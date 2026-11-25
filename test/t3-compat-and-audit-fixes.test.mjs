import assert from "node:assert/strict";
import crypto from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

import {
  BackgroundActionExecutor,
  authorizeActionScreenshotCoords,
  dedupeSpatiallyOverlappingMatches,
} from "../src/action-executor.mjs";
import { AtomicActExecutor } from "../src/act-executor.mjs";
import { AppSnapshotRegistry, normalizeElementBounds } from "../src/app-snapshot-registry.mjs";
import { BRIDGE_JXA_SOURCE } from "../src/ax-bridge.mjs";
import { pickPromotableMainWindow } from "../src/background-policy.mjs";
import { BrokerRpcClient } from "../src/broker-client.mjs";
import { ComputerUseBrokerServer } from "../src/broker-sidecar.mjs";
import {
  PREVIEW_VIDEO_JS_PATH,
  PROJECT_ROOT,
  SIDECAR_PILL_MARKDOWN,
  UI_HTML_PATH,
  VIDEO_WS_SUBPROTOCOL,
  buildT3OneTimePillHint,
  detectMcpHost,
  formatT3LiveViewUrl,
  resolveSafeSystemTmpDir,
  sanitizeHostEnv,
} from "../src/constants.mjs";
import { FocusPolicyGuard } from "../src/focus-policy-guard.mjs";
import { getStaticFallbackTools } from "../src/mcp-server.mjs";
import { PreviewStreamManager } from "../src/preview-stream.mjs";
import { SidecarWebAdapter } from "../src/sidecar-web-adapter.mjs";
import { TakeoverController } from "../src/takeover-controller.mjs";
import { VideoWebSocketHub } from "../src/video-websocket.mjs";
import {
  discoverT3AntigravityConfigDirs,
  installCodexComputerUse,
  resolveStableNodePath,
  uninstallCodexComputerUse,
} from "../scripts/installer-lib.mjs";

function makeShortTmpDir(prefix = "cua-t3-") {
  return mkdtempSync(path.join("/tmp", prefix));
}

function createFakePeer(toolHandler = async () => ({ isError: false, content: [{ type: "text", text: "ok" }] })) {
  return {
    agentInstanceId: "fake-peer-1",
    child: { pid: process.pid },
    async ensureStarted() {},
    async callTool(name, args, timeoutMs, opts) {
      opts?.beforeWriteCheck?.();
      return toolHandler(name, args, timeoutMs, opts);
    },
    async listTools() {
      return {
        tools: [
          { name: "list_apps", description: "List apps", inputSchema: { type: "object", properties: {} } },
          { name: "get_app_state", description: "Get state", inputSchema: { type: "object", properties: {} } },
          { name: "query", description: "Query AX", inputSchema: { type: "object", properties: {} } },
        ],
      };
    },
    close() {},
  };
}

test("T2 & T7 & T1 static fallback: safe short TMPDIR, sanitized host env, host detection, and 12-tool static schema", () => {
  const pollutedEnv = {
    PATH: process.env.PATH,
    TMPDIR: "/Users/example/.t3/userdata/antigravity-tmp/ac0a3dfd6dddb20962cecff6ee5fe65e/run-123456",
    ELECTRON_RUN_AS_NODE: "1",
    GEMINI_HOME: "/Users/example/.t3/userdata/providers/antigravity/hash/config",
    AGY_ACP_FORCE_FILE_STORAGE: "true",
    AGY_ACP_SESSION_ID: "sess-1",
    AGY_CLI_MODE: "acp",
    KEEP_ME: "yes",
  };

  const safeTmp = resolveSafeSystemTmpDir(pollutedEnv);
  assert.equal(safeTmp.includes("/.t3/"), false);
  const fullSock = path.join(safeTmp, "open-computer-use-agent-0123456789abcdef.sock");
  assert.ok(
    Buffer.byteLength(fullSock, "utf8") < 104,
    `Expected socket path < 104 bytes, got ${Buffer.byteLength(fullSock, "utf8")}: ${fullSock}`
  );

  const cleanEnv = sanitizeHostEnv(pollutedEnv);
  assert.equal(cleanEnv.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(cleanEnv.GEMINI_HOME, undefined);
  assert.equal(cleanEnv.AGY_ACP_FORCE_FILE_STORAGE, undefined);
  assert.equal(cleanEnv.AGY_ACP_SESSION_ID, undefined);
  assert.equal(cleanEnv.AGY_CLI_MODE, undefined);
  assert.equal(cleanEnv.KEEP_ME, "yes");
  assert.equal(cleanEnv.TMPDIR, safeTmp);

  assert.equal(detectMcpHost({ AGY_CUA_HOST: "t3" }), "t3");
  assert.equal(detectMcpHost({ AGY_CUA_HOST: "antigravity" }), "antigravity");
  assert.equal(detectMcpHost({}, { name: "t3-code-desktop" }), "t3");
  assert.equal(
    detectMcpHost({ GEMINI_HOME: "/Users/x/.t3/userdata/providers/antigravity/1/config" }),
    "t3"
  );
  assert.equal(detectMcpHost({ T3CODE_THREAD_ID: "mcp:thread-1" }), "t3");

  const url = formatT3LiveViewUrl(54321, "tok_abc");
  assert.equal(url, "http://127.0.0.1:54321/?token=tok_abc");
  assert.ok(buildT3OneTimePillHint(54321, "tok_abc").includes(url));

  const t3Tools = getStaticFallbackTools({ host: "t3" });
  const agyTools = getStaticFallbackTools({ host: "antigravity" });
  assert.equal(t3Tools.length, 12);
  assert.equal(t3Tools.some((t) => t.description.includes("sidecar://")), false);
  assert.equal(agyTools.some((t) => t.description.includes(SIDECAR_PILL_MARKDOWN)), true);
});

test("T1 & T3 & T7: BrokerRpcClient single-flight autoSpawn with lockfile, sidecar/info RPC, and start() failure cleanup", async () => {
  const dir = makeShortTmpDir("cua-t1-");
  const sockPath = path.join(dir, "broker.sock");
  const lockPath = path.join(dir, "spawn.lock");
  let spawnedBroker = null;
  let spawnCalls = 0;

  try {
    // T3: start() failure on uncreatable/overlong socket path must close cleanly without leaking
    const overlongSock = path.join(dir, "x".repeat(140) + ".sock");
    const brokenServer = new ComputerUseBrokerServer({
      webPort: 0,
      socketPath: overlongSock,
      infoPath: null,
      actionPeer: createFakePeer(),
      streamPeer: createFakePeer(),
      axBridge: { enabled: false, setSyntheticEventTag() {}, close: async () => {} },
      desktopHelperClient: null,
      launchHelperOnStart: false,
    });
    await assert.rejects(() => brokenServer.start());
    assert.equal(brokenServer.socketServer, null);

    // T1: 4 concurrent clients share lockfile so spawnFn fires ONCE and all 4 succeed
    const spawnFn = () => {
      spawnCalls += 1;
      spawnedBroker = new ComputerUseBrokerServer({
        webPort: 0,
        uiToken: "t3-secret-token",
        socketPath: sockPath,
        infoPath: null,
        actionPeer: createFakePeer(),
        streamPeer: createFakePeer(),
        axBridge: { enabled: false, setSyntheticEventTag() {}, close: async () => {} },
        desktopHelperClient: null,
        launchHelperOnStart: false,
      });
      void spawnedBroker.start();
      return { on() {}, unref() {} };
    };

    const clients = Array.from({ length: 4 }, () =>
      new BrokerRpcClient({
        socketPath: sockPath,
        autoSpawn: true,
        lockPath,
        spawnFn,
      })
    );

    const pings = await Promise.all(clients.map((c) => c.request("ping", {})));
    assert.equal(spawnCalls, 1, "Lockfile must prevent duplicate daemon spawns across concurrent MCP clients");
    for (const p of pings) {
      assert.equal(p.ok, true);
    }

    const info = await clients[0].request("sidecar/info", {});
    assert.ok(info.webPort > 0);
    assert.equal(info.uiToken, "t3-secret-token");

    const listT3 = await clients[0].request("tools/list", { host: "t3" });
    const listAgy = await clients[0].request("tools/list", { host: "antigravity" });
    assert.equal(listT3.tools.some((t) => String(t.description || "").includes("sidecar://")), false);
    assert.equal(listAgy.tools.some((t) => String(t.description || "").includes(SIDECAR_PILL_MARKDOWN)), true);

    await Promise.all(clients.map((c) => c.close()));
  } finally {
    if (spawnedBroker) await spawnedBroker.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
});

test("T5 & T8: installer syncs and restores both ~/.gemini/config and ~/.t3/userdata/providers/antigravity/*/config", async () => {
  const fakeHome = makeShortTmpDir("cua-t5-home-");
  try {
    const geminiCfg = path.join(fakeHome, ".gemini", "config");
    const t3Cfg = path.join(
      fakeHome,
      ".t3",
      "userdata",
      "providers",
      "antigravity",
      "ac0a3dfd6dddb20962cecff6ee5fe65e",
      "config"
    );
    mkdirSync(geminiCfg, { recursive: true });
    mkdirSync(t3Cfg, { recursive: true });

    // Seed pre-existing third-party MCP servers in both configs
    writeFileSync(
      path.join(geminiCfg, "mcp_config.json"),
      JSON.stringify({ mcpServers: { "other-mcp": { command: "node", args: ["other.js"] } } }, null, 2)
    );
    writeFileSync(
      path.join(t3Cfg, "mcp_config.json"),
      JSON.stringify(
        {
          mcpServers: {
            "t3-code": { command: "node", args: ["t3.js"] },
            "computer-use": { command: "old-cu", args: ["legacy.js"] },
          },
        },
        null,
        2
      )
    );

    // Seed fake OCU binary so installer reuses local runtime without network npm install
    const fakeInstallDir = path.join(fakeHome, ".gemini", "codex-style-computer-use");
    const fakeOcuBinDir = path.join(
      fakeInstallDir,
      "node_modules",
      "open-computer-use",
      "dist",
      "Open Computer Use.app",
      "Contents",
      "MacOS"
    );
    mkdirSync(fakeOcuBinDir, { recursive: true });
    writeFileSync(path.join(fakeOcuBinDir, "OpenComputerUse"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });

    const discovered = discoverT3AntigravityConfigDirs(fakeHome);
    assert.deepEqual(discovered, [t3Cfg]);

    const res = await installCodexComputerUse({
      sourceRoot: PROJECT_ROOT,
      homeDir: fakeHome,
      installDir: fakeInstallDir,
      skipDoctor: true,
      skipProcessKill: true,
      skipNativeSelfTest: true,
      liveRpcFn: async () => false,
      log: () => {},
    });
    assert.equal(res.t3SyncedCount, 1);

    const t3McpAfterInstall = JSON.parse(readFileSync(path.join(t3Cfg, "mcp_config.json"), "utf8"));
    assert.ok(t3McpAfterInstall.mcpServers["t3-code"]);
    assert.ok(t3McpAfterInstall.mcpServers["computer-use"].args[0].endsWith("src/mcp-server.mjs"));
    assert.ok(t3McpAfterInstall.mcpServers["computer-use-js"].args[0].endsWith("src/mcp-repl-server.mjs"));

    const t3GeminiMd = readFileSync(path.join(t3Cfg, "GEMINI.md"), "utf8");
    assert.equal(t3GeminiMd.includes("sidecar://computer-use-preview"), false);
    assert.equal(t3GeminiMd.includes("(T3 Code)"), true);
    assert.equal(existsSync(path.join(t3Cfg, "sidecars")), false);

    await uninstallCodexComputerUse({
      homeDir: fakeHome,
      installDir: fakeInstallDir,
      skipProcessKill: true,
      liveRpcFn: async () => false,
    });

    const t3McpAfterUninstall = JSON.parse(readFileSync(path.join(t3Cfg, "mcp_config.json"), "utf8"));
    assert.deepEqual(t3McpAfterUninstall.mcpServers["computer-use"], {
      command: "old-cu",
      args: ["legacy.js"],
    });
    assert.equal(t3McpAfterUninstall.mcpServers["computer-use-js"], undefined);
    assert.equal(existsSync(path.join(t3Cfg, "GEMINI.md")), false);

    assert.equal(typeof resolveStableNodePath(process.execPath), "string");
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test("B1, B4, B5, B11.6: BackgroundActionExecutor blocks stale auto-replay, enforces string/OOB/drag coord proofs, protects sky_bypass, and verifies alias set_value readback", async () => {
  let peerCalls = [];
  let refreshFn = null;
  const registry = new AppSnapshotRegistry();
  const focusGuard = new FocusPolicyGuard({
    frontmostAppFn: async () => ({ pid: 999, bundleId: "com.user.front", processToken: "999:1" }),
    restoreAppFn: async () => true,
  });

  const elementsMap = new Map([
    [
      "5",
      {
        index: "5",
        role: "AXButton",
        rawText: "保存",
        identifier: "btn-save",
        fingerprint: "AXButton|btn-save|",
        label: "AXButton「保存」",
        origin: "snapshot",
      },
    ],
    [
      "9",
      {
        index: "9",
        role: "AXTextField",
        rawText: "",
        identifier: "title-input",
        fingerprint: "AXTextField|title-input|",
        label: "AXTextField",
        origin: "snapshot",
      },
    ],
  ]);

  registry.recordMeta(
    "com.test.app",
    {
      bundleId: "com.test.app",
      appDisplayName: "TestApp",
      pid: 4321,
      windowId: 101,
      windowTitle: "Editor",
      windowBounds: { x: 0, y: 0, width: 800, height: 600 },
      windowCount: 2,
      singleWindowProven: false,
      peerInstanceId: "fake-peer-1",
      elements: elementsMap,
    },
    {
      fromActionPeer: true,
      includeAx: true,
      includeScreenshot: true,
      actionDims: { width: 800, height: 600 },
      processToken: "4321:100.0",
    }
  );

  const executor = new BackgroundActionExecutor({
    actionPeer: createFakePeer(async (name, args) => {
      peerCalls.push({ name, args });
      if (args._triggerStaleOnce) {
        return { isError: true, content: [{ type: "text", text: "previous element indexes invalidated" }] };
      }
      return { isError: false, content: [{ type: "text", text: "ok" }] };
    }),
    axBridge: { enabled: false },
    focusPolicyGuard: focusGuard,
    registry,
    refreshActionStateFn: async (...a) => refreshFn?.(...a),
    editableFocusFn: async () => ({ editable: true, singleLine: true }),
    windowClickFn: async () => ({ delivered: true, method: "window_post" }),
    windowKeyFn: async (_pid, key) => {
      if (key === "BackSpace") {
        return { delivered: false, deliveryState: "not_sent", reason: "paused_mid_bypass" };
      }
      return { delivered: true, method: "window_key" };
    },
    windowTextFn: async (_pid, text) => {
      peerCalls.push({ name: "window_text", text });
      return { delivered: true, method: "window_key" };
    },
    postActionDelayMs: 0,
  });

  // B4.2: Out-of-bounds coordinate click blocked before invoking peer
  const oobClick = await executor.dispatch({
    name: "click",
    app: "com.test.app",
    cleanArgs: { app: "com.test.app", x: "950", y: "200" },
    parsedRef: { ok: true, hasElementRef: false },
  });
  assert.equal(oobClick.result.isError, true);
  assert.equal(oobClick.result.reason, "out_of_bounds");
  assert.equal(peerCalls.length, 0);

  // B4.1: Invalid non-numeric coordinate rejected
  const nanClick = await executor.dispatch({
    name: "click",
    app: "com.test.app",
    cleanArgs: { app: "com.test.app", x: "not-a-num", y: 100 },
    parsedRef: { ok: true, hasElementRef: false },
  });
  assert.equal(nanClick.result.isError, true);
  assert.equal(nanClick.result.reason, "invalid_coordinates");

  // B4.3: Coordinate drag on multi-window app blocked (`requireSingleWindow: true`)
  const multiWinDrag = await executor.dispatch({
    name: "drag",
    app: "com.test.app",
    cleanArgs: { app: "com.test.app", from_x: 50, from_y: 50, to_x: 200, to_y: 200 },
    parsedRef: { ok: true, hasElementRef: false },
  });
  assert.equal(multiWinDrag.result.isError, true);
  assert.equal(multiWinDrag.result.reason, "unproven_single_window");

  // B1: Unpinned element click when refresh changes #5 from "保存" to "删除全部" MUST block replay!
  refreshFn = async () => {
    registry.recordMeta(
      "com.test.app",
      {
        bundleId: "com.test.app",
        pid: 4321,
        windowId: 101,
        windowTitle: "Editor",
        elements: new Map([
          [
            "5",
            {
              index: "5",
              role: "AXButton",
              rawText: "删除全部",
              identifier: "btn-delete-all",
              fingerprint: "AXButton|btn-delete-all|",
              label: "AXButton「删除全部」",
            },
          ],
        ]),
      },
      { fromActionPeer: true, includeAx: true, includeScreenshot: false, processToken: "4321:100.0" }
    );
    return { isError: false, content: [{ type: "text", text: "refreshed" }] };
  };
  peerCalls = [];
  const driftedReplay = await executor.dispatch({
    name: "click",
    app: "com.test.app",
    cleanArgs: { app: "com.test.app", element_index: "5", _triggerStaleOnce: true },
    parsedRef: { ok: true, hasElementRef: true, rawIndex: "5" },
  });
  assert.equal(driftedReplay.result.isError, true);
  assert.match(driftedReplay.result.content[0].text, /ErrorCode:\s*STALE_REF/);
  assert.match(driftedReplay.result.content[0].text, /Delivery:\s*not_delivered/);
  assert.equal(peerCalls.length, 1, "Must NOT replay click onto mutated element #5 after refresh");

  // B5.1: set_value:sky_bypass when BackSpace returns deliveryState: "not_sent" MUST NOT fall through to native set_value
  focusGuard.recordSteal("com.test.app", "set_value:native");
  focusGuard.recordSteal("com.test.app", "click:sky_click");
  focusGuard.recordSteal("com.test.app", "press_key:sky_key");
  peerCalls = [];
  const blockedBypass = await executor.dispatch({
    name: "set_value",
    app: "com.test.app",
    cleanArgs: { app: "com.test.app", element_index: "9", value: "hello\tworld" },
    parsedRef: { ok: true, hasElementRef: true, rawIndex: "9" },
    validatedElement: elementsMap.get("9"),
  });
  assert.equal(blockedBypass.actionRouteKey, "set_value:sky_bypass");
  assert.equal(blockedBypass.result.isError, true);
  assert.equal(
    peerCalls.some((c) => c.name === "set_value"),
    false,
    "Must NEVER fall back to focus-stealing native set_value after click+cmd+a"
  );

  // B11.6: set_value readback verifies >=1_000_000 query alias via matching identifier in postSnapshot
  const preSnap = registry.getLatestSnapshot("com.test.app");
  const rbOut = await executor.verifyAndFormatReadBack({
    name: "set_value",
    cleanArgs: { app: "com.test.app", element_index: "1000001", value: "新内容" },
    parsedRef: { ok: true, hasElementRef: true, rawIndex: "1000001" },
    result: { isError: false, content: [{ type: "text", text: "ok" }] },
    actionRouteKey: "set_value:sky_bypass",
    preAppKey: "com.test.app",
    preSnapshot: preSnap,
    preElement: {
      index: "1000001",
      role: "AXTextField",
      identifier: "title-input",
      isSecure: false,
    },
    readBackStateFn: async () => {
      registry.recordMeta(
        "com.test.app",
        {
          bundleId: "com.test.app",
          pid: 4321,
          windowId: 101,
          windowTitle: "Editor",
          elements: new Map([
            [
              "14",
              {
                index: "14",
                role: "AXTextField",
                rawText: 'Value: "新内容"',
                identifier: "title-input",
                fingerprint: "AXTextField|title-input|",
                isSecure: false,
              },
            ],
          ]),
        },
        { fromActionPeer: true, includeAx: true, includeScreenshot: false, processToken: "4321:100.0" }
      );
      return { isError: false, content: [{ type: "text", text: '[14] AXTextField Value: "新内容"' }] };
    },
  });
  assert.equal(rbOut.verified, true);
  assert.equal(rbOut.deliveryStatus, "delivered_verified");
  focusGuard.close();
});

test("B2, B3, B6, B7, B8, B11, B12: takeover multi-chord guard, unknown-agent recovery, PID restart fail-closed, secure subrole, and act arg validation", async () => {
  // B7 & B2.3: multi-chord reserved hotkey & unknown-agent recovery on resume()
  let verifyCalled = 0;
  const tc = new TakeoverController({
    emergencyHotkey: "ctrl+opt+escape",
    onVerifyUnknownAgentCleared: async (agentId) => {
      verifyCalled += 1;
      tc.clearWriteOutcomeUnknown(agentId);
    },
  });
  assert.equal(tc.isReservedHotkey("tab ctrl+opt+escape"), true);
  assert.equal(tc.isReservedHotkey("cmd+c ctrl+alt+esc"), true);
  assert.equal(tc.isReservedHotkey("cmd+c Return"), false);

  tc.requestPause({ reason: "manual_pause", source: "ui" });
  tc.markWriteOutcomeUnknown("action-engine-1");
  const resumed = await tc.resume();
  assert.equal(verifyCalled, 1);
  assert.equal(resumed.ok, true);
  assert.equal(tc.nativeWriteUnknownLock, false);

  // B3.1 & B6.2 & B11.1-B11.4: AppSnapshotRegistry
  let currentIdentity = { alive: true, pid: 500, processToken: "500:10.0" };
  const reg = new AppSnapshotRegistry({
    processIdentityFn: async (pid) => (pid === 500 ? currentIdentity : null),
  });
  reg.recordMeta(
    "MyEditor",
    {
      bundleId: "com.example.editor",
      appDisplayName: "MyEditor",
      pid: 500,
      windowId: 77,
      windowTitle: "Main",
      elements: new Map([
        ["1", { index: "1", role: "AXButton", rawText: "Run", fingerprint: "AXButton||Run" }],
      ]),
    },
    { fromActionPeer: true, includeAx: true, includeScreenshot: false, processToken: "500:10.0" }
  );

  // B6.2 + B11.1: query with AXSecureTextField subrole marks isSecure=true AND keeps sibling element "1"
  const afterQuery = await reg.ingestQueryMatches("MyEditor", {
    window_id: 77,
    window_title: "Main",
    matches: [
      {
        index: 1000001,
        role: "AXTextField",
        subrole: "AXSecureTextField",
        value: "secret-pass",
        bounds: { x: 10, y: 20, w: 120, h: 28 },
      },
    ],
  });
  assert.equal(afterQuery.elements.get("1000001")?.isSecure, true);
  assert.equal(afterQuery.elements.get("1000001")?.rawText, "[redacted]");
  assert.equal(afterQuery.elements.has("1"), true, "Partial query must preserve sibling snapshot elements");

  // B3.1: PID 500 exited -> processIdentityFn(500) returns null -> validateTargetRef MUST fail closed!
  currentIdentity = null;
  const staleCheck = await reg.validateTargetRef({
    app: "MyEditor",
    parsedRef: { ok: true, hasElementRef: true, snapshotId: afterQuery.snapshotId, rawIndex: "1000001" },
  });
  assert.equal(staleCheck.ok, false);
  assert.equal(staleCheck.errorCode, "STALE_REF");

  // B11.2 & B11.4: deleteMeta clears custom query alias; normalizeElementBounds rejects null & Infinity
  reg.recordMeta("CustomAliasName", { bundleId: "com.example.editor", pid: 500 }, { fromActionPeer: false });
  reg.deleteMeta("com.example.editor");
  assert.equal(reg.getMeta("CustomAliasName"), null);
  assert.equal(normalizeElementBounds({ x: null, y: 0, w: 100, h: 50 }), null);
  assert.equal(normalizeElementBounds({ x: 0, y: 0, w: Infinity, h: 50 }), null);
  assert.equal(
    authorizeActionScreenshotCoords(null, {
      localPoint: { x: null, y: 10 },
      windowSize: { width: 500, height: 400 },
    }).authorized,
    false
  );

  // B6.1: JXA handleInsertSelectedText blocks AXSecureTextField
  const jxaBox = {
    ObjC: { import() {}, bindFunction() {}, unwrap: (v) => v, deepUnwrap: (v) => v, castRefToObject: (v) => v },
    Ref: () => [null],
  };
  jxaBox.$ = Object.assign((s) => s, {
    AXIsProcessTrusted: () => true,
    CGPreflightScreenCaptureAccess: () => true,
    AXUIElementCreateSystemWide: () => ({}),
    AXUIElementSetMessagingTimeout() {},
    AXUIElementCreateApplication: () => ({ kind: "app" }),
    AXUIElementCopyAttributeValue: (el, attr, out) => {
      if (el.kind === "app" && String(attr) === "AXFocusedUIElement") {
        out[0] = { kind: "el" };
        return 0;
      }
      if (el.kind === "el" && String(attr) === "AXRole") {
        out[0] = "AXTextField";
        return 0;
      }
      if (el.kind === "el" && String(attr) === "AXSubrole") {
        out[0] = "AXSecureTextField";
        return 0;
      }
      return -25212;
    },
    NSBundle: { bundleWithPath: () => ({ load: false }) },
    NSFileHandle: { fileHandleWithStandardInput: {}, fileHandleWithStandardOutput: {} },
  });
  vm.createContext(jxaBox);
  vm.runInContext(BRIDGE_JXA_SOURCE, jxaBox);
  const secIns = jxaBox.handleInsertSelectedText({ pid: 123, text: "abc" });
  assert.equal(secIns.delivered, false);
  assert.equal(secIns.reason, "secure_field");

  // B12: pickPromotableMainWindow filters AXSystemDialog & AXFloatingWindow
  const picked = pickPromotableMainWindow(
    { subrole: "AXFloatingWindow", width: 400, height: 300, id: "float" },
    [
      { subrole: "AXSystemDialog", width: 500, height: 400, id: "sysdlg" },
      { subrole: "AXStandardWindow", width: 1000, height: 700, id: "main" },
    ]
  );
  assert.equal(picked?.id, "main");

  // B8.3: dedupeSpatiallyOverlappingMatches keeps matches from distinct windows separate
  const crossWin = dedupeSpatiallyOverlappingMatches([
    { index: 1, role: "AXButton", title: "确定", window_id: 10, bounds: { x: 20, y: 20, w: 80, h: 30 } },
    { index: 2, role: "AXButton", title: "确定", window_id: 20, bounds: { x: 20, y: 20, w: 80, h: 30 } },
  ]);
  assert.equal(crossWin.length, 2);

  // B8.1 & B8.2: AtomicActExecutor rejects vacuous expect & invalid window_id
  const actExec = new AtomicActExecutor({
    registry: reg,
    actionExecutor: {},
    takeoverController: tc,
    getActionPeer: () => createFakePeer(),
    getAxBridge: () => null,
    checkAppRunning: async () => ({ running: true, pid: 100 }),
    safeGetAppState: async () => ({ isError: false, content: [] }),
    processQueryResult: async () => ({}),
    isBrokerPaused: () => false,
    isSameActiveApp: () => true,
    onAdoptFollowTarget: () => {},
    registerOperationTarget: () => {},
  });

  const vacuousRes = await actExec.execute({
    app: "Finder",
    target: { text: "Open" },
    expect: { window_title_contains: ["", "   "] },
  });
  assert.equal(vacuousRes.isError, true);
  assert.ok(JSON.stringify(vacuousRes).includes("INVALID_ACT_ARGS"));

  for (const badWid of [0, -1, "abc", Infinity, true]) {
    const badWidRes = await actExec.execute({
      app: "Finder",
      window_id: badWid,
      target: { text: "Open" },
      expect: { any_text: ["Opened"] },
    });
    assert.equal(badWidRes.isError, true);
    assert.ok(JSON.stringify(badWidRes).includes("INVALID_ACT_ARGS"));
  }
});

test("B16: REPL session survives transient socket disconnect via clientSessionId and CUAScriptRunner supports @sN:index selectText & __proto__ bindings", async () => {
  const dir = makeShortTmpDir("cua-b16-");
  const sockPath = path.join(dir, "repl.sock");
  let selectTextArgsSeen = null;

  const broker = new ComputerUseBrokerServer({
    webPort: 0,
    socketPath: sockPath,
    infoPath: null,
    actionPeer: createFakePeer(async (name, args) => {
      if (name === "list_apps") {
        return {
          isError: false,
          content: [{ type: "text", text: "1. TextEdit (com.apple.TextEdit) [Running]" }],
        };
      }
      if (name === "get_app_state") {
        return {
          isError: false,
          content: [
            {
              type: "text",
              text: 'App=com.apple.TextEdit (pid ' + process.pid + ')\nWindow: "Doc"\n[0] AXWindow "Doc"\n[5] AXTextArea Value: "Hello World"',
            },
          ],
        };
      }
      if (name === "select_text") {
        selectTextArgsSeen = args;
        return { isError: false, content: [{ type: "text", text: "ok" }] };
      }
      return { isError: false, content: [{ type: "text", text: "ok" }] };
    }),
    streamPeer: createFakePeer(),
    axBridge: { enabled: false, setSyntheticEventTag() {}, close: async () => {} },
    processIdentityFn: async (pid) => ({ alive: true, pid, processToken: `${pid}:1.0` }),
    desktopHelperClient: null,
    launchHelperOnStart: false,
  });

  await broker.start();
  const client = new BrokerRpcClient({ socketPath: sockPath, autoSpawn: false });

  try {
    // 1. Store top-level binding including `["__proto__"]` own property and bind app
    const run1 = await client.request("repl/run", {
      code: `
        var bag = JSON.parse('{"__proto__":{"tag":42},"count":7}');
        var app = await cua.getApp("com.apple.TextEdit");
        const snapMatch = /Snapshot:\\s*(s\\d+)/.exec(await app.getAXState({ emit: false }));
        var snapId = snapMatch ? snapMatch[1] : "s1";
        nodeRepl.write("ok1:" + snapId);
      `,
    });
    assert.equal(run1.isError, false, JSON.stringify(run1));

    // Simulate transient socket drop on client without closing logical MCP process
    client.conn.destroy();
    await new Promise((r) => setTimeout(r, 40));

    // 2. Next run on same BrokerRpcClient reconnects and STILL has `bag`, `app`, and `snapId`,
    //    and `app.selectText("@sN:5", ...)` succeeds!
    const run2 = await client.request("repl/run", {
      code: `
        await app.selectText("@" + snapId + ":5", "Hello");
        nodeRepl.write("count=" + bag.count);
      `,
    });
    assert.equal(run2.isError, false, JSON.stringify(run2));
    assert.ok(JSON.stringify(run2.content).includes("count=7"));
    assert.equal(selectTextArgsSeen?.element_index, "5");
  } finally {
    await client.close();
    await broker.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B19, B20, B21, B22 & UI hygiene: proxy WS Host/Origin, recovery IDR on seq jump, unsubscribe on hide, HTTP HEAD/400, and zero innerHTML", async () => {
  // Verify UI hygiene invariant: ZERO `.innerHTML =` in index.html or preview-video.js
  const uiHtml = readFileSync(UI_HTML_PATH, "utf8");
  const videoJs = readFileSync(PREVIEW_VIDEO_JS_PATH, "utf8");
  assert.equal(/\.innerHTML\s*=/u.test(uiHtml), false, "index.html must never use .innerHTML =");
  assert.equal(/\.innerHTML\s*=/u.test(videoJs), false, "preview-video.js must never use .innerHTML =");

  // B20 & B21.1: PreviewVideoController accepts recovery IDR on seq jump and sends unsubscribe on pane_hidden
  const controlPayloads = [];
  const decodedChunks = [];
  const winBox = {
    location: { protocol: "http:", host: "127.0.0.1:9999" },
    isSecureContext: true,
    EncodedVideoChunk: function (init) {
      Object.assign(this, init);
    },
    VideoDecoder: function () {},
  };
  winBox.window = winBox;
  vm.createContext(winBox);
  vm.runInContext(videoJs, winBox);
  const Ctrl = winBox.CUAPreviewVideo.PreviewVideoController;
  const ctrl = new Ctrl({
    canvas: { width: 100, height: 100, getContext: () => ({ drawImage() {} }) },
    apiPost: async (url, body) => {
      controlPayloads.push({ url, body });
      return { mode: "jpeg", reason: "test" };
    },
    getBrokerBootId: () => "boot-1",
  });
  ctrl.configuredGeneration = 1;
  ctrl.awaitIdr = false;
  ctrl.expectNextSeq = 11;
  ctrl.awaitingRecovery = true;
  ctrl.decoder = {
    state: "configured",
    decodeQueueSize: 0,
    decode(chunk) {
      decodedChunks.push(chunk);
    },
    close() {},
  };
  // Server dropped P-frames 11..24 and sent recovery IDR seq=25 -> must decode immediately without need_idr!
  ctrl.handleAccessUnitPacket(
    { generation: 1, seq: 25, isIdr: true, ptsUs: 5000, durationUs: 33000, payload: new Uint8Array([1, 2, 3]) },
    ctrl.epoch
  );
  assert.equal(decodedChunks.length, 1);
  assert.equal(decodedChunks[0].type, "key");
  assert.equal(ctrl.expectNextSeq, 26);
  assert.equal(controlPayloads.some((p) => p.body?.action === "need_idr"), false);

  ctrl.hadServerView = true;
  ctrl.stop("pane_hidden");
  assert.equal(
    controlPayloads.some((p) => p.url === "/api/video/control" && p.body?.action === "unsubscribe"),
    true
  );

  // B19 & B22: SidecarWebAdapter HEAD / 400 + VideoWebSocketHub reverse-proxy loopback Host/Origin
  let port = 0;
  const wsHub = new VideoWebSocketHub({
    brokerBootId: "boot-b19",
    getPort: () => port,
  });
  const adapter = new SidecarWebAdapter({
    webPort: 0,
    uiToken: "tok-b22",
    brokerBootId: "boot-b19",
    state: {
      permissions: { platform: "darwin", accessibility: true, screenRecording: true },
      headlessStats: {},
      recentActions: [],
      runningApps: [],
    },
    wsHub,
    runSerializedAction: (fn) => fn(),
    refreshAppsList: async () => {},
    refreshPermissionsQuietly: async () => {},
    onGetWindows: async () => ({ ok: true, windows: [] }),
    onRequestPermission: async () => ({ ok: false }),
    onSelectApp: async () => ({}),
    onBringToFront: async () => {},
    onInteract: async () => ({}),
    onTakeoverClaim: async () => ({}),
    onSettingsUpdate: async () => ({}),
    onVideoSubscribe: async () => ({}),
    onVideoControl: async () => ({}),
    captureStreamTick: async () => {},
  });
  await adapter.start();
  port = adapter.webPort;

  try {
    // HEAD /healthz -> 200 + Referrer-Policy: no-referrer
    const headRes = await fetch(`http://127.0.0.1:${port}/healthz`, { method: "HEAD" });
    assert.equal(headRes.status, 200);
    assert.equal(headRes.headers.get("referrer-policy"), "no-referrer");

    // POST /api/select-app with empty app -> 400 (not 500)
    const badPost = await fetch(`http://127.0.0.1:${port}/api/select-app?token=tok-b22`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app: "" }),
    });
    assert.equal(badPost.status, 400);

    // Reverse-proxy loopback Host (62999 != bound port) + valid ticket -> 101 Switching Protocols
    const ticket = wsHub.issueTicket({ viewId: "v-proxy", targetKey: "t1", streamId: 1 });
    const upgradeStatus = await new Promise((resolve, reject) => {
      const key = crypto.randomBytes(16).toString("base64");
      const sock = net.createConnection({ host: "127.0.0.1", port }, () => {
        sock.write(
          [
            `GET /api/video/ws?ticket=${encodeURIComponent(ticket)} HTTP/1.1`,
            "Host: 127.0.0.1:62999",
            "Origin: http://127.0.0.1:62999",
            "Upgrade: websocket",
            "Connection: Upgrade",
            "Sec-WebSocket-Version: 13",
            `Sec-WebSocket-Key: ${key}`,
            `Sec-WebSocket-Protocol: ${VIDEO_WS_SUBPROTOCOL}`,
            "\r\n",
          ].join("\r\n")
        );
      });
      sock.once("data", (buf) => {
        const firstLine = buf.toString("utf8").split("\r\n")[0];
        sock.destroy();
        resolve(firstLine);
      });
      sock.once("error", reject);
    });
    assert.match(upgradeStatus, /^HTTP\/1\.1 101 /);

    // B21.2: PreviewStreamManager caps #views at 16
    const psm = new PreviewStreamManager({ brokerBootId: "boot-b19", wsHub });
    for (let i = 0; i < 22; i += 1) {
      await psm.subscribe({ viewId: `v-${i}`, targetKey: null, supportsWebCodecs: false });
    }
    assert.ok(Object.keys(psm.getViewDiagnostics()).length <= 16);
    await psm.closeAll();
  } finally {
    await adapter.close();
  }
});
