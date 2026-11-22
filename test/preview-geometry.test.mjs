import assert from "node:assert/strict";
import test from "node:test";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { rmSync } from "node:fs";
import { ComputerUseBrokerServer } from "../src/broker-sidecar.mjs";
import {
  actionPixelToWindowPoint,
  buildTargetKey,
  computeContainDisplayRect,
  createPreviewGeometry,
  evaluateArbitraryPointCapability,
  mapToActionPixel,
  mapToWindowPoint,
  parseTargetKey,
  pointerToNormalizedContent,
  projectCursor,
  validateFrameRef,
} from "../src/preview-geometry.mjs";
import { SidecarWebAdapter } from "../src/sidecar-web-adapter.mjs";

const TINY_JPEG_B64 = Buffer.from([
  0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x03, 0x00, 0x05, 0x00, 0x03, 0xff, 0xd9,
]).toString("base64"); // 1280x768 SOF0 header (0x0500=1280, 0x0300=768)

function makeMockHelper(windowsProvider) {
  return {
    available: true,
    videoAvailable: false,
    getDiagnostics: () => ({
      available: true,
      videoAvailable: false,
      pid: 4321,
      bundleId: "io.codexstyle.cua.desktop-helper.dev",
      capabilities: {
        screenRecordingPreflight: false,
        inputMonitoringPreflight: false,
        accessibilityTrusted: true,
        mouseTapActive: false,
        keyTapActive: false,
        hotkeyActive: false,
      },
    }),
    async listWindows(pid) {
      return windowsProvider(pid);
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
  };
}

test("PreviewGeometry maps 1000x600 pt identically across 960x576 H.264 and 1280x768 JPEG, supports Retina & negative display origins, and rejects black bars", () => {
  // 1. Exact blueprint example: 1000x600 pt window -> H.264 960x576 & OCU JPEG 1280x768
  const h264Geom = createPreviewGeometry({
    brokerBootId: "boot-1",
    pid: 2001,
    processToken: "2001:1700.0",
    windowId: 501,
    windowBoundsPt: { x: -1440, y: -220, width: 1000, height: 600 }, // Negative secondary Retina display origin
    previewContentRectPt: { x: 0, y: 0, width: 1000, height: 600 },
    previewPixelSize: { width: 960, height: 576 },
    actionContentRectPt: { x: 0, y: 0, width: 1000, height: 600 },
    actionPixelSize: { width: 1280, height: 768 },
    scaleFactor: 2,
    jxaTrusted: false,
    ocuActionProven: true,
  });

  const jpegGeom = createPreviewGeometry({
    brokerBootId: "boot-1",
    pid: 2001,
    processToken: "2001:1700.0",
    windowId: 501,
    windowBoundsPt: { x: -1440, y: -220, width: 1000, height: 600 },
    previewContentRectPt: { x: 0, y: 0, width: 1000, height: 600 },
    previewPixelSize: { width: 1280, height: 768 },
    actionContentRectPt: { x: 0, y: 0, width: 1000, height: 600 },
    actionPixelSize: { width: 1280, height: 768 },
    scaleFactor: 2,
    jxaTrusted: false,
    ocuActionProven: true,
  });

  const ptFromH264 = mapToWindowPoint({ normX: 0.75, normY: 0.25 }, h264Geom);
  const ptFromJpeg = mapToWindowPoint({ normX: 0.75, normY: 0.25 }, jpegGeom);
  assert.deepEqual(ptFromH264, { x: 750, y: 150, screenX: -690, screenY: -70 });
  assert.deepEqual(ptFromJpeg, ptFromH264);

  const pxFromH264 = mapToActionPixel(ptFromH264, h264Geom);
  const pxFromJpeg = mapToActionPixel(ptFromJpeg, jpegGeom);
  assert.deepEqual(pxFromH264, { x: 960, y: 192 });
  assert.deepEqual(pxFromJpeg, { x: 960, y: 192 });

  const cursorOverlay = projectCursor(ptFromH264, h264Geom);
  assert.equal(cursorOverlay.visible, true);
  assert.equal(Math.abs(cursorOverlay.normX - 0.75) < 1e-9, true);
  assert.equal(Math.abs(cursorOverlay.normY - 0.25) < 1e-9, true);

  const roundTripPt = actionPixelToWindowPoint(pxFromH264, h264Geom);
  assert.equal(Math.abs(roundTripPt.x - 750) < 0.01, true);
  assert.equal(Math.abs(roundTripPt.y - 150) < 0.01, true);

  // 2. Letterbox / pillarbox black-bar pointer rejection
  const displayRect = computeContainDisplayRect(500, 400, 1000, 600);
  // 500x400 fits 1000x600 at width=500, height=300 centered at y=50
  assert.deepEqual(displayRect, { x: 0, y: 50, width: 500, height: 300 });
  assert.equal(pointerToNormalizedContent(250, 20, displayRect).ok, false);
  assert.equal(pointerToNormalizedContent(250, 20, displayRect).code, "OUTSIDE_CONTENT_RECT");
  assert.equal(pointerToNormalizedContent(250, 380, displayRect).code, "OUTSIDE_CONTENT_RECT");
  const inside = pointerToNormalizedContent(375, 125, displayRect);
  assert.equal(inside.ok, true);
  assert.equal(inside.normX, 0.75);
  assert.equal(inside.normY, 0.25);

  // 3. TargetKey encode/decode preserves colons inside processToken cleanly
  const parsedKey = parseTargetKey(h264Geom.targetKey);
  assert.deepEqual(parsedKey, {
    pid: 2001,
    processToken: "2001:1700.0",
    windowId: 501,
    windowGeneration: 1,
  });

  // 4. Stale frameRef validations: resize, WID switch, WID reuse across PIDs
  const baseRef = {
    brokerBootId: "boot-1",
    targetKey: h264Geom.targetKey,
    geometryRev: 1,
    seq: 12,
    windowId: 501,
  };
  assert.equal(validateFrameRef(baseRef, h264Geom).ok, true);
  assert.equal(
    validateFrameRef(baseRef, h264Geom, { pid: 2001, windowId: 501, boundsPt: { x: -1440, y: -220, width: 900, height: 600 } }).code,
    "STALE_VIEW"
  );
  assert.equal(
    validateFrameRef(baseRef, { ...h264Geom, geometryRev: 2 }).code,
    "STALE_VIEW"
  );
  assert.equal(
    validateFrameRef(baseRef, { ...h264Geom, targetKey: buildTargetKey({ pid: 2001, processToken: "2001:1700.0", windowId: 502 }) }).code,
    "STALE_VIEW"
  );
  assert.equal(
    validateFrameRef(baseRef, { ...h264Geom, targetKey: buildTargetKey({ pid: 2099, processToken: "2099:1800.0", windowId: 501, windowGeneration: 2 }) }).code,
    "STALE_VIEW"
  );

  // 5. Capability adjudication: explicit WID requires window_post
  const capNoJxaExplicit = evaluateArbitraryPointCapability({
    geometry: { ...h264Geom, explicitWindowId: true },
    jxaTrusted: false,
    ocuActionProven: true,
  });
  assert.equal(capNoJxaExplicit.allowed, false);
  assert.equal(capNoJxaExplicit.readOnlyReason, "explicit_wid_requires_window_post");
});

test("SidecarWebAdapter rejects stale or cross-window /api/frame.jpg requests with 409 STALE_VIEW", async () => {
  const state = {
    brokerBootId: "boot-test",
    activeApp: "com.example.App",
    targetKey: "v1|100|tok|501|1",
    geometryRev: 1,
    windowId: 501,
    actionSeq: 0,
    frameSeq: 0,
    frameWidth: 0,
    frameHeight: 0,
    frameLatencyMs: 0,
    lastActivityAt: 0,
    recentActions: [],
    runningApps: [],
    permissions: { platform: "darwin", accessibility: true, screenRecording: true },
    headlessStats: {},
  };
  const web = new SidecarWebAdapter({
    webPort: 0,
    uiToken: "tok",
    brokerBootId: "boot-test",
    state,
  });
  const port = await web.start();
  try {
    web.updateFrameFromImageItem({ mimeType: "image/jpeg", data: TINY_JPEG_B64 }, 5, {
      frameMeta: { targetKey: "v1|100|tok|501|1", geometryRev: 1, windowId: 501 },
    });
    state.targetKey = "v1|100|tok|502|1";
    web.updateFrameFromImageItem({ mimeType: "image/jpeg", data: TINY_JPEG_B64 }, 5, {
      frameMeta: { targetKey: "v1|100|tok|502|1", geometryRev: 1, windowId: 502 },
    });

    // Requesting seq=1 with targetKey of window 502 must be rejected (409)
    const mismatchRes = await fetch(
      `http://127.0.0.1:${port}/api/frame.jpg?token=tok&seq=1&boot=boot-test&targetKey=${encodeURIComponent("v1|100|tok|502|1")}`
    );
    assert.equal(mismatchRes.status, 409);

    // Wrong boot must return 409
    const badBootRes = await fetch(
      `http://127.0.0.1:${port}/api/frame.jpg?token=tok&seq=2&boot=old-boot`
    );
    assert.equal(badBootRes.status, 409);

    // Matching seq=2 + targetKey must return 200
    const okRes = await fetch(
      `http://127.0.0.1:${port}/api/frame.jpg?token=tok&seq=2&boot=boot-test&targetKey=${encodeURIComponent("v1|100|tok|502|1")}`
    );
    assert.equal(okRes.status, 200);
  } finally {
    await web.close();
  }
});

test("Broker enforces zero native writes when same-window delivery is unproven, routes explicit WID clicks via window_post without fallback, and tolerates H.264 vs OCU dimension difference", async () => {
  const sock = path.join(os.tmpdir(), `cua-geom-broker-${process.pid}-${crypto.randomBytes(4).toString("hex")}.sock`);
  let jxaAccessible = false;
  let windows = [
    { pid: 3100, windowId: 801, layer: 0, title: "Main Win", boundsPt: { x: 100, y: 50, width: 1000, height: 600 }, onScreen: true },
    { pid: 3100, windowId: 802, layer: 0, title: "Promo Popup", boundsPt: { x: 200, y: 120, width: 400, height: 300 }, onScreen: true },
  ];
  let nativeActionWrites = 0;
  const windowClickCalls = [];
  const windowScrollCalls = [];

  const mockPeer = {
    async listTools() {
      return { tools: [{ name: "list_apps" }, { name: "get_app_state" }, { name: "click" }, { name: "scroll" }] };
    },
    async callTool(name, args) {
      if (name === "list_apps") {
        return { isError: false, content: [{ type: "text", text: "TestApp — com.example.Multi [running]" }] };
      }
      if (name === "get_app_state") {
        return {
          isError: false,
          content: [
            {
              type: "text",
              text: "App=com.example.Multi (pid 3100)\nWindow: \"Main Win\", App: TestApp.\n1 button OK",
            },
            { type: "image", mimeType: "image/jpeg", data: TINY_JPEG_B64 }, // 1280x768 action screenshot
          ],
        };
      }
      nativeActionWrites += 1;
      return { isError: false, content: [{ type: "text", text: `ok ${name} ${JSON.stringify(args)}` }] };
    },
    close() {},
  };

  const token = "geom-tok";
  const broker = new ComputerUseBrokerServer({
    webPort: 0,
    uiToken: token,
    socketPath: sock,
    infoPath: null,
    actionPeer: mockPeer,
    streamPeer: mockPeer,
    axBridge: null,
    desktopHelperClient: makeMockHelper(() => windows),
    permissionsFn: async () => ({ platform: "darwin", accessibility: jxaAccessible, screenRecording: true }),
    processIdentityFn: async (pid) => ({ pid, alive: true, processToken: `${pid}:1700.0` }),
    windowClickFn: async (pid, opts) => {
      windowClickCalls.push({ pid, opts });
      return { delivered: true, method: "window_post" };
    },
    windowScrollFn: async (pid, opts) => {
      windowScrollCalls.push({ pid, opts });
      return { delivered: true, verified: true, method: "window_post_scroll" };
    },
    launchHelperOnStart: false,
  });

  try {
    const { webPort } = await broker.start();

    // 1. Pin explicit secondary window 802 while JXA is NOT trusted -> must be readOnly & return 409 with 0 native writes!
    const selRes = await (
      await fetch(`http://127.0.0.1:${webPort}/api/select-app`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Sidecar-Token": token },
        body: JSON.stringify({ app: "com.example.Multi", windowId: 802 }),
      })
    ).json();
    assert.equal(selRes.pinnedWindowId, 802);
    assert.equal(selRes.previewReadOnly, true);
    assert.equal(selRes.previewReadOnlyReason, "explicit_wid_requires_window_post");

    const unprovenClick = await fetch(`http://127.0.0.1:${webPort}/api/interact`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Sidecar-Token": token },
      body: JSON.stringify({
        app: "com.example.Multi",
        brokerBootId: broker.brokerBootId,
        frameRef: {
          brokerBootId: broker.brokerBootId,
          targetKey: selRes.targetKey,
          geometryRev: selRes.geometryRev,
          seq: selRes.frameSeq || 1,
          windowId: 802,
        },
        kind: "click",
        normX: 0.5,
        normY: 0.5,
      }),
    });
    assert.equal(unprovenClick.status, 409);
    assert.equal(nativeActionWrites, 0, "Unproven same-window click must produce 0 native writes");
    assert.equal(windowClickCalls.length, 0);

    // 2. Grant JXA + select window 801 (1000x600 pt), then simulate H.264 960x576 dims on preview while action JPEG is 1280x768
    jxaAccessible = true;
    await fetch(`http://127.0.0.1:${webPort}/api/permissions`, {
      headers: { "X-Sidecar-Token": token },
    });
    const mainSel = await (
      await fetch(`http://127.0.0.1:${webPort}/api/select-app`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Sidecar-Token": token },
        body: JSON.stringify({ app: "com.example.Multi", windowId: 801 }),
      })
    ).json();
    assert.equal(mainSel.previewReadOnly, false);

    // Update preview dimensions to H.264 960x576 while action screenshot stays 1280x768
    const geom = broker.previewStreamManager.syncActiveGeometry({
      pid: 3100,
      processToken: "3100:1700.0",
      windowId: 801,
      explicitWindowId: true,
      windowBoundsPt: { x: 100, y: 50, width: 1000, height: 600 },
      previewPixelSize: { width: 960, height: 576 },
      actionPixelSize: { width: 1280, height: 768 },
      jxaTrusted: true,
    });
    broker.state.frameWidth = 960;
    broker.state.frameHeight = 576;

    const validClickRes = await fetch(`http://127.0.0.1:${webPort}/api/interact`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Sidecar-Token": token },
      body: JSON.stringify({
        app: "com.example.Multi",
        brokerBootId: broker.brokerBootId,
        frameRef: {
          brokerBootId: broker.brokerBootId,
          targetKey: geom.targetKey,
          geometryRev: geom.geometryRev,
          seq: Math.max(1, mainSel.frameSeq),
          windowId: 801,
        },
        kind: "click",
        normX: 0.75,
        normY: 0.25,
      }),
    });
    assert.equal(validClickRes.status, 200);
    assert.equal(windowClickCalls.length, 1);
    assert.equal(windowClickCalls[0].opts.wid, 801);
    assert.equal(windowClickCalls[0].opts.allowAppPostFallback, false);
    assert.deepEqual(windowClickCalls[0].opts.localPoint, { x: 750, y: 150 });
    assert.equal(nativeActionWrites, 0, "JXA window_post must not touch OCU global/app action peer");

    // Pointer-targeted scroll with frameRef also targets wid 801
    const validScrollRes = await fetch(`http://127.0.0.1:${webPort}/api/interact`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Sidecar-Token": token },
      body: JSON.stringify({
        app: "com.example.Multi",
        brokerBootId: broker.brokerBootId,
        frameRef: {
          brokerBootId: broker.brokerBootId,
          targetKey: geom.targetKey,
          geometryRev: geom.geometryRev,
          seq: Math.max(1, mainSel.frameSeq),
          windowId: 801,
        },
        kind: "scroll",
        direction: "down",
        pages: 0.5,
        normX: 0.5,
        normY: 0.5,
      }),
    });
    assert.equal(validScrollRes.status, 200);
    assert.equal(windowScrollCalls.length, 1);
    assert.equal(windowScrollCalls[0].opts.wid, 801);
    assert.deepEqual(windowScrollCalls[0].opts.localPoint, { x: 500, y: 300 });

    // 3. Window resizes live -> stale frameRef must fail 409 with 0 additional writes!
    windows = [
      { pid: 3100, windowId: 801, layer: 0, title: "Main Win", boundsPt: { x: 100, y: 50, width: 820, height: 600 }, onScreen: true },
    ];
    const staleResizeRes = await fetch(`http://127.0.0.1:${webPort}/api/interact`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Sidecar-Token": token },
      body: JSON.stringify({
        app: "com.example.Multi",
        brokerBootId: broker.brokerBootId,
        frameRef: {
          brokerBootId: broker.brokerBootId,
          targetKey: geom.targetKey,
          geometryRev: geom.geometryRev,
          seq: Math.max(1, mainSel.frameSeq),
          windowId: 801,
        },
        kind: "click",
        normX: 0.5,
        normY: 0.5,
      }),
    });
    assert.equal(staleResizeRes.status, 409);
    assert.equal(windowClickCalls.length, 1, "Resized window click must produce 0 native writes");
  } finally {
    await broker.close();
    rmSync(sock, { force: true });
  }
});
