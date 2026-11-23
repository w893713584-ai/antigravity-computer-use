import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import vm from "node:vm";

import {
  authorizeActionScreenshotCoords,
  BackgroundActionExecutor,
  clipBoxIntersectionCenter,
} from "../src/action-executor.mjs";
import { AtomicActExecutor } from "../src/act-executor.mjs";
import {
  AppSnapshotRegistry,
  evaluateScreenshotMetaProof,
  isSingleWindowProven,
  resolveFocusedWindowObservation,
} from "../src/app-snapshot-registry.mjs";
import { BRIDGE_JXA_SOURCE, PersistentAxBridge } from "../src/ax-bridge.mjs";
import {
  dispatchBackgroundPointClickDetailed,
  dispatchBackgroundPointDragDetailed,
} from "../src/background-policy.mjs";
import { ComputerUseBrokerServer } from "../src/broker-sidecar.mjs";
import {
  FocusPolicyGuard,
  planBackgroundClickMethods,
  planBackgroundKeyMethods,
} from "../src/focus-policy-guard.mjs";
import {
  tryHeadlessBackgroundScroll,
  tryHeadlessContextMenu,
  tryHeadlessSelectedTextInsert,
  tryWindowKey,
  tryWindowScroll,
  tryWindowText,
} from "../src/headless-engine.mjs";
import crypto from "node:crypto";
import { rmSync } from "node:fs";
import { SCRIPT_RUNNER_APP_PATH } from "../src/constants.mjs";
import { BrokerRpcClient } from "../src/broker-client.mjs";
import { verifyNativeAppBundle } from "../src/native-distribution.mjs";
import { NativeComputerUsePeer } from "../src/native-peer.mjs";
import { StrictReplSessionManager } from "../src/repl-runner.mjs";
import { TakeoverAbortedError, TakeoverController } from "../src/takeover-controller.mjs";

function createJxaHarness({
  axTrusted = true,
  axWindows = null,
  hitTestFn = null,
  eventAllocOk = true,
  scrollEventAllocFn = null,
} = {}) {
  let postedEvents = 0;
  let axGetWindowCalls = 0;
  const winMap = axWindows || {
    4784: { x: 0, y: 45, w: 1469, h: 810, title: "剪映专业版", axBounds: { x: 0, y: 0, w: 1469, h: 810 } },
  };
  const sandbox = {
    ObjC: {
      import() {},
      bindFunction() {},
      unwrap: (v) => (v instanceof String ? v.valueOf() : v),
      deepUnwrap: (v) => v,
      castRefToObject: (v) => v,
    },
    $: undefined,
    Ref: (typeStr) => (typeStr ? [0] : [null]),
  };
  sandbox.$ = Object.assign((s) => s, {
    AXIsProcessTrusted: () => axTrusted,
    CGPreflightScreenCaptureAccess: () => false,
    AXUIElementCreateSystemWide: () => ({}),
    AXUIElementSetMessagingTimeout() {},
    AXUIElementCreateApplication: (pid) => ({ kind: "app", pid }),
    AXUIElementCopyAttributeValue: (el, rawAttr, out) => {
      const attr = String(rawAttr);
      if (!el || typeof el !== "object") return -25212;
      if (el.kind === "app") {
        if (attr === "AXFocusedWindow" || attr === "AXMainWindow") {
          const firstWid = Object.keys(winMap)[0];
          const w = winMap[firstWid];
          if (!w) return -25212;
          out[0] = { kind: "win", wid: Number(firstWid), bounds: w.axBounds, title: w.title };
          return 0;
        }
        if (attr === "AXWindows") {
          const arr = Object.entries(winMap).map(([wid, w]) => ({
            kind: "win",
            wid: Number(wid),
            bounds: w.axBounds,
            title: w.title,
          }));
          out[0] = {
            count: arr.length,
            objectAtIndex: (i) => arr[i],
          };
          return 0;
        }
        return -25212;
      }
      if (attr === "AXRole") {
        out[0] = el.kind === "win" ? "AXWindow" : el.role || "AXStaticText";
        return 0;
      }
      if (attr === "AXTitle") {
        out[0] = el.title || "";
        return 0;
      }
      if (attr === "AXParent") {
        if (el.parent) {
          out[0] = el.parent;
          return 0;
        }
        return -25212;
      }
      if (attr === "AXPosition" && el.bounds) {
        out[0] = `x: ${el.bounds.x}, y: ${el.bounds.y}`;
        return 0;
      }
      if (attr === "AXSize" && el.bounds) {
        out[0] = `w: ${el.bounds.w}, h: ${el.bounds.h}`;
        return 0;
      }
      if (attr === "AXWindow" && el.winEl) {
        out[0] = el.winEl;
        return 0;
      }
      return -25212;
    },
    AXUIElementCopyActionNames: () => -25212,
    AXUIElementCopyElementAtPosition: (_app, x, y, out) => {
      if (!hitTestFn) return -25212;
      const hit = hitTestFn(x, y);
      if (!hit) return -25212;
      out[0] = hit;
      return 0;
    },
    _AXUIElementGetWindow: (el, outRef) => {
      axGetWindowCalls += 1;
      let cur = el;
      while (cur) {
        if (cur.wid) {
          outRef[0] = cur.wid;
          return 0;
        }
        cur = cur.winEl || cur.parent || null;
      }
      return -25212;
    },
    CFCopyDescription: (v) => v,
    CFRelease() {},
    CFRunLoopRunInMode() {},
    kCFRunLoopDefaultMode: "default",
    NSBundle: { bundleWithPath: () => ({ load: true }) },
    NSProcessInfo: { processInfo: { systemUptime: 100 } },
    NSThread: { sleepForTimeInterval() {} },
    NSFileHandle: {
      fileHandleWithStandardInput: { availableData: { length: 0 } },
      fileHandleWithStandardOutput: { writeData() {} },
    },
    NSString: {},
    NSUTF16LittleEndianStringEncoding: 10,
    CGWindowListCopyWindowInfo: () =>
      Object.entries(winMap).map(([wid, w]) => ({
        kCGWindowNumber: Number(wid),
        kCGWindowOwnerPID: 63251,
        kCGWindowLayer: 0,
        kCGWindowAlpha: 1,
        kCGWindowName: w.title,
        kCGWindowBounds: { X: w.x, Y: w.y, Width: w.w, Height: w.h },
      })),
    CGEventSourceCreate: () => (eventAllocOk ? {} : null),
    CGEventCreateMouseEvent: (_s, evType, pt, btn) =>
      eventAllocOk ? { kind: "mouse", evType, x: pt.x, y: pt.y, btn } : null,
    CGEventCreateKeyboardEvent: (_s, keyCode, down) =>
      eventAllocOk ? { kind: "key", keyCode, down } : null,
    CGEventCreateScrollWheelEvent2: (_s, u, c, dy, dx) =>
      scrollEventAllocFn
        ? scrollEventAllocFn(u, c, dy, dx)
        : eventAllocOk
          ? { kind: "wheel", u, c, dy, dx }
          : null,
    CGEventKeyboardSetUnicodeString() {},
    CGEventSetLocation() {},
    CGEventSetTimestamp() {},
    CGEventSetFlags() {},
    CGEventSetIntegerValueField() {},
    CGEventSetDoubleValueField() {},
    CGEventSetWindowLocation() {},
    SLEventSetIntegerValueField() {},
    SLEventPostToPid() {
      postedEvents += 1;
    },
    CGEventPostToPid() {
      postedEvents += 1;
    },
    kCGMouseEventClickState: 1,
    kCGMouseEventButtonNumber: 3,
  });
  const callableDollar = Object.assign((str) => {
    const boxed = Object(String(str));
    boxed.dataUsingEncoding = () => ({ isNil: () => false, bytes: {} });
    return boxed;
  }, sandbox.$);
  sandbox.$ = callableDollar;
  vm.createContext(sandbox);
  vm.runInContext(BRIDGE_JXA_SOURCE, sandbox);
  return {
    sandbox,
    getPostedEvents: () => postedEvents,
    getAxGetWindowCalls: () => axGetWindowCalls,
  };
}

test("Slice 1: JXA trust gate fails closed with jxa_accessibility_untrusted and zero Quartz events across all window_* handlers & one-shot fallbacks", async () => {
  // 1) JXA handler seam when AXIsProcessTrusted() === false
  const h = createJxaHarness({ axTrusted: false });
  const clickRes = h.sandbox.handleWindowClick({
    pid: 63251,
    wid: 4784,
    localPoint: { x: 100, y: 100 },
  });
  assert.equal(clickRes.delivered, false);
  assert.equal(clickRes.deliveryState, "not_sent");
  assert.equal(clickRes.reason, "jxa_accessibility_untrusted");

  const keyRes = h.sandbox.handleWindowKey({
    pid: 63251,
    wid: 4784,
    key: "space",
  });
  assert.equal(keyRes.delivered, false);
  assert.equal(keyRes.deliveryState, "not_sent");
  assert.equal(keyRes.reason, "jxa_accessibility_untrusted");

  const textRes = h.sandbox.handleWindowText({
    pid: 63251,
    wid: 4784,
    text: "hello",
  });
  assert.equal(textRes.delivered, false);
  assert.equal(textRes.deliveryState, "not_sent");
  assert.equal(textRes.reason, "jxa_accessibility_untrusted");

  const scrollRes = h.sandbox.handleWindowScroll({
    pid: 63251,
    wid: 4784,
    localPoint: { x: 400, y: 400 },
    direction: "down",
  });
  assert.equal(scrollRes.delivered, false);
  assert.equal(scrollRes.verified, false);
  assert.equal(scrollRes.deliveryState, "not_sent");
  assert.equal(scrollRes.reason, "jxa_accessibility_untrusted");
  assert.equal(h.getPostedEvents(), 0, "Untrusted JXA must post ZERO Quartz events");

  // 2) Live PersistentAxBridge seam checks if macOS osascript is untrusted
  if (process.platform === "darwin") {
    const bridge = new PersistentAxBridge({ enabled: true });
    try {
      const perms = await bridge.checkPermissions().catch(() => null);
      if (perms?.accessibility === false) {
        const liveKey = await bridge.postWindowKey(999998, { key: "space" });
        assert.equal(liveKey.delivered, false);
        assert.equal(liveKey.deliveryState, "not_sent");
        assert.equal(liveKey.reason, "jxa_accessibility_untrusted");

        const liveText = await bridge.postWindowText(999998, { text: "hi" });
        assert.equal(liveText.delivered, false);
        assert.equal(liveText.deliveryState, "not_sent");
        assert.equal(liveText.reason, "jxa_accessibility_untrusted");

        // Tiny Window Override / one-shot osascript click & drag paths must NOT claim delivered:true when untrusted
        const oneShotRes = await dispatchBackgroundPointClickDetailed(process.pid, 100, 100, {
          axBridge: null,
          allowAppPostFallback: true,
        });
        assert.equal(oneShotRes.delivered, false);
        assert.equal(oneShotRes.deliveryState, "not_sent");
        assert.equal(oneShotRes.reason, "jxa_accessibility_untrusted");

        const oneShotDragRes = await dispatchBackgroundPointDragDetailed(process.pid, 100, 100, 160, 100);
        assert.equal(oneShotDragRes.delivered, false);
        assert.equal(oneShotDragRes.deliveryState, "not_sent");
        assert.equal(oneShotDragRes.method, "app_post");
        assert.equal(oneShotDragRes.reason, "jxa_accessibility_untrusted");
      }
    } finally {
      await bridge.close();
    }
  }

  // 3) dispatchBackgroundPointClickDetailed when axBridge returns jxa_accessibility_untrusted must NOT fall back to one-shot osascript
  const pointRes = await dispatchBackgroundPointClickDetailed(process.pid, 200, 200, {
    wid: 4784,
    bounds: { x: 0, y: 45, width: 1469, height: 810 },
    allowAppPostFallback: true,
    axBridge: {
      async postWindowClick() {
        return { delivered: false, deliveryState: "not_sent", reason: "jxa_accessibility_untrusted" };
      },
    },
  });
  assert.equal(pointRes.delivered, false);
  assert.equal(pointRes.deliveryState, "not_sent");
  assert.equal(pointRes.reason, "jxa_accessibility_untrusted");

  // 4) Broker / BackgroundActionExecutor explicit window_post (left & right click) & window_key fail closed with ZERO fallbacks
  let peerCalls = 0;
  let windowClickCalls = 0;
  let windowKeyCalls = 0;
  let contextMenuCalls = 0;
  const sock = path.join(tmpdir(), `cua-slice1-${process.pid}-${Date.now()}.sock`);
  const fakePeer = {
    async listTools() {
      return {
        tools: [
          { name: "list_apps" },
          { name: "get_app_state" },
          { name: "click", inputSchema: { properties: { click_method: { enum: ["auto", "app_post", "sky_click"] } } } },
          { name: "press_key" },
          { name: "type_text" },
        ],
      };
    },
    async callTool(name) {
      if (name === "list_apps") {
        return { isError: false, content: [{ type: "text", text: "剪映专业版 — com.lemon.lvpro [running]" }] };
      }
      if (name === "get_app_state") {
        return {
          isError: false,
          content: [
            {
              type: "text",
              text: [
                `App=com.lemon.lvpro (pid ${process.pid})`,
                'Window: "剪映专业版", App: 剪映专业版.',
                "0 标准窗口 剪映专业版",
              ].join("\n"),
            },
            {
              type: "image",
              data: Buffer.from([
                0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x02, 0xc1, 0x05, 0x00, 0x01, 0x01, 0x11, 0x00, 0xff, 0xd9,
              ]).toString("base64"),
              mimeType: "image/jpeg",
            },
          ],
        };
      }
      peerCalls += 1;
      return { isError: false, content: [{ type: "text", text: "ok" }] };
    },
    close() {},
  };
  const fakeBridge = {
    enabled: true,
    async checkPermissions() {
      return { accessibility: false, screenRecording: false };
    },
    async getFrontmostApp() {
      return { pid: 100, bundleId: "com.google.antigravity", displayName: "Antigravity" };
    },
    async restoreFrontmostApp() {
      return true;
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
      return { wid: 4784, title: "剪映专业版", windowBounds: { x: 0, y: 45, w: 1469, h: 810 }, windowIds: [4784] };
    },
    async postWindowClick() {
      windowClickCalls += 1;
      return { delivered: true };
    },
    async postWindowKey() {
      windowKeyCalls += 1;
      return { delivered: true };
    },
    async triggerContextMenu() {
      contextMenuCalls += 1;
      return { delivered: true, verified: true };
    },
    async dropSnapshots() {
      return { ok: true };
    },
    async close() {},
  };
  const broker = new ComputerUseBrokerServer({
    webPort: 0,
    socketPath: sock,
    infoPath: null,
    actionPeer: fakePeer,
    streamPeer: fakePeer,
    axBridge: fakeBridge,
    permissionsFn: async () => ({ platform: "darwin", accessibility: false, screenRecording: false }),
    runningAppIdentityFn: async () => ({ pid: process.pid, bundleId: "com.lemon.lvpro", processToken: `${process.pid}:1` }),
  });
  await broker.start();
  try {
    await broker.executeToolCall("get_app_state", { app: "com.lemon.lvpro" }, { source: "ai" });

    const leftExplicit = await broker.executeToolCall(
      "click",
      { app: "com.lemon.lvpro", x: 100, y: 100, click_method: "window_post" },
      { source: "ai" }
    );
    assert.equal(leftExplicit.isError, true);
    assert.match(leftExplicit.content[0].text, /jxa_accessibility_untrusted/);

    const rightExplicit = await broker.executeToolCall(
      "click",
      { app: "com.lemon.lvpro", element_index: "0", mouse_button: "right", click_method: "window_post" },
      { source: "ai" }
    );
    assert.equal(rightExplicit.isError, true);
    assert.match(rightExplicit.content[0].text, /jxa_accessibility_untrusted/);

    const keyExplicit = await broker.executeToolCall(
      "press_key",
      { app: "com.lemon.lvpro", key: "space", key_method: "window_key" },
      { source: "ai" }
    );
    assert.equal(keyExplicit.isError, true);
    assert.match(keyExplicit.content[0].text, /jxa_accessibility_untrusted/);

    assert.equal(windowClickCalls, 0, "Gate must stop window_post before calling windowClickFn");
    assert.equal(windowKeyCalls, 0, "Gate must stop window_key before calling windowKeyFn");
    assert.equal(contextMenuCalls, 0, "Explicit window_post right-click must NOT fall back to AXShowMenu");
    assert.equal(peerCalls, 0, "Explicit window_post/window_key untrusted calls must NOT fall back to OCU peer");
  } finally {
    await broker.close();
  }
});

test("Slice 2: Capability-aware FocusPolicyGuard, non-deadlocking executeActClick, single-gesture safety, and Takeover click:app_post policy", async () => {
  // 1) FocusPolicyGuard.planClick / planKey capability awareness
  const guard = new FocusPolicyGuard({
    resolveTargetInfo: () => ({
      appQuery: "com.lemon.lvpro",
      pid: 63251,
      bundleId: "com.lemon.lvpro",
      appDisplayName: "剪映专业版",
    }),
  });
  const scope4784 = { pid: 63251, processToken: "63251:1", windowId: 4784 };
  const scope4799 = { pid: 63251, processToken: "63251:1", windowId: 4799 };
  const scopeRestarted = { pid: 63251, processToken: "63251:2", windowId: 4784 };

  guard.recordSteal("com.lemon.lvpro", "click:sky_click", { routeScope: scope4784 });

  // When windowPostAvailable is true (default), ADR-0003 floor preserves window_post first
  assert.deepEqual(
    guard.planClick({ app: "com.lemon.lvpro", x: 100, y: 100 }, ["com.lemon.lvpro"], {
      routeScope: scope4784,
    }),
    ["window_post", "app_post"]
  );
  assert.deepEqual(
    guard.planClick(
      { app: "com.lemon.lvpro", x: 100, y: 100, click_method: "sky_click" },
      ["com.lemon.lvpro"],
      { routeScope: scope4784 }
    ),
    ["window_post", "app_post"]
  );

  // When windowPostAvailable is false, sky_click steal degrades auto left click to ["app_post"] (never dead window_post)
  assert.deepEqual(
    guard.planClick({ app: "com.lemon.lvpro", x: 100, y: 100 }, ["com.lemon.lvpro"], {
      routeScope: scope4784,
      windowPostAvailable: false,
    }),
    ["app_post"]
  );
  // Penalized explicit sky_click when windowPostAvailable is false MUST degrade to ["app_post"] (never re-enable focus-stealing sky_click)
  assert.deepEqual(
    guard.planClick(
      { app: "com.lemon.lvpro", x: 100, y: 100, click_method: "sky_click" },
      ["com.lemon.lvpro"],
      { routeScope: scope4784, windowPostAvailable: false }
    ),
    ["app_post"]
  );
  // Clean unblocked explicit sky_click still stays ["sky_click"]
  assert.deepEqual(
    guard.planClick(
      { app: "com.lemon.lvpro", x: 100, y: 100, click_method: "sky_click" },
      ["com.lemon.lvpro"],
      { routeScope: scope4799, windowPostAvailable: false }
    ),
    ["sky_click"]
  );
  // Explicit window_post still returns ["window_post"] so trust gate rejects honestly
  assert.deepEqual(
    guard.planClick(
      { app: "com.lemon.lvpro", x: 100, y: 100, click_method: "window_post" },
      ["com.lemon.lvpro"],
      { routeScope: scope4784, windowPostAvailable: false }
    ),
    ["window_post"]
  );
  // Right & triple clicks without window_post use ["app_post"]
  assert.deepEqual(
    guard.planClick(
      { app: "com.lemon.lvpro", x: 100, y: 100, mouse_button: "right" },
      ["com.lemon.lvpro"],
      { routeScope: scope4784, windowPostAvailable: false }
    ),
    ["app_post"]
  );
  assert.deepEqual(
    guard.planClick(
      { app: "com.lemon.lvpro", x: 100, y: 100, click_count: 3 },
      ["com.lemon.lvpro"],
      { routeScope: scope4784, windowPostAvailable: false }
    ),
    ["app_post"]
  );

  // Unrelated window, restarted processToken, and keyboard do NOT inherit wid:4784 click penalty
  assert.deepEqual(
    guard.planClick({ app: "com.lemon.lvpro", x: 100, y: 100 }, ["com.lemon.lvpro"], {
      routeScope: scope4799,
      windowPostAvailable: false,
    }),
    ["sky_click", "app_post"]
  );
  assert.deepEqual(
    guard.planClick({ app: "com.lemon.lvpro", x: 100, y: 100 }, ["com.lemon.lvpro"], {
      routeScope: scopeRestarted,
      windowPostAvailable: false,
    }),
    ["sky_click", "app_post"]
  );
  assert.deepEqual(
    guard.planKey("press_key", { app: "com.lemon.lvpro", key: "space" }, ["com.lemon.lvpro"], {
      routeScope: scope4784,
      windowKeyAvailable: false,
    }),
    ["sky_key"]
  );

  // After sky_key steal on same scope & windowKeyAvailable: false -> auto plans [] (fail closed, no dead window_key)
  guard.recordSteal("com.lemon.lvpro", "press_key:sky_key", { routeScope: scope4784 });
  assert.deepEqual(
    guard.planKey("press_key", { app: "com.lemon.lvpro", key: "space" }, ["com.lemon.lvpro"], {
      routeScope: scope4784,
      windowKeyAvailable: false,
    }),
    []
  );
  // Directly penalized explicit sky_key without floor fails closed [] (never re-enables focus-stealing sky_key)
  assert.deepEqual(
    planBackgroundKeyMethods(
      { app: "com.lemon.lvpro", key: "space", key_method: "sky_key" },
      { blockedMethods: ["sky_key"], windowKeyAvailable: false }
    ),
    []
  );
  assert.deepEqual(
    planBackgroundKeyMethods(
      { app: "com.lemon.lvpro", key: "space", key_method: "sky_key" },
      { blockedMethods: [], windowKeyAvailable: false }
    ),
    ["sky_key"]
  );
  assert.deepEqual(
    planBackgroundClickMethods(
      { app: "com.lemon.lvpro", x: 10, y: 10 },
      { blockedMethods: ["sky_click", "app_post"], windowPostAvailable: false }
    ),
    []
  );

  // 2) TakeoverController suppresses auto-click pause while click:app_post is in flight
  const tc = new TakeoverController();
  const op = tc.admit({ name: "click", isAi: true, isMutating: true });
  tc.setTarget(op, {
    app: "com.lemon.lvpro",
    bundleId: "com.lemon.lvpro",
    pid: 63251,
    processToken: "63251:1",
    windowId: 4784,
    routeKey: "click:app_post",
  });
  let resolveWrite;
  const pendingWrite = new Promise((r) => {
    resolveWrite = r;
  });
  const tracked = tc.trackNativeWrite(op, pendingWrite, { routeKey: "click:app_post" });
  const suppressed = tc.handleSensorEvent({
    type: "mouse_down",
    sourceClass: "human",
    hit: { state: "hit", pid: 63251, processToken: "63251:1", windowId: 4784, occludedByOther: false },
  });
  assert.equal(suppressed.triggered, false);
  assert.equal(suppressed.reason, "route_auto_click_disabled");
  assert.equal(tc.paused, false, "click:app_post in flight must suppress auto-click pause just like click:sky_click");
  tc.handleSensorEvent({ type: "emergency_hotkey", sourceClass: "human" });
  assert.equal(tc.paused, true, "emergency_hotkey must still pause even while click:app_post is in flight");
  resolveWrite({ isError: false });
  await tracked;

  // 3) Broker / executeActClick routes via app_post when sky_click is blacklisted & jxaTrusted is false,
  //    never loops to sky_click on opaque app_post errors or POSTCONDITION_FAILED, and avoids fake window_post route
  const sock = path.join(tmpdir(), `cua-slice2-${process.pid}-${Date.now()}.sock`);
  const peerClickCalls = [];
  let peerMode = "ok"; // "ok" | "opaque_error" | "no_postcondition"
  let expectPresent = false;
  let frontmost = { pid: 100, bundleId: "com.google.antigravity", displayName: "Antigravity" };

  const peer = {
    async listTools() {
      return {
        tools: [
          { name: "list_apps" },
          { name: "get_app_state" },
          { name: "query" },
          { name: "click", inputSchema: { properties: { click_method: { enum: ["auto", "app_post", "sky_click"] } } } },
        ],
      };
    },
    async callTool(name, args) {
      if (name === "list_apps") {
        return { isError: false, content: [{ type: "text", text: "剪映专业版 — com.lemon.lvpro [running]" }] };
      }
      if (name === "get_app_state") {
        return {
          isError: false,
          content: [
            {
              type: "text",
              text: [
                `App=com.lemon.lvpro (pid ${process.pid})`,
                'Window: "剪映专业版", App: 剪映专业版.',
                "0 标准窗口 剪映专业版",
              ].join("\n"),
            },
            {
              type: "image",
              data: Buffer.from([
                0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x02, 0xc1, 0x05, 0x00, 0x01, 0x01, 0x11, 0x00, 0xff, 0xd9,
              ]).toString("base64"),
              mimeType: "image/jpeg",
            },
          ],
        };
      }
      if (name === "query") {
        if (args.text === "朗读面板") {
          return {
            isError: false,
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  window_id: 4784,
                  window_title: "剪映专业版",
                  matches: expectPresent
                    ? [{ index: 1000010, role: "AXStaticText", title: "朗读面板", bounds: { x: 10, y: 10, w: 50, h: 20 } }]
                    : [],
                }),
              },
            ],
          };
        }
        return {
          isError: false,
          content: [
            {
              type: "text",
              text: JSON.stringify({
                window_id: 4784,
                window_title: "剪映专业版",
                matches: [
                  {
                    index: 1000004,
                    role: "AXStaticText",
                    title: "VESettingPanelSubTabControl:气泡",
                    bounds: { x: 1252, y: 91, w: 98, h: 24 },
                  },
                ],
              }),
            },
          ],
        };
      }
      if (name === "click") {
        peerClickCalls.push(args);
        if (peerMode === "opaque_error") {
          return { isError: true, content: [{ type: "text", text: "IPC write stalled" }] };
        }
        if (peerMode === "ok") {
          expectPresent = true;
        }
        return { isError: false, content: [{ type: "text", text: "ok" }] };
      }
      return { isError: true, content: [{ type: "text", text: `unknown ${name}` }] };
    },
    close() {},
  };

  const fakeBridge = {
    enabled: true,
    async checkPermissions() {
      return { accessibility: false, screenRecording: false };
    },
    async getFrontmostApp() {
      return frontmost;
    },
    async restoreFrontmostApp() {
      frontmost = { pid: 100, bundleId: "com.google.antigravity", displayName: "Antigravity" };
      return true;
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
      return { wid: 4784, title: "剪映专业版", windowBounds: { x: 0, y: 45, w: 1469, h: 810 }, windowIds: [4784] };
    },
    async resolveActionTarget(_pid, opts) {
      return {
        resolved: true,
        wid: opts?.wid || 4784,
        windowBounds: { x: 0, y: 45, w: 1469, h: 810 },
        reason: "window_local_point",
      };
    },
    async dropSnapshots() {
      return { ok: true };
    },
    async close() {},
  };

  const broker = new ComputerUseBrokerServer({
    webPort: 0,
    socketPath: sock,
    infoPath: null,
    actionPeer: peer,
    streamPeer: peer,
    axBridge: fakeBridge,
    permissionsFn: async () => ({ platform: "darwin", accessibility: false, screenRecording: false }),
    runningAppIdentityFn: async () => ({ pid: process.pid, bundleId: "com.lemon.lvpro", processToken: `${process.pid}:1` }),
  });
  await broker.start();
  try {
    await broker.executeToolCall("get_app_state", { app: "com.lemon.lvpro" }, { source: "ai" });

    // Record prior click:sky_click focus steal on wid 4784
    broker.focusPolicyGuard.recordSteal("com.lemon.lvpro", "click:sky_click", {
      routeScope: { pid: process.pid, processToken: `${process.pid}:1`, windowId: 4784 },
    });

    // a) Opaque error on app_post must NOT fall through to sky_click (clicksSent must be 1!)
    peerMode = "opaque_error";
    peerClickCalls.length = 0;
    const errAct = await broker.executeToolCall(
      "act",
      {
        app: "com.lemon.lvpro",
        target: { text: "VESettingPanelSubTabControl:气泡", exact: true },
        reveal: { max_scroll_steps: 0 },
        expect: { any_text: ["朗读面板"] },
        timeout_ms: 400,
      },
      { source: "ai" }
    );
    assert.equal(errAct.isError, true);
    const errPayload = JSON.parse(errAct.content[0].text.replace(/^\[[^\]]+\]\s*/, ""));
    assert.equal(errPayload.clicksSent, 1);
    assert.equal(errPayload.route, "click:app_post");
    assert.equal(peerClickCalls.length, 1);
    assert.equal(peerClickCalls[0].click_method, "app_post");

    // b) POSTCONDITION_FAILED on app_post must NOT escalate to sky_click
    peerMode = "no_postcondition";
    peerClickCalls.length = 0;
    const postFailAct = await broker.executeToolCall(
      "act",
      {
        app: "com.lemon.lvpro",
        target: { text: "VESettingPanelSubTabControl:气泡", exact: true },
        reveal: { max_scroll_steps: 0 },
        expect: { any_text: ["朗读面板"] },
        timeout_ms: 250,
      },
      { source: "ai" }
    );
    assert.equal(postFailAct.isError, true);
    assert.equal(peerClickCalls.length, 1);
    assert.equal(peerClickCalls[0].click_method, "app_post");

    // c) Next call STILL uses app_post cleanly (never escalated back to sky_click) and succeeds!
    peerMode = "ok";
    peerClickCalls.length = 0;
    const okAct = await broker.executeToolCall(
      "act",
      {
        app: "com.lemon.lvpro",
        target: { text: "VESettingPanelSubTabControl:气泡", exact: true },
        reveal: { max_scroll_steps: 0 },
        expect: { any_text: ["朗读面板"] },
        timeout_ms: 1000,
      },
      { source: "ai" }
    );
    assert.equal(okAct.isError, false, `Expected act to succeed via app_post: ${okAct.content?.[0]?.text}`);
    const okPayload = JSON.parse(okAct.content[0].text);
    assert.equal(okPayload.verified, true);
    assert.equal(okPayload.route, "click:app_post");
    assert.equal(peerClickCalls.length, 1);
    assert.equal(peerClickCalls[0].click_method, "app_post");

    // d) If BOTH sky_click and app_post are blocked, zero-dispatch act MUST NOT misreport route:"click:window_post"
    broker.focusPolicyGuard.recordSteal("com.lemon.lvpro", "click:app_post", {
      routeScope: { pid: process.pid, processToken: `${process.pid}:1`, windowId: 4784 },
    });
    peerClickCalls.length = 0;
    const blockedAct = await broker.executeToolCall(
      "act",
      {
        app: "com.lemon.lvpro",
        target: { text: "VESettingPanelSubTabControl:气泡", exact: true },
        reveal: { max_scroll_steps: 0 },
        expect: { any_text: ["朗读面板"] },
        timeout_ms: 300,
      },
      { source: "ai" }
    );
    assert.equal(blockedAct.isError, true);
    assert.equal(peerClickCalls.length, 0);
    const blockedPayload = JSON.parse(blockedAct.content[0].text.replace(/^\[[^\]]+\]\s*/, ""));
    assert.equal(blockedPayload.clicksSent, 0);
    assert.equal(blockedPayload.route ?? null, null, "Zero-dispatch failure must not claim route: click:window_post");
  } finally {
    await broker.close();
  }
});

test("Slice 3a: Broker act maps Qt query bounds to exact 1280x705 screenshot pixels, enforces Same-Window Proof, invalidates on peer restart, and protects expect observation", async () => {
  const sock = path.join(tmpdir(), `cua-slice3-broker-${process.pid}-${Date.now()}.sock`);
  const peerClickCalls = [];
  let peerGeneration = "action-engine-1";
  let currentWindowTitle = "剪映专业版";
  let focusedWindowInfo = {
    wid: 4784,
    title: "剪映专业版",
    windowBounds: { x: 0, y: 45, w: 1469, h: 810 },
    windowIds: [4784],
  };
  let queryWid = 4784;
  let queryExpectResponseWid = 4784;
  let textTtsActive = false;
  let bubbleActive = false;
  let expectQueryCalls = 0;
  let simulateClickSteal = true;
  let simulateReadBackSteal = false;
  let frontmost = { pid: 100, bundleId: "com.google.antigravity", displayName: "Antigravity" };
  let frontmostRestores = 0;

  // 1280x705 baseline JPEG SOF0 header
  const jpg1280x705 = Buffer.from([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x02, 0xc1, 0x05, 0x00, 0x01, 0x01, 0x11, 0x00, 0xff, 0xd9,
  ]).toString("base64");

  const peer = {
    get agentInstanceId() {
      return peerGeneration;
    },
    async listTools() {
      return {
        tools: [
          { name: "list_apps" },
          { name: "get_app_state" },
          { name: "query" },
          { name: "click", inputSchema: { properties: { click_method: { enum: ["auto", "app_post", "sky_click"] } } } },
        ],
      };
    },
    async callTool(name, args) {
      if (name === "list_apps") {
        return { isError: false, content: [{ type: "text", text: "剪映专业版 — com.lemon.lvpro [running]" }] };
      }
      if (name === "get_app_state") {
        if (simulateReadBackSteal) {
          frontmost = { pid: process.pid, bundleId: "com.lemon.lvpro", displayName: "剪映专业版" };
        }
        return {
          isError: false,
          content: [
            {
              type: "text",
              text: [
                `App=com.lemon.lvpro (pid ${process.pid})`,
                `Window: "${currentWindowTitle}", App: 剪映专业版.`,
                "0 标准窗口 剪映专业版",
              ].join("\n"),
            },
            { type: "image", data: jpg1280x705, mimeType: "image/jpeg" },
          ],
        };
      }
      if (name === "query") {
        if (args.text === "text_tts") {
          return {
            isError: false,
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  window_id: queryWid,
                  window_title: currentWindowTitle,
                  matches: [
                    {
                      index: 1000001,
                      role: "AXStaticText",
                      title: "text_tts",
                      bounds: { x: 1290, y: 37, w: 50, h: 42 },
                    },
                  ],
                }),
              },
            ],
          };
        }
        if (args.text === "VESettingPanelSubTabControl:气泡") {
          return {
            isError: false,
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  window_id: queryWid,
                  window_title: currentWindowTitle,
                  matches: [
                    {
                      index: 1000004,
                      role: "AXStaticText",
                      title: "VESettingPanelSubTabControl:气泡",
                      bounds: { x: 1252, y: 91, w: 98, h: 24 },
                    },
                  ],
                }),
              },
            ],
          };
        }
        if (args.text === "开始朗读") {
          expectQueryCalls += 1;
          return {
            isError: false,
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  window_id: queryExpectResponseWid,
                  matches: textTtsActive
                    ? [{ index: 1000020, role: "AXButton", title: "开始朗读", bounds: { x: 1200, y: 200, w: 80, h: 28 } }]
                    : [],
                }),
              },
            ],
          };
        }
        if (args.text === "气泡样式") {
          return {
            isError: false,
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  window_id: 4784,
                  matches: bubbleActive
                    ? [{ index: 1000021, role: "AXStaticText", title: "气泡样式", bounds: { x: 1200, y: 200, w: 80, h: 28 } }]
                    : [],
                }),
              },
            ],
          };
        }
        if (args.text === "OldTabMarker") {
          // Cross-window match from window_id 8123 while expecting on 4784!
          return {
            isError: false,
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  window_id: 8123,
                  matches: [{ index: 99, role: "AXStaticText", title: "OldTabMarker", window_id: 8123 }],
                }),
              },
            ],
          };
        }
        return { isError: false, content: [{ type: "text", text: JSON.stringify({ window_id: queryWid, matches: [] }) }] };
      }
      if (name === "click") {
        peerClickCalls.push(args);
        if ((args.x === 1146 && args.y === 50) || args.element_index === "1000001") {
          textTtsActive = true;
          if (args.click_method === "sky_click" && simulateClickSteal) {
            // Simulate Qt self-activation on sky_click
            frontmost = { pid: process.pid, bundleId: "com.lemon.lvpro", displayName: "剪映专业版" };
          }
        }
        if (args.x === 1134 && args.y === 90) {
          bubbleActive = true;
        }
        return { isError: false, content: [{ type: "text", text: "ok" }] };
      }
      return { isError: true, content: [{ type: "text", text: `unknown ${name}` }] };
    },
    close() {},
  };

  const fakeBridge = {
    enabled: true,
    async checkPermissions() {
      return { accessibility: false, screenRecording: false };
    },
    async getFrontmostApp() {
      return frontmost;
    },
    async restoreFrontmostApp() {
      frontmostRestores += 1;
      frontmost = { pid: 100, bundleId: "com.google.antigravity", displayName: "Antigravity" };
      return true;
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
      return focusedWindowInfo;
    },
    async resolveActionTarget(_pid, opts) {
      return {
        resolved: true,
        wid: opts?.wid || 4784,
        windowBounds: { x: 0, y: 45, w: 1469, h: 810 },
        axOriginMismatch: true,
        reason: "window_local_point",
      };
    },
    async dropSnapshots() {
      return { ok: true };
    },
    async close() {},
  };

  const broker = new ComputerUseBrokerServer({
    webPort: 0,
    socketPath: sock,
    infoPath: null,
    actionPeer: peer,
    streamPeer: peer,
    axBridge: fakeBridge,
    focusController: {
      async getFrontmostApp() {
        return frontmost;
      },
      async restoreFrontmostApp() {
        frontmostRestores += 1;
        frontmost = { pid: 100, bundleId: "com.google.antigravity", displayName: "Antigravity" };
        return true;
      },
      sweepDelaysMs: [],
    },
    permissionsFn: async () => ({ platform: "darwin", accessibility: false, screenRecording: false }),
    runningAppIdentityFn: async () => ({ pid: process.pid, bundleId: "com.lemon.lvpro", processToken: `${process.pid}:1` }),
  });
  await broker.start();

  try {
    // Offscreen clipBoxIntersectionCenter with requireOverlap must return null
    assert.equal(
      clipBoxIntersectionCenter({ x: 100, y: 900, w: 80, h: 30 }, { x: 0, y: 0, w: 1469, h: 810 }, { requireOverlap: true }),
      null
    );

    // 1) Initial get_app_state gets single-window proof wid=4784
    await broker.executeToolCall("get_app_state", { app: "com.lemon.lvpro" }, { source: "ai" });
    const meta1 = broker.registry.getMeta("com.lemon.lvpro");
    assert.equal(meta1.actionScreenshotMeta?.windowIdProven, true);
    assert.equal(meta1.actionScreenshotMeta?.windowId, 4784);
    assert.equal(meta1.actionScreenshotMeta?.peerInstanceId, "action-engine-1");

    // 2) act(text_tts) with explicit window_id:4784 (proven match) MUST use mapped pixels [1146, 50], NOT element_index
    peerClickCalls.length = 0;
    const act1 = await broker.executeToolCall(
      "act",
      {
        app: "com.lemon.lvpro",
        window_id: 4784,
        target: { text: "text_tts", exact: true },
        reveal: { max_scroll_steps: 0 },
        expect: { any_text: ["开始朗读"] },
        timeout_ms: 800,
      },
      { source: "ai" }
    );
    assert.equal(act1.isError, false, `Expected act1 ok: ${act1.content?.[0]?.text}`);
    assert.deepEqual(peerClickCalls, [
      { app: "com.lemon.lvpro", click_method: "sky_click", x: 1146, y: 50, mouse_button: "left", click_count: 1 },
    ]);

    // 3) Since sky_click self-activated on wid:4784, act(气泡) without explicit window_id falls through cleanly to app_post at [1134, 90]!
    peerClickCalls.length = 0;
    const act2 = await broker.executeToolCall(
      "act",
      {
        app: "com.lemon.lvpro",
        target: { text: "VESettingPanelSubTabControl:气泡", exact: true },
        reveal: { max_scroll_steps: 0 },
        expect: { any_text: ["气泡样式"] },
        timeout_ms: 800,
      },
      { source: "ai" }
    );
    assert.equal(act2.isError, false, `Expected act2 ok via app_post: ${act2.content?.[0]?.text}`);
    assert.deepEqual(peerClickCalls, [
      { app: "com.lemon.lvpro", click_method: "app_post", x: 1134, y: 90, mouse_button: "left", click_count: 1 },
    ]);

    // 4) expect.text_disappears receiving cross-window query result (8123 vs 4784) must NOT falsely verify=true,
    //    and read-back focus steal must NOT penalize click:sky_click on a clean window!
    textTtsActive = false;
    simulateClickSteal = false;
    const cleanScope4900 = { pid: process.pid, processToken: `${process.pid}:1`, windowId: 4900 };
    focusedWindowInfo = {
      wid: 4900,
      title: "新编辑器",
      windowBounds: { x: 0, y: 45, w: 1469, h: 810 },
      windowIds: [4900],
    };
    currentWindowTitle = "新编辑器";
    queryWid = 4900;
    await broker.executeToolCall("get_app_state", { app: "com.lemon.lvpro" }, { source: "ai" });
    simulateReadBackSteal = false;
    // Trigger a one-shot focus steal during #evaluateExpect's query("OldTabMarker") read-back on pinned wid 4900
    const prevRestores = frontmostRestores;
    let expectQueryStealInjected = false;
    const origCallTool = peer.callTool.bind(peer);
    peer.callTool = async (name, args) => {
      if (name === "query" && args?.text === "OldTabMarker" && !expectQueryStealInjected) {
        expectQueryStealInjected = true;
        frontmost = { pid: process.pid, bundleId: "com.lemon.lvpro", displayName: "剪映专业版" };
      }
      return origCallTool(name, args);
    };
    const actCrossExpect = await broker.executeToolCall(
      "act",
      {
        app: "com.lemon.lvpro",
        window_id: 4900,
        target: { text: "text_tts", exact: true },
        reveal: { max_scroll_steps: 0 },
        expect: { text_disappears: ["OldTabMarker"] },
        timeout_ms: 250,
      },
      { source: "ai" }
    );
    assert.equal(actCrossExpect.isError, true, "Cross-window text_disappears (wid 8123 != 4900) must be inconclusive, not verified:true");
    assert.ok(frontmostRestores > prevRestores, "Focus steal during #evaluateExpect must be reclaimed");
    assert.equal(
      broker.focusPolicyGuard.isMethodBlocked(["com.lemon.lvpro"], "click", "sky_click", {
        routeScope: cleanScope4900,
      }),
      false,
      "Observation read-back inside #evaluateExpect must NOT blacklist click:sky_click"
    );
    peer.callTool = origCallTool;
    simulateReadBackSteal = false;

    // 5) Ambiguous sibling windows (same title/size, wid: null from getFocusedWindowInfo):
    //    query(wid 4784) -> get_app_state MUST NOT inherit 4784 as windowIdProven:true!
    focusedWindowInfo = {
      wid: null,
      title: "剪映专业版",
      windowBounds: null,
      windowIds: [4784, 4800],
    };
    currentWindowTitle = "剪映专业版";
    queryWid = 4784;
    await broker.executeToolCall("query", { app: "com.lemon.lvpro", text: "text_tts", window_id: 4784 }, { source: "ai" });
    await broker.executeToolCall("get_app_state", { app: "com.lemon.lvpro" }, { source: "ai" });
    const unprovMeta = broker.registry.getMeta("com.lemon.lvpro");
    assert.equal(
      Boolean(unprovMeta.actionScreenshotMeta?.windowIdProven),
      false,
      "Inherited WID without proven screenshot capture must set windowIdProven: false"
    );

    // On wid:4784 (where sky_click is already blocked and screenshot is unproven), pinned PID-level app_post must be refused.
    peerClickCalls.length = 0;
    const pinnedAppPostRefused = await broker.executeToolCall(
      "act",
      {
        app: "com.lemon.lvpro",
        window_id: 4784,
        target: { text: "text_tts", exact: true },
        reveal: { max_scroll_steps: 0 },
        expect: { any_text: ["开始朗读"] },
        timeout_ms: 400,
      },
      { source: "ai" }
    );
    assert.equal(pinnedAppPostRefused.isError, true, "Unproven pinned wid:4784 must refuse PID-level app_post");
    assert.equal(peerClickCalls.length, 0);

    // Pinned act to clean sibling window_id: 4800 when screenshot is NOT proven for 4800 must fall back to element_index (NOT pixel coords)
    queryWid = 4800;
    queryExpectResponseWid = 4800;
    textTtsActive = false;
    await broker.executeToolCall("query", { app: "com.lemon.lvpro", text: "text_tts", window_id: 4800 }, { source: "ai" });
    await broker.executeToolCall("get_app_state", { app: "com.lemon.lvpro" }, { source: "ai" });
    assert.equal(Boolean(broker.registry.getMeta("com.lemon.lvpro").actionScreenshotMeta?.windowIdProven), false);
    peerClickCalls.length = 0;
    const pinnedFallbackAct = await broker.executeToolCall(
      "act",
      {
        app: "com.lemon.lvpro",
        window_id: 4800,
        target: { text: "text_tts", exact: true },
        reveal: { max_scroll_steps: 0 },
        expect: { any_text: ["开始朗读"] },
        timeout_ms: 800,
      },
      { source: "ai" }
    );
    assert.equal(pinnedFallbackAct.isError, false, `Expected pinnedFallbackAct ok: ${pinnedFallbackAct.content?.[0]?.text}`);
    assert.equal(peerClickCalls[0].click_method, "sky_click");
    assert.equal(
      peerClickCalls[0].element_index,
      "1000001",
      "Unproven screenshot for pinned wid:4800 must fall back to element_index instead of pixels"
    );
    assert.equal(peerClickCalls[0].x, undefined);

    // 6) Action peer restart invalidates cached actionScreenshotMeta
    peerGeneration = "action-engine-2";
    broker.registry.invalidateActionScreenshots();
    assert.equal(broker.registry.getMeta("com.lemon.lvpro").actionHasScreenshot, false);
    assert.equal(broker.registry.getMeta("com.lemon.lvpro").actionScreenshotMeta, null);
  } finally {
    await broker.close();
  }
});

test("Slice 3b: PersistentAxBridge aligns Qt AXWindow origin offset ONLY when _AXUIElementGetWindow confirms identical wid", () => {
  // 1) Verified same window: AXWindow {0,0,1469,810} vs CGWindow {0,45,1469,810}, wid=4784
  const hSame = createJxaHarness({
    axTrusted: true,
    axWindows: {
      4784: { x: 0, y: 45, w: 1469, h: 810, title: "剪映专业版", axBounds: { x: 0, y: 0, w: 1469, h: 810 } },
    },
    hitTestFn: (x, y) => {
      // Simulate Qt hit-test failing at CG screen coords (1315, 103) and succeeding only at AX origin (1315, 58)
      if (Math.abs(x - 1315) <= 2 && Math.abs(y - 58) <= 2) {
        return {
          role: "AXButton",
          wid: 4784,
          bounds: { x: 1290, y: 37, w: 50, h: 42 },
          winEl: { kind: "win", wid: 4784, bounds: { x: 0, y: 0, w: 1469, h: 810 }, title: "剪映专业版" },
        };
      }
      return null;
    },
  });
  hSame.sandbox.retainedSnapshots.s1 = {
    pid: 63251,
    windowEl: { kind: "win", wid: 4784, bounds: { x: 0, y: 0, w: 1469, h: 810 }, title: "剪映专业版" },
    elements: {
      1: {
        el: {
          role: "AXButton",
          wid: 4784,
          bounds: { x: 1290, y: 37, w: 50, h: 42 },
          winEl: { kind: "win", wid: 4784, bounds: { x: 0, y: 0, w: 1469, h: 810 }, title: "剪映专业版" },
        },
        w: 50,
        h: 42,
        relX: 1290,
        relY: 37,
      },
    },
  };

  const resolved = hSame.sandbox.handleResolveActionTarget({
    pid: 63251,
    wid: 4784,
    localPoint: { x: 1315, y: 58 },
  });
  assert.equal(resolved.resolved, true);
  assert.equal(resolved.axOriginMismatch, true);
  assert.deepEqual({ x: resolved.centerLocalPoint?.x, y: resolved.centerLocalPoint?.y }, { x: 1315, y: 58 });

  const winClick = hSame.sandbox.handleWindowClick({
    pid: 63251,
    wid: 4784,
    snapshotId: "s1",
    elementIndex: "1",
  });
  assert.equal(winClick.delivered, true);
  assert.equal(winClick.localX, 1315);
  assert.equal(winClick.localY, 58, "45pt AX/CG origin mismatch must map localY to 58 (not 58-45=13)");

  // 2) Mismatched sibling windows (same dimensions, different wid: element belongs to 4702 while target wid is 4784)
  const hSibling = createJxaHarness({
    axTrusted: true,
    axWindows: {
      4784: { x: 0, y: 45, w: 1469, h: 810, title: "剪映专业版", axBounds: { x: 0, y: 0, w: 1469, h: 810 } },
      4702: { x: 100, y: 45, w: 1469, h: 810, title: "剪映专业版", axBounds: { x: 0, y: 0, w: 1469, h: 810 } },
    },
  });
  hSibling.sandbox.retainedSnapshots.s2 = {
    pid: 63251,
    windowEl: { kind: "win", wid: 4702, bounds: { x: 0, y: 0, w: 1469, h: 810 }, title: "剪映专业版" },
    elements: {
      1: {
        el: {
          role: "AXButton",
          wid: 4702,
          bounds: { x: 1290, y: 37, w: 50, h: 42 },
          winEl: { kind: "win", wid: 4702, bounds: { x: 0, y: 0, w: 1469, h: 810 }, title: "剪映专业版" },
        },
      },
    },
  };
  const mismatchClick = hSibling.sandbox.handleWindowClick({
    pid: 63251,
    wid: 4784,
    snapshotId: "s2",
    elementIndex: "1",
  });
  assert.equal(mismatchClick.delivered, false);
  assert.equal(mismatchClick.deliveryState, "not_sent");
  assert.equal(mismatchClick.reason, "element_window_mismatch");
  assert.equal(hSibling.getPostedEvents(), 0, "Mismatched sibling window must post ZERO events");
});

test("Slice 4a: Pre-IPC STALE_PEER_GENERATION guard, AppSnapshotRegistry provenance seam, Qt AX-origin-first hit-test, unconditional sibling guard, offscreen fail-fast, & honest partial delivery", async () => {
  // 1) Real NativeComputerUsePeer queue + child restart: stale click must reject before child 2 stdin.write
  const jpg1280x705 = Buffer.from([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x02, 0xc1, 0x05, 0x00, 0x01, 0x01, 0x11, 0x00, 0xff, 0xd9,
  ]).toString("base64");
  let spawnSeq = 0;
  let child1Proc = null;
  const child2ToolWrites = [];
  const peer = new NativeComputerUsePeer({
    name: "action-peer-restart-test",
    agentReapFn: async () => ({ reaped: true }),
    spawnFn() {
      spawnSeq += 1;
      const myGen = spawnSeq;
      const proc = new EventEmitter();
      proc.pid = 70000 + myGen;
      proc.exitCode = null;
      proc.killed = false;
      proc.stdout = new PassThrough();
      proc.stderr = new PassThrough();
      proc.stdin = new Writable({
        write(chunk, _enc, cb) {
          for (const rawLine of String(chunk).split(/\r?\n/)) {
            if (!rawLine.trim()) continue;
            const msg = JSON.parse(rawLine);
            if (myGen >= 2 && msg.method === "tools/call") {
              child2ToolWrites.push(msg.params);
            }
            if (msg.method === "initialize") {
              queueMicrotask(() => {
                proc.stdout.write(
                  `${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18" } })}\n`
                );
              });
            } else if (msg.id !== undefined) {
              queueMicrotask(() => {
                if (msg.params?.name === "get_app_state") {
                  proc.stdout.write(
                    `${JSON.stringify({
                      jsonrpc: "2.0",
                      id: msg.id,
                      result: {
                        isError: false,
                        content: [
                          { type: "text", text: `App=com.lemon.lvpro (pid ${process.pid})\nWindow: "剪映专业版", App: 剪映专业版.\nWindowID: 4784` },
                          { type: "image", data: jpg1280x705, mimeType: "image/jpeg" },
                        ],
                      },
                    })}\n`
                  );
                } else {
                  proc.stdout.write(
                    `${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { isError: false, content: [{ type: "text", text: "ok" }] } })}\n`
                  );
                }
              });
            }
          }
          cb();
        },
      });
      proc.kill = () => {
        proc.killed = true;
        proc.exitCode = 1;
        return true;
      };
      if (myGen === 1) child1Proc = proc;
      return proc;
    },
  });

  try {
    const registry = new AppSnapshotRegistry();
    const stateRes = await peer.callTool("get_app_state", { app: "com.lemon.lvpro" });
    const gen1Id = peer.agentInstanceId;
    assert.ok(gen1Id, "Expected initial peer generation id");
    const meta1 = registry.recordMeta(
      "com.lemon.lvpro",
      {
        pid: process.pid,
        windowId: 4784,
        windowBounds: { x: 0, y: 45, w: 1469, h: 810 },
        peerInstanceId: gen1Id,
      },
      {
        fromActionPeer: true,
        includeAx: true,
        includeScreenshot: true,
        actionDims: { width: 1280, height: 705 },
      }
    );

    // Simulate peer child 1 dying cleanly right before executeActClick dispatches
    child1Proc.exitCode = 1;
    child1Proc.emit("exit", 1, null);

    const guard = new FocusPolicyGuard({
      focusController: {
        async getFrontmostApp() {
          return { pid: 100, bundleId: "com.google.antigravity" };
        },
        async restoreFrontmostApp() {
          return true;
        },
        sweepDelaysMs: [],
      },
    });
    const staleExecutor = new BackgroundActionExecutor({
      actionPeer: peer,
      axBridge: { enabled: true, async checkPermissions() { return { accessibility: false }; } },
      focusPolicyGuard: guard,
      registry,
    });
    const staleActRes = await staleExecutor.executeActClick({
      app: "com.lemon.lvpro",
      pid: process.pid,
      meta: meta1,
      match: { index: 1000001, role: "AXStaticText", title: "text_tts", bounds: { x: 1290, y: 37, w: 50, h: 42 } },
      targetWindowId: 4784,
    });
    assert.equal(staleActRes.delivered, false);
    assert.equal(staleActRes.clicksSent, 0);
    assert.equal(staleActRes.routeKey, null);
    assert.equal(staleActRes.failureReason, "stale_peer_generation");
    assert.equal(child2ToolWrites.length, 0, "Stale click built from peer 1 must write 0 tool calls to peer 2 stdin");

    // Direct NativeComputerUsePeer guard also rejects expectedAgentInstanceId mismatch
    await assert.rejects(
      () =>
        peer.callTool("click", { app: "com.lemon.lvpro", x: 10, y: 10 }, 2000, {
          expectedAgentInstanceId: gen1Id,
        }),
      (err) => err?.code === "STALE_PEER_GENERATION" && err?.deliveryState === "not_sent"
    );
    assert.equal(child2ToolWrites.length, 0);
  } finally {
    peer.close();
  }

  // 2) AppSnapshotRegistry Same-Window Proof seam: rejects same-title siblings, tiny_window_override, and unproven inherited wid
  const reg2 = new AppSnapshotRegistry({
    axBridge: {
      enabled: true,
      async getFocusedWindowInfo() {
        return {
          wid: 4784,
          title: "剪映专业版",
          windowBounds: { x: 0, y: 45, w: 1469, h: 810 },
          windowIds: [4784, 4800],
        };
      },
    },
  });
  const siblingProof = await reg2.proveScreenshotWindowObservation("com.lemon.lvpro", {
    pid: process.pid,
    imgDims: { width: 1280, height: 705 },
    windowTitle: "剪映专业版",
  });
  assert.equal(siblingProof.proven, false, "Two sibling windows with identical title must NEVER prove screenshot WID");
  assert.equal(siblingProof.windowCount, 2);
  assert.equal(siblingProof.singleWindowProven, false);

  const tinyOverrideMeta = {
    pid: process.pid,
    windowId: 4784,
    windowBounds: { x: 0, y: 45, w: 1469, h: 810 },
    actionScreenshotMeta: {
      pid: process.pid,
      windowId: 4784,
      windowIdProven: true,
      windowCount: 1,
      singleWindowProven: true,
      width: 1280,
      height: 705,
      source: "tiny_window_override",
    },
  };
  assert.equal(
    authorizeActionScreenshotCoords(tinyOverrideMeta, {
      pid: process.pid,
      targetWindowId: 4784,
      windowSize: { width: 1469, height: 810 },
      localPoint: { x: 1315, y: 58 },
    }).authorized,
    false,
    "tiny_window_override screenshot must not authorize OCU pixel click"
  );

  const inheritedUnprovenMeta = {
    pid: process.pid,
    windowId: 4784,
    windowBounds: { x: 0, y: 45, w: 1469, h: 810 },
    actionScreenshotMeta: {
      pid: process.pid,
      windowId: 4784,
      windowIdProven: false,
      windowCount: 2,
      singleWindowProven: false,
      width: 1280,
      height: 705,
      source: "ocu_action_peer",
    },
  };
  assert.equal(
    authorizeActionScreenshotCoords(inheritedUnprovenMeta, {
      pid: process.pid,
      targetWindowId: 4784,
      windowSize: { width: 1469, height: 810 },
      localPoint: { x: 1315, y: 58 },
    }).sameWindowProven,
    false,
    "Unpinned act must not treat inherited unproven windowId as proven"
  );

  // Unpinned act without effectiveWid and with windowCount: null must ALSO fail closed when windowIdProven is false
  const noWidNoCountMeta = {
    pid: process.pid,
    windowBounds: { x: 0, y: 45, w: 1469, h: 810 },
    actionScreenshotMeta: {
      pid: process.pid,
      windowId: null,
      windowIdProven: false,
      windowCount: null,
      singleWindowProven: false,
      width: 1280,
      height: 705,
      source: "ocu_action_peer",
    },
  };
  assert.equal(
    authorizeActionScreenshotCoords(noWidNoCountMeta, {
      pid: process.pid,
      windowSize: { width: 1469, height: 810 },
      localPoint: { x: 1315, y: 58 },
    }).authorized,
    false,
    "Unpinned coordinate auth without windowIdProven and windowCount must fail closed"
  );

  // Deferred invalidateActionScreenshots("old-gen") must preserve screenshots captured by "new-gen"
  const regRestartRace = new AppSnapshotRegistry();
  regRestartRace.recordMeta(
    "com.lemon.lvpro",
    { pid: process.pid, windowId: 4784, peerInstanceId: "gen-2" },
    { fromActionPeer: true, includeAx: true, includeScreenshot: true, actionDims: { width: 1280, height: 705 } }
  );
  regRestartRace.invalidateActionScreenshots("gen-1");
  assert.equal(
    regRestartRace.getMeta("com.lemon.lvpro").actionScreenshotMeta?.peerInstanceId,
    "gen-2",
    "Deferred reap of old peer generation must NOT wipe gen-2 screenshot"
  );
  regRestartRace.invalidateActionScreenshots("gen-2");
  assert.equal(regRestartRace.getMeta("com.lemon.lvpro").actionScreenshotMeta, null);

  // 3) Qt AX-origin-first hit-test avoids hitting neighboring CG-shifted control (`气泡` vs `朗读`)
  const hitProbes = [];
  const hNeighbor = createJxaHarness({
    axTrusted: true,
    axWindows: {
      4784: { x: 0, y: 45, w: 1469, h: 810, title: "剪映专业版", axBounds: { x: 0, y: 0, w: 1469, h: 810 } },
    },
    hitTestFn: (x, y) => {
      hitProbes.push({ x, y });
      // AX-origin local (1315, 58) -> 朗读 (`text_tts`)
      if (Math.abs(x - 1315) <= 2 && Math.abs(y - 58) <= 2) {
        return {
          role: "AXButton",
          title: "text_tts",
          wid: 4784,
          bounds: { x: 1290, y: 37, w: 50, h: 42 },
          winEl: { kind: "win", wid: 4784, bounds: { x: 0, y: 0, w: 1469, h: 810 }, title: "剪映专业版" },
        };
      }
      // CG-origin screen (1315, 45+58=103) -> neighboring control 气泡!
      if (Math.abs(x - 1315) <= 2 && Math.abs(y - 103) <= 2) {
        return {
          role: "AXButton",
          title: "气泡",
          wid: 4784,
          bounds: { x: 1252, y: 91, w: 98, h: 24 },
          winEl: { kind: "win", wid: 4784, bounds: { x: 0, y: 0, w: 1469, h: 810 }, title: "剪映专业版" },
        };
      }
      return null;
    },
  });
  const neighborRes = hNeighbor.sandbox.handleResolveActionTarget({
    pid: 63251,
    wid: 4784,
    localPoint: { x: 1315, y: 58 },
  });
  assert.equal(hitProbes[0].y, 58, "axOriginMismatch must probe AX-origin FIRST before CG-origin");
  assert.equal(neighborRes.resolved, true);
  assert.deepEqual({ x: neighborRes.localBounds?.x, y: neighborRes.localBounds?.y }, { x: 1290, y: 37 });
  assert.deepEqual({ x: neighborRes.centerLocalPoint?.x, y: neighborRes.centerLocalPoint?.y }, { x: 1315, y: 58 });

  // 4) Unconditional sibling guard (even when localPoint IS supplied!) + terminal mismatch & offscreen fail-fast
  const hUncondSibling = createJxaHarness({
    axTrusted: true,
    axWindows: {
      4784: { x: 0, y: 45, w: 1469, h: 810, title: "剪映专业版", axBounds: { x: 0, y: 0, w: 1469, h: 810 } },
      4702: { x: 100, y: 45, w: 1469, h: 810, title: "剪映专业版", axBounds: { x: 0, y: 0, w: 1469, h: 810 } },
    },
  });
  hUncondSibling.sandbox.retainedSnapshots.sSibling = {
    pid: 63251,
    windowEl: { kind: "win", wid: 4702, bounds: { x: 0, y: 0, w: 1469, h: 810 }, title: "剪映专业版" },
    elements: {
      1: {
        el: {
          role: "AXButton",
          wid: 4702,
          bounds: { x: 1290, y: 37, w: 50, h: 42 },
          winEl: { kind: "win", wid: 4702, bounds: { x: 0, y: 0, w: 1469, h: 810 }, title: "剪映专业版" },
        },
      },
    },
  };
  const bothSuppliedMismatch = hUncondSibling.sandbox.handleWindowClick({
    pid: 63251,
    wid: 4784,
    snapshotId: "sSibling",
    elementIndex: "1",
    localPoint: { x: 1315, y: 58 },
  });
  assert.equal(bothSuppliedMismatch.delivered, false);
  assert.equal(bothSuppliedMismatch.deliveryState, "not_sent");
  assert.equal(bothSuppliedMismatch.reason, "element_window_mismatch");
  assert.equal(hUncondSibling.getPostedEvents(), 0);

  let peerClicksInAct = 0;
  let winClicksInAct = 0;
  const actGuard = new FocusPolicyGuard();
  const actExec = new BackgroundActionExecutor({
    actionPeer: {
      async callTool(name) {
        if (name === "click") peerClicksInAct += 1;
        return { isError: false, content: [{ type: "text", text: "ok" }] };
      },
    },
    axBridge: { enabled: true, async checkPermissions() { return { accessibility: true }; } },
    focusPolicyGuard: actGuard,
    registry: reg2,
    windowClickFn: async () => {
      winClicksInAct += 1;
      return { delivered: false, deliveryState: "not_sent", reason: "element_window_mismatch" };
    },
  });
  const mismatchActRes = await actExec.executeActClick({
    app: "com.lemon.lvpro",
    pid: process.pid,
    meta: { windowBounds: { x: 0, y: 45, w: 1469, h: 810 } },
    match: { index: 1, bounds: { x: 1290, y: 37, w: 50, h: 42 } },
    targetWindowId: 4784,
  });
  assert.equal(mismatchActRes.delivered, false);
  assert.equal(mismatchActRes.clicksSent, 0);
  assert.equal(mismatchActRes.routeKey, null);
  assert.equal(mismatchActRes.failureReason, "element_window_mismatch");
  assert.equal(peerClicksInAct, 0, "element_window_mismatch must terminate without OCU fallback");

  winClicksInAct = 0;
  peerClicksInAct = 0;
  const offscreenActRes = await actExec.executeActClick({
    app: "com.lemon.lvpro",
    pid: process.pid,
    meta: { windowBounds: { x: 0, y: 45, w: 1469, h: 810 } },
    match: { index: 1, bounds: { x: 100, y: 900, w: 80, h: 30 } },
    targetWindowId: 4784,
  });
  assert.equal(offscreenActRes.delivered, false);
  assert.equal(offscreenActRes.clicksSent, 0);
  assert.equal(offscreenActRes.routeKey, null);
  assert.equal(offscreenActRes.failureReason, "target_offscreen");
  assert.equal(winClicksInAct, 0);
  assert.equal(peerClicksInAct, 0);

  // 5) Partial delivery: sent_unknown blocks set_value fallback & right-click AXShowMenu, and scroll reports sent_unknown
  let nativeSetValueCalls = 0;
  let contextMenuFallbackCalls = 0;
  const partialExec = new BackgroundActionExecutor({
    actionPeer: {
      async callTool(name) {
        if (name === "set_value") nativeSetValueCalls += 1;
        return { isError: false, content: [{ type: "text", text: "ok" }] };
      },
    },
    axBridge: { enabled: true, async checkPermissions() { return { accessibility: true }; } },
    focusPolicyGuard: new FocusPolicyGuard(),
    registry: reg2,
    windowClickFn: async () => ({ delivered: false, deliveryState: "sent_unknown", reason: "partial_click_post" }),
    windowKeyFn: async () => ({ delivered: true }),
    windowTextFn: async () => ({ delivered: false, deliveryState: "sent_unknown", reason: "partial_text_post" }),
    editableFocusFn: async () => ({ editable: true, singleLine: true }),
    contextMenuFallbackFn: async () => {
      contextMenuFallbackCalls += 1;
      return { delivered: true };
    },
  });
  partialExec.focusPolicyGuard.recordSteal("com.lemon.lvpro", "set_value:native");
  partialExec.focusPolicyGuard.recordSteal("com.lemon.lvpro", "press_key:sky_key");
  partialExec.focusPolicyGuard.recordSteal("com.lemon.lvpro", "type_text:sky_key");
  partialExec.focusPolicyGuard.recordSteal("com.lemon.lvpro", "click:sky_click");
  reg2.recordMeta(
    "com.lemon.lvpro",
    {
      pid: process.pid,
      windowId: 4784,
      windowBounds: { x: 0, y: 45, w: 1469, h: 810 },
      elements: new Map([
        ["1", { index: "1", role: "AXTextField", rawText: "1 文本输入框 Title", origin: "ax" }],
      ]),
    },
    { fromActionPeer: true, includeAx: true, includeScreenshot: true, actionDims: { width: 1280, height: 705 } }
  );
  const partialBypassRes = await partialExec.dispatch({
    name: "set_value",
    app: "com.lemon.lvpro",
    cleanArgs: { app: "com.lemon.lvpro", element_index: "1", value: "hello" },
    parsedRef: { ok: true, hasElementRef: true, rawIndex: "1" },
  });
  assert.equal(partialBypassRes.actionRouteKey, "set_value:sky_bypass");
  assert.equal(partialBypassRes.result.isError, true);
  assert.equal(partialBypassRes.result.deliveryState, "sent_unknown");
  assert.equal(nativeSetValueCalls, 0, "Partial sky_bypass window_text must NEVER fall through to native set_value");

  const partialRightClickRes = await partialExec.dispatch({
    name: "click",
    app: "com.lemon.lvpro",
    cleanArgs: { app: "com.lemon.lvpro", element_index: "1", mouse_button: "right" },
    parsedRef: { ok: true, hasElementRef: true, rawIndex: "1" },
  });
  assert.equal(partialRightClickRes.result.isError, true);
  assert.equal(partialRightClickRes.result.deliveryState, "sent_unknown");
  assert.equal(contextMenuFallbackCalls, 0, "sent_unknown window_post must block AXShowMenu fallback");

  let scrollAllocCall = 0;
  const hPartialScroll = createJxaHarness({
    axTrusted: true,
    scrollEventAllocFn: (u, c, dy, dx) => {
      scrollAllocCall += 1;
      return scrollAllocCall <= 1 ? { kind: "wheel", u, c, dy, dx } : null;
    },
  });
  const partialScrollRes = hPartialScroll.sandbox.handleWindowScroll({
    pid: 63251,
    wid: 4784,
    localPoint: { x: 500, y: 400 },
    direction: "down",
    steps: 3,
  });
  assert.equal(partialScrollRes.delivered, false);
  assert.equal(partialScrollRes.deliveryState, "sent_unknown");
  assert.equal(partialScrollRes.reason, "partial_scroll_post");
  assert.ok(partialScrollRes.deltaY < 0 && Math.abs(partialScrollRes.deltaY) < 400);

  // ActionExecutor preserves deliveryState: "sent_unknown" and fatal: true across scroll, drag, and tiny-override point click
  let axScrollFallbackCalls = 0;
  reg2.recordMeta(
    "com.lemon.lvpro",
    {
      pid: process.pid,
      windowId: 4784,
      windowCount: 1,
      singleWindowProven: true,
      windowBounds: { x: 0, y: 45, w: 1469, h: 810 },
    },
    {
      fromActionPeer: true,
      includeAx: true,
      includeScreenshot: true,
      actionDims: { width: 1280, height: 705 },
      tinyWindowOverride: {
        wid: 4784,
        bounds: { x: 0, y: 45, width: 1469, height: 810 },
        imgWidth: 1280,
        imgHeight: 705,
      },
    }
  );
  const unkExec = new BackgroundActionExecutor({
    actionPeer: { async callTool() { return { isError: false, content: [{ type: "text", text: "ok" }] }; } },
    axBridge: { enabled: true, async checkPermissions() { return { accessibility: true }; } },
    focusPolicyGuard: new FocusPolicyGuard(),
    registry: reg2,
    windowScrollFn: async () => ({ delivered: false, deliveryState: "sent_unknown", method: "window_post_scroll", reason: "partial_scroll_post" }),
    axScrollFallbackFn: async () => {
      axScrollFallbackCalls += 1;
      return { delivered: true };
    },
    pointClickFn: async () => ({ delivered: false, deliveryState: "sent_unknown", method: "app_post", reason: "point_click_outcome_unknown" }),
    pointDragFn: async () => ({ delivered: false, deliveryState: "sent_unknown", method: "app_post", reason: "partial_point_drag_post" }),
  });
  const scrollUnkRes = await unkExec.dispatch({
    name: "scroll",
    app: "com.lemon.lvpro",
    cleanArgs: { app: "com.lemon.lvpro", direction: "down" },
    windowDelivery: { route: "window_post", pid: process.pid, windowId: 4784, allowAppPostFallback: true },
  });
  assert.equal(scrollUnkRes.result.deliveryState, "sent_unknown");
  assert.equal(scrollUnkRes.result.fatal, true);
  assert.equal(axScrollFallbackCalls, 0, "sent_unknown window scroll must block ax_scrollbar fallback");

  const ptClickUnkRes = await unkExec.dispatch({
    name: "click",
    app: "com.lemon.lvpro",
    cleanArgs: { app: "com.lemon.lvpro", x: 100, y: 100 },
  });
  assert.equal(ptClickUnkRes.result.deliveryState, "sent_unknown");
  assert.equal(ptClickUnkRes.result.fatal, true);
  assert.equal(ptClickUnkRes.result.reason, "point_click_outcome_unknown");

  const ptDragUnkRes = await unkExec.dispatch({
    name: "drag",
    app: "com.lemon.lvpro",
    cleanArgs: { app: "com.lemon.lvpro", from_x: 100, from_y: 100, to_x: 200, to_y: 100 },
  });
  assert.equal(ptDragUnkRes.result.deliveryState, "sent_unknown");
  assert.equal(ptDragUnkRes.result.fatal, true);
  assert.equal(ptDragUnkRes.result.reason, "partial_point_drag_post");
});

test("Slice 4b: act observation pause gate, obsVersion sweep fence, and strict window-bound expect & latestImage omission", async () => {
  // 1) FocusPolicyGuard obsVersion fence protects routes even if enterObservationPhase fires mid-enforce
  let releaseFrontSample;
  const frontGate = new Promise((r) => {
    releaseFrontSample = r;
  });
  let sampleCalls = 0;
  let restores = 0;
  let frontmostApp = { pid: 100, bundleId: "com.google.antigravity" };
  const guard = new FocusPolicyGuard({
    resolveTargetInfo: () => ({ pid: process.pid, bundleId: "com.lemon.lvpro", appDisplayName: "剪映专业版" }),
    focusController: {
      async getFrontmostApp() {
        sampleCalls += 1;
        if (sampleCalls === 2) await frontGate;
        return frontmostApp;
      },
      async restoreFrontmostApp() {
        restores += 1;
        frontmostApp = { pid: 100, bundleId: "com.google.antigravity" };
        return true;
      },
      sweepDelaysMs: [],
    },
  });
  const scope = await guard.beginGuard("com.lemon.lvpro", {
    routeScope: { pid: process.pid, windowId: 4784 },
  });
  frontmostApp = { pid: process.pid, bundleId: "com.lemon.lvpro" };
  const enforcePromise = scope.enforce("click:sky_click", {
    routeScope: { pid: process.pid, windowId: 4784 },
  });
  // Wait a microtask so sampleCalls === 2 enters await frontGate before observation starts
  await new Promise((r) => setTimeout(r, 10));
  scope.enterObservationPhase();
  scope.exitObservationPhase();
  releaseFrontSample();
  assert.equal(await enforcePromise, true, "Steal must still be reclaimed");
  assert.equal(restores, 1);
  assert.equal(
    guard.isMethodBlocked(["com.lemon.lvpro"], "click", "sky_click", {
      routeScope: { pid: process.pid, windowId: 4784 },
    }),
    false,
    "obsVersion change during in-flight #enforce must suppress route penalty"
  );
  guard.close();

  // 2) Broker act: observationalOnly (0 promoteMainWindowFn), empty matches without wid, unpinned sibling bodyText & unproven latestImage
  const sock = path.join(tmpdir(), `cua-slice4b-${process.pid}-${Date.now()}.sock`);
  let promoteCalls = 0;
  let returnTinyOnState = false;
  let expectSiblingBodyOnly = false;
  let unpinnedSucceedViaQuery = false;
  // Tiny 84x84 JPEG header + 1280x705 JPEG header
  const jpgTiny = Buffer.from([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x54, 0x00, 0x54, 0x01, 0x01, 0x11, 0x00, 0xff, 0xd9,
  ]).toString("base64");
  const jpg1280 = Buffer.from([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x02, 0xc1, 0x05, 0x00, 0x01, 0x01, 0x11, 0x00, 0xff, 0xd9,
  ]).toString("base64");

  const peer = {
    async listTools() {
      return {
        tools: [
          { name: "list_apps" },
          { name: "get_app_state" },
          { name: "query" },
          { name: "click", inputSchema: { properties: { click_method: { enum: ["sky_click"] } } } },
        ],
      };
    },
    async callTool(name, args) {
      if (name === "list_apps") {
        return { isError: false, content: [{ type: "text", text: "剪映专业版 — com.lemon.lvpro [running]" }] };
      }
      if (name === "get_app_state") {
        return {
          isError: false,
          content: [
            {
              type: "text",
              text: [
                `App=com.lemon.lvpro (pid ${process.pid})`,
                'Window: "剪映专业版", App: 剪映专业版.',
                expectSiblingBodyOnly ? "\t1 静态文本 SiblingOnlyText" : "0 对话框",
              ].join("\n"),
            },
            { type: "image", data: returnTinyOnState ? jpgTiny : jpg1280, mimeType: "image/jpeg" },
          ],
        };
      }
      if (name === "query") {
        if (args.text === "target_btn") {
          return {
            isError: false,
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  window_id: 4784,
                  window_title: "剪映专业版",
                  matches: [
                    { index: 1000001, role: "AXButton", title: "target_btn", bounds: { x: 100, y: 100, w: 80, h: 30 } },
                  ],
                }),
              },
            ],
          };
        }
        if (args.text === "OldVanishText") {
          // Intentionally omit window_id with matches: [] -> MUST be inconclusive for pinned text_disappears
          return { isError: false, content: [{ type: "text", text: JSON.stringify({ matches: [] }) }] };
        }
        if (args.text === "SiblingOnlyText") {
          return { isError: false, content: [{ type: "text", text: JSON.stringify({ window_id: 4784, matches: [] }) }] };
        }
        if (args.text === "RealQueryVerified") {
          return {
            isError: false,
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  window_id: 4784,
                  matches: unpinnedSucceedViaQuery
                    ? [{ index: 1000002, role: "AXStaticText", title: "RealQueryVerified", bounds: { x: 10, y: 10, w: 60, h: 20 } }]
                    : [],
                }),
              },
            ],
          };
        }
        return { isError: false, content: [{ type: "text", text: JSON.stringify({ window_id: 4784, matches: [] }) }] };
      }
      if (name === "click") {
        unpinnedSucceedViaQuery = true;
        return { isError: false, content: [{ type: "text", text: "ok" }] };
      }
      return { isError: true, content: [{ type: "text", text: `unknown ${name}` }] };
    },
    close() {},
  };

  const bridge = {
    enabled: true,
    async checkPermissions() {
      return { accessibility: false, screenRecording: false };
    },
    async getFrontmostApp() {
      return { pid: 100, bundleId: "com.google.antigravity" };
    },
    async restoreFrontmostApp() {
      return true;
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
      // Two sibling windows -> windowIdProven stays false!
      return { wid: null, title: "剪映专业版", windowBounds: null, windowIds: [4784, 4800] };
    },
    async resolveActionTarget() {
      return { resolved: true, wid: 4784, windowBounds: { x: 0, y: 45, w: 1469, h: 810 }, reason: "window_local_point" };
    },
    async dropSnapshots() {
      return { ok: true };
    },
    async close() {},
  };

  const broker = new ComputerUseBrokerServer({
    webPort: 0,
    socketPath: sock,
    infoPath: null,
    actionPeer: peer,
    streamPeer: peer,
    axBridge: bridge,
    promoteMainWindowFn: async () => {
      promoteCalls += 1;
      return true;
    },
    permissionsFn: async () => ({ platform: "darwin", accessibility: false, screenRecording: false }),
    runningAppIdentityFn: async () => ({ pid: process.pid, bundleId: "com.lemon.lvpro", processToken: `${process.pid}:1` }),
  });
  await broker.start();

  try {
    // Seed initial 1280x705 state so #ensureAppReady warm-state does not trigger before #evaluateExpect
    await broker.executeToolCall("get_app_state", { app: "com.lemon.lvpro" }, { source: "ai" });

    // a) Pinned text_disappears with { matches: [] } and missing window_id must NOT verify true
    returnTinyOnState = false;
    const missingWidVanish = await broker.executeToolCall(
      "act",
      {
        app: "com.lemon.lvpro",
        window_id: 4784,
        target: { text: "target_btn", exact: true },
        reveal: { max_scroll_steps: 0 },
        expect: { text_disappears: ["OldVanishText"] },
        timeout_ms: 150,
      },
      { source: "ai" }
    );
    assert.equal(missingWidVanish.isError, true, "Missing response window_id with empty matches must stay inconclusive");

    // b) Unpinned expect.any_text must NOT verify from unproven sibling get_app_state body, AND must NOT call promoteMainWindowFn
    returnTinyOnState = true;
    expectSiblingBodyOnly = true;
    promoteCalls = 0;
    const siblingBodyRes = await broker.executeToolCall(
      "act",
      {
        app: "com.lemon.lvpro",
        target: { text: "target_btn", exact: true },
        reveal: { max_scroll_steps: 0 },
        expect: { any_text: ["SiblingOnlyText"] },
        timeout_ms: 150,
      },
      { source: "ai" }
    );
    assert.equal(siblingBodyRes.isError, true, "Unproven get_app_state bodyText must NOT verify unpinned any_text");
    assert.equal(promoteCalls, 0, "observationalOnly expect read must NOT invoke promoteMainWindowFn");

    // c) Successful unpinned act with unproven screenshot must omit latestImage
    expectSiblingBodyOnly = false;
    unpinnedSucceedViaQuery = false;
    const unprovenImgSuccess = await broker.executeToolCall(
      "act",
      {
        app: "com.lemon.lvpro",
        target: { text: "target_btn", exact: true },
        reveal: { max_scroll_steps: 0 },
        expect: { any_text: ["RealQueryVerified"] },
        timeout_ms: 500,
      },
      { source: "ai" }
    );
    assert.equal(unprovenImgSuccess.isError, false);
    assert.equal(
      unprovenImgSuccess.content.some((c) => c.type === "image"),
      false,
      "Unproven screenshot must be omitted from act latestImage"
    );
  } finally {
    await broker.close();
  }
});

test("Slice 5 (Round 4 Regressions): Same-Window Proof completeness, click/scroll route gates, reveal/text/value sent_unknown, expect WID binding, and JXA edge cases", async () => {
  // 1) P1 #1: proveScreenshotWindowObservation rejects mismatched sole windowIds, authorizeActionScreenshotCoords rejects effectiveWid=0,
  //    invalidateActionScreenshots preserves peerInstanceId=null, and text-only recordMeta clears prior screenshot proof.
  let obsWid = 41;
  let obsWindowIds = [42];
  const regP1 = new AppSnapshotRegistry({
    axBridge: {
      enabled: true,
      async getFocusedWindowInfo() {
        return {
          wid: obsWid,
          title: "Main",
          windowBounds: { x: 0, y: 0, w: 1200, h: 800 },
          windowIds: obsWindowIds,
        };
      },
    },
  });
  const badInvProof = await regP1.proveScreenshotWindowObservation("com.lemon.lvpro", {
    pid: process.pid,
    imgDims: { width: 1200, height: 800 },
  });
  assert.equal(badInvProof.proven, false, "Focused wid=41 with sole inventory [42] must NOT prove screenshot window");

  obsWid = 41;
  obsWindowIds = [41];
  const goodInvProof = await regP1.proveScreenshotWindowObservation("com.lemon.lvpro", {
    pid: process.pid,
    imgDims: { width: 1200, height: 800 },
  });
  assert.equal(goodInvProof.proven, true);

  const zeroEffectiveAuth = authorizeActionScreenshotCoords(
    {
      pid: process.pid,
      actionScreenshotMeta: {
        pid: process.pid,
        windowId: 0,
        windowIdProven: true,
        width: 1200,
        height: 800,
        source: "ocu_action_peer",
      },
    },
    {
      pid: process.pid,
      windowSize: { width: 1200, height: 800 },
      localPoint: { x: 100, y: 100 },
    }
  );
  assert.equal(zeroEffectiveAuth.sameWindowProven, false);
  assert.equal(zeroEffectiveAuth.authorized, false);

  regP1.recordMeta(
    "com.lemon.lvpro",
    { pid: process.pid, windowId: 41, peerInstanceId: "gen-1" },
    { fromActionPeer: true, includeAx: true, includeScreenshot: true, actionDims: { width: 1200, height: 800 } }
  );
  regP1.recordMeta(
    "com.apple.finder",
    { pid: process.pid + 1, windowId: 77, peerInstanceId: null },
    { fromActionPeer: true, includeAx: true, includeScreenshot: true, actionDims: { width: 800, height: 600 } }
  );
  regP1.invalidateActionScreenshots("gen-1");
  assert.equal(regP1.getMeta("com.lemon.lvpro").actionScreenshotMeta, null);
  assert.equal(
    regP1.getMeta("com.apple.finder").actionScreenshotMeta?.windowId,
    77,
    "invalidateActionScreenshots('gen-1') must NOT wipe entries with peerInstanceId: null"
  );

  // Text-only get_app_state (includeScreenshot: true, actionDims: null) clears prior screenshot proof
  regP1.recordMeta(
    "com.apple.finder",
    { pid: process.pid + 1, windowId: null },
    { fromActionPeer: true, includeAx: true, includeScreenshot: true, actionDims: null }
  );
  assert.equal(regP1.getMeta("com.apple.finder").actionHasScreenshot, false);
  assert.equal(regP1.getMeta("com.apple.finder").actionScreenshotMeta, null);

  // 2) P1 #2 + P2 #3: Regular pixel click fails closed on unproven shot & multi-win app_post;
  //    pinned act passes allowAppPostFallback=false; pinned executeActScroll skips ax_scrollbar & app_post; center-only offscreen fails fast.
  const recordedWrites = [];
  const guardRoutes = new FocusPolicyGuard();
  const regRoutes = new AppSnapshotRegistry();
  regRoutes.recordMeta(
    "com.example.review",
    { pid: process.pid, windowId: null },
    { fromActionPeer: true, includeAx: true, includeScreenshot: true, actionDims: { width: 1200, height: 800 } }
  );
  let jxaPerms = false;
  const routeExec = new BackgroundActionExecutor({
    registry: regRoutes,
    focusPolicyGuard: guardRoutes,
    axBridge: {
      enabled: true,
      async checkPermissions() {
        return { accessibility: jxaPerms };
      },
    },
    actionPeer: {
      agentInstanceId: "peer-1",
      async callTool(name, args) {
        recordedWrites.push({ route: `peer:${name}`, args });
        return { isError: false, content: [{ type: "text", text: "ok" }] };
      },
    },
    windowClickFn: async (_pid, opts) => {
      recordedWrites.push({ route: "window_post", allowAppPostFallback: opts.allowAppPostFallback, wid: opts.wid });
      return { delivered: true, method: "window_post", wid: opts.wid };
    },
    windowScrollFn: async (_pid, opts) => {
      recordedWrites.push({ route: "window_post_scroll", allowAppPostFallback: opts.allowAppPostFallback, wid: opts.wid });
      return { delivered: true, method: "window_post_scroll", wid: opts.wid };
    },
    axScrollFallbackFn: async () => {
      recordedWrites.push({ route: "ax_scrollbar" });
      return { delivered: true, verified: true };
    },
  });

  const unprovPixelClick = await routeExec.dispatch({
    name: "click",
    app: "com.example.review",
    cleanArgs: { app: "com.example.review", x: 100, y: 100 },
    parsedRef: { ok: true, hasElementRef: false },
  });
  assert.equal(unprovPixelClick.result.isError, true);
  assert.equal(unprovPixelClick.result.deliveryState, "not_sent");
  assert.equal(unprovPixelClick.result.fatal, true);
  assert.equal(unprovPixelClick.result.reason, "unproven_same_window");
  assert.equal(recordedWrites.length, 0);

  // Proven windowId: 41 with windowCount: 2 -> sky_click blocked + app_post must be refused (unproven_single_window)
  regRoutes.recordMeta(
    "com.example.review",
    {
      pid: process.pid,
      windowId: 41,
      windowCount: 2,
      singleWindowProven: false,
      peerInstanceId: "peer-1",
    },
    { fromActionPeer: true, includeAx: true, includeScreenshot: true, actionDims: { width: 1200, height: 800 } }
  );
  guardRoutes.recordSteal("com.example.review", "click:sky_click", {
    routeScope: { pid: process.pid, windowId: 41 },
  });
  const multiWinAppPost = await routeExec.dispatch({
    name: "click",
    app: "com.example.review",
    cleanArgs: { app: "com.example.review", x: 100, y: 100 },
    parsedRef: { ok: true, hasElementRef: false },
  });
  assert.equal(multiWinAppPost.result.isError, true);
  assert.equal(multiWinAppPost.result.reason, "unproven_single_window");
  assert.equal(recordedWrites.length, 0);

  jxaPerms = true;
  recordedWrites.length = 0;
  const pinMeta = {
    pid: process.pid,
    windowId: 41,
    windowBounds: { x: 0, y: 0, w: 1200, h: 800 },
    actionScreenshotMeta: regRoutes.getMeta("com.example.review").actionScreenshotMeta,
  };
  await routeExec.executeActClick({
    app: "com.example.review",
    pid: process.pid,
    meta: pinMeta,
    match: { index: 12, bounds: { x: 10, y: 10, w: 30, h: 20 } },
    explicitWindowId: 41,
    targetWindowId: 41,
  });
  assert.equal(recordedWrites[0]?.route, "window_post");
  assert.equal(recordedWrites[0]?.allowAppPostFallback, false, "Pinned act without single-window proof must pass allowAppPostFallback: false");

  recordedWrites.length = 0;
  await routeExec.executeActScroll({
    app: "com.example.review",
    pid: process.pid,
    meta: { pid: process.pid, windowId: 42, windowBounds: { x: 0, y: 0, w: 1200, h: 800 } },
    windowId: 42,
  });
  assert.equal(recordedWrites.some((w) => w.route === "ax_scrollbar"), false, "Pinned scroll must skip widless ax_scrollbar");
  assert.equal(recordedWrites[0]?.route, "window_post_scroll");
  assert.equal(recordedWrites[0]?.allowAppPostFallback, false, "Pinned scroll without single-window proof must forbid app_post fallback");

  // P2 #3: Center-only offscreen target (10, 900) in 1200x800 fails fast with 0 writes
  recordedWrites.length = 0;
  const centerOffscreen = await routeExec.executeActClick({
    app: "com.example.review",
    pid: process.pid,
    meta: pinMeta,
    match: { index: 12 },
    targetWindowId: 41,
    resolvedTarget: {
      wid: 41,
      windowBounds: { x: 0, y: 0, w: 1200, h: 800 },
      centerLocalPoint: { x: 10, y: 900 },
    },
  });
  assert.equal(centerOffscreen.delivered, false);
  assert.equal(centerOffscreen.clicksSent, 0);
  assert.equal(centerOffscreen.failureReason, "target_offscreen");
  assert.equal(recordedWrites.length, 0);

  // 3) P1 #3: executeActScroll sent_unknown blocks native scroll & AtomicActExecutor reveal loop terminates immediately
  let nativeScrollCalls = 0;
  const scrollUnkExec = new BackgroundActionExecutor({
    registry: regRoutes,
    focusPolicyGuard: new FocusPolicyGuard(),
    axBridge: { enabled: true, async checkPermissions() { return { accessibility: true }; } },
    actionPeer: {
      async callTool(name) {
        if (name === "scroll") nativeScrollCalls += 1;
        return { isError: false, content: [{ type: "text", text: "ok" }] };
      },
    },
    windowScrollFn: async () => ({
      delivered: false,
      deliveryState: "sent_unknown",
      method: "window_post_scroll",
      reason: "partial_scroll_post",
    }),
  });
  const scrollUnkOut = await scrollUnkExec.executeActScroll({
    app: "com.example.review",
    pid: process.pid,
    meta: { pid: process.pid, windowBounds: { x: 0, y: 0, w: 1200, h: 800 } },
  });
  assert.equal(scrollUnkOut.delivered, false);
  assert.equal(scrollUnkOut.outcomeUnknown, true);
  assert.equal(scrollUnkOut.deliveryState, "sent_unknown");
  assert.equal(nativeScrollCalls, 0, "sent_unknown window scroll must NEVER fall through to native scroll");

  for (const scrollMode of ["sent_unknown", "failed"]) {
    let revealClicks = 0;
    let scrollAttempts = 0;
    const tc = new TakeoverController();
    const actOnly = new AtomicActExecutor({
      getActionPeer: () => ({
        agentInstanceId: "p1",
        async callTool(name) {
          if (name === "query") return { isError: false, content: [{ type: "text", text: JSON.stringify({ window_id: 41, matches: [] }) }] };
          if (name === "get_app_state") return { isError: false, content: [{ type: "text", text: "App=com.example.review (pid 1)\nWindow: \"W\", App: Review." }] };
          return { isError: false, content: [{ type: "text", text: "ok" }] };
        },
      }),
      registry: new AppSnapshotRegistry(),
      takeoverController: tc,
      checkAppRunning: async () => ({ running: true }),
      getRunningAppIdentityFn: async () => ({ pid: process.pid, bundleId: "com.example.review", processToken: "1:1" }),
      safeGetAppState: async () => ({ isError: false, content: [{ type: "text", text: "App=com.example.review (pid 1)\nWindow: \"W\", App: Review." }] }),
      processQueryResult: (_app, res) => {
        const parsed = JSON.parse(res.content[0].text);
        return { parsed, merged: { windowBounds: { x: 0, y: 0, w: 1200, h: 800 }, snapshotId: "s1" } };
      },
      actionExecutor: {
        async executeActScroll() {
          scrollAttempts += 1;
          return scrollMode === "sent_unknown"
            ? { delivered: false, outcomeUnknown: true, deliveryState: "sent_unknown", route: "scroll:window_post_scroll" }
            : { delivered: false, route: null, reason: "scroll_unavailable" };
        },
        async executeActClick() {
          revealClicks += 1;
          return { delivered: true, clicksSent: 1, aborted: false };
        },
      },
    });
    const actScrollStop = await actOnly.execute({
      app: "com.example.review",
      target: { text: "MissingTarget" },
      reveal: { direction: "down", max_scroll_steps: 3 },
      expect: { any_text: ["AfterClick"] },
    });
    assert.equal(actScrollStop.isError, true);
    assert.equal(scrollAttempts, 1, `Reveal loop must stop on first ${scrollMode} scroll`);
    assert.equal(revealClicks, 0);
    assert.match(
      actScrollStop.content[0].text,
      scrollMode === "sent_unknown" ? /WRITE_OUTCOME_UNKNOWN/ : /SCROLL_FAILED/
    );
  }

  // 4) P1 #4: expect with wantWid === 0 & vanishTerms (no ReferenceError), text-only sibling rejection, & dispatchWindowId binding
  const regExp = new AppSnapshotRegistry();
  regExp.recordMeta(
    "com.lemon.lvpro",
    { pid: process.pid, windowId: 41, peerInstanceId: "p1" },
    { fromActionPeer: true, includeAx: true, includeScreenshot: true, actionDims: { width: 1200, height: 800 } }
  );
  let expScenario = "vanish_no_wid";
  const expExec = new AtomicActExecutor({
    getActionPeer: () => ({
      agentInstanceId: "p1",
      async callTool(name, args) {
        if (name === "query") {
          if (args.text === "targetBtn") {
            return {
              isError: false,
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    window_id: null,
                    matches: [{ index: 1, role: "AXButton", title: "targetBtn", bounds: { x: 10, y: 10, w: 40, h: 20 } }],
                  }),
                },
              ],
            };
          }
          return { isError: false, content: [{ type: "text", text: JSON.stringify({ window_id: 99, matches: [] }) }] };
        }
        return { isError: false, content: [{ type: "text", text: "ok" }] };
      },
    }),
    getAxBridge: () => ({
      enabled: true,
      async resolveActionTarget() {
        return {
          resolved: true,
          wid: expScenario === "sibling_text_only" ? 41 : null,
          windowBounds: { x: 0, y: 0, w: 1200, h: 800 },
          centerLocalPoint: { x: 30, y: 20 },
        };
      },
    }),
    registry: regExp,
    takeoverController: new TakeoverController(),
    checkAppRunning: async () => ({ running: true }),
    getRunningAppIdentityFn: async () => ({ pid: process.pid, bundleId: "com.lemon.lvpro", processToken: "1:1" }),
    safeGetAppState: async () => {
      if (expScenario === "vanish_no_wid") {
        // Trigger fast deadline expiry or error before stateRead
        return { isError: true, content: [{ type: "text", text: "state_failed" }] };
      }
      // Sibling text-only response claiming "编辑器" & "DoneFromSibling" with no image!
      regExp.recordMeta(
        "com.lemon.lvpro",
        { pid: process.pid, windowTitle: "编辑器", peerInstanceId: "p1" },
        { fromActionPeer: true, includeAx: true, includeScreenshot: true, actionDims: null, source: "snapshot" }
      );
      return {
        isError: false,
        content: [
          {
            type: "text",
            text: `App=com.lemon.lvpro (pid ${process.pid})\nWindow: "编辑器", App: 剪映专业版.\n\t1 静态文本 DoneFromSibling`,
          },
        ],
      };
    },
    processQueryResult: (_app, res) => {
      const parsed = JSON.parse(res.content[0].text);
      return {
        parsed,
        merged: {
          windowId: null,
          windowBounds: { x: 0, y: 0, w: 1200, h: 800 },
          snapshotId: "s1",
          snapshot: { elements: new Map([["1", { origin: "ax" }]]) },
        },
      };
    },
    actionExecutor: {
      async executeActClick() {
        return {
          delivered: true,
          clicksSent: 1,
          aborted: false,
          routeKey: "click:window_post",
          routeScope: { pid: process.pid, windowId: expScenario === "sibling_text_only" ? 41 : null },
          localPoint: { x: 30, y: 20 },
        };
      },
    },
  });

  expScenario = "vanish_no_wid";
  const vanishNoWidRes = await expExec.execute({
    app: "com.lemon.lvpro",
    target: { text: "targetBtn" },
    reveal: { max_scroll_steps: 0 },
    expect: { text_disappears: ["ModalMarker"] },
    timeout_ms: 80,
  });
  assert.equal(vanishNoWidRes.isError, true);
  assert.match(vanishNoWidRes.content[0].text, /POSTCONDITION_FAILED/);

  expScenario = "sibling_text_only";
  const siblingSpoofRes = await expExec.execute({
    app: "com.lemon.lvpro",
    target: { text: "targetBtn" },
    reveal: { max_scroll_steps: 0 },
    expect: { any_text: ["DoneFromSibling"], window_title_contains: "编辑器" },
    timeout_ms: 80,
  });
  assert.equal(siblingSpoofRes.isError, true, "Text-only sibling response must NEVER inherit screenshot proof or spoof expect");
  assert.match(siblingSpoofRes.content[0].text, /POSTCONDITION_FAILED/);

  // 5) P1 #5: headless-engine rethrows WRITE_OUTCOME_UNKNOWN; type_text axRes sent_unknown blocks sky_key; set_value post-BackSpace -> sent_unknown
  await assert.rejects(
    () =>
      tryHeadlessSelectedTextInsert(process.pid, "hello", {
        axBridge: {
          async insertSelectedText() {
            const err = new Error("ax text outcome unknown");
            err.code = "WRITE_OUTCOME_UNKNOWN";
            err.deliveryState = "sent_unknown";
            throw err;
          },
        },
      }),
    (err) => err?.code === "WRITE_OUTCOME_UNKNOWN" && err?.deliveryState === "sent_unknown"
  );
  await assert.rejects(
    () =>
      tryHeadlessBackgroundScroll(process.pid, null, "down", 1, {
        axBridge: {
          async scroll() {
            const err = new Error("ax scroll outcome unknown");
            err.code = "WRITE_OUTCOME_UNKNOWN";
            err.deliveryState = "sent_unknown";
            throw err;
          },
        },
      }),
    (err) => err?.code === "WRITE_OUTCOME_UNKNOWN" && err?.deliveryState === "sent_unknown"
  );

  let fallbackKeyCalls = 0;
  let keySeq = 0;
  const regTextVal = new AppSnapshotRegistry();
  regTextVal.recordMeta(
    "com.apple.TextEdit",
    {
      pid: process.pid,
      windowId: 55,
      elements: new Map([["1", { index: "1", role: "AXTextField", rawText: "1 field", origin: "ax" }]]),
    },
    { fromActionPeer: true, includeAx: true, includeScreenshot: false }
  );
  const textValExec = new BackgroundActionExecutor({
    registry: regTextVal,
    focusPolicyGuard: new FocusPolicyGuard(),
    axBridge: { enabled: true, async checkPermissions() { return { accessibility: true }; } },
    actionPeer: {
      async callTool(name) {
        if (name === "type_text" || name === "press_key") fallbackKeyCalls += 1;
        return { isError: false, content: [{ type: "text", text: "ok" }] };
      },
    },
    selectedTextInsertFn: async () => ({ delivered: false, deliveryState: "sent_unknown", reason: "ax_write_unknown" }),
    editableFocusFn: async () => ({ editable: true, singleLine: true }),
    windowKeyFn: async (_pid, key) => {
      keySeq += 1;
      if (key === "cmd+a" || key === "BackSpace") return { delivered: true };
      return { delivered: false, deliveryState: "not_sent", reason: "key_not_sent" };
    },
    windowTextFn: async () => ({ delivered: false, deliveryState: "not_sent", reason: "window_text_not_sent" }),
  });

  const typeUnkRes = await textValExec.dispatch({
    name: "type_text",
    app: "com.apple.TextEdit",
    cleanArgs: { app: "com.apple.TextEdit", text: "中文内容" },
  });
  assert.equal(typeUnkRes.result.isError, true);
  assert.equal(typeUnkRes.result.deliveryState, "sent_unknown");
  assert.equal(typeUnkRes.result.fatal, true);
  assert.equal(fallbackKeyCalls, 0, "type_text sent_unknown on ax_selected_text must NEVER fall through to sky_key");

  textValExec.focusPolicyGuard.recordSteal("com.apple.TextEdit", "set_value:native");
  textValExec.focusPolicyGuard.recordSteal("com.apple.TextEdit", "press_key:sky_key");
  textValExec.focusPolicyGuard.recordSteal("com.apple.TextEdit", "type_text:sky_key");
  const setValAfterClear = await textValExec.dispatch({
    name: "set_value",
    app: "com.apple.TextEdit",
    cleanArgs: { app: "com.apple.TextEdit", element_index: "1", value: "abc" },
    parsedRef: { ok: true, hasElementRef: true, rawIndex: "1" },
  });
  assert.equal(setValAfterClear.result.isError, true);
  assert.equal(
    setValAfterClear.result.deliveryState,
    "sent_unknown",
    "set_value failure after BackSpace clearing must report deliveryState: sent_unknown, not child not_sent"
  );
  assert.equal(setValAfterClear.result.fatal, true);
  assert.ok(keySeq >= 2);

  // 6) P2 #1 & P2 #2 + Spec JXA edge cases:
  //    a) NativeComputerUsePeer teardown stamps WRITE_OUTCOME_UNKNOWN / sent_unknown on pending mutating entries
  const mockChild = new EventEmitter();
  mockChild.stdin = new Writable({
    write(chunk, _enc, cb) {
      for (const line of String(chunk).split("\n").filter(Boolean)) {
        try {
          const msg = JSON.parse(line);
          if (msg.method === "initialize") {
            mockChild.stdout.emit(
              "data",
              `${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { capabilities: {} } })}\n`
            );
          } else if (msg.method === "tools/call") {
            queueMicrotask(() => mockChild.emit("exit", 1, null));
          }
        } catch {}
      }
      cb();
    },
  });
  mockChild.stdout = new EventEmitter();
  mockChild.stdout.setEncoding = () => {};
  mockChild.stderr = new EventEmitter();
  mockChild.stderr.setEncoding = () => {};
  mockChild.kill = () => {};
  mockChild.killed = false;
  mockChild.exitCode = null;
  const tearPeer = new NativeComputerUsePeer({
    name: "tear-test",
    spawnFn: () => mockChild,
    agentReapFn: async () => ({ reaped: true }),
  });
  const mutP = tearPeer.callTool("click", { app: "com.lemon.lvpro", element_index: "1" }, 5000);
  await assert.rejects(
    () => mutP,
    (err) => err?.code === "WRITE_OUTCOME_UNKNOWN" && err?.deliveryState === "sent_unknown" && err?.dispatched === true
  );
  tearPeer.close();

  //    b) #buildOperationAbortedResult preserves deliveryState & fatal at broker caller boundary (both click and act)
  const errPeer = {
    async listTools() {
      return { tools: [{ name: "list_apps" }, { name: "get_app_state" }, { name: "query" }, { name: "click" }] };
    },
    async callTool(name) {
      if (name === "list_apps") return { isError: false, content: [{ type: "text", text: "剪映专业版 — com.lemon.lvpro [running]" }] };
      if (name === "get_app_state") {
        return {
          isError: false,
          content: [
            { type: "text", text: `App=com.lemon.lvpro (pid ${process.pid})\nWindow: "剪映专业版", App: 剪映专业版.\n\t1 按钮 导出` },
          ],
        };
      }
      if (name === "query") {
        return {
          isError: false,
          content: [
            { type: "text", text: JSON.stringify({ window_id: 4784, matches: [{ index: 1, role: "AXButton", title: "导出", bounds: { x: 10, y: 10, w: 50, h: 20 } }] }) },
          ],
        };
      }
      return { isError: false, content: [{ type: "text", text: "ok" }] };
    },
    close() {},
  };
  const errBroker = new ComputerUseBrokerServer({
    webPort: 0,
    socketPath: path.join(tmpdir(), `cua-err-${process.pid}.sock`),
    infoPath: null,
    actionPeer: errPeer,
    streamPeer: errPeer,
    axBridge: {
      enabled: true,
      async checkPermissions() { return { accessibility: true, screenRecording: true }; },
      async findRunningApp() { return { alive: true, pid: process.pid, bundleId: "com.lemon.lvpro", processToken: `${process.pid}:1` }; },
      async getProcessInfo(pid) { return { alive: true, guiApp: true, pid, bundleId: "com.lemon.lvpro", processToken: `${pid}:1` }; },
      async ensureManualAccessibility() { return { supported: true, changed: false, enabled: true, definitive: true }; },
      async verifyLiveRef() { return { ok: true }; },
      async resolveActionTarget() { return { resolved: true, wid: 4784, windowBounds: { x: 0, y: 0, w: 1200, h: 800 }, centerLocalPoint: { x: 35, y: 20 } }; },
      async dropSnapshots() { return { ok: true }; },
      async close() {},
    },
    focusController: {
      async getFrontmostApp() { return { pid: 100, bundleId: "com.google.antigravity" }; },
      async restoreFrontmostApp() { return true; },
      sweepDelaysMs: [],
    },
    windowClickFn: async () => {
      const e = new Error("persistent partial click post");
      e.code = "WRITE_OUTCOME_UNKNOWN";
      e.deliveryState = "sent_unknown";
      throw e;
    },
  });
  await errBroker.start();
  try {
    await errBroker.executeToolCall("get_app_state", { app: "com.lemon.lvpro" }, { source: "ai" });
    const abortedClickBoundary = await errBroker.executeToolCall(
      "click",
      { app: "com.lemon.lvpro", element_index: "1", click_method: "window_post" },
      { source: "ai" }
    );
    assert.equal(abortedClickBoundary.isError, true);
    assert.equal(abortedClickBoundary.deliveryState, "sent_unknown");
    assert.equal(abortedClickBoundary.fatal, true);

    const abortedActBoundary = await errBroker.executeToolCall(
      "act",
      {
        app: "com.lemon.lvpro",
        target: { text: "导出", exact: true },
        reveal: { max_scroll_steps: 0 },
        expect: { any_text: ["完成"] },
        timeout_ms: 400,
      },
      { source: "ai" }
    );
    assert.equal(abortedActBoundary.isError, true);
    assert.equal(abortedActBoundary.deliveryState, "sent_unknown");
    assert.equal(abortedActBoundary.fatal, true);
  } finally {
    await errBroker.close();
  }

  //    c) P2 #2: #captureProtectedFrontmost starting during observation phase and finishing after exitObservationPhase must NOT penalize
  let frontSampleCount = 0;
  let releasePreObsFront;
  const preObsGate = new Promise((r) => {
    releasePreObsFront = r;
  });
  let obsRestores = 0;
  let obsFront = { pid: 100, bundleId: "com.google.antigravity" };
  const obsFenceGuard = new FocusPolicyGuard({
    resolveTargetInfo: () => ({ pid: process.pid, bundleId: "com.lemon.lvpro", appDisplayName: "剪映专业版" }),
    focusController: {
      async getFrontmostApp() {
        frontSampleCount += 1;
        if (frontSampleCount === 2) await preObsGate;
        return obsFront;
      },
      async restoreFrontmostApp() {
        obsRestores += 1;
        obsFront = { pid: 100, bundleId: "com.google.antigravity" };
        return true;
      },
      sweepDelaysMs: [500],
    },
  });
  const obsScope = await obsFenceGuard.beginGuard("com.lemon.lvpro", {
    routeScope: { pid: process.pid, windowId: 4784 },
  });
  obsScope.finish("click:sky_click", {
    alreadyRecorded: false,
    routeScope: { pid: process.pid, windowId: 4784 },
  });
  obsFront = { pid: process.pid, bundleId: "com.lemon.lvpro" };
  obsScope.enterObservationPhase();
  const beginGuardDuringObsP = obsFenceGuard.beginGuard("com.lemon.lvpro", {
    routeScope: { pid: process.pid, windowId: 4784 },
  });
  await new Promise((r) => setTimeout(r, 10));
  obsScope.exitObservationPhase();
  releasePreObsFront();
  await beginGuardDuringObsP;
  assert.ok(obsRestores >= 1);
  assert.equal(
    obsFenceGuard.isMethodBlocked(["com.lemon.lvpro"], "click", "sky_click", {
      routeScope: { pid: process.pid, windowId: 4784 },
    }),
    false,
    "Sample started during observation phase and finished after exit must NOT blacklist click:sky_click"
  );
  obsFenceGuard.close();

  //    d) Spec (c) JXA edge cases: handleWindowScroll try/catch (sent_unknown vs not_sent), handleWindowClick !anyPosted -> not_sent,
  //       handleWindowText untrusted on empty string
  const hScrollThrowAfterOne = createJxaHarness({
    axTrusted: true,
    scrollEventAllocFn: (u, c, dy, dx) => {
      if (hScrollThrowAfterOne._calls === undefined) hScrollThrowAfterOne._calls = 0;
      hScrollThrowAfterOne._calls += 1;
      if (hScrollThrowAfterOne._calls >= 2) throw new Error("wheel_alloc_boom");
      return { kind: "wheel", u, c, dy, dx };
    },
  });
  const scrollThrowPartial = hScrollThrowAfterOne.sandbox.handleWindowScroll({
    pid: 63251,
    wid: 4784,
    localPoint: { x: 500, y: 400 },
    direction: "down",
    steps: 3,
  });
  assert.equal(scrollThrowPartial.delivered, false);
  assert.equal(scrollThrowPartial.deliveryState, "sent_unknown");
  assert.equal(scrollThrowPartial.reason, "scroll_post_exception");

  const hClickThrowPrePost = createJxaHarness({ axTrusted: true });
  hClickThrowPrePost.sandbox.$.CGEventCreateMouseEvent = () => {
    throw new Error("mouse_alloc_boom");
  };
  const clickThrowPrePost = hClickThrowPrePost.sandbox.handleWindowClick({
    pid: 63251,
    wid: 4784,
    localPoint: { x: 500, y: 400 },
  });
  assert.equal(clickThrowPrePost.delivered, false);
  assert.equal(clickThrowPrePost.deliveryState, "not_sent");
  assert.equal(clickThrowPrePost.reason, "click_post_exception");

  const hUntrustedEmptyText = createJxaHarness({ axTrusted: false });
  const emptyUntrustedText = hUntrustedEmptyText.sandbox.handleWindowText({
    pid: 63251,
    wid: 4784,
    text: "",
  });
  assert.equal(emptyUntrustedText.delivered, false);
  assert.equal(emptyUntrustedText.deliveryState, "not_sent");
  assert.equal(emptyUntrustedText.reason, "jxa_accessibility_untrusted");

  // 7) Round 5 Spec & Standards Closure Regressions:
  //    a) tryHeadlessContextMenu rethrows WRITE_OUTCOME_UNKNOWN; dispatch contextMenu & axScroll propagate non-thrown sent_unknown
  await assert.rejects(
    () =>
      tryHeadlessContextMenu(
        process.pid,
        { index: "1", identifier: "id1" },
        {
          axBridge: {
            async triggerContextMenu() {
              const err = new Error("menu outcome unknown");
              err.code = "WRITE_OUTCOME_UNKNOWN";
              err.deliveryState = "sent_unknown";
              throw err;
            },
          },
        }
      ),
    (err) => err?.code === "WRITE_OUTCOME_UNKNOWN" && err?.deliveryState === "sent_unknown"
  );

  const axFbExec = new BackgroundActionExecutor({
    registry: regTextVal,
    focusPolicyGuard: new FocusPolicyGuard(),
    axBridge: { enabled: true, async checkPermissions() { return { accessibility: false }; } },
    actionPeer: { async callTool() { return { isError: true, content: [{ type: "text", text: "failed" }] }; } },
    contextMenuFallbackFn: async () => ({ delivered: false, deliveryState: "sent_unknown", reason: "menu_unknown" }),
    axScrollFallbackFn: async () => ({ delivered: false, deliveryState: "sent_unknown", reason: "scroll_unknown" }),
  });
  const menuUnkRes = await axFbExec.dispatch({
    name: "click",
    app: "com.apple.TextEdit",
    cleanArgs: { app: "com.apple.TextEdit", element_index: "1", mouse_button: "right" },
    parsedRef: { ok: true, hasElementRef: true, rawIndex: "1" },
  });
  assert.equal(menuUnkRes.actionRouteKey, "click:ax_show_menu");
  assert.equal(menuUnkRes.result.deliveryState, "sent_unknown");
  assert.equal(menuUnkRes.result.fatal, true);

  const scrollFbUnkRes = await axFbExec.dispatch({
    name: "scroll",
    app: "com.apple.TextEdit",
    cleanArgs: { app: "com.apple.TextEdit", element_index: "1", direction: "down", pages: 1 },
    parsedRef: { ok: true, hasElementRef: true, rawIndex: "1" },
  });
  assert.equal(scrollFbUnkRes.actionRouteKey, "scroll:ax_scrollbar");
  assert.equal(scrollFbUnkRes.result.deliveryState, "sent_unknown");
  assert.equal(scrollFbUnkRes.result.fatal, true);

  //    b) executeActClick + AtomicActExecutor preserve sent_unknown / fatal on non-thrown partial returns
  const clickUnkActExec = new BackgroundActionExecutor({
    registry: regRoutes,
    focusPolicyGuard: new FocusPolicyGuard(),
    axBridge: { enabled: true, async checkPermissions() { return { accessibility: true }; } },
    actionPeer: { async callTool() { return { isError: false, content: [{ type: "text", text: "ok" }] }; } },
    windowClickFn: async () => ({ delivered: false, deliveryState: "sent_unknown", reason: "partial_win_click" }),
  });
  const nonThrownClickUnk = await clickUnkActExec.executeActClick({
    app: "com.example.review",
    pid: process.pid,
    meta: pinMeta,
    match: { index: 12, bounds: { x: 10, y: 10, w: 30, h: 20 } },
    explicitWindowId: 41,
    targetWindowId: 41,
  });
  assert.equal(nonThrownClickUnk.deliveryState, "sent_unknown");
  assert.equal(nonThrownClickUnk.fatal, true);

  const nonThrownActOnly = new AtomicActExecutor({
    getActionPeer: () => ({
      agentInstanceId: "p1",
      async callTool(name) {
        if (name === "query") {
          return {
            isError: false,
            content: [{ type: "text", text: JSON.stringify({ window_id: 41, matches: [{ index: 1, role: "AXButton", title: "Go", bounds: { x: 10, y: 10, w: 30, h: 20 } }] }) }],
          };
        }
        return { isError: false, content: [{ type: "text", text: "ok" }] };
      },
    }),
    registry: regRoutes,
    takeoverController: new TakeoverController(),
    checkAppRunning: async () => ({ running: true }),
    getRunningAppIdentityFn: async () => ({ pid: process.pid, bundleId: "com.example.review", processToken: "1:1" }),
    safeGetAppState: async () => ({ isError: false, content: [{ type: "text", text: "App=com.example.review (pid 1)\nWindow: \"W\", App: Review." }] }),
    processQueryResult: (_app, res) => ({
      parsed: JSON.parse(res.content[0].text),
      merged: { windowId: 41, windowBounds: { x: 0, y: 0, w: 1200, h: 800 }, snapshotId: "s1", snapshot: { elements: new Map([["1", { origin: "ax" }]]) } },
    }),
    actionExecutor: {
      executeActClick: async () => nonThrownClickUnk,
    },
  });
  const actPartialOut = await nonThrownActOnly.execute({
    app: "com.example.review",
    window_id: 41,
    target: { text: "Go" },
    reveal: { max_scroll_steps: 0 },
    expect: { any_text: ["Done"] },
  });
  assert.equal(actPartialOut.isError, true);
  assert.equal(actPartialOut.deliveryState, "sent_unknown");
  assert.equal(actPartialOut.fatal, true);
  assert.match(actPartialOut.content[0].text, /WRITE_OUTCOME_UNKNOWN/);

  //    c) dispatchBackgroundPointClickDetailed must NOT fall back to PID app_post on window_resized
  const ptNoFallbackRes = await dispatchBackgroundPointClickDetailed(process.pid, 200, 200, {
    wid: 41,
    allowAppPostFallback: true,
    axBridge: {
      async postWindowClick() {
        return { delivered: false, deliveryState: "not_sent", method: "window_post", reason: "window_resized" };
      },
    },
  });
  assert.equal(ptNoFallbackRes.delivered, false);
  assert.equal(ptNoFallbackRes.deliveryState, "not_sent");
  assert.equal(ptNoFallbackRes.reason, "window_resized");

  //    d) Preview ocu_pixel marks readOnly when !jxaTrusted and screenshot windowIdProven === false
  const jpg1280Unprov = Buffer.from([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x02, 0xc1, 0x05, 0x00, 0x01, 0x01, 0x11, 0x00, 0xff, 0xd9,
  ]).toString("base64");
  const previewUnprovPeer = {
    async listTools() { return { tools: [{ name: "list_apps" }, { name: "get_app_state" }] }; },
    async callTool(name) {
      if (name === "list_apps") return { isError: false, content: [{ type: "text", text: "Unprov — com.example.Unprov [running]" }] };
      return {
        isError: false,
        content: [
          { type: "text", text: `App=com.example.Unprov (pid ${process.pid})\nWindow: "Unprov", App: Unprov.` },
          { type: "image", mimeType: "image/jpeg", data: jpg1280Unprov },
        ],
      };
    },
    close() {},
  };
  const previewUnprovBroker = new ComputerUseBrokerServer({
    webPort: 0,
    uiToken: "prev-unprov",
    socketPath: path.join(tmpdir(), `cua-prev-unprov-${process.pid}.sock`),
    infoPath: null,
    actionPeer: previewUnprovPeer,
    streamPeer: previewUnprovPeer,
    permissionsFn: async () => ({ platform: "darwin", accessibility: false, screenRecording: true }),
    runningAppIdentityFn: async () => ({ pid: process.pid, bundleId: "com.example.Unprov", processToken: `${process.pid}:1` }),
  });
  await previewUnprovBroker.start();
  try {
    await previewUnprovBroker.executeToolCall("get_app_state", { app: "com.example.Unprov" }, { source: "ai" });
    const prevGeom = previewUnprovBroker.previewStreamManager.getActiveGeometry();
    assert.equal(prevGeom, null, "Unproven screenshot without proven bounds must NOT synthesize writable preview geometry");
    const blockedInteract = await fetch(`http://127.0.0.1:${previewUnprovBroker.webPort}/api/interact`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Sidecar-Token": "prev-unprov" },
      body: JSON.stringify({ app: "com.example.Unprov", kind: "click", normX: 0.5, normY: 0.5 }),
    });
    const blockedJson = await blockedInteract.json();
    assert.equal(blockedJson.ok, false);
    assert.match(String(blockedJson.error || ""), /unproven_same_window|Same-Window Proof/i);
  } finally {
    await previewUnprovBroker.close();
  }

  //    e) Even with jxaTrusted=true, unproven shot with pid=0 / missing windowBounds must NOT enable ocu_pixel
  const jxaTrustedPid0Peer = {
    async listTools() { return { tools: [{ name: "list_apps" }, { name: "get_app_state" }] }; },
    async callTool(name) {
      if (name === "list_apps") return { isError: false, content: [{ type: "text", text: "NoPid — com.example.NoPid [running]" }] };
      return {
        isError: false,
        content: [
          { type: "text", text: 'Window: "NoPid", App: NoPid.' },
          { type: "image", mimeType: "image/jpeg", data: jpg1280Unprov },
        ],
      };
    },
    close() {},
  };
  const jxaTrustedPid0Broker = new ComputerUseBrokerServer({
    webPort: 0,
    uiToken: "jxa-pid0",
    socketPath: path.join(tmpdir(), `cua-jxa-pid0-${process.pid}.sock`),
    infoPath: null,
    actionPeer: jxaTrustedPid0Peer,
    streamPeer: jxaTrustedPid0Peer,
    axBridge: { enabled: true, async checkPermissions() { return { accessibility: true, screenRecording: true }; }, async close() {} },
    permissionsFn: async () => ({ platform: "darwin", accessibility: true, screenRecording: true }),
    runningAppIdentityFn: async () => null,
  });
  await jxaTrustedPid0Broker.start();
  try {
    await jxaTrustedPid0Broker.executeToolCall("get_app_state", { app: "com.example.NoPid" }, { source: "ai" });
    assert.equal(
      jxaTrustedPid0Broker.previewStreamManager.getActiveGeometry(),
      null,
      "Unproven shot under jxaTrusted=true and missing bounds/pid must NOT enable ocu_pixel"
    );
  } finally {
    await jxaTrustedPid0Broker.close();
  }
});

test("Slice 8: Comprehensive security, Qt 45pt WID, sent_unknown, and cross-scope observation regressions", async () => {
  // 1) AppSnapshotRegistry replacement-window proof & immutable invalidateActionScreenshots
  const reg8 = new AppSnapshotRegistry();
  reg8.recordMeta(
    "com.lemon.lvpro",
    {
      pid: process.pid,
      windowId: 41,
      windowTitle: "Main",
      windowBounds: { x: 0, y: 0, w: 1200, h: 800 },
      windowCount: 1,
      singleWindowProven: true,
    },
    {
      fromActionPeer: true,
      includeAx: true,
      includeScreenshot: true,
      actionDims: { width: 1200, height: 800 },
      imageDigest: "digest-initial",
    }
  );
  const metaSnapBefore = reg8.getMeta("com.lemon.lvpro");
  assert.equal(metaSnapBefore.lastImageDigest, "digest-initial");

  const replacementProof = await reg8.proveScreenshotWindowObservation("com.lemon.lvpro", {
    pid: process.pid,
    imgDims: { width: 1200, height: 800 },
    windowTitle: "Main",
    parsedWindowId: null,
    preObs: { wid: 41, windowBounds: { x: 0, y: 0, w: 1200, h: 800 }, title: "Main", windowIds: [41] },
    desktopHelperClient: {
      available: true,
      async getFocusedWindow() {
        return {
          wid: 55,
          title: "Main",
          windowBounds: { x: 0, y: 0, width: 1200, height: 800 },
          windowIds: [55],
        };
      },
    },
  });
  assert.equal(replacementProof.proven, false, "Same-title replacement window (41 -> 55) must not prove Same-Window Proof");

  const multiObsProof = await reg8.proveScreenshotWindowObservation("com.lemon.lvpro", {
    pid: process.pid,
    imgDims: { width: 1200, height: 800 },
    windowTitle: "Main",
    parsedWindowId: 41,
    preObs: { wid: 41, windowBounds: { x: 0, y: 0, w: 1200, h: 800 }, title: "Main", windowIds: [41, 42] },
    desktopHelperClient: {
      available: true,
      async getFocusedWindow() {
        return {
          wid: 41,
          title: "Main",
          windowBounds: { x: 0, y: 0, width: 1200, height: 800 },
          windowIds: [41],
        };
      },
    },
  });
  assert.equal(multiObsProof.singleWindowProven, false, "preObs multi-window must suppress singleWindowProven");

  reg8.invalidateActionScreenshots();
  const metaAfterInv = reg8.getMeta("com.lemon.lvpro");
  assert.equal(metaAfterInv.actionScreenshotMeta, null);
  assert.equal(metaAfterInv.lastImageDigest, null);
  assert.equal(metaSnapBefore.lastImageDigest, "digest-initial", "invalidateActionScreenshots must replace entries immutably");

  // 2) Post-prep ocu_pixel wid drift race returns 409 UNPROVEN_SAME_WINDOW without clicking, and ambiguous stream stays readOnly
  const jpg1200 = Buffer.from([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x03, 0x20, 0x04, 0xb0, 0x01, 0x01, 0x11, 0x00, 0xff, 0xd9,
  ]).toString("base64");
  let obsWid = 41;
  let flipOnNextState = false;
  let ocuPrepClickCalls = 0;
  const ocuRaceActionPeer = {
    async listTools() {
      return { tools: [{ name: "list_apps" }, { name: "get_app_state" }, { name: "click" }] };
    },
    async callTool(name) {
      if (name === "list_apps") {
        return { isError: false, content: [{ type: "text", text: "RaceApp — com.example.OcuRace [running]" }] };
      }
      if (name === "get_app_state") {
        if (flipOnNextState) {
          obsWid = 42;
        }
        return {
          isError: false,
          content: [
            { type: "text", text: `App=com.example.OcuRace (pid ${process.pid})\nWindow: "Win", App: RaceApp.` },
            { type: "image", mimeType: "image/jpeg", data: jpg1200 },
          ],
        };
      }
      if (name === "click") ocuPrepClickCalls += 1;
      return { isError: false, content: [{ type: "text", text: "ok" }] };
    },
    close() {},
  };
  const ocuRaceStreamPeer = {
    async listTools() {
      return { tools: [{ name: "list_apps" }, { name: "get_app_state" }] };
    },
    async callTool(name) {
      if (name === "list_apps") {
        return { isError: false, content: [{ type: "text", text: "RaceApp — com.example.OcuRace [running]" }] };
      }
      return {
        isError: false,
        content: [
          { type: "text", text: `App=com.example.OcuRace (pid ${process.pid})\nWindow: "Win", App: RaceApp.` },
          { type: "image", mimeType: "image/jpeg", data: jpg1200 },
        ],
      };
    },
    close() {},
  };
  const ocuRaceBroker = new ComputerUseBrokerServer({
    webPort: 0,
    uiToken: "ocu-race",
    socketPath: path.join(tmpdir(), `cua-ocu-race-${process.pid}.sock`),
    infoPath: null,
    actionPeer: ocuRaceActionPeer,
    streamPeer: ocuRaceStreamPeer,
    axBridge: {
      enabled: true,
      async checkPermissions() {
        return { accessibility: false, screenRecording: true };
      },
      async getFocusedWindowInfo() {
        return {
          wid: obsWid,
          title: "Win",
          windowBounds: { x: 0, y: 0, w: 1200, h: 800 },
          windowIds: [obsWid],
        };
      },
      async close() {},
    },
    desktopHelperClient: {
      available: true,
      async listWindows() {
        return [
          {
            pid: process.pid,
            wid: obsWid,
            title: "Win",
            bounds: { x: 0, y: 0, width: 1200, height: 800 },
            layer: 0,
            alpha: 1,
            onScreen: true,
          },
        ];
      },
      async getFocusedWindow() {
        return {
          wid: obsWid,
          title: "Win",
          windowBounds: { x: 0, y: 0, width: 1200, height: 800 },
          windowIds: [obsWid],
        };
      },
      async captureWindowJpeg() {
        return { ok: false, reason: "test_fallback_to_ocu" };
      },
    },
    permissionsFn: async () => ({ platform: "darwin", accessibility: false, screenRecording: true }),
    runningAppIdentityFn: async () => ({ pid: process.pid, bundleId: "com.example.OcuRace", processToken: `${process.pid}:1` }),
  });
  await ocuRaceBroker.start();
  try {
    const selRes = await fetch(`http://127.0.0.1:${ocuRaceBroker.webPort}/api/select-app`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Sidecar-Token": "ocu-race" },
      body: JSON.stringify({ app: "com.example.OcuRace" }),
    });
    assert.equal(selRes.status, 200);
    const activeBefore = ocuRaceBroker.previewStreamManager.getActiveGeometry();
    assert.equal(activeBefore?.deliveryRoute, "ocu_pixel");
    assert.equal(activeBefore?.windowId, 41);

    ocuRaceBroker.registry.invalidateActionScreenshots();
    flipOnNextState = true;
    const raceInteract = await fetch(`http://127.0.0.1:${ocuRaceBroker.webPort}/api/interact`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Sidecar-Token": "ocu-race" },
      body: JSON.stringify({ app: "com.example.OcuRace", kind: "click", normX: 0.5, normY: 0.5 }),
    });
    assert.equal(raceInteract.status, 409);
    const raceJson = await raceInteract.json();
    assert.equal(raceJson.code, "UNPROVEN_SAME_WINDOW");
    assert.equal(ocuPrepClickCalls, 0, "Post-prep ocu_pixel WID drift must abort before clicking");

    const ambigGeom = ocuRaceBroker.previewStreamManager.syncActiveGeometry({
      pid: process.pid,
      processToken: `${process.pid}:1`,
      windowId: 42,
      windowBoundsPt: { x: 0, y: 0, width: 1200, height: 800 },
      previewContentRectPt: { x: 0, y: 0, width: 1200, height: 800 },
      previewPixelSize: { width: 1200, height: 800 },
      jxaTrusted: true,
      singleWindowProven: false,
      readOnlyOverride: true,
      readOnlyReasonOverride: "ambiguous_multi_window_stream",
      selectAsActive: true,
    });
    assert.equal(ambigGeom.readOnly, true);
    assert.equal(ambigGeom.readOnlyReason, "ambiguous_multi_window_stream");
    assert.equal(ambigGeom.allowAppPostFallback, false);
  } finally {
    await ocuRaceBroker.close();
  }

  // 3) Coord drag, ocu_pixel sky_click lock, and unpinned app_post gates in ActionExecutor
  const gateGuard = new FocusPolicyGuard();
  const gateReg = new AppSnapshotRegistry();
  let gatePeerCalls = [];
  let gateWinClickCalls = 0;
  const gateExec = new BackgroundActionExecutor({
    registry: gateReg,
    focusPolicyGuard: gateGuard,
    axBridge: { enabled: true, async checkPermissions() { return { accessibility: false }; } },
    actionPeer: {
      agentInstanceId: "gate-peer",
      async callTool(name, args) {
        gatePeerCalls.push({ name, args });
        return { isError: false, content: [{ type: "text", text: "ok" }] };
      },
    },
    windowClickFn: async () => {
      gateWinClickCalls += 1;
      return { delivered: true, method: "window_post" };
    },
  });
  gateReg.recordMeta(
    "com.example.Gate",
    { pid: process.pid, windowId: null },
    { fromActionPeer: true, includeAx: true, includeScreenshot: true, actionDims: { width: 1200, height: 800 } }
  );
  const unprovDrag = await gateExec.dispatch({
    name: "drag",
    app: "com.example.Gate",
    cleanArgs: { app: "com.example.Gate", from_x: 10, from_y: 20, to_x: 120, to_y: 20 },
    parsedRef: { ok: true, hasElementRef: false },
  });
  assert.equal(unprovDrag.result.isError, true);
  assert.equal(unprovDrag.result.deliveryState, "not_sent");
  assert.equal(unprovDrag.result.fatal, true);
  assert.equal(unprovDrag.result.reason, "unproven_same_window");
  assert.equal(gatePeerCalls.length, 0);

  gateReg.recordMeta(
    "com.example.Gate",
    { pid: process.pid, windowId: 41, windowCount: 2, singleWindowProven: false, peerInstanceId: "gate-peer" },
    { fromActionPeer: true, includeAx: true, includeScreenshot: true, actionDims: { width: 1200, height: 800 } }
  );
  gateGuard.recordSteal("com.example.Gate", "click:sky_click", { routeScope: { pid: process.pid, windowId: 41 } });
  const blockedOcuPixel = await gateExec.dispatch({
    name: "click",
    app: "com.example.Gate",
    cleanArgs: { app: "com.example.Gate", x: 100, y: 100, click_method: "sky_click" },
    parsedRef: { ok: true, hasElementRef: false },
    windowDelivery: { route: "ocu_pixel", windowId: 41, windowBoundsPt: { x: 0, y: 0, width: 1200, height: 800 } },
  });
  assert.equal(blockedOcuPixel.result.isError, true);
  assert.equal(blockedOcuPixel.result.deliveryState, "not_sent");
  assert.equal(blockedOcuPixel.result.fatal, true);
  assert.equal(blockedOcuPixel.result.reason, "ocu_pixel_sky_click_blocked");
  assert.equal(gatePeerCalls.length, 0);
  assert.equal(gateWinClickCalls, 0);

  const unpinnedMultiWinMeta = gateReg.getMeta("com.example.Gate");
  const unpinnedActBlocked = await gateExec.executeActClick({
    app: "com.example.Gate",
    pid: process.pid,
    meta: { ...unpinnedMultiWinMeta, windowBounds: { x: 0, y: 0, w: 1200, h: 800 } },
    match: { index: 1, bounds: { x: 10, y: 10, w: 40, h: 20 } },
    targetWindowId: 41,
  });
  assert.equal(unpinnedActBlocked.delivered, false, "Unpinned multi-window act must not fall through to PID app_post when sky_click is blocked");
  assert.equal(gatePeerCalls.length, 0);

  // Mixed element_index + to_x/to_y drag & multi-window/mismatched tinyWindowOverride drag must fail closed
  const mixedDragBlocked = await gateExec.dispatch({
    name: "drag",
    app: "com.example.Gate",
    cleanArgs: { app: "com.example.Gate", element_index: "1", to_x: 150, to_y: 120 },
    parsedRef: { ok: true, hasElementRef: true, rawIndex: "1" },
    liveWindowObs: { wid: 99, windowIds: [99] },
  });
  assert.equal(mixedDragBlocked.result.isError, true);
  assert.equal(mixedDragBlocked.result.deliveryState, "not_sent");
  assert.equal(mixedDragBlocked.result.reason, "unproven_same_window");

  gateReg.recordMeta(
    "com.example.Gate",
    {
      pid: process.pid,
      windowId: 41,
      windowCount: 2,
      singleWindowProven: false,
      windowBounds: { x: 0, y: 0, w: 1200, h: 800 },
    },
    {
      fromActionPeer: true,
      includeAx: false,
      includeScreenshot: true,
      actionDims: { width: 1200, height: 800 },
      tinyWindowOverride: { wid: 41, bounds: { x: 0, y: 0, width: 1200, height: 800 }, imgWidth: 1200, imgHeight: 800 },
    }
  );
  let tinyDragCalls = 0;
  const tinyGateExec = new BackgroundActionExecutor({
    registry: gateReg,
    focusPolicyGuard: gateGuard,
    actionPeer: { async callTool() { return { isError: false, content: [{ type: "text", text: "ok" }] }; } },
    pointDragFn: async () => {
      tinyDragCalls += 1;
      return { delivered: true, method: "app_post" };
    },
  });
  const multiTinyDragBlocked = await tinyGateExec.dispatch({
    name: "drag",
    app: "com.example.Gate",
    cleanArgs: { app: "com.example.Gate", from_x: 10, from_y: 20, to_x: 100, to_y: 20 },
    parsedRef: { ok: true, hasElementRef: false },
  });
  assert.equal(multiTinyDragBlocked.result.isError, true);
  assert.equal(multiTinyDragBlocked.result.reason, "unproven_single_window");
  assert.equal(tinyDragCalls, 0);

  // ocu_pixel with tinyWindowOverride present must STILL hit ocu_pixel sky_click lock instead of tinyWindowOverride
  const ocuWithTinyBlocked = await tinyGateExec.dispatch({
    name: "click",
    app: "com.example.Gate",
    cleanArgs: { app: "com.example.Gate", x: 100, y: 100, click_method: "sky_click" },
    parsedRef: { ok: true, hasElementRef: false },
    windowDelivery: { route: "ocu_pixel", windowId: 41, windowBoundsPt: { x: 0, y: 0, width: 1200, height: 800 } },
  });
  assert.equal(ocuWithTinyBlocked.result.isError, true);

  // dispatchBackgroundPointDragDetailed enforces beforeWriteCheck before running JXA
  await assert.rejects(
    () =>
      dispatchBackgroundPointDragDetailed(process.pid, 10, 10, 50, 50, {
        beforeWriteCheck: () => {
          throw new TakeoverAbortedError("paused_drag", { code: "PAUSED" });
        },
      }),
    (e) => e?.aborted === true
  );

  // 4) Qt 45pt handleFocusedWindow resolves _AXUIElementGetWindow first against pidWindows
  const hQt45 = createJxaHarness({
    axTrusted: true,
    axWindows: {
      4784: { x: 0, y: 45, w: 1469, h: 810, title: "剪映专业版", axBounds: { x: 0, y: 0, w: 1469, h: 810 } },
      4785: { x: 2000, y: 45, w: 400, h: 300, title: "剪映专业版", axBounds: { x: 2000, y: 0, w: 400, h: 300 } },
    },
  });
  const qtFocused = hQt45.sandbox.handleFocusedWindow({ pid: 63251, windowTitle: "剪映专业版" });
  assert.equal(qtFocused.wid, 4784);
  assert.equal(qtFocused.windowBounds.y, 45);
  assert.deepEqual(Array.from(qtFocused.windowIds), [4784, 4785]);

  // 5) sent_unknown zero-retry, JXA mid-gesture throw, PersistentAxBridge.close(), one-shot 2nd beforeWriteCheck, & REPL kill
  let retryPeerCalls = 0;
  let unhideCalls = 0;
  const unkRetryExec = new BackgroundActionExecutor({
    registry: gateReg,
    focusPolicyGuard: new FocusPolicyGuard(),
    axBridge: { enabled: true, async checkPermissions() { return { accessibility: false }; } },
    unhideAppFn: async () => {
      unhideCalls += 1;
    },
    actionPeer: {
      agentInstanceId: "gate-peer",
      async callTool() {
        retryPeerCalls += 1;
        return {
          isError: true,
          deliveryState: "sent_unknown",
          content: [{ type: "text", text: "Target app is hidden after partial click" }],
        };
      },
    },
  });
  const noRetryRes = await unkRetryExec.dispatch({
    name: "click",
    app: "com.example.Gate",
    cleanArgs: { app: "com.example.Gate", element_index: "1" },
    parsedRef: { ok: true, hasElementRef: true, rawIndex: "1" },
  });
  assert.equal(retryPeerCalls, 1, "sent_unknown must never unhide or retry");
  assert.equal(unhideCalls, 0);
  assert.equal(noRetryRes.result.deliveryState, "sent_unknown");
  assert.equal(noRetryRes.result.fatal, true);
  assert.equal(noRetryRes.result.code, "WRITE_OUTCOME_UNKNOWN");

  const hThrow = createJxaHarness({ axTrusted: true });
  hThrow.sandbox.$.SLEventPostToPid = () => {
    throw new Error("simulated post throw");
  };
  hThrow.sandbox.$.CGEventPostToPid = () => {
    throw new Error("simulated post throw");
  };
  assert.equal(
    hThrow.sandbox.handleWindowClick({ pid: 63251, wid: 4784, localPoint: { x: 100, y: 100 } }).deliveryState,
    "sent_unknown"
  );
  assert.equal(
    hThrow.sandbox.handleWindowScroll({ pid: 63251, wid: 4784, direction: "down", pages: 1 }).deliveryState,
    "sent_unknown"
  );
  assert.equal(
    hThrow.sandbox.handleWindowKey({ pid: 63251, wid: 4784, key: "Return" }).deliveryState,
    "sent_unknown"
  );
  assert.equal(
    hThrow.sandbox.handleWindowText({ pid: 63251, wid: 4784, text: "abc" }).deliveryState,
    "sent_unknown"
  );

  await assert.rejects(
    () => tryWindowKey(process.pid, "a", { axBridge: { enabled: true, async postWindowKey() { return { delivered: false, deliveryState: "sent_unknown", reason: "k" }; } } }),
    (e) => e?.code === "WRITE_OUTCOME_UNKNOWN" && e?.deliveryState === "sent_unknown"
  );
  await assert.rejects(
    () => tryWindowText(process.pid, "hi", { axBridge: { enabled: true, async postWindowText() { return { delivered: false, deliveryState: "sent_unknown", reason: "t" }; } } }),
    (e) => e?.code === "WRITE_OUTCOME_UNKNOWN" && e?.deliveryState === "sent_unknown"
  );
  await assert.rejects(
    () => tryWindowScroll(process.pid, { axBridge: { enabled: true, async postWindowScroll() { return { delivered: false, deliveryState: "sent_unknown", reason: "s" }; } } }),
    (e) => e?.code === "WRITE_OUTCOME_UNKNOWN" && e?.deliveryState === "sent_unknown"
  );

  const mockCloseProc = Object.assign(new EventEmitter(), {
    exitCode: null,
    signalCode: null,
    killed: false,
    pid: 999999,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill() {
      this.killed = true;
      this.exitCode = 0;
      queueMicrotask(() => this.emit("close", 0, "SIGKILL"));
    },
  });
  mockCloseProc.stdin = Object.assign(
    new Writable({
      write(chunk, _enc, cb) {
        const lines = String(chunk).split("\n").filter(Boolean);
        for (const raw of lines) {
          try {
            const req = JSON.parse(raw);
            if (req.method === "ping") {
              mockCloseProc.stdout.write(`${JSON.stringify({ id: req.id, ok: true, result: { pong: true } })}\n`);
            }
          } catch {}
        }
        cb();
      },
    }),
    { writable: true }
  );
  mockCloseProc.stdin.on("finish", () => {
    if (!mockCloseProc.killed) {
      mockCloseProc.exitCode = 0;
      queueMicrotask(() => mockCloseProc.emit("close", 0, null));
    }
  });
  const closeBridge = new PersistentAxBridge({
    enabled: true,
    spawnFn: () => mockCloseProc,
  });
  await closeBridge.ensureStarted();
  const inFlightScroll = closeBridge.postWindowScroll(63251, { wid: 4784, direction: "down" });
  const attachedCloseReject = inFlightScroll.then(
    () => ({ ok: true }),
    (err) => ({ ok: false, err })
  );
  await new Promise((r) => setTimeout(r, 15));
  await closeBridge.close();
  const closeOutcome = await attachedCloseReject;
  assert.equal(closeOutcome.ok, false);
  assert.equal(closeOutcome.err?.code, "WRITE_OUTCOME_UNKNOWN");
  assert.equal(closeOutcome.err?.deliveryState, "sent_unknown");

  if (process.platform === "darwin") {
    let textCheckCount = 0;
    await assert.rejects(
      () =>
        tryHeadlessSelectedTextInsert(process.pid, "你好", {
          axBridge: { enabled: true, async insertSelectedText() { return null; } },
          beforeWriteCheck: () => {
            textCheckCount += 1;
            if (textCheckCount >= 2) throw new TakeoverAbortedError("paused", { code: "PAUSED" });
          },
        }),
      (e) => e?.aborted === true
    );
    let scrollCheckCount = 0;
    await assert.rejects(
      () =>
        tryHeadlessBackgroundScroll(process.pid, null, "down", 1, {
          axBridge: { enabled: true, async scroll() { return null; } },
          beforeWriteCheck: () => {
            scrollCheckCount += 1;
            if (scrollCheckCount >= 2) throw new TakeoverAbortedError("paused", { code: "PAUSED" });
          },
        }),
      (e) => e?.aborted === true
    );
    let menuCheckCount = 0;
    await assert.rejects(
      () =>
        tryHeadlessContextMenu(process.pid, { role: "AXButton", rawText: "Export" }, {
          axBridge: { enabled: true, async triggerContextMenu() { return null; } },
          beforeWriteCheck: () => {
            menuCheckCount += 1;
            if (menuCheckCount >= 2) throw new TakeoverAbortedError("paused", { code: "PAUSED" });
          },
        }),
      (e) => e?.aborted === true
    );

    const runnerStatus = await verifyNativeAppBundle(SCRIPT_RUNNER_APP_PATH, {
      role: "scriptRunner",
      skipSelfTest: true,
    });
    if (runnerStatus.ok) {
      const replTakeover = new TakeoverController();
      const fakeReplBroker = {
        registry: gateReg,
        takeoverController: replTakeover,
        actionPeer: { agentInstanceId: "repl-peer-1" },
        async executeToolCall(toolName) {
          if (toolName === "click") {
            return {
              isError: true,
              deliveryState: "sent_unknown",
              fatal: true,
              code: "WRITE_OUTCOME_UNKNOWN",
              content: [{ type: "text", text: "partial click post" }],
            };
          }
          return {
            isError: false,
            content: [{ type: "text", text: `App=com.example.Gate (pid ${process.pid})\nWindow: "W", App: Gate.` }],
          };
        },
      };
      const replMgr = new StrictReplSessionManager({ broker: fakeReplBroker });
      try {
        // Simulated pre-existing peer crash lock on real agentId "agent-42" must NOT be clobbered by REPL error handling
        replTakeover.markWriteOutcomeUnknown("agent-42");
        replTakeover.clearWriteOutcomeUnknown("agent-42");
        replTakeover.markWriteOutcomeUnknown("agent-42");
        replTakeover.clearWriteOutcomeUnknown("agent-42");
        const replRes = await replMgr.run("sess-slice8", {
          code: `var g = await cua.getApp("com.example.Gate"); var leaked = 42; await g.click({ x: 10, y: 10 });`,
          timeout_ms: 8000,
        });
        assert.equal(replRes.isError, true);
        assert.equal(replRes.deliveryState, "sent_unknown");
        assert.equal(replRes.fatal, true);
        assert.equal(replRes.code, "WRITE_OUTCOME_UNKNOWN");
        const afterWipe = await replMgr.run("sess-slice8", {
          code: `nodeRepl.write(typeof leaked);`,
          timeout_ms: 5000,
        });
        assert.match(afterWipe.content[0].text, /undefined/, "REPL session state must be wiped on WRITE_OUTCOME_UNKNOWN");
        // Verify pre-latched peer unknown lock with real agentId is preserved and unlockable by clearWriteOutcomeUnknown
        replTakeover.markWriteOutcomeUnknown("agent-42");
        await fakeReplBroker.executeToolCall("click");
        replTakeover.clearWriteOutcomeUnknown("agent-42");
        assert.equal(
          replTakeover.assertMayDispatch({ signal: new AbortController().signal, isAi: true, epoch: replTakeover.pauseEpoch }),
          true,
          "clearWriteOutcomeUnknown('agent-42') must unlock without being clobbered by REPL 'default' agentId"
        );
      } finally {
        await replMgr.closeAll();
      }
    }
  }

  // 6) Pinned title-only expect works when resolveActionTarget returns resolved: false + wid/windowTitle
  const titleActExec = new AtomicActExecutor({
    getActionPeer: () => ({
      agentInstanceId: "gate-peer",
      async callTool(name) {
        if (name === "query") {
          return {
            isError: false,
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  window_id: 41,
                  matches: [{ index: 1, role: "AXButton", title: "OpenInspector", bounds: { x: 10, y: 10, w: 30, h: 20 } }],
                }),
              },
            ],
          };
        }
        return { isError: false, content: [{ type: "text", text: "ok" }] };
      },
    }),
    getAxBridge: () => ({
      enabled: true,
      async resolveActionTarget() {
        return { resolved: false, wid: 41, windowTitle: "Inspector", reason: "window_only" };
      },
    }),
    registry: gateReg,
    takeoverController: new TakeoverController(),
    checkAppRunning: async () => ({ running: true }),
    getRunningAppIdentityFn: async () => ({ pid: process.pid, bundleId: "com.example.Gate", processToken: `${process.pid}:1` }),
    safeGetAppState: async () => ({ isError: false, content: [{ type: "text", text: `App=com.example.Gate (pid ${process.pid})\nWindow: "W", App: Gate.` }] }),
    processQueryResult: (_app, res) => ({
      parsed: JSON.parse(res.content[0].text),
      merged: { windowId: 41, windowBounds: { x: 0, y: 0, w: 1200, h: 800 }, snapshotId: "s-title", snapshot: { elements: new Map([["1", { origin: "ax" }]]) } },
    }),
    actionExecutor: {
      async executeActClick() {
        return { delivered: true, clicksSent: 1, routeKey: "click:window_post" };
      },
    },
  });
  const pinnedTitleRes = await titleActExec.execute({
    app: "com.example.Gate",
    window_id: 41,
    target: { text: "OpenInspector" },
    reveal: { max_scroll_steps: 0 },
    expect: { window_title_contains: ["Inspector"] },
    timeout_ms: 800,
  });
  assert.equal(pinnedTitleRes.isError, false, `Expected pinned title-only expect to pass: ${pinnedTitleRes.content?.[0]?.text}`);

  // 7) Cross-scope FocusPolicyGuard observation fence protects route penalty across scopes
  let releaseCrossFront;
  const crossFrontGate = new Promise((r) => {
    releaseCrossFront = r;
  });
  let crossFrontCalls = 0;
  let crossFrontRestores = 0;
  const crossGuard = new FocusPolicyGuard({
    resolveTargetInfo: () => ({ pid: process.pid, bundleId: "com.lemon.lvpro", appDisplayName: "剪映专业版" }),
    focusController: {
      async getFrontmostApp() {
        crossFrontCalls += 1;
        if (crossFrontCalls === 2) {
          await crossFrontGate;
          return { pid: process.pid, bundleId: "com.lemon.lvpro" };
        }
        return { pid: 100, bundleId: "com.google.antigravity" };
      },
      async restoreFrontmostApp() {
        crossFrontRestores += 1;
        return true;
      },
      sweepDelaysMs: [],
    },
  });
  const scopeA = await crossGuard.beginGuard("com.lemon.lvpro", { routeScope: { pid: process.pid, windowId: 4784 } });
  const scopeB = crossGuard.createScope("com.lemon.lvpro", { pid: 100, bundleId: "com.google.antigravity" }, crossGuard.epoch, {
    routeScope: { pid: process.pid, windowId: 4785 },
  });
  const enforceA = scopeA.enforce("click:sky_click");
  await new Promise((r) => setTimeout(r, 15));
  scopeB.enterObservationPhase();
  releaseCrossFront();
  const aStolen = await enforceA;
  scopeB.exitObservationPhase();
  assert.equal(aStolen, true);
  assert.equal(crossFrontRestores, 1);
  assert.equal(
    crossGuard.planClick({ app: "com.lemon.lvpro" }, ["com.lemon.lvpro"], { routeScope: { pid: process.pid, windowId: 4784 } }).includes("sky_click"),
    true,
    "Cross-scope observation phase in scopeB must block penalty recording in scopeA"
  );
  crossGuard.close();
});

test("Round 9 Codex Fixes 1-7: coord no-replay, ambiguous/rollback stream guards, cold preObs fail-closed, liveWindowObs checks, scroll:app_post_scroll gate, small JXA WID", async () => {
  // 1) Fix 1: coord click & mixed drag do NOT auto-refresh and replay stale coordinates on "stale snapshot"
  let clickPeerCalls = 0;
  let dragPeerCalls = 0;
  let autoRefreshCalls = 0;
  let unhideCalls = 0;
  let nextPeerErrText = "stale window";
  const reg1 = new AppSnapshotRegistry();
  reg1.recordMeta(
    "com.example.NoReplay",
    {
      pid: 7100,
      windowId: 71,
      windowBounds: { x: 0, y: 0, w: 800, h: 600 },
      windowCount: 1,
      singleWindowProven: true,
      elements: new Map([
        ["1", { index: "1", role: "AXButton", title: "Start", origin: "ax", frame: { x: 10, y: 10, w: 40, h: 20 } }],
      ]),
    },
    {
      fromActionPeer: true,
      includeAx: true,
      includeScreenshot: true,
      actionDims: { width: 800, height: 600 },
    }
  );
  const meta1 = reg1.getMeta("com.example.NoReplay");
  if (meta1?.actionScreenshotMeta) {
    meta1.actionScreenshotMeta.peerInstanceId = "peer-nr";
  }
  const snap1 = reg1.getLatestSnapshot("com.example.NoReplay");
  assert.ok(snap1);

  const noReplayExec = new BackgroundActionExecutor({
    registry: reg1,
    focusPolicyGuard: new FocusPolicyGuard({
      resolveTargetInfo: () => ({ pid: 7100, bundleId: "com.example.NoReplay" }),
      focusController: {
        async getFrontmostApp() {
          return { pid: 100, bundleId: "com.google.antigravity" };
        },
        async restoreFrontmostApp() {
          return true;
        },
        sweepDelaysMs: [],
      },
    }),
    takeoverController: new TakeoverController(),
    actionPeer: {
      agentInstanceId: "peer-nr",
      async callTool(name) {
        if (name === "click") clickPeerCalls += 1;
        if (name === "drag") dragPeerCalls += 1;
        return { isError: true, content: [{ type: "text", text: nextPeerErrText }] };
      },
    },
    unhideAppFn: async () => {
      unhideCalls += 1;
      return true;
    },
    refreshActionStateFn: async () => {
      autoRefreshCalls += 1;
      return { isError: false };
    },
  });

  const noReplayClick = await noReplayExec.dispatch({
    name: "click",
    app: "com.example.NoReplay",
    cleanArgs: { app: "com.example.NoReplay", x: 120, y: 140, click_method: "sky_click" },
    parsedRef: { ok: true, hasElementRef: false, snapshotId: null, rawIndex: null },
    liveWindowObs: { wid: 71, windowIds: [71] },
  });
  assert.equal(noReplayClick.result.isError, true);
  assert.equal(clickPeerCalls, 1, "Coord click must NOT replay after stale window");
  assert.equal(autoRefreshCalls, 0);

  nextPeerErrText = "Target app is hidden";
  const noReplayHiddenClick = await noReplayExec.dispatch({
    name: "click",
    app: "com.example.NoReplay",
    cleanArgs: { app: "com.example.NoReplay", x: 120, y: 140, click_method: "sky_click" },
    parsedRef: { ok: true, hasElementRef: false, snapshotId: null, rawIndex: null },
    liveWindowObs: { wid: 71, windowIds: [71] },
  });
  assert.equal(noReplayHiddenClick.result.isError, true);
  assert.equal(clickPeerCalls, 2, "Coord click must NOT unhide+replay after Target app is hidden");
  assert.equal(unhideCalls, 0);
  nextPeerErrText = "stale window";

  const noReplayMixedDrag = await noReplayExec.dispatch({
    name: "drag",
    app: "com.example.NoReplay",
    cleanArgs: {
      app: "com.example.NoReplay",
      element_index: "1",
      to_x: 320,
      to_y: 260,
    },
    parsedRef: { ok: true, hasElementRef: true, snapshotId: null, rawIndex: "1" },
    validatedSnapshot: snap1,
    validatedElement: snap1.elements.get("1"),
    liveWindowObs: { wid: 71, windowIds: [71] },
  });
  assert.equal(noReplayMixedDrag.result.isError, true);
  assert.equal(dragPeerCalls, 1, "Mixed element+coord drag must NOT replay after stale snapshot");
  assert.equal(autoRefreshCalls, 0);
  noReplayExec.focusPolicyGuard.close();

  // 2) Fix 2 & Fix 3: liveWindowObs multi-window blocks app_post across click, tinyOverride, executeActClick, executeActScroll;
  //    and scroll:app_post_scroll penalty blocks appPostFallback in executeActScroll
  const reg2 = new AppSnapshotRegistry();
  reg2.recordMeta(
    "com.example.LiveObs",
    {
      pid: 7200,
      windowId: 41,
      windowTitle: "Main",
      windowBounds: { x: 0, y: 0, w: 1000, h: 600 },
      windowCount: 1,
      singleWindowProven: true,
    },
    {
      fromActionPeer: true,
      includeAx: false,
      includeScreenshot: true,
      actionDims: { width: 1000, height: 600 },
      tinyWindowOverride: {
        wid: 41,
        windowTitle: "Main",
        bounds: { x: 0, y: 0, width: 1000, height: 600 },
        imgWidth: 1000,
        imgHeight: 600,
      },
    }
  );
  const meta2 = reg2.getMeta("com.example.LiveObs");
  if (meta2?.actionScreenshotMeta) {
    meta2.actionScreenshotMeta.peerInstanceId = "peer-lo";
  }

  let frontFlip = false;
  const guard2 = new FocusPolicyGuard({
    resolveTargetInfo: () => ({ pid: 7200, bundleId: "com.example.LiveObs" }),
    focusController: {
      async getFrontmostApp() {
        if (frontFlip) {
          return { pid: 7200, bundleId: "com.example.LiveObs" };
        }
        return { pid: 100, bundleId: "com.google.antigravity" };
      },
      async restoreFrontmostApp() {
        return true;
      },
      sweepDelaysMs: [],
    },
  });
  // Block click:sky_click + scroll:app_post_scroll cleanly via two steals each
  for (let i = 0; i < 2; i += 1) {
    const s1 = await guard2.beginGuard("com.example.LiveObs", { routeScope: { pid: 7200, windowId: 41 } });
    frontFlip = true;
    await s1.enforce("click:sky_click");
    frontFlip = false;
    const s2 = await guard2.beginGuard("com.example.LiveObs", { routeScope: { pid: 7200, windowId: 41 } });
    frontFlip = true;
    await s2.enforce("scroll:app_post_scroll");
    frontFlip = false;
  }
  assert.equal(
    guard2.isMethodBlocked(["com.example.LiveObs"], "click", "sky_click", {
      routeScope: { pid: 7200, windowId: 41 },
    }),
    true
  );
  assert.equal(
    guard2.isMethodBlocked(["com.example.LiveObs"], "scroll", "app_post_scroll", {
      routeScope: { pid: 7200, windowId: 41 },
    }),
    true
  );

  let peerLiveCalls = 0;
  const ptAppFallbacks = [];
  const winClickFallbacks = [];
  const winScrollFallbacks = [];
  const liveMultiObs = { wid: 41, windowIds: [41, 42] };
  const exec2 = new BackgroundActionExecutor({
    registry: reg2,
    focusPolicyGuard: guard2,
    takeoverController: new TakeoverController(),
    actionPeer: {
      agentInstanceId: "peer-lo",
      async callTool() {
        peerLiveCalls += 1;
        return { isError: false, content: [{ type: "text", text: "ok" }] };
      },
    },
    axBridge: {
      enabled: true,
      async isJxaAccessibilityTrusted() {
        return true;
      },
      async getFocusedWindowInfo() {
        return liveMultiObs;
      },
    },
    pointClickFn: async (_pid, _x, _y, opts) => {
      ptAppFallbacks.push(opts.allowAppPostFallback);
      return { delivered: true, method: "window_post" };
    },
    windowClickFn: async (_pid, opts) => {
      winClickFallbacks.push(opts.allowAppPostFallback);
      return { delivered: true, method: "window_post" };
    },
    windowScrollFn: async (_pid, opts) => {
      winScrollFallbacks.push(opts.allowAppPostFallback);
      return { delivered: true, verified: true, method: "window_post_scroll" };
    },
    axScrollFallbackFn: null,
  });

  // 2a) TinyWindowOverride click with multi-window liveWindowObs refuses app_post fallback
  const tinyMultiClick = await exec2.dispatch({
    name: "click",
    app: "com.example.LiveObs",
    cleanArgs: { app: "com.example.LiveObs", x: 100, y: 100 },
    parsedRef: { ok: true, hasElementRef: false, snapshotId: null, rawIndex: null },
    liveWindowObs: liveMultiObs,
  });
  assert.equal(tinyMultiClick.result.isError, false);
  assert.deepEqual(ptAppFallbacks, [false]);

  // 2b) Clear tinyWindowOverride -> coord click with app_post blocks on multi-window liveWindowObs
  const savedTiny = meta2.tinyWindowOverride;
  meta2.tinyWindowOverride = null;
  const regAppPostBlock = await exec2.dispatch({
    name: "click",
    app: "com.example.LiveObs",
    cleanArgs: { app: "com.example.LiveObs", x: 100, y: 100, click_method: "app_post" },
    parsedRef: { ok: true, hasElementRef: false, snapshotId: null, rawIndex: null },
    windowDelivery: {
      route: "app_post",
      windowId: 41,
      windowBoundsPt: { x: 0, y: 0, width: 1000, height: 600 },
    },
    liveWindowObs: liveMultiObs,
  });
  assert.equal(regAppPostBlock.result.isError, true);
  assert.equal(regAppPostBlock.result.reason, "unproven_single_window");
  assert.equal(peerLiveCalls, 0);
  meta2.tinyWindowOverride = savedTiny;

  // 2c) executeActClick without explicit liveWindowObs checks axBridge.getFocusedWindowInfo -> false
  await exec2.executeActClick({
    app: "com.example.LiveObs",
    pid: 7200,
    meta: meta2,
    explicitWindowId: 41,
    match: { bounds: { x: 50, y: 50, w: 40, h: 20 } },
  });
  assert.deepEqual(winClickFallbacks, [false]);

  // 2d) executeActScroll without explicit liveWindowObs checks axBridge.getFocusedWindowInfo -> false
  await exec2.executeActScroll({
    app: "com.example.LiveObs",
    pid: 7200,
    meta: meta2,
    windowId: 41,
  });
  assert.deepEqual(winScrollFallbacks, [false]);

  // 2e) Fix 3: single-window liveWindowObs, click:app_post NOT blocked, ONLY scroll:app_post_scroll blocked -> false
  await exec2.executeActScroll({
    app: "com.example.LiveObs",
    pid: 7200,
    meta: meta2,
    windowId: 41,
    liveWindowObs: { wid: 41, windowIds: [41] },
  });
  assert.deepEqual(winScrollFallbacks, [false, false]);
  guard2.close();

  // 3) Fix 4, Fix 5 & Fix 6: ComputerUseBrokerServer HTTP + RPC tests
  const sock = path.join(tmpdir(), `cua-codex-r9-${process.pid}-${crypto.randomBytes(4).toString("hex")}.sock`);
  const miniJpeg = Buffer.from([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x03, 0x00, 0x05, 0x00, 0x01, 0x01, 0x11, 0x00,
    0xff, 0xd9,
  ]).toString("base64"); // 1280x768 (>=16B) matches 1000x600
  const helperWindows = [
    { pid: 9911, windowId: 801, layer: 0, title: "Main", boundsPt: { x: 0, y: 0, width: 1000, height: 600 }, onScreen: true },
    { pid: 9911, windowId: 802, layer: 0, title: "Aux", boundsPt: { x: 20, y: 20, width: 500, height: 400 }, onScreen: true },
  ];
  let coldHelperCalls = 0;
  let interactWindowClicks = 0;

  const peer3 = {
    async listTools() {
      return { tools: [{ name: "list_apps" }, { name: "get_app_state" }, { name: "click" }] };
    },
    async callTool(name, args = {}) {
      if (name === "list_apps") {
        return {
          isError: false,
          content: [
            { type: "text", text: "MultiApp — com.example.Multi [running]\nColdApp — com.example.Cold [running]" },
          ],
        };
      }
      if (name === "get_app_state") {
        const isMulti = args?.app === "com.example.Multi";
        const pidNum = isMulti ? 9911 : 9912;
        const appId = isMulti ? "com.example.Multi" : "com.example.Cold";
        const appName = isMulti ? "MultiApp" : "ColdApp";
        return {
          isError: false,
          content: [
            { type: "text", text: `App=${appId} (pid ${pidNum})\nWindow: "Main", App: ${appName}.\n\t1 button OK` },
            { type: "image", mimeType: "image/jpeg", data: miniJpeg },
          ],
        };
      }
      return { isError: false, content: [{ type: "text", text: "ok" }] };
    },
    close() {},
  };

  const token = "codex-r9-tok";
  const broker = new ComputerUseBrokerServer({
    webPort: 0,
    uiToken: token,
    socketPath: sock,
    infoPath: null,
    actionPeer: peer3,
    streamPeer: peer3,
    axBridge: null,
    desktopHelperClient: {
      available: true,
      videoAvailable: false,
      getDiagnostics: () => ({
        available: true,
        videoAvailable: false,
        pid: 4322,
        bundleId: "io.codexstyle.cua.desktop-helper.dev",
        capabilities: { accessibilityTrusted: true },
      }),
      async listWindows(pid) {
        if (pid === 9912) {
          return [
            { pid: 9912, windowId: 555, layer: 0, title: "Main", boundsPt: { x: 0, y: 0, width: 1000, height: 600 }, onScreen: true },
          ];
        }
        return helperWindows;
      },
      async getFocusedWindow(pid) {
        if (pid === 9912) {
          coldHelperCalls += 1;
          if (coldHelperCalls === 1) return null;
          return {
            wid: 555,
            windowIds: [555],
            title: "Main",
            windowBounds: { x: 0, y: 0, width: 1000, height: 600 },
          };
        }
        return null;
      },
      async start() {
        return this.getDiagnostics();
      },
      async setTakeoverTargets() {
        return true;
      },
      async resetTakeoverLatch() {
        return true;
      },
      async probe() {
        return this.getDiagnostics();
      },
      async close() {},
    },
    permissionsFn: async () => ({ platform: "darwin", accessibility: true, screenRecording: true }),
    runningAppIdentityFn: async (appQuery) => {
      if (appQuery === "com.example.Cold") {
        return { pid: 9912, bundleId: "com.example.Cold", processToken: "9912:1" };
      }
      return { pid: 9911, bundleId: "com.example.Multi", processToken: "9911:1" };
    },
    processIdentityFn: async (pid) => ({ pid, alive: true, guiApp: true, processToken: `${pid}:1` }),
    windowClickFn: async () => {
      interactWindowClicks += 1;
      return { delivered: true, method: "window_post" };
    },
    launchHelperOnStart: false,
  });

  await broker.start();
  const rpc = new BrokerRpcClient({ socketPath: sock });
  try {
    const webPort = broker.webPort;

    // 3a) Fix 5: Cold screenshot where running app pid=9912 resolves, preObs returns [], parsedWindowId=0 -> fails closed
    const coldRes = await rpc.request("tools/call", {
      name: "get_app_state",
      arguments: { app: "com.example.Cold" },
      source: "ai",
    });
    assert.equal(Boolean(coldRes.isError), false);
    assert.ok(coldHelperCalls >= 2, `Expected preObs + postObs listWindows calls, got ${coldHelperCalls}`);
    const coldMeta = broker.registry.getMeta("com.example.Cold");
    assert.equal(coldMeta?.actionScreenshotMeta?.singleWindowProven, false);
    assert.equal(coldMeta?.windowId ?? null, null);

    // 3b) Fix 6: Select 801, then invalid reqWid=999999 rolls back and restores 801 geometry
    const selGood = await (
      await fetch(`http://127.0.0.1:${webPort}/api/select-app`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Sidecar-Token": token },
        body: JSON.stringify({ app: "com.example.Multi", windowId: 801 }),
      })
    ).json();
    assert.equal(selGood.pinnedWindowId, 801);
    assert.equal(broker.previewStreamManager.getActiveGeometry()?.windowId, 801);

    const selBadRes = await fetch(`http://127.0.0.1:${webPort}/api/select-app`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Sidecar-Token": token },
      body: JSON.stringify({ app: "com.example.Multi", windowId: 999999 }),
    });
    const selBadBody = await selBadRes.json();
    assert.equal(selBadBody.ok, false);
    assert.equal(selBadBody.statusCode, 404);
    assert.equal(selBadBody.state.pinnedWindowId, 801);
    assert.equal(broker.previewStreamManager.getActiveGeometry()?.windowId, 801);
    assert.equal(broker.previewStreamManager.getActiveGeometry()?.windowBoundsPt?.width, 1000);

    // 3c) Fix 4: ambiguous frame marked in frameHistory & readOnlyOverride transition bumps geometryRev
    const gAmbig = broker.previewStreamManager.syncActiveGeometry({
      pid: 9911,
      processToken: "9911:1",
      windowId: 801,
      explicitWindowId: true,
      windowBoundsPt: { x: 0, y: 0, width: 1000, height: 600 },
      jxaTrusted: true,
      singleWindowProven: false,
      readOnlyOverride: true,
      readOnlyReasonOverride: "ambiguous_multi_window_stream",
    });
    broker.webAdapter.updateFrameFromImageItem(
      { mimeType: "image/jpeg", data: miniJpeg },
      12,
      {
        frameMeta: {
          targetKey: gAmbig.targetKey,
          geometryRev: gAmbig.geometryRev,
          windowId: 801,
          ambiguous: true,
        },
      }
    );
    const pushedEntry = broker.webAdapter.frameHistory[broker.webAdapter.frameHistory.length - 1];
    assert.equal(pushedEntry?.ambiguous, true);

    const gClear = broker.previewStreamManager.syncActiveGeometry({
      pid: 9911,
      processToken: "9911:1",
      windowId: 801,
      explicitWindowId: true,
      windowBoundsPt: { x: 0, y: 0, width: 1000, height: 600 },
      jxaTrusted: true,
      singleWindowProven: true,
      readOnlyOverride: false,
      readOnlyReasonOverride: null,
    });
    assert.equal(
      gClear.geometryRev,
      gAmbig.geometryRev + 1,
      "Clearing readOnlyOverride without bounds change must bump geometryRev"
    );

    const staleAmbigInteract = await fetch(`http://127.0.0.1:${webPort}/api/interact`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Sidecar-Token": token },
      body: JSON.stringify({
        app: "com.example.Multi",
        brokerBootId: broker.brokerBootId,
        frameRef: {
          transport: "jpeg",
          brokerBootId: broker.brokerBootId,
          targetKey: gClear.targetKey,
          geometryRev: gClear.geometryRev,
          seq: pushedEntry.seq,
          windowId: 801,
        },
        kind: "click",
        normX: 0.5,
        normY: 0.5,
      }),
    });
    assert.equal(staleAmbigInteract.status, 409);
    const staleAmbigBody = await staleAmbigInteract.json();
    assert.equal(staleAmbigBody.code, "STALE_VIEW");
    assert.equal(interactWindowClicks, 0);
  } finally {
    await rpc.close();
    await broker.close();
    rmSync(sock, { force: true });
  }

  // 4) Fix 7: JXA resolveTargetCgWindow finds 110x75 layer-8 floating panel ONLY when reqWid > 0
  const { sandbox } = createJxaHarness({});
  sandbox.$.CGWindowListCopyWindowInfo = () => [
    {
      kCGWindowNumber: 901,
      kCGWindowOwnerPID: 63251,
      kCGWindowLayer: 8,
      kCGWindowAlpha: 1,
      kCGWindowName: "SmallPalette",
      kCGWindowBounds: { X: 10, Y: 20, Width: 110, Height: 75 },
    },
  ];
  assert.equal(sandbox.listVisiblePidCgWindows(63251).length, 0);
  assert.equal(sandbox.listVisiblePidCgWindows(63251, { includeSmallAndAux: true }).length, 1);
  const withoutExplicitWid = sandbox.resolveTargetCgWindow(63251, "SmallPalette", null, null, {
    x: 10,
    y: 20,
    w: 110,
    h: 75,
  });
  assert.notEqual(withoutExplicitWid?.wid, 901);
  const foundSmall = sandbox.resolveTargetCgWindow(63251, "", 901, null, null);
  assert.equal(foundSmall?.wid, 901);
  assert.equal(foundSmall?.w, 110);
  assert.equal(foundSmall?.h, 75);
});

test("Round 10 Spec/Standards/Codex Fixes: isSingleWindowProven explicit false, excluded focused panel, tiny moved/blocked guards, partial set_value sent_unknown preservation, pinned hit-test wid, clicksSent:0 on not_sent, REPL abort-in-flight wait", async () => {
  // 1) Spec CRITICAL #1: isSingleWindowProven honors explicit singleWindowProven: false even when windowCount === 1
  assert.equal(isSingleWindowProven({ singleWindowProven: false, windowCount: 1 }), false);
  assert.equal(isSingleWindowProven({ singleWindowProven: true, windowCount: 1 }), true);
  assert.equal(isSingleWindowProven({ windowCount: 1 }), true);

  // 2) Codex P1 #2: JXA handleFocusedWindow focusing excluded small/aux panel sets focusedExcludedWindow & refuses app_post
  const { sandbox: sExcl } = createJxaHarness({
    axWindows: {
      41: { x: 0, y: 0, w: 1000, h: 600, title: "Main" },
    },
  });
  sExcl.$.CGWindowListCopyWindowInfo = () => [
    {
      kCGWindowNumber: 41,
      kCGWindowOwnerPID: 63251,
      kCGWindowLayer: 0,
      kCGWindowAlpha: 1,
      kCGWindowName: "Main",
      kCGWindowBounds: { X: 0, Y: 0, Width: 1000, Height: 600 },
    },
    {
      kCGWindowNumber: 901,
      kCGWindowOwnerPID: 63251,
      kCGWindowLayer: 8,
      kCGWindowAlpha: 1,
      kCGWindowName: "FloatingTools",
      kCGWindowBounds: { X: 20, Y: 20, Width: 110, Height: 75 },
    },
  ];
  const origCopyAttr = sExcl.$.AXUIElementCopyAttributeValue;
  sExcl.$.AXUIElementCopyAttributeValue = (el, attr, out) => {
    if (el && el.kind === "app" && String(attr) === "AXFocusedWindow") {
      out[0] = { kind: "win", title: "FloatingTools", wid: 901, bounds: { x: 20, y: 20, w: 110, h: 75 } };
      return 0;
    }
    return origCopyAttr(el, attr, out);
  };
  const exclObs = sExcl.handleFocusedWindow({ pid: 63251 });
  assert.equal(exclObs.wid, null);
  assert.equal(exclObs.focusedExcludedWindow, true);
  assert.ok(exclObs.windowIds.includes(901));
  const exclProof = evaluateScreenshotMetaProof(
    {
      pid: 63251,
      windowId: 41,
      actionFrameWidth: 1000,
      actionFrameHeight: 600,
      actionScreenshotMeta: {
        pid: 63251,
        windowId: 41,
        windowIdProven: true,
        windowBounds: { x: 0, y: 0, width: 1000, height: 600 },
        width: 1000,
        height: 600,
        windowCount: 1,
        singleWindowProven: true,
      },
    },
    { pid: 63251, liveWindowObs: exclObs, requireSingleWindow: true }
  );
  assert.equal(exclProof.singleWindowProven, false);

  // 3) Codex P1 #5: Pinned resolveActionTarget must NOT recenter using an AX hit-test node of unknown ownership (effectiveWid=0)
  const { sandbox: sPin } = createJxaHarness({
    axWindows: {
      4784: { x: 0, y: 0, w: 1000, h: 600, title: "Editor" },
    },
    hitTestFn: () => ({
      role: "AXButton",
      bounds: { x: 140, y: 80, w: 80, h: 50 }, // center (180, 105), NO wid -> effectiveWid=0
    }),
  });
  const pinRes = sPin.handleResolveActionTarget({
    pid: 63251,
    wid: 4784,
    localPoint: { x: 101, y: 60 },
  });
  assert.equal(pinRes.resolved, true);
  assert.equal(pinRes.centerLocalPoint.x, 101);
  assert.equal(pinRes.centerLocalPoint.y, 60);

  // 4) Standards #3 + Codex P1 #3, #6 + Standards #4:
  //    (a) TinyOverride click refuses moved windowBounds (>2pt) with unproven_same_window
  //    (b) TinyOverride drag refuses blocked drag:app_post with drag_route_blocked
  //    (c) Partial set_value (Backspace + stale window type_text) preserves sent_unknown instead of STALE_REF
  //    (d) executeActClick returns clicksSent: 0 when native click returns deliveryState: "not_sent"
  const reg10 = new AppSnapshotRegistry();
  reg10.recordMeta(
    "com.example.R10",
    {
      pid: 7400,
      windowId: 41,
      windowTitle: "Main",
      windowBounds: { x: 0, y: 0, w: 1000, h: 600 },
      windowCount: 1,
      singleWindowProven: true,
      elements: new Map([
        ["1", { index: "1", role: "AXTextField", title: "Input", origin: "ax", frame: { x: 10, y: 10, w: 120, h: 30 } }],
      ]),
    },
    {
      fromActionPeer: true,
      includeAx: true,
      includeScreenshot: true,
      actionDims: { width: 1000, height: 600 },
      tinyWindowOverride: {
        wid: 41,
        windowTitle: "Main",
        bounds: { x: 0, y: 0, width: 1000, height: 600 },
        imgWidth: 1000,
        imgHeight: 600,
      },
    }
  );
  const meta10 = reg10.getMeta("com.example.R10");
  if (meta10?.actionScreenshotMeta) {
    meta10.actionScreenshotMeta.peerInstanceId = "peer-10";
  }
  const snap10 = reg10.getLatestSnapshot("com.example.R10");

  let dragSteal = false;
  const guard10 = new FocusPolicyGuard({
    resolveTargetInfo: () => ({ pid: 7400, bundleId: "com.example.R10" }),
    focusController: {
      async getFrontmostApp() {
        return dragSteal
          ? { pid: 7400, bundleId: "com.example.R10" }
          : { pid: 100, bundleId: "com.google.antigravity" };
      },
      async restoreFrontmostApp() {
        return true;
      },
      sweepDelaysMs: [],
    },
  });
  for (let i = 0; i < 2; i += 1) {
    const s = await guard10.beginGuard("com.example.R10", { routeScope: { pid: 7400, windowId: 41 } });
    dragSteal = true;
    await s.enforce("drag:app_post");
    dragSteal = false;
  }
  const sSv = await guard10.beginGuard("com.example.R10", { routeScope: { pid: 7400, windowId: 41 } });
  dragSteal = true;
  await sSv.enforce("set_value:native");
  dragSteal = false;

  let ptClickCalls10 = 0;
  let ptDragCalls10 = 0;
  let allowWinClick10 = true;
  let failOcuClick10 = false;
  const exec10 = new BackgroundActionExecutor({
    registry: reg10,
    focusPolicyGuard: guard10,
    takeoverController: new TakeoverController(),
    actionPeer: {
      agentInstanceId: "peer-10",
      async callTool(name) {
        if (name === "click" && failOcuClick10) {
          return { isError: true, deliveryState: "not_sent", content: [{ type: "text", text: "blocked_pre" }] };
        }
        if (name === "type_text") {
          return { isError: true, deliveryState: "not_sent", content: [{ type: "text", text: "stale window" }] };
        }
        return { isError: false, content: [{ type: "text", text: "ok" }] };
      },
    },
    axBridge: { enabled: true, async isJxaAccessibilityTrusted() { return true; } },
    editableFocusFn: async () => ({ editable: true, role: "AXTextField", singleLine: true }),
    selectedTextInsertFn: async () => ({ delivered: false, reason: "unsupported" }),
    windowClickFn: async () =>
      allowWinClick10
        ? { delivered: true, method: "window_post" }
        : { delivered: false, reason: "window_not_found" },
    pointClickFn: async () => {
      ptClickCalls10 += 1;
      return { delivered: true, method: "window_post" };
    },
    pointDragFn: async () => {
      ptDragCalls10 += 1;
      return { delivered: true, method: "app_post" };
    },
    windowKeyFn: async (_pid, key) => {
      if (key === "cmd+a" || key === "BackSpace" || key === "Backspace") {
        return { delivered: true, method: "window_key" };
      }
      return { delivered: false, deliveryState: "not_sent", reason: "window_not_found" };
    },
    windowTextFn: async () => ({ delivered: false, deliveryState: "not_sent", reason: "stale window" }),
  });

  // (4a) Moved window bounds refuse tinyOverride click
  const movedTiny = await exec10.dispatch({
    name: "click",
    app: "com.example.R10",
    cleanArgs: { app: "com.example.R10", x: 50, y: 50 },
    parsedRef: { ok: true, hasElementRef: false, snapshotId: null, rawIndex: null },
    liveWindowObs: { wid: 41, windowIds: [41], windowBounds: { x: 60, y: 20, width: 1000, height: 600 } },
  });
  assert.equal(movedTiny.result.isError, true);
  assert.equal(movedTiny.result.reason, "unproven_same_window");
  assert.equal(ptClickCalls10, 0);

  // (4b) Blocked drag:app_post refuses tinyOverride drag
  const blockedDrag = await exec10.dispatch({
    name: "drag",
    app: "com.example.R10",
    cleanArgs: { app: "com.example.R10", from_x: 20, from_y: 20, to_x: 80, to_y: 20 },
    parsedRef: { ok: true, hasElementRef: false, snapshotId: null, rawIndex: null },
    liveWindowObs: { wid: 41, windowIds: [41], windowBounds: { x: 0, y: 0, width: 1000, height: 600 } },
  });
  assert.equal(blockedDrag.result.isError, true);
  assert.equal(blockedDrag.result.reason, "drag_route_blocked");
  assert.equal(ptDragCalls10, 0);

  // (4c) Partial set_value on pinned snapshot ref preserves sent_unknown instead of converting to STALE_REF
  const partialSetVal = await exec10.dispatch({
    name: "set_value",
    app: "com.example.R10",
    cleanArgs: { app: "com.example.R10", snapshot_id: snap10.id, element_index: "1", value: "abc" },
    parsedRef: { ok: true, hasElementRef: true, snapshotId: snap10.id, rawIndex: "1", displayRef: `${snap10.id}:1` },
    validatedSnapshot: snap10,
    validatedElement: snap10.elements.get("1"),
  });
  assert.equal(partialSetVal.result.isError, true);
  assert.equal(partialSetVal.result.deliveryState, "sent_unknown");
  assert.equal(partialSetVal.result.code, "WRITE_OUTCOME_UNKNOWN");
  assert.equal(partialSetVal.isStalePinnedRef, false);

  // (4d) executeActClick reports clicksSent: 0 when native OCU click returns deliveryState: "not_sent"
  allowWinClick10 = false;
  failOcuClick10 = true;
  const notSentAct = await exec10.executeActClick({
    app: "com.example.R10",
    pid: 7400,
    meta: meta10,
    explicitWindowId: 41,
    match: { index: "1", bounds: { x: 10, y: 10, w: 80, h: 30 } },
    resolvedTarget: { wid: 41, windowBounds: { x: 0, y: 0, w: 1000, h: 600 }, centerLocalPoint: { x: 50, y: 25 } },
    liveWindowObs: { wid: 41, windowIds: [41] },
  });
  assert.equal(notSentAct.delivered, false);
  assert.equal(notSentAct.clicksSent, 0);
  guard10.close();

  // 5) Codex P1 #7: REPL pause during an in-flight mutating click waits for settled sent_unknown instead of returning [PAUSED]
  const tc10 = new TakeoverController();
  const regRepl10 = new AppSnapshotRegistry();
  regRepl10.recordMeta(
    "com.example.ReplAbort",
    { pid: process.pid, windowId: 77, windowBounds: { x: 0, y: 0, w: 800, h: 600 }, windowCount: 1, singleWindowProven: true },
    { fromActionPeer: true, actionDims: { width: 800, height: 600 } }
  );
  let releaseBrokerClick;
  const brokerClickGate = new Promise((r) => {
    releaseBrokerClick = r;
  });
  const mgr10 = new StrictReplSessionManager({
    broker: {
      registry: regRepl10,
      takeoverController: tc10,
      async executeToolCall(toolName) {
        if (toolName === "click") {
          setTimeout(() => {
            tc10.requestPause({ reason: "ui_interact", source: "ui" });
            setTimeout(() => releaseBrokerClick(), 40);
          }, 25);
          await brokerClickGate;
          return {
            isError: true,
            code: "WRITE_OUTCOME_UNKNOWN",
            deliveryState: "sent_unknown",
            fatal: true,
            content: [{ type: "text", text: "mutating click sent_unknown" }],
          };
        }
        return { isError: false, content: [{ type: "text", text: `App=com.example.ReplAbort (pid ${process.pid})\n1 button OK` }] };
      },
    },
  });
  const replRunRes = await mgr10.run("s-r10-abort", {
    code: 'var g = await cua.getApp("com.example.ReplAbort"); await g.click({ x: 100, y: 100 });',
    timeout_ms: 5000,
  });
  assert.equal(replRunRes.isError, true);
  assert.equal(replRunRes.deliveryState, "sent_unknown", `Unexpected replRunRes: ${JSON.stringify(replRunRes)}`);
  assert.equal(replRunRes.code, "WRITE_OUTCOME_UNKNOWN");
});

test("R11 fixes: focusedExcludedWindow propagation, #resolveLiveWindowObs fallback & single-win mismatch, single-pass geometryRev stability", async () => {
  // 1) AppSnapshotRegistry.captureWindowObservation & resolveFocusedWindowObservation
  const excludedRegistry = new AppSnapshotRegistry({
    axBridge: {
      enabled: true,
      async getFocusedWindowInfo() {
        return { wid: 88, title: "Main", windowBounds: { x: 0, y: 0, width: 1000, height: 600 } };
      },
    },
  });
  excludedRegistry.recordMeta(
    "com.example.Excluded",
    {
      pid: 7501,
      windowId: 88,
      windowBounds: { x: 0, y: 0, w: 1000, h: 600 },
      windowCount: 1,
      singleWindowProven: true,
    },
    { fromActionPeer: true, actionDims: { width: 1000, height: 600 } }
  );

  // 1a) helperObs wid > 0 still forwards focusedExcludedWindow: true and blocks proveScreenshotWindowObservation
  const excludedHelperClient = {
    available: true,
    async getFocusedWindow() {
      return {
        wid: 88,
        title: "Main",
        windowBounds: { x: 0, y: 0, width: 1000, height: 600 },
        windowIds: [88],
        focusedExcludedWindow: true,
      };
    },
  };
  const directExcluded = await excludedRegistry.captureWindowObservation("com.example.Excluded", {
    desktopHelperClient: excludedHelperClient,
  });
  assert.equal(directExcluded?.focusedExcludedWindow, true);
  const excludedProof = await excludedRegistry.proveScreenshotWindowObservation("com.example.Excluded", {
    pid: 7501,
    imgDims: { width: 1000, height: 600 },
    parsedWindowId: 88,
    preObs: directExcluded,
    hadPrePid: true,
    desktopHelperClient: excludedHelperClient,
  });
  assert.equal(excludedProof.proven, false);
  assert.equal(excludedProof.singleWindowProven, false);

  // 1b) helperObs wid: null merges focusedExcludedWindow: true with axBridge output
  const mergedExcluded = await excludedRegistry.captureWindowObservation("com.example.Excluded", {
    desktopHelperClient: {
      available: true,
      async getFocusedWindow() {
        return { wid: null, windowIds: [88], focusedExcludedWindow: true };
      },
    },
  });
  assert.equal(mergedExcluded?.wid, 88);
  assert.deepEqual(mergedExcluded?.windowIds, [88]);
  assert.equal(mergedExcluded?.focusedExcludedWindow, true);

  // 1c) helperObs wid: null with empty windowIds & focusedExcludedWindow: true without axBridge
  const bareExcluded = await resolveFocusedWindowObservation({
    pid: 7501,
    axBridge: null,
    desktopHelperClient: {
      available: true,
      async getFocusedWindow() {
        return { wid: null, windowIds: [], focusedExcludedWindow: true };
      },
    },
  });
  assert.deepEqual(bareExcluded, {
    wid: null,
    title: null,
    windowBounds: null,
    windowIds: [],
    focusedExcludedWindow: true,
  });

  // 2) BackgroundActionExecutor.#resolveLiveWindowObs fallback & single-window mismatch
  const regLive = new AppSnapshotRegistry();
  regLive.recordMeta(
    "com.example.LiveR11",
    {
      pid: 7502,
      windowId: 91,
      windowTitle: "Main",
      windowBounds: { x: 0, y: 0, w: 1000, h: 600 },
      windowCount: 1,
      singleWindowProven: true,
    },
    { fromActionPeer: true, includeAx: true, includeScreenshot: true, actionDims: { width: 1000, height: 600 } }
  );
  const metaLive = regLive.getMeta("com.example.LiveR11");
  if (metaLive?.actionScreenshotMeta) {
    metaLive.actionScreenshotMeta.peerInstanceId = "peer-r11";
  }

  let helperMode = "partial_ids_ax_mismatch";
  let axQueries = 0;
  const allowFallbacks = [];
  const guardLive = new FocusPolicyGuard({
    resolveTargetInfo: () => ({ pid: 7502, bundleId: "com.example.LiveR11" }),
    focusController: {
      async getFrontmostApp() {
        return { pid: 100, bundleId: "com.google.antigravity" };
      },
      async restoreFrontmostApp() {
        return true;
      },
      sweepDelaysMs: [],
    },
  });
  const execLive = new BackgroundActionExecutor({
    registry: regLive,
    focusPolicyGuard: guardLive,
    takeoverController: new TakeoverController(),
    actionPeer: {
      agentInstanceId: "peer-r11",
      async callTool() {
        return { isError: false, content: [{ type: "text", text: "ok" }] };
      },
    },
    desktopHelperClient: {
      available: true,
      async getFocusedWindow() {
        if (helperMode === "partial_ids_ax_mismatch") {
          return { wid: null, windowIds: [91] };
        }
        return null;
      },
      async listWindows() {
        return [{ pid: 7502, windowId: 999, title: "Other", boundsPt: { x: 0, y: 0, width: 1000, height: 600 }, onScreen: true }];
      },
    },
    axBridge: {
      enabled: true,
      async isJxaAccessibilityTrusted() {
        return true;
      },
      async getFocusedWindowInfo() {
        axQueries += 1;
        if (helperMode === "partial_ids_ax_mismatch") {
          return { wid: 92, title: "Second", windowBounds: { x: 0, y: 0, width: 1000, height: 600 }, windowIds: null };
        }
        return null;
      },
    },
    windowScrollFn: async (_pid, opts) => {
      allowFallbacks.push(opts.allowAppPostFallback);
      return { delivered: true, verified: true, method: "window_post_scroll" };
    },
    axScrollFallbackFn: null,
  });

  // 2a) helperObs wid: null + windowIds: [91] does NOT short-circuit before axBridge -> detects wid=92 != 91
  const scrollViaAx = await execLive.executeActScroll({
    app: "com.example.LiveR11",
    pid: 7502,
    meta: metaLive,
    windowId: 91,
    direction: "down",
  });
  assert.equal(scrollViaAx.delivered, true);
  assert.equal(axQueries, 1);
  assert.deepEqual(allowFallbacks, [false]);

  // 2b) Single-window listWindows fallback returns mismatched windowIds: [999] -> fails closed (allowAppPostFallback: false)
  helperMode = "list_single_mismatch";
  const scrollSingleMismatch = await execLive.executeActScroll({
    app: "com.example.LiveR11",
    pid: 7502,
    meta: metaLive,
    windowId: 91,
    direction: "down",
  });
  assert.equal(scrollSingleMismatch.delivered, true);
  assert.deepEqual(allowFallbacks, [false, false]);
  guardLive.close();

  // 3) Broker #refreshAndPublishPreviewFrame: ambiguous multi-window stream keeps geometryRev stable (no +2 churn)
  const sockR11 = path.join(tmpdir(), `cua-r11-${process.pid}-${crypto.randomBytes(4).toString("hex")}.sock`);
  const miniJpegR11 = Buffer.from([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x03, 0x00, 0x05, 0x00, 0x01, 0x01, 0x11, 0x00,
    0xff, 0xd9,
  ]).toString("base64");
  const peerR11 = {
    async listTools() {
      return { tools: [{ name: "list_apps" }, { name: "get_app_state" }] };
    },
    async callTool(name) {
      if (name === "get_app_state") {
        return {
          isError: false,
          content: [
            { type: "text", text: "App=com.example.AmbigR11 (pid 7503)\nWindow: \"Main\", App: AmbigR11.\n\t1 button OK" },
            { type: "image", mimeType: "image/jpeg", data: miniJpegR11 },
          ],
        };
      }
      return { isError: false, content: [{ type: "text", text: "ok" }] };
    },
    close() {},
  };
  const brokerR11 = new ComputerUseBrokerServer({
    webPort: 0,
    uiToken: "r11-tok",
    socketPath: sockR11,
    infoPath: null,
    actionPeer: peerR11,
    streamPeer: peerR11,
    axBridge: null,
    desktopHelperClient: {
      available: true,
      videoAvailable: false,
      getDiagnostics: () => ({
        available: true,
        videoAvailable: false,
        pid: 4323,
        bundleId: "io.codexstyle.cua.desktop-helper.dev",
        capabilities: { accessibilityTrusted: true },
      }),
      async listWindows() {
        return [
          { pid: 7503, windowId: 701, layer: 0, title: "Main", boundsPt: { x: 0, y: 0, width: 1000, height: 600 }, onScreen: true },
          { pid: 7503, windowId: 702, layer: 0, title: "Aux", boundsPt: { x: 30, y: 30, width: 500, height: 400 }, onScreen: true },
        ];
      },
      async getFocusedWindow() {
        return { wid: null, windowIds: [701, 702] };
      },
      async start() {
        return this.getDiagnostics();
      },
      async setTakeoverTargets() {
        return true;
      },
      async resetTakeoverLatch() {
        return true;
      },
      async probe() {
        return this.getDiagnostics();
      },
      async close() {},
    },
    permissionsFn: async () => ({ platform: "darwin", accessibility: true, screenRecording: true }),
    runningAppIdentityFn: async () => ({ pid: 7503, bundleId: "com.example.AmbigR11", processToken: "7503:1" }),
    processIdentityFn: async (pid) => ({ pid, alive: true, guiApp: true, processToken: `${pid}:1` }),
    launchHelperOnStart: false,
  });
  await brokerR11.start();
  const rpcR11 = new BrokerRpcClient({ socketPath: sockR11 });
  try {
    await rpcR11.request("tools/call", {
      name: "get_app_state",
      arguments: { app: "com.example.AmbigR11" },
      source: "ai",
    });
    const revAfterFirst = brokerR11.state.geometryRev;
    assert.equal(revAfterFirst, 1);
    assert.equal(brokerR11.state.previewReadOnly, true);
    assert.equal(brokerR11.state.previewReadOnlyReason, "ambiguous_multi_window_stream");
    assert.equal(brokerR11.webAdapter.frameHistory.at(-1)?.ambiguous, true);

    await rpcR11.request("tools/call", {
      name: "get_app_state",
      arguments: { app: "com.example.AmbigR11" },
      source: "ai",
    });
    assert.equal(brokerR11.state.geometryRev, revAfterFirst, "Repeated ambiguous frames must not churn geometryRev");
    assert.equal(brokerR11.state.previewGeometry?.geometryRev, revAfterFirst);
    assert.equal(brokerR11.webAdapter.frameHistory.at(-1)?.geometryRev, revAfterFirst);
    assert.equal(brokerR11.webAdapter.frameHistory.at(-1)?.ambiguous, true);
  } finally {
    await rpcR11.close();
    await brokerR11.close();
    rmSync(sockR11, { force: true });
  }
});


