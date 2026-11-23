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

function normalizeScopeToken(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function resolveScopeProc(routeScope) {
  if (!routeScope || typeof routeScope !== "object") return "";
  const token = normalizeScopeToken(routeScope.processToken);
  if (token) return token;
  const pid = Number(routeScope.pid);
  if (Number.isInteger(pid) && pid > 0) return String(pid);
  return "";
}

function recordScopeKeyFor(routeScope = null) {
  if (!routeScope || typeof routeScope !== "object") return "*";
  const wid = Number(routeScope.windowId);
  const proc = resolveScopeProc(routeScope);
  if (Number.isInteger(wid) && wid > 0) {
    return `w:${proc || "*"}:${wid}`;
  }
  if (proc) {
    return `p:${proc}`;
  }
  return "*";
}

function lookupScopeKeysFor(routeScope = null) {
  if (!routeScope || typeof routeScope !== "object") {
    return ["*"];
  }
  const wid = Number(routeScope.windowId);
  const proc = resolveScopeProc(routeScope);
  if (Number.isInteger(wid) && wid > 0) {
    return proc ? [`w:${proc}:${wid}`, `w:*:${wid}`, "*"] : [`w:*:${wid}`, "*"];
  }
  if (proc) {
    return [`p:${proc}`, "*"];
  }
  return ["*"];
}

/**
 * Adaptive tracker recording `(appAlias, scope, DeliveryRoute)` tuples that caused Focus Steals,
 * while strictly preserving the Window-Local Delivery Floor (`window_post`, `window_key`).
 */
export class SelfActivationTracker {
  #routes = new Map();

  record(appKey, routeKey, { routeScope = null } = {}) {
    const app = typeof appKey === "string" ? appKey.trim().toLowerCase() : "";
    const parsed = parseDeliveryRoute(routeKey);
    if (!app || !parsed.normalized) return;
    if (WINDOW_LOCAL_DELIVERY_FLOOR.has(parsed.method)) return;
    const scopeKey = recordScopeKeyFor(routeScope);
    let scopes = this.#routes.get(app);
    if (!scopes) {
      scopes = new Map();
      this.#routes.set(app, scopes);
    }
    let set = scopes.get(scopeKey);
    if (!set) {
      set = new Set();
      scopes.set(scopeKey, set);
    }
    set.add(parsed.normalized);
  }

  getBlockedMethods(appKey, toolName = "click", opts = {}) {
    return this.getBlockedMethodsForAliases([appKey], toolName, opts);
  }

  getBlockedMethodsForAliases(appKeys = [], toolName = "click", { routeScope = null } = {}) {
    const targetTool = String(toolName || "click").trim().toLowerCase();
    const blocked = new Set();
    const scopeKeys = lookupScopeKeysFor(routeScope);
    for (const rawKey of appKeys) {
      const app = typeof rawKey === "string" ? rawKey.trim().toLowerCase() : "";
      if (!app) continue;
      const scopes = this.#routes.get(app);
      if (!scopes) continue;
      for (const scopeKey of scopeKeys) {
        const set = scopes.get(scopeKey);
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
    }
    return Array.from(blocked);
  }

  hasRouteSteal(appKey, routeKey, { routeScope = null } = {}) {
    const app = typeof appKey === "string" ? appKey.trim().toLowerCase() : "";
    const parsed = parseDeliveryRoute(routeKey);
    if (!app || !parsed.normalized) return false;
    const scopes = this.#routes.get(app);
    if (!scopes) return false;
    for (const scopeKey of lookupScopeKeysFor(routeScope)) {
      if (scopes.get(scopeKey)?.has(parsed.normalized)) return true;
    }
    return false;
  }

  hasSkyFocusSteal(...appKeys) {
    for (const rawKey of appKeys) {
      const app = typeof rawKey === "string" ? rawKey.trim().toLowerCase() : "";
      if (!app) continue;
      const scopes = this.#routes.get(app);
      if (!scopes) continue;
      for (const set of scopes.values()) {
        if (
          set.has("click:sky_click") ||
          set.has("press_key:sky_key") ||
          set.has("type_text:sky_key") ||
          set.has("set_value:sky_bypass")
        ) {
          return true;
        }
      }
    }
    return false;
  }
}

export function planBackgroundClickMethods(
  args = {},
  {
    allowAccessibilityFallback = false,
    blockedMethods = [],
    avoidSkyFocus = false,
    windowPostAvailable = true,
  } = {}
) {
  const blocked = new Set(
    Array.from(blockedMethods || []).map((m) => String(m || "").trim().toLowerCase())
  );
  for (const floorMethod of WINDOW_LOCAL_DELIVERY_FLOOR) {
    blocked.delete(floorMethod);
  }

  const floorAvailable = windowPostAvailable !== false;
  const skyBlocked = Boolean(avoidSkyFocus) || blocked.has("sky_click");
  const rawMethod = typeof args.click_method === "string" ? args.click_method.trim().toLowerCase() : "";
  const explicit = rawMethod && rawMethod !== "auto" && rawMethod !== "global" ? rawMethod : null;

  const button = (args.mouse_button || "left").toLowerCase();
  const count = args.click_count ?? 1;

  const filterNonActivating = (candidates) => {
    const filtered = candidates.filter(
      (m) =>
        (floorAvailable || m !== "window_post") &&
        !blocked.has(m) &&
        !(skyBlocked && m === "sky_click")
    );
    if (filtered.length > 0) return filtered;
    return floorAvailable ? ["window_post"] : [];
  };

  if (explicit === "accessibility") {
    const nonFloorBase =
      button === "left" && (count === 1 || count === 2) && !skyBlocked
        ? ["sky_click", "app_post"]
        : ["app_post"];
    const base = skyBlocked ? ["window_post", "app_post"] : nonFloorBase;
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
  { blockedMethods = [], avoidSkyFocus = false, windowKeyAvailable = true } = {}
) {
  const blocked = new Set(
    Array.from(blockedMethods || []).map((m) => String(m || "").trim().toLowerCase())
  );
  for (const floorMethod of WINDOW_LOCAL_DELIVERY_FLOOR) {
    blocked.delete(floorMethod);
  }
  const floorAvailable = windowKeyAvailable !== false;
  const skyKeyDirectlyBlocked = blocked.has("sky_key");
  const preferWindowKey = Boolean(avoidSkyFocus) || skyKeyDirectlyBlocked;
  const rawMethod = typeof args.key_method === "string" ? args.key_method.trim().toLowerCase() : "";
  const explicit = rawMethod && rawMethod !== "auto" && rawMethod !== "global" ? rawMethod : null;
  if (explicit === "window_key") {
    return ["window_key"];
  }
  if (explicit) {
    if (explicit === "sky_key" && preferWindowKey) {
      if (!floorAvailable) return skyKeyDirectlyBlocked ? [] : ["sky_key"];
      return skyKeyDirectlyBlocked ? ["window_key"] : ["window_key", "sky_key"];
    }
    if (blocked.has(explicit)) {
      return floorAvailable ? ["window_key"] : [];
    }
    return [explicit];
  }
  if (preferWindowKey) {
    if (!floorAvailable) return [];
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
  #activeObservationScopes = new Set();
  #globalObsVersion = 0;

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
        this.#activeObservationScopes.delete(id);
        if (guard.scopeState) guard.scopeState.inObservationPhase = false;
        this.#clearSweepTimersForScope(id);
      }
    }
  }

  #aliasesFor(app) {
    const info = this.#resolveTargetInfo(app) || {};
    return uniqueAliases([info.bundleId, info.appDisplayName, info.appQuery, app]);
  }

  recordSteal(app, routeKey, { routeScope = null, recordRoutePenalty = true, emitTelemetry = true } = {}) {
    const info = this.#resolveTargetInfo(app) || {};
    if (recordRoutePenalty !== false) {
      for (const alias of uniqueAliases([info.bundleId, info.appDisplayName, info.appQuery, app])) {
        this.#tracker.record(alias, routeKey, { routeScope });
      }
    }
    if (emitTelemetry !== false) {
      this.#onFocusStealPrevented?.({
        app: info.appDisplayName || app,
        targetApp: info.bundleId || app,
        routeKey: routeKey || null,
        routePenaltyRecorded: recordRoutePenalty !== false,
      });
    }
  }

  #recordScopeStealOutcome(app, guardOrState, effectiveRoute, { penaltyAllowed, routeScope }) {
    const key = effectiveRoute || "__default__";
    const needPenalty = penaltyAllowed && !guardOrState.recordedRoutes.has(key);
    const needTelemetry = !guardOrState.recordedTelemetry.has(key);
    if (!needPenalty && !needTelemetry) return;
    if (needPenalty) guardOrState.recordedRoutes.add(key);
    if (needTelemetry) guardOrState.recordedTelemetry.add(key);
    this.recordSteal(app, effectiveRoute, {
      routeScope,
      recordRoutePenalty: needPenalty,
      emitTelemetry: needTelemetry,
    });
  }

  async #captureProtectedFrontmost(app) {
    if (!app || !this.#focusController) return null;
    this.#pruneExpiredGuards();
    const preGlobalObsVersion = this.#globalObsVersion;
    const preGlobalObsActive = this.#activeObservationScopes.size > 0;
    const preObsSnapshots = new Map();
    for (const [id, guard] of this.#activeGuards.entries()) {
      preObsSnapshots.set(id, {
        obsVersion: guard.scopeState?.obsVersion || 0,
        inObservationPhase: Boolean(guard.scopeState?.inObservationPhase),
      });
    }
    const frontNow = await this.#focusController.getFrontmostApp();
    if (!frontNow?.pid) return null;

    this.#pruneExpiredGuards();
    for (const [id, guard] of this.#activeGuards.entries()) {
      const guardedApp = guard.app || app;
      const targetInfo = this.#resolveTargetInfo(guardedApp);
      if (didTargetStealFocus(guard.frontBefore, frontNow, targetInfo)) {
        if (this.#isHumanTakeoverActive(guard, targetInfo, frontNow)) {
          continue;
        }
        const restored = await this.#focusController.restoreFrontmostApp(guard.frontBefore.pid, {
          expectedFrontmostPid: frontNow.pid,
          expectedFrontmostProcessToken: frontNow.processToken || null,
          expectedRestoreProcessToken: guard.frontBefore.processToken || null,
        });
        if (restored === false) {
          const refreshed = await this.#focusController.getFrontmostApp().catch(() => null);
          if (!refreshed?.pid || matchesTargetIdentity(refreshed, targetInfo)) {
            return null;
          }
          return refreshed;
        }
        const preObs = preObsSnapshots.get(id) || {
          obsVersion: guard.scopeState?.obsVersion || 0,
          inObservationPhase: Boolean(guard.scopeState?.inObservationPhase),
        };
        const penaltyAllowed =
          guard.recordRoutePenalty !== false &&
          guard.scopeState?.recordRoutePenalty !== false &&
          !preObs.inObservationPhase &&
          !guard.scopeState?.inObservationPhase &&
          (guard.scopeState?.obsVersion || 0) === preObs.obsVersion &&
          !preGlobalObsActive &&
          this.#activeObservationScopes.size === 0 &&
          this.#globalObsVersion === preGlobalObsVersion;
        this.#recordScopeStealOutcome(guardedApp, guard.scopeState, guard.routeKey, {
          penaltyAllowed,
          routeScope: guard.routeScope ?? guard.scopeState?.routeScope ?? null,
        });
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

  async #enforce(
    frontBefore,
    app,
    epoch,
    _scopeId,
    scopeState,
    routeKey = null,
    { recordRoutePenalty = true, routeScope = undefined } = {}
  ) {
    const preObsVersion = scopeState.obsVersion || 0;
    const preGlobalObsVersion = this.#globalObsVersion;
    const preGlobalObsActive = this.#activeObservationScopes.size > 0;
    const effectivePenalty =
      recordRoutePenalty !== false &&
      scopeState.recordRoutePenalty !== false &&
      !scopeState.inObservationPhase &&
      !preGlobalObsActive;
    const effectiveScope =
      routeScope !== undefined ? routeScope : (scopeState.routeScope ?? null);
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
      const restored = await this.#focusController.restoreFrontmostApp(frontBefore.pid, {
        expectedFrontmostPid: frontNow.pid,
        expectedFrontmostProcessToken: frontNow.processToken || null,
        expectedRestoreProcessToken: frontBefore.processToken || null,
      });
      if (restored === false) {
        return false;
      }
      const penaltyAllowedNow =
        effectivePenalty &&
        !scopeState.inObservationPhase &&
        scopeState.recordRoutePenalty !== false &&
        (scopeState.obsVersion || 0) === preObsVersion &&
        this.#activeObservationScopes.size === 0 &&
        this.#globalObsVersion === preGlobalObsVersion;
      const effectiveRoute = routeKey || scopeState.routeKey || null;
      this.#recordScopeStealOutcome(app, scopeState, effectiveRoute, {
        penaltyAllowed: penaltyAllowedNow,
        routeScope: effectiveScope,
      });
      return true;
    }
    return false;
  }

  #scheduleSweep(
    frontBefore,
    app,
    epoch,
    scopeId,
    scopeState,
    {
      routeKey = null,
      alreadyRecorded = false,
      recordRoutePenalty = undefined,
      routeScope = undefined,
    } = {}
  ) {
    if (routeKey) scopeState.routeKey = routeKey;
    if (recordRoutePenalty === false) scopeState.recordRoutePenalty = false;
    if (routeScope !== undefined) scopeState.routeScope = routeScope;
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
      routeScope: scopeState.routeScope ?? null,
      recordRoutePenalty: scopeState.recordRoutePenalty !== false,
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
        void this.#enforce(frontBefore, app, epoch, scopeId, scopeState, scopeState.routeKey, {
          recordRoutePenalty: scopeState.recordRoutePenalty !== false,
          routeScope: scopeState.routeScope ?? null,
        });
      }, delayMs);
      timer.unref?.();
      scopeTimers.add(timer);
    }
  }

  createScope(app, frontBefore, epoch = this.#epoch, { routeScope = null } = {}) {
    const scopeId = ++this.#nextScopeId;
    const scopeState = {
      routeKey: null,
      recordedRoutes: new Set(),
      recordedTelemetry: new Set(),
      humanIntentVersion: this.#humanFocusIntentVersion,
      routeScope,
      recordRoutePenalty: true,
      inObservationPhase: false,
      obsVersion: 0,
    };
    return {
      scopeId,
      app,
      frontBefore,
      epoch,
      enterObservationPhase: () => {
        scopeState.obsVersion += 1;
        this.#globalObsVersion += 1;
        scopeState.inObservationPhase = true;
        this.#activeObservationScopes.add(scopeId);
      },
      exitObservationPhase: () => {
        scopeState.inObservationPhase = false;
        this.#activeObservationScopes.delete(scopeId);
      },
      enforceObservation: (routeScopeOverride = undefined) =>
        this.#enforce(frontBefore, app, epoch, scopeId, scopeState, "read_back", {
          recordRoutePenalty: false,
          routeScope: routeScopeOverride,
        }),
      enforce: (routeKey = null, opts = {}) =>
        this.#enforce(frontBefore, app, epoch, scopeId, scopeState, routeKey, opts),
      finish: (routeKey = null, { alreadyRecorded = false, recordRoutePenalty = undefined, routeScope: finishScope = undefined } = {}) => {
        scopeState.inObservationPhase = false;
        this.#activeObservationScopes.delete(scopeId);
        return this.#scheduleSweep(frontBefore, app, epoch, scopeId, scopeState, {
          routeKey,
          alreadyRecorded,
          recordRoutePenalty,
          routeScope: finishScope,
        });
      },
    };
  }

  async beginGuard(app, { routeScope = null } = {}) {
    const epoch = this.#epoch;
    const frontBefore = app ? await this.#captureProtectedFrontmost(app) : null;
    return this.createScope(app, frontBefore, epoch, { routeScope });
  }

  cancelForExplicitRaise() {
    this.#epoch += 1;
    for (const guard of this.#activeGuards.values()) {
      if (guard.scopeState) guard.scopeState.inObservationPhase = false;
    }
    this.#activeObservationScopes.clear();
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
        if (guard.scopeState) guard.scopeState.inObservationPhase = false;
        this.#activeObservationScopes.delete(scopeId);
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

  planClick(
    args = {},
    aliases = [],
    { allowAccessibilityFallback = false, routeScope = null, windowPostAvailable = true } = {}
  ) {
    const list = uniqueAliases(aliases.length ? aliases : this.#aliasesFor(args?.app));
    return planBackgroundClickMethods(args, {
      allowAccessibilityFallback,
      blockedMethods: this.#tracker.getBlockedMethodsForAliases(list, "click", { routeScope }),
      avoidSkyFocus: false,
      windowPostAvailable,
    });
  }

  planKey(toolName, args = {}, aliases = [], { routeScope = null, windowKeyAvailable = true } = {}) {
    const list = uniqueAliases(aliases.length ? aliases : this.#aliasesFor(args?.app));
    return planBackgroundKeyMethods(args, {
      blockedMethods: this.#tracker.getBlockedMethodsForAliases(list, toolName, { routeScope }),
      avoidSkyFocus: false,
      windowKeyAvailable,
    });
  }

  isMethodBlocked(aliases = [], toolName = "click", method = "", { routeScope = null } = {}) {
    return this.#tracker
      .getBlockedMethodsForAliases(uniqueAliases(aliases), toolName, { routeScope })
      .includes(String(method || "").trim().toLowerCase());
  }

  hasPriorStealForScope(aliases = [], routeKeys = [], routeScope = null) {
    const list = uniqueAliases(aliases);
    return list.some((alias) =>
      routeKeys.some((routeKey) => this.#tracker.hasRouteSteal(alias, routeKey, { routeScope }))
    );
  }

  hasPriorSteal(aliases = [], ...routeKeys) {
    let routeScope = null;
    let keys = routeKeys;
    if (keys.length > 0) {
      const last = keys[keys.length - 1];
      if (last && typeof last === "object" && !Array.isArray(last)) {
        routeScope = last.routeScope ?? null;
        keys = keys.slice(0, -1);
      }
    }
    return this.hasPriorStealForScope(aliases, keys, routeScope);
  }
}
