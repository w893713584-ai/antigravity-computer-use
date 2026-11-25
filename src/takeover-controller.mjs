import crypto from "node:crypto";
import { DEFAULT_EMERGENCY_HOTKEY, EMERGENCY_HOTKEY } from "./constants.mjs";

const MAX_RECENT_INTENT_IDS = 256;

const RESERVED_HOTKEY_MOD_ALIASES = new Map([
  ["ctrl", "ctrl"],
  ["control", "ctrl"],
  ["control_l", "ctrl"],
  ["control_r", "ctrl"],
  ["opt", "opt"],
  ["option", "opt"],
  ["alt", "opt"],
  ["alt_l", "opt"],
  ["alt_r", "opt"],
  ["cmd", "cmd"],
  ["command", "cmd"],
  ["super", "cmd"],
  ["super_l", "cmd"],
  ["super_r", "cmd"],
  ["meta", "cmd"],
  ["win", "cmd"],
  ["shift", "shift"],
  ["shift_l", "shift"],
  ["shift_r", "shift"],
]);

const RESERVED_HOTKEY_KEY_ALIASES = new Map([
  ["esc", "escape"],
  ["escape", "escape"],
  ["enter", "return"],
  ["return", "return"],
]);

const UI_INTERACT_KIND_LABELS = {
  click: "点击",
  scroll: "滚动",
  type_text: "输入文字",
  press_key: "按键",
};

/**
 * Normalize manual Side-Pane Mini-Window interaction metadata into a canonical takeover claim.
 */
export function buildUiInteractionPauseClaim(app, data = {}) {
  const kind = typeof data?.kind === "string" && data.kind.trim() ? data.kind.trim() : "interact";
  const kindZh = UI_INTERACT_KIND_LABELS[kind] || "操作";
  return {
    ...data,
    app,
    rule: data?.rule || `ui_${kind}`,
    label: data?.label || `小窗手动${kindZh}接管已暂停 AI`,
  };
}

/**
 * Normalize a hotkey / xdotool chord string for exact emergency-stop conflict matching.
 */
export function normalizeHotkeySignature(rawSpec) {
  if (typeof rawSpec !== "string") return "";
  const tokens = rawSpec.trim().toLowerCase().split(/\s+/u).filter(Boolean);
  if (tokens.length !== 1) return "";
  const parts = tokens[0].split("+").filter(Boolean);
  if (parts.length < 2) return "";
  const mods = new Set();
  for (let i = 0; i < parts.length - 1; i += 1) {
    const mod = RESERVED_HOTKEY_MOD_ALIASES.get(parts[i]);
    if (!mod) return "";
    mods.add(mod);
  }
  const rawKey = parts[parts.length - 1];
  const key = RESERVED_HOTKEY_KEY_ALIASES.get(rawKey) || rawKey;
  const orderedMods = ["cmd", "ctrl", "opt", "shift"].filter((m) => mods.has(m));
  return [...orderedMods, key].join("+");
}

/**
 * Generate a non-zero 52-bit positive integer tag (losslessly representable in JS Number,
 * JXA int64_t, and Swift Int64) for stamping synthetic CGEvents per Broker boot.
 */
export function generateSyntheticEventTag() {
  const high = crypto.randomInt(0x1000, 0x1fff);
  const low = crypto.randomInt(1, 0xffffffff);
  return high * 0x100000000 + low;
}

export class TakeoverAbortedError extends Error {
  constructor(
    message = "Computer Use operation aborted by pause or cancellation",
    { code = "PAUSED", deliveryState = "not_sent", pauseEpoch = 0 } = {}
  ) {
    super(message);
    this.name = "TakeoverAbortedError";
    this.code = code;
    this.aborted = true;
    this.deliveryState = deliveryState;
    this.pauseEpoch = pauseEpoch;
  }
}

export function isTakeoverAbortedError(err) {
  return Boolean(
    err instanceof TakeoverAbortedError ||
      err?.code === "PAUSED" ||
      err?.code === "CANCELLED" ||
      err?.code === "WRITE_LOCKED_UNKNOWN_AGENT" ||
      err?.code === "WRITE_OUTCOME_UNKNOWN"
  );
}

/**
 * Deep Controller: TakeoverController
 *
 * Single Broker authority for:
 * 1) Active AI action target registry (distinct from Mini-Window viewing target)
 * 2) Precision background-safe human takeover discrimination (`evaluateSensorEvent`)
 * 3) Synchronized `running -> draining -> paused -> running` latch & monotonic `pauseEpoch`
 * 4) Synchronous pre-write dispatch gate (`assertMayDispatch`) + in-flight write drain
 * 5) OCU black-box route capability overrides & reserved emergency-stop hotkey guard
 */
export class TakeoverController {
  #phase = "running"; // "running" | "draining" | "paused"
  #pauseEpoch = 0;
  #pauseReason = null;
  #pauseDetail = null;
  #activeTarget = null;
  #lastTarget = null;
  #nextOperationId = 1;
  #operations = new Map();
  #inFlightNativeWrites = new Map();
  #nextWriteId = 1;
  #drainWaiters = new Set();
  #recentIntentIds = new Map();
  #nativeWriteUnknownLock = false;
  #unknownAgentInstanceId = null;
  #routePolicies = new Map();
  #trustedPids = new Set();
  #takeoverMode = "baseline";
  #helperCapabilities = {
    inputMonitoring: false,
    accessibility: false,
    mouseTapActive: false,
    keyTapActive: false,
    hotkeyActive: false,
    secureInputActive: false,
    sessionLocked: false,
  };

  constructor({
    syntheticEventTag = generateSyntheticEventTag(),
    emergencyHotkey = EMERGENCY_HOTKEY,
    trustedPids = [],
    onPauseLatched = null,
    onPhaseChanged = null,
    onTargetChanged = null,
    onResume = null,
    onVerifyUnknownAgentCleared = null,
  } = {}) {
    this.syntheticEventTag = Number(syntheticEventTag) || generateSyntheticEventTag();
    this.emergencyHotkey = emergencyHotkey || EMERGENCY_HOTKEY;
    this.emergencyHotkeySignature = normalizeHotkeySignature(this.emergencyHotkey);
    this.setTrustedPids(trustedPids);
    this.onPauseLatched = onPauseLatched;
    this.onPhaseChanged = onPhaseChanged;
    this.onTargetChanged = onTargetChanged;
    this.onResume = onResume;
    this.onVerifyUnknownAgentCleared = onVerifyUnknownAgentCleared;

    // Default black-box safety: untagged OCU routes cannot be distinguished from human HID events while in flight.
    for (const routeKey of ["click:sky_click", "click:app_post", "click:native", "drag:native"]) {
      this.#routePolicies.set(routeKey, { autoClick: false, autoKey: true });
    }
    for (const routeKey of [
      "press_key:sky_key",
      "type_text:sky_key",
      "press_key:native",
      "type_text:native",
    ]) {
      this.#routePolicies.set(routeKey, { autoClick: true, autoKey: false });
    }
  }

  get phase() {
    return this.#phase;
  }

  get paused() {
    return this.#phase !== "running";
  }

  get pauseEpoch() {
    return this.#pauseEpoch;
  }

  get pauseReason() {
    return this.#pauseReason;
  }

  get pauseDetail() {
    return this.#pauseDetail ? { ...this.#pauseDetail } : null;
  }

  get activeTarget() {
    return this.#activeTarget ? { ...this.#activeTarget } : null;
  }

  get inFlightWriteCount() {
    return this.#inFlightNativeWrites.size;
  }

  get nativeWriteUnknownLock() {
    return this.#nativeWriteUnknownLock;
  }

  publicState() {
    return {
      paused: this.paused,
      pausePhase: this.#phase,
      pauseEpoch: this.#pauseEpoch,
      pauseReason: this.#pauseReason,
      pauseDetail: this.pauseDetail,
      emergencyHotkey: this.emergencyHotkey,
      takeoverMode: this.#takeoverMode,
    };
  }

  setTrustedPids(pids = []) {
    const next = new Set();
    for (const p of Array.isArray(pids) ? pids : []) {
      const n = Number(p);
      if (Number.isInteger(n) && n > 0) next.add(n);
    }
    this.#trustedPids = next;
  }

  setHelperCapabilities(caps = {}) {
    this.#helperCapabilities = {
      inputMonitoring: Boolean(caps.inputMonitoring),
      accessibility: Boolean(caps.accessibility),
      mouseTapActive: Boolean(caps.mouseTapActive),
      keyTapActive: Boolean(caps.keyTapActive),
      hotkeyActive: Boolean(caps.hotkeyActive),
      secureInputActive: Boolean(caps.secureInputActive),
      sessionLocked: Boolean(caps.sessionLocked),
    };
    this.#takeoverMode =
      this.#helperCapabilities.mouseTapActive || this.#helperCapabilities.keyTapActive
        ? "enhanced"
        : "baseline";
  }

  getHelperCapabilities() {
    return { ...this.#helperCapabilities, mode: this.#takeoverMode };
  }

  setRoutePolicy(routeKey, { autoClick = true, autoKey = true } = {}) {
    const key = String(routeKey || "").trim().toLowerCase();
    if (!key) return;
    this.#routePolicies.set(key, {
      autoClick: Boolean(autoClick),
      autoKey: Boolean(autoKey),
    });
  }

  isAutomaticRuleEnabled(kind, routeKey = null) {
    if (routeKey) {
      const policy = this.#routePolicies.get(String(routeKey).trim().toLowerCase());
      if (policy) {
        return kind === "key" ? policy.autoKey : policy.autoClick;
      }
    }
    for (const entry of this.#inFlightNativeWrites.values()) {
      if (!entry?.routeKey) continue;
      const policy = this.#routePolicies.get(String(entry.routeKey).trim().toLowerCase());
      if (policy && (kind === "key" ? !policy.autoKey : !policy.autoClick)) {
        return false;
      }
    }
    return true;
  }

  isReservedHotkey(keySpec) {
    if (!this.emergencyHotkeySignature || typeof keySpec !== "string") return false;
    const tokens = keySpec.trim().split(/\s+/u).filter(Boolean);
    for (const tok of tokens) {
      const sig = normalizeHotkeySignature(tok);
      if (sig && sig === this.emergencyHotkeySignature) {
        return true;
      }
    }
    return false;
  }

  /**
   * Admit an incoming MCP or UI operation. AI mutating operations fail closed immediately if paused.
   */
  admit({
    name = "unknown",
    isAi = true,
    isMutating = true,
    allowReadWhenPaused = false,
    signal = null,
  } = {}) {
    if (signal?.aborted) {
      throw new TakeoverAbortedError("调用已被请求方取消。", {
        code: "CANCELLED",
        deliveryState: "not_sent",
        pauseEpoch: this.#pauseEpoch,
      });
    }
    if (isAi && isMutating && this.paused) {
      throw new TakeoverAbortedError(
        "Computer Use 已被用户暂停（人类接管/暂停刹车）。请先停止自动操作，等待用户点击「继续」。",
        {
          code: "PAUSED",
          deliveryState: "not_sent",
          pauseEpoch: this.#pauseEpoch,
        }
      );
    }
    const id = this.#nextOperationId++;
    const controller = new AbortController();
    const onExternalAbort = () => {
      if (!controller.signal.aborted) {
        controller.abort(
          new TakeoverAbortedError("调用已取消（客户端断开或中止）。", {
            code: "CANCELLED",
            deliveryState: "not_sent",
            pauseEpoch: this.#pauseEpoch,
          })
        );
      }
    };
    if (signal) {
      signal.addEventListener("abort", onExternalAbort, { once: true });
    }
    const op = {
      id,
      name,
      epoch: this.#pauseEpoch,
      isAi: Boolean(isAi),
      isMutating: Boolean(isMutating),
      allowReadWhenPaused: Boolean(allowReadWhenPaused),
      controller,
      signal: controller.signal,
      externalSignal: signal,
      disposed: false,
      lastRouteKey: null,
      cleanupListener: () => {
        if (signal) signal.removeEventListener("abort", onExternalAbort);
      },
    };
    this.#operations.set(id, op);
    return op;
  }

  /**
   * Register the currently targeted desktop PID / window / token for an active AI operation.
   */
  setTarget(operation, targetInfo = {}) {
    if (!operation || operation.disposed || !operation.isAi) return null;
    if (operation.signal.aborted || this.paused || operation.epoch !== this.#pauseEpoch) {
      return null;
    }
    const pid = Number(targetInfo.pid) > 0 ? Number(targetInfo.pid) : null;
    const windowId = Number(targetInfo.windowId) > 0 ? Number(targetInfo.windowId) : null;
    const nextTarget = {
      app: targetInfo.app || null,
      bundleId: targetInfo.bundleId || null,
      appDisplayName: targetInfo.appDisplayName || null,
      pid,
      processToken: targetInfo.processToken || null,
      windowId,
      windowTitle: targetInfo.windowTitle || null,
      routeKey: targetInfo.routeKey || operation.lastRouteKey || null,
      operationId: operation.id,
      pauseEpoch: operation.epoch,
    };
    if (nextTarget.routeKey) {
      operation.lastRouteKey = nextTarget.routeKey;
    }
    this.#activeTarget = nextTarget;
    this.#lastTarget = nextTarget;
    this.onTargetChanged?.(this.activeTarget);
    return this.activeTarget;
  }

  clearOperation(operation) {
    if (!operation) return;
    operation.disposed = true;
    operation.cleanupListener?.();
    this.#operations.delete(operation.id);
    if (this.#activeTarget?.operationId === operation.id) {
      this.#activeTarget = null;
      this.onTargetChanged?.(null);
    }
  }

  /**
   * Synchronous last-microsecond permission check executed immediately before writing to native IPC.
   */
  assertMayDispatch(operation = null, { isRead = false } = {}) {
    if (operation?.externalSignal?.aborted || operation?.signal?.aborted) {
      throw new TakeoverAbortedError("调用在写入原生进程前已取消。", {
        code: "CANCELLED",
        deliveryState: "not_sent",
        pauseEpoch: this.#pauseEpoch,
      });
    }
    if (!isRead && this.#nativeWriteUnknownLock) {
      throw new TakeoverAbortedError(
        "上一次原生写入处于已发送未知状态（app-agent 未确认退出），写入口暂锁。",
        {
          code: "WRITE_LOCKED_UNKNOWN_AGENT",
          deliveryState: "not_sent",
          pauseEpoch: this.#pauseEpoch,
        }
      );
    }
    if (operation && !operation.isAi) {
      return true;
    }
    if (!isRead && (this.paused || (operation && operation.epoch !== this.#pauseEpoch))) {
      throw new TakeoverAbortedError(
        "Computer Use 在写入原生进程前检测到人类接管/暂停，已安全阻断（not_sent）。",
        {
          code: "PAUSED",
          deliveryState: "not_sent",
          pauseEpoch: this.#pauseEpoch,
        }
      );
    }
    if (isRead && this.paused && operation?.allowReadWhenPaused === false) {
      throw new TakeoverAbortedError("当前已暂停，禁止执行带副作用的读取。", {
        code: "PAUSED",
        deliveryState: "not_sent",
        pauseEpoch: this.#pauseEpoch,
      });
    }
    return true;
  }

  /**
   * Track an already-written native IPC call so `requestPause` enters `draining` until it settles.
   */
  trackNativeWrite(operation, writePromise, meta = {}) {
    const id = this.#nextWriteId++;
    const entry = {
      id,
      operationId: operation?.id || null,
      routeKey: meta.routeKey || null,
      startedAt: Date.now(),
    };
    this.#inFlightNativeWrites.set(id, entry);
    return Promise.resolve(writePromise).finally(() => {
      this.#inFlightNativeWrites.delete(id);
      if (this.#phase === "draining" && this.#inFlightNativeWrites.size === 0) {
        this.#phase = "paused";
        this.onPhaseChanged?.(this.publicState());
      }
      if (this.#inFlightNativeWrites.size === 0) {
        for (const resolve of this.#drainWaiters) {
          resolve(true);
        }
        this.#drainWaiters.clear();
      }
    });
  }

  markWriteOutcomeUnknown(agentInstanceId = "default") {
    this.#nativeWriteUnknownLock = true;
    this.#unknownAgentInstanceId = String(agentInstanceId || "default");
  }

  clearWriteOutcomeUnknown(agentInstanceId = null) {
    if (!this.#nativeWriteUnknownLock) return;
    if (agentInstanceId && this.#unknownAgentInstanceId && agentInstanceId !== this.#unknownAgentInstanceId) {
      return;
    }
    this.#nativeWriteUnknownLock = false;
    this.#unknownAgentInstanceId = null;
  }

  async waitForDrain({ timeoutMs = 5000 } = {}) {
    if (this.#inFlightNativeWrites.size === 0) return true;
    return new Promise((resolve) => {
      let timer = null;
      const done = (drained) => {
        if (timer) clearTimeout(timer);
        this.#drainWaiters.delete(onDrained);
        resolve(drained);
      };
      const onDrained = () => done(true);
      this.#drainWaiters.add(onDrained);
      if (timeoutMs > 0) {
        timer = setTimeout(() => done(false), timeoutMs);
        timer.unref?.();
      }
    });
  }

  #rememberIntentId(intentId) {
    if (typeof intentId !== "string" || !intentId.trim()) return false;
    const key = intentId.trim();
    if (this.#recentIntentIds.has(key)) return true;
    if (this.#recentIntentIds.size >= MAX_RECENT_INTENT_IDS) {
      const oldest = this.#recentIntentIds.keys().next().value;
      if (oldest !== undefined) this.#recentIntentIds.delete(oldest);
    }
    this.#recentIntentIds.set(key, Date.now());
    return false;
  }

  /**
   * Synchronously latch pause state, advance `pauseEpoch`, abort all in-flight AI operations,
   * and optionally record user focus takeover intent for FocusPolicyGuard.
   */
  requestPause(intent = {}) {
    const isDuplicateIntent = this.#rememberIntentId(intent.intentId);
    const targetPid = Number(intent.targetPid) > 0 ? Number(intent.targetPid) : null;
    if (isDuplicateIntent && this.paused) {
      return {
        latched: false,
        idempotent: true,
        ...this.publicState(),
      };
    }

    const wasRunning = !this.paused;
    const nextPhase = this.#inFlightNativeWrites.size > 0 ? "draining" : "paused";
    const reason = String(intent.reason || "manual_pause");
    const detail = {
      reason,
      source: intent.source || "system",
      rule: intent.rule || reason,
      label: intent.label || "已暂停 AI 操作",
      targetApp: intent.targetApp || this.#activeTarget?.bundleId || this.#activeTarget?.app || null,
      targetPid: targetPid || this.#activeTarget?.pid || null,
      targetWindowId:
        Number(intent.targetWindowId) > 0
          ? Number(intent.targetWindowId)
          : this.#activeTarget?.windowId || null,
      timestamp: Date.now(),
    };

    if (wasRunning) {
      this.#phase = nextPhase;
      this.#pauseEpoch += 1;
      this.#pauseReason = reason;
      this.#pauseDetail = detail;
    } else if (reason === "ui_bring_to_front" || reason === "emergency_hotkey") {
      this.#pauseReason = reason;
      this.#pauseDetail = detail;
    }

    const abortErr = new TakeoverAbortedError(
      `Computer Use 已被暂停 (${detail.label})。`,
      {
        code: "PAUSED",
        deliveryState: "not_sent",
        pauseEpoch: this.#pauseEpoch,
      }
    );
    for (const op of this.#operations.values()) {
      if (op.isAi && !op.signal.aborted) {
        op.controller.abort(abortErr);
      }
    }

    const activeSnapshot = this.#activeTarget;
    this.#activeTarget = null;
    if (activeSnapshot) {
      this.onTargetChanged?.(null);
    }

    if (wasRunning) {
      this.onPauseLatched?.({
        ...this.publicState(),
        intent,
        wasActiveTarget: activeSnapshot,
      });
    } else {
      this.onPhaseChanged?.(this.publicState());
    }

    return {
      latched: wasRunning,
      idempotent: false,
      ...this.publicState(),
    };
  }

  async resume({ expectedPauseEpoch = null } = {}) {
    if (
      expectedPauseEpoch !== null &&
      expectedPauseEpoch !== undefined &&
      Number(expectedPauseEpoch) !== this.#pauseEpoch
    ) {
      return {
        ok: false,
        statusCode: 409,
        code: "PAUSE_EPOCH_MISMATCH",
        error: `暂停状态已变化（期望 epoch=${expectedPauseEpoch}，当前 epoch=${this.#pauseEpoch}），请刷新后重试。`,
        ...this.publicState(),
      };
    }

    if (this.#inFlightNativeWrites.size > 0) {
      const drained = await this.waitForDrain({ timeoutMs: 2500 });
      if (!drained) {
        return {
          ok: false,
          statusCode: 409,
          code: "DRAINING_IN_PROGRESS",
          error: "仍有在途原生输入尚未排空，请稍候再继续。",
          ...this.publicState(),
        };
      }
    }

    if (this.#nativeWriteUnknownLock && typeof this.onVerifyUnknownAgentCleared === "function") {
      try {
        await this.onVerifyUnknownAgentCleared(this.#unknownAgentInstanceId);
      } catch {}
    }

    if (this.#nativeWriteUnknownLock) {
      return {
        ok: false,
        statusCode: 409,
        code: "WRITE_LOCKED_UNKNOWN_AGENT",
        error: "前次原生动作结果未知，等待底层进程重启清理后方可继续。",
        ...this.publicState(),
      };
    }

    const prevTarget = this.#lastTarget;
    this.#phase = "running";
    this.#pauseReason = null;
    this.#pauseDetail = null;
    await this.onResume?.({ lastTarget: prevTarget, pauseEpoch: this.#pauseEpoch });
    this.onPhaseChanged?.(this.publicState());
    return {
      ok: true,
      ...this.publicState(),
    };
  }

  /**
   * Pure takeover discriminator enforcing background safety:
   * - Never fires on synthetic or unknown input sources
   * - Never fires on user work inside Antigravity / other non-target apps
   * - Never fires on occluded windows behind other visible apps
   * - Fires only on targeted human clicks, confirmed target switching/typing, or emergency hotkey
   */
  evaluateSensorEvent(evt) {
    if (!evt || typeof evt !== "object") {
      return { trigger: false, reason: "invalid_event" };
    }
    if (evt.sourceClass === "synthetic" || evt.sourceClass === "unknown") {
      return { trigger: false, reason: `ignored_${evt.sourceClass}` };
    }
    if (
      evt.sourceTag !== undefined &&
      evt.sourceTag !== null &&
      Number(evt.sourceTag) === this.syntheticEventTag
    ) {
      return { trigger: false, reason: "ignored_synthetic_tag" };
    }
    if (
      evt.type !== "emergency_hotkey" &&
      Number(evt.sourcePid) > 0 &&
      this.#trustedPids.has(Number(evt.sourcePid))
    ) {
      return { trigger: false, reason: "trusted_automation_pid" };
    }

    if (evt.type === "emergency_hotkey") {
      if (evt.isRepeat) {
        return { trigger: false, reason: "ignored_hotkey_repeat" };
      }
      return {
        trigger: true,
        intent: {
          reason: "emergency_hotkey",
          rule: "emergency_hotkey",
          source: "hotkey",
          label: `人类急停热键 (${this.emergencyHotkey})`,
          transfersFocusToTarget: false,
        },
      };
    }

    const target = this.#activeTarget;
    if (!target || !(target.pid > 0)) {
      return { trigger: false, reason: "no_active_ai_target" };
    }

    if (evt.type === "mouse_down") {
      if (!this.isAutomaticRuleEnabled("click", target.routeKey)) {
        return { trigger: false, reason: "route_auto_click_disabled" };
      }
      const hit = evt.hit;
      if (!hit || hit.state !== "hit") {
        return { trigger: false, reason: "hit_unknown_or_miss" };
      }
      if (hit.occludedByOther) {
        return { trigger: false, reason: "hit_occluded_by_other_window" };
      }
      if (Number(hit.pid) !== target.pid) {
        return { trigger: false, reason: "hit_other_pid" };
      }
      if (hit.processToken && target.processToken && hit.processToken !== target.processToken) {
        return { trigger: false, reason: "process_token_mismatch" };
      }
      if (target.windowId > 0) {
        const hitWid = Number(hit.windowId || 0);
        const modalParentWid = Number(hit.confirmedModalParentWindowId || 0);
        if (hitWid !== target.windowId && modalParentWid !== target.windowId) {
          return { trigger: false, reason: "hit_different_window_id" };
        }
      }
      return {
        trigger: true,
        intent: {
          reason: "human_click_target",
          rule: "human_click_target",
          source: "hid",
          label: `真人点击目标窗口 · ${target.appDisplayName || target.app || `PID ${target.pid}`}`,
          targetPid: target.pid,
          targetWindowId: hit.windowId || target.windowId,
          targetApp: target.bundleId || target.app,
          transfersFocusToTarget: true,
        },
      };
    }

    if (evt.type === "key_down") {
      if (!this.isAutomaticRuleEnabled("key", target.routeKey)) {
        return { trigger: false, reason: "route_auto_key_disabled" };
      }
      if (Number(evt.frontmostPid) !== target.pid) {
        return { trigger: false, reason: "typing_in_other_app" };
      }
      if (evt.processToken && target.processToken && evt.processToken !== target.processToken) {
        return { trigger: false, reason: "process_token_mismatch" };
      }
      if (target.windowId > 0) {
        const focusedWid = Number(evt.focusedWindowId || 0);
        if (focusedWid <= 0 || focusedWid !== target.windowId) {
          return { trigger: false, reason: "focused_window_unverified_or_mismatch" };
        }
      }
      return {
        trigger: true,
        intent: {
          reason: "human_type_target",
          rule: "human_type_target",
          source: "hid",
          label: `真人在目标窗口按键 · ${target.appDisplayName || target.app || `PID ${target.pid}`}`,
          targetPid: target.pid,
          targetWindowId: target.windowId,
          targetApp: target.bundleId || target.app,
          transfersFocusToTarget: true,
        },
      };
    }

    if (evt.type === "app_activated") {
      if (evt.sourceClass !== "human" || evt.hasHumanSwitchGesture !== true) {
        return { trigger: false, reason: "activation_without_human_gesture" };
      }
      if (Number(evt.pid) !== target.pid) {
        return { trigger: false, reason: "activated_other_app" };
      }
      if (evt.processToken && target.processToken && evt.processToken !== target.processToken) {
        return { trigger: false, reason: "process_token_mismatch" };
      }
      if (
        target.windowId > 0 &&
        Number(evt.focusedWindowId || 0) > 0 &&
        Number(evt.focusedWindowId) !== target.windowId
      ) {
        return { trigger: false, reason: "activated_other_window" };
      }
      return {
        trigger: true,
        intent: {
          reason: "human_switch_target",
          rule: "human_switch_target",
          source: "hid",
          label: `真人切至目标应用 · ${target.appDisplayName || target.app || `PID ${target.pid}`}`,
          targetPid: target.pid,
          targetWindowId: target.windowId,
          targetApp: target.bundleId || target.app,
          transfersFocusToTarget: true,
        },
      };
    }

    return { trigger: false, reason: `unsupported_event_${evt.type}` };
  }

  handleSensorEvent(evt) {
    const verdict = this.evaluateSensorEvent(evt);
    if (!verdict.trigger) {
      return { triggered: false, reason: verdict.reason, ...this.publicState() };
    }
    const pauseOut = this.requestPause(verdict.intent);
    return { triggered: true, ...pauseOut };
  }
}
