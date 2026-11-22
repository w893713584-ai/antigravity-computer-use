/**
 * Deep Module: FocusPolicyGuard
 *
 * Concentrates Focus Steal detection/reclamation, epoch cancellation on explicit user raise,
 * delayed sweep timers, cross-app rapid attribution, alias fan-out, adaptive Delivery Route
 * blacklisting, and the Window-Local Delivery Floor (`window_post` / `window_key`, ADR-0003)
 * behind one small interface.
 */

export const WINDOW_LOCAL_DELIVERY_FLOOR = new Set(["window_post", "window_key"]);

function normalizeAppIdentityToken(value) {
  if (typeof value !== "string") return "";
  return value.trim().replace(/\.app$/iu, "").toLowerCase();
}

export function matchesTargetIdentity(frontApp, targetInfo = {}) {
  if (!frontApp || !Number.isInteger(frontApp.pid) || frontApp.pid <= 0) return false;
  if (Number.isInteger(targetInfo.pid) && targetInfo.pid > 0 && frontApp.pid === targetInfo.pid) {
    return true;
  }
  const frontBid = typeof frontApp.bundleId === "string" ? frontApp.bundleId.trim().toLowerCase() : "";
  const targetBid = typeof targetInfo.bundleId === "string" ? targetInfo.bundleId.trim().toLowerCase() : "";
  const queryRaw = typeof targetInfo.appQuery === "string" ? targetInfo.appQuery.trim().toLowerCase() : "";
  if (frontBid && ((targetBid && frontBid === targetBid) || (queryRaw && frontBid === queryRaw))) {
    return true;
  }
  const frontName = normalizeAppIdentityToken(frontApp.displayName);
  if (!frontName) return false;
  const targetName = normalizeAppIdentityToken(targetInfo.appDisplayName);
  const queryName = normalizeAppIdentityToken(targetInfo.appQuery);
  return Boolean((targetName && frontName === targetName) || (queryName && frontName === queryName));
}

export function didTargetStealFocus(frontBefore, frontNow, targetInfo = {}) {
  if (!frontBefore?.pid || !frontNow?.pid) return false;
  if (frontBefore.pid === frontNow.pid) return false;
  if (matchesTargetIdentity(frontBefore, targetInfo)) return false;
  return matchesTargetIdentity(frontNow, targetInfo);
}

export function parseDeliveryRoute(routeKey) {
  const normalized = typeof routeKey === "string" ? routeKey.trim().toLowerCase() : "";
  if (!normalized) return { normalized: "", tool: "", method: "" };
  const sep = normalized.indexOf(":");
  if (sep >= 0) {
    return {
      normalized,
      tool: normalized.slice(0, sep),
      method: normalized.slice(sep + 1),
    };
  }
  const isBareFloor = WINDOW_LOCAL_DELIVERY_FLOOR.has(normalized);
  return {
    normalized,
    tool: isBareFloor ? "" : normalized,
    method: isBareFloor ? normalized : "",
  };
}

export function formatDeliveryRoute(tool, method = "") {
  const t = String(tool || "").trim().toLowerCase();
  const m = String(method || "").trim().toLowerCase();
  return m ? `${t}:${m}` : t;
}

/**
 * Adaptive tracker recording `(appAlias, DeliveryRoute)` pairs that caused Focus Steals,
 * while strictly preserving the Window-Local Delivery Floor (`window_post`, `window_key`).
 */
export class SelfActivationTracker {
  #routes = new Map();

  record(appKey, routeKey) {
    const app = typeof appKey === "string" ? appKey.trim().toLowerCase() : "";
    const parsed = parseDeliveryRoute(routeKey);
    if (!app || !parsed.normalized) return;
    if (WINDOW_LOCAL_DELIVERY_FLOOR.has(parsed.method)) return;
    let set = this.#routes.get(app);
    if (!set) {
      set = new Set();
      this.#routes.set(app, set);
    }
    set.add(parsed.normalized);
  }

  getBlockedMethods(appKey, toolName = "click") {
    return this.getBlockedMethodsForAliases([appKey], toolName);
  }

  getBlockedMethodsForAliases(appKeys = [], toolName = "click") {
    const targetTool = String(toolName || "click").trim().toLowerCase();
    const blocked = new Set();
    for (const rawKey of appKeys) {
      const app = typeof rawKey === "string" ? rawKey.trim().toLowerCase() : "";
      if (!app) continue;
      const set = this.#routes.get(app);
      if (!set) continue;
      for (const entry of set) {
        const parsed = parseDeliveryRoute(entry);
        if (
          parsed.tool === targetTool &&
          parsed.method &&
          !WINDOW_LOCAL_DELIVERY_FLOOR.has(parsed.method)
        ) {
          blocked.add(parsed.method);
        }
      }
    }
    return Array.from(blocked);
  }

  hasRouteSteal(appKey, routeKey) {
    const app = typeof appKey === "string" ? appKey.trim().toLowerCase() : "";
    const parsed = parseDeliveryRoute(routeKey);
    return Boolean(app && parsed.normalized && this.#routes.get(app)?.has(parsed.normalized));
  }

  hasSkyFocusSteal(...appKeys) {
    for (const rawKey of appKeys) {
      const app = typeof rawKey === "string" ? rawKey.trim().toLowerCase() : "";
      if (!app) continue;
      const set = this.#routes.get(app);
      if (
        set &&
        (set.has("click:sky_click") ||
          set.has("press_key:sky_key") ||
          set.has("type_text:sky_key") ||
          set.has("set_value:sky_bypass"))
      ) {
        return true;
      }
    }
    return false;
  }
}

export function planBackgroundClickMethods(
  args = {},
  { allowAccessibilityFallback = false, blockedMethods = [], avoidSkyFocus = false } = {}
) {
  const blocked = new Set(
    Array.from(blockedMethods || []).map((m) => String(m || "").trim().toLowerCase())
  );
  for (const floorMethod of WINDOW_LOCAL_DELIVERY_FLOOR) {
    blocked.delete(floorMethod);
  }

  const skyBlocked = Boolean(avoidSkyFocus) || blocked.has("sky_click");
  const rawMethod = typeof args.click_method === "string" ? args.click_method.trim().toLowerCase() : "";
  const explicit = rawMethod && rawMethod !== "auto" && rawMethod !== "global" ? rawMethod : null;

  const button = (args.mouse_button || "left").toLowerCase();
  const count = args.click_count ?? 1;

  const filterNonActivating = (candidates) => {
    const filtered = candidates.filter(
      (m) => !blocked.has(m) && !(skyBlocked && m === "sky_click")
    );
    return filtered.length > 0 ? filtered : ["window_post"];
  };

  if (explicit === "accessibility") {
    const base =
      button === "left" && (count === 1 || count === 2)
        ? skyBlocked
          ? ["window_post", "app_post"]
          : ["sky_click", "app_post"]
        : skyBlocked
          ? ["window_post", "app_post"]
          : ["app_post"];
    const chain = filterNonActivating(base);
    if (!blocked.has("accessibility")) {
      chain.push("accessibility");
    }
    return chain;
  }

  if (explicit === "window_post") {
    return ["window_post"];
  }

  if (explicit) {
    if (explicit === "sky_click" && skyBlocked) {
      return filterNonActivating(["window_post", "app_post"]);
    }
    if (blocked.has(explicit)) {
      return filterNonActivating(["window_post", "app_post"]);
    }
    return [explicit];
  }

  if (button === "left" && (count === 1 || count === 2)) {
    const base = skyBlocked ? ["window_post", "app_post"] : ["sky_click", "app_post"];
    const fallbacks = filterNonActivating(base);
    if (
      allowAccessibilityFallback &&
      !blocked.has("accessibility") &&
      args.element_index !== undefined &&
      String(args.element_index) !== "0"
    ) {
      fallbacks.push("accessibility");
    }
    return fallbacks;
  }

  const nonLeftBase = skyBlocked ? ["window_post", "app_post"] : ["app_post"];
  return filterNonActivating(nonLeftBase);
}

export function planBackgroundKeyMethods(
  args = {},
  { blockedMethods = [], avoidSkyFocus = false } = {}
) {
  const blocked = new Set(
    Array.from(blockedMethods || []).map((m) => String(m || "").trim().toLowerCase())
  );
  for (const floorMethod of WINDOW_LOCAL_DELIVERY_FLOOR) {
    blocked.delete(floorMethod);
  }
  const skyKeyDirectlyBlocked = blocked.has("sky_key");
  const preferWindowKey = Boolean(avoidSkyFocus) || skyKeyDirectlyBlocked;
  const rawMethod = typeof args.key_method === "string" ? args.key_method.trim().toLowerCase() : "";
  const explicit = rawMethod && rawMethod !== "auto" && rawMethod !== "global" ? rawMethod : null;
  if (explicit === "window_key") {
    return ["window_key"];
  }
  if (explicit) {
    if (explicit === "sky_key" && preferWindowKey) {
      return skyKeyDirectlyBlocked ? ["window_key"] : ["window_key", "sky_key"];
    }
    if (blocked.has(explicit)) {
      return ["window_key"];
    }
    return [explicit];
  }
  if (preferWindowKey) {
    return skyKeyDirectlyBlocked ? ["window_key"] : ["window_key", "sky_key"];
  }
  return ["sky_key"];
}

function uniqueAliases(aliases = []) {
  return Array.from(
    new Set(
      aliases
        .map((a) => (typeof a === "string" ? a.trim() : ""))
        .filter(Boolean)
    )
  );
}

export class FocusPolicyGuard {
  #focusController;
  #tracker;
  #resolveTargetInfo;
  #onFocusStealPrevented;
  #epoch = 0;
  #nextScopeId = 0;
  #activeGuards = new Map();
  #sweepTimers = new Map();
  #humanFocusIntentVersion = 0;
  #humanFocusTargetPid = null;

  constructor({
    focusController,
    tracker = new SelfActivationTracker(),
    resolveTargetInfo = (app) => ({ appQuery: app, pid: null, bundleId: null, appDisplayName: null }),
    onFocusStealPrevented = null,
  } = {}) {
    this.#focusController = focusController;
    this.#tracker = tracker;
    this.#resolveTargetInfo = resolveTargetInfo;
    this.#onFocusStealPrevented = onFocusStealPrevented;
  }

  get tracker() {
    return this.#tracker;
  }

  get epoch() {
    return this.#epoch;
  }

  #clearSweepTimersForScope(scopeId) {
    const timers = this.#sweepTimers.get(scopeId);
    if (!timers) return;
    for (const timer of timers) {
      clearTimeout(timer);
    }
    this.#sweepTimers.delete(scopeId);
  }

  #clearAllSweepTimers() {
    for (const timers of this.#sweepTimers.values()) {
      for (const timer of timers) {
        clearTimeout(timer);
      }
    }
    this.#sweepTimers.clear();
  }

  #pruneExpiredGuards(now = Date.now()) {
    for (const [id, guard] of this.#activeGuards.entries()) {
      if (guard.epoch !== this.#epoch || now >= guard.expiresAt) {
        this.#activeGuards.delete(id);
        this.#clearSweepTimersForScope(id);
      }
    }
  }

  #aliasesFor(app) {
    const info = this.#resolveTargetInfo(app) || {};
    return uniqueAliases([info.bundleId, info.appDisplayName, info.appQuery, app]);
  }

  recordSteal(app, routeKey) {
    const info = this.#resolveTargetInfo(app) || {};
    for (const alias of uniqueAliases([info.bundleId, info.appDisplayName, info.appQuery, app])) {
      this.#tracker.record(alias, routeKey);
    }
    this.#onFocusStealPrevented?.({
      app: info.appDisplayName || app,
      targetApp: info.bundleId || app,
      routeKey: routeKey || null,
    });
  }

  async #captureProtectedFrontmost(app) {
    if (!app || !this.#focusController) return null;
    const frontNow = await this.#focusController.getFrontmostApp();
    if (!frontNow?.pid) return null;

    this.#pruneExpiredGuards();
    for (const guard of this.#activeGuards.values()) {
      const guardedApp = guard.app || app;
      const targetInfo = this.#resolveTargetInfo(guardedApp);
      if (didTargetStealFocus(guard.frontBefore, frontNow, targetInfo)) {
        if (this.#isHumanTakeoverActive(guard, targetInfo, frontNow)) {
          continue;
        }
        await this.#focusController.restoreFrontmostApp(guard.frontBefore.pid, {
          expectedFrontmostPid: frontNow.pid,
          expectedFrontmostProcessToken: frontNow.processToken || null,
          expectedRestoreProcessToken: guard.frontBefore.processToken || null,
        });
        const key = guard.routeKey || "__default__";
        if (!guard.scopeState.recordedRoutes.has(key)) {
          guard.scopeState.recordedRoutes.add(key);
          this.recordSteal(guardedApp, guard.routeKey);
        }
        return guard.frontBefore;
      }
    }
    return frontNow;
  }

  #isHumanTakeoverActive(guardOrScope, targetInfo = {}, frontNow = null) {
    const capturedVer = guardOrScope?.humanIntentVersion ?? this.#humanFocusIntentVersion;
    if (this.#humanFocusIntentVersion !== capturedVer) {
      if (
        !this.#humanFocusTargetPid ||
        this.#humanFocusTargetPid === targetInfo?.pid ||
        this.#humanFocusTargetPid === frontNow?.pid
      ) {
        return true;
      }
    }
    if (
      this.#humanFocusTargetPid &&
      frontNow?.pid &&
      frontNow.pid === this.#humanFocusTargetPid
    ) {
      return true;
    }
    return false;
  }

  async #enforce(frontBefore, app, epoch, _scopeId, scopeState, routeKey = null) {
    if (!frontBefore?.pid || !app || epoch !== this.#epoch || !this.#focusController) return false;
    if (scopeState.humanIntentVersion !== undefined && scopeState.humanIntentVersion !== this.#humanFocusIntentVersion) {
      const targetInfoPre = this.#resolveTargetInfo(app);
      if (!this.#humanFocusTargetPid || this.#humanFocusTargetPid === targetInfoPre?.pid) {
        return false;
      }
    }
    const frontNow = await this.#focusController.getFrontmostApp();
    if (!frontNow?.pid || epoch !== this.#epoch) return false;
    const targetInfo = this.#resolveTargetInfo(app);
    if (didTargetStealFocus(frontBefore, frontNow, targetInfo)) {
      if (this.#isHumanTakeoverActive(scopeState, targetInfo, frontNow)) {
        return false;
      }
      await this.#focusController.restoreFrontmostApp(frontBefore.pid, {
        expectedFrontmostPid: frontNow.pid,
        expectedFrontmostProcessToken: frontNow.processToken || null,
        expectedRestoreProcessToken: frontBefore.processToken || null,
      });
      const effectiveRoute = routeKey || scopeState.routeKey || null;
      const key = effectiveRoute || "__default__";
      if (!scopeState.recordedRoutes.has(key)) {
        scopeState.recordedRoutes.add(key);
        this.recordSteal(app, effectiveRoute);
      }
      return true;
    }
    return false;
  }

  #scheduleSweep(frontBefore, app, epoch, scopeId, scopeState, { routeKey = null, alreadyRecorded = false } = {}) {
    if (routeKey) scopeState.routeKey = routeKey;
    if (alreadyRecorded) {
      scopeState.recordedRoutes.add(scopeState.routeKey || "__default__");
    }
    if (!frontBefore?.pid || !app || epoch !== this.#epoch || !this.#focusController) return;
    if (
      scopeState.humanIntentVersion !== undefined &&
      scopeState.humanIntentVersion !== this.#humanFocusIntentVersion
    ) {
      const tInfo = this.#resolveTargetInfo(app);
      if (!this.#humanFocusTargetPid || this.#humanFocusTargetPid === tInfo?.pid) {
        return;
      }
    }
    const targetInfo = this.#resolveTargetInfo(app);
    if (matchesTargetIdentity(frontBefore, targetInfo)) return;

    const delays = Array.isArray(this.#focusController.sweepDelaysMs)
      ? this.#focusController.sweepDelaysMs.filter((d) => Number.isFinite(d) && d > 0)
      : [];
    if (delays.length === 0) return;

    this.#pruneExpiredGuards();
    this.#clearSweepTimersForScope(scopeId);

    const maxDelay = Math.max(...delays);
    this.#activeGuards.set(scopeId, {
      scopeId,
      scopeState,
      humanIntentVersion: scopeState.humanIntentVersion ?? this.#humanFocusIntentVersion,
      frontBefore,
      app,
      epoch,
      routeKey: scopeState.routeKey,
      expiresAt: Date.now() + maxDelay + 120,
    });

    const scopeTimers = new Set();
    this.#sweepTimers.set(scopeId, scopeTimers);
    for (const delayMs of delays) {
      const timer = setTimeout(() => {
        scopeTimers.delete(timer);
        if (scopeTimers.size === 0) {
          this.#sweepTimers.delete(scopeId);
        }
        void this.#enforce(frontBefore, app, epoch, scopeId, scopeState, scopeState.routeKey);
      }, delayMs);
      timer.unref?.();
      scopeTimers.add(timer);
    }
  }

  createScope(app, frontBefore, epoch = this.#epoch) {
    const scopeId = ++this.#nextScopeId;
    const scopeState = {
      routeKey: null,
      recordedRoutes: new Set(),
      humanIntentVersion: this.#humanFocusIntentVersion,
    };
    return {
      scopeId,
      app,
      frontBefore,
      epoch,
      enforce: (routeKey = null) => this.#enforce(frontBefore, app, epoch, scopeId, scopeState, routeKey),
      finish: (routeKey = null, { alreadyRecorded = false } = {}) =>
        this.#scheduleSweep(frontBefore, app, epoch, scopeId, scopeState, { routeKey, alreadyRecorded }),
    };
  }

  async beginGuard(app) {
    const epoch = this.#epoch;
    const frontBefore = app ? await this.#captureProtectedFrontmost(app) : null;
    return this.createScope(app, frontBefore, epoch);
  }

  cancelForExplicitRaise() {
    this.#epoch += 1;
    this.#activeGuards.clear();
    this.#clearAllSweepTimers();
  }

  /**
   * Cancel active reclaim sweeps targeting `targetPid` when the human explicitly
   * takes over that target window (click/switch/type), while keeping sweeps for
   * unrelated background apps intact.
   */
  cancelForHumanTargetTakeover(targetPid = null) {
    this.#humanFocusIntentVersion += 1;
    const pidNum = Number(targetPid) > 0 ? Number(targetPid) : null;
    this.#humanFocusTargetPid = pidNum;
    if (!pidNum) {
      return this.#humanFocusIntentVersion;
    }
    for (const [scopeId, guard] of this.#activeGuards.entries()) {
      const info = this.#resolveTargetInfo(guard.app);
      if (info?.pid === pidNum) {
        this.#activeGuards.delete(scopeId);
        this.#clearSweepTimersForScope(scopeId);
      }
    }
    return this.#humanFocusIntentVersion;
  }

  clearHumanTargetTakeover() {
    this.#humanFocusTargetPid = null;
  }

  close() {
    this.cancelForExplicitRaise();
  }

  planClick(args = {}, aliases = [], { allowAccessibilityFallback = false } = {}) {
    const list = uniqueAliases(aliases.length ? aliases : this.#aliasesFor(args?.app));
    return planBackgroundClickMethods(args, {
      allowAccessibilityFallback,
      blockedMethods: this.#tracker.getBlockedMethodsForAliases(list, "click"),
      avoidSkyFocus: this.#tracker.hasSkyFocusSteal(...list),
    });
  }

  planKey(toolName, args = {}, aliases = []) {
    const list = uniqueAliases(aliases.length ? aliases : this.#aliasesFor(args?.app));
    return planBackgroundKeyMethods(args, {
      blockedMethods: this.#tracker.getBlockedMethodsForAliases(list, toolName),
      avoidSkyFocus: this.#tracker.hasSkyFocusSteal(...list),
    });
  }

  isMethodBlocked(aliases = [], toolName = "click", method = "") {
    return this.#tracker
      .getBlockedMethodsForAliases(uniqueAliases(aliases), toolName)
      .includes(String(method || "").trim().toLowerCase());
  }

  hasPriorSteal(aliases = [], ...routeKeys) {
    const list = uniqueAliases(aliases);
    return list.some((alias) =>
      routeKeys.some((routeKey) => this.#tracker.hasRouteSteal(alias, routeKey))
    );
  }
}
