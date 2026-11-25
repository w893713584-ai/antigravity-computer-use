import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import http from "node:http";
import { promisify } from "node:util";
import {
  MAX_HTTP_BODY_BYTES,
  PREVIEW_VIDEO_JS_PATH,
  SIDECAR_PRELOAD_PATH,
  UI_HTML_PATH,
} from "./constants.mjs";
import { parseImageDimensions } from "./background-policy.mjs";
import { buildUiInteractionPauseClaim } from "./takeover-controller.mjs";

const execFileAsync = promisify(execFile);

export const BIND_HOST = "127.0.0.1";
const ACTIVE_STREAM_INTERVAL_MS = 110; // ~9 fps during active interaction
const IDLE_STREAM_INTERVAL_MS = 420;   // ~2.4 fps when idle watching
const ACTIVE_BOOST_WINDOW_MS = 4500;
const MAX_FRAME_HISTORY = 8;

/**
 * Deep Transport Adapter: SidecarWebAdapter
 *
 * Isolates HTTP / SSE / WebSocket video attach / token-auth / AgentAPI forwarding /
 * frame-history verification / adaptive live-stream timer plumbing for the
 * Side-Pane Mini-Window from the core Computer Use Broker state machine.
 */
export class SidecarWebAdapter {
  constructor({
    webPort = 0,
    uiToken = "",
    brokerBootId,
    state,
    getActiveActionCount = () => 0,
    shouldPollJpeg = () => true,
    isScreenLockedBackoff = () => false,
    refreshPermissionsQuietly = async () => {},
    getPermissionsReport = null,
    onRequestPermission = async () => ({ ok: false }),
    refreshAppsList = async () => ({ apps: [] }),
    onGetWindows = async () => ({ ok: true, windows: [] }),
    runSerializedAction = async (fn) => fn(),
    onSelectApp = async () => ({}),
    onBringToFront = async () => {},
    preQueueValidateInteract = null,
    onInteract = async () => ({ ok: true }),
    onTakeoverClaim = async () => ({ ok: true }),
    onSettingsUpdate = null,
    onVideoSubscribe = async () => ({ mode: "jpeg", reason: "unsupported" }),
    onVideoControl = async () => ({ ok: false }),
    wsHub = null,
    captureStreamTick = async () => {},
    maxSseClients = 2,
  }) {
    this.webPort = webPort;
    this.uiToken = uiToken;
    this.brokerBootId = brokerBootId;
    this.state = state;
    this.getActiveActionCount = getActiveActionCount;
    this.shouldPollJpeg = shouldPollJpeg;
    this.isScreenLockedBackoff = isScreenLockedBackoff;
    this.refreshPermissionsQuietly = refreshPermissionsQuietly;
    this.getPermissionsReport = getPermissionsReport;
    this.onRequestPermission = onRequestPermission;
    this.refreshAppsList = refreshAppsList;
    this.onGetWindows = onGetWindows;
    this.runSerializedAction = runSerializedAction;
    this.onSelectApp = onSelectApp;
    this.onBringToFront = onBringToFront;
    this.preQueueValidateInteract = preQueueValidateInteract;
    this.onInteract = onInteract;
    this.onTakeoverClaim = onTakeoverClaim;
    this.onSettingsUpdate = onSettingsUpdate;
    this.onVideoSubscribe = onVideoSubscribe;
    this.onVideoControl = onVideoControl;
    this.wsHub = wsHub;
    this.captureStreamTick = captureStreamTick;
    this.maxSseClients = Math.max(1, Number(maxSseClients) || 2);

    this.httpServer = null;
    this.sseClients = new Set();
    this.sseClientTimers = new Map();
    this.streamTimer = null;
    this.latestFrameBytes = null;
    this.latestFrameMime = "image/jpeg";
    this.frameHistory = [];
  }

  #cleanupSseClient(res) {
    const timer = this.sseClientTimers.get(res);
    if (timer) {
      clearInterval(timer);
      this.sseClientTimers.delete(res);
    }
    this.sseClients.delete(res);
  }

  #evictSseClient(res, reason = "max_clients") {
    this.#cleanupSseClient(res);
    try {
      if (!res.writableEnded && !res.destroyed) {
        res.write(`event: superseded\ndata: ${JSON.stringify({ reason })}\n\n`);
        res.end();
      }
    } catch {}
    const destroyTimer = setTimeout(() => {
      try {
        if (!res.destroyed) res.destroy();
      } catch {}
    }, 250);
    destroyTimer.unref?.();
  }

  validateHttpToken(req, url) {
    if (
      (req?.method === "GET" || req?.method === "HEAD") &&
      (url.pathname === "/" ||
        url.pathname === "/index.html" ||
        url.pathname === "/preload.js" ||
        url.pathname === "/preview-video.js" ||
        url.pathname === "/healthz")
    ) {
      return true;
    }
    if (!this.uiToken) return true;
    const provided = req?.headers?.["x-sidecar-token"] || url.searchParams.get("token");
    return provided === this.uiToken;
  }

  publicState() {
    return {
      brokerBootId: this.brokerBootId,
      activeApp: this.state.activeApp,
      appDisplayName: this.state.appDisplayName,
      bundleId: this.state.bundleId,
      pid: this.state.pid,
      windowId: this.state.windowId ?? null,
      pinnedWindowId: this.state.pinnedWindowId ?? null,
      targetKey: this.state.targetKey ?? null,
      geometryRev: this.state.geometryRev ?? 1,
      windowTitle: this.state.windowTitle,
      occludedNote: this.state.occludedNote,
      activeSnapshotId: this.state.activeSnapshotId,
      followAi: this.state.followAi,
      paused: this.state.paused,
      pausePhase: this.state.pausePhase || (this.state.paused ? "paused" : "running"),
      pauseEpoch: this.state.pauseEpoch ?? 0,
      pauseReason: this.state.pauseReason || null,
      pauseDetail: this.state.pauseDetail || null,
      takeoverMode: this.state.takeoverMode || "baseline",
      emergencyHotkey: this.state.emergencyHotkey || "ctrl+opt+escape",
      aiStatus: this.state.aiStatus,
      lastAction: this.state.lastAction,
      actionSeq: this.state.actionSeq,
      frameSeq: this.state.frameSeq,
      frameWidth: this.state.frameWidth,
      frameHeight: this.state.frameHeight,
      frameLatencyMs: this.state.frameLatencyMs,
      hasFrame: Boolean(this.latestFrameBytes),
      previewGeometry: this.state.previewGeometry ?? null,
      previewReadOnly: Boolean(this.state.previewReadOnly),
      previewReadOnlyReason: this.state.previewReadOnlyReason ?? null,
      streamPaused: Boolean(this.state.streamPaused),
      streamPausedReason: this.state.streamPausedReason ?? null,
      videoTransport: this.state.videoTransport || "jpeg",
      availableWindows: Array.isArray(this.state.availableWindows) ? this.state.availableWindows : [],
      recentActions: this.state.recentActions,
      runningApps: this.state.runningApps,
      permissions: this.state.permissions,
      ...(this.state.permissionComponents ? { permissionComponents: this.state.permissionComponents } : {}),
      headlessStats: { ...this.state.headlessStats },
    };
  }

  broadcastSse(event, payload) {
    if (this.sseClients.size === 0) return;
    const packet = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const res of this.sseClients) {
      try {
        res.write(packet);
      } catch {
        this.#cleanupSseClient(res);
      }
    }
  }

  broadcastState() {
    this.broadcastSse("state", this.publicState());
  }

  pushActionEvent({
    type,
    label,
    source = "ai",
    normX = null,
    normY = null,
    windowPointPt = null,
    windowId = null,
    app = null,
    targetApp = null,
  }) {
    this.state.actionSeq += 1;
    this.state.lastActivityAt = Date.now();
    const evt = {
      seq: this.state.actionSeq,
      type,
      label,
      source,
      app: app || this.state.appDisplayName || this.state.activeApp,
      targetApp: targetApp || this.state.bundleId || this.state.activeApp,
      normX: Number.isFinite(normX) ? Math.max(0, Math.min(1, normX)) : null,
      normY: Number.isFinite(normY) ? Math.max(0, Math.min(1, normY)) : null,
      ...(windowPointPt &&
      Number.isFinite(Number(windowPointPt.x)) &&
      Number.isFinite(Number(windowPointPt.y))
        ? { windowPointPt: { x: Number(windowPointPt.x), y: Number(windowPointPt.y) } }
        : {}),
      ...(Number(windowId) > 0 ? { windowId: Number(windowId) } : {}),
      ...(this.state.targetKey ? { targetKey: this.state.targetKey } : {}),
      timestamp: this.state.lastActivityAt,
    };
    this.state.lastAction = evt;
    this.state.recentActions = [evt, ...this.state.recentActions].slice(0, 14);
    this.broadcastSse("action", evt);
    this.broadcastState();
  }

  updateFrameFromImageItem(imageItem, latencyMs = 0, { frameMeta = null } = {}) {
    if (!imageItem?.data) return null;
    const bytes = Buffer.from(imageItem.data, "base64");
    const dims = parseImageDimensions(bytes);
    const nextTargetKey = frameMeta?.targetKey ?? this.state.targetKey ?? null;
    const nextGeomRev = frameMeta?.geometryRev ?? this.state.geometryRev ?? 1;
    const nextWindowId = frameMeta
      ? (frameMeta.windowId ?? null)
      : (this.state.pinnedWindowId > 0 ? null : (this.state.windowId ?? null));
    const nextAmbiguous = Boolean(frameMeta?.ambiguous);
    const lastHist = this.frameHistory[this.frameHistory.length - 1] || null;
    const identityChanged =
      !lastHist ||
      lastHist.targetKey !== nextTargetKey ||
      lastHist.geometryRev !== nextGeomRev ||
      (lastHist.windowId ?? null) !== (nextWindowId ?? null) ||
      Boolean(lastHist.ambiguous) !== nextAmbiguous;

    const unchanged =
      !identityChanged &&
      this.latestFrameBytes &&
      this.latestFrameBytes.length === bytes.length &&
      Buffer.compare(this.latestFrameBytes, bytes) === 0;

    this.latestFrameBytes = bytes;
    this.latestFrameMime = imageItem.mimeType || "image/jpeg";
    if (dims) {
      this.state.frameWidth = dims.width;
      this.state.frameHeight = dims.height;
    }
    if (latencyMs > 0) {
      this.state.frameLatencyMs = latencyMs;
    }
    if (!unchanged) {
      this.state.frameSeq += 1;
      const frameRef = {
        transport: "jpeg",
        brokerBootId: this.brokerBootId,
        seq: this.state.frameSeq,
        targetKey: nextTargetKey,
        geometryRev: nextGeomRev,
        windowId: nextWindowId,
      };
      this.frameHistory.push({
        seq: this.state.frameSeq,
        bytes,
        mimeType: this.latestFrameMime,
        width: this.state.frameWidth,
        height: this.state.frameHeight,
        targetKey: nextTargetKey,
        geometryRev: nextGeomRev,
        windowId: nextWindowId,
        ambiguous: nextAmbiguous,
        frameRef,
      });
      if (this.frameHistory.length > MAX_FRAME_HISTORY) {
        this.frameHistory.splice(0, this.frameHistory.length - MAX_FRAME_HISTORY);
      }
      this.broadcastSse("frame", {
        brokerBootId: this.brokerBootId,
        frameSeq: this.state.frameSeq,
        targetKey: nextTargetKey,
        geometryRev: nextGeomRev,
        windowId: nextWindowId,
        frameRef,
        width: this.state.frameWidth,
        height: this.state.frameHeight,
        latencyMs: this.state.frameLatencyMs,
      });
    }
    return dims;
  }

  clearFrameAndStopStream() {
    this.latestFrameBytes = null;
    this.frameHistory = [];
    this.stopStreamTimer();
  }

  stopStreamTimer() {
    if (this.streamTimer) {
      clearTimeout(this.streamTimer);
      this.streamTimer = null;
    }
  }

  ensureStreamLoop() {
    if (this.streamTimer) return;
    const tick = async () => {
      if (this.sseClients.size === 0 || !this.state.activeApp) {
        this.streamTimer = null;
        return;
      }
      if (this.getActiveActionCount() === 0 && this.shouldPollJpeg()) {
        await this.captureStreamTick();
      }
      if (!this.state.activeApp || this.sseClients.size === 0) {
        this.streamTimer = null;
        return;
      }
      const recentlyActive = Date.now() - this.state.lastActivityAt < ACTIVE_BOOST_WINDOW_MS;
      const delay = this.isScreenLockedBackoff()
        ? 2500
        : recentlyActive
          ? ACTIVE_STREAM_INTERVAL_MS
          : IDLE_STREAM_INTERVAL_MS;
      this.streamTimer = setTimeout(tick, delay);
      this.streamTimer.unref?.();
    };
    this.streamTimer = setTimeout(tick, 40);
    this.streamTimer.unref?.();
  }

  async #execAgentApi(args, { projectId } = {}) {
    const env = { ...process.env };
    if (typeof projectId === "string" && projectId.trim()) {
      env.ANTIGRAVITY_PROJECT_ID = projectId.trim();
    }
    const exe = process.env.ANTIGRAVITY_AGENTAPI_EXE;
    const file = exe || "agentapi";
    const execArgs = exe ? ["agentapi", ...args] : args;
    const { stdout } = await execFileAsync(file, execArgs, {
      encoding: "utf-8",
      env,
      timeout: 15_000,
    });
    return stdout.trim() ? JSON.parse(stdout) : {};
  }

  async #readJsonBody(req) {
    const contentType = String(req.headers["content-type"] || "").toLowerCase();
    return new Promise((resolve, reject) => {
      const chunks = [];
      let total = 0;
      let aborted = false;
      req.on("data", (chunk) => {
        if (aborted) return;
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += buf.length;
        if (total > MAX_HTTP_BODY_BYTES) {
          aborted = true;
          const err = new Error("Payload Too Large");
          err.statusCode = 413;
          reject(err);
          req.destroy();
          return;
        }
        chunks.push(buf);
      });
      req.on("error", (err) => {
        if (!aborted) reject(err);
      });
      req.on("end", () => {
        if (aborted) return;
        const raw = Buffer.concat(chunks).toString("utf8").trim();
        if (!raw) {
          resolve({});
          return;
        }
        if (!contentType.includes("application/json")) {
          const err = new Error("Content-Type must be application/json");
          err.statusCode = 415;
          reject(err);
          return;
        }
        try {
          resolve(JSON.parse(raw));
        } catch {
          const err = new Error("Invalid JSON body");
          err.statusCode = 400;
          reject(err);
        }
      });
    });
  }

  async handleRequest(req, res) {
    let url;
    try {
      url = new URL(req.url || "/", `http://${BIND_HOST}:${this.webPort || 80}`);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid request URL" }));
      return;
    }

    try {
      if (!this.validateHttpToken(req, url)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }

    const isGetOrHead = req.method === "GET" || req.method === "HEAD";
    const isHead = req.method === "HEAD";
    const secHeaders = {
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    };

    if (isGetOrHead && url.pathname === "/healthz") {
      res.writeHead(200, { "Content-Type": "application/json", ...secHeaders });
      res.end(isHead ? undefined : JSON.stringify({ ok: true }));
      return;
    }

    if (isGetOrHead && url.pathname === "/preload.js") {
      const preload = existsSync(SIDECAR_PRELOAD_PATH)
        ? readFileSync(SIDECAR_PRELOAD_PATH, "utf8")
        : "window.sidecar = window.sidecar || { fetch: window.fetch.bind(window) };";
      res.writeHead(200, {
        "Content-Type": "application/javascript; charset=utf-8",
        "Cache-Control": "no-store",
        ...secHeaders,
      });
      res.end(isHead ? undefined : preload);
      return;
    }

    if (isGetOrHead && (url.pathname === "/" || url.pathname === "/index.html")) {
      const html = readFileSync(UI_HTML_PATH, "utf8");
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        ...secHeaders,
      });
      res.end(isHead ? undefined : html);
      return;
    }

    if (isGetOrHead && url.pathname === "/preview-video.js") {
      const js = existsSync(PREVIEW_VIDEO_JS_PATH) ? readFileSync(PREVIEW_VIDEO_JS_PATH, "utf8") : "";
      res.writeHead(200, {
        "Content-Type": "application/javascript; charset=utf-8",
        "Cache-Control": "no-store",
        ...secHeaders,
      });
      res.end(isHead ? undefined : js);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/frame.jpg") {
      const reqBoot = url.searchParams.get("boot");
      if (reqBoot && reqBoot !== this.brokerBootId) {
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Broker session restarted", code: "STALE_VIEW" }));
        return;
      }
      const seqRaw = url.searchParams.get("seq");
      const reqTargetKey = url.searchParams.get("targetKey");
      if (seqRaw !== null) {
        const reqSeq = Number.parseInt(seqRaw, 10);
        const match = this.frameHistory.find((entry) => entry.seq === reqSeq);
        if (!match) {
          res.writeHead(409, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Stale or evicted frame seq", code: "STALE_VIEW" }));
          return;
        }
        if (reqTargetKey && match.targetKey && reqTargetKey !== match.targetKey) {
          res.writeHead(409, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Frame targetKey mismatch", code: "STALE_VIEW" }));
          return;
        }
        res.writeHead(200, {
          "Content-Type": match.mimeType || "image/jpeg",
          "Content-Length": match.bytes.length,
          "Cache-Control": "no-store, no-cache, must-revalidate",
          "X-CUA-Frame-Seq": String(match.seq),
          ...(match.targetKey ? { "X-CUA-Target-Key": match.targetKey } : {}),
          "X-CUA-Geometry-Rev": String(match.geometryRev ?? 1),
        });
        res.end(match.bytes);
        return;
      }
      if (!this.latestFrameBytes) {
        res.writeHead(204);
        res.end();
        return;
      }
      res.writeHead(200, {
        "Content-Type": this.latestFrameMime,
        "Content-Length": this.latestFrameBytes.length,
        "Cache-Control": "no-store, no-cache, must-revalidate",
      });
      res.end(this.latestFrameBytes);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/windows") {
      const out = await this.onGetWindows();
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(out));
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/permissions") {
      await this.refreshPermissionsQuietly();
      const body =
        typeof this.getPermissionsReport === "function"
          ? await this.getPermissionsReport()
          : this.state.permissions;
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(body));
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/state") {
      if (this.state.permissions.accessibility === null) {
        await this.refreshPermissionsQuietly();
      }
      if (this.state.runningApps.length === 0) {
        try {
          await this.refreshAppsList();
        } catch {}
      }
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(this.publicState()));
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.flushHeaders?.();
      while (this.sseClients.size >= this.maxSseClients) {
        const oldestRes = this.sseClients.values().next().value;
        if (!oldestRes) break;
        this.#evictSseClient(oldestRes, "max_clients");
      }
      res.write(`event: state\ndata: ${JSON.stringify(this.publicState())}\n\n`);
      this.sseClients.add(res);
      this.ensureStreamLoop();

      const keepAlive = setInterval(() => {
        try {
          if (res.writableEnded || res.destroyed) {
            this.#cleanupSseClient(res);
            return;
          }
          res.write(": ping\n\n");
        } catch {
          this.#cleanupSseClient(res);
        }
      }, 15_000);
      keepAlive.unref?.();
      this.sseClientTimers.set(res, keepAlive);

      req.on("close", () => {
        this.#cleanupSseClient(res);
      });
      res.on("close", () => {
        this.#cleanupSseClient(res);
      });
      return;
    }

    if (req.method === "POST") {
      const badRequest = (msg) => {
        const err = new Error(msg);
        err.statusCode = 400;
        return err;
      };
      try {
        const data = await this.#readJsonBody(req);

        if (url.pathname === "/_sidecar/send-message") {
          const convId = String(data.conversationId || "").trim();
          const message = String(data.message || "");
          if (!convId || convId.startsWith("-") || !message) {
            throw badRequest("conversationId and message are required");
          }
          const out = await this.#execAgentApi(
            [
              "send-message",
              ...(typeof data.title === "string" && data.title ? ["--title", data.title] : []),
              "--",
              convId,
              message,
            ],
            { projectId: data.projectId }
          );
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(out));
          return;
        }
        if (url.pathname === "/_sidecar/new-conversation") {
          const model = String(data.model || "flash").trim();
          const message = String(data.message || "");
          if (!message || model.startsWith("-")) {
            throw badRequest("valid model and message are required");
          }
          const out = await this.#execAgentApi(
            ["new-conversation", "--model", model, "--", message],
            { projectId: data.projectId }
          );
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(out));
          return;
        }
        if (url.pathname === "/_sidecar/get-conversation-metadata") {
          const convId = String(data.conversationId || "").trim();
          if (!convId || convId.startsWith("-")) {
            throw badRequest("valid conversationId is required");
          }
          const out = await this.#execAgentApi(["get-conversation-metadata", convId]);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(out));
          return;
        }

        if (url.pathname === "/api/refresh-apps") {
          await this.runSerializedAction(async () => {
            await this.refreshAppsList();
          });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(this.publicState()));
          return;
        }

        if (url.pathname === "/api/select-app") {
          const target = String(data.app || "").trim();
          if (!target) throw badRequest("app is required");
          const payload = await this.runSerializedAction(() => this.onSelectApp(target, data));
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(payload));
          return;
        }

        if (url.pathname === "/api/settings") {
          if (typeof this.onSettingsUpdate === "function") {
            const out = await this.onSettingsUpdate(data);
            if (out?.statusCode && out.statusCode >= 400) {
              res.writeHead(out.statusCode, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ ...out, state: this.publicState() }));
              return;
            }
          } else {
            if (typeof data.followAi === "boolean") this.state.followAi = data.followAi;
            if (typeof data.paused === "boolean") {
              this.state.paused = data.paused;
              this.pushActionEvent({
                type: "setting",
                label: data.paused ? "已暂停 AI 操作" : "已恢复 AI 操作",
                source: "ui",
              });
            }
            this.broadcastState();
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(this.publicState()));
          return;
        }

        if (url.pathname === "/api/takeover-claim") {
          if (data.brokerBootId && data.brokerBootId !== this.brokerBootId) {
            const staleErr = new Error("Broker session restarted; please retry");
            staleErr.statusCode = 409;
            throw staleErr;
          }
          const out = await this.onTakeoverClaim(data);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ...out, state: this.publicState() }));
          return;
        }

        if (url.pathname === "/api/permissions/request") {
          const kind = String(data.kind || "").trim();
          const out = await this.onRequestPermission(kind);
          res.writeHead(out?.ok === false ? 400 : 200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(out));
          return;
        }

        if (url.pathname === "/api/bring-to-front") {
          const target = String(data.app || this.state.activeApp || "").trim();
          await this.onBringToFront(target);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
          return;
        }

        if (url.pathname === "/api/video/subscribe") {
          if (data.brokerBootId && data.brokerBootId !== this.brokerBootId) {
            const staleErr = new Error("Broker session restarted; please retry");
            staleErr.statusCode = 409;
            throw staleErr;
          }
          const out = await this.onVideoSubscribe(data);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(out));
          return;
        }

        if (url.pathname === "/api/video/control") {
          if (data.brokerBootId && data.brokerBootId !== this.brokerBootId) {
            const staleErr = new Error("Broker session restarted; please retry");
            staleErr.statusCode = 409;
            throw staleErr;
          }
          const out = await this.onVideoControl(data);
          res.writeHead(out?.ok === false && out?.statusCode ? out.statusCode : 200, {
            "Content-Type": "application/json",
          });
          res.end(JSON.stringify(out));
          return;
        }

        if (url.pathname === "/api/interact") {
          if (data.brokerBootId && data.brokerBootId !== this.brokerBootId) {
            const staleErr = new Error("Broker session restarted; please retry");
            staleErr.statusCode = 409;
            throw staleErr;
          }
          const app = String(data.app || this.state.activeApp || "").trim();
          if (!app) throw badRequest("请先选择一个要操作的后台窗口");
          if (typeof this.preQueueValidateInteract === "function") {
            const preCheck = await this.preQueueValidateInteract(app, data);
            if (preCheck && !preCheck.ok) {
              res.writeHead(preCheck.statusCode || 409, { "Content-Type": "application/json" });
              res.end(
                JSON.stringify({
                  ok: false,
                  code: preCheck.code || "STALE_VIEW",
                  error: preCheck.error || preCheck.message || "Stale view",
                  state: this.publicState(),
                })
              );
              return;
            }
          }
          if (typeof this.onTakeoverClaim === "function") {
            await this.onTakeoverClaim(buildUiInteractionPauseClaim(app, data));
          }
          const payload = await this.runSerializedAction(() => this.onInteract(app, data));
          res.writeHead(payload?.statusCode >= 400 ? payload.statusCode : 200, {
            "Content-Type": "application/json",
          });
          res.end(JSON.stringify(payload));
          return;
        }

        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not found" }));
      } catch (err) {
        const code = err?.statusCode || 500;
        if (!res.headersSent) {
          res.writeHead(code, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        }
      }
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
    } catch (outerErr) {
      const code = outerErr?.statusCode || 500;
      if (!res.headersSent) {
        res.writeHead(code, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: outerErr instanceof Error ? outerErr.message : String(outerErr) }));
      } else {
        try {
          res.end();
        } catch {}
      }
    }
  }

  async start() {
    this.httpServer = http.createServer((req, res) => {
      this.handleRequest(req, res).catch(() => {
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Internal server error" }));
        }
      });
    });
    await new Promise((resolve, reject) => {
      this.httpServer.once("error", reject);
      this.httpServer.listen(this.webPort, BIND_HOST, () => {
        this.webPort = this.httpServer.address().port;
        resolve();
      });
    });
    this.wsHub?.attach(this.httpServer);
    return this.webPort;
  }

  async close() {
    this.stopStreamTimer();
    this.wsHub?.closeAll();
    for (const client of Array.from(this.sseClients)) {
      this.#cleanupSseClient(client);
      try {
        client.end();
      } catch {}
    }
    this.sseClients.clear();
    for (const timer of this.sseClientTimers.values()) {
      clearInterval(timer);
    }
    this.sseClientTimers.clear();
    if (this.httpServer) {
      this.httpServer.closeAllConnections?.();
      await new Promise((resolve) => this.httpServer.close(() => resolve()));
      this.httpServer = null;
    }
  }
}
