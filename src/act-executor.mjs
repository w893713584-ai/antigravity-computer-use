import {
  extractResultImage,
  extractResultText,
  findRunningApp,
  launchAppInBackground,
  parseSnapshotMetadata,
  unhideAppWithoutActivating,
} from "./background-policy.mjs";
import {
  buildRouteScopeFromMeta,
  evaluateScreenshotMetaProof,
  normalizeElementBounds,
} from "./app-snapshot-registry.mjs";
import { dedupeSpatiallyOverlappingMatches } from "./action-executor.mjs";
import { normalizeRectPt } from "./preview-geometry.mjs";
import { isTakeoverAbortedError } from "./takeover-controller.mjs";

/**
 * Format an `act` MCP tool result consistently across executor outcomes and pre-queue cancellation.
 */
export function buildActToolResult({
  isError = false,
  status = "ok",
  code = null,
  message = null,
  deliveryState = null,
  verified = false,
  sent = false,
  clicksSent = 0,
  steps = 0,
  matchCount = 0,
  route = null,
  windowTitle = null,
  latestImage = null,
} = {}) {
  const payload = {
    status,
    ...(code ? { code } : {}),
    ...(deliveryState ? { deliveryState } : {}),
    verified: Boolean(verified),
    sent: Boolean(sent),
    clicksSent,
    steps,
    matchCount,
    ...(route ? { route } : {}),
    ...(windowTitle ? { windowTitle } : {}),
    ...(message ? { message } : {}),
  };
  const prefix = code && isError ? `[${code}] ` : "";
  const content = [{ type: "text", text: `${prefix}${JSON.stringify(payload)}` }];
  if (latestImage?.type === "image" && latestImage.data) {
    content.push(latestImage);
  }
  return {
    isError: Boolean(isError),
    ...(deliveryState ? { deliveryState } : {}),
    ...(deliveryState === "sent_unknown" ? { fatal: true } : {}),
    content,
  };
}

/**
 * Deep Module: AtomicActExecutor
 *
 * Encapsulates the serialized `act` transaction behind a single `execute(args, ctx)` seam:
 * app-ready preparation, filtered & deduplicated query resolution, progressive reveal scrolling
 * with stagnation detection, AXParent target resolution, single background click dispatch, and
 * playback-proof semantic `expect` polling.
 */
export class AtomicActExecutor {
  constructor({
    getActionPeer,
    getAxBridge = () => null,
    registry,
    actionExecutor,
    takeoverController,
    getRunningAppIdentityFn = () => null,
    isBrokerPaused = () => false,
    checkAppRunning,
    safeGetAppState,
    processQueryResult,
    registerOperationTarget = () => {},
    isSameActiveApp = () => false,
    onAdoptFollowTarget = () => {},
    onMutationRecorded = () => {},
    onVerifiedMutationRecorded = () => {},
  } = {}) {
    this.getActionPeer = getActionPeer;
    this.getAxBridge = getAxBridge;
    this.registry = registry;
    this.actionExecutor = actionExecutor;
    this.takeoverController = takeoverController;
    this.getRunningAppIdentityFn = getRunningAppIdentityFn;
    this.isBrokerPaused = isBrokerPaused;
    this.checkAppRunning = checkAppRunning;
    this.safeGetAppState = safeGetAppState;
    this.processQueryResult = processQueryResult;
    this.registerOperationTarget = registerOperationTarget;
    this.isSameActiveApp = isSameActiveApp;
    this.onAdoptFollowTarget = onAdoptFollowTarget;
    this.onMutationRecorded = onMutationRecorded;
    this.onVerifiedMutationRecorded = onVerifiedMutationRecorded;
  }

  #buildToolResult(opts = {}) {
    return buildActToolResult(opts);
  }

  #buildTakeoverAbortResult(err, steps = 0, matchCount = 0) {
    const sentUnknown = err?.deliveryState === "sent_unknown";
    return this.#buildToolResult({
      isError: true,
      status: "cancelled",
      code: err?.code || "PAUSED",
      deliveryState: err?.deliveryState || null,
      message: err?.message || "操作已被暂停或取消。",
      sent: sentUnknown,
      clicksSent: sentUnknown && matchCount > 0 ? 1 : 0,
      steps,
      matchCount,
    });
  }

  async #sleepWithSignal(ms, signal = null) {
    if (ms <= 0 || signal?.aborted) return;
    await new Promise((resolve) => {
      let timer = null;
      const onAbort = () => {
        if (timer) clearTimeout(timer);
        resolve();
      };
      timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  #isPeerTimeoutError(err) {
    return Boolean(err && /\btimed out after \d+ms\b/iu.test(String(err.message || err)));
  }

  #extractAxBodyText(rawText) {
    const lines = String(rawText || "").split(/\r?\n/);
    const body = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (/^(?:App=|Window:|\[Snapshot:)/u.test(trimmed)) continue;
      body.push(line);
    }
    return body.join("\n");
  }

  async #ensureAppReady(
    app,
    {
      isAiSource,
      shouldFollow,
      focusScope,
      signal = null,
      operation = null,
      explicitWindowId = null,
      deadlineAt = 0,
      markOsTouched,
    }
  ) {
    const actionPeer = this.getActionPeer();
    const axBridge = this.getAxBridge();
    const runningIdentityFn = this.getRunningAppIdentityFn();

    const check = await this.checkAppRunning(actionPeer, app);
    if (!check.running) {
      if (!isAiSource) {
        return {
          ok: false,
          result: this.#buildToolResult({
            isError: true,
            status: "failed",
            code: "APP_NOT_RUNNING",
            message: `目标应用 "${app}" 未在运行。`,
          }),
        };
      }
      this.takeoverController.assertMayDispatch(operation, { isRead: false });
      markOsTouched("act:launch");
      const launchPromise = launchAppInBackground(app);
      await (operation && typeof this.takeoverController?.trackNativeWrite === "function"
        ? this.takeoverController.trackNativeWrite(operation, launchPromise, {
            routeKey: "app:launch_in_background",
          })
        : launchPromise);
      await this.safeGetAppState(
        actionPeer,
        { app, include_ax: true, include_screenshot: true, max_tree_nodes: 200 },
        {
          updateActiveApp: shouldFollow,
          allowLaunch: false,
          timeoutMs: Math.max(80, deadlineAt - Date.now()),
          operation,
        }
      );
      await focusScope?.enforce("act:launch");
    }

    let meta = this.registry.getMeta(app);
    const listMatch = findRunningApp(check.apps, app);
    let resolvedIdentity = null;
    if (!meta?.pid && !listMatch?.pid && typeof runningIdentityFn === "function") {
      resolvedIdentity = await runningIdentityFn(app, { axBridge }).catch(() => null);
    }
    let pid = meta?.pid || listMatch?.pid || resolvedIdentity?.pid || null;
    const processToken = meta?.processToken || resolvedIdentity?.processToken || null;
    if (pid > 0 || Number(explicitWindowId) > 0) {
      this.registerOperationTarget(
        operation,
        app,
        {
          ...(meta || {}),
          ...(resolvedIdentity || {}),
          ...(pid ? { pid } : {}),
          ...(processToken ? { processToken } : {}),
        },
        explicitWindowId
      );
    }
    if (pid > 0) {
      const wakePromise = this.registry.ensureRendererAxAwake(pid, processToken, {
        beforeWriteCheck: isAiSource
          ? () => this.takeoverController.assertMayDispatch(operation, { isRead: false })
          : null,
      });
      const wake =
        operation && typeof this.takeoverController?.trackNativeWrite === "function"
          ? await this.takeoverController.trackNativeWrite(operation, wakePromise, {
              routeKey: "ax:ensure_manual",
            })
          : await wakePromise;
      if (wake?.changed) {
        await this.#sleepWithSignal(35, signal);
      }
    }

    if (signal?.aborted) {
      const isPause =
        signal.reason?.code === "PAUSED" || (isAiSource && this.takeoverController.paused);
      return {
        ok: false,
        result: this.#buildToolResult({
          isError: true,
          status: "cancelled",
          code: isPause ? "PAUSED" : "CANCELLED",
          message: isPause
            ? signal.reason?.message || "Computer Use 已被用户暂停。"
            : "调用在准备阶段已取消。",
        }),
      };
    }

    if (!meta?.actionFrameWidth && !(Number(explicitWindowId) > 0)) {
      markOsTouched("act:warm_state");
      await this.safeGetAppState(
        actionPeer,
        { app, include_ax: true, include_screenshot: true, max_tree_nodes: 200 },
        {
          updateActiveApp: shouldFollow,
          allowLaunch: false,
          timeoutMs: Math.max(80, deadlineAt - Date.now()),
          operation,
        }
      );
      await focusScope?.enforce("act:warm_state");
      meta = this.registry.getMeta(app);
      pid = meta?.pid || pid || null;
    }

    if (
      pid > 0 &&
      typeof axBridge?.resolveActionTarget === "function" &&
      (!meta?.windowBounds ||
        (Number(explicitWindowId) > 0 && meta?.windowId !== Number(explicitWindowId)))
    ) {
      const resolvedWin = await axBridge
        .resolveActionTarget(pid, {
          wid: explicitWindowId || meta?.tinyWindowOverride?.wid || meta?.windowId || null,
          windowTitle: meta?.windowTitle || "",
          windowBounds: meta?.tinyWindowOverride?.bounds || null,
        })
        .catch(() => null);
      if (resolvedWin?.windowBounds) {
        meta = this.registry.recordMeta(
          app,
          {
            pid,
            bundleId: meta?.bundleId || resolvedIdentity?.bundleId || null,
            appDisplayName: meta?.appDisplayName || resolvedIdentity?.displayName || null,
            windowId: resolvedWin.wid || explicitWindowId || meta?.windowId || null,
            windowBounds: resolvedWin.windowBounds,
          },
          { fromActionPeer: false, includeAx: false, includeScreenshot: false, preserveScreenshotState: true }
        );
      }
    }

    if (shouldFollow && !this.isSameActiveApp(app) && meta) {
      this.onAdoptFollowTarget({
        activeApp: meta.bundleId || app,
        bundleId: meta.bundleId ?? null,
        pid: meta.pid ?? pid ?? null,
        appDisplayName: meta.appDisplayName || app,
        windowTitle: meta.windowTitle ?? null,
      });
    }

    return {
      ok: true,
      pid: meta?.pid || pid || null,
      processToken: meta?.processToken || processToken || null,
      resolvedIdentity,
    };
  }

  async #runQuery(
    app,
    target,
    {
      pid,
      processToken,
      resolvedIdentity,
      windowId,
      focusScope,
      operation = null,
      signal = null,
      deadlineAt = 0,
      remainingBudgetMs = 4000,
    }
  ) {
    const actionPeer = this.getActionPeer();
    const wantWid = Number(windowId) > 0 ? Number(windowId) : 0;
    const baseQueryArgs = {
      app,
      ...(target.text ? { text: target.text } : {}),
      ...(target.role ? { role: target.role } : {}),
      ...(target.exact === true ? { exact: true } : {}),
      ...(wantWid > 0 ? { window_id: wantWid } : {}),
      limit: 25,
    };

    const currentBudget = () =>
      deadlineAt > 0 ? Math.max(50, deadlineAt - Date.now()) : remainingBudgetMs;
    let queryPeerInstanceId = null;
    const callQuery = async (extra = {}) => {
      const qArgs = { ...baseQueryArgs, ...extra };
      const callTimeout = Math.max(50, Math.min(8000, currentBudget()));
      if (operation?.isAi) {
        this.takeoverController.assertMayDispatch(operation, { isRead: true });
      }
      let rawRes = await actionPeer.callTool("query", qArgs, callTimeout);
      queryPeerInstanceId = actionPeer?.agentInstanceId || null;
      if (rawRes?.isError && /target app is hidden/iu.test(extractResultText(rawRes))) {
        if (!operation?.isAi || !this.takeoverController.paused) {
          if (operation?.isAi) {
            this.takeoverController.assertMayDispatch(operation, { isRead: false });
          }
          const meta = this.registry.getMeta(app);
          const unhidePromise = unhideAppWithoutActivating(meta?.pid || pid, app);
          await (operation && typeof this.takeoverController?.trackNativeWrite === "function"
            ? this.takeoverController.trackNativeWrite(operation, unhidePromise, {
                routeKey: "app:unhide",
              })
            : unhidePromise);
          if (operation?.isAi) {
            this.takeoverController.assertMayDispatch(operation, { isRead: true });
          }
          rawRes = await actionPeer.callTool("query", qArgs, callTimeout);
          queryPeerInstanceId = actionPeer?.agentInstanceId || null;
        }
      }
      await focusScope?.enforce("act:query");
      return this.processQueryResult(app, rawRes, {
        queryPid: pid,
        queryToken: processToken,
        resolvedQueryApp: resolvedIdentity,
        updateActiveSnapshot: false,
      });
    };

    let processed = await callQuery();
    const filterAndDedupe = (proc) => {
      const rawMatches = Array.isArray(proc.parsed?.matches) ? proc.parsed.matches : [];
      const rawWid = Number(proc.parsed?.window_id || 0);
      const filtered = rawMatches.filter((m) => {
        if (!m || typeof m !== "object") return false;
        if (wantWid > 0) {
          const mWid = Number(m.window_id || rawWid || 0);
          if (mWid !== wantWid) return false;
        }
        if (target.identifier) {
          if (String(m.identifier || "").trim() !== String(target.identifier).trim()) {
            return false;
          }
        }
        if (target.exact === true && target.text) {
          const wantText = String(target.text).trim();
          const vals = [m.title, m.value, m.description, m.label, m.text];
          if (!vals.some((v) => typeof v === "string" && v.trim() === wantText)) {
            return false;
          }
        }
        return true;
      });
      const normalizedFiltered = filtered.map((m) =>
        rawWid > 0 && !(Number(m.window_id) > 0) ? { ...m, window_id: rawWid } : m
      );
      return {
        rawMatches,
        rawWid,
        deduped: dedupeSpatiallyOverlappingMatches(normalizedFiltered),
      };
    };

    let evaluated = filterAndDedupe(processed);
    if (
      processed.parsed?.truncated === true &&
      evaluated.deduped.length <= 1 &&
      !signal?.aborted &&
      currentBudget() > 120
    ) {
      processed = await callQuery({ max_nodes: 2500, limit: 50 });
      evaluated = filterAndDedupe(processed);
    }

    const truncatedFailure = Boolean(processed.parsed?.truncated === true && evaluated.deduped.length <= 1);
    return {
      deduped: evaluated.deduped,
      truncatedFailure,
      parsed: processed.parsed,
      merged: processed.merged,
      windowId:
        evaluated.rawWid > 0
          ? evaluated.rawWid
          : Number(evaluated.deduped[0]?.window_id) > 0
            ? Number(evaluated.deduped[0].window_id)
            : null,
      windowTitle: processed.parsed?.window_title || null,
      peerInstanceId: queryPeerInstanceId,
    };
  }

  async #reclaimObservationFocus(focusScope) {
    if (typeof focusScope?.enforceObservation === "function") {
      return focusScope.enforceObservation();
    }
    return focusScope?.enforce?.("read_back", { recordRoutePenalty: false });
  }

  async #captureViewportSignature(
    app,
    target,
    { windowId = null, focusScope, operation = null, deadlineAt = 0 }
  ) {
    const actionPeer = this.getActionPeer();
    const wantWid = Number(windowId) > 0 ? Number(windowId) : 0;
    const rem = () => Math.max(50, Math.min(4000, deadlineAt - Date.now()));
    let winTitle = "";
    let body = "";
    let itemsSig = "";

    focusScope?.enterObservationPhase?.();
    try {
      if (wantWid === 0 && Date.now() < deadlineAt) {
        const stateRes = await this.safeGetAppState(
          actionPeer,
          {
            app,
            include_ax: true,
            include_screenshot: false,
            text_limit: 4000,
            window_placement: "keep",
          },
          {
            updateActiveApp: false,
            allowLaunch: false,
            preserveScreenshotState: true,
            observationalOnly: true,
            timeoutMs: rem(),
            operation,
          }
        ).catch(() => null);
        await this.#reclaimObservationFocus(focusScope);
        if (stateRes && !stateRes.isError) {
          const rawText = extractResultText(stateRes);
          const meta = parseSnapshotMetadata(rawText);
          winTitle = meta.windowTitle || "";
          body = this.#extractAxBodyText(rawText).trim();
        }
      }

      const probeRes =
        Date.now() < deadlineAt
          ? await actionPeer
              .callTool(
                "query",
                {
                  app,
                  ...(wantWid > 0 ? { window_id: wantWid } : {}),
                  ...(target?.role ? { role: target.role } : {}),
                  limit: 8,
                },
                rem()
              )
              .catch(() => null)
          : null;
      await this.#reclaimObservationFocus(focusScope);
      if (probeRes && !probeRes.isError) {
        try {
          const parsed = JSON.parse(extractResultText(probeRes));
          if (!winTitle && parsed?.window_title) winTitle = String(parsed.window_title);
          if (Array.isArray(parsed?.matches) && parsed.matches.length > 0) {
            itemsSig = parsed.matches
              .map((m) => {
                const b = normalizeElementBounds(m?.bounds || m?.frame);
                const pos = b ? `${Math.round(b.x)},${Math.round(b.y)},${Math.round(b.w)},${Math.round(b.h)}` : "";
                return `${m.index ?? ""}:${m.title || m.label || m.identifier || ""}:${pos}`;
              })
              .join("|");
          }
        } catch {}
      }
    } finally {
      focusScope?.exitObservationPhase?.();
    }

    return `${winTitle}::${body}::${itemsSig}`;
  }

  async #evaluateExpect(
    app,
    pid,
    expectSpec,
    {
      windowId = null,
      defaultWindowId = null,
      explicitWindowPinned = false,
      focusScope,
      signal = null,
      operation = null,
      deadlineAt = 0,
    } = {}
  ) {
    const actionPeer = this.getActionPeer();
    const axBridge = this.getAxBridge();
    const wantWid = Number(windowId) > 0 ? Number(windowId) : 0;
    const isPinnedNonDefaultWin = Boolean(
      wantWid > 0 &&
        (explicitWindowPinned || (Number(defaultWindowId) > 0 && wantWid !== Number(defaultWindowId)))
    );
    const rem = () => Math.max(50, Math.min(8000, deadlineAt - Date.now()));

    let stateReadOk = false;
    let stateAmbiguousMultiWindow = false;
    let image = null;
    let winTitle = "";
    let bodyText = "";

    focusScope?.enterObservationPhase?.();
    try {
      if (!isPinnedNonDefaultWin && Date.now() < deadlineAt && !signal?.aborted) {
        const prevShotMeta = this.registry.getMeta(app)?.actionScreenshotMeta || null;
        const stateRes = await this.safeGetAppState(
          actionPeer,
          {
            app,
            include_ax: true,
            include_screenshot: true,
            text_limit: 8000,
            window_placement: "keep",
          },
          {
            updateActiveApp: false,
            allowLaunch: false,
            preserveScreenshotState: true,
            observationalOnly: true,
            timeoutMs: rem(),
            operation,
          }
        ).catch(() => null);
        await this.#reclaimObservationFocus(focusScope);
        stateReadOk = Boolean(stateRes && !stateRes.isError);
        const extractedImg = stateReadOk ? extractResultImage(stateRes) : null;
        const afterMeta = this.registry.getMeta(app);
        const proof =
          typeof this.registry?.evaluateActionScreenshotProof === "function"
            ? this.registry.evaluateActionScreenshotProof(afterMeta, {
                targetWindowId: wantWid > 0 ? wantWid : null,
                requirePositiveWid: true,
              })
            : evaluateScreenshotMetaProof(afterMeta, {
                targetWindowId: wantWid > 0 ? wantWid : null,
                requirePositiveWid: true,
              });
        const freshShotCaptured = Boolean(extractedImg && proof.shotMeta && proof.shotMeta !== prevShotMeta);
        const stateWindowProven = Boolean(freshShotCaptured && proof.sameWindowProven);
        stateAmbiguousMultiWindow = Boolean(
          !stateWindowProven || Number(proof.windowCount) > 1
        );
        image = stateWindowProven ? extractedImg : null;
        if (stateReadOk && stateWindowProven) {
          const rawText = extractResultText(stateRes);
          const meta = parseSnapshotMetadata(rawText);
          winTitle = String(meta.windowTitle || "");
          bodyText = this.#extractAxBodyText(rawText);
        }
      }

      const inspectTerm = async (term) => {
        if (!term) return "inconclusive";
        if (!isPinnedNonDefaultWin && stateReadOk && bodyText && bodyText.includes(term)) {
          return "present";
        }
        if (!(wantWid > 0) && stateAmbiguousMultiWindow) {
          return "inconclusive";
        }
        if (signal?.aborted || Date.now() > deadlineAt) return "inconclusive";
        const queryLim = wantWid > 0 ? 25 : 5;
        const qRes = await actionPeer
          .callTool(
            "query",
            {
              app,
              text: term,
              ...(wantWid > 0 ? { window_id: wantWid } : {}),
              limit: queryLim,
            },
            rem()
          )
          .catch(() => null);
        await this.#reclaimObservationFocus(focusScope);
        if (!qRes || qRes.isError) return "inconclusive";
        try {
          const parsed = JSON.parse(extractResultText(qRes));
          const responseWid = Number(parsed?.window_id || 0);
          if (
            !winTitle &&
            parsed?.window_title &&
            (wantWid > 0 ? responseWid === wantWid : responseWid > 0 && !stateAmbiguousMultiWindow)
          ) {
            winTitle = String(parsed.window_title);
          }
          if (wantWid > 0 && responseWid > 0 && responseWid !== wantWid) {
            return "inconclusive";
          }
          const matches = Array.isArray(parsed?.matches) ? parsed.matches : [];
          if (wantWid > 0 && responseWid === 0) {
            if (matches.some((m) => Number(m?.window_id || 0) === wantWid)) {
              return "present";
            }
            return "inconclusive";
          }
          const matched = matches.some((m) => {
            if (wantWid > 0) {
              return Number(m?.window_id || responseWid || 0) === wantWid;
            }
            return true;
          });
          if (matched) return "present";
          if (parsed?.truncated === true || (wantWid > 0 && matches.length >= queryLim)) {
            return "inconclusive";
          }
          return "absent";
        } catch {
          return "inconclusive";
        }
      };

      const normalizeList = (v) =>
        Array.isArray(v)
          ? v
              .filter((s) => typeof s === "string")
              .map((s) => s.trim())
              .filter(Boolean)
          : typeof v === "string" && v.trim()
            ? [v.trim()]
            : [];

      const titleTerms = normalizeList(expectSpec.window_title_contains);
      const allTerms = normalizeList(expectSpec.all_text);
      const anyTerms = normalizeList(expectSpec.any_text);
      const vanishTerms = normalizeList(expectSpec.text_disappears);
      if (
        titleTerms.length === 0 &&
        allTerms.length === 0 &&
        anyTerms.length === 0 &&
        vanishTerms.length === 0
      ) {
        return {
          matched: false,
          windowTitle: winTitle || null,
          image,
        };
      }

      if (wantWid > 0 && titleTerms.length > 0 && !winTitle && pid > 0 && typeof axBridge?.resolveActionTarget === "function") {
        const resolvedWin = await axBridge.resolveActionTarget(pid, { wid: wantWid }).catch(() => null);
        await this.#reclaimObservationFocus(focusScope);
        if (Number(resolvedWin?.wid || 0) === wantWid && resolvedWin?.windowTitle) {
          winTitle = String(resolvedWin.windowTitle);
        }
      }

      let ok = true;
      if (titleTerms.length > 0) {
        if (!winTitle || !titleTerms.every((t) => winTitle.includes(t))) {
          ok = false;
        }
      }
      if (ok && allTerms.length > 0) {
        for (const term of allTerms) {
          if (signal?.aborted || (await inspectTerm(term)) !== "present") {
            ok = false;
            break;
          }
        }
      }
      if (ok && anyTerms.length > 0) {
        let anyMatched = false;
        for (const term of anyTerms) {
          if (signal?.aborted) break;
          if ((await inspectTerm(term)) === "present") {
            anyMatched = true;
            break;
          }
        }
        if (!anyMatched) ok = false;
      }
      if (ok && vanishTerms.length > 0) {
        if ((!isPinnedNonDefaultWin && !stateReadOk) || (wantWid === 0 && stateAmbiguousMultiWindow)) {
          ok = false;
        } else {
          for (const term of vanishTerms) {
            if (signal?.aborted || (await inspectTerm(term)) !== "absent") {
              ok = false;
              break;
            }
          }
        }
      }

      return {
        matched: ok,
        windowTitle: winTitle || null,
        image,
      };
    } finally {
      focusScope?.exitObservationPhase?.();
    }
  }

  async execute(
    args,
    {
      isAiSource = true,
      shouldFollow = true,
      focusScope = null,
      signal = null,
      clientSignal = null,
      operation = null,
      markOsTouched = () => {},
      markFocusFinalized = () => {},
    } = {}
  ) {
    const app = typeof args?.app === "string" ? args.app.trim() : "";
    const effectiveSignal = operation?.signal || signal;
    const rawTarget =
      typeof args?.target === "string"
        ? { text: args.target }
        : args?.target && typeof args.target === "object" && !Array.isArray(args.target)
          ? args.target
          : null;
    const expectSpec =
      args?.expect && typeof args.expect === "object" && !Array.isArray(args.expect)
        ? args.expect
        : null;

    const hasQuerySelector = Boolean(
      rawTarget && (String(rawTarget.text || "").trim() || String(rawTarget.role || "").trim())
    );
    const parseExpectField = (v) => {
      if (v === undefined || v === null) return { valid: true, terms: [] };
      if (typeof v === "string") {
        const t = v.trim();
        return { valid: true, terms: t ? [t] : [] };
      }
      if (Array.isArray(v) && v.every((item) => typeof item === "string")) {
        return { valid: true, terms: v.map((s) => s.trim()).filter(Boolean) };
      }
      return { valid: false, terms: [] };
    };
    const expAny = expectSpec ? parseExpectField(expectSpec.any_text) : { valid: false, terms: [] };
    const expAll = expectSpec ? parseExpectField(expectSpec.all_text) : { valid: false, terms: [] };
    const expVanish = expectSpec ? parseExpectField(expectSpec.text_disappears) : { valid: false, terms: [] };
    const expTitle = expectSpec ? parseExpectField(expectSpec.window_title_contains) : { valid: false, terms: [] };
    const hasExpectClause = Boolean(
      expectSpec &&
        expAny.valid &&
        expAll.valid &&
        expVanish.valid &&
        expTitle.valid &&
        expAny.terms.length + expAll.terms.length + expVanish.terms.length + expTitle.terms.length > 0
    );
    const hasExplicitWindowId = args?.window_id !== undefined && args?.window_id !== null;
    const validExplicitWindowId =
      !hasExplicitWindowId ||
      (typeof args.window_id !== "boolean" &&
        args.window_id !== "" &&
        Number.isSafeInteger(Number(args.window_id)) &&
        Number(args.window_id) > 0);
    const mouseButton = String(args?.mouse_button ?? "left").toLowerCase();
    const validButton = ["left", "right", "middle"].includes(mouseButton);
    if (!app || !hasQuerySelector || !hasExpectClause || !validButton || !validExplicitWindowId) {
      return this.#buildToolResult({
        isError: true,
        status: "invalid_args",
        code: "INVALID_ACT_ARGS",
        message:
          "act requires valid `app`, `target` (`text` and/or `role`), non-empty `expect`, optional positive integer `window_id`, and `mouse_button` (left|right|middle).",
      });
    }

    const reveal =
      args?.reveal && typeof args.reveal === "object" && !Array.isArray(args.reveal) ? args.reveal : {};
    const direction = ["up", "down", "left", "right"].includes(String(reveal.direction || "down").toLowerCase())
      ? String(reveal.direction || "down").toLowerCase()
      : "down";
    const parsedSteps = Number(reveal.max_scroll_steps);
    const maxScrollSteps =
      reveal.max_scroll_steps !== undefined &&
      reveal.max_scroll_steps !== null &&
      Number.isFinite(parsedSteps)
        ? Math.max(0, Math.min(10, parsedSteps))
        : 4;
    const parsedPages = Number(reveal.pages_per_step);
    const pagesPerStep =
      Number.isFinite(parsedPages) && parsedPages > 0
        ? Math.max(0.15, Math.min(1.5, parsedPages))
        : 0.7;
    const parsedClicks = Number(args?.click_count);
    const clickCount = Number.isFinite(parsedClicks)
      ? Math.max(1, Math.min(3, Math.round(parsedClicks)))
      : 1;
    const callerExplicitWindowId = hasExplicitWindowId ? Number(args.window_id) : null;
    const parsedTimeout = Number(args?.timeout_ms);
    const timeoutMs = Number.isFinite(parsedTimeout)
      ? Math.max(40, Math.min(25_000, parsedTimeout))
      : 5000;
    const deadlineAt = Date.now() + timeoutMs;

    const cancelledState = () => {
      if (clientSignal?.aborted && effectiveSignal?.reason?.code !== "PAUSED") {
        return { code: "CANCELLED", message: "调用已取消（客户端断开或中止）。" };
      }
      if (
        isAiSource &&
        (this.isBrokerPaused() ||
          this.takeoverController.paused ||
          (operation && operation.epoch !== this.takeoverController.pauseEpoch) ||
          effectiveSignal?.reason?.code === "PAUSED")
      ) {
        return {
          code: "PAUSED",
          message: effectiveSignal?.reason?.message || "Computer Use 已被用户暂停。",
        };
      }
      if (effectiveSignal?.aborted) {
        return { code: "CANCELLED", message: "调用已取消（客户端断开或中止）。" };
      }
      if (Date.now() > deadlineAt) return { code: "TIMEOUT", message: `act 在 ${timeoutMs}ms 内超时。` };
      return null;
    };

    const resolveExpectStopCode = () => {
      const paused =
        isAiSource &&
        (this.isBrokerPaused() ||
          this.takeoverController.paused ||
          (operation && operation.epoch !== this.takeoverController.pauseEpoch) ||
          effectiveSignal?.reason?.code === "PAUSED");
      if (!paused && !effectiveSignal?.aborted) return null;
      return clientSignal?.aborted && effectiveSignal?.reason?.code !== "PAUSED"
        ? "CANCELLED"
        : paused
          ? "PAUSED"
          : "CANCELLED";
    };

    const postSendStopResult = (code, message, { route, windowTitle, evalOut, clicksSent, steps }) =>
      this.#buildToolResult({
        isError: true,
        status: code === "POSTCONDITION_FAILED" ? "postcondition_failed" : "cancelled",
        code,
        message,
        sent: true,
        verified: false,
        clicksSent,
        steps,
        matchCount: 1,
        route,
        windowTitle: evalOut?.windowTitle || windowTitle,
        latestImage: evalOut?.image || null,
      });

    const preCancel = cancelledState();
    if (preCancel) {
      return this.#buildToolResult({
        isError: true,
        status: "cancelled",
        code: preCancel.code,
        message: preCancel.message,
      });
    }

    let pid = null;
    let curMeta = null;
    let resolvedTarget = null;
    let selectedMatch = null;
    let selectedMerged = null;
    let selectedWindowId = callerExplicitWindowId;
    let selectedWindowTitle = null;
    let selectedQueryPeerInstanceId = null;
    let scrollStepsDone = 0;
    let stagnantCount = 0;

    try {
      markOsTouched("act:prepare");
      const ready = await this.#ensureAppReady(app, {
        isAiSource,
        shouldFollow,
        focusScope,
        signal: effectiveSignal,
        operation,
        explicitWindowId: callerExplicitWindowId,
        deadlineAt,
        markOsTouched,
      });
      if (!ready.ok) {
        return ready.result;
      }

      pid = ready.pid;
      const processToken = ready.processToken;
      const resolvedIdentity = ready.resolvedIdentity;
      this.registerOperationTarget(operation, app, this.registry.getMeta(app), selectedWindowId);

      for (let step = 0; step <= maxScrollSteps; step += 1) {
        const abortNow = cancelledState();
        if (abortNow) {
          return this.#buildToolResult({
            isError: true,
            status: "cancelled",
            code: abortNow.code,
            message: abortNow.message,
            steps: scrollStepsDone,
          });
        }

        markOsTouched("act:query");
        const qOut = await this.#runQuery(app, rawTarget, {
          pid,
          processToken,
          resolvedIdentity,
          windowId: selectedWindowId,
          focusScope,
          operation,
          signal: effectiveSignal,
          deadlineAt,
          remainingBudgetMs: Math.max(50, deadlineAt - Date.now()),
        });
        if (qOut.windowId) {
          this.registerOperationTarget(operation, app, this.registry.getMeta(app), qOut.windowId);
        }

        if (qOut.deduped.length > 1) {
          return this.#buildToolResult({
            isError: true,
            status: "ambiguous",
            code: "AMBIGUOUS_TARGET",
            message: `找到 ${qOut.deduped.length} 个不重叠的匹配目标，拒绝盲点。请缩小 target 范围或启用 exact: true。`,
            steps: scrollStepsDone,
            matchCount: qOut.deduped.length,
          });
        }

        if (qOut.truncatedFailure) {
          return this.#buildToolResult({
            isError: true,
            status: "truncated",
            code: "QUERY_TRUNCATED",
            message: "query 搜索结果被截断，无法确认目标唯一性，已中止操作。",
            steps: scrollStepsDone,
            matchCount: qOut.deduped.length,
          });
        }

        if (qOut.deduped.length === 1) {
          const candidate = qOut.deduped[0];
          const candBounds = normalizeElementBounds(candidate?.bounds || candidate?.frame);
          const snapMeta = this.registry.getMeta(app);
          const candidateWid =
            Number(candidate.window_id) > 0
              ? Number(candidate.window_id)
              : qOut.windowId || selectedWindowId || null;
          let logicalWin =
            !(candidateWid > 0 && snapMeta?.windowId > 0 && snapMeta.windowId !== candidateWid)
              ? normalizeElementBounds(snapMeta?.windowBounds || snapMeta?.tinyWindowOverride?.bounds)
              : null;
          if (candBounds && !logicalWin && pid > 0) {
            const axBridge = this.getAxBridge?.();
            if (typeof axBridge?.resolveActionTarget === "function") {
              const resolvedWin = await axBridge
                .resolveActionTarget(pid, {
                  wid: candidateWid,
                  windowTitle: qOut.windowTitle || snapMeta?.windowTitle || "",
                })
                .catch(() => null);
              if (resolvedWin?.windowBounds) {
                logicalWin = normalizeElementBounds(resolvedWin.windowBounds);
              }
            }
          }
          const offscreen =
            candBounds &&
            logicalWin &&
            (candBounds.y + candBounds.h * 0.5 < 0 ||
              candBounds.y + candBounds.h * 0.5 > logicalWin.h ||
              candBounds.x + candBounds.w * 0.5 < 0 ||
              candBounds.x + candBounds.w * 0.5 > logicalWin.w);
          if (!offscreen || step === maxScrollSteps) {
            selectedMatch = candidate;
            selectedMerged = qOut.merged;
            selectedWindowId =
              Number(candidate.window_id) > 0
                ? Number(candidate.window_id)
                : qOut.windowId || callerExplicitWindowId;
            selectedWindowTitle = qOut.windowTitle || snapMeta?.windowTitle || null;
            selectedQueryPeerInstanceId = qOut.peerInstanceId || null;
            this.registerOperationTarget(operation, app, snapMeta, selectedWindowId);
            break;
          }
        }

        if (step >= maxScrollSteps) break;

        const beforeSig = await this.#captureViewportSignature(app, rawTarget, {
          windowId: selectedWindowId,
          focusScope,
          operation,
          deadlineAt,
        });
        const abortMid = cancelledState();
        if (abortMid) {
          return this.#buildToolResult({
            isError: true,
            status: "cancelled",
            code: abortMid.code,
            message: abortMid.message,
            steps: scrollStepsDone,
          });
        }

        const loopMeta = this.registry.getMeta(app);
        markOsTouched("act:scroll");
        const scrollRes = await this.actionExecutor.executeActScroll({
          app,
          pid: loopMeta?.pid || pid,
          meta: loopMeta,
          snapshotId: this.registry.getLatestSnapshot(loopMeta?.bundleId || app)?.id || null,
          direction,
          pages: pagesPerStep,
          windowId: selectedWindowId,
          operation,
          timeoutMs: Math.max(50, deadlineAt - Date.now()),
        });
        await focusScope?.enforce(scrollRes.route || "act:scroll");
        if (scrollRes.outcomeUnknown || scrollRes.deliveryState === "sent_unknown") {
          return this.#buildToolResult({
            isError: true,
            status: "cancelled",
            code: "WRITE_OUTCOME_UNKNOWN",
            deliveryState: "sent_unknown",
            message: "滚动揭示写入结果未知，已中止后续滚动与点击以防重复触发。",
            sent: true,
            clicksSent: 0,
            steps: scrollStepsDone,
            route: scrollRes.route || null,
          });
        }
        if (!scrollRes.delivered) {
          return this.#buildToolResult({
            isError: true,
            status: "no_progress",
            code: "SCROLL_FAILED",
            message: `滚动揭示未能发送 (${scrollRes.reason || "unavailable"})，已中止操作。`,
            sent: false,
            clicksSent: 0,
            steps: scrollStepsDone,
            route: scrollRes.route || null,
          });
        }
        await this.#sleepWithSignal(90, effectiveSignal);
        scrollStepsDone += 1;

        const abortAfterScroll = cancelledState();
        if (abortAfterScroll) {
          return this.#buildToolResult({
            isError: true,
            status: "cancelled",
            code: abortAfterScroll.code,
            message: abortAfterScroll.message,
            steps: scrollStepsDone,
          });
        }

        const afterSig = await this.#captureViewportSignature(app, rawTarget, {
          windowId: selectedWindowId,
          focusScope,
          operation,
          deadlineAt,
        });
        if (afterSig === beforeSig) {
          stagnantCount += 1;
          if (stagnantCount >= 2) {
            return this.#buildToolResult({
              isError: true,
              status: "no_progress",
              code: "SCROLL_NO_PROGRESS",
              message: `连续滚动 ${stagnantCount} 步后视口内容无变化，未找到目标。`,
              steps: scrollStepsDone,
            });
          }
        } else {
          stagnantCount = 0;
        }
      }

      if (!selectedMatch) {
        return this.#buildToolResult({
          isError: true,
          status: "not_found",
          code: stagnantCount > 0 ? "SCROLL_NO_PROGRESS" : "TARGET_NOT_FOUND",
          message: "在指定滚动步数内未找到唯一可见目标。",
          steps: scrollStepsDone,
        });
      }

      const abortBeforeResolve = cancelledState();
      if (abortBeforeResolve) {
        return this.#buildToolResult({
          isError: true,
          status: "cancelled",
          code: abortBeforeResolve.code,
          message: abortBeforeResolve.message,
          steps: scrollStepsDone,
          matchCount: 1,
        });
      }

      curMeta = this.registry.getMeta(app);
      pid = curMeta?.pid || pid || null;
      this.registerOperationTarget(operation, app, curMeta, selectedWindowId);
      const rawBounds = normalizeElementBounds(selectedMatch?.bounds || selectedMatch?.frame);
      const initialLocalPoint = rawBounds
        ? { x: rawBounds.x + rawBounds.w / 2, y: rawBounds.y + rawBounds.h / 2 }
        : null;

      const axBridge = this.getAxBridge();
      if (pid > 0 && typeof axBridge?.resolveActionTarget === "function") {
        resolvedTarget = await axBridge
          .resolveActionTarget(pid, {
            snapshotId: selectedMerged?.snapshotId || null,
            elementIndex: selectedMatch.index !== undefined ? String(selectedMatch.index) : null,
            elementMeta: selectedMerged?.snapshot?.elements?.get(String(selectedMatch.index)) || null,
            localPoint: initialLocalPoint,
            wid: selectedWindowId || curMeta?.tinyWindowOverride?.wid || curMeta?.windowId || null,
            windowTitle: selectedWindowTitle || curMeta?.windowTitle || "",
            windowBounds: curMeta?.windowBounds || curMeta?.tinyWindowOverride?.bounds || null,
          })
          .catch(() => null);
      }

      const abortBeforeClick = cancelledState();
      if (abortBeforeClick) {
        return this.#buildToolResult({
          isError: true,
          status: "cancelled",
          code: abortBeforeClick.code,
          message: abortBeforeClick.message,
          steps: scrollStepsDone,
          matchCount: 1,
        });
      }
    } catch (err) {
      if (isTakeoverAbortedError(err)) {
        return this.#buildTakeoverAbortResult(err, scrollStepsDone, 0);
      }
      if (this.#isPeerTimeoutError(err)) {
        return this.#buildToolResult({
          isError: true,
          status: "cancelled",
          code: "TIMEOUT",
          message: `act 在 ${timeoutMs}ms 内超时。`,
          steps: scrollStepsDone,
        });
      }
      throw err;
    }

    markOsTouched("act:click");
    let clickRes;
    try {
      clickRes = await this.actionExecutor.executeActClick({
        app,
        pid,
        meta: curMeta,
        snapshotId: selectedMerged?.snapshotId || null,
        match: selectedMatch,
        elementMeta: selectedMerged?.snapshot?.elements?.get(String(selectedMatch.index)) || null,
        resolvedTarget,
        explicitWindowId: callerExplicitWindowId,
        targetWindowId: selectedWindowId,
        queryPeerInstanceId: selectedQueryPeerInstanceId,
        windowTitle: selectedWindowTitle || curMeta?.windowTitle || "",
        mouseButton,
        clickCount,
        signal: effectiveSignal,
        operation,
        remainingBudgetMs: Math.max(50, deadlineAt - Date.now()),
      });
    } catch (err) {
      if (isTakeoverAbortedError(err)) {
        return this.#buildTakeoverAbortResult(err, scrollStepsDone, 1);
      }
      throw err;
    }

    if (clickRes.aborted) {
      const isPause =
        (isAiSource && this.takeoverController.paused) || effectiveSignal?.reason?.code === "PAUSED";
      return this.#buildToolResult({
        isError: true,
        status: "cancelled",
        code: isPause ? "PAUSED" : "CANCELLED",
        message: isPause
          ? effectiveSignal?.reason?.message || "Computer Use 已被用户暂停。"
          : "调用已在点击前取消。",
        steps: scrollStepsDone,
        matchCount: 1,
      });
    }

    const clickRoute = clickRes.routeKey;
    const clicksSent = clickRes.clicksSent;
    const actWid = selectedWindowId || curMeta?.windowId || null;
    const actRouteScope =
      clickRes.routeScope ||
      (typeof this.registry?.buildRouteScope === "function"
        ? this.registry.buildRouteScope(curMeta, { windowId: actWid })
        : buildRouteScopeFromMeta(curMeta, { windowId: actWid }));

    const stolenOnClick = await focusScope?.enforce(clickRoute, { routeScope: actRouteScope });
    focusScope?.finish(clickRoute, {
      alreadyRecorded: Boolean(stolenOnClick),
      routeScope: actRouteScope,
    });
    markFocusFinalized();

    if (clicksSent > 0) {
      const winBounds =
        normalizeRectPt(curMeta?.windowBounds || curMeta?.tinyWindowOverride?.bounds) || null;
      const actNorm =
        clickRes.localPoint && winBounds
          ? {
              normX: clickRes.localPoint.x / winBounds.width,
              normY: clickRes.localPoint.y / winBounds.height,
            }
          : { normX: null, normY: null };
      this.onMutationRecorded({
        type: "click",
        label: `原子操作 act · ${String(rawTarget.text || rawTarget.role || "").slice(0, 48)}`,
        source: isAiSource ? "ai" : "ui",
        normX: actNorm.normX,
        normY: actNorm.normY,
        ...(clickRes.localPoint ? { windowPointPt: clickRes.localPoint } : {}),
        ...(selectedWindowId || curMeta?.windowId ? { windowId: selectedWindowId || curMeta?.windowId } : {}),
        app: curMeta?.appDisplayName || app,
        targetApp: curMeta?.bundleId || app,
      });
    }

    if (!clickRes.delivered) {
      const sentUnknown = clickRes.deliveryState === "sent_unknown";
      return this.#buildToolResult({
        isError: true,
        status: sentUnknown ? "cancelled" : "click_failed",
        code: sentUnknown ? "WRITE_OUTCOME_UNKNOWN" : "ACT_CLICK_FAILED",
        ...(clickRes.deliveryState ? { deliveryState: clickRes.deliveryState } : {}),
        message: sentUnknown
          ? `目标点击写入结果未知 (${clickRes.failureReason || "write_outcome_unknown"})，已阻断后续操作。`
          : `目标点击未能发送 (${clickRes.failureReason || "unavailable"})。`,
        sent: sentUnknown || clicksSent > 0,
        clicksSent: sentUnknown ? Math.max(1, clicksSent) : clicksSent,
        steps: scrollStepsDone,
        matchCount: 1,
        route: clickRoute,
      });
    }

    const dispatchWindowId =
      Number(selectedWindowId) > 0
        ? Number(selectedWindowId)
        : Number(callerExplicitWindowId) > 0
          ? Number(callerExplicitWindowId)
          : Number(clickRes.routeScope?.windowId || 0) > 0
            ? Number(clickRes.routeScope.windowId)
            : Number(resolvedTarget?.wid || 0) > 0
              ? Number(resolvedTarget.wid)
              : null;
    const pollGapsMs = [60, 130, 240, 400];
    let pollIdx = 0;
    let latestEval = null;
    for (;;) {
      const preStopCode = resolveExpectStopCode();
      if (preStopCode) {
        return postSendStopResult(
          preStopCode,
          "点击已发送，在后置校验阶段收到取消/暂停信号并立即停止（未重试点击）。",
          { route: clickRoute, windowTitle: selectedWindowTitle, evalOut: latestEval, clicksSent, steps: scrollStepsDone }
        );
      }

      latestEval = await this.#evaluateExpect(app, pid, expectSpec, {
        windowId: dispatchWindowId,
        defaultWindowId: curMeta?.windowId || null,
        explicitWindowPinned: Boolean(callerExplicitWindowId > 0),
        focusScope,
        signal: effectiveSignal,
        operation,
        deadlineAt,
      }).catch((err) => {
        if (this.#isPeerTimeoutError(err) || isTakeoverAbortedError(err)) {
          return { matched: false, windowTitle: null, image: null };
        }
        throw err;
      });

      const postStopCode = resolveExpectStopCode();
      if (postStopCode) {
        return postSendStopResult(
          postStopCode,
          "点击已发送，在后置校验阶段收到取消/暂停信号并立即停止（未重试点击）。",
          { route: clickRoute, windowTitle: selectedWindowTitle, evalOut: latestEval, clicksSent, steps: scrollStepsDone }
        );
      }
      if (latestEval.matched) {
        this.onVerifiedMutationRecorded();
        return this.#buildToolResult({
          isError: false,
          status: "ok",
          verified: true,
          sent: true,
          clicksSent,
          steps: scrollStepsDone,
          matchCount: 1,
          route: clickRoute,
          windowTitle: latestEval.windowTitle || selectedWindowTitle,
          latestImage: latestEval.image,
        });
      }
      const remainingMs = deadlineAt - Date.now();
      if (remainingMs <= 0) {
        return postSendStopResult(
          "POSTCONDITION_FAILED",
          "点击已发送，但语义 expect 后置条件在超时前未成立。",
          { route: clickRoute, windowTitle: selectedWindowTitle, evalOut: latestEval, clicksSent, steps: scrollStepsDone }
        );
      }

      const waitMs = Math.min(remainingMs, pollGapsMs[Math.min(pollIdx, pollGapsMs.length - 1)]);
      pollIdx += 1;
      await this.#sleepWithSignal(waitMs, effectiveSignal);
      const sleepStopCode = resolveExpectStopCode();
      if (Date.now() >= deadlineAt && !sleepStopCode) {
        return postSendStopResult(
          "POSTCONDITION_FAILED",
          "点击已发送，但语义 expect 后置条件在超时前未成立。",
          { route: clickRoute, windowTitle: selectedWindowTitle, evalOut: latestEval, clicksSent, steps: scrollStepsDone }
        );
      }
    }
  }
}
