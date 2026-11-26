import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

import { BackgroundActionExecutor } from "../src/action-executor.mjs";
import {
  AppSnapshotRegistry,
  areWindowTitlesConsistent,
} from "../src/app-snapshot-registry.mjs";
import { BRIDGE_JXA_SOURCE } from "../src/ax-bridge.mjs";
import { parseSnapshotMetadata } from "../src/background-policy.mjs";
import { BrokerRpcClient } from "../src/broker-client.mjs";
import { ComputerUseBrokerServer } from "../src/broker-sidecar.mjs";
import { BROWSER_TITLE_SUFFIX_PATTERN } from "../src/constants.mjs";
import {
  FocusPolicyGuard,
  isChromiumBrowserApp,
  planActClickMethods,
  planBackgroundClickMethods,
} from "../src/focus-policy-guard.mjs";

function makeJpg1280x828() {
  // Minimal valid SOF0 JPEG header carrying 1280x828 (0x0500 x 0x033C)
  return Buffer.from([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x03, 0x3c, 0x05, 0x00, 0x01, 0x01, 0x11, 0x00,
    0xff, 0xd9,
  ]).toString("base64");
}

function createBridgeVm({
  axTrusted = true,
  axWindows = {},
  cgWindows = [],
  hitTestFn = null,
  onPerformAction = null,
  getSystemUptime = null,
} = {}) {
  const postedMouseLocations = [];
  const performedActions = [];
  let axChildrenWalkCount = 0;

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
    CGPreflightScreenCaptureAccess: () => true,
    AXUIElementCreateSystemWide: () => ({}),
    AXUIElementSetMessagingTimeout() {},
    AXUIElementCreateApplication: (pid) => ({ kind: "app", pid }),
    AXUIElementCopyAttributeValue: (el, rawAttr, out) => {
      const attr = String(rawAttr);
      if (!el || typeof el !== "object") return -25212;
      if (el.destroyed) return -25202;
      if (el.kind === "app") {
        const wins = axWindows[el.pid] || [];
        if (attr === "AXFocusedWindow" || attr === "AXMainWindow") {
          if (!wins[0]) return -25212;
          out[0] = wins[0];
          return 0;
        }
        if (attr === "AXWindows") {
          out[0] = { count: wins.length, objectAtIndex: (i) => wins[i] };
          return 0;
        }
        return -25212;
      }
      if (attr === "AXRole") {
        out[0] = el.kind === "win" ? "AXWindow" : el.role || "AXStaticText";
        return 0;
      }
      if (attr === "AXRoleDescription") {
        out[0] = el.roleDesc || "";
        return 0;
      }
      if (attr === "AXTitle") {
        out[0] = el.title || "";
        return 0;
      }
      if (attr === "AXDescription") {
        out[0] = el.desc || "";
        return 0;
      }
      if (attr === "AXHelp") {
        out[0] = el.help || "";
        return 0;
      }
      if (attr === "AXIdentifier" || attr === "AXDOMIdentifier") {
        out[0] = el.identifier || "";
        return 0;
      }
      if (attr === "AXChildren") {
        axChildrenWalkCount += 1;
        const ch = Array.isArray(el.children) ? el.children : [];
        out[0] = { count: ch.length, objectAtIndex: (i) => ch[i] };
        return 0;
      }
      if (attr === "AXParent") {
        if (el.parent) {
          out[0] = el.parent;
          return 0;
        }
        return -25212;
      }
      if (attr === "AXWindow" && el.winEl) {
        out[0] = el.winEl;
        return 0;
      }
      if (attr === "AXPosition" && el.bounds) {
        out[0] = `x: ${el.bounds.x}, y: ${el.bounds.y}`;
        return 0;
      }
      if (attr === "AXSize" && el.bounds) {
        out[0] = `w: ${el.bounds.w}, h: ${el.bounds.h}`;
        return 0;
      }
      return -25212;
    },
    AXUIElementCopyMultipleAttributeValues: (el, _attrs, _opts, out) => {
      const vals = [
        el.kind === "win" ? "AXWindow" : el.role || "AXStaticText",
        el.roleDesc || "",
        el.identifier || "",
        el.identifier || "",
        el.title || "",
        el.desc || "",
        el.help || "",
      ];
      out[0] = { count: vals.length, objectAtIndex: (i) => vals[i] };
      return 0;
    },
    AXUIElementCopyActionNames: (el, out) => {
      const actions = Array.isArray(el?.actions) ? el.actions : [];
      out[0] = { count: actions.length, objectAtIndex: (i) => actions[i] };
      return 0;
    },
    AXUIElementPerformAction: (el, actionRaw) => {
      const action = String(actionRaw);
      performedActions.push({ el, action });
      if (onPerformAction) return onPerformAction(el, action);
      return 0;
    },
    AXUIElementCopyElementAtPosition: (_app, x, y, out) => {
      if (!hitTestFn) return -25212;
      const hit = hitTestFn(x, y);
      if (!hit) return -25212;
      out[0] = hit;
      return 0;
    },
    _AXUIElementGetWindow: (el, outRef) => {
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
    NSProcessInfo: {
      processInfo: {
        get systemUptime() {
          return typeof getSystemUptime === "function" ? getSystemUptime() : 100;
        },
      },
    },
    NSThread: { sleepForTimeInterval() {} },
    NSFileHandle: {
      fileHandleWithStandardInput: { availableData: { length: 0 } },
      fileHandleWithStandardOutput: { writeData() {} },
    },
    NSString: {},
    NSUTF16LittleEndianStringEncoding: 10,
    CGWindowListCopyWindowInfo: () => cgWindows,
    CGEventSourceCreate: () => ({}),
    CGEventCreateMouseEvent: (_s, evType, pt, btn) => {
      const ev = { kind: "mouse", evType, x: pt.x, y: pt.y, btn };
      if (evType === 1 || evType === 2) {
        postedMouseLocations.push({ evType, x: pt.x, y: pt.y });
      }
      return ev;
    },
    CGEventSetTimestamp() {},
    CGEventSetIntegerValueField() {},
    CGEventSetDoubleValueField() {},
    CGEventSetWindowLocation() {},
    SLEventSetIntegerValueField() {},
    SLEventPostToPid() {},
    CGEventPostToPid() {},
    kCGMouseEventClickState: 1,
    kCGMouseEventButtonNumber: 3,
  });

  sandbox.$ = Object.assign((str) => {
    const boxed = Object(String(str));
    boxed.dataUsingEncoding = () => ({ isNil: () => false, bytes: {} });
    return boxed;
  }, sandbox.$);

  vm.createContext(sandbox);
  vm.runInContext(BRIDGE_JXA_SOURCE, sandbox);

  return {
    sandbox,
    postedMouseLocations,
    performedActions,
    getAxChildrenWalkCount: () => axChildrenWalkCount,
    resetCounters: () => {
      axChildrenWalkCount = 0;
    },
  };
}

test("1. areWindowTitlesConsistent & proveScreenshotWindowObservation handle Edge/Chrome AXTitle suffix while rejecting sibling windows", async () => {
  assert.equal(
    areWindowTitlesConsistent(
      "饮食日记 -智能体 - 灵珠平台 - Microsoft Edge",
      "饮食日记 -智能体 - 灵珠平台",
      "Microsoft Edge"
    ),
    true
  );
  assert.equal(
    areWindowTitlesConsistent(
      "Docs - Google Chrome",
      "Docs",
      "Google Chrome"
    ),
    true
  );
  assert.equal(
    areWindowTitlesConsistent(
      "Page - Safari - Microsoft Edge",
      "Page - Safari",
      "Microsoft Edge"
    ),
    true
  );
  // Sibling profile / sleep suffix MUST NOT match!
  assert.equal(
    areWindowTitlesConsistent(
      "饮食日记 -智能体 - 灵珠平台 - 睡眠 - Microsoft Edge",
      "饮食日记 -智能体 - 灵珠平台",
      "Microsoft Edge"
    ),
    false
  );
  assert.equal(
    areWindowTitlesConsistent(
      "其他标签页 - Microsoft Edge",
      "饮食日记 -智能体 - 灵珠平台",
      "Microsoft Edge"
    ),
    false
  );

  let helperTitle = "饮食日记 -智能体 - 灵珠平台";
  const reg = new AppSnapshotRegistry();
  const helper = {
    available: true,
    async getFocusedWindow() {
      return {
        wid: 10937,
        title: helperTitle,
        windowBounds: { x: 22, y: 33, w: 1280, h: 828 },
        windowIds: [10937],
      };
    },
  };

  const provenRes = await reg.proveScreenshotWindowObservation("com.microsoft.edgemac", {
    pid: 74661,
    imgDims: { width: 1280, height: 828 },
    windowTitle: "饮食日记 -智能体 - 灵珠平台 - Microsoft Edge",
    appDisplayName: "Microsoft Edge",
    preObs: {
      wid: 10937,
      title: "饮食日记 -智能体 - 灵珠平台",
      windowBounds: { x: 22, y: 33, w: 1280, h: 828 },
      windowIds: [10937],
    },
    desktopHelperClient: helper,
  });
  assert.equal(provenRes.proven, true);
  assert.equal(provenRes.windowId, 10937);
  assert.equal(provenRes.singleWindowProven, true);

  // Sibling profile window title in AX vs main tab title in CG -> must still fail closed!
  const siblingRes = await reg.proveScreenshotWindowObservation("com.microsoft.edgemac", {
    pid: 74661,
    imgDims: { width: 1280, height: 828 },
    windowTitle: "饮食日记 -智能体 - 灵珠平台 - 睡眠 - Microsoft Edge",
    appDisplayName: "Microsoft Edge",
    preObs: {
      wid: 10937,
      title: "饮食日记 -智能体 - 灵珠平台",
      windowBounds: { x: 22, y: 33, w: 1280, h: 828 },
      windowIds: [10937],
    },
    desktopHelperClient: helper,
  });
  assert.equal(siblingRes.proven, false);

  // Different tab title -> must fail closed!
  helperTitle = "另一个网页";
  const diffTabRes = await reg.proveScreenshotWindowObservation("com.microsoft.edgemac", {
    pid: 74661,
    imgDims: { width: 1280, height: 828 },
    windowTitle: "饮食日记 -智能体 - 灵珠平台 - Microsoft Edge",
    appDisplayName: "Microsoft Edge",
    preObs: {
      wid: 10937,
      title: "另一个网页",
      windowBounds: { x: 22, y: 33, w: 1280, h: 828 },
      windowIds: [10937],
    },
    desktopHelperClient: helper,
  });
  assert.equal(diffTabRes.proven, false);
});

test("2. End-to-end Broker on Edge allows coordinate click (auto/window_post/sky_click) & drag without unproven_same_window", async () => {
  const sock = `/tmp/agy-cua-edge-e2e-${process.pid}-${Date.now()}.sock`;
  const token = "edge-e2e-token";
  const edgeShot = makeJpg1280x828();
  const peerCalls = [];
  const windowClickCalls = [];

  const peer = {
    agentInstanceId: "edge-peer-1",
    async listTools() {
      return { tools: [] };
    },
    async callTool(name, args) {
      peerCalls.push({ name, args });
      if (name === "list_apps") {
        return {
          isError: false,
          content: [{ type: "text", text: "Microsoft Edge — com.microsoft.edgemac [running]" }],
        };
      }
      if (name === "get_app_state") {
        return {
          isError: false,
          content: [
            {
              type: "text",
              text: [
                `App=com.microsoft.edgemac (pid ${process.pid})`,
                'Window: "饮食日记 -智能体 - 灵珠平台 - Microsoft Edge", App: Microsoft Edge.',
                "\t176 按钮",
                "\t177 button Frame: x=794, y=593, w=12, h=12",
              ].join("\n"),
            },
            { type: "image", mimeType: "image/jpeg", data: edgeShot },
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
    axBridge: {
      enabled: true,
      setSyntheticEventTag() {},
      async checkPermissions() {
        return { accessibility: true, screenRecording: true };
      },
      async getProcessInfo(pid) {
        return { alive: true, guiApp: true, pid, processToken: `${pid}:edge1` };
      },
      async ensureManualAccessibility() {
        return { supported: true, changed: false, enabled: true, definitive: true };
      },
      async bindSnapshot() {
        return { bound: true, boundCount: 2, windowBound: true };
      },
      async verifyLiveRef() {
        return { ok: true };
      },
      async dropSnapshots() {
        return { ok: true };
      },
      async close() {},
    },
    desktopHelperClient: {
      available: true,
      getDiagnostics() {
        return { available: true, bundleId: "io.codexstyle.cua.desktop-helper.dev", capabilities: {} };
      },
      async setTakeoverTargets() {},
      async resetTakeoverLatch() {},
      async listWindows() {
        return [
          {
            pid: process.pid,
            windowId: 10937,
            layer: 0,
            ownerName: "Microsoft Edge",
            bundleId: "com.microsoft.edgemac",
            title: "饮食日记 -智能体 - 灵珠平台",
            alpha: 1,
            onScreen: true,
            boundsPt: { x: 22, y: 33, width: 1280, height: 828 },
          },
        ];
      },
      async getFocusedWindow() {
        return {
          wid: 10937,
          title: "饮食日记 -智能体 - 灵珠平台",
          windowBounds: { x: 22, y: 33, w: 1280, h: 828 },
          windowIds: [10937],
        };
      },
      async close() {},
    },
    focusController: {
      async getFrontmostApp() {
        return { pid: 1111, bundleId: "com.t3tools.t3code", displayName: "T3 Code" };
      },
      async restoreFrontmostApp() {
        return true;
      },
      sweepDelaysMs: [],
    },
    processIdentityFn: async (pid) => ({
      alive: true,
      guiApp: true,
      pid,
      processToken: `${pid}:edge1`,
    }),
    rendererAccessibilityFn: async () => ({
      supported: true,
      changed: false,
      enabled: true,
      definitive: true,
    }),
    permissionsFn: async () => ({ platform: "darwin", accessibility: true, screenRecording: true }),
    windowClickFn: async (pid, opts) => {
      windowClickCalls.push({ pid, opts });
      return { delivered: true, method: "window_post", wid: opts.wid || 10937 };
    },
    launchHelperOnStart: false,
  });

  await broker.start();
  const client = new BrokerRpcClient({ socketPath: sock });
  try {
    const stateRes = await client.request("tools/call", {
      name: "get_app_state",
      arguments: { app: "Microsoft Edge", include_ax: true, include_screenshot: true },
      source: "ai",
    });
    assert.equal(Boolean(stateRes.isError), false);
    const meta = broker.registry.getMeta("Microsoft Edge");
    assert.equal(meta.windowId, 10937);
    assert.equal(meta.actionScreenshotMeta?.windowIdProven, true);
    assert.equal(meta.actionScreenshotMeta?.singleWindowProven, true);

    const autoClick = await client.request("tools/call", {
      name: "click",
      arguments: { app: "Microsoft Edge", x: 443, y: 598 },
      source: "ai",
    });
    assert.equal(Boolean(autoClick.isError), false, autoClick.content?.[0]?.text);
    assert.equal(
      peerCalls.some((c) => c.name === "click" && c.args.click_method === "sky_click"),
      true
    );

    const winPostClick = await client.request("tools/call", {
      name: "click",
      arguments: { app: "Microsoft Edge", x: 443, y: 598, click_method: "window_post" },
      source: "ai",
    });
    assert.equal(Boolean(winPostClick.isError), false, winPostClick.content?.[0]?.text);
    assert.equal(windowClickCalls.length, 1);
    assert.equal(windowClickCalls[0].opts.wid, 10937);

    peerCalls.length = 0;
    const skyClick = await client.request("tools/call", {
      name: "click",
      arguments: { app: "Microsoft Edge", x: 443, y: 598, click_method: "sky_click" },
      source: "ai",
    });
    assert.equal(Boolean(skyClick.isError), false, skyClick.content?.[0]?.text);
    assert.equal(
      peerCalls.some((c) => c.name === "click" && c.args.click_method === "sky_click"),
      true
    );

    peerCalls.length = 0;
    const dragRes = await client.request("tools/call", {
      name: "drag",
      arguments: { app: "Microsoft Edge", from_x: 100, from_y: 200, to_x: 300, to_y: 400 },
      source: "ai",
    });
    assert.equal(Boolean(dragRes.isError), false, dragRes.content?.[0]?.text);
    assert.equal(
      peerCalls.some((c) => c.name === "drag" && c.args.from_x === 100 && c.args.to_y === 400),
      true
    );
  } finally {
    await client.close();
    await broker.close();
    rmSync(sock, { force: true });
  }
});

test("3. parseSnapshotMetadata extracts Frame bounds and strips Frame text from rawText", () => {
  const snapText = [
    "App=com.microsoft.edgemac (pid 74661)",
    'Window: "饮食日记 -智能体 - 灵珠平台 - Microsoft Edge", App: Microsoft Edge.',
    "\t176 按钮",
    "\t177 button Frame: x=794, y=593, w=12, h=12",
    "\t54 button Tag: 草稿自动保存 Frame: x=1040, y=130, w=129, h=24 Secondary Actions: AXPress",
  ].join("\n");

  const parsed = parseSnapshotMetadata(snapText);
  const el177 = parsed.elements.get("177");
  assert.deepEqual(el177.bounds, { x: 794, y: 593, w: 12, h: 12 });
  assert.equal(el177.rawText, "");

  const el54 = parsed.elements.get("54");
  assert.deepEqual(el54.bounds, { x: 1040, y: 130, w: 129, h: 24 });
  assert.equal(el54.rawText, "Tag: 草稿自动保存");
  assert.deepEqual(el54.secondaryActions, ["AXPress"]);
});

test("4. FocusPolicyGuard & planBackgroundClickMethods prioritize accessibility on Chromium browsers while preserving non-Chromium ordering", () => {
  assert.equal(isChromiumBrowserApp(["com.microsoft.edgemac"]), true);
  assert.equal(isChromiumBrowserApp(["Microsoft Edge"]), true);
  assert.equal(isChromiumBrowserApp(["com.google.Chrome"]), true);
  assert.equal(isChromiumBrowserApp(["剪映专业版", "com.lemon.lvpro"]), false);

  const guard = new FocusPolicyGuard({
    resolveTargetInfo: (app) => ({
      appQuery: app,
      pid: 74661,
      bundleId: app === "Microsoft Edge" ? "com.microsoft.edgemac" : app,
      appDisplayName: app,
    }),
  });

  // Explicit click_method: "accessibility" on Edge tries accessibility FIRST
  assert.deepEqual(
    guard.planClick(
      { app: "Microsoft Edge", element_index: "176", click_method: "accessibility" },
      ["com.microsoft.edgemac", "Microsoft Edge"]
    ),
    ["accessibility", "sky_click", "app_post"]
  );

  // After sky_click steals focus on Edge, auto single-left element click tries accessibility FIRST
  const edgeScope = { pid: 74661, windowId: 10937 };
  guard.recordSteal("Microsoft Edge", "click:sky_click", { routeScope: edgeScope });
  assert.deepEqual(
    guard.planClick(
      { app: "Microsoft Edge", element_index: "176" },
      ["com.microsoft.edgemac", "Microsoft Edge"],
      { routeScope: edgeScope }
    ),
    ["accessibility", "window_post", "app_post"]
  );

  // Element index "0" or double-click must NOT promote accessibility on auto
  assert.deepEqual(
    guard.planClick(
      { app: "Microsoft Edge", element_index: "0" },
      ["com.microsoft.edgemac", "Microsoft Edge"],
      { routeScope: edgeScope }
    ),
    ["window_post", "app_post"]
  );
  assert.deepEqual(
    guard.planClick(
      { app: "Microsoft Edge", element_index: "176", click_count: 2 },
      ["com.microsoft.edgemac", "Microsoft Edge"],
      { routeScope: edgeScope }
    ),
    ["window_post", "app_post"]
  );

  // If accessibility itself steals focus, it is dropped cleanly
  guard.recordSteal("Microsoft Edge", "click:accessibility", { routeScope: edgeScope });
  assert.deepEqual(
    guard.planClick(
      { app: "Microsoft Edge", element_index: "176" },
      ["com.microsoft.edgemac", "Microsoft Edge"],
      { routeScope: edgeScope }
    ),
    ["window_post", "app_post"]
  );

  // Non-Chromium app retains existing ordering
  assert.deepEqual(
    planBackgroundClickMethods(
      { app: "剪映专业版", element_index: "81", click_method: "accessibility" },
      { blockedMethods: [] }
    ),
    ["sky_click", "app_post", "accessibility"]
  );
  assert.deepEqual(
    planBackgroundClickMethods(
      { app: "com.apple.TextEdit", element_index: "1" },
      { blockedMethods: ["sky_click"] }
    ),
    ["window_post", "app_post"]
  );
});

test("5. JXA bridge avoids empty-hint button mis-match, falls back to elementMeta.bounds, and climbs ancestors for handlePressActionTarget", () => {
  const pid = 74661;
  const wid = 10937;
  const winBounds = { x: 22, y: 33, w: 1280, h: 828 };

  const axWin = {
    kind: "win",
    wid,
    role: "AXWindow",
    title: "饮食日记 -智能体 - 灵珠平台 - Microsoft Edge",
    bounds: winBounds,
    children: [],
  };
  const backBtn = {
    role: "AXButton",
    roleDesc: "按钮",
    title: "返回",
    bounds: { x: 30, y: 60, w: 24, h: 24 },
    winEl: axWin,
    parent: axWin,
    actions: ["AXPress"],
  };
  const varHeaderGroup = {
    role: "AXGroup",
    roleDesc: "组",
    title: "",
    bounds: { x: 459, y: 611, w: 351, h: 40 },
    winEl: axWin,
    parent: axWin,
    actions: ["AXPress", "AXShowMenu"],
  };
  const varInnerGroup = {
    role: "AXGroup",
    roleDesc: "组",
    bounds: { x: 483, y: 621, w: 29, h: 20 },
    winEl: axWin,
    parent: varHeaderGroup,
    actions: ["AXShowMenu"],
  };
  const varText = {
    role: "AXStaticText",
    roleDesc: "文本",
    bounds: { x: 483, y: 621, w: 29, h: 20 },
    winEl: axWin,
    parent: varInnerGroup,
    actions: ["AXShowMenu"],
  };
  axWin.children = [backBtn, varHeaderGroup];
  varHeaderGroup.children = [varInnerGroup];
  varInnerGroup.children = [varText];

  // Other window node to verify strict cross-window ownership rejection
  const otherWin = {
    kind: "win",
    wid: 13746,
    role: "AXWindow",
    title: "睡眠",
    bounds: { x: 18, y: 37, w: 1280, h: 828 },
  };
  const otherPressBtn = {
    role: "AXButton",
    winEl: otherWin,
    parent: otherWin,
    actions: ["AXPress"],
  };

  const vmHarness = createBridgeVm({
    axTrusted: true,
    axWindows: { [pid]: [axWin] },
    cgWindows: [
      {
        kCGWindowOwnerPID: pid,
        kCGWindowNumber: wid,
        kCGWindowLayer: 0,
        kCGWindowAlpha: 1,
        kCGWindowIsOnscreen: true,
        kCGWindowName: "饮食日记 -智能体 - 灵珠平台",
        kCGWindowBounds: { X: 22, Y: 33, Width: 1280, Height: 828 },
      },
    ],
    hitTestFn: (sx, sy) => {
      // Hitting inside varText (local ~475, 598 => screen ~497, 631)
      if (sx >= 480 && sx <= 520 && sy >= 620 && sy <= 645) {
        return varText;
      }
      // Cross-window hit
      if (sx === 999 && sy === 999) {
        return otherPressBtn;
      }
      return null;
    },
  });

  // (a) Unlabeled icon button with empty rawText/help/identifier must NOT match backBtn ("返回")
  const resolvedEmpty = vmHarness.sandbox.resolveElementHandle(
    pid,
    null,
    "176",
    { role: "按钮", rawText: "", help: null, identifier: null },
    "饮食日记 -智能体 - 灵珠平台 - Microsoft Edge",
    wid
  );
  assert.equal(resolvedEmpty.el, null);

  // (b) handleWindowClick verifies live element at elementMeta.bounds (O(1), no AXChildren walk) and fails closed if stale/missing
  const plusBtn = {
    role: "AXButton",
    roleDesc: "按钮",
    title: "",
    bounds: { x: 22 + 794, y: 33 + 593, w: 12, h: 12 },
    winEl: axWin,
    parent: axWin,
    actions: ["AXPress"],
  };
  const plusBtnInnerIcon = {
    role: "AXGroup",
    roleDesc: "组",
    bounds: { x: 22 + 796, y: 33 + 595, w: 8, h: 8 },
    winEl: axWin,
    parent: plusBtn,
  };
  const popupModelBtn = {
    role: "AXPopUpButton",
    roleDesc: "弹出式按钮",
    title: "选择模型",
    bounds: { x: 22 + 994, y: 33 + 451, w: 109, h: 36 },
    winEl: axWin,
    parent: axWin,
    actions: ["AXPress"],
  };
  const otherLabelBtn = {
    role: "AXButton",
    roleDesc: "按钮",
    title: "保存",
    bounds: { x: 22 + 300, y: 33 + 400, w: 60, h: 24 },
    winEl: axWin,
    parent: axWin,
    actions: ["AXPress"],
  };
  const vmBoundsHarness = createBridgeVm({
    axTrusted: true,
    axWindows: { [pid]: [axWin] },
    cgWindows: [
      {
        kCGWindowOwnerPID: pid,
        kCGWindowNumber: wid,
        kCGWindowLayer: 0,
        kCGWindowAlpha: 1,
        kCGWindowIsOnscreen: true,
        kCGWindowName: "饮食日记 -智能体 - 灵珠平台",
        kCGWindowBounds: { X: 22, Y: 33, Width: 1280, Height: 828 },
      },
    ],
    hitTestFn: (sx, sy) => {
      if (Math.abs(sx - (22 + 800)) <= 6 && Math.abs(sy - (33 + 599)) <= 6) {
        return plusBtnInnerIcon;
      }
      if (Math.abs(sx - (22 + 1048.5)) <= 10 && Math.abs(sy - (33 + 469)) <= 10) {
        return popupModelBtn;
      }
      if (Math.abs(sx - (22 + 330)) <= 10 && Math.abs(sy - (33 + 412)) <= 10) {
        return otherLabelBtn;
      }
      return null;
    },
  });

  vmBoundsHarness.resetCounters();
  const clickViaLiveBounds = vmBoundsHarness.sandbox.handleWindowClick({
    pid,
    wid,
    elementIndex: "177",
    elementMeta: {
      role: "button",
      rawText: "",
      bounds: { x: 794, y: 593, w: 12, h: 12 },
      windowId: wid,
    },
    windowTitle: "饮食日记 -智能体 - 灵珠平台 - Microsoft Edge",
  });
  assert.equal(clickViaLiveBounds.delivered, true);
  assert.equal(clickViaLiveBounds.localX, 800);
  assert.equal(clickViaLiveBounds.localY, 599);
  assert.equal(vmBoundsHarness.getAxChildrenWalkCount(), 0, "O(1) bounds probe must skip AXChildren walk");

  // AXPopUpButton matches OCU role "button"
  const clickPopup = vmBoundsHarness.sandbox.handleWindowClick({
    pid,
    wid,
    elementIndex: "192",
    elementMeta: {
      role: "button",
      rawText: "选择模型",
      bounds: { x: 994, y: 451, w: 109, h: 36 },
      windowId: wid,
    },
    windowTitle: "饮食日记 -智能体 - 灵珠平台 - Microsoft Edge",
  });
  assert.equal(clickPopup.delivered, true);
  assert.equal(clickPopup.localX, 1048.5);
  assert.equal(clickPopup.localY, 469);

  // Stale labeled button replaced by a different-label button at same bounds -> must fail closed (element_not_found)
  vmBoundsHarness.postedMouseLocations.length = 0;
  const staleReplacedClick = vmBoundsHarness.sandbox.handleWindowClick({
    pid,
    wid,
    elementIndex: "200",
    elementMeta: {
      role: "button",
      rawText: "删除",
      bounds: { x: 300, y: 400, w: 60, h: 24 },
      windowId: wid,
    },
    windowTitle: "饮食日记 -智能体 - 灵珠平台 - Microsoft Edge",
  });
  assert.equal(staleReplacedClick.delivered, false);
  assert.equal(staleReplacedClick.deliveryState, "not_sent");
  assert.equal(staleReplacedClick.reason, "element_not_found");
  assert.equal(vmBoundsHarness.postedMouseLocations.length, 0);

  // Missing element at bounds -> must NOT blindly click stale coordinates
  const missingAtBoundsClick = vmBoundsHarness.sandbox.handleWindowClick({
    pid,
    wid,
    elementIndex: "201",
    elementMeta: {
      role: "button",
      rawText: "",
      bounds: { x: 100, y: 100, w: 20, h: 20 },
      windowId: wid,
    },
    windowTitle: "饮食日记 -智能体 - 灵珠平台 - Microsoft Edge",
  });
  assert.equal(missingAtBoundsClick.delivered, false);
  assert.equal(missingAtBoundsClick.deliveryState, "not_sent");
  assert.equal(missingAtBoundsClick.reason, "element_not_found");
  assert.equal(vmBoundsHarness.postedMouseLocations.length, 0);

  // axOriginMismatch variant: AX window origin is (0, 0) while CG origin is (22, 33)
  const axOriginZeroWin = {
    kind: "win",
    wid,
    role: "AXWindow",
    title: "饮食日记 -智能体 - 灵珠平台 - Microsoft Edge",
    bounds: { x: 0, y: 0, w: 1280, h: 828 },
    children: [],
  };
  const axOriginBtn = {
    role: "AXButton",
    roleDesc: "按钮",
    title: "",
    bounds: { x: 794, y: 593, w: 12, h: 12 },
    winEl: axOriginZeroWin,
    parent: axOriginZeroWin,
    actions: ["AXPress"],
  };
  const vmMismatchHarness = createBridgeVm({
    axTrusted: true,
    axWindows: { [pid]: [axOriginZeroWin] },
    cgWindows: [
      {
        kCGWindowOwnerPID: pid,
        kCGWindowNumber: wid,
        kCGWindowLayer: 0,
        kCGWindowAlpha: 1,
        kCGWindowIsOnscreen: true,
        kCGWindowName: "饮食日记 -智能体 - 灵珠平台",
        kCGWindowBounds: { X: 22, Y: 33, Width: 1280, Height: 828 },
      },
    ],
    hitTestFn: (sx, sy) => (Math.abs(sx - 800) <= 2 && Math.abs(sy - 599) <= 2 ? axOriginBtn : null),
  });
  const mismatchBoundsClick = vmMismatchHarness.sandbox.handleWindowClick({
    pid,
    wid,
    elementIndex: "177",
    elementMeta: {
      role: "button",
      rawText: "",
      bounds: { x: 794, y: 593, w: 12, h: 12 },
      windowId: wid,
    },
    windowTitle: "饮食日记 -智能体 - 灵珠平台 - Microsoft Edge",
  });
  assert.equal(mismatchBoundsClick.delivered, true);
  assert.equal(mismatchBoundsClick.localX, 800);
  assert.equal(mismatchBoundsClick.localY, 599);
  assert.equal(vmMismatchHarness.postedMouseLocations[0].x, 822);
  assert.equal(vmMismatchHarness.postedMouseLocations[0].y, 632);

  // (c) handlePressActionTarget climbs from varText -> varInnerGroup -> varHeaderGroup (AXPress)
  const pressRes = vmHarness.sandbox.handlePressActionTarget({
    pid,
    wid,
    localPoint: { x: 475, y: 598 },
    windowTitle: "饮食日记 -智能体 - 灵珠平台 - Microsoft Edge",
  });
  assert.equal(pressRes.delivered, true);
  assert.equal(pressRes.method, "ax_press");
  assert.equal(pressRes.role, "AXGroup");
  assert.equal(vmHarness.performedActions.length, 1);
  assert.equal(vmHarness.performedActions[0].el, varHeaderGroup);
  assert.equal(vmHarness.performedActions[0].action, "AXPress");

  // (d) Cross-window target is rejected cleanly before AXUIElementPerformAction
  const crossWinPress = vmHarness.sandbox.handlePressActionTarget({
    pid,
    wid,
    localPoint: { x: 977, y: 966 }, // screen (999, 999)
    windowTitle: "饮食日记 -智能体 - 灵珠平台 - Microsoft Edge",
  });
  assert.equal(crossWinPress.delivered, false);
  assert.equal(vmHarness.performedActions.length, 1);
});

test("6. executeActClick uses axBridge.pressActionTarget on Chromium when resolvedTarget.hasAxPress === true", async () => {
  const registry = new AppSnapshotRegistry();
  registry.recordMeta(
    "com.microsoft.edgemac",
    {
      pid: 74661,
      bundleId: "com.microsoft.edgemac",
      appDisplayName: "Microsoft Edge",
      windowId: 10937,
      windowTitle: "饮食日记 -智能体 - 灵珠平台 - Microsoft Edge",
      windowBounds: { x: 22, y: 33, w: 1280, h: 828 },
      windowCount: 1,
      singleWindowProven: true,
      peerInstanceId: "peer-1",
    },
    {
      fromActionPeer: true,
      includeAx: true,
      includeScreenshot: true,
      actionDims: { width: 1280, height: 828 },
      processToken: "74661:edge1",
    }
  );

  const pressCalls = [];
  let windowClickCalls = 0;
  let peerClickCalls = 0;

  const exec = new BackgroundActionExecutor({
    actionPeer: {
      agentInstanceId: "peer-1",
      async callTool() {
        peerClickCalls += 1;
        return { isError: false, content: [{ type: "text", text: "ok" }] };
      },
    },
    axBridge: {
      enabled: true,
      async checkPermissions() {
        return { accessibility: true, screenRecording: true };
      },
      async pressActionTarget(pid, opts) {
        pressCalls.push({ pid, opts });
        return { delivered: true, verified: false, deliveryState: "delivered", method: "ax_press", wid: 10937 };
      },
    },
    desktopHelperClient: {
      available: true,
      async getFocusedWindow() {
        return {
          wid: 10937,
          title: "饮食日记 -智能体 - 灵珠平台",
          windowBounds: { x: 22, y: 33, w: 1280, h: 828 },
          windowIds: [10937],
        };
      },
    },
    focusPolicyGuard: new FocusPolicyGuard({
      resolveTargetInfo: () => ({
        appQuery: "Microsoft Edge",
        pid: 74661,
        bundleId: "com.microsoft.edgemac",
        appDisplayName: "Microsoft Edge",
      }),
    }),
    registry,
    windowClickFn: async () => {
      windowClickCalls += 1;
      return { delivered: true, method: "window_post" };
    },
  });

  const actOut = await exec.executeActClick({
    app: "Microsoft Edge",
    pid: 74661,
    meta: registry.getMeta("com.microsoft.edgemac"),
    match: { index: 1001384, role: "AXStaticText", value: "变量", bounds: { x: 461, y: 588, w: 29, h: 20 }, window_id: 10937 },
    resolvedTarget: {
      resolved: true,
      wid: 10937,
      hasAxPress: true,
      role: "AXGroup",
      localBounds: { x: 437, y: 578, w: 351, h: 40 },
      centerLocalPoint: { x: 612.5, y: 598 },
      windowBounds: { x: 22, y: 33, w: 1280, h: 828 },
      reason: "ax_card",
    },
    targetWindowId: 10937,
    windowTitle: "饮食日记 -智能体 - 灵珠平台 - Microsoft Edge",
  });

  assert.equal(actOut.delivered, true);
  assert.equal(actOut.routeKey, "click:accessibility");
  assert.equal(pressCalls.length, 1);
  assert.equal(pressCalls[0].pid, 74661);
  assert.equal(pressCalls[0].opts.wid, 10937);
  assert.equal(windowClickCalls, 0);
  assert.equal(peerClickCalls, 0);
});

test("7. Bug #1: AXPress error codes classify sent_unknown vs not_sent and executeActClick never double-clicks on sent_unknown", async () => {
  const pid = 74661;
  const wid = 10937;
  const axWin = {
    kind: "win",
    wid,
    role: "AXWindow",
    title: "Test - Microsoft Edge",
    bounds: { x: 0, y: 0, w: 1280, h: 828 },
    children: [],
  };
  const btn = {
    role: "AXButton",
    bounds: { x: 100, y: 100, w: 80, h: 32 },
    winEl: axWin,
    parent: axWin,
    actions: ["AXPress"],
  };
  axWin.children = [btn];

  let nextErrCode = -25204;
  const vmErr = createBridgeVm({
    axTrusted: true,
    axWindows: { [pid]: [axWin] },
    cgWindows: [
      {
        kCGWindowOwnerPID: pid,
        kCGWindowNumber: wid,
        kCGWindowLayer: 0,
        kCGWindowAlpha: 1,
        kCGWindowIsOnscreen: true,
        kCGWindowName: "Test",
        kCGWindowBounds: { X: 0, Y: 0, Width: 1280, Height: 828 },
      },
    ],
    hitTestFn: () => btn,
    onPerformAction: () => nextErrCode,
  });

  // Ambiguous IPC/runtime errors (-25204 kAXErrorCannotComplete, -25200 kAXErrorFailure) -> sent_unknown
  nextErrCode = -25204;
  const cannotCompleteRes = vmErr.sandbox.handlePressActionTarget({ pid, wid, localPoint: { x: 140, y: 116 } });
  assert.equal(cannotCompleteRes.delivered, false);
  assert.equal(cannotCompleteRes.deliveryState, "sent_unknown");
  assert.equal(cannotCompleteRes.reason, "ax_cannot_complete");
  assert.equal(cannotCompleteRes.code, -25204);

  nextErrCode = -25200;
  const failureRes = vmErr.sandbox.handlePressActionTarget({ pid, wid, localPoint: { x: 140, y: 116 } });
  assert.equal(failureRes.delivered, false);
  assert.equal(failureRes.deliveryState, "sent_unknown");
  assert.equal(failureRes.reason, "ax_outcome_unknown");

  // Definite not-sent codes (-25206 unsupported, -25202 invalid element, -25211 API disabled) -> not_sent
  for (const [code, expectedReason] of [
    [-25206, "ax_action_unsupported"],
    [-25202, "element_destroyed_in_background"],
    [-25211, "jxa_accessibility_untrusted"],
  ]) {
    nextErrCode = code;
    const res = vmErr.sandbox.handlePressActionTarget({ pid, wid, localPoint: { x: 140, y: 116 } });
    assert.equal(res.delivered, false);
    assert.equal(res.deliveryState, "not_sent");
    assert.equal(res.reason, expectedReason);
    assert.equal(res.code, code);
  }

  // executeActClick must NOT fall back to windowClickFn or actionPeer on sent_unknown,
  // and must fall back cleanly to windowClickFn once on definite not_sent (ax_action_unsupported).
  const registry = new AppSnapshotRegistry();
  registry.recordMeta(
    "com.microsoft.edgemac",
    {
      pid,
      bundleId: "com.microsoft.edgemac",
      appDisplayName: "Microsoft Edge",
      windowId: wid,
      windowTitle: "Test - Microsoft Edge",
      windowBounds: { x: 0, y: 0, w: 1280, h: 828 },
      windowCount: 1,
      singleWindowProven: true,
      peerInstanceId: "peer-1",
    },
    {
      fromActionPeer: true,
      includeAx: true,
      includeScreenshot: true,
      actionDims: { width: 1280, height: 828 },
      processToken: `${pid}:e1`,
    }
  );

  let mode = "unknown";
  let windowClickCalls = 0;
  let peerClickCalls = 0;
  const exec = new BackgroundActionExecutor({
    actionPeer: {
      agentInstanceId: "peer-1",
      async callTool() {
        peerClickCalls += 1;
        return { isError: false, content: [{ type: "text", text: "ok" }] };
      },
    },
    axBridge: {
      enabled: true,
      async checkPermissions() {
        return { accessibility: true, screenRecording: true };
      },
      async pressActionTarget() {
        if (mode === "unknown") {
          const err = new Error("PersistentAxBridge partial press delivery (ax_cannot_complete)");
          err.code = "WRITE_OUTCOME_UNKNOWN";
          err.deliveryState = "sent_unknown";
          err.dispatched = true;
          throw err;
        }
        if (mode === "mismatch") {
          return { delivered: false, deliveryState: "not_sent", reason: "element_window_mismatch" };
        }
        if (mode === "destroyed") {
          return { delivered: false, deliveryState: "not_sent", reason: "element_destroyed_in_background" };
        }
        return { delivered: false, deliveryState: "not_sent", reason: "ax_action_unsupported", code: -25206 };
      },
    },
    desktopHelperClient: {
      available: true,
      async getFocusedWindow() {
        return { wid, title: "Test", windowBounds: { x: 0, y: 0, w: 1280, h: 828 }, windowIds: [wid] };
      },
    },
    focusPolicyGuard: new FocusPolicyGuard({
      resolveTargetInfo: () => ({
        appQuery: "Microsoft Edge",
        pid,
        bundleId: "com.microsoft.edgemac",
        appDisplayName: "Microsoft Edge",
      }),
    }),
    registry,
    windowClickFn: async () => {
      windowClickCalls += 1;
      return { delivered: true, method: "window_post", wid };
    },
  });

  const baseActArgs = {
    app: "Microsoft Edge",
    pid,
    meta: registry.getMeta("com.microsoft.edgemac"),
    match: { index: 1, role: "AXButton", bounds: { x: 100, y: 100, w: 80, h: 32 }, window_id: wid },
    resolvedTarget: {
      resolved: true,
      wid,
      hasAxPress: true,
      pressTargetId: "rt_1",
      role: "AXButton",
      localBounds: { x: 100, y: 100, w: 80, h: 32 },
      centerLocalPoint: { x: 140, y: 116 },
      windowBounds: { x: 0, y: 0, w: 1280, h: 828 },
    },
    targetWindowId: wid,
    windowTitle: "Test - Microsoft Edge",
  };

  // (a) sent_unknown throws TakeoverAbortedError(WRITE_OUTCOME_UNKNOWN) and never triggers fallback click
  mode = "unknown";
  await assert.rejects(
    () => exec.executeActClick(baseActArgs),
    (err) => err?.code === "WRITE_OUTCOME_UNKNOWN" && err?.deliveryState === "sent_unknown"
  );
  assert.equal(windowClickCalls, 0);
  assert.equal(peerClickCalls, 0);

  // (b) element_window_mismatch & element_destroyed_in_background fail closed with 0 fallback clicks
  for (const failMode of ["mismatch", "destroyed"]) {
    mode = failMode;
    const res = await exec.executeActClick(baseActArgs);
    assert.equal(res.delivered, false);
    assert.equal(res.clicksSent, 0);
    assert.equal(windowClickCalls, 0);
    assert.equal(peerClickCalls, 0);
  }

  // (c) ax_action_unsupported (not_sent) falls back cleanly to window_post once
  mode = "unsupported";
  const fallbackRes = await exec.executeActClick(baseActArgs);
  assert.equal(fallbackRes.delivered, true);
  assert.equal(fallbackRes.routeKey, "click:window_post");
  assert.equal(windowClickCalls, 1);
  assert.equal(peerClickCalls, 0);
});

test("8. Bug #3: prep budget expiry in handlePressActionTarget & handleWindowClick fails closed as not_sent without firing writes", () => {
  const pid = 74661;
  const wid = 10937;
  const axWin = {
    kind: "win",
    wid,
    role: "AXWindow",
    title: "Budget - Microsoft Edge",
    bounds: { x: 0, y: 0, w: 1280, h: 828 },
    children: [],
  };
  const btn = {
    role: "AXButton",
    bounds: { x: 100, y: 100, w: 80, h: 32 },
    winEl: axWin,
    parent: axWin,
    actions: ["AXPress"],
  };
  axWin.children = [btn];

  let clock = 100;
  const vmBudget = createBridgeVm({
    axTrusted: true,
    axWindows: { [pid]: [axWin] },
    cgWindows: [
      {
        kCGWindowOwnerPID: pid,
        kCGWindowNumber: wid,
        kCGWindowLayer: 0,
        kCGWindowAlpha: 1,
        kCGWindowIsOnscreen: true,
        kCGWindowName: "Budget",
        kCGWindowBounds: { X: 0, Y: 0, Width: 1280, Height: 828 },
      },
    ],
    getSystemUptime: () => {
      const cur = clock;
      clock += 1.2;
      return cur;
    },
    hitTestFn: () => btn,
  });

  const pressTimeout = vmBudget.sandbox.handlePressActionTarget({
    pid,
    wid,
    localPoint: { x: 140, y: 116 },
  });
  assert.equal(pressTimeout.delivered, false);
  assert.equal(pressTimeout.deliveryState, "not_sent");
  assert.equal(pressTimeout.reason, "prep_budget_exceeded");
  assert.equal(vmBudget.performedActions.length, 0);

  clock = 200;
  const clickTimeout = vmBudget.sandbox.handleWindowClick({
    pid,
    wid,
    localPoint: { x: 140, y: 116 },
  });
  assert.equal(clickTimeout.delivered, false);
  assert.equal(clickTimeout.deliveryState, "not_sent");
  assert.equal(clickTimeout.reason, "prep_budget_exceeded");
  assert.equal(vmBudget.postedMouseLocations.length, 0);
});

test("9. Bug #4: Oversized AXPress containers & AXWebArea are rejected consistently, while pressTargetId caches and re-verifies live handles", () => {
  const pid = 74661;
  const wid = 10937;
  const axWin = {
    kind: "win",
    wid,
    role: "AXWindow",
    title: "Container - Microsoft Edge",
    bounds: { x: 0, y: 0, w: 1280, h: 828 },
    children: [],
  };
  const oversizedGroup = {
    role: "AXGroup",
    bounds: { x: 20, y: 40, w: 1200, h: 760 },
    winEl: axWin,
    parent: axWin,
    actions: ["AXPress"],
  };
  const midPanelGroup = {
    role: "AXGroup",
    bounds: { x: 20, y: 40, w: 900, h: 650 }, // >50% of 1280x828 when climbed as ancestor
    winEl: axWin,
    parent: axWin,
    actions: ["AXPress"],
  };
  const webArea = {
    role: "AXWebArea",
    bounds: { x: 20, y: 80, w: 600, h: 400 },
    winEl: axWin,
    parent: axWin,
    actions: ["AXPress"],
  };
  const leafInOversized = {
    role: "AXStaticText",
    bounds: { x: 200, y: 200, w: 80, h: 20 },
    winEl: axWin,
    parent: oversizedGroup,
  };
  const leafInMidPanel = {
    role: "AXStaticText",
    bounds: { x: 200, y: 260, w: 80, h: 20 },
    winEl: axWin,
    parent: midPanelGroup,
  };
  const cardGroup = {
    role: "AXGroup",
    bounds: { x: 400, y: 500, w: 240, h: 44 },
    winEl: axWin,
    parent: axWin,
    actions: ["AXPress"],
  };
  const cardLeaf = {
    role: "AXStaticText",
    bounds: { x: 420, y: 512, w: 80, h: 20 },
    winEl: axWin,
    parent: cardGroup,
  };

  let hitTarget = leafInOversized;
  const vmContainer = createBridgeVm({
    axTrusted: true,
    axWindows: { [pid]: [axWin] },
    cgWindows: [
      {
        kCGWindowOwnerPID: pid,
        kCGWindowNumber: wid,
        kCGWindowLayer: 0,
        kCGWindowAlpha: 1,
        kCGWindowIsOnscreen: true,
        kCGWindowName: "Container",
        kCGWindowBounds: { X: 0, Y: 0, Width: 1280, Height: 828 },
      },
    ],
    hitTestFn: () => hitTarget,
  });

  for (const target of [leafInOversized, leafInMidPanel, webArea]) {
    hitTarget = target;
    const resolved = vmContainer.sandbox.handleResolveActionTarget({ pid, wid, localPoint: { x: 220, y: 210 } });
    assert.equal(resolved.hasAxPress, false);
    assert.equal(resolved.pressTargetId, null);

    const pressed = vmContainer.sandbox.handlePressActionTarget({ pid, wid, localPoint: { x: 220, y: 210 } });
    assert.equal(pressed.delivered, false);
    assert.equal(pressed.deliveryState, "not_sent");
    assert.equal(pressed.reason, "ax_press_target_oversized");
  }
  assert.equal(vmContainer.performedActions.length, 0);

  // Valid card resolves with pressTargetId; pressActionTarget uses that exact cached handle even if hitTestFn is null
  hitTarget = cardLeaf;
  const resolvedCard = vmContainer.sandbox.handleResolveActionTarget({ pid, wid, localPoint: { x: 460, y: 522 } });
  assert.equal(resolvedCard.hasAxPress, true);
  assert.ok(resolvedCard.pressTargetId);

  hitTarget = null;
  const cachedPress = vmContainer.sandbox.handlePressActionTarget({
    pid,
    wid,
    pressTargetId: resolvedCard.pressTargetId,
  });
  assert.equal(cachedPress.delivered, true);
  assert.equal(vmContainer.performedActions.length, 1);
  assert.equal(vmContainer.performedActions[0].el, cardGroup);

  // If the cached handle is destroyed before press, fail closed without re-probing stale coordinates
  cardGroup.destroyed = true;
  const destroyedPress = vmContainer.sandbox.handlePressActionTarget({
    pid,
    wid,
    pressTargetId: resolvedCard.pressTargetId,
    localPoint: { x: 460, y: 522 },
  });
  assert.equal(destroyedPress.delivered, false);
  assert.equal(destroyedPress.deliveryState, "not_sent");
  assert.equal(destroyedPress.reason, "element_destroyed_in_background");
  assert.equal(vmContainer.performedActions.length, 1);
});

test("10. Bug #5 & shared browser suffix regex: non-Chromium explicit accessibility ordering, FocusPolicyGuard.planActClick, and JXA title suffix matching", async () => {
  // Non-Chromium app with sky_click blocked must keep window_post & app_post ahead of accessibility
  assert.deepEqual(
    planBackgroundClickMethods(
      { app: "剪映专业版", element_index: "81", click_method: "accessibility" },
      { blockedMethods: ["sky_click"] }
    ),
    ["window_post", "app_post", "accessibility"]
  );

  // planActClickMethods on Chromium vs non-Chromium
  assert.deepEqual(
    planActClickMethods(
      { mouseButton: "left", clickCount: 1, hasAxPress: true },
      { preferAccessibility: true, windowPostAvailable: true, blockedMethods: [] }
    ),
    ["accessibility", "window_post", "sky_click", "app_post"]
  );
  assert.deepEqual(
    planActClickMethods(
      { mouseButton: "left", clickCount: 1, hasAxPress: true },
      { preferAccessibility: false, windowPostAvailable: true, blockedMethods: [] }
    ),
    ["window_post", "sky_click", "app_post"]
  );

  // executeActClick skips pressActionTarget once click:accessibility steals focus on Chromium
  const pid = 74661;
  const wid = 10937;
  const registry = new AppSnapshotRegistry();
  registry.recordMeta(
    "com.microsoft.edgemac",
    {
      pid,
      bundleId: "com.microsoft.edgemac",
      appDisplayName: "Microsoft Edge",
      windowId: wid,
      windowTitle: "Test - Microsoft Edge",
      windowBounds: { x: 0, y: 0, w: 1280, h: 828 },
      windowCount: 1,
      singleWindowProven: true,
      peerInstanceId: "peer-1",
    },
    { fromActionPeer: true, includeAx: true, includeScreenshot: true, actionDims: { width: 1280, height: 828 } }
  );
  const guard = new FocusPolicyGuard({
    resolveTargetInfo: () => ({
      appQuery: "Microsoft Edge",
      pid,
      bundleId: "com.microsoft.edgemac",
      appDisplayName: "Microsoft Edge",
    }),
  });
  const edgeScope = { pid, windowId: wid };
  guard.recordSteal("Microsoft Edge", "click:accessibility", { routeScope: edgeScope });

  let pressCalled = 0;
  let winClickCalled = 0;
  const exec = new BackgroundActionExecutor({
    actionPeer: { agentInstanceId: "peer-1", async callTool() { return { isError: false }; } },
    axBridge: {
      enabled: true,
      async checkPermissions() {
        return { accessibility: true, screenRecording: true };
      },
      async pressActionTarget() {
        pressCalled += 1;
        return { delivered: true, deliveryState: "delivered" };
      },
    },
    desktopHelperClient: {
      available: true,
      async getFocusedWindow() {
        return { wid, title: "Test", windowBounds: { x: 0, y: 0, w: 1280, h: 828 }, windowIds: [wid] };
      },
    },
    focusPolicyGuard: guard,
    registry,
    windowClickFn: async () => {
      winClickCalled += 1;
      return { delivered: true, method: "window_post", wid };
    },
  });

  const resAfterSteal = await exec.executeActClick({
    app: "Microsoft Edge",
    pid,
    meta: registry.getMeta("com.microsoft.edgemac"),
    match: { index: 1, role: "AXButton", bounds: { x: 100, y: 100, w: 80, h: 32 }, window_id: wid },
    resolvedTarget: {
      resolved: true,
      wid,
      hasAxPress: true,
      localBounds: { x: 100, y: 100, w: 80, h: 32 },
      centerLocalPoint: { x: 140, y: 116 },
      windowBounds: { x: 0, y: 0, w: 1280, h: 828 },
    },
    targetWindowId: wid,
    windowTitle: "Test - Microsoft Edge",
  });
  assert.equal(resAfterSteal.delivered, true);
  assert.equal(resAfterSteal.routeKey, "click:window_post");
  assert.equal(pressCalled, 0);
  assert.equal(winClickCalled, 1);

  // Shared browser title suffix pattern in BRIDGE_JXA_SOURCE & selectTargetWindow suffix match
  assert.equal(BRIDGE_JXA_SOURCE.includes(JSON.stringify(BROWSER_TITLE_SUFFIX_PATTERN)), true);
  const wOther = { kind: "win", wid: 1, role: "AXWindow", title: "其他标签页 - Microsoft Edge" };
  const wTarget = { kind: "win", wid: 2, role: "AXWindow", title: "饮食日记 - Microsoft Edge" };
  const vmTitle = createBridgeVm({ axWindows: { [pid]: [wOther, wTarget] } });
  const appEl = vmTitle.sandbox.createAppElement(pid, 0.5);
  const picked = vmTitle.sandbox.selectTargetWindow(appEl, "饮食日记", 0);
  assert.equal(picked, wTarget);
});
