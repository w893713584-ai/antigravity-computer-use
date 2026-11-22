import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import { BROKER_INFO_PATH, OPEN_COMPUTER_USE_BIN, PROJECT_ROOT, SIDECAR_PILL_MARKDOWN, UI_HTML_PATH } from "../src/constants.mjs";
import { ComputerUseBrokerServer } from "../src/broker-sidecar.mjs";
import { BrokerRpcClient } from "../src/broker-client.mjs";
import { NativeComputerUsePeer } from "../src/native-peer.mjs";
import { parseAppsList, extractResultText } from "../src/background-policy.mjs";

const HAS_LIVE_OCU_BIN =
  path.isAbsolute(OPEN_COMPUTER_USE_BIN) && existsSync(OPEN_COMPUTER_USE_BIN);

test("Broker HTTP token auth, pause brake, Raise interception, and live non-activating frame capture", async (t) => {
  if (!HAS_LIVE_OCU_BIN) {
    t.skip("Live desktop E2E requires an installed open-computer-use binary");
    return;
  }
  const sock = `/tmp/agy-cua-test-${process.pid}.sock`;
  const token = "test-secret-token";
  const broker = new ComputerUseBrokerServer({
    webPort: 0,
    uiToken: token,
    socketPath: sock,
  });

  const { webPort } = await broker.start();
  const client = new BrokerRpcClient({ socketPath: sock });

  try {
    // 1. Unauthorized HTTP request without token must return 401
    const unauth = await fetch(`http://127.0.0.1:${webPort}/api/state`);
    assert.equal(unauth.status, 401);

    // 2. Authorized HTML & state must return 200
    const pageRes = await fetch(`http://127.0.0.1:${webPort}/?token=${token}`);
    assert.equal(pageRes.status, 200);
    const html = await pageRes.text();
    assert.match(html, /Computer Use 侧面小窗/);

    // 3. Check frontmost app BEFORE background observation
    const listBefore = await client.request("tools/call", {
      name: "list_apps",
      arguments: {},
      source: "ai",
    });
    const appsBefore = parseAppsList(extractResultText(listBefore));
    const frontmostBefore = appsBefore.find((a) => a.isFrontmost)?.bundleId;
    const backgroundTarget = appsBefore.find((a) => a.isRunning && !a.isFrontmost);

    assert.ok(backgroundTarget, "Expected at least one non-frontmost running app on desktop");

    // 4. Observe background app via broker — must NOT change frontmost app AND must populate JPEG frame (when desktop is unlocked)
    const stateRes = await client.request("tools/call", {
      name: "get_app_state",
      arguments: { app: backgroundTarget.bundleId, max_tree_nodes: 40 },
      source: "ai",
    });
    const stateText = extractResultText(stateRes);
    const isDesktopLocked = stateRes.isError && /锁屏|locked/iu.test(stateText);
    if (!isDesktopLocked) {
      assert.equal(stateRes.isError, false, stateText);
    }

    const listAfter = await client.request("tools/call", {
      name: "list_apps",
      arguments: {},
      source: "ai",
    });
    const frontmostAfter = parseAppsList(extractResultText(listAfter)).find((a) => a.isFrontmost)?.bundleId;
    assert.equal(
      frontmostAfter,
      frontmostBefore,
      "Background get_app_state must NEVER steal focus or change frontmost app!"
    );

    // 5. Verify Mini-Window /api/frame.jpg serves valid JPEG bytes & parsed dimensions when desktop is unlocked
    if (!isDesktopLocked) {
      const frameRes = await fetch(`http://127.0.0.1:${webPort}/api/frame.jpg?token=${token}`);
      assert.equal(frameRes.status, 200);
      const frameBuf = Buffer.from(await frameRes.arrayBuffer());
      assert.ok(frameBuf.length > 500, `Expected non-trivial JPEG frame, got ${frameBuf.length}B`);
      assert.equal(frameBuf[0], 0xff);
      assert.equal(frameBuf[1], 0xd8);

      const liveStateRes = await fetch(`http://127.0.0.1:${webPort}/api/state?token=${token}`);
      const liveState = await liveStateRes.json();
      assert.ok(liveState.frameWidth > 50 && liveState.frameHeight > 50, `Expected parsed dimensions, got ${liveState.frameWidth}x${liveState.frameHeight}`);
    }

    // 6. Verify AI `Raise` secondary action is intercepted without raising the window
    const raiseRes = await client.request("tools/call", {
      name: "perform_secondary_action",
      arguments: { app: backgroundTarget.bundleId, element_index: "0", action: "Raise" },
      source: "ai",
    });
    assert.match(extractResultText(raiseRes), /Skipped Raise/);

    // 7. Verify Pause safety brake blocks AI mutating actions while allowing UI resume
    await fetch(`http://127.0.0.1:${webPort}/api/settings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Sidecar-Token": token },
      body: JSON.stringify({ paused: true }),
    });
    const blockedClick = await client.request("tools/call", {
      name: "press_key",
      arguments: { app: backgroundTarget.bundleId, key: "Escape" },
      source: "ai",
    });
    assert.equal(blockedClick.isError, true);
    assert.match(extractResultText(blockedClick), /暂停/);
  } finally {
    await client.close();
    await broker.close();
  }
});

test("Both stdio MCP servers (mcp-server.mjs & mcp-repl-server.mjs) initialize and execute against broker", async () => {
  const sock = `/tmp/agy-cua-mcp-${process.pid}.sock`;
  const ciFallbackPeer = {
    async listTools() {
      return {
        tools: [
          { name: "list_apps", description: "List desktop apps", inputSchema: { type: "object", properties: {} } },
          { name: "get_app_state", description: "Get app state", inputSchema: { type: "object", properties: { app: { type: "string" } } } },
        ],
      };
    },
    async callTool(name) {
      if (name === "list_apps") {
        return {
          isError: false,
          content: [{ type: "text", text: "Finder — com.apple.finder [running, frontmost]\nTextEdit — com.apple.TextEdit [running]" }],
        };
      }
      return { isError: false, content: [{ type: "text", text: "ok" }] };
    },
    close() {},
  };
  const broker = new ComputerUseBrokerServer({
    webPort: 0,
    socketPath: sock,
    ...(HAS_LIVE_OCU_BIN ? {} : { actionPeer: ciFallbackPeer, streamPeer: ciFallbackPeer }),
  });
  await broker.start();

  async function runMcpRoundtrip(scriptRelPath, toolCallParams) {
    const child = spawn(process.execPath, [path.join(PROJECT_ROOT, scriptRelPath)], {
      env: { ...process.env, AGY_CUA_BROKER_SOCK: sock },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdout.setEncoding("utf8");
    let buf = "";
    const responses = new Map();
    child.stdout.on("data", (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) {
          const m = JSON.parse(line);
          if (m.id !== undefined) responses.set(m.id, m);
        }
      }
    });
    const sendRpc = (id, method, params = {}) =>
      new Promise((resolve) => {
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
        const iv = setInterval(() => {
          if (responses.has(id)) {
            clearInterval(iv);
            resolve(responses.get(id));
          }
        }, 20);
      });

    try {
      const init = await sendRpc(1, "initialize", { protocolVersion: "2025-06-18" });
      assert.ok(init.result?.serverInfo?.name);
      const list = await sendRpc(2, "tools/list", {});
      assert.ok(Array.isArray(list.result?.tools) && list.result.tools.length >= 2);
      assert.ok(
        list.result.tools.some((t) => String(t.description || "").includes(SIDECAR_PILL_MARKDOWN)),
        `Expected ${scriptRelPath} tools/list to surface ${SIDECAR_PILL_MARKDOWN}`
      );
      const call1 = await sendRpc(3, "tools/call", toolCallParams);
      assert.equal(call1.result?.isError, false, JSON.stringify(call1));
      assert.ok(
        extractResultText(call1.result).includes(SIDECAR_PILL_MARKDOWN),
        `Expected first tools/call in ${scriptRelPath} to include one-time ${SIDECAR_PILL_MARKDOWN} hint`
      );
      const call2 = await sendRpc(4, "tools/call", toolCallParams);
      assert.equal(call2.result?.isError, false, JSON.stringify(call2));
      assert.equal(
        extractResultText(call2.result).includes(SIDECAR_PILL_MARKDOWN),
        false,
        `Expected second tools/call in ${scriptRelPath} not to repeat ${SIDECAR_PILL_MARKDOWN} hint`
      );
    } finally {
      child.kill("SIGTERM");
    }
  }

  try {
    await runMcpRoundtrip("src/mcp-server.mjs", {
      name: "list_apps",
      arguments: {},
    });
    await runMcpRoundtrip("src/mcp-repl-server.mjs", {
      name: "js",
      arguments: { code: "var apps = await cua.listApps({ emit: false }); nodeRepl.write(apps.length);" },
    });
  } finally {
    await broker.close();
  }
});

test("Stream loop stops and detaches instead of auto-relaunching when user quits the target app", async () => {
  const sock = `/tmp/agy-cua-quit-${process.pid}.sock`;
  const dummyProc = spawn(process.execPath, ["-e", "setInterval(() => {}, 10000)"], {
    stdio: "ignore",
  });
  let appAlive = true;
  let relaunchCount = 0;

  // Minimal 1x1 JPEG bytes
  const tinyJpg = Buffer.from([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00, 0xff, 0xd9,
  ]).toString("base64");

  const makePeer = () => ({
    async listTools() {
      return { tools: [{ name: "list_apps" }, { name: "get_app_state" }] };
    },
    async callTool(name) {
      if (name === "list_apps") {
        const line = appAlive
          ? "Gemini — com.google.GeminiMacOS [running, last-used=2026-11-11, uses=50]"
          : "Gemini — com.google.GeminiMacOS [last-used=2026-11-11, uses=50]";
        return { isError: false, content: [{ type: "text", text: line }] };
      }
      if (name === "get_app_state") {
        // Real OpenComputerUse launches closed apps via NSWorkspace.openApplication when get_app_state is called!
        if (!appAlive) {
          relaunchCount += 1;
          appAlive = true;
        }
        return {
          isError: false,
          content: [
            {
              type: "text",
              text: `App=com.google.GeminiMacOS (pid ${dummyProc.pid})\nWindow: "Gemini", App: Gemini.`,
            },
            { type: "image", mimeType: "image/jpeg", data: tinyJpg },
          ],
        };
      }
      return { isError: false, content: [{ type: "text", text: "ok" }] };
    },
    close() {},
  });

  const broker = new ComputerUseBrokerServer({
    webPort: 0,
    uiToken: "quit-test-token",
    socketPath: sock,
    actionPeer: makePeer(),
    streamPeer: makePeer(),
  });
  const { webPort } = await broker.start();
  const client = new BrokerRpcClient({ socketPath: sock });
  const sseAbort = new AbortController();

  try {
    // 1. AI observes Gemini -> sets activeApp & pid
    await client.request("tools/call", {
      name: "get_app_state",
      arguments: { app: "com.google.GeminiMacOS" },
      source: "ai",
    });

    // 2. Aux Pane connects to /api/events -> starts live stream polling loop
    const sseRes = await fetch(`http://127.0.0.1:${webPort}/api/events?token=quit-test-token`, {
      signal: sseAbort.signal,
    });
    assert.equal(sseRes.status, 200);
    await new Promise((r) => setTimeout(r, 180));

    // 3. User quits Gemini (Cmd+Q): process exits
    await new Promise((resolve) => {
      dummyProc.once("exit", () => {
        appAlive = false;
        resolve();
      });
      dummyProc.kill("SIGKILL");
    });

    // 4. Wait past several stream intervals (active stream interval is 110ms)
    await new Promise((r) => setTimeout(r, 450));

    assert.equal(
      relaunchCount,
      0,
      `Expected 0 auto-relaunches after quitting app, but stream loop triggered ${relaunchCount} relaunch(es)`
    );

    const stateAfterQuit = await (
      await fetch(`http://127.0.0.1:${webPort}/api/state?token=quit-test-token`)
    ).json();
    assert.equal(stateAfterQuit.activeApp, null, "Expected activeApp to detach after app quit");
    assert.equal(stateAfterQuit.hasFrame, false, "Expected stale frame to clear after app quit");
  } finally {
    sseAbort.abort();
    try {
      dummyProc.kill("SIGKILL");
    } catch {}
    await client.close();
    await broker.close();
  }
});

test("Socket disconnect resilience, fast broker.close() with connected clients, and BROKER_INFO_PATH isolation", async () => {
  const sock = `/tmp/agy-cua-sock-${process.pid}.sock`;
  let infoBefore = null;
  try {
    infoBefore = readFileSync(BROKER_INFO_PATH, "utf8");
  } catch {}

  const fakePeer = {
    async listTools() {
      return { tools: [{ name: "list_apps" }] };
    },
    async callTool() {
      await new Promise((r) => setTimeout(r, 80));
      return { isError: false, content: [{ type: "text", text: "Finder — com.apple.finder [running]" }] };
    },
    close() {},
  };

  const broker = new ComputerUseBrokerServer({
    webPort: 0,
    uiToken: "sock-token",
    socketPath: sock,
    actionPeer: fakePeer,
    streamPeer: fakePeer,
  });
  await broker.start();

  // Test broker must NOT clobber production ~/.config/ocu/agy-cua-sidecar.json
  if (infoBefore) {
    const infoNow = readFileSync(BROKER_INFO_PATH, "utf8");
    assert.equal(infoNow, infoBefore, "Test broker must not overwrite production BROKER_INFO_PATH");
  }

  // Abrupt socket reset while RPC reply is in flight must not throw unhandled socket error
  const rawConn = net.createConnection(sock);
  await new Promise((resolve) => rawConn.once("connect", resolve));
  rawConn.write('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_apps"}}\n');
  rawConn.destroy();
  await new Promise((r) => setTimeout(r, 120));

  // Persistent BrokerRpcClient connected -> broker.close() must finish in <400ms without hanging!
  const persistentClient = new BrokerRpcClient({ socketPath: sock });
  const ping = await persistentClient.request("ping", {});
  assert.equal(ping.ok, true);

  const closeResult = await Promise.race([
    broker.close().then(() => "closed"),
    new Promise((r) => setTimeout(() => r("hung"), 450)),
  ]);
  assert.equal(closeResult, "closed", "broker.close() hung while persistent RPC client was connected");
  await persistentClient.close();
});

test("Mini-Window click-after-scroll preserves AX indexes and screenshot geometry, AXRaise is blocked, and stale PID never relaunches switched app", async () => {
  const sock = `/tmp/agy-cua-interact-${process.pid}.sock`;
  const token = "interact-token";
  const appAPid = process.pid; // alive PID
  let appBRunning = true;
  let appBRelaunched = 0;

  const tinyJpg = Buffer.from([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x03, 0x20, 0x05, 0x00, 0x01, 0x01, 0x11, 0x00, 0xff, 0xd9,
  ]).toString("base64"); // 1280x800 JPEG

  // Strict simulation of OpenComputerUse's snapshot state machine on actionPeer
  let actionHasAx = false;
  let actionHasScreenshot = false;
  let includeAxFalseCallsOnActionPeer = 0;
  const clickedCoords = [];

  const actionPeer = {
    async listTools() {
      return { tools: [] };
    },
    async callTool(name, args = {}) {
      if (name === "list_apps") {
        const lines = ["AppA — com.example.AppA [running]"];
        if (appBRunning) lines.push("AppB — com.example.AppB [running]");
        return { isError: false, content: [{ type: "text", text: lines.join("\n") }] };
      }
      if (name === "get_app_state") {
        if (args.app === "com.example.AppB" && !appBRunning) {
          appBRelaunched += 1;
          appBRunning = true;
        }
        if (args.include_ax === false) {
          includeAxFalseCallsOnActionPeer += 1;
          actionHasAx = false;
        } else {
          actionHasAx = true;
        }
        actionHasScreenshot = args.include_screenshot !== false;
        const pidLine =
          args.app === "com.example.AppA"
            ? `App=com.example.AppA (pid ${appAPid})\nWindow: "WinA", App: AppA.\n0 标准窗口 WinA`
            : `Window: "WinB", App: AppB.\n0 标准窗口 WinB`; // simulate omitted pid line on AppB
        const content = [{ type: "text", text: pidLine }];
        if (actionHasScreenshot) {
          content.push({ type: "image", mimeType: "image/jpeg", data: tinyJpg });
        }
        return { isError: false, content };
      }
      if (name === "scroll") {
        if (!actionHasAx) {
          return { isError: true, content: [{ type: "text", text: "Element 0 not found; read AX again" }] };
        }
        return { isError: false, content: [{ type: "text", text: "ok" }] };
      }
      if (name === "click") {
        if (args.x !== undefined && !actionHasScreenshot) {
          return {
            isError: true,
            content: [{ type: "text", text: "Screenshot omitted by include_screenshot=false; coordinate input requires a delivered screenshot" }],
          };
        }
        clickedCoords.push({ x: args.x, y: args.y });
        return { isError: false, content: [{ type: "text", text: "ok" }] };
      }
      if (name === "press_key") {
        if (args.key === "cmd+q") {
          appBRunning = false;
        }
        return { isError: false, content: [{ type: "text", text: "ok" }] };
      }
      if (name === "perform_secondary_action") {
        return { isError: false, content: [{ type: "text", text: "performed secondary" }] };
      }
      return { isError: false, content: [{ type: "text", text: "ok" }] };
    },
    close() {},
  };

  const streamPeer = {
    async callTool(name, args = {}) {
      if (name === "list_apps") return actionPeer.callTool("list_apps", args);
      if (name === "get_app_state") {
        if (args.app === "com.example.AppB" && !appBRunning) {
          appBRelaunched += 1;
        }
        return {
          isError: false,
          content: [
            { type: "text", text: `Window: "Win", App: ${args.app}.` },
            { type: "image", mimeType: "image/jpeg", data: tinyJpg },
          ],
        };
      }
      return { isError: false, content: [{ type: "text", text: "ok" }] };
    },
    close() {},
  };

  const broker = new ComputerUseBrokerServer({
    webPort: 0,
    uiToken: token,
    socketPath: sock,
    actionPeer,
    streamPeer,
  });
  const { webPort } = await broker.start();
  const client = new BrokerRpcClient({ socketPath: sock });

  try {
    // 1. Observe AppA (sets pid = appAPid)
    await client.request("tools/call", {
      name: "get_app_state",
      arguments: { app: "com.example.AppA" },
      source: "ai",
    });

    // 2. Mini-Window Scroll then Click on AppA -> BOTH must succeed, and actionPeer must never get include_ax: false!
    const scrollRes = await (
      await fetch(`http://127.0.0.1:${webPort}/api/interact`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Sidecar-Token": token },
        body: JSON.stringify({ app: "com.example.AppA", kind: "scroll", direction: "down", pages: 0.4 }),
      })
    ).json();
    assert.equal(scrollRes.ok, true, JSON.stringify(scrollRes));

    const clickRes = await (
      await fetch(`http://127.0.0.1:${webPort}/api/interact`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Sidecar-Token": token },
        body: JSON.stringify({ app: "com.example.AppA", kind: "click", normX: 0.5, normY: 0.25 }),
      })
    ).json();
    assert.equal(clickRes.ok, true, JSON.stringify(clickRes));
    assert.deepEqual(clickedCoords[0], { x: 640, y: 200 });
    assert.equal(includeAxFalseCallsOnActionPeer, 0, "Broker must never wipe actionPeer AX indexes with include_ax: false");
    assert.equal(broker.state.paused, true, "Manual /api/interact must latch human takeover pause");

    // Resume AI after manual mini-window takeover so subsequent AI checks run normally
    const resumeAfterInteractRes = await fetch(`http://127.0.0.1:${webPort}/api/settings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Sidecar-Token": token },
      body: JSON.stringify({ paused: false }),
    });
    assert.equal(resumeAfterInteractRes.status, 200);
    const resumedState = await resumeAfterInteractRes.json();
    assert.equal(resumedState.paused, false);

    // 3. AXRaise must also be intercepted (not just "Raise")
    const axRaiseRes = await client.request("tools/call", {
      name: "perform_secondary_action",
      arguments: { app: "com.example.AppA", element_index: "0", action: "AXRaise" },
      source: "ai",
    });
    assert.match(extractResultText(axRaiseRes), /Skipped Raise/);

    // 4. Switch to AppB (whose snapshot omitted PID) -> state.pid must NOT keep AppA's alive PID!
    // Then press cmd+q -> AppB exits and must NOT be relaunched by read-back or UI interact!
    await client.request("tools/call", {
      name: "get_app_state",
      arguments: { app: "com.example.AppB" },
      source: "ai",
    });
    await client.request("tools/call", {
      name: "press_key",
      arguments: { app: "com.example.AppB", key: "cmd+q" },
      source: "ai",
    });
    assert.equal(appBRelaunched, 0, "cmd+q read-back must not relaunch exited app");

    const deadClickRes = await (
      await fetch(`http://127.0.0.1:${webPort}/api/interact`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Sidecar-Token": token },
        body: JSON.stringify({ app: "com.example.AppB", kind: "click", normX: 0.5, normY: 0.5 }),
      })
    ).json();
    assert.equal(deadClickRes.ok, false);
    assert.equal(appBRelaunched, 0, "UI click on just-exited app must not relaunch it");
  } finally {
    await client.close();
    await broker.close();
  }
});

test("BrokerRpcClient reconnects after broker restart without double-executing mutating calls, and UI HTML is XSS-safe", async () => {
  const sock = `/tmp/agy-cua-restart-${process.pid}.sock`;
  let clickExecutions = 0;

  // Server 1: accepts connection, receives click request, and crashes mid-flight before replying!
  const crashingServer = net.createServer((conn) => {
    conn.on("data", () => {
      clickExecutions += 1;
      conn.destroy();
    });
  });
  await new Promise((r) => crashingServer.listen(sock, r));

  const client = new BrokerRpcClient({ socketPath: sock });
  await assert.rejects(
    () =>
      client.request("tools/call", {
        name: "click",
        arguments: { app: "com.apple.finder", x: 10, y: 10 },
      }),
    /closed|ECONNRESET/i
  );
  assert.equal(clickExecutions, 1, "Mid-flight disconnect must NEVER replay a mutating click a second time");
  await new Promise((r) => crashingServer.close(r));

  // Server 2: Sidecar restarts on the same socket path -> client must reconnect cleanly!
  const fakePeer = {
    async listTools() {
      return { tools: [{ name: "list_apps" }] };
    },
    async callTool() {
      return { isError: false, content: [{ type: "text", text: "Finder — com.apple.finder [running]" }] };
    },
    close() {},
  };
  const restartedBroker = new ComputerUseBrokerServer({
    webPort: 0,
    uiToken: "restart-token",
    socketPath: sock,
    actionPeer: fakePeer,
    streamPeer: fakePeer,
  });
  await restartedBroker.start();
  try {
    const listRes = await client.request("tools/list", {});
    assert.equal(listRes.tools[0].name, "list_apps");
  } finally {
    await client.close();
    await restartedBroker.close();
  }

  // Verify src/ui/index.html has zero innerHTML sinks and handles frameSeq reset across restarts
  const uiSource = readFileSync(UI_HTML_PATH, "utf8");
  assert.equal(/\.innerHTML\s*=/u.test(uiSource), false, "src/ui/index.html must not use .innerHTML assignments (XSS sink)");
  assert.match(uiSource, /brokerBootId/, "src/ui/index.html should track brokerBootId to reset displayedFrameSeq on sidecar restart");
});

test("Post-action read-back preserves drag diagnostic notes, /api/select-app surfaces windowless errors, and teardown isolates per-request dispatched flag", async () => {
  const sock = `/tmp/agy-cua-pass2-${process.pid}.sock`;
  const token = "pass2-token";

  const peer = {
    async listTools() {
      return { tools: [] };
    },
    async callTool(name, args = {}) {
      if (name === "list_apps") {
        return {
          isError: false,
          content: [
            {
              type: "text",
              text: [
                "AppA — com.example.AppA [running]",
                "WindowlessApp — com.example.Windowless [running]",
              ].join("\n"),
            },
          ],
        };
      }
      if (name === "get_app_state") {
        if (args.app === "com.example.Windowless") {
          return { isError: true, content: [{ type: "text", text: "No open windows found for WindowlessApp" }] };
        }
        return {
          isError: false,
          content: [{ type: "text", text: `App=com.example.AppA (pid ${process.pid})\nWindow: "WinA", App: AppA.` }],
        };
      }
      if (name === "drag") {
        return {
          isError: false,
          content: [{ type: "text", text: "ok\nDrag delivered via app_post: mouse events were posted directly." }],
        };
      }
      return { isError: false, content: [{ type: "text", text: "ok" }] };
    },
    close() {},
  };

  const broker = new ComputerUseBrokerServer({
    webPort: 0,
    uiToken: token,
    socketPath: sock,
    actionPeer: peer,
    streamPeer: peer,
  });
  const { webPort } = await broker.start();
  const client = new BrokerRpcClient({ socketPath: sock });

  try {
    // 1. Drag diagnostic note must be preserved alongside post-action read-back state
    const dragRes = await client.request("tools/call", {
      name: "drag",
      arguments: { app: "com.example.AppA", from_x: 10, from_y: 10, to_x: 100, to_y: 100 },
      source: "ai",
    });
    assert.match(extractResultText(dragRes), /Drag delivered via app_post/);
    assert.match(extractResultText(dragRes), /Window: "WinA"/);

    // 2. Selecting a windowless app in UI must return ok: false with clear error message
    const selRes = await (
      await fetch(`http://127.0.0.1:${webPort}/api/select-app`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Sidecar-Token": token },
        body: JSON.stringify({ app: "com.example.Windowless" }),
      })
    ).json();
    assert.equal(selRes.ok, false);
    assert.match(String(selRes.error), /No open windows/);
  } finally {
    await client.close();
    await broker.close();
  }
});

test("Concurrent tool calls serialize cleanly, ai-repl gets safe read-back, and Focus-Steal Guard catches immediate & delayed Qt self-activation", async () => {
  const sock = `/tmp/agy-cua-guard-${process.pid}.sock`;
  const token = "guard-token";

  let inFlightActions = 0;
  let maxConcurrentActions = 0;
  const callOrder = [];

  let simulatedFront = { pid: 82290, bundleId: "com.google.antigravity" };
  const restoredPids = [];

  const focusController = {
    async getFrontmostApp() {
      return simulatedFront;
    },
    async restoreFrontmostApp(pid) {
      restoredPids.push(pid);
      simulatedFront = { pid, bundleId: "com.google.antigravity" };
      return true;
    },
    sweepDelaysMs: [40, 110],
  };

  let triggerImmediateSteal = false;
  let triggerDelayedStealMs = 0;

  const peer = {
    async listTools() {
      return {
        tools: [
          { name: "get_app_state", description: "Read app state." },
          { name: "click", description: "Click target." },
        ],
      };
    },
    async callTool(name, args = {}) {
      inFlightActions += 1;
      maxConcurrentActions = Math.max(maxConcurrentActions, inFlightActions);
      callOrder.push(`${name}:${args.key || args.x || "state"}`);
      await new Promise((r) => setTimeout(r, 25));
      try {
        if (name === "list_apps") {
          return {
            isError: false,
            content: [{ type: "text", text: "剪映专业版 — com.lemon.lvpro [running]" }],
          };
        }
        if (name === "get_app_state") {
          return {
            isError: false,
            content: [
              {
                type: "text",
                text: `App=com.lemon.lvpro (pid ${process.pid})\nWindow: "剪映专业版", App: 剪映专业版.`,
              },
            ],
          };
        }
        if (name === "click") {
          if (triggerImmediateSteal) {
            simulatedFront = { pid: process.pid, bundleId: "com.lemon.lvpro" };
          }
          if (triggerDelayedStealMs > 0) {
            setTimeout(() => {
              simulatedFront = { pid: process.pid, bundleId: "com.lemon.lvpro" };
            }, triggerDelayedStealMs);
          }
          return { isError: false, content: [{ type: "text", text: "ok" }] };
        }
        return { isError: false, content: [{ type: "text", text: "ok" }] };
      } finally {
        inFlightActions -= 1;
      }
    },
    close() {},
  };

  const broker = new ComputerUseBrokerServer({
    webPort: 0,
    uiToken: token,
    socketPath: sock,
    actionPeer: peer,
    streamPeer: peer,
    focusController,
  });
  await broker.start();
  const client = new BrokerRpcClient({ socketPath: sock });

  try {
    // 0. tools/list injects the sidecar pill reminder into get_app_state description
    const toolsList = await client.request("tools/list", {});
    const getAppStateTool = toolsList.tools.find((t) => t.name === "get_app_state");
    assert.ok(
      getAppStateTool.description.includes(SIDECAR_PILL_MARKDOWN),
      "get_app_state description must include sidecar pill guidance for lazy-loaded MCP agents"
    );

    // 1. Fire 4 parallel tool calls (like step 191 in 9b849133) -> must serialize strictly with max concurrency 1
    const [r1, r2, r3, r4] = await Promise.all([
      client.request("tools/call", { name: "get_app_state", arguments: { app: "com.lemon.lvpro" }, source: "ai" }),
      client.request("tools/call", { name: "click", arguments: { app: "com.lemon.lvpro", x: 320, y: 825 }, source: "ai-repl" }),
      client.request("tools/call", { name: "press_key", arguments: { app: "com.lemon.lvpro", key: "super+a" }, source: "ai" }),
      client.request("tools/call", { name: "get_app_state", arguments: { app: "com.lemon.lvpro" }, source: "ai" }),
    ]);
    assert.equal(maxConcurrentActions, 1, "Concurrent executeToolCall invocations must never interleave on actionPeer");
    assert.equal(r1.isError, false);
    assert.match(extractResultText(r2), /Window: "剪映专业版"/, "ai-repl click must perform safe post-action read-back");
    assert.equal(r3.isError, false);
    assert.equal(r4.isError, false);

    // 2. Immediate Qt self-activation during click -> immediately restores Antigravity (pid 82290)
    triggerImmediateSteal = true;
    await client.request("tools/call", {
      name: "click",
      arguments: { app: "com.lemon.lvpro", x: 100, y: 100 },
      source: "ai",
    });
    triggerImmediateSteal = false;
    assert.equal(simulatedFront.pid, 82290);
    assert.ok(restoredPids.includes(82290), "Expected immediate focus theft to restore pid 82290");

    // 3. Delayed Qt window-transition self-activation (60ms after click returns) -> caught by post-action sweep!
    restoredPids.length = 0;
    triggerDelayedStealMs = 60;
    await client.request("tools/call", {
      name: "click",
      arguments: { app: "com.lemon.lvpro", x: 320, y: 825 },
      source: "ai",
    });
    triggerDelayedStealMs = 0;
    await new Promise((r) => setTimeout(r, 160));
    assert.equal(simulatedFront.pid, 82290);
    assert.ok(restoredPids.includes(82290), "Expected delayed window-transition focus theft to restore pid 82290");
  } finally {
    await client.close();
    await broker.close();
  }
});

test("NativeComputerUsePeer isolates socket namespaces and auto-recovers read-only calls from transient agent disconnects", async () => {
  const p1 = new NativeComputerUsePeer({ name: "action-engine" });
  const p2 = new NativeComputerUsePeer({ name: "stream-engine" });
  const ns1 = p1.envOverrides.OPEN_COMPUTER_USE_AGENT_SOCKET_NAMESPACE;
  const ns2 = p2.envOverrides.OPEN_COMPUTER_USE_AGENT_SOCKET_NAMESPACE;
  assert.ok(typeof ns1 === "string" && ns1.length > 0 && ns1.length <= 18);
  assert.ok(typeof ns2 === "string" && ns2.length > 0 && ns2.length <= 18);
  assert.notEqual(ns1, ns2, "actionPeer and streamPeer must never share the same app-agent socket namespace");
  p1.close();
  p2.close();

  // Simulate a mock MCP child script that crashes once on its first get_app_state with Code=3840, then succeeds on reboot
  const mockScript = `
    const fs = require("fs");
    const marker = process.env.MOCK_CRASH_MARKER;
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (msg.method === "initialize") {
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: {} } }) + "\\n");
        } else if (msg.method === "tools/call") {
          if (!fs.existsSync(marker)) {
            fs.writeFileSync(marker, "1");
            process.stderr.write('Error Domain=NSCocoaErrorDomain Code=3840 "Unterminated string around line 1, column 12."\\n');
            process.exit(1);
          }
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { isError: false, content: [{ type: "text", text: "recovered-ok" }] } }) + "\\n");
        }
      }
    });
  `;
  const markerPath = `/tmp/agy-cua-peer-recover-${process.pid}`;
  try {
    const fsMod = await import("node:fs");
    fsMod.rmSync(markerPath, { force: true });
    const recoveringPeer = new NativeComputerUsePeer({
      name: "recover-peer",
      command: process.execPath,
      args: ["-e", mockScript],
      envOverrides: { MOCK_CRASH_MARKER: markerPath },
    });
    try {
      const res = await recoveringPeer.callTool("get_app_state", { app: "com.lemon.lvpro" }, 5000);
      assert.equal(extractResultText(res), "recovered-ok");
    } finally {
      recoveringPeer.close();
      fsMod.rmSync(markerPath, { force: true });
    }
  } catch (err) {
    throw err;
  }
});

test("Mini-Window ignores tiny 84x84 floating AI-orb subwindows when a main editor window exists for the same PID", async () => {
  const sock = `/tmp/agy-cua-orb-${process.pid}.sock`;
  const token = "orb-token";

  // 84x84 JPEG (simulating 剪映's 42x42 pt floating AI assistant orb)
  const orb84Jpg = Buffer.from([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x54, 0x00, 0x54, 0x01, 0x01, 0x11, 0x00, 0xff, 0xd9,
  ]).toString("base64");
  // 1280x705 JPEG (simulating 剪映's real main editor window)
  const main1280JpgBytes = Buffer.from([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x02, 0xc1, 0x05, 0x00, 0x01, 0x01, 0x11, 0x00, 0xff, 0xd9,
  ]);

  const peer = {
    async listTools() {
      return { tools: [] };
    },
    async callTool(name) {
      if (name === "list_apps") {
        return { isError: false, content: [{ type: "text", text: "剪映专业版 — com.lemon.lvpro [running]" }] };
      }
      if (name === "get_app_state") {
        return {
          isError: false,
          content: [
            { type: "text", text: `App=com.lemon.lvpro (pid ${process.pid})\nWindow: "剪映专业版", App: 剪映专业版.` },
            { type: "image", mimeType: "image/jpeg", data: orb84Jpg },
          ],
        };
      }
      return { isError: false, content: [{ type: "text", text: "ok" }] };
    },
    close() {},
  };

  let fallbackCalls = 0;
  let promoteCalls = 0;
  const pointClicks = [];
  let peerClickCalled = false;

  const origCallTool = peer.callTool.bind(peer);
  peer.callTool = async (name, args) => {
    if (name === "click") {
      peerClickCalled = true;
      return {
        isError: true,
        content: [{ type: "text", text: "sky_click target is outside the snapshot window bounds" }],
      };
    }
    return origCallTool(name, args);
  };

  const broker = new ComputerUseBrokerServer({
    webPort: 0,
    uiToken: token,
    socketPath: sock,
    actionPeer: peer,
    streamPeer: peer,
    promoteMainWindowFn: async (pid) => {
      assert.equal(pid, process.pid);
      promoteCalls += 1;
      return false; // Simulate stubborn custom Qt orb that stays AXFocusedWindow
    },
    mainWindowFallbackFn: async (pid) => {
      assert.equal(pid, process.pid);
      fallbackCalls += 1;
      return {
        data: main1280JpgBytes.toString("base64"),
        mimeType: "image/jpeg",
        wid: 30442,
        bounds: { x: 100, y: 50, width: 1469, height: 810 },
        imgWidth: 1280,
        imgHeight: 705,
        windowTitle: "剪映专业版 - 主窗口",
      };
    },
    pointClickFn: async (pid, screenX, screenY, opts) => {
      pointClicks.push({ pid, screenX, screenY, opts });
      return true;
    },
  });
  const { webPort } = await broker.start();
  const client = new BrokerRpcClient({ socketPath: sock });

  try {
    await client.request("tools/call", {
      name: "get_app_state",
      arguments: { app: "com.lemon.lvpro" },
      source: "ai",
    });
    const st = await (await fetch(`http://127.0.0.1:${webPort}/api/state?token=${token}`)).json();
    assert.ok(promoteCalls >= 1, "Expected Stage 1 background main-window focus promotion to be attempted");
    assert.ok(fallbackCalls >= 1, "Expected tiny 84x84 floating orb frame to trigger main-window fallback");
    assert.equal(st.frameWidth, 1280);
    assert.equal(st.frameHeight, 705);

    // Coordinate click after tiny-orb fallback must map onto real main window bounds instead of hitting 84x84 orb!
    const clickRes = await client.request("tools/call", {
      name: "click",
      arguments: { app: "com.lemon.lvpro", x: 640, y: 352.5 },
      source: "ai",
    });
    assert.equal(Boolean(clickRes?.isError), false);
    assert.equal(peerClickCalled, false, "Must NOT send 1280x705 coordinates into peer holding 84x84 orb snapshot");
    assert.equal(pointClicks.length, 1);
    assert.equal(pointClicks[0].pid, process.pid);
    assert.ok(Math.abs(pointClicks[0].screenX - (100 + 1469 * 0.5)) < 1.5);
    assert.ok(Math.abs(pointClicks[0].screenY - (50 + 810 * 0.5)) < 1.5);
  } finally {
    await client.close();
    await broker.close();
  }
});

test("Focus-Steal Guard never yanks window back when user clicks 置顶 mid-action", async () => {
  const sock = `/tmp/agy-cua-epoch-${process.pid}.sock`;
  const token = "epoch-token";
  let currentFront = { pid: 1111, bundleId: "com.google.antigravity" };
  let restoredCount = 0;

  let releaseClick = null;
  const clickStarted = new Promise((resolve) => {
    releaseClick = resolve;
  });
  let finishClick = null;
  const clickGate = new Promise((resolve) => {
    finishClick = resolve;
  });

  const peer = {
    async listTools() {
      return { tools: [] };
    },
    async callTool(name) {
      if (name === "list_apps") {
        return { isError: false, content: [{ type: "text", text: "剪映专业版 — com.lemon.lvpro [running]" }] };
      }
      if (name === "get_app_state") {
        return {
          isError: false,
          content: [{ type: "text", text: `App=com.lemon.lvpro (pid ${process.pid})\nWindow: "剪映专业版", App: 剪映专业版.` }],
        };
      }
      if (name === "click") {
        releaseClick();
        await clickGate;
        return { isError: false, content: [{ type: "text", text: "ok" }] };
      }
      return { isError: false, content: [{ type: "text", text: "ok" }] };
    },
    close() {},
  };

  const broker = new ComputerUseBrokerServer({
    webPort: 0,
    uiToken: token,
    socketPath: sock,
    actionPeer: peer,
    streamPeer: peer,
    focusController: {
      async getFrontmostApp() {
        return currentFront;
      },
      async restoreFrontmostApp() {
        restoredCount += 1;
        return true;
      },
      sweepDelaysMs: [40, 90],
    },
  });
  const { webPort } = await broker.start();
  const client = new BrokerRpcClient({ socketPath: sock });

  try {
    await client.request("tools/call", {
      name: "get_app_state",
      arguments: { app: "com.lemon.lvpro" },
      source: "ai",
    });

    const inflightClick = client.request("tools/call", {
      name: "click",
      arguments: { app: "com.lemon.lvpro", element_index: "1" },
      source: "ai",
    });
    await clickStarted;

    // User intentionally clicks "置顶" while AI click is in-flight!
    currentFront = { pid: process.pid, bundleId: "com.lemon.lvpro" };
    await fetch(`http://127.0.0.1:${webPort}/api/bring-to-front`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Sidecar-Token": token },
      body: JSON.stringify({ app: "com.lemon.lvpro" }),
    });

    finishClick();
    await inflightClick;
    await new Promise((r) => setTimeout(r, 150));

    assert.equal(restoredCount, 0, "Focus-Steal Guard must NOT fight user's intentional 置顶 click");
  } finally {
    await client.close();
    await broker.close();
  }
});

test("Broker forces window_placement='keep' (.readOnly), downgrades AI click_method='accessibility', and guards cold-cache localized app names", async () => {
  const sock = `/tmp/agy-cua-keep-${process.pid}.sock`;
  const token = "keep-token";
  const observedPlacements = [];
  const observedClickMethods = [];
  let currentFront = { pid: 2222, bundleId: "com.google.antigravity", displayName: "Antigravity" };
  const restoredPids = [];

  const peer = {
    async listTools() {
      return { tools: [] };
    },
    async callTool(name, args) {
      if (name === "list_apps") {
        return {
          isError: false,
          content: [{ type: "text", text: "剪映专业版 — com.lemon.lvpro [running]" }],
        };
      }
      if (name === "get_app_state") {
        observedPlacements.push(args.window_placement);
        return {
          isError: false,
          content: [
            {
              type: "text",
              text: `App=com.lemon.lvpro (pid ${process.pid})\nWindow: "剪映专业版", App: 剪映专业版.\n\t81 按钮 朗读`,
            },
          ],
        };
      }
      if (name === "click") {
        observedClickMethods.push(args.click_method);
        if (args.click_method === "sky_click") {
          return { isError: false, content: [{ type: "text", text: "ok" }] };
        }
        return { isError: true, content: [{ type: "text", text: "failed" }] };
      }
      if (name === "set_value") {
        // Simulate Qt self-activation inside AXSetValue!
        currentFront = { pid: process.pid, bundleId: "com.lemon.lvpro", displayName: "剪映专业版" };
        return { isError: false, content: [{ type: "text", text: "ok" }] };
      }
      return { isError: false, content: [{ type: "text", text: "ok" }] };
    },
    close() {},
  };

  const broker = new ComputerUseBrokerServer({
    webPort: 0,
    uiToken: token,
    socketPath: sock,
    actionPeer: peer,
    streamPeer: peer,
    focusController: {
      async getFrontmostApp() {
        return currentFront;
      },
      async restoreFrontmostApp(pid) {
        restoredPids.push(pid);
        currentFront = { pid, bundleId: "com.google.antigravity", displayName: "Antigravity" };
        return true;
      },
      sweepDelaysMs: [],
    },
  });
  await broker.start();
  const client = new BrokerRpcClient({ socketPath: sock });

  try {
    // 1. Cold-cache AI click with Chinese display name + explicit click_method: "accessibility"
    // Must pre-warm with window_placement: "keep" and execute via "sky_click" (never AXPress first)!
    const clickRes = await client.request("tools/call", {
      name: "click",
      arguments: { app: "剪映专业版", element_index: "81", click_method: "accessibility" },
      source: "ai",
    });
    assert.equal(Boolean(clickRes?.isError), false);
    assert.equal(observedClickMethods[0], "sky_click");
    assert.ok(observedPlacements.length >= 1);
    for (const wp of observedPlacements) {
      assert.equal(wp, "keep", `Expected window_placement='keep' (.readOnly), got '${wp}'`);
    }

    // 2. Even if caller passes window_placement: "restore", broker must force "keep"
    await client.request("tools/call", {
      name: "get_app_state",
      arguments: { app: "剪映专业版", window_placement: "restore" },
      source: "ai",
    });
    assert.equal(observedPlacements.at(-1), "keep");

    // 3. If Qt self-activates during set_value on Chinese app name, Focus-Steal Guard reclaims Antigravity!
    await client.request("tools/call", {
      name: "set_value",
      arguments: { app: "剪映专业版", element_index: "81", value: "hello" },
      source: "ai",
    });
    assert.ok(restoredPids.includes(2222), "Expected Focus-Steal Guard to restore Antigravity PID 2222");
  } finally {
    await client.close();
    await broker.close();
  }
});

test("Closed-loop @sN:index STALE_REF, PID generation mismatch, pure JSON query snapshot_id, and advertised secondary actions", async () => {
  const sock = `/tmp/agy-cua-closedloop-${process.pid}.sock`;
  const token = "closed-loop-token";
  let screenPhase = 1;
  let processGeneration = "gen-1";
  const dispatchedCalls = [];

  const jpgA = Buffer.from([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x01, 0xe0, 0x02, 0x80, 0x01, 0x01, 0x11, 0x00, 0xff, 0xd9,
  ]).toString("base64");

  const peer = {
    async listTools() {
      return {
        tools: [
          { name: "list_apps", description: "list" },
          { name: "get_app_state", description: "state" },
          { name: "query", description: "query" },
          { name: "click", description: "click" },
          { name: "perform_secondary_action", description: "sec" },
        ],
      };
    },
    async callTool(name, args) {
      if (name === "list_apps") {
        return {
          isError: false,
          content: [{ type: "text", text: "Notes — com.apple.Notes [running]" }],
        };
      }
      if (name === "get_app_state") {
        const snapshotText =
          screenPhase === 1
            ? [
                `App=com.apple.Notes (pid ${process.pid})`,
                'Window: "Compose", App: Notes.',
                "\t1 按钮 发送 Secondary Actions: AXPress, ShowMenu ID: btn_send",
                "\t2 AXTextField 内容 ID: body_field",
              ].join("\n")
            : [
                `App=com.apple.Notes (pid ${process.pid})`,
                'Window: "Sent Confirmation", App: Notes.',
                "\t1 按钮 确定 Secondary Actions: Confirm ID: btn_done",
                "\t2 按钮 关闭 Secondary Actions: Cancel ID: btn_cancel",
              ].join("\n");
        return {
          isError: false,
          content: [
            { type: "text", text: snapshotText },
            ...(args.include_screenshot !== false
              ? [{ type: "image", data: jpgA, mimeType: "image/jpeg" }]
              : []),
          ],
        };
      }
      if (name === "query") {
        return {
          isError: false,
          content: [
            {
              type: "text",
              text: JSON.stringify({
                matches: [{ index: 1, role: "按钮", title: "发送", identifier: "btn_send" }],
                truncated: false,
                stop_reason: "complete",
              }),
            },
          ],
        };
      }
      dispatchedCalls.push({ name, args });
      if (name === "click") {
        screenPhase = 2; // Simulate UI transition after click
      }
      return { isError: false, content: [{ type: "text", text: "ok" }] };
    },
    close() {},
  };

  const broker = new ComputerUseBrokerServer({
    webPort: 0,
    uiToken: token,
    socketPath: sock,
    actionPeer: peer,
    streamPeer: peer,
    processIdentityFn: async (pid) => ({
      pid,
      startTimeText: processGeneration,
      processToken: `${pid}:${processGeneration}`,
    }),
    permissionsFn: async () => ({
      platform: "darwin",
      accessibility: true,
      screenRecording: true,
      checkedAt: Date.now(),
    }),
  });
  await broker.start();
  const client = new BrokerRpcClient({ socketPath: sock });

  try {
    // 1. Initial get_app_state issues s1
    const s1Res = await client.request("tools/call", {
      name: "get_app_state",
      arguments: { app: "com.apple.Notes" },
      source: "ai",
    });
    assert.match(s1Res.content[0].text, /\[Snapshot: s1 \| PID:/);

    // 2. query returns strictly valid JSON with injected snapshot_id ("s2") for computer-use-js
    const queryRes = await client.request("tools/call", {
      name: "query",
      arguments: { app: "com.apple.Notes", role: "按钮" },
      source: "ai-repl",
    });
    const parsedQuery = JSON.parse(queryRes.content[0].text);
    assert.equal(parsedQuery.snapshot_id, "s2");
    assert.equal(parsedQuery.window_title, "Compose");

    // 3. Click @s1:1 unwraps "1" for native actionPeer and triggers UI transition -> s3
    const clickRes = await client.request("tools/call", {
      name: "click",
      arguments: { app: "com.apple.Notes", element_index: "@s1:1" },
      source: "ai",
    });
    assert.equal(Boolean(clickRes?.isError), false);
    assert.equal(dispatchedCalls[0].args.element_index, "1");
    assert.equal(dispatchedCalls[0].args.snapshot_id, undefined);
    assert.match(clickRes.content.map((c) => c.text).join("\n"), /\[Snapshot: s3 \|/);

    // 4. Retrying stale @s1:1 is rejected fail-closed with STALE_REF BEFORE hitting actionPeer!
    const countBeforeStale = dispatchedCalls.length;
    const staleRes = await client.request("tools/call", {
      name: "click",
      arguments: { app: "com.apple.Notes", element_index: "@s1:1" },
      source: "ai",
    });
    assert.equal(staleRes.isError, true);
    assert.match(staleRes.content[0].text, /ErrorCode:\s*STALE_REF/);
    assert.match(staleRes.content[0].text, /当前最新快照为\s*s3/);
    assert.equal(dispatchedCalls.length, countBeforeStale);

    // 5. Unadvertised perform_secondary_action returns ACTION_NOT_SUPPORTED; advertised case-normalizes
    const badSec = await client.request("tools/call", {
      name: "perform_secondary_action",
      arguments: { app: "com.apple.Notes", element_index: "@s3:1", action: "AXDelete" },
      source: "ai",
    });
    assert.equal(badSec.isError, true);
    assert.match(badSec.content[0].text, /\[ACTION_NOT_SUPPORTED\]/);

    const okSec = await client.request("tools/call", {
      name: "perform_secondary_action",
      arguments: { app: "com.apple.Notes", element_index: "@s3:1", action: "confirm" },
      source: "ai",
    });
    assert.equal(Boolean(okSec?.isError), false);
    assert.equal(dispatchedCalls.at(-1).name, "perform_secondary_action");
    assert.equal(dispatchedCalls.at(-1).args.action, "Confirm");

    // 6. Recycled PID generation mismatch rejects @s3:1 with STALE_REF
    processGeneration = "gen-2-restarted";
    const recycledRes = await client.request("tools/call", {
      name: "click",
      arguments: { app: "com.apple.Notes", element_index: "@s3:1" },
      source: "ai",
    });
    assert.equal(recycledRes.isError, true);
    assert.match(recycledRes.content[0].text, /ErrorCode:\s*STALE_REF/);

    const stateJson = await (
      await fetch(`http://127.0.0.1:${broker.webPort}/api/state?token=${token}`)
    ).json();
    assert.equal(stateJson.headlessStats.staleRefsBlocked >= 2, true);
    assert.equal(stateJson.recentActions.some((a) => a.type === "stale_ref"), true);
  } finally {
    await client.close();
    await broker.close();
  }
});

test("Headless AX fallbacks (AXSelectedText/AXScrollBar/AXShowMenu), set_value readback & secure masking, adaptive SelfActivationTracker, and permissions diagnostics", async () => {
  const sock = `/tmp/agy-cua-headless-${process.pid}.sock`;
  const token = "headless-token";
  let currentFront = { pid: 2222, bundleId: "com.google.antigravity", displayName: "Antigravity" };
  let fieldValue = "";
  let selectedTextMode = "succeed";
  const triedClickMethods = [];
  const typedTextCalls = [];

  const peer = {
    async listTools() {
      return {
        tools: [
          { name: "list_apps" },
          { name: "get_app_state" },
          { name: "click" },
          { name: "type_text" },
          { name: "scroll" },
          { name: "set_value" },
        ],
      };
    },
    async callTool(name, args) {
      if (name === "list_apps") {
        return {
          isError: false,
          content: [{ type: "text", text: "TextEdit — com.apple.TextEdit [running]" }],
        };
      }
      if (name === "get_app_state") {
        return {
          isError: false,
          content: [
            {
              type: "text",
              text: [
                `App=com.apple.TextEdit (pid ${process.pid})`,
                'Window: "Document", App: TextEdit.',
                `\t1 AXTextField Value: "${fieldValue}" ID: search_box`,
                '\t2 AXSecureTextField ID: secret_box',
              ].join("\n"),
            },
          ],
        };
      }
      if (name === "click") {
        triedClickMethods.push(args.click_method);
        if (args.click_method === "accessibility") {
          // Simulate self-activation ONLY when accessibility is called
          currentFront = { pid: process.pid, bundleId: "com.apple.TextEdit", displayName: "TextEdit" };
          return { isError: false, content: [{ type: "text", text: "ok" }] };
        }
        return { isError: true, content: [{ type: "text", text: "coordinate miss" }] };
      }
      if (name === "type_text") {
        typedTextCalls.push(args);
        return { isError: false, content: [{ type: "text", text: "ok" }] };
      }
      if (name === "scroll") {
        return { isError: true, content: [{ type: "text", text: "no scroll wheel target" }] };
      }
      if (name === "set_value") {
        if (String(args.element_index) === "1") {
          fieldValue = args.value;
        }
        return { isError: false, content: [{ type: "text", text: "ok" }] };
      }
      return { isError: false, content: [{ type: "text", text: "ok" }] };
    },
    close() {},
  };

  const broker = new ComputerUseBrokerServer({
    webPort: 0,
    uiToken: token,
    socketPath: sock,
    actionPeer: peer,
    streamPeer: peer,
    focusController: {
      async getFrontmostApp() {
        return currentFront;
      },
      async restoreFrontmostApp(pid) {
        currentFront = { pid, bundleId: "com.google.antigravity", displayName: "Antigravity" };
        return true;
      },
      sweepDelaysMs: [],
    },
    permissionsFn: async () => ({
      platform: "darwin",
      accessibility: false,
      screenRecording: true,
      checkedAt: Date.now(),
    }),
    selectedTextInsertFn: async (_pid, text) => {
      if (selectedTextMode === "succeed") {
        fieldValue = text;
        return { delivered: true, verified: true, reason: "ok" };
      }
      return { delivered: false, verified: false, reason: "not_settable" };
    },
    axScrollFallbackFn: async () => ({ delivered: true, verified: true, reason: "ok" }),
    contextMenuFallbackFn: async () => ({ delivered: true, verified: false, reason: "ok" }),
  });
  await broker.start();
  const client = new BrokerRpcClient({ socketPath: sock });

  try {
    // 1. Permissions endpoint & /api/state report missing Accessibility cleanly without OS prompt
    const state1 = await (
      await fetch(`http://127.0.0.1:${broker.webPort}/api/state?token=${token}`)
    ).json();
    assert.deepEqual(state1.permissions, {
      platform: "darwin",
      accessibility: false,
      screenRecording: true,
    });

    // 2. CJK type_text takes AXSelectedText fast-path first, then seamlessly falls back to sky_key
    await client.request("tools/call", {
      name: "get_app_state",
      arguments: { app: "com.apple.TextEdit" },
      source: "ai",
    });
    const axType = await client.request("tools/call", {
      name: "type_text",
      arguments: { app: "com.apple.TextEdit", text: "你好世界" },
      source: "ai",
    });
    assert.equal(Boolean(axType.isError), false);
    assert.match(axType.content[0].text, /Route: type_text:ax_selected_text/);
    assert.equal(typedTextCalls.length, 0);

    selectedTextMode = "fallback";
    const keyFallback = await client.request("tools/call", {
      name: "type_text",
      arguments: { app: "com.apple.TextEdit", text: "第二段" },
      source: "ai",
    });
    assert.equal(Boolean(keyFallback.isError), false);
    assert.equal(typedTextCalls.length, 1);
    assert.equal(typedTextCalls[0].key_method, "sky_key");

    // 3. scroll fallback to AXScrollBar marks delivered_verified
    const scrollRes = await client.request("tools/call", {
      name: "scroll",
      arguments: { app: "com.apple.TextEdit", element_index: "1", direction: "down", pages: 1 },
      source: "ai",
    });
    assert.equal(Boolean(scrollRes.isError), false);
    assert.match(scrollRes.content[0].text, /Route: scroll:ax_scrollbar/);
    assert.match(scrollRes.content[0].text, /delivered_verified/);

    // 4. right-click falls back to AXShowMenu when native right-click errors
    const rClickRes = await client.request("tools/call", {
      name: "click",
      arguments: { app: "com.apple.TextEdit", element_index: "1", mouse_button: "right" },
      source: "ai",
    });
    assert.equal(Boolean(rClickRes.isError), false);
    assert.match(rClickRes.content[0].text, /Route: click:ax_show_menu/);

    // 5. set_value normal readback verified & AXSecureTextField redacted in logs + response!
    const setNorm = await client.request("tools/call", {
      name: "set_value",
      arguments: { app: "com.apple.TextEdit", element_index: "1", value: "query123" },
      source: "ai",
    });
    assert.match(setNorm.content[0].text, /Delivery: delivered_verified/);

    const setSec = await client.request("tools/call", {
      name: "set_value",
      arguments: { app: "com.apple.TextEdit", element_index: "2", value: "MyUltraSecret99" },
      source: "ai",
    });
    const secAllText = setSec.content.map((c) => c.text || "").join("\n");
    assert.match(secAllText, /value redacted/);
    assert.equal(secAllText.includes("MyUltraSecret99"), false);
    assert.equal(secAllText.includes("TopSecretPwd"), false);

    // 6. Adaptive SelfActivationTracker learns from accessibility steal and blocks it next time!
    await client.request("tools/call", {
      name: "click",
      arguments: { app: "com.apple.TextEdit", element_index: "1", click_method: "accessibility" },
      source: "ai",
    });
    assert.deepEqual(triedClickMethods.slice(-3), ["sky_click", "app_post", "accessibility"]);

    triedClickMethods.length = 0;
    await client.request("tools/call", {
      name: "click",
      arguments: { app: "com.apple.TextEdit", element_index: "1", click_method: "accessibility" },
      source: "ai",
    });
    assert.deepEqual(triedClickMethods, ["sky_click", "app_post"]);

    const finalState = await (
      await fetch(`http://127.0.0.1:${broker.webPort}/api/state?token=${token}`)
    ).json();
    assert.equal(finalState.headlessStats.focusStealsPrevented >= 1, true);
    assert.equal(finalState.recentActions.some((a) => a.type === "focus_guard"), true);
    assert.equal(
      JSON.stringify(finalState.recentActions).includes("MyUltraSecret99"),
      false,
      "Secure text value must never appear in Mini-Window logs"
    );
  } finally {
    await client.close();
    await broker.close();
  }
});

test("Live AXUIElementRef pre-dispatch guard catches async background destruction, modal sheets, and layout shifts", async () => {
  const sock = `/tmp/agy-cua-liveax-${process.pid}.sock`;
  const boundSnapshots = [];
  let liveMode = "ok";
  let currentAxLine1 = "\t1 按钮 确定 ID: btn_ok";
  let clickCalls = 0;

  const peer = {
    async listTools() {
      return [];
    },
    async callTool(name) {
      if (name === "list_apps") {
        return {
          isError: false,
          content: [{ type: "text", text: "Demo — com.example.Demo [running]" }],
        };
      }
      if (name === "get_app_state") {
        return {
          isError: false,
          content: [
            {
              type: "text",
              text: [
                `App=com.example.Demo (pid ${process.pid})`,
                'Window: "Workspace", App: Demo.',
                currentAxLine1,
              ].join("\n"),
            },
          ],
        };
      }
      if (name === "click") {
        clickCalls += 1;
        return { isError: false, content: [{ type: "text", text: "ok" }] };
      }
      return { isError: false, content: [{ type: "text", text: "ok" }] };
    },
    close() {},
  };

  const mockAxBridge = {
    async bindSnapshot(payload) {
      boundSnapshots.push(payload.snapshotId);
      return { bound: true, snapshotId: payload.snapshotId };
    },
    async verifyLiveRef({ snapshotId, elementIndex }) {
      if (liveMode === "destroyed") {
        return {
          ok: false,
          reason: "element_destroyed_in_background",
          message: `Element @${snapshotId}:${elementIndex} was destroyed asynchronously in the background.`,
        };
      }
      if (liveMode === "modal") {
        return {
          ok: false,
          reason: "modal_sheet_appeared",
          message: `A modal dialog/sheet appeared asynchronously over the window after snapshot ${snapshotId}.`,
        };
      }
      if (liveMode === "moved_once") {
        liveMode = "ok";
        return {
          ok: false,
          moved: true,
          reason: "element_moved_in_background",
          message: `Element @${snapshotId}:${elementIndex} shifted position inside the window asynchronously.`,
        };
      }
      if (liveMode === "moved_shifted_index") {
        liveMode = "ok";
        currentAxLine1 = "\t1 按钮 顶部新横幅 ID: btn_banner";
        return {
          ok: false,
          moved: true,
          reason: "element_moved_in_background",
          message: `Element @${snapshotId}:${elementIndex} shifted position inside the window asynchronously.`,
        };
      }
      return { ok: true };
    },
    async dropSnapshots() {
      return { ok: true };
    },
    async close() {},
  };

  const broker = new ComputerUseBrokerServer({
    webPort: 0,
    uiToken: "liveax-tok",
    socketPath: sock,
    actionPeer: peer,
    streamPeer: peer,
    axBridge: mockAxBridge,
    focusController: {
      async getFrontmostApp() {
        return { pid: 2222, bundleId: "com.google.antigravity", displayName: "Antigravity" };
      },
      async restoreFrontmostApp() {
        return true;
      },
      sweepDelaysMs: [],
    },
  });
  await broker.start();
  const client = new BrokerRpcClient({ socketPath: sock });

  try {
    // 1. Async background element destruction between snapshots blocks @s1:1 BEFORE native click
    await client.request("tools/call", {
      name: "get_app_state",
      arguments: { app: "com.example.Demo" },
      source: "ai",
    });
    assert.deepEqual(boundSnapshots, ["s1"]);

    liveMode = "destroyed";
    const destroyedRes = await client.request("tools/call", {
      name: "click",
      arguments: { app: "com.example.Demo", element_index: "@s1:1" },
      source: "ai",
    });
    assert.equal(destroyedRes.isError, true);
    assert.match(destroyedRes.content[0].text, /ErrorCode: STALE_REF/);
    assert.match(destroyedRes.content[0].text, /destroyed asynchronously/);
    assert.equal(clickCalls, 0);

    // 2. Async modal sheet appearing over background window blocks even unpinned index "1"
    await client.request("tools/call", {
      name: "get_app_state",
      arguments: { app: "com.example.Demo" },
      source: "ai",
    });
    liveMode = "modal";
    const modalRes = await client.request("tools/call", {
      name: "click",
      arguments: { app: "com.example.Demo", element_index: "1" },
      source: "ai",
    });
    assert.equal(modalRes.isError, true);
    assert.match(modalRes.content[0].text, /ErrorCode: STALE_REF/);
    assert.match(modalRes.content[0].text, /modal dialog\/sheet/);
    assert.equal(clickCalls, 0);

    // 3. Layout shift on pinned @s3:1 strictly returns STALE_REF
    await client.request("tools/call", {
      name: "get_app_state",
      arguments: { app: "com.example.Demo" },
      source: "ai",
    });
    liveMode = "moved_once";
    const pinnedMoved = await client.request("tools/call", {
      name: "click",
      arguments: { app: "com.example.Demo", element_index: "@s3:1" },
      source: "ai",
    });
    assert.equal(pinnedMoved.isError, true);
    assert.match(pinnedMoved.content[0].text, /ErrorCode: STALE_REF/);
    assert.equal(clickCalls, 0);

    // 4. Layout shift on unpinned "1" with unchanged fingerprint auto-refreshes coordinates and clicks!
    await client.request("tools/call", {
      name: "get_app_state",
      arguments: { app: "com.example.Demo" },
      source: "ai",
    });
    liveMode = "moved_once";
    const unpinnedMovedOk = await client.request("tools/call", {
      name: "click",
      arguments: { app: "com.example.Demo", element_index: "1" },
      source: "ai",
    });
    assert.equal(Boolean(unpinnedMovedOk.isError), false);
    assert.equal(clickCalls, 1);

    // 5. Layout shift on unpinned "1" where a new banner replaced index #1 fails closed with STALE_REF!
    liveMode = "moved_shifted_index";
    const unpinnedShiftedBanner = await client.request("tools/call", {
      name: "click",
      arguments: { app: "com.example.Demo", element_index: "1" },
      source: "ai",
    });
    assert.equal(unpinnedShiftedBanner.isError, true);
    assert.match(unpinnedShiftedBanner.content[0].text, /ErrorCode: STALE_REF/);
    assert.equal(clickCalls, 1, "Must NOT click the newly inserted banner at index #1");
  } finally {
    await client.close();
    await broker.close();
  }
});

test("Electron AXManualAccessibility lazy wake-up populates DOM AX tree on cold start and memoizes per process generation", async () => {
  const sock = `/tmp/agy-cua-electron-${process.pid}.sock`;
  let manualAxEnabled = false;
  let wakeCalls = 0;
  let procGen = "6100:1001";

  const peer = {
    async listTools() {
      return [];
    },
    async callTool(name) {
      if (name === "list_apps") {
        return {
          isError: false,
          content: [{ type: "text", text: "Slack — com.tinyspeck.slackmacgap [running]" }],
        };
      }
      if (name === "get_app_state") {
        const lines = [
          "App=com.tinyspeck.slackmacgap (pid 6100)",
          'Window: "Slack - General", App: Slack.',
          "\t1 AXWindow Slack",
        ];
        if (manualAxEnabled) {
          lines.push("\t10 按钮 发送消息 ID: send_btn");
          lines.push('\t11 文本框 Value: "" ID: msg_input');
        }
        return { isError: false, content: [{ type: "text", text: lines.join("\n") }] };
      }
      if (name === "query") {
        return {
          isError: false,
          content: [
            {
              type: "text",
              text: JSON.stringify({
                matches: manualAxEnabled
                  ? [{ index: 10, role: "按钮", title: "发送消息", identifier: "send_btn" }]
                  : [],
              }),
            },
          ],
        };
      }
      return { isError: false, content: [{ type: "text", text: "ok" }] };
    },
    close() {},
  };

  const broker = new ComputerUseBrokerServer({
    webPort: 0,
    uiToken: "elec-tok",
    socketPath: sock,
    actionPeer: peer,
    streamPeer: peer,
    processIdentityFn: async (pid) => ({ pid, processToken: procGen }),
    rendererAccessibilityFn: async () => {
      wakeCalls += 1;
      if (!manualAxEnabled) {
        manualAxEnabled = true;
        return { supported: true, changed: true, enabled: true };
      }
      return { supported: true, changed: false, enabled: true };
    },
    focusController: {
      async getFrontmostApp() {
        return { pid: 2222, bundleId: "com.google.antigravity", displayName: "Antigravity" };
      },
      async restoreFrontmostApp() {
        return true;
      },
      sweepDelaysMs: [],
    },
  });
  await broker.start();
  const client = new BrokerRpcClient({ socketPath: sock });

  try {
    // 1. Cold-start get_app_state wakes AXManualAccessibility and returns full DOM AX controls in s1!
    const snap1 = await client.request("tools/call", {
      name: "get_app_state",
      arguments: { app: "com.tinyspeck.slackmacgap" },
      source: "ai",
    });
    const text1 = extractResultText(snap1);
    assert.match(text1, /\[Snapshot: s1\b/);
    assert.match(text1, /10 按钮 发送消息/);
    assert.equal(wakeCalls, 1);

    // 2. Subsequent get_app_state & query on the same process generation are memoized (no redundant wake)
    await client.request("tools/call", {
      name: "get_app_state",
      arguments: { app: "com.tinyspeck.slackmacgap" },
      source: "ai",
    });
    await client.request("tools/call", {
      name: "query",
      arguments: { app: "com.tinyspeck.slackmacgap", text: "发送" },
      source: "ai",
    });
    assert.equal(wakeCalls, 1);

    // 3. When Electron app restarts with a new processToken, AXManualAccessibility wakes again!
    manualAxEnabled = false;
    procGen = "6100:2002";
    const snapAfterRestart = await client.request("tools/call", {
      name: "get_app_state",
      arguments: { app: "com.tinyspeck.slackmacgap" },
      source: "ai",
    });
    assert.match(extractResultText(snapAfterRestart), /10 按钮 发送消息/);
    assert.equal(wakeCalls, 2);
  } finally {
    await client.close();
    await broker.close();
  }
});

test("Identifier-free AXShowMenu / AXScrollBar & adaptive set_value sky_bypass stop Qt set_value focus theft", async () => {
  const sock = `/tmp/agy-cua-qtsetval-${process.pid}.sock`;
  let currentFront = { pid: 2222, bundleId: "com.google.antigravity", displayName: "Antigravity" };
  let subtitleValue = "旧字幕";
  let nativeSetValueCalls = 0;
  let focusRestoreCalls = 0;
  const peerLog = [];
  const bridgeHandleCalls = [];

  const peer = {
    async listTools() {
      return [];
    },
    async callTool(name, args = {}) {
      peerLog.push({ name, args });
      if (name === "list_apps") {
        return {
          isError: false,
          content: [{ type: "text", text: "剪映专业版 — com.lemon.lvpro [running]" }],
        };
      }
      if (name === "get_app_state") {
        return {
          isError: false,
          content: [
            {
              type: "text",
              text: [
                `App=com.lemon.lvpro (pid ${process.pid})`,
                'Window: "草稿工程", App: 剪映专业版.',
                `\t1 AXTextField Value: "${subtitleValue}"`,
                "\t2 AXSecureTextField",
                "\t3 按钮 轨道片段 Secondary Actions: AXPress, AXShowMenu",
              ].join("\n"),
            },
          ],
        };
      }
      if (name === "click") {
        if ((args.mouse_button || "left") === "right") {
          return { isError: true, content: [{ type: "text", text: "right click unsupported" }] };
        }
        return { isError: false, content: [{ type: "text", text: "ok" }] };
      }
      if (name === "scroll") {
        return { isError: true, content: [{ type: "text", text: "wheel unsupported" }] };
      }
      if (name === "press_key") {
        if (args.key === "BackSpace") {
          subtitleValue = "";
        }
        return { isError: false, content: [{ type: "text", text: "ok" }] };
      }
      if (name === "type_text") {
        subtitleValue += String(args.text || "");
        return { isError: false, content: [{ type: "text", text: "ok" }] };
      }
      if (name === "set_value") {
        nativeSetValueCalls += 1;
        // Simulate Qt/剪映 calling activateIgnoringOtherApps inside AXValue setter!
        currentFront = { pid: process.pid, bundleId: "com.lemon.lvpro", displayName: "剪映专业版" };
        if (String(args.element_index) === "1") {
          subtitleValue = String(args.value || "");
        }
        return { isError: false, content: [{ type: "text", text: "ok" }] };
      }
      return { isError: false, content: [{ type: "text", text: "ok" }] };
    },
    close() {},
  };

  const mockAxBridge = {
    async bindSnapshot() {
      return { bound: true };
    },
    async verifyLiveRef() {
      return { ok: true };
    },
    async triggerContextMenu(pid, payload) {
      bridgeHandleCalls.push({ op: "context_menu", pid, ...payload });
      return { delivered: true, verified: true, reason: "ok" };
    },
    async scroll(pid, payload) {
      bridgeHandleCalls.push({ op: "scroll", pid, ...payload });
      return { delivered: true, verified: true, reason: "ok" };
    },
    async dropSnapshots() {
      return { ok: true };
    },
    async close() {},
  };

  const broker = new ComputerUseBrokerServer({
    webPort: 0,
    uiToken: "qt-tok",
    socketPath: sock,
    actionPeer: peer,
    streamPeer: peer,
    axBridge: mockAxBridge,
    focusController: {
      async getFrontmostApp() {
        return currentFront;
      },
      async restoreFrontmostApp(pid) {
        focusRestoreCalls += 1;
        currentFront = { pid, bundleId: "com.google.antigravity", displayName: "Antigravity" };
        return true;
      },
      sweepDelaysMs: [],
    },
  });
  await broker.start();
  const client = new BrokerRpcClient({ socketPath: sock });

  try {
    await client.request("tools/call", {
      name: "get_app_state",
      arguments: { app: "com.lemon.lvpro" },
      source: "ai",
    });

    // 1. Element #3 has NO AXIdentifier -> right-click & scroll still succeed via retained snapshot handle!
    const ctxClick = await client.request("tools/call", {
      name: "click",
      arguments: { app: "com.lemon.lvpro", element_index: "3", mouse_button: "right" },
      source: "ai",
    });
    assert.equal(Boolean(ctxClick.isError), false);
    assert.match(ctxClick.content[0].text, /Route: click:ax_show_menu/);
    assert.equal(bridgeHandleCalls[0].elementIndex, "3");
    assert.equal(bridgeHandleCalls[0].elementMeta.identifier, null);

    const scr = await client.request("tools/call", {
      name: "scroll",
      arguments: { app: "com.lemon.lvpro", element_index: "3", direction: "down", pages: 1 },
      source: "ai",
    });
    assert.equal(Boolean(scr.isError), false);
    assert.match(scr.content[0].text, /Route: scroll:ax_scrollbar/);
    assert.equal(bridgeHandleCalls[1].elementIndex, "3");

    // 2. First set_value runs set_value:native, Focus-Steal Guard catches Qt self-activation & records route
    const set1 = await client.request("tools/call", {
      name: "set_value",
      arguments: { app: "com.lemon.lvpro", element_index: "1", value: "第一段字幕" },
      source: "ai",
    });
    assert.equal(Boolean(set1.isError), false);
    assert.match(set1.content[0].text, /Route: set_value:native/);
    assert.equal(nativeSetValueCalls, 1);
    assert.equal(focusRestoreCalls, 1);
    assert.equal(currentFront.pid, 2222);

    // 3. Second set_value automatically switches to set_value:sky_bypass -> ZERO set_value call & ZERO focus steal!
    peerLog.length = 0;
    const set2 = await client.request("tools/call", {
      name: "set_value",
      arguments: { app: "com.lemon.lvpro", element_index: "1", value: "第二段字幕" },
      source: "ai",
    });
    assert.equal(Boolean(set2.isError), false);
    assert.match(set2.content[0].text, /Route: set_value:sky_bypass/);
    assert.match(set2.content[0].text, /Delivery: delivered_verified/);
    assert.equal(subtitleValue, "第二段字幕");
    assert.equal(nativeSetValueCalls, 1, "Second set_value must NOT call native set_value");
    assert.equal(focusRestoreCalls, 1, "Second set_value must cause ZERO focus theft");
    assert.equal(
      peerLog.some((c) => c.name === "click" && c.args.click_method === "sky_click"),
      true
    );
    assert.equal(
      peerLog.some((c) => c.name === "type_text" && c.args.key_method === "sky_key" && c.args.text === "第二段字幕"),
      true
    );

    // 4. Secure password field (#2) NEVER routes secret characters over sky_key!
    peerLog.length = 0;
    const setPwd = await client.request("tools/call", {
      name: "set_value",
      arguments: { app: "com.lemon.lvpro", element_index: "2", value: "NeverViaSkyKey88" },
      source: "ai",
    });
    assert.equal(Boolean(setPwd.isError), false);
    assert.equal(nativeSetValueCalls, 2);
    assert.equal(
      peerLog.some((c) => c.name === "type_text"),
      false,
      "AXSecureTextField must NEVER send password via sky_key"
    );
  } finally {
    await client.close();
    await broker.close();
  }
});

test("set_value sky_bypass aborts before cmd+a/BackSpace when focus misses editable field, sanitizes single-line newlines, and cold query preserves indexes & redacts secure fields", async () => {
  const sock = `/tmp/agy-cua-safety-${process.pid}.sock`;
  let currentFront = { pid: 2222, bundleId: "com.google.antigravity", displayName: "Antigravity" };
  let focusCheckResult = { editable: false, singleLine: false, reason: "focused_role_not_editable:AXGroup" };
  let wakeAttempts = 0;
  let transientWakeDone = false;
  const peerCalls = [];

  const peer = {
    async listTools() {
      return [];
    },
    async callTool(name, args = {}) {
      peerCalls.push({ name, args });
      if (name === "list_apps") {
        // Deliberately omit PID in list_apps (real OpenComputerUse list_apps has no PID)
        return {
          isError: false,
          content: [{ type: "text", text: "剪映专业版 — com.lemon.lvpro [running]" }],
        };
      }
      if (name === "query") {
        return {
          isError: false,
          content: [
            {
              type: "text",
              text: JSON.stringify({
                window_title: "主编辑窗口",
                matches: [
                  {
                    index: 42,
                    role: "AXTextField",
                    title: "字幕内容",
                    value: "原始文案",
                  },
                  {
                    index: 43,
                    role: "secure text field",
                    title: "云端密钥",
                    value: "sk-live-do-not-leak-777",
                    help: "Secret API Token",
                  },
                  {
                    index: 44,
                    role: "按钮",
                    title: "导出工程",
                    value: null,
                    secondary_actions: ["AXPress", "AXShowMenu"],
                  },
                ],
              }),
            },
          ],
        };
      }
      if (name === "get_app_state") {
        return {
          isError: false,
          content: [
            {
              type: "text",
              text: [
                `App=com.lemon.lvpro (pid ${process.pid})`,
                'Window: "主编辑窗口", App: 剪映专业版.',
                '\t42 AXTextField Value: "第一行 第二行"',
                "\t43 secure text field",
                "\t44 按钮 导出工程 Secondary Actions: AXPress, AXShowMenu",
              ].join("\n"),
            },
          ],
        };
      }
      if (name === "set_value") {
        currentFront = { pid: process.pid, bundleId: "com.lemon.lvpro", displayName: "剪映专业版" };
        return { isError: false, content: [{ type: "text", text: "ok" }] };
      }
      return { isError: false, content: [{ type: "text", text: "ok" }] };
    },
    close() {},
  };

  const boundSnapshots = [];
  const mockAxBridge = {
    async bindSnapshot(payload) {
      boundSnapshots.push(payload);
      return { bound: true };
    },
    async verifyLiveRef() {
      return { ok: true };
    },
    async dropSnapshots() {
      return { ok: true };
    },
    async close() {},
  };

  const broker = new ComputerUseBrokerServer({
    webPort: 0,
    uiToken: "safe-tok",
    socketPath: sock,
    actionPeer: peer,
    streamPeer: peer,
    axBridge: mockAxBridge,
    runningAppIdentityFn: async () => ({
      pid: process.pid,
      bundleId: "com.lemon.lvpro",
      displayName: "剪映专业版",
      processToken: `${process.pid}:5000`,
    }),
    processIdentityFn: async (pid) => ({ pid, processToken: `${pid}:5000` }),
    rendererAccessibilityFn: async () => {
      wakeAttempts += 1;
      if (!transientWakeDone) {
        transientWakeDone = true;
        return { supported: false, changed: false, enabled: false, definitive: false, code: -25204 };
      }
      return { supported: true, changed: false, enabled: true, definitive: true, code: 0 };
    },
    editableFocusFn: async () => focusCheckResult,
    focusController: {
      async getFrontmostApp() {
        return currentFront;
      },
      async restoreFrontmostApp(pid) {
        currentFront = { pid, bundleId: "com.google.antigravity", displayName: "Antigravity" };
        return true;
      },
      sweepDelaysMs: [],
    },
  });
  await broker.start();
  const client = new BrokerRpcClient({ socketPath: sock });

  try {
    // 1. Cold `query` resolves PID via runningAppIdentityFn, attempts wake (transient failure not memoized),
    //    populates button rawText from title, and redacts "secure text field" from snapshot metadata!
    const qRes = await client.request("tools/call", {
      name: "query",
      arguments: { app: "剪映专业版", text: "导出" },
      source: "ai",
    });
    assert.equal(Boolean(qRes.isError), false);
    assert.equal(wakeAttempts, 1);
    assert.equal(boundSnapshots.length, 1);
    const boundSec = boundSnapshots[0].elements.get("43");
    const boundBtn = boundSnapshots[0].elements.get("44");
    assert.equal(boundSec.rawText, "[redacted]");
    assert.equal(JSON.stringify(boundSec).includes("sk-live-do-not-leak-777"), false);
    assert.equal(boundBtn.rawText, "导出工程");

    // 2. Clicking `@s1:44` right after cold `query` does NOT call a pre-warm `get_app_state` before `click`!
    peerCalls.length = 0;
    const clickAfterQuery = await client.request("tools/call", {
      name: "click",
      arguments: { app: "剪映专业版", element_index: "@s1:44" },
      source: "ai",
    });
    assert.equal(Boolean(clickAfterQuery.isError), false);
    const firstClickIdx = peerCalls.findIndex((c) => c.name === "click");
    const preClickGetStateIdx = peerCalls.findIndex(
      (c, idx) => idx < firstClickIdx && c.name === "get_app_state"
    );
    assert.ok(firstClickIdx >= 0);
    assert.equal(
      preClickGetStateIdx,
      -1,
      "Must NOT overwrite actionPeer query index table with pre-warm get_app_state before click"
    );
    // Post-action read_back runs in strict observationalOnly mode (no AX write during read-back).
    assert.equal(wakeAttempts, 1);

    // Explicit non-observational get_app_state retries rendererAccessibilityFn because the 1st wake was transient (`definitive: false`).
    const explicitStateRes = await client.request("tools/call", {
      name: "get_app_state",
      arguments: { app: "剪映专业版", include_ax: true, include_screenshot: false },
      source: "ai",
    });
    assert.equal(Boolean(explicitStateRes.isError), false);
    assert.equal(wakeAttempts, 2);

    // 3. First set_value triggers route steal recording (`set_value:native`)
    await client.request("tools/call", {
      name: "set_value",
      arguments: { app: "剪映专业版", element_index: "42", value: "首次写入" },
      source: "ai",
    });

    // 4. Second set_value when focus missed editable field (`editable: false`) MUST NOT send cmd+a or BackSpace!
    peerCalls.length = 0;
    focusCheckResult = { editable: false, singleLine: false, reason: "focused_timeline_clip" };
    const setMissedFocus = await client.request("tools/call", {
      name: "set_value",
      arguments: { app: "剪映专业版", element_index: "42", value: "危险测试" },
      source: "ai",
    });
    assert.equal(Boolean(setMissedFocus.isError), false);
    assert.equal(
      peerCalls.some((c) => c.name === "press_key"),
      false,
      "Must NEVER send cmd+a or BackSpace when focus did not land on an editable text control!"
    );

    // 5. Third set_value when focus IS on single-line AXTextField (`editable: true, singleLine: true`)
    //    uses sky_bypass AND strips `\r\n` so sky_key never submits a form via Return!
    peerCalls.length = 0;
    focusCheckResult = { editable: true, singleLine: true, role: "AXTextField" };
    const setSingleLine = await client.request("tools/call", {
      name: "set_value",
      arguments: { app: "剪映专业版", element_index: "42", value: "第一行\n第二行" },
      source: "ai",
    });
    assert.equal(Boolean(setSingleLine.isError), false);
    assert.match(setSingleLine.content[0].text, /Route: set_value:sky_bypass/);
    const typedCall = peerCalls.find((c) => c.name === "type_text");
    assert.ok(typedCall);
    assert.equal(typedCall.args.text, "第一行 第二行");
  } finally {
    await client.close();
    await broker.close();
  }
});

test("Adaptive sky_click / sky_key blacklist stops repeated click:sky_click focus steals via window_post & window_key across app aliases", async () => {
  const sock = `/tmp/agy-cua-skyblock-${process.pid}.sock`;
  const token = "skyblock-token";
  const miniJpeg = Buffer.from([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x03, 0x23, 0x05, 0x00, 0x01, 0x01, 0x11, 0x00,
    0xff, 0xd9,
  ]).toString("base64");

  let currentFront = { pid: 82290, bundleId: "com.google.antigravity", displayName: "Antigravity" };
  let focusSteals = 0;
  let activeTab = "素材";
  const peerCalls = [];
  const windowClickCalls = [];
  const windowKeyCalls = [];
  const windowTextCalls = [];

  const peer = {
    async listTools() {
      return { tools: [] };
    },
    async callTool(name, args) {
      peerCalls.push({ name, args });
      if (name === "list_apps") {
        return {
          isError: false,
          content: [{ type: "text", text: "剪映专业版 — com.lemon.lvpro [running]" }],
        };
      }
      if (name === "get_app_state") {
        return {
          isError: false,
          content: [
            {
              type: "text",
              text: [
                `App=com.lemon.lvpro (pid ${process.pid})`,
                'Window: "剪映专业版", App: 剪映专业版.',
                `\t1 按钮 音频 (${activeTab})`,
              ].join("\n"),
            },
            { type: "image", mimeType: "image/jpeg", data: miniJpeg },
          ],
        };
      }
      if (name === "click") {
        if (args.click_method === "sky_click") {
          // Simulate Qt6 self-activating its window when SkyLight posts synthetic 0x0d AppActivated
          currentFront = { pid: process.pid, bundleId: "com.lemon.lvpro", displayName: "剪映专业版" };
          activeTab = "音频";
        }
        return { isError: false, content: [{ type: "text", text: "ok" }] };
      }
      if (name === "press_key" || name === "type_text") {
        if (args.key_method === "sky_key") {
          currentFront = { pid: process.pid, bundleId: "com.lemon.lvpro", displayName: "剪映专业版" };
        }
        return { isError: false, content: [{ type: "text", text: "ok" }] };
      }
      return { isError: false, content: [{ type: "text", text: "ok" }] };
    },
    close() {},
  };

  const broker = new ComputerUseBrokerServer({
    webPort: 0,
    uiToken: token,
    socketPath: sock,
    actionPeer: peer,
    streamPeer: peer,
    focusController: {
      async getFrontmostApp() {
        return currentFront;
      },
      async restoreFrontmostApp(pid) {
        focusSteals += 1;
        currentFront = { pid, bundleId: "com.google.antigravity", displayName: "Antigravity" };
        return true;
      },
      sweepDelaysMs: [],
    },
    processIdentityFn: async (pid) => ({ alive: true, guiApp: true, pid, processToken: `${pid}:sky` }),
    rendererAccessibilityFn: async () => ({ supported: false, changed: false, enabled: false, definitive: true }),
    windowClickFn: async (pid, opts) => {
      windowClickCalls.push({ pid, opts });
      activeTab = "文本";
      if (opts.x === 888) {
        // Simulate a QQuickWidget dialog button that self-activates even on window_post (SLEventPostToPid)
        currentFront = { pid: process.pid, bundleId: "com.lemon.lvpro", displayName: "剪映专业版" };
      }
      return { delivered: true, wid: 31327, localX: opts.x ?? 492, localY: opts.y ?? 52 };
    },
    windowKeyFn: async (pid, key, opts) => {
      windowKeyCalls.push({ pid, key, opts });
      if (key === "fn+BackSpace") {
        return { delivered: false, reason: "unsupported_key" };
      }
      return { delivered: true, wid: 31327 };
    },
    windowTextFn: async (pid, text, opts) => {
      windowTextCalls.push({ pid, text, opts });
      return { delivered: true, wid: 31327 };
    },
  });
  await broker.start();
  const client = new BrokerRpcClient({ socketPath: sock });

  try {
    // 1. First click (addressed by Chinese display name) tries sky_click -> Focus-Steal Guard catches it & records steal
    const c1 = await client.request("tools/call", {
      name: "click",
      arguments: { app: "剪映专业版", x: 450, y: 52 },
      source: "ai",
    });
    assert.equal(Boolean(c1.isError), false);
    assert.equal(focusSteals, 1);
    assert.match(extractResultText(c1), /Route: click:sky_click/);

    // 2. Second click (even when addressed by bundleId + explicit click_method: "sky_click"!)
    //    MUST skip sky_click completely, route via click:window_post, and cause ZERO focus steals!
    peerCalls.length = 0;
    const c2 = await client.request("tools/call", {
      name: "click",
      arguments: { app: "com.lemon.lvpro", x: 492, y: 52, click_method: "sky_click" },
      source: "ai",
    });
    assert.equal(Boolean(c2.isError), false);
    assert.equal(focusSteals, 1, "Subsequent click must NOT steal focus again");
    assert.equal(
      peerCalls.some((c) => c.name === "click"),
      false,
      "Blocked sky_click must be served by window_post without calling native sky_click"
    );
    assert.equal(windowClickCalls.length, 1);
    assert.equal(windowClickCalls[0].opts.x, 492);
    assert.equal(windowClickCalls[0].opts.y, 52);
    assert.equal(windowClickCalls[0].opts.frameWidth, 1280);
    assert.equal(windowClickCalls[0].opts.frameHeight, 803);
    assert.match(extractResultText(c2), /Route: click:window_post/);
    assert.match(extractResultText(c2), /Requested: click:sky_click/);
    assert.match(extractResultText(c2), /Delivery: delivered_verified/);

    // 3. click:sky_click MUST NOT cross-blacklist press_key / type_text;
    //    once press_key:sky_key & type_text:sky_key themselves steal focus on this scope, subsequent calls switch to window_key!
    peerCalls.length = 0;
    const k0 = await client.request("tools/call", {
      name: "press_key",
      arguments: { app: "剪映专业版", key: "space" },
      source: "ai",
    });
    assert.equal(Boolean(k0.isError), false);
    assert.equal(focusSteals, 2, "First press_key tries sky_key because click steal does not cross-blacklist keyboard");
    assert.match(extractResultText(k0), /Route: press_key:sky_key/);

    peerCalls.length = 0;
    const k1 = await client.request("tools/call", {
      name: "press_key",
      arguments: { app: "剪映专业版", key: "space" },
      source: "ai",
    });
    assert.equal(Boolean(k1.isError), false);
    assert.equal(focusSteals, 2, "press_key via window_key must cause ZERO focus steals");
    assert.equal(peerCalls.some((c) => c.name === "press_key"), false);
    assert.equal(windowKeyCalls.length, 1);
    assert.equal(windowKeyCalls[0].key, "space");
    assert.match(extractResultText(k1), /Route: press_key:window_key/);

    peerCalls.length = 0;
    const t0 = await client.request("tools/call", {
      name: "type_text",
      arguments: { app: "com.lemon.lvpro", text: "Hello 剪映" },
      source: "ai",
    });
    assert.equal(Boolean(t0.isError), false);
    assert.equal(focusSteals, 3, "First type_text tries sky_key before learning type_text steal");
    assert.match(extractResultText(t0), /Route: type_text:sky_key/);

    peerCalls.length = 0;
    const t1 = await client.request("tools/call", {
      name: "type_text",
      arguments: { app: "com.lemon.lvpro", text: "Hello 剪映" },
      source: "ai",
    });
    assert.equal(Boolean(t1.isError), false);
    assert.equal(focusSteals, 3, "type_text via window_key must cause ZERO focus steals");
    assert.equal(peerCalls.some((c) => c.name === "type_text"), false);
    assert.equal(windowTextCalls.length, 1);
    assert.equal(windowTextCalls[0].text, "Hello 剪映");
    assert.match(extractResultText(t1), /Route: type_text:window_key/);

    // 4. Fatal unsupported_key from window_key must fail closed without falling back to focus-stealing sky_key
    peerCalls.length = 0;
    const badKeyRes = await client.request("tools/call", {
      name: "press_key",
      arguments: { app: "com.lemon.lvpro", key: "fn+BackSpace" },
      source: "ai",
    });
    assert.equal(Boolean(badKeyRes.isError), true);
    assert.equal(
      peerCalls.some((c) => c.name === "press_key"),
      false,
      "Fatal unsupported_key must NOT fall back to native sky_key"
    );

    // 5. Direction A: if a QQuickWidget dialog button inside 剪映 triggers self-activation on window_post,
    //    focus_guard pulls focus back immediately AND window_post is NEVER permanently banned or downgraded to app_post!
    peerCalls.length = 0;
    windowClickCalls.length = 0;
    const qmlDialogClick = await client.request("tools/call", {
      name: "click",
      arguments: { app: "com.lemon.lvpro", x: 888, y: 120 },
      source: "ai",
    });
    assert.equal(Boolean(qmlDialogClick.isError), false);
    assert.equal(focusSteals, 4, "focus_guard must pull focus back when QQuickWidget dialog self-activates");
    assert.match(extractResultText(qmlDialogClick), /Route: click:window_post/);

    // Subsequent auto click AND explicit click_method: "window_post" MUST stay on window_post (never app_post!)
    peerCalls.length = 0;
    windowClickCalls.length = 0;
    const nextQmlClick = await client.request("tools/call", {
      name: "click",
      arguments: { app: "剪映专业版", x: 510, y: 64 },
      source: "ai",
    });
    assert.equal(Boolean(nextQmlClick.isError), false);
    assert.equal(
      peerCalls.some((c) => c.name === "click"),
      false,
      "Subsequent click must NOT downgrade from window_post to native app_post"
    );
    assert.equal(windowClickCalls.length, 1);
    assert.match(extractResultText(nextQmlClick), /Route: click:window_post/);

    const explicitWinPostClick = await client.request("tools/call", {
      name: "click",
      arguments: { app: "com.lemon.lvpro", x: 520, y: 64, click_method: "window_post" },
      source: "ai",
    });
    assert.equal(Boolean(explicitWinPostClick.isError), false);
    assert.equal(windowClickCalls.length, 2);
    assert.match(extractResultText(explicitWinPostClick), /Route: click:window_post/);
  } finally {
    await client.close();
    await broker.close();
  }
});

test("Rapid <80ms delayed focus steal caught by next call's #captureProtectedFrontmostApp records blacklist and restores across apps", async () => {
  const sock = `/tmp/agy-cua-rapidsteal-${process.pid}.sock`;
  const token = "test-rapid-steal-token";
  const miniJpeg = Buffer.from([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x03, 0x23, 0x05, 0x00, 0x01, 0x01, 0x11, 0x00,
    0xff, 0xd9,
  ]).toString("base64");
  let currentFront = {
    pid: 1111,
    bundleId: "com.google.antigravity",
    displayName: "Antigravity",
  };
  let restores = 0;
  const windowClickCalls = [];
  const peerClickCalls = [];

  const peer = {
    async listTools() {
      return [{ name: "get_app_state" }, { name: "click" }, { name: "list_apps" }];
    },
    async callTool(name, args) {
      if (name === "list_apps") {
        return {
          isError: false,
          content: [
            {
              type: "text",
              text: [
                "剪映专业版 — com.lemon.lvpro [running]",
                "TextEdit — com.apple.TextEdit [running]",
              ].join("\n"),
            },
          ],
        };
      }
      if (name === "get_app_state") {
        const isLv = /lvpro|剪映/iu.test(String(args.app));
        return {
          isError: false,
          content: [
            {
              type: "text",
              text: isLv
                ? [
                    "App=com.lemon.lvpro (pid 10038)",
                    'Window: "剪映专业版", App: 剪映专业版.',
                    "\t1 按钮 导出",
                  ].join("\n")
                : [
                    "App=com.apple.TextEdit (pid 20022)",
                    'Window: "未命名", App: TextEdit.',
                    "\t1 按钮 好",
                  ].join("\n"),
            },
            { type: "image", mimeType: "image/jpeg", data: miniJpeg },
          ],
        };
      }
      if (name === "click") {
        peerClickCalls.push(args);
        return { isError: false, content: [{ type: "text", text: "ok" }] };
      }
      return { isError: false, content: [{ type: "text", text: "ok" }] };
    },
    close() {},
  };

  const broker = new ComputerUseBrokerServer({
    webPort: 0,
    uiToken: token,
    socketPath: sock,
    actionPeer: peer,
    streamPeer: peer,
    focusController: {
      async getFrontmostApp() {
        return currentFront;
      },
      async restoreFrontmostApp(pid) {
        restores += 1;
        currentFront = { pid, bundleId: "com.google.antigravity", displayName: "Antigravity" };
        return true;
      },
      sweepDelaysMs: [400],
    },
    processIdentityFn: async (pid) => ({ alive: true, guiApp: true, pid, processToken: `${pid}:rapid` }),
    rendererAccessibilityFn: async () => ({ supported: false, changed: false, enabled: false, definitive: true }),
    windowClickFn: async (pid, opts) => {
      windowClickCalls.push({ pid, opts });
      return { delivered: true, wid: 31327, localX: 200, localY: 100 };
    },
  });
  await broker.start();
  const client = new BrokerRpcClient({ socketPath: sock });

  try {
    // 1. Click 1 on 剪映 finishes while frontmost is still Antigravity
    const r1 = await client.request("tools/call", {
      name: "click",
      arguments: { app: "com.lemon.lvpro", x: 10, y: 5 },
      source: "ai",
    });
    assert.equal(Boolean(r1.isError), false);
    assert.equal(restores, 0);

    // 15ms later (before the 400ms sweep timer fires!), macOS finishes bringing 剪映 to front
    currentFront = { pid: 10038, bundleId: "com.lemon.lvpro", displayName: "剪映专业版" };

    // 2. Immediately call a DIFFERENT app (TextEdit): #captureProtectedFrontmostApp must still recognize
    //    that guard.app ("com.lemon.lvpro") stole focus, restore Antigravity, AND record click:sky_click on 剪映!
    const r2 = await client.request("tools/call", {
      name: "get_app_state",
      arguments: { app: "com.apple.TextEdit" },
      source: "ai",
    });
    assert.equal(Boolean(r2.isError), false);
    assert.equal(restores, 1, "Cross-app call must restore Antigravity from delayed 剪映 steal");

    // 3. Next click on 剪映 MUST now have click:sky_click blacklisted and use click:window_post!
    peerClickCalls.length = 0;
    const r3 = await client.request("tools/call", {
      name: "click",
      arguments: { app: "剪映专业版", x: 12, y: 6 },
      source: "ai",
    });
    assert.equal(Boolean(r3.isError), false);
    assert.equal(peerClickCalls.length, 0, "sky_click must be blacklisted after rapid steal detection");
    assert.equal(windowClickCalls.length, 1);
    assert.match(extractResultText(r3), /Route: click:window_post/);
  } finally {
    await client.close();
    await broker.close();
  }
});
