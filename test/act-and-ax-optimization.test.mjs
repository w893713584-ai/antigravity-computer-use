import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

import {
  clipBoxIntersectionCenter,
  dedupeSpatiallyOverlappingMatches,
  screenshotPixelToWindowPoint,
  windowPointToScreenshotPixel,
} from "../src/action-executor.mjs";
import { AppSnapshotRegistry } from "../src/app-snapshot-registry.mjs";
import { BRIDGE_JXA_SOURCE, PersistentAxBridge } from "../src/ax-bridge.mjs";
import { ComputerUseBrokerServer } from "../src/broker-sidecar.mjs";
import { BrokerRpcClient } from "../src/broker-client.mjs";
import { parseSnapshotMetadata } from "../src/background-policy.mjs";
import { runJsonRpcStdioServer } from "../src/jsonrpc-stdio.mjs";

test("Slice 1 (P0): Reference-origin tiered validation preserves query bounds/windowId, avoids whole-tree bind blocks, and rejects only pinned stale refs", async () => {
  const bindCalls = [];
  let verifyMode = "not_retained";

  const fakeAxBridge = {
    enabled: true,
    async bindSnapshot(payload) {
      bindCalls.push(payload.snapshotId);
      return { bound: true, boundCount: payload.elements?.length || 0 };
    },
    async verifyLiveRef({ snapshotId }) {
      if (verifyMode === "not_retained") {
        return {
          ok: false,
          skipped: "snapshot_not_retained",
          reason: "snapshot_not_retained",
          message: `Snapshot ${snapshotId} is no longer retained in live AX memory.`,
        };
      }
      if (verifyMode === "not_bound") {
        return {
          ok: false,
          skipped: "element_not_bound",
          reason: "element_not_bound",
          message: `Element @${snapshotId}:15 is not affirmatively bound in live AX memory.`,
        };
      }
      if (verifyMode === "destroyed") {
        return {
          ok: false,
          reason: "element_destroyed_in_background",
          message: `Element @${snapshotId}:15 was destroyed asynchronously.`,
        };
      }
      return { ok: true, snapshotId };
    },
    async dropSnapshots() {
      return { ok: true };
    },
  };

  const registry = new AppSnapshotRegistry({ axBridge: fakeAxBridge });

  // 1a) Direct Registry check: ingestQueryMatches preserves bounds, windowId, origin="query"
  const qMerged = await registry.ingestQueryMatches(
    "com.lemon.lvpro",
    {
      window_id: 499,
      window_title: "剪映专业版",
      matches: [
        {
          index: 1000001,
          role: "AXStaticText",
          title: "HomePageDraftTitle:心理学男声_Ep1V3_Seg06",
          bounds: { x: 246, y: 693, w: 98, h: 21 },
        },
      ],
    },
    { queryPid: 14016 }
  );
  const qSnap = registry.getLatestSnapshot("com.lemon.lvpro");
  assert.equal(qSnap?.windowId, 499, "Snapshot must store window_id from query");
  const qEl = qSnap?.elements?.get("1000001");
  assert.equal(qEl?.origin, "query");
  assert.equal(qEl?.windowId, 499);
  assert.deepEqual(qEl?.bounds, { x: 246, y: 693, w: 98, h: 21 });

  // Unpinned query ref (1000001) must succeed even when JXA verifyLiveRef returns snapshot_not_retained!
  const unpinnedQueryCheck = await registry.validateTargetRef({
    app: "com.lemon.lvpro",
    parsedRef: { ok: true, hasElementRef: true, rawIndex: "1000001", snapshotId: null, displayRef: "1000001" },
  });
  assert.equal(unpinnedQueryCheck.ok, true, "Unpinned query ref must not fail on snapshot_not_retained");

  // 1b) Unpinned regular ref ("15") after get_app_state must succeed on snapshot_not_retained or element_not_bound,
  // while pinned "@s2:15" MUST still fail closed with STALE_REF!
  const snapMeta = parseSnapshotMetadata(
    [
      `App=com.lemon.lvpro (pid ${process.pid})`,
      'Window: "剪映专业版", App: 剪映专业版.',
      "\t15 文本 Description: HomePageDraftTitle:心理学男声_Ep1V3_Seg06",
    ].join("\n")
  );
  const s2Merged = registry.recordMeta("com.lemon.lvpro", snapMeta, {
    fromActionPeer: true,
    includeAx: true,
    includeScreenshot: true,
    actionDims: { width: 1280, height: 720 },
  });
  assert.equal(s2Merged.snapshotId, "s2");
  const snapEl = registry.getLatestSnapshot("com.lemon.lvpro")?.elements?.get("15");
  assert.equal(snapEl?.origin, "snapshot");

  verifyMode = "not_retained";
  const unpinnedRegCheck = await registry.validateTargetRef({
    app: "com.lemon.lvpro",
    parsedRef: { ok: true, hasElementRef: true, rawIndex: "15", snapshotId: null, displayRef: "15" },
  });
  assert.equal(unpinnedRegCheck.ok, true, "Unpinned regular ref must tolerate snapshot_not_retained when window intact");

  verifyMode = "not_bound";
  const unpinnedNotBound = await registry.validateTargetRef({
    app: "com.lemon.lvpro",
    parsedRef: { ok: true, hasElementRef: true, rawIndex: "15", snapshotId: null, displayRef: "15" },
  });
  assert.equal(unpinnedNotBound.ok, true, "Unpinned regular ref must tolerate element_not_bound");

  const pinnedFail = await registry.validateTargetRef({
    app: "com.lemon.lvpro",
    parsedRef: { ok: true, hasElementRef: true, rawIndex: "15", snapshotId: "s2", displayRef: "@s2:15" },
  });
  assert.equal(pinnedFail.ok, false, "Pinned @s2:15 must fail closed on element_not_bound");
  assert.equal(pinnedFail.errorCode, "STALE_REF");

  // 1c) Unpinned regular ref MUST still fail with STALE_REF on real background mutation
  verifyMode = "destroyed";
  const mutatedFail = await registry.validateTargetRef({
    app: "com.lemon.lvpro",
    parsedRef: { ok: true, hasElementRef: true, rawIndex: "15", snapshotId: null, displayRef: "15" },
  });
  assert.equal(mutatedFail.ok, false, "Unpinned ref must fail on affirmative element_destroyed_in_background");
  assert.equal(mutatedFail.errorCode, "STALE_REF");

  // Broker end-to-end check: query -> unpinned click(1000001) never triggers whole-tree bindSnapshot and succeeds
  const sock = path.join(tmpdir(), `cua-slice1-${process.pid}-${Date.now()}.sock`);
  const brokerBindCalls = [];
  const brokerPeer = {
    async listTools() {
      return { tools: [{ name: "list_apps" }, { name: "get_app_state" }, { name: "query" }, { name: "click" }] };
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
              text: [`App=com.lemon.lvpro (pid ${process.pid})`, 'Window: "剪映专业版", App: 剪映专业版.', "\t15 文本 Description: HomePageDraftTitle:心理学男声_Ep1V3_Seg06"].join("\n"),
            },
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
                window_id: 499,
                window_title: "剪映专业版",
                matches: [
                  {
                    index: 1000001,
                    role: "AXStaticText",
                    title: "HomePageDraftTitle:心理学男声_Ep1V3_Seg06",
                    bounds: { x: 246, y: 693, w: 98, h: 21 },
                  },
                ],
              }),
            },
          ],
        };
      }
      return { isError: false, content: [{ type: "text", text: `clicked:${args.element_index}` }] };
    },
    close() {},
  };

  const broker = new ComputerUseBrokerServer({
    webPort: 0,
    uiToken: "slice1-tok",
    socketPath: sock,
    actionPeer: brokerPeer,
    streamPeer: brokerPeer,
    axBridge: {
      enabled: true,
      async bindSnapshot(p) {
        brokerBindCalls.push(p.snapshotId);
        return { bound: true };
      },
      async verifyLiveRef({ snapshotId }) {
        return { ok: false, skipped: "snapshot_not_retained", reason: "snapshot_not_retained", snapshotId };
      },
      async ensureManualAccessibility() {
        return { supported: false, changed: false, enabled: false, definitive: true };
      },
      async getProcessInfo(pid) {
        return { alive: true, guiApp: true, pid, processToken: `${pid}:tok1` };
      },
      async dropSnapshots() {
        return { ok: true };
      },
    },
    focusController: {
      async getFrontmostApp() {
        return { pid: 900, bundleId: "com.google.antigravity", displayName: "Antigravity" };
      },
      async restoreFrontmostApp() {
        return true;
      },
      sweepDelaysMs: [],
    },
  });
  await broker.start();
  const client = new BrokerRpcClient({ socketPath: sock, enableFallback: false });
  try {
    const qRes = await client.request("tools/call", {
      name: "query",
      arguments: { app: "com.lemon.lvpro", text: "心理学男声_Ep1V3_Seg06" },
    });
    assert.equal(Boolean(qRes.isError), false);
    assert.equal(brokerBindCalls.length, 0, "High-index OCU query matches (>=1000000) must not trigger whole-tree JXA bindSnapshot");

    const clickRes = await client.request("tools/call", {
      name: "click",
      arguments: { app: "com.lemon.lvpro", element_index: "1000001" },
    });
    assert.equal(Boolean(clickRes.isError), false, "Click on fresh unpinned OCU query ref 1000001 must succeed");
  } finally {
    await client.close();
    await broker.close();
  }
});

test("Slice 2 (P1): Coordinate seam, JXA batched traversal (>420 nodes / >80 children), cooperative budget without worker kill, single-in-flight RPC queue, and WID owner + window_scroll", async () => {
  // 2a) Coordinate seam pure math check (independent worked examples)
  const shotPt = windowPointToScreenshotPixel(
    { x: 1046, y: 772 },
    { windowWidth: 1440, windowHeight: 810, imageWidth: 1280, imageHeight: 720 }
  );
  assert.ok(Math.abs(shotPt.x - 929.78) < 0.02, `Expected ~929.78, got ${shotPt.x}`);
  assert.ok(Math.abs(shotPt.y - 686.22) < 0.02, `Expected ~686.22, got ${shotPt.y}`);

  const backWinPt = screenshotPixelToWindowPoint(shotPt, {
    windowWidth: 1440,
    windowHeight: 810,
    imageWidth: 1280,
    imageHeight: 720,
  });
  assert.ok(Math.abs(backWinPt.x - 1046) < 0.05);
  assert.ok(Math.abs(backWinPt.y - 772) < 0.05);

  // Clip intersection center inside visible list container
  const clipped = clipBoxIntersectionCenter(
    { x: 246, y: 693, w: 98, h: 21 },
    { x: 200, y: 200, w: 400, h: 500 }
  );
  assert.ok(clipped.y <= 700 && clipped.y >= 693, "Clipped center must stay inside visible viewport y<=700");

  // 2b) VM JXA test: 800-node tree with 120 children under one parent + AXUIElementCopyMultipleAttributeValues + budget exhaustion
  const bigChildren = Array.from({ length: 120 }, (_, idx) => ({
    role: "AXButton",
    roleDesc: "button",
    id: `row_${idx}`,
    title: `Draft_${idx}`,
    desc: "",
    help: "",
    bounds: { x: -700, y: 150 + idx * 4, w: 80, h: 20 },
    children:
      idx === 115
        ? Array.from({ length: 685 }, (_x, j) => ({
            role: "AXStaticText",
            roleDesc: "text",
            id: `leaf_${j}`,
            title: j === 680 ? "DeepTargetLeaf" : `Item_${j}`,
            desc: "",
            help: "",
            bounds: { x: -700, y: 610, w: 80, h: 20 },
            children: [],
          }))
        : [],
  }));
  const fakeWin = {
    role: "AXWindow",
    roleDesc: "standard window",
    id: "main_win",
    title: "剪映专业版",
    desc: "",
    help: "",
    bounds: { x: -800, y: 120, w: 1440, h: 810 },
    children: bigChildren,
  };

  let axIpcCalls = 0;
  let hitTestElementAtPoint = null;
  let fakeClockSec = 100.0;
  let advancePerBatch = 0;
  const postedMouseEvents = [];
  const postedWheelEvents = [];
  const nsArrayWrap = (arr) => ({
    count: arr.length,
    objectAtIndex: (i) => arr[i],
    isKindOfClass: (cls) => cls === "NSArray",
    isNil: () => false,
  });
  const nsStrWrap = (s) => ({
    __val: String(s),
    isKindOfClass: (cls) => cls === "NSString",
    isNil: () => false,
  });

  const sandbox = {
    ObjC: {
      import() {},
      bindFunction() {},
      unwrap(v) {
        return v && v.__val !== undefined ? v.__val : v;
      },
      castRefToObject(r) {
        return r;
      },
      deepUnwrap(v) {
        return v;
      },
    },
    Ref: () => [null],
    $: Object.assign((s) => nsStrWrap(s), {
      NSString: { class: "NSString" },
      NSArray: {
        class: "NSArray",
        arrayWithArray: (a) => a,
      },
      kCFRunLoopDefaultMode: "kCFRunLoopDefaultMode",
      CFRelease() {},
      CFRunLoopRunInMode() {},
      CFCopyDescription(v) {
        return nsStrWrap(v.__desc || "");
      },
      AXUIElementCreateSystemWide: () => ({ role: "AXSystemWide" }),
      AXUIElementCreateApplication: () => ({ role: "AXApplication", mainWin: fakeWin }),
      AXUIElementSetMessagingTimeout: () => 0,
      AXUIElementCopyMultipleAttributeValues: (el, attrs, _flags, out) => {
        axIpcCalls += 1;
        fakeClockSec += advancePerBatch;
        const arr = [];
        for (let i = 0; i < attrs.length; i++) {
          const name = attrs[i].__val || attrs[i];
          if (name === "AXRole") arr.push(el.role ? nsStrWrap(el.role) : { isNil: () => false, isKindOfClass: () => false });
          else if (name === "AXRoleDescription") arr.push(el.roleDesc ? nsStrWrap(el.roleDesc) : { isNil: () => false, isKindOfClass: () => false });
          else if (name === "AXIdentifier") arr.push(el.id ? nsStrWrap(el.id) : { isNil: () => false, isKindOfClass: () => false });
          else if (name === "AXTitle") arr.push(el.title ? nsStrWrap(el.title) : { isNil: () => false, isKindOfClass: () => false });
          else if (name === "AXDescription") arr.push(el.desc ? nsStrWrap(el.desc) : { isNil: () => false, isKindOfClass: () => false });
          else if (name === "AXHelp") arr.push(el.help ? nsStrWrap(el.help) : { isNil: () => false, isKindOfClass: () => false });
          else if (name === "AXChildren") arr.push(el.children ? nsArrayWrap(el.children) : { isNil: () => false, isKindOfClass: () => false });
          else arr.push({ isNil: () => false, isKindOfClass: () => false });
        }
        out[0] = nsArrayWrap(arr);
        return 0;
      },
      AXUIElementCopyAttributeValue: (el, attr, out) => {
        axIpcCalls += 1;
        const key = attr?.__val || attr;
        if (key === "AXMainWindow" || key === "AXFocusedWindow") {
          out[0] = el.mainWin || fakeWin;
          return 0;
        }
        if (key === "AXWindows") {
          out[0] = nsArrayWrap([fakeWin]);
          return 0;
        }
        if (key === "AXChildren") {
          out[0] = el.children && el.children.length > 0 ? nsArrayWrap(el.children) : null;
          return el.children && el.children.length > 0 ? 0 : -25212;
        }
        if (key === "AXParent") {
          out[0] = el.parent || null;
          return el.parent ? 0 : -25212;
        }
        if (key === "AXTitle") {
          out[0] = el.title ? nsStrWrap(el.title) : null;
          return el.title ? 0 : -25212;
        }
        if (key === "AXRole") {
          out[0] = el.role ? nsStrWrap(el.role) : null;
          return el.role ? 0 : -25212;
        }
        if (key === "AXPosition" && el.bounds) {
          out[0] = { __desc: `{value = CGPoint: {x: ${el.bounds.x}, y: ${el.bounds.y}}}` };
          return 0;
        }
        if (key === "AXSize" && el.bounds) {
          out[0] = { __desc: `{value = CGSize: {w: ${el.bounds.w}, h: ${el.bounds.h}}}` };
          return 0;
        }
        return -25212;
      },
      AXUIElementCopyActionNames: (el, out) => {
        out[0] = nsArrayWrap((el.actions || []).map((a) => nsStrWrap(a)));
        return 0;
      },
      AXUIElementCopyElementAtPosition: (_app, x, y, out) => {
        if (hitTestElementAtPoint) {
          out[0] = hitTestElementAtPoint(x, y);
          return out[0] ? 0 : -25212;
        }
        return -25212;
      },
      AXIsProcessTrusted: () => true,
      NSBundle: { bundleWithPath: () => ({ load: true }) },
      NSProcessInfo: {
        processInfo: {
          get systemUptime() {
            return fakeClockSec;
          },
        },
      },
      NSThread: { sleepForTimeInterval() {} },
      NSFileHandle: {
        fileHandleWithStandardInput: { availableData: { length: 0 } },
        fileHandleWithStandardOutput: { writeData() {} },
      },
      CGWindowListCopyWindowInfo: () => [
        { kCGWindowNumber: 77, kCGWindowOwnerPID: 1234, kCGWindowLayer: 0, kCGWindowAlpha: 1, kCGWindowName: "剪映专业版", kCGWindowBounds: { X: -800, Y: 120, Width: 1440, Height: 810 } },
        { kCGWindowNumber: 88, kCGWindowOwnerPID: 9999, kCGWindowLayer: 0, kCGWindowAlpha: 1, kCGWindowName: "OtherApp", kCGWindowBounds: { X: 0, Y: 0, Width: 1200, Height: 800 } },
      ],
      CGEventSourceCreate: () => ({}),
      CGEventCreateMouseEvent: (_src, evType, pt, btn) => ({ kind: "mouse", evType, x: pt.x, y: pt.y, btn, fields: {} }),
      CGEventCreateScrollWheelEvent2: (_src, units, wheelCount, w1, w2) => ({ kind: "wheel", units, wheelCount, w1, w2, x: 0, y: 0, fields: {} }),
      CGEventSetLocation: (ev, pt) => { ev.x = pt.x; ev.y = pt.y; },
      CGEventSetTimestamp() {},
      CGEventSetIntegerValueField: (ev, f, v) => { ev.fields[f] = v; },
      CGEventSetDoubleValueField() {},
      CGEventSetWindowLocation: (ev, lx, ly) => { ev.localX = lx; ev.localY = ly; },
      SLEventSetIntegerValueField: (ev, f, v) => { ev.sl = ev.sl || {}; ev.sl[f] = v; },
      SLEventPostToPid: (pid, ev) => {
        if (ev.kind === "wheel") postedWheelEvents.push({ pid, ev });
        else if (ev.evType === 1) postedMouseEvents.push({ pid, ev });
      },
      CGEventPostToPid() {},
      kCGMouseEventClickState: 1,
      kCGMouseEventButtonNumber: 3,
    }),
  };
  vm.createContext(sandbox);
  vm.runInContext(BRIDGE_JXA_SOURCE, sandbox);

  axIpcCalls = 0;
  const bindRes = sandbox.handleBindSnapshot({
    snapshotId: "s_big",
    pid: 1234,
    windowTitle: "剪映专业版",
    elements: [
      { index: "115", role: "button", identifier: "row_115", rawText: "Draft_115" },
      { index: "799", role: "text", identifier: "leaf_680", rawText: "DeepTargetLeaf" },
    ],
  });
  assert.equal(bindRes.bound, true);
  assert.equal(bindRes.boundCount, 2, "Must traverse >80 children and >420 nodes to bind row_115 & deep leaf_680");
  assert.ok(axIpcCalls < 800 * 2.2, `Batched traversal must cut AX IPC >=70% vs naive 8*N, got ${axIpcCalls}`);

  // Budget exhaustion returns incomplete:true without throwing and retains already-bound nodes
  advancePerBatch = 0.05;
  const partialRes = sandbox.handleBindSnapshot({
    snapshotId: "s_budget",
    pid: 1234,
    windowTitle: "剪映专业版",
    budgetSec: 0.4,
    elements: [{ index: "1", role: "button", identifier: "row_0", rawText: "Draft_0" }],
  });
  assert.equal(partialRes.bound, true);
  assert.equal(partialRes.incomplete, true, "Budget exhaustion must return incomplete:true gracefully");

  // Negative-origin secondary screen localPoint click & WID owner verification
  const clickNegOrigin = sandbox.handleWindowClick({
    pid: 1234,
    wid: 77,
    localPoint: { x: 1046, y: 772 },
    expectedWindowSize: { w: 1440, h: 810 },
  });
  assert.equal(clickNegOrigin.delivered, true);
  assert.equal(clickNegOrigin.localX, 1046);
  assert.equal(clickNegOrigin.localY, 772);
  assert.equal(postedMouseEvents[0].ev.x, 246, "screenX = -800 + 1046 = 246");
  assert.equal(postedMouseEvents[0].ev.y, 892, "screenY = 120 + 772 = 892");

  const wrongOwner = sandbox.handleWindowClick({
    pid: 1234,
    wid: 88, // Owned by pid 9999!
    windowBounds: { x: 0, y: 0, width: 1200, height: 800 },
    localPoint: { x: 100, y: 100 },
  });
  assert.equal(wrongOwner.delivered, false);
  assert.equal(wrongOwner.reason, "window_not_found");

  // handleWindowScroll sends pixel wheel with local + screen coords + WID
  const scrollRes = sandbox.handleWindowScroll({
    pid: 1234,
    wid: 77,
    localPoint: { x: 400, y: 500 },
    deltaY: -240,
    deltaX: 0,
  });
  assert.equal(scrollRes.delivered, true);
  assert.equal(postedWheelEvents.length, 1);
  assert.equal(postedWheelEvents[0].ev.w1, -240);
  assert.equal(postedWheelEvents[0].ev.x, -400);
  assert.equal(postedWheelEvents[0].ev.y, 620);
  assert.equal(postedWheelEvents[0].ev.sl[51], 77);

  // Vanished WID (not present in populated CGWindowListCopyWindowInfo) rejects stale windowBounds
  const vanishedWid = sandbox.handleWindowClick({
    pid: 1234,
    wid: 999999,
    windowBounds: { x: 0, y: 0, width: 1200, height: 800 },
    localPoint: { x: 100, y: 100 },
  });
  assert.equal(vanishedWid.delivered, false);
  assert.equal(vanishedWid.reason, "window_not_found");

  // handleWindowClick prioritizes explicit localPoint + expectedWindowSize over elementIndex
  const resizeRejected = sandbox.handleWindowClick({
    pid: 1234,
    wid: 77,
    elementIndex: "999999",
    localPoint: { x: 100, y: 100 },
    expectedWindowSize: { w: 1280, h: 720 },
  });
  assert.equal(resizeRejected.delivered, false);
  assert.equal(resizeRejected.reason, "window_resized");

  // handleResolveActionTarget promotes AXStaticText leaf -> parent AXButton, and keeps hop-0 AXButton intact
  const outerGroup = {
    role: "AXGroup",
    bounds: { x: -750, y: 200, w: 400, h: 300 },
    actions: [],
    parent: null,
  };
  const cardBtn = {
    role: "AXButton",
    bounds: { x: -600, y: 300, w: 200, h: 140 },
    actions: ["AXPress"],
    parent: outerGroup,
  };
  const leafLabel = {
    role: "AXStaticText",
    bounds: { x: -580, y: 400, w: 160, h: 24 },
    actions: [],
    parent: cardBtn,
  };
  hitTestElementAtPoint = (_x, y) => (y > 490 ? leafLabel : cardBtn);

  const promoted = sandbox.handleResolveActionTarget({ pid: 1234, wid: 77, localPoint: { x: 300, y: 400 } });
  assert.equal(promoted.resolved, true);
  assert.equal(promoted.role, "AXButton");
  assert.equal(promoted.hops, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(promoted.localBounds)), { x: 200, y: 180, w: 200, h: 140 });
  assert.deepEqual(JSON.parse(JSON.stringify(promoted.centerLocalPoint)), { x: 300, y: 250 });

  const preservedHop0 = sandbox.handleResolveActionTarget({ pid: 1234, wid: 77, localPoint: { x: 300, y: 250 } });
  assert.equal(preservedHop0.resolved, true);
  assert.equal(preservedHop0.role, "AXButton");
  assert.equal(preservedHop0.hops, 0, "Hop-0 AXButton with AXPress must never be overwritten by enclosing AXGroup");

  // 2c) PersistentAxBridge single-in-flight queue: 120ms request 1 followed by 70ms-timeout request 2 -> BOTH resolve!
  const workers = [];
  const queuedBridge = new PersistentAxBridge({
    enabled: true,
    spawnFn() {
      const proc = new EventEmitter();
      proc.exitCode = null;
      proc.killed = false;
      proc.stdout = new PassThrough();
      proc.stderr = new PassThrough();
      proc.stdin = new Writable({
        write(chunk, _enc, cb) {
          const msg = JSON.parse(String(chunk).trim());
          const delay = msg.method === "slow_call" ? 110 : 5;
          setTimeout(() => {
            proc.stdout.write(`${JSON.stringify({ id: msg.id, ok: true, result: { echoed: msg.method } })}\n`);
          }, delay);
          cb();
        },
      });
      proc.kill = () => {};
      workers.push(proc);
      return proc;
    },
  });
  await queuedBridge.ensureStarted();
  const [slowOut, fastOut] = await Promise.all([
    queuedBridge.request("slow_call", {}, { timeoutMs: 300 }),
    queuedBridge.request("fast_call", {}, { timeoutMs: 70 }),
  ]);
  assert.equal(slowOut.echoed, "slow_call");
  assert.equal(fastOut.echoed, "fast_call", "Queued request timer must start on actual dispatch, not queue enqueue");
  assert.equal(workers.length, 1);
  await queuedBridge.close();
});

test("Slice 3 (P2): Atomic act tool (progressive scroll + overlap dedup + AXParent click + playback-proof expect), 100x playback control, and immediate disconnect cancellation", async () => {
  // Valid minimal 1x1 JPEG builder with distinct trailing bytes per frame so screenshot bytes change every frame
  const makeFrameBase64 = (seq) =>
    Buffer.concat([
      Buffer.from("ffd8ffe000104a46494600010100000100010000ffe1", "hex"),
      Buffer.from(`frame-${seq}`),
      Buffer.from("ffd9", "hex"),
    ]).toString("base64");

  let scrollStep = 0;
  let editorOpen = false;
  let frameSeq = 0;
  let scenario = "progressive_scroll"; // "progressive_scroll" | "ambiguous" | "inert_scroll" | "playback" | "slow_locate" | "slow_poll" | "truncated_locate" | "vanish_inconclusive"
  let clicksSent = 0;
  let lastClickPayload = null;
  let postClickStateReads = 0;
  const axScrollCalls = [];
  const windowScrollCalls = [];
  let slowLocateEntered = null;
  let slowLocateRelease = null;
  let slowPollEntered = null;
  let slowPollRelease = null;
  let queryCalls = 0;

  const sock = path.join(tmpdir(), `cua-slice3-${process.pid}-${Date.now()}.sock`);
  const fakePeer = {
    async listTools() {
      return {
        tools: [
          { name: "list_apps" },
          { name: "get_app_state" },
          { name: "query" },
          { name: "click", inputSchema: { properties: { click_method: { enum: ["sky_click"] } } } },
          { name: "scroll" },
        ],
      };
    },
    async callTool(name, args) {
      if (name === "list_apps") {
        return { isError: false, content: [{ type: "text", text: "剪映专业版 — com.lemon.lvpro [running]" }] };
      }
      if (name === "get_app_state") {
        frameSeq += 1;
        if (clicksSent > 0) postClickStateReads += 1;
        const lines = [
          `App=com.lemon.lvpro (pid ${process.pid})`,
          `Window: "${editorOpen ? "剪映专业版 - 编辑器" : "剪映专业版"}", App: 剪映专业版.`,
        ];
        if (scenario === "progressive_scroll" && !editorOpen) {
          lines.push(`\t10 按钮 列表视口页_${scrollStep} Title: 列表视口页_${scrollStep}`);
        }
        if (editorOpen) {
          lines.push("\t20 按钮 导出 Title: 导出");
        }
        if (scenario === "vanish_inconclusive" && clicksSent > 0) {
          return { isError: true, content: [{ type: "text", text: "state_read_failed" }] };
        }
        return {
          isError: false,
          content: [
            { type: "text", text: lines.join("\n") },
            { type: "image", data: makeFrameBase64(frameSeq), mimeType: "image/jpeg" },
          ],
        };
      }
      if (name === "query") {
        queryCalls += 1;
        if (scenario === "truncated_locate") {
          return {
            isError: false,
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  window_id: 501,
                  truncated: true,
                  matches: [
                    { index: 1000010, role: "AXButton", title: args?.text || "Target", bounds: { x: 200, y: 200, w: 80, h: 20 } },
                  ],
                }),
              },
            ],
          };
        }
        if (scenario === "vanish_inconclusive") {
          if (String(args?.text || "") === "弹窗") {
            return {
              isError: false,
              content: [{ type: "text", text: JSON.stringify({ window_id: 501, truncated: true, matches: [] }) }],
            };
          }
          return {
            isError: false,
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  window_id: 501,
                  matches: [
                    { index: 1000041, role: "AXButton", title: "关闭弹窗", bounds: { x: 200, y: 200, w: 80, h: 24 } },
                  ],
                }),
              },
            ],
          };
        }
        if (scenario === "slow_locate") {
          slowLocateEntered?.();
          if (slowLocateRelease) await slowLocateRelease;
          return {
            isError: false,
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  window_id: 501,
                  matches: [
                    { index: 1000010, role: "AXStaticText", title: args?.text || "Target", bounds: { x: 200, y: 200, w: 80, h: 20 } },
                  ],
                }),
              },
            ],
          };
        }
        if (scenario === "ambiguous") {
          return {
            isError: false,
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  window_id: 501,
                  matches: [
                    { index: 1000011, role: "AXButton", title: "心理学男声_Ep1V3_Seg06", bounds: { x: 100, y: 120, w: 180, h: 120 } },
                    { index: 1000012, role: "AXButton", title: "心理学男声_Ep1V3_Seg06", bounds: { x: 600, y: 420, w: 180, h: 120 } },
                  ],
                }),
              },
            ],
          };
        }
        if (scenario === "inert_scroll" || scenario === "playback") {
          if (args?.text === "导出完成弹窗") {
            return { isError: false, content: [{ type: "text", text: JSON.stringify({ window_id: 501, matches: [] }) }] };
          }
          if (scenario === "playback") {
            return {
              isError: false,
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    window_id: 501,
                    matches: [
                      { index: 1000021, role: "AXButton", title: "导出", bounds: { x: 1180, y: 20, w: 72, h: 28 } },
                    ],
                  }),
                },
              ],
            };
          }
          return { isError: false, content: [{ type: "text", text: JSON.stringify({ window_id: 501, matches: [] }) }] };
        }
        if (scenario === "slow_poll") {
          if (String(args?.text || "").includes("永不出现")) {
            slowPollEntered?.();
            if (slowPollRelease) await slowPollRelease;
            return { isError: false, content: [{ type: "text", text: JSON.stringify({ window_id: 501, matches: [] }) }] };
          }
          return {
            isError: false,
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  window_id: 501,
                  matches: [
                    { index: 1000031, role: "AXButton", title: "导出", bounds: { x: 400, y: 300, w: 80, h: 32 } },
                  ],
                }),
              },
            ],
          };
        }
        // progressive_scroll
        if (editorOpen && args?.text === "导出") {
          return {
            isError: false,
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  window_id: 501,
                  matches: [{ index: 1000099, role: "AXButton", title: "导出", bounds: { x: 1180, y: 20, w: 72, h: 28 } }],
                }),
              },
            ],
          };
        }
        if (scrollStep >= 2) {
          // Return overlapping parent AXButton card + child AXStaticText label
          return {
            isError: false,
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  window_id: 501,
                  matches: [
                    {
                      index: 1000001,
                      role: "AXButton",
                      title: "心理学男声_Ep1V3_Seg06",
                      bounds: { x: 220, y: 400, w: 200, h: 140 },
                    },
                    {
                      index: 1000002,
                      role: "AXStaticText",
                      title: "HomePageDraftTitle:心理学男声_Ep1V3_Seg06",
                      bounds: { x: 240, y: 500, w: 160, h: 24 },
                    },
                  ],
                }),
              },
            ],
          };
        }
        return { isError: false, content: [{ type: "text", text: JSON.stringify({ window_id: 501, matches: [] }) }] };
      }
      if (name === "scroll" || name === "click") {
        return { isError: false, content: [{ type: "text", text: "unexpected native fallback" }] };
      }
      return { isError: true, content: [{ type: "text", text: `unknown tool ${name}` }] };
    },
    close() {},
  };

  const fakeAxBridge = {
    enabled: true,
    async checkPermissions() {
      return { accessibility: true, screenRecording: true };
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
    async bindSnapshot({ elements }) {
      return { bound: true, boundCount: elements?.length || 0 };
    },
    async verifyLiveRef({ snapshotId }) {
      return { ok: true, snapshotId };
    },
    async scroll(pid, opts) {
      axScrollCalls.push({ pid, opts });
      return { delivered: false, verified: false, reason: "no_scrollbar" };
    },
    async postWindowScroll(pid, opts) {
      if (scenario === "progressive_scroll") {
        scrollStep += 1;
      }
      windowScrollCalls.push({ pid, opts });
      return { delivered: true, verified: false, method: "window_post_scroll", wid: 501 };
    },
    async resolveActionTarget(_pid, opts) {
      return {
        resolved: true,
        wid: 501,
        windowTitle: editorOpen ? "剪映专业版 - 编辑器" : "剪映专业版",
        windowBounds: { x: 0, y: 0, w: 1280, h: 720 },
        role: "AXButton",
        hasAxPress: true,
        hops: 1,
        localBounds: { x: 220, y: 400, w: 200, h: 140 },
        centerLocalPoint: opts?.localPoint ? { x: 320, y: 470 } : null,
      };
    },
    async postWindowClick(_pid, opts) {
      clicksSent += 1;
      lastClickPayload = opts;
      if (scenario === "progressive_scroll") {
        editorOpen = true;
      }
      return { delivered: true, method: "window_post", wid: 501, localX: opts?.localPoint?.x, localY: opts?.localPoint?.y };
    },
    async dropSnapshots() {
      return { ok: true };
    },
    async close() {},
  };

  const server = new ComputerUseBrokerServer({
    webPort: 0,
    socketPath: sock,
    infoPath: null,
    actionPeer: fakePeer,
    streamPeer: fakePeer,
    axBridge: fakeAxBridge,
    permissionsFn: async () => ({ platform: "darwin", accessibility: true, screenRecording: true }),
    runningAppIdentityFn: async () => ({ pid: process.pid, bundleId: "com.lemon.lvpro", processToken: `${process.pid}:1` }),
  });
  await server.start();

  try {
    // 3a) getToolsList() must advertise `act`
    const listed = await server.getToolsList();
    const actTool = listed.tools.find((t) => t.name === "act");
    assert.ok(actTool, "act tool must be exposed in getToolsList()");
    assert.deepEqual(actTool.inputSchema.required, ["app", "target", "expect"]);

    // 3b) Progressive scroll -> spatial overlap dedup -> AXParent card click -> expect verified:true
    scenario = "progressive_scroll";
    scrollStep = 0;
    editorOpen = false;
    clicksSent = 0;
    axScrollCalls.length = 0;
    windowScrollCalls.length = 0;
    const okRes = await server.executeToolCall(
      "act",
      {
        app: "com.lemon.lvpro",
        target: { text: "心理学男声_Ep1V3_Seg06" },
        reveal: { direction: "down", max_scroll_steps: 4, pages_per_step: 0.7 },
        expect: { any_text: ["导出"], window_title_contains: "编辑器" },
        timeout_ms: 4000,
      },
      { source: "ai" }
    );
    assert.equal(okRes.isError, false, `Expected act to succeed, got: ${okRes.content?.[0]?.text}`);
    const okPayload = JSON.parse(okRes.content[0].text);
    assert.equal(okPayload.verified, true);
    assert.equal(okPayload.clicksSent, 1);
    assert.equal(clicksSent, 1);
    assert.equal(scrollStep, 2);
    assert.equal(axScrollCalls.length, 2, "tryHeadlessBackgroundScroll must receive exact 5-arg call into axBridge.scroll");
    assert.equal(axScrollCalls[0].opts.direction, "down");
    assert.equal(axScrollCalls[0].opts.pages, 0.7);
    assert.equal(windowScrollCalls.length, 2);
    assert.equal(windowScrollCalls[0].opts.pages, 0.7);
    assert.equal(lastClickPayload?.elementIndex, "1000001", "act forwards elementIndex for pre-click live check while still honoring resolved localPoint");
    assert.ok(lastClickPayload?.localPoint?.x === 320 && lastClickPayload?.localPoint?.y === 470);

    // 3c) Disjoint duplicate targets -> AMBIGUOUS_TARGET with clicksSent === 0
    scenario = "ambiguous";
    clicksSent = 0;
    const ambigRes = await server.executeToolCall(
      "act",
      {
        app: "com.lemon.lvpro",
        target: { text: "心理学男声_Ep1V3_Seg06" },
        expect: { any_text: ["导出"] },
      },
      { source: "ai" }
    );
    assert.equal(ambigRes.isError, true);
    assert.match(ambigRes.content[0].text, /AMBIGUOUS_TARGET/);
    assert.equal(clicksSent, 0);

    // 3d) Inert scroll -> SCROLL_NO_PROGRESS with clicksSent === 0
    scenario = "inert_scroll";
    clicksSent = 0;
    const inertRes = await server.executeToolCall(
      "act",
      {
        app: "com.lemon.lvpro",
        target: { text: "不存在的草稿" },
        reveal: { direction: "down", max_scroll_steps: 4, pages_per_step: 0.7 },
        expect: { any_text: ["导出"] },
      },
      { source: "ai" }
    );
    assert.equal(inertRes.isError, true);
    assert.match(inertRes.content[0].text, /SCROLL_NO_PROGRESS/);
    assert.equal(clicksSent, 0);

    // 3e) 100x Playback False-Positive Control: changing JPEG frames on every read must score 0/100 verified:true
    scenario = "playback";
    editorOpen = false;
    let falsePositives = 0;
    for (let run = 0; run < 100; run += 1) {
      const pbRes = await server.executeToolCall(
        "act",
        {
          app: "com.lemon.lvpro",
          target: { text: "导出" },
          reveal: { max_scroll_steps: 0 },
          expect: { any_text: ["导出完成弹窗"] },
          timeout_ms: 80,
        },
        { source: "ai" }
      );
      if (!pbRes.isError) falsePositives += 1;
      else assert.match(pbRes.content[0].text, /POSTCONDITION_FAILED/);
    }
    assert.equal(falsePositives, 0, "Continuous playback frame changes must produce 0/100 false-positive verifications");

    // 3f) Truncated locate & inconclusive text_disappears fail closed cleanly
    scenario = "truncated_locate";
    clicksSent = 0;
    queryCalls = 0;
    const truncRes = await server.executeToolCall(
      "act",
      {
        app: "com.lemon.lvpro",
        target: { text: "Target" },
        expect: { any_text: ["Done"] },
      },
      { source: "ai" }
    );
    assert.equal(truncRes.isError, true);
    assert.match(truncRes.content[0].text, /QUERY_TRUNCATED/);
    assert.equal(clicksSent, 0);
    assert.equal(queryCalls, 2, "Truncated single match should retry once with larger max_nodes before failing");

    scenario = "vanish_inconclusive";
    clicksSent = 0;
    const vanishRes = await server.executeToolCall(
      "act",
      {
        app: "com.lemon.lvpro",
        target: { text: "关闭弹窗" },
        reveal: { max_scroll_steps: 0 },
        expect: { text_disappears: ["弹窗"] },
        timeout_ms: 80,
      },
      { source: "ai" }
    );
    assert.equal(vanishRes.isError, true);
    assert.match(vanishRes.content[0].text, /POSTCONDITION_FAILED/);

    // 3g) Immediate disconnect cancellation on Broker socket using deterministic gates:
    //  Case 1: Disconnect BEFORE click while suspended inside query aborts before postWindowClick (clicksSent === 0)
    scenario = "slow_locate";
    clicksSent = 0;
    let releaseLocate = null;
    slowLocateRelease = new Promise((r) => {
      releaseLocate = r;
    });
    const locateReady = new Promise((r) => {
      slowLocateEntered = r;
    });
    await new Promise((resolve, reject) => {
      const clientSock = net.createConnection(sock, async () => {
        clientSock.write(
          `${JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: {
              name: "act",
              source: "ai",
              arguments: {
                app: "com.lemon.lvpro",
                target: { text: "Target" },
                expect: { any_text: ["Done"] },
                timeout_ms: 2000,
              },
            },
          })}\n`
        );
        await locateReady;
        clientSock.destroy();
      });
      clientSock.on("error", reject);
      clientSock.on("close", async () => {
        // Allow conn.on("close") on server side to abort connAbort before releasing query
        await new Promise((r) => setTimeout(r, 15));
        releaseLocate();
        await new Promise((r) => setTimeout(r, 25));
        resolve();
      });
    });
    slowLocateEntered = null;
    slowLocateRelease = null;
    assert.equal(clicksSent, 0, "Client disconnect during locate phase must abort before dispatching click");

    //  Case 2: Disconnect AFTER click during expect polling stops polling immediately with clicksSent === 1
    scenario = "slow_poll";
    clicksSent = 0;
    postClickStateReads = 0;
    let releasePoll = null;
    slowPollRelease = new Promise((r) => {
      releasePoll = r;
    });
    const pollReady = new Promise((r) => {
      slowPollEntered = r;
    });
    await new Promise((resolve, reject) => {
      const clientSock = net.createConnection(sock, async () => {
        clientSock.write(
          `${JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: {
              name: "act",
              source: "ai",
              arguments: {
                app: "com.lemon.lvpro",
                target: { text: "导出" },
                reveal: { max_scroll_steps: 0 },
                expect: { any_text: ["永不出现"] },
                timeout_ms: 3000,
              },
            },
          })}\n`
        );
        await pollReady;
        clientSock.destroy();
      });
      clientSock.on("error", reject);
      clientSock.on("close", async () => {
        await new Promise((r) => setTimeout(r, 15));
        releasePoll();
        await new Promise((r) => setTimeout(r, 25));
        resolve();
      });
    });
    slowPollEntered = null;
    slowPollRelease = null;
    assert.equal(clicksSent, 1, "Disconnect after click must not replay or double-click");
    assert.ok(postClickStateReads <= 2, `Disconnect during postcondition polling must stop early, got ${postClickStateReads}`);

    // 3h) runJsonRpcStdioServer immediate cancellation via abortOnEnd + notifications/cancelled (incl. escaped method)
    const stdioIn = new PassThrough();
    const stdioOut = new PassThrough();
    const stdioLines = [];
    stdioOut.on("data", (d) => {
      for (const l of String(d).split("\n").filter(Boolean)) stdioLines.push(JSON.parse(l));
    });
    const callStarted = { cancel_req: null, eof_req: null };
    const callAborted = {};
    runJsonRpcStdioServer({
      input: stdioIn,
      output: stdioOut,
      registerSignals: false,
      abortOnEnd: true,
      serverInfo: { name: "test-cancel", version: "1.0.0" },
      onListTools: async () => ({ tools: [] }),
      onCallTool: async (params, _req, { signal }) => {
        callStarted[params.name]?.();
        return new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              callAborted[params.name] = true;
              const err = new Error("aborted");
              err.aborted = true;
              reject(err);
            },
            { once: true }
          );
        });
      },
    });
    const cancelStartedP = new Promise((r) => {
      callStarted.cancel_req = r;
    });
    stdioIn.write(`${JSON.stringify({ jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "cancel_req" } })}\n`);
    await cancelStartedP;
    stdioIn.write('{"jsonrpc":"2.0","method":"notifications\\/cancelled","params":{"requestId":10}}\n');
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(callAborted.cancel_req, true, "Escaped notifications/cancelled must abort signal immediately");

    const eofStartedP = new Promise((r) => {
      callStarted.eof_req = r;
    });
    stdioIn.write(`${JSON.stringify({ jsonrpc: "2.0", id: 11, method: "tools/call", params: { name: "eof_req" } })}\n`);
    await eofStartedP;
    stdioIn.end();
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(callAborted.eof_req, true, "abortOnEnd stdin EOF must abort signal immediately");
    assert.equal(stdioLines.length, 0, "Aborted rejections must not emit spurious -32603 responses");
  } finally {
    await server.close();
  }
});

test("Slice 4 (Post-Review Regressions): Independent overlap preservation, cross-windowId drift, real macOS JXA bridge, and MCP backoff/REPL cancellation", async () => {
  // 4a) Two overlapping clickable buttons with distinct labels must NOT collapse (preserve ambiguity)
  const overlappedButtons = dedupeSpatiallyOverlappingMatches([
    { index: 1, role: "AXButton", title: "导出视频", bounds: { x: 100, y: 100, w: 200, h: 120 } },
    { index: 2, role: "AXButton", title: "删除", bounds: { x: 120, y: 120, w: 160, h: 80 } },
  ]);
  assert.equal(overlappedButtons.length, 2, "Independent clickable controls with distinct labels must stay ambiguous");

  // Wrapping card + plain text child MUST collapse cleanly keeping clickable AXButton
  const cardPlusText = dedupeSpatiallyOverlappingMatches([
    { index: 3, role: "AXStaticText", title: "导出视频", bounds: { x: 120, y: 120, w: 100, h: 24 } },
    { index: 4, role: "AXButton", title: "导出视频", bounds: { x: 100, y: 100, w: 200, h: 120 } },
  ]);
  assert.equal(cardPlusText.length, 1);
  assert.equal(cardPlusText[0].role, "AXButton");

  // 4b) Unpinned "1000001" query ref must reject cross-windowId drift even when windowTitle matches
  const registry = new AppSnapshotRegistry({ axBridge: null });
  await registry.ingestQueryMatches(
    "com.lemon.lvpro",
    {
      window_id: 499,
      window_title: "剪映专业版",
      matches: [{ index: 1000001, role: "AXButton", title: "DraftA", bounds: { x: 10, y: 10, w: 50, h: 30 } }],
    },
    { queryPid: process.pid }
  );
  await registry.ingestQueryMatches(
    "com.lemon.lvpro",
    {
      window_id: 500,
      window_title: "剪映专业版",
      matches: [{ index: 1000002, role: "AXButton", title: "DraftB", bounds: { x: 10, y: 10, w: 50, h: 30 } }],
    },
    { queryPid: process.pid }
  );
  const crossWinCheck = await registry.validateTargetRef({
    app: "com.lemon.lvpro",
    parsedRef: { ok: true, hasElementRef: true, rawIndex: "1000001", snapshotId: null, displayRef: "1000001" },
  });
  assert.equal(crossWinCheck.ok, false, "Ref 1000001 from window 499 must not survive window switch to 500 under same title");
  assert.equal(crossWinCheck.errorCode, "STALE_REF");

  // 4c) Real macOS JXA PersistentAxBridge (desktop-entitled hosts only): vanished WID + real CFArray batched bindSnapshot without crash
  if (process.platform === "darwin") {
    const liveBridge = new PersistentAxBridge({ enabled: true });
    try {
      const perms = await liveBridge.checkPermissions().catch(() => null);
      if (perms?.accessibility === true && perms?.screenRecording === true) {
        const vanished = await liveBridge.postWindowClick(process.pid, {
          wid: 999999,
          windowBounds: { x: 0, y: 0, width: 800, height: 600 },
          localPoint: { x: 10, y: 10 },
        });
        assert.equal(vanished.delivered, false);
        assert.equal(vanished.reason, "window_not_found", "Vanished WID must fail closed even when windowBounds is supplied");

        const finder = await liveBridge.findRunningApp("com.apple.finder").catch(() => null);
        if (finder?.pid > 0) {
          const bound = await liveBridge.bindSnapshot({
            snapshotId: "s_live_batch",
            pid: finder.pid,
            windowTitle: "",
            elements: [{ index: "1", role: "button", rawText: "" }],
          });
          assert.equal(typeof bound?.bound, "boolean", "Real macOS CFArray batch traversal must complete cleanly");
        }
      }
    } finally {
      await liveBridge.close();
    }
  }

  const waitExitBounded = (child, ms = 1500) => {
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    return Promise.race([
      once(child, "exit"),
      new Promise((resolve) => setTimeout(resolve, ms)),
    ]);
  };

  // 4d) Spawned mcp-server.mjs: notifications/cancelled during BrokerRpcClient connect backoff delivers 0 RPCs
  const mcpSock = path.join(tmpdir(), `cua-mcp-cancel-${process.pid}-${Date.now()}.sock`);
  const mcpChild = spawn(process.execPath, ["src/mcp-server.mjs"], {
    cwd: REPO_ROOT,
    env: { ...process.env, AGY_CUA_BROKER_SOCK: mcpSock },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const mcpStdoutLines = [];
  let mcpBuf = "";
  mcpChild.stdout.on("data", (d) => {
    mcpBuf += String(d);
    let nl;
    while ((nl = mcpBuf.indexOf("\n")) >= 0) {
      const line = mcpBuf.slice(0, nl).trim();
      mcpBuf = mcpBuf.slice(nl + 1);
      if (line) mcpStdoutLines.push(JSON.parse(line));
    }
  });
  const deliveredRpcs = [];
  const lateServer = net.createServer((conn) => {
    conn.on("data", (bytes) => {
      for (const l of String(bytes).split("\n").filter(Boolean)) {
        const msg = JSON.parse(l);
        deliveredRpcs.push(msg.params?.name || msg.method);
        conn.write(`${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [] } })}\n`);
      }
    });
  });
  try {
    mcpChild.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 99, method: "ping" })}\n`);
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("mcp-server ping timeout")), 2500);
      const check = () => {
        if (mcpStdoutLines.some((m) => m.id === 99)) {
          clearTimeout(t);
          resolve();
        } else {
          setTimeout(check, 5);
        }
      };
      check();
    });
    mcpChild.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "act", arguments: { app: "fixture" } } })}\n`
    );
    await new Promise((r) => setTimeout(r, 25));
    mcpChild.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } })}\n`
    );
    await new Promise((resolve) => lateServer.listen(mcpSock, resolve));
    await new Promise((r) => setTimeout(r, 220));
    mcpChild.stdin.end();
    await waitExitBounded(mcpChild, 1500);
    assert.deepEqual(deliveredRpcs, [], "Cancelled call during Broker connect backoff must never reconnect and dispatch");
    assert.equal(
      mcpStdoutLines.some((m) => m.id === 1 && m.error),
      false,
      "Cancelled call must not emit a spurious JSON-RPC error response"
    );
  } finally {
    try {
      mcpChild.stdin.end();
    } catch {}
    if (mcpChild.exitCode === null && mcpChild.signalCode === null) {
      mcpChild.kill("SIGKILL");
      await waitExitBounded(mcpChild, 500);
    }
    if (lateServer.listening) {
      await new Promise((resolve) => lateServer.close(resolve));
    }
  }

  // 4e) Spawned mcp-repl-server.mjs: cancelling an in-flight js call resets sandboxed REPL session so next js call succeeds cleanly
  const replSock = path.join(tmpdir(), `cua-repl-cancel-${process.pid}-${Date.now()}.sock`);
  const replFakePeer = {
    async listTools() {
      return { tools: [{ name: "list_apps" }, { name: "get_app_state" }] };
    },
    async callTool(name) {
      if (name === "list_apps") {
        return { isError: false, content: [{ type: "text", text: "Finder — com.apple.finder [running]" }] };
      }
      return { isError: false, content: [{ type: "text", text: "ok" }] };
    },
    close() {},
  };
  const replBroker = new ComputerUseBrokerServer({
    webPort: 0,
    socketPath: replSock,
    infoPath: null,
    actionPeer: replFakePeer,
    streamPeer: replFakePeer,
    axBridge: null,
    launchHelperOnStart: false,
    permissionsFn: async () => ({ platform: "darwin", accessibility: true, screenRecording: true }),
  });
  await replBroker.start();
  const replChild = spawn(process.execPath, ["src/mcp-repl-server.mjs"], {
    cwd: REPO_ROOT,
    env: { ...process.env, AGY_CUA_BROKER_SOCK: replSock },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const replStdoutLines = [];
  let replBuf = "";
  replChild.stdout.on("data", (d) => {
    replBuf += String(d);
    let nl;
    while ((nl = replBuf.indexOf("\n")) >= 0) {
      const line = replBuf.slice(0, nl).trim();
      replBuf = replBuf.slice(nl + 1);
      if (line) replStdoutLines.push(JSON.parse(line));
    }
  });
  const waitReplId = (id, timeout = 4000) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`repl id ${id} timeout`)), timeout);
      const poll = () => {
        const found = replStdoutLines.find((m) => m.id === id);
        if (found) {
          clearTimeout(timer);
          resolve(found);
        } else {
          setTimeout(poll, 10);
        }
      };
      poll();
    });
  try {
    replChild.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
    await waitReplId(1);
    replChild.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "js", arguments: { code: "await new Promise(r => setTimeout(r, 4000));" } },
      })}\n`
    );
    await new Promise((r) => setTimeout(r, 60));
    replChild.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 2 } })}\n`
    );
    replChild.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "js", arguments: { code: "nodeRepl.write(40 + 2);" } },
      })}\n`
    );
    const recovered = await waitReplId(3);
    assert.equal(
      Boolean(recovered.result?.isError),
      false,
      `Subsequent js call after cancel must recover cleanly, got: ${JSON.stringify(recovered.result)}`
    );
    assert.match(JSON.stringify(recovered.result), /42/);
    replChild.stdin.end();
    await waitExitBounded(replChild, 1500);
  } finally {
    try {
      replChild.stdin.end();
    } catch {}
    if (replChild.exitCode === null && replChild.signalCode === null) {
      replChild.kill("SIGKILL");
      await waitExitBounded(replChild, 500);
    }
    await replBroker.close();
  }

  // 4f) act() tail-budget 50ms peer timeout safety + explicit window_id expect isolation
  const timeoutSock = path.join(tmpdir(), `cua-tail-timeout-${process.pid}-${Date.now()}.sock`);
  let queryDelayMs = 75;
  let stateDelayMs = 85;
  let vanishOnPinnedWin = false;
  let postClickStateCalls = 0;
  let tailClicksSent = 0;

  const waitWithTimeout = async (delayMs, timeoutMs) => {
    const t = Number(timeoutMs);
    if (Number.isFinite(t) && t > 0 && delayMs > t) {
      await new Promise((r) => setTimeout(r, t));
      throw new Error(`action-engine tools/call timed out after ${t}ms`);
    }
    await new Promise((r) => setTimeout(r, delayMs));
  };

  const tailPeer = {
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
    async callTool(name, args, timeoutMs) {
      if (name === "list_apps") {
        return { isError: false, content: [{ type: "text", text: "剪映专业版 — com.lemon.lvpro [running]" }] };
      }
      if (name === "get_app_state") {
        if (tailClicksSent > 0) postClickStateCalls += 1;
        await waitWithTimeout(stateDelayMs, timeoutMs);
        return {
          isError: false,
          content: [
            {
              type: "text",
              text: [
                `App=com.lemon.lvpro (pid ${process.pid})`,
                'Window: "剪映专业版", App: 剪映专业版.',
                "0 对话框",
                "\t1 文本 HomePageStartProjectDesp Title: HomePageStartProjectDesp",
              ].join("\n"),
            },
          ],
        };
      }
      if (name === "query") {
        await waitWithTimeout(queryDelayMs, timeoutMs);
        if (args?.text === "HomePageStartProjectDesp") {
          return {
            isError: false,
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  window_id: args?.window_id || 1323,
                  window_title: "剪映专业版",
                  matches: vanishOnPinnedWin
                    ? []
                    : [
                        {
                          index: 1000050,
                          role: "AXStaticText",
                          title: "HomePageStartProjectDesp",
                          bounds: { x: 671, y: 109, w: 64, h: 23 },
                        },
                      ],
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
                window_id: args?.window_id || 1323,
                window_title: "剪映专业版",
                matches:
                  !args?.text || args.text === "模板"
                    ? [
                        {
                          index: 1000039,
                          role: "AXStaticText",
                          title: "模板",
                          bounds: { x: 62, y: 252, w: 28, h: 17 },
                        },
                      ]
                    : [],
              }),
            },
          ],
        };
      }
      return { isError: false, content: [{ type: "text", text: "ok" }] };
    },
    close() {},
  };

  const tailAxBridge = {
    enabled: true,
    async checkPermissions() {
      return { accessibility: true, screenRecording: true };
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
    async resolveActionTarget(_pid, opts) {
      return {
        resolved: true,
        wid: opts?.wid || 1323,
        windowBounds: { x: 151, y: 58, w: 1168, h: 780 },
        role: "AXStaticText",
        hasAxPress: false,
        hops: 0,
        localBounds: { x: 62, y: 252, w: 28, h: 17 },
        centerLocalPoint: opts?.localPoint || { x: 76, y: 260 },
      };
    },
    async postWindowClick(_pid, opts) {
      tailClicksSent += 1;
      return { delivered: true, method: "window_post", wid: 1323, localX: opts?.localPoint?.x, localY: opts?.localPoint?.y };
    },
    async dropSnapshots() {
      return { ok: true };
    },
    async close() {},
  };

  const tailServer = new ComputerUseBrokerServer({
    webPort: 0,
    socketPath: timeoutSock,
    infoPath: null,
    actionPeer: tailPeer,
    streamPeer: tailPeer,
    axBridge: tailAxBridge,
    permissionsFn: async () => ({ platform: "darwin", accessibility: true, screenRecording: true }),
    runningAppIdentityFn: async () => ({ pid: process.pid, bundleId: "com.lemon.lvpro", processToken: `${process.pid}:1` }),
  });
  await tailServer.start();

  try {
    // Case A: Post-click tail budget triggers peer timeout -> must return POSTCONDITION_FAILED cleanly, never throw 50ms error
    queryDelayMs = 75;
    vanishOnPinnedWin = false;
    postClickStateCalls = 0;
    tailClicksSent = 0;
    const tailRes = await tailServer.executeToolCall(
      "act",
      {
        app: "com.lemon.lvpro",
        window_id: 1323,
        target: { text: "模板", exact: true },
        reveal: { max_scroll_steps: 0 },
        expect: { text_disappears: ["HomePageStartProjectDesp"] },
        timeout_ms: 220,
      },
      { source: "ai" }
    );
    assert.equal(tailRes.isError, true, "Tail budget expect failure should return isError: true");
    assert.match(tailRes.content[0].text, /POSTCONDITION_FAILED/);
    const tailPayload = JSON.parse(tailRes.content[0].text.replace(/^\[POSTCONDITION_FAILED\]\s*/u, ""));
    assert.equal(tailPayload.code, "POSTCONDITION_FAILED");
    assert.equal(tailPayload.sent, true);
    assert.equal(tailPayload.verified, false);
    assert.equal(tailPayload.clicksSent, 1);
    assert.equal(postClickStateCalls, 0, "Explicit window_id expect must not poll default get_app_state");

    // Case A2: Unpinned default window with realistic slow get_app_state (85ms) near deadline -> POSTCONDITION_FAILED, never 50ms RPC throw
    queryDelayMs = 20;
    stateDelayMs = 85;
    vanishOnPinnedWin = false;
    postClickStateCalls = 0;
    tailClicksSent = 0;
    const unpinnedTailRes = await tailServer.executeToolCall(
      "act",
      {
        app: "com.lemon.lvpro",
        target: { text: "模板", exact: true },
        reveal: { max_scroll_steps: 0 },
        expect: { any_text: ["NeverAppears"] },
        timeout_ms: 170,
      },
      { source: "ai" }
    );
    assert.equal(unpinnedTailRes.isError, true);
    assert.match(unpinnedTailRes.content[0].text, /POSTCONDITION_FAILED/);
    const unpinnedTailPayload = JSON.parse(unpinnedTailRes.content[0].text.replace(/^\[POSTCONDITION_FAILED\]\s*/u, ""));
    assert.equal(unpinnedTailPayload.sent, true);
    assert.equal(unpinnedTailPayload.verified, false);
    assert.equal(unpinnedTailPayload.clicksSent, 1);

    // Case B: Explicit window_id isolation -> verified: true even when default get_app_state still sees dialog text
    queryDelayMs = 10;
    stateDelayMs = 5;
    vanishOnPinnedWin = true;
    postClickStateCalls = 0;
    tailClicksSent = 0;
    const pinnedOkRes = await tailServer.executeToolCall(
      "act",
      {
        app: "com.lemon.lvpro",
        window_id: 1323,
        target: { text: "模板", exact: true },
        reveal: { max_scroll_steps: 0 },
        expect: { text_disappears: ["HomePageStartProjectDesp"] },
        timeout_ms: 1000,
      },
      { source: "ai" }
    );
    assert.equal(pinnedOkRes.isError, false, `Explicit window_id disappear check failed: ${pinnedOkRes.content?.[0]?.text}`);
    const pinnedPayload = JSON.parse(pinnedOkRes.content[0].text);
    assert.equal(pinnedPayload.verified, true);
    assert.equal(pinnedPayload.clicksSent, 1);
    assert.equal(postClickStateCalls, 0, "Pinned window_id expect must bypass unrelated default dialog get_app_state");

    // Case C: Pre-click locate peer timeout -> structured TIMEOUT with clicksSent === 0
    queryDelayMs = 90;
    vanishOnPinnedWin = false;
    tailClicksSent = 0;
    const preTimeoutRes = await tailServer.executeToolCall(
      "act",
      {
        app: "com.lemon.lvpro",
        window_id: 1323,
        target: { text: "模板", exact: true },
        reveal: { max_scroll_steps: 0 },
        expect: { text_disappears: ["HomePageStartProjectDesp"] },
        timeout_ms: 45,
      },
      { source: "ai" }
    );
    assert.equal(preTimeoutRes.isError, true);
    assert.match(preTimeoutRes.content[0].text, /TIMEOUT/);
    const prePayload = JSON.parse(preTimeoutRes.content[0].text.replace(/^\[TIMEOUT\]\s*/u, ""));
    assert.equal(prePayload.code, "TIMEOUT");
    assert.equal(prePayload.sent, false);
    assert.equal(prePayload.clicksSent, 0);
    assert.equal(tailClicksSent, 0);
  } finally {
    await tailServer.close();
  }

  // 4g) Untrusted JXA osascript skips window_post & explicit window_id uses element_index sky_click
  const untrustedSock = path.join(tmpdir(), `cua-untrusted-jxa-${process.pid}-${Date.now()}.sock`);
  let jxaClickCalls = 0;
  let jxaScrollCalls = 0;
  let peerClickArgs = null;
  let peerScrollArgs = null;
  let untrustedTabSwitched = false;

  // Minimal valid 1620x1000 baseline JPEG header (SOI + SOF0 + EOI) for parseImageDimensions
  const jpeg1620x1000Base64 = Buffer.from([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x0b, 0x08, 0x03, 0xe8, 0x06, 0x54, 0x01, 0x01, 0x11, 0x00,
    0xff, 0xd9,
  ]).toString("base64");

  const untrustedPeer = {
    async listTools() {
      return {
        tools: [
          { name: "list_apps" },
          { name: "get_app_state" },
          { name: "query" },
          { name: "click", inputSchema: { properties: { click_method: { enum: ["sky_click"] } } } },
          { name: "scroll" },
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
                "0 对话框",
                "\t1 按钮",
                "\t2 关闭按钮",
              ].join("\n"),
            },
            { type: "image", data: jpeg1620x1000Base64, mimeType: "image/jpeg" },
          ],
        };
      }
      if (name === "query") {
        if (args?.text === "HomePageStartProjectDesp") {
          return {
            isError: false,
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  window_id: 1323,
                  window_title: "剪映专业版",
                  matches: untrustedTabSwitched
                    ? []
                    : [
                        {
                          index: 1000050,
                          role: "AXStaticText",
                          title: "HomePageStartProjectDesp",
                          bounds: { x: 671, y: 109, w: 64, h: 23 },
                        },
                      ],
                }),
              },
            ],
          };
        }
        if (args?.text === "OnlineResourceInfoView") {
          return {
            isError: false,
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  window_id: 1323,
                  window_title: "剪映专业版",
                  matches: untrustedTabSwitched
                    ? [
                        {
                          index: 1000044,
                          role: "AXStaticText",
                          title: "OnlineResourceInfoView:测试模板",
                          bounds: { x: 246, y: 218, w: 166, h: 295 },
                        },
                      ]
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
                window_id: 1323,
                window_title: "剪映专业版",
                matches: [
                  {
                    index: 1000035,
                    role: "AXStaticText",
                    title: "模板",
                    bounds: { x: 62, y: 252, w: 28, h: 17 },
                  },
                ],
              }),
            },
          ],
        };
      }
      if (name === "click") {
        peerClickArgs = args;
        untrustedTabSwitched = true;
        return { isError: false, content: [{ type: "text", text: "ok" }] };
      }
      if (name === "scroll") {
        peerScrollArgs = args;
        return { isError: false, content: [{ type: "text", text: "ok" }] };
      }
      return { isError: true, content: [{ type: "text", text: `unknown tool ${name}` }] };
    },
    close() {},
  };

  const untrustedAxBridge = {
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
    async resolveActionTarget(_pid, opts) {
      return {
        resolved: true,
        wid: opts?.wid || 1323,
        windowBounds: { x: 151, y: 58, w: 1168, h: 780 },
        role: null,
        hasAxPress: false,
        hops: 0,
        localBounds: null,
        centerLocalPoint: opts?.localPoint || { x: 76, y: 260 },
        reason: "window_local_point",
      };
    },
    async postWindowClick() {
      jxaClickCalls += 1;
      return { delivered: true, method: "window_post", wid: 1323 };
    },
    async postWindowScroll() {
      jxaScrollCalls += 1;
      return { delivered: true, method: "window_post_scroll", wid: 1323 };
    },
    async dropSnapshots() {
      return { ok: true };
    },
    async close() {},
  };

  const untrustedServer = new ComputerUseBrokerServer({
    webPort: 0,
    socketPath: untrustedSock,
    infoPath: null,
    actionPeer: untrustedPeer,
    streamPeer: untrustedPeer,
    axBridge: untrustedAxBridge,
    permissionsFn: async () => ({ platform: "darwin", accessibility: false, screenRecording: false }),
    runningAppIdentityFn: async () => ({ pid: process.pid, bundleId: "com.lemon.lvpro", processToken: `${process.pid}:1` }),
  });
  await untrustedServer.start();

  try {
    await untrustedServer.executeToolCall("get_app_state", { app: "com.lemon.lvpro" }, { source: "ai" });

    const actUntrustedRes = await untrustedServer.executeToolCall(
      "act",
      {
        app: "com.lemon.lvpro",
        window_id: 1323,
        target: { text: "模板", exact: true },
        reveal: { max_scroll_steps: 0 },
        expect: { text_disappears: ["HomePageStartProjectDesp"], any_text: ["OnlineResourceInfoView"] },
        timeout_ms: 1500,
      },
      { source: "ai" }
    );
    assert.equal(jxaClickCalls, 0, "Untrusted JXA window_post must be skipped so it never silently drops clicks");
    assert.deepEqual(peerClickArgs, {
      app: "com.lemon.lvpro",
      click_method: "sky_click",
      element_index: "1000035",
      mouse_button: "left",
      click_count: 1,
    });
    assert.equal(actUntrustedRes.isError, false, `Expected act to succeed via element_index sky_click, got: ${actUntrustedRes.content?.[0]?.text}`);
    const actUntrustedPayload = JSON.parse(actUntrustedRes.content[0].text);
    assert.equal(actUntrustedPayload.verified, true);
    assert.equal(actUntrustedPayload.clicksSent, 1);
    assert.equal(actUntrustedPayload.route, "click:sky_click");

    const scrollFallbackRes = await untrustedServer.actionExecutor.executeActScroll({
      app: "com.lemon.lvpro",
      pid: process.pid,
      meta: untrustedServer.registry.getMeta("com.lemon.lvpro"),
      direction: "down",
      pages: 0.7,
    });
    assert.equal(jxaScrollCalls, 0, "Untrusted JXA window_post_scroll must be skipped so native scroll can run");
    assert.equal(scrollFallbackRes.delivered, true);
    assert.equal(scrollFallbackRes.route, "scroll:native");
    assert.deepEqual(peerScrollArgs, { app: "com.lemon.lvpro", direction: "down", pages: 0.7 });
  } finally {
    await untrustedServer.close();
  }
});

test("Codex 6.2 regressions: pinned act rejects query matches lacking window_id instead of clicking unproven window", async () => {
  let clickCount = 0;
  const sock = path.join(tmpdir(), `cua-pin-act-strict-${process.pid}-${Date.now()}.sock`);
  const peer = {
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
          content: [{ type: "text", text: `App=com.lemon.lvpro (pid ${process.pid})\nWindow: "Main", App: 剪映专业版.\n0 按钮 "Confirm"` }],
        };
      }
      if (name === "query") {
        // Deliberately omit window_id on both top-level response and match
        return {
          isError: false,
          content: [{ type: "text", text: JSON.stringify({ window_title: "Other", matches: [{ index: 0, role: "AXButton", title: "Confirm", bounds: { x: 10, y: 10, w: 40, h: 20 } }] }) }],
        };
      }
      if (name === "click") {
        clickCount += 1;
        return { isError: false, content: [{ type: "text", text: "ok" }] };
      }
      return { isError: true, content: [{ type: "text", text: "err" }] };
    },
    close() {},
  };
  const broker = new ComputerUseBrokerServer({
    webPort: 0,
    socketPath: sock,
    infoPath: null,
    actionPeer: peer,
    streamPeer: peer,
    axBridge: {
      enabled: true,
      async checkPermissions() { return { accessibility: true, screenRecording: true }; },
      async getFrontmostApp() { return { pid: 100, bundleId: "com.google.antigravity" }; },
      async restoreFrontmostApp() { return true; },
      async findRunningApp() { return { alive: true, pid: process.pid, bundleId: "com.lemon.lvpro", processToken: `${process.pid}:1` }; },
      async ensureManualAccessibility() { return { supported: true, changed: false, enabled: true, definitive: true }; },
      async resolveActionTarget(_pid, opts) {
        return { resolved: true, wid: opts?.wid || 1323, windowBounds: { x: 0, y: 0, w: 800, h: 600 }, centerLocalPoint: { x: 30, y: 20 }, reason: "window_local_point" };
      },
      async dropSnapshots() { return { ok: true }; },
      async close() {},
    },
    permissionsFn: async () => ({ platform: "darwin", accessibility: true, screenRecording: true }),
    runningAppIdentityFn: async () => ({ pid: process.pid, bundleId: "com.lemon.lvpro", processToken: `${process.pid}:1` }),
  });
  await broker.start();
  try {
    const res = await broker.executeToolCall(
      "act",
      {
        app: "com.lemon.lvpro",
        window_id: 1323,
        target: { text: "Confirm" },
        reveal: { max_scroll_steps: 0 },
        expect: { any_text: ["Done"] },
      },
      { source: "ai" }
    );
    assert.equal(res.isError, true);
    const rawTxt = res.content[0].text;
    const payload = JSON.parse(rawTxt.slice(rawTxt.indexOf("{")));
    assert.equal(payload.code, "TARGET_NOT_FOUND");
    assert.equal(clickCount, 0);
  } finally {
    await broker.close();
  }
});



