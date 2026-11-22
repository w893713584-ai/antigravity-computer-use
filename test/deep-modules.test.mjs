import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { FocusPolicyGuard } from "../src/focus-policy-guard.mjs";
import { AppSnapshotRegistry } from "../src/app-snapshot-registry.mjs";
import { BackgroundActionExecutor } from "../src/action-executor.mjs";
import { runJsonRpcStdioServer } from "../src/jsonrpc-stdio.mjs";
import { SidecarWebAdapter } from "../src/sidecar-web-adapter.mjs";
import { parseSnapshotMetadata } from "../src/background-policy.mjs";
import { AtomicActExecutor } from "../src/act-executor.mjs";
import { TakeoverController } from "../src/takeover-controller.mjs";

test("FocusPolicyGuard unifies Focus Steal reclamation, cross-app rapid attribution, epoch cancellation, and Window-Local Delivery Floor", async () => {
  let frontmost = { pid: 900, bundleId: "com.google.antigravity", displayName: "Antigravity" };
  const restores = [];
  const preventedEvents = [];

  const knownApps = new Map([
    [
      "lv",
      {
        pid: 10038,
        bundleId: "com.lemon.lvpro",
        appDisplayName: "剪映专业版",
      },
    ],
    [
      "te",
      {
        pid: 20022,
        bundleId: "com.apple.TextEdit",
        appDisplayName: "TextEdit",
      },
    ],
  ]);

  const lookupMeta = (app) => {
    if (/lvpro|剪映/iu.test(String(app))) return knownApps.get("lv");
    if (/textedit/iu.test(String(app))) return knownApps.get("te");
    return null;
  };

  const guard = new FocusPolicyGuard({
    focusController: {
      async getFrontmostApp() {
        return frontmost;
      },
      async restoreFrontmostApp(pid) {
        restores.push(pid);
        frontmost = { pid, bundleId: "com.google.antigravity", displayName: "Antigravity" };
        return true;
      },
      sweepDelaysMs: [40],
    },
    resolveTargetInfo: (app) => {
      const m = lookupMeta(app);
      return {
        appQuery: app,
        pid: m?.pid || null,
        bundleId: m?.bundleId || null,
        appDisplayName: m?.appDisplayName || null,
      };
    },
    onFocusStealPrevented: (evt) => {
      preventedEvents.push(evt);
    },
  });

  try {
    // 1. Unblocked app starts on sky_click / sky_key
    assert.deepEqual(guard.planClick({ app: "剪映专业版", x: 100, y: 80 }, ["剪映专业版", "com.lemon.lvpro"]), [
      "sky_click",
      "app_post",
    ]);

    // 2. Rapid <80ms delayed steal on 剪映 caught by subsequent TextEdit beginGuard
    const scope1 = await guard.beginGuard("剪映专业版");
    assert.equal(await scope1.enforce("click:sky_click"), false);
    scope1.finish("click:sky_click");

    // OS finishes activating 剪映 12ms later (before 250ms sweep fires), while AI queries TextEdit
    frontmost = { pid: 10038, bundleId: "com.lemon.lvpro", displayName: "剪映专业版" };
    const scope2 = await guard.beginGuard("com.apple.TextEdit");
    assert.equal(restores.length, 1);
    assert.equal(restores[0], 900);
    assert.equal(scope2.frontBefore?.pid, 900);
    assert.equal(preventedEvents.length, 1);
    assert.equal(preventedEvents[0].routeKey, "click:sky_click");
    assert.equal(preventedEvents[0].targetApp, "com.lemon.lvpro");

    // Intervening read-only scope2 (no finish()) MUST NOT cancel scope1's remaining sweep timer!
    frontmost = { pid: 10038, bundleId: "com.lemon.lvpro", displayName: "剪映专业版" };
    await new Promise((r) => setTimeout(r, 55));
    assert.equal(restores.length, 2, "Remaining sweep wave must still reclaim secondary delayed steal");
    assert.equal(preventedEvents.length, 1, "Same route steal must not be double-recorded");

    // TextEdit must NOT be blamed; 剪映 (under both displayName & bundleId) switches to window_post / window_key!
    assert.deepEqual(guard.planClick({ app: "com.apple.TextEdit", x: 20, y: 20 }, ["com.apple.TextEdit"]), [
      "sky_click",
      "app_post",
    ]);
    assert.deepEqual(guard.planClick({ app: "com.lemon.lvpro", x: 100, y: 80 }, ["com.lemon.lvpro"]), [
      "window_post",
      "app_post",
    ]);
    assert.deepEqual(guard.planKey("press_key", { app: "剪映专业版", key: "space" }, ["剪映专业版"]), [
      "window_key",
      "sky_key",
    ]);

    // 3. Window-Local Delivery Floor (ADR-0003): Focus Steal during click:window_post or bare window_post
    //    is reclaimed without EVER blacklisting window_post or poisoning hasPriorSteal
    guard.tracker.record("com.lemon.lvpro", "window_post");
    guard.tracker.record("com.lemon.lvpro", "window_key");
    assert.equal(guard.hasPriorSteal(["com.lemon.lvpro"], "window_post", "window_key"), false);

    const scope3 = await guard.beginGuard("com.lemon.lvpro");
    frontmost = { pid: 10038, bundleId: "com.lemon.lvpro", displayName: "剪映专业版" };
    const stolen3 = await scope3.enforce("click:window_post");
    scope3.finish("click:window_post", { alreadyRecorded: stolen3 });
    assert.equal(stolen3, true);
    assert.equal(restores.length, 3);
    assert.equal(preventedEvents.length, 2);
    assert.equal(guard.isMethodBlocked(["com.lemon.lvpro"], "click", "window_post"), false);
    assert.deepEqual(guard.planClick({ app: "com.lemon.lvpro", x: 100, y: 80 }, ["com.lemon.lvpro"]), [
      "window_post",
      "app_post",
    ]);

    // 4. Explicit user raise (`置顶`) bumps epoch and cancels in-flight guard scopes
    const scope4 = await guard.beginGuard("com.lemon.lvpro");
    guard.cancelForExplicitRaise();
    frontmost = { pid: 10038, bundleId: "com.lemon.lvpro", displayName: "剪映专业版" };
    assert.equal(await scope4.enforce("click:window_post"), false);
    assert.equal(restores.length, 3);
  } finally {
    guard.close();
  }
});

test("AppSnapshotRegistry unifies get_app_state & query element fingerprints/redaction and serializes bindSnapshot before verifyLiveRef", async () => {
  const callOrder = [];
  let moveCheckCount = 0;

  const fakeAxBridge = {
    enabled: true,
    async bindSnapshot({ snapshotId }) {
      await new Promise((r) => setTimeout(r, 15));
      callOrder.push(`bind:${snapshotId}`);
      return { bound: 2 };
    },
    async verifyLiveRef({ snapshotId, elementIndex }) {
      callOrder.push(`verify:${snapshotId}:${elementIndex}`);
      moveCheckCount += 1;
      if (moveCheckCount === 1) {
        return { ok: false, moved: true, reason: "element_moved", message: "Button shifted" };
      }
      return { ok: false, moved: false, reason: "element_destroyed", message: "Node gone" };
    },
    async dropSnapshots() {
      return { ok: true };
    },
  };

  let issuedCount = 0;
  const registry = new AppSnapshotRegistry({
    axBridge: fakeAxBridge,
    processIdentityFn: async (pid) => ({ alive: true, guiApp: true, pid, processToken: `${pid}:tok1` }),
    rendererAccessibilityFn: async () => ({ supported: true, changed: false, enabled: true }),
    onSnapshotIssued: () => {
      issuedCount += 1;
    },
  });

  // 1. Fingerprint & secure-field parity between get_app_state text and query JSON
  const snapMeta = parseSnapshotMetadata(
    [
      "App=com.example.vault (pid 4242)",
      'Window: "Login", App: Vault.',
      "\t1 AXSecureTextField supersecret Help: Enter password ID: login_pwd",
      "\t2 按钮 提交 ID: submit_btn",
    ].join("\n")
  );
  const recorded = registry.recordMeta("Vault", snapMeta, {
    fromActionPeer: true,
    includeAx: true,
    includeScreenshot: true,
    actionDims: { width: 1280, height: 800 },
    processToken: "4242:tok1",
  });
  registry.bindSnapshotHandles(recorded);

  assert.equal(issuedCount, 1);
  assert.equal(recorded.elements.get("1").rawText, "[redacted]");
  assert.equal(recorded.elements.get("1").help, "Enter password");

  const queryMerged = await registry.ingestQueryMatches(
    "Vault",
    {
      window_title: "Login",
      matches: [
        { index: 1, role: "AXSecureTextField", value: "leaked!", help: "secret help", identifier: "login_pwd" },
        { index: 2, role: "按钮", title: "提交", identifier: "submit_btn" },
      ],
    },
    { queryPid: 4242, queryToken: "4242:tok1" }
  );
  registry.bindSnapshotHandles(queryMerged);

  assert.equal(queryMerged.elements.get("1").rawText, "[redacted]");
  assert.equal(queryMerged.elements.get("1").help, null);
  assert.equal(
    queryMerged.elements.get("1").fingerprint,
    recorded.elements.get("1").fingerprint,
    "Secure element fingerprint must match identically across get_app_state and query"
  );
  assert.equal(
    queryMerged.elements.get("2").fingerprint,
    recorded.elements.get("2").fingerprint,
    "Identified button fingerprint must match identically across get_app_state and query"
  );

  // 2. Unpinned ref with liveCheck.moved === true waits for pending bindSnapshot, refreshes state, and recovers
  const unpinnedCheck = await registry.validateTargetRef({
    app: "com.example.vault",
    parsedRef: { ok: true, hasElementRef: true, rawIndex: "2", snapshotId: null, displayRef: "2" },
    refreshActionState: async () => {
      const refreshed = registry.recordMeta("com.example.vault", snapMeta, {
        fromActionPeer: true,
        includeAx: true,
        includeScreenshot: true,
        actionDims: { width: 1280, height: 800 },
        processToken: "4242:tok1",
      });
      registry.bindSnapshotHandles(refreshed);
      return { isError: false };
    },
  });
  assert.equal(unpinnedCheck.ok, true);
  assert.equal(unpinnedCheck.element?.identifier, "submit_btn");
  assert.deepEqual(callOrder.slice(0, 3), ["bind:s1", "bind:s2", "verify:s2:2"]);

  // 3. Pinned @s3:2 with destroyed live node fails closed with STALE_REF
  const pinnedCheck = await registry.validateTargetRef({
    app: "Vault",
    parsedRef: {
      ok: true,
      hasElementRef: true,
      rawIndex: "2",
      snapshotId: "s3",
      displayRef: "@s3:2",
    },
    refreshActionState: async () => ({ isError: false }),
  });
  assert.equal(pinnedCheck.ok, false);
  assert.equal(pinnedCheck.errorCode, "STALE_REF");

  // 4. Concurrent bindSnapshotHandles() queued while flushPendingBinds() is awaiting MUST also complete
  const snap4 = registry.recordMeta("Vault", snapMeta, {
    fromActionPeer: true,
    includeAx: true,
    includeScreenshot: false,
    processToken: "4242:tok1",
  });
  registry.bindSnapshotHandles(snap4);
  const flushPromise = registry.flushPendingBinds();
  setTimeout(() => {
    const snap5 = registry.recordMeta("Vault", snapMeta, {
      fromActionPeer: true,
      includeAx: true,
      includeScreenshot: false,
      processToken: "4242:tok1",
    });
    registry.bindSnapshotHandles(snap5);
  }, 5);
  await flushPromise;
  assert.equal(callOrder.includes(`bind:${snap4.snapshotId}`), true);
  assert.equal(callOrder.includes("bind:s5"), true);
});

test("BackgroundActionExecutor routes Window-Local Delivery Floor, enforces set_value sky_bypass safety gate, sanitizes single-line newlines, and formats closed-loop readback", async () => {
  const peerCalls = [];
  const windowKeyLog = [];
  const windowTextLog = [];
  const pointClicks = [];
  let editableState = { editable: false, singleLine: true };

  const registry = new AppSnapshotRegistry();
  const focusGuard = new FocusPolicyGuard({
    resolveTargetInfo: (app) => ({
      appQuery: app,
      pid: 7788,
      bundleId: "com.lemon.lvpro",
      appDisplayName: "剪映专业版",
    }),
  });

  // Seed snapshot metadata for 剪映专业版
  const snapMeta = parseSnapshotMetadata(
    [
      "App=com.lemon.lvpro (pid 7788)",
      'Window: "剪映专业版", App: 剪映专业版.',
      '\t5 text field Value: "旧标题" ID: title_input',
    ].join("\n")
  );
  registry.recordMeta("com.lemon.lvpro", snapMeta, {
    fromActionPeer: true,
    includeAx: true,
    includeScreenshot: true,
    actionDims: { width: 1000, height: 500 },
    imageDigest: "digest-before",
    tinyWindowOverride: {
      wid: 30442,
      bounds: { x: 100, y: 200, width: 1000, height: 500 },
      imgWidth: 1000,
      imgHeight: 500,
    },
  });

  const executor = new BackgroundActionExecutor({
    actionPeer: {
      async callTool(name, args) {
        peerCalls.push({ name, args });
        return { isError: false, content: [{ type: "text", text: "ok" }] };
      },
    },
    focusPolicyGuard: focusGuard,
    registry,
    postActionDelayMs: 0,
    windowTransitionRetryDelayMs: 0,
    pointClickFn: async (pid, sx, sy, opts) => {
      pointClicks.push({ pid, sx, sy, wid: opts.wid });
      return { delivered: true, method: "window_post" };
    },
    windowClickFn: async () => ({ delivered: true }),
    windowKeyFn: async (_pid, key) => {
      windowKeyLog.push(key);
      return { delivered: true };
    },
    windowTextFn: async (_pid, text) => {
      windowTextLog.push(text);
      return { delivered: true };
    },
    editableFocusFn: async () => editableState,
    selectedTextInsertFn: async () => ({ delivered: false }),
  });

  // 1. Out-of-bounds tinyWindowOverride point click fails closed without dispatching
  const oob = await executor.dispatch({
    name: "click",
    app: "com.lemon.lvpro",
    cleanArgs: { app: "com.lemon.lvpro", x: 1200, y: 250 },
    parsedRef: { ok: true, hasElementRef: false },
    shouldFollow: true,
    eventSource: "ai",
  });
  assert.equal(oob.result.isError, true);
  assert.equal(pointClicks.length, 0);

  // 2. Valid tinyWindowOverride point click maps screenshot coords -> screen bounds
  const mappedClick = await executor.dispatch({
    name: "click",
    app: "com.lemon.lvpro",
    cleanArgs: { app: "com.lemon.lvpro", x: 500, y: 250 },
    parsedRef: { ok: true, hasElementRef: false },
    shouldFollow: true,
    eventSource: "ai",
  });
  assert.equal(mappedClick.result.isError, false);
  assert.equal(mappedClick.actionRouteKey, "click:window_post");
  assert.deepEqual(pointClicks[0], { pid: 7788, sx: 600, sy: 450, wid: 30442 });

  // 3. Record prior native set_value & sky_click steals -> sky_bypass triggers,
  //    but editableFocusFn = false MUST abort BEFORE cmd+a / BackSpace!
  focusGuard.recordSteal("com.lemon.lvpro", "set_value:native");
  focusGuard.recordSteal("com.lemon.lvpro", "click:sky_click");
  focusGuard.recordSteal("com.lemon.lvpro", "press_key:sky_key");
  focusGuard.recordSteal("com.lemon.lvpro", "type_text:sky_key");

  const unsafeBypass = await executor.dispatch({
    name: "set_value",
    app: "com.lemon.lvpro",
    cleanArgs: { app: "com.lemon.lvpro", element_index: "5", value: "新标题\n第二行" },
    parsedRef: { ok: true, hasElementRef: true, rawIndex: "5" },
    shouldFollow: true,
    eventSource: "ai",
  });
  assert.equal(
    windowKeyLog.length,
    0,
    "Safety gate must never press cmd+a or BackSpace when focused element is not editable!"
  );
  assert.equal(unsafeBypass.actionRouteKey, "set_value:native");

  // 4. Now editableFocusFn = { editable: true, singleLine: true } -> sky_bypass uses window_post/window_key floor and sanitizes \n -> space
  editableState = { editable: true, singleLine: true };
  const safeBypass = await executor.dispatch({
    name: "set_value",
    app: "com.lemon.lvpro",
    cleanArgs: { app: "com.lemon.lvpro", element_index: "5", value: "新标题\r\n副标题" },
    parsedRef: { ok: true, hasElementRef: true, rawIndex: "5" },
    shouldFollow: true,
    eventSource: "ai",
  });
  assert.equal(safeBypass.result.isError, false);
  assert.equal(safeBypass.actionRouteKey, "set_value:sky_bypass");
  assert.deepEqual(windowKeyLog, ["cmd+a", "BackSpace"]);
  assert.deepEqual(windowTextLog, ["新标题 副标题"]);

  // 5. Post-action readback verifies new value and appends Delivery footer
  const postMeta = parseSnapshotMetadata(
    [
      "App=com.lemon.lvpro (pid 7788)",
      'Window: "剪映专业版", App: 剪映专业版.',
      '\t5 text field Value: "新标题 副标题" ID: title_input',
    ].join("\n")
  );
  const verifiedReadback = await executor.verifyAndFormatReadBack({
    name: "set_value",
    cleanArgs: { app: "com.lemon.lvpro", element_index: "5", value: "新标题 副标题" },
    parsedRef: { ok: true, hasElementRef: true, rawIndex: "5" },
    ...safeBypass,
    checkAppRunningFn: async () => ({ running: true }),
    readBackStateFn: async () => {
      registry.recordMeta("com.lemon.lvpro", postMeta, {
        fromActionPeer: true,
        includeAx: true,
        includeScreenshot: false,
      });
      return {
        isError: false,
        content: [{ type: "text", text: 'Window: "剪映专业版"\n\t5 text field Value: "新标题 副标题"' }],
      };
    },
  });
  assert.equal(verifiedReadback.verified, true);
  assert.match(
    verifiedReadback.result.content[0].text,
    /\[Delivery: delivered_verified \| Route: set_value:sky_bypass\]/
  );
});

test("runJsonRpcStdioServer serializes async requests, attaches Sidecar pill hint exactly once on first non-error call, and guards oversized lines", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const responses = [];
  output.setEncoding("utf8");
  let outBuf = "";
  output.on("data", (chunk) => {
    outBuf += chunk;
    let nl;
    while ((nl = outBuf.indexOf("\n")) >= 0) {
      const line = outBuf.slice(0, nl).trim();
      outBuf = outBuf.slice(nl + 1);
      if (line) responses.push(JSON.parse(line));
    }
  });

  let closed = false;
  runJsonRpcStdioServer({
    input,
    output,
    registerSignals: false,
    maxLineBufferBytes: 512,
    serverInfo: { name: "test-mcp", version: "1.0.0" },
    instructions: "Test instructions",
    onListTools: async () => ({ tools: [{ name: "ping_tool" }] }),
    onCallTool: async (params, _req, { attachPillHint }) => {
      if (params.name === "slow_error") {
        await new Promise((r) => setTimeout(r, 20));
        return attachPillHint({
          isError: true,
          content: [{ type: "text", text: "failed" }],
        });
      }
      return attachPillHint({
        isError: false,
        content: [{ type: "text", text: `ok:${params.name}` }],
      });
    },
    onClose: async () => {
      closed = true;
    },
  });

  input.write(
    [
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "slow_error" } }),
      JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "first_ok" } }),
      JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "second_ok" } }),
    ].join("\n") + "\n"
  );

  // Oversized chunk triggers -32600 without crashing server
  input.write("x".repeat(700) + "\n");
  input.end();

  await new Promise((r) => setTimeout(r, 60));

  assert.equal(closed, true);
  assert.deepEqual(
    responses.map((r) => r.id),
    [1, 2, 3, 4, null],
    "Responses must preserve strict request serialization order"
  );
  // Error response #2 did NOT consume the one-time pill hint
  assert.equal(responses[1].result.content.length, 1);
  // First non-error response #3 received the Sidecar pill hint
  assert.equal(responses[2].result.content.length, 2);
  assert.match(responses[2].result.content[1].text, /sidecar:\/\/computer-use-preview\//);
  // Second non-error response #4 did NOT duplicate the pill hint
  assert.equal(responses[3].result.content.length, 1);
  // Oversized request rejected with -32600
  assert.equal(responses[4].error.code, -32600);
});

test("SidecarWebAdapter enforces token auth (exempting /healthz & /preload.js), deduplicates frame broadcasts, and serves /api/frame.jpg", async () => {
  const state = {
    activeApp: "com.apple.TextEdit",
    appDisplayName: "TextEdit",
    bundleId: "com.apple.TextEdit",
    pid: process.pid,
    windowTitle: "Untitled",
    occludedNote: false,
    activeSnapshotId: "s1",
    followAi: true,
    paused: false,
    aiStatus: "idle",
    lastAction: null,
    actionSeq: 0,
    frameSeq: 0,
    frameWidth: 0,
    frameHeight: 0,
    frameLatencyMs: 0,
    lastActivityAt: 0,
    recentActions: [],
    runningApps: [],
    permissions: { platform: "darwin", accessibility: true, screenRecording: true },
    headlessStats: {
      snapshotsIssued: 1,
      staleRefsBlocked: 0,
      focusStealsPrevented: 0,
      verifiedMutations: 0,
      totalMutations: 0,
    },
  };

  // Minimal 1x1 PNG base64
  const onePxPngBase64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

  const web = new SidecarWebAdapter({
    webPort: 0,
    uiToken: "secret-test-token",
    brokerBootId: "boot-test-1",
    state,
    getActiveActionCount: () => 0,
    isScreenLockedBackoff: () => false,
    refreshPermissionsQuietly: async () => {},
    refreshAppsList: async () => ({ apps: [] }),
    runSerializedAction: async (fn) => fn(),
    onSelectApp: async () => ({}),
    onBringToFront: async () => {},
    onInteract: async () => ({ ok: true }),
    captureStreamTick: async () => {},
  });

  const port = await web.start();
  try {
    // Public endpoints work without token
    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(health.status, 200);

    // Protected endpoints reject missing token with 401
    const unauth = await fetch(`http://127.0.0.1:${port}/api/state`);
    assert.equal(unauth.status, 401);

    // Frame deduplication increments frameSeq once for identical bytes
    web.updateFrameFromImageItem({ data: onePxPngBase64, mimeType: "image/png" }, 12);
    web.updateFrameFromImageItem({ data: onePxPngBase64, mimeType: "image/png" }, 9);
    assert.equal(state.frameSeq, 1);
    assert.equal(state.frameWidth, 1);
    assert.equal(state.frameHeight, 1);

    const frameRes = await fetch(`http://127.0.0.1:${port}/api/frame.jpg?token=secret-test-token`);
    assert.equal(frameRes.status, 200);
    assert.equal(frameRes.headers.get("content-type"), "image/png");
  } finally {
    await web.close();
  }
});

test("AtomicActExecutor seam handles INVALID_ACT_ARGS, AMBIGUOUS_TARGET, SCROLL_NO_PROGRESS, and verified success", async () => {
  let mode = "empty";
  let clicksSentCount = 0;
  let mutations = 0;
  let verifiedMutations = 0;
  const meta = {
    pid: 4321,
    bundleId: "com.test.App",
    appDisplayName: "TestApp",
    processToken: "4321:1",
    windowId: 77,
    windowTitle: "Main",
    windowBounds: { x: 0, y: 0, width: 800, height: 600 },
  };
  const takeover = new TakeoverController();

  const makeExecutor = () =>
    new AtomicActExecutor({
      getActionPeer: () => ({
        async callTool(name) {
          if (name === "query") {
            if (mode === "ambiguous") {
              return {
                isError: false,
                content: [
                  {
                    type: "text",
                    text: JSON.stringify({
                      window_id: 77,
                      window_title: "Main",
                      matches: [
                        { index: 1, title: "Export", bounds: { x: 10, y: 10, w: 60, h: 30 }, window_id: 77 },
                        { index: 2, title: "Export", bounds: { x: 220, y: 10, w: 60, h: 30 }, window_id: 77 },
                      ],
                    }),
                  },
                ],
              };
            }
            if (mode === "single") {
              return {
                isError: false,
                content: [
                  {
                    type: "text",
                    text: JSON.stringify({
                      window_id: 77,
                      window_title: "Main",
                      matches: [
                        { index: 1, title: "Export", bounds: { x: 10, y: 10, w: 60, h: 30 }, window_id: 77 },
                      ],
                    }),
                  },
                ],
              };
            }
            return {
              isError: false,
              content: [{ type: "text", text: JSON.stringify({ window_id: 77, window_title: "Main", matches: [] }) }],
            };
          }
          return { isError: false, content: [{ type: "text", text: "ok" }] };
        },
      }),
      registry: {
        getMeta: () => meta,
        ensureRendererAxAwake: async () => ({ changed: false }),
        getLatestSnapshot: () => ({ id: "snap-1", elements: new Map() }),
      },
      actionExecutor: {
        async executeActScroll() {
          return { delivered: true, route: "scroll:ax" };
        },
        async executeActClick() {
          clicksSentCount += 1;
          return {
            aborted: false,
            delivered: true,
            clicksSent: 1,
            routeKey: "click:window_post",
            localPoint: { x: 40, y: 25 },
          };
        },
      },
      takeoverController: takeover,
      getRunningAppIdentityFn: async () => ({ pid: 4321, bundleId: "com.test.App", processToken: "4321:1" }),
      isBrokerPaused: () => false,
      checkAppRunning: async () => ({ running: true, apps: [{ bundleId: "com.test.App", pid: 4321 }] }),
      safeGetAppState: async () => ({
        isError: false,
        content: [
          {
            type: "text",
            text:
              mode === "single"
                ? "App=TestApp (com.test.App) pid=4321\nWindow=Main (wid=77)\nExport Completed"
                : "App=TestApp (com.test.App) pid=4321\nWindow=Main (wid=77)\nStatic List Body",
          },
        ],
      }),
      processQueryResult: (_app, rawRes) => {
        const parsed = JSON.parse(rawRes.content[0].text);
        return {
          parsed,
          merged: { snapshotId: "snap-1", snapshot: { elements: new Map() } },
          windowId: 77,
          windowTitle: "Main",
        };
      },
      onMutationRecorded: () => {
        mutations += 1;
      },
      onVerifiedMutationRecorded: () => {
        verifiedMutations += 1;
      },
    });

  const parseJsonPayload = (res) => {
    const raw = res.content[0].text;
    const idx = raw.indexOf("{");
    return JSON.parse(raw.slice(idx));
  };

  const executor = makeExecutor();

  // 1. INVALID_ACT_ARGS when expect is missing
  const invalidRes = await executor.execute({ app: "com.test.App", target: { text: "Export" } });
  assert.equal(invalidRes.isError, true);
  assert.equal(parseJsonPayload(invalidRes).code, "INVALID_ACT_ARGS");

  // 2. AMBIGUOUS_TARGET when 2 distinct matches exist
  mode = "ambiguous";
  const ambRes = await executor.execute({
    app: "com.test.App",
    target: { text: "Export" },
    expect: { all_text: ["Export Completed"] },
  });
  assert.equal(ambRes.isError, true);
  assert.equal(parseJsonPayload(ambRes).code, "AMBIGUOUS_TARGET");
  assert.equal(clicksSentCount, 0);

  // 3. SCROLL_NO_PROGRESS after 2 identical viewport signatures
  mode = "empty";
  const noProgRes = await executor.execute({
    app: "com.test.App",
    target: { text: "MissingItem" },
    reveal: { max_scroll_steps: 4, direction: "down" },
    expect: { all_text: ["Export Completed"] },
  });
  assert.equal(noProgRes.isError, true);
  const noProgPayload = parseJsonPayload(noProgRes);
  assert.equal(noProgPayload.code, "SCROLL_NO_PROGRESS");
  assert.equal(noProgPayload.steps, 2);
  assert.equal(clicksSentCount, 0);

  // 4. Verified success on unique visible target + postcondition match
  mode = "single";
  const okRes = await executor.execute({
    app: "com.test.App",
    target: { text: "Export" },
    expect: { all_text: ["Export Completed"] },
  });
  assert.equal(okRes.isError, false);
  const okPayload = parseJsonPayload(okRes);
  assert.equal(okPayload.status, "ok");
  assert.equal(okPayload.verified, true);
  assert.equal(okPayload.clicksSent, 1);
  assert.equal(mutations, 1);
  assert.equal(verifiedMutations, 1);
});



