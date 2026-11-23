import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import net from "node:net";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import { tmpdir } from "node:os";
import { PersistentAxBridge } from "../src/ax-bridge.mjs";
import { restoreFrontmostAppFast } from "../src/background-policy.mjs";
import { ComputerUseBrokerServer } from "../src/broker-sidecar.mjs";
import { BrokerRpcClient } from "../src/broker-client.mjs";
import { DesktopHelperClient } from "../src/desktop-helper-client.mjs";
import { FocusPolicyGuard } from "../src/focus-policy-guard.mjs";
import { NativeComputerUsePeer } from "../src/native-peer.mjs";
import {
  TakeoverController,
  generateSyntheticEventTag,
  isTakeoverAbortedError,
} from "../src/takeover-controller.mjs";

function makeTinyJpgBase64() {
  return Buffer.from([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x03, 0x20, 0x05, 0x00, 0x01, 0x01, 0x11, 0x00, 0xff,
    0xd9,
  ]).toString("base64");
}

function makeFakeDesktopHelper(initialCaps = {}) {
  const listeners = {
    onSensorEvent: null,
  };
  let caps = {
    screenRecordingPreflight: true,
    inputMonitoringPreflight: true,
    accessibilityTrusted: true,
    mouseTapActive: true,
    keyTapActive: true,
    hotkeyActive: true,
    fallbackReason: null,
    ...initialCaps,
  };
  const targetsHistory = [];
  let latchResets = 0;
  let permissionRequests = [];

  return {
    targetsHistory,
    getLatchResets: () => latchResets,
    getPermissionRequests: () => permissionRequests,
    emitSensorEvent(evt) {
      return listeners.onSensorEvent?.(evt);
    },
    setSensorHandler(fn) {
      listeners.onSensorEvent = fn;
    },
    get available() {
      return true;
    },
    async start() {
      return this.getDiagnostics();
    },
    getDiagnostics() {
      return {
        available: true,
        authenticated: true,
        pid: 43210,
        bundleId: "io.codexstyle.cua.desktop-helper.dev",
        reason: null,
        capabilities: { ...caps },
      };
    },
    async setTakeoverTargets(targets = []) {
      targetsHistory.push(targets);
      return true;
    },
    async resetTakeoverLatch() {
      latchResets += 1;
      return true;
    },
    async requestPermission(kind) {
      permissionRequests.push(kind);
      return { granted: true, kind, capabilities: { ...caps } };
    },
    async close() {},
  };
}

test("TakeoverController discriminates background human work, synthetic tags, epoch staleness, and FocusPolicyGuard cancellation", async () => {
  const tag = generateSyntheticEventTag();
  assert.ok(Number.isSafeInteger(tag) && tag > 0);

  const controller = new TakeoverController({ syntheticEventTag: tag });
  const op = controller.admit({ name: "click", isAi: true, isMutating: true });
  controller.setTarget(op, {
    app: "com.lemon.lvpro",
    bundleId: "com.lemon.lvpro",
    appDisplayName: "剪映专业版",
    pid: 7001,
    processToken: "7001:99",
    windowId: 501,
    routeKey: "click:window_post",
  });

  // 1. Background-safe filtering: none of these may pause AI
  const ignoredCases = [
    { type: "mouse_down", sourceClass: "human", hit: { state: "hit", pid: 100, windowId: 10, occludedByOther: false } },
    { type: "mouse_down", sourceClass: "human", hit: { state: "hit", pid: 7001, windowId: 501, occludedByOther: true } },
    { type: "mouse_down", sourceClass: "human", hit: { state: "hit", pid: 7001, windowId: 502, occludedByOther: false } },
    { type: "mouse_down", sourceClass: "human", hit: { state: "unknown" } },
    { type: "mouse_down", sourceClass: "unknown", hit: { state: "hit", pid: 7001, windowId: 501 } },
    { type: "mouse_down", sourceClass: "human", sourceTag: tag, hit: { state: "hit", pid: 7001, windowId: 501 } },
    { type: "key_down", sourceClass: "human", frontmostPid: 100, focusedWindowId: 10 },
    { type: "key_down", sourceClass: "human", frontmostPid: 7001, processToken: "7001:99", focusedWindowId: 0 },
    { type: "key_down", sourceClass: "human", frontmostPid: 7001, processToken: "7001:99", focusedWindowId: 502 },
    { type: "app_activated", sourceClass: "human", pid: 7001, hasHumanSwitchGesture: false },
    { type: "emergency_hotkey", sourceClass: "human", isRepeat: true },
  ];
  for (const evt of ignoredCases) {
    const res = controller.handleSensorEvent(evt);
    assert.equal(res.triggered, false, `Expected sensor event to be ignored: ${JSON.stringify(evt)}`);
    assert.equal(controller.paused, false);
  }

  // Route override disabling autoClick suppresses mouse_down while keeping emergency_hotkey active
  controller.setRoutePolicy("click:window_post", { autoClick: false, autoKey: true });
  const disabledClick = controller.handleSensorEvent({
    type: "mouse_down",
    sourceClass: "human",
    hit: { state: "hit", pid: 7001, processToken: "7001:99", windowId: 501, occludedByOther: false },
  });
  assert.equal(disabledClick.triggered, false);
  assert.equal(disabledClick.reason, "route_auto_click_disabled");
  controller.setRoutePolicy("click:window_post", { autoClick: true, autoKey: true });

  // Reserved hotkey check
  assert.equal(controller.isReservedHotkey("Control_L+Alt_L+Escape"), true);
  assert.equal(controller.isReservedHotkey("ctrl+opt+esc"), true);
  assert.equal(controller.isReservedHotkey("cmd+c"), false);

  // 2. Real human click hitting exact target PID + WID latches pause once
  const hitRes = controller.handleSensorEvent({
    type: "mouse_down",
    sourceClass: "human",
    hit: { state: "hit", pid: 7001, processToken: "7001:99", windowId: 501, occludedByOther: false },
  });
  assert.equal(hitRes.triggered, true);
  assert.equal(controller.paused, true);
  assert.equal(controller.pauseEpoch, 1);
  assert.equal(op.signal.aborted, true);
  assert.throws(() => controller.assertMayDispatch(op), (err) => isTakeoverAbortedError(err));

  // Stale epoch resume returns 409, valid epoch resumes cleanly
  const badResume = await controller.resume({ expectedPauseEpoch: 999 });
  assert.equal(badResume.ok, false);
  assert.equal(badResume.statusCode, 409);
  assert.equal(controller.paused, true);

  const okResume = await controller.resume({ expectedPauseEpoch: 1 });
  assert.equal(okResume.ok, true);
  assert.equal(controller.paused, false);

  // Old operation admitted under epoch 0 MUST still fail closed after pause -> quick resume into epoch 1!
  assert.throws(
    () => controller.assertMayDispatch(op),
    (err) => isTakeoverAbortedError(err) && err.deliveryState === "not_sent"
  );
  controller.clearOperation(op);

  // Intent ID deduplication
  const firstClaim = controller.requestPause({
    reason: "ui_interact",
    intentId: "claim-123",
  });
  assert.equal(firstClaim.latched, true);
  assert.equal(firstClaim.pauseEpoch, 2);
  const dupClaim = controller.requestPause({
    reason: "ui_interact",
    intentId: "claim-123",
  });
  assert.equal(dupClaim.idempotent, true);
  assert.equal(dupClaim.pauseEpoch, 2);

  // FocusPolicyGuard human target takeover cancels reclaim sweeps toward Antigravity
  const restores = [];
  let frontApp = { pid: 100, bundleId: "com.google.antigravity", displayName: "Antigravity" };
  const guard = new FocusPolicyGuard({
    focusController: {
      async getFrontmostApp() {
        return frontApp;
      },
      async restoreFrontmostApp(pid) {
        restores.push(pid);
        return true;
      },
      sweepDelaysMs: [40],
    },
    resolveTargetInfo: () => ({ pid: 7001, bundleId: "com.lemon.lvpro", appDisplayName: "剪映专业版" }),
  });
  const scope = await guard.beginGuard("com.lemon.lvpro");
  frontApp = { pid: 7001, bundleId: "com.lemon.lvpro", displayName: "剪映专业版" };
  scope.finish("click:sky_click");
  guard.cancelForHumanTargetTakeover(7001);
  await new Promise((r) => setTimeout(r, 90));
  assert.deepEqual(restores, [], "Human target takeover must cancel focus reclaim sweeps for targetPid");
  guard.close();
});

test("Pre-IPC write gate aborts with 0 stdin writes when pause happens during ensureStarted()", async () => {
  const controller = new TakeoverController();
  const op = controller.admit({ name: "click", isAi: true, isMutating: true });

  // 1. NativeComputerUsePeer: pause strikes while worker process handshake is in progress -> 0 stdin writes
  const peerWrites = [];
  let peerWriteCount = 0;
  const peer = new NativeComputerUsePeer({
    name: "test-peer",
    spawnFn() {
      const proc = new EventEmitter();
      proc.pid = 55551;
      proc.exitCode = null;
      proc.killed = false;
      proc.stdout = new PassThrough();
      proc.stderr = new PassThrough();
      proc.stdin = new Writable({
        write(chunk, _enc, cb) {
          const line = String(chunk);
          peerWrites.push(line);
          if (line.includes('"initialize"')) {
            // Pause strikes just as initialize settles, BEFORE actual tool stdin.write!
            queueMicrotask(() => {
              proc.stdout.write(
                `${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18" } })}\n`
              );
              controller.requestPause({ reason: "emergency_hotkey", source: "hotkey" });
            });
          } else if (line.includes('"tools/call"') || line.includes('"click"')) {
            peerWriteCount += 1;
          }
          cb();
        },
      });
      proc.kill = () => {
        proc.killed = true;
        return true;
      };
      return proc;
    },
  });

  try {
    await assert.rejects(
      () =>
        peer.callTool("click", { app: "Finder", x: 10, y: 10 }, 2000, {
          beforeWriteCheck: () => controller.assertMayDispatch(op),
        }),
      (err) => isTakeoverAbortedError(err) && err.deliveryState === "not_sent"
    );
    assert.equal(peerWriteCount, 0, "Paused NativeComputerUsePeer must perform 0 tool writes to stdin");
  } finally {
    peer.close();
  }

  // 2. PersistentAxBridge: pause strikes while JXA worker handshake completes -> 0 postWindowClick writes
  const controller2 = new TakeoverController();
  const op2 = controller2.admit({ name: "click", isAi: true, isMutating: true });
  let jxaToolWrites = 0;
  const bridge = new PersistentAxBridge({
    enabled: true,
    syntheticEventTag: controller2.syntheticEventTag,
    spawnFn() {
      const proc = new EventEmitter();
      proc.exitCode = null;
      proc.killed = false;
      proc.stdout = new PassThrough();
      proc.stderr = new PassThrough();
      proc.stdin = new Writable({
        write(chunk, _enc, cb) {
          const line = String(chunk);
          if (line.includes('"ping"')) {
            queueMicrotask(() => {
              proc.stdout.write(`${JSON.stringify({ id: 1, ok: true, result: { ok: true } })}\n`);
              controller2.requestPause({ reason: "human_click_target", source: "hid" });
            });
          } else {
            jxaToolWrites += 1;
          }
          cb();
        },
      });
      proc.kill = () => {
        proc.killed = true;
        return true;
      };
      return proc;
    },
  });

  try {
    await assert.rejects(
      () =>
        bridge.postWindowClick(7001, {
          wid: 501,
          windowBounds: { x: 0, y: 0, width: 800, height: 600 },
          localPoint: { x: 20, y: 20 },
          beforeWriteCheck: () => controller2.assertMayDispatch(op2),
        }),
      (err) => isTakeoverAbortedError(err) && err.deliveryState === "not_sent"
    );
    assert.equal(jxaToolWrites, 0, "Paused PersistentAxBridge must perform 0 JXA writes after ensureStarted");
  } finally {
    await bridge.close();
  }
});

test("Broker takeover integration: sensor targeting, drain ordering before manual /api/interact, act pre/post-click, hotkey guard, and v2 permissions", async () => {
  const sock = path.join(tmpdir(), `cua-takeover-${process.pid}-${Date.now()}.sock`);
  const token = "takeover-test-token";
  const tinyJpg = makeTinyJpgBase64();
  const helper = makeFakeDesktopHelper();

  let scenario = "idle";
  let queryEntered = null;
  let queryRelease = null;
  let expectEntered = null;
  let expectRelease = null;
  let clicksSent = 0;
  let postClickReads = 0;
  const dispatchedTools = [];

  const peer = {
    async listTools() {
      return {
        tools: [
          { name: "list_apps" },
          { name: "get_app_state" },
          { name: "query" },
          { name: "click" },
          { name: "press_key" },
          { name: "scroll" },
        ],
      };
    },
    async callTool(name, args = {}) {
      dispatchedTools.push({ name, args });
      if (name === "list_apps") {
        return {
          isError: false,
          content: [{ type: "text", text: "剪映专业版 — com.lemon.lvpro [running]" }],
        };
      }
      if (name === "get_app_state") {
        if (scenario === "slow_expect") {
          postClickReads += 1;
          expectEntered?.();
          if (expectRelease) await expectRelease;
        }
        return {
          isError: false,
          content: [
            {
              type: "text",
              text: `App=com.lemon.lvpro (pid ${process.pid})\nWindow: "主窗口", App: 剪映专业版.\n0AXWindow 主窗口\n\t1AXButton 导出`,
            },
            { type: "image", mimeType: "image/jpeg", data: tinyJpg },
          ],
        };
      }
      if (name === "query") {
        if (scenario === "slow_locate" && args.text === "导出") {
          queryEntered?.();
          if (queryRelease) await queryRelease;
        }
        return {
          isError: false,
          content: [
            {
              type: "text",
              text: JSON.stringify({
                window_id: 501,
                window_title: "主窗口",
                truncated: false,
                stop_reason: "complete",
                matches:
                  args.text === "Done"
                    ? []
                    : [
                        {
                          index: 1000001,
                          role: "AXButton",
                          title: "导出",
                          bounds: { x: 100, y: 100, w: 80, h: 32 },
                          window_id: 501,
                        },
                      ],
              }),
            },
          ],
        };
      }
      if (name === "click") {
        clicksSent += 1;
        return { isError: false, content: [{ type: "text", text: "ok" }] };
      }
      if (name === "press_key") {
        return { isError: false, content: [{ type: "text", text: "ok" }] };
      }
      return { isError: false, content: [{ type: "text", text: "ok" }] };
    },
    close() {},
  };

  const fakeAxBridge = {
    enabled: true,
    setSyntheticEventTag() {},
    async checkPermissions() {
      return { accessibility: true, screenRecording: true };
    },
    async findRunningApp() {
      return { alive: true, pid: process.pid, bundleId: "com.lemon.lvpro", processToken: `${process.pid}:1` };
    },
    async getProcessInfo(pid) {
      return { alive: true, guiApp: true, pid, bundleId: "com.lemon.lvpro", processToken: `${pid}:1` };
    },
    async ensureManualAccessibility() {
      return { supported: true, changed: false, enabled: true, definitive: true };
    },
    async getFocusedWindowInfo() {
      return {
        wid: 501,
        title: "主窗口",
        windowBounds: { x: 0, y: 0, w: 1280, h: 800 },
        windowIds: [501],
      };
    },
    async resolveActionTarget(_pid, opts) {
      return {
        resolved: true,
        wid: 501,
        windowBounds: { x: 0, y: 0, w: 1280, h: 800 },
        role: "AXButton",
        hasAxPress: true,
        hops: 0,
        localBounds: { x: 100, y: 100, w: 80, h: 32 },
        centerLocalPoint: { x: 140, y: 116 },
      };
    },
    async postWindowClick() {
      clicksSent += 1;
      return { delivered: true, method: "window_post", wid: 501, localX: 140, localY: 116 };
    },
    async close() {},
  };

  const broker = new ComputerUseBrokerServer({
    webPort: 0,
    uiToken: token,
    socketPath: sock,
    actionPeer: peer,
    streamPeer: peer,
    axBridge: fakeAxBridge,
    desktopHelperClient: helper,
    permissionsFn: async () => ({ platform: "darwin", accessibility: true, screenRecording: true }),
    runningAppIdentityFn: async () => ({
      pid: process.pid,
      bundleId: "com.lemon.lvpro",
      displayName: "剪映专业版",
      processToken: `${process.pid}:1`,
    }),
    focusController: {
      async getFrontmostApp() {
        return { pid: 100, bundleId: "com.google.antigravity", displayName: "Antigravity" };
      },
      async restoreFrontmostApp() {
        return true;
      },
      sweepDelaysMs: [],
    },
  });
  // Wire helper sensor callback onto broker's takeoverController
  helper.setSensorHandler((evt) => broker.takeoverController.handleSensorEvent(evt));
  broker.takeoverController.setHelperCapabilities(helper.getDiagnostics().capabilities);
  broker.state.takeoverMode = broker.takeoverController.publicState().takeoverMode;

  const { webPort } = await broker.start();
  const client = new BrokerRpcClient({ socketPath: sock, enableFallback: false });

  try {
    // 1. Check GET /api/state keeps exact 3-key permissions, while GET /api/permissions returns v2 breakdown
    const stateRes = await (
      await fetch(`http://127.0.0.1:${webPort}/api/state?token=${token}`)
    ).json();
    assert.deepEqual(stateRes.permissions, {
      platform: "darwin",
      accessibility: true,
      screenRecording: true,
    });
    assert.equal(stateRes.takeoverMode, "enhanced");

    const permV2 = await (
      await fetch(`http://127.0.0.1:${webPort}/api/permissions?token=${token}`)
    ).json();
    assert.equal(permV2.version, 2);
    assert.equal(permV2.components.desktopHelper.status, "enhanced");
    assert.equal(permV2.components.jxa.status, "granted");

    // 2. Warm target app state, then verify AI reserved emergency hotkey is rejected before touching OS
    await client.request("tools/call", {
      name: "get_app_state",
      arguments: { app: "com.lemon.lvpro" },
      source: "ai",
    });
    const hotkeyBlock = await client.request("tools/call", {
      name: "press_key",
      arguments: { app: "com.lemon.lvpro", key: "Control_L+Alt_L+Escape" },
      source: "ai",
    });
    assert.equal(hotkeyBlock.isError, true);
    assert.match(hotkeyBlock.content[0].text, /RESERVED_HOTKEY/);
    assert.equal(
      dispatchedTools.filter((t) => t.name === "press_key").length,
      0,
      "Reserved emergency hotkey must never be dispatched to native peer"
    );

    // 3. Pre-click human click sensor hit during act locate aborts cleanly with clicksSent === 0
    scenario = "slow_locate";
    clicksSent = 0;
    let releaseLocate;
    queryRelease = new Promise((r) => {
      releaseLocate = r;
    });
    const locateReady = new Promise((r) => {
      queryEntered = r;
    });
    const preClickActP = client.request("tools/call", {
      name: "act",
      arguments: {
        app: "com.lemon.lvpro",
        target: { text: "导出" },
        reveal: { max_scroll_steps: 0 },
        expect: { any_text: ["Done"] },
        timeout_ms: 4000,
      },
      source: "ai",
    });
    await locateReady;
    // Verify unrelated Antigravity click does NOT trigger pause
    helper.emitSensorEvent({
      type: "mouse_down",
      sourceClass: "human",
      hit: { state: "hit", pid: 100, windowId: 10, occludedByOther: false },
    });
    assert.equal(broker.takeoverController.paused, false);
    // Now human clicks exact target PID + WID 501
    helper.emitSensorEvent({
      type: "mouse_down",
      sourceClass: "human",
      hit: { state: "hit", pid: process.pid, windowId: 501, occludedByOther: false },
    });
    assert.equal(broker.takeoverController.paused, true);
    releaseLocate();
    const preClickActRes = await preClickActP;
    assert.equal(preClickActRes.isError, true);
    assert.match(preClickActRes.content[0].text, /PAUSED/);
    assert.equal(clicksSent, 0);
    scenario = "idle";

    // Resume with expectedPauseEpoch
    const epochNow = broker.state.pauseEpoch;
    const staleResumeRes = await fetch(`http://127.0.0.1:${webPort}/api/settings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Sidecar-Token": token },
      body: JSON.stringify({ paused: false, expectedPauseEpoch: epochNow + 42 }),
    });
    assert.equal(staleResumeRes.status, 409);

    const goodResumeRes = await fetch(`http://127.0.0.1:${webPort}/api/settings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Sidecar-Token": token },
      body: JSON.stringify({ paused: false, expectedPauseEpoch: epochNow }),
    });
    assert.equal(goodResumeRes.status, 200);
    assert.equal(helper.getLatchResets() >= 1, true);

    // 4. Case (a): Direct POST /api/interact while act is in-flight in #actionQueue aborts act at t=0
    scenario = "slow_locate";
    clicksSent = 0;
    let releaseLocate2;
    queryRelease = new Promise((r) => {
      releaseLocate2 = r;
    });
    const locateReady2 = new Promise((r) => {
      queryEntered = r;
    });
    const actInQueueP = client.request("tools/call", {
      name: "act",
      arguments: {
        app: "com.lemon.lvpro",
        target: { text: "导出" },
        reveal: { max_scroll_steps: 0 },
        expect: { any_text: ["Done"] },
        timeout_ms: 4000,
      },
      source: "ai",
    });
    await locateReady2;
    const interactPromise = fetch(`http://127.0.0.1:${webPort}/api/interact`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Sidecar-Token": token },
      body: JSON.stringify({
        app: "com.lemon.lvpro",
        brokerBootId: broker.brokerBootId,
        intentId: "manual-click-1",
        kind: "click",
        normX: 0.25,
        normY: 0.25,
      }),
    });
    // Wait briefly for /api/takeover claim inside /api/interact to latch pause BEFORE query releases
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(broker.takeoverController.paused, true);
    releaseLocate2();
    const abortedActRes = await actInQueueP;
    assert.equal(abortedActRes.isError, true);
    assert.match(abortedActRes.content[0].text, /PAUSED/);
    const interactJson = await (await interactPromise).json();
    assert.equal(interactJson.ok, true);
    // Manual click executed once, AI act click never ran!
    assert.equal(clicksSent, 1);
    scenario = "idle";

    // Resume for Case (b) + post-click act test
    await fetch(`http://127.0.0.1:${webPort}/api/settings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Sidecar-Token": token },
      body: JSON.stringify({ paused: false, expectedPauseEpoch: broker.state.pauseEpoch }),
    });

    // 5. Case (b): Held in-flight trackNativeWrite forces /api/interact into `draining` until settled
    let releaseTrackedWrite;
    const trackedPromise = new Promise((r) => {
      releaseTrackedWrite = r;
    });
    const trackedWrap = broker.takeoverController.trackNativeWrite(null, trackedPromise, {
      routeKey: "click:test",
    });
    const clicksBeforeDrain = clicksSent;
    const drainInteractP = fetch(`http://127.0.0.1:${webPort}/api/interact`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Sidecar-Token": token },
      body: JSON.stringify({
        app: "com.lemon.lvpro",
        brokerBootId: broker.brokerBootId,
        intentId: "drain-click-2",
        kind: "click",
        normX: 0.4,
        normY: 0.4,
      }),
    });
    await new Promise((r) => setTimeout(r, 35));
    assert.equal(broker.takeoverController.phase, "draining");
    assert.equal(clicksSent, clicksBeforeDrain, "Manual UI click must wait while AI native write is draining");
    releaseTrackedWrite();
    await trackedWrap;
    const drainJson = await (await drainInteractP).json();
    assert.equal(drainJson.ok, true);
    assert.equal(broker.takeoverController.phase, "paused");
    assert.equal(clicksSent, clicksBeforeDrain + 1, "Manual UI click executes once drain finishes");

    // 6. Post-click pause during act expect phase stops with sent:true, clicksSent:1
    await fetch(`http://127.0.0.1:${webPort}/api/settings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Sidecar-Token": token },
      body: JSON.stringify({ paused: false, expectedPauseEpoch: broker.state.pauseEpoch }),
    });
    scenario = "slow_expect";
    clicksSent = 0;
    postClickReads = 0;
    let releaseExpect;
    expectRelease = new Promise((r) => {
      releaseExpect = r;
    });
    const expectReady = new Promise((r) => {
      expectEntered = r;
    });
    const postClickActP = client.request("tools/call", {
      name: "act",
      arguments: {
        app: "com.lemon.lvpro",
        target: { text: "导出" },
        reveal: { max_scroll_steps: 0 },
        expect: { any_text: ["NeverAppears"] },
        timeout_ms: 4000,
      },
      source: "ai",
    });
    await expectReady;
    const claimRes = await fetch(`http://127.0.0.1:${webPort}/api/takeover-claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Sidecar-Token": token },
      body: JSON.stringify({
        app: "com.lemon.lvpro",
        brokerBootId: broker.brokerBootId,
        intentId: "claim-post-click",
      }),
    });
    assert.equal(claimRes.status, 200);
    releaseExpect();
    const postClickRes = await postClickActP;
    assert.equal(postClickRes.isError, true);
    assert.match(postClickRes.content[0].text, /PAUSED/);
    const payload = JSON.parse(postClickRes.content[0].text.replace(/^\[PAUSED\]\s*/u, ""));
    assert.equal(payload.sent, true);
    assert.equal(payload.clicksSent, 1);
    assert.equal(postClickReads, 1, "Post-click expect polling must stop immediately once paused");
  } finally {
    scenario = "idle";
    queryRelease = null;
    expectRelease = null;
    await client.close();
    await broker.close();
  }
});

test("DesktopHelperClient auto-reconnects after unexpected kill and suppresses JXA Screen Recording false positive", async () => {
  const activeSockets = new Set();
  let launchCount = 0;
  const statuses = [];

  const helperClient = new DesktopHelperClient({
    brokerBootId: "boot-reconnect-test",
    autoRestart: true,
    restartDelayMs: 40,
    maxRestartsInWindow: 4,
    launchFn: async ({ socketPath, authToken, brokerBootId }) => {
      launchCount += 1;
      const sock = net.createConnection(socketPath);
      activeSockets.add(sock);
      sock.on("close", () => activeSockets.delete(sock));
      sock.on("error", () => {});
      sock.on("connect", () => {
          sock.write(
          `${JSON.stringify({
            type: "hello",
            authToken,
            brokerBootId,
            pid: null,
            bundleId: "io.codexstyle.cua.desktop-helper.dev",
            capabilities: {
              screenRecordingPreflight: true,
              inputMonitoringPreflight: false,
              accessibilityTrusted: false,
              mouseTapActive: false,
              keyTapActive: false,
              hotkeyActive: false,
              fallbackReason: "input_monitoring_not_granted",
            },
          })}\n`
        );
      });
      let buf = "";
      sock.setEncoding("utf8");
      sock.on("data", (chunk) => {
        buf += chunk;
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          const req = JSON.parse(line);
          if (req.op === "shutdown") {
            sock.write(`${JSON.stringify({ type: "reply", id: req.id, ok: true, result: {} })}\n`);
            sock.end();
          } else {
            sock.write(`${JSON.stringify({ type: "reply", id: req.id, ok: true, result: { pong: true } })}\n`);
          }
        }
      });
    },
    onStatusChanged: (diag) => statuses.push(diag),
  });

  let broker;
  try {
    const first = await helperClient.start();
    assert.equal(launchCount, 1);
    assert.equal(first.available, true);
    assert.equal(first.capabilities.screenRecordingPreflight, true);

    // Wire into Broker with JXA mock reporting screenRecording=false -> effective permissions must trust helper preflight=true
    const sockPath = path.join(tmpdir(), `cua-reconnect-${Date.now()}-${Math.random().toString(16).slice(2)}.sock`);
    broker = new ComputerUseBrokerServer({
      socketPath: sockPath,
      webHost: "127.0.0.1",
      webPort: 0,
      uiToken: "reconnect-test-token",
      desktopHelperClient: helperClient,
      launchHelperOnStart: false,
      permissionsFn: async () => ({
        platform: "darwin",
        accessibility: true,
        screenRecording: false,
        checkedAt: Date.now(),
      }),
      axBridge: {
        enabled: true,
        setSyntheticEventTag() {},
        async checkPermissions() {
          return { accessibility: true, screenRecording: false };
        },
        async findRunningApp() {
          return { alive: false, pid: 0 };
        },
        async listApps() {
          return [];
        },
        async getFrontmostApp() {
          return null;
        },
      },
      actionPeer: {
        async connect() {},
        async listTools() {
          return { tools: [] };
        },
        async callTool() {
          return { isError: false, content: [] };
        },
        close() {},
      },
    });
    const info = await broker.start();
    const permRes = await fetch(
      `http://127.0.0.1:${info.webPort}/api/permissions?token=reconnect-test-token`
    );
    const permJson = await permRes.json();
    assert.equal(permJson.screenRecording, true, "Effective screenRecording must be true when helper preflight is true");
    assert.equal(permJson.components.jxa.screenRecording, false, "JXA component keeps honest telemetry");
    assert.equal(permJson.components.desktopHelper.preflight.screenRecording, true);

    // Simulate macOS TCC SIGKILLing CUADesktopHelper -> socket drops -> client auto-restarts once
    assert.equal(activeSockets.size, 1);
    for (const s of activeSockets) s.destroy();

    const deadline = Date.now() + 2500;
    while (Date.now() < deadline && (launchCount < 2 || !helperClient.available)) {
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(launchCount, 2, "DesktopHelperClient must auto-restart after unexpected disconnect");
    assert.equal(helperClient.available, true, "DesktopHelperClient must be available again after reconnect");
    assert.equal(
      statuses.some((d) => d.available === false && d.reason === "helper_disconnected"),
      true
    );

    // Explicit close must not trigger another restart
    await broker.close();
    broker = null;
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(launchCount, 2, "Explicit close must suppress autoRestart");
  } finally {
    for (const s of activeSockets) s.destroy();
    if (broker) await broker.close();
    else await helperClient.close();
  }
});

test("NativeComputerUsePeer holds WRITE_LOCKED_UNKNOWN_AGENT until deferred reap finishes and untagged OCU routes disable auto-click during flight", async () => {
  // 1. Deferred mutating timeout reaper keeps WRITE_LOCKED_UNKNOWN_AGENT locked until reaper resolves
  const controller = new TakeoverController();
  let releaseReap;
  const reapGate = new Promise((r) => {
    releaseReap = r;
  });
  let reapCalls = 0;

  const peer = new NativeComputerUsePeer({
    name: "timeout-lock-peer",
    onMutatingTimeoutUnknown(agentInstanceId) {
      controller.markWriteOutcomeUnknown(agentInstanceId);
      controller.requestPause({ reason: "mutating_timeout", source: "watchdog" });
    },
    onAgentInstanceCleared(agentInstanceId) {
      controller.clearWriteOutcomeUnknown(agentInstanceId);
    },
    async agentReapFn() {
      reapCalls += 1;
      await reapGate;
    },
    spawnFn() {
      const proc = new EventEmitter();
      proc.pid = 66661;
      proc.exitCode = null;
      proc.killed = false;
      proc.stdout = new PassThrough();
      proc.stderr = new PassThrough();
      proc.stdin = new Writable({
        write(chunk, _enc, cb) {
          const line = String(chunk);
          if (line.includes('"initialize"')) {
            queueMicrotask(() => {
              proc.stdout.write(
                `${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18" } })}\n`
              );
            });
          }
          // Deliberately never answer mutating tools/call so timeout fires
          cb();
        },
      });
      proc.kill = () => {
        proc.killed = true;
        proc.exitCode = 143;
        queueMicrotask(() => proc.emit("exit", 143, "SIGTERM"));
        return true;
      };
      return proc;
    },
  });

  try {
    await assert.rejects(
      () => peer.callTool("click", { app: "Finder", x: 1, y: 1 }, 40),
      /timed out after 40ms/u
    );
    assert.equal(controller.nativeWriteUnknownLock, true);
    const blockedResume = await controller.resume();
    assert.equal(blockedResume.ok, false);
    assert.equal(blockedResume.code, "WRITE_LOCKED_UNKNOWN_AGENT");

    releaseReap();
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(reapCalls, 1);
    assert.equal(controller.nativeWriteUnknownLock, false);
    const okResume = await controller.resume();
    assert.equal(okResume.ok, true);
  } finally {
    peer.close();
  }

  // 2. Untagged OCU routes (e.g. click:sky_click) suppress auto-click pause while write is in flight, without suppressing emergency_hotkey
  const controller2 = new TakeoverController({ syntheticEventTag: generateSyntheticEventTag() });
  const op = controller2.admit({ name: "click", isAi: true, isMutating: true });
  controller2.setTarget(op, {
    app: "com.lemon.lvpro",
    bundleId: "com.lemon.lvpro",
    pid: 7001,
    processToken: "7001:99",
    windowId: 501,
    routeKey: "click:window_post",
  });

  let finishSkyWrite;
  const skyWritePromise = new Promise((r) => {
    finishSkyWrite = r;
  });
  const tracked = controller2.trackNativeWrite(op, skyWritePromise, { routeKey: "click:sky_click" });

  const suppressed = controller2.handleSensorEvent({
    type: "mouse_down",
    sourceClass: "human",
    hit: { state: "hit", pid: 7001, processToken: "7001:99", windowId: 501, occludedByOther: false },
  });
  assert.equal(suppressed.triggered, false);
  assert.equal(suppressed.reason, "route_auto_click_disabled");
  assert.equal(controller2.paused, false);

  finishSkyWrite({ isError: false });
  await tracked;

  const afterSettle = controller2.handleSensorEvent({
    type: "mouse_down",
    sourceClass: "human",
    hit: { state: "hit", pid: 7001, processToken: "7001:99", windowId: 501, occludedByOther: false },
  });
  assert.equal(afterSettle.triggered, true);
  assert.equal(afterSettle.pauseReason, "human_click_target");
  assert.equal(controller2.paused, true);

  // Even while paused/draining or with untagged write in flight, emergency_hotkey always wins
  const resumed2 = await controller2.resume();
  assert.equal(resumed2.ok, true);
  const op2 = controller2.admit({ name: "click", isAi: true, isMutating: true });
  let finishSky2;
  const p2 = controller2.trackNativeWrite(op2, new Promise((r) => { finishSky2 = r; }), {
    routeKey: "click:sky_click",
  });
  const hotkeyHit = controller2.handleSensorEvent({ type: "emergency_hotkey", sourceClass: "human", isRepeat: false });
  assert.equal(hotkeyHit.triggered, true);
  finishSky2({ isError: false });
  await p2;

  // 3. Trusted automation PIDs ignore non-hotkey HID events, while configurable emergencyHotkey still reserves & triggers
  const controller3 = new TakeoverController({
    emergencyHotkey: "ctrl+shift+k",
    trustedPids: [88001, 88002],
  });
  assert.equal(controller3.isReservedHotkey("Control_L+Shift_L+k"), true);
  assert.equal(controller3.isReservedHotkey("ctrl+opt+escape"), false);
  const op3 = controller3.admit({ name: "click", isAi: true, isMutating: true });
  controller3.setTarget(op3, {
    app: "com.lemon.lvpro",
    bundleId: "com.lemon.lvpro",
    pid: 7001,
    processToken: "7001:99",
    windowId: 501,
    routeKey: "click:window_post",
  });
  const ignoredTrusted = controller3.handleSensorEvent({
    type: "mouse_down",
    sourceClass: "human",
    sourcePid: 88001,
    hit: { state: "hit", pid: 7001, processToken: "7001:99", windowId: 501, occludedByOther: false },
  });
  assert.equal(ignoredTrusted.triggered, false);
  assert.equal(ignoredTrusted.reason, "trusted_automation_pid");

  const customHotkeyHit = controller3.handleSensorEvent({
    type: "emergency_hotkey",
    sourceClass: "human",
    sourcePid: 88001,
    isRepeat: false,
  });
  assert.equal(customHotkeyHit.triggered, true);

  // enter/return alias normalization + NativeComputerUsePeer onChildSpawned callback
  const controllerEnter = new TakeoverController({ emergencyHotkey: "ctrl+enter" });
  assert.equal(controllerEnter.isReservedHotkey("Control_L+Return"), true);
  assert.equal(controllerEnter.isReservedHotkey("ctrl+return"), true);

  const spawnedPids = [];
  const spawnPeer = new NativeComputerUsePeer({
    name: "spawn-callback-peer",
    onChildSpawned: (pid) => spawnedPids.push(pid),
    spawnFn() {
      const proc = new EventEmitter();
      proc.pid = 77771;
      proc.exitCode = null;
      proc.killed = false;
      proc.stdout = new PassThrough();
      proc.stderr = new PassThrough();
      proc.stdin = new Writable({
        write(chunk, _enc, cb) {
          const line = String(chunk);
          if (line.includes('"initialize"')) {
            queueMicrotask(() => {
              proc.stdout.write(
                `${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18" } })}\n`
              );
            });
          } else {
            queueMicrotask(() => {
              proc.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, result: { ok: true } })}\n`);
            });
          }
          cb();
        },
      });
      proc.kill = () => true;
      return proc;
    },
  });
  try {
    await spawnPeer.ensureStarted();
    assert.deepEqual(spawnedPids, [77771]);
  } finally {
    spawnPeer.close();
  }
});

test("Codex 6.2 regressions: peer exit while mutating holds lock on reap failure, AX write timeout never falls back to sky_click, restoreFrontmost aborts on foreground change, and app_activated validates focusedWindowId", async () => {
  // 1. Child unexpected exit while mutating tool in flight holds lock when reap returns { reaped: false }
  const lockCtrl = new TakeoverController();
  let procRef = null;
  const failReapPeer = new NativeComputerUsePeer({
    name: "exit-lock-peer",
    onMutatingTimeoutUnknown(agentId) {
      lockCtrl.markWriteOutcomeUnknown(agentId);
    },
    onAgentInstanceCleared(agentId) {
      lockCtrl.clearWriteOutcomeUnknown(agentId);
    },
    async agentReapFn() {
      return { reaped: false };
    },
    spawnFn() {
      const proc = new EventEmitter();
      proc.pid = 77772;
      proc.exitCode = null;
      proc.killed = false;
      proc.stdout = new PassThrough();
      proc.stderr = new PassThrough();
      proc.stdin = new Writable({
        write(chunk, _enc, cb) {
          const line = String(chunk);
          if (line.includes('"initialize"')) {
            queueMicrotask(() => {
              proc.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18" } })}\n`);
            });
          } else if (line.includes('"click"')) {
            queueMicrotask(() => {
              proc.exitCode = 1;
              proc.emit("exit", 1, null);
            });
          }
          cb();
        },
      });
      proc.kill = () => true;
      procRef = proc;
      return proc;
    },
  });
  try {
    await assert.rejects(() => failReapPeer.callTool("click", { app: "Finder", x: 1, y: 1 }, 500));
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(lockCtrl.nativeWriteUnknownLock, true);
    const blocked = await lockCtrl.resume();
    assert.equal(blocked.code, "WRITE_LOCKED_UNKNOWN_AGENT");
  } finally {
    failReapPeer.close();
    void procRef;
  }

  // 2. PersistentAxBridge mutating timeout tags WRITE_OUTCOME_UNKNOWN / sent_unknown & BackgroundActionExecutor never falls back to sky_click
  const timeoutAxBridge = new PersistentAxBridge({
    enabled: true,
    spawnFn() {
      const proc = new EventEmitter();
      proc.pid = 77773;
      proc.exitCode = null;
      proc.stdout = new PassThrough();
      proc.stderr = new PassThrough();
      proc.stdin = new Writable({
        write(chunk, _enc, cb) {
          const msg = JSON.parse(String(chunk).trim());
          if (msg.method === "ping") {
            queueMicrotask(() => proc.stdout.write(`${JSON.stringify({ id: msg.id, ok: true, result: { ok: true } })}\n`));
          }
          cb();
        },
      });
      proc.kill = () => {
        proc.exitCode = 137;
        queueMicrotask(() => proc.emit("exit", 137, "SIGKILL"));
        return true;
      };
      return proc;
    },
  });
  try {
    await assert.rejects(
      () => timeoutAxBridge.request("window_click", { pid: 100, wid: 200 }, { timeoutMs: 25 }),
      (err) => err?.code === "WRITE_OUTCOME_UNKNOWN" && err?.deliveryState === "sent_unknown" && err?.dispatched === true
    );
  } finally {
    await timeoutAxBridge.close();
  }

  let skyClicks = 0;
  const unknownSock = path.join(tmpdir(), `cua-ax-unknown-${process.pid}-${Date.now()}.sock`);
  const unknownPeer = {
    async listTools() {
      return { tools: [{ name: "list_apps" }, { name: "get_app_state" }, { name: "query" }, { name: "click" }] };
    },
    async callTool(name) {
      if (name === "list_apps") {
        return { isError: false, content: [{ type: "text", text: "剪映专业版 — com.lemon.lvpro [running]" }] };
      }
      if (name === "get_app_state") {
        return {
          isError: false,
          content: [
            { type: "text", text: `App=com.lemon.lvpro (pid ${process.pid})\nWindow: "Main", App: 剪映专业版.\n0 按钮 "Export"` },
            { type: "image", data: makeTinyJpgBase64(), mimeType: "image/jpeg" },
          ],
        };
      }
      if (name === "query") {
        return {
          isError: false,
          content: [
            {
              type: "text",
              text: JSON.stringify({
                window_id: 707,
                window_title: "Main",
                matches: [{ index: 0, role: "AXButton", title: "Export", window_id: 707, bounds: { x: 10, y: 10, w: 60, h: 24 } }],
              }),
            },
          ],
        };
      }
      if (name === "click") {
        skyClicks += 1;
        return { isError: false, content: [{ type: "text", text: "ok" }] };
      }
      return { isError: true, content: [{ type: "text", text: "err" }] };
    },
    close() {},
  };
  const unknownAxBroker = new ComputerUseBrokerServer({
    webPort: 0,
    socketPath: unknownSock,
    infoPath: null,
    actionPeer: unknownPeer,
    streamPeer: unknownPeer,
    axBridge: {
      enabled: true,
      async checkPermissions() { return { accessibility: true, screenRecording: true }; },
      async getFrontmostApp() { return { pid: 100, bundleId: "com.google.antigravity" }; },
      async restoreFrontmostAppDetailed() { return { ok: true, definitive: true }; },
      async findRunningApp() { return { alive: true, pid: process.pid, bundleId: "com.lemon.lvpro", processToken: `${process.pid}:1` }; },
      async getProcessInfo(pid) { return { alive: true, guiApp: true, pid, bundleId: "com.lemon.lvpro", processToken: `${pid}:1` }; },
      async ensureManualAccessibility() { return { supported: true, changed: false, enabled: true, definitive: true }; },
      async resolveActionTarget() { return { resolved: true, wid: 707, windowBounds: { x: 0, y: 0, w: 800, h: 600 }, centerLocalPoint: { x: 40, y: 22 }, reason: "window_local_point" }; },
      async postWindowClick() {
        const err = new Error("PersistentAxBridge timeout on post_window_click (50ms)");
        err.code = "WRITE_OUTCOME_UNKNOWN";
        err.deliveryState = "sent_unknown";
        err.dispatched = true;
        throw err;
      },
      async dropSnapshots() { return { ok: true }; },
      async close() {},
    },
    permissionsFn: async () => ({ platform: "darwin", accessibility: true, screenRecording: true }),
    runningAppIdentityFn: async () => ({ pid: process.pid, bundleId: "com.lemon.lvpro", processToken: `${process.pid}:1` }),
  });
  await unknownAxBroker.start();
  try {
    const actRes = await unknownAxBroker.executeToolCall(
      "act",
      {
        app: "com.lemon.lvpro",
        target: { text: "Export" },
        reveal: { max_scroll_steps: 0 },
        expect: { any_text: ["Done"] },
      },
      { source: "ai" }
    );
    assert.equal(skyClicks, 0, "Unknown postWindowClick timeout must NEVER fall through to sky_click");
    const rawTxt = actRes.content[0].text;
    const body = JSON.parse(rawTxt.slice(rawTxt.indexOf("{")));
    assert.equal(body.code, "WRITE_OUTCOME_UNKNOWN");
    assert.equal(body.sent, true);
  } finally {
    await unknownAxBroker.close();
  }

  // 3. restoreFrontmostAppFast honors definitive foreground_changed refusal
  if (process.platform === "darwin") {
    const refused = await restoreFrontmostAppFast(process.pid, {
      expectedFrontmostPid: 999999,
      axBridge: {
        async restoreFrontmostAppDetailed() {
          return { ok: false, reason: "foreground_changed", definitive: true };
        },
      },
    });
    assert.equal(refused, false);
  }

  // 4. TakeoverController app_activated validates focusedWindowId when target.windowId > 0
  const tc3 = new TakeoverController();
  const op3 = tc3.admit({ name: "act", isAi: true, isMutating: true });
  tc3.setTarget(op3, { pid: 7001, windowId: 501, processToken: "7001:1" });
  const wrongWinAct = tc3.evaluateSensorEvent({
    type: "app_activated",
    sourceClass: "human",
    hasHumanSwitchGesture: true,
    pid: 7001,
    processToken: "7001:1",
    focusedWindowId: 999,
  });
  assert.equal(wrongWinAct.trigger, false);
  assert.equal(wrongWinAct.reason, "activated_other_window");
  tc3.clearOperation(op3);
});
