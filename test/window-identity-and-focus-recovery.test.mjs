import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import vm from "node:vm";

import { BackgroundActionExecutor } from "../src/action-executor.mjs";
import { AppSnapshotRegistry } from "../src/app-snapshot-registry.mjs";
import { BRIDGE_JXA_SOURCE, PersistentAxBridge } from "../src/ax-bridge.mjs";
import {
  dispatchBackgroundPointClickDetailed,
  extractResultText,
  parseSnapshotMetadata,
} from "../src/background-policy.mjs";
import { BrokerRpcClient } from "../src/broker-client.mjs";
import { ComputerUseBrokerServer } from "../src/broker-sidecar.mjs";
import { SCRIPT_RUNNER_BIN_PATH } from "../src/constants.mjs";
import { FocusPolicyGuard } from "../src/focus-policy-guard.mjs";
import { computeFrameDigest, didUiStructurallyChange } from "../src/headless-engine.mjs";
import { PreviewStreamManager } from "../src/preview-stream.mjs";
import { buildBrokerToolCallForReplOp } from "../src/repl-schema.mjs";

function makeTinyJpgBase64(seed = 0x11) {
  return Buffer.from([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x03, 0x20, 0x05, 0x00, 0x01, 0x01, seed, 0x00,
    0xff, 0xd9,
  ]).toString("base64");
}

test("Home -> Editor transition reclaims focus without blacklisting sky_click on the new window, and read_back never blacklists sky_click", async () => {
  const sock = `/tmp/agy-cua-win-trans-${process.pid}-${Date.now()}.sock`;
  const token = "test-win-trans-token";
  const miniBefore = makeTinyJpgBase64(0x11);
  const miniAfter = makeTinyJpgBase64(0x22);

  let currentFront = { pid: 1111, bundleId: "com.google.antigravity", displayName: "Antigravity" };
  let activeWindow = "home";
  let currentWid = 4600;
  let focusSteals = 0;
  const peerCalls = [];
  const windowClickCalls = [];

  const peer = {
    async listTools() {
      return { tools: [] };
    },
    async callTool(name, args) {
      peerCalls.push({ name, args });
      if (name === "list_apps") {
        return {
          isError: false,
          content: [{ type: "text", text: "剪映专业版 — com.lemon.lvpro [running]" }],
        };
      }
      if (name === "get_app_state") {
        const isEditor = activeWindow === "editor";
        return {
          isError: false,
          content: [
            {
              type: "text",
              text: [
                `App=com.lemon.lvpro (pid ${process.pid})`,
                `Window: "${isEditor ? "Editor" : "Home"}", App: 剪映专业版.`,
                isEditor
                  ? '\t1 button "Export" ID: export_btn\n\t2 button "Text" ID: text_tab'
                  : '\t1 button "Open Project" ID: open_proj',
              ].join("\n"),
            },
            { type: "image", mimeType: "image/jpeg", data: isEditor ? miniAfter : miniBefore },
          ],
        };
      }
      if (name === "click") {
        if (args.click_method === "sky_click") {
          currentFront = { pid: process.pid, bundleId: "com.lemon.lvpro", displayName: "剪映专业版" };
          if (activeWindow === "home") {
            activeWindow = "editor";
            currentWid = 4702;
          }
        }
        return { isError: false, content: [{ type: "text", text: "ok" }] };
      }
      return { isError: false, content: [{ type: "text", text: "ok" }] };
    },
    close() {},
  };

  const axBridge = {
    enabled: true,
    setSyntheticEventTag() {},
    async ensureManualAx() {
      return { supported: false, changed: false, enabled: false };
    },
    async checkPermissions() {
      return { accessibility: true, screenRecording: true };
    },
    async getFrontmostApp() {
      return currentFront;
    },
    async restoreFrontmostApp(pid) {
      focusSteals += 1;
      currentFront = { pid, bundleId: "com.google.antigravity", displayName: "Antigravity" };
      return true;
    },
    async getFocusedWindowInfo() {
      return {
        wid: currentWid,
        title: currentWid === 4702 ? "Editor" : "Home",
        windowBounds: { x: 40, y: 40, w: 1280, h: 800 },
      };
    },
  };

  const broker = new ComputerUseBrokerServer({
    webPort: 0,
    uiToken: token,
    socketPath: sock,
    actionPeer: peer,
    streamPeer: peer,
    axBridge,
    focusController: {
      async getFrontmostApp() {
        return currentFront;
      },
      async restoreFrontmostApp(pid) {
        focusSteals += 1;
        currentFront = { pid, bundleId: "com.google.antigravity", displayName: "Antigravity" };
        return true;
      },
      sweepDelaysMs: [],
    },
    processIdentityFn: async (pid) => ({
      alive: true,
      guiApp: true,
      pid,
      processToken: `${pid}:jy1`,
    }),
    rendererAccessibilityFn: async () => ({
      supported: false,
      changed: false,
      enabled: false,
      definitive: true,
    }),
    windowClickFn: async (pid, opts) => {
      windowClickCalls.push({ pid, opts });
      return { delivered: true, method: "window_post", wid: opts.wid || currentWid };
    },
  });

  await broker.start();
  const client = new BrokerRpcClient({ socketPath: sock });
  try {
    await client.request("tools/call", {
      name: "get_app_state",
      arguments: { app: "com.lemon.lvpro", include_ax: true, include_screenshot: true },
      source: "ai",
    });

    // 1. Click Home (4600) -> opens Editor (4702) and steals focus
    const homeClick = await client.request("tools/call", {
      name: "click",
      arguments: { app: "com.lemon.lvpro", x: 300, y: 200, click_method: "sky_click" },
      source: "ai",
    });
    assert.equal(Boolean(homeClick.isError), false);
    assert.equal(focusSteals, 1, "Focus must be reclaimed after Home -> Editor transition");
    assert.match(extractResultText(homeClick), /Route: click:sky_click/);

    // 2. Next click on Editor (4702) via auto AND explicit sky_click MUST still reach sky_click!
    peerCalls.length = 0;
    const editorAuto = await client.request("tools/call", {
      name: "click",
      arguments: { app: "com.lemon.lvpro", x: 500, y: 300 },
      source: "ai",
    });
    assert.equal(Boolean(editorAuto.isError), false);
    assert.equal(
      peerCalls.some((c) => c.name === "click" && c.args.click_method === "sky_click"),
      true,
      "Editor window 4702 auto click must still use sky_click after Home -> Editor transition"
    );
    assert.equal(windowClickCalls.length, 0);
    assert.match(extractResultText(editorAuto), /Route: click:sky_click/);

    // 3. Test read_back focus activation does NOT blacklist click:sky_click on a clean click
    activeWindow = "editor";
    currentWid = 4702;
    const cleanScope = { pid: process.pid, processToken: `${process.pid}:jy1`, windowId: 4702 };
    const cleanGuard = new FocusPolicyGuard({
      focusController: {
        async getFrontmostApp() {
          return currentFront;
        },
        async restoreFrontmostApp(pid) {
          focusSteals += 1;
          currentFront = { pid, bundleId: "com.google.antigravity", displayName: "Antigravity" };
          return true;
        },
        sweepDelaysMs: [],
      },
      resolveTargetInfo: () => ({
        appQuery: "com.lemon.lvpro",
        pid: process.pid,
        bundleId: "com.lemon.lvpro",
        appDisplayName: "剪映专业版",
      }),
    });
    currentFront = { pid: 1111, bundleId: "com.google.antigravity", displayName: "Antigravity" };
    const readScope = await cleanGuard.beginGuard("com.lemon.lvpro", { routeScope: cleanScope });
    currentFront = { pid: process.pid, bundleId: "com.lemon.lvpro", displayName: "剪映专业版" };
    const reclaimedOnReadBack = await readScope.enforce("read_back", { recordRoutePenalty: false });
    assert.equal(reclaimedOnReadBack, true, "read_back steal must still reclaim focus");
    assert.deepEqual(
      cleanGuard.planClick({ app: "com.lemon.lvpro", click_method: "sky_click" }, ["com.lemon.lvpro"], {
        routeScope: cleanScope,
      }),
      ["sky_click"]
    );
    assert.equal(cleanGuard.tracker.hasRouteSteal("com.lemon.lvpro", "read_back", { routeScope: cleanScope }), false);
    assert.equal(cleanGuard.tracker.hasRouteSteal("com.lemon.lvpro", "click:sky_click", { routeScope: cleanScope }), false);
  } finally {
    await client.close();
    await broker.close();
  }
});

test("Same-WID query keeps screenshot dims while cross-WID query clears dims and rejects stale coordinate clicks", async () => {
  const registry = new AppSnapshotRegistry();
  const focusGuard = new FocusPolicyGuard({
    resolveTargetInfo: (app) => ({
      appQuery: app,
      pid: 7788,
      bundleId: "com.lemon.lvpro",
      appDisplayName: "剪映专业版",
    }),
  });

  const snapMeta = parseSnapshotMetadata(
    [
      "App=com.lemon.lvpro (pid 7788)",
      'Window: "Home", App: 剪映专业版.',
      '\t1 button "Open" ID: open_btn',
    ].join("\n")
  );
  snapMeta.windowId = 4600;
  registry.recordMeta("com.lemon.lvpro", snapMeta, {
    fromActionPeer: true,
    includeAx: true,
    includeScreenshot: true,
    actionDims: { width: 1280, height: 800 },
    imageDigest: "home-digest",
  });

  // Same WID query preserves screenshot dimensions
  await registry.ingestQueryMatches("com.lemon.lvpro", {
    window_id: 4600,
    window_title: "Home",
    matches: [{ index: 1000001, role: "AXButton", title: "Open", window_id: 4600 }],
  });
  let metaNow = registry.getMeta("com.lemon.lvpro");
  assert.equal(metaNow.actionHasScreenshot, true);
  assert.equal(metaNow.actionFrameWidth, 1280);
  assert.equal(metaNow.actionFrameHeight, 800);

  // Cross-WID query (4600 -> 4702) clears old window screenshot dimensions
  await registry.ingestQueryMatches("com.lemon.lvpro", {
    window_id: 4702,
    window_title: "Editor",
    matches: [{ index: 1000002, role: "AXButton", title: "Export", window_id: 4702 }],
  });
  metaNow = registry.getMeta("com.lemon.lvpro");
  assert.equal(metaNow.windowId, 4702);
  assert.equal(metaNow.actionHasScreenshot, false);
  assert.equal(metaNow.actionFrameWidth, 0);
  assert.equal(metaNow.actionFrameHeight, 0);

  let windowClickCalled = false;
  const executor = new BackgroundActionExecutor({
    actionPeer: {
      async callTool() {
        return { isError: false, content: [{ type: "text", text: "ok" }] };
      },
    },
    focusPolicyGuard: focusGuard,
    registry,
    postActionDelayMs: 0,
    windowTransitionRetryDelayMs: 0,
    windowClickFn: async () => {
      windowClickCalled = true;
      return { delivered: true, method: "window_post" };
    },
  });

  const staleCoordClick = await executor.dispatch({
    name: "click",
    app: "com.lemon.lvpro",
    cleanArgs: { app: "com.lemon.lvpro", x: 100, y: 100, click_method: "window_post" },
    parsedRef: { ok: true, hasElementRef: false },
    fallbackDims: { width: 1280, height: 800, sameApp: true },
  });
  assert.equal(staleCoordClick.result.isError, true);
  assert.match(
    extractResultText(staleCoordClick.result),
    /Current window has no matching screenshot geometry; run get_app_state before coordinate click\./
  );
  assert.equal(windowClickCalled, false);
});

test("Cold query native alias + same WID/title/frameDigest stays delivered_unverified without false structural change", async () => {
  const registry = new AppSnapshotRegistry();
  const focusGuard = new FocusPolicyGuard({
    resolveTargetInfo: (app) => ({
      appQuery: app,
      pid: 7788,
      bundleId: "com.lemon.lvpro",
      appDisplayName: "剪映专业版",
    }),
  });
  const imgB64 = makeTinyJpgBase64(0x33);
  const sameDigest = computeFrameDigest(Buffer.from(imgB64, "base64"));

  await registry.ingestQueryMatches(
    "com.lemon.lvpro",
    {
      window_id: 4702,
      window_title: "Editor",
      matches: [{ index: 1000003, role: "AXButton", title: "Export", window_id: 4702 }],
    },
    { queryPid: 7788 }
  );
  const preMeta = registry.getMeta("com.lemon.lvpro");
  preMeta.lastImageDigest = sameDigest;
  const preSnap = registry.getLatestSnapshot("com.lemon.lvpro");
  assert.equal(preSnap.source, "query");

  const executor = new BackgroundActionExecutor({
    actionPeer: {
      async callTool() {
        return { isError: false, content: [{ type: "text", text: "ok" }] };
      },
    },
    focusPolicyGuard: focusGuard,
    registry,
    postActionDelayMs: 0,
    windowTransitionRetryDelayMs: 0,
    windowClickFn: async () => ({ delivered: true, method: "window_post", wid: 4702 }),
  });

  const dispatched = await executor.dispatch({
    name: "click",
    app: "com.lemon.lvpro",
    cleanArgs: {
      app: "com.lemon.lvpro",
      element_index: "1000003",
      click_method: "window_post",
    },
    parsedRef: { ok: true, hasElementRef: true, rawIndex: "1000003" },
    validatedSnapshot: preSnap,
    validatedElement: preSnap.elements.get("1000003"),
    fallbackDims: { width: 0, height: 0, sameApp: true },
  });
  assert.equal(dispatched.result.isError, false);

  const readBackOut = await executor.verifyAndFormatReadBack({
    name: "click",
    cleanArgs: { app: "com.lemon.lvpro", element_index: "1000003" },
    parsedRef: { ok: true, hasElementRef: true, rawIndex: "1000003" },
    ...dispatched,
    readBackStateFn: async () => {
      const postText = [
        "App=com.lemon.lvpro (pid 7788)",
        'Window: "Editor", App: 剪映专业版.',
        '\t1 button "Export" ID: export_btn',
        '\t2 button "Text" ID: text_tab',
        '\t3 button "Audio" ID: audio_tab',
      ].join("\n");
      const meta = parseSnapshotMetadata(postText);
      meta.windowId = 4702;
      registry.recordMeta("com.lemon.lvpro", meta, {
        fromActionPeer: true,
        includeAx: true,
        includeScreenshot: true,
        actionDims: { width: 1280, height: 800 },
        imageDigest: sameDigest,
        source: "snapshot",
      });
      const postSnap = registry.getLatestSnapshot("com.lemon.lvpro");
      assert.equal(
        didUiStructurallyChange(preSnap, postSnap),
        false,
        "Cold query baseline must not count AX population as structural UI change"
      );
      return {
        isError: false,
        content: [
          { type: "text", text: postText },
          { type: "image", mimeType: "image/jpeg", data: imgB64 },
        ],
      };
    },
  });

  assert.equal(readBackOut.verified, false);
  assert.equal(readBackOut.deliveryStatus, "delivered_unverified");
  assert.match(extractResultText(readBackOut.result), /Delivery: delivered_unverified \| Route: click:window_post/);
});

test("handleWindowClick fails closed on 0-post and reports sent_unknown on partial post (WRITE_OUTCOME_UNKNOWN in PersistentAxBridge)", async () => {
  let postMode = "fail_all"; // "fail_all" | "fail_up"
  let cgWindows = [
    {
      kCGWindowNumber: 55,
      kCGWindowOwnerPID: 1234,
      kCGWindowLayer: 0,
      kCGWindowAlpha: 1,
      kCGWindowName: "Editor",
      kCGWindowBounds: { X: 10, y: 20, Y: 20, Width: 500, Height: 400 },
    },
  ];
  const sandbox = {
    ObjC: {
      import() {},
      bindFunction(fnName) {
        if (fnName === "SLEventPostToPid") {
          throw new Error("unavailable");
        }
      },
      unwrap(v) {
        return v?.__val !== undefined ? v.__val : v;
      },
      deepUnwrap(v) {
        return v;
      },
      castRefToObject(r) {
        return r;
      },
    },
    Ref: () => [null],
    $: Object.assign((s) => ({ __val: s }), {
      CGWindowListCopyWindowInfo: () => cgWindows,
      AXUIElementCreateApplication: () => ({}),
      AXUIElementSetMessagingTimeout: () => 0,
      AXUIElementCopyAttributeValue: () => -25205,
      NSFileHandle: {
        fileHandleWithStandardInput: { availableData: { length: 0 } },
        fileHandleWithStandardOutput: { writeData() {} },
      },
      NSProcessInfo: { processInfo: { systemUptime: 1 } },
      NSThread: { sleepForTimeInterval() {} },
      CGEventSourceCreate: () => ({}),
      CGEventCreateMouseEvent: (_src, evType) => {
        if (postMode === "fail_all") return null;
        if (postMode === "fail_up" && (evType === 2 || evType === 4 || evType === 26)) return null;
        return {};
      },
      CGEventSetTimestamp() {},
      CGEventSetIntegerValueField() {},
      CGEventSetDoubleValueField() {},
      CGEventPostToPid() {},
      CFRelease() {},
      kCGMouseEventClickState: 1,
      kCGMouseEventButtonNumber: 3,
    }),
  };
  vm.createContext(sandbox);
  vm.runInContext(BRIDGE_JXA_SOURCE, sandbox);

  const zeroRes = sandbox.handleWindowClick({
    pid: 1234,
    screenCoords: true,
    x: 100,
    y: 100,
    wid: 55,
    allowAppPostFallback: true,
  });
  assert.equal(zeroRes.delivered, false);
  assert.equal(zeroRes.method, null);
  assert.equal(zeroRes.reason, "event_post_failed");

  postMode = "fail_up";
  const partialRes = sandbox.handleWindowClick({
    pid: 1234,
    screenCoords: true,
    x: 100,
    y: 100,
    wid: 55,
    allowAppPostFallback: true,
  });
  assert.equal(partialRes.delivered, false);
  assert.equal(partialRes.deliveryState, "sent_unknown");
  assert.equal(partialRes.reason, "partial_click_post");

  const bridge = new PersistentAxBridge({
    enabled: true,
    spawnFn: () => {
      const proc = new EventEmitter();
      proc.stdout = new PassThrough();
      proc.stderr = new PassThrough();
      proc.exitCode = null;
      proc.killed = false;
      proc.stdin = new Writable({
        write(chunk, _enc, cb) {
          for (const line of String(chunk).split("\n").filter(Boolean)) {
            const msg = JSON.parse(line);
            const res =
              msg.method === "window_click"
                ? { delivered: false, deliveryState: "sent_unknown", method: "window_post", reason: "partial_click_post", wid: 55 }
                : { ok: true };
            queueMicrotask(() =>
              proc.stdout.write(`${JSON.stringify({ id: msg.id, ok: true, result: res })}\n`)
            );
          }
          cb();
        },
      });
      proc.kill = () => {
        proc.exitCode = 0;
        queueMicrotask(() => proc.emit("exit", 0, null));
        return true;
      };
      return proc;
    },
  });
  try {
    await assert.rejects(
      () => bridge.postWindowClick(1234, { wid: 55, localPoint: { x: 20, y: 20 } }),
      (err) => err?.code === "WRITE_OUTCOME_UNKNOWN" && err?.deliveryState === "sent_unknown" && err?.dispatched === true
    );
  } finally {
    await bridge.close();
  }
});

test("restoreFrontmostApp() === false skips recordSteal and onFocusStealPrevented", async () => {
  let frontmost = { pid: 1111, bundleId: "com.google.antigravity", displayName: "Antigravity" };
  let preventedCount = 0;
  const scope = { pid: 7788, processToken: "7788:tok", windowId: 901 };

  const guard = new FocusPolicyGuard({
    focusController: {
      async getFrontmostApp() {
        return frontmost;
      },
      async restoreFrontmostApp() {
        return false;
      },
      sweepDelaysMs: [],
    },
    resolveTargetInfo: () => ({
      appQuery: "com.lemon.lvpro",
      pid: 7788,
      bundleId: "com.lemon.lvpro",
      appDisplayName: "剪映专业版",
    }),
    onFocusStealPrevented: () => {
      preventedCount += 1;
    },
  });

  const guardScope = await guard.beginGuard("com.lemon.lvpro", { routeScope: scope });
  frontmost = { pid: 7788, bundleId: "com.lemon.lvpro", displayName: "剪映专业版" };
  const reclaimed = await guardScope.enforce("click:sky_click", { routeScope: scope });
  guardScope.finish("click:sky_click", { alreadyRecorded: reclaimed, routeScope: scope });

  assert.equal(reclaimed, false);
  assert.equal(preventedCount, 0);
  assert.equal(guard.tracker.hasRouteSteal("com.lemon.lvpro", "click:sky_click", { routeScope: scope }), false);
  assert.deepEqual(
    guard.planClick({ app: "com.lemon.lvpro" }, ["com.lemon.lvpro"], { routeScope: scope }),
    ["sky_click", "app_post"]
  );
});

test("CUAScriptRunner.app accepts camelCase & snake_case click/key options, rejects conflicts, and returns structured receipts", async (t) => {
  if (process.platform !== "darwin" || !existsSync(SCRIPT_RUNNER_BIN_PATH)) {
    t.skip("CUAScriptRunner.app requires macOS built native runner");
    return;
  }

  const sock = `/tmp/agy-cua-repl-opt-${process.pid}-${Date.now()}.sock`;
  const token = "test-repl-opt-token";
  const mini = makeTinyJpgBase64(0x44);
  const peerCalls = [];
  let stateToggle = false;

  const peer = {
    async listTools() {
      return { tools: [{ name: "list_apps" }, { name: "get_app_state" }, { name: "click" }, { name: "press_key" }, { name: "type_text" }] };
    },
    async callTool(name, args) {
      peerCalls.push({ name, args });
      if (name === "list_apps") {
        return { isError: false, content: [{ type: "text", text: "Finder — com.apple.finder [running]" }] };
      }
      if (name === "get_app_state") {
        stateToggle = !stateToggle;
        return {
          isError: false,
          content: [
            {
              type: "text",
              text: `App=com.apple.finder (pid ${process.pid})\nWindow: "${stateToggle ? "A" : "B"}", App: Finder.\n\t1 button "OK"`,
            },
            { type: "image", mimeType: "image/jpeg", data: mini },
          ],
        };
      }
      return { isError: false, content: [{ type: "text", text: "ok" }] };
    },
    close() {},
  };

  const broker = new ComputerUseBrokerServer({
    webPort: 0,
    uiToken: token,
    socketPath: sock,
    actionPeer: peer,
    streamPeer: peer,
    focusController: {
      async getFrontmostApp() {
        return { pid: 1111, bundleId: "com.google.antigravity", displayName: "Antigravity" };
      },
      async restoreFrontmostApp() {
        return true;
      },
      sweepDelaysMs: [],
    },
    processIdentityFn: async (pid) => ({ alive: true, guiApp: true, pid, processToken: `${pid}:repl` }),
    rendererAccessibilityFn: async () => ({ supported: false, changed: false, enabled: false, definitive: true }),
    windowClickFn: async () => ({ delivered: true, method: "window_post", wid: 101 }),
    windowKeyFn: async () => ({ delivered: true, wid: 101 }),
  });

  await broker.start();
  const client = new BrokerRpcClient({ socketPath: sock, enableFallback: false });
  try {
    const res = await client.request("repl/run", {
      code: [
        `const app = await cua.getApp("com.apple.finder", { initialState: false });`,
        `await app.getAXState();`,
        `const r1 = await app.click("1", { click_method: "window_post", mouse_button: "left", click_count: 1 });`,
        `const r2 = await app.pressKey("space", { key_method: "sky_key" });`,
        `let conflictMsg = "";`,
        `try {`,
        `  await app.click("1", { clickMethod: "sky_click", click_method: "window_post" });`,
        `} catch (e) {`,
        `  conflictMsg = String(e && e.message || e);`,
        `}`,
        `nodeRepl.write(JSON.stringify({ r1, r2, conflictMsg }));`,
      ].join("\n"),
    });
    assert.equal(Boolean(res.isError), false, JSON.stringify(res));
    const jsonText = res.content.find((c) => c.type === "text" && c.text.startsWith("{"))?.text;
    assert.ok(jsonText, `Expected JSON output in ${JSON.stringify(res.content)}`);
    const parsed = JSON.parse(jsonText);
    assert.equal(parsed.r1.ok, true);
    assert.equal(parsed.r1.route, "click:window_post");
    assert.ok(parsed.r1.delivery);
    assert.equal(parsed.r2.ok, true);
    assert.equal(parsed.r2.route, "press_key:sky_key");
    assert.match(parsed.conflictMsg, /Conflicting click options: clickMethod and click_method/);
    assert.equal(
      peerCalls.some((c) => c.name === "press_key" && c.args.key_method === "sky_key"),
      true
    );
  } finally {
    await client.close();
    await broker.close();
  }
});

test("JXA handleFocusedWindow strict AX matching, multi-click partial/exception/pixel-resize, fail-closed handleWindowKey/Text, and PersistentAxBridge crash sent_unknown", async () => {
  const cgWindows = [
    {
      kCGWindowOwnerPID: 1234,
      kCGWindowNumber: 55,
      kCGWindowLayer: 0,
      kCGWindowAlpha: 1,
      kCGWindowName: "Main",
      kCGWindowBounds: { X: 100, Y: 100, Width: 1024, Height: 768 },
    },
    {
      kCGWindowOwnerPID: 1234,
      kCGWindowNumber: 56,
      kCGWindowLayer: 0,
      kCGWindowAlpha: 1,
      kCGWindowName: "Secondary",
      kCGWindowBounds: { X: 200, Y: 200, Width: 600, Height: 400 },
    },
  ];
  let postMode = "ok";
  let evIndex = 0;
  let postCount = 0;
  let throwOnPostAt = 0;
  const sandbox = {
    ObjC: {
      import() {},
      bindFunction() {},
      deepUnwrap: (v) => v,
      unwrap: (v) => v,
      castRefToObject: (v) => v,
    },
    Application: Object.assign(() => ({}), { currentApplication: () => ({}) }),
    delay() {},
    Ref: () => [null],
    $: Object.assign((s) => ({ __val: s }), {
      CGWindowListCopyWindowInfo: () => cgWindows,
      AXUIElementCreateApplication: () => ({}),
      AXUIElementSetMessagingTimeout: () => 0,
      AXUIElementCopyAttributeValue: () => -25205,
      NSFileHandle: {
        fileHandleWithStandardInput: { availableData: { length: 0 } },
        fileHandleWithStandardOutput: { writeData() {} },
      },
      NSProcessInfo: { processInfo: { systemUptime: 1 } },
      NSThread: { sleepForTimeInterval() {} },
      CGEventSourceCreate: () => ({}),
      CGEventCreateMouseEvent: () => {
        const idx = evIndex++;
        if (postMode === "fail_second_click" && idx >= 2) return null;
        return {};
      },
      CGEventCreateKeyboardEvent: () => ({}),
      CGEventKeyboardSetUnicodeString() {},
      CGEventSetFlags() {},
      CGEventSetTimestamp() {},
      CGEventSetIntegerValueField() {},
      CGEventSetDoubleValueField() {},
      CGEventPostToPid() {
        postCount += 1;
        if (throwOnPostAt > 0 && postCount === throwOnPostAt) {
          throw new Error("simulated_cg_post_throw");
        }
      },
      CFRelease() {},
      kCGMouseEventClickState: 1,
      kCGMouseEventButtonNumber: 3,
    }),
  };
  vm.createContext(sandbox);
  vm.runInContext(BRIDGE_JXA_SOURCE, sandbox);

  const focusedUnknown = sandbox.handleFocusedWindow({ pid: 1234 });
  assert.equal(focusedUnknown.wid, null);
  assert.deepEqual(Array.from(focusedUnknown.windowIds), [55, 56]);

  postMode = "fail_second_click";
  evIndex = 0;
  postCount = 0;
  const secondClickFail = sandbox.handleWindowClick({
    pid: 1234,
    screenCoords: true,
    x: 200,
    y: 200,
    wid: 55,
    clickCount: 2,
    allowAppPostFallback: true,
  });
  assert.equal(secondClickFail.delivered, false);
  assert.equal(secondClickFail.deliveryState, "sent_unknown");
  assert.equal(secondClickFail.reason, "partial_click_post");

  postMode = "ok";
  evIndex = 0;
  postCount = 0;
  throwOnPostAt = 2;
  const postExceptionRes = sandbox.handleWindowClick({
    pid: 1234,
    screenCoords: true,
    x: 200,
    y: 200,
    wid: 55,
    allowAppPostFallback: true,
  });
  assert.equal(postExceptionRes.delivered, false);
  assert.equal(postExceptionRes.deliveryState, "sent_unknown");
  assert.equal(postExceptionRes.reason, "click_post_exception");

  throwOnPostAt = 0;
  postCount = 0;
  const pixelResizeRes = sandbox.handleWindowClick({
    pid: 1234,
    screenCoords: false,
    x: 100,
    y: 100,
    frameWidth: 800,
    frameHeight: 600,
    expectedWindowSize: { width: 800, height: 600 },
    wid: 55,
    allowAppPostFallback: true,
  });
  assert.equal(pixelResizeRes.delivered, false);
  assert.equal(pixelResizeRes.reason, "window_resized");
  assert.equal(postCount, 0);

  const missingKeyRes = sandbox.handleWindowKey({ pid: 1234, key: "space", wid: 9999 });
  assert.equal(missingKeyRes.delivered, false);
  assert.equal(missingKeyRes.reason, "window_not_found");
  assert.equal(postCount, 0);

  const missingTextRes = sandbox.handleWindowText({ pid: 1234, text: "abc", wid: 9999 });
  assert.equal(missingTextRes.delivered, false);
  assert.equal(missingTextRes.reason, "window_not_found");
  assert.equal(postCount, 0);

  const crashingBridge = new PersistentAxBridge({
    enabled: true,
    spawnFn: () => {
      const proc = new EventEmitter();
      proc.stdout = new PassThrough();
      proc.stderr = new PassThrough();
      proc.exitCode = null;
      proc.killed = false;
      proc.stdin = new Writable({
        write(chunk, _enc, cb) {
          for (const line of String(chunk).split("\n").filter(Boolean)) {
            const msg = JSON.parse(line);
            if (msg.method === "window_click") {
              setTimeout(() => {
                proc.exitCode = 137;
                proc.emit("exit", 137, "SIGKILL");
              }, 10);
            } else {
              queueMicrotask(() =>
                proc.stdout.write(`${JSON.stringify({ id: msg.id, ok: true, result: { ok: true } })}\n`)
              );
            }
          }
          cb();
        },
      });
      proc.kill = () => {
        proc.exitCode = 0;
        queueMicrotask(() => proc.emit("exit", 0, null));
        return true;
      };
      return proc;
    },
  });
  try {
    await assert.rejects(
      () => crashingBridge.postWindowClick(1234, { wid: 55, localPoint: { x: 20, y: 20 } }),
      (err) => err?.code === "WRITE_OUTCOME_UNKNOWN" && err?.deliveryState === "sent_unknown" && err?.dispatched === true
    );
  } finally {
    await crashingBridge.close();
  }
});

test("dispatchBackgroundPointClickDetailed forwards beforeWriteCheck, rethrows WRITE_OUTCOME_UNKNOWN, and fails closed on explicit wid window_not_found", async () => {
  let checkCalls = 0;
  const beforeWriteCheck = () => {
    checkCalls += 1;
  };

  await assert.rejects(
    () =>
      dispatchBackgroundPointClickDetailed(process.pid, 150, 150, {
        wid: 55,
        allowAppPostFallback: true,
        beforeWriteCheck,
        axBridge: {
          enabled: true,
          async postWindowClick(_pid, opts) {
            opts.beforeWriteCheck?.();
            const err = new Error("sent_unknown");
            err.code = "WRITE_OUTCOME_UNKNOWN";
            err.deliveryState = "sent_unknown";
            err.dispatched = true;
            throw err;
          },
        },
      }),
    (err) => err?.code === "WRITE_OUTCOME_UNKNOWN" && err?.deliveryState === "sent_unknown"
  );
  assert.equal(checkCalls, 1);

  const missingWid = await dispatchBackgroundPointClickDetailed(process.pid, 150, 150, {
    wid: 55,
    allowAppPostFallback: true,
    axBridge: {
      enabled: true,
      async postWindowClick() {
        return { delivered: false, method: "window_post", reason: "window_not_found" };
      },
    },
  });
  assert.equal(missingWid.delivered, false);
  assert.equal(missingWid.method, "window_post");
  assert.equal(missingWid.reason, "window_not_found");

  await assert.rejects(
    () =>
      dispatchBackgroundPointClickDetailed(process.pid, 150, 150, {
        axBridge: null,
        allowAppPostFallback: true,
        beforeWriteCheck: () => {
          const err = new Error("PAUSED_BEFORE_OSASCRIPT");
          err.aborted = true;
          throw err;
        },
      }),
    (err) => err?.aborted === true
  );
});

test("AppSnapshotRegistry distinguishes existing-window switches from new windows and clears proven screenshot on WID-less query", async () => {
  const reg = new AppSnapshotRegistry();
  assert.equal(
    reg.detectNewWindowTransition({ wid: 4600, windowIds: [4600, 4601] }, { wid: 4601 }),
    false
  );
  assert.equal(
    reg.detectNewWindowTransition({ wid: 4600, windowIds: [4600, 4601] }, { wid: 4702 }),
    true
  );

  const screenMeta = parseSnapshotMetadata(
    [`App=com.lemon.lvpro (pid ${process.pid})`, 'Window: "Main", App: 剪映专业版.', '\t1 button "OK" ID: ok'].join("\n")
  );
  reg.recordMeta(
    "com.lemon.lvpro",
    { ...screenMeta, windowId: 4600 },
    {
      fromActionPeer: true,
      includeAx: true,
      includeScreenshot: true,
      actionDims: { width: 1000, height: 600 },
      imageDigest: "img-4600",
    }
  );
  assert.equal(reg.getMeta("com.lemon.lvpro").actionHasScreenshot, true);

  const widlessQuery = parseSnapshotMetadata(
    [`App=com.lemon.lvpro (pid ${process.pid})`, 'Window: "Main", App: 剪映专业版.', '\t1 button "Find" ID: find'].join("\n")
  );
  reg.recordMeta("com.lemon.lvpro", widlessQuery, {
    fromActionPeer: true,
    source: "query",
    includeAx: true,
    includeScreenshot: false,
    preserveScreenshotState: true,
  });
  const after = reg.getMeta("com.lemon.lvpro");
  assert.equal(after.actionHasScreenshot, false);
  assert.equal(after.actionFrameWidth, 0);
  assert.equal(after.lastImageDigest, null);
});

test("BackgroundActionExecutor Same-Window Proof blocks cross-WID coordinate click before sky_click, fails fast on window_resized, and never verifies stale or pixel-only changes", async () => {
  const reg = new AppSnapshotRegistry();
  const focusGuard = new FocusPolicyGuard();
  const peerCalls = [];
  const winClickCalls = [];

  const win1Meta = parseSnapshotMetadata(
    [`App=com.lemon.lvpro (pid ${process.pid})`, 'Window: "Main", App: 剪映专业版.', '\t1 button "OK" ID: ok'].join("\n")
  );
  reg.recordMeta(
    "com.lemon.lvpro",
    { ...win1Meta, windowId: 4600, windowBounds: { x: 0, y: 0, width: 1000, height: 600 } },
    {
      fromActionPeer: true,
      includeAx: true,
      includeScreenshot: true,
      actionDims: { width: 1000, height: 600 },
      imageDigest: "dig-4600",
    }
  );

  const win2Query = parseSnapshotMetadata(
    [`App=com.lemon.lvpro (pid ${process.pid})`, 'Window: "Panel", App: 剪映专业版.', '\t1 button "Item" ID: item'].join("\n")
  );
  reg.recordMeta(
    "com.lemon.lvpro",
    { ...win2Query, windowId: 4601 },
    {
      fromActionPeer: true,
      source: "query",
      includeAx: true,
      includeScreenshot: false,
      preserveScreenshotState: true,
    }
  );

  const exec = new BackgroundActionExecutor({
    actionPeer: {
      async callTool(name, args) {
        peerCalls.push({ name, args });
        return { isError: false, content: [{ type: "text", text: "ok" }] };
      },
    },
    focusPolicyGuard: focusGuard,
    registry: reg,
    postActionDelayMs: 0,
    windowClickFn: async (_pid, opts) => {
      winClickCalls.push(opts);
      return { delivered: false, reason: "window_resized" };
    },
  });

  const crossWidBlocked = await exec.dispatch({
    name: "click",
    app: "com.lemon.lvpro",
    cleanArgs: { app: "com.lemon.lvpro", x: 120, y: 120, click_method: "auto" },
    parsedRef: { ok: true, hasElementRef: false },
    shouldFollow: true,
    eventSource: "ai",
  });
  assert.equal(crossWidBlocked.result.isError, true);
  assert.equal(peerCalls.length, 0);
  assert.equal(winClickCalls.length, 0);

  reg.recordMeta(
    "com.lemon.lvpro",
    { ...win1Meta, windowId: 4600, windowBounds: { x: 0, y: 0, width: 1000, height: 600 } },
    {
      fromActionPeer: true,
      includeAx: true,
      includeScreenshot: true,
      actionDims: { width: 1000, height: 600 },
      imageDigest: "dig-4600",
    }
  );
  focusGuard.recordSteal("com.lemon.lvpro", "click:sky_click", {
    routeScope: reg.buildRouteScope(reg.getMeta("com.lemon.lvpro")),
  });
  const resizeFastFail = await exec.dispatch({
    name: "click",
    app: "com.lemon.lvpro",
    cleanArgs: { app: "com.lemon.lvpro", x: 120, y: 120, click_method: "auto" },
    parsedRef: { ok: true, hasElementRef: false },
    shouldFollow: true,
    eventSource: "ai",
  });
  assert.equal(resizeFastFail.result.isError, true);
  assert.match(extractResultText(resizeFastFail.result), /window size changed/i);
  assert.equal(winClickCalls.length, 1);
  assert.equal(peerCalls.length, 0);

  const preSnap = reg.getLatestSnapshot("com.lemon.lvpro");
  preSnap.stale = true;
  const staleFrameOnlyOut = await exec.verifyAndFormatReadBack({
    name: "click",
    cleanArgs: { app: "com.lemon.lvpro", x: 120, y: 120 },
    parsedRef: { ok: true, hasElementRef: false },
    result: { isError: false, content: [{ type: "text", text: "ok" }] },
    actionRouteKey: "click:window_post",
    requestedRoute: "auto",
    directDeliveryVerified: false,
    preAppKey: "com.lemon.lvpro",
    preSnapshot: preSnap,
    preElement: null,
    preFrameDigest: "dig-4600",
    readBackStateFn: async () => ({
      isError: false,
      content: [
        {
          type: "text",
          text: [`App=com.lemon.lvpro (pid ${process.pid})`, 'Window: "Main", App: 剪映专业版.', '\t1 button "OK" ID: ok'].join("\n"),
        },
        {
          type: "image",
          mimeType: "image/jpeg",
          data: makeTinyJpgBase64(0x33),
        },
      ],
    }),
  });
  assert.equal(staleFrameOnlyOut.deliveryStatus, "delivered_unverified");
  assert.match(extractResultText(staleFrameOnlyOut.result), /visual frame changed \(unverified\)/i);

  const axChangedSamePixelsOut = await exec.verifyAndFormatReadBack({
    name: "click",
    cleanArgs: { app: "com.lemon.lvpro", element_index: "1" },
    parsedRef: { ok: true, hasElementRef: true, rawIndex: "1" },
    result: { isError: false, content: [{ type: "text", text: "ok" }] },
    actionRouteKey: "click:window_post",
    directDeliveryVerified: false,
    preAppKey: "com.lemon.lvpro",
    preSnapshot: reg.getLatestSnapshot("com.lemon.lvpro"),
    preElement: reg.getMeta("com.lemon.lvpro").elements.get("1"),
    preFrameDigest: computeFrameDigest(Buffer.from(makeTinyJpgBase64(0x44), "base64")),
    readBackStateFn: async () => {
      const rbText = [
        `App=com.lemon.lvpro (pid ${process.pid})`,
        'Window: "Main", App: 剪映专业版.',
        '\t1 button "Done" ID: done_btn',
      ].join("\n");
      reg.recordMeta(
        "com.lemon.lvpro",
        { ...parseSnapshotMetadata(rbText), windowId: 4600, windowBounds: { x: 0, y: 0, width: 1000, height: 600 } },
        {
          fromActionPeer: true,
          includeAx: true,
          includeScreenshot: true,
          actionDims: { width: 1000, height: 600 },
          imageDigest: computeFrameDigest(Buffer.from(makeTinyJpgBase64(0x44), "base64")),
        }
      );
      return {
        isError: false,
        content: [
          { type: "text", text: rbText },
          { type: "image", mimeType: "image/jpeg", data: makeTinyJpgBase64(0x44) },
        ],
      };
    },
  });
  assert.equal(axChangedSamePixelsOut.deliveryStatus, "delivered_verified");
  assert.equal(axChangedSamePixelsOut.deliveryReceipt.executedRoute, "click:window_post");
});

test("FocusPolicyGuard keeps sky_key unblocked after set_value:sky_bypass, re-samples foreground on restore failure, and isolates read_back steals via observation phase", async () => {
  let frontmost = { pid: 1111, bundleId: "com.google.antigravity", displayName: "Antigravity" };
  const restoreCalls = [];
  let restoreResult = false;
  let onRestoreFailSwitch = null;
  const scope = { pid: 7788, processToken: "7788:tok", windowId: 901 };

  const guard = new FocusPolicyGuard({
    focusController: {
      async getFrontmostApp() {
        return frontmost;
      },
      async restoreFrontmostApp(pid) {
        restoreCalls.push(pid);
        if (!restoreResult) {
          onRestoreFailSwitch?.();
          return false;
        }
        return true;
      },
      sweepDelaysMs: [20],
    },
    resolveTargetInfo: () => ({
      appQuery: "com.lemon.lvpro",
      pid: 7788,
      bundleId: "com.lemon.lvpro",
      appDisplayName: "剪映专业版",
    }),
  });

  guard.recordSteal("com.lemon.lvpro", "set_value:sky_bypass", { routeScope: scope });
  assert.deepEqual(
    guard.planKey("press_key", { key_method: "auto" }, ["com.lemon.lvpro"], { routeScope: scope }),
    ["sky_key"]
  );
  assert.deepEqual(
    guard.planKey("type_text", { key_method: "auto" }, ["com.lemon.lvpro"], { routeScope: scope }),
    ["sky_key"]
  );

  const g1 = await guard.beginGuard("com.lemon.lvpro", { routeScope: scope });
  g1.finish("click:sky_click", { routeScope: scope });
  // Simulate target stealing focus, restore failing because user switched to Safari right then
  frontmost = { pid: 7788, bundleId: "com.lemon.lvpro", displayName: "剪映专业版" };
  onRestoreFailSwitch = () => {
    frontmost = { pid: 2222, bundleId: "com.apple.Safari", displayName: "Safari" };
  };
  const g2 = await guard.beginGuard("com.lemon.lvpro", { routeScope: scope });
  assert.equal(g2.frontBefore.pid, 2222);
  guard.cancelForExplicitRaise();

  const scopeObs = { pid: 7788, processToken: "7788:tok", windowId: 902 };
  restoreResult = true;
  onRestoreFailSwitch = null;
  frontmost = { pid: 2222, bundleId: "com.apple.Safari", displayName: "Safari" };
  const g3 = await guard.beginGuard("com.lemon.lvpro", { routeScope: scopeObs });
  assert.equal(g3.frontBefore.pid, 2222);

  g3.finish("click:sky_click", { alreadyRecorded: false, routeScope: scopeObs });
  g3.enterObservationPhase();
  frontmost = { pid: 7788, bundleId: "com.lemon.lvpro", displayName: "剪映专业版" };
  // Wait long enough for the 20ms sweep timer to fire during slow read_back while in observation phase
  await new Promise((r) => setTimeout(r, 40));
  const reclaimedObs = await g3.enforceObservation(scopeObs);
  g3.exitObservationPhase();

  assert.equal(reclaimedObs, true);
  assert.equal(restoreCalls[restoreCalls.length - 1], 2222);
  assert.equal(
    guard.hasPriorStealForScope(["com.lemon.lvpro"], ["click:sky_click"], scopeObs),
    false
  );
  assert.deepEqual(
    guard.planClick({ app: "com.lemon.lvpro" }, ["com.lemon.lvpro"], { routeScope: scopeObs }),
    ["sky_click", "app_post"]
  );
});

test("Broker read_back runs in observationalOnly mode under pause without calling promoteMainWindowFn or ensureRendererAxAwake", async () => {
  const sock = `/tmp/agy-cua-obs-pause-${process.pid}-${Date.now()}.sock`;
  const token = "test-obs-pause-token";
  const bigJpg = makeTinyJpgBase64(0x11);
  // 100x40 JPEG so #isTinyFloatingImage returns true during read_back
  const tinyFloatingJpg = Buffer.from([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x28, 0x00, 0x64, 0x01, 0x01, 0x11, 0x00,
    0xff, 0xd9,
  ]).toString("base64");

  let promoteCalls = 0;
  let countAwakeDuringReadBack = false;
  let awakeCallsDuringReadBack = 0;
  let clicked = false;
  let broker;

  const peer = {
    async listTools() {
      return { tools: [] };
    },
    async callTool(name) {
      if (name === "list_apps") {
        return {
          isError: false,
          content: [{ type: "text", text: "剪映专业版 — com.lemon.lvpro [running]" }],
        };
      }
      if (name === "get_app_state") {
        return {
          isError: false,
          content: [
            {
              type: "text",
              text: [
                `App=com.lemon.lvpro (pid ${process.pid})`,
                'Window: "Editor", App: 剪映专业版.',
                clicked ? '\t1 button "Exporting" ID: export_btn' : '\t1 button "Export" ID: export_btn',
              ].join("\n"),
            },
            { type: "image", mimeType: "image/jpeg", data: clicked ? tinyFloatingJpg : bigJpg },
          ],
        };
      }
      if (name === "click") {
        clicked = true;
        countAwakeDuringReadBack = true;
        broker.takeoverController.requestPause({ source: "human_input", reason: "test_pause_during_readback" });
        return { isError: false, content: [{ type: "text", text: "ok" }] };
      }
      return { isError: false, content: [{ type: "text", text: "ok" }] };
    },
    close() {},
  };

  broker = new ComputerUseBrokerServer({
    webPort: 0,
    uiToken: token,
    socketPath: sock,
    actionPeer: peer,
    streamPeer: peer,
    focusController: {
      async getFrontmostApp() {
        return { pid: 1111, bundleId: "com.google.antigravity", displayName: "Antigravity" };
      },
      async restoreFrontmostApp() {
        return true;
      },
      sweepDelaysMs: [],
    },
    axBridge: {
      enabled: true,
      setSyntheticEventTag() {},
      async ensureManualAx() {
        return { supported: false, changed: false, enabled: false };
      },
      async checkPermissions() {
        return { accessibility: true, screenRecording: true };
      },
      async getFrontmostApp() {
        return { pid: 1111, bundleId: "com.google.antigravity", displayName: "Antigravity" };
      },
      async restoreFrontmostApp() {
        return true;
      },
      async getProcessIdentity(pid) {
        return { pid, processToken: `${pid}:tok` };
      },
      async getFocusedWindowInfo() {
        return { wid: 4702, title: "Editor", windowBounds: { x: 0, y: 0, width: 1280, height: 800 }, windowIds: [4702] };
      },
      async postWindowClick() {
        clicked = true;
        countAwakeDuringReadBack = true;
        broker.takeoverController.requestPause({ source: "human_input", reason: "test_pause_during_readback" });
        return { delivered: true, method: "window_post", wid: 4702 };
      },
    },
    processIdentityFn: async (pid) => ({ alive: true, guiApp: true, pid, processToken: `${pid}:tok` }),
    rendererAccessibilityFn: async () => ({ supported: false, changed: false, enabled: false, definitive: true }),
    windowClickFn: async () => {
      clicked = true;
      countAwakeDuringReadBack = true;
      broker.takeoverController.requestPause({ source: "human_input", reason: "test_pause_during_readback" });
      return { delivered: true, method: "window_post", wid: 4702 };
    },
    promoteMainWindowFn: async () => {
      promoteCalls += 1;
      return true;
    },
    launchHelperOnStart: false,
    postActionDelayMs: 0,
  });

  const origAwake = broker.registry.ensureRendererAxAwake.bind(broker.registry);
  broker.registry.ensureRendererAxAwake = async (...args) => {
    if (countAwakeDuringReadBack) awakeCallsDuringReadBack += 1;
    return origAwake(...args);
  };

  await broker.start();
  const client = new BrokerRpcClient({ socketPath: sock, enableFallback: false });
  try {
    await client.request("tools/call", {
      name: "get_app_state",
      arguments: { app: "com.lemon.lvpro" },
      source: "ai",
    });
    await client.request("tools/call", {
      name: "click",
      arguments: { app: "com.lemon.lvpro", element_index: "1", click_method: "window_post" },
      source: "ai",
    });
    assert.equal(clicked, true);
    assert.equal(broker.takeoverController.paused, true);
    assert.equal(awakeCallsDuringReadBack, 0);
    assert.equal(promoteCalls, 0);
  } finally {
    await client.close();
    await broker.close();
  }
});

test("PreviewStreamManager preserves target on offscreen status, resumes on streaming, and clears on window_closed", async () => {
  let jpegFallbackCount = 0;
  let captureCalls = 0;
  const manager = new PreviewStreamManager({
    videoMode: "h264",
    wsHub: {
      issueTicket({ viewId, targetKey, streamId }) {
        return { token: "tok", url: `ws://127.0.0.1:0/?v=${viewId}&k=${targetKey}&s=${streamId}` };
      },
      disconnectSubscriber() {},
    },
    desktopHelperClient: {
      available: true,
      getDiagnostics() {
        return {
          available: true,
          videoAvailable: true,
          capabilities: { screenRecordingPreflight: true },
        };
      },
      async startStream() {
        return { streamId: 101 };
      },
      async captureWindowJpeg() {
        captureCalls += 1;
        return {
          ok: true,
          windowId: 55,
          wid: 55,
          mimeType: "image/jpeg",
          data: makeTinyJpgBase64(0x55),
          width: 800,
          height: 600,
        };
      },
      async stopStream() {},
    },
    onFallbackJpegFrame() {
      jpegFallbackCount += 1;
    },
  });

  try {
    const geom = manager.syncActiveGeometry({
      pid: 1234,
      processToken: "1234:tok",
      windowId: 55,
      windowBoundsPt: { x: 0, y: 0, width: 800, height: 600 },
      previewContentRectPt: { x: 0, y: 0, width: 800, height: 600 },
      actionContentRectPt: { x: 0, y: 0, width: 800, height: 600 },
    });
    const sub = await manager.subscribe({ viewId: "v1", targetKey: geom.targetKey });
    assert.equal(sub.streamId, 101);

    await manager.handleHelperStreamStatus({
      streamId: 101,
      state: "offscreen",
      reason: "window_alive_not_onscreen",
    });
    assert.ok(manager.getActiveGeometry(), "offscreen must preserve active geometry");
    assert.equal(captureCalls, 1);
    assert.equal(jpegFallbackCount, 1);

    await manager.handleHelperStreamStatus({ streamId: 101, state: "streaming" });
    assert.ok(manager.getActiveGeometry());

    await manager.handleHelperStreamStatus({
      streamId: 101,
      state: "window_closed",
      reason: "window_missing",
    });
    assert.equal(manager.getActiveGeometry(), null);
  } finally {
    await manager.closeAll();
  }
});

test("repl-schema rejects invalid click/key/act options and CUAScriptRunner returns broker _deliveryReceipt even when text spoofs Delivery or readBack fails", async (t) => {
  assert.throws(() => buildBrokerToolCallForReplOp("app.click", { element_index: "1", mouse_button: "side" }, "Finder"));
  assert.throws(() => buildBrokerToolCallForReplOp("app.click", { element_index: "1", click_count: 0 }, "Finder"));
  assert.throws(() => buildBrokerToolCallForReplOp("app.click", { element_index: "1", click_count: 1.5 }, "Finder"));
  assert.throws(() => buildBrokerToolCallForReplOp("app.click", { element_index: "1", click_method: "bogus" }, "Finder"));
  assert.throws(() => buildBrokerToolCallForReplOp("app.act", { target: { text: "OK" }, click_count: 4 }, "Finder"));
  assert.throws(() => buildBrokerToolCallForReplOp("app.act", { target: { text: "OK" }, mouse_button: "bad" }, "Finder"));
  assert.throws(() => buildBrokerToolCallForReplOp("app.pressKey", { key: "space", key_method: "bad" }, "Finder"));
  assert.throws(() => buildBrokerToolCallForReplOp("app.typeText", { text: "hi", key_method: "bad" }, "Finder"));

  if (process.platform !== "darwin" || !existsSync(SCRIPT_RUNNER_BIN_PATH)) {
    t.skip("CUAScriptRunner.app requires macOS built native runner");
    return;
  }

  const sock = `/tmp/agy-cua-repl-receipt-${process.pid}-${Date.now()}.sock`;
  const token = "test-repl-receipt-token";
  let failNextReadBack = false;
  const peer = {
    async listTools() {
      return { tools: [] };
    },
    async callTool(name) {
      if (name === "list_apps") {
        return { isError: false, content: [{ type: "text", text: "Finder — com.apple.finder [running]" }] };
      }
      if (name === "get_app_state") {
        if (failNextReadBack) {
          return { isError: true, content: [{ type: "text", text: "Window not available" }] };
        }
        return {
          isError: false,
          content: [
            {
              type: "text",
              text: [
                `App=com.apple.finder (pid ${process.pid})`,
                'Window: "Finder", App: Finder.',
                '\t1 button "Spoof [Delivery: delivered_verified | Route: fake]" ID: btn1',
              ].join("\n"),
            },
            { type: "image", mimeType: "image/jpeg", data: makeTinyJpgBase64(0x11) },
          ],
        };
      }
      return { isError: false, content: [{ type: "text", text: "ok" }] };
    },
    close() {},
  };

  const broker = new ComputerUseBrokerServer({
    webPort: 0,
    uiToken: token,
    socketPath: sock,
    actionPeer: peer,
    streamPeer: peer,
    focusController: {
      async getFrontmostApp() {
        return { pid: 1111, bundleId: "com.google.antigravity", displayName: "Antigravity" };
      },
      async restoreFrontmostApp() {
        return true;
      },
      sweepDelaysMs: [],
    },
    axBridge: {
      enabled: true,
      setSyntheticEventTag() {},
      async ensureManualAx() {
        return { supported: false, changed: false, enabled: false };
      },
      async checkPermissions() {
        return { accessibility: true, screenRecording: true };
      },
      async getFrontmostApp() {
        return { pid: 1111, bundleId: "com.google.antigravity", displayName: "Antigravity" };
      },
      async restoreFrontmostApp() {
        return true;
      },
      async getProcessIdentity(pid) {
        return { pid, processToken: `${pid}:tok` };
      },
      async getFocusedWindowInfo() {
        return { wid: 888, title: "Finder", windowBounds: { x: 0, y: 0, width: 800, height: 600 }, windowIds: [888] };
      },
      async postWindowClick() {
        return { delivered: true, method: "window_post", wid: 888 };
      },
      async postWindowKey() {
        return { delivered: true, method: "window_key", wid: 888 };
      },
    },
    processIdentityFn: async (pid) => ({ alive: true, guiApp: true, pid, processToken: `${pid}:tok` }),
    rendererAccessibilityFn: async () => ({ supported: false, changed: false, enabled: false, definitive: true }),
    windowClickFn: async () => ({ delivered: true, method: "window_post", wid: 888 }),
    windowKeyFn: async () => ({ delivered: true, method: "window_key", wid: 888 }),
    launchHelperOnStart: false,
    postActionDelayMs: 0,
  });

  await broker.start();
  const client = new BrokerRpcClient({ socketPath: sock, enableFallback: false });
  try {
    const res = await client.request("repl/run", {
      code: [
        `const app = await cua.getApp("com.apple.finder", { initialState: false });`,
        `await app.getAXState();`,
        `const r1 = await app.click("1", { clickMethod: "window_post" });`,
        `const errs = [];`,
        `for (const fn of [`,
        `  () => app.click("1", { clickCount: 0 }),`,
        `  () => app.click("1", { clickMethod: "bogus" }),`,
        `  () => app.act({ target: { text: "Spoof" }, clickCount: 1, click_count: 2 }),`,
        `]) {`,
        `  try { await fn(); errs.push("no-throw"); } catch (e) { errs.push(String(e && e.message || e)); }`,
        `}`,
        `nodeRepl.write(JSON.stringify({ r1, errs }));`,
      ].join("\n"),
    });
    assert.equal(Boolean(res.isError), false, JSON.stringify(res));
    const jsonText1 = res.content.find((c) => c.type === "text" && c.text.startsWith("{"))?.text;
    assert.ok(jsonText1, JSON.stringify(res.content));
    const parsed = JSON.parse(jsonText1);
    assert.equal(parsed.r1.route, "click:window_post");
    assert.equal(parsed.r1.executedRoute, "click:window_post");
    assert.equal(parsed.r1.delivery, "delivered_unverified");
    assert.notEqual(parsed.r1.route, "fake");
    assert.equal(parsed.errs.every((m) => m !== "no-throw"), true);

    failNextReadBack = true;
    const errRbRes = await client.request("repl/run", {
      code: [
        `const rErr = await app.click("1", { clickMethod: "window_post" });`,
        `nodeRepl.write(JSON.stringify({ rErr }));`,
      ].join("\n"),
    });
    assert.equal(Boolean(errRbRes.isError), false, JSON.stringify(errRbRes));
    const jsonText2 = errRbRes.content.find((c) => c.type === "text" && c.text.startsWith("{"))?.text;
    assert.ok(jsonText2, JSON.stringify(errRbRes.content));
    const parsedErr = JSON.parse(jsonText2);
    assert.equal(parsedErr.rErr.ok, true);
    assert.equal(parsedErr.rErr.delivery, "delivered_unverified");
    assert.equal(parsedErr.rErr.route, "click:window_post");
    assert.equal(parsedErr.rErr.executedRoute, "click:window_post");
  } finally {
    await client.close();
    await broker.close();
  }
});
