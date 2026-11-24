import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPromoteMainWindowJxaScript,
  didTargetStealFocus,
  findRunningApp,
  isLikelyBundleId,
  isMiniEmptyDialogSnapshot,
  isProcessAlive,
  isSecureTextRole,
  parseAppsList,
  parseImageDimensions,
  parseLsappinfoFront,
  parseSnapshotMetadata,
  pickPromotableMainWindow,
  planBackgroundClickMethods,
  planBackgroundKeyMethods,
  promoteMainWindowFocusInBackground,
} from "../src/background-policy.mjs";
import {
  SelfActivationTracker,
  SnapshotLedger,
  matchAdvertisedAction,
  parseQualifiedElementRef,
  sanitizeToolArgsForNative,
  shouldAttemptSelectedTextFastPath,
  tryHeadlessBackgroundScroll,
  tryHeadlessContextMenu,
  verifySetValueObservation,
} from "../src/headless-engine.mjs";
import { PersistentAxBridge } from "../src/ax-bridge.mjs";

test("parseAppsList parses macOS running and frontmost markers", () => {
  const raw = [
    "Microsoft Edge — com.microsoft.edgemac [frontmost, running, last-used=2026-11-11, uses=4961]",
    "微信 — com.tencent.xinWeChat [running, last-used=2026-11-11, uses=2142]",
    "Calculator — com.apple.calculator [last-used=2026-10-01, uses=5]",
  ].join("\n");

  const apps = parseAppsList(raw);
  assert.equal(apps.length, 3);
  assert.deepEqual(apps[0], {
    displayName: "Microsoft Edge",
    bundleId: "com.microsoft.edgemac",
    isRunning: true,
    isFrontmost: true,
  });
  assert.equal(apps[1].displayName, "微信");
  assert.equal(apps[1].isRunning, true);
  assert.equal(apps[1].isFrontmost, false);
  assert.equal(apps[2].isRunning, false);
});

test("parseSnapshotMetadata extracts pid, window title, and element labels", () => {
  const raw = [
    "App=com.google.GeminiMacOS (pid 75539)",
    'Window: "Gemini - 新对话", App: Gemini.',
    "0 标准窗口 Gemini - 新对话, Secondary Actions: Raise",
    "\t1 分离组",
    "\t\t2 按钮 搜索 Help: 搜索对话 (⇧⌘F) ID: sidebar_header_search",
  ].join("\n");

  const meta = parseSnapshotMetadata(raw);
  assert.equal(meta.bundleId, "com.google.GeminiMacOS");
  assert.equal(meta.pid, 75539);
  assert.equal(meta.windowTitle, "Gemini - 新对话");
  assert.equal(meta.appDisplayName, "Gemini");
  assert.equal(meta.elements.get("2")?.label, "按钮「搜索」");
});

test("parseImageDimensions reads PNG and JPEG dimensions accurately", () => {
  // Minimal 24-byte PNG header for 1280x800
  const png = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
  png.writeUInt32BE(1280, 16);
  png.writeUInt32BE(800, 20);
  assert.deepEqual(parseImageDimensions(png), { width: 1280, height: 800 });

  // Minimal JPEG with SOF0 marker for 960x600
  const jpg = Buffer.from([
    0xff, 0xd8,             // SOI
    0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, // APP0
    0xff, 0xc0, 0x00, 0x0b, 0x08,       // SOF0, length 11, precision 8
    0x02, 0x58,             // height = 600
    0x03, 0xc0,             // width = 960
    0x01, 0x01, 0x11, 0x00,
    0xff, 0xd9,             // EOI
  ]);
  assert.deepEqual(parseImageDimensions(jpg), { width: 960, height: 600 });
});

test("planBackgroundClickMethods prioritizes sky_click and avoids AXPress self-activation by default", () => {
  assert.deepEqual(planBackgroundClickMethods({ app: "Safari", element_index: "5" }), [
    "sky_click",
    "app_post",
  ]);
  assert.deepEqual(
    planBackgroundClickMethods({ app: "Safari", element_index: "5" }, { allowAccessibilityFallback: true }),
    ["sky_click", "app_post", "accessibility"]
  );
  assert.deepEqual(planBackgroundClickMethods({ app: "Safari", element_index: "0" }), [
    "sky_click",
    "app_post",
  ]);
  assert.deepEqual(planBackgroundClickMethods({ app: "Safari", x: 100, y: 200, mouse_button: "right" }), [
    "app_post",
  ]);
  assert.deepEqual(planBackgroundClickMethods({ app: "Safari", x: 10, y: 20, click_method: "app_post" }), [
    "app_post",
  ]);
  // Explicit AI `click_method: "accessibility"` must still try non-activating `sky_click` & `app_post` FIRST
  // so Qt/Electron `AXPress` never self-activates when `sky_click` succeeds!
  assert.deepEqual(
    planBackgroundClickMethods({ app: "剪映专业版", element_index: "81", click_method: "accessibility" }),
    ["sky_click", "app_post", "accessibility"]
  );
  // Explicit `click_method: "global"` must be sanitized to non-activating background methods
  assert.deepEqual(planBackgroundClickMethods({ app: "剪映专业版", x: 50, y: 60, click_method: "global" }), [
    "sky_click",
    "app_post",
  ]);
});

test("parseLsappinfoFront and didTargetStealFocus detect background focus theft accurately", () => {
  const sample = `[ NULL ]  ASN:0x0-0x221a218: (in front) \n    bundleID="com.google.antigravity"\n    pid = 82290 !cgsConnection`;
  assert.deepEqual(parseLsappinfoFront(sample), {
    pid: 82290,
    bundleId: "com.google.antigravity",
    displayName: null,
  });
  const localizedSample = `"剪映专业版" ASN:0x0-0x2205203: \n    bundleID="com.lemon.lvpro"\n    pid = 10038 !cgsConnection`;
  assert.deepEqual(parseLsappinfoFront(localizedSample), {
    pid: 10038,
    bundleId: "com.lemon.lvpro",
    displayName: "剪映专业版",
  });
  assert.equal(parseLsappinfoFront(""), null);

  const antigravity = { pid: 82290, bundleId: "com.google.antigravity", displayName: "Antigravity" };
  const jianying = { pid: 9449, bundleId: "com.lemon.lvpro", displayName: "剪映专业版" };
  const wechat = { pid: 5001, bundleId: "com.tencent.xinWeChat", displayName: "微信" };

  // Target stole focus from Antigravity -> true
  assert.equal(
    didTargetStealFocus(antigravity, jianying, {
      appQuery: "剪映专业版",
      pid: 9449,
      bundleId: "com.lemon.lvpro",
    }),
    true
  );

  // Cold-cache Chinese display name only (pid=null, bundleId=null) -> MUST still detect focus theft!
  assert.equal(
    didTargetStealFocus(antigravity, jianying, {
      appQuery: "剪映专业版",
      pid: null,
      bundleId: null,
    }),
    true
  );

  // Target was ALREADY frontmost before action -> false (do not steal from user)
  assert.equal(
    didTargetStealFocus(jianying, jianying, {
      appQuery: "com.lemon.lvpro",
      pid: 9449,
      bundleId: "com.lemon.lvpro",
    }),
    false
  );

  // User switched to a third app (WeChat) during action -> false (respect user action)
  assert.equal(
    didTargetStealFocus(antigravity, wechat, {
      appQuery: "com.lemon.lvpro",
      pid: 9449,
      bundleId: "com.lemon.lvpro",
    }),
    false
  );
});

test("planBackgroundKeyMethods uses non-activating sky_key without auto or global fallback", () => {
  assert.deepEqual(planBackgroundKeyMethods({ app: "Safari", text: "hi" }), ["sky_key"]);
  assert.deepEqual(planBackgroundKeyMethods({ app: "Safari", text: "hi", key_method: "sky_key" }), [
    "sky_key",
  ]);
  assert.deepEqual(planBackgroundKeyMethods({ app: "Safari", text: "hi", key_method: "global" }), [
    "sky_key",
  ]);
});

test("isLikelyBundleId handles .app suffixes, underscores, and invalid inputs safely", () => {
  assert.equal(isLikelyBundleId("com.google.GeminiMacOS"), true);
  assert.equal(isLikelyBundleId("com.jetbrains.pycharm_ce"), true);
  assert.equal(isLikelyBundleId("Firefox.app"), false);
  assert.equal(isLikelyBundleId("Visual Studio Code.app"), false);
  assert.equal(isLikelyBundleId("Safari"), false);
  assert.equal(isLikelyBundleId("-a"), false);
  assert.equal(isLikelyBundleId(null), false);
});

test("isProcessAlive and findRunningApp detect exited apps without launching them", () => {
  assert.equal(isProcessAlive(process.pid), true);
  assert.equal(isProcessAlive(99999999), false);
  assert.equal(isProcessAlive(null), false);

  const apps = parseAppsList(
    [
      "Antigravity — com.google.antigravity [frontmost, running]",
      "Gemini — com.google.GeminiMacOS [last-used=2026-11-11, uses=50]",
    ].join("\n")
  );
  assert.equal(findRunningApp(apps, "com.google.GeminiMacOS"), null);
  assert.equal(findRunningApp(apps, "Gemini"), null);
  assert.equal(findRunningApp(apps, "Antigravity")?.bundleId, "com.google.antigravity");
});

test("parseQualifiedElementRef and sanitizeToolArgsForNative handle @sN:index and detect conflicts", () => {
  assert.deepEqual(parseQualifiedElementRef("@s3:18"), {
    ok: true,
    hasElementRef: true,
    snapshotId: "s3",
    rawIndex: "18",
    displayRef: "@s3:18",
  });
  assert.deepEqual(parseQualifiedElementRef("18", "s2"), {
    ok: true,
    hasElementRef: true,
    snapshotId: "s2",
    rawIndex: "18",
    displayRef: "@s2:18",
  });
  assert.equal(parseQualifiedElementRef("@s2:8", "s3").ok, false);
  assert.equal(parseQualifiedElementRef("@bad:abc").ok, false);

  const sanitized = sanitizeToolArgsForNative(
    { app: "TextEdit", element_index: "@s3:18", snapshot_id: "s3", x: 10 },
    parseQualifiedElementRef("@s3:18")
  );
  assert.deepEqual(sanitized, { app: "TextEdit", element_index: "18", x: 10 });
});

test("SnapshotLedger issues monotonic IDs, rejects STALE_REF on UI change or recycled PID, and merges query results", () => {
  const ledger = new SnapshotLedger();
  const s1Els = new Map([
    ["1", { index: "1", role: "按钮", identifier: "btn_send", label: "按钮「发送」", fingerprint: "按钮|btn_send|发送" }],
    ["2", { index: "2", role: "文本区", identifier: "editor", label: "文本区「内容」", fingerprint: "文本区|editor|内容" }],
    ["3", { index: "3", role: "按钮", identifier: "btn_close", label: "按钮「关闭」", fingerprint: "按钮|btn_close|关闭" }],
    ["4", { index: "4", role: "按钮", identifier: "btn_help", label: "按钮「帮助」", fingerprint: "按钮|btn_help|帮助" }],
  ]);
  const s1 = ledger.issueSnapshot({
    appKey: "com.example.App",
    bundleId: "com.example.App",
    pid: 4000,
    processToken: "4000:Mon Nov 11 10:00:00 2026",
    windowTitle: "Main Window",
    elements: s1Els,
  });
  assert.equal(s1.id, "s1");

  // Valid @s1:1 check passes
  assert.equal(
    ledger.validateRef({
      appKey: "com.example.App",
      bundleId: "com.example.App",
      parsedRef: parseQualifiedElementRef("@s1:1"),
      currentPid: 4000,
      currentProcessToken: "4000:Mon Nov 11 10:00:00 2026",
      currentWindowTitle: "Main Window",
    }).ok,
    true
  );

  // Partial query merges prior elements cleanly without invalidating non-stale refs
  const s2 = ledger.issueSnapshot({
    appKey: "com.example.App",
    bundleId: "com.example.App",
    pid: 4000,
    processToken: "4000:Mon Nov 11 10:00:00 2026",
    windowTitle: "Main Window",
    elements: new Map([
      ["1", { index: "1", role: "按钮", identifier: "btn_send", label: "按钮「发送」", fingerprint: "按钮|btn_send|发送" }],
    ]),
    elementsPartial: true,
    source: "query",
  });
  assert.equal(s2.id, "s2");
  assert.equal(s2.elements.size, 4);

  // Structural UI transition (window + elements change) marks older snapshots stale
  const s3Els = new Map([
    ["1", { index: "1", role: "按钮", identifier: "btn_confirm", label: "按钮「确认」", fingerprint: "按钮|btn_confirm|确认" }],
    ["2", { index: "2", role: "按钮", identifier: "btn_cancel", label: "按钮「取消」", fingerprint: "按钮|btn_cancel|取消" }],
  ]);
  const s3 = ledger.issueSnapshot({
    appKey: "com.example.App",
    bundleId: "com.example.App",
    pid: 4000,
    processToken: "4000:Mon Nov 11 10:00:00 2026",
    windowTitle: "Confirm Dialog",
    elements: s3Els,
  });
  assert.equal(s3.id, "s3");

  const staleRef = ledger.validateRef({
    appKey: "com.example.App",
    bundleId: "com.example.App",
    parsedRef: parseQualifiedElementRef("@s1:1"),
    currentPid: 4000,
    currentProcessToken: "4000:Mon Nov 11 10:00:00 2026",
    currentWindowTitle: "Confirm Dialog",
  });
  assert.equal(staleRef.ok, false);
  assert.equal(staleRef.errorCode, "STALE_REF");
  assert.equal(staleRef.currentSnapshotId, "s3");

  // Recycled PID generation mismatch triggers STALE_REF on latest snapshot too
  const recycled = ledger.validateRef({
    appKey: "com.example.App",
    bundleId: "com.example.App",
    parsedRef: parseQualifiedElementRef("@s3:1"),
    currentPid: 4000,
    currentProcessToken: "4000:Mon Nov 11 10:05:00 2026",
    currentWindowTitle: "Confirm Dialog",
  });
  assert.equal(recycled.ok, false);
  assert.equal(recycled.reason, "process_restarted");
});

test("parseSnapshotMetadata extracts Secondary Actions & redacts AXSecureTextField values", () => {
  const raw = [
    "App=com.example.Login (pid 8888)",
    'Window: "Sign In", App: Login.',
    '\t1 AXSecureTextField Value: "super-secret-password" ID: pwd_field Help: Password',
    '\t2 按钮 Submit Secondary Actions: AXPress, AXShowMenu, Confirm ID: btn_submit',
  ].join("\n");
  const meta = parseSnapshotMetadata(raw);
  const pwd = meta.elements.get("1");
  const submit = meta.elements.get("2");
  assert.equal(pwd.isSecure, true);
  assert.equal(pwd.rawText, "[redacted]");
  assert.equal(pwd.label.includes("super-secret-password"), false);
  assert.equal(submit.identifier, "btn_submit");
  assert.deepEqual(submit.secondaryActions, ["AXPress", "AXShowMenu", "Confirm"]);
  assert.equal(matchAdvertisedAction(submit.secondaryActions, "axshowmenu"), "AXShowMenu");
  assert.equal(matchAdvertisedAction(submit.secondaryActions, "AXDelete"), null);
});

test("SelfActivationTracker, planBackgroundClickMethods blacklist, verifySetValueObservation, and CJK fast-path", () => {
  const tracker = new SelfActivationTracker();
  tracker.record("com.lemon.lvpro", "click:accessibility");
  assert.deepEqual(tracker.getBlockedMethods("com.lemon.lvpro", "click"), ["accessibility"]);
  assert.deepEqual(
    planBackgroundClickMethods(
      { app: "剪映专业版", element_index: "81", click_method: "accessibility" },
      { blockedMethods: tracker.getBlockedMethods("com.lemon.lvpro", "click") }
    ),
    ["sky_click", "app_post"]
  );

  assert.equal(
    verifySetValueObservation({
      expectedValue: "hello",
      postElement: { rawText: "hello", isSecure: false },
    }).verified,
    true
  );
  assert.equal(
    verifySetValueObservation({
      expectedValue: "hello",
      preElement: { rawText: "old", isSecure: false },
      postElement: { rawText: "old", isSecure: false },
    }).verified,
    false
  );
  const secVerify = verifySetValueObservation({
    expectedValue: "s3cr3t",
    postElement: { isSecure: true, rawText: null },
  });
  assert.equal(secVerify.redacted, true);
  assert.equal(JSON.stringify(secVerify).includes("s3cr3t"), false);

  assert.equal(shouldAttemptSelectedTextFastPath("com.apple.TextEdit", "你好世界"), true);
  assert.equal(shouldAttemptSelectedTextFastPath("com.apple.TextEdit", "hello"), false);
  assert.equal(shouldAttemptSelectedTextFastPath("com.lemon.lvpro", "你好世界"), false);
});

test("tryHeadlessContextMenu and tryHeadlessBackgroundScroll operate without AXIdentifier via axBridge handles", async () => {
  const calls = [];
  const fakeBridge = {
    async triggerContextMenu(pid, payload) {
      calls.push({ op: "context_menu", pid, payload });
      return { delivered: true, verified: true, reason: "ok" };
    },
    async scroll(pid, payload) {
      calls.push({ op: "scroll", pid, payload });
      return { delivered: true, verified: true, reason: "ok" };
    },
  };

  const noIdElement = {
    index: "7",
    role: "按钮",
    identifier: null,
    rawText: "导出视频",
    help: "打开导出菜单",
  };
  const ctxRes = await tryHeadlessContextMenu(5120, noIdElement, {
    axBridge: fakeBridge,
    snapshotId: "s4",
    elementIndex: "7",
  });
  assert.equal(ctxRes.delivered, true);
  assert.equal(ctxRes.verified, true);
  assert.equal(calls[0].payload.snapshotId, "s4");
  assert.equal(calls[0].payload.elementIndex, "7");
  assert.equal(calls[0].payload.elementMeta.identifier, null);

  const scrRes = await tryHeadlessBackgroundScroll(5120, noIdElement, "down", 2, {
    axBridge: fakeBridge,
    snapshotId: "s4",
    elementIndex: "7",
  });
  assert.equal(scrRes.delivered, true);
  assert.equal(scrRes.verified, true);
  assert.equal(calls[1].payload.snapshotId, "s4");
  assert.equal(calls[1].payload.elementIndex, "7");
  assert.equal(calls[1].payload.pages, 2);
});

test("PersistentAxBridge warm RPC latency, SIGKILL auto-respawn recovery, and zero-orphan close()", async () => {
  if (process.platform !== "darwin") return;
  const bridge = new PersistentAxBridge({ enabled: true });
  let secondPid = null;
  try {
    const started = await bridge.ensureStarted();
    assert.equal(started, true);
    const firstPid = bridge.pid;
    assert.ok(firstPid > 0 && isProcessAlive(firstPid));

    // Warm up tccd/CF permission check once before measuring warm RPC latency
    await bridge.checkPermissions();

    // Warm RPC round-trip should be fast (<25ms, typically ~0.8-1.5ms)
    const t0 = performance.now();
    const perms = await bridge.checkPermissions();
    const dt = performance.now() - t0;
    assert.equal(perms?.platform, "darwin");
    assert.ok(dt < 35, `Expected warm PersistentAxBridge RPC <35ms, got ${dt.toFixed(2)}ms`);

    const front = await bridge.getFrontmostApp();
    if (front?.pid > 0) {
      const pInfo = await bridge.getProcessInfo(front.pid);
      assert.equal(pInfo?.alive, true);
      assert.match(String(pInfo?.processToken || ""), new RegExp(`^${front.pid}:\\d+`));
    }

    // Simulate abrupt daemon crash (SIGKILL) -> next request must transparently respawn!
    process.kill(firstPid, "SIGKILL");
    await new Promise((r) => setTimeout(r, 35));
    const permsAfterCrash = await bridge.checkPermissions();
    assert.equal(permsAfterCrash?.platform, "darwin");
    secondPid = bridge.pid;
    assert.ok(secondPid > 0 && secondPid !== firstPid);
    assert.equal(isProcessAlive(secondPid), true);
  } finally {
    await bridge.close();
  }
  if (secondPid) {
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(isProcessAlive(secondPid), false, "PersistentAxBridge child must exit cleanly on close()");
  }
});

test("Multi-word English AX roles (secure text field, pop up button) parse & redact cleanly, and >24KB CJK payloads survive PersistentAxBridge pipe framing", async () => {
  const raw = [
    "App=com.example.Vault (pid 9100)",
    'Window: "Sign In", App: Vault.',
    '\t1 secure text field Value: "top-secret-token-99" ID: secret_input Help: Enter API key',
    '\t2 search text field Value: "剪映字幕搜索" ID: search_box',
    "\t3 pop up button Export Preset Secondary Actions: AXPress, AXShowMenu",
  ].join("\n");
  const meta = parseSnapshotMetadata(raw);
  const sec = meta.elements.get("1");
  const search = meta.elements.get("2");
  const popup = meta.elements.get("3");

  assert.equal(isSecureTextRole("secure text field"), true);
  assert.equal(isSecureTextRole("AXSecureTextField"), true);
  assert.equal(isSecureTextRole("search text field"), false);

  assert.equal(sec.role, "secure text field");
  assert.equal(sec.isSecure, true);
  assert.equal(sec.rawText, "[redacted]");
  assert.equal(sec.help, "Enter API key");
  assert.equal(JSON.stringify(sec).includes("top-secret-token-99"), false);

  assert.equal(search.role, "search text field");
  assert.equal(search.isSecure, false);
  assert.equal(search.rawText, 'Value: "剪映字幕搜索"');

  assert.equal(popup.role, "pop up button");
  assert.deepEqual(popup.secondaryActions, ["AXPress", "AXShowMenu"]);

  if (process.platform !== "darwin") return;
  const bridge = new PersistentAxBridge({ enabled: true });
  try {
    // Build a >32KB multi-byte CJK + emoji payload to stress OS pipe chunk boundaries
    const elements = [];
    for (let i = 1; i <= 260; i += 1) {
      elements.push({
        index: String(i),
        role: "按钮",
        identifier: `btn_中文标识符_${i}`,
        rawText: `导出高清时间线片段_${i}_🎬_测试超长多字节UTF8管道分片稳定性_不丢包不截断`,
        help: `第 ${i} 个轨道控制按钮帮助说明`,
        fingerprint: `按钮|btn_中文标识符_${i}|导出高清时间线片段_${i}`,
      });
    }
    const serializedLen = Buffer.byteLength(JSON.stringify(elements), "utf8");
    assert.ok(serializedLen > 32 * 1024, `Expected >32KB UTF-8 payload, got ${serializedLen}`);

    // Sending to non-GUI PID (-1 / current node pid without AX windows) exercises full stdin->JSON.parse->stdout framing
    const bindRes = await bridge.bindSnapshot({
      snapshotId: "s_large_cjk",
      pid: process.pid,
      appKey: "com.example.Stress",
      windowTitle: "超长中文窗口标题_多字节边界压测",
      elements,
    });
    assert.equal(typeof bindRes?.bound, "boolean");
    const postPing = await bridge.checkPermissions();
    assert.equal(postPing?.platform, "darwin");
  } finally {
    await bridge.close();
  }
});

test("planBackgroundClickMethods & planBackgroundKeyMethods honor sky_click / sky_key blacklists and PersistentAxBridge validates window_post inputs", async () => {
  // 1. Once sky_click stole focus, planBackgroundClickMethods MUST skip sky_click across auto, explicit sky_click, and accessibility!
  assert.deepEqual(
    planBackgroundClickMethods(
      { app: "com.lemon.lvpro", x: 450, y: 52 },
      { blockedMethods: ["sky_click"] }
    ),
    ["window_post", "app_post"]
  );
  assert.deepEqual(
    planBackgroundClickMethods(
      { app: "com.lemon.lvpro", x: 450, y: 52, click_method: "sky_click" },
      { blockedMethods: ["sky_click"] }
    ),
    ["window_post", "app_post"]
  );
  assert.deepEqual(
    planBackgroundClickMethods(
      { app: "com.lemon.lvpro", element_index: "12", click_method: "accessibility" },
      { blockedMethods: ["sky_click", "accessibility"] }
    ),
    ["window_post", "app_post"]
  );
  assert.deepEqual(
    planBackgroundClickMethods(
      { app: "com.lemon.lvpro", x: 450, y: 52 },
      { blockedMethods: ["sky_click", "app_post"] }
    ),
    ["window_post"]
  );
  // Direction A: window_post (SLEventPostToPid) must NEVER be permanently banned or downgraded to app_post
  assert.deepEqual(
    planBackgroundClickMethods(
      { app: "com.lemon.lvpro", x: 450, y: 52 },
      { blockedMethods: ["sky_click", "window_post"] }
    ),
    ["window_post", "app_post"]
  );
  assert.deepEqual(
    planBackgroundClickMethods(
      { app: "com.lemon.lvpro", x: 450, y: 52, click_method: "window_post" },
      { blockedMethods: ["sky_click", "window_post", "app_post"] }
    ),
    ["window_post"]
  );

  // 2. planBackgroundKeyMethods switches to window_key when sky_key is blocked or avoidSkyFocus is set
  assert.deepEqual(
    planBackgroundKeyMethods({ app: "com.lemon.lvpro", key: "space" }, { blockedMethods: ["sky_key"] }),
    ["window_key"]
  );
  assert.deepEqual(
    planBackgroundKeyMethods(
      { app: "com.lemon.lvpro", key: "space" },
      { blockedMethods: ["sky_key", "window_key"] }
    ),
    ["window_key"]
  );
  assert.deepEqual(
    planBackgroundKeyMethods(
      { app: "com.lemon.lvpro", key: "space", key_method: "sky_key" },
      { blockedMethods: ["sky_key"] }
    ),
    ["window_key"]
  );
  assert.deepEqual(
    planBackgroundKeyMethods({ app: "com.lemon.lvpro", key: "space" }, { avoidSkyFocus: true }),
    ["window_key", "sky_key"]
  );

  // 3. SelfActivationTracker alias lookup, SkyLight 0x0d detection, & non-downgradable window_post / window_key
  const tracker = new SelfActivationTracker();
  tracker.record("com.lemon.lvpro", "click:sky_click");
  tracker.record("剪映专业版", "click:sky_click");
  tracker.record("com.lemon.lvpro", "click:window_post");
  tracker.record("com.lemon.lvpro", "press_key:window_key");
  assert.deepEqual(
    tracker.getBlockedMethodsForAliases(["剪映专业版", "com.lemon.lvpro"], "click"),
    ["sky_click"]
  );
  assert.deepEqual(
    tracker.getBlockedMethodsForAliases(["剪映专业版", "com.lemon.lvpro"], "press_key"),
    []
  );
  assert.equal(tracker.hasSkyFocusSteal("剪映专业版"), true);
  assert.equal(tracker.hasSkyFocusSteal("com.apple.TextEdit"), false);
  tracker.record("com.example.editor", "set_value:sky_bypass");
  assert.equal(tracker.hasSkyFocusSteal("com.example.editor"), true);

  if (process.platform !== "darwin") return;
  const bridge = new PersistentAxBridge({ enabled: true });
  try {
    // Missing target coordinates (x=null, y=null, no elementIndex) must NOT coerce null -> (0, 0)
    const missingTarget = await bridge.postWindowClick(process.pid, {
      wid: 999999,
      windowBounds: { x: 100, y: 100, width: 800, height: 600 },
    });
    assert.equal(missingTarget.delivered, false);
    assert.equal(missingTarget.reason, "missing_target");

    // Out-of-bounds screenshot coordinates must fail closed without dispatching events
    const outOfBounds = await bridge.postWindowClick(process.pid, {
      x: 1600,
      y: 900,
      frameWidth: 1280,
      frameHeight: 800,
      wid: 999999,
      windowBounds: { x: 100, y: 100, width: 800, height: 600 },
    });
    assert.equal(outOfBounds.delivered, false);
    assert.equal(outOfBounds.reason, "out_of_bounds");

    // Unknown X11 keysym or unknown modifier (e.g. "fn+BackSpace") fails closed without dropping modifiers
    const badKey = await bridge.postWindowKey(999998, { key: "XF86NonExistentKey" });
    assert.equal(badKey.delivered, false);
    assert.equal(badKey.reason, "unsupported_key");

    const badMod = await bridge.postWindowKey(999998, { key: "fn+BackSpace" });
    assert.equal(badMod.delivered, false);
    assert.equal(badMod.reason, "unsupported_key");

    const danglingPlus = await bridge.postWindowKey(999998, { key: "cmd+" });
    assert.equal(danglingPlus.delivered, false);
    assert.equal(danglingPlus.reason, "unsupported_key");

    // Valid chords including "Cmd+Z" and "cmd++" either succeed (when osascript has AX permission)
    // or fail closed with jxa_accessibility_untrusted (never silently dropping events & returning delivered:true)
    const perms = await bridge.checkPermissions().catch(() => null);
    const undoChord = await bridge.postWindowKey(999998, { key: "Cmd+Z" });
    const zoomInChord = await bridge.postWindowKey(999998, { key: "cmd++" });
    if (perms?.accessibility === false) {
      assert.equal(undoChord.delivered, false);
      assert.equal(undoChord.deliveryState, "not_sent");
      assert.equal(undoChord.reason, "jxa_accessibility_untrusted");
      assert.equal(zoomInChord.delivered, false);
      assert.equal(zoomInChord.deliveryState, "not_sent");
      assert.equal(zoomInChord.reason, "jxa_accessibility_untrusted");
    } else {
      assert.equal(undoChord.delivered, true);
      assert.equal(zoomInChord.delivered, true);
    }
  } finally {
    await bridge.close();
  }
});

test("promoteMainWindowFocusInBackground & isMiniEmptyDialogSnapshot ignore 92x92 AXDialog and promote largest >=300x200 main window", async () => {
  // 1. Pure window selector ignores AXDialog or <300x200 AXMainWindow and picks largest AXStandardWindow
  const miniDialog = { id: "mini-dlg", subrole: "AXDialog", width: 92, height: 92 };
  const largeDialog = { id: "large-dlg", subrole: "AXDialog", width: 520, height: 360 };
  const smallStd = { id: "small-std", subrole: "AXStandardWindow", width: 640, height: 480 };
  const mainStd = { id: "main-std", subrole: "AXStandardWindow", width: 1469, height: 810 };
  const customMain = { id: "qt-custom", subrole: "AXUnknown", width: 1280, height: 720 };

  assert.equal(pickPromotableMainWindow(miniDialog, [miniDialog, smallStd, mainStd])?.id, "main-std");
  assert.equal(pickPromotableMainWindow(largeDialog, [largeDialog, smallStd, mainStd])?.id, "main-std");
  assert.equal(pickPromotableMainWindow(miniDialog, [miniDialog, largeDialog, customMain])?.id, "qt-custom");
  assert.equal(pickPromotableMainWindow(mainStd, [miniDialog, smallStd])?.id, "main-std");
  assert.equal(pickPromotableMainWindow(miniDialog, [miniDialog]), null);

  // 2. Execute generated JXA logic against mocked ApplicationServices AX table to verify JXA script behavior end-to-end
  if (process.platform === "darwin") {
    let executedScript = "";
    const promotedAttrs = [];
    const ok = await promoteMainWindowFocusInBackground(process.pid, {
      settleMs: 0,
      execFileFn: async (_bin, args) => {
        executedScript = args[args.length - 1];
        const body = executedScript
          .replace('ObjC.import("ApplicationServices");', "")
          .replace('ObjC.import("Foundation");', "");
        const mockWindows = [
          { id: "orb-92", subrole: "AXDialog", w: 92, h: 92 },
          { id: "sub-std", subrole: "AXStandardWindow", w: 600, h: 400 },
          { id: "editor-main", subrole: "AXStandardWindow", w: 1469, h: 810 },
        ];
        const fn = new Function("ObjC", "$", "Ref", `return ${body.trim()}`);
        const $fn = (s) => s;
        $fn.kCFBooleanTrue = true;
        $fn.AXUIElementCreateApplication = () => ({ kind: "app" });
        $fn.CFCopyDescription = (szObj) => `<AXValue {value = w:${szObj.w} h:${szObj.h} type = kAXValueCGSizeType}>`;
        $fn.AXUIElementCopyAttributeValue = (el, attr, out) => {
          if (el.kind === "app" && attr === "AXMainWindow") {
            out[0] = mockWindows[0]; // Hijacked by 92x92 AXDialog!
            return 0;
          }
          if (el.kind === "app" && attr === "AXWindows") {
            out[0] = {
              count: mockWindows.length,
              objectAtIndex: (i) => mockWindows[i],
            };
            return 0;
          }
          if (attr === "AXSubrole") {
            out[0] = el.subrole;
            return 0;
          }
          if (attr === "AXSize") {
            out[0] = { w: el.w, h: el.h };
            return 0;
          }
          return -1;
        };
        $fn.AXUIElementSetAttributeValue = (el, attr, val) => {
          promotedAttrs.push({ id: el.id, attr, val });
          return 0;
        };
        const out = fn(
          {
            castRefToObject: (x) => x,
            unwrap: (x) => x,
          },
          $fn,
          () => [null]
        );
        return { stdout: `${out}\n` };
      },
    });
    assert.equal(ok, true);
    assert.match(buildPromoteMainWindowJxaScript(process.pid), /AXDialog/);
    assert.deepEqual(promotedAttrs, [
      { id: "editor-main", attr: "AXMain", val: true },
      { id: "editor-main", attr: "AXFocused", val: true },
    ]);
  }

  // 3. Mini childless `0 对话框` snapshot detection
  const miniSnap = ['App=com.lemon.lvpro (pid 54321)', 'Window: "", App: 剪映专业版.', "0 对话框"].join("\n");
  assert.equal(isMiniEmptyDialogSnapshot(miniSnap, null), true);
  assert.equal(isMiniEmptyDialogSnapshot(miniSnap, { width: 184, height: 184 }), true);
  assert.equal(isMiniEmptyDialogSnapshot(miniSnap, { width: 1280, height: 705 }), false);

  const realDialogSnap = [
    "App=com.lemon.lvpro (pid 54321)",
    'Window: "剪映专业版", App: 剪映专业版.',
    "0 对话框",
    "\t1 文本 HomePageStartProjectDesp",
  ].join("\n");
  assert.equal(isMiniEmptyDialogSnapshot(realDialogSnap, { width: 184, height: 184 }), false);
});
