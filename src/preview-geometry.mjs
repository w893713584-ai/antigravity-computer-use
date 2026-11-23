const GEOMETRY_TOLERANCE_PT = 1.0;
const ASPECT_TOLERANCE_RATIO = 0.03;

export function normalizeRectPt(raw) {
  if (!raw || typeof raw !== "object") return null;
  const x = Number(raw.x);
  const y = Number(raw.y);
  const width = Number(raw.width ?? raw.w);
  const height = Number(raw.height ?? raw.h);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !(width > 0) || !(height > 0)) {
    return null;
  }
  return { x, y, width, height };
}

export function normalizeSize(raw) {
  if (!raw || typeof raw !== "object") return null;
  const width = Number(raw.width ?? raw.w);
  const height = Number(raw.height ?? raw.h);
  if (!Number.isFinite(width) || !Number.isFinite(height) || !(width > 0) || !(height > 0)) {
    return null;
  }
  return { width, height };
}

export function rectsEqualPt(a, b, tolerance = GEOMETRY_TOLERANCE_PT) {
  const ra = normalizeRectPt(a);
  const rb = normalizeRectPt(b);
  if (!ra || !rb) return false;
  return (
    Math.abs(ra.x - rb.x) <= tolerance &&
    Math.abs(ra.y - rb.y) <= tolerance &&
    Math.abs(ra.width - rb.width) <= tolerance &&
    Math.abs(ra.height - rb.height) <= tolerance
  );
}

/**
 * Canonical window identity token combining PID, launch generation (`processToken`),
 * CoreGraphics `CGWindowID`, and local observation generation (`windowGeneration`).
 * Prevents silent reuse across exited apps or recycled CGWindowIDs.
 */
export function buildTargetKey({
  pid = 0,
  processToken = null,
  windowId = 0,
  windowGeneration = 1,
} = {}) {
  const p = Number(pid) > 0 ? Math.trunc(Number(pid)) : 0;
  const t = typeof processToken === "string" && processToken.trim() ? encodeURIComponent(processToken.trim()) : "";
  const w = Number(windowId) > 0 ? Math.trunc(Number(windowId)) : 0;
  const g = Number(windowGeneration) > 0 ? Math.trunc(Number(windowGeneration)) : 1;
  return `v1|${p}|${t}|${w}|${g}`;
}

export function parseTargetKey(targetKey) {
  if (typeof targetKey !== "string" || !targetKey.startsWith("v1|")) return null;
  const parts = targetKey.split("|");
  if (parts.length !== 5) return null;
  const pid = Number.parseInt(parts[1], 10);
  let processToken = null;
  try {
    processToken = parts[2] ? decodeURIComponent(parts[2]) : null;
  } catch {
    processToken = null;
  }
  const windowId = Number.parseInt(parts[3], 10);
  const windowGeneration = Number.parseInt(parts[4], 10);
  return {
    pid: Number.isInteger(pid) && pid > 0 ? pid : 0,
    processToken,
    windowId: Number.isInteger(windowId) && windowId > 0 ? windowId : 0,
    windowGeneration: Number.isInteger(windowGeneration) && windowGeneration > 0 ? windowGeneration : 1,
  };
}

/**
 * Compute exact visible content rectangle (`object-fit: contain`) inside a container box
 * using logical content dimensions so black bars / letterboxing are explicitly excluded.
 */
export function computeContainDisplayRect(containerWidth, containerHeight, contentWidth, contentHeight) {
  const cw = Number(containerWidth);
  const ch = Number(containerHeight);
  const vw = Number(contentWidth);
  const vh = Number(contentHeight);
  if (!(cw > 0) || !(ch > 0) || !(vw > 0) || !(vh > 0)) return null;
  const scale = Math.min(cw / vw, ch / vh);
  const width = vw * scale;
  const height = vh * scale;
  return {
    x: (cw - width) / 2,
    y: (ch - height) / 2,
    width,
    height,
  };
}

/**
 * Map a pointer offset inside the canvas/viewport container to `[0, 1]` within `visibleRect`.
 * Rejects points falling into letterbox/pillarbox black bars rather than clamping them onto edges.
 */
export function pointerToNormalizedContent(offsetX, offsetY, visibleRect) {
  const rect = normalizeRectPt(visibleRect);
  const px = Number(offsetX);
  const py = Number(offsetY);
  if (!rect || !Number.isFinite(px) || !Number.isFinite(py)) {
    return { ok: false, code: "MISSING_DISPLAY_RECT", reason: "visible_rect_unavailable" };
  }
  const relX = (px - rect.x) / rect.width;
  const relY = (py - rect.y) / rect.height;
  if (relX < 0 || relX > 1 || relY < 0 || relY > 1) {
    return { ok: false, code: "OUTSIDE_CONTENT_RECT", reason: "pointer_in_letterbox" };
  }
  return {
    ok: true,
    normX: relX,
    normY: relY,
  };
}

/**
 * Determine whether arbitrary-point coordinates (`/api/interact` click/scroll) are
 * proven to hit the exact window rendered in the Mini-Window.
 */
export function evaluateArbitraryPointCapability({
  geometry,
  jxaTrusted = false,
  singleWindowProven = false,
  ocuActionProven = false,
} = {}) {
  if (!geometry || !geometry.windowBoundsPt || !geometry.previewContentRectPt) {
    return {
      allowed: false,
      route: null,
      allowAppPostFallback: false,
      readOnlyReason: "missing_geometry",
    };
  }
  const explicitWindowId = Boolean(geometry.explicitWindowId);
  if (jxaTrusted === true && geometry.pid > 0 && (geometry.windowId > 0 || !explicitWindowId)) {
    return {
      allowed: true,
      route: "window_post",
      allowAppPostFallback: Boolean(!explicitWindowId && singleWindowProven),
      readOnlyReason: null,
    };
  }

  let ocuProven = false;
  if (!explicitWindowId) {
    if (ocuActionProven === true) {
      ocuProven = true;
    } else if (ocuActionProven && typeof ocuActionProven === "object") {
      const pidOk = !(ocuActionProven.pid > 0 && geometry.pid > 0) || ocuActionProven.pid === geometry.pid;
      const tokenOk =
        !ocuActionProven.processToken ||
        !geometry.processToken ||
        ocuActionProven.processToken === geometry.processToken;
      const widOk =
        !(ocuActionProven.windowId > 0 && geometry.windowId > 0) ||
        ocuActionProven.windowId === geometry.windowId;
      const px = normalizeSize(ocuActionProven.pixelSize || ocuActionProven);
      const refRect = normalizeRectPt(geometry.actionContentRectPt || geometry.previewContentRectPt);
      let aspectOk = true;
      if (px && refRect) {
        const pxAspect = px.width / px.height;
        const winAspect = refRect.width / refRect.height;
        aspectOk = Math.abs(pxAspect - winAspect) / Math.max(winAspect, 0.001) <= ASPECT_TOLERANCE_RATIO;
      }
      ocuProven = Boolean(pidOk && tokenOk && widOk && px && aspectOk);
    }
  }

  if (ocuProven) {
    return {
      allowed: true,
      route: "ocu_pixel",
      allowAppPostFallback: false,
      readOnlyReason: null,
    };
  }

  return {
    allowed: false,
    route: null,
    allowAppPostFallback: false,
    readOnlyReason: explicitWindowId ? "explicit_wid_requires_window_post" : "unproven_same_window",
  };
}

/**
 * Construct canonical `PreviewGeometry` binding window logical bounds, preview image
 * crop/size, OCU action screenshot crop/size, and fail-closed arbitrary-point capability.
 */
export function createPreviewGeometry({
  brokerBootId = null,
  pid = 0,
  processToken = null,
  windowId = 0,
  windowGeneration = 1,
  targetKey = null,
  explicitWindowId = false,
  geometryRev = 1,
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
} = {}) {
  const normBounds = normalizeRectPt(windowBoundsPt);
  const fullLocalRect = normBounds
    ? { x: 0, y: 0, width: normBounds.width, height: normBounds.height }
    : null;
  const normPreviewCrop = normalizeRectPt(previewContentRectPt) || fullLocalRect;
  const normActionCrop = normalizeRectPt(actionContentRectPt) || fullLocalRect;
  const normPreviewPx = normalizeSize(previewPixelSize);
  const normActionPx = normalizeSize(actionPixelSize);
  const computedTargetKey =
    targetKey ||
    buildTargetKey({
      pid,
      processToken,
      windowId,
      windowGeneration,
    });

  const base = {
    brokerBootId: brokerBootId || null,
    targetKey: computedTargetKey,
    pid: Number(pid) > 0 ? Math.trunc(Number(pid)) : 0,
    processToken: processToken || null,
    windowId: Number(windowId) > 0 ? Math.trunc(Number(windowId)) : 0,
    windowGeneration: Number(windowGeneration) > 0 ? Math.trunc(Number(windowGeneration)) : 1,
    explicitWindowId: Boolean(explicitWindowId),
    geometryRev: Number(geometryRev) > 0 ? Math.trunc(Number(geometryRev)) : 1,
    windowBoundsPt: normBounds,
    previewContentRectPt: normPreviewCrop,
    previewPixelSize: normPreviewPx,
    actionContentRectPt: normActionCrop,
    actionPixelSize: normActionPx,
    scaleFactor: Number(scaleFactor) > 0 ? Number(scaleFactor) : null,
  };

  if (readOnlyOverride) {
    return {
      ...base,
      readOnly: true,
      readOnlyReason: readOnlyReasonOverride || "read_only",
      deliveryRoute: null,
      allowAppPostFallback: false,
    };
  }

  const cap = evaluateArbitraryPointCapability({
    geometry: base,
    jxaTrusted,
    singleWindowProven,
    ocuActionProven,
  });

  return {
    ...base,
    readOnly: !cap.allowed,
    readOnlyReason: cap.allowed ? null : cap.readOnlyReason,
    deliveryRoute: cap.route,
    allowAppPostFallback: cap.allowAppPostFallback,
  };
}

/**
 * Validate UI `frameRef` against current active `PreviewGeometry` and (optionally) a fresh
 * live CoreGraphics window record (`WindowInventory` / `desktopHelper.listWindows`).
 */
export function validateFrameRef(frameRef, currentGeometry, liveWindow = null) {
  if (!frameRef || typeof frameRef !== "object") {
    return {
      ok: false,
      statusCode: 409,
      code: "STALE_VIEW",
      reason: "missing_frame_ref",
      message: "画面帧引用缺失，请刷新后重试。",
    };
  }
  if (!currentGeometry || !currentGeometry.targetKey) {
    return {
      ok: false,
      statusCode: 409,
      code: "STALE_VIEW",
      reason: "no_active_geometry",
      message: "当前没有可验证的目标窗口几何信息。",
    };
  }
  if (
    currentGeometry.brokerBootId &&
    frameRef.brokerBootId &&
    frameRef.brokerBootId !== currentGeometry.brokerBootId
  ) {
    return {
      ok: false,
      statusCode: 409,
      code: "STALE_VIEW",
      reason: "broker_boot_mismatch",
      message: "Broker 会话已重启，旧画面已失效。",
    };
  }
  if (!frameRef.targetKey || frameRef.targetKey !== currentGeometry.targetKey) {
    return {
      ok: false,
      statusCode: 409,
      code: "STALE_VIEW",
      reason: "target_key_mismatch",
      message: "目标窗口已切换，旧画面点击已拦截。",
    };
  }
  if (
    Number(frameRef.windowId) > 0 &&
    currentGeometry.windowId > 0 &&
    Number(frameRef.windowId) !== currentGeometry.windowId
  ) {
    return {
      ok: false,
      statusCode: 409,
      code: "STALE_VIEW",
      reason: "window_id_mismatch",
      message: "目标窗口 ID 已变化，旧画面点击已拦截。",
    };
  }
  if (Number(frameRef.geometryRev) !== Number(currentGeometry.geometryRev)) {
    return {
      ok: false,
      statusCode: 409,
      code: "STALE_VIEW",
      reason: "geometry_rev_mismatch",
      message: "窗口尺寸或位置已变化，请使用最新画面重试。",
    };
  }
  if (!(Number(frameRef.seq) > 0)) {
    return {
      ok: false,
      statusCode: 409,
      code: "STALE_VIEW",
      reason: "invalid_frame_seq",
      message: "帧序号无效，无法派发。",
    };
  }
  if (frameRef.transport === "h264") {
    if (!(Number(frameRef.streamId) > 0) || !(Number(frameRef.generation) > 0)) {
      return {
        ok: false,
        statusCode: 409,
        code: "STALE_VIEW",
        reason: "invalid_h264_stream_identity",
        message: "H.264 帧缺少有效流标识或代次，无法派发。",
      };
    }
  }

  if (liveWindow && typeof liveWindow === "object") {
    const livePid = Number(liveWindow.pid || 0);
    if (currentGeometry.pid > 0 && livePid > 0 && livePid !== currentGeometry.pid) {
      return {
        ok: false,
        statusCode: 409,
        code: "STALE_VIEW",
        reason: "live_pid_mismatch",
        message: "目标进程已变化，已拒绝旧画面输入。",
      };
    }
    if (
      currentGeometry.processToken &&
      liveWindow.processToken &&
      liveWindow.processToken !== currentGeometry.processToken
    ) {
      return {
        ok: false,
        statusCode: 409,
        code: "STALE_VIEW",
        reason: "live_process_token_mismatch",
        message: "目标进程已重启，已拒绝旧画面输入。",
      };
    }
    const liveWid = Number(liveWindow.windowId || liveWindow.wid || 0);
    if (currentGeometry.windowId > 0 && liveWid > 0 && liveWid !== currentGeometry.windowId) {
      return {
        ok: false,
        statusCode: 409,
        code: "STALE_VIEW",
        reason: "live_window_id_mismatch",
        message: "实时窗口 ID 已变化，已拒绝旧画面输入。",
      };
    }
    const liveBounds = normalizeRectPt(liveWindow.boundsPt || liveWindow.bounds || liveWindow.windowBounds);
    if (currentGeometry.windowBoundsPt && liveBounds) {
      if (!rectsEqualPt(currentGeometry.windowBoundsPt, liveBounds, GEOMETRY_TOLERANCE_PT)) {
        return {
          ok: false,
          statusCode: 409,
          code: "STALE_VIEW",
          reason: "live_window_bounds_changed",
          message: "真实窗口已移动或缩放，已拒绝旧坐标输入。",
        };
      }
    }
  }

  if (currentGeometry.readOnly) {
    return {
      ok: false,
      statusCode: 409,
      code: "UNPROVEN_SAME_WINDOW",
      reason: currentGeometry.readOnlyReason || "read_only",
      message: "当前窗口尚未证明同窗任意点派发能力，小窗处于只读保护状态。",
    };
  }

  return { ok: true, statusCode: 200, code: null, reason: null };
}

/**
 * Convert normalized preview coordinates `[0, 1]` inside `previewContentRectPt`
 * into canonical window-local logical points and Quartz global screen points.
 */
export function mapToWindowPoint(norm, geometry) {
  const nx = Number(norm?.normX ?? norm?.x);
  const ny = Number(norm?.normY ?? norm?.y);
  if (!Number.isFinite(nx) || !Number.isFinite(ny) || nx < 0 || nx > 1 || ny < 0 || ny > 1) {
    return null;
  }
  const crop = normalizeRectPt(geometry?.previewContentRectPt);
  const winBounds = normalizeRectPt(geometry?.windowBoundsPt);
  if (!crop || !winBounds) return null;
  const x = crop.x + nx * crop.width;
  const y = crop.y + ny * crop.height;
  return {
    x,
    y,
    screenX: winBounds.x + x,
    screenY: winBounds.y + y,
  };
}

/**
 * Project a window-local logical point into the OCU action screenshot pixel coordinate
 * space. Rounding occurs only at this final pixel interface.
 */
export function mapToActionPixel(windowPoint, geometry) {
  const px = Number(windowPoint?.x);
  const py = Number(windowPoint?.y);
  const actionCrop = normalizeRectPt(geometry?.actionContentRectPt || geometry?.previewContentRectPt);
  const actionPx = normalizeSize(geometry?.actionPixelSize);
  if (!Number.isFinite(px) || !Number.isFinite(py) || !actionCrop || !actionPx) {
    return null;
  }
  const relX = (px - actionCrop.x) / actionCrop.width;
  const relY = (py - actionCrop.y) / actionCrop.height;
  if (relX < -1e-6 || relX > 1 + 1e-6 || relY < -1e-6 || relY > 1 + 1e-6) {
    return null;
  }
  const clampedX = Math.max(0, Math.min(1, relX));
  const clampedY = Math.max(0, Math.min(1, relY));
  return {
    x: Math.round(clampedX * actionPx.width),
    y: Math.round(clampedY * actionPx.height),
  };
}

/**
 * Inverse helper: convert a delivered OCU action pixel back into a window-local logical point.
 */
export function actionPixelToWindowPoint(pixel, geometry) {
  const sx = Number(pixel?.x);
  const sy = Number(pixel?.y);
  const actionCrop = normalizeRectPt(geometry?.actionContentRectPt || geometry?.previewContentRectPt);
  const actionPx = normalizeSize(geometry?.actionPixelSize);
  if (!Number.isFinite(sx) || !Number.isFinite(sy) || !actionCrop || !actionPx) {
    return null;
  }
  const winBounds = normalizeRectPt(geometry?.windowBoundsPt);
  const x = actionCrop.x + (sx * actionCrop.width) / actionPx.width;
  const y = actionCrop.y + (sy * actionCrop.height) / actionPx.height;
  return {
    x,
    y,
    ...(winBounds ? { screenX: winBounds.x + x, screenY: winBounds.y + y } : {}),
  };
}

/**
 * Project a canonical window-local logical point onto the active preview surface's
 * normalized `[0, 1]` cursor overlay coordinates.
 */
export function projectCursor(windowPoint, geometry) {
  const px = Number(windowPoint?.x);
  const py = Number(windowPoint?.y);
  const previewCrop = normalizeRectPt(geometry?.previewContentRectPt);
  if (!Number.isFinite(px) || !Number.isFinite(py) || !previewCrop) {
    return { visible: false, normX: null, normY: null };
  }
  const normX = (px - previewCrop.x) / previewCrop.width;
  const normY = (py - previewCrop.y) / previewCrop.height;
  if (normX < -0.02 || normX > 1.02 || normY < -0.02 || normY > 1.02) {
    return { visible: false, normX: null, normY: null };
  }
  return {
    visible: true,
    normX: Math.max(0, Math.min(1, normX)),
    normY: Math.max(0, Math.min(1, normY)),
  };
}
