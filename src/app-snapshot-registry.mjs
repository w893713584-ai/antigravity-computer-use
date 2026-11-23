import { parseQualifiedElementRef, SnapshotLedger } from "./headless-engine.mjs";

export const SECURE_ROLE_RE =
  /AXSecureTextField|SecureTextField|secure\s+text\s+field|安全文本|密码/iu;

export function isSecureTextRole(role) {
  return SECURE_ROLE_RE.test(String(role || ""));
}

function normalizeSemanticFingerprintText(textStr) {
  if (!textStr) return "";
  const quoted = /^(.*?)\bValue:\s*"([\s\S]*)"$/u.exec(textStr);
  if (quoted) {
    return [quoted[1].trim(), quoted[2].trim()].filter(Boolean).join(" ");
  }
  const plain = /^Value:\s*([\s\S]*)$/u.exec(textStr);
  if (plain) return plain[1].trim();
  return textStr;
}

export function normalizeElementBounds(raw) {
  if (!raw || typeof raw !== "object") return null;
  const x = Number(raw.x);
  const y = Number(raw.y);
  const w = Number(raw.w ?? raw.width);
  const h = Number(raw.h ?? raw.height);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !(w > 0) || !(h > 0)) {
    return null;
  }
  return { x, y, w, h };
}

/**
 * Check whether two window/image aspect ratios agree within `maxDelta`.
 */
export function hasMatchingAspectRatio(w1, h1, w2, h2, maxDelta = 0.03) {
  const aW = Number(w1);
  const aH = Number(h1);
  const bW = Number(w2);
  const bH = Number(h2);
  if (!(aW > 0) || !(aH > 0) || !(bW > 0) || !(bH > 0)) {
    return false;
  }
  const r1 = aW / aH;
  const r2 = bW / bH;
  return Math.abs(r2 - r1) / Math.max(r1, 0.001) <= maxDelta;
}

/**
 * Derive a `{ pid, processToken, windowId }` route scope from cached snapshot/meta records.
 */
export function buildRouteScopeFromMeta(meta, { snapshot = null, windowId = null } = {}) {
  const pid = Number(meta?.pid || snapshot?.pid || 0) || null;
  const processToken = meta?.processToken || snapshot?.processToken || null;
  const explicitWid = Number(windowId);
  const resolvedWid =
    Number.isInteger(explicitWid) && explicitWid > 0
      ? explicitWid
      : Number(
          snapshot?.windowId ||
            meta?.windowId ||
            meta?.actionScreenshotMeta?.windowId ||
            meta?.tinyWindowOverride?.wid ||
            0
        ) || null;
  if (!pid && !processToken && !resolvedWid) return null;
  return {
    pid,
    processToken,
    windowId: resolvedWid,
  };
}

/**
 * Resolve a live window observation for a running PID by combining desktop-helper
 * focus metadata, AX focused-window queries, and optional window-list fallbacks.
 */
export async function resolveFocusedWindowObservation({
  pid,
  windowTitle = "",
  desktopHelperClient = null,
  axBridge = null,
  allowListWindowsFallback = false,
} = {}) {
  const numPid = Number(pid || 0);
  if (!(numPid > 0)) return null;
  const toPositiveIds = (raw) =>
    Array.isArray(raw) ? raw.map((x) => Number(x)).filter((x) => x > 0) : null;

  let helperObs = null;
  if (desktopHelperClient?.available && typeof desktopHelperClient.getFocusedWindow === "function") {
    helperObs = await desktopHelperClient.getFocusedWindow(numPid).catch(() => null);
    if (helperObs && Number(helperObs.wid) > 0) {
      return {
        wid: Number(helperObs.wid),
        title: helperObs.title || null,
        windowBounds: helperObs.windowBounds || null,
        windowIds: toPositiveIds(helperObs.windowIds),
        ...(helperObs.focusedExcludedWindow ? { focusedExcludedWindow: true } : {}),
      };
    }
  }
  const helperWindowIds = toPositiveIds(helperObs?.windowIds);
  if (axBridge?.enabled !== false && typeof axBridge?.getFocusedWindowInfo === "function") {
    const axObs = await axBridge
      .getFocusedWindowInfo(numPid, { windowTitle: windowTitle || "" })
      .catch(() => null);
    if (axObs && typeof axObs === "object") {
      const axIds = toPositiveIds(axObs.windowIds);
      const focusedExcluded = Boolean(
        axObs.focusedExcludedWindow || helperObs?.focusedExcludedWindow
      );
      return {
        wid: Number(axObs.wid) > 0 ? Number(axObs.wid) : null,
        title: axObs.title || null,
        windowBounds: axObs.windowBounds || null,
        windowIds: axIds?.length ? axIds : helperWindowIds,
        ...(focusedExcluded ? { focusedExcludedWindow: true } : {}),
      };
    }
  }
  if (helperObs && (helperWindowIds?.length || helperObs.focusedExcludedWindow)) {
    return {
      wid: null,
      title: helperObs.title || null,
      windowBounds: helperObs.windowBounds || null,
      windowIds: helperWindowIds || [],
      ...(helperObs.focusedExcludedWindow ? { focusedExcludedWindow: true } : {}),
    };
  }
  if (
    allowListWindowsFallback &&
    desktopHelperClient?.available &&
    typeof desktopHelperClient.listWindows === "function"
  ) {
    const wins = await desktopHelperClient.listWindows(numPid).catch(() => null);
    if (Array.isArray(wins) && wins.length > 0) {
      const windowIds = toPositiveIds(wins.map((w) => w?.windowId || w?.wid));
      if (windowIds?.length) {
        return { wid: null, windowIds };
      }
    }
  }
  return null;
}

/**
 * Determine whether an observation or proof guarantees a single visible window.
 * Explicit boolean `singleWindowProven` takes precedence over cached `windowCount === 1`.
 */
export function isSingleWindowProven(shotOrAuth) {
  if (typeof shotOrAuth?.singleWindowProven === "boolean") {
    return shotOrAuth.singleWindowProven;
  }
  return shotOrAuth?.windowCount === 1;
}

/**
 * Shared authoritative Same-Window Proof & Single-Window Shot evaluator on `actionScreenshotMeta`.
 * Pixel coordinate scaling remains at the ActionExecutor seam (`windowPointToScreenshotPixel`).
 */
export function evaluateScreenshotMetaProof(
  meta,
  {
    shotMeta = undefined,
    pid = null,
    expectedPeerInstanceId = null,
    callerExplicitWindowId = null,
    targetWindowId = null,
    windowSize = null,
    liveWindowObs = null,
    requireSingleWindow = false,
    requirePositiveWid = true,
  } = {}
) {
  const shot = shotMeta !== undefined ? shotMeta : meta?.actionScreenshotMeta || null;
  const imgW = Number(shot?.width || meta?.actionFrameWidth || 0);
  const imgH = Number(shot?.height || meta?.actionFrameHeight || 0);
  const effectivePid = Number(pid || meta?.pid || 0);
  const shotWid = Number(shot?.windowId || 0);

  const identityMatch = Boolean(
    shot &&
      shot.source === "ocu_action_peer" &&
      imgW > 0 &&
      imgH > 0 &&
      (!expectedPeerInstanceId || !shot.peerInstanceId || shot.peerInstanceId === expectedPeerInstanceId) &&
      (!(effectivePid > 0 && shot.pid > 0) || Number(shot.pid) === effectivePid) &&
      (!meta?.processToken || !shot.processToken || shot.processToken === meta.processToken)
  );

  let boundsMatch = identityMatch;
  const normW = Number(windowSize?.width ?? windowSize?.w ?? 0);
  const normH = Number(windowSize?.height ?? windowSize?.h ?? 0);
  if (boundsMatch && normW > 0 && normH > 0) {
    if (shot.windowBounds) {
      const sw = Number(shot.windowBounds.width ?? shot.windowBounds.w ?? 0);
      const sh = Number(shot.windowBounds.height ?? shot.windowBounds.h ?? 0);
      if (sw > 0 && sh > 0 && (Math.abs(sw - normW) > 4 || Math.abs(sh - normH) > 4)) {
        boundsMatch = false;
      }
    }
    if (boundsMatch && !hasMatchingAspectRatio(normW, normH, imgW, imgH, 0.03)) {
      boundsMatch = false;
    }
  }

  let liveMatch = true;
  if (liveWindowObs && typeof liveWindowObs === "object") {
    const liveWid = Number(liveWindowObs.wid || liveWindowObs.windowId || 0);
    if (liveWid > 0 && shotWid > 0 && liveWid !== shotWid) {
      liveMatch = false;
    }
    const lb = normalizeElementBounds(liveWindowObs.windowBounds || liveWindowObs.boundsPt || liveWindowObs.bounds);
    if (liveMatch && lb) {
      if (shot?.windowBounds) {
        const sw = Number(shot.windowBounds.width ?? shot.windowBounds.w ?? 0);
        const sh = Number(shot.windowBounds.height ?? shot.windowBounds.h ?? 0);
        if (sw > 0 && sh > 0 && (Math.abs(sw - lb.w) > 4 || Math.abs(sh - lb.h) > 4)) {
          liveMatch = false;
        }
      }
      if (liveMatch && imgW > 0 && imgH > 0 && !hasMatchingAspectRatio(lb.w, lb.h, imgW, imgH, 0.03)) {
        liveMatch = false;
      }
    }
  }

  const isPinned = Number(callerExplicitWindowId) > 0;
  const effectiveWid = isPinned
    ? Number(callerExplicitWindowId)
    : Number(targetWindowId || meta?.tinyWindowOverride?.wid || meta?.windowId || 0);
  const widMatch = Boolean(
    shot?.windowIdProven === true &&
      shotWid > 0 &&
      (effectiveWid > 0 ? shotWid === effectiveWid : !requirePositiveWid)
  );

  const liveWindowIds = Array.isArray(liveWindowObs?.windowIds)
    ? liveWindowObs.windowIds.map((x) => Number(x)).filter((x) => x > 0)
    : null;
  const liveWidObs = Number(liveWindowObs?.wid || liveWindowObs?.windowId || 0);
  const liveFocusedExcluded = Boolean(
    liveWindowObs?.focusedExcludedWindow === true ||
      (!(liveWidObs > 0) &&
        liveWindowIds?.length === 1 &&
        liveWindowObs?.title &&
        shot?.windowTitle &&
        String(liveWindowObs.title).trim() !== String(shot.windowTitle).trim())
  );
  const liveMultiWindow = Boolean(
    liveFocusedExcluded ||
      (liveWindowIds &&
        (liveWindowIds.length !== 1 || (shotWid > 0 && Number(liveWindowIds[0]) !== shotWid)))
  );
  const singleWindowProven = Boolean(isSingleWindowProven(shot) && !liveMultiWindow);
  const sameWindowProven = Boolean(identityMatch && boundsMatch && liveMatch && widMatch);
  const proven = Boolean(sameWindowProven && (!requireSingleWindow || singleWindowProven));

  return {
    proven,
    sameWindowProven,
    identityMatch,
    boundsMatch,
    liveMatch,
    widMatch,
    singleWindowProven,
    effectiveWid: effectiveWid > 0 ? effectiveWid : shotWid > 0 ? shotWid : null,
    shotWindowId: shotWid > 0 ? shotWid : null,
    windowCount: shot?.windowCount ?? null,
    width: imgW,
    height: imgH,
    peerInstanceId: shot?.peerInstanceId || null,
    shotMeta: shot,
  };
}

/**
 * Single authoritative builder for Snapshot & `query` element descriptors.
 * Enforces identical password redaction (`isSecure`), `identifier`-stable fingerprinting,
 * bounds/window provenance (`origin`, `windowId`), and human-readable labels across
 * both `get_app_state` text and `query` JSON ingestion.
 */
export function buildElementDescriptor({
  index,
  role,
  primaryText = "",
  identifier = null,
  help = null,
  secondaryActions = [],
  bounds = null,
  windowId = null,
  origin = "snapshot",
  fallbackLabelToIdentifier = false,
  redactHelp = false,
  emptyRawTextAsNull = false,
}) {
  const indexStr = String(index);
  const roleStr = String(role || "控件");
  const cleanId = identifier ? String(identifier).trim() || null : null;
  const isSecure = isSecureTextRole(roleStr);
  const cleanHelp = !(isSecure && redactHelp) && help ? String(help).trim() || null : null;
  const actions = Array.isArray(secondaryActions)
    ? secondaryActions.map((s) => String(s).trim()).filter(Boolean)
    : [];
  const winIdNum = Number(windowId);
  const cleanWindowId = Number.isInteger(winIdNum) && winIdNum > 0 ? winIdNum : null;

  const textStr = isSecure ? "" : String(primaryText ?? "").trim();
  const fingerprintText = cleanId ? "" : normalizeSemanticFingerprintText(textStr).slice(0, 48);
  const displayDesc = textStr || (fallbackLabelToIdentifier ? cleanId || "" : "");

  return {
    index: indexStr,
    role: roleStr,
    rawText: isSecure ? "[redacted]" : textStr || (emptyRawTextAsNull ? null : ""),
    identifier: cleanId,
    help: cleanHelp,
    secondaryActions: actions,
    bounds: normalizeElementBounds(bounds),
    windowId: cleanWindowId,
    origin: origin === "query" ? "query" : "snapshot",
    isSecure,
    fingerprint: `${roleStr}|${cleanId || ""}|${isSecure ? "[secure]" : fingerprintText}`,
    label: isSecure
      ? `${roleStr}「[已脱敏]」`
      : displayDesc
        ? `${roleStr}「${displayDesc.slice(0, 28)}」`
        : roleStr,
  };
}

function normalizeMetaKey(appQuery) {
  return typeof appQuery === "string" ? appQuery.trim().toLowerCase() : "";
}

/**
 * Deep Module: AppSnapshotRegistry
 *
 * Owns per-app metadata caching, alias resolution, SnapshotLedger issuance,
 * Electron `AXManualAccessibility` wake memoization, serialized `axBridge.bindSnapshot`
 * ordering, `query` match ingestion, and pre-dispatch Qualified Element Ref validation.
 */
export class AppSnapshotRegistry {
  #cache = new Map();
  #ledger;
  #axBridge;
  #processIdentityFn;
  #rendererAccessibilityFn;
  #onSnapshotIssued;
  #manualAxWokenByPid = new Map();
  #pendingSnapshotBind = null;

  constructor({
    snapshotLedger = new SnapshotLedger(),
    axBridge = null,
    processIdentityFn = null,
    rendererAccessibilityFn = null,
    onSnapshotIssued = null,
  } = {}) {
    this.#ledger = snapshotLedger;
    this.#axBridge = axBridge;
    this.#processIdentityFn = processIdentityFn;
    this.#rendererAccessibilityFn = rendererAccessibilityFn;
    this.#onSnapshotIssued = onSnapshotIssued;
  }

  get ledger() {
    return this.#ledger;
  }

  get cache() {
    return this.#cache;
  }

  getLatestSnapshot(appKey) {
    return appKey ? this.#ledger.getLatest(appKey) : null;
  }

  markAppStale(appKey, reason = "stale") {
    if (appKey) {
      this.#ledger.markAppStale(appKey, reason);
    }
  }

  getMeta(appQuery) {
    const norm = normalizeMetaKey(appQuery);
    return norm ? this.#cache.get(norm) || null : null;
  }

  aliasesFor(appQuery, meta = null) {
    const resolved = meta || this.getMeta(appQuery);
    return Array.from(
      new Set([resolved?.bundleId, resolved?.appDisplayName, appQuery].filter(Boolean))
    );
  }

  isSameApp(appQuery, activeState = {}) {
    if (!appQuery || !activeState?.activeApp) return false;
    const k = normalizeMetaKey(appQuery);
    return Boolean(
      k === normalizeMetaKey(activeState.activeApp) ||
        (activeState.bundleId && k === normalizeMetaKey(activeState.bundleId)) ||
        (activeState.appDisplayName && k === normalizeMetaKey(activeState.appDisplayName))
    );
  }

  recordMeta(
    appQuery,
    meta,
    {
      fromActionPeer = false,
      includeAx = true,
      includeScreenshot = true,
      preserveScreenshotState = false,
      actionDims = null,
      imageDigest = undefined,
      tinyWindowOverride = undefined,
      processToken = undefined,
      source = "snapshot",
    } = {}
  ) {
    const prev =
      (meta.bundleId && this.#cache.get(normalizeMetaKey(meta.bundleId))) ||
      (appQuery && this.#cache.get(normalizeMetaKey(appQuery))) ||
      {};

    let elements = prev.elements || new Map();
    let elementsPartial = Boolean(prev.elementsPartial);
    let actionHasAx = Boolean(prev.actionHasAx);
    let actionHasScreenshot = Boolean(prev.actionHasScreenshot);
    let actionFrameWidth = prev.actionFrameWidth || 0;
    let actionFrameHeight = prev.actionFrameHeight || 0;
    let nextTinyOverride = prev.tinyWindowOverride || null;
    const nextProcessToken = processToken !== undefined ? processToken : prev.processToken || null;
    let snapshotId = prev.snapshotId || null;
    const rawWinId = Number(meta.windowId);
    const parsedWinId = Number.isInteger(rawWinId) && rawWinId > 0 ? rawWinId : null;
    const pidChanged = Boolean(meta.pid && prev.pid && meta.pid !== prev.pid);
    const processChanged = Boolean(
      nextProcessToken && prev.processToken && nextProcessToken !== prev.processToken
    );
    const windowChanged = Boolean(
      (meta.windowTitle && prev.windowTitle && meta.windowTitle !== prev.windowTitle) ||
        (parsedWinId && prev.windowId && parsedWinId !== prev.windowId)
    );
    const identityChanged = windowChanged || pidChanged || processChanged;
    const captureMatchesPrev =
      source !== "query" && !(fromActionPeer && !includeScreenshot)
        ? true
        : !preserveScreenshotState
          ? false
          : parsedWinId !== null
            ? Boolean(prev.windowId && prev.windowId === parsedWinId && !pidChanged && !processChanged)
            : !prev.windowId && !pidChanged && !processChanged;

    let lastImageDigest =
      imageDigest !== undefined
        ? imageDigest
        : identityChanged || !captureMatchesPrev
          ? null
          : prev.lastImageDigest || null;
    if (identityChanged) {
      elements = new Map();
      elementsPartial = false;
      actionHasAx = false;
      actionHasScreenshot = false;
      actionFrameWidth = 0;
      actionFrameHeight = 0;
      nextTinyOverride = null;
      snapshotId = null;
    } else if (!captureMatchesPrev) {
      actionHasScreenshot = false;
      actionFrameWidth = 0;
      actionFrameHeight = 0;
      nextTinyOverride = null;
    }

    if (fromActionPeer) {
      if (!includeAx) {
        elements = new Map();
        elementsPartial = false;
        actionHasAx = false;
      } else if (meta.elementsPartial || source === "query") {
        if (identityChanged) {
          elements = meta.elements instanceof Map ? meta.elements : new Map();
        } else if (meta.elements?.size) {
          elements = meta.elements;
        }
        elementsPartial = true;
        actionHasAx = true;
      } else {
        elements = meta.elements instanceof Map ? meta.elements : new Map();
        elementsPartial = false;
        actionHasAx = true;
      }
      if (
        (includeScreenshot && !actionDims) ||
        (!includeScreenshot && (!preserveScreenshotState || !captureMatchesPrev))
      ) {
        actionHasScreenshot = false;
        actionFrameWidth = 0;
        actionFrameHeight = 0;
        lastImageDigest = imageDigest !== undefined ? imageDigest : null;
      } else if (actionDims) {
        actionHasScreenshot = true;
        actionFrameWidth = actionDims.width;
        actionFrameHeight = actionDims.height;
      }
      if (tinyWindowOverride !== undefined) {
        nextTinyOverride = tinyWindowOverride;
      }
    } else if (includeAx) {
      if (meta.elementsPartial) {
        elements = meta.elements?.size ? meta.elements : identityChanged ? new Map() : elements;
        elementsPartial = true;
      } else {
        elements = meta.elements instanceof Map ? meta.elements : new Map();
        elementsPartial = false;
      }
    }

    const bundleId = meta.bundleId || prev.bundleId || null;
    const pid = meta.pid || prev.pid || null;
    const windowId =
      parsedWinId !== null
        ? parsedWinId
        : identityChanged
          ? null
          : prev.windowId || null;
    const windowTitle = meta.windowTitle || (identityChanged ? null : prev.windowTitle || null);
    const appDisplayName = meta.appDisplayName || prev.appDisplayName || null;
    const explicitWinBounds = normalizeElementBounds(meta.windowBounds);
    const overrideWinBounds = normalizeElementBounds(nextTinyOverride?.bounds);
    const windowBounds =
      overrideWinBounds ||
      explicitWinBounds ||
      (identityChanged ? null : prev.windowBounds || null);

    if (fromActionPeer && includeAx) {
      if (identityChanged) {
        this.#ledger.markAppStale(bundleId || appQuery, pidChanged || processChanged ? "process_restarted" : "window_changed");
      }
      const snap = this.#ledger.issueSnapshot({
        appKey: bundleId || appQuery,
        bundleId,
        pid,
        processToken: nextProcessToken,
        windowId,
        windowTitle,
        frameWidth: actionFrameWidth,
        frameHeight: actionFrameHeight,
        elements,
        elementsPartial,
        source,
      });
      if (snap) {
        snapshotId = snap.id;
        this.#onSnapshotIssued?.(snap);
      }
    } else if (fromActionPeer && !includeAx) {
      this.#ledger.markAppStale(bundleId || appQuery, "ax_cache_invalidated");
    }

    let nextActionScreenshotMeta =
      identityChanged || !captureMatchesPrev ? null : prev.actionScreenshotMeta || null;
    if (
      fromActionPeer &&
      ((includeScreenshot && !actionDims) ||
        (!includeScreenshot && (!preserveScreenshotState || !captureMatchesPrev)))
    ) {
      nextActionScreenshotMeta = null;
    } else if (fromActionPeer && includeScreenshot && actionDims) {
      const windowIdProven = Boolean(parsedWinId !== null || nextTinyOverride?.wid > 0);
      const windowCount =
        Number.isInteger(meta.windowCount) && meta.windowCount >= 0 ? meta.windowCount : null;
      const singleWindowProven = Boolean(
        meta.singleWindowProven || (nextTinyOverride?.wid > 0 && windowCount === 1)
      );
      nextActionScreenshotMeta = {
        pid: pid || null,
        processToken: nextProcessToken || null,
        windowId: windowId || nextTinyOverride?.wid || null,
        windowIdProven,
        windowCount,
        singleWindowProven,
        peerInstanceId: meta.peerInstanceId || null,
        windowTitle: windowTitle || null,
        windowBounds: windowBounds || null,
        width: actionDims.width,
        height: actionDims.height,
        capturedAt: Date.now(),
        source: nextTinyOverride ? "tiny_window_override" : "ocu_action_peer",
      };
    }

    const merged = {
      ...prev,
      bundleId,
      pid,
      processToken: nextProcessToken,
      windowId,
      windowBounds,
      windowTitle,
      appDisplayName,
      occludedNote: meta.occludedNote ?? prev.occludedNote ?? false,
      elements,
      elementsPartial,
      snapshotId,
      actionHasAx,
      actionHasScreenshot,
      actionFrameWidth,
      actionFrameHeight,
      actionScreenshotMeta: nextActionScreenshotMeta,
      lastImageDigest,
      tinyWindowOverride: nextTinyOverride,
      updatedAt: Date.now(),
    };

    for (const key of [appQuery, merged.bundleId, merged.appDisplayName]) {
      const norm = normalizeMetaKey(key);
      if (norm) this.#cache.set(norm, merged);
    }
    return merged;
  }

  /**
   * Invalidate cached action-peer screenshots across apps or for a specific peer instance.
   */
  invalidateActionScreenshots(targetPeerInstanceId = null) {
    const updated = new Map();
    for (const [normKey, entry] of this.#cache.entries()) {
      if (
        targetPeerInstanceId &&
        entry.actionScreenshotMeta?.peerInstanceId !== targetPeerInstanceId
      ) {
        continue;
      }
      let nextEntry = updated.get(entry);
      if (!nextEntry) {
        nextEntry = {
          ...entry,
          actionHasScreenshot: false,
          actionFrameWidth: 0,
          actionFrameHeight: 0,
          actionScreenshotMeta: null,
          singleWindowProven: false,
          windowCount: null,
          tinyWindowOverride: null,
          lastImageDigest: null,
        };
        updated.set(entry, nextEntry);
      }
      this.#cache.set(normKey, nextEntry);
    }
  }

  deleteMeta(appQuery) {
    const meta = this.getMeta(appQuery);
    if (meta?.pid > 0) {
      this.#manualAxWokenByPid.delete(meta.pid);
      void this.#axBridge?.dropSnapshots?.({ pid: meta.pid });
    }
    for (const key of [appQuery, meta?.bundleId, meta?.appDisplayName]) {
      const norm = normalizeMetaKey(key);
      if (norm) {
        this.#cache.delete(norm);
        this.#ledger.clearApp(norm);
      }
    }
  }

  async resolveProcessIdentity(pid) {
    if (!Number.isInteger(pid) || pid <= 0 || typeof this.#processIdentityFn !== "function") {
      return null;
    }
    return this.#processIdentityFn(pid, { axBridge: this.#axBridge }).catch(() => null);
  }

  async ensureRendererAxAwake(pid, processToken = null, { beforeWriteCheck = null } = {}) {
    if (!Number.isInteger(pid) || pid <= 0 || typeof this.#rendererAccessibilityFn !== "function") {
      return { supported: false, changed: false, enabled: false };
    }
    const prevToken = this.#manualAxWokenByPid.get(pid);
    if (prevToken) {
      if (!processToken || prevToken === processToken) {
        return { supported: true, changed: false, enabled: true };
      }
      if (prevToken === "pid-only") {
        this.#manualAxWokenByPid.set(pid, processToken);
        return { supported: true, changed: false, enabled: true };
      }
    }
    if (typeof beforeWriteCheck === "function") {
      beforeWriteCheck();
    }
    try {
      const res = await this.#rendererAccessibilityFn(pid, { axBridge: this.#axBridge });
      if (res && typeof res === "object") {
        if ((res.supported && res.enabled) || res.definitive === true) {
          this.#manualAxWokenByPid.set(pid, processToken || "pid-only");
        }
        return res;
      }
    } catch {}
    return { supported: false, changed: false, enabled: false };
  }

  bindSnapshotHandles(merged) {
    if (
      !merged?.snapshotId ||
      !Number.isInteger(merged.pid) ||
      merged.pid <= 0 ||
      !this.#axBridge ||
      this.#axBridge.enabled === false ||
      typeof this.#axBridge.bindSnapshot !== "function"
    ) {
      return;
    }
    const prev = this.#pendingSnapshotBind || Promise.resolve();
    this.#pendingSnapshotBind = prev
      .catch(() => null)
      .then(() =>
        this.#axBridge.bindSnapshot({
          snapshotId: merged.snapshotId,
          pid: merged.pid,
          windowTitle: merged.windowTitle,
          elements: merged.elements,
        })
      )
      .catch(() => null);
  }

  async flushPendingBinds() {
    while (this.#pendingSnapshotBind) {
      const current = this.#pendingSnapshotBind;
      await current;
      if (this.#pendingSnapshotBind === current) {
        this.#pendingSnapshotBind = null;
      }
    }
  }

  async ingestQueryMatches(
    app,
    parsed,
    { queryPid = null, queryToken = null, resolvedQueryApp = null } = {}
  ) {
    const existingMeta = this.getMeta(app);
    const parsedWinId = Number(parsed?.window_id);
    const queryWindowId =
      Number.isInteger(parsedWinId) && parsedWinId > 0 ? parsedWinId : null;
    const queryElements = new Map();
    if (Array.isArray(parsed?.matches)) {
      for (const m of parsed.matches) {
        if (m.index !== undefined) {
          const primaryText =
            m.title ||
            m.description ||
            (typeof m.value === "string" ? m.value : "") ||
            m.text ||
            "";
          const desc = buildElementDescriptor({
            index: m.index,
            role: m.role || "控件",
            primaryText,
            identifier: m.identifier || null,
            help: m.help || null,
            secondaryActions: m.secondary_actions,
            bounds: m.bounds ?? m.frame ?? null,
            windowId: queryWindowId,
            origin: "query",
            fallbackLabelToIdentifier: true,
            redactHelp: true,
            emptyRawTextAsNull: true,
          });
          queryElements.set(desc.index, desc);
        }
      }
    }

    const effectivePid = existingMeta?.pid || queryPid || null;
    const procIdentity =
      effectivePid > 0 && typeof this.#processIdentityFn === "function"
        ? await this.#processIdentityFn(effectivePid, { axBridge: this.#axBridge }).catch(() => null)
        : null;

    return this.recordMeta(
      app,
      {
        pid: effectivePid,
        bundleId: resolvedQueryApp?.bundleId || existingMeta?.bundleId || null,
        appDisplayName: resolvedQueryApp?.displayName || existingMeta?.appDisplayName || null,
        windowId: queryWindowId,
        windowTitle: parsed?.window_title || existingMeta?.windowTitle || null,
        elements: queryElements,
        elementsPartial: true,
      },
      {
        fromActionPeer: true,
        includeAx: true,
        includeScreenshot: false,
        preserveScreenshotState: true,
        processToken: procIdentity?.processToken || queryToken,
        source: "query",
      }
    );
  }

  async validateTargetRef({ app, parsedRef, refreshActionState = null } = {}) {
    const currentMeta = this.getMeta(app);
    const liveProc =
      currentMeta?.pid > 0 && typeof this.#processIdentityFn === "function"
        ? await this.#processIdentityFn(currentMeta.pid, { axBridge: this.#axBridge }).catch(
            () => null
          )
        : null;

    const refCheck = this.#ledger.validateRef({
      appKey: app,
      bundleId: currentMeta?.bundleId || null,
      parsedRef,
      currentPid: currentMeta?.pid || null,
      currentProcessToken: liveProc?.processToken || null,
      currentWindowId: currentMeta?.windowId || null,
      currentWindowTitle: currentMeta?.windowTitle || null,
    });
    if (!refCheck.ok) {
      if (refCheck.reason === "process_restarted") {
        this.#ledger.markAppStale(currentMeta?.bundleId || app, "process_restarted");
      }
      return {
        ok: false,
        stage: "ledger",
        errorCode: refCheck.errorCode,
        message: refCheck.message,
        currentSnapshotId: refCheck.currentSnapshotId,
        currentMeta,
      };
    }

    let validatedSnapshot = refCheck.snapshot || null;
    let validatedElement = refCheck.element || null;
    await this.flushPendingBinds();

    const isPinnedRef = Boolean(parsedRef.snapshotId);
    const isNativeQueryAlias =
      !isPinnedRef &&
      validatedElement?.origin === "query" &&
      Number(parsedRef.rawIndex) >= 1_000_000;

    if (
      !isNativeQueryAlias &&
      validatedSnapshot?.id &&
      this.#axBridge &&
      this.#axBridge.enabled !== false &&
      typeof this.#axBridge.verifyLiveRef === "function"
    ) {
      const callVerify = () =>
        this.#axBridge.verifyLiveRef({
          snapshotId: validatedSnapshot.id,
          elementIndex: parsedRef.hasElementRef ? parsedRef.rawIndex : null,
          expectedPid: currentMeta?.pid || null,
          requireBound: isPinnedRef,
        });

      let liveCheck = null;
      let verifyErr = null;
      try {
        liveCheck = await callVerify();
      } catch (err) {
        verifyErr = err;
      }

      const needsRebind =
        isPinnedRef &&
        (Boolean(verifyErr) ||
          liveCheck?.skipped === "snapshot_not_retained" ||
          liveCheck?.skipped === "element_not_bound");
      if (
        needsRebind &&
        typeof this.#axBridge.bindSnapshot === "function" &&
        (validatedSnapshot.pid || currentMeta?.pid) > 0
      ) {
        const targetElements =
          validatedSnapshot.elements?.size > 0
            ? validatedSnapshot.elements
            : validatedElement
              ? [validatedElement]
              : [];
        const rebound = await this.#axBridge
          .bindSnapshot({
            snapshotId: validatedSnapshot.id,
            pid: validatedSnapshot.pid || currentMeta.pid,
            windowTitle: validatedSnapshot.windowTitle,
            elements: targetElements,
          })
          .catch(() => null);
        if (rebound?.bound) {
          verifyErr = null;
          try {
            liveCheck = await callVerify();
          } catch (err2) {
            verifyErr = err2;
          }
        }
      }

      if (verifyErr) {
        if (isPinnedRef) {
          liveCheck = {
            ok: false,
            reason: "live_ax_verifier_failed",
            message: `Live AX verification failed for '${parsedRef.displayRef || validatedSnapshot.id}': ${verifyErr instanceof Error ? verifyErr.message : String(verifyErr)}`,
          };
        } else {
          // Unpinned ref: bridge timeout/error without affirmative mutation falls back cleanly to OCU peer
          liveCheck = { ok: true, skipped: "live_ax_verifier_unavailable" };
        }
      } else if (
        isPinnedRef &&
        (!liveCheck || liveCheck.ok !== true || Boolean(liveCheck.skipped))
      ) {
        liveCheck = {
          ok: false,
          reason: liveCheck?.reason || liveCheck?.skipped || "live_ax_unverified",
          message:
            liveCheck?.message ||
            `Snapshot ${validatedSnapshot.id} is no longer affirmatively bound in live AX memory for '${parsedRef.displayRef}'.`,
        };
      } else if (
        !isPinnedRef &&
        (liveCheck?.skipped === "snapshot_not_retained" ||
          liveCheck?.skipped === "element_not_bound")
      ) {
        // Unpinned ref when JXA did not retain/reach element (and window/app checks passed): allow dispatch
        liveCheck = { ok: true, skipped: liveCheck.skipped };
      }

      if (liveCheck && liveCheck.ok === false) {
        const appKeyForStale = currentMeta?.bundleId || app;
        this.#ledger.markAppStale(appKeyForStale, liveCheck.reason || "live_ax_invalidated");

        let recoveredUnpinnedMove = false;
        if (
          !parsedRef.snapshotId &&
          liveCheck.moved === true &&
          parsedRef.hasElementRef &&
          typeof refreshActionState === "function"
        ) {
          const refreshRes = await refreshActionState();
          await this.flushPendingBinds();
          if (!refreshRes?.isError) {
            const refreshedMeta = this.getMeta(app);
            const refreshedEl = refreshedMeta?.elements?.get(parsedRef.rawIndex) || null;
            if (
              refreshedEl &&
              validatedElement?.fingerprint &&
              refreshedEl.fingerprint === validatedElement.fingerprint
            ) {
              validatedSnapshot = this.#ledger.getLatest(appKeyForStale) || validatedSnapshot;
              validatedElement = refreshedEl;
              recoveredUnpinnedMove = true;
            }
          }
        }

        if (!recoveredUnpinnedMove) {
          const latestAfterRefresh = this.#ledger.getLatest(appKeyForStale);
          const suggestedSnapshotId =
            latestAfterRefresh && !latestAfterRefresh.stale ? latestAfterRefresh.id : null;
          return {
            ok: false,
            stage: "live_ax",
            errorCode: "STALE_REF",
            message:
              liveCheck.message ||
              `Target UI mutated asynchronously in the background after snapshot ${validatedSnapshot.id}.`,
            currentSnapshotId: suggestedSnapshotId,
            currentMeta,
          };
        }
      }
    }

    return { ok: true, snapshot: validatedSnapshot, element: validatedElement };
  }

  describeElement(app, elementIndex) {
    if (elementIndex === undefined || elementIndex === null) return "";
    const parsed = parseQualifiedElementRef(elementIndex);
    const rawIdx = parsed.ok && parsed.hasElementRef ? parsed.rawIndex : String(elementIndex);
    const meta = this.getMeta(app);
    const snap = parsed.ok && parsed.snapshotId ? this.#ledger.getSnapshot(parsed.snapshotId) : null;
    const el = snap?.elements?.get(rawIdx) || meta?.elements?.get(rawIdx);
    return el ? el.label : `元素 #${rawIdx}`;
  }

  resolveActionWindowPoint(app, args = {}, element = null) {
    const meta = this.getMeta(app);
    if (
      args?.windowPointPt &&
      Number.isFinite(Number(args.windowPointPt.x)) &&
      Number.isFinite(Number(args.windowPointPt.y))
    ) {
      return {
        windowPointPt: { x: Number(args.windowPointPt.x), y: Number(args.windowPointPt.y) },
        windowId: Number(args.windowId) > 0 ? Number(args.windowId) : meta?.windowId || null,
      };
    }
    const elBounds = normalizeElementBounds(element?.bounds);
    if (elBounds) {
      return {
        windowPointPt: { x: elBounds.x + elBounds.w / 2, y: elBounds.y + elBounds.h / 2 },
        windowId: element?.windowId || meta?.windowId || null,
      };
    }
    const winBounds = normalizeElementBounds(meta?.actionScreenshotMeta?.windowBounds || meta?.windowBounds);
    const px = Number(args?.x ?? args?.to_x);
    const py = Number(args?.y ?? args?.to_y);
    const fw = meta?.actionScreenshotMeta?.width || meta?.actionFrameWidth || 0;
    const fh = meta?.actionScreenshotMeta?.height || meta?.actionFrameHeight || 0;
    if (winBounds && Number.isFinite(px) && Number.isFinite(py) && fw > 0 && fh > 0) {
      return {
        windowPointPt: { x: (px * winBounds.w) / fw, y: (py * winBounds.h) / fh },
        windowId: meta?.actionScreenshotMeta?.windowId || meta?.windowId || null,
      };
    }
    return { windowPointPt: null, windowId: meta?.windowId || null };
  }

  resolveCursorNorm(app, args, fallbackDims = { width: 0, height: 0 }) {
    const meta = this.getMeta(app);
    const w = meta?.actionFrameWidth || fallbackDims.width || 0;
    const h = meta?.actionFrameHeight || fallbackDims.height || 0;
    if (Number.isFinite(args?.x) && Number.isFinite(args?.y) && w > 0 && h > 0) {
      return { normX: args.x / w, normY: args.y / h };
    }
    return { normX: null, normY: null };
  }

  buildRouteScope(meta, { snapshot = null, windowId = null } = {}) {
    return buildRouteScopeFromMeta(meta, { snapshot, windowId });
  }

  /**
   * Capture a live focused-window observation for an app, forwarding helper
   * and AX signals including excluded small/auxiliary window focus flags.
   */
  async captureWindowObservation(app, { pid: explicitPid = null, desktopHelperClient = null, preferredTitle = "" } = {}) {
    const meta = this.getMeta(app);
    return resolveFocusedWindowObservation({
      pid: explicitPid || meta?.pid || 0,
      windowTitle: preferredTitle || meta?.windowTitle || "",
      desktopHelperClient,
      axBridge: this.#axBridge,
      allowListWindowsFallback: false,
    });
  }

  /**
   * Compare pre- and post-action window observations to detect whether an action
   * opened or shifted focus to a previously unseen window ID.
   */
  detectNewWindowTransition(preObs, postObs) {
    const preWid = Number(preObs?.wid || 0);
    const postWid = Number(postObs?.wid || 0);
    if (!(preWid > 0) || !(postWid > 0) || postWid === preWid) {
      return false;
    }
    if (Array.isArray(preObs?.windowIds) && preObs.windowIds.length > 0) {
      return !preObs.windowIds.includes(postWid);
    }
    return true;
  }

  /**
   * Evaluate cached screenshot Same-Window Proof for an app name/key or meta record.
   */
  evaluateActionScreenshotProof(appOrMeta, options = {}) {
    const meta =
      typeof appOrMeta === "string" ? this.getMeta(appOrMeta) : appOrMeta || null;
    return evaluateScreenshotMetaProof(meta, options);
  }

  /**
   * Verify post-screenshot window observation against pre-shot state, image aspect ratio, and single-window invariance.
   */
  async proveScreenshotWindowObservation(
    app,
    {
      pid = null,
      imgDims = null,
      windowTitle = "",
      parsedWindowId = null,
      preObs = null,
      hadPrePid = false,
      desktopHelperClient = null,
    } = {}
  ) {
    const iw = Number(imgDims?.width || 0);
    const ih = Number(imgDims?.height || 0);
    if (!(Number(pid) > 0) || !(iw > 0) || !(ih > 0)) {
      return { proven: false, windowId: null, windowBounds: null, windowCount: null, singleWindowProven: false };
    }
    const obs = await this.captureWindowObservation(app, {
      pid,
      desktopHelperClient,
      preferredTitle: windowTitle || "",
    }).catch(() => null);
    const windowCount = Array.isArray(obs?.windowIds) ? obs.windowIds.length : null;
    const obsWid = Number(obs?.wid || 0);
    const parsedWid = Number(parsedWindowId || 0);
    const preWid = Number(preObs?.wid || 0);
    const preIds = Array.isArray(preObs?.windowIds)
      ? preObs.windowIds.map((x) => Number(x)).filter((x) => x > 0)
      : null;
    const preStable = Boolean(
      !(hadPrePid && !preWid && parsedWid === 0) &&
      !(preWid > 0 && obsWid > 0 && preWid !== obsWid) &&
        !(preIds && preIds.length > 0 && (preIds.length !== 1 || (obsWid > 0 && preIds[0] !== obsWid)))
    );
    const parsedWidMatches = !(parsedWid > 0 && obsWid > 0 && parsedWid !== obsWid);
    const cleanExpectedTitle = String(windowTitle || "").trim();
    const cleanObservedTitle = String(obs?.title || "").trim();
    const titleConsistent =
      !cleanExpectedTitle || !cleanObservedTitle || cleanExpectedTitle === cleanObservedTitle;
    if (obsWid > 0 && obs?.windowBounds) {
      const obW = Number(obs.windowBounds.width ?? obs.windowBounds.w ?? 0);
      const obH = Number(obs.windowBounds.height ?? obs.windowBounds.h ?? 0);
      if (
        obW > 0 &&
        obH > 0 &&
        hasMatchingAspectRatio(obW, obH, iw, ih, 0.03) &&
        windowCount === 1 &&
        Number(obs.windowIds[0]) === obsWid &&
        preStable &&
        obs?.focusedExcludedWindow !== true &&
        parsedWidMatches &&
        titleConsistent
      ) {
        return {
          proven: true,
          windowId: obsWid,
          windowBounds: obs.windowBounds,
          windowCount: 1,
          singleWindowProven: true,
        };
      }
    }
    return {
      proven: false,
      windowId: null,
      windowBounds: null,
      windowCount,
      singleWindowProven: false,
    };
  }

  recordObservedWindowTransition(app, meta, postObs) {
    const wid = Number(postObs?.wid || 0);
    if (!app || !(wid > 0)) return null;
    return this.recordMeta(
      app,
      {
        pid: meta?.pid || null,
        bundleId: meta?.bundleId || null,
        appDisplayName: meta?.appDisplayName || null,
        windowId: wid,
        windowTitle: postObs?.title || undefined,
        windowBounds: postObs?.windowBounds || undefined,
      },
      {
        fromActionPeer: false,
        includeAx: false,
        includeScreenshot: false,
        preserveScreenshotState: false,
      }
    );
  }
}
