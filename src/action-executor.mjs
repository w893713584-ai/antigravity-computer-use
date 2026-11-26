import {
  dispatchBackgroundPointClickDetailed,
  dispatchBackgroundPointDragDetailed,
  extractResultImage,
  extractResultText,
  unhideAppWithoutActivating,
} from "./background-policy.mjs";
import {
  buildRouteScopeFromMeta,
  evaluateScreenshotMetaProof,
  hasMatchingAspectRatio,
  isSingleWindowProven,
  normalizeElementBounds,
  resolveFocusedWindowObservation,
} from "./app-snapshot-registry.mjs";
import { isWriteOutcomeUnknown } from "./ax-bridge.mjs";
import { formatDeliveryRoute } from "./focus-policy-guard.mjs";
import { TakeoverAbortedError } from "./takeover-controller.mjs";
import {
  buildStaleRefToolResult,
  computeFrameDigest,
  didUiStructurallyChange,
  resolveJxaPostTrust,
  shouldAttemptSelectedTextFastPath,
  tryHeadlessBackgroundScroll,
  tryHeadlessContextMenu,
  tryHeadlessSelectedTextInsert,
  tryWindowKey,
  tryWindowPostClick,
  tryWindowScroll,
  tryWindowText,
  verifyEditableTextFocus,
  verifySetValueObservation,
} from "./headless-engine.mjs";

export function attachDeliveryReceipt(result, receipt) {
  if (!result || typeof result !== "object" || !receipt || typeof receipt !== "object") {
    return result;
  }
  Object.defineProperty(result, "_deliveryReceipt", {
    value: receipt,
    enumerable: false,
    configurable: true,
    writable: true,
  });
  return result;
}

export const STALE_SNAPSHOT_RE =
  /requires a current.*target window|no longer exists|stale window|No window bounds|coordinate input requires a delivered screenshot|Screenshot omitted|No app state|Run get_app_state|previous element indexes invalidated|Read AX before element-targeted actions/iu;

export function appendResultFooter(result, footerText) {
  if (!result || !footerText || !Array.isArray(result.content)) return result;
  const content = result.content.map((item) => ({ ...item }));
  const firstTextIdx = content.findIndex(
    (item) => item?.type === "text" && typeof item.text === "string"
  );
  if (firstTextIdx >= 0) {
    if (!content[firstTextIdx].text.includes(footerText)) {
      content[firstTextIdx].text = content[firstTextIdx].text
        ? `${content[firstTextIdx].text}\n${footerText}`
        : footerText;
    }
  } else {
    content.unshift({ type: "text", text: footerText });
  }
  return { ...result, content };
}

function isValidTinyOverrideGeometry(ov) {
  return Boolean(
    ov &&
      ov.bounds &&
      Number.isFinite(ov.imgWidth) &&
      ov.imgWidth > 0 &&
      Number.isFinite(ov.imgHeight) &&
      ov.imgHeight > 0 &&
      Number.isFinite(ov.bounds.x) &&
      Number.isFinite(ov.bounds.y) &&
      Number.isFinite(ov.bounds.width) &&
      ov.bounds.width > 0 &&
      Number.isFinite(ov.bounds.height) &&
      ov.bounds.height > 0
  );
}

function isWithinTinyOverrideBounds(ov, x, y) {
  return x >= 0 && y >= 0 && x <= ov.imgWidth + 1 && y <= ov.imgHeight + 1;
}

function mapTinyOverridePoint(ov, x, y) {
  return {
    screenX: ov.bounds.x + (x / ov.imgWidth) * ov.bounds.width,
    screenY: ov.bounds.y + (y / ov.imgHeight) * ov.bounds.height,
  };
}

/**
 * Single authoritative pure coordinate seam: convert window-local logical points
 * (e.g., OCU `query` `bounds` or `AXPosition - winOrigin`) into encoded screenshot
 * pixels for `click({ x, y })`, absorbing Retina scaling & `MAX_DIMENSION=1280`.
 */
export function windowPointToScreenshotPixel(
  point,
  { windowWidth, windowHeight, imageWidth, imageHeight } = {}
) {
  const px = Number(point?.x);
  const py = Number(point?.y);
  const ww = Number(windowWidth);
  const wh = Number(windowHeight);
  const iw = Number(imageWidth);
  const ih = Number(imageHeight);
  if (
    !Number.isFinite(px) ||
    !Number.isFinite(py) ||
    !(ww > 0) ||
    !(wh > 0) ||
    !(iw > 0) ||
    !(ih > 0)
  ) {
    return null;
  }
  return {
    x: (px * iw) / ww,
    y: (py * ih) / wh,
  };
}

const AX_ORIGIN_OFFSET_BUNDLE_RE = /^com\.lemon\.lvpro$/iu;

function hasAxOriginOffsetQuirk(bundle, match) {
  return (
    AX_ORIGIN_OFFSET_BUNDLE_RE.test(String(bundle || "").trim()) &&
    Boolean(normalizeElementBounds(match?.bounds || match?.frame))
  );
}

function normalizeUnknownOutcomeResult(
  res,
  fallbackText = "Write outcome unknown; blocked fallback or retry to avoid duplicate side effects.",
  fallbackReason = "write_outcome_unknown"
) {
  const existingText = extractResultText(res);
  return {
    ...(res && typeof res === "object" ? res : {}),
    isError: true,
    deliveryState: "sent_unknown",
    fatal: true,
    code: "WRITE_OUTCOME_UNKNOWN",
    reason: res?.reason || fallbackReason,
    content:
      Array.isArray(res?.content) && res.content.length > 0
        ? res.content
        : [{ type: "text", text: existingText || fallbackText }],
  };
}

function sentUnknownError(message, reason = "write_outcome_unknown") {
  return {
    isError: true,
    deliveryState: "sent_unknown",
    fatal: true,
    code: "WRITE_OUTCOME_UNKNOWN",
    reason,
    content: [{ type: "text", text: message }],
  };
}

/**
 * Authorize converting Window-Local Points onto the current OCU action screenshot
 * under the Same-Window Proof invariant.
 */
function parseStrictFiniteCoord(val) {
  if (val === null || val === undefined || val === "" || typeof val === "boolean") {
    return NaN;
  }
  if (typeof val === "string" && !/^[+-]?\d+(?:\.\d+)?$/u.test(val.trim())) {
    return NaN;
  }
  const n = Number(val);
  return Number.isFinite(n) ? n : NaN;
}

export function authorizeActionScreenshotCoords(
  meta,
  {
    pid = null,
    callerExplicitWindowId = null,
    targetWindowId = null,
    windowSize = null,
    localPoint = null,
    actionPeerInstanceId = null,
    liveWindowObs = null,
  } = {}
) {
  const proof = evaluateScreenshotMetaProof(meta, {
    pid,
    expectedPeerInstanceId: actionPeerInstanceId,
    callerExplicitWindowId,
    targetWindowId,
    windowSize,
    liveWindowObs,
    requireSingleWindow: false,
    requirePositiveWid: true,
  });
  const lx = parseStrictFiniteCoord(localPoint?.x);
  const ly = parseStrictFiniteCoord(localPoint?.y);
  const ww = parseStrictFiniteCoord(windowSize?.width);
  const wh = parseStrictFiniteCoord(windowSize?.height);
  const hasValidInput = Boolean(
    localPoint &&
      Number.isFinite(lx) &&
      Number.isFinite(ly) &&
      windowSize &&
      ww > 0 &&
      wh > 0
  );
  const sameWindowProven = Boolean(proof.sameWindowProven && hasValidInput);
  const rawPx = sameWindowProven
    ? windowPointToScreenshotPixel({ x: lx, y: ly }, {
        windowWidth: ww,
        windowHeight: wh,
        imageWidth: proof.width,
        imageHeight: proof.height,
      })
    : null;
  const rx = rawPx ? Math.round(rawPx.x) : null;
  const ry = rawPx ? Math.round(rawPx.y) : null;
  const authorized = Boolean(
    sameWindowProven && rawPx && rx >= 0 && ry >= 0 && rx <= proof.width && ry <= proof.height
  );

  return {
    authorized,
    sameWindowProven,
    pixelPoint: authorized ? { x: rx, y: ry } : null,
    peerInstanceId: proof.peerInstanceId,
    singleWindowProven: proof.singleWindowProven,
    windowCount: proof.windowCount,
  };
}

/**
 * Inverse seam: convert encoded screenshot pixels back into window-local logical points
 * (`pointWindowPt`) for `window_post` / `window_scroll`.
 */
export function screenshotPixelToWindowPoint(
  pixel,
  { windowWidth, windowHeight, imageWidth, imageHeight } = {}
) {
  const sx = Number(pixel?.x);
  const sy = Number(pixel?.y);
  const ww = Number(windowWidth);
  const wh = Number(windowHeight);
  const iw = Number(imageWidth);
  const ih = Number(imageHeight);
  if (
    !Number.isFinite(sx) ||
    !Number.isFinite(sy) ||
    !(ww > 0) ||
    !(wh > 0) ||
    !(iw > 0) ||
    !(ih > 0)
  ) {
    return null;
  }
  return {
    x: (sx * ww) / iw,
    y: (sy * wh) / ih,
  };
}

function unpackPointDispatchResult(rawRes, defaultMethod, actionLabel) {
  const isObj = typeof rawRes === "object" && rawRes !== null;
  const ok = isObj ? Boolean(rawRes.delivered) : Boolean(rawRes);
  const deliveryState = isObj ? rawRes.deliveryState : undefined;
  const reason = isObj ? rawRes.reason : undefined;
  const method = (isObj && rawRes.method) || defaultMethod;
  const unknown = isObj && isWriteOutcomeUnknown(rawRes);
  const baseErr = {
    isError: true,
    ...(deliveryState ? { deliveryState } : {}),
    ...(reason ? { reason } : {}),
    content: [
      {
        type: "text",
        text:
          reason === "jxa_accessibility_untrusted"
            ? `Background point ${actionLabel} unavailable (jxa_accessibility_untrusted).`
            : reason
              ? `Background point ${actionLabel} failed (${reason}).`
              : `Background point ${actionLabel} failed.`,
      },
    ],
  };
  const result = ok
    ? {
        isError: false,
        content: [{ type: "text", text: actionLabel === "drag" ? "Drag delivered via app_post" : "ok" }],
      }
    : unknown
      ? normalizeUnknownOutcomeResult(baseErr)
      : baseErr;
  return { method, result };
}

/**
 * Compute center point of `targetBox`, clipped inside `clipBox` (e.g., visible list viewport)
 * when provided and intersecting; falls back to `targetBox` center if no overlap.
 */
export function clipBoxIntersectionCenter(targetBox, clipBox = null, { requireOverlap = false } = {}) {
  if (!targetBox || !(Number(targetBox.w) > 0) || !(Number(targetBox.h) > 0)) return null;
  const tx1 = Number(targetBox.x);
  const ty1 = Number(targetBox.y);
  const tx2 = tx1 + Number(targetBox.w);
  const ty2 = ty1 + Number(targetBox.h);
  if (clipBox && Number(clipBox.w) > 0 && Number(clipBox.h) > 0) {
    const cx1 = Number(clipBox.x);
    const cy1 = Number(clipBox.y);
    const cx2 = cx1 + Number(clipBox.w);
    const cy2 = cy1 + Number(clipBox.h);
    const ix1 = Math.max(tx1, cx1);
    const iy1 = Math.max(ty1, cy1);
    const ix2 = Math.min(tx2, cx2);
    const iy2 = Math.min(ty2, cy2);
    if (ix2 > ix1 && iy2 > iy1) {
      return { x: (ix1 + ix2) / 2, y: (iy1 + iy2) / 2 };
    }
    if (requireOverlap) {
      return null;
    }
  }
  return { x: (tx1 + tx2) / 2, y: (ty1 + ty2) / 2 };
}

function buildActNativeClickArgs({
  app,
  clickMethod,
  match,
  resolvedTarget = null,
  meta = null,
  auth = null,
  callerExplicitWindowId = null,
  queryPeerInstanceId = null,
  jxaTrusted = true,
  mouseButton = "left",
  clickCount = 1,
}) {
  const isPinned = Number(callerExplicitWindowId) > 0;
  const sameWindowProven = Boolean(auth?.sameWindowProven);
  const canMapPx = Boolean(auth?.authorized && auth?.pixelPoint);
  const rx = auth?.pixelPoint?.x ?? null;
  const ry = auth?.pixelPoint?.y ?? null;

  // OCU app_post sends PID-only events without window routing; refuse without proven single-window target match.
  if (clickMethod === "app_post") {
    if (!sameWindowProven || !isSingleWindowProven(auth)) {
      return null;
    }
  }

  const matchWid = Number(match?.window_id || 0);
  const elemMeta = match?.index !== undefined ? meta?.elements?.get(String(match.index)) : null;
  const hasPinnedMatchWid =
    matchWid === Number(callerExplicitWindowId) ||
    Number(elemMeta?.windowId || 0) === Number(callerExplicitWindowId);
  const hasSnapshotProvenance = Boolean(elemMeta && elemMeta.origin);
  const canUseIdx =
    match?.index !== undefined && (!isPinned || (hasPinnedMatchWid && hasSnapshotProvenance));

  const bundle = String(meta?.bundleId || app || "").trim();
  const preferPx =
    canMapPx &&
    (resolvedTarget?.reason === "ax_card" ||
      resolvedTarget?.axOriginMismatch === true ||
      (!jxaTrusted && hasAxOriginOffsetQuirk(bundle, match)));

  if ((preferPx || !canUseIdx) && canMapPx) {
    return {
      clickArgs: {
        app,
        click_method: clickMethod,
        x: rx,
        y: ry,
        mouse_button: mouseButton,
        click_count: clickCount,
      },
      expectedAgentInstanceId: auth?.peerInstanceId || null,
    };
  }
  if (canUseIdx) {
    return {
      clickArgs: {
        app,
        click_method: clickMethod,
        element_index: String(match.index),
        mouse_button: mouseButton,
        click_count: clickCount,
      },
      expectedAgentInstanceId: queryPeerInstanceId || null,
    };
  }
  return null;
}

/**
 * Deduplicate nested parent/child `query` matches on the same UI control/card
 * while keeping independently actionable overlapping controls distinct (preventing
 * false AMBIGUOUS_TARGET without silently swallowing separate interactive buttons).
 */
export function dedupeSpatiallyOverlappingMatches(matches = []) {
  if (!Array.isArray(matches) || matches.length <= 1) return Array.isArray(matches) ? matches : [];
  const normBox = (m) => {
    const b = normalizeElementBounds(m?.bounds || m?.frame);
    return b ? { ...b, area: b.w * b.h } : null;
  };
  const overlapRatio = (a, b) => {
    const ix1 = Math.max(a.x, b.x);
    const iy1 = Math.max(a.y, b.y);
    const ix2 = Math.min(a.x + a.w, b.x + b.w);
    const iy2 = Math.min(a.y + a.h, b.y + b.h);
    if (ix2 <= ix1 || iy2 <= iy1) return 0;
    const inter = (ix2 - ix1) * (iy2 - iy1);
    const minArea = Math.min(a.area, b.area);
    return minArea > 0 ? inter / minArea : 0;
  };
  const clickableBonus = (m) => {
    const r = String(m?.role || "").toLowerCase();
    return /button|cell|menuitem|tab|checkbox|radio|link/.test(r) ? 1 : 0;
  };
  const primaryLabel = (m) =>
    String(m?.title || m?.label || m?.text || m?.description || m?.value || m?.identifier || "")
      .trim()
      .toLowerCase();
  const representsSameControl = (a, b) => {
    // Only collapse two clickable controls when they share an identifier or identical label (or one lacks own identity)
    if (a.clickRank > 0 && b.clickRank > 0) {
      const idA = String(a.match?.identifier || "").trim();
      const idB = String(b.match?.identifier || "").trim();
      if (idA && idB) return idA === idB;
      const lblA = primaryLabel(a.match);
      const lblB = primaryLabel(b.match);
      if (lblA && lblB) return lblA === lblB;
    }
    return true;
  };

  // Strict weak ordering: smaller area first, then clickable rank, then original order
  const decorated = matches.map((m, origIdx) => ({
    match: m,
    origIdx,
    winId: Number(m?.window_id) > 0 ? Number(m.window_id) : 0,
    box: normBox(m),
    clickRank: clickableBonus(m),
  }));
  decorated.sort((a, b) => {
    if (a.box && !b.box) return -1;
    if (!a.box && b.box) return 1;
    if (a.box && b.box && a.box.area !== b.box.area) return a.box.area - b.box.area;
    if (a.clickRank !== b.clickRank) return b.clickRank - a.clickRank;
    return a.origIdx - b.origIdx;
  });

  const kept = [];
  for (const item of decorated) {
    if (!item.box) {
      kept.push(item);
      continue;
    }
    const existingIdx = kept.findIndex(
      (k) =>
        k.box &&
        !(item.winId > 0 && k.winId > 0 && item.winId !== k.winId) &&
        overlapRatio(item.box, k.box) >= 0.7 &&
        representsSameControl(item, k)
    );
    if (existingIdx < 0) {
      kept.push(item);
    } else if (item.clickRank > kept[existingIdx].clickRank) {
      // Promote wrapping clickable container (e.g. AXButton card) over plain text descendant
      kept[existingIdx] = item;
    }
  }
  return kept.map((k) => k.match);
}

/**
 * Deep Module: BackgroundActionExecutor
 *
 * Encapsulates Delivery Route selection and dispatch (Window-Local Delivery Floor,
 * SkyLight / CGEvent cascade, Tiny Window Override coordinate remapping,
 * AXShowMenu / AXScrollBar / AXSelectedText direct routes, and set_value sky_bypass
 * with editable-focus safety gate) plus closed-loop post-action readback verification.
 */
export class BackgroundActionExecutor {
  constructor({
    actionPeer,
    axBridge = null,
    desktopHelperClient = null,
    focusPolicyGuard,
    registry,
    unhideAppFn = unhideAppWithoutActivating,
    refreshActionStateFn = null,
    pointClickFn = dispatchBackgroundPointClickDetailed,
    pointDragFn = dispatchBackgroundPointDragDetailed,
    editableFocusFn = verifyEditableTextFocus,
    selectedTextInsertFn = tryHeadlessSelectedTextInsert,
    axScrollFallbackFn = tryHeadlessBackgroundScroll,
    contextMenuFallbackFn = tryHeadlessContextMenu,
    windowClickFn = tryWindowPostClick,
    windowKeyFn = tryWindowKey,
    windowTextFn = tryWindowText,
    windowScrollFn = tryWindowScroll,
    takeoverController = null,
    postActionDelayMs = 55,
    windowTransitionRetryDelayMs = 220,
  } = {}) {
    this.actionPeer = actionPeer;
    this.axBridge = axBridge;
    this.desktopHelperClient = desktopHelperClient;
    this.focusPolicyGuard = focusPolicyGuard;
    this.registry = registry;
    this.unhideAppFn = unhideAppFn;
    this.refreshActionStateFn = refreshActionStateFn;
    this.pointClickFn = pointClickFn;
    this.pointDragFn = pointDragFn;
    this.editableFocusFn = editableFocusFn;
    this.selectedTextInsertFn = selectedTextInsertFn;
    this.axScrollFallbackFn = axScrollFallbackFn;
    this.contextMenuFallbackFn = contextMenuFallbackFn;
    this.windowClickFn = windowClickFn;
    this.windowKeyFn = windowKeyFn;
    this.windowTextFn = windowTextFn;
    this.windowScrollFn = windowScrollFn;
    this.takeoverController = takeoverController;
    this.postActionDelayMs = postActionDelayMs;
    this.windowTransitionRetryDelayMs = windowTransitionRetryDelayMs;
  }

  #beforeWrite(operation, isRead = false) {
    this.takeoverController?.assertMayDispatch(operation, { isRead });
  }

  #resolveRouteScope(meta, opts = {}) {
    if (typeof this.registry?.buildRouteScope === "function") {
      return this.registry.buildRouteScope(meta, opts);
    }
    return buildRouteScopeFromMeta(meta, opts);
  }

  #trackWrite(operation, promise, routeKey = null) {
    if (!this.takeoverController) return promise;
    return this.takeoverController.trackNativeWrite(operation, promise, { routeKey });
  }

  #rethrowIfAborted(err) {
    if (err?.aborted) throw err;
    if (err?.deliveryState === "sent_unknown" || err?.code === "WRITE_OUTCOME_UNKNOWN") {
      throw new TakeoverAbortedError(
        err?.message || "窗口操作写入结果未知，已阻断后续回退点击以防重复触发。",
        {
          code: "WRITE_OUTCOME_UNKNOWN",
          deliveryState: "sent_unknown",
        }
      );
    }
  }

  #buildReservedHotkeyErrorIfBlocked(toolName, key, operation) {
    if (
      toolName === "press_key" &&
      operation?.isAi &&
      this.takeoverController?.isReservedHotkey(key)
    ) {
      return {
        isError: true,
        fatal: true,
        content: [
          {
            type: "text",
            text: `[RESERVED_HOTKEY] 禁止 AI 发送人类急停热键 "${key}"。`,
          },
        ],
      };
    }
    return null;
  }

  #formatWindowClickOutcome(winRes, { fallbackText, mapReasonText = false } = {}) {
    if (winRes?.delivered) {
      return { isError: false, content: [{ type: "text", text: "ok" }] };
    }
    const text =
      mapReasonText && winRes?.reason === "out_of_bounds"
        ? "Click coordinates are outside the current window screenshot bounds."
        : mapReasonText && winRes?.reason === "window_resized"
          ? "Target window size changed since screenshot; run get_app_state before retrying."
          : fallbackText;
    if (isWriteOutcomeUnknown(winRes)) {
      return normalizeUnknownOutcomeResult(winRes, text);
    }
    return {
      isError: true,
      ...(winRes?.deliveryState ? { deliveryState: winRes.deliveryState } : {}),
      ...(winRes?.reason ? { reason: winRes.reason } : {}),
      ...(mapReasonText
        ? {
            fatal:
              winRes?.reason === "out_of_bounds" ||
              winRes?.reason === "window_resized" ||
              winRes?.reason === "element_window_mismatch",
          }
        : {}),
      content: [{ type: "text", text }],
    };
  }

  #buildJxaUntrustedError(text, { fatal = false } = {}) {
    return {
      isError: true,
      deliveryState: "not_sent",
      reason: "jxa_accessibility_untrusted",
      ...(fatal ? { fatal: true } : {}),
      content: [{ type: "text", text }],
    };
  }

  #authorizeCoordDispatch(
    preMeta,
    {
      liveWindowObs = null,
      targetWindowId = null,
      windowSize = null,
      requireSingleWindow = false,
      points = [],
      actionLabel = "click",
    } = {}
  ) {
    const proof = evaluateScreenshotMetaProof(preMeta, {
      expectedPeerInstanceId: this.actionPeer?.agentInstanceId || null,
      targetWindowId,
      windowSize,
      liveWindowObs,
      requireSingleWindow,
      requirePositiveWid: true,
    });
    if (!proof.sameWindowProven) {
      return {
        ok: false,
        reason: "unproven_same_window",
        message: `Coordinate ${actionLabel} blocked (unproven_same_window): Same-Window Proof is missing or stale for the current screenshot; run get_app_state or target a window-verified element before acting.`,
      };
    }
    if (requireSingleWindow && !proof.singleWindowProven) {
      return {
        ok: false,
        reason: "unproven_single_window",
        message: `Coordinate ${actionLabel} blocked (unproven_single_window): PID-level fallback requires a proven single-window screenshot match.`,
      };
    }
    for (const pt of Array.isArray(points) ? points : []) {
      const px = Array.isArray(pt) ? pt[0] : pt?.x;
      const py = Array.isArray(pt) ? pt[1] : pt?.y;
      if (
        !Number.isFinite(px) ||
        !Number.isFinite(py) ||
        px < 0 ||
        py < 0 ||
        px > proof.width ||
        py > proof.height
      ) {
        return {
          ok: false,
          reason: "out_of_bounds",
          message: `Coordinate ${actionLabel} out of bounds: (${px}, ${py}) lies outside current window screenshot bounds (${proof.width}x${proof.height}).`,
        };
      }
    }
    return { ok: true, proof };
  }

  async #callActionPeerWithRecovery(
    toolName,
    callArgs,
    app,
    {
      shouldFollow = true,
      allowAutoRefresh = true,
      operation = null,
      timeoutMs = undefined,
      expectedAgentInstanceId = null,
      preMeta = null,
      preElement = null,
    } = {}
  ) {
    const routeTag =
      toolName === "click" || toolName === "drag"
        ? `${toolName}:${callArgs?.click_method || "native"}`
        : toolName === "press_key" || toolName === "type_text"
          ? `${toolName}:${callArgs?.key_method || "native"}`
          : toolName;
    const beforeWriteCheck = () => this.#beforeWrite(operation, false);
    const invokePeer = async () => {
      try {
        return await this.#trackWrite(
          operation,
          this.actionPeer.callTool(toolName, callArgs, timeoutMs, {
            beforeWriteCheck,
            expectedAgentInstanceId,
          }),
          routeTag
        );
      } catch (err) {
        if (err?.code === "STALE_PEER_GENERATION") {
          return {
            isError: true,
            deliveryState: "not_sent",
            fatal: true,
            reason: "stale_peer_generation",
            content: [{ type: "text", text: err.message }],
          };
        }
        throw err;
      }
    };

    beforeWriteCheck();
    let lastRes = await invokePeer();
    if (isWriteOutcomeUnknown(lastRes)) return normalizeUnknownOutcomeResult(lastRes);
    if (!lastRes?.isError || lastRes?.reason === "stale_peer_generation") return lastRes;

    const hasFiniteCoord = (v) => Number.isFinite(parseStrictFiniteCoord(v));
    const isCoordPeerOp =
      (toolName === "click" || toolName === "drag" || toolName === "scroll") &&
      (hasFiniteCoord(callArgs?.x) ||
        hasFiniteCoord(callArgs?.y) ||
        hasFiniteCoord(callArgs?.from_x) ||
        hasFiniteCoord(callArgs?.from_y) ||
        hasFiniteCoord(callArgs?.to_x) ||
        hasFiniteCoord(callArgs?.to_y));

    const errText = extractResultText(lastRes);
    if (!isCoordPeerOp && /target app is hidden/iu.test(errText)) {
      beforeWriteCheck();
      const meta = this.registry.getMeta(app);
      await this.#trackWrite(operation, this.unhideAppFn(meta?.pid, app), `${toolName}:unhide`);
      beforeWriteCheck();
      lastRes = await invokePeer();
      if (isWriteOutcomeUnknown(lastRes)) return normalizeUnknownOutcomeResult(lastRes);
      if (!lastRes?.isError || lastRes?.reason === "stale_peer_generation") return lastRes;
    }

    if (
      !isCoordPeerOp &&
      allowAutoRefresh &&
      typeof this.refreshActionStateFn === "function" &&
      STALE_SNAPSHOT_RE.test(extractResultText(lastRes))
    ) {
      const elemIdxRaw =
        callArgs?.element_index !== undefined && callArgs?.element_index !== null
          ? String(callArgs.element_index).trim()
          : "";
      if (elemIdxRaw && elemIdxRaw !== "0" && Number(elemIdxRaw) >= 1_000_000) {
        const latestNow = this.registry.getLatestSnapshot(preMeta?.bundleId || app);
        return {
          ...buildStaleRefToolResult({
            errorCode: "STALE_REF",
            message: `Query element alias #${elemIdxRaw} is no longer valid in native AX table; re-run query or get_app_state before retrying.`,
            currentSnapshotId: latestNow?.id || null,
          }),
          fatal: true,
          deliveryState: "not_sent",
        };
      }
      this.#beforeWrite(operation, true);
      const refreshRes = await this.refreshActionStateFn(app, { shouldFollow, operation });
      if (refreshRes?.isError) return lastRes;
      const refreshedMeta = this.registry.getMeta(app);
      const windowOrProcDrifted = Boolean(
        preMeta &&
          refreshedMeta &&
          ((preMeta.pid > 0 && refreshedMeta.pid > 0 && preMeta.pid !== refreshedMeta.pid) ||
            (preMeta.processToken &&
              refreshedMeta.processToken &&
              preMeta.processToken !== refreshedMeta.processToken) ||
            (preMeta.windowId > 0 &&
              refreshedMeta.windowId > 0 &&
              preMeta.windowId !== refreshedMeta.windowId) ||
            (preMeta.windowTitle &&
              refreshedMeta.windowTitle &&
              preMeta.windowTitle !== refreshedMeta.windowTitle))
      );
      if (windowOrProcDrifted) {
        return {
          ...buildStaleRefToolResult({
            errorCode: "STALE_REF",
            message:
              "Target window or process changed during state refresh; blocked automatic action replay.",
            currentSnapshotId: refreshedMeta?.snapshotId || null,
          }),
          fatal: true,
          deliveryState: "not_sent",
        };
      }
      if (elemIdxRaw && elemIdxRaw !== "0" && (preElement || preMeta?.actionHasAx)) {
        const refreshedEl = refreshedMeta?.elements?.get(elemIdxRaw) || null;
        if (
          !preElement?.fingerprint ||
          !refreshedEl?.fingerprint ||
          refreshedEl.fingerprint !== preElement.fingerprint
        ) {
          return {
            ...buildStaleRefToolResult({
              errorCode: "STALE_REF",
              message: `Element #${elemIdxRaw} changed or disappeared after state refresh; blocked automatic action replay.`,
              currentSnapshotId: refreshedMeta?.snapshotId || null,
            }),
            fatal: true,
            deliveryState: "not_sent",
          };
        }
      }
      beforeWriteCheck();
      lastRes = await invokePeer();
      if (isWriteOutcomeUnknown(lastRes)) return normalizeUnknownOutcomeResult(lastRes);
    }

    return lastRes;
  }

  async #dispatchClickMethod(method, ctx) {
    const {
      app,
      cleanArgs,
      parsedRef,
      preMeta,
      preSnapshot,
      preElement,
      shouldFollow,
      allowAutoRefresh,
      fallbackDims = { width: 0, height: 0 },
      operation = null,
    } = ctx;

    if (method === "window_post") {
      const jxaTrusted = await ctx.getJxaTrusted();
      if (!jxaTrusted) {
        return this.#buildJxaUntrustedError(
          "Window-local click unavailable (jxa_accessibility_untrusted): grant Accessibility to osascript or use Open Computer Use routes.",
          { fatal: cleanArgs.click_method === "window_post" }
        );
      }
      if (!(preMeta?.pid > 0) || typeof this.windowClickFn !== "function") {
        return {
          isError: true,
          deliveryState: "not_sent",
          content: [{ type: "text", text: "Window-local click bridge unavailable." }],
        };
      }
      const isCoordClick =
        !parsedRef?.hasElementRef &&
        Number.isFinite(cleanArgs.x) &&
        Number.isFinite(cleanArgs.y);
      const hasPreMetaScreenshot =
        preMeta?.actionHasScreenshot !== false &&
        Number(preMeta?.actionFrameWidth) > 0 &&
        Number(preMeta?.actionFrameHeight) > 0;
      const frameWidth = hasPreMetaScreenshot ? preMeta.actionFrameWidth : 0;
      const frameHeight = hasPreMetaScreenshot ? preMeta.actionFrameHeight : 0;
      if (isCoordClick && !(frameWidth > 0 && frameHeight > 0)) {
        const isFatalNoGeometry =
          cleanArgs.click_method === "window_post" ||
          Boolean(preMeta?.windowId > 0) ||
          Boolean(fallbackDims?.width > 0 && fallbackDims?.height > 0);
        return {
          isError: true,
          deliveryState: "not_sent",
          fatal: isFatalNoGeometry,
          content: [
            {
              type: "text",
              text: "Current window has no matching screenshot geometry; run get_app_state before coordinate click.",
            },
          ],
        };
      }
      const beforeWriteCheck = () => this.#beforeWrite(operation, false);
      beforeWriteCheck();
      const rawOv = preMeta?.tinyWindowOverride || null;
      const matchingOverride =
        rawOv &&
        (!preMeta?.windowId ||
          !rawOv.wid ||
          rawOv.wid === preMeta.windowId ||
          preMeta?.actionScreenshotMeta?.source === "tiny_window_override")
          ? rawOv
          : null;
      const wid = matchingOverride?.wid || preSnapshot?.windowId || preMeta?.windowId || null;
      const windowBounds =
        matchingOverride?.bounds ||
        preMeta?.actionScreenshotMeta?.windowBounds ||
        preMeta?.windowBounds ||
        null;
      const captureBounds = preMeta?.actionScreenshotMeta?.windowBounds || windowBounds;
      const expW = Number(captureBounds?.width ?? captureBounds?.w ?? 0);
      const expH = Number(captureBounds?.height ?? captureBounds?.h ?? 0);
      const expectedWindowSize = expW > 0 && expH > 0 ? { width: expW, height: expH } : null;
      const winRes = await this.#trackWrite(
        operation,
        this.windowClickFn(preMeta.pid, {
          axBridge: this.axBridge,
          snapshotId: preSnapshot?.id || null,
          elementIndex: parsedRef?.hasElementRef ? parsedRef.rawIndex : null,
          elementMeta: preElement || null,
          x: cleanArgs.x ?? null,
          y: cleanArgs.y ?? null,
          frameWidth,
          frameHeight,
          expectedWindowSize,
          windowTitle: preMeta?.windowTitle || "",
          wid,
          windowBounds,
          button: cleanArgs.mouse_button || "left",
          clickCount: cleanArgs.click_count ?? 1,
          syntheticTag: this.takeoverController?.syntheticEventTag || 0,
          beforeWriteCheck,
        }),
        "click:window_post"
      ).catch((err) => {
        this.#rethrowIfAborted(err);
        return { delivered: false, reason: err?.message || "window_click_error" };
      });
      return this.#formatWindowClickOutcome(winRes, {
        fallbackText: isWriteOutcomeUnknown(winRes)
          ? `Window-local click outcome unknown (${winRes?.reason || "sent_unknown"}).`
          : `Window-local click unavailable (${winRes?.reason || "unavailable"}).`,
        mapReasonText: true,
      });
    }

    const isCoordPeerClick =
      !parsedRef?.hasElementRef && Number.isFinite(cleanArgs.x) && Number.isFinite(cleanArgs.y);
    if (isCoordPeerClick && method === "app_post") {
      const clickProof = evaluateScreenshotMetaProof(preMeta, {
        expectedPeerInstanceId: this.actionPeer?.agentInstanceId || null,
        targetWindowId: preMeta?.windowId || ctx.windowDelivery?.windowId || null,
        liveWindowObs: ctx.liveWindowObs || null,
        requireSingleWindow: true,
        requirePositiveWid: false,
      });
      if (ctx.windowDelivery?.route === "ocu_pixel" || !clickProof.proven) {
        return {
          isError: true,
          deliveryState: "not_sent",
          fatal: true,
          reason:
            clickProof.sameWindowProven && !clickProof.singleWindowProven
              ? "unproven_single_window"
              : clickProof.singleWindowProven
                ? "unproven_same_window"
                : "unproven_single_window",
          content: [
            {
              type: "text",
              text: "Coordinate click blocked (unproven_single_window): PID-only app_post requires proven single-window screenshot match.",
            },
          ],
        };
      }
    }
    return this.#callActionPeerWithRecovery(
      "click",
      { ...cleanArgs, click_method: method },
      app,
      {
        shouldFollow,
        allowAutoRefresh,
        operation,
        preMeta,
        preElement,
        expectedAgentInstanceId: isCoordPeerClick
          ? preMeta?.actionScreenshotMeta?.peerInstanceId || null
          : null,
      }
    );
  }

  async #dispatchKeyMethod(toolName, method, ctx) {
    const {
      app,
      cleanArgs,
      preMeta,
      preSnapshot,
      shouldFollow,
      allowAutoRefresh,
      operation = null,
    } = ctx;
    const hotkeyBlock = this.#buildReservedHotkeyErrorIfBlocked(toolName, cleanArgs.key, operation);
    if (hotkeyBlock) {
      return hotkeyBlock;
    }
    if (method === "window_key") {
      const jxaTrusted = await ctx.getJxaTrusted();
      if (!jxaTrusted) {
        return this.#buildJxaUntrustedError(
          "Window key delivery unavailable (jxa_accessibility_untrusted): grant Accessibility to osascript or use sky_key.",
          { fatal: cleanArgs.key_method === "window_key" }
        );
      }
      const beforeWriteCheck = () => this.#beforeWrite(operation, false);
      beforeWriteCheck();
      const targetWid =
        preMeta?.tinyWindowOverride?.wid || preSnapshot?.windowId || preMeta?.windowId || null;
      if (toolName === "press_key" && preMeta?.pid > 0 && typeof this.windowKeyFn === "function") {
        const keyRes = await this.#trackWrite(
          operation,
          this.windowKeyFn(preMeta.pid, cleanArgs.key, {
            axBridge: this.axBridge,
            windowTitle: preMeta?.windowTitle || "",
            wid: targetWid,
            syntheticTag: this.takeoverController?.syntheticEventTag || 0,
            beforeWriteCheck,
          }),
          "press_key:window_key"
        ).catch((err) => {
          this.#rethrowIfAborted(err);
          return { delivered: false, reason: err?.message || "window_key_error" };
        });
        if (keyRes?.delivered) {
          return { isError: false, content: [{ type: "text", text: "ok" }] };
        }
        const keyReason = keyRes?.reason || "unavailable";
        if (isWriteOutcomeUnknown(keyRes)) {
          return normalizeUnknownOutcomeResult(keyRes, `Window key delivery failed (${keyReason}).`);
        }
        return {
          isError: true,
          deliveryState: keyRes?.deliveryState,
          reason: keyReason,
          fatal: keyReason !== "bridge_unavailable",
          content: [
            {
              type: "text",
              text: `Window key delivery failed (${keyReason}).`,
            },
          ],
        };
      }
      if (toolName === "type_text" && preMeta?.pid > 0 && typeof this.windowTextFn === "function") {
        const txtRes = await this.#trackWrite(
          operation,
          this.windowTextFn(preMeta.pid, String(cleanArgs.text ?? ""), {
            axBridge: this.axBridge,
            windowTitle: preMeta?.windowTitle || "",
            wid: targetWid,
            syntheticTag: this.takeoverController?.syntheticEventTag || 0,
            beforeWriteCheck,
          }),
          "type_text:window_key"
        ).catch((err) => {
          this.#rethrowIfAborted(err);
          return { delivered: false, reason: err?.message || "window_text_error" };
        });
        if (txtRes?.delivered) {
          return { isError: false, content: [{ type: "text", text: "ok" }] };
        }
        const txtReason = txtRes?.reason || "unavailable";
        if (isWriteOutcomeUnknown(txtRes)) {
          return normalizeUnknownOutcomeResult(txtRes, `Window text delivery failed (${txtReason}).`);
        }
        return {
          isError: true,
          deliveryState: txtRes?.deliveryState,
          reason: txtReason,
          fatal: txtReason !== "bridge_unavailable" && txtReason !== "unicode_fn_unavailable",
          content: [
            {
              type: "text",
              text: `Window text delivery failed (${txtReason}).`,
            },
          ],
        };
      }
      return {
        isError: true,
        deliveryState: "not_sent",
        reason: "bridge_unavailable",
        content: [{ type: "text", text: "Window key bridge unavailable." }],
      };
    }

    return this.#callActionPeerWithRecovery(
      toolName,
      { ...cleanArgs, key_method: method },
      app,
      { shouldFollow, allowAutoRefresh, operation, preMeta }
    );
  }

  async #executeBackgroundSetValueBypass(ctx) {
    const {
      app,
      cleanArgs,
      aliases,
      preAppKey,
      preMeta,
      preSnapshot,
      preElement,
      routeScope = null,
    } = ctx;
    const jxaTrusted = await ctx.getJxaTrusted();
    if (
      !jxaTrusted &&
      this.editableFocusFn === verifyEditableTextFocus &&
      this.axBridge &&
      this.axBridge.enabled !== false &&
      typeof this.axBridge.verifyEditableFocus === "function"
    ) {
      return { ok: false };
    }
    const effectiveWid =
      routeScope?.windowId ||
      preMeta?.tinyWindowOverride?.wid ||
      preSnapshot?.windowId ||
      preMeta?.windowId ||
      null;
    const clickMethods = this.focusPolicyGuard.planClick(
      { app, element_index: cleanArgs.element_index },
      aliases,
      { routeScope, windowPostAvailable: jxaTrusted }
    );
    const bypassClickCtx = {
      ...ctx,
      cleanArgs: { app, element_index: cleanArgs.element_index },
      parsedRef: {
        ok: true,
        hasElementRef: true,
        snapshotId: preSnapshot?.id || null,
        rawIndex: String(cleanArgs.element_index),
      },
    };

    let focusedOk = false;
    let focusedClickMethod = null;
    let lastClickRes = null;
    for (const method of clickMethods) {
      lastClickRes = await this.#dispatchClickMethod(method, bypassClickCtx);
      if (!lastClickRes?.isError) {
        focusedOk = true;
        focusedClickMethod = method;
        break;
      }
      if (isWriteOutcomeUnknown(lastClickRes)) {
        return {
          ok: false,
          outcomeUnknown: true,
          result: normalizeUnknownOutcomeResult(lastClickRes),
        };
      }
      if (lastClickRes?.fatal) break;
    }
    if (!focusedOk) {
      return { ok: false };
    }
    if (ctx.focusScope && focusedClickMethod) {
      await ctx.focusScope.enforce(formatDeliveryRoute("click", focusedClickMethod), { routeScope });
    }

    const focusCheck =
      typeof this.editableFocusFn === "function"
        ? await this.editableFocusFn(preMeta?.pid, {
            axBridge: this.axBridge,
            snapshotId: preSnapshot?.id || null,
            elementIndex: cleanArgs.element_index,
            fallbackElementMeta: preElement,
            windowTitle: preMeta?.windowTitle || "",
            wid: effectiveWid,
          }).catch(() => ({ editable: false }))
        : { editable: false };
    if (!focusCheck?.editable) {
      return { ok: false };
    }

    const pressKeyMethods = this.focusPolicyGuard.planKey("press_key", { app }, aliases, {
      routeScope,
      windowKeyAvailable: jxaTrusted,
    });
    const runBypassPressKey = async (key) => {
      for (const method of pressKeyMethods) {
        const res = await this.#dispatchKeyMethod("press_key", method, {
          ...ctx,
          cleanArgs: { app, key },
          allowAutoRefresh: false,
        });
        if (!res?.isError && ctx.focusScope) {
          await ctx.focusScope.enforce(formatDeliveryRoute("press_key", method), { routeScope });
        }
        if (isWriteOutcomeUnknown(res)) return normalizeUnknownOutcomeResult(res);
        if (!res?.isError || res?.fatal) return res;
      }
      return { isError: true };
    };

    const selAllRes = await runBypassPressKey("cmd+a");
    if (isWriteOutcomeUnknown(selAllRes)) {
      return {
        ok: false,
        outcomeUnknown: true,
        result: normalizeUnknownOutcomeResult(selAllRes),
      };
    }
    if (selAllRes?.isError) {
      if (selAllRes.deliveryState === "not_sent") {
        return {
          ok: false,
          outcomeUnknown: false,
          result: selAllRes,
        };
      }
      return { ok: false };
    }

    const clearRes = await runBypassPressKey("BackSpace");
    if (clearRes?.isError) {
      if (clearRes.deliveryState === "not_sent") {
        return {
          ok: false,
          outcomeUnknown: false,
          result: clearRes.content?.length
            ? clearRes
            : {
                ...clearRes,
                content: [{ type: "text", text: "Clearing field was not sent." }],
              },
        };
      }
      return {
        ok: false,
        outcomeUnknown: true,
        result: normalizeUnknownOutcomeResult(
          clearRes,
          "Clearing field failed with unknown outcome."
        ),
      };
    }

    const targetValue = String(cleanArgs.value ?? "");
    if (!targetValue.length) {
      return {
        ok: true,
        verified: false,
        result: {
          isError: false,
          content: [{ type: "text", text: "Value cleared via background sky_bypass." }],
        },
      };
    }

    if (
      preMeta?.pid > 0 &&
      !this.focusPolicyGuard.isMethodBlocked(aliases, "type_text", "ax_selected_text", {
        routeScope,
      }) &&
      typeof this.selectedTextInsertFn === "function" &&
      shouldAttemptSelectedTextFastPath(preAppKey, targetValue)
    ) {
      const axIns = await this.#trackWrite(
        ctx.operation,
        this.selectedTextInsertFn(preMeta.pid, targetValue, {
          axBridge: this.axBridge,
          wid: effectiveWid,
          beforeWriteCheck: () => this.#beforeWrite(ctx.operation, false),
        }),
        "set_value:ax_selected_text"
      ).catch((err) => {
        this.#rethrowIfAborted(err);
        return null;
      });
      if (axIns?.delivered) {
        return {
          ok: true,
          verified: Boolean(axIns.verified),
          result: {
            isError: false,
            content: [
              { type: "text", text: "Value set via background sky_bypass (AXSelectedText)." },
            ],
          },
        };
      }
      if (axIns?.deliveryState === "sent_unknown") {
        return {
          ok: false,
          outcomeUnknown: true,
          result: sentUnknownError(
            `Background set_value bypass failed (${axIns?.reason || "sent_unknown"}).`,
            axIns?.reason || "write_outcome_unknown"
          ),
        };
      }
    }

    const safeKeyText = focusCheck.singleLine
      ? targetValue.replace(/[\r\n\t]+/gu, " ")
      : targetValue.replace(/\t/gu, " ");
    const typeKeyMethods = this.focusPolicyGuard.planKey("type_text", { app }, aliases, {
      routeScope,
      windowKeyAvailable: jxaTrusted,
    });
    let typeRes = null;
    for (const method of typeKeyMethods) {
      typeRes = await this.#dispatchKeyMethod("type_text", method, {
        ...ctx,
        cleanArgs: { app, text: safeKeyText },
        allowAutoRefresh: false,
      });
      if (!typeRes?.isError && ctx.focusScope) {
        await ctx.focusScope.enforce(formatDeliveryRoute("type_text", method), { routeScope });
      }
      if (isWriteOutcomeUnknown(typeRes)) {
        typeRes = normalizeUnknownOutcomeResult(typeRes);
        break;
      }
      if (!typeRes?.isError || typeRes?.fatal) break;
    }
    if (!typeRes || typeRes.isError) {
      return {
        ok: false,
        outcomeUnknown: true,
        result: normalizeUnknownOutcomeResult(
          typeRes,
          "Text bypass incomplete after clearing field.",
          typeRes?.reason || "set_value_bypass_incomplete"
        ),
      };
    }
    return {
      ok: true,
      verified: false,
      result: typeRes,
    };
  }

  #buildNotSentError(reason, text, { fatal = true } = {}) {
    return {
      isError: true,
      deliveryState: "not_sent",
      ...(fatal ? { fatal: true } : {}),
      ...(reason ? { reason } : {}),
      content: [{ type: "text", text }],
    };
  }

  #evaluateTinyOverrideProof(preMeta, ov, liveWindowObs = null) {
    const metaOvMatched = Boolean(
      !preMeta?.windowId ||
        !ov?.wid ||
        Number(ov.wid) === Number(preMeta.windowId) ||
        preMeta?.actionScreenshotMeta?.source === "tiny_window_override"
    );
    const liveWid = Number(liveWindowObs?.wid || liveWindowObs?.windowId || 0);
    const liveWidOk = !(liveWid > 0 && ov?.wid > 0 && liveWid !== Number(ov.wid));
    const lb = normalizeElementBounds(
      liveWindowObs?.windowBounds || liveWindowObs?.boundsPt || liveWindowObs?.bounds
    );
    const boundsOk = Boolean(
      !lb ||
        !ov?.bounds ||
        (Math.abs(lb.x - Number(ov.bounds.x || 0)) <= 2 &&
          Math.abs(lb.y - Number(ov.bounds.y || 0)) <= 2 &&
          Math.abs(lb.w - Number(ov.bounds.width || 0)) <= 2 &&
          Math.abs(lb.h - Number(ov.bounds.height || 0)) <= 2)
    );
    const ovMatched = Boolean(metaOvMatched && liveWidOk && boundsOk);
    const liveIds = Array.isArray(liveWindowObs?.windowIds)
      ? liveWindowObs.windowIds.map((x) => Number(x)).filter((x) => x > 0)
      : null;
    const singleWindowOk = Boolean(
      ovMatched &&
        liveWindowObs?.focusedExcludedWindow !== true &&
        isSingleWindowProven(preMeta?.actionScreenshotMeta) &&
        (!liveIds || (liveIds.length === 1 && (!(ov?.wid > 0) || liveIds[0] === Number(ov.wid))))
    );
    return { ovMatched, boundsOk, singleWindowOk };
  }

  async dispatch({
    name,
    app,
    cleanArgs,
    parsedRef,
    validatedSnapshot = null,
    validatedElement = null,
    shouldFollow = true,
    eventSource = "ai",
    fallbackDims = { width: 0, height: 0 },
    operation = null,
    windowDelivery = null,
    liveWindowObs = null,
    routeScope = null,
    focusScope = null,
  }) {
    let result = null;
    let actionRouteKey = name;
    let directDeliveryVerified = false;
    let actionEvent = null;

    const allowAutoRefresh = !parsedRef?.snapshotId;
    const preMeta = app ? this.registry.getMeta(app) : null;
    const aliases = app ? this.registry.aliasesFor(app, preMeta) : [];
    const preAppKey = preMeta?.bundleId || app || "";
    const preSnapshot =
      validatedSnapshot ||
      (parsedRef?.snapshotId ? this.registry.ledger.getSnapshot(parsedRef.snapshotId) : null) ||
      this.registry.getLatestSnapshot(preAppKey);
    const preElement =
      validatedElement ||
      (parsedRef?.hasElementRef
        ? preSnapshot?.elements?.get(parsedRef.rawIndex) ||
          preMeta?.elements?.get(parsedRef.rawIndex) ||
          null
        : null);
    const preFrameDigest = preMeta?.lastImageDigest || null;
    const effectiveRouteScope =
      routeScope || this.#resolveRouteScope(preMeta, { snapshot: preSnapshot });
    const rawExplicitMethod =
      name === "click"
        ? cleanArgs?.click_method
        : name === "press_key" || name === "type_text"
          ? cleanArgs?.key_method
          : null;
    const normalizedExplicitMethod =
      typeof rawExplicitMethod === "string" ? rawExplicitMethod.trim().toLowerCase() : "";
    const requestedRoute =
      normalizedExplicitMethod &&
      normalizedExplicitMethod !== "auto" &&
      normalizedExplicitMethod !== "global"
        ? formatDeliveryRoute(name, normalizedExplicitMethod)
        : null;
    let jxaTrustedPromise = null;
    const getJxaTrusted = () => {
      if (!jxaTrustedPromise) {
        jxaTrustedPromise = this.#isJxaPostTrusted();
      }
      return jxaTrustedPromise;
    };
    let normalizedArgs = cleanArgs ? { ...cleanArgs } : {};
    if (name === "click" && !parsedRef?.hasElementRef && !windowDelivery?.localPoint) {
      const cx = parseStrictFiniteCoord(normalizedArgs.x);
      const cy = parseStrictFiniteCoord(normalizedArgs.y);
      if (!Number.isFinite(cx) || !Number.isFinite(cy)) {
        return {
          result: this.#buildNotSentError(
            "invalid_coordinates",
            "Click requires either element_index or finite numeric x and y coordinates."
          ),
          actionRouteKey: requestedRoute || null,
          requestedRoute,
          directDeliveryVerified: false,
          actionEvent: null,
          isStalePinnedRef: false,
          preAppKey,
          preSnapshot,
          preElement,
          preFrameDigest,
        };
      }
      normalizedArgs.x = cx;
      normalizedArgs.y = cy;
    } else if (name === "drag" && !parsedRef?.hasElementRef) {
      const fx = parseStrictFiniteCoord(
        normalizedArgs.from_x !== undefined ? normalizedArgs.from_x : normalizedArgs.x
      );
      const fy = parseStrictFiniteCoord(
        normalizedArgs.from_y !== undefined ? normalizedArgs.from_y : normalizedArgs.y
      );
      const tx = parseStrictFiniteCoord(normalizedArgs.to_x);
      const ty = parseStrictFiniteCoord(normalizedArgs.to_y);
      if (!Number.isFinite(fx) || !Number.isFinite(fy) || !Number.isFinite(tx) || !Number.isFinite(ty)) {
        return {
          result: this.#buildNotSentError(
            "invalid_coordinates",
            "Coordinate drag requires finite numeric from_x, from_y, to_x, and to_y coordinates."
          ),
          actionRouteKey: requestedRoute || null,
          requestedRoute,
          directDeliveryVerified: false,
          actionEvent: null,
          isStalePinnedRef: false,
          preAppKey,
          preSnapshot,
          preElement,
          preFrameDigest,
        };
      }
      normalizedArgs.from_x = fx;
      normalizedArgs.from_y = fy;
      normalizedArgs.to_x = tx;
      normalizedArgs.to_y = ty;
    }
    cleanArgs = normalizedArgs;

    const ctx = {
      app,
      cleanArgs,
      parsedRef,
      aliases,
      preAppKey,
      preMeta,
      preSnapshot,
      preElement,
      shouldFollow,
      allowAutoRefresh,
      fallbackDims,
      operation,
      windowDelivery,
      liveWindowObs,
      routeScope: effectiveRouteScope,
      focusScope,
      getJxaTrusted,
    };

    if (name === "click") {
      const { normX, normY } = this.registry.resolveCursorNorm(app, cleanArgs, fallbackDims);
      const targetDesc = parsedRef?.hasElementRef
        ? this.registry.describeElement(app, cleanArgs.element_index)
        : windowDelivery?.localPoint
          ? `坐标 (${Math.round(windowDelivery.localPoint.x)}, ${Math.round(windowDelivery.localPoint.y)} pt)`
          : `坐标 (${Math.round(cleanArgs.x)}, ${Math.round(cleanArgs.y)})`;
      const rawOv = preMeta?.tinyWindowOverride || null;
      const ov =
        rawOv &&
        (!preMeta?.windowId ||
          !rawOv.wid ||
          rawOv.wid === preMeta.windowId ||
          preMeta?.actionScreenshotMeta?.source === "tiny_window_override")
          ? rawOv
          : null;
      const isCoordClickDispatch =
        !parsedRef?.hasElementRef &&
        Number.isFinite(cleanArgs.x) &&
        Number.isFinite(cleanArgs.y);

      if (windowDelivery?.route === "window_post") {
        const jxaTrusted = await getJxaTrusted();
        const targetPid = Number(windowDelivery.pid || preMeta?.pid || 0);
        if (!jxaTrusted) {
          actionRouteKey = formatDeliveryRoute("click", "window_post");
          result = this.#buildJxaUntrustedError(
            "Window-local click unavailable (jxa_accessibility_untrusted): grant Accessibility to osascript or use Open Computer Use routes.",
            { fatal: true }
          );
        } else if (!(targetPid > 0) || typeof this.windowClickFn !== "function") {
          actionRouteKey = formatDeliveryRoute("click", "window_post");
          result = {
            isError: true,
            deliveryState: "not_sent",
            fatal: true,
            reason: "bridge_unavailable",
            content: [{ type: "text", text: "Window-local click bridge unavailable." }],
          };
        } else {
          const beforeWriteCheck = () => this.#beforeWrite(operation, false);
          beforeWriteCheck();
          const wb = windowDelivery.windowBoundsPt || null;
          const winRes = await this.#trackWrite(
            operation,
            this.windowClickFn(targetPid, {
              axBridge: this.axBridge,
              localPoint: windowDelivery.localPoint,
              expectedWindowSize:
                windowDelivery.expectedWindowSize ||
                (wb ? { width: wb.width ?? wb.w, height: wb.height ?? wb.h } : null),
              wid: windowDelivery.windowId || null,
              windowTitle: windowDelivery.windowTitle || preMeta?.windowTitle || "",
              windowBounds: wb
                ? {
                    x: wb.x ?? 0,
                    y: wb.y ?? 0,
                    width: wb.width ?? wb.w,
                    height: wb.height ?? wb.h,
                  }
                : null,
              button: cleanArgs.mouse_button || "left",
              clickCount: cleanArgs.click_count ?? 1,
              allowAppPostFallback: Boolean(windowDelivery.allowAppPostFallback),
              syntheticTag: this.takeoverController?.syntheticEventTag || 0,
              beforeWriteCheck,
            }),
            "click:window_post"
          ).catch((err) => {
            this.#rethrowIfAborted(err);
            return { delivered: false, reason: err?.message || "window_click_error" };
          });
          actionRouteKey = formatDeliveryRoute("click", winRes?.method || "window_post");
          result = this.#formatWindowClickOutcome(winRes, {
            fallbackText: `Window-local click rejected (${winRes?.reason || "unavailable"}).`,
          });
        }
      } else if (
        isCoordClickDispatch &&
        preMeta?.windowId > 0 &&
        preMeta?.actionHasScreenshot === false
      ) {
        actionRouteKey = requestedRoute || null;
        result = {
          isError: true,
          deliveryState: "not_sent",
          fatal: true,
          reason: "missing_screenshot_geometry",
          content: [
            {
              type: "text",
              text: "Current window has no matching screenshot geometry; run get_app_state before coordinate click.",
            },
          ],
        };
      } else if (
        isCoordClickDispatch &&
        windowDelivery?.route !== "ocu_pixel" &&
        isValidTinyOverrideGeometry(ov) &&
        preMeta?.pid > 0 &&
        typeof this.pointClickFn === "function"
      ) {
        const ovProof = this.#evaluateTinyOverrideProof(preMeta, ov, liveWindowObs);
        if (!isWithinTinyOverrideBounds(ov, cleanArgs.x, cleanArgs.y)) {
          actionRouteKey = requestedRoute || null;
          result = this.#buildNotSentError(
            "out_of_bounds",
            "Click coordinates are outside the current window screenshot bounds."
          );
        } else if (!ovProof.ovMatched) {
          actionRouteKey = requestedRoute || null;
          result = this.#buildNotSentError(
            "unproven_same_window",
            "Coordinate click blocked (unproven_same_window): tiny-window override does not match current target window."
          );
        } else {
          const beforeWriteCheck = () => this.#beforeWrite(operation, false);
          beforeWriteCheck();
          const { screenX, screenY } = mapTinyOverridePoint(ov, cleanArgs.x, cleanArgs.y);
          const allowAppPostFallback =
            cleanArgs.click_method !== "window_post" &&
            windowDelivery?.route !== "ocu_pixel" &&
            ovProof.singleWindowOk &&
            !this.focusPolicyGuard.isMethodBlocked(aliases, "click", "app_post", {
              routeScope: effectiveRouteScope,
            });
          const rawClick = await this.#trackWrite(
            operation,
            this.pointClickFn(preMeta.pid, screenX, screenY, {
              button: cleanArgs.mouse_button || "left",
              clickCount: cleanArgs.click_count ?? 1,
              axBridge: this.axBridge,
              wid: ov.wid || null,
              bounds: ov.bounds,
              allowAppPostFallback,
              syntheticTag: this.takeoverController?.syntheticEventTag || 0,
              beforeWriteCheck,
            }),
            "click:point_override"
          ).catch((err) => {
            this.#rethrowIfAborted(err);
            return { delivered: false, deliveryState: "not_sent", reason: err?.message || "point_click_error" };
          });
          const unpackedPt = unpackPointDispatchResult(
            rawClick,
            cleanArgs.click_method === "window_post" ? "window_post" : "app_post",
            "click"
          );
          actionRouteKey = formatDeliveryRoute("click", unpackedPt.method);
          result = unpackedPt.result;
        }
      } else {
        const regularCoordAuth =
          isCoordClickDispatch && (!windowDelivery?.route || windowDelivery.route === "ocu_pixel")
            ? this.#authorizeCoordDispatch(preMeta, {
                liveWindowObs,
                targetWindowId: windowDelivery?.windowId || null,
                windowSize: windowDelivery?.windowBoundsPt
                  ? {
                      width: windowDelivery.windowBoundsPt.width ?? windowDelivery.windowBoundsPt.w,
                      height: windowDelivery.windowBoundsPt.height ?? windowDelivery.windowBoundsPt.h,
                    }
                  : null,
                points: [[cleanArgs.x, cleanArgs.y]],
                actionLabel: "click",
              })
            : { ok: true };
        let lastRes = null;
        if (!regularCoordAuth.ok) {
          actionRouteKey = requestedRoute || null;
          lastRes = {
            isError: true,
            deliveryState: "not_sent",
            fatal: true,
            reason: regularCoordAuth.reason,
            content: [{ type: "text", text: regularCoordAuth.message }],
          };
        } else {
          const windowPostAvailable = await getJxaTrusted();
          const plannedMethods = this.focusPolicyGuard.planClick(cleanArgs, aliases, {
            routeScope: effectiveRouteScope,
            windowPostAvailable,
          });
          const isOcuPixel = windowDelivery?.route === "ocu_pixel";
          const methods = isOcuPixel
            ? plannedMethods.includes("sky_click")
              ? ["sky_click"]
              : []
            : plannedMethods;
          if (methods.length === 0) {
            actionRouteKey = requestedRoute || null;
            lastRes = {
              isError: true,
              deliveryState: "not_sent",
              fatal: true,
              reason: isOcuPixel
                ? "ocu_pixel_sky_click_blocked"
                : !windowPostAvailable
                  ? "jxa_accessibility_untrusted"
                  : "click_route_blocked",
              content: [
                {
                  type: "text",
                  text: isOcuPixel
                    ? "Click blocked: sky_click caused focus steals on this window and ocu_pixel cannot fall back to non-sky routes."
                    : !windowPostAvailable
                      ? "Click blocked: all OCU click routes caused focus steals on this window and window_post is unavailable (jxa_accessibility_untrusted)."
                      : "Click blocked: no compliant non-activating Delivery Route available for this window.",
                },
              ],
            };
          } else {
            for (const method of methods) {
              actionRouteKey = formatDeliveryRoute("click", method);
              lastRes = await this.#dispatchClickMethod(method, ctx);
              if (isWriteOutcomeUnknown(lastRes)) {
                lastRes = normalizeUnknownOutcomeResult(lastRes);
                break;
              }
              if (!lastRes?.isError || lastRes?.fatal) break;
            }
          }
        }

        if (
          lastRes?.isError &&
          !lastRes?.fatal &&
          !isWriteOutcomeUnknown(lastRes) &&
          cleanArgs.click_method !== "window_post" &&
          (cleanArgs.mouse_button || "left") === "right" &&
          parsedRef?.hasElementRef &&
          preMeta?.pid > 0 &&
          !this.focusPolicyGuard.isMethodBlocked(aliases, "click", "ax_show_menu", {
            routeScope: effectiveRouteScope,
          }) &&
          typeof this.contextMenuFallbackFn === "function"
        ) {
          const beforeWriteCheck = () => this.#beforeWrite(operation, false);
          beforeWriteCheck();
          const menuRes = await this.#trackWrite(
            operation,
            this.contextMenuFallbackFn(preMeta.pid, preElement, {
              axBridge: this.axBridge,
              snapshotId: preSnapshot?.id || null,
              elementIndex: parsedRef.rawIndex,
              windowTitle: preMeta?.windowTitle || "",
              wid: effectiveRouteScope?.windowId || null,
              beforeWriteCheck,
            }),
            "click:ax_show_menu"
          ).catch((err) => {
            this.#rethrowIfAborted(err);
            return null;
          });
          if (menuRes?.delivered) {
            actionRouteKey = formatDeliveryRoute("click", "ax_show_menu");
            directDeliveryVerified = Boolean(menuRes.verified);
            lastRes = {
              isError: false,
              content: [{ type: "text", text: "Context menu triggered via AXShowMenu." }],
            };
          } else if (menuRes?.deliveryState === "sent_unknown") {
            actionRouteKey = formatDeliveryRoute("click", "ax_show_menu");
            lastRes = sentUnknownError(
              `Context menu trigger outcome unknown via AXShowMenu (${menuRes?.reason || "sent_unknown"}).`,
              menuRes?.reason || "write_outcome_unknown"
            );
          }
        }
        result = lastRes;
      }

      const clickPrefix =
        (cleanArgs.mouse_button || "left") === "right"
          ? "右键点击"
          : (cleanArgs.click_count ?? 1) >= 2
            ? "双击"
            : "点击";
      const meta = this.registry.getMeta(app);
      const resolvedWinPt = this.registry.resolveActionWindowPoint(
        app,
        windowDelivery?.localPoint
          ? {
              ...cleanArgs,
              windowPointPt: windowDelivery.localPoint,
              windowId: windowDelivery.windowId,
            }
          : cleanArgs,
        preElement
      );
      const evtNormX =
        Number.isFinite(windowDelivery?.normX) ? windowDelivery.normX : normX;
      const evtNormY =
        Number.isFinite(windowDelivery?.normY) ? windowDelivery.normY : normY;
      actionEvent = {
        type: "click",
        label: `${clickPrefix} · ${targetDesc}`,
        source: eventSource,
        normX: evtNormX,
        normY: evtNormY,
        ...(resolvedWinPt?.windowPointPt ? { windowPointPt: resolvedWinPt.windowPointPt } : {}),
        ...(resolvedWinPt?.windowId ? { windowId: resolvedWinPt.windowId } : {}),
        app: meta?.appDisplayName || app,
        targetApp: meta?.bundleId || app,
      };
    } else if (name === "type_text" || name === "press_key") {
      let lastRes = this.#buildReservedHotkeyErrorIfBlocked(name, cleanArgs.key, operation);
      if (lastRes) {
        // Blocked before dispatching any key event
      } else if (
        name === "type_text" &&
        (!cleanArgs.key_method || cleanArgs.key_method === "auto") &&
        preMeta?.pid > 0 &&
        !this.focusPolicyGuard.isMethodBlocked(aliases, "type_text", "ax_selected_text", {
          routeScope: effectiveRouteScope,
        }) &&
        typeof this.selectedTextInsertFn === "function" &&
        shouldAttemptSelectedTextFastPath(preAppKey, cleanArgs.text)
      ) {
        const beforeWriteCheck = () => this.#beforeWrite(operation, false);
        beforeWriteCheck();
        const axRes = await this.#trackWrite(
          operation,
          this.selectedTextInsertFn(preMeta.pid, cleanArgs.text, {
            axBridge: this.axBridge,
            wid: effectiveRouteScope?.windowId || null,
            beforeWriteCheck,
          }),
          "type_text:ax_selected_text"
        ).catch((err) => {
          this.#rethrowIfAborted(err);
          return null;
        });
        if (axRes?.delivered) {
          actionRouteKey = formatDeliveryRoute("type_text", "ax_selected_text");
          directDeliveryVerified = Boolean(axRes.verified);
          lastRes = {
            isError: false,
            content: [{ type: "text", text: "Text inserted via AXSelectedText." }],
          };
        } else if (axRes?.deliveryState === "sent_unknown") {
          actionRouteKey = formatDeliveryRoute("type_text", "ax_selected_text");
          lastRes = sentUnknownError(
            `Text insertion outcome unknown via AXSelectedText (${axRes?.reason || "sent_unknown"}).`,
            axRes?.reason || "write_outcome_unknown"
          );
        }
      }

      if (!lastRes) {
        const windowKeyAvailable = await getJxaTrusted();
        const methods = this.focusPolicyGuard.planKey(name, cleanArgs, aliases, {
          routeScope: effectiveRouteScope,
          windowKeyAvailable,
        });
        if (methods.length === 0) {
          actionRouteKey = requestedRoute || null;
          lastRes = {
            isError: true,
            deliveryState: "not_sent",
            fatal: true,
            reason: !windowKeyAvailable ? "jxa_accessibility_untrusted" : "key_route_blocked",
            content: [
              {
                type: "text",
                text: !windowKeyAvailable
                  ? `${name} blocked: sky_key caused focus steals on this window and window_key is unavailable (jxa_accessibility_untrusted).`
                  : `${name} blocked: no compliant non-activating key Delivery Route available.`,
              },
            ],
          };
        } else {
          for (const method of methods) {
            actionRouteKey = formatDeliveryRoute(name, method);
            lastRes = await this.#dispatchKeyMethod(name, method, ctx);
            if (isWriteOutcomeUnknown(lastRes)) {
              lastRes = normalizeUnknownOutcomeResult(lastRes);
              break;
            }
            if (!lastRes?.isError || lastRes?.fatal) break;
          }
        }
      }

      result = lastRes;
      const preview =
        name === "type_text"
          ? `输入「${String(cleanArgs.text || "").slice(0, 24)}${String(cleanArgs.text || "").length > 24 ? "…" : ""}」`
          : `按键 ${cleanArgs.key}`;
      const meta = this.registry.getMeta(app);
      actionEvent = {
        type: "key",
        label: preview,
        source: eventSource,
        app: meta?.appDisplayName || app,
        targetApp: meta?.bundleId || app,
      };
    } else {
      const ov = preMeta?.tinyWindowOverride;
      const startX = Number.isFinite(cleanArgs.from_x) ? cleanArgs.from_x : cleanArgs.x;
      const startY = Number.isFinite(cleanArgs.from_y) ? cleanArgs.from_y : cleanArgs.y;

      if (
        name === "drag" &&
        Number.isFinite(startX) &&
        Number.isFinite(startY) &&
        Number.isFinite(cleanArgs.to_x) &&
        Number.isFinite(cleanArgs.to_y) &&
        isValidTinyOverrideGeometry(ov) &&
        preMeta?.pid > 0 &&
        typeof this.pointDragFn === "function"
      ) {
        const ovProof = this.#evaluateTinyOverrideProof(preMeta, ov, liveWindowObs);
        if (
          !isWithinTinyOverrideBounds(ov, startX, startY) ||
          !isWithinTinyOverrideBounds(ov, cleanArgs.to_x, cleanArgs.to_y)
        ) {
          actionRouteKey = requestedRoute || null;
          result = this.#buildNotSentError(
            "out_of_bounds",
            "Drag coordinates are outside the current window screenshot bounds."
          );
        } else if (!ovProof.ovMatched) {
          actionRouteKey = requestedRoute || null;
          result = this.#buildNotSentError(
            "unproven_same_window",
            "Coordinate drag blocked (unproven_same_window): tiny-window override does not match current target window."
          );
        } else if (!ovProof.singleWindowOk) {
          actionRouteKey = requestedRoute || null;
          result = this.#buildNotSentError(
            "unproven_single_window",
            "Coordinate drag blocked (unproven_single_window): PID-level tiny-window drag requires a proven single-window screenshot match."
          );
        } else if (
          windowDelivery?.route === "ocu_pixel" ||
          this.focusPolicyGuard.isMethodBlocked(aliases, "drag", "app_post", {
            routeScope: effectiveRouteScope,
          })
        ) {
          actionRouteKey = requestedRoute || null;
          result = this.#buildNotSentError(
            windowDelivery?.route === "ocu_pixel" ? "ocu_pixel_drag_blocked" : "drag_route_blocked",
            "Coordinate drag blocked: PID-level drag:app_post is unavailable or blocked for this window."
          );
        } else {
          actionRouteKey = formatDeliveryRoute("drag", "app_post");
          const beforeWriteCheck = () => this.#beforeWrite(operation, false);
          beforeWriteCheck();
          const fromPt = mapTinyOverridePoint(ov, startX, startY);
          const toPt = mapTinyOverridePoint(ov, cleanArgs.to_x, cleanArgs.to_y);
          const dragRes = await this.#trackWrite(
            operation,
            this.pointDragFn(
              preMeta.pid,
              fromPt.screenX,
              fromPt.screenY,
              toPt.screenX,
              toPt.screenY,
              {
                syntheticTag: this.takeoverController?.syntheticEventTag || 0,
                beforeWriteCheck,
              }
            ),
            "drag:app_post"
          ).catch((err) => {
            this.#rethrowIfAborted(err);
            return { delivered: false, deliveryState: "not_sent", reason: err?.message || "point_drag_error" };
          });
          result = unpackPointDispatchResult(dragRes, "app_post", "drag").result;
        }
      } else {
        let handledViaBypass = false;
        if (name === "scroll" && windowDelivery?.route === "window_post" && typeof this.windowScrollFn === "function") {
          const jxaTrusted = await getJxaTrusted();
          const targetPid = Number(windowDelivery.pid || preMeta?.pid || 0);
          if (!jxaTrusted) {
            actionRouteKey = formatDeliveryRoute("scroll", "window_post_scroll");
            result = this.#buildJxaUntrustedError(
              "Window-local scroll unavailable (jxa_accessibility_untrusted).",
              { fatal: true }
            );
            handledViaBypass = true;
          } else if (targetPid > 0) {
            const beforeWriteCheck = () => this.#beforeWrite(operation, false);
            beforeWriteCheck();
            const wb = windowDelivery.windowBoundsPt || null;
            const winScroll = await this.#trackWrite(
              operation,
              this.windowScrollFn(targetPid, {
                axBridge: this.axBridge,
                direction: cleanArgs.direction,
                pages: cleanArgs.pages,
                wid: windowDelivery.windowId || null,
                windowBounds: wb
                  ? {
                      x: wb.x ?? 0,
                      y: wb.y ?? 0,
                      width: wb.width ?? wb.w,
                      height: wb.height ?? wb.h,
                    }
                  : null,
                windowTitle: windowDelivery.windowTitle || preMeta?.windowTitle || "",
                localPoint: windowDelivery.localPoint || null,
                allowAppPostFallback: Boolean(windowDelivery.allowAppPostFallback),
                syntheticTag: this.takeoverController?.syntheticEventTag || 0,
                beforeWriteCheck,
              }),
              "scroll:window_post_scroll"
            ).catch((err) => {
              this.#rethrowIfAborted(err);
              return null;
            });
            actionRouteKey = formatDeliveryRoute(
              "scroll",
              winScroll?.method || "window_post_scroll"
            );
            result = winScroll?.delivered
              ? { isError: false, content: [{ type: "text", text: "Scrolled via window_post_scroll." }] }
              : isWriteOutcomeUnknown(winScroll)
                ? normalizeUnknownOutcomeResult(
                    winScroll,
                    `Window-local scroll failed (${winScroll?.reason || "unavailable"}).`
                  )
                : {
                    isError: true,
                    ...(winScroll?.deliveryState ? { deliveryState: winScroll.deliveryState } : {}),
                    ...(winScroll?.reason ? { reason: winScroll.reason } : {}),
                    content: [
                      {
                        type: "text",
                        text: `Window-local scroll failed (${winScroll?.reason || "unavailable"}).`,
                      },
                    ],
                  };
            handledViaBypass = true;
          }
        }
        if (!handledViaBypass && name === "set_value") {
          actionRouteKey = formatDeliveryRoute("set_value", "native");
          const hasPriorNativeSteal = this.focusPolicyGuard.hasPriorStealForScope(
            aliases,
            ["set_value:native", "set_value"],
            effectiveRouteScope
          );
          if (parsedRef?.hasElementRef && !preElement?.isSecure && hasPriorNativeSteal) {
            const bypass = await this.#executeBackgroundSetValueBypass(ctx);
            if (bypass?.ok) {
              handledViaBypass = true;
              actionRouteKey = formatDeliveryRoute("set_value", "sky_bypass");
              directDeliveryVerified = Boolean(bypass.verified);
              result = bypass.result;
            } else if (bypass?.outcomeUnknown) {
              handledViaBypass = true;
              actionRouteKey = formatDeliveryRoute("set_value", "sky_bypass");
              result = normalizeUnknownOutcomeResult(
                bypass.result,
                "Background set_value bypass outcome unknown; blocked native fallback.",
                "set_value_bypass_unknown"
              );
            } else if (bypass?.result) {
              handledViaBypass = true;
              actionRouteKey = formatDeliveryRoute("set_value", "sky_bypass");
              result = bypass.result;
            }
          }
        }

        if (!handledViaBypass) {
          const hasDragStartCoords = Number.isFinite(startX) && Number.isFinite(startY);
          const hasDragEndCoords =
            Number.isFinite(cleanArgs.to_x) && Number.isFinite(cleanArgs.to_y);
          const dragPoints = [];
          if (hasDragStartCoords) dragPoints.push([startX, startY]);
          if (hasDragEndCoords) dragPoints.push([cleanArgs.to_x, cleanArgs.to_y]);
          const isCoordDragDispatch =
            name === "drag" && (hasDragStartCoords || hasDragEndCoords);
          const coordDragAuth = isCoordDragDispatch
            ? this.#authorizeCoordDispatch(preMeta, {
                liveWindowObs,
                requireSingleWindow: true,
                points: dragPoints,
                actionLabel: "drag",
              })
            : { ok: true };
          if (!coordDragAuth.ok) {
            actionRouteKey = requestedRoute || null;
            result = {
              isError: true,
              deliveryState: "not_sent",
              fatal: true,
              reason: coordDragAuth.reason,
              content: [{ type: "text", text: coordDragAuth.message }],
            };
          } else {
            result = await this.#callActionPeerWithRecovery(name, cleanArgs, app, {
              shouldFollow,
              allowAutoRefresh,
              operation,
              preMeta,
              preElement,
              expectedAgentInstanceId: isCoordDragDispatch
                ? coordDragAuth.proof?.peerInstanceId || preMeta?.actionScreenshotMeta?.peerInstanceId || null
                : null,
            });
          }
        }

        if (
          name === "scroll" &&
          result?.isError &&
          !result?.fatal &&
          !isWriteOutcomeUnknown(result) &&
          preMeta?.pid > 0 &&
          (!windowDelivery || windowDelivery.allowAppPostFallback !== false) &&
          !this.focusPolicyGuard.isMethodBlocked(aliases, "scroll", "ax_scrollbar", {
            routeScope: effectiveRouteScope,
          }) &&
          typeof this.axScrollFallbackFn === "function"
        ) {
          const beforeWriteCheck = () => this.#beforeWrite(operation, false);
          beforeWriteCheck();
          const axScroll = await this.#trackWrite(
            operation,
            this.axScrollFallbackFn(
              preMeta.pid,
              preElement,
              cleanArgs.direction,
              cleanArgs.pages,
              {
                axBridge: this.axBridge,
                snapshotId: preSnapshot?.id || null,
                elementIndex: parsedRef?.hasElementRef ? parsedRef.rawIndex : null,
                windowTitle: preMeta?.windowTitle || "",
                wid: effectiveRouteScope?.windowId || null,
                beforeWriteCheck,
              }
            ),
            "scroll:ax_scrollbar"
          ).catch((err) => {
            this.#rethrowIfAborted(err);
            return null;
          });
          if (axScroll?.delivered) {
            actionRouteKey = formatDeliveryRoute("scroll", "ax_scrollbar");
            directDeliveryVerified = Boolean(axScroll.verified);
            result = {
              isError: false,
              content: [{ type: "text", text: "Scrolled via AXScrollBar." }],
            };
          } else if (axScroll?.deliveryState === "sent_unknown") {
            actionRouteKey = formatDeliveryRoute("scroll", "ax_scrollbar");
            result = sentUnknownError(
              `Scroll outcome unknown via AXScrollBar (${axScroll?.reason || "sent_unknown"}).`,
              axScroll?.reason || "write_outcome_unknown"
            );
          }
        }
      }

      const meta = this.registry.getMeta(app);
      const w = meta?.actionFrameWidth || fallbackDims.width || 0;
      const h = meta?.actionFrameHeight || fallbackDims.height || 0;
      const { normX, normY } =
        name === "drag" &&
        w > 0 &&
        h > 0 &&
        Number.isFinite(cleanArgs.to_x) &&
        Number.isFinite(cleanArgs.to_y)
          ? { normX: cleanArgs.to_x / w, normY: cleanArgs.to_y / h }
          : this.registry.resolveCursorNorm(app, cleanArgs, fallbackDims);
      const dragTargetText =
        Number.isFinite(cleanArgs.to_x) && Number.isFinite(cleanArgs.to_y)
          ? `(${Math.round(cleanArgs.to_x)}, ${Math.round(cleanArgs.to_y)})`
          : parsedRef?.hasElementRef
            ? this.registry.describeElement(app, cleanArgs.element_index)
            : "目标位置";
      const actionLabels = {
        scroll: `滚动 ${cleanArgs.direction} (${cleanArgs.pages ?? 1} 页)`,
        drag: `拖拽 → ${dragTargetText}`,
        set_value: `填写 ${this.registry.describeElement(app, cleanArgs.element_index)}`,
        select_text: `选中文本「${String(cleanArgs.text || "").slice(0, 18)}」`,
        perform_secondary_action: `动作 ${cleanArgs.action} · ${this.registry.describeElement(app, cleanArgs.element_index)}`,
      };
      const resolvedWinPt = this.registry.resolveActionWindowPoint(
        app,
        name === "drag" && Number.isFinite(cleanArgs.to_x) && Number.isFinite(cleanArgs.to_y)
          ? { ...cleanArgs, x: cleanArgs.to_x, y: cleanArgs.to_y }
          : cleanArgs,
        preElement
      );
      actionEvent = {
        type: name,
        label: actionLabels[name] || name,
        source: eventSource,
        normX,
        normY,
        ...(resolvedWinPt?.windowPointPt ? { windowPointPt: resolvedWinPt.windowPointPt } : {}),
        ...(resolvedWinPt?.windowId ? { windowId: resolvedWinPt.windowId } : {}),
        app: meta?.appDisplayName || app,
        targetApp: meta?.bundleId || app,
      };
    }

    if (
      !isWriteOutcomeUnknown(result) &&
      parsedRef?.snapshotId &&
      result?.isError &&
      STALE_SNAPSHOT_RE.test(extractResultText(result))
    ) {
      const latestNow = this.registry.getLatestSnapshot(preAppKey);
      return {
        result: buildStaleRefToolResult({
          errorCode: "STALE_REF",
          message: `Native AX cache invalidated for pinned ref '${parsedRef.displayRef}'. Call get_app_state before retrying.`,
          currentSnapshotId: latestNow?.id || null,
        }),
        actionRouteKey,
        requestedRoute,
        directDeliveryVerified,
        actionEvent,
        isStalePinnedRef: true,
        preAppKey,
        preSnapshot,
        preElement,
        preFrameDigest,
      };
    }

    return {
      result,
      actionRouteKey,
      requestedRoute,
      directDeliveryVerified,
      actionEvent,
      isStalePinnedRef: false,
      preAppKey,
      preSnapshot,
      preElement,
      preFrameDigest,
    };
  }

  async verifyAndFormatReadBack({
    name,
    cleanArgs,
    parsedRef,
    result,
    actionRouteKey,
    requestedRoute = null,
    directDeliveryVerified = false,
    preAppKey,
    preSnapshot,
    preElement,
    preFrameDigest,
    checkAppRunningFn,
    readBackStateFn,
    onBeforeReadBackFn = null,
    onReclaimFocusFn = null,
    onAfterReadBackFn = null,
  }) {
    const actionNote = extractResultText(result)
      .replace(/^ok\s*/iu, "")
      .trim();

    if (this.postActionDelayMs > 0) {
      await new Promise((r) => setTimeout(r, this.postActionDelayMs));
    }

    let readBack = null;
    try {
      if (typeof onBeforeReadBackFn === "function") {
        await onBeforeReadBackFn();
      }

      readBack = await readBackStateFn();
      if (readBack?.isError && typeof checkAppRunningFn === "function") {
        const stillRunning = await checkAppRunningFn();
        if (stillRunning?.running) {
          if (this.windowTransitionRetryDelayMs > 0) {
            await new Promise((r) => setTimeout(r, this.windowTransitionRetryDelayMs));
          }
          readBack = await readBackStateFn();
        }
      }

      if (typeof onReclaimFocusFn === "function") {
        await onReclaimFocusFn();
      }
    } finally {
      if (typeof onAfterReadBackFn === "function") {
        await onAfterReadBackFn();
      }
    }

    const buildReceipt = (delivery) => ({
      delivery,
      route: actionRouteKey,
      executedRoute: actionRouteKey,
      ...(requestedRoute ? { requestedRoute } : {}),
    });

    if (readBack?.isError) {
      const errReceipt = buildReceipt("delivered_unverified");
      return {
        result: attachDeliveryReceipt(result, errReceipt),
        deliveryStatus: "delivered_unverified",
        verified: false,
        actionRouteKey,
        requestedRoute,
        deliveryReceipt: errReceipt,
      };
    }

    const postSnapshot = this.registry.getLatestSnapshot(preAppKey);
    const readBackImg = extractResultImage(readBack);
    const postFrameDigest = readBackImg?.data
      ? computeFrameDigest(Buffer.from(readBackImg.data, "base64"))
      : null;
    const axChanged = Boolean(
      preSnapshot &&
        postSnapshot &&
        postSnapshot.id !== preSnapshot.id &&
        didUiStructurallyChange(preSnapshot, postSnapshot)
    );
    const frameChanged = Boolean(
      preFrameDigest && postFrameDigest && preFrameDigest !== postFrameDigest
    );

    let deliveryStatus = "delivered_unverified";
    let verificationNote = "";
    if (name === "set_value") {
      const freshSnapForSetValue =
        postSnapshot && (!preSnapshot || postSnapshot.id !== preSnapshot.id) ? postSnapshot : null;
      let postEl =
        parsedRef?.hasElementRef &&
        Number(parsedRef.rawIndex) < 1_000_000 &&
        freshSnapForSetValue?.elements?.get(parsedRef.rawIndex)
          ? freshSnapForSetValue.elements.get(parsedRef.rawIndex)
          : null;
      if (postEl && preElement?.role && postEl.role !== preElement.role) {
        postEl = null;
      }
      if (!postEl && preElement?.identifier && freshSnapForSetValue?.elements instanceof Map) {
        const idMatches = Array.from(freshSnapForSetValue.elements.values()).filter(
          (el) =>
            el?.identifier === preElement.identifier &&
            (!preElement.role || el.role === preElement.role)
        );
        if (idMatches.length === 1) {
          postEl = idMatches[0];
        }
      }
      const check = verifySetValueObservation({
        expectedValue: cleanArgs.value,
        postElement: postEl,
        preElement,
        readBackText: extractResultText(readBack),
        isSecure: Boolean(preElement?.isSecure || postEl?.isSecure),
      });
      if (check.redacted) {
        if (directDeliveryVerified) {
          deliveryStatus = "delivered_verified";
        }
        verificationNote = check.note || "Secure field write completed [value redacted]";
      } else if (check.verified === true || (check.verified === null && directDeliveryVerified)) {
        deliveryStatus = "delivered_verified";
      } else if (check.verified === false) {
        verificationNote = `set_value readback still observed '${String(check.observed || "").slice(0, 40)}'`;
      }
    } else if (directDeliveryVerified || axChanged) {
      deliveryStatus = "delivered_verified";
    } else if (frameChanged) {
      verificationNote = "visual frame changed (unverified)";
    }

    const verified = deliveryStatus === "delivered_verified";
    const requestedNote =
      requestedRoute && requestedRoute !== actionRouteKey
        ? ` | Requested: ${requestedRoute}`
        : "";
    const deliveryFooter = `[Delivery: ${deliveryStatus} | Route: ${actionRouteKey}${verificationNote ? ` | ${verificationNote}` : ""}${requestedNote}]`;
    const mergedResult =
      actionNote && Array.isArray(readBack.content)
        ? {
            ...readBack,
            content: [{ type: "text", text: actionNote }, ...readBack.content],
          }
        : readBack;
    const deliveryReceipt = buildReceipt(deliveryStatus);

    return {
      result: attachDeliveryReceipt(appendResultFooter(mergedResult, deliveryFooter), deliveryReceipt),
      deliveryStatus,
      verified,
      actionRouteKey,
      requestedRoute,
      deliveryReceipt,
    };
  }

  async #isJxaPostTrusted() {
    return resolveJxaPostTrust({
      axBridge: this.axBridge,
      hasCustomWindowTransport:
        this.windowClickFn !== tryWindowPostClick ||
        this.windowKeyFn !== tryWindowKey ||
        this.windowTextFn !== tryWindowText ||
        this.windowScrollFn !== tryWindowScroll,
    });
  }

  async #resolveLiveWindowObs(pid, { liveWindowObs = null, windowTitle = "" } = {}) {
    if (liveWindowObs) return liveWindowObs;
    return resolveFocusedWindowObservation({
      pid,
      windowTitle,
      desktopHelperClient: this.desktopHelperClient,
      axBridge: this.axBridge,
      allowListWindowsFallback: true,
    });
  }

  async executeActScroll({
    app,
    pid,
    meta,
    snapshotId = null,
    direction = "down",
    pages = 0.7,
    windowId = null,
    localPoint = null,
    liveWindowObs = null,
    timeoutMs = null,
    operation = null,
  } = {}) {
    const aliases = app ? this.registry.aliasesFor(app, meta) : [];
    const wid =
      Number(windowId) > 0
        ? Number(windowId)
        : meta?.tinyWindowOverride?.wid || meta?.windowId || null;
    const routeScope = this.#resolveRouteScope(meta, { windowId: wid });
    const isPinnedWin = Number(windowId) > 0;
    const beforeWriteCheck = () => this.#beforeWrite(operation, false);
    const unknownScrollResult = (routeMethod, reason) => ({
      delivered: false,
      outcomeUnknown: true,
      code: "WRITE_OUTCOME_UNKNOWN",
      deliveryState: "sent_unknown",
      fatal: true,
      reason: reason || "write_outcome_unknown",
      route: formatDeliveryRoute("scroll", routeMethod),
    });
    let lastReason = null;

    if (
      !isPinnedWin &&
      pid > 0 &&
      typeof this.axScrollFallbackFn === "function" &&
      !this.focusPolicyGuard.isMethodBlocked(aliases, "scroll", "ax_scrollbar", { routeScope })
    ) {
      beforeWriteCheck();
      const axRes = await this.#trackWrite(
        operation,
        this.axScrollFallbackFn(pid, null, direction, pages, {
          axBridge: this.axBridge,
          snapshotId,
          elementIndex: "0",
          beforeWriteCheck,
        }),
        "scroll:ax_scrollbar"
      ).catch((err) => {
        this.#rethrowIfAborted(err);
        return null;
      });
      if (axRes?.delivered && axRes?.verified) {
        return { delivered: true, route: formatDeliveryRoute("scroll", "ax_scrollbar") };
      }
      if (isWriteOutcomeUnknown(axRes)) {
        return unknownScrollResult("ax_scrollbar", axRes?.reason);
      }
      if (axRes?.reason) lastReason = axRes.reason;
    }

    const jxaTrusted = await this.#isJxaPostTrusted();
    if (jxaTrusted && pid > 0 && typeof this.windowScrollFn === "function") {
      const effectiveLiveObs = await this.#resolveLiveWindowObs(pid, {
        liveWindowObs,
        windowTitle: meta?.windowTitle || "",
      });
      beforeWriteCheck();
      const scrollProof = evaluateScreenshotMetaProof(meta, {
        pid,
        expectedPeerInstanceId: this.actionPeer?.agentInstanceId || null,
        callerExplicitWindowId: isPinnedWin ? windowId : null,
        targetWindowId: wid,
        liveWindowObs: effectiveLiveObs,
        requireSingleWindow: true,
      });
      const allowAppPostFallback =
        scrollProof.proven &&
        !this.focusPolicyGuard.isMethodBlocked(aliases, "scroll", "app_post_scroll", { routeScope }) &&
        !this.focusPolicyGuard.isMethodBlocked(aliases, "click", "app_post", { routeScope });
      const winBounds =
        meta?.windowBounds || meta?.tinyWindowOverride?.bounds || null;
      const winRes = await this.#trackWrite(
        operation,
        this.windowScrollFn(pid, {
          axBridge: this.axBridge,
          direction,
          pages,
          wid,
          windowBounds: winBounds
            ? {
                x: winBounds.x ?? 0,
                y: winBounds.y ?? 0,
                width: winBounds.w ?? winBounds.width,
                height: winBounds.h ?? winBounds.height,
              }
            : null,
          windowTitle: meta?.windowTitle || "",
          localPoint,
          allowAppPostFallback,
          syntheticTag: this.takeoverController?.syntheticEventTag || 0,
          beforeWriteCheck,
        }),
        "scroll:window_post_scroll"
      ).catch((err) => {
        this.#rethrowIfAborted(err);
        return null;
      });
      if (winRes?.delivered) {
        return {
          delivered: true,
          route: formatDeliveryRoute("scroll", winRes.method || "window_post_scroll"),
        };
      }
      if (isWriteOutcomeUnknown(winRes)) {
        return unknownScrollResult(winRes?.method || "window_post_scroll", winRes?.reason);
      }
      if (winRes?.reason) lastReason = winRes.reason;
    }

    if (
      !isPinnedWin &&
      !this.focusPolicyGuard.hasPriorStealForScope(
        aliases,
        ["scroll:native", "click:sky_click"],
        routeScope
      )
    ) {
      beforeWriteCheck();
      const callTimeout = Number(timeoutMs) > 0 ? Math.max(50, Math.min(8000, timeoutMs)) : undefined;
      const nativeRes = await this.#trackWrite(
        operation,
        this.actionPeer.callTool("scroll", { app, direction, pages }, callTimeout, { beforeWriteCheck }),
        "scroll:native"
      ).catch((err) => {
        this.#rethrowIfAborted(err);
        return null;
      });
      if (nativeRes && !nativeRes.isError) {
        return { delivered: true, route: formatDeliveryRoute("scroll", "native") };
      }
      if (isWriteOutcomeUnknown(nativeRes)) {
        return unknownScrollResult("native", nativeRes?.reason);
      }
    }

    return {
      delivered: false,
      route: null,
      reason: lastReason || (isPinnedWin && !jxaTrusted ? "jxa_accessibility_untrusted" : "scroll_unavailable"),
    };
  }

  async executeActClick({
    app,
    pid,
    meta,
    snapshotId = null,
    match,
    elementMeta = null,
    resolvedTarget = null,
    explicitWindowId = null,
    targetWindowId = null,
    queryPeerInstanceId = null,
    windowTitle = "",
    liveWindowObs = null,
    mouseButton = "left",
    clickCount = 1,
    signal = null,
    remainingBudgetMs = null,
    operation = null,
  } = {}) {
    const aliases = app ? this.registry.aliasesFor(app, meta) : [];
    const beforeWriteCheck = () => this.#beforeWrite(operation, false);
    const rawBounds = normalizeElementBounds(match?.bounds || match?.frame);
    const initialLocalPoint = rawBounds
      ? { x: rawBounds.x + rawBounds.w / 2, y: rawBounds.y + rawBounds.h / 2 }
      : null;

    // Logical window size only from genuine logical geometry — never encoded pixels (`actionFrameWidth`/`Height`)
    const logicalWinBounds =
      normalizeElementBounds(resolvedTarget?.windowBounds) ||
      normalizeElementBounds(meta?.windowBounds) ||
      normalizeElementBounds(meta?.tinyWindowOverride?.bounds) ||
      null;
    const windowSize = logicalWinBounds
      ? { width: logicalWinBounds.w, height: logicalWinBounds.h }
      : null;
    const windowClipBox = windowSize ? { x: 0, y: 0, w: windowSize.width, h: windowSize.height } : null;

    const cardBounds = normalizeElementBounds(resolvedTarget?.localBounds);
    const targetBoxForClip = cardBounds || rawBounds;
    const clippedCenter = targetBoxForClip
      ? clipBoxIntersectionCenter(targetBoxForClip, windowClipBox, {
          requireOverlap: Boolean(windowClipBox),
        })
      : null;
    const effectiveWid =
      Number(explicitWindowId) > 0
        ? Number(explicitWindowId)
        : Number(targetWindowId) > 0
          ? Number(targetWindowId)
          : resolvedTarget?.wid || meta?.tinyWindowOverride?.wid || meta?.windowId || null;
    const routeScope = this.#resolveRouteScope(meta, { windowId: effectiveWid });

    if (targetBoxForClip && windowClipBox && !clippedCenter) {
      return {
        delivered: false,
        clicksSent: 0,
        aborted: false,
        routeKey: null,
        routeScope,
        failureReason: "target_offscreen",
      };
    }

    const finalLocalPoint =
      clippedCenter ||
      (resolvedTarget?.centerLocalPoint &&
      Number.isFinite(Number(resolvedTarget.centerLocalPoint.x)) &&
      Number.isFinite(Number(resolvedTarget.centerLocalPoint.y))
        ? { x: Number(resolvedTarget.centerLocalPoint.x), y: Number(resolvedTarget.centerLocalPoint.y) }
        : null) ||
      initialLocalPoint;

    if (
      finalLocalPoint &&
      windowClipBox &&
      (finalLocalPoint.x < windowClipBox.x ||
        finalLocalPoint.x > windowClipBox.x + windowClipBox.w ||
        finalLocalPoint.y < windowClipBox.y ||
        finalLocalPoint.y > windowClipBox.y + windowClipBox.h)
    ) {
      return {
        delivered: false,
        clicksSent: 0,
        aborted: false,
        routeKey: null,
        routeScope,
        failureReason: "target_offscreen",
      };
    }

    const effectiveLiveObs = await this.#resolveLiveWindowObs(pid, {
      liveWindowObs,
      windowTitle: windowTitle || meta?.windowTitle || "",
    });
    const auth = authorizeActionScreenshotCoords(meta, {
      pid,
      callerExplicitWindowId: explicitWindowId,
      targetWindowId: effectiveWid,
      windowSize,
      localPoint: finalLocalPoint,
      actionPeerInstanceId: this.actionPeer?.agentInstanceId || null,
      liveWindowObs: effectiveLiveObs,
    });
    const singleWindowOk = Boolean(auth.sameWindowProven && isSingleWindowProven(auth));

    const jxaTrusted = await this.#isJxaPostTrusted();
    const actMethods =
      typeof this.focusPolicyGuard.planActClick === "function"
        ? this.focusPolicyGuard.planActClick(
            {
              mouse_button: mouseButton,
              click_count: clickCount,
              hasAxPress: resolvedTarget?.hasAxPress === true,
            },
            aliases,
            { routeScope, windowPostAvailable: jxaTrusted }
          )
        : this.focusPolicyGuard.planClick(
            { click_method: "auto", mouse_button: mouseButton, click_count: clickCount },
            aliases,
            { routeScope, windowPostAvailable: jxaTrusted }
          );
    const allowWindowPost = !this.focusPolicyGuard.isMethodBlocked(aliases, "click", "window_post", {
      routeScope,
    });
    const allowAppPostFallback =
      singleWindowOk &&
      !this.focusPolicyGuard.isMethodBlocked(aliases, "click", "app_post", { routeScope });

    let failureReason = null;
    const elemMeta =
      elementMeta || (match?.index !== undefined ? meta?.elements?.get(String(match.index)) || null : null);

    if (
      actMethods.includes("accessibility") &&
      jxaTrusted &&
      pid > 0 &&
      typeof this.axBridge?.pressActionTarget === "function"
    ) {
      if (signal?.aborted) {
        return { delivered: false, clicksSent: 0, aborted: true, routeKey: null, routeScope, failureReason: "cancelled" };
      }
      beforeWriteCheck();
      const pressRes = await this.#trackWrite(
        operation,
        this.axBridge.pressActionTarget(pid, {
          pressTargetId: resolvedTarget?.pressTargetId || null,
          snapshotId,
          elementIndex: match?.index !== undefined ? String(match.index) : null,
          elementMeta: elemMeta,
          localPoint: finalLocalPoint,
          wid: effectiveWid,
          windowTitle: windowTitle || meta?.windowTitle || "",
          windowBounds: logicalWinBounds
            ? {
                x: logicalWinBounds.x,
                y: logicalWinBounds.y,
                width: logicalWinBounds.w,
                height: logicalWinBounds.h,
              }
            : null,
          beforeWriteCheck,
        }),
        "click:accessibility"
      ).catch((err) => {
        this.#rethrowIfAborted(err);
        return { delivered: false, reason: err?.message || "ax_press_error" };
      });
      if (pressRes?.delivered) {
        return {
          delivered: true,
          clicksSent: 1,
          aborted: false,
          routeKey: formatDeliveryRoute("click", "accessibility"),
          routeScope,
          failureReason: null,
          localPoint: finalLocalPoint,
        };
      }
      failureReason = pressRes?.reason || "ax_press_unavailable";
      if (isWriteOutcomeUnknown(pressRes)) {
        return {
          delivered: false,
          clicksSent: 1,
          aborted: false,
          code: "WRITE_OUTCOME_UNKNOWN",
          deliveryState: "sent_unknown",
          fatal: true,
          routeKey: formatDeliveryRoute("click", "accessibility"),
          routeScope,
          failureReason: pressRes?.reason || "write_outcome_unknown",
        };
      }
      if (
        pressRes?.reason === "window_resized" ||
        pressRes?.reason === "out_of_bounds" ||
        pressRes?.reason === "element_window_mismatch" ||
        /^(?:element|window)_(?:destroyed|mutated|hidden|moved|changed)_in_background$|^modal_sheet_appeared$/u.test(
          String(pressRes?.reason || "")
        )
      ) {
        return { delivered: false, clicksSent: 0, aborted: false, routeKey: null, routeScope, failureReason };
      }
    }

    if (
      jxaTrusted &&
      allowWindowPost &&
      pid > 0 &&
      typeof this.windowClickFn === "function" &&
      finalLocalPoint
    ) {
      if (signal?.aborted) {
        return { delivered: false, clicksSent: 0, aborted: true, routeKey: null, routeScope, failureReason: "cancelled" };
      }
      beforeWriteCheck();
      const winRes = await this.#trackWrite(
        operation,
        this.windowClickFn(pid, {
          axBridge: this.axBridge,
          snapshotId,
          elementIndex: match?.index !== undefined ? String(match.index) : null,
          elementMeta: elemMeta,
          localPoint: finalLocalPoint,
          expectedWindowSize: windowSize,
          windowTitle: windowTitle || meta?.windowTitle || "",
          wid: effectiveWid,
          windowBounds: logicalWinBounds
            ? {
                x: logicalWinBounds.x,
                y: logicalWinBounds.y,
                width: logicalWinBounds.w,
                height: logicalWinBounds.h,
              }
            : null,
          button: mouseButton,
          clickCount,
          allowAppPostFallback,
          syntheticTag: this.takeoverController?.syntheticEventTag || 0,
          beforeWriteCheck,
        }),
        "click:window_post"
      ).catch((err) => {
        this.#rethrowIfAborted(err);
        return { delivered: false, reason: err?.message || "window_click_error" };
      });

      if (winRes?.delivered) {
        return {
          delivered: true,
          clicksSent: 1,
          aborted: false,
          routeKey: formatDeliveryRoute("click", winRes.method || "window_post"),
          routeScope,
          failureReason: null,
          localPoint: finalLocalPoint,
        };
      }
      failureReason = winRes?.reason || "window_post_unavailable";
      if (isWriteOutcomeUnknown(winRes)) {
        return {
          delivered: false,
          clicksSent: 1,
          aborted: false,
          code: "WRITE_OUTCOME_UNKNOWN",
          deliveryState: "sent_unknown",
          fatal: true,
          routeKey: formatDeliveryRoute("click", "window_post"),
          routeScope,
          failureReason: winRes?.reason || "write_outcome_unknown",
        };
      }
      if (
        winRes?.reason === "window_resized" ||
        winRes?.reason === "out_of_bounds" ||
        winRes?.reason === "element_window_mismatch" ||
        /^(?:element|window)_(?:destroyed|mutated|hidden|moved|changed)_in_background$|^modal_sheet_appeared$/u.test(
          String(winRes?.reason || "")
        )
      ) {
        return { delivered: false, clicksSent: 0, aborted: false, routeKey: null, routeScope, failureReason };
      }
    }

    if (signal?.aborted) {
      return { delivered: false, clicksSent: 0, aborted: true, routeKey: null, routeScope, failureReason: "cancelled" };
    }

    const ocuMethods = actMethods.filter((m) => m === "sky_click" || m === "app_post");
    for (const ocuMethod of ocuMethods) {
      const built = buildActNativeClickArgs({
        app,
        clickMethod: ocuMethod,
        match,
        resolvedTarget,
        meta,
        auth,
        callerExplicitWindowId: explicitWindowId,
        queryPeerInstanceId,
        jxaTrusted,
        mouseButton,
        clickCount,
      });

      if (built?.clickArgs) {
        if (signal?.aborted) {
          return { delivered: false, clicksSent: 0, aborted: true, routeKey: null, routeScope, failureReason: "cancelled" };
        }
        beforeWriteCheck();
        const candidateRoute = formatDeliveryRoute("click", ocuMethod);
        const callTimeout =
          Number(remainingBudgetMs) > 0 ? Math.max(50, Math.min(8000, remainingBudgetMs)) : undefined;
        let stalePeerErr = null;
        const nativeClick = await this.#trackWrite(
          operation,
          this.actionPeer.callTool("click", built.clickArgs, callTimeout, {
            beforeWriteCheck,
            expectedAgentInstanceId: built.expectedAgentInstanceId,
          }),
          candidateRoute
        ).catch((err) => {
          this.#rethrowIfAborted(err);
          if (err?.code === "STALE_PEER_GENERATION") {
            stalePeerErr = err;
            return null;
          }
          return null;
        });
        if (stalePeerErr) {
          return {
            delivered: false,
            clicksSent: 0,
            aborted: false,
            routeKey: null,
            routeScope,
            failureReason: "stale_peer_generation",
          };
        }
        if (nativeClick && !nativeClick.isError) {
          return {
            delivered: true,
            clicksSent: 1,
            aborted: false,
            routeKey: candidateRoute,
            routeScope,
            failureReason: null,
            localPoint: finalLocalPoint,
          };
        }
        const isUnknown = isWriteOutcomeUnknown(nativeClick);
        return {
          delivered: false,
          clicksSent: isUnknown ? 1 : nativeClick?.deliveryState === "not_sent" ? 0 : 1,
          aborted: false,
          ...(isUnknown
            ? { code: "WRITE_OUTCOME_UNKNOWN", deliveryState: "sent_unknown", fatal: true }
            : nativeClick?.deliveryState
              ? { deliveryState: nativeClick.deliveryState }
              : {}),
          routeKey: candidateRoute,
          routeScope,
          failureReason: extractResultText(nativeClick) || failureReason || `${ocuMethod}_failed`,
        };
      }
    }

    return {
      delivered: false,
      clicksSent: 0,
      aborted: false,
      routeKey: null,
      routeScope,
      failureReason: !jxaTrusted
        ? failureReason || "click_route_blocked (jxa_accessibility_untrusted)"
        : failureReason || "click_route_blocked",
    };
  }
}
