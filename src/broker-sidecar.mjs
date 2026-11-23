import crypto from "node:crypto";
import { chmodSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import {
  BROKER_INFO_PATH,
  BROKER_SOCKET_PATH,
  MAX_LINE_BUFFER_BYTES,
  SCRIPT_RUNNER_APP_PATH,
  SCRIPT_RUNNER_BIN_PATH,
  SIDECAR_PILL_MARKDOWN,
  isMainModule,
} from "./constants.mjs";
import { NativeComputerUsePeer } from "./native-peer.mjs";
import {
  bringAppToFrontExplicit,
  captureMainWindowFallbackJpeg,
  dispatchBackgroundPointClickDetailed,
  dispatchBackgroundPointDragDetailed,
  extractResultImage,
  extractResultText,
  findRunningApp,
  getFrontmostAppFast,
  isProcessAlive,
  launchAppInBackground,
  parseAppsList,
  parseImageDimensions,
  parseSnapshotMetadata,
  promoteMainWindowFocusInBackground,
  redactToolResultSecureText,
  restoreFrontmostAppFast,
  unhideAppWithoutActivating,
} from "./background-policy.mjs";
import {
  SNAPSHOT_REF_DOC,
  SelfActivationTracker,
  SnapshotLedger,
  buildStaleRefToolResult,
  checkMacPermissions,
  computeFrameDigest,
  ensureRendererAccessibility,
  evaluateJxaPostTrust,
  getProcessIdentity,
  matchAdvertisedAction,
  parseQualifiedElementRef,
  resolveRunningAppIdentity,
  sanitizeToolArgsForNative,
  tryHeadlessBackgroundScroll,
  tryHeadlessContextMenu,
  tryHeadlessSelectedTextInsert,
  tryWindowKey,
  tryWindowPostClick,
  tryWindowScroll,
  tryWindowText,
  verifyEditableTextFocus,
} from "./headless-engine.mjs";
import { PersistentAxBridge } from "./ax-bridge.mjs";
import { AppSnapshotRegistry, isSecureTextRole } from "./app-snapshot-registry.mjs";
import { FocusPolicyGuard } from "./focus-policy-guard.mjs";
import { BackgroundActionExecutor, appendResultFooter, attachDeliveryReceipt } from "./action-executor.mjs";
import { AtomicActExecutor, buildActToolResult } from "./act-executor.mjs";
import { BIND_HOST, SidecarWebAdapter } from "./sidecar-web-adapter.mjs";
import { DesktopHelperClient } from "./desktop-helper-client.mjs";
import {
  mapToActionPixel,
  mapToWindowPoint,
  normalizeRectPt,
  rectsEqualPt,
  validateFrameRef,
} from "./preview-geometry.mjs";
import { PreviewStreamManager } from "./preview-stream.mjs";
import { StrictReplSessionManager } from "./repl-runner.mjs";
import {
  TakeoverController,
  buildUiInteractionPauseClaim,
  isTakeoverAbortedError,
} from "./takeover-controller.mjs";
import { VideoWebSocketHub } from "./video-websocket.mjs";

const DEFAULT_FOCUS_SWEEP_DELAYS_MS = [80, 220, 450];
const SIDECAR_TOOL_NOTE = `\nSide-pane live view: include ${SIDECAR_PILL_MARKDOWN} once in your first reply using Computer Use so the user can open the right-hand live mini-window.`;
const SIDECAR_REF_TOOL_NOTE = `\n${SNAPSHOT_REF_DOC}`;
const LOCKED_SESSION_POSIX_RE = /NSPOSIXErrorDomain\s+Code=2\b/iu;
const LOCKED_SESSION_MESSAGE =
  "macOS 屏幕当前处于锁屏/休眠状态（Locked Use 未启用），请先解锁屏幕后重试，或运行 `open-computer-use locked-use enable` 开启锁屏后台控制。";

export class ComputerUseBrokerServer {
  #actionQueue = Promise.resolve();
  #activeActionCount = 0;
  #screenLockedBackoff = false;
  #ownsBoundSocket = false;
  #boundSocketInode = null;
  #nextConnSeq = 1;

  constructor({
    webPort = Number.parseInt(
      process.env.ANTIGRAVITY_SIDECAR_WEB_PORT || process.env.AGY_CUA_WEB_PORT || "0",
      10
    ),
    uiToken = process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN || crypto.randomBytes(24).toString("hex"),
    socketPath = BROKER_SOCKET_PATH,
    infoPath = socketPath === BROKER_SOCKET_PATH ? BROKER_INFO_PATH : null,
    actionPeer = null,
    streamPeer = null,
    axBridge = undefined,
    focusController = null,
    promoteMainWindowFn = promoteMainWindowFocusInBackground,
    mainWindowFallbackFn = captureMainWindowFallbackJpeg,
    pointClickFn = dispatchBackgroundPointClickDetailed,
    pointDragFn = dispatchBackgroundPointDragDetailed,
    processIdentityFn = getProcessIdentity,
    runningAppIdentityFn = resolveRunningAppIdentity,
    permissionsFn = checkMacPermissions,
    rendererAccessibilityFn = ensureRendererAccessibility,
    editableFocusFn = verifyEditableTextFocus,
    selectedTextInsertFn = tryHeadlessSelectedTextInsert,
    axScrollFallbackFn = tryHeadlessBackgroundScroll,
    contextMenuFallbackFn = tryHeadlessContextMenu,
    windowClickFn = tryWindowPostClick,
    windowKeyFn = tryWindowKey,
    windowTextFn = tryWindowText,
    windowScrollFn = tryWindowScroll,
    snapshotLedger = null,
    selfActivationTracker = null,
    takeoverController = null,
    desktopHelperClient = undefined,
    launchHelperOnStart = undefined,
    replManager = null,
    scriptRunnerBinPath = null,
    interactDrainTimeoutMs = 4000,
    bringToFrontDrainTimeoutMs = 250,
  } = {}) {
    this.uiToken = uiToken;
    this.socketPath = socketPath;
    this.infoPath = infoPath;
    this.brokerBootId = crypto.randomUUID();
    this.scriptRunnerBinPath = scriptRunnerBinPath || SCRIPT_RUNNER_BIN_PATH;
    this.interactDrainTimeoutMs = interactDrainTimeoutMs;
    this.bringToFrontDrainTimeoutMs = bringToFrontDrainTimeoutMs;
    this.replManager = replManager;

    this.takeoverController =
      takeoverController ||
      new TakeoverController({
        onPauseLatched: (info) => this.#onTakeoverPauseLatched(info),
        onPhaseChanged: () => this.#syncTakeoverStateAndBroadcast(),
        onTargetChanged: (target) => {
          this.#syncTrustedAutomationPids(target);
        },
        onResume: async ({ lastTarget }) => {
          if (lastTarget?.bundleId || lastTarget?.app) {
            this.registry.markAppStale(lastTarget.bundleId || lastTarget.app, "resumed_after_takeover");
          }
          this.focusPolicyGuard?.clearHumanTargetTakeover();
          await this.desktopHelperClient?.resetTakeoverLatch().catch(() => {});
          this.webAdapter?.pushActionEvent({
            type: "setting",
            label: "已恢复 AI 操作",
            source: "ui",
          });
        },
      });

    if (!this.replManager) {
      this.replManager = new StrictReplSessionManager({
        broker: this,
        scriptRunnerBinPath: this.scriptRunnerBinPath,
      });
    }

    this.axBridge =
      axBridge !== undefined
        ? axBridge
        : new PersistentAxBridge({
            enabled: !actionPeer && process.platform === "darwin",
            syntheticEventTag: this.takeoverController.syntheticEventTag,
          });
    if (typeof this.axBridge?.setSyntheticEventTag === "function") {
      this.axBridge.setSyntheticEventTag(this.takeoverController.syntheticEventTag);
    }

    let lastActionPeerInstanceId = null;
    this.actionPeer =
      actionPeer ||
      new NativeComputerUsePeer({
        name: "action-engine",
        envOverrides:
          socketPath === BROKER_SOCKET_PATH
            ? { OPEN_COMPUTER_USE_AGENT_SOCKET_NAMESPACE: "agy-action" }
            : {},
        ownsSocketNamespace: socketPath === BROKER_SOCKET_PATH ? true : undefined,
        onMutatingTimeoutUnknown: (agentId) => {
          this.takeoverController.markWriteOutcomeUnknown(agentId);
        },
        onAgentInstanceCleared: (agentId) => {
          this.takeoverController.clearWriteOutcomeUnknown(agentId);
          this.registry?.invalidateActionScreenshots?.(agentId);
        },
        onChildSpawned: () => {
          const curId = this.actionPeer?.agentInstanceId || null;
          if (lastActionPeerInstanceId && curId && curId !== lastActionPeerInstanceId) {
            this.registry?.invalidateActionScreenshots?.(lastActionPeerInstanceId);
          }
          if (curId) lastActionPeerInstanceId = curId;
          this.#syncTrustedAutomationPids();
        },
      });
    this.streamPeer =
      streamPeer ||
      new NativeComputerUsePeer({
        name: "stream-engine",
        envOverrides:
          socketPath === BROKER_SOCKET_PATH
            ? { OPEN_COMPUTER_USE_AGENT_SOCKET_NAMESPACE: "agy-stream" }
            : {},
        ownsSocketNamespace: socketPath === BROKER_SOCKET_PATH ? true : undefined,
        onChildSpawned: () => {
          this.#syncTrustedAutomationPids();
        },
      });

    const shouldLaunchHelper =
      typeof launchHelperOnStart === "boolean"
        ? launchHelperOnStart
        : socketPath === BROKER_SOCKET_PATH &&
          !actionPeer &&
          process.platform === "darwin" &&
          process.env.AGY_CUA_DISABLE_HELPER_AUTOSTART !== "1";
    this.launchHelperOnStart = shouldLaunchHelper;

    this.wsHub = new VideoWebSocketHub({
      brokerBootId: this.brokerBootId,
      getPort: () => this.webAdapter?.webPort || 0,
      onSubscriberConnected: (sub) => this.previewStreamManager?.onWsSubscriberConnected(sub),
      onSubscriberClosed: (sub, reason) => this.previewStreamManager?.onWsSubscriberClosed(sub, reason),
      onSubscriberNeedIdr: (sub) => this.previewStreamManager?.onWsSubscriberNeedIdr(sub),
    });

    this.desktopHelperClient =
      desktopHelperClient !== undefined
        ? desktopHelperClient
        : shouldLaunchHelper
          ? new DesktopHelperClient({
              brokerBootId: this.brokerBootId,
              syntheticEventTag: this.takeoverController.syntheticEventTag,
              onSensorEvent: (evt) => this.takeoverController.handleSensorEvent(evt),
              onCapabilitiesChanged: (caps) => {
                this.takeoverController.setHelperCapabilities(caps);
                this.previewStreamManager?.bumpCapabilityEpoch();
                this.#syncTakeoverStateFields();
                void this.#refreshPermissionsQuietly().then(() => {
                  this.#syncPreviewStateFields();
                  this.webAdapter?.broadcastState();
                });
              },
              onStatusChanged: () => {
                this.#syncTakeoverStateFields();
                void this.#refreshPermissionsQuietly().then(() => {
                  this.#syncPreviewStateFields();
                  this.webAdapter?.broadcastState();
                });
              },
              onVideoPacket: (pkt) => this.previewStreamManager?.handleVideoPacket(pkt),
              onStreamStatus: (st) => void this.previewStreamManager?.handleHelperStreamStatus(st),
            })
          : null;

    if (desktopHelperClient !== undefined && desktopHelperClient) {
      desktopHelperClient.onVideoPacket = (pkt) => this.previewStreamManager?.handleVideoPacket(pkt);
      desktopHelperClient.onStreamStatus = (st) =>
        void this.previewStreamManager?.handleHelperStreamStatus(st);
    }

    this.previewStreamManager = new PreviewStreamManager({
      brokerBootId: this.brokerBootId,
      desktopHelperClient: this.desktopHelperClient,
      wsHub: this.wsHub,
      onStateChanged: () => {
        this.#syncPreviewStateFields();
        this.webAdapter?.broadcastState();
      },
      onFallbackJpegFrame: async (jpeg) => {
        if (!jpeg?.data || !this.state.activeApp) return;
        this.webAdapter?.updateFrameFromImageItem(
          { type: "image", mimeType: jpeg.mimeType || "image/jpeg", data: jpeg.data },
          0,
          {
            frameMeta: {
              targetKey: jpeg.targetKey,
              geometryRev: jpeg.geometryRev,
              windowId: jpeg.windowId,
            },
          }
        );
        this.#syncPreviewStateFields();
        this.webAdapter?.broadcastState();
      },
      onRequestJpegTick: () => {
        this.webAdapter?.ensureStreamLoop();
        void this.#captureStreamFrameOnce();
      },
    });

    this.promoteMainWindowFn = promoteMainWindowFn;
    this.mainWindowFallbackFn = mainWindowFallbackFn;
    this.runningAppIdentityFn = runningAppIdentityFn;
    this.permissionsFn = permissionsFn;
    this.axScrollFallbackFn = axScrollFallbackFn;
    this.windowClickFn = windowClickFn;
    this.windowScrollFn = windowScrollFn;

    this.socketServer = null;
    this.socketClients = new Set();
    this.streamInFlight = false;
    this.cachedTools = null;

    const tkState = this.takeoverController.publicState();
    // Live UI state shared with the Aux Pane mini-window
    this.state = {
      activeApp: null,
      appDisplayName: null,
      bundleId: null,
      pid: null,
      windowId: null,
      pinnedWindowId: null,
      targetKey: null,
      geometryRev: 1,
      availableWindows: [],
      previewGeometry: null,
      previewReadOnly: false,
      previewReadOnlyReason: null,
      streamPaused: false,
      streamPausedReason: null,
      videoTransport: "jpeg",
      windowTitle: null,
      occludedNote: false,
      activeSnapshotId: null,
      followAi: true,
      paused: tkState.paused,
      pausePhase: tkState.pausePhase,
      pauseEpoch: tkState.pauseEpoch,
      pauseReason: tkState.pauseReason,
      pauseDetail: tkState.pauseDetail,
      takeoverMode: tkState.takeoverMode,
      emergencyHotkey: tkState.emergencyHotkey,
      aiStatus: "idle",
      lastAction: null,
      actionSeq: 0,
      frameSeq: 0,
      frameWidth: 0,
      frameHeight: 0,
      frameLatencyMs: 0,
      lastActivityAt: 0,
      recentActions: [],
      runningApps: [],
      permissions: {
        platform: process.platform,
        accessibility: null,
        screenRecording: null,
      },
      permissionComponents: null,
      headlessStats: {
        snapshotsIssued: 0,
        staleRefsBlocked: 0,
        focusStealsPrevented: 0,
        verifiedMutations: 0,
        totalMutations: 0,
      },
    };
    this.#ocuObservationStats = {
      actionOk: null,
      streamOk: null,
      lastError: null,
      checkedAt: null,
    };

    // Deep Module 1: AppSnapshotRegistry
    this.registry = new AppSnapshotRegistry({
      snapshotLedger: snapshotLedger || new SnapshotLedger(),
      axBridge: this.axBridge,
      processIdentityFn,
      rendererAccessibilityFn,
      onSnapshotIssued: () => {
        this.state.headlessStats.snapshotsIssued += 1;
      },
    });
    this.snapshotLedger = this.registry.ledger;
    this.appMetaCache = this.registry.cache;

    // Deep Module 2: FocusPolicyGuard
    this.focusController = {
      getFrontmostApp: () => getFrontmostAppFast({ axBridge: this.axBridge }),
      restoreFrontmostApp: (pid, opts = {}) =>
        restoreFrontmostAppFast(pid, { axBridge: this.axBridge, ...(opts || {}) }),
      sweepDelaysMs: DEFAULT_FOCUS_SWEEP_DELAYS_MS,
      ...(focusController || {}),
    };
    this.focusPolicyGuard = new FocusPolicyGuard({
      focusController: this.focusController,
      tracker: selfActivationTracker || new SelfActivationTracker(),
      resolveTargetInfo: (app) => this.#buildTargetFocusInfo(app),
      onFocusStealPrevented: ({ app, targetApp, routeKey }) => {
        this.state.headlessStats.focusStealsPrevented += 1;
        this.webAdapter.pushActionEvent({
          type: "focus_guard",
          label: `拦截焦点抢占 · 已拉回后台${routeKey ? ` (${routeKey})` : ""}`,
          source: "ai",
          app,
          targetApp,
        });
      },
    });
    this.selfActivationTracker = this.focusPolicyGuard.tracker;

    // Deep Module 3: BackgroundActionExecutor + AtomicActExecutor
    this.actionExecutor = new BackgroundActionExecutor({
      actionPeer: this.actionPeer,
      axBridge: this.axBridge,
      desktopHelperClient: this.desktopHelperClient,
      focusPolicyGuard: this.focusPolicyGuard,
      registry: this.registry,
      unhideAppFn: unhideAppWithoutActivating,
      refreshActionStateFn: (app, { shouldFollow, operation = null } = {}) =>
        this.#safeGetAppState(
          this.actionPeer,
          { app, include_ax: true, include_screenshot: true, max_tree_nodes: 150 },
          { updateActiveApp: shouldFollow, allowLaunch: false, operation }
        ),
      pointClickFn,
      pointDragFn,
      editableFocusFn,
      selectedTextInsertFn,
      axScrollFallbackFn,
      contextMenuFallbackFn,
      windowClickFn,
      windowKeyFn,
      windowTextFn,
      windowScrollFn,
      takeoverController: this.takeoverController,
    });

    this.actExecutor = new AtomicActExecutor({
      getActionPeer: () => this.actionPeer,
      getAxBridge: () => this.axBridge,
      registry: this.registry,
      actionExecutor: this.actionExecutor,
      takeoverController: this.takeoverController,
      getRunningAppIdentityFn: () => this.runningAppIdentityFn,
      isBrokerPaused: () => this.state.paused,
      checkAppRunning: (peer, appQuery) => this.#checkAppRunning(peer, appQuery),
      safeGetAppState: (peer, args, opts) => this.#safeGetAppState(peer, args, opts),
      processQueryResult: (app, res, opts) => this.#processQueryResult(app, res, opts),
      registerOperationTarget: (op, app, meta, explicitWid) =>
        this.#registerOperationTarget(op, app, meta, explicitWid),
      isSameActiveApp: (appQuery) => this.#isSameActiveApp(appQuery),
      onAdoptFollowTarget: ({ activeApp, bundleId, pid, appDisplayName, windowTitle }) => {
        this.state.activeApp = activeApp;
        this.state.bundleId = bundleId;
        this.state.pid = pid;
        this.state.appDisplayName = appDisplayName;
        this.state.windowTitle = windowTitle;
      },
      onMutationRecorded: (evt) => {
        this.state.headlessStats.totalMutations += 1;
        this.webAdapter.pushActionEvent(evt);
      },
      onVerifiedMutationRecorded: () => {
        this.state.headlessStats.verifiedMutations += 1;
      },
    });

    // Deep Module 4: SidecarWebAdapter
    this.webAdapter = new SidecarWebAdapter({
      webPort,
      uiToken,
      brokerBootId: this.brokerBootId,
      state: this.state,
      getActiveActionCount: () => this.#activeActionCount,
      shouldPollJpeg: () =>
        this.state.targetKey
          ? this.previewStreamManager.needsJpegPolling(this.state.targetKey)
          : Boolean(this.state.activeApp && !this.state.pinnedWindowId),
      isScreenLockedBackoff: () => this.#screenLockedBackoff,
      refreshPermissionsQuietly: () => this.#refreshPermissionsQuietly(),
      getPermissionsReport: () => this.getPermissionsReport(),
      onRequestPermission: (kind) => this.#handleRequestPermission(kind),
      refreshAppsList: () => this.refreshAppsList(),
      onGetWindows: () => this.#handleGetWindows(),
      runSerializedAction: (fn) => this.#runSerializedAction(fn),
      onSelectApp: (target, data) => this.#handleSelectApp(target, data),
      onBringToFront: (target) => this.#handleBringToFront(target),
      preQueueValidateInteract: (app, data) => this.#preQueueValidateInteract(app, data),
      onInteract: (app, data) => this.#handleInteract(app, data),
      onTakeoverClaim: (data) => this.#handleTakeoverClaim(data),
      onSettingsUpdate: (data) => this.#handleSettingsUpdate(data),
      onVideoSubscribe: (data) => this.#handleVideoSubscribe(data),
      onVideoControl: (data) => this.#handleVideoControl(data),
      wsHub: this.wsHub,
      captureStreamTick: () => this.#captureStreamFrameOnce(),
    });
  }

  #ocuObservationStats;

  #syncTrustedAutomationPids(targetOverride = undefined) {
    const trustedPids = [
      process.pid,
      this.actionPeer?.child?.pid,
      this.streamPeer?.child?.pid,
      this.axBridge?.pid,
    ].filter((p) => Number(p) > 0);
    this.takeoverController?.setTrustedPids?.(trustedPids);
    const effectiveTarget =
      targetOverride !== undefined ? targetOverride : this.takeoverController?.activeTarget;
    void this.desktopHelperClient
      ?.setTakeoverTargets(effectiveTarget ? [effectiveTarget] : [], trustedPids)
      .catch(() => {});
  }

  #syncPreviewStateFields() {
    const geom = this.previewStreamManager.getActiveGeometry();
    const vs = this.previewStreamManager.getViewTransportSummary(geom?.targetKey || this.state.targetKey);
    this.state.targetKey = geom?.targetKey || null;
    this.state.geometryRev = geom?.geometryRev || 1;
    this.state.windowId = geom?.windowId > 0 ? geom.windowId : this.state.windowId || null;
    this.state.availableWindows = this.previewStreamManager.availableWindows;
    this.state.previewGeometry = geom
      ? {
          brokerBootId: geom.brokerBootId,
          targetKey: geom.targetKey,
          pid: geom.pid,
          windowId: geom.windowId,
          explicitWindowId: geom.explicitWindowId,
          geometryRev: geom.geometryRev,
          windowBoundsPt: geom.windowBoundsPt,
          previewContentRectPt: geom.previewContentRectPt,
          previewPixelSize: geom.previewPixelSize,
          actionContentRectPt: geom.actionContentRectPt,
          actionPixelSize: geom.actionPixelSize,
          scaleFactor: geom.scaleFactor,
          readOnly: geom.readOnly,
          readOnlyReason: geom.readOnlyReason,
          deliveryRoute: geom.deliveryRoute,
        }
      : null;
    this.state.previewReadOnly = Boolean(geom?.readOnly);
    this.state.previewReadOnlyReason = geom?.readOnlyReason || null;
    this.state.streamPaused = Boolean(vs.streamPaused);
    this.state.streamPausedReason = vs.streamPaused ? vs.reason || "stream_paused" : null;
    this.state.videoTransport = vs.transport || "jpeg";
  }

  #isJxaWindowPostTrusted() {
    return evaluateJxaPostTrust({
      axBridge: this.axBridge,
      cachedAccessibility: this.state.permissions.accessibility,
      hasCustomWindowTransport:
        this.windowClickFn !== tryWindowPostClick || this.windowScrollFn !== tryWindowScroll,
    });
  }

  async #refreshActivePreviewGeometry({
    app = this.state.activeApp,
    pid: explicitPid = 0,
    windows = null,
    allowHelperQuery = true,
    selectAsActive = undefined,
    activate = undefined,
    readOnlyOverride = false,
    readOnlyReasonOverride = null,
    resolveReadOnlyOverride = null,
  } = {}) {
    const shouldSelectAsActive =
      selectAsActive !== undefined ? Boolean(selectAsActive) : activate !== undefined ? Boolean(activate) : true;
    if (!app) {
      this.previewStreamManager.clearActiveGeometry();
      this.#syncPreviewStateFields();
      return { geometry: null, notFound: false };
    }
    if (this.state.permissions.accessibility === null && typeof this.permissionsFn === "function") {
      await this.#refreshPermissionsQuietly().catch(() => {});
    }
    const meta = this.registry.getMeta(app);
    const sameActive = this.#isSameActiveApp(app);
    const pid = Number(explicitPid || 0) || meta?.pid || (sameActive ? this.state.pid : 0) || 0;
    const processToken = meta?.processToken || null;

    let liveWindows = Array.isArray(windows) ? windows : null;
    if (!liveWindows && allowHelperQuery && this.desktopHelperClient?.available && pid > 0) {
      liveWindows = await this.desktopHelperClient.listWindows(pid).catch(() => []);
    }

    const selection = this.previewStreamManager.selectTargetWindow({
      pid,
      meta,
      explicitWindowId: this.state.pinnedWindowId,
      windows: liveWindows || [],
    });
    if (selection.notFound) {
      if (shouldSelectAsActive) {
        this.previewStreamManager.clearActiveGeometry();
      }
      this.#syncPreviewStateFields();
      return { geometry: null, notFound: true, selection };
    }

    const selected = selection.selected;
    const selectedWid =
      selected?.windowId ||
      this.state.pinnedWindowId ||
      meta?.tinyWindowOverride?.wid ||
      meta?.windowId ||
      (sameActive ? this.state.windowId : 0) ||
      0;

    const windowBoundsPt =
      selected?.boundsPt ||
      normalizeRectPt(meta?.tinyWindowOverride?.bounds) ||
      normalizeRectPt(meta?.windowBounds) ||
      null;

    if (!windowBoundsPt) {
      if (shouldSelectAsActive) {
        this.previewStreamManager.clearActiveGeometry();
      }
      this.#syncPreviewStateFields();
      return { geometry: this.previewStreamManager.getActiveGeometry(), notFound: false, selection };
    }

    const jxaTrusted = this.#isJxaWindowPostTrusted();
    const actionShot = meta?.actionScreenshotMeta || null;
    const shotProof = !selection.explicitWindowId
      ? this.registry.evaluateActionScreenshotProof(meta, {
          pid,
          expectedPeerInstanceId: this.actionPeer?.agentInstanceId || null,
          targetWindowId: selectedWid,
          windowSize: windowBoundsPt,
          requireSingleWindow: true,
          requirePositiveWid: true,
        })
      : null;
    const ocuActionProven = shotProof?.proven
      ? {
          pid: shotProof.shotMeta?.pid || pid,
          processToken: shotProof.shotMeta?.processToken || processToken,
          windowId: shotProof.shotWindowId || 0,
          pixelSize: { width: shotProof.width, height: shotProof.height },
        }
      : false;
    const helperWindows = selection.availableWindows || [];
    const helperSingleWin = Boolean(
      helperWindows.length === 1 && selectedWid > 0 && Number(helperWindows[0]?.windowId) === selectedWid
    );
    const singleWindowProven = Boolean(
      helperWindows.length > 0
        ? helperSingleWin &&
            (!shotProof?.shotMeta ||
              !Number.isInteger(shotProof.windowCount) ||
              shotProof.windowCount === 1)
        : shotProof?.sameWindowProven && shotProof?.singleWindowProven
    );

    const previewPixelSize =
      this.state.frameWidth > 0 && this.state.frameHeight > 0
        ? { width: this.state.frameWidth, height: this.state.frameHeight }
        : null;
    const actionPixelSize =
      actionShot?.width > 0 && actionShot?.height > 0
        ? { width: actionShot.width, height: actionShot.height }
        : meta?.actionFrameWidth > 0 && meta?.actionFrameHeight > 0
          ? { width: meta.actionFrameWidth, height: meta.actionFrameHeight }
          : null;

    const resolvedReadOnly =
      typeof resolveReadOnlyOverride === "function"
        ? resolveReadOnlyOverride({
            selectedWid,
            helperWinCount: helperWindows.length,
            selection,
          })
        : null;
    const effectiveReadOnlyOverride =
      resolvedReadOnly && resolvedReadOnly.readOnlyOverride !== undefined
        ? resolvedReadOnly.readOnlyOverride
        : readOnlyOverride;
    const effectiveReadOnlyReasonOverride =
      resolvedReadOnly && resolvedReadOnly.readOnlyReasonOverride !== undefined
        ? resolvedReadOnly.readOnlyReasonOverride
        : readOnlyReasonOverride;

    const geom = this.previewStreamManager.syncActiveGeometry({
      pid,
      processToken,
      windowId: selectedWid,
      explicitWindowId: selection.explicitWindowId,
      windowBoundsPt,
      previewPixelSize,
      actionPixelSize,
      jxaTrusted,
      singleWindowProven,
      ocuActionProven,
      readOnlyOverride: effectiveReadOnlyOverride,
      readOnlyReasonOverride: effectiveReadOnlyReasonOverride,
      selectAsActive: shouldSelectAsActive,
    });
    if (selected?.title && sameActive) {
      this.state.windowTitle = selected.title;
    }
    this.#syncPreviewStateFields();
    return { geometry: geom, notFound: false, selection };
  }

  #syncTakeoverStateFields() {
    const tk = this.takeoverController.publicState();
    this.state.paused = tk.paused;
    this.state.pausePhase = tk.pausePhase;
    this.state.pauseEpoch = tk.pauseEpoch;
    this.state.pauseReason = tk.pauseReason;
    this.state.pauseDetail = tk.pauseDetail;
    this.state.takeoverMode = tk.takeoverMode;
    this.state.emergencyHotkey = tk.emergencyHotkey;
  }

  #syncTakeoverStateAndBroadcast() {
    this.#syncTakeoverStateFields();
    this.webAdapter?.broadcastState();
  }

  #onTakeoverPauseLatched({ pauseDetail, intent } = {}) {
    this.#syncTakeoverStateFields();
    if (intent?.transfersFocusToTarget) {
      this.focusPolicyGuard.cancelForHumanTargetTakeover(intent.targetPid || pauseDetail?.targetPid || null);
    }
    if (this.replManager && typeof this.replManager.abortAllForPause === "function") {
      this.replManager.abortAllForPause(pauseDetail?.label || "人类接管已暂停");
    }
    this.webAdapter?.pushActionEvent({
      type: "takeover",
      label: `[人类接管已暂停] ${pauseDetail?.label || "已暂停 AI 操作"}`,
      source: pauseDetail?.source || "ui",
      targetApp: pauseDetail?.targetApp || this.state.bundleId || this.state.activeApp,
    });
  }

  get webPort() {
    return this.webAdapter.webPort;
  }

  set webPort(port) {
    this.webAdapter.webPort = port;
  }

  get httpServer() {
    return this.webAdapter.httpServer;
  }

  get sseClients() {
    return this.webAdapter.sseClients;
  }

  get latestFrameBytes() {
    return this.webAdapter.latestFrameBytes;
  }

  #isSameActiveApp(appQuery) {
    return this.registry.isSameApp(appQuery, this.state);
  }

  #buildTargetFocusInfo(app) {
    const meta = this.registry.getMeta(app);
    const sameActive = this.#isSameActiveApp(app);
    return {
      appQuery: app,
      pid: meta?.pid || (sameActive ? this.state.pid : null),
      bundleId: meta?.bundleId || (sameActive ? this.state.bundleId : null),
      appDisplayName: meta?.appDisplayName || (sameActive ? this.state.appDisplayName : null),
    };
  }

  #runSerializedAction(fn) {
    const task = this.#actionQueue.then(async () => {
      this.#activeActionCount += 1;
      try {
        return await fn();
      } finally {
        this.#activeActionCount -= 1;
      }
    });
    this.#actionQueue = task.catch(() => {});
    return task;
  }

  /**
   * Check if `appQuery` is currently running without launching it.
   */
  async #checkAppRunning(peer, appQuery) {
    if (!appQuery) return { running: false, pid: null, apps: [] };
    const cached = this.registry.getMeta(appQuery);
    if (cached?.pid && isProcessAlive(cached.pid)) {
      return { running: true, pid: cached.pid, apps: null };
    }
    try {
      const listRes = await peer.callTool("list_apps", {}, 4_000);
      const parsed = parseAppsList(extractResultText(listRes));
      this.state.runningApps = parsed.filter((a) => a.isRunning);
      const match =
        findRunningApp(parsed, appQuery) ||
        (cached?.bundleId ? findRunningApp(parsed, cached.bundleId) : null) ||
        (cached?.appDisplayName ? findRunningApp(parsed, cached.appDisplayName) : null);
      return { running: Boolean(match), pid: null, match, apps: parsed };
    } catch {
      return { running: false, pid: null, apps: null };
    }
  }

  /**
   * Detach activeApp cleanly when the user or an action quits the target application,
   * preventing live stream or UI interactions from calling `get_app_state` and auto-relaunching it.
   */
  #detachExitedActiveApp(runningApps = null) {
    const exitedLabel = this.state.appDisplayName || this.state.activeApp;
    this.registry.deleteMeta(this.state.activeApp);
    this.registry.deleteMeta(this.state.bundleId);
    this.registry.deleteMeta(this.state.appDisplayName);

    this.state.activeApp = null;
    this.state.appDisplayName = null;
    this.state.bundleId = null;
    this.state.pid = null;
    this.state.windowId = null;
    this.state.pinnedWindowId = null;
    this.state.windowTitle = null;
    this.state.occludedNote = false;
    this.state.activeSnapshotId = null;
    this.state.frameWidth = 0;
    this.state.frameHeight = 0;
    this.state.frameLatencyMs = 0;
    this.previewStreamManager.clearActiveGeometry();
    this.#syncPreviewStateFields();
    this.webAdapter.clearFrameAndStopStream();
    if (Array.isArray(runningApps)) {
      this.state.runningApps = runningApps;
    }
    if (exitedLabel) {
      this.webAdapter.pushActionEvent({
        type: "setting",
        label: `应用已退出 · ${exitedLabel}（已停止后台同步）`,
        source: "ui",
      });
    } else {
      this.webAdapter.broadcastState();
    }
  }

  #isTinyFloatingImage(result) {
    const img = extractResultImage(result);
    if (!img?.data) return false;
    const dims = parseImageDimensions(Buffer.from(img.data, "base64"));
    return Boolean(dims && (dims.width < 180 || dims.height < 180));
  }

  async #upgradeTinyFloatingWindowResult(result, fallbackPid = null) {
    if (!result || result.isError || typeof this.mainWindowFallbackFn !== "function") {
      return { result, override: null };
    }
    const img = extractResultImage(result);
    if (!img?.data || !this.#isTinyFloatingImage(result)) {
      return { result, override: null };
    }
    const meta = parseSnapshotMetadata(extractResultText(result));
    const pid = meta.pid || fallbackPid;
    if (!Number.isInteger(pid) || pid <= 0) return { result, override: null };
    const replacement = await this.mainWindowFallbackFn(pid);
    if (!replacement?.data || !Array.isArray(result.content)) return { result, override: null };

    const repDims = parseImageDimensions(Buffer.from(replacement.data, "base64"));
    const override = replacement.bounds
      ? {
          wid: replacement.wid || null,
          bounds: replacement.bounds,
          imgWidth: replacement.imgWidth || repDims?.width || replacement.bounds.width,
          imgHeight: replacement.imgHeight || repDims?.height || replacement.bounds.height,
          windowTitle: replacement.windowTitle || null,
        }
      : null;

    const noteLine = override
      ? `[Main Window wid=${override.wid} (${override.bounds.width}x${override.bounds.height}) — ignored tiny floating widget]`
      : null;

    let annotatedText = false;
    const nextContent = result.content.map((item) => {
      if (item === img) {
        return {
          type: "image",
          mimeType: replacement.mimeType || "image/jpeg",
          data: replacement.data,
        };
      }
      if (!annotatedText && noteLine && item?.type === "text" && typeof item.text === "string") {
        annotatedText = true;
        return { ...item, text: `${noteLine}\n${item.text}` };
      }
      return item;
    });

    return {
      result: { ...result, content: nextContent },
      override,
    };
  }

  /**
   * Read-only non-activating `get_app_state` wrapper (`window_placement: "keep"` = `.readOnly`).
   */
  async #safeGetAppState(
    peer,
    rawArgs = {},
    {
      updateActiveApp = true,
      allowLaunch = true,
      observationalOnly = false,
      preserveScreenshotState = false,
      preservePinnedWindow = false,
      timeoutMs = null,
      operation = null,
    } = {}
  ) {
    const app = rawArgs.app;
    const argsWithReadOnly = {
      ...rawArgs,
      window_placement: "keep",
    };
    const canMutateForRead =
      !observationalOnly && allowLaunch && (!operation?.isAi || !this.takeoverController.paused);

    if (app) {
      const check = await this.#checkAppRunning(peer, app);
      if (!check.running) {
        if (!canMutateForRead) {
          if (this.#isSameActiveApp(app)) {
            this.#detachExitedActiveApp(check.apps?.filter((a) => a.isRunning));
          }
          return {
            isError: true,
            content: [{ type: "text", text: `Target app ${app} is no longer running.` }],
          };
        }
        if (operation?.isAi) {
          this.takeoverController.assertMayDispatch(operation, { isRead: false });
        }
        const launchPromise = launchAppInBackground(app);
        await (operation
          ? this.takeoverController.trackNativeWrite(operation, launchPromise, {
              routeKey: "app:launch_in_background",
            })
          : launchPromise);
      }
    }

    if (!observationalOnly && peer === this.actionPeer && argsWithReadOnly.include_ax !== false && app) {
      const preCached = this.registry.getMeta(app);
      if (preCached?.pid > 0 && !(operation?.isAi && this.takeoverController.paused)) {
        const wakePromise = this.registry.ensureRendererAxAwake(
          preCached.pid,
          preCached.processToken,
          {
            beforeWriteCheck: operation?.isAi
              ? () => this.takeoverController.assertMayDispatch(operation, { isRead: false })
              : null,
          }
        );
        await (operation
          ? this.takeoverController.trackNativeWrite(operation, wakePromise, {
              routeKey: "ax:ensure_manual",
            })
          : wakePromise);
      }
    }

    const capturePreShotObs = async () => {
      if (peer !== this.actionPeer || argsWithReadOnly.include_screenshot === false || !app) {
        return { obs: null, hadPrePid: false };
      }
      let prePid =
        this.registry.getMeta(app)?.pid || (this.#isSameActiveApp(app) ? this.state.pid : null) || 0;
      if (!(prePid > 0) && typeof this.runningAppIdentityFn === "function") {
        const preIdentity = await this.runningAppIdentityFn(app, { axBridge: this.axBridge }).catch(
          () => null
        );
        prePid = Number(preIdentity?.pid || 0);
      }
      if (!(prePid > 0)) return { obs: null, hadPrePid: false };
      const obs = await this.registry
        .captureWindowObservation(app, { pid: prePid, desktopHelperClient: this.desktopHelperClient })
        .catch(() => null);
      return { obs, hadPrePid: true };
    };

    if (operation?.isAi) {
      this.takeoverController.assertMayDispatch(operation, { isRead: true });
    }

    const t0 = Date.now();
    let result;
    let capturedPeerInstanceId = null;
    let preObsRes = await capturePreShotObs();
    const callTimeout = Number(timeoutMs) > 0 ? Math.max(50, Math.min(12_000, timeoutMs)) : undefined;
    try {
      result = await peer.callTool("get_app_state", argsWithReadOnly, callTimeout);
      capturedPeerInstanceId = peer?.agentInstanceId || null;
    } catch (err) {
      if (LOCKED_SESSION_POSIX_RE.test(String(err?.message || ""))) {
        this.#screenLockedBackoff = true;
        return {
          isError: true,
          content: [{ type: "text", text: LOCKED_SESSION_MESSAGE }],
        };
      }
      throw err;
    }
    this.#screenLockedBackoff = false;
    let text = extractResultText(result);

    if (result?.isError && app && !LOCKED_SESSION_POSIX_RE.test(text)) {
      const errCheck = await this.#checkAppRunning(peer, app);
      if (errCheck.running) {
        if (!observationalOnly && (!operation?.isAi || !this.takeoverController.paused)) {
          if (operation?.isAi) {
            this.takeoverController.assertMayDispatch(operation, { isRead: false });
          }
          const cached = this.registry.getMeta(app);
          const unhidePromise = unhideAppWithoutActivating(cached?.pid, app);
          await (operation
            ? this.takeoverController.trackNativeWrite(operation, unhidePromise, {
                routeKey: "app:unhide",
              })
            : unhidePromise);
          if (operation?.isAi) {
            this.takeoverController.assertMayDispatch(operation, { isRead: true });
          }
          preObsRes = await capturePreShotObs();
          result = await peer.callTool("get_app_state", argsWithReadOnly);
          capturedPeerInstanceId = peer?.agentInstanceId || null;
          text = extractResultText(result);
        }
      } else if (canMutateForRead) {
        if (operation?.isAi) {
          this.takeoverController.assertMayDispatch(operation, { isRead: false });
        }
        const launchRetryPromise = launchAppInBackground(app);
        await (operation
          ? this.takeoverController.trackNativeWrite(operation, launchRetryPromise, {
              routeKey: "app:launch_in_background",
            })
          : launchRetryPromise);
        if (operation?.isAi) {
          this.takeoverController.assertMayDispatch(operation, { isRead: true });
        }
        preObsRes = await capturePreShotObs();
        result = await peer.callTool("get_app_state", argsWithReadOnly);
        capturedPeerInstanceId = peer?.agentInstanceId || null;
        text = extractResultText(result);
      }
    }

    let tinyWindowOverride = null;
    if (!result?.isError && argsWithReadOnly.include_screenshot !== false && this.#isTinyFloatingImage(result)) {
      const fallbackPid =
        parseSnapshotMetadata(text).pid || this.registry.getMeta(app)?.pid || this.state.pid;
      if (
        !observationalOnly &&
        peer === this.actionPeer &&
        fallbackPid > 0 &&
        typeof this.promoteMainWindowFn === "function" &&
        !(operation?.isAi && this.takeoverController.paused)
      ) {
        if (operation?.isAi) {
          this.takeoverController.assertMayDispatch(operation, { isRead: false });
        }
        const promotePromise = this.promoteMainWindowFn(fallbackPid);
        const promoted = await (operation
          ? this.takeoverController.trackNativeWrite(operation, promotePromise, {
              routeKey: "ax:promote_main_window",
            })
          : promotePromise);
        if (promoted) {
          if (operation?.isAi) {
            this.takeoverController.assertMayDispatch(operation, { isRead: true });
          }
          preObsRes = await capturePreShotObs();
          const retryRes = await peer.callTool("get_app_state", argsWithReadOnly);
          if (!retryRes?.isError) {
            result = retryRes;
            capturedPeerInstanceId = peer?.agentInstanceId || null;
            text = extractResultText(result);
          }
        }
      }
      if (!observationalOnly && this.#isTinyFloatingImage(result)) {
        const upgraded = await this.#upgradeTinyFloatingWindowResult(result, fallbackPid);
        result = upgraded.result;
        text = extractResultText(result);
        tinyWindowOverride = upgraded.override;
      }
    }

    if (!result?.isError) {
      let meta = parseSnapshotMetadata(text);
      if (tinyWindowOverride?.windowTitle) {
        meta.windowTitle = tinyWindowOverride.windowTitle;
      }
      const targetPid = meta.pid || this.registry.getMeta(app)?.pid || null;
      const procIdentity =
        peer === this.actionPeer &&
        argsWithReadOnly.include_ax !== false &&
        targetPid &&
        typeof this.registry.resolveProcessIdentity === "function"
          ? await this.registry.resolveProcessIdentity(targetPid)
          : null;

      if (
        !observationalOnly &&
        peer === this.actionPeer &&
        argsWithReadOnly.include_ax !== false &&
        targetPid &&
        !(operation?.isAi && this.takeoverController.paused)
      ) {
        const wakePromise = this.registry.ensureRendererAxAwake(
          targetPid,
          procIdentity?.processToken,
          {
            beforeWriteCheck: operation?.isAi
              ? () => this.takeoverController.assertMayDispatch(operation, { isRead: false })
              : null,
          }
        );
        const wake = await (operation
          ? this.takeoverController.trackNativeWrite(operation, wakePromise, {
              routeKey: "ax:ensure_manual",
            })
          : wakePromise);
        if (wake?.changed) {
          await new Promise((r) => setTimeout(r, 35));
          if (operation?.isAi) {
            this.takeoverController.assertMayDispatch(operation, { isRead: true });
          }
          preObsRes = await capturePreShotObs();
          const wokenRes = await peer.callTool("get_app_state", argsWithReadOnly).catch(() => null);
          if (wokenRes && !wokenRes.isError) {
            capturedPeerInstanceId = peer?.agentInstanceId || null;
            if (argsWithReadOnly.include_screenshot !== false && this.#isTinyFloatingImage(wokenRes)) {
              const upgradedWake = await this.#upgradeTinyFloatingWindowResult(wokenRes, targetPid);
              result = upgradedWake.result;
              tinyWindowOverride = upgradedWake.override;
            } else {
              result = wokenRes;
              if (argsWithReadOnly.include_screenshot !== false) {
                tinyWindowOverride = null;
              }
            }
            text = extractResultText(result);
            meta = parseSnapshotMetadata(text);
            if (tinyWindowOverride?.windowTitle) {
              meta.windowTitle = tinyWindowOverride.windowTitle;
            }
          }
        }
      }

      const latencyMs = Date.now() - t0;
      const img = extractResultImage(result);
      const imgBytes = img?.data ? Buffer.from(img.data, "base64") : null;
      const imgDims = imgBytes ? parseImageDimensions(imgBytes) : null;
      const imgDigest = imgBytes ? computeFrameDigest(imgBytes) : undefined;
      meta.peerInstanceId = capturedPeerInstanceId;
      if (
        peer === this.actionPeer &&
        argsWithReadOnly.include_screenshot !== false &&
        !tinyWindowOverride &&
        targetPid > 0 &&
        imgDims?.width > 0 &&
        imgDims?.height > 0 &&
        typeof this.registry.proveScreenshotWindowObservation === "function"
      ) {
        const proof = await this.registry.proveScreenshotWindowObservation(app, {
          pid: targetPid,
          imgDims,
          windowTitle: meta.windowTitle || "",
          parsedWindowId: meta.windowId || null,
          preObs: preObsRes?.obs || null,
          hadPrePid: Boolean(preObsRes?.hadPrePid),
          desktopHelperClient: this.desktopHelperClient,
        });
        meta.windowCount = proof.windowCount;
        meta.singleWindowProven = proof.singleWindowProven;
        if (proof.proven) {
          meta.windowId = proof.windowId;
          meta.windowBounds = proof.windowBounds;
        } else {
          meta.windowId = null;
          meta.windowBounds = null;
        }
      }
      const merged = this.registry.recordMeta(app, meta, {
        fromActionPeer: peer === this.actionPeer,
        includeAx: argsWithReadOnly.include_ax !== false,
        includeScreenshot: argsWithReadOnly.include_screenshot !== false,
        preserveScreenshotState,
        actionDims: imgDims,
        imageDigest: argsWithReadOnly.include_screenshot !== false ? imgDigest : undefined,
        tinyWindowOverride:
          argsWithReadOnly.include_screenshot !== false ? tinyWindowOverride : undefined,
        processToken: procIdentity?.processToken,
        source: "snapshot",
      });
      if (peer === this.actionPeer && argsWithReadOnly.include_ax !== false) {
        this.registry.bindSnapshotHandles(merged);
      }

      if (updateActiveApp) {
        const switching = !this.#isSameActiveApp(merged.bundleId || app);
        if (switching && !preservePinnedWindow) {
          this.state.pinnedWindowId = null;
        }
        this.state.activeApp = merged.bundleId || app;
        this.state.bundleId = merged.bundleId ?? (switching ? null : this.state.bundleId);
        this.state.pid = merged.pid ?? (switching ? null : this.state.pid);
        this.state.appDisplayName = merged.appDisplayName || app;
        this.state.windowTitle = merged.windowTitle ?? (switching ? null : this.state.windowTitle);
        this.state.occludedNote = Boolean(merged.occludedNote);
        if (merged.snapshotId) {
          this.state.activeSnapshotId = merged.snapshotId;
        } else if (switching) {
          this.state.activeSnapshotId = null;
        }
      }

      if (img && (!this.state.activeApp || this.#isSameActiveApp(merged.bundleId || app) || updateActiveApp)) {
        const dims = parseImageDimensions(imgBytes);
        if (dims) {
          this.state.frameWidth = dims.width;
          this.state.frameHeight = dims.height;
        }
        await this.#refreshAndPublishPreviewFrame({
          app: merged.bundleId || app,
          pid: Number(merged.pid || this.state.pid || 0),
          img,
          latencyMs,
          provenWid: tinyWindowOverride
            ? Number(tinyWindowOverride.wid || 0) || null
            : merged?.actionScreenshotMeta?.windowIdProven
              ? Number(merged?.windowId || 0) || null
              : null,
          minWinCount: Number(merged?.actionScreenshotMeta?.windowCount || 0),
          forceCheckMultiWindow: !tinyWindowOverride,
        }).catch(() => {});
      } else if (updateActiveApp) {
        await this.#refreshActivePreviewGeometry({
          app: merged.bundleId || app,
          allowHelperQuery: true,
          selectAsActive: true,
        }).catch(() => {});
      }

      if (peer === this.actionPeer && argsWithReadOnly.include_ax !== false && merged.snapshotId) {
        result = appendResultFooter(
          result,
          `[Snapshot: ${merged.snapshotId}${merged.pid ? ` | PID: ${merged.pid}` : ""}${merged.windowTitle ? ` | Window: "${merged.windowTitle}"` : ""}]`
        );
      }
      result = redactToolResultSecureText(result);
    }

    return result;
  }

  async #refreshPermissionsQuietly() {
    const now = Date.now();
    let jxaPerms = {
      platform: process.platform,
      accessibility: this.state.permissions.accessibility,
      screenRecording: this.state.permissions.screenRecording,
      checkedAt: now,
    };
    if (typeof this.permissionsFn === "function") {
      try {
        const perms = await this.permissionsFn({ axBridge: this.axBridge });
        if (perms && typeof perms === "object") {
          jxaPerms = {
            platform: perms.platform || process.platform,
            accessibility: perms.accessibility ?? this.state.permissions.accessibility,
            screenRecording: perms.screenRecording ?? this.state.permissions.screenRecording,
            checkedAt: perms.checkedAt || now,
          };
          this.state.permissions = {
            platform: jxaPerms.platform,
            accessibility: jxaPerms.accessibility,
            screenRecording: jxaPerms.screenRecording,
          };
        }
      } catch {}
    }

    const helperDiag = this.desktopHelperClient
      ? this.desktopHelperClient.getDiagnostics()
      : {
          available: false,
          reason: this.launchHelperOnStart === false ? "disabled" : "not_configured",
          bundleId: null,
          capabilities: {
            screenRecordingPreflight: null,
            inputMonitoringPreflight: null,
            accessibilityTrusted: null,
            mouseTapActive: false,
            keyTapActive: false,
            hotkeyActive: false,
            fallbackReason: "not_configured",
          },
        };
    const helperScreenRecording = helperDiag.available
      ? helperDiag.capabilities?.screenRecordingPreflight
      : null;
    const ocuStreamVerified = this.#ocuObservationStats.streamOk === true;
    const effectiveScreenRecording =
      helperScreenRecording === true || ocuStreamVerified
        ? true
        : jxaPerms.screenRecording;

    this.state.permissions = {
      platform: jxaPerms.platform,
      accessibility: jxaPerms.accessibility,
      screenRecording: effectiveScreenRecording,
    };

    const srAvail = existsSync(SCRIPT_RUNNER_APP_PATH) && existsSync(SCRIPT_RUNNER_BIN_PATH);
    const ocuActionComp = {
      status:
        this.#ocuObservationStats.actionOk === true
          ? "verified"
          : this.#ocuObservationStats.actionOk === false
            ? "degraded"
            : "unprobed",
      identity: "Open Computer Use.app",
      checkedAt: this.#ocuObservationStats.checkedAt || now,
      lastError: this.#ocuObservationStats.lastError,
    };
    const ocuStreamComp = {
      status:
        this.#ocuObservationStats.streamOk === true
          ? "verified"
          : this.#ocuObservationStats.streamOk === false
            ? "degraded"
            : "unprobed",
      identity: "Open Computer Use.app",
      checkedAt: this.#ocuObservationStats.checkedAt || now,
    };
    this.state.permissionComponents = {
      ocuAction: ocuActionComp,
      ocuStream: ocuStreamComp,
      ocu: {
        action: ocuActionComp,
        stream: ocuStreamComp,
      },
      jxa: {
        status: jxaPerms.accessibility === true ? "granted" : jxaPerms.accessibility === false ? "denied" : "unknown",
        identity: "/usr/bin/osascript",
        accessibility: jxaPerms.accessibility,
        screenRecording: jxaPerms.screenRecording,
        checkedAt: jxaPerms.checkedAt,
      },
      desktopHelper: {
        status: helperDiag.available
          ? helperDiag.capabilities.mouseTapActive || helperDiag.capabilities.keyTapActive
            ? "enhanced"
            : "baseline"
          : "unavailable",
        identity: helperDiag.bundleId || "CUADesktopHelper.app",
        reason: helperDiag.reason || helperDiag.capabilities?.fallbackReason || null,
        preflight: {
          screenRecording: helperDiag.capabilities?.screenRecordingPreflight ?? null,
          inputMonitoring: helperDiag.capabilities?.inputMonitoringPreflight ?? null,
          accessibility: helperDiag.capabilities?.accessibilityTrusted ?? null,
        },
        activeCapabilities: {
          mouseTapActive: Boolean(helperDiag.capabilities?.mouseTapActive),
          keyTapActive: Boolean(helperDiag.capabilities?.keyTapActive),
          hotkeyActive: Boolean(helperDiag.capabilities?.hotkeyActive),
          videoAvailable: Boolean(helperDiag.videoAvailable),
        },
        capabilities: helperDiag.capabilities,
        checkedAt: now,
      },
      scriptRunner: {
        status: srAvail ? "available" : "missing",
        identity: "CUAScriptRunner.app",
        checkedAt: now,
      },
    };
  }

  async getPermissionsReport() {
    return {
      ...this.state.permissions,
      version: 2,
      checkedAt: Date.now(),
      takeoverMode: this.state.takeoverMode,
      views: this.previewStreamManager.getViewDiagnostics(),
      components: this.state.permissionComponents || {},
    };
  }

  async #handleRequestPermission(kind) {
    if (!["screenRecording", "inputMonitoring"].includes(kind)) {
      return { ok: false, error: "Unsupported permission kind" };
    }
    if (!this.desktopHelperClient || !this.desktopHelperClient.available) {
      return { ok: false, error: "CUADesktopHelper 未连接或未安装" };
    }
    const res = await this.desktopHelperClient.requestPermission(kind);
    await this.#refreshPermissionsQuietly();
    this.webAdapter.broadcastState();
    return { ok: true, ...res, permissions: await this.getPermissionsReport() };
  }

  async #handleSettingsUpdate(data = {}) {
    if (typeof data.followAi === "boolean") {
      this.state.followAi = data.followAi;
    }
    if (typeof data.paused === "boolean") {
      if (data.paused) {
        this.takeoverController.requestPause({
          reason: "manual_pause",
          source: "ui",
          rule: "manual_pause",
          label: "已手动暂停 AI 操作",
          transfersFocusToTarget: false,
        });
      } else {
        const res = await this.takeoverController.resume({
          expectedPauseEpoch: data.expectedPauseEpoch ?? null,
        });
        this.#syncTakeoverStateFields();
        this.webAdapter.broadcastState();
        return res;
      }
    }
    this.#syncTakeoverStateFields();
    this.webAdapter.broadcastState();
    return { ok: true, ...this.takeoverController.publicState() };
  }

  async #handleTakeoverClaim(data = {}) {
    const targetApp = String(data.app || this.state.activeApp || "").trim() || null;
    if (
      data.requireActiveMatch &&
      targetApp &&
      this.state.activeApp &&
      !this.#isSameActiveApp(targetApp)
    ) {
      const err = new Error("Active app changed before interaction; ignored stale target");
      err.statusCode = 409;
      throw err;
    }
    const targetMeta = targetApp ? this.registry.getMeta(targetApp) : null;
    const out = this.takeoverController.requestPause({
      reason: String(data.reason || "ui_interact"),
      source: "ui",
      rule: String(data.rule || "ui_interact_claim"),
      label: String(data.label || "小窗操作接管已暂停 AI"),
      intentId: typeof data.intentId === "string" ? data.intentId : null,
      targetApp: targetMeta?.bundleId || targetApp,
      targetPid: targetMeta?.pid || (targetApp && this.#isSameActiveApp(targetApp) ? this.state.pid : null),
      transfersFocusToTarget: false,
    });
    return { ok: true, ...out };
  }

  /**
   * Refresh running app inventory for the UI dropdown without activating anything.
   */
  async refreshAppsList() {
    const res = await this.actionPeer.callTool("list_apps", {});
    const text = extractResultText(res);
    const parsed = parseAppsList(text);
    this.state.runningApps = parsed.filter((a) => a.isRunning);
    this.webAdapter.broadcastState();
    return { rawResult: res, apps: parsed };
  }

  #buildOperationAbortedResult(name, err) {
    const code = err?.code || "PAUSED";
    const msg = err?.message || "Computer Use 已被暂停或取消。";
    const deliveryState = err?.deliveryState || null;
    if (name === "act") {
      return buildActToolResult({
        isError: true,
        status: "cancelled",
        code,
        message: msg,
        sent: deliveryState === "sent_unknown",
        ...(deliveryState ? { deliveryState } : {}),
      });
    }
    return {
      isError: true,
      ...(deliveryState ? { deliveryState, fatal: true } : {}),
      ...(code ? { reason: code } : {}),
      content: [{ type: "text", text: `[${code}] ${msg}` }],
    };
  }

  #registerOperationTarget(operation, app, fallbackMeta = null, explicitWid = null) {
    if (!operation?.isAi || !app) return;
    const meta = fallbackMeta || this.registry.getMeta(app);
    const pid = meta?.pid || (this.#isSameActiveApp(app) ? this.state.pid : null) || null;
    const wid =
      Number(explicitWid) > 0
        ? Number(explicitWid)
        : meta?.tinyWindowOverride?.wid || meta?.windowId || null;
    if (!pid && !meta?.bundleId && !this.state.bundleId) return;
    this.takeoverController.setTarget(operation, {
      app,
      bundleId: meta?.bundleId || (this.#isSameActiveApp(app) ? this.state.bundleId : null),
      appDisplayName:
        meta?.appDisplayName || (this.#isSameActiveApp(app) ? this.state.appDisplayName : null) || app,
      pid,
      processToken: meta?.processToken || null,
      windowId: wid,
      windowTitle: meta?.windowTitle || null,
    });
  }

  /**
   * Execute a Computer Use tool call (from `mcp-server`, `mcp-repl-server`, or Mini-Window UI).
   * Strictly serialized so parallel model tool calls never interleave snapshots or AX indexes.
   */
  async executeToolCall(name, args = {}, options = {}) {
    const source = options?.source || "ai";
    const isAiSource = source === "ai" || source === "ai-repl";
    const isMutating = !["list_apps", "get_app_state", "query"].includes(name);
    let operation = null;

    if (options?.parentOperation) {
      operation = options.parentOperation;
      try {
        this.takeoverController.assertMayDispatch(operation, { isRead: !isMutating });
      } catch (err) {
        if (isTakeoverAbortedError(err)) {
          return this.#buildOperationAbortedResult(name, err);
        }
        throw err;
      }
    } else {
      try {
        operation = this.takeoverController.admit({
          name,
          isAi: isAiSource,
          isMutating,
          allowReadWhenPaused: true,
          signal: options?.signal || null,
        });
        if (source === "ai-repl" || options?.isRepl) {
          operation.isRepl = true;
        }
      } catch (err) {
        if (isTakeoverAbortedError(err)) {
          return this.#buildOperationAbortedResult(name, err);
        }
        throw err;
      }
    }

    return this.#runSerializedAction(async () => {
      try {
        this.takeoverController.assertMayDispatch(operation, { isRead: !isMutating });
        return await this.#executeToolCallUnlocked(name, args, { ...options, operation });
      } catch (err) {
        if (isTakeoverAbortedError(err)) {
          return this.#buildOperationAbortedResult(name, err);
        }
        throw err;
      } finally {
        if (!options?.parentOperation) {
          this.takeoverController.clearOperation(operation);
        }
      }
    });
  }

  async #executeToolCallUnlocked(
    name,
    args = {},
    { source = "ai", focusScopeOverride = null, signal = null, operation = null, windowDelivery = null } = {}
  ) {
    const isAiSource = source === "ai" || source === "ai-repl";
    const isMutating = !["list_apps", "get_app_state", "query"].includes(name);
    const effectiveSignal = operation?.signal || signal;

    if (isAiSource && isMutating && this.takeoverController.paused) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: "Computer Use 已被用户在右侧「Computer Use 小窗」暂停（Paused by user）。请先停下并询问用户是否继续。",
          },
        ],
      };
    }

    if (name === "list_apps") {
      if (this.state.permissions.accessibility === null) {
        void this.#refreshPermissionsQuietly();
      }
      const { rawResult } = await this.refreshAppsList();
      return rawResult;
    }

    const app = args.app;
    const shouldFollow = source === "ui" || this.state.followAi || !this.state.activeApp;
    const focusScope =
      focusScopeOverride || (app ? await this.focusPolicyGuard.beginGuard(app) : null);
    let focusFinalized = false;
    let touchedTargetOs = false;
    let lastRouteKey = `${name}:aborted`;
    let routeScope = null;

    if (isAiSource) {
      this.state.aiStatus = isMutating ? "acting" : "observing";
      this.state.lastActivityAt = Date.now();
      this.webAdapter.broadcastState();
    }

    try {
      if (name === "get_app_state") {
        if (this.state.permissions.accessibility === null) {
          void this.#refreshPermissionsQuietly();
        }
        const cachedMeta = this.registry.getMeta(app);
        const preserveActionAx =
          args.include_ax === false &&
          args.include_screenshot !== false &&
          Boolean(this.streamPeer) &&
          Boolean(cachedMeta?.actionHasAx);
        const targetPeer = preserveActionAx ? this.streamPeer : this.actionPeer;

        touchedTargetOs = true;
        lastRouteKey = "get_app_state";
        let res = await this.#safeGetAppState(targetPeer, args, {
          updateActiveApp: shouldFollow,
          allowLaunch: !this.takeoverController.paused,
          operation,
        });
        this.#ocuObservationStats.checkedAt = Date.now();
        if (targetPeer === this.streamPeer) {
          this.#ocuObservationStats.streamOk = !res?.isError;
        } else {
          this.#ocuObservationStats.actionOk = !res?.isError;
          if (res?.isError) this.#ocuObservationStats.lastError = extractResultText(res).slice(0, 120);
        }
        const stolen = await focusScope?.enforce("get_app_state");
        focusScope?.finish("get_app_state", { alreadyRecorded: Boolean(stolen) });
        focusFinalized = true;
        if (!res?.isError && preserveActionAx) {
          const preservedId = this.registry.getLatestSnapshot(cachedMeta?.bundleId || app)?.id;
          if (preservedId) {
            res = appendResultFooter(
              res,
              `[Snapshot: ${preservedId} | Screenshot-only frame; previous element refs preserved]`
            );
          }
        }
        if (isAiSource && !res?.isError && args.include_ax !== false) {
          const meta = this.registry.getMeta(app);
          this.webAdapter.pushActionEvent({
            type: "observe",
            label: `读取窗口状态 · ${meta?.windowTitle || app}`,
            source: "ai",
            app: meta?.appDisplayName || app,
            targetApp: meta?.bundleId || app,
          });
        } else {
          this.webAdapter.broadcastState();
        }
        if (
          operation?.isAi &&
          (operation.isMutating || operation.isRepl) &&
          !res?.isError &&
          app
        ) {
          this.#registerOperationTarget(operation, app, this.registry.getMeta(app), args.window_id);
        }
        this.webAdapter.ensureStreamLoop();
        return res;
      }

      if (name === "query") {
        let resolvedQueryApp = null;
        let queryPid = null;
        let queryToken = null;
        touchedTargetOs = true;
        lastRouteKey = "query";
        if (app) {
          const check = await this.#checkAppRunning(this.actionPeer, app);
          if (!check.running && isAiSource) {
            if (this.takeoverController.paused) {
              return {
                isError: true,
                content: [
                  {
                    type: "text",
                    text: "[PAUSED] Computer Use 已被用户暂停，未自动启动已退出的目标应用。",
                  },
                ],
              };
            }
            this.takeoverController.assertMayDispatch(operation, { isRead: false });
            await this.takeoverController.trackNativeWrite(operation, launchAppInBackground(app), {
              routeKey: "app:launch_in_background",
            });
          }
          const preMetaForQuery = this.registry.getMeta(app);
          const listAppMatch = findRunningApp(check.apps, app);
          if (
            !preMetaForQuery?.pid &&
            !listAppMatch?.pid &&
            typeof this.runningAppIdentityFn === "function"
          ) {
            resolvedQueryApp = await this.runningAppIdentityFn(app, {
              axBridge: this.axBridge,
            }).catch(() => null);
          }
          queryPid = preMetaForQuery?.pid || listAppMatch?.pid || resolvedQueryApp?.pid || null;
          queryToken = preMetaForQuery?.processToken || resolvedQueryApp?.processToken || null;
          if (queryPid > 0 && !(isAiSource && this.takeoverController.paused)) {
            const wake = await this.takeoverController.trackNativeWrite(
              operation,
              this.registry.ensureRendererAxAwake(queryPid, queryToken, {
                beforeWriteCheck: isAiSource
                  ? () => this.takeoverController.assertMayDispatch(operation, { isRead: false })
                  : null,
              }),
              { routeKey: "ax:ensure_manual" }
            );
            if (wake?.changed) {
              await new Promise((r) => setTimeout(r, 35));
            }
          }
        }

        if (isAiSource) {
          this.takeoverController.assertMayDispatch(operation, { isRead: true });
        }
        let res = await this.actionPeer.callTool("query", args);
        if (res?.isError && /target app is hidden/iu.test(extractResultText(res))) {
          if (!isAiSource || !this.takeoverController.paused) {
            if (isAiSource) {
              this.takeoverController.assertMayDispatch(operation, { isRead: false });
            }
            const meta = this.registry.getMeta(app);
            await this.takeoverController.trackNativeWrite(
              operation,
              unhideAppWithoutActivating(meta?.pid || queryPid, app),
              { routeKey: "app:unhide" }
            );
            if (isAiSource) {
              this.takeoverController.assertMayDispatch(operation, { isRead: true });
            }
            res = await this.actionPeer.callTool("query", args);
          }
        }
        const stolen = await focusScope?.enforce("query");
        focusScope?.finish("query", { alreadyRecorded: Boolean(stolen) });
        focusFinalized = true;
        const processed = await this.#processQueryResult(app, res, {
          queryPid,
          queryToken,
          resolvedQueryApp,
          updateActiveSnapshot: true,
        });
        if (
          operation?.isAi &&
          (operation.isMutating || operation.isRepl) &&
          !processed.result?.isError &&
          app
        ) {
          this.#registerOperationTarget(operation, app, this.registry.getMeta(app), args.window_id);
        }
        return processed.result;
      }

      if (name === "act") {
        const actResult = await this.actExecutor.execute(args, {
          isAiSource,
          shouldFollow,
          focusScope,
          signal: effectiveSignal,
          clientSignal: signal,
          operation,
          markOsTouched: (routeKey) => {
            touchedTargetOs = true;
            lastRouteKey = routeKey;
          },
          markFocusFinalized: () => {
            focusFinalized = true;
          },
        });
        this.webAdapter.broadcastState();
        this.webAdapter.ensureStreamLoop();
        return actResult;
      }

      const parsedRef = parseQualifiedElementRef(args.element_index, args.snapshot_id);
      if (!parsedRef.ok) {
        const latestForApp = app
          ? this.registry.getLatestSnapshot(this.registry.getMeta(app)?.bundleId || app)
          : null;
        return buildStaleRefToolResult({
          errorCode: parsedRef.errorCode,
          message: parsedRef.message,
          currentSnapshotId: latestForApp?.id || null,
        });
      }
      const cleanArgs = sanitizeToolArgsForNative(args, parsedRef);

      // Guard mutating actions (including Raise): never foreground-launch a quit app on UI calls
      // or pinned snapshot refs, and pre-launch with `open -g` on unpinned AI calls if not running.
      if (app) {
        const preCheck = await this.#checkAppRunning(this.actionPeer, app);
        if (!preCheck.running) {
          this.registry.markAppStale(this.registry.getMeta(app)?.bundleId || app, "app_exited");
          if (source === "ui") {
            if (this.#isSameActiveApp(app)) {
              this.#detachExitedActiveApp(preCheck.apps?.filter((a) => a.isRunning));
            }
            return {
              isError: true,
              content: [{ type: "text", text: "目标应用已退出，操作已取消。" }],
            };
          }
          if (parsedRef.snapshotId) {
            this.state.headlessStats.staleRefsBlocked += 1;
            this.webAdapter.pushActionEvent({
              type: "stale_ref",
              label: `拦截过期引用（应用已退出）· ${parsedRef.displayRef}`,
              source: isAiSource ? "ai" : "ui",
              app: this.registry.getMeta(app)?.appDisplayName || app,
              targetApp: this.registry.getMeta(app)?.bundleId || app,
            });
            return buildStaleRefToolResult({
              errorCode: "STALE_REF",
              message: `目标应用 "${app}" 已退出，旧快照引用 ${parsedRef.displayRef} 已失效（未自动重启应用）。请先调用 get_app_state 重新启动并获取新快照。`,
              currentSnapshotId: null,
            });
          }
          touchedTargetOs = true;
          lastRouteKey = "launch";
          if (isAiSource) {
            this.takeoverController.assertMayDispatch(operation, { isRead: false });
          }
          await this.takeoverController.trackNativeWrite(operation, launchAppInBackground(app), {
            routeKey: "app:launch_in_background",
          });
          await this.#safeGetAppState(
            this.actionPeer,
            { app, include_ax: true, include_screenshot: true, max_tree_nodes: 150 },
            { updateActiveApp: shouldFollow, allowLaunch: false, operation }
          );
          await focusScope?.enforce("launch");
        } else if (!this.registry.getMeta(app)?.actionHasAx) {
          touchedTargetOs = true;
          lastRouteKey = "warm_state";
          await this.#safeGetAppState(
            this.actionPeer,
            { app, include_ax: true, include_screenshot: true, max_tree_nodes: 200 },
            { updateActiveApp: shouldFollow, allowLaunch: false, operation }
          );
          await focusScope?.enforce("warm_state");
        } else if (!this.registry.getMeta(app)?.pid && typeof this.runningAppIdentityFn === "function") {
          const liveInfo = await this.runningAppIdentityFn(app, { axBridge: this.axBridge }).catch(
            () => null
          );
          if (liveInfo?.pid > 0) {
            const existing = this.registry.getMeta(app);
            this.registry.recordMeta(
              app,
              {
                pid: liveInfo.pid,
                bundleId: existing?.bundleId || liveInfo.bundleId || null,
                appDisplayName: existing?.appDisplayName || liveInfo.displayName || null,
                windowTitle: existing?.windowTitle || null,
              },
              {
                fromActionPeer: false,
                includeAx: false,
                includeScreenshot: false,
                processToken: liveInfo.processToken,
              }
            );
          }
        }
        this.#registerOperationTarget(operation, app, this.registry.getMeta(app), args.window_id);
      }

      if (name === "perform_secondary_action") {
        if (/^(?:ax)?raise$/iu.test(String(cleanArgs.action || "").trim())) {
          touchedTargetOs = true;
          lastRouteKey = "perform_secondary_action:raise_blocked";
          const stateRes = await this.#safeGetAppState(
            this.actionPeer,
            { app, text_limit: 500 },
            { updateActiveApp: shouldFollow, allowLaunch: false, operation }
          );
          const stolen = await focusScope?.enforce("perform_secondary_action:raise_blocked");
          focusScope?.finish("perform_secondary_action:raise_blocked", {
            alreadyRecorded: Boolean(stolen),
          });
          focusFinalized = true;
          const existingText = extractResultText(stateRes);
          return {
            isError: false,
            content: [
              {
                type: "text",
                text: `Skipped Raise to keep window in background without stealing user focus.\n${existingText}`,
              },
              ...(stateRes?.content || []).filter((c) => c.type === "image"),
            ],
          };
        }
      }

      // Fail-closed closed-loop validation for qualified `@sN:index` or known AX snapshots
      const isSyntheticUiScroll =
        source === "ui" &&
        name === "scroll" &&
        cleanArgs.element_index === "0" &&
        !parsedRef.snapshotId;
      let validatedElement = null;
      let validatedSnapshot = null;
      if (app && (parsedRef.hasElementRef || parsedRef.snapshotId) && !isSyntheticUiScroll) {
        touchedTargetOs = true;
        if (lastRouteKey === `${name}:aborted`) {
          lastRouteKey = "validate_ref";
        }
        const valRes = await this.registry.validateTargetRef({
          app,
          parsedRef,
          refreshActionState: () =>
            this.#safeGetAppState(
              this.actionPeer,
              { app, include_ax: true, include_screenshot: true, max_tree_nodes: 200 },
              { updateActiveApp: shouldFollow, allowLaunch: false, operation }
            ),
        });
        if (!valRes.ok) {
          this.state.headlessStats.staleRefsBlocked += 1;
          const prefix = valRes.stage === "live_ax" ? "拦截后台异步变更" : "拦截过期引用";
          this.webAdapter.pushActionEvent({
            type: "stale_ref",
            label: `${prefix} · ${parsedRef.displayRef}${valRes.currentSnapshotId ? ` → 请改用 ${valRes.currentSnapshotId}` : ""}`,
            source: isAiSource ? "ai" : "ui",
            app: valRes.currentMeta?.appDisplayName || app,
            targetApp: valRes.currentMeta?.bundleId || app,
          });
          return buildStaleRefToolResult({
            errorCode: valRes.errorCode,
            message: valRes.message,
            currentSnapshotId: valRes.currentSnapshotId,
          });
        }
        validatedElement = valRes.element || null;
        validatedSnapshot = valRes.snapshot || null;
        this.#registerOperationTarget(operation, app, this.registry.getMeta(app), args.window_id);
      }

      // Pre-dispatch advertised secondary action verification
      if (name === "perform_secondary_action" && parsedRef.hasElementRef) {
        const currentMeta = this.registry.getMeta(app);
        const targetEl = validatedElement || currentMeta?.elements?.get(parsedRef.rawIndex) || null;
        if (targetEl && Array.isArray(targetEl.secondaryActions) && targetEl.secondaryActions.length > 0) {
          const matchedAction = matchAdvertisedAction(targetEl.secondaryActions, cleanArgs.action);
          if (!matchedAction) {
            return {
              isError: true,
              content: [
                {
                  type: "text",
                  text: `[ACTION_NOT_SUPPORTED] 元素 #${parsedRef.rawIndex} (${targetEl.label}) 未声明辅助动作 "${cleanArgs.action}"；当前可用动作: ${targetEl.secondaryActions.join(", ")}。`,
                },
              ],
            };
          }
          cleanArgs.action = matchedAction;
        }
      }

      // Track AI's target app when followAi is enabled
      if (app && shouldFollow && !this.#isSameActiveApp(app)) {
        const known = this.registry.getMeta(app);
        this.state.activeApp = known?.bundleId || app;
        this.state.bundleId = known?.bundleId ?? null;
        this.state.pid = known?.pid ?? null;
        this.state.appDisplayName = known?.appDisplayName || app;
        this.state.windowTitle = known?.windowTitle ?? null;
        this.state.activeSnapshotId =
          this.registry.getLatestSnapshot(known?.bundleId || app)?.id ?? null;
      }

      if (effectiveSignal?.aborted) {
        if (isTakeoverAbortedError(effectiveSignal.reason)) {
          return this.#buildOperationAbortedResult(name, effectiveSignal.reason);
        }
        return {
          isError: true,
          content: [{ type: "text", text: "[CANCELLED] 调用已在发送前取消。" }],
        };
      }
      this.takeoverController.assertMayDispatch(operation, { isRead: !isMutating });

      const preMeta = app ? this.registry.getMeta(app) : null;
      const preSnap =
        validatedSnapshot ||
        (parsedRef.snapshotId ? this.registry.ledger.getSnapshot(parsedRef.snapshotId) : null) ||
        (app ? this.registry.getLatestSnapshot(preMeta?.bundleId || app) : null);
      const initialRouteScope = this.registry.buildRouteScope(preMeta, {
        snapshot: preSnap,
        windowId: windowDelivery?.windowId || null,
      });
      const preFocusObs =
        app && (name === "click" || name === "drag" || !initialRouteScope?.windowId)
          ? await this.registry.captureWindowObservation(app, {
              desktopHelperClient: this.desktopHelperClient,
              preferredTitle: preMeta?.windowTitle || "",
            })
          : null;
      routeScope = this.registry.buildRouteScope(preMeta, {
        snapshot: preSnap,
        windowId: windowDelivery?.windowId || preFocusObs?.wid || null,
      });

      touchedTargetOs = true;
      const dispatched = await this.actionExecutor.dispatch({
        name,
        app,
        cleanArgs,
        parsedRef,
        validatedElement,
        validatedSnapshot,
        shouldFollow,
        eventSource: isAiSource ? "ai" : "ui",
        fallbackDims: {
          width: this.state.frameWidth,
          height: this.state.frameHeight,
          sameApp: this.#isSameActiveApp(app),
        },
        operation,
        windowDelivery,
        routeScope,
        focusScope,
        liveWindowObs: preFocusObs,
      });
      lastRouteKey = dispatched.actionRouteKey || lastRouteKey;

      if (dispatched.actionEvent) {
        this.webAdapter.pushActionEvent(dispatched.actionEvent);
      }

      if (dispatched.isStalePinnedRef) {
        this.state.headlessStats.staleRefsBlocked += 1;
        return dispatched.result;
      }

      let result = dispatched.result;
      let businessWindowTransition = false;
      if (name === "click" && result && !result.isError && Number(preFocusObs?.wid || 0) > 0) {
        const postFocusObs = await this.registry.captureWindowObservation(app, {
          desktopHelperClient: this.desktopHelperClient,
        });
        if (this.registry.detectNewWindowTransition(preFocusObs, postFocusObs)) {
          businessWindowTransition = true;
          this.registry.recordObservedWindowTransition(app, preMeta, postFocusObs);
        }
      }
      if (app && focusScope) {
        const stolen = await focusScope.enforce(dispatched.actionRouteKey, {
          recordRoutePenalty: !businessWindowTransition,
          routeScope,
        });
        focusScope.finish(dispatched.actionRouteKey, {
          alreadyRecorded: Boolean(stolen),
          recordRoutePenalty: !businessWindowTransition,
          routeScope,
        });
        focusFinalized = true;
      }

      // Safe .readOnly post-action read-back & closed-loop delivery verification
      if (result && !result.isError && app) {
        const postCheck = await this.#checkAppRunning(this.actionPeer, app);
        if (!postCheck.running) {
          this.registry.markAppStale(dispatched.preAppKey, "app_exited");
          if (this.#isSameActiveApp(app)) {
            this.#detachExitedActiveApp(postCheck.apps?.filter((a) => a.isRunning));
          } else {
            this.registry.deleteMeta(app);
          }
          return {
            isError: false,
            content: [{ type: "text", text: "Action completed; target app exited." }],
          };
        }

        this.state.headlessStats.totalMutations += 1;

        if (isAiSource) {
          const verifiedOut = await this.actionExecutor.verifyAndFormatReadBack({
            name,
            cleanArgs,
            parsedRef,
            ...dispatched,
            checkAppRunningFn: () => this.#checkAppRunning(this.actionPeer, app),
            onBeforeReadBackFn: () => focusScope?.enterObservationPhase?.(),
            readBackStateFn: () =>
              this.#safeGetAppState(
                this.actionPeer,
                { app },
                {
                  updateActiveApp: shouldFollow,
                  allowLaunch: false,
                  observationalOnly: true,
                  operation,
                }
              ),
            onReclaimFocusFn: () => focusScope?.enforceObservation?.(),
            onAfterReadBackFn: () => focusScope?.exitObservationPhase?.(),
          });
          if (verifiedOut.verified) {
            this.state.headlessStats.verifiedMutations += 1;
          }
          result = verifiedOut.result;
        } else {
          attachDeliveryReceipt(result, {
            delivery: dispatched.directDeliveryVerified ? "delivered_verified" : "delivered_unverified",
            route: dispatched.actionRouteKey,
            executedRoute: dispatched.actionRouteKey,
            ...(dispatched.requestedRoute ? { requestedRoute: dispatched.requestedRoute } : {}),
          });
          if (this.sseClients.size > 0 && shouldFollow) {
            if (dispatched.directDeliveryVerified) {
              this.state.headlessStats.verifiedMutations += 1;
            }
            void this.#captureStreamFrameOnce();
          }
        }
        this.webAdapter.broadcastState();
      }

      this.webAdapter.ensureStreamLoop();
      return result;
    } catch (err) {
      if (LOCKED_SESSION_POSIX_RE.test(String(err?.message || ""))) {
        this.#screenLockedBackoff = true;
        return {
          isError: true,
          content: [{ type: "text", text: LOCKED_SESSION_MESSAGE }],
        };
      }
      throw err;
    } finally {
      if (!focusFinalized && touchedTargetOs && app && focusScope) {
        try {
          const stolen = await focusScope.enforce(lastRouteKey, { routeScope });
          focusScope.finish(lastRouteKey, { alreadyRecorded: Boolean(stolen), routeScope });
          focusFinalized = true;
        } catch {}
      }
      if (isAiSource) {
        this.state.aiStatus = "idle";
        this.webAdapter.broadcastState();
      }
    }
  }

  async #tryCaptureHelperWindowJpeg({
    app,
    pid,
    windowId,
    t0 = Date.now(),
    refreshGeometry = false,
    broadcast = false,
    requireActiveUnchanged = false,
  }) {
    const helperDiag = this.desktopHelperClient?.getDiagnostics?.() || null;
    if (
      !(windowId > 0) ||
      !(pid > 0) ||
      !helperDiag?.available ||
      !helperDiag.capabilities?.screenRecordingPreflight
    ) {
      return false;
    }
    const metaCached = this.registry.getMeta(app);
    const cap = await this.desktopHelperClient
      .captureWindowJpeg({
        pid,
        processToken: metaCached?.processToken || null,
        windowId,
      })
      .catch(() => null);
    if (!cap?.data) return false;
    if (cap.windowId > 0 && Number(cap.windowId) !== windowId) return false;
    if (
      requireActiveUnchanged &&
      (this.state.activeApp !== app || this.state.pinnedWindowId !== windowId)
    ) {
      return false;
    }
    if (cap.width) this.state.frameWidth = cap.width;
    if (cap.height) this.state.frameHeight = cap.height;
    if (cap.title && cap.title !== this.state.windowTitle) {
      this.state.windowTitle = cap.title;
    }
    if (refreshGeometry) {
      await this.#refreshActivePreviewGeometry({
        app,
        windows: cap.boundsPt
          ? [
              {
                pid,
                windowId,
                layer: 0,
                title: cap.title || this.state.windowTitle || "",
                alpha: 1,
                onScreen: true,
                boundsPt: cap.boundsPt,
              },
            ]
          : null,
        allowHelperQuery: !cap.boundsPt,
        selectAsActive: true,
      }).catch(() => {});
    }
    this.previewStreamManager.setTargetStreamPaused(this.state.targetKey, false, null);
    this.state.streamPaused = false;
    this.state.streamPausedReason = null;
    this.webAdapter.updateFrameFromImageItem(
      { type: "image", mimeType: cap.mimeType || "image/jpeg", data: cap.data },
      Math.max(0, Date.now() - t0),
      {
        frameMeta: {
          targetKey: this.state.targetKey,
          geometryRev: this.state.geometryRev,
          windowId,
        },
      }
    );
    if (broadcast) {
      this.webAdapter.broadcastState();
    }
    return true;
  }

  /**
   * Capture a single screenshot-only frame on the dedicated `streamPeer`
   * so `actionPeer`'s AX element indexes are NEVER invalidated.
   */
  async #captureStreamFrameOnce() {
    if (this.streamInFlight || !this.state.activeApp) return;
    this.streamInFlight = true;
    try {
      const targetApp = this.state.activeApp;
      if (!(this.state.pid && isProcessAlive(this.state.pid))) {
        const listRes = await this.streamPeer.callTool("list_apps", {}, 4_000);
        const parsed = parseAppsList(extractResultText(listRes));
        const runningMatch =
          findRunningApp(parsed, targetApp) ||
          (this.state.appDisplayName ? findRunningApp(parsed, this.state.appDisplayName) : null);
        if (!runningMatch) {
          if (this.state.activeApp === targetApp) {
            this.#detachExitedActiveApp(parsed.filter((a) => a.isRunning));
          }
          return;
        }
        this.state.runningApps = parsed.filter((a) => a.isRunning);
      }

      const t0 = Date.now();
      const pinnedWid = this.state.pinnedWindowId;
      if (pinnedWid > 0) {
        const helperCaptured = await this.#tryCaptureHelperWindowJpeg({
          app: targetApp,
          pid: this.state.pid,
          windowId: pinnedWid,
          t0,
          refreshGeometry: true,
          broadcast: true,
          requireActiveUnchanged: true,
        });
        if (helperCaptured) {
          return;
        }
        // Pinned windows MUST NOT fall back to app-scoped OCU screenshots (wrong window provenance).
        if (this.previewStreamManager.needsJpegPolling(this.state.targetKey)) {
          await this.#refreshActivePreviewGeometry({
            app: targetApp,
            allowHelperQuery: Boolean(this.desktopHelperClient?.available),
            selectAsActive: true,
          }).catch(() => {});
          const lastHist = this.webAdapter.frameHistory[this.webAdapter.frameHistory.length - 1] || null;
          if (!lastHist || Number(lastHist.windowId) !== pinnedWid) {
            this.webAdapter.latestFrameBytes = null;
          }
          this.previewStreamManager.setTargetStreamPaused(
            this.state.targetKey,
            true,
            "pinned_window_capture_unavailable"
          );
          this.state.streamPaused = true;
          this.state.streamPausedReason = "pinned_window_capture_unavailable";
          this.webAdapter.broadcastState();
        }
        return;
      }

      let res = await this.streamPeer.callTool(
        "get_app_state",
        {
          app: targetApp,
          include_ax: false,
          include_screenshot: true,
          window_placement: "keep",
        },
        8_000
      );
      this.#screenLockedBackoff = false;
      this.#ocuObservationStats.checkedAt = Date.now();
      this.#ocuObservationStats.streamOk = !res?.isError;
      if (!res?.isError && this.state.activeApp === targetApp) {
        const upgraded = await this.#upgradeTinyFloatingWindowResult(res, this.state.pid);
        res = upgraded.result;
        const dt = Date.now() - t0;
        const meta = parseSnapshotMetadata(extractResultText(res));
        if (upgraded.override?.windowTitle) {
          meta.windowTitle = upgraded.override.windowTitle;
        }
        if (meta.pid) this.state.pid = meta.pid;
        if (meta.bundleId) this.state.bundleId = meta.bundleId;
        if (meta.windowTitle && meta.windowTitle !== this.state.windowTitle) {
          this.state.windowTitle = meta.windowTitle;
          this.state.appDisplayName = meta.appDisplayName || this.state.appDisplayName;
          this.webAdapter.broadcastState();
        }
        const img = extractResultImage(res);
        if (img) {
          const dims = img.data ? parseImageDimensions(Buffer.from(img.data, "base64")) : null;
          if (dims) {
            this.state.frameWidth = dims.width;
            this.state.frameHeight = dims.height;
          }
          await this.#refreshAndPublishPreviewFrame({
            app: targetApp,
            pid: this.state.pid,
            img,
            latencyMs: dt,
            provenWid: Number(upgraded.override?.wid || meta.windowId || 0) || null,
            forceCheckMultiWindow: true,
          }).catch(() => {});
        }
      }
    } catch (err) {
      this.#screenLockedBackoff = LOCKED_SESSION_POSIX_RE.test(String(err?.message || ""));
    } finally {
      this.streamInFlight = false;
    }
  }

  /**
   * Refresh preview geometry once with multi-window ambiguity evaluated up front,
   * then publish the captured frame with matching metadata.
   */
  async #refreshAndPublishPreviewFrame({
    app,
    pid = 0,
    img,
    latencyMs = 0,
    provenWid = null,
    minWinCount = 0,
    forceCheckMultiWindow = true,
  }) {
    let ambiguousEvaluated = false;
    let multiWindowAmbiguous = false;
    await this.#refreshActivePreviewGeometry({
      app,
      pid,
      allowHelperQuery: Boolean(this.desktopHelperClient?.available),
      selectAsActive: true,
      resolveReadOnlyOverride: ({ selectedWid, helperWinCount: liveHelperWinCount }) => {
        ambiguousEvaluated = true;
        const helperWinCount = Math.max(Number(minWinCount || 0), liveHelperWinCount);
        multiWindowAmbiguous = Boolean(
          forceCheckMultiWindow &&
            helperWinCount > 1 &&
            (!provenWid || (selectedWid > 0 && provenWid !== selectedWid))
        );
        return multiWindowAmbiguous
          ? {
              readOnlyOverride: true,
              readOnlyReasonOverride: "ambiguous_multi_window_stream",
            }
          : null;
      },
    }).catch(() => {});
    if (!ambiguousEvaluated && forceCheckMultiWindow) {
      const helperWinCount = Math.max(
        Number(minWinCount || 0),
        this.previewStreamManager.availableWindows.length
      );
      const fallbackWid = Number(this.state.windowId || 0);
      multiWindowAmbiguous = Boolean(
        helperWinCount > 1 &&
          (!provenWid || (fallbackWid > 0 && provenWid !== fallbackWid))
      );
    }
    this.webAdapter.updateFrameFromImageItem(img, latencyMs, {
      frameMeta: {
        targetKey: this.state.targetKey,
        geometryRev: this.state.geometryRev,
        windowId: multiWindowAmbiguous ? provenWid : provenWid || this.state.windowId || null,
        ambiguous: multiWindowAmbiguous,
      },
    });
  }

  async #handleGetWindows() {
    if (this.state.activeApp && this.desktopHelperClient?.available) {
      await this.#refreshActivePreviewGeometry({
        app: this.state.activeApp,
        allowHelperQuery: true,
        selectAsActive: true,
      }).catch(() => {});
    }
    return {
      ok: true,
      windows: this.previewStreamManager.availableWindows,
      pinnedWindowId: this.state.pinnedWindowId,
      targetKey: this.state.targetKey,
    };
  }

  async #handleVideoSubscribe(data = {}) {
    if (this.state.activeApp && !this.previewStreamManager.getActiveGeometry()) {
      await this.#refreshActivePreviewGeometry({
        app: this.state.activeApp,
        allowHelperQuery: true,
        selectAsActive: true,
      }).catch(() => {});
    }
    return this.previewStreamManager.subscribe({
      viewId: data.viewId,
      targetKey: data.targetKey || this.state.targetKey,
      supportsWebCodecs: data.supportsWebCodecs !== false,
      webCodecsReason: data.webCodecsReason || null,
    });
  }

  async #handleVideoControl(data = {}) {
    return this.previewStreamManager.handleControl(data);
  }

  async #handleSelectApp(target, data = {}) {
    if (typeof data.followAi === "boolean") {
      this.state.followAi = data.followAi;
    }
    const reqWid = Number(data.windowId) > 0 ? Number(data.windowId) : null;
    const prevPinned = this.state.pinnedWindowId;
    if (reqWid !== null) {
      this.state.pinnedWindowId = reqWid;
    } else if (!this.#isSameActiveApp(target) || data.windowId === null || data.windowId === "") {
      this.state.pinnedWindowId = null;
    }

    const focusScope = await this.focusPolicyGuard.beginGuard(target);
    const selRes = await this.#safeGetAppState(
      this.actionPeer,
      {
        app: target,
        include_ax: true,
        include_screenshot: !(reqWid > 0),
        max_tree_nodes: 400,
      },
      { updateActiveApp: true, allowLaunch: true, preservePinnedWindow: true }
    );
    const stolen = await focusScope.enforce("select_app");
    focusScope.finish("select_app", { alreadyRecorded: stolen });
    if (selRes?.isError) {
      return {
        ok: false,
        error: extractResultText(selRes) || "该应用当前没有可捕获的窗口",
        state: this.webAdapter.publicState(),
      };
    }

    const geomRes = await this.#refreshActivePreviewGeometry({
      app: target,
      allowHelperQuery: true,
      selectAsActive: true,
    });
    if (reqWid && geomRes.notFound) {
      this.state.pinnedWindowId = prevPinned;
      await this.#refreshActivePreviewGeometry({
        app: target,
        allowHelperQuery: true,
        selectAsActive: true,
      }).catch(() => {});
      this.#syncPreviewStateFields();
      return {
        ok: false,
        statusCode: 404,
        error: `指定的目标窗口 (${reqWid}) 不存在或已关闭`,
        state: this.webAdapter.publicState(),
      };
    }

    await this.#tryCaptureHelperWindowJpeg({
      app: target,
      pid: this.state.pid,
      windowId: reqWid,
      refreshGeometry: false,
      broadcast: false,
    });

    this.state.lastActivityAt = Date.now();
    this.webAdapter.broadcastState();
    this.webAdapter.ensureStreamLoop();
    return this.webAdapter.publicState();
  }

  async #handleBringToFront(target) {
    const targetMeta = target ? this.registry.getMeta(target) : null;
    const targetPid =
      target && this.#isSameActiveApp(target)
        ? this.state.pid || targetMeta?.pid
        : targetMeta?.pid;
    this.takeoverController.requestPause({
      reason: "ui_bring_to_front",
      source: "ui",
      rule: "ui_bring_to_front",
      label: `置顶原窗口接管 · ${targetMeta?.appDisplayName || this.state.appDisplayName || target || "目标窗口"}`,
      targetApp: targetMeta?.bundleId || target || null,
      targetPid: targetPid || null,
      transfersFocusToTarget: true,
    });
    this.focusPolicyGuard.cancelForHumanTargetTakeover(targetPid || null);
    this.focusPolicyGuard.cancelForExplicitRaise();
    if (!target) return;
    await this.takeoverController.waitForDrain({ timeoutMs: this.bringToFrontDrainTimeoutMs });
    await bringAppToFrontExplicit(target, targetPid);
    this.webAdapter.pushActionEvent({
      type: "activate",
      label: `已置顶原窗口 · ${targetMeta?.appDisplayName || this.state.appDisplayName || target}`,
      source: "ui",
      targetApp: targetMeta?.bundleId || target,
    });
  }

  #preQueueValidateInteract(app, data = {}) {
    if (data.requireActiveMatch && this.state.activeApp && !this.#isSameActiveApp(app)) {
      return {
        ok: false,
        statusCode: 409,
        code: "STALE_VIEW",
        error: "Active app changed before interaction; ignored stale target",
      };
    }
    const needsGeometryCheck =
      Boolean(data.frameRef) ||
      data.kind === "click" ||
      (data.kind === "scroll" &&
        (Number.isFinite(Number(data.normX)) || Number.isFinite(Number(data.normY))));
    if (!needsGeometryCheck) {
      return { ok: true };
    }
    if (this.state.streamPaused) {
      return {
        ok: false,
        statusCode: 409,
        code: "STALE_VIEW",
        error: "当前窗口画面已暂停，请等待画面恢复后再操作",
      };
    }
    const curGeom = this.previewStreamManager.getActiveGeometry();
    if (data.frameRef) {
      return this.#validateInteractiveFrameRef(data.frameRef, curGeom);
    }
    if (this.state.pinnedWindowId > 0 || curGeom?.readOnly) {
      return {
        ok: false,
        statusCode: 409,
        code: curGeom?.readOnly ? "UNPROVEN_SAME_WINDOW" : "STALE_VIEW",
        error: curGeom?.readOnly
          ? "当前窗口处于只读保护状态（尚未证明同窗任意点派发能力）"
          : "显式指定窗口的交互必须携带当前 frameRef",
      };
    }
    return { ok: true };
  }

  #validateInteractiveFrameRef(frameRef, curGeom, liveWin = null) {
    const val = validateFrameRef(frameRef, curGeom, liveWin);
    if (!val.ok) {
      return {
        ok: false,
        statusCode: val.statusCode || 409,
        code: val.code,
        error: val.message,
      };
    }
    if (frameRef.transport === "h264") {
      const h264Val = this.previewStreamManager.validateH264FrameRef(frameRef);
      if (!h264Val.ok) {
        return {
          ok: false,
          statusCode: h264Val.statusCode || 409,
          code: h264Val.code,
          error: h264Val.message,
        };
      }
      return { ok: true };
    }
    if (frameRef.transport === "jpeg") {
      const histHit = this.webAdapter.frameHistory.find(
        (entry) => entry.seq === Number(frameRef.seq)
      );
      if (
        !histHit ||
        histHit.ambiguous === true ||
        (histHit.targetKey && histHit.targetKey !== curGeom.targetKey) ||
        (Number(histHit.geometryRev) > 0 && Number(histHit.geometryRev) !== Number(curGeom.geometryRev)) ||
        (curGeom.windowId > 0 && Number(histHit.windowId) > 0 && Number(histHit.windowId) !== curGeom.windowId) ||
        (this.state.pinnedWindowId > 0 && Number(histHit.windowId) !== this.state.pinnedWindowId)
      ) {
        return {
          ok: false,
          statusCode: 409,
          code: "STALE_VIEW",
          error: "该 JPEG 帧已被淘汰或窗口身份不匹配，请使用最新画面操作",
        };
      }
    }
    return { ok: true };
  }

  async #handleInteract(app, data = {}) {
    if (data.requireActiveMatch && this.state.activeApp && !this.#isSameActiveApp(app)) {
      const err = new Error("Active app changed before interaction; ignored stale target");
      err.statusCode = 409;
      throw err;
    }
    this.state.lastActivityAt = Date.now();

    const metaPre = this.registry.getMeta(app);
    const claim = buildUiInteractionPauseClaim(app, data);
    this.takeoverController.requestPause({
      reason: "ui_interact",
      source: "ui",
      rule: claim.rule,
      label: claim.label,
      intentId: typeof data.intentId === "string" ? data.intentId : null,
      targetApp: metaPre?.bundleId || app,
      targetPid: metaPre?.pid || (this.#isSameActiveApp(app) ? this.state.pid : null),
      transfersFocusToTarget: false,
    });

    const drained = await this.takeoverController.waitForDrain({
      timeoutMs: this.interactDrainTimeoutMs,
    });
    if (!drained || this.takeoverController.nativeWriteUnknownLock) {
      return {
        ok: false,
        error: "AI 在途原生输入尚未排空确认，已暂缓本次手动操作以防事件交错。",
        state: this.webAdapter.publicState(),
      };
    }

    const check = await this.#checkAppRunning(this.actionPeer, app);
    if (!check.running) {
      if (this.#isSameActiveApp(app)) {
        this.#detachExitedActiveApp(check.apps?.filter((a) => a.isRunning));
      }
      return {
        ok: false,
        error: "目标应用已退出",
        state: this.webAdapter.publicState(),
      };
    }

    // Post-drain, pre-dispatch same-window + frameRef + live window verification (zero writes on failure)
    const enforceGeom =
      Boolean(data.frameRef) ||
      this.state.pinnedWindowId > 0 ||
      Boolean(this.previewStreamManager.getActiveGeometry()?.readOnly);
    let validatedGeom = null;
    if (
      enforceGeom &&
      (data.kind === "click" ||
        (data.kind === "scroll" &&
          (data.frameRef || Number.isFinite(Number(data.normX)) || this.state.pinnedWindowId > 0)) ||
        data.frameRef)
    ) {
      if (this.state.streamPaused) {
        return {
          ok: false,
          statusCode: 409,
          code: "STALE_VIEW",
          error: "画面已暂停，操作未派发",
          state: this.webAdapter.publicState(),
        };
      }
      const curGeom = this.previewStreamManager.getActiveGeometry();
      let liveWin = null;
      if (this.desktopHelperClient?.available && curGeom?.pid > 0 && curGeom?.windowId > 0) {
        const wins = await this.desktopHelperClient.listWindows(curGeom.pid).catch(() => null);
        liveWin = Array.isArray(wins)
          ? wins.find((w) => Number(w.windowId) === curGeom.windowId) || null
          : null;
        if (!liveWin) {
          await this.#refreshActivePreviewGeometry({
            app,
            windows: Array.isArray(wins) ? wins : [],
            allowHelperQuery: false,
          }).catch(() => {});
          return {
            ok: false,
            statusCode: 409,
            code: "STALE_VIEW",
            error: "目标窗口已关闭或无法验证，旧画面操作已取消",
            state: this.webAdapter.publicState(),
          };
        }
        let freshProcToken = liveWin.processToken || null;
        if (!freshProcToken && typeof this.runningAppIdentityFn === "function") {
          const freshId = await this.runningAppIdentityFn(app, { axBridge: this.axBridge }).catch(
            () => null
          );
          if (freshId?.pid === curGeom.pid && freshId?.processToken) {
            freshProcToken = freshId.processToken;
          }
        }
        if (freshProcToken) {
          liveWin = { ...liveWin, processToken: freshProcToken };
        }
      }
      if (data.frameRef) {
        const val = this.#validateInteractiveFrameRef(data.frameRef, curGeom, liveWin);
        if (!val.ok) {
          await this.#refreshActivePreviewGeometry({ app, allowHelperQuery: false }).catch(() => {});
          return {
            ok: false,
            statusCode: val.statusCode || 409,
            code: val.code,
            error: val.error,
            state: this.webAdapter.publicState(),
          };
        }
        validatedGeom = curGeom;
      } else if (!curGeom || curGeom.readOnly || this.state.pinnedWindowId > 0) {
        return {
          ok: false,
          statusCode: 409,
          code: curGeom?.readOnly ? "UNPROVEN_SAME_WINDOW" : "STALE_VIEW",
          error: "当前窗口缺少同窗派发证明或帧引用，操作已拦截",
          state: this.webAdapter.publicState(),
        };
      }
    }

    const uiOp = this.takeoverController.admit({
      name: `ui:${data.kind || "interact"}`,
      isAi: false,
      isMutating: true,
    });
    const focusScope = await this.focusPolicyGuard.beginGuard(app);
    const uiCallOpts = {
      source: "ui",
      focusScopeOverride: focusScope,
      operation: uiOp,
    };
    let delegatedToToolCall = false;
    let interactTouchedOs = false;

    try {
      if (data.kind === "click") {
        const normX = Number(data.normX);
        const normY = Number(data.normY);
        if (
          !Number.isFinite(normX) ||
          !Number.isFinite(normY) ||
          normX < 0 ||
          normX > 1 ||
          normY < 0 ||
          normY > 1
        ) {
          return {
            ok: false,
            error: "Invalid click coordinates",
            state: this.webAdapter.publicState(),
          };
        }

        const activeGeom = validatedGeom || (!this.state.pinnedWindowId ? this.previewStreamManager.getActiveGeometry() : null);
        if (activeGeom?.windowBoundsPt && activeGeom?.previewContentRectPt && !activeGeom.readOnly) {
          const winPt = mapToWindowPoint({ normX, normY }, activeGeom);
          if (!winPt) {
            return {
              ok: false,
              statusCode: 409,
              code: "STALE_VIEW",
              error: "Unable to project click coordinates onto target window",
              state: this.webAdapter.publicState(),
            };
          }
          if (activeGeom.deliveryRoute === "window_post") {
            delegatedToToolCall = true;
            const callRes = await this.#executeToolCallUnlocked(
              "click",
              {
                app,
                x: Math.round(winPt.x),
                y: Math.round(winPt.y),
                mouse_button: data.button || "left",
                click_count: data.clickCount || 1,
              },
              {
                ...uiCallOpts,
                windowDelivery: {
                  route: "window_post",
                  pid: activeGeom.pid,
                  windowId: activeGeom.windowId,
                  windowBoundsPt: activeGeom.windowBoundsPt,
                  expectedWindowSize: {
                    width: activeGeom.windowBoundsPt.width,
                    height: activeGeom.windowBoundsPt.height,
                  },
                  localPoint: { x: winPt.x, y: winPt.y },
                  allowAppPostFallback: activeGeom.allowAppPostFallback,
                  normX,
                  normY,
                  targetKey: activeGeom.targetKey,
                },
              }
            );
            return {
              ok: !callRes?.isError,
              error: callRes?.isError ? extractResultText(callRes) : null,
              state: this.webAdapter.publicState(),
            };
          }
          if (activeGeom.deliveryRoute === "ocu_pixel") {
            let meta = this.registry.getMeta(app);
            let geomForPixel = activeGeom;
            if (!meta?.actionHasScreenshot || !geomForPixel.actionPixelSize) {
              interactTouchedOs = true;
              const prepRes = await this.#safeGetAppState(
                this.actionPeer,
                { app, include_ax: true, include_screenshot: true, max_tree_nodes: 120 },
                {
                  updateActiveApp: this.#isSameActiveApp(app) || !this.state.activeApp,
                  allowLaunch: false,
                  preservePinnedWindow: true,
                  operation: uiOp,
                }
              );
              await focusScope.enforce("interact_prep");
              if (prepRes?.isError) {
                return {
                  ok: false,
                  error: extractResultText(prepRes),
                  state: this.webAdapter.publicState(),
                };
              }
              meta = this.registry.getMeta(app);
              geomForPixel = this.previewStreamManager.getActiveGeometry();
              const boundsStillMatch = Boolean(
                !geomForPixel?.windowBoundsPt ||
                  !activeGeom.windowBoundsPt ||
                  rectsEqualPt(geomForPixel.windowBoundsPt, activeGeom.windowBoundsPt, 4)
              );
              if (
                !geomForPixel ||
                geomForPixel.readOnly ||
                geomForPixel.deliveryRoute !== "ocu_pixel" ||
                geomForPixel.windowId !== activeGeom.windowId ||
                (activeGeom.targetKey && geomForPixel.targetKey !== activeGeom.targetKey) ||
                !boundsStillMatch
              ) {
                return {
                  ok: false,
                  statusCode: 409,
                  code: "UNPROVEN_SAME_WINDOW",
                  reason: geomForPixel?.readOnlyReason || "unproven_same_window",
                  error: "OCU 动作截图与当前视频窗口几何不匹配或处于只读保护，已拦截点击",
                  state: this.webAdapter.publicState(),
                };
              }
            }
            const px = mapToActionPixel(winPt, geomForPixel);
            if (!px) {
              return {
                ok: false,
                statusCode: 409,
                code: "UNPROVEN_SAME_WINDOW",
                error: "OCU 动作截图与当前视频窗口几何不匹配，已拦截点击",
                state: this.webAdapter.publicState(),
              };
            }
            delegatedToToolCall = true;
            const callRes = await this.#executeToolCallUnlocked(
              "click",
              {
                app,
                x: px.x,
                y: px.y,
                click_method: "sky_click",
                mouse_button: data.button || "left",
                click_count: data.clickCount || 1,
              },
              {
                ...uiCallOpts,
                windowDelivery: {
                  route: "ocu_pixel",
                  localPoint: { x: winPt.x, y: winPt.y },
                  windowId: geomForPixel.windowId,
                  windowBoundsPt: geomForPixel.windowBoundsPt,
                  normX,
                  normY,
                  targetKey: geomForPixel.targetKey,
                },
              }
            );
            return {
              ok: !callRes?.isError,
              error: callRes?.isError ? extractResultText(callRes) : null,
              state: this.webAdapter.publicState(),
            };
          }
          return {
            ok: false,
            statusCode: 409,
            code: "UNPROVEN_SAME_WINDOW",
            error: "无法证明任意点点击落入同窗，已阻止操作",
            state: this.webAdapter.publicState(),
          };
        }

        // App-following compatibility fallback when no full PreviewGeometry exists (legacy callers without frameRef)
        let meta = this.registry.getMeta(app);
        const dimsOutOfSync =
          this.state.videoTransport === "jpeg" &&
          !this.state.pinnedWindowId &&
          this.#isSameActiveApp(app) &&
          this.state.frameWidth > 0 &&
          (meta?.actionFrameWidth !== this.state.frameWidth ||
            meta?.actionFrameHeight !== this.state.frameHeight);
        if (!meta?.actionHasScreenshot || !meta?.actionFrameWidth || dimsOutOfSync) {
          interactTouchedOs = true;
          const prepRes = await this.#safeGetAppState(
            this.actionPeer,
            { app, include_ax: true, include_screenshot: true, max_tree_nodes: 120 },
            {
              updateActiveApp: this.#isSameActiveApp(app) || !this.state.activeApp,
              allowLaunch: false,
              operation: uiOp,
            }
          );
          await focusScope.enforce("interact_prep");
          if (prepRes?.isError) {
            return {
              ok: false,
              error: extractResultText(prepRes),
              state: this.webAdapter.publicState(),
            };
          }
          meta = this.registry.getMeta(app);
        }
        const refWidth = meta?.actionFrameWidth || this.state.frameWidth || 1280;
        const refHeight = meta?.actionFrameHeight || this.state.frameHeight || 800;
        const x = Math.round(normX * refWidth);
        const y = Math.round(normY * refHeight);
        delegatedToToolCall = true;
        const callRes = await this.#executeToolCallUnlocked(
          "click",
          {
            app,
            x,
            y,
            mouse_button: data.button || "left",
            click_count: data.clickCount || 1,
          },
          uiCallOpts
        );
        return {
          ok: !callRes?.isError,
          error: callRes?.isError ? extractResultText(callRes) : null,
          state: this.webAdapter.publicState(),
        };
      }

      if (data.kind === "scroll") {
        const activeGeom = validatedGeom || (!this.state.pinnedWindowId ? this.previewStreamManager.getActiveGeometry() : null);
        const hasNorm = Number.isFinite(Number(data.normX)) && Number.isFinite(Number(data.normY));
        const scrollWinPt =
          hasNorm && activeGeom?.windowBoundsPt && activeGeom?.previewContentRectPt
            ? mapToWindowPoint({ normX: Number(data.normX), normY: Number(data.normY) }, activeGeom)
            : null;
        if (activeGeom?.deliveryRoute === "window_post" && (this.state.pinnedWindowId > 0 || scrollWinPt)) {
          delegatedToToolCall = true;
          const callRes = await this.#executeToolCallUnlocked(
            "scroll",
            {
              app,
              element_index: "0",
              direction: data.direction || "down",
              pages: Math.max(0.08, Math.min(3, Number(data.pages) || 0.35)),
            },
            {
              ...uiCallOpts,
              windowDelivery: {
                route: "window_post",
                pid: activeGeom.pid,
                windowId: activeGeom.windowId,
                windowBoundsPt: activeGeom.windowBoundsPt,
                localPoint: scrollWinPt ? { x: scrollWinPt.x, y: scrollWinPt.y } : null,
                allowAppPostFallback: activeGeom.allowAppPostFallback,
              },
            }
          );
          return {
            ok: !callRes?.isError,
            error: callRes?.isError ? extractResultText(callRes) : null,
            state: this.webAdapter.publicState(),
          };
        }

        const meta = this.registry.getMeta(app);
        if (!meta?.actionHasAx || !meta?.elements?.has("0")) {
          interactTouchedOs = true;
          const prepRes = await this.#safeGetAppState(
            this.actionPeer,
            { app, include_ax: true, include_screenshot: true, max_tree_nodes: 80 },
            { updateActiveApp: false, allowLaunch: false, operation: uiOp }
          );
          await focusScope.enforce("interact_prep");
          if (prepRes?.isError) {
            return { ok: false, error: extractResultText(prepRes) };
          }
        }
        delegatedToToolCall = true;
        const callRes = await this.#executeToolCallUnlocked(
          "scroll",
          {
            app,
            element_index: "0",
            direction: data.direction || "down",
            pages: Math.max(0.08, Math.min(3, Number(data.pages) || 0.35)),
          },
          uiCallOpts
        );
        return {
          ok: !callRes?.isError,
          error: callRes?.isError ? extractResultText(callRes) : null,
        };
      }

      if (data.kind === "type_text") {
        delegatedToToolCall = true;
        const callRes = await this.#executeToolCallUnlocked(
          "type_text",
          { app, text: String(data.text || "") },
          uiCallOpts
        );
        return {
          ok: !callRes?.isError,
          error: callRes?.isError ? extractResultText(callRes) : null,
        };
      }

      if (data.kind === "press_key") {
        delegatedToToolCall = true;
        const callRes = await this.#executeToolCallUnlocked(
          "press_key",
          { app, key: String(data.key || "") },
          uiCallOpts
        );
        return {
          ok: !callRes?.isError,
          error: callRes?.isError ? extractResultText(callRes) : null,
        };
      }

      throw new Error(`Unsupported interaction kind: ${data.kind}`);
    } finally {
      this.takeoverController.clearOperation(uiOp);
      if (!delegatedToToolCall && interactTouchedOs) {
        try {
          const stolen = await focusScope.enforce("interact_prep");
          focusScope.finish("interact_prep", { alreadyRecorded: Boolean(stolen) });
        } catch {}
      }
    }
  }

  async #processQueryResult(
    app,
    rawRes,
    { queryPid = null, queryToken = null, resolvedQueryApp = null, updateActiveSnapshot = true } = {}
  ) {
    let res = rawRes;
    let parsed = null;
    let merged = null;
    if (!res?.isError && Array.isArray(res?.content)) {
      try {
        parsed = JSON.parse(extractResultText(res));
        if (Array.isArray(parsed?.matches)) {
          let redactedAny = false;
          parsed.matches = parsed.matches.map((m) => {
            if (!m || typeof m !== "object") return m;
            if (!isSecureTextRole(m.role) && !isSecureTextRole(m.subrole)) return m;
            redactedAny = true;
            const safeMatch = { ...m };
            for (const [k, v] of Object.entries(safeMatch)) {
              if (
                k === "index" ||
                k === "role" ||
                k === "subrole" ||
                k === "identifier" ||
                k === "enabled" ||
                k === "focused" ||
                k === "bounds" ||
                k === "frame" ||
                k === "actions" ||
                k === "secondary_actions"
              ) {
                continue;
              }
              if (k === "value") {
                safeMatch[k] = "[redacted]";
              } else if (typeof v === "string") {
                safeMatch[k] = null;
              }
            }
            return safeMatch;
          });
          merged = await this.registry.ingestQueryMatches(app, parsed, {
            queryPid,
            queryToken,
            resolvedQueryApp,
          });
          const allNativeQueryAliases =
            parsed.matches.length === 0 ||
            parsed.matches.every((m) => Number(m?.index) >= 1_000_000);
          if (!allNativeQueryAliases) {
            this.registry.bindSnapshotHandles(merged);
          }
          if (merged.snapshotId) {
            parsed.snapshot_id = merged.snapshotId;
            if (merged.windowTitle && !parsed.window_title) {
              parsed.window_title = merged.windowTitle;
            }
            if (
              updateActiveSnapshot &&
              (this.#isSameActiveApp(merged.bundleId || app) || !this.state.activeApp)
            ) {
              this.state.activeSnapshotId = merged.snapshotId;
            }
          }
          if (merged.snapshotId || redactedAny) {
            const newContent = res.content.map((item) => ({ ...item }));
            const txtIdx = newContent.findIndex((c) => c?.type === "text");
            if (txtIdx >= 0) {
              newContent[txtIdx].text = JSON.stringify(parsed);
              res = { ...res, content: newContent };
            }
          }
          if (updateActiveSnapshot) {
            this.webAdapter.broadcastState();
          }
        }
      } catch {}
    }
    return { result: res, parsed, merged };
  }


  async getToolsList() {
    if (!this.cachedTools) {
      const raw = await this.actionPeer.listTools();
      const tools = Array.isArray(raw?.tools)
        ? raw.tools.map((tool) => {
            if (!tool || typeof tool.description !== "string") return tool;
            let desc = tool.description;
            if (
              (tool.name === "get_app_state" || tool.name === "list_apps") &&
              !desc.includes(SIDECAR_PILL_MARKDOWN)
            ) {
              desc = `${desc}${SIDECAR_TOOL_NOTE}`;
            }
            if (
              (tool.name === "get_app_state" || tool.name === "query") &&
              !desc.includes("@sN:index")
            ) {
              desc = `${desc}${SIDECAR_REF_TOOL_NOTE}`;
            }

            let nextSchema = tool.inputSchema;
            if (
              tool.name === "click" &&
              Array.isArray(tool.inputSchema?.properties?.click_method?.enum) &&
              !tool.inputSchema.properties.click_method.enum.includes("window_post")
            ) {
              const cm = tool.inputSchema.properties.click_method;
              nextSchema = {
                ...tool.inputSchema,
                properties: {
                  ...tool.inputSchema.properties,
                  click_method: {
                    ...cm,
                    enum: [...cm.enum, "window_post"],
                  },
                },
              };
            } else if (
              (tool.name === "press_key" || tool.name === "type_text") &&
              Array.isArray(tool.inputSchema?.properties?.key_method?.enum) &&
              !tool.inputSchema.properties.key_method.enum.includes("window_key")
            ) {
              const km = tool.inputSchema.properties.key_method;
              nextSchema = {
                ...tool.inputSchema,
                properties: {
                  ...tool.inputSchema.properties,
                  key_method: {
                    ...km,
                    enum: [...km.enum, "window_key"],
                  },
                },
              };
            }

            if (desc === tool.description && nextSchema === tool.inputSchema) return tool;
            return {
              ...tool,
              description: desc,
              ...(nextSchema !== tool.inputSchema ? { inputSchema: nextSchema } : {}),
            };
          })
        : [];
      if (!tools.some((t) => t?.name === "act")) {
        tools.push({
          name: "act",
          description:
            "Atomically locate a UI target (with optional background reveal scrolling), deduplicate nested matches, click its interactive control/card once in the background, and verify an explicit semantic postcondition (`expect`).",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["app", "target", "expect"],
            properties: {
              app: { type: "string", description: "Target application name or bundle ID." },
              window_id: { type: "number", description: "Optional explicit CGWindowNumber to pin." },
              target: {
                type: "object",
                additionalProperties: false,
                properties: {
                  text: { type: "string" },
                  role: { type: "string" },
                  exact: { type: "boolean" },
                },
              },
              click_count: { type: "integer", minimum: 1, maximum: 3 },
              mouse_button: { type: "string", enum: ["left", "right", "middle"] },
              reveal: {
                type: "object",
                additionalProperties: false,
                properties: {
                  direction: { type: "string", enum: ["down", "up", "left", "right"] },
                  max_scroll_steps: { type: "integer", minimum: 0, maximum: 10 },
                  pages_per_step: { type: "number", minimum: 0.15, maximum: 1.5 },
                },
              },
              expect: {
                type: "object",
                additionalProperties: false,
                properties: {
                  any_text: { type: "array", items: { type: "string" } },
                  all_text: { type: "array", items: { type: "string" } },
                  text_disappears: { type: "array", items: { type: "string" } },
                  window_title_contains: { type: "string" },
                },
              },
              timeout_ms: { type: "integer", minimum: 40, maximum: 25000 },
            },
          },
        });
      }
      this.cachedTools = { ...(raw || {}), tools };
    }
    return this.cachedTools;
  }

  #handleSocketConnection(conn) {
    this.socketClients.add(conn);
    const connAbort = new AbortController();
    const connCtx = {
      sessionId: `conn-${this.#nextConnSeq++}`,
      connAbort,
      inFlightRequests: new Map(),
      cancelledRequestIds: new Set(),
    };
    const cleanupConn = (reason) => {
      if (!connAbort.signal.aborted) connAbort.abort(new Error(reason));
      for (const ctrl of connCtx.inFlightRequests.values()) {
        if (!ctrl.signal.aborted) ctrl.abort(new Error(reason));
      }
      connCtx.inFlightRequests.clear();
      void this.replManager?.closeSession?.(connCtx.sessionId)?.catch?.(() => {});
      this.socketClients.delete(conn);
    };
    conn.setEncoding("utf8");
    let buf = "";

    conn.on("error", () => {
      cleanupConn("socket_error");
      conn.destroy();
    });

    conn.on("close", () => {
      cleanupConn("socket_closed");
    });

    conn.on("data", (chunk) => {
      buf += chunk;
      if (Buffer.byteLength(buf, "utf8") > MAX_LINE_BUFFER_BYTES) {
        conn.destroy();
        return;
      }
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        void this.#dispatchBrokerRpc(conn, line, connCtx);
      }
    });
  }

  async #dispatchBrokerRpc(conn, rawLine, connCtx) {
    let msg;
    try {
      msg = JSON.parse(rawLine);
    } catch {
      if (!conn.destroyed && conn.writable) {
        try {
          conn.write(
            `${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })}\n`
          );
        } catch {
          conn.destroy();
        }
      }
      return;
    }
    if (!msg || typeof msg !== "object" || Array.isArray(msg) || typeof msg.method !== "string") {
      const errId =
        msg && typeof msg === "object" && !Array.isArray(msg) && msg.id !== undefined ? msg.id : null;
      if (!conn.destroyed && conn.writable) {
        try {
          conn.write(
            `${JSON.stringify({ jsonrpc: "2.0", id: errId, error: { code: -32600, message: "Invalid Request" } })}\n`
          );
        } catch {
          conn.destroy();
        }
      }
      return;
    }
    const { id, method } = msg;
    const params = msg.params && typeof msg.params === "object" && !Array.isArray(msg.params) ? msg.params : {};
    const reply = (payload) => {
      if (id === undefined) return;
      if (!conn.destroyed && conn.writable) {
        try {
          conn.write(`${JSON.stringify({ jsonrpc: "2.0", id, ...payload })}\n`);
        } catch {
          conn.destroy();
        }
      }
    };

    if (method === "rpc/cancel") {
      const targetReqId = params?.requestId;
      if (targetReqId !== undefined && targetReqId !== null) {
        const key = String(targetReqId);
        const targetCtrl = connCtx.inFlightRequests.get(key);
        if (targetCtrl) {
          if (!targetCtrl.signal.aborted) {
            targetCtrl.abort(new Error("rpc/cancel"));
          }
        } else {
          if (connCtx.cancelledRequestIds.size >= 256) connCtx.cancelledRequestIds.clear();
          connCtx.cancelledRequestIds.add(key);
        }
      }
      if (id !== undefined) {
        reply({ result: { ok: true } });
      }
      return;
    }

    if (id === undefined) {
      return;
    }

    const reqAbort = new AbortController();
    const reqKey = String(id);
    const onConnAbort = () => {
      if (!reqAbort.signal.aborted) {
        reqAbort.abort(connCtx.connAbort.signal.reason || new Error("socket_closed"));
      }
    };
    if (connCtx.connAbort.signal.aborted) {
      reqAbort.abort(connCtx.connAbort.signal.reason || new Error("socket_closed"));
    } else if (connCtx.cancelledRequestIds.delete(reqKey)) {
      reqAbort.abort(new Error("rpc/cancel"));
    } else {
      connCtx.connAbort.signal.addEventListener("abort", onConnAbort, { once: true });
    }
    connCtx.inFlightRequests.set(reqKey, reqAbort);

    try {
      if (method === "ping") {
        reply({ result: { ok: true, pid: process.pid, brokerBootId: this.brokerBootId } });
        return;
      }
      if (method === "tools/list") {
        const result = await this.getToolsList();
        reply({ result });
        return;
      }
      if (method === "tools/call") {
        const rpcSource = params?.source === "ai-repl" ? "ai-repl" : "ai";
        const result = await this.executeToolCall(params?.name, params?.arguments || {}, {
          source: rpcSource,
          signal: reqAbort.signal,
        });
        if (!reqAbort.signal.aborted) {
          reply({ result });
        }
        return;
      }
      if (method === "state/get") {
        reply({ result: this.webAdapter.publicState() });
        return;
      }
      if (method === "repl/tools") {
        reply({ result: this.replManager.getToolDefinitions() });
        return;
      }
      if (method === "repl/run") {
        const result = await this.replManager.run(connCtx.sessionId, params || {}, {
          signal: reqAbort.signal,
        });
        if (!reqAbort.signal.aborted) {
          reply({ result });
        }
        return;
      }
      if (method === "repl/reset") {
        const result = await this.replManager.reset(connCtx.sessionId);
        if (!reqAbort.signal.aborted) {
          reply({ result });
        }
        return;
      }
      reply({ error: { code: -32601, message: `Unknown broker method: ${method}` } });
    } catch (err) {
      if (!reqAbort.signal.aborted) {
        reply({
          error: {
            code: -32000,
            message: err instanceof Error ? err.message : String(err),
          },
        });
      }
    } finally {
      connCtx.inFlightRequests.delete(reqKey);
      connCtx.connAbort.signal.removeEventListener("abort", onConnAbort);
    }
  }

  async #probeLiveSocket(socketPath) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (alive) => {
        if (settled) return;
        settled = true;
        try {
          probe.destroy();
        } catch {}
        resolve(alive);
      };
      const probe = net.createConnection(socketPath);
      const timer = setTimeout(() => finish(false), 350);
      timer.unref?.();
      probe.once("connect", () => {
        clearTimeout(timer);
        finish(true);
      });
      probe.once("error", () => {
        clearTimeout(timer);
        finish(false);
      });
    });
  }

  async start() {
    mkdirSync(path.dirname(this.socketPath), { recursive: true, mode: 0o700 });
    if (existsSync(this.socketPath)) {
      const liveOwner = await this.#probeLiveSocket(this.socketPath);
      if (liveOwner) {
        throw new Error(`Another ComputerUseBrokerServer is already listening on ${this.socketPath}`);
      }
      try {
        rmSync(this.socketPath, { force: true });
      } catch {}
    }

    this.socketServer = net.createServer((conn) => this.#handleSocketConnection(conn));
    await new Promise((resolve, reject) => {
      this.socketServer.once("error", reject);
      this.socketServer.listen(this.socketPath, () => {
        this.#ownsBoundSocket = true;
        try {
          chmodSync(this.socketPath, 0o600);
          this.#boundSocketInode = statSync(this.socketPath).ino;
        } catch {}
        resolve();
      });
    });

    await this.webAdapter.start();
    if (this.desktopHelperClient && typeof this.desktopHelperClient.start === "function") {
      void this.desktopHelperClient
        .start()
        .then(() => {
          this.#syncTrustedAutomationPids();
        })
        .catch(() => {});
    }

    if (this.infoPath) {
      try {
        mkdirSync(path.dirname(this.infoPath), { recursive: true, mode: 0o700 });
        writeFileSync(
          this.infoPath,
          JSON.stringify(
            {
              pid: process.pid,
              brokerBootId: this.brokerBootId,
              webPort: this.webPort,
              socketPath: this.socketPath,
              startedAt: new Date().toISOString(),
            },
            null,
            2
          ),
          { mode: 0o600 }
        );
      } catch {}
    }

    console.log(
      `[computer-use-preview] broker listening on http://${BIND_HOST}:${this.webPort} and ${this.socketPath}`
    );
    return { webPort: this.webPort, socketPath: this.socketPath };
  }

  async close() {
    this.focusPolicyGuard.close();
    if (this.previewStreamManager && typeof this.previewStreamManager.closeAll === "function") {
      await this.previewStreamManager.closeAll().catch(() => {});
    }
    if (this.replManager && typeof this.replManager.closeAll === "function") {
      await this.replManager.closeAll().catch(() => {});
    }
    if (this.desktopHelperClient && typeof this.desktopHelperClient.close === "function") {
      await this.desktopHelperClient.close().catch(() => {});
    }
    await this.webAdapter.close();

    for (const sock of this.socketClients) {
      try {
        sock.destroy();
      } catch {}
    }
    this.socketClients.clear();

    await this.registry.flushPendingBinds().catch(() => null);

    this.actionPeer.close();
    this.streamPeer.close();
    if (this.axBridge && typeof this.axBridge.close === "function") {
      await this.axBridge.close().catch(() => {});
    }

    if (this.socketServer) {
      await new Promise((resolve) => this.socketServer.close(() => resolve()));
      this.socketServer = null;
    }
    if (this.#ownsBoundSocket) {
      try {
        if (existsSync(this.socketPath)) {
          const currentIno = statSync(this.socketPath).ino;
          if (!this.#boundSocketInode || currentIno === this.#boundSocketInode) {
            rmSync(this.socketPath, { force: true });
          }
        }
      } catch {}
      this.#ownsBoundSocket = false;
      this.#boundSocketInode = null;
    }
  }
}

if (isMainModule(import.meta.url)) {
  const server = new ComputerUseBrokerServer();
  server.start().catch((err) => {
    console.error("[computer-use-preview] fatal startup error:", err);
    process.exit(1);
  });

  const shutdown = () => {
    server.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
