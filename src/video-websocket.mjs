import crypto from "node:crypto";
import {
  VIDEO_AU_FLAG_IDR,
  VIDEO_BACKPRESSURE_MAX_AGE_MS,
  VIDEO_MAX_AU_BYTES,
  VIDEO_MAX_CONFIG_BYTES,
  VIDEO_MAX_STATUS_BYTES,
  VIDEO_PACKET_TYPE,
  VIDEO_TICKET_TTL_MS,
  VIDEO_WIRE_HEADER_BYTES,
  VIDEO_WIRE_MAGIC,
  VIDEO_WS_SUBPROTOCOL,
} from "./constants.mjs";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_UDS_STREAM_BUFFER_BYTES = 4 * 1024 * 1024;
const MAX_INBOUND_WS_BUFFER_BYTES = 16 * 1024;

export function maxPayloadForPacketType(type) {
  switch (type) {
    case VIDEO_PACKET_TYPE.CONFIG:
      return VIDEO_MAX_CONFIG_BYTES;
    case VIDEO_PACKET_TYPE.ACCESS_UNIT:
      return VIDEO_MAX_AU_BYTES;
    case VIDEO_PACKET_TYPE.STATUS:
      return VIDEO_MAX_STATUS_BYTES;
    default:
      return -1;
  }
}

/**
 * Encode one 40-byte big-endian `CUV1` header + payload packet shared identically
 * between Swift->Node UDS (`v.sock`) and Node->WebView RFC 6455 binary messages.
 */
export function encodeVideoPacket({
  type,
  flags = 0,
  streamId = 0,
  generation = 0,
  seq = 0,
  ptsUs = 0n,
  durationUs = 0,
  payload = Buffer.alloc(0),
} = {}) {
  const maxBytes = maxPayloadForPacketType(type);
  if (maxBytes < 0) {
    throw new Error(`Invalid video packet type: ${type}`);
  }
  const payloadBuf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  if (payloadBuf.length > maxBytes) {
    throw new Error(`Video packet type ${type} exceeds limit (${payloadBuf.length} > ${maxBytes})`);
  }
  const isAu = type === VIDEO_PACKET_TYPE.ACCESS_UNIT;
  const effectiveFlags = isAu ? flags & VIDEO_AU_FLAG_IDR : 0;
  const effectiveSeq = isAu ? (Number(seq) >>> 0) : 0;

  const out = Buffer.allocUnsafe(VIDEO_WIRE_HEADER_BYTES + payloadBuf.length);
  out.write(VIDEO_WIRE_MAGIC, 0, 4, "ascii");
  out.writeUInt8(type, 4);
  out.writeUInt8(effectiveFlags, 5);
  out.writeUInt16BE(VIDEO_WIRE_HEADER_BYTES, 6);
  out.writeUInt32BE(Number(streamId) >>> 0, 8);
  out.writeUInt32BE(Number(generation) >>> 0, 12);
  out.writeUInt32BE(effectiveSeq, 16);
  out.writeUInt32BE(payloadBuf.length >>> 0, 20);
  out.writeBigUInt64BE(typeof ptsUs === "bigint" ? ptsUs : BigInt(Math.max(0, Math.trunc(Number(ptsUs) || 0))), 24);
  out.writeUInt32BE(Number(durationUs) >>> 0, 32);
  out.writeUInt32BE(0, 36);
  if (payloadBuf.length > 0) {
    payloadBuf.copy(out, VIDEO_WIRE_HEADER_BYTES);
  }
  return out;
}

/**
 * Decode and validate a 40-byte `CUV1` binary packet header.
 */
export function decodeVideoPacketHeader(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < VIDEO_WIRE_HEADER_BYTES) {
    return { ok: false, reason: "truncated_header" };
  }
  if (buf.toString("ascii", 0, 4) !== VIDEO_WIRE_MAGIC) {
    return { ok: false, reason: "bad_magic" };
  }
  const type = buf.readUInt8(4);
  const flags = buf.readUInt8(5);
  const headerBytes = buf.readUInt16BE(6);
  if (headerBytes !== VIDEO_WIRE_HEADER_BYTES) {
    return { ok: false, reason: `invalid_header_bytes:${headerBytes}` };
  }
  const maxBytes = maxPayloadForPacketType(type);
  if (maxBytes < 0) {
    return { ok: false, reason: `invalid_packet_type:${type}` };
  }
  const streamId = buf.readUInt32BE(8);
  const generation = buf.readUInt32BE(12);
  const seq = buf.readUInt32BE(16);
  const payloadBytes = buf.readUInt32BE(20);
  const ptsUs = buf.readBigUInt64BE(24);
  const durationUs = buf.readUInt32BE(32);
  const reserved = buf.readUInt32BE(36);

  if (reserved !== 0) {
    return { ok: false, reason: "non_zero_reserved" };
  }
  if (payloadBytes > maxBytes) {
    return { ok: false, reason: `payload_exceeds_limit:${payloadBytes}` };
  }
  if (type === VIDEO_PACKET_TYPE.ACCESS_UNIT) {
    if ((flags & ~VIDEO_AU_FLAG_IDR) !== 0) {
      return { ok: false, reason: `invalid_au_flags:${flags}` };
    }
    if (seq < 1) {
      return { ok: false, reason: "invalid_au_seq" };
    }
  } else {
    if (flags !== 0 || seq !== 0) {
      return { ok: false, reason: "non_au_nonzero_flags_or_seq" };
    }
  }

  return {
    ok: true,
    type,
    flags,
    isIdr: type === VIDEO_PACKET_TYPE.ACCESS_UNIT && (flags & VIDEO_AU_FLAG_IDR) !== 0,
    headerBytes,
    streamId,
    generation,
    seq,
    payloadBytes,
    ptsUs,
    durationUs,
    packetBytes: headerBytes + payloadBytes,
  };
}

/**
 * Incremental length-prefixed UDS stream frame extractor for `CUV1` packets.
 */
export class VideoPacketStreamDecoder {
  #buf = Buffer.alloc(0);

  constructor({ onPacket, onError } = {}) {
    this.onPacket = onPacket;
    this.onError = onError;
  }

  push(chunk) {
    const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (incoming.length === 0) return;
    if (this.#buf.length + incoming.length > MAX_UDS_STREAM_BUFFER_BYTES) {
      this.#buf = Buffer.alloc(0);
      this.onError?.(new Error("video_uds_buffer_overflow"));
      return;
    }
    this.#buf = this.#buf.length === 0 ? incoming : Buffer.concat([this.#buf, incoming]);

    while (this.#buf.length >= VIDEO_WIRE_HEADER_BYTES) {
      const header = decodeVideoPacketHeader(this.#buf);
      if (!header.ok) {
        this.#buf = Buffer.alloc(0);
        this.onError?.(new Error(`video_wire_error:${header.reason}`));
        return;
      }
      if (this.#buf.length < header.packetBytes) {
        return;
      }
      const rawPacket = this.#buf.subarray(0, header.packetBytes);
      const payload = Buffer.from(rawPacket.subarray(VIDEO_WIRE_HEADER_BYTES, header.packetBytes));
      const packetCopy = Buffer.from(rawPacket);
      this.#buf = this.#buf.subarray(header.packetBytes);
      this.onPacket?.({
        ...header,
        payload,
        rawPacket: packetCopy,
      });
    }
  }

  reset() {
    this.#buf = Buffer.alloc(0);
  }
}

/**
 * Parse ISO/IEC 14496-15 `avcC` decoder configuration record and derive `avc1.PPCCLL`.
 */
export function parseAvcDecoderConfig(avcCBuf) {
  const buf = Buffer.isBuffer(avcCBuf) ? avcCBuf : Buffer.from(avcCBuf || "", "base64");
  if (buf.length < 7 || buf[0] !== 1) {
    return { ok: false, reason: "invalid_avcc_header" };
  }
  const profileIdc = buf[1];
  const profileCompat = buf[2];
  const levelIdc = buf[3];
  const nalLengthSize = (buf[4] & 0x03) + 1;
  const numSps = buf[5] & 0x1f;
  let offset = 6;
  const spsList = [];
  for (let i = 0; i < numSps; i += 1) {
    if (offset + 2 > buf.length) return { ok: false, reason: "truncated_sps_length" };
    const len = buf.readUInt16BE(offset);
    offset += 2;
    if (len < 1 || offset + len > buf.length) return { ok: false, reason: "truncated_sps" };
    spsList.push(buf.subarray(offset, offset + len));
    offset += len;
  }
  if (offset + 1 > buf.length) return { ok: false, reason: "missing_pps_count" };
  const numPps = buf[offset];
  offset += 1;
  const ppsList = [];
  for (let i = 0; i < numPps; i += 1) {
    if (offset + 2 > buf.length) return { ok: false, reason: "truncated_pps_length" };
    const len = buf.readUInt16BE(offset);
    offset += 2;
    if (len < 1 || offset + len > buf.length) return { ok: false, reason: "truncated_pps" };
    ppsList.push(buf.subarray(offset, offset + len));
    offset += len;
  }
  if (spsList.length === 0 || ppsList.length === 0) {
    return { ok: false, reason: "missing_sps_or_pps" };
  }
  const hex2 = (b) => b.toString(16).padStart(2, "0");
  return {
    ok: true,
    codec: `avc1.${hex2(profileIdc)}${hex2(profileCompat)}${hex2(levelIdc)}`,
    profileIdc,
    profileCompat,
    levelIdc,
    nalLengthSize,
    spsList,
    ppsList,
    avcC: buf,
  };
}

/**
 * Inspect an AVCC access unit, verify exact NAL framing, detect real IDR (`nalType === 5`),
 * and normalize length prefixes to 4-byte big-endian if `nalLengthSize` is 1 or 2.
 */
export function parseAndNormalizeAvccAu(buf, { nalLengthSize = 4 } = {}) {
  const input = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (![1, 2, 4].includes(nalLengthSize)) {
    return { ok: false, reason: `unsupported_nal_length_size:${nalLengthSize}` };
  }
  let offset = 0;
  const nalTypes = [];
  const nals = [];
  let containsIdrNal = false;

  while (offset + nalLengthSize <= input.length) {
    let nalLen = 0;
    for (let i = 0; i < nalLengthSize; i += 1) {
      nalLen = (nalLen << 8) | input[offset + i];
    }
    offset += nalLengthSize;
    if (nalLen <= 0 || offset + nalLen > input.length) {
      return { ok: false, reason: "malformed_avcc_nal_length" };
    }
    const nal = input.subarray(offset, offset + nalLen);
    const nalType = nal[0] & 0x1f;
    nalTypes.push(nalType);
    if (nalType === 5) containsIdrNal = true;
    nals.push(nal);
    offset += nalLen;
  }
  if (offset !== input.length || nals.length === 0) {
    return { ok: false, reason: "trailing_or_empty_avcc_au" };
  }

  let data = input;
  if (nalLengthSize !== 4) {
    const parts = [];
    for (const nal of nals) {
      const hdr = Buffer.allocUnsafe(4);
      hdr.writeUInt32BE(nal.length >>> 0, 0);
      parts.push(hdr, nal);
    }
    data = Buffer.concat(parts);
  }
  return { ok: true, data, containsIdrNal, nalTypes };
}

function isLoopbackAddress(addr) {
  if (!addr) return false;
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

function encodeWsFrame(opcode, payload = Buffer.alloc(0)) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  let hdr;
  if (body.length < 126) {
    hdr = Buffer.allocUnsafe(2);
    hdr[0] = 0x80 | (opcode & 0x0f);
    hdr[1] = body.length;
  } else if (body.length < 65536) {
    hdr = Buffer.allocUnsafe(4);
    hdr[0] = 0x80 | (opcode & 0x0f);
    hdr[1] = 126;
    hdr.writeUInt16BE(body.length, 2);
  } else {
    hdr = Buffer.allocUnsafe(10);
    hdr[0] = 0x80 | (opcode & 0x0f);
    hdr[1] = 127;
    hdr.writeBigUInt64BE(BigInt(body.length), 2);
  }
  return body.length > 0 ? Buffer.concat([hdr, body]) : hdr;
}

function rejectUpgrade(socket, statusCode, message) {
  try {
    socket.end(
      `HTTP/1.1 ${statusCode} ${message}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`
    );
  } catch {}
  try {
    socket.destroy();
  } catch {}
}

/**
 * Same-port RFC 6455 WebSocket hub for H.264 `CUV1` binary streaming with strict loopback,
 * Host/Origin, single-use ticket, `cua.h264.v1` subprotocol, control-only inbound validation,
 * and per-subscriber bounded backpressure isolation (`300ms` max queue / drop-to-await-IDR).
 */
export class VideoWebSocketHub {
  #tickets = new Map();
  #subscribers = new Map();
  #nextSubId = 1;
  #server = null;
  #upgradeHandler = null;
  #backpressureMaxAgeMs;

  constructor({
    brokerBootId,
    getPort = () => 0,
    onSubscriberConnected = null,
    onSubscriberClosed = null,
    onSubscriberNeedIdr = null,
    backpressureMaxAgeMs = VIDEO_BACKPRESSURE_MAX_AGE_MS,
  } = {}) {
    this.brokerBootId = brokerBootId;
    this.getPort = getPort;
    this.onSubscriberConnected = onSubscriberConnected;
    this.onSubscriberClosed = onSubscriberClosed;
    this.onSubscriberNeedIdr = onSubscriberNeedIdr;
    this.#backpressureMaxAgeMs = backpressureMaxAgeMs;
  }

  attach(httpServer) {
    if (!httpServer || this.#server === httpServer) return;
    this.#server = httpServer;
    this.#upgradeHandler = (req, socket, head) => this.handleUpgrade(req, socket, head);
    httpServer.on("upgrade", this.#upgradeHandler);
  }

  detach() {
    if (this.#server && this.#upgradeHandler) {
      this.#server.removeListener("upgrade", this.#upgradeHandler);
    }
    this.#server = null;
    this.#upgradeHandler = null;
  }

  issueTicket({ viewId, targetKey, streamId } = {}) {
    const now = Date.now();
    for (const [tok, rec] of this.#tickets) {
      if (rec.expiresAt <= now) this.#tickets.delete(tok);
    }
    const ticket = crypto.randomBytes(24).toString("hex");
    this.#tickets.set(ticket, {
      viewId: String(viewId || ""),
      targetKey: String(targetKey || ""),
      streamId: Number(streamId) || 0,
      brokerBootId: this.brokerBootId,
      expiresAt: now + VIDEO_TICKET_TTL_MS,
    });
    return ticket;
  }

  getSubscribersForTarget(targetKey) {
    const out = [];
    for (const sub of this.#subscribers.values()) {
      if (!sub.closed && sub.targetKey === targetKey) {
        out.push(sub);
      }
    }
    return out;
  }

  getSubscriberCount() {
    return this.#subscribers.size;
  }

  handleUpgrade(req, socket, head = Buffer.alloc(0)) {
    const remote = socket?.remoteAddress || "";
    if (!isLoopbackAddress(remote)) {
      rejectUpgrade(socket, 403, "Forbidden");
      return;
    }

    const boundPort = Number(this.getPort?.() || 0);
    let url;
    try {
      url = new URL(req.url || "/", `http://127.0.0.1:${boundPort || 80}`);
    } catch {
      rejectUpgrade(socket, 400, "Bad Request");
      return;
    }
    if (url.pathname !== "/api/video/ws") {
      rejectUpgrade(socket, 404, "Not Found");
      return;
    }

    const hostHdr = String(req.headers.host || "").trim().toLowerCase();
    const validHosts =
      boundPort > 0
        ? [`127.0.0.1:${boundPort}`, `localhost:${boundPort}`]
        : ["127.0.0.1", "localhost"];
    if (!validHosts.includes(hostHdr)) {
      rejectUpgrade(socket, 403, "Invalid Host");
      return;
    }

    const originHdr = String(req.headers.origin || "").trim().toLowerCase();
    const expectedOrigin = `http://${hostHdr}`;
    const altOrigins =
      boundPort > 0
        ? [`http://127.0.0.1:${boundPort}`, `http://localhost:${boundPort}`]
        : ["http://127.0.0.1", "http://localhost"];
    if (!originHdr || (originHdr !== expectedOrigin && !altOrigins.includes(originHdr))) {
      rejectUpgrade(socket, 403, "Invalid Origin");
      return;
    }

    const upgradeHdr = String(req.headers.upgrade || "").toLowerCase();
    const connHdr = String(req.headers.connection || "").toLowerCase();
    const wsVersion = String(req.headers["sec-websocket-version"] || "").trim();
    const wsKey = String(req.headers["sec-websocket-key"] || "").trim();
    const wsProtocols = String(req.headers["sec-websocket-protocol"] || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    if (
      upgradeHdr !== "websocket" ||
      !connHdr.split(",").some((part) => part.trim() === "upgrade") ||
      wsVersion !== "13" ||
      !/^[A-Za-z0-9+/]{22}==$/u.test(wsKey) ||
      !wsProtocols.includes(VIDEO_WS_SUBPROTOCOL)
    ) {
      rejectUpgrade(socket, 400, "Bad WebSocket Upgrade");
      return;
    }

    const ticketTok = String(url.searchParams.get("ticket") || "").trim();
    const ticketRec = ticketTok ? this.#tickets.get(ticketTok) : null;
    if (ticketTok) this.#tickets.delete(ticketTok); // Strict single-use
    if (
      !ticketRec ||
      ticketRec.expiresAt <= Date.now() ||
      ticketRec.brokerBootId !== this.brokerBootId
    ) {
      rejectUpgrade(socket, 401, "Invalid or Expired Ticket");
      return;
    }

    const accept = crypto.createHash("sha1").update(`${wsKey}${WS_GUID}`).digest("base64");
    const responseHeaders = [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      `Sec-WebSocket-Protocol: ${VIDEO_WS_SUBPROTOCOL}`,
      "\r\n",
    ].join("\r\n");

    try {
      socket.setNoDelay?.(true);
      socket.write(responseHeaders);
    } catch {
      try {
        socket.destroy();
      } catch {}
      return;
    }

    const sub = {
      id: `ws-${this.#nextSubId++}`,
      viewId: ticketRec.viewId,
      targetKey: ticketRec.targetKey,
      streamId: ticketRec.streamId,
      socket,
      decodeReadyGeneration: null,
      awaitIdr: true,
      writeInFlight: false,
      pendingConfigPacket: null,
      pendingAuSlot: null,
      stallTimer: null,
      inboundBuf: Buffer.alloc(0),
      closed: false,
      closeReason: null,
    };
    this.#subscribers.set(sub.id, sub);

    socket.on("data", (chunk) => this.#onSocketData(sub, chunk));
    socket.on("drain", () => this.#onSocketDrain(sub));
    socket.on("error", () => this.disconnectSubscriber(sub, "socket_error"));
    socket.on("close", () => this.disconnectSubscriber(sub, sub.closeReason || "socket_closed"));

    this.onSubscriberConnected?.(sub);
    if (head && head.length > 0) {
      this.#onSocketData(sub, head);
    }
  }

  #onSocketData(sub, chunk) {
    if (sub.closed) return;
    const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (sub.inboundBuf.length + incoming.length > MAX_INBOUND_WS_BUFFER_BYTES) {
      this.#closeProtocolViolation(sub, 1009, "inbound_overflow");
      return;
    }
    sub.inboundBuf = sub.inboundBuf.length === 0 ? incoming : Buffer.concat([sub.inboundBuf, incoming]);

    while (sub.inboundBuf.length >= 2) {
      const b0 = sub.inboundBuf[0];
      const b1 = sub.inboundBuf[1];
      const fin = (b0 & 0x80) !== 0;
      const rsv = (b0 & 0x70) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      const payloadLen = b1 & 0x7f;

      if (!fin || rsv || !masked || payloadLen > 125) {
        this.#closeProtocolViolation(sub, 1002, "forbidden_inbound_frame");
        return;
      }
      if (![0x8, 0x9, 0xa].includes(opcode)) {
        this.#closeProtocolViolation(sub, 1003, "inbound_data_forbidden");
        return;
      }
      const frameBytes = 2 + 4 + payloadLen;
      if (sub.inboundBuf.length < frameBytes) return;

      const maskKey = sub.inboundBuf.subarray(2, 6);
      const maskedPayload = sub.inboundBuf.subarray(6, frameBytes);
      const payload = Buffer.allocUnsafe(payloadLen);
      for (let i = 0; i < payloadLen; i += 1) {
        payload[i] = maskedPayload[i] ^ maskKey[i & 3];
      }
      sub.inboundBuf = sub.inboundBuf.subarray(frameBytes);

      if (opcode === 0x8) {
        if (payload.length === 1) {
          this.#closeProtocolViolation(sub, 1002, "invalid_close_payload");
          return;
        }
        if (payload.length >= 2) {
          const closeCode = payload.readUInt16BE(0);
          const validCloseCode =
            (closeCode >= 1000 &&
              closeCode <= 1014 &&
              closeCode !== 1004 &&
              closeCode !== 1005 &&
              closeCode !== 1006) ||
            (closeCode >= 3000 && closeCode <= 4999);
          if (!validCloseCode) {
            this.#closeProtocolViolation(sub, 1002, "invalid_close_code");
            return;
          }
          try {
            new TextDecoder("utf-8", { fatal: true }).decode(payload.subarray(2));
          } catch {
            this.#closeProtocolViolation(sub, 1007, "invalid_close_utf8");
            return;
          }
        }
        try {
          if (sub.socket.writable) {
            sub.socket.end(encodeWsFrame(0x8, payload.subarray(0, 2)));
          }
        } catch {}
        this.disconnectSubscriber(sub, "client_closed", { flushDelayMs: 40 });
        return;
      }
      if (opcode === 0x9) {
        this.#writeRawWsFrame(sub, encodeWsFrame(0xa, payload));
      }
    }
  }

  #closeProtocolViolation(sub, wsCode, reason) {
    const body = Buffer.allocUnsafe(2);
    body.writeUInt16BE(wsCode, 0);
    try {
      if (sub.socket.writable) {
        sub.socket.end(encodeWsFrame(0x8, body));
      }
    } catch {}
    this.disconnectSubscriber(sub, reason, { flushDelayMs: 40 });
  }

  markDecodeReady(viewId, generation) {
    for (const sub of this.#subscribers.values()) {
      if (!sub.closed && sub.viewId === viewId) {
        sub.decodeReadyGeneration = generation;
        sub.awaitIdr = true;
      }
    }
  }

  markAwaitIdr(viewId) {
    for (const sub of this.#subscribers.values()) {
      if (!sub.closed && sub.viewId === viewId) {
        sub.awaitIdr = true;
      }
    }
  }

  sendPacket(sub, { type, generation, isIdr = false, rawPacket }) {
    if (!sub || sub.closed || !sub.socket?.writable) return false;

    if (type === VIDEO_PACKET_TYPE.ACCESS_UNIT) {
      if (sub.decodeReadyGeneration === null || generation !== sub.decodeReadyGeneration) {
        return false;
      }
      if (sub.awaitIdr) {
        if (!isIdr) return false;
        sub.awaitIdr = false;
      }
    }

    const frame = encodeWsFrame(0x2, rawPacket);

    if (sub.writeInFlight || sub.socket.writableNeedDrain) {
      if (type === VIDEO_PACKET_TYPE.CONFIG) {
        sub.pendingConfigPacket = frame;
        this.#ensureStallTimer(sub);
        return true;
      }
      if (type === VIDEO_PACKET_TYPE.STATUS) {
        return true;
      }
      // Bounded single pending AU slot: drop delta AUs instead of accumulating latency.
      if (sub.pendingAuSlot) {
        if (isIdr) {
          sub.pendingAuSlot = { frame, isIdr: true };
          this.#ensureStallTimer(sub);
          return true;
        }
        // Replacing/dropping a delta AU loses inter-frame reference -> jump to await_idr.
        if (!sub.pendingAuSlot.isIdr) {
          sub.pendingAuSlot = null;
        }
        sub.awaitIdr = true;
        this.onSubscriberNeedIdr?.(sub, "delta_dropped_under_backpressure");
        return false;
      }
      if (!isIdr) {
        // Better to skip queueing delta AU when backpressured? Actually keeping 1 AU slot lets
        // brief micro-bursts absorb without IDR, and dropping on 2nd delta triggers awaitIdr.
      }
      sub.pendingAuSlot = { frame, isIdr };
      this.#ensureStallTimer(sub);
      return true;
    }

    return this.#dispatchFrameNow(sub, frame);
  }

  #writeRawWsFrame(sub, frame) {
    if (!sub || sub.closed || !sub.socket?.writable) return false;
    try {
      const ok = sub.socket.write(frame);
      if (!ok) {
        sub.writeInFlight = true;
        this.#ensureStallTimer(sub);
      }
      return true;
    } catch {
      this.disconnectSubscriber(sub, "write_error");
      return false;
    }
  }

  #dispatchFrameNow(sub, frame) {
    const ok = this.#writeRawWsFrame(sub, frame);
    if (!ok) return false;
    if (sub.writeInFlight) {
      sub.writeInFlight = true;
      this.#ensureStallTimer(sub);
    }
    return true;
  }

  #ensureStallTimer(sub) {
    if (sub.closed || sub.stallTimer) return;
    sub.stallTimer = setTimeout(() => {
      sub.stallTimer = null;
      if (sub.closed) return;
      if (sub.writeInFlight || sub.pendingConfigPacket || sub.pendingAuSlot || sub.socket.writableNeedDrain) {
        this.disconnectSubscriber(sub, "slow_consumer");
      }
    }, this.#backpressureMaxAgeMs);
    sub.stallTimer.unref?.();
  }

  #clearStallTimer(sub) {
    if (sub.stallTimer) {
      clearTimeout(sub.stallTimer);
      sub.stallTimer = null;
    }
  }

  #onSocketDrain(sub) {
    if (sub.closed) return;
    sub.writeInFlight = false;
    this.#clearStallTimer(sub);

    if (sub.pendingConfigPacket) {
      const cfg = sub.pendingConfigPacket;
      sub.pendingConfigPacket = null;
      this.#dispatchFrameNow(sub, cfg);
      if (sub.writeInFlight) return;
    }
    if (sub.pendingAuSlot) {
      const nextAu = sub.pendingAuSlot;
      sub.pendingAuSlot = null;
      this.#dispatchFrameNow(sub, nextAu.frame);
    }
  }

  disconnectSubscriber(subOrViewId, reason = "closed", { flushDelayMs = 0 } = {}) {
    if (typeof subOrViewId === "string") {
      for (const sub of this.#subscribers.values()) {
        if (sub.viewId === subOrViewId) {
          this.disconnectSubscriber(sub, reason, { flushDelayMs });
        }
      }
      return;
    }
    const sub = subOrViewId;
    if (!sub || sub.closed) return;
    sub.closed = true;
    sub.closeReason = reason;
    this.#clearStallTimer(sub);
    sub.pendingConfigPacket = null;
    sub.pendingAuSlot = null;
    this.#subscribers.delete(sub.id);
    try {
      if (flushDelayMs > 0 && sub.socket && !sub.socket.destroyed) {
        const destroyTimer = setTimeout(() => {
          try {
            sub.socket.destroy();
          } catch {}
        }, flushDelayMs);
        destroyTimer.unref?.();
        sub.socket.once?.("close", () => clearTimeout(destroyTimer));
      } else {
        sub.socket.destroy();
      }
    } catch {}
    this.onSubscriberClosed?.(sub, reason);
  }

  closeAll() {
    this.#tickets.clear();
    for (const sub of Array.from(this.#subscribers.values())) {
      this.disconnectSubscriber(sub, "hub_closed");
    }
    this.detach();
  }
}
