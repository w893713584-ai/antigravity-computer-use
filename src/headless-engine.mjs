import { execFile } from "node:child_process";
import crypto from "node:crypto";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const MAX_SNAPSHOTS_PER_APP = 16;
const MAX_TOTAL_SNAPSHOTS = 64;
const PERMISSIONS_CACHE_TTL_MS = 10_000;
const STABLE_ELEMENT_LIMIT = 40;

const SAFE_TEXT_ROLES = new Set([
  "AXTextField",
  "AXTextArea",
  "AXSearchField",
  "AXComboBox",
]);

const SELF_ACTIVATING_TEXT_BUNDLE_RE = /^(?:com\.lemon\.lvpro|com\.google\.Chrome|com\.microsoft\.edgemac|org\.chromium\.Chromium)/iu;
const CJK_OR_NON_ASCII_RE = /[^\x20-\x7e]/u;

export const SNAPSHOT_REF_DOC =
  "Refs: snapshots include `[Snapshot: sN]`. You may pass `@sN:index` inside `element_index` for stale-ref protection (`STALE_REF` on UI change).";

/**
 * Parse an element reference such as `"12"`, `12`, `"@s3:12"`, or `("12", "s3")`.
 */
export function parseQualifiedElementRef(rawElementIndex, explicitSnapshotId = null) {
  if (rawElementIndex === undefined || rawElementIndex === null || rawElementIndex === "") {
    return {
      ok: true,
      hasElementRef: false,
      snapshotId: normalizeSnapshotId(explicitSnapshotId),
      rawIndex: null,
      displayRef: "",
    };
  }

  const explicitSnap = normalizeSnapshotId(explicitSnapshotId);
  if (explicitSnapshotId !== null && explicitSnapshotId !== undefined && explicitSnapshotId !== "" && !explicitSnap) {
    return {
      ok: false,
      errorCode: "INVALID_ARGS",
      message: `Invalid snapshot_id '${String(explicitSnapshotId)}'. Expected format 'sN'.`,
    };
  }

  if (typeof rawElementIndex === "number") {
    if (!Number.isSafeInteger(rawElementIndex) || rawElementIndex < 0) {
      return {
        ok: false,
        errorCode: "INVALID_ARGS",
        message: `Invalid element_index '${rawElementIndex}'. Expected non-negative integer.`,
      };
    }
    const rawIndex = String(rawElementIndex);
    return {
      ok: true,
      hasElementRef: true,
      snapshotId: explicitSnap,
      rawIndex,
      displayRef: explicitSnap ? `@${explicitSnap}:${rawIndex}` : rawIndex,
    };
  }

  const trimmed = String(rawElementIndex).trim();
  if (trimmed.startsWith("@")) {
    const m = /^@(s\d+):(\d+)$/iu.exec(trimmed);
    if (!m) {
      return {
        ok: false,
        errorCode: "INVALID_ARGS",
        message: `Invalid qualified element ref '${trimmed}'. Expected format '@sN:index' (e.g. '@s3:12').`,
      };
    }
    const refSnap = m[1].toLowerCase();
    const rawIndex = m[2];
    if (explicitSnap && explicitSnap !== refSnap) {
      return {
        ok: false,
        errorCode: "INVALID_ARGS",
        message: `Conflicting snapshot references '${refSnap}' and '${explicitSnap}'.`,
      };
    }
    return {
      ok: true,
      hasElementRef: true,
      snapshotId: refSnap,
      rawIndex,
      displayRef: `@${refSnap}:${rawIndex}`,
    };
  }

  if (!/^\d+$/u.test(trimmed)) {
    return {
      ok: false,
      errorCode: "INVALID_ARGS",
      message: `Invalid element_index '${trimmed}'. Expected numeric index or '@sN:index'.`,
    };
  }

  return {
    ok: true,
    hasElementRef: true,
    snapshotId: explicitSnap,
    rawIndex: trimmed,
    displayRef: explicitSnap ? `@${explicitSnap}:${trimmed}` : trimmed,
  };
}

export function normalizeSnapshotId(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  return /^s\d+$/u.test(trimmed) ? trimmed : null;
}

/**
 * Strip broker-only ref qualification (`@sN:`) & `snapshot_id` before sending to OpenComputerUse.
 */
export function sanitizeToolArgsForNative(args = {}, parsedRef = null) {
  const clean = { ...args };
  delete clean.snapshot_id;
  if (parsedRef?.hasElementRef) {
    clean.element_index =
      typeof args.element_index === "number" ? Number(parsedRef.rawIndex) : parsedRef.rawIndex;
  }
  return clean;
}

/**
 * Build a structural signature for UI change detection across snapshots.
 * Focuses on window identity + element roles/IDs rather than mutable text field values.
 */
export function computeSnapshotSignature(meta = {}) {
  const elements = meta.elements instanceof Map ? meta.elements : new Map();
  const sample = [];
  for (const [idx, el] of elements.entries()) {
    if (sample.length >= STABLE_ELEMENT_LIMIT) break;
    sample.push(`${idx}:${el.fingerprint || el.role || ""}`);
  }
  return {
    windowTitle: meta.windowTitle || "",
    elementCount: elements.size,
    sample,
  };
}

function filterStructuralElements(elements) {
  const filtered = new Map();
  if (!(elements instanceof Map)) return filtered;
  for (const [idx, el] of elements.entries()) {
    const num = Number(idx);
    if (el?.origin === "query" || (Number.isFinite(num) && num >= 1_000_000)) {
      continue;
    }
    filtered.set(idx, el);
  }
  return filtered;
}

/**
 * Detect whether a UI transition occurred between two snapshots of the same app
 * strong enough that old `@sK:index` refs should fail closed with `STALE_REF`.
 */
export function didUiStructurallyChange(prevSnap, nextSnap) {
  if (!prevSnap || !nextSnap) return false;
  if (prevSnap.pid && nextSnap.pid && prevSnap.pid !== nextSnap.pid) return true;
  if (
    prevSnap.processToken &&
    nextSnap.processToken &&
    prevSnap.processToken !== nextSnap.processToken
  ) {
    return true;
  }
  if (prevSnap.windowId && nextSnap.windowId && prevSnap.windowId !== nextSnap.windowId) {
    return true;
  }
  if ((prevSnap.windowTitle || "") !== (nextSnap.windowTitle || "")) {
    return true;
  }

  const prevEls = filterStructuralElements(prevSnap.elements);
  const nextEls = filterStructuralElements(nextSnap.elements);
  if (prevSnap.source === "query" && prevEls.size === 0) {
    return false;
  }
  if (!prevEls.size || !nextEls.size) {
    return Boolean(prevEls.size !== nextEls.size && Math.max(prevEls.size, nextEls.size) >= 3);
  }

  const prevCount = prevEls.size;
  const nextCount = nextEls.size;
  if (Math.abs(nextCount - prevCount) >= Math.max(3, Math.ceil(prevCount * 0.25))) {
    return true;
  }

  let compared = 0;
  let mismatched = 0;
  for (const [idx, prevEl] of prevEls.entries()) {
    compared += 1;
    const nextEl = nextEls.get(idx);
    if (!nextEl || !elementsHaveSameIdentity(prevEl, nextEl)) {
      mismatched += 1;
    }
    if (compared >= STABLE_ELEMENT_LIMIT) break;
  }

  if (compared > 0 && mismatched / compared >= 0.25) {
    return true;
  }
  return false;
}

export function elementsHaveSameIdentity(a, b) {
  if (!a || !b) return false;
  if ((a.role || "") !== (b.role || "")) return false;
  if (a.identifier && b.identifier && a.identifier !== b.identifier) return false;
  if (a.identifier && !b.identifier) return false;
  if (!a.identifier && b.identifier) return false;
  // For containers/text inputs whose value/title naturally mutates as the user edits, role+id match suffices;
  // for buttons/menu items/tabs without identifier, require matching static fingerprint.
  if (!a.identifier && (a.fingerprint || "") !== (b.fingerprint || "")) {
    return false;
  }
  return true;
}

/**
 * Snapshot Ledger tracking monotonic `s1`, `s2`, ... IDs, element fingerprints,
 * and fail-closed `STALE_REF` verification.
 */
export class SnapshotLedger {
  #seq = 0;
  #byId = new Map();
  #byApp = new Map();

  #normKey(appKey) {
    return typeof appKey === "string" ? appKey.trim().toLowerCase() : "";
  }

  getLatest(appKey) {
    const key = this.#normKey(appKey);
    const list = key ? this.#byApp.get(key) : null;
    if (!list?.length) return null;
    return list[list.length - 1];
  }

  getSnapshot(snapshotId) {
    const id = normalizeSnapshotId(snapshotId);
    return id ? this.#byId.get(id) || null : null;
  }

  issueSnapshot({
    appKey,
    bundleId = null,
    pid = null,
    processToken = null,
    windowId = null,
    windowTitle = null,
    frameWidth = 0,
    frameHeight = 0,
    elements = new Map(),
    elementsPartial = false,
    source = "snapshot",
  }) {
    const key = this.#normKey(bundleId || appKey);
    if (!key) return null;

    this.#seq += 1;
    const id = `s${this.#seq}`;
    const prev = this.getLatest(key);
    const nextWindowId = Number.isInteger(windowId) && windowId > 0 ? windowId : null;
    const prevWindowChanged = Boolean(
      prev &&
        ((nextWindowId && prev.windowId && nextWindowId !== prev.windowId) ||
          (windowTitle && prev.windowTitle && windowTitle !== prev.windowTitle))
    );

    // For partial `query` results on the same window, merge matching nodes with latest active elements so sibling indexes remain usable.
    const storedElements = new Map();
    if (source === "query" && prev?.elements?.size && !prev.stale && !prevWindowChanged) {
      for (const [k, v] of prev.elements.entries()) {
        storedElements.set(k, v);
      }
    }
    if (elements instanceof Map) {
      for (const [k, v] of elements.entries()) {
        storedElements.set(String(k), v);
      }
    }

    const record = {
      id,
      appKey: key,
      bundleId,
      pid: pid || null,
      processToken: processToken || null,
      windowId: nextWindowId,
      windowTitle: windowTitle || null,
      frameWidth: frameWidth || 0,
      frameHeight: frameHeight || 0,
      elements: storedElements,
      elementsPartial: Boolean(elementsPartial) || source === "query",
      source,
      createdAt: Date.now(),
      stale: false,
      staleReason: null,
      supersededBy: null,
      uiChangedSinceCapture: false,
    };

    if (prev && (source === "snapshot" || prevWindowChanged)) {
      const uiChanged = source === "snapshot" ? didUiStructurallyChange(prev, record) : false;
      const staleReason = prevWindowChanged ? "window_changed" : "ui_changed";
      const list = this.#byApp.get(key) || [];
      for (const older of list) {
        if (!older.supersededBy) older.supersededBy = id;
        if ((uiChanged || prevWindowChanged) && !older.stale) {
          older.stale = true;
          older.staleReason = staleReason;
          older.uiChangedSinceCapture = true;
        }
      }
    }

    let list = this.#byApp.get(key) || [];
    list.push(record);
    if (list.length > MAX_SNAPSHOTS_PER_APP) {
      const dropped = list.shift();
      if (dropped) this.#byId.delete(dropped.id);
    }
    this.#byApp.set(key, list);
    this.#byId.set(id, record);

    while (this.#byId.size > MAX_TOTAL_SNAPSHOTS) {
      const oldestKey = this.#byId.keys().next().value;
      if (!oldestKey) break;
      const oldest = this.#byId.get(oldestKey);
      this.#byId.delete(oldestKey);
      if (oldest) {
        const appList = this.#byApp.get(oldest.appKey);
        if (appList) {
          const idx = appList.indexOf(oldest);
          if (idx >= 0) appList.splice(idx, 1);
        }
      }
    }

    return record;
  }

  markAppStale(appKey, reason = "ui_changed") {
    const key = this.#normKey(appKey);
    const list = key ? this.#byApp.get(key) : null;
    if (!list) return;
    for (const snap of list) {
      snap.stale = true;
      snap.staleReason = snap.staleReason || reason;
    }
  }

  clearApp(appKey) {
    const key = this.#normKey(appKey);
    const list = key ? this.#byApp.get(key) : null;
    if (!list) return;
    for (const snap of list) {
      this.#byId.delete(snap.id);
    }
    this.#byApp.delete(key);
  }

  validateRef({
    appKey,
    bundleId = null,
    parsedRef,
    currentPid = null,
    currentProcessToken = null,
    currentWindowId = null,
    currentWindowTitle = null,
  }) {
    if (!parsedRef?.ok) {
      return {
        ok: false,
        errorCode: parsedRef?.errorCode || "INVALID_ARGS",
        message: parsedRef?.message || "Invalid element reference.",
        currentSnapshotId: this.getLatest(bundleId || appKey)?.id || null,
      };
    }

    const key = this.#normKey(bundleId || appKey);
    const latest = this.getLatest(key) || this.getLatest(appKey);
    const hasExplicitSnap = Boolean(parsedRef.snapshotId);
    const snap = hasExplicitSnap ? this.getSnapshot(parsedRef.snapshotId) : latest;

    if (hasExplicitSnap) {
      if (!snap) {
        return {
          ok: false,
          errorCode: "STALE_REF",
          reason: "snapshot_not_found",
          message: `Snapshot '${parsedRef.snapshotId}' is expired or unknown.`,
          currentSnapshotId: latest?.id || null,
        };
      }
      if (key && snap.appKey !== key && this.#normKey(appKey) && snap.appKey !== this.#normKey(appKey)) {
        return {
          ok: false,
          errorCode: "STALE_REF",
          reason: "snapshot_app_mismatch",
          message: `Ref '${parsedRef.displayRef}' belongs to '${snap.appKey}', not '${bundleId || appKey}'.`,
          currentSnapshotId: latest?.id || null,
        };
      }
    }

    if (!snap) {
      return { ok: true, snapshot: null, element: null, rawIndex: parsedRef.rawIndex };
    }

    if (currentPid && snap.pid && currentPid !== snap.pid) {
      return {
        ok: false,
        errorCode: "STALE_REF",
        reason: "pid_changed",
        message: `Target process PID changed (${snap.pid} -> ${currentPid}) after snapshot ${snap.id}.`,
        currentSnapshotId: latest?.id || null,
      };
    }

    if (currentProcessToken && snap.processToken && currentProcessToken !== snap.processToken) {
      return {
        ok: false,
        errorCode: "STALE_REF",
        reason: "process_restarted",
        message: `Target app restarted (PID ${snap.pid} recycled) after snapshot ${snap.id}.`,
        currentSnapshotId: latest?.id || null,
      };
    }

    if (
      currentWindowId &&
      snap.windowId &&
      currentWindowId !== snap.windowId
    ) {
      return {
        ok: false,
        errorCode: "STALE_REF",
        reason: "window_changed",
        message: `Window ID changed (${snap.windowId} -> ${currentWindowId}) since snapshot ${snap.id}.`,
        currentSnapshotId: latest?.id || null,
      };
    }

    if (
      currentWindowTitle &&
      snap.windowTitle &&
      currentWindowTitle !== snap.windowTitle
    ) {
      return {
        ok: false,
        errorCode: "STALE_REF",
        reason: "window_changed",
        message: `Window changed ('${snap.windowTitle}' -> '${currentWindowTitle}') since snapshot ${snap.id}.`,
        currentSnapshotId: latest?.id || null,
      };
    }

    if (snap.stale) {
      return {
        ok: false,
        errorCode: "STALE_REF",
        reason: snap.staleReason || "ui_changed",
        message: `Snapshot '${snap.id}' is stale (${snap.staleReason || "UI changed"}) for ref '${parsedRef.displayRef}'.`,
        currentSnapshotId: latest?.id || null,
      };
    }

    // If explicitly referencing an older non-stale snapshot, verify element identity still matches latest.
    if (hasExplicitSnap && latest && snap.id !== latest.id && parsedRef.hasElementRef) {
      const oldEl = snap.elements.get(parsedRef.rawIndex);
      const newEl = latest.elements.get(parsedRef.rawIndex);
      if (oldEl && (newEl ? !elementsHaveSameIdentity(oldEl, newEl) : !latest.elementsPartial)) {
        return {
          ok: false,
          errorCode: "STALE_REF",
          reason: "element_drifted",
          message: `Element ${parsedRef.displayRef} (${oldEl.label || oldEl.role}) changed or disappeared in snapshot ${latest.id}.`,
          currentSnapshotId: latest.id,
        };
      }
    }

    const element = parsedRef.hasElementRef ? snap.elements.get(parsedRef.rawIndex) || null : null;
    if (element?.windowId && currentWindowId && element.windowId !== currentWindowId) {
      return {
        ok: false,
        errorCode: "STALE_REF",
        reason: "window_changed",
        message: `Element '${parsedRef.displayRef}' belongs to window ${element.windowId}, current window is ${currentWindowId}.`,
        currentSnapshotId: latest?.id || snap.id,
      };
    }
    if (parsedRef.hasElementRef && !element) {
      if (snap.elements.size > 0 && !snap.elementsPartial && (hasExplicitSnap || snap.source === "snapshot")) {
        return {
          ok: false,
          errorCode: "STALE_REF",
          reason: "element_not_in_snapshot",
          message: `Element '${parsedRef.displayRef}' was not found in snapshot ${snap.id}.`,
          currentSnapshotId: latest?.id || snap.id,
        };
      }
      if (!hasExplicitSnap && snap.elementsPartial) {
        const appSnaps = this.#byApp.get(key) || [];
        const crossWinMatch = [...appSnaps].reverse().find((s) => {
          if (s.id === snap.id || !s.elements?.has(parsedRef.rawIndex)) return false;
          const oldEl = s.elements.get(parsedRef.rawIndex);
          return Boolean(
            (s.windowId && snap.windowId && s.windowId !== snap.windowId) ||
              (oldEl?.windowId && snap.windowId && oldEl.windowId !== snap.windowId) ||
              s.staleReason === "window_changed"
          );
        });
        if (crossWinMatch || Number(parsedRef.rawIndex) >= 1_000_000) {
          return {
            ok: false,
            errorCode: "STALE_REF",
            reason: crossWinMatch ? "window_changed" : "element_not_in_snapshot",
            message: crossWinMatch
              ? `Element '${parsedRef.displayRef}' belonged to a previous window (${crossWinMatch.windowId || "prior"}).`
              : `Query element '${parsedRef.displayRef}' is no longer present in current snapshot ${snap.id}.`,
            currentSnapshotId: latest?.id || snap.id,
          };
        }
      }
    }

    return {
      ok: true,
      snapshot: snap,
      element,
      rawIndex: parsedRef.rawIndex,
    };
  }
}

export function buildStaleRefToolResult({ errorCode = "STALE_REF", message, currentSnapshotId = null }) {
  const hint = currentSnapshotId
    ? `请先调用 get_app_state 或 query 获取最新元素索引（当前最新快照为 ${currentSnapshotId}），再使用新的 @${currentSnapshotId}:index 重试。`
    : "请先调用 get_app_state 或 query 刷新当前界面快照后再重试。";
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: `[ErrorCode: ${errorCode} | Delivery: not_delivered | RetrySafe: true]\n${message}\n${hint}`,
      },
    ],
  };
}

export { SelfActivationTracker } from "./focus-policy-guard.mjs";

function extractSemanticFieldValue(rawText) {
  if (rawText === null || rawText === undefined) return null;
  const s = String(rawText);
  const quotedMatch = /^(?:[\s\S]*?\b)?Value:\s*"([\s\S]*)"$/u.exec(s);
  if (quotedMatch) return quotedMatch[1];
  const plainMatch = /^Value:\s*([\s\S]*)$/u.exec(s);
  if (plainMatch) return plainMatch[1];
  return s;
}

/**
 * Normalize and compare expected `set_value` against observed snapshot text (redacting secure fields).
 */
export function verifySetValueObservation({
  expectedValue,
  postElement = null,
  preElement = null,
  readBackText = "",
  isSecure = false,
}) {
  if (isSecure || preElement?.isSecure || postElement?.isSecure) {
    return {
      verified: null,
      redacted: true,
      note: "Secure field write completed [value redacted]",
    };
  }
  const want = String(expectedValue ?? "");
  const observedRaw = postElement?.rawText ?? postElement?.valueText ?? null;
  if (observedRaw !== null) {
    const obsVal = extractSemanticFieldValue(observedRaw);
    if (want.length === 0) {
      return {
        verified: obsVal === "",
        redacted: false,
        observed: obsVal,
      };
    }
    if (obsVal === want) {
      return { verified: true, redacted: false, observed: obsVal };
    }
    return { verified: false, redacted: false, observed: obsVal };
  }
  return { verified: null, redacted: false, observed: null };
}

/**
 * Compute a lightweight SHA-256 digest of a frame buffer for visual-change verification.
 */
export function computeFrameDigest(bytes) {
  if (!bytes || !bytes.length) return null;
  return crypto.createHash("sha256").update(bytes).digest("hex").slice(0, 16);
}

/**
 * Check macOS process start-time generation via warm `axBridge` (~0.9ms) or `/bin/ps` fallback
 * (zero WindowServer/AppKit activation).
 */
export async function getProcessIdentity(pid, { axBridge = null } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform !== "darwin") {
    return { pid, startTimeText: null, processToken: `${pid}:non-darwin` };
  }
  if (axBridge && typeof axBridge.getProcessInfo === "function") {
    try {
      const info = await axBridge.getProcessInfo(pid);
      if (info?.alive && info?.processToken) {
        return {
          pid,
          startTimeText: String(info.launchTs ?? ""),
          processToken: info.processToken,
          bundleId: info.bundleId || null,
          displayName: info.displayName || null,
        };
      }
      if (info && info.guiApp === true && info.alive === false) {
        return null;
      }
    } catch {}
  }
  try {
    const { stdout } = await execFileAsync("/bin/ps", ["-p", String(pid), "-o", "pid=,lstart="], {
      timeout: 1200,
    });
    const line = String(stdout || "").trim();
    if (!line) return null;
    const match = /^(\d+)\s+(.+)$/u.exec(line);
    if (!match || Number.parseInt(match[1], 10) !== pid) return null;
    const startTimeText = match[2].trim();
    return {
      pid,
      startTimeText,
      processToken: `${pid}:${startTimeText}`,
    };
  } catch {
    return null;
  }
}

let cachedPermissions = null;
let cachedPermissionsAt = 0;

/**
 * Check macOS TCC permissions (Accessibility + Screen Recording) WITHOUT triggering system prompts.
 */
export async function checkMacPermissions({ forceRefresh = false, axBridge = null } = {}) {
  if (process.platform !== "darwin") {
    return { platform: process.platform, accessibility: null, screenRecording: null, checkedAt: Date.now() };
  }
  if (!forceRefresh && cachedPermissions && Date.now() - cachedPermissionsAt < PERMISSIONS_CACHE_TTL_MS) {
    return cachedPermissions;
  }
  if (axBridge && typeof axBridge.checkPermissions === "function") {
    try {
      const parsed = await axBridge.checkPermissions();
      cachedPermissions = {
        platform: "darwin",
        accessibility: typeof parsed?.accessibility === "boolean" ? parsed.accessibility : null,
        screenRecording: typeof parsed?.screenRecording === "boolean" ? parsed.screenRecording : null,
        checkedAt: Date.now(),
      };
      cachedPermissionsAt = Date.now();
      return cachedPermissions;
    } catch {}
  }
  const script = [
    'ObjC.import("ApplicationServices");',
    'ObjC.import("CoreGraphics");',
    'var ax = typeof $.AXIsProcessTrusted === "function" ? Boolean($.AXIsProcessTrusted()) : null;',
    'var sr = null;',
    'try { ObjC.bindFunction("CGPreflightScreenCaptureAccess", ["bool", []]); sr = Boolean($.CGPreflightScreenCaptureAccess()); } catch (e) {}',
    'JSON.stringify({ accessibility: ax, screenRecording: sr });',
  ].join("\n");
  try {
    const { stdout } = await execFileAsync("/usr/bin/osascript", ["-l", "JavaScript", "-e", script], {
      timeout: 2500,
    });
    const parsed = JSON.parse(String(stdout || "{}").trim() || "{}");
    cachedPermissions = {
      platform: "darwin",
      accessibility: typeof parsed.accessibility === "boolean" ? parsed.accessibility : null,
      screenRecording: typeof parsed.screenRecording === "boolean" ? parsed.screenRecording : null,
      checkedAt: Date.now(),
    };
    cachedPermissionsAt = Date.now();
    return cachedPermissions;
  } catch {
    return (
      cachedPermissions || {
        platform: "darwin",
        accessibility: null,
        screenRecording: null,
        checkedAt: Date.now(),
      }
    );
  }
}

/**
 * Silently wake lazy Chromium / Electron web accessibility trees (`AXManualAccessibility = true`)
 * without touching `AXEnhancedUserInterface` or activating any window.
 */
export async function ensureRendererAccessibility(pid, { axBridge = null } = {}) {
  if (process.platform !== "darwin" || !Number.isInteger(pid) || pid <= 0) {
    return { supported: false, changed: false, enabled: false, definitive: false };
  }
  if (axBridge && axBridge.enabled !== false && typeof axBridge.ensureManualAccessibility === "function") {
    try {
      const res = await axBridge.ensureManualAccessibility(pid);
      if (res) return res;
    } catch {}
  }
  return { supported: false, changed: false, enabled: false, definitive: false };
}

/**
 * Resolve a running GUI app's live PID, bundleId, and launch generation token via `NSWorkspace`
 * (used when `query` runs on a cold cache before `get_app_state`).
 */
export async function resolveRunningAppIdentity(appQuery, { axBridge = null } = {}) {
  if (process.platform !== "darwin" || typeof appQuery !== "string" || !appQuery.trim()) {
    return null;
  }
  if (axBridge && axBridge.enabled !== false && typeof axBridge.findRunningApp === "function") {
    try {
      const info = await axBridge.findRunningApp(appQuery.trim());
      if (info?.pid > 0) return info;
    } catch {}
  }
  return null;
}

const EDITABLE_META_ROLE_RE =
  /AXTextField|AXTextArea|AXSearchField|AXComboBox|text\s*field|text\s*area|search\s*(?:text\s*)?field|combo\s*box|文本框|文本区|文本域|搜索框|输入框|组合框/iu;
const MULTILINE_META_ROLE_RE = /AXTextArea|text\s*area|文本区|文本域/iu;

/**
 * Verify that `AXFocusedUIElement` inside `pid` is an editable non-secure text control
 * BEFORE firing destructive `Cmd+A` + `BackSpace` in `set_value:sky_bypass`.
 */
export async function verifyEditableTextFocus(
  pid,
  { axBridge = null, snapshotId = null, elementIndex = null, fallbackElementMeta = null } = {}
) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return { editable: false, role: null, singleLine: false, reason: "invalid_pid" };
  }
  if (axBridge && axBridge.enabled !== false && typeof axBridge.verifyEditableFocus === "function") {
    try {
      const res = await axBridge.verifyEditableFocus(pid, {
        snapshotId,
        elementIndex,
        elementMeta: fallbackElementMeta,
      });
      if (res && typeof res.editable === "boolean") {
        return res;
      }
    } catch {
      return { editable: false, role: null, singleLine: false, reason: "bridge_error" };
    }
  }
  // When `axBridge` is explicitly disabled (synthetic unit-test peer), validate via snapshot element metadata
  if (axBridge?.enabled === false || (axBridge && typeof axBridge.verifyEditableFocus !== "function")) {
    if (!fallbackElementMeta || fallbackElementMeta.isSecure) {
      return { editable: false, role: fallbackElementMeta?.role || null, singleLine: false, reason: "missing_or_secure_meta" };
    }
    const roleStr = String(fallbackElementMeta.role || "");
    const editable = EDITABLE_META_ROLE_RE.test(roleStr);
    return {
      editable,
      role: roleStr || null,
      singleLine: editable ? !MULTILINE_META_ROLE_RE.test(roleStr) : false,
      reason: editable ? "meta_verified" : "non_editable_meta_role",
    };
  }
  return { editable: false, role: null, singleLine: false, reason: "unavailable" };
}

export function shouldAttemptSelectedTextFastPath(appKey, text) {
  if (typeof text !== "string" || !text.length) return false;
  if (!CJK_OR_NON_ASCII_RE.test(text)) return false;
  if (appKey && SELF_ACTIVATING_TEXT_BUNDLE_RE.test(String(appKey).trim())) return false;
  return true;
}

/**
 * Headless macOS `AXSelectedText` insertion (inspired by `agent-desktop`'s `type_text.rs`).
 * Only succeeds when the target PID's `AXFocusedUIElement` is an editable, non-secure text control
 * whose `AXSelectedText` attribute is explicitly settable AND readback confirms the write stuck.
 */
export async function tryHeadlessSelectedTextInsert(pid, text, { axBridge = null, beforeWriteCheck = null } = {}) {
  if (process.platform !== "darwin") return { delivered: false, verified: false, reason: "non_darwin" };
  if (!Number.isInteger(pid) || pid <= 0 || typeof text !== "string" || !text.length) {
    return { delivered: false, verified: false, reason: "invalid_args" };
  }
  if (typeof beforeWriteCheck === "function") {
    beforeWriteCheck();
  }
  if (axBridge && typeof axBridge.insertSelectedText === "function") {
    try {
      const res = await axBridge.insertSelectedText(pid, text, { beforeWriteCheck });
      if (res) return res;
    } catch (err) {
      if (err?.aborted) throw err;
    }
  }
  const textLiteral = JSON.stringify(text);
  const safeRolesLiteral = JSON.stringify(Array.from(SAFE_TEXT_ROLES));
  const script = `
    ObjC.import("ApplicationServices");
    ObjC.import("Foundation");
    var pid = ${pid};
    var text = ${textLiteral};
    var allowedRoles = ${safeRolesLiteral};
    var appEl = $.AXUIElementCreateApplication(pid);
    var focusOut = Ref();
    if ($.AXUIElementCopyAttributeValue(appEl, $("AXFocusedUIElement"), focusOut) !== 0 || !focusOut[0]) {
      JSON.stringify({ delivered: false, verified: false, reason: "no_focused_element" });
    } else {
      var focused = ObjC.castRefToObject(focusOut[0]);
      var roleOut = Ref();
      var role = null;
      if ($.AXUIElementCopyAttributeValue(focused, $("AXRole"), roleOut) === 0 && roleOut[0]) {
        role = ObjC.unwrap(ObjC.castRefToObject(roleOut[0]));
      }
      if (!role || allowedRoles.indexOf(role) < 0) {
        JSON.stringify({ delivered: false, verified: false, reason: "unsupported_role", role: role });
      } else {
        var settableRef = Ref();
        var canSetErr = $.AXUIElementIsAttributeSettable(focused, $("AXSelectedText"), settableRef);
        if (canSetErr !== 0 || !settableRef[0]) {
          JSON.stringify({ delivered: false, verified: false, reason: "not_settable", role: role });
        } else {
          var beforeValOut = Ref();
          var beforeVal = ($.AXUIElementCopyAttributeValue(focused, $("AXValue"), beforeValOut) === 0 && beforeValOut[0])
            ? String(ObjC.unwrap(ObjC.castRefToObject(beforeValOut[0])) || "")
            : null;
          var setErr = $.AXUIElementSetAttributeValue(focused, $("AXSelectedText"), $(text));
          if (setErr !== 0) {
            JSON.stringify({ delivered: false, verified: false, reason: "ax_set_error", code: Number(setErr) });
          } else {
            var afterValOut = Ref();
            var afterVal = ($.AXUIElementCopyAttributeValue(focused, $("AXValue"), afterValOut) === 0 && afterValOut[0])
              ? String(ObjC.unwrap(ObjC.castRefToObject(afterValOut[0])) || "")
              : null;
            var verified = afterVal !== null && (afterVal.indexOf(text) >= 0 || afterVal !== beforeVal);
            JSON.stringify({ delivered: true, verified: Boolean(verified), reason: verified ? "ok" : "unverified" });
          }
        }
      }
    }
  `;
  try {
    const { stdout } = await execFileAsync("/usr/bin/osascript", ["-l", "JavaScript", "-e", script], {
      timeout: 2500,
    });
    return JSON.parse(String(stdout || "{}").trim() || '{"delivered":false,"verified":false}');
  } catch {
    return { delivered: false, verified: false, reason: "exec_failed" };
  }
}

/**
 * Headless macOS `AXScrollBar` semantic scroll fallback (inspired by `agent-desktop`'s `scroll.rs`).
 * Walks visible/matching AXScrollArea elements of `pid` and drives `AXIncrement` / `AXDecrement`
 * or `AXValue` shift in the background without activating the window or moving the OS cursor.
 */
export async function tryHeadlessBackgroundScroll(
  pid,
  elementMeta,
  direction = "down",
  pages = 1,
  { axBridge = null, snapshotId = null, elementIndex = null, beforeWriteCheck = null } = {}
) {
  if (process.platform !== "darwin") return { delivered: false, verified: false, reason: "non_darwin" };
  if (!Number.isInteger(pid) || pid <= 0) {
    return { delivered: false, verified: false, reason: "invalid_pid" };
  }
  if (typeof beforeWriteCheck === "function") {
    beforeWriteCheck();
  }
  if (axBridge && typeof axBridge.scroll === "function") {
    try {
      const res = await axBridge.scroll(pid, {
        snapshotId,
        elementIndex,
        elementMeta,
        direction,
        pages,
        beforeWriteCheck,
      });
      if (res) return res;
    } catch (err) {
      if (err?.aborted) throw err;
    }
  }
  const dir = String(direction || "down").toLowerCase();
  const isVertical = dir === "up" || dir === "down";
  const barAttr = isVertical ? "AXVerticalScrollBar" : "AXHorizontalScrollBar";
  const stepAction = dir === "down" || dir === "right" ? "AXIncrement" : "AXDecrement";
  const sign = dir === "down" || dir === "right" ? 1 : -1;
  const pageAmount = Math.max(0.1, Math.min(10, Number(pages) || 1));
  const targetId = elementMeta?.identifier ? JSON.stringify(elementMeta.identifier) : "null";

  const script = `
    ObjC.import("ApplicationServices");
    ObjC.import("Foundation");
    var pid = ${pid};
    var barAttr = ${JSON.stringify(barAttr)};
    var stepAction = ${JSON.stringify(stepAction)};
    var sign = ${sign};
    var pageAmount = ${pageAmount};
    var targetId = ${targetId};
    var appEl = $.AXUIElementCreateApplication(pid);

    function readAttr(el, name) {
      var out = Ref();
      if ($.AXUIElementCopyAttributeValue(el, $(name), out) === 0 && out[0]) {
        return ObjC.castRefToObject(out[0]);
      }
      return null;
    }

    function readStr(el, name) {
      var obj = readAttr(el, name);
      return obj ? String(ObjC.unwrap(obj) || "") : "";
    }

    function findScrollBarInSubtree(root, maxVisits) {
      var queue = [root];
      var visits = 0;
      var matchedArea = null;
      var anyAreaBar = null;
      while (queue.length > 0 && visits < maxVisits) {
        var cur = queue.shift();
        visits += 1;
        var bar = readAttr(cur, barAttr);
        if (bar) {
          if (!anyAreaBar) anyAreaBar = bar;
          if (targetId && (readStr(cur, "AXIdentifier") === targetId || readStr(cur, "AXDOMIdentifier") === targetId)) {
            matchedArea = bar;
            break;
          }
          if (!targetId && readStr(cur, "AXRole") === "AXScrollArea") {
            matchedArea = bar;
            break;
          }
        }
        var ch = readAttr(cur, "AXChildren");
        if (ch && ch.count) {
          var limit = Math.min(Number(ch.count), 40);
          for (var i = 0; i < limit; i++) {
            queue.push(ch.objectAtIndex(i));
          }
        }
      }
      return matchedArea || anyAreaBar;
    }

    var win = readAttr(appEl, "AXMainWindow") || readAttr(appEl, "AXFocusedWindow");
    if (!win) {
      var wins = readAttr(appEl, "AXWindows");
      if (wins && wins.count > 0) win = wins.objectAtIndex(0);
    }
    var bar = win ? findScrollBarInSubtree(win, 180) : null;
    if (!bar) {
      JSON.stringify({ delivered: false, verified: false, reason: "no_scrollbar" });
    } else {
      var beforeObj = readAttr(bar, "AXValue");
      var beforeNum = beforeObj !== null ? Number(ObjC.unwrap(beforeObj)) : null;
      var didShift = false;
      if (Number.isFinite(beforeNum)) {
        var settableRef = Ref();
        if ($.AXUIElementIsAttributeSettable(bar, $("AXValue"), settableRef) === 0 && settableRef[0]) {
          var nextVal = Math.max(0, Math.min(1, beforeNum + sign * 0.1 * pageAmount));
          if (Math.abs(nextVal - beforeNum) > 1e-6 && $.AXUIElementSetAttributeValue(bar, $("AXValue"), $(nextVal)) === 0) {
            didShift = true;
          }
        }
      }
      if (!didShift) {
        var steps = Math.max(1, Math.min(8, Math.round(pageAmount * 3)));
        for (var s = 0; s < steps; s++) {
          if ($.AXUIElementPerformAction(bar, $(stepAction)) === 0) didShift = true;
        }
      }
      var afterObj = readAttr(bar, "AXValue");
      var afterNum = afterObj !== null ? Number(ObjC.unwrap(afterObj)) : null;
      var verified = Number.isFinite(beforeNum) && Number.isFinite(afterNum) && Math.abs(afterNum - beforeNum) > 1e-5;
      JSON.stringify({ delivered: didShift, verified: verified, reason: didShift ? "ok" : "inert_scrollbar" });
    }
  `;
  try {
    const { stdout } = await execFileAsync("/usr/bin/osascript", ["-l", "JavaScript", "-e", script], {
      timeout: 3000,
    });
    return JSON.parse(String(stdout || "{}").trim() || '{"delivered":false,"verified":false}');
  } catch {
    return { delivered: false, verified: false, reason: "exec_failed" };
  }
}

/**
 * Normalize an advertised Secondary Action name (`ShowMenu` / `AXShowMenu`).
 */
export function matchAdvertisedAction(advertisedList = [], requestedAction = "") {
  if (!Array.isArray(advertisedList) || advertisedList.length === 0) return null;
  const norm = (s) => String(s || "").trim().replace(/^AX/iu, "").toLowerCase();
  const target = norm(requestedAction);
  if (!target) return null;
  return advertisedList.find((item) => norm(item) === target) || null;
}

/**
 * Headless context-menu trigger (`AXShowMenu`), operating directly on retained `AXUIElementRef`
 * handles or role+label/help/identifier matching (no `AXIdentifier` required).
 */
export async function tryHeadlessContextMenu(
  pid,
  elementMeta,
  { axBridge = null, snapshotId = null, elementIndex = null, beforeWriteCheck = null } = {}
) {
  if (process.platform !== "darwin") return { delivered: false, verified: false, reason: "non_darwin" };
  if (!Number.isInteger(pid) || pid <= 0) {
    return { delivered: false, verified: false, reason: "invalid_pid" };
  }
  if (typeof beforeWriteCheck === "function") {
    beforeWriteCheck();
  }
  if (axBridge && typeof axBridge.triggerContextMenu === "function") {
    try {
      const res = await axBridge.triggerContextMenu(pid, {
        snapshotId,
        elementIndex,
        elementMeta,
        beforeWriteCheck,
      });
      if (res) return res;
    } catch (err) {
      if (err?.aborted) throw err;
    }
  }
  const hasCriterion = Boolean(
    elementMeta?.identifier || elementMeta?.rawText || elementMeta?.help || elementMeta?.role
  );
  if (!hasCriterion) {
    return { delivered: false, verified: false, reason: "missing_criteria" };
  }
  const targetIdLiteral = JSON.stringify(elementMeta?.identifier || "");
  const roleLiteral = JSON.stringify(String(elementMeta?.role || "").trim().toLowerCase());
  const hintLiteral = JSON.stringify(
    String(elementMeta?.rawText || "")
      .replace(/,?\s*Value:\s*.*$/iu, "")
      .trim()
      .toLowerCase()
  );
  const helpLiteral = JSON.stringify(String(elementMeta?.help || "").trim().toLowerCase());
  const script = `
    ObjC.import("ApplicationServices");
    ObjC.import("Foundation");
    var pid = ${pid};
    var targetId = ${targetIdLiteral};
    var wantRole = ${roleLiteral};
    var wantHint = ${hintLiteral};
    var wantHelp = ${helpLiteral};
    var appEl = $.AXUIElementCreateApplication(pid);

    function readAttr(el, name) {
      var out = Ref();
      if ($.AXUIElementCopyAttributeValue(el, $(name), out) === 0 && out[0]) {
        return ObjC.castRefToObject(out[0]);
      }
      return null;
    }

    function readStr(el, name) {
      var obj = readAttr(el, name);
      return obj ? String(ObjC.unwrap(obj) || "") : "";
    }

    function matchesNode(el) {
      var id = readStr(el, "AXIdentifier") || readStr(el, "AXDOMIdentifier");
      if (targetId) return id === targetId;
      var axRole = readStr(el, "AXRole").toLowerCase();
      var roleDesc = readStr(el, "AXRoleDescription").toLowerCase();
      if (wantRole && wantRole !== axRole && wantRole !== roleDesc && wantRole.replace(/^ax/, "") !== axRole.replace(/^ax/, "")) {
        return false;
      }
      if (!wantHint && !wantHelp) return false;
      var t = readStr(el, "AXTitle").toLowerCase();
      var d = readStr(el, "AXDescription").toLowerCase();
      var hp = readStr(el, "AXHelp").toLowerCase();
      if (wantHint && (t === wantHint || d === wantHint || (t && wantHint.indexOf(t) === 0))) return true;
      if (wantHelp && hp === wantHelp) return true;
      return false;
    }

    function findTarget(root, maxVisits) {
      var queue = [root];
      var visits = 0;
      while (queue.length > 0 && visits < maxVisits) {
        var cur = queue.shift();
        visits += 1;
        if (matchesNode(cur)) return cur;
        var ch = readAttr(cur, "AXChildren");
        if (ch && ch.count) {
          var limit = Math.min(Number(ch.count), 40);
          for (var i = 0; i < limit; i++) queue.push(ch.objectAtIndex(i));
        }
      }
      return null;
    }

    var win = readAttr(appEl, "AXMainWindow") || readAttr(appEl, "AXFocusedWindow");
    var target = win ? findTarget(win, 240) : null;
    if (!target) {
      JSON.stringify({ delivered: false, verified: false, reason: "not_found" });
    } else {
      var actionsOut = Ref();
      var hasShowMenu = false;
      if ($.AXUIElementCopyActionNames(target, actionsOut) === 0 && actionsOut[0]) {
        var nsArr = ObjC.castRefToObject(actionsOut[0]);
        var len = nsArr ? Number(nsArr.count) : 0;
        for (var i = 0; i < len; i++) {
          if (String(ObjC.unwrap(nsArr.objectAtIndex(i))) === "AXShowMenu") { hasShowMenu = true; break; }
        }
      }
      if (!hasShowMenu) {
        JSON.stringify({ delivered: false, verified: false, reason: "not_advertised" });
      } else {
        var err = $.AXUIElementPerformAction(target, $("AXShowMenu"));
        JSON.stringify({ delivered: err === 0, verified: err === 0, reason: err === 0 ? "ok" : "ax_error" });
      }
    }
  `;
  try {
    const { stdout } = await execFileAsync("/usr/bin/osascript", ["-l", "JavaScript", "-e", script], {
      timeout: 2500,
    });
    return JSON.parse(String(stdout || "{}").trim() || '{"delivered":false,"verified":false}');
  } catch {
    return { delivered: false, verified: false, reason: "exec_failed" };
  }
}

/**
 * Focus-free SkyLight window-local mouse click (`CGEventSetWindowLocation` + `kCGWindowNumber`
 * + `SLEventPostToPid` WITHOUT `SLPSPostEventRecordTo(0x0d)` `AppActivated`).
 * Prevents Qt6 / custom-engine apps (e.g. 剪映 `com.lemon.lvpro`) from self-activating their window.
 */
export async function tryWindowPostClick(pid, options = {}) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return { delivered: false, reason: "invalid_pid" };
  }
  const { axBridge = null, ...rest } = options || {};
  if (axBridge && axBridge.enabled !== false && typeof axBridge.postWindowClick === "function") {
    try {
      const res = await axBridge.postWindowClick(pid, rest);
      if (res?.deliveryState === "sent_unknown") {
        const err = new Error(`Window click partial delivery (${res.reason || "partial_click_post"})`);
        err.code = "WRITE_OUTCOME_UNKNOWN";
        err.deliveryState = "sent_unknown";
        err.dispatched = true;
        throw err;
      }
      if (res) return res;
    } catch (err) {
      if (err?.aborted || err?.deliveryState === "sent_unknown" || err?.code === "WRITE_OUTCOME_UNKNOWN") {
        throw err;
      }
      return { delivered: false, reason: err?.message || "bridge_error" };
    }
  }
  return { delivered: false, reason: "bridge_unavailable" };
}

/**
 * Focus-free keyboard key/chord delivery (`CGEventPostToPid` without `SLPSPostEventRecordTo(0x0d)`).
 */
export async function tryWindowKey(pid, key, options = {}) {
  if (!Number.isInteger(pid) || pid <= 0 || typeof key !== "string" || !key.trim()) {
    return { delivered: false, reason: "invalid_args" };
  }
  const { axBridge = null, ...rest } = options || {};
  if (axBridge && axBridge.enabled !== false && typeof axBridge.postWindowKey === "function") {
    try {
      const res = await axBridge.postWindowKey(pid, { key, ...rest });
      if (res) return res;
    } catch (err) {
      if (err?.aborted || err?.deliveryState === "sent_unknown" || err?.code === "WRITE_OUTCOME_UNKNOWN") {
        throw err;
      }
      return { delivered: false, reason: err?.message || "bridge_error" };
    }
  }
  return { delivered: false, reason: "bridge_unavailable" };
}

/**
 * Focus-free Unicode text delivery (`CGEventKeyboardSetUnicodeString` + `CGEventPostToPid` without `0x0d`).
 */
export async function tryWindowText(pid, text, options = {}) {
  if (!Number.isInteger(pid) || pid <= 0 || typeof text !== "string") {
    return { delivered: false, reason: "invalid_args" };
  }
  const { axBridge = null, ...rest } = options || {};
  if (axBridge && axBridge.enabled !== false && typeof axBridge.postWindowText === "function") {
    try {
      const res = await axBridge.postWindowText(pid, { text, ...rest });
      if (res) return res;
    } catch (err) {
      if (err?.aborted || err?.deliveryState === "sent_unknown" || err?.code === "WRITE_OUTCOME_UNKNOWN") {
        throw err;
      }
      return { delivered: false, reason: err?.message || "bridge_error" };
    }
  }
  return { delivered: false, reason: "bridge_unavailable" };
}

export async function tryWindowScroll(pid, options = {}) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return { delivered: false, verified: false, reason: "invalid_args" };
  }
  const { axBridge = null, ...rest } = options || {};
  if (axBridge && axBridge.enabled !== false && typeof axBridge.postWindowScroll === "function") {
    try {
      const res = await axBridge.postWindowScroll(pid, rest);
      if (res) return res;
    } catch (err) {
      if (err?.aborted || err?.deliveryState === "sent_unknown" || err?.code === "WRITE_OUTCOME_UNKNOWN") {
        throw err;
      }
      return { delivered: false, verified: false, reason: err?.message || "bridge_error" };
    }
  }
  return { delivered: false, verified: false, reason: "bridge_unavailable" };
}
