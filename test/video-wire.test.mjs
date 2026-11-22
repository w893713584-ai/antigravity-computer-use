import assert from "node:assert/strict";
import test from "node:test";
import crypto from "node:crypto";
import http from "node:http";
import net from "node:net";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import vm from "node:vm";
import { ComputerUseBrokerServer } from "../src/broker-sidecar.mjs";
import {
  DESKTOP_HELPER_BIN_PATH,
  PREVIEW_VIDEO_JS_PATH,
  UI_HTML_PATH,
  VIDEO_PACKET_TYPE,
} from "../src/constants.mjs";
import { runDesktopHelperEncoderSelfTest } from "../src/native-distribution.mjs";
import { PreviewStreamManager } from "../src/preview-stream.mjs";
import {
  VideoPacketStreamDecoder,
  VideoWebSocketHub,
  decodeVideoPacketHeader,
  encodeVideoPacket,
  parseAndNormalizeAvccAu,
  parseAvcDecoderConfig,
} from "../src/video-websocket.mjs";

function buildSampleAvcC() {
  const sps = Buffer.from([0x67, 0x42, 0xc0, 0x1f, 0xda, 0x01, 0x40, 0x16, 0xec, 0x04, 0x40]);
  const pps = Buffer.from([0x68, 0xce, 0x3c, 0x80]);
  const out = Buffer.alloc(11 + sps.length + pps.length);
  let p = 0;
  out[p++] = 1; // configurationVersion
  out[p++] = sps[1]; // 0x42 Baseline
  out[p++] = sps[2]; // 0xc0 Constrained
  out[p++] = sps[3]; // 0x1f Level 3.1
  out[p++] = 0xff; // lengthSizeMinusOne=3 (4 bytes)
  out[p++] = 0xe1; // 1 SPS
  out.writeUInt16BE(sps.length, p);
  p += 2;
  sps.copy(out, p);
  p += sps.length;
  out[p++] = 1; // 1 PPS
  out.writeUInt16BE(pps.length, p);
  p += 2;
  pps.copy(out, p);
  return { avcC: out, sps, pps };
}

function makeWsMaskedControlFrame(opcode, payload = Buffer.alloc(0)) {
  const mask = Buffer.from([0x12, 0x34, 0x56, 0x78]);
  const out = Buffer.alloc(6 + payload.length);
  out[0] = 0x80 | (opcode & 0x0f);
  out[1] = 0x80 | (payload.length & 0x7f);
  mask.copy(out, 2);
  for (let i = 0; i < payload.length; i += 1) {
    out[6 + i] = payload[i] ^ mask[i & 3];
  }
  return out;
}

class WsTestClient {
  constructor(port, wsPath, { host, origin, protocol = "cua.h264.v1", headers = {} } = {}) {
    this.port = port;
    this.wsPath = wsPath;
    this.host = host || `127.0.0.1:${port}`;
    this.origin = origin !== undefined ? origin : `http://127.0.0.1:${port}`;
    this.protocol = protocol;
    this.extraHeaders = headers;
    this.socket = null;
    this.buf = Buffer.alloc(0);
    this.frames = [];
    this.closed = false;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const key = crypto.randomBytes(16).toString("base64");
      const reqLines = [
        `GET ${this.wsPath} HTTP/1.1`,
        `Host: ${this.host}`,
        ...(this.origin ? [`Origin: ${this.origin}`] : []),
        "Upgrade: websocket",
        "Connection: Upgrade",
        "Sec-WebSocket-Version: 13",
        `Sec-WebSocket-Key: ${key}`,
        ...(this.protocol ? [`Sec-WebSocket-Protocol: ${this.protocol}`] : []),
        ...Object.entries(this.extraHeaders).map(([k, v]) => `${k}: ${v}`),
        "\r\n",
      ];
      const sock = net.connect(this.port, "127.0.0.1", () => {
        sock.write(reqLines.join("\r\n"));
      });
      this.socket = sock;
      let upgraded = false;
      sock.on("data", (chunk) => {
        this.buf = Buffer.concat([this.buf, chunk]);
        if (!upgraded) {
          const idx = this.buf.indexOf("\r\n\r\n");
          if (idx < 0) return;
          const hdrText = this.buf.subarray(0, idx).toString("utf8");
          this.buf = this.buf.subarray(idx + 4);
          if (!hdrText.startsWith("HTTP/1.1 101")) {
            sock.destroy();
            resolve({ statusLine: hdrText.split("\r\n")[0], upgraded: false });
            return;
          }
          upgraded = true;
          this.#drainFrames();
          resolve({ statusLine: hdrText.split("\r\n")[0], upgraded: true, headers: hdrText });
        } else {
          this.#drainFrames();
        }
      });
      sock.on("close", () => {
        this.closed = true;
      });
      sock.on("error", reject);
    });
  }

  #drainFrames() {
    while (this.buf.length >= 2) {
      const b0 = this.buf[0];
      const b1 = this.buf[1];
      const opcode = b0 & 0x0f;
      let len = b1 & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        len = Number(this.buf.readBigUInt64BE(2));
        offset = 10;
      }
      if (this.buf.length < offset + len) return;
      const payload = Buffer.from(this.buf.subarray(offset, offset + len));
      this.buf = this.buf.subarray(offset + len);
      this.frames.push({ opcode, payload });
    }
  }

  close() {
    try {
      this.socket?.destroy();
    } catch {}
  }
}

test("CUV1 40-byte wire codec, avcC profile/level extraction, AVCC NAL normalization, and UDS stream chunking", () => {
  const { avcC } = buildSampleAvcC();
  const parsedCfg = parseAvcDecoderConfig(avcC);
  assert.equal(parsedCfg.ok, true);
  assert.equal(parsedCfg.codec, "avc1.42c01f");
  assert.equal(parsedCfg.nalLengthSize, 4);

  // 2-byte length AVCC AU containing AUD (9) + real IDR (5) -> normalized to 4-byte length + containsIdrNal=true
  const aud = Buffer.from([0x09, 0xf0]);
  const idr = Buffer.from([0x65, 0x88, 0x84, 0x21]);
  const twoByteAu = Buffer.alloc(2 + aud.length + 2 + idr.length);
  twoByteAu.writeUInt16BE(aud.length, 0);
  aud.copy(twoByteAu, 2);
  twoByteAu.writeUInt16BE(idr.length, 2 + aud.length);
  idr.copy(twoByteAu, 4 + aud.length);

  const normAu = parseAndNormalizeAvccAu(twoByteAu, { nalLengthSize: 2 });
  assert.equal(normAu.ok, true);
  assert.equal(normAu.containsIdrNal, true);
  assert.deepEqual(normAu.nalTypes, [9, 5]);
  assert.equal(normAu.data.readUInt32BE(0), aud.length);

  // Non-IDR AU check
  const slice = Buffer.from([0x41, 0x9a, 0x11]);
  const nonIdrAu = Buffer.concat([Buffer.from([0, 0, 0, slice.length]), slice]);
  assert.equal(parseAndNormalizeAvccAu(nonIdrAu).containsIdrNal, false);

  // Encode & verify golden 40-byte big-endian header
  const cfgPayload = Buffer.from(JSON.stringify({ codec: parsedCfg.codec, avcC: avcC.toString("base64") }));
  const cfgPkt = encodeVideoPacket({
    type: VIDEO_PACKET_TYPE.CONFIG,
    streamId: 7,
    generation: 2,
    ptsUs: 123456n,
    payload: cfgPayload,
  });
  assert.equal(cfgPkt.subarray(0, 4).toString("ascii"), "CUV1");
  assert.equal(cfgPkt.readUInt16BE(6), 40);
  assert.equal(cfgPkt.readUInt32BE(8), 7);
  assert.equal(cfgPkt.readUInt32BE(12), 2);
  assert.equal(cfgPkt.readUInt32BE(16), 0);
  assert.equal(cfgPkt.readUInt32BE(20), cfgPayload.length);
  assert.equal(cfgPkt.readBigUInt64BE(24), 123456n);

  const auPkt = encodeVideoPacket({
    type: VIDEO_PACKET_TYPE.ACCESS_UNIT,
    flags: 1,
    streamId: 7,
    generation: 2,
    seq: 1,
    ptsUs: 140000n,
    durationUs: 50000,
    payload: normAu.data,
  });

  // Feed byte-by-byte / uneven splits into VideoPacketStreamDecoder
  const received = [];
  const errors = [];
  const dec = new VideoPacketStreamDecoder({
    onPacket: (p) => received.push(p),
    onError: (e) => errors.push(e),
  });
  const combined = Buffer.concat([cfgPkt, auPkt]);
  dec.push(combined.subarray(0, 17));
  dec.push(combined.subarray(17, 45));
  dec.push(combined.subarray(45));
  assert.equal(errors.length, 0);
  assert.equal(received.length, 2);
  assert.equal(received[0].type, VIDEO_PACKET_TYPE.CONFIG);
  assert.equal(received[1].isIdr, true);
  assert.equal(received[1].seq, 1);

  // Reject malformed header magic or oversized length
  assert.equal(decodeVideoPacketHeader(Buffer.from("BAD1" + "\0".repeat(36))).ok, false);
  const badLenPkt = Buffer.from(cfgPkt.subarray(0, 40));
  badLenPkt.writeUInt32BE(99999999, 20);
  assert.equal(decodeVideoPacketHeader(badLenPkt).ok, false);
});

test("VideoWebSocketHub enforces Host/Origin/single-use-ticket/control-only RFC6455 and isolates slow consumers while keeping control fast", async () => {
  const { avcC } = buildSampleAvcC();
  let streamSeq = 1;
  let startedStreams = [];
  let stoppedStreams = [];
  let keyframeRequests = [];
  let helperTakeoverTargetsCalls = 0;

  const fakeHelper = {
    available: true,
    videoAvailable: true,
    getDiagnostics: () => ({
      available: true,
      videoAvailable: true,
      capabilities: { screenRecordingPreflight: true, inputMonitoringPreflight: true },
    }),
    async startStream(params) {
      const id = streamSeq++;
      startedStreams.push({ id, ...params });
      return { streamId: id };
    },
    async stopStream(id) {
      stoppedStreams.push(id);
      return true;
    },
    async requestKeyframe(id) {
      keyframeRequests.push(id);
      return true;
    },
    async captureWindowJpeg() {
      return null;
    },
    async setTakeoverTargets() {
      helperTakeoverTargetsCalls += 1;
      return true;
    },
  };

  let port = 0;
  let manager;
  const wsHub = new VideoWebSocketHub({
    brokerBootId: "boot-ws",
    getPort: () => port,
    onSubscriberConnected: (sub) => manager?.onWsSubscriberConnected(sub),
    onSubscriberClosed: (sub, reason) => manager?.onWsSubscriberClosed(sub, reason),
    onSubscriberNeedIdr: (sub) => manager?.onWsSubscriberNeedIdr(sub),
    backpressureMaxAgeMs: 90,
  });

  manager = new PreviewStreamManager({
    brokerBootId: "boot-ws",
    desktopHelperClient: fakeHelper,
    wsHub,
    warmHoldMs: 80,
    firstFrameTimeoutMs: 500,
    idrRecoveryTimeoutMs: 120,
  });

  const server = http.createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  wsHub.attach(server);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  port = server.address().port;

  try {
    const geom1 = manager.syncActiveGeometry({
      pid: 1001,
      processToken: "1001:10.0",
      windowId: 10,
      windowBoundsPt: { x: 0, y: 0, width: 1000, height: 600 },
      jxaTrusted: true,
    });
    assert.equal(manager.needsJpegPolling(geom1.targetKey), true);

    // 1. Subscribe fast viewer v1 -> JPEG polling stays TRUE until `rendered` arrives!
    const sub1 = await manager.subscribe({ viewId: "v1", targetKey: geom1.targetKey });
    assert.equal(sub1.mode, "probe");
    assert.equal(manager.needsJpegPolling(geom1.targetKey), true);

    // Wrong Origin rejected
    const badOriginClient = new WsTestClient(port, sub1.wsPath, { origin: "http://evil.example:9999" });
    const badOriginRes = await badOriginClient.connect();
    assert.equal(badOriginRes.upgraded, false);

    // Expired/consumed single-use ticket -> retry same wsPath after consumption fails (since badOrigin already consumed ticket, re-subscribe)
    const sub1b = await manager.subscribe({ viewId: "v1", targetKey: geom1.targetKey });
    const ws1 = new WsTestClient(port, sub1b.wsPath);
    const up1 = await ws1.connect();
    assert.equal(up1.upgraded, true);

    // Reusing same ticket fails
    const replayClient = new WsTestClient(port, sub1b.wsPath);
    const replayRes = await replayClient.connect();
    assert.equal(replayRes.upgraded, false);

    // Push CONFIG generation 1 -> client gets CONFIG
    const cfgPayload = Buffer.from(
      JSON.stringify({
        codec: "avc1.42c01f",
        avcC: avcC.toString("base64"),
        codedWidth: 960,
        codedHeight: 576,
        displayWidth: 960,
        displayHeight: 576,
        targetKey: geom1.targetKey,
        geometryRev: geom1.geometryRev,
        contentRectPt: { x: 0, y: 0, width: 1000, height: 600 },
      })
    );
    manager.handleVideoPacket({
      type: VIDEO_PACKET_TYPE.CONFIG,
      flags: 0,
      streamId: sub1b.streamId,
      generation: 1,
      seq: 0,
      ptsUs: 100n,
      durationUs: 0,
      payload: cfgPayload,
      rawPacket: encodeVideoPacket({
        type: VIDEO_PACKET_TYPE.CONFIG,
        streamId: sub1b.streamId,
        generation: 1,
        ptsUs: 100n,
        payload: cfgPayload,
      }),
    });

    // Delta AU sent BEFORE decode_ready must NOT reach client
    const deltaPayload = Buffer.from([0, 0, 0, 3, 0x41, 0x9a, 0x01]);
    manager.handleVideoPacket({
      type: VIDEO_PACKET_TYPE.ACCESS_UNIT,
      flags: 0,
      isIdr: false,
      streamId: sub1b.streamId,
      generation: 1,
      seq: 1,
      ptsUs: 150n,
      durationUs: 50,
      payload: deltaPayload,
      rawPacket: encodeVideoPacket({
        type: VIDEO_PACKET_TYPE.ACCESS_UNIT,
        flags: 0,
        streamId: sub1b.streamId,
        generation: 1,
        seq: 1,
        ptsUs: 150n,
        durationUs: 50,
        payload: deltaPayload,
      }),
    });
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(ws1.frames.filter((f) => f.opcode === 2).length, 1, "Only CONFIG should be delivered before decode_ready");

    // Client sends masked ping -> hub replies pong; decode_ready + IDR + rendered -> JPEG polling turns OFF
    ws1.socket.write(makeWsMaskedControlFrame(0x9, Buffer.from("hi")));
    await manager.handleControl({ viewId: "v1", action: "decode_ready", streamId: sub1b.streamId, generation: 1 });
    assert.equal(keyframeRequests.length >= 1, true);

    const idrPayload = Buffer.from([0, 0, 0, 4, 0x65, 0x88, 0x84, 0x21]);
    manager.handleVideoPacket({
      type: VIDEO_PACKET_TYPE.ACCESS_UNIT,
      flags: 1,
      isIdr: true,
      streamId: sub1b.streamId,
      generation: 1,
      seq: 2,
      ptsUs: 200n,
      durationUs: 50,
      payload: idrPayload,
      rawPacket: encodeVideoPacket({
        type: VIDEO_PACKET_TYPE.ACCESS_UNIT,
        flags: 1,
        streamId: sub1b.streamId,
        generation: 1,
        seq: 2,
        ptsUs: 200n,
        durationUs: 50,
        payload: idrPayload,
      }),
    });
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(ws1.frames.some((f) => f.opcode === 0xa && f.payload.toString() === "hi"), true);
    assert.equal(ws1.frames.filter((f) => f.opcode === 2).length, 2, "IDR must arrive after decode_ready");
    assert.equal(manager.needsJpegPolling(geom1.targetKey), true, "JPEG polling MUST remain active until rendered");

    await manager.handleControl({ viewId: "v1", action: "rendered", streamId: sub1b.streamId, generation: 1, seq: 2 });
    assert.equal(manager.needsJpegPolling(geom1.targetKey), false, "JPEG polling pauses only after rendered");

    // Stale generation AU rejected by hub
    manager.handleVideoPacket({
      type: VIDEO_PACKET_TYPE.ACCESS_UNIT,
      flags: 1,
      isIdr: true,
      streamId: sub1b.streamId,
      generation: 0,
      seq: 1,
      ptsUs: 50n,
      durationUs: 50,
      payload: idrPayload,
      rawPacket: encodeVideoPacket({
        type: VIDEO_PACKET_TYPE.ACCESS_UNIT,
        flags: 1,
        streamId: sub1b.streamId,
        generation: 0,
        seq: 1,
        ptsUs: 50n,
        durationUs: 50,
        payload: idrPayload,
      }),
    });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(ws1.frames.filter((f) => f.opcode === 2).length, 2);

    // 2. Slow subscriber backpressure isolation vs fast subscriber + control
    const subSlow = await manager.subscribe({ viewId: "vSlow", targetKey: geom1.targetKey });
    const wsSlow = new WsTestClient(port, subSlow.wsPath);
    await wsSlow.connect();
    await manager.handleControl({ viewId: "vSlow", action: "decode_ready", streamId: subSlow.streamId, generation: 1 });
    // Deliver an IDR first so vSlow exits awaitIdr, then transition it to rendered
    manager.handleVideoPacket({
      type: VIDEO_PACKET_TYPE.ACCESS_UNIT,
      flags: 1,
      isIdr: true,
      streamId: sub1b.streamId,
      generation: 1,
      seq: 3,
      ptsUs: 250n,
      durationUs: 50,
      payload: idrPayload,
      rawPacket: encodeVideoPacket({
        type: VIDEO_PACKET_TYPE.ACCESS_UNIT,
        flags: 1,
        streamId: sub1b.streamId,
        generation: 1,
        seq: 3,
        ptsUs: 250n,
        durationUs: 50,
        payload: idrPayload,
      }),
    });
    await new Promise((r) => setTimeout(r, 20));
    await manager.handleControl({ viewId: "vSlow", action: "rendered", streamId: subSlow.streamId, generation: 1, seq: 3 });

    // Force slow backpressure on vSlow's internal subscriber object while pushing AU seq=4
    const slowSubObj = wsHub.getSubscribersForTarget(geom1.targetKey).find((s) => s.viewId === "vSlow");
    slowSubObj.writeInFlight = true;
    const okTakeover = await fakeHelper.setTakeoverTargets([{ pid: 1001 }]);
    assert.equal(okTakeover, true);
    assert.equal(helperTakeoverTargetsCalls, 1);

    const ws1BinaryBefore = ws1.frames.filter((f) => f.opcode === 2).length;
    // Push AU while vSlow is stalled -> wait >90ms backpressure timeout -> only vSlow disconnects while v1 receives AU
    manager.handleVideoPacket({
      type: VIDEO_PACKET_TYPE.ACCESS_UNIT,
      flags: 0,
      isIdr: false,
      streamId: sub1b.streamId,
      generation: 1,
      seq: 4,
      ptsUs: 300n,
      durationUs: 50,
      payload: deltaPayload,
      rawPacket: encodeVideoPacket({
        type: VIDEO_PACKET_TYPE.ACCESS_UNIT,
        flags: 0,
        streamId: sub1b.streamId,
        generation: 1,
        seq: 4,
        ptsUs: 300n,
        durationUs: 50,
        payload: deltaPayload,
      }),
    });
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(wsSlow.closed, true, "Slow subscriber must disconnect after backpressure limit");
    assert.equal(ws1.closed, false, "Fast subscriber must remain connected");
    assert.equal(ws1.frames.filter((f) => f.opcode === 2).length, ws1BinaryBefore + 1, "Fast subscriber must still receive AU");
    assert.equal(manager.needsJpegPolling(geom1.targetKey), true, "Slow viewer fallback restores JPEG polling");

    // Inbound masked text frame on v1 violates control-only RFC 6455 rule and closes socket
    ws1.socket.write(makeWsMaskedControlFrame(0x1, Buffer.from("illegal")));
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(ws1.closed, true);

    // 3. Stream pause / blank without JPEG fallback transitions to streamPaused + readOnly
    await manager.handleHelperStreamStatus({ streamId: sub1b.streamId, targetKey: geom1.targetKey, state: "suspended", reason: "window_minimized" });
    assert.equal(manager.getActiveGeometry().readOnly, true);
    assert.equal(manager.getViewTransportSummary(geom1.targetKey).streamPaused, true);

    // Warm hold stop after unsubscribe
    await manager.unsubscribeView("v1");
    await manager.unsubscribeView("vSlow");
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(stoppedStreams.includes(sub1b.streamId), true);

    // 4. Max 2 active targets, idle warm-hold reclaim, 3rd live target degrades gracefully, AGY_CUA_VIDEO=jpeg rollback, and blank->same-WID JPEG fallback
    let jpegFallbackCaptured = false;
    fakeHelper.captureWindowJpeg = async ({ pid, windowId }) => {
      jpegFallbackCaptured = true;
      return {
        data: Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x00, 0x02, 0x00, 0x03, 0xff, 0xd9]).toString("base64"),
        mimeType: "image/jpeg",
        width: 512,
        height: 256,
        pid,
        windowId,
      };
    };
    let onFallbackCalled = 0;
    const manager2 = new PreviewStreamManager({
      brokerBootId: "boot-cap",
      desktopHelperClient: fakeHelper,
      wsHub,
      warmHoldMs: 500,
      firstFrameTimeoutMs: 500,
      onFallbackJpegFrame: () => {
        onFallbackCalled += 1;
      },
    });
    const gA = manager2.syncActiveGeometry({ pid: 201, windowId: 1, windowBoundsPt: { x: 0, y: 0, width: 800, height: 600 }, jxaTrusted: true });
    const gB = manager2.syncActiveGeometry({ pid: 202, windowId: 2, windowBoundsPt: { x: 0, y: 0, width: 800, height: 600 }, jxaTrusted: true });
    const gC = manager2.syncActiveGeometry({ pid: 203, windowId: 3, windowBoundsPt: { x: 0, y: 0, width: 800, height: 600 }, jxaTrusted: true });
    const sA = await manager2.subscribe({ viewId: "va", targetKey: gA.targetKey });
    const sB = await manager2.subscribe({ viewId: "vb", targetKey: gB.targetKey });
    assert.equal(sA.mode, "probe");
    assert.equal(sB.mode, "probe");
    const sC = await manager2.subscribe({ viewId: "vc", targetKey: gC.targetKey });
    assert.equal(sC.mode, "jpeg");
    assert.equal(sC.reason, "max_streams_reached");

    // Unsubscribe vb (leaves gB in warm hold) -> subscribing vc now reclaims warm-hold slot gB cleanly!
    await manager2.unsubscribeView("vb");
    const sC2 = await manager2.subscribe({ viewId: "vc", targetKey: gC.targetKey });
    assert.equal(sC2.mode, "probe");

    // Blank status tries same-WID JPEG capture cleanly
    await manager2.handleHelperStreamStatus({ streamId: sA.streamId, targetKey: gA.targetKey, state: "blank", reason: "sc_frame_blank" });
    assert.equal(jpegFallbackCaptured, true);
    assert.equal(onFallbackCalled, 1);

    // Rollback mode forces jpeg
    const managerRollback = new PreviewStreamManager({
      brokerBootId: "boot-rb",
      videoMode: "jpeg",
      desktopHelperClient: fakeHelper,
      wsHub,
    });
    const gRb = managerRollback.syncActiveGeometry({ pid: 204, windowId: 4, windowBoundsPt: { x: 0, y: 0, width: 800, height: 600 }, jxaTrusted: true });
    const sRb = await managerRollback.subscribe({ viewId: "vrb", targetKey: gRb.targetKey });
    assert.equal(sRb.mode, "jpeg");
    assert.equal(sRb.reason, "video_rollback_jpeg");
    await managerRollback.closeAll();
    await manager2.closeAll();
  } finally {
    await manager.closeAll();
    wsHub.closeAll();
    await new Promise((r) => server.close(r));
  }
});

test("UI preview-video.js and index.html are XSS-safe (.innerHTML free) and parse cleanly", () => {
  const html = readFileSync(UI_HTML_PATH, "utf8");
  const videoJs = readFileSync(PREVIEW_VIDEO_JS_PATH, "utf8");
  assert.equal(/\.innerHTML\s*=/u.test(html), false, "index.html must not contain .innerHTML =");
  assert.equal(/\.innerHTML\s*=/u.test(videoJs), false, "preview-video.js must not contain .innerHTML =");

  // Execute preview-video.js UMD/IIFE in isolated vm context to verify syntax + pure geometry helpers
  const sandbox = {
    window: { location: { protocol: "http:", host: "127.0.0.1:1234" }, isSecureContext: true },
    atob: (s) => Buffer.from(s, "base64").toString("binary"),
  };
  vm.runInNewContext(videoJs, sandbox);
  const helpers = sandbox.window.CUAPreviewVideo;
  assert.ok(helpers);
  const plain = (v) => JSON.parse(JSON.stringify(v));
  const vis = plain(helpers.computeContainDisplayRect(500, 400, 1000, 600));
  assert.deepEqual(vis, { x: 0, y: 50, width: 500, height: 300 });
  assert.equal(helpers.pointerToNormalizedContent(10, 10, vis), null);
  assert.deepEqual(plain(helpers.pointerToNormalizedContent(375, 125, vis)), { normX: 0.75, normY: 0.25 });
  const cur = plain(helpers.projectCursor({ x: 750, y: 150 }, { x: 0, y: 0, width: 1000, height: 600 }));
  assert.deepEqual(cur, { visible: true, normX: 0.75, normY: 0.25 });

  // Also parse inline <script> inside src/ui/index.html to guarantee zero JS syntax errors
  const scriptMatches = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gu)];
  assert.equal(scriptMatches.length, 1);
  new vm.Script(scriptMatches[0][1], { filename: "src/ui/index.html" });

  // Verify renderPermissionsBanner avoids JXA Screen Recording false positives when DesktopHelper has SR
  const bannerFnMatch = scriptMatches[0][1].match(
    /function renderPermissionsBanner\([\s\S]*?\n      \}\n\n      function renderWinMeta/u
  );
  assert.ok(bannerFnMatch, "renderPermissionsBanner function must exist in index.html");
  const bannerFnSrc = bannerFnMatch[0].replace(/\n\n      function renderWinMeta$/u, "");
  const makeStubNode = (tag = "div") => ({
    tag,
    className: "",
    type: "",
    textContent: "",
    children: [],
    listeners: {},
    classList: {
      classes: new Set(),
      add(c) {
        this.classes.add(c);
      },
      remove(c) {
        this.classes.delete(c);
      },
      contains(c) {
        return this.classes.has(c);
      },
    },
    appendChild(child) {
      if (child?.tag === "#fragment") {
        this.children.push(...child.children);
      } else {
        this.children.push(child);
      }
      return child;
    },
    replaceChildren(...nodes) {
      this.children = [];
      for (const n of nodes) this.appendChild(n);
    },
    addEventListener(ev, fn) {
      this.listeners[ev] = fn;
    },
  });
  const permBanner = makeStubNode("div");
  const bannerCtx = {
    permBanner,
    requestHelperPermission: () => {},
    document: {
      createDocumentFragment: () => makeStubNode("#fragment"),
      createElement: (tag) => makeStubNode(tag),
    },
  };
  vm.runInNewContext(`${bannerFnSrc}\nglobalThis.__renderPermissionsBanner = renderPermissionsBanner;`, bannerCtx);
  const renderPermissionsBanner = bannerCtx.__renderPermissionsBanner;

  // Case 1: JXA says screenRecording=false, helper has screenRecordingPreflight=true & needs input monitoring
  renderPermissionsBanner(
    { platform: "darwin", accessibility: true, screenRecording: false },
    {
      desktopHelper: {
        status: "baseline",
        capabilities: {
          screenRecordingPreflight: true,
          inputMonitoringPreflight: false,
          mouseTapActive: false,
          keyTapActive: false,
        },
      },
    }
  );
  assert.equal(permBanner.classList.contains("show"), true);
  assert.equal(permBanner.children[0].textContent.includes("缺少 macOS 权限"), false);
  assert.equal(permBanner.children[0].textContent.includes("基础接管模式"), true);
  assert.deepEqual(
    permBanner.children.slice(1).map((b) => b.textContent),
    ["开启精准输入接管"]
  );

  // Case 2: Enhanced helper with Screen Recording + Input Monitoring hides banner even if stale permissions.screenRecording=false
  renderPermissionsBanner(
    { platform: "darwin", accessibility: true, screenRecording: false },
    {
      desktopHelper: {
        status: "enhanced",
        capabilities: {
          screenRecordingPreflight: true,
          inputMonitoringPreflight: true,
          mouseTapActive: true,
          keyTapActive: true,
        },
      },
    }
  );
  assert.equal(permBanner.classList.contains("show"), false);

  // Case 3: Helper temporarily unavailable while reconnecting surfaces reconnecting hint
  renderPermissionsBanner(
    { platform: "darwin", accessibility: true, screenRecording: true },
    { desktopHelper: { status: "unavailable", reason: "reconnecting", capabilities: {} } }
  );
  assert.equal(permBanner.classList.contains("show"), true);
  assert.equal(permBanner.children[0].textContent.includes("正在重连"), true);
});

test("PreviewVideoController re-emits rendered on resize generation change and enforces transient fallback retryCooldownMs", async () => {
  const videoJs = readFileSync(PREVIEW_VIDEO_JS_PATH, "utf8");
  const { avcC } = buildSampleAvcC();
  const sockets = [];
  const apiPosts = [];
  let subscribeCalls = 0;

  class FakeWebSocket {
    constructor(url, protocols) {
      this.url = url;
      this.protocols = protocols;
      this.binaryType = "";
      this.onmessage = null;
      this.onerror = null;
      this.onclose = null;
      sockets.push(this);
    }
    close() {}
  }

  class FakeEncodedVideoChunk {
    constructor(init) {
      this.init = init;
    }
  }

  class FakeVideoDecoder {
    constructor(init) {
      this.output = init.output;
      this.error = init.error;
      this.state = "unconfigured";
      this.decodeQueueSize = 0;
    }
    static async isConfigSupported() {
      return { supported: true };
    }
    configure() {
      this.state = "configured";
    }
    decode(chunk) {
      let closed = false;
      this.output({
        displayWidth: chunk?.init?.type === "key" ? 800 : 800,
        codedWidth: 800,
        codedHeight: 600,
        close() {
          closed = true;
        },
      });
      assert.equal(closed, true);
    }
    close() {
      this.state = "closed";
    }
  }

  const sandbox = {
    window: { location: { protocol: "http:", host: "127.0.0.1:4321" }, isSecureContext: true },
    atob: (s) => Buffer.from(s, "base64").toString("binary"),
    TextDecoder,
    Uint8Array,
    ArrayBuffer,
    DataView,
    Date,
    Math,
    setTimeout,
    clearTimeout,
    VideoDecoder: FakeVideoDecoder,
    EncodedVideoChunk: FakeEncodedVideoChunk,
    WebSocket: FakeWebSocket,
  };
  sandbox.window.VideoDecoder = FakeVideoDecoder;
  sandbox.window.EncodedVideoChunk = FakeEncodedVideoChunk;
  sandbox.window.WebSocket = FakeWebSocket;
  vm.runInNewContext(videoJs, sandbox);

  const canvas = {
    width: 0,
    height: 0,
    getContext() {
      return {
        drawImage() {},
        clearRect() {},
      };
    },
  };

  const transportEvents = [];
  const ctrl = new sandbox.window.CUAPreviewVideo.PreviewVideoController({
    canvas,
    retryCooldownMs: 5000,
    getToken: () => "tok-1",
    getBrokerBootId: () => "boot-1",
    onH264Frame: () => {},
    onTransportChange: (ev) => transportEvents.push(ev),
    apiPost: async (pathUrl, body) => {
      apiPosts.push({ pathUrl, body });
      if (pathUrl === "/api/video/subscribe") {
        subscribeCalls += 1;
        return {
          mode: "probe",
          streamId: 9,
          wsPath: "/ws/video?viewId=" + body.viewId,
          firstFrameTimeoutMs: 2000,
        };
      }
      return { ok: true };
    },
  });

  const toAb = (buf) => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

  ctrl.syncTarget({ targetKey: "pid:7001:wid:501", activeApp: "com.lemon.lvpro", streamPaused: false });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(subscribeCalls, 1);
  assert.equal(sockets.length, 1);

  // Generation 1 config + IDR
  const cfg1 = encodeVideoPacket({
    type: VIDEO_PACKET_TYPE.CONFIG,
    streamId: 9,
    generation: 1,
    seq: 1,
    payload: Buffer.from(
      JSON.stringify({
        codec: "avc1.42c01f",
        codedWidth: 800,
        codedHeight: 600,
        avcC: avcC.toString("base64"),
        targetKey: "pid:7001:wid:501",
        geometryRev: 1,
      })
    ),
  });
  sockets[0].onmessage({ data: toAb(cfg1) });
  await new Promise((r) => setTimeout(r, 10));
  const idr1 = encodeVideoPacket({
    type: VIDEO_PACKET_TYPE.ACCESS_UNIT,
    streamId: 9,
    generation: 1,
    seq: 1,
    flags: 1,
    payload: Buffer.from([0x00, 0x00, 0x00, 0x02, 0x65, 0x00]),
  });
  sockets[0].onmessage({ data: toAb(idr1) });
  await new Promise((r) => setTimeout(r, 10));

  const rendered1 = apiPosts.filter((p) => p.pathUrl === "/api/video/control" && p.body.action === "rendered");
  assert.equal(rendered1.length, 1);
  assert.equal(rendered1[0].body.generation, 1);
  assert.equal(ctrl.renderedGeneration, 1);
  assert.equal(ctrl.hasDrawnFirstFrame, true);

  // Generation 2 resize config + IDR while hasDrawnFirstFrame is already true must emit a second rendered!
  const cfg2 = encodeVideoPacket({
    type: VIDEO_PACKET_TYPE.CONFIG,
    streamId: 9,
    generation: 2,
    seq: 2,
    payload: Buffer.from(
      JSON.stringify({
        codec: "avc1.42c01f",
        codedWidth: 1024,
        codedHeight: 768,
        avcC: avcC.toString("base64"),
        targetKey: "pid:7001:wid:501",
        geometryRev: 2,
      })
    ),
  });
  sockets[0].onmessage({ data: toAb(cfg2) });
  await new Promise((r) => setTimeout(r, 10));
  const idr2 = encodeVideoPacket({
    type: VIDEO_PACKET_TYPE.ACCESS_UNIT,
    streamId: 9,
    generation: 2,
    seq: 1,
    flags: 1,
    payload: Buffer.from([0x00, 0x00, 0x00, 0x02, 0x65, 0x01]),
  });
  sockets[0].onmessage({ data: toAb(idr2) });
  await new Promise((r) => setTimeout(r, 10));

  const renderedAll = apiPosts.filter((p) => p.pathUrl === "/api/video/control" && p.body.action === "rendered");
  assert.equal(renderedAll.length, 2);
  assert.equal(renderedAll[1].body.generation, 2);
  assert.equal(ctrl.renderedGeneration, 2);

  // Transient fallback sets cooldown; immediate syncTarget polls must NOT thrash /api/video/subscribe
  ctrl.triggerFallback("ws_closed", false);
  assert.equal(ctrl.mode, "jpeg");
  assert.ok(ctrl.retryNotBeforeAt > Date.now());
  ctrl.syncTarget({ targetKey: "pid:7001:wid:501", activeApp: "com.lemon.lvpro", streamPaused: false });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(subscribeCalls, 1, "Repeated syncTarget within retryCooldownMs must not resubscribe");

  // Switching targetKey clears cooldown and subscribes immediately
  ctrl.syncTarget({ targetKey: "pid:7001:wid:502", activeApp: "com.lemon.lvpro", streamPaused: false });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(subscribeCalls, 2);
  ctrl.stop("test_done");
});

test("H.264 sourceCropPx uses 9-arg cropped drawImage, geometryVerified:false marks readOnly, and live CUADesktopHelper --self-test-encoder emits IDR", async () => {
  const videoJs = readFileSync(PREVIEW_VIDEO_JS_PATH, "utf8");
  const { avcC } = buildSampleAvcC();
  const drawCalls = [];
  const sockets = [];

  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      sockets.push(this);
    }
    close() {}
  }
  class FakeEncodedVideoChunk {
    constructor(init) {
      this.init = init;
    }
  }
  class FakeVideoDecoder {
    constructor(init) {
      this.output = init.output;
      this.state = "unconfigured";
      this.decodeQueueSize = 0;
    }
    static async isConfigSupported() {
      return { supported: true };
    }
    configure() {
      this.state = "configured";
    }
    decode() {
      this.output({ displayWidth: 1000, codedWidth: 1000, codedHeight: 600, close() {} });
    }
    close() {
      this.state = "closed";
    }
  }

  const sandbox = {
    window: { location: { protocol: "http:", host: "127.0.0.1:4322" }, isSecureContext: true },
    atob: (s) => Buffer.from(s, "base64").toString("binary"),
    TextDecoder,
    Uint8Array,
    ArrayBuffer,
    DataView,
    Date,
    Math,
    setTimeout,
    clearTimeout,
    VideoDecoder: FakeVideoDecoder,
    EncodedVideoChunk: FakeEncodedVideoChunk,
    WebSocket: FakeWebSocket,
  };
  sandbox.window.VideoDecoder = FakeVideoDecoder;
  sandbox.window.EncodedVideoChunk = FakeEncodedVideoChunk;
  sandbox.window.WebSocket = FakeWebSocket;
  vm.runInNewContext(videoJs, sandbox);

  const canvas = {
    width: 0,
    height: 0,
    getContext() {
      return {
        drawImage(...args) {
          drawCalls.push(args);
        },
      };
    },
  };
  const ctrl = new sandbox.window.CUAPreviewVideo.PreviewVideoController({
    canvas,
    getToken: () => "tok",
    getBrokerBootId: () => "boot",
    apiPost: async (pathUrl) =>
      pathUrl === "/api/video/subscribe"
        ? { mode: "probe", streamId: 12, wsPath: "/ws/video?viewId=crop", firstFrameTimeoutMs: 2000 }
        : { ok: true },
  });
  const toAb = (buf) => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

  ctrl.syncTarget({ targetKey: "v1|7001||501|1", activeApp: "com.lemon.lvpro", streamPaused: false });
  await new Promise((r) => setTimeout(r, 15));
  sockets[0].onmessage({
    data: toAb(
      encodeVideoPacket({
        type: VIDEO_PACKET_TYPE.CONFIG,
        streamId: 12,
        generation: 1,
        payload: Buffer.from(
          JSON.stringify({
            codec: "avc1.42c01f",
            codedWidth: 1000,
            codedHeight: 600,
            sourceCropPx: { x: 20, y: 10, width: 900, height: 540 },
            avcC: avcC.toString("base64"),
            targetKey: "v1|7001||501|1",
            geometryRev: 1,
          })
        ),
      })
    ),
  });
  await new Promise((r) => setTimeout(r, 10));
  sockets[0].onmessage({
    data: toAb(
      encodeVideoPacket({
        type: VIDEO_PACKET_TYPE.ACCESS_UNIT,
        streamId: 12,
        generation: 1,
        seq: 1,
        flags: 1,
        payload: Buffer.from([0x00, 0x00, 0x00, 0x02, 0x65, 0x00]),
      })
    ),
  });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(canvas.width, 900);
  assert.equal(canvas.height, 540);
  assert.equal(drawCalls.length, 1);
  assert.equal(drawCalls[0].length, 9);
  assert.deepEqual(drawCalls[0].slice(1), [20, 10, 900, 540, 0, 0, 900, 540]);
  ctrl.stop("test_done");

  // Unverified ScreenCaptureKit contentRect geometry downgrades PreviewStreamManager target to readOnly
  const server = http.createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const wsHub = new VideoWebSocketHub({ server, getBrokerBootId: () => "boot-ro" });
  const manager = new PreviewStreamManager({
    brokerBootId: "boot-ro",
    desktopHelperClient: { available: false },
    wsHub,
  });
  try {
    const g = manager.syncActiveGeometry({
      pid: 7001,
      windowId: 501,
      windowBoundsPt: { x: 0, y: 0, width: 800, height: 600 },
      jxaTrusted: true,
    });
    assert.equal(g.readOnly, false);
    const s = await manager.subscribe({ viewId: "v-ro", targetKey: g.targetKey });
    assert.equal(s.mode, "jpeg"); // no helper -> verify handler directly via fake helper path
    const mgr2 = new PreviewStreamManager({
      brokerBootId: "boot-ro",
      desktopHelperClient: {
        available: true,
        videoAvailable: true,
        getDiagnostics() {
          return {
            available: true,
            videoAvailable: true,
            capabilities: { screenRecordingPreflight: true },
          };
        },
        async startStream() {
          return { streamId: 55, codedWidth: 800, codedHeight: 600 };
        },
        async stopStream() {
          return true;
        },
      },
      wsHub,
    });
    const g2 = mgr2.syncActiveGeometry({
      pid: 7001,
      windowId: 502,
      windowBoundsPt: { x: 0, y: 0, width: 800, height: 600 },
      jxaTrusted: true,
    });
    const sub2 = await mgr2.subscribe({ viewId: "v-ro2", targetKey: g2.targetKey });
    assert.equal(sub2.mode, "probe");
    const cfgBuf = Buffer.from(
      JSON.stringify({
        codec: "avc1.42c01f",
        codedWidth: 800,
        codedHeight: 600,
        avcC: avcC.toString("base64"),
        targetKey: g2.targetKey,
        geometryRev: 1,
        geometryVerified: false,
      })
    );
    mgr2.handleVideoPacket({
      type: VIDEO_PACKET_TYPE.CONFIG,
      flags: 0,
      streamId: 55,
      generation: 1,
      seq: 0,
      ptsUs: 100n,
      durationUs: 0,
      payload: cfgBuf,
      rawPacket: encodeVideoPacket({
        type: VIDEO_PACKET_TYPE.CONFIG,
        streamId: 55,
        generation: 1,
        ptsUs: 100n,
        payload: cfgBuf,
      }),
    });
    const roGeom = mgr2.getGeometry(g2.targetKey);
    assert.equal(roGeom.readOnly, true);
    assert.equal(roGeom.readOnlyReason, "unverified_sc_geometry");
    await mgr2.closeAll();
  } finally {
    await manager.closeAll();
    wsHub.closeAll();
    await new Promise((r) => server.close(r));
  }

  if (process.platform === "darwin") {
    const encRes = await runDesktopHelperEncoderSelfTest(DESKTOP_HELPER_BIN_PATH);
    assert.equal(encRes.ok, true, `Expected hardware H.264 self-test pass: ${JSON.stringify(encRes)}`);
    assert.equal(encRes.isIdr, true);
    assert.equal(encRes.auBytes > 0, true);
  }
});

test("Codex 6.2 regressions: WS permessage-deflate upgrade, strict Close validation, viewId H.264 frameRef, and pinned OCU fallback block", async () => {
  const { avcC } = buildSampleAvcC();
  let port = 0;
  let lastNeedIdrStream = 0;
  const wsHub = new VideoWebSocketHub({
    brokerBootId: "boot-codex62",
    getPort: () => port,
    onSubscriberNeedIdr: (sub) => {
      lastNeedIdrStream = sub.streamId;
    },
  });
  const server = http.createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  wsHub.attach(server);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  port = server.address().port;

  try {
    // 1. Client offering permessage-deflate upgrades cleanly (101) without echoing extensions,
    // and malformed 1-byte Close frame receives RFC6455 1002 close frame.
    const ticket = wsHub.issueTicket({
      viewId: "v-ext-1",
      targetKey: "100:100.0:200:1",
      streamId: 11,
    });
    const cli = new WsTestClient(port, `/api/video/ws?ticket=${ticket}`, {
      headers: { "Sec-WebSocket-Extensions": "permessage-deflate; client_max_window_bits" },
    });
    const res = await cli.connect();
    assert.equal(res.upgraded, true, `Expected 101 upgrade with permessage-deflate offer: ${JSON.stringify(res)}`);
    assert.equal(/sec-websocket-extensions/iu.test(res.headers || ""), false);

    cli.socket.write(makeWsMaskedControlFrame(0x8, Buffer.from([0x03])));
    await new Promise((r) => setTimeout(r, 70));
    const closeFrame = cli.frames.find((f) => f.opcode === 0x8);
    assert.ok(closeFrame, "Expected server Close frame before destroy");
    assert.equal(closeFrame.payload.readUInt16BE(0), 1002);
    cli.close();

    // 2. PreviewStreamManager.validateH264FrameRef enforces viewId + active H264 view + generation
    const manager = new PreviewStreamManager({
      brokerBootId: "boot-codex62",
      desktopHelperClient: {
        available: true,
        videoAvailable: true,
        getDiagnostics: () => ({
          available: true,
          videoAvailable: true,
          capabilities: { screenRecordingPreflight: true },
        }),
        startStream: async () => ({
          streamId: 21,
          targetKey: "100:100.0:201:1",
          geometryRev: 1,
          codedWidth: 640,
          codedHeight: 360,
        }),
        requestKeyframe: async () => ({ ok: true }),
        stopStream: async () => ({ ok: true }),
      },
      wsHub,
      onStateChanged: () => {},
    });
    const geom = manager.syncActiveGeometry({
      pid: 100,
      processToken: "100:100.0",
      windowId: 201,
      explicitWindowId: true,
      windowBoundsPt: { x: 0, y: 0, width: 640, height: 360 },
      previewPixelSize: { width: 640, height: 360 },
      actionPixelSize: { width: 640, height: 360 },
      jxaTrusted: true,
    });
    const sub = await manager.subscribe({ viewId: "v-issued", targetKey: geom.targetKey });
    assert.equal(sub.mode, "probe");
    assert.ok(sub.wsPath);
    const cfgBuf = Buffer.from(
      JSON.stringify({
        codec: "avc1.42c01f",
        avcC: avcC.toString("base64"),
        codedWidth: 640,
        codedHeight: 360,
        displayWidth: 640,
        displayHeight: 360,
        targetKey: geom.targetKey,
        geometryRev: 1,
      })
    );
    manager.handleVideoPacket({
      type: VIDEO_PACKET_TYPE.CONFIG,
      flags: 0,
      streamId: 21,
      generation: 1,
      seq: 0,
      ptsUs: 100n,
      durationUs: 0,
      payload: cfgBuf,
      rawPacket: encodeVideoPacket({
        type: VIDEO_PACKET_TYPE.CONFIG,
        streamId: 21,
        generation: 1,
        ptsUs: 100n,
        payload: cfgBuf,
      }),
    });
    await manager.handleControl({ viewId: "v-issued", action: "decode_ready", streamId: 21, generation: 1 });
    await manager.handleControl({ viewId: "v-issued", action: "rendered", streamId: 21, generation: 1, seq: 1 });

    assert.equal(
      manager.validateH264FrameRef({
        transport: "h264",
        viewId: "v-issued",
        streamId: 21,
        generation: 1,
        targetKey: geom.targetKey,
      }).ok,
      true
    );
    assert.equal(
      manager.validateH264FrameRef({
        transport: "h264",
        viewId: "v-forged",
        streamId: 21,
        generation: 1,
        targetKey: geom.targetKey,
      }).code,
      "STALE_VIEW"
    );
    await manager.handleControl({ viewId: "v-issued", action: "fallback", streamId: 21, reason: "test_drop" });
    assert.equal(
      manager.validateH264FrameRef({
        transport: "h264",
        viewId: "v-issued",
        streamId: 21,
        generation: 1,
        targetKey: geom.targetKey,
      }).code,
      "STALE_VIEW"
    );
    await manager.closeAll();

    // 3. Pinned window MUST NOT fall back to unpinned OCU get_app_state screenshot when helper JPEG fails
    let ocuUnpinnedScreenshotCalls = 0;
    const pinnedSock = path.join(tmpdir(), `cua-pinned-noocu-${process.pid}-${Date.now()}.sock`);
    const fakeHelper = {
      available: true,
      getDiagnostics: () => ({
        available: true,
        capabilities: {
          screenRecordingPreflight: true,
          inputMonitoringPreflight: true,
          mouseTapActive: false,
          keyTapActive: false,
          hotkeyActive: false,
        },
      }),
      listWindows: async () => [
        { pid: process.pid, processToken: `${process.pid}:1`, windowId: 801, layer: 0, title: "Main", alpha: 1, onScreen: true, boundsPt: { x: 0, y: 0, width: 800, height: 600 } },
        { pid: process.pid, processToken: `${process.pid}:1`, windowId: 802, layer: 0, title: "Child", alpha: 1, onScreen: true, boundsPt: { x: 50, y: 50, width: 400, height: 300 } },
      ],
      captureWindowJpeg: async () => null,
      start: async function () { return this.getDiagnostics(); },
      setTakeoverTargets: async () => true,
      resetTakeoverLatch: async () => true,
      probe: async function () { return this.getDiagnostics(); },
      close: async () => {},
    };
    const peerMock = {
      async listTools() {
        return { tools: [{ name: "list_apps" }, { name: "get_app_state" }] };
      },
      async callTool(name, args) {
        if (name === "list_apps") {
          return { isError: false, content: [{ type: "text", text: "PinnedApp — com.example.Pin [running]" }] };
        }
        if (name === "get_app_state") {
          if (args?.include_screenshot !== false) {
            ocuUnpinnedScreenshotCalls += 1;
          }
          return {
            isError: false,
            content: [{ type: "text", text: `App=com.example.Pin (pid ${process.pid})\nWindow: "Main", App: PinnedApp.\n` }],
          };
        }
        return { isError: true, content: [{ type: "text", text: `unknown ${name}` }] };
      },
      close() {},
    };
    const pinBroker = new ComputerUseBrokerServer({
      webPort: 0,
      uiToken: "pin-tok",
      socketPath: pinnedSock,
      infoPath: null,
      streamIntervalMs: 35,
      actionPeer: peerMock,
      streamPeer: peerMock,
      desktopHelperClient: fakeHelper,
      permissionsFn: async () => ({ platform: "darwin", accessibility: true, screenRecording: true }),
      runningAppIdentityFn: async () => ({ pid: process.pid, bundleId: "com.example.Pin", processToken: `${process.pid}:1` }),
      axBridge: { enabled: true, async checkPermissions() { return { accessibility: true, screenRecording: true }; }, async close() {} },
    });
    await pinBroker.start();
    try {
      await pinBroker.executeToolCall("list_apps", {}, { source: "ai" });
      await fetch(`http://127.0.0.1:${pinBroker.webPort}/api/select-app`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Sidecar-Token": "pin-tok" },
        body: JSON.stringify({ app: "com.example.Pin", windowId: 802 }),
      });
      await pinBroker.webAdapter.captureStreamTick();
      assert.equal(
        ocuUnpinnedScreenshotCalls,
        0,
        "Pinned window select-app and background stream must NEVER capture unpinned OCU screenshots"
      );
      assert.equal(pinBroker.state.streamPaused, true);
      assert.equal(pinBroker.state.streamPausedReason, "pinned_window_capture_unavailable");
    } finally {
      await pinBroker.close();
    }
  } finally {
    wsHub.closeAll();
    await new Promise((r) => server.close(r));
    void lastNeedIdrStream;
  }
});
