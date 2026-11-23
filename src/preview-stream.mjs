import {
  VIDEO_FIRST_FRAME_TIMEOUT_MS,
  VIDEO_IDR_RECOVERY_TIMEOUT_MS,
  VIDEO_MAX_ACTIVE_TARGETS,
  VIDEO_MODE_ENV,
  VIDEO_PACKET_TYPE,
  VIDEO_TARGET_WARM_HOLD_MS,
} from "./constants.mjs";
import {
  buildTargetKey,
  createPreviewGeometry,
  normalizeRectPt,
  rectsEqualPt,
} from "./preview-geometry.mjs";
import { parseAvcDecoderConfig } from "./video-websocket.mjs";

const SUPPRESSIBLE_REASONS = new Set([
  "screen_recording_not_granted",
  "webcodecs_unavailable",
  "codec_unsupported",
  "hardware_encoder_unavailable",
  "video_rollback_jpeg",
]);

function normalizeWindowEntry(raw) {
  if (!raw || typeof raw !== "object") return null;
  const pid = Number(raw.pid || 0);
  const wid = Number(raw.windowId || raw.wid || 0);
  const boundsPt = normalizeRectPt(raw.boundsPt || raw.bounds);
  if (!(pid > 0) || !(wid > 0) || !boundsPt) return null;
  const layer = Number(raw.layer ?? 0);
  const alpha = raw.alpha === undefined ? 1 : Number(raw.alpha);
  if (alpha <= 0.01) return null;
  const isMainCandidate = layer === 0 && boundsPt.width >= 180 && boundsPt.height >= 120;
  return {
    pid,
    windowId: wid,
    layer,
    ownerName: String(raw.ownerName || ""),
    bundleId: raw.bundleId ? String(raw.bundleId) : null,
    title: String(raw.title || ""),
    alpha,
    onScreen: raw.onScreen !== false,
    boundsPt,
    kind: isMainCandidate ? "main" : "popup",
  };
}

/**
 * Coordinates same-window target selection, `PreviewGeometry` revisions, dual-target
 * `SCStream + VTCompressionSession` lifecycle (3s warm hold, max 2 concurrent streams),
 * per-view JPEG <-> H.264 handover, and stall/minimize fallback to same-WID JPEG or paused empty state.
 */
export class PreviewStreamManager {
  #targets = new Map(); // targetKey -> target stream record
  #views = new Map(); // viewId -> per-Mini-Window transport state
  #activeTargetKey = null;
  #geometries = new Map(); // targetKey -> PreviewGeometry
  #windowGenerations = new Map(); // windowId -> { pid, processToken, gen }
  #availableWindows = [];
  #capabilityEpoch = 1;
  #closed = false;

  constructor({
    brokerBootId,
    videoMode = VIDEO_MODE_ENV,
    maxActiveTargets = VIDEO_MAX_ACTIVE_TARGETS,
    warmHoldMs = VIDEO_TARGET_WARM_HOLD_MS,
    firstFrameTimeoutMs = VIDEO_FIRST_FRAME_TIMEOUT_MS,
    idrRecoveryTimeoutMs = VIDEO_IDR_RECOVERY_TIMEOUT_MS,
    desktopHelperClient = null,
    wsHub = null,
    onStateChanged = null,
    onFallbackJpegFrame = null,
    onRequestJpegTick = null,
  } = {}) {
    this.brokerBootId = brokerBootId;
    this.videoMode = String(videoMode || "auto").toLowerCase();
    this.maxActiveTargets = maxActiveTargets;
    this.warmHoldMs = warmHoldMs;
    this.firstFrameTimeoutMs = firstFrameTimeoutMs;
    this.idrRecoveryTimeoutMs = idrRecoveryTimeoutMs;
    this.desktopHelperClient = desktopHelperClient;
    this.wsHub = wsHub;
    this.onStateChanged = onStateChanged;
    this.onFallbackJpegFrame = onFallbackJpegFrame;
    this.onRequestJpegTick = onRequestJpegTick;
  }

  get activeTargetKey() {
    return this.#activeTargetKey;
  }

  get availableWindows() {
    return this.#availableWindows.map((w) => ({ ...w, boundsPt: { ...w.boundsPt } }));
  }

  bumpCapabilityEpoch() {
    this.#capabilityEpoch += 1;
    for (const view of this.#views.values()) {
      view.fallbackSuppressKey = null;
    }
  }

  resolveWindowGeneration(pid, processToken, windowId) {
    const wid = Number(windowId || 0);
    if (!(wid > 0)) return 1;
    const prev = this.#windowGenerations.get(wid);
    if (!prev) {
      this.#windowGenerations.set(wid, { pid, processToken: processToken || null, gen: 1 });
      return 1;
    }
    if (prev.pid !== pid || (prev.processToken && processToken && prev.processToken !== processToken)) {
      const nextGen = prev.gen + 1;
      this.#windowGenerations.set(wid, { pid, processToken: processToken || null, gen: nextGen });
      return nextGen;
    }
    if (!prev.processToken && processToken) {
      prev.processToken = processToken;
    }
    return prev.gen;
  }

  /**
   * Select target window without ever mutating focus/z-order/minimized state or
   * auto-switching from an already selected main window to an auxiliary popup.
   */
  selectTargetWindow({
    pid = 0,
    meta = null,
    explicitWindowId = null,
    windows = [],
  } = {}) {
    const normalized = (Array.isArray(windows) ? windows : [])
      .map(normalizeWindowEntry)
      .filter((w) => w && (!(pid > 0) || w.pid === pid));
    this.#availableWindows = normalized;

    const reqExplicit = Number(explicitWindowId) > 0 ? Number(explicitWindowId) : null;
    if (reqExplicit) {
      const hit = normalized.find((w) => w.windowId === reqExplicit) || null;
      return {
        selected: hit,
        explicitWindowId: true,
        notFound: normalized.length > 0 && !hit,
        availableWindows: this.availableWindows,
      };
    }

    const provenWid = Number(meta?.tinyWindowOverride?.wid || meta?.windowId || 0);
    if (provenWid > 0) {
      const provenHit = normalized.find((w) => w.windowId === provenWid) || null;
      if (provenHit) {
        return {
          selected: provenHit,
          explicitWindowId: false,
          notFound: false,
          availableWindows: this.availableWindows,
        };
      }
    }

    // Main window selection: keep existing main window stable against transient popups.
    const mainCandidates = normalized.filter((w) => w.kind === "main");
    const pool = mainCandidates.length > 0 ? mainCandidates : normalized;
    const onScreenPool = pool.filter((w) => w.onScreen);
    const searchPool = onScreenPool.length > 0 ? onScreenPool : pool;

    let best = null;
    let bestArea = -1;
    for (const w of searchPool) {
      const area = w.boundsPt.width * w.boundsPt.height;
      if (area > bestArea) {
        bestArea = area;
        best = w;
      }
    }
    return {
      selected: best,
      explicitWindowId: false,
      notFound: false,
      availableWindows: this.availableWindows,
    };
  }

  syncActiveGeometry({
    pid = 0,
    processToken = null,
    windowId = 0,
    explicitWindowId = false,
    windowBoundsPt = null,
    previewContentRectPt = null,
    previewPixelSize = null,
    actionContentRectPt = null,
    actionPixelSize = null,
    scaleFactor = null,
    jxaTrusted = false,
    singleWindowProven = false,
    ocuActionProven = false,
    readOnlyOverride = false,
    readOnlyReasonOverride = null,
    selectAsActive = undefined,
    activate = undefined,
  } = {}) {
    const shouldSelectAsActive =
      selectAsActive !== undefined ? Boolean(selectAsActive) : activate !== undefined ? Boolean(activate) : true;
    const winGen = this.resolveWindowGeneration(pid, processToken, windowId);
    const targetKey = buildTargetKey({ pid, processToken, windowId, windowGeneration: winGen });
    const prev = this.#geometries.get(targetKey) || null;

    let geometryRev = prev?.geometryRev || 1;
    if (prev) {
      const boundsChanged =
        Boolean(windowBoundsPt && prev.windowBoundsPt) &&
        !rectsEqualPt(windowBoundsPt, prev.windowBoundsPt, 1.0);
      const cropChanged =
        Boolean(previewContentRectPt && prev.previewContentRectPt) &&
        !rectsEqualPt(previewContentRectPt, prev.previewContentRectPt, 1.0);
      const prevPx = prev.previewPixelSize;
      const pxChanged = Boolean(
        previewPixelSize &&
          prevPx &&
          (Math.abs(previewPixelSize.width - prevPx.width) > 1 ||
            Math.abs(previewPixelSize.height - prevPx.height) > 1)
      );
      if (boundsChanged || cropChanged || pxChanged) {
        geometryRev += 1;
      }
    }

    const buildGeometry = (rev) =>
      createPreviewGeometry({
        brokerBootId: this.brokerBootId,
        pid,
        processToken,
        windowId,
        windowGeneration: winGen,
        targetKey,
        explicitWindowId,
        geometryRev: rev,
        windowBoundsPt: windowBoundsPt || prev?.windowBoundsPt || null,
        previewContentRectPt: previewContentRectPt || prev?.previewContentRectPt || null,
        previewPixelSize: previewPixelSize || prev?.previewPixelSize || null,
        actionContentRectPt: actionContentRectPt || prev?.actionContentRectPt || null,
        actionPixelSize: actionPixelSize || prev?.actionPixelSize || null,
        scaleFactor: scaleFactor ?? prev?.scaleFactor ?? null,
        jxaTrusted,
        singleWindowProven,
        ocuActionProven,
        readOnlyOverride,
        readOnlyReasonOverride,
      });

    let next = buildGeometry(geometryRev);
    if (
      prev &&
      geometryRev === (prev.geometryRev || 1) &&
      (Boolean(prev.readOnly) !== Boolean(next.readOnly) ||
        (prev.readOnlyReason ?? null) !== (next.readOnlyReason ?? null) ||
        (prev.deliveryRoute ?? null) !== (next.deliveryRoute ?? null))
    ) {
      next = buildGeometry(geometryRev + 1);
    }

    this.#geometries.set(targetKey, next);
    if (shouldSelectAsActive) {
      this.#activeTargetKey = targetKey;
    }
    const t = this.#targets.get(targetKey);
    if (t) {
      t.geometry = next;
      t.geometryRev = next.geometryRev;
    }
    return next;
  }

  clearActiveGeometry() {
    this.#activeTargetKey = null;
    this.#availableWindows = [];
  }

  getActiveGeometry() {
    return this.#activeTargetKey ? this.#geometries.get(this.#activeTargetKey) || null : null;
  }

  getGeometry(targetKey) {
    return targetKey ? this.#geometries.get(targetKey) || null : null;
  }

  getViewDiagnostics() {
    const out = {};
    for (const [vid, view] of this.#views) {
      out[vid] = {
        viewId: vid,
        targetKey: view.targetKey,
        mode: view.mode,
        streamId: view.streamId,
        generation: view.generation,
        fallbackReason: view.fallbackReason,
        lastRenderedSeq: view.lastRenderedSeq,
      };
    }
    return out;
  }

  getViewTransportSummary(targetKey = this.#activeTargetKey) {
    if (this.videoMode === "jpeg" || this.videoMode === "off") {
      return { transport: "jpeg", reason: "video_rollback_jpeg", streamPaused: false };
    }
    const target = targetKey ? this.#targets.get(targetKey) : null;
    if (target?.streamPaused) {
      return {
        transport: "paused",
        reason: target.streamPausedReason || "stream_paused",
        streamPaused: true,
      };
    }
    for (const view of this.#views.values()) {
      if (targetKey && view.targetKey !== targetKey) continue;
      if (view.mode === "h264") {
        return { transport: "h264", reason: null, streamPaused: false };
      }
      if (view.mode === "probe" || view.mode === "decode_ready") {
        return { transport: "jpeg", reason: "probing_h264", streamPaused: false };
      }
      if (view.fallbackReason) {
        return { transport: "jpeg", reason: view.fallbackReason, streamPaused: false };
      }
    }
    return { transport: "jpeg", reason: null, streamPaused: false };
  }

  needsJpegPolling(targetKey = this.#activeTargetKey) {
    if (!targetKey) return false;
    if (this.videoMode === "jpeg" || this.videoMode === "off") return true;
    const target = this.#targets.get(targetKey);
    if (!target || target.streamPaused || !target.streamId) return true;

    let matchingViews = 0;
    for (const view of this.#views.values()) {
      if (view.targetKey !== targetKey) continue;
      matchingViews += 1;
      if (view.mode !== "h264") {
        return true;
      }
    }
    return matchingViews === 0;
  }

  #ensureView(viewId) {
    let view = this.#views.get(viewId);
    if (!view) {
      view = {
        viewId,
        targetKey: null,
        mode: "jpeg",
        fallbackReason: null,
        fallbackSuppressKey: null,
        streamId: null,
        generation: 0,
        firstFrameTimer: null,
        recoveryTimer: null,
        lastRenderedSeq: 0,
      };
      this.#views.set(viewId, view);
    }
    return view;
  }

  #clearViewTimers(view) {
    if (view.firstFrameTimer) {
      clearTimeout(view.firstFrameTimer);
      view.firstFrameTimer = null;
    }
    if (view.recoveryTimer) {
      clearTimeout(view.recoveryTimer);
      view.recoveryTimer = null;
    }
  }

  #detachViewFromTarget(view) {
    if (!view.targetKey) return;
    const prevTarget = this.#targets.get(view.targetKey);
    if (prevTarget) {
      prevTarget.viewIds.delete(view.viewId);
      if (prevTarget.viewIds.size === 0 && prevTarget.streamId && !prevTarget.warmHoldTimer) {
        prevTarget.warmHoldTimer = setTimeout(() => {
          prevTarget.warmHoldTimer = null;
          void this.stopTargetStream(prevTarget.targetKey, "warm_hold_expired");
        }, this.warmHoldMs);
        prevTarget.warmHoldTimer.unref?.();
      }
    }
    this.wsHub?.disconnectSubscriber(view.viewId, "view_rebound");
  }

  async subscribe({
    viewId,
    targetKey = null,
    supportsWebCodecs = true,
    webCodecsReason = null,
  } = {}) {
    if (this.#closed) {
      return { mode: "jpeg", reason: "manager_closed" };
    }
    const cleanViewId = String(viewId || "").trim();
    if (!cleanViewId) {
      throw new Error("viewId is required");
    }
    const effectiveKey = String(targetKey || this.#activeTargetKey || "").trim();
    const geom = effectiveKey ? this.#geometries.get(effectiveKey) : null;
    const view = this.#ensureView(cleanViewId);

    const makeFallback = (reason, suppress = false) => {
      this.#clearViewTimers(view);
      if (view.targetKey !== effectiveKey) {
        this.#detachViewFromTarget(view);
        view.targetKey = effectiveKey || null;
      }
      view.mode = "jpeg";
      view.streamId = null;
      view.fallbackReason = reason;
      if (suppress && SUPPRESSIBLE_REASONS.has(reason)) {
        view.fallbackSuppressKey = `${this.#capabilityEpoch}:${reason}`;
      }
      this.wsHub?.disconnectSubscriber(cleanViewId, reason);
      this.onRequestJpegTick?.();
      this.onStateChanged?.();
      return {
        mode: "jpeg",
        viewId: cleanViewId,
        targetKey: effectiveKey || null,
        reason,
        brokerBootId: this.brokerBootId,
      };
    };

    if (this.videoMode === "jpeg" || this.videoMode === "off") {
      return makeFallback("video_rollback_jpeg", true);
    }
    if (!effectiveKey || !geom || !(geom.pid > 0) || !(geom.windowId > 0)) {
      return makeFallback("no_target_window", false);
    }
    if (!supportsWebCodecs) {
      return makeFallback(webCodecsReason || "webcodecs_unavailable", true);
    }

    const helperDiag = this.desktopHelperClient?.getDiagnostics?.() || null;
    if (!helperDiag?.available || !helperDiag?.videoAvailable) {
      return makeFallback("desktop_helper_video_unavailable", false);
    }
    if (!helperDiag.capabilities?.screenRecordingPreflight) {
      return makeFallback("screen_recording_not_granted", true);
    }
    if (
      view.fallbackSuppressKey &&
      view.fallbackSuppressKey.startsWith(`${this.#capabilityEpoch}:`)
    ) {
      return makeFallback(view.fallbackReason || "suppressed", true);
    }

    if (view.targetKey && view.targetKey !== effectiveKey) {
      this.#detachViewFromTarget(view);
    }

    let target = this.#targets.get(effectiveKey);
    if (!target) {
      if (this.#targets.size >= this.maxActiveTargets) {
        // Reclaim an idle warm-hold target before rejecting a new active viewer.
        let evictedKey = null;
        for (const [candKey, cand] of this.#targets) {
          if (cand.viewIds.size === 0) {
            evictedKey = candKey;
            break;
          }
        }
        if (evictedKey) {
          await this.stopTargetStream(evictedKey, "evicted_for_new_target");
        } else {
          return makeFallback("max_streams_reached", false);
        }
      }
      target = {
        targetKey: effectiveKey,
        pid: geom.pid,
        processToken: geom.processToken,
        windowId: geom.windowId,
        geometry: geom,
        geometryRev: geom.geometryRev,
        streamId: null,
        generation: 0,
        latestConfigPacket: null,
        latestStatus: null,
        streamPaused: false,
        streamPausedReason: null,
        viewIds: new Set(),
        warmHoldTimer: null,
        startingPromise: null,
      };
      this.#targets.set(effectiveKey, target);
    }

    if (target.warmHoldTimer) {
      clearTimeout(target.warmHoldTimer);
      target.warmHoldTimer = null;
    }

    if (!target.streamId) {
      if (!target.startingPromise) {
        target.startingPromise = this.desktopHelperClient
          .startStream({
            pid: geom.pid,
            processToken: geom.processToken,
            windowId: geom.windowId,
            targetKey: effectiveKey,
            geometryRev: geom.geometryRev,
          })
          .then((res) => {
            target.streamId = Number(res?.streamId || 0);
            if (!(target.streamId > 0)) {
              throw new Error("invalid_helper_stream_id");
            }
            return target;
          })
          .finally(() => {
            target.startingPromise = null;
          });
      }
      try {
        await target.startingPromise;
      } catch (err) {
        this.#targets.delete(effectiveKey);
        return makeFallback(err?.message || "stream_start_failed", false);
      }
    }

    this.#clearViewTimers(view);
    view.targetKey = effectiveKey;
    view.mode = "probe";
    view.fallbackReason = null;
    view.streamId = target.streamId;
    view.generation = target.generation || 0;
    target.viewIds.add(cleanViewId);

    const ticket = this.wsHub.issueTicket({
      viewId: cleanViewId,
      targetKey: effectiveKey,
      streamId: target.streamId,
    });

    view.firstFrameTimer = setTimeout(() => {
      view.firstFrameTimer = null;
      if (view.targetKey === effectiveKey && view.mode !== "h264") {
        this.#degradeViewToJpeg(view, "first_frame_timeout");
      }
    }, this.firstFrameTimeoutMs);
    view.firstFrameTimer.unref?.();

    this.onStateChanged?.();
    return {
      mode: "probe",
      viewId: cleanViewId,
      targetKey: effectiveKey,
      streamId: target.streamId,
      generation: target.generation || 0,
      geometryRev: geom.geometryRev,
      wsPath: `/api/video/ws?ticket=${encodeURIComponent(ticket)}`,
      brokerBootId: this.brokerBootId,
      firstFrameTimeoutMs: this.firstFrameTimeoutMs,
    };
  }

  validateH264FrameRef(frameRef) {
    if (!frameRef || typeof frameRef !== "object" || frameRef.transport !== "h264") {
      return {
        ok: false,
        statusCode: 409,
        code: "STALE_VIEW",
        reason: "invalid_h264_frame_ref",
        message: "H.264 帧引用无效。",
      };
    }
    const target = frameRef.targetKey ? this.#targets.get(frameRef.targetKey) : null;
    if (
      !target ||
      !(target.streamId > 0) ||
      Number(frameRef.streamId) !== target.streamId ||
      !(Number(frameRef.generation) > 0) ||
      Number(frameRef.generation) !== target.generation
    ) {
      return {
        ok: false,
        statusCode: 409,
        code: "STALE_VIEW",
        reason: "h264_stream_generation_mismatch",
        message: "H.264 画面流或代次已失效，请使用最新画面操作。",
      };
    }
    const viewId = typeof frameRef.viewId === "string" ? frameRef.viewId.trim() : "";
    const view = viewId ? this.#views.get(viewId) : null;
    if (
      !view ||
      view.targetKey !== frameRef.targetKey ||
      view.streamId !== target.streamId ||
      (view.mode !== "h264" && view.mode !== "decode_ready")
    ) {
      return {
        ok: false,
        statusCode: 409,
        code: "STALE_VIEW",
        reason: "h264_view_not_active",
        message: "H.264 订阅视图已降级或不存在，请刷新后重试。",
      };
    }
    return { ok: true };
  }

  setTargetStreamPaused(targetKey, paused, reason = null) {
    const target = targetKey ? this.#targets.get(targetKey) : null;
    if (!target) return false;
    target.streamPaused = Boolean(paused);
    target.streamPausedReason = paused ? reason || "stream_paused" : null;
    this.onStateChanged?.();
    return true;
  }

  onWsSubscriberConnected(sub) {
    const view = this.#views.get(sub.viewId);
    if (!view || view.targetKey !== sub.targetKey) return;
    const target = this.#targets.get(sub.targetKey);
    if (!target || target.streamId !== sub.streamId) return;
    if (target.latestConfigPacket) {
      this.wsHub?.sendPacket(sub, target.latestConfigPacket);
    }
  }

  onWsSubscriberClosed(sub, reason) {
    const view = this.#views.get(sub.viewId);
    if (!view || view.targetKey !== sub.targetKey) return;
    if (view.mode !== "jpeg") {
      this.#degradeViewToJpeg(view, reason || "ws_closed");
    }
  }

  async onWsSubscriberNeedIdr(sub) {
    const view = this.#views.get(sub.viewId);
    if (!view || !sub.streamId) return;
    const target = this.#targets.get(view.targetKey);
    await this.desktopHelperClient?.requestKeyframe?.(sub.streamId, {
      targetKey: view.targetKey,
      geometryRev: target?.geometryRev,
    });
  }

  async handleControl({ viewId, action, streamId = null, generation = null, seq = 0, reason = null } = {}) {
    const cleanViewId = String(viewId || "").trim();
    if (!cleanViewId) {
      throw new Error("viewId is required");
    }
    const view = this.#views.get(cleanViewId);
    if (!view) {
      return { ok: false, reason: "unknown_view" };
    }
    if (streamId !== null && streamId !== undefined && Number(streamId) !== view.streamId) {
      return { ok: false, reason: "stale_stream_id" };
    }

    if (action === "decode_ready") {
      const gen = Number(generation ?? view.generation ?? 0);
      view.mode = "decode_ready";
      view.generation = gen;
      this.wsHub?.markDecodeReady(cleanViewId, gen);
      if (view.streamId) {
        const target = this.#targets.get(view.targetKey);
        await this.desktopHelperClient?.requestKeyframe?.(view.streamId, {
          targetKey: view.targetKey,
          geometryRev: target?.geometryRev,
        });
      }
      return { ok: true, mode: view.mode, streamId: view.streamId, generation: gen };
    }

    if (action === "rendered") {
      this.#clearViewTimers(view);
      view.mode = "h264";
      view.fallbackReason = null;
      if (Number(generation) > 0) view.generation = Number(generation);
      if (Number(seq) > 0) view.lastRenderedSeq = Number(seq);
      const target = this.#targets.get(view.targetKey);
      if (target) {
        target.streamPaused = false;
        target.streamPausedReason = null;
      }
      this.onStateChanged?.();
      return { ok: true, mode: "h264", needsJpegPolling: this.needsJpegPolling(view.targetKey) };
    }

    if (action === "need_idr") {
      this.wsHub?.markAwaitIdr(cleanViewId);
      if (view.recoveryTimer) clearTimeout(view.recoveryTimer);
      view.recoveryTimer = setTimeout(() => {
        view.recoveryTimer = null;
        if (view.streamId) {
          this.#degradeViewToJpeg(view, "idr_recovery_timeout");
        }
      }, this.idrRecoveryTimeoutMs);
      view.recoveryTimer.unref?.();
      if (view.streamId) {
        const target = this.#targets.get(view.targetKey);
        await this.desktopHelperClient?.requestKeyframe?.(view.streamId, {
          targetKey: view.targetKey,
          geometryRev: target?.geometryRev,
        });
      }
      return { ok: true, recoveryScheduled: true };
    }

    if (action === "fallback") {
      this.#degradeViewToJpeg(view, reason || "client_fallback");
      return { ok: true, mode: "jpeg", reason: view.fallbackReason };
    }

    if (action === "unsubscribe") {
      await this.unsubscribeView(cleanViewId, { reason: reason || "client_unsubscribe" });
      return { ok: true };
    }

    throw new Error(`Unsupported video control action: ${action}`);
  }

  async unsubscribeView(viewId, { reason = "unsubscribed" } = {}) {
    const view = this.#views.get(viewId);
    if (!view) return false;
    this.#clearViewTimers(view);
    this.#detachViewFromTarget(view);
    this.#views.delete(viewId);
    this.wsHub?.disconnectSubscriber(viewId, reason);
    this.onRequestJpegTick?.();
    this.onStateChanged?.();
    return true;
  }

  #degradeViewToJpeg(view, reason) {
    this.#clearViewTimers(view);
    view.mode = "jpeg";
    view.fallbackReason = reason || "fallback";
    if (SUPPRESSIBLE_REASONS.has(view.fallbackReason)) {
      view.fallbackSuppressKey = `${this.#capabilityEpoch}:${view.fallbackReason}`;
    }
    if (view.targetKey) {
      const target = this.#targets.get(view.targetKey);
      if (target) {
        target.viewIds.delete(view.viewId);
        if (target.viewIds.size === 0 && target.streamId && !target.warmHoldTimer) {
          target.warmHoldTimer = setTimeout(() => {
            target.warmHoldTimer = null;
            void this.stopTargetStream(target.targetKey, "warm_hold_expired");
          }, this.warmHoldMs);
          target.warmHoldTimer.unref?.();
        }
      }
    }
    view.streamId = null;
    this.wsHub?.disconnectSubscriber(view.viewId, view.fallbackReason);
    this.onRequestJpegTick?.();
    this.onStateChanged?.();
  }

  handleVideoPacket(packet) {
    if (!packet || this.#closed) return;
    let target = null;
    for (const cand of this.#targets.values()) {
      if (cand.streamId === packet.streamId) {
        target = cand;
        break;
      }
    }
    if (!target) return;

    if (packet.type === VIDEO_PACKET_TYPE.CONFIG) {
      let cfg;
      try {
        cfg = JSON.parse(packet.payload.toString("utf8"));
      } catch {
        return;
      }
      const avcInfo = cfg?.avcC ? parseAvcDecoderConfig(cfg.avcC) : { ok: false };
      if (!avcInfo.ok) return;

      target.generation = packet.generation;
      target.latestConfigPacket = packet;
      target.streamPaused = false;
      target.streamPausedReason = null;

      if (target.geometry) {
        const pxW = Number(cfg.sourceCropPx?.width) || Number(cfg.displayWidth) || Number(cfg.codedWidth);
        const pxH = Number(cfg.sourceCropPx?.height) || Number(cfg.displayHeight) || Number(cfg.codedHeight);
        const nextPreviewPx =
          pxW > 0 && pxH > 0 ? { width: pxW, height: pxH } : target.geometry.previewPixelSize;
        const nextCrop = normalizeRectPt(cfg.contentRectPt) || target.geometry.previewContentRectPt;
        const nextCropPx = cfg.sourceCropPx
          ? {
              x: Number(cfg.sourceCropPx.x) || 0,
              y: Number(cfg.sourceCropPx.y) || 0,
              width: Number(cfg.sourceCropPx.width) || 0,
              height: Number(cfg.sourceCropPx.height) || 0,
            }
          : null;
        const prevCropPx = target.lastSourceCropPx || null;
        const cropPxChanged =
          Boolean(prevCropPx && nextCropPx) &&
          (Math.abs(prevCropPx.x - nextCropPx.x) > 0.5 ||
            Math.abs(prevCropPx.y - nextCropPx.y) > 0.5 ||
            Math.abs(prevCropPx.width - nextCropPx.width) > 0.5 ||
            Math.abs(prevCropPx.height - nextCropPx.height) > 0.5);
        target.lastSourceCropPx = nextCropPx;
        const revNum = Number(cfg.geometryRev);
        const curGeom = target.geometry;
        const nextGeomRev =
          Number.isInteger(revNum) && revNum > curGeom.geometryRev
            ? revNum
            : cropPxChanged
              ? curGeom.geometryRev + 1
              : curGeom.geometryRev;
        const updated = createPreviewGeometry({
          ...curGeom,
          geometryRev: nextGeomRev,
          previewContentRectPt: nextCrop,
          previewPixelSize: nextPreviewPx,
          jxaTrusted: curGeom.deliveryRoute === "window_post",
          ocuActionProven: curGeom.deliveryRoute === "ocu_pixel",
          readOnlyOverride: cfg.geometryVerified === false,
          readOnlyReasonOverride: cfg.geometryVerified === false ? "unverified_sc_geometry" : null,
        });
        target.geometry = updated;
        target.geometryRev = updated.geometryRev;
        this.#geometries.set(target.targetKey, updated);
      }

      for (const sub of this.wsHub?.getSubscribersForTarget(target.targetKey) || []) {
        this.wsHub.sendPacket(sub, packet);
      }
      this.onStateChanged?.();
      return;
    }

    if (packet.type === VIDEO_PACKET_TYPE.ACCESS_UNIT) {
      target.streamPaused = false;
      target.streamPausedReason = null;
      for (const sub of this.wsHub?.getSubscribersForTarget(target.targetKey) || []) {
        this.wsHub.sendPacket(sub, packet);
      }
    }
  }

  async handleHelperStreamStatus(status) {
    if (!status || typeof status !== "object" || this.#closed) return;
    let target = null;
    if (status.targetKey && this.#targets.has(status.targetKey)) {
      target = this.#targets.get(status.targetKey);
    } else if (Number(status.streamId) > 0) {
      for (const cand of this.#targets.values()) {
        if (cand.streamId === Number(status.streamId)) {
          target = cand;
          break;
        }
      }
    }
    if (!target) return;
    target.latestStatus = status;

    const st = String(status.state || "");
    if (st === "window_closed") {
      await this.stopTargetStream(target.targetKey, "window_closed");
      this.#geometries.delete(target.targetKey);
      if (this.#activeTargetKey === target.targetKey) {
        this.#activeTargetKey = null;
      }
      this.onStateChanged?.();
      return;
    }

    if (st === "streaming" || st === "geometry_changed") {
      target.streamPaused = false;
      target.streamPausedReason = null;
      if (status.boundsPt) {
        const curGeom = target.geometry;
        if (curGeom) {
          const updated = this.syncActiveGeometry({
            pid: curGeom.pid,
            processToken: curGeom.processToken,
            windowId: curGeom.windowId,
            explicitWindowId: curGeom.explicitWindowId,
            windowBoundsPt: status.boundsPt,
            previewContentRectPt: {
              x: 0,
              y: 0,
              width: Number(status.boundsPt.width),
              height: Number(status.boundsPt.height),
            },
            previewPixelSize: curGeom.previewPixelSize,
            actionContentRectPt: curGeom.actionContentRectPt,
            actionPixelSize: curGeom.actionPixelSize,
            scaleFactor: status.scaleFactor ?? curGeom.scaleFactor,
            jxaTrusted: curGeom.deliveryRoute === "window_post",
            ocuActionProven: curGeom.deliveryRoute === "ocu_pixel",
            selectAsActive: this.#activeTargetKey === target.targetKey,
          });
          target.geometry = updated;
          target.geometryRev = updated.geometryRev;
        }
      }
      this.onStateChanged?.();
      return;
    }

    if (["blank", "suspended", "stalled", "window_minimized", "offscreen", "encoder_error", "stopped"].includes(st)) {
      // Try verifiable same-WID JPEG before freezing to paused read-only state.
      let jpegRes = null;
      if (this.desktopHelperClient?.available && target.pid > 0 && target.windowId > 0) {
        jpegRes = await this.desktopHelperClient
          .captureWindowJpeg({
            pid: target.pid,
            processToken: target.processToken,
            windowId: target.windowId,
          })
          .catch(() => null);
      }

      if (jpegRes?.data && this.onFallbackJpegFrame) {
        target.streamPaused = false;
        target.streamPausedReason = null;
        await this.onFallbackJpegFrame({
          ...jpegRes,
          targetKey: target.targetKey,
          geometryRev: target.geometryRev,
          fallbackReason: st,
        });
        for (const vid of Array.from(target.viewIds)) {
          const view = this.#views.get(vid);
          if (view) this.#degradeViewToJpeg(view, st);
        }
        return;
      }

      target.streamPaused = true;
      target.streamPausedReason = st;
      if (target.geometry) {
        const pausedGeom = createPreviewGeometry({
          ...target.geometry,
          readOnlyOverride: true,
          readOnlyReasonOverride: `stream_${st}`,
        });
        target.geometry = pausedGeom;
        this.#geometries.set(target.targetKey, pausedGeom);
      }
      for (const vid of Array.from(target.viewIds)) {
        const view = this.#views.get(vid);
        if (view) {
          this.#clearViewTimers(view);
          view.mode = "jpeg";
          view.fallbackReason = st;
          this.wsHub?.disconnectSubscriber(vid, st);
        }
      }
      this.onStateChanged?.();
    }
  }

  async stopTargetStream(targetKey, reason = "stopped") {
    const target = this.#targets.get(targetKey);
    if (!target) return false;
    this.#targets.delete(targetKey);
    if (target.warmHoldTimer) {
      clearTimeout(target.warmHoldTimer);
      target.warmHoldTimer = null;
    }
    for (const vid of Array.from(target.viewIds)) {
      const view = this.#views.get(vid);
      if (view) {
        this.#clearViewTimers(view);
        view.streamId = null;
        view.mode = "jpeg";
        view.fallbackReason = reason;
        this.wsHub?.disconnectSubscriber(vid, reason);
      }
    }
    target.viewIds.clear();
    if (target.streamId) {
      await this.desktopHelperClient?.stopStream?.(target.streamId).catch(() => {});
    }
    return true;
  }

  async closeAll() {
    this.#closed = true;
    for (const view of this.#views.values()) {
      this.#clearViewTimers(view);
    }
    this.#views.clear();
    for (const targetKey of Array.from(this.#targets.keys())) {
      await this.stopTargetStream(targetKey, "manager_closed");
    }
    this.#targets.clear();
    this.#geometries.clear();
  }
}
