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
    const lastImageDigest = imageDigest !== undefined ? imageDigest : prev.lastImageDigest || null;
    let nextTinyOverride = prev.tinyWindowOverride || null;
    const nextProcessToken = processToken !== undefined ? processToken : prev.processToken || null;
    let snapshotId = prev.snapshotId || null;

    const rawWinId = Number(meta.windowId);
    const parsedWinId = Number.isInteger(rawWinId) && rawWinId > 0 ? rawWinId : null;
    const windowChanged = Boolean(
      (meta.windowTitle && prev.windowTitle && meta.windowTitle !== prev.windowTitle) ||
        (parsedWinId && prev.windowId && parsedWinId !== prev.windowId)
    );

    if (fromActionPeer) {
      if (!includeAx) {
        elements = new Map();
        elementsPartial = false;
        actionHasAx = false;
      } else if (meta.elementsPartial || source === "query") {
        if (windowChanged) {
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
      if (!includeScreenshot && !preserveScreenshotState) {
        actionHasScreenshot = false;
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
        elements = meta.elements?.size ? meta.elements : windowChanged ? new Map() : elements;
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
        : windowChanged
          ? null
          : prev.windowId || null;
    const windowTitle = meta.windowTitle || prev.windowTitle || null;
    const appDisplayName = meta.appDisplayName || prev.appDisplayName || null;
    const explicitWinBounds = normalizeElementBounds(meta.windowBounds);
    const overrideWinBounds = normalizeElementBounds(nextTinyOverride?.bounds);
    const windowBounds =
      overrideWinBounds ||
      explicitWinBounds ||
      (windowChanged ? null : prev.windowBounds || null);

    if (fromActionPeer && includeAx) {
      if (windowChanged) {
        this.#ledger.markAppStale(bundleId || appQuery, "window_changed");
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

    let nextActionScreenshotMeta = windowChanged ? null : prev.actionScreenshotMeta || null;
    if (fromActionPeer && !includeScreenshot && !preserveScreenshotState) {
      nextActionScreenshotMeta = null;
    } else if (fromActionPeer && includeScreenshot && actionDims) {
      nextActionScreenshotMeta = {
        pid: pid || null,
        processToken: nextProcessToken || null,
        windowId: windowId || nextTinyOverride?.wid || null,
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
}
