import { execFile } from "node:child_process";
import crypto from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  DESKTOP_HELPER_APP_PATH,
  DESKTOP_HELPER_BIN_PATH,
  EMERGENCY_HOTKEY,
  VIDEO_PACKET_TYPE,
} from "./constants.mjs";
import { VideoPacketStreamDecoder } from "./video-websocket.mjs";

const execFileAsync = promisify(execFile);

const HEARTBEAT_INTERVAL_MS = 500;
const HEARTBEAT_TIMEOUT_MS = 450;
const MAX_MISSED_HEARTBEATS = 3;
const CONNECT_HANDSHAKE_TIMEOUT_MS = 4000;
const MAX_CONTROL_LINE_BYTES = 4 * 1024 * 1024;

/**
 * Broker-side UDS supervisor & NDJSON control client for `CUADesktopHelper.app`.
 * Launches via LaunchServices in background (`open -n -g -j -a`), enforces per-boot auth token
 * and heartbeat liveness, and gracefully degrades to `{ available: false }` when helper is
 * absent or macOS TCC permissions are not granted.
 */
export class DesktopHelperClient {
  #runtimeDir = null;
  #socketPath = null;
  #videoSocketPath = null;
  #rendezvousPath = null;
  #server = null;
  #videoServer = null;
  #conn = null;
  #videoConn = null;
  #videoDecoder = null;
  #videoAuthenticated = false;
  #buffer = "";
  #authToken = null;
  #starting = null;
  #closed = false;
  #nextReqId = 1;
  #pending = new Map();
  #heartbeatTimer = null;
  #missedHeartbeats = 0;
  #restartTimer = null;
  #restartTimestamps = [];
  #restarting = false;
  #helperPid = null;
  #helperBundleId = null;
  #authenticated = false;
  #available = false;
  #unavailableReason = "not_started";
  #capabilities = {
    screenRecordingPreflight: false,
    inputMonitoringPreflight: false,
    accessibilityTrusted: false,
    mouseTapActive: false,
    keyTapActive: false,
    hotkeyActive: false,
    secureInputActive: false,
    sessionLocked: false,
    fallbackReason: "not_started",
  };

  constructor({
    appPath = DESKTOP_HELPER_APP_PATH,
    binPath = DESKTOP_HELPER_BIN_PATH,
    brokerBootId = crypto.randomUUID(),
    syntheticEventTag = 0,
    emergencyHotkey = EMERGENCY_HOTKEY,
    trustedPids = [process.pid],
    launchFn = null,
    autoRestart = !launchFn && process.platform === "darwin",
    restartDelayMs = 700,
    maxRestartsInWindow = 5,
    restartWindowMs = 60_000,
    onSensorEvent = null,
    onCapabilitiesChanged = null,
    onStatusChanged = null,
    onVideoPacket = null,
    onStreamStatus = null,
  } = {}) {
    this.appPath = appPath;
    this.binPath = binPath;
    this.brokerBootId = brokerBootId;
    this.syntheticEventTag = syntheticEventTag;
    this.emergencyHotkey = emergencyHotkey || EMERGENCY_HOTKEY;
    this.trustedPids = Array.isArray(trustedPids)
      ? trustedPids.map((p) => Number(p)).filter((p) => Number.isInteger(p) && p > 0)
      : [process.pid];
    this.launchFn = launchFn;
    this.autoRestart = Boolean(autoRestart);
    this.restartDelayMs = Math.max(20, Number(restartDelayMs) || 700);
    this.maxRestartsInWindow = Math.max(1, Number(maxRestartsInWindow) || 5);
    this.restartWindowMs = Math.max(1000, Number(restartWindowMs) || 60_000);
    this.onSensorEvent = onSensorEvent;
    this.onCapabilitiesChanged = onCapabilitiesChanged;
    this.onStatusChanged = onStatusChanged;
    this.onVideoPacket = onVideoPacket;
    this.onStreamStatus = onStreamStatus;
  }

  get available() {
    return Boolean(this.#available && this.#authenticated && this.#conn && !this.#conn.destroyed);
  }

  get videoAvailable() {
    return Boolean(this.available && this.#videoAuthenticated && this.#videoConn && !this.#videoConn.destroyed);
  }

  get helperPid() {
    return this.#helperPid;
  }

  getDiagnostics() {
    return {
      available: this.available,
      videoAvailable: this.videoAvailable,
      authenticated: this.#authenticated,
      pid: this.#helperPid,
      bundleId: this.#helperBundleId,
      appPath: this.appPath,
      reason: this.available ? null : this.#unavailableReason,
      capabilities: { ...this.#capabilities },
    };
  }

  async start() {
    if (this.#closed) {
      this.#unavailableReason = "closed";
      return this.getDiagnostics();
    }
    this.#clearRestartTimer();
    if (this.available) return this.getDiagnostics();
    if (this.#starting) return this.#starting;

    this.#starting = this.#startInternal().finally(() => {
      this.#starting = null;
    });
    return this.#starting;
  }

  async #startInternal() {
    if (!this.launchFn && process.platform !== "darwin") {
      this.#unavailableReason = "non_darwin";
      return this.getDiagnostics();
    }
    if (!this.launchFn && (!existsSync(this.appPath) || !existsSync(this.binPath))) {
      this.#unavailableReason = "helper_missing";
      return this.getDiagnostics();
    }

    await this.#closeServersOnly();
    this.#cleanupRuntimeArtifacts();

    // Short path under /tmp or os.tmpdir() keeps macOS sun_path well under 104 bytes
    const baseTmp = process.platform === "darwin" ? "/tmp" : os.tmpdir();
    this.#runtimeDir = mkdtempSync(path.join(baseTmp, "cua-dh-"));
    chmodSync(this.#runtimeDir, 0o700);
    this.#socketPath = path.join(this.#runtimeDir, "c.sock");
    this.#videoSocketPath = path.join(this.#runtimeDir, "v.sock");
    this.#rendezvousPath = path.join(this.#runtimeDir, "r.json");
    this.#authToken = crypto.randomBytes(24).toString("hex");
    this.#authenticated = false;
    this.#videoAuthenticated = false;
    this.#available = false;

    writeFileSync(
      this.#rendezvousPath,
      JSON.stringify({
        controlSocket: this.#socketPath,
        videoSocket: this.#videoSocketPath,
        brokerBootId: this.brokerBootId,
        authToken: this.#authToken,
        syntheticTag: this.syntheticEventTag,
        emergencyHotkey: this.emergencyHotkey,
        trustedPids: this.trustedPids,
      }),
      { mode: 0o600 }
    );

    const videoListenPromise = new Promise((resolveVideo, rejectVideo) => {
      this.#videoServer = net.createServer((sock) => {
        if (this.#videoConn && !this.#videoConn.destroyed) {
          sock.destroy();
          return;
        }
        this.#videoConn = sock;
        this.#videoAuthenticated = false;
        this.#videoDecoder = new VideoPacketStreamDecoder({
          onPacket: (pkt) => this.#onVideoPacketDecoded(pkt),
          onError: () => this.#closeVideoConn(),
        });
        sock.on("data", (chunk) => {
          if (this.#videoConn === sock) {
            this.#videoDecoder?.push(chunk);
          }
        });
        sock.on("error", () => {
          if (this.#videoConn === sock) this.#closeVideoConn();
        });
        sock.on("close", () => {
          if (this.#videoConn === sock) this.#closeVideoConn();
        });
      });
      this.#videoServer.once("error", rejectVideo);
      this.#videoServer.listen(this.#videoSocketPath, () => {
        try {
          chmodSync(this.#videoSocketPath, 0o600);
        } catch {}
        resolveVideo();
      });
    });

    const helloPromise = new Promise((resolve, reject) => {
      let settled = false;
      const finish = (err = null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err);
        else resolve(true);
      };
      const timer = setTimeout(() => {
        finish(new Error("helper_handshake_timeout"));
      }, CONNECT_HANDSHAKE_TIMEOUT_MS);
      timer.unref?.();

      this.#server = net.createServer((sock) => {
        if (this.#conn && !this.#conn.destroyed) {
          sock.destroy();
          return;
        }
        this.#conn = sock;
        this.#buffer = "";
        sock.setEncoding("utf8");
        sock.on("data", (chunk) => this.#onData(chunk, finish));
        sock.on("error", () => {
          if (this.#conn === sock) {
            this.#onSocketClosed("helper_socket_error");
          }
          finish(new Error(this.#unavailableReason || "helper_socket_error"));
        });
        sock.on("close", () => {
          if (this.#conn === sock) {
            this.#onSocketClosed("helper_disconnected");
          }
          finish(new Error(this.#unavailableReason || "helper_disconnected"));
        });
      });

      this.#server.once("error", (err) => finish(err));
      Promise.resolve(videoListenPromise)
        .then(() => {
          this.#server.listen(this.#socketPath, () => {
            try {
              chmodSync(this.#socketPath, 0o600);
            } catch {}
            Promise.resolve()
              .then(() => this.#launchHelper())
              .catch((err) => finish(err));
          });
        })
        .catch((err) => finish(err));
    });

    try {
      await helloPromise;
      this.#available = true;
      this.#unavailableReason = null;
      this.#startHeartbeat();
      this.onCapabilitiesChanged?.({ ...this.#capabilities });
      this.onStatusChanged?.(this.getDiagnostics());
      return this.getDiagnostics();
    } catch (err) {
      this.#unavailableReason = err?.message || "helper_start_failed";
      await this.#resetConnectionOnly();
      this.onStatusChanged?.(this.getDiagnostics());
      return this.getDiagnostics();
    }
  }

  async #launchHelper() {
    if (typeof this.launchFn === "function") {
      await this.launchFn({
        appPath: this.appPath,
        binPath: this.binPath,
        rendezvousPath: this.#rendezvousPath,
        socketPath: this.#socketPath,
        authToken: this.#authToken,
        brokerBootId: this.brokerBootId,
        syntheticEventTag: this.syntheticEventTag,
      });
      return;
    }
    // Always pass -g -j -n so LaunchServices launches completely in background without stealing focus.
    await execFileAsync(
      "/usr/bin/open",
      ["-n", "-g", "-j", "-a", this.appPath, "--args", "--rendezvous", this.#rendezvousPath],
      { timeout: 5000 }
    );
  }

  #onData(chunk, helloFinish = null) {
    this.#buffer += chunk;
    if (Buffer.byteLength(this.#buffer, "utf8") > MAX_CONTROL_LINE_BYTES) {
      this.#onSocketClosed("control_buffer_overflow");
      return;
    }
    let nl;
    while ((nl = this.#buffer.indexOf("\n")) >= 0) {
      const line = this.#buffer.slice(0, nl).trim();
      this.#buffer = this.#buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (!msg || typeof msg !== "object" || Array.isArray(msg)) continue;
      this.#handleMessage(msg, helloFinish);
    }
  }

  #handleMessage(msg, helloFinish = null) {
    if (!this.#authenticated) {
      if (
        msg.type !== "hello" ||
        msg.authToken !== this.#authToken ||
        msg.brokerBootId !== this.brokerBootId
      ) {
        this.#onSocketClosed("helper_auth_failed");
        helloFinish?.(new Error("helper_auth_failed"));
        return;
      }
      this.#authenticated = true;
      this.#helperPid = Number(msg.pid) > 0 ? Number(msg.pid) : null;
      this.#helperBundleId = typeof msg.bundleId === "string" ? msg.bundleId : null;
      if (msg.capabilities && typeof msg.capabilities === "object") {
        this.#capabilities = { ...this.#capabilities, ...msg.capabilities };
      }
      helloFinish?.(null);
      return;
    }

    if (msg.type === "reply" && msg.id !== undefined && msg.id !== null) {
      const entry = this.#pending.get(String(msg.id));
      if (!entry) return;
      this.#pending.delete(String(msg.id));
      if (entry.timer) clearTimeout(entry.timer);
      if (msg.ok) {
        entry.resolve(msg.result || {});
      } else {
        const err = new Error(msg.error?.message || "helper_rpc_error");
        err.code = msg.error?.code || "HELPER_ERROR";
        entry.reject(err);
      }
      return;
    }

    if (msg.type === "capabilities" && msg.capabilities && typeof msg.capabilities === "object") {
      this.#capabilities = { ...this.#capabilities, ...msg.capabilities };
      this.onCapabilitiesChanged?.({ ...this.#capabilities });
      return;
    }

    if (msg.type === "streamStatus" && msg.status && typeof msg.status === "object") {
      this.onStreamStatus?.(msg.status);
      return;
    }

    if (msg.type === "takeoverEvent" && msg.event && typeof msg.event === "object") {
      this.onSensorEvent?.(msg.event);
    }
  }

  #onVideoPacketDecoded(packet) {
    if (!this.#videoAuthenticated) {
      if (packet.type !== VIDEO_PACKET_TYPE.STATUS || packet.streamId !== 0 || packet.generation !== 0) {
        this.#closeVideoConn();
        return;
      }
      let msg;
      try {
        msg = JSON.parse(packet.payload.toString("utf8"));
      } catch {
        this.#closeVideoConn();
        return;
      }
      if (
        msg?.type !== "videoHello" ||
        msg.authToken !== this.#authToken ||
        msg.brokerBootId !== this.brokerBootId
      ) {
        this.#closeVideoConn();
        return;
      }
      this.#videoAuthenticated = true;
      return;
    }
    this.onVideoPacket?.(packet);
    if (packet.type === VIDEO_PACKET_TYPE.STATUS) {
      try {
        const parsed = JSON.parse(packet.payload.toString("utf8"));
        if (parsed && typeof parsed === "object" && parsed.type === "streamStatus") {
          this.onStreamStatus?.(parsed);
        }
      } catch {}
    }
  }

  #closeVideoConn() {
    this.#videoAuthenticated = false;
    this.#videoDecoder?.reset();
    this.#videoDecoder = null;
    if (this.#videoConn && !this.#videoConn.destroyed) {
      try {
        this.#videoConn.destroy();
      } catch {}
    }
    this.#videoConn = null;
  }

  #startHeartbeat() {
    this.#stopHeartbeat();
    this.#missedHeartbeats = 0;
    this.#heartbeatTimer = setInterval(async () => {
      if (!this.available) return;
      try {
        await this.request("ping", {}, HEARTBEAT_TIMEOUT_MS);
        this.#missedHeartbeats = 0;
      } catch {
        this.#missedHeartbeats += 1;
        if (this.#missedHeartbeats >= MAX_MISSED_HEARTBEATS) {
          this.#onSocketClosed("helper_heartbeat_timeout");
        }
      }
    }, HEARTBEAT_INTERVAL_MS);
    this.#heartbeatTimer.unref?.();
  }

  #stopHeartbeat() {
    if (this.#heartbeatTimer) {
      clearInterval(this.#heartbeatTimer);
      this.#heartbeatTimer = null;
    }
  }

  #onSocketClosed(reason) {
    this.#stopHeartbeat();
    const wasAvailable = this.#available;
    this.#available = false;
    this.#authenticated = false;
    this.#unavailableReason = reason;
    if (this.#conn && !this.#conn.destroyed) {
      try {
        this.#conn.destroy();
      } catch {}
    }
    this.#conn = null;
    for (const entry of this.#pending.values()) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
    this.#pending.clear();
    if (wasAvailable) {
      this.onCapabilitiesChanged?.({
        screenRecordingPreflight: false,
        inputMonitoringPreflight: false,
        accessibilityTrusted: false,
        mouseTapActive: false,
        keyTapActive: false,
        hotkeyActive: false,
        fallbackReason: reason,
      });
      this.onStatusChanged?.(this.getDiagnostics());
      this.#scheduleAutoRestart(reason);
    }
  }

  #clearRestartTimer() {
    if (this.#restartTimer) {
      clearTimeout(this.#restartTimer);
      this.#restartTimer = null;
    }
  }

  #scheduleAutoRestart(reason) {
    if (
      this.#closed ||
      !this.autoRestart ||
      this.#restartTimer ||
      this.#restarting ||
      this.#starting ||
      !["helper_disconnected", "helper_heartbeat_timeout", "helper_socket_error"].includes(reason)
    ) {
      return;
    }
    const now = Date.now();
    this.#restartTimestamps = this.#restartTimestamps.filter(
      (ts) => now - ts < this.restartWindowMs
    );
    if (this.#restartTimestamps.length >= this.maxRestartsInWindow) {
      this.#unavailableReason = "helper_restart_exhausted";
      this.onStatusChanged?.(this.getDiagnostics());
      return;
    }
    this.#restartTimestamps.push(now);
    this.#restartTimer = setTimeout(async () => {
      this.#restartTimer = null;
      if (this.#closed || this.#restarting) return;
      this.#restarting = true;
      try {
        await this.#resetConnectionOnly();
        if (this.#closed) return;
        this.#unavailableReason = "reconnecting";
        this.onStatusChanged?.(this.getDiagnostics());
        await this.start();
      } catch {
      } finally {
        this.#restarting = false;
      }
    }, this.restartDelayMs);
    this.#restartTimer.unref?.();
  }

  async request(op, params = {}, timeoutMs = 2000) {
    if (!this.available) {
      throw new Error(`DesktopHelper unavailable (${this.#unavailableReason})`);
    }
    const id = this.#nextReqId++;
    return new Promise((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.#pending.delete(String(id));
              reject(new Error(`DesktopHelper op ${op} timed out after ${timeoutMs}ms`));
            }, timeoutMs)
          : null;
      timer?.unref?.();
      this.#pending.set(String(id), { resolve, reject, timer });
      try {
        this.#conn.write(`${JSON.stringify({ v: 1, id, op, params })}\n`);
      } catch (err) {
        if (timer) clearTimeout(timer);
        this.#pending.delete(String(id));
        reject(err);
      }
    });
  }

  async probe() {
    if (!this.available) return this.getDiagnostics();
    const res = await this.request("probe", {}, 1500);
    if (res?.capabilities) {
      this.#capabilities = { ...this.#capabilities, ...res.capabilities };
    }
    return this.getDiagnostics();
  }

  async setTakeoverTargets(targets = [], trustedPids = null) {
    if (!this.available) return false;
    try {
      const payload = { targets };
      if (Array.isArray(trustedPids)) {
        const cleanPids = trustedPids.map((p) => Number(p)).filter((p) => Number.isInteger(p) && p > 0);
        this.trustedPids = cleanPids;
        payload.trustedPids = cleanPids;
      }
      await this.request("setTakeoverTargets", payload, 1000);
      return true;
    } catch {
      return false;
    }
  }

  async setEmergencyHotkey(hotkey) {
    this.emergencyHotkey = String(hotkey || EMERGENCY_HOTKEY);
    if (!this.available) return false;
    try {
      const res = await this.request("setEmergencyHotkey", { hotkey: this.emergencyHotkey }, 1000);
      return Boolean(res?.valid);
    } catch {
      return false;
    }
  }

  async resetTakeoverLatch() {
    if (!this.available) return false;
    try {
      await this.request("resetTakeoverLatch", {}, 1000);
      return true;
    } catch {
      return false;
    }
  }

  async listWindows(pid = null) {
    if (!this.available) return [];
    const res = await this.request("listWindows", pid > 0 ? { pid } : {}, 1500);
    return Array.isArray(res?.windows) ? res.windows : [];
  }

  async requestPermission(kind) {
    if (!this.available) {
      throw new Error(`DesktopHelper unavailable (${this.#unavailableReason})`);
    }
    const res = await this.request("requestPermission", { kind }, 5000);
    if (res?.capabilities) {
      this.#capabilities = { ...this.#capabilities, ...res.capabilities };
      this.onCapabilitiesChanged?.({ ...this.#capabilities });
    }
    return res;
  }

  async startStream({ pid, processToken = null, windowId, targetKey, geometryRev = 1 } = {}) {
    return this.request(
      "start",
      { pid, processToken, windowId, targetKey, geometryRev },
      4000
    );
  }

  async stopStream(streamId) {
    if (!this.available || !(Number(streamId) > 0)) return false;
    try {
      const res = await this.request("stop", { streamId: Number(streamId) }, 1500);
      return Boolean(res?.stopped);
    } catch {
      return false;
    }
  }

  async requestKeyframe(streamId, { targetKey = null, geometryRev = null } = {}) {
    if (!this.available || !(Number(streamId) > 0)) return false;
    try {
      const res = await this.request(
        "keyframe",
        {
          streamId: Number(streamId),
          ...(targetKey ? { targetKey } : {}),
          ...(Number(geometryRev) > 0 ? { geometryRev: Number(geometryRev) } : {}),
        },
        1500
      );
      return Boolean(res?.requested);
    } catch {
      return false;
    }
  }

  async captureWindowJpeg({ pid, processToken = null, windowId } = {}) {
    if (!this.available) {
      throw new Error(`DesktopHelper unavailable (${this.#unavailableReason})`);
    }
    return this.request("captureWindowJpeg", { pid, processToken, windowId }, 3500);
  }

  async #closeServersOnly() {
    if (this.#videoServer) {
      await new Promise((resolve) => {
        try {
          this.#videoServer.close(() => resolve());
        } catch {
          resolve();
        }
      });
      this.#videoServer = null;
    }
    if (this.#server) {
      await new Promise((resolve) => {
        try {
          this.#server.close(() => resolve());
        } catch {
          resolve();
        }
      });
      this.#server = null;
    }
  }

  async #resetConnectionOnly() {
    this.#stopHeartbeat();
    this.#closeVideoConn();
    this.#onSocketClosed(this.#unavailableReason || "reset");
    await this.#closeServersOnly();
    this.#cleanupRuntimeArtifacts();
  }

  #cleanupRuntimeArtifacts() {
    if (this.#runtimeDir) {
      try {
        rmSync(this.#runtimeDir, { recursive: true, force: true });
      } catch {}
      this.#runtimeDir = null;
      this.#socketPath = null;
      this.#videoSocketPath = null;
      this.#rendezvousPath = null;
    }
  }

  async close() {
    this.#closed = true;
    this.#clearRestartTimer();
    this.#stopHeartbeat();
    if (this.available) {
      try {
        await this.request("shutdown", {}, 400);
      } catch {}
    }
    if (this.#helperPid > 0) {
      try {
        process.kill(this.#helperPid, "SIGTERM");
      } catch {}
    }
    await this.#resetConnectionOnly();
  }
}
