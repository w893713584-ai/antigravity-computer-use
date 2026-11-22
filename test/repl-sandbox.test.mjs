import assert from "node:assert/strict";
import net from "node:net";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { ComputerUseBrokerServer } from "../src/broker-sidecar.mjs";
import { BrokerRpcClient } from "../src/broker-client.mjs";
import {
  REPL_MAX_RESULT_BYTES,
  REPL_MAX_SOURCE_BYTES,
  SCRIPT_RUNNER_APP_PATH,
  SCRIPT_RUNNER_BIN_PATH,
  SIDECAR_PILL_MARKDOWN,
} from "../src/constants.mjs";
import { verifyNativeAppBundle } from "../src/native-distribution.mjs";
import { truncateMcpResultTo256KiB } from "../src/repl-schema.mjs";
import { StrictReplSessionManager } from "../src/repl-runner.mjs";

function makeMinimalJpegBase64() {
  return Buffer.from([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x01, 0x00, 0x01, 0x00, 0x01, 0x01, 0x11, 0x00, 0xff,
    0xd9,
  ]).toString("base64");
}

function makeMockDesktopBrokerHarness() {
  let clickCount = 0;
  let queryCount = 0;
  let actCount = 0;
  const sock = path.join(tmpdir(), `cua-repl-test-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.sock`);
  const tinyJpg = makeMinimalJpegBase64();

  const peer = {
    async listTools() {
      return {
        tools: [
          { name: "list_apps" },
          { name: "get_app_state" },
          { name: "query" },
          { name: "click" },
          { name: "scroll" },
        ],
      };
    },
    async callTool(name, args = {}) {
      if (name === "list_apps") {
        return {
          isError: false,
          content: [{ type: "text", text: "Finder — com.apple.finder [running]" }],
        };
      }
      if (name === "get_app_state") {
        return {
          isError: false,
          content: [
            {
              type: "text",
              text: `App=com.apple.finder (pid ${process.pid})\nWindow: "Finder", App: Finder.\n0 AXWindow Finder\n\t1 AXButton 打开`,
            },
            { type: "image", mimeType: "image/jpeg", data: tinyJpg },
          ],
        };
      }
      if (name === "query") {
        queryCount += 1;
        return {
          isError: false,
          content: [
            {
              type: "text",
              text: JSON.stringify({
                window_id: 777,
                window_title: "Finder",
                truncated: false,
                stop_reason: "complete",
                matches: [
                  {
                    index: 1000001,
                    role: "AXButton",
                    title: args.text || "打开",
                    bounds: { x: 20, y: 20, w: 60, h: 24 },
                    window_id: 777,
                  },
                ],
              }),
            },
          ],
        };
      }
      if (name === "click") {
        clickCount += 1;
        return { isError: false, content: [{ type: "text", text: "ok" }] };
      }
      return { isError: false, content: [{ type: "text", text: "ok" }] };
    },
    close() {},
  };

  const fakeAx = {
    enabled: true,
    setSyntheticEventTag() {},
    async checkPermissions() {
      return { accessibility: true, screenRecording: true };
    },
    async findRunningApp() {
      return { alive: true, pid: process.pid, bundleId: "com.apple.finder", processToken: `${process.pid}:1` };
    },
    async getProcessInfo(pid) {
      return { alive: true, guiApp: true, pid, bundleId: "com.apple.finder", processToken: `${pid}:1` };
    },
    async ensureManualAccessibility() {
      return { supported: true, changed: false, enabled: true, definitive: true };
    },
    async resolveActionTarget(_pid, opts) {
      return {
        resolved: true,
        wid: 777,
        windowBounds: { x: 0, y: 0, w: 800, h: 600 },
        role: "AXButton",
        hasAxPress: true,
        hops: 0,
        localBounds: { x: 20, y: 20, w: 60, h: 24 },
        centerLocalPoint: opts?.localPoint || { x: 50, y: 32 },
      };
    },
    async postWindowClick() {
      clickCount += 1;
      actCount += 1;
      return { delivered: true, method: "window_post", wid: 777, localX: 50, localY: 32 };
    },
    async close() {},
  };

  const broker = new ComputerUseBrokerServer({
    webPort: 0,
    uiToken: "repl-test-tok",
    socketPath: sock,
    actionPeer: peer,
    streamPeer: peer,
    axBridge: fakeAx,
    launchHelperOnStart: false,
    permissionsFn: async () => ({ platform: "darwin", accessibility: true, screenRecording: true }),
    runningAppIdentityFn: async () => ({
      pid: process.pid,
      bundleId: "com.apple.finder",
      displayName: "Finder",
      processToken: `${process.pid}:1`,
    }),
    focusController: {
      async getFrontmostApp() {
        return { pid: 100, bundleId: "com.google.antigravity", displayName: "Antigravity" };
      },
      async restoreFrontmostApp() {
        return true;
      },
      sweepDelaysMs: [],
    },
  });

  return {
    sock,
    broker,
    getClickCount: () => clickCount,
    getQueryCount: () => queryCount,
    resetCounters: () => {
      clickCount = 0;
      queryCount = 0;
      actCount = 0;
    },
  };
}

test("Real CUAScriptRunner.app passes bundle signature + Seatbelt denial self-test on macOS", async () => {
  if (process.platform !== "darwin") return;
  const verification = await verifyNativeAppBundle(SCRIPT_RUNNER_APP_PATH, {
    role: "scriptRunner",
    skipSelfTest: false,
  });
  assert.equal(verification.ok, true, `CUAScriptRunner verification failed: ${JSON.stringify(verification)}`);
});

test("Hardened REPL persists var/let/const/session/app handles across turns, enforces lexical rules, and blocks eval/prototype pollution", async () => {
  const { sock, broker, getQueryCount, resetCounters } = makeMockDesktopBrokerHarness();
  await broker.start();
  const client = new BrokerRpcClient({ socketPath: sock, enableFallback: false });

  try {
    // 1. Bind var app + const + let + undefined + session across turns
    const t1 = await client.request("repl/run", {
      code: [
        `var app = await cua.getApp("com.apple.finder", { initialState: false });`,
        `const fixed = 42;`,
        `let counter = 10;`,
        `var undefVar = undefined;`,
        `session.note = "中文会话状态";`,
        `nodeRepl.write("turn1_ok");`,
      ].join("\n"),
    });
    assert.equal(t1.isError, false, JSON.stringify(t1));
    assert.equal(
      t1.content.some((c) => c.type === "text" && /Codex-Style Computer Use JavaScript API/.test(c.text)),
      true,
      `Expected once-per-session cua.core docs in turn 1: ${JSON.stringify(t1.content)}`
    );
    assert.equal(
      t1.content.some((c) => c.type === "text" && /turn1_ok/.test(c.text)),
      true,
      `Expected turn1_ok in turn 1: ${JSON.stringify(t1.content)}`
    );

    // 2. Next turn calls `cua.listApps` (must NOT re-emit `cua.core` docs), `app.query(...)`, mutates `let counter`, reads `const fixed`
    const t2 = await client.request("repl/run", {
      code: [
        `const apps = await cua.listApps({ emit: false });`,
        `const q = await app.query({ text: "打开" });`,
        `counter += fixed;`,
        `const shot = await app.getScreenshot({ emit: false });`,
        `await nodeRepl.emitImage(shot);`,
        `nodeRepl.write(JSON.stringify({ appCount: apps.length, matches: q.matches.length, counter, undefType: typeof undefVar, note: session.note, isU8: shot instanceof Uint8Array }));`,
      ].join("\n"),
    });
    assert.equal(t2.isError, false, JSON.stringify(t2));
    assert.equal(
      t2.content.some((c) => c.type === "text" && /Codex-Style Computer Use JavaScript API/.test(c.text)),
      false,
      "cua.core guidance must not repeat in subsequent turns of the same session"
    );
    assert.equal(t2.content.some((c) => c.type === "image"), true, "emitImage(Uint8Array) must produce image block");
    const parsedT2 = JSON.parse(t2.content.find((c) => c.type === "text" && c.text.startsWith("{")).text);
    assert.deepEqual(parsedT2, {
      appCount: 1,
      matches: 1,
      counter: 52,
      undefType: "undefined",
      note: "中文会话状态",
      isU8: true,
    });

    // 3. Re-declaring `const fixed` must fail SyntaxError BEFORE executing any desktop RPC!
    resetCounters();
    const t3 = await client.request("repl/run", {
      code: `const fixed = 99;\nawait app.query({ text: "打开" });`,
    });
    assert.equal(t3.isError, true);
    assert.match(t3.content[0].text, /already been declared/i);
    assert.equal(getQueryCount(), 0, "Declaration check error must fail BEFORE running any desktop RPC");

    // 4. Reassigning `const fixed = 99` throws TypeError and preserves prior bindings (`counter === 52`)
    const t4 = await client.request("repl/run", {
      code: `fixed = 99;`,
    });
    assert.equal(t4.isError, true);

    const t5 = await client.request("repl/run", {
      code: `nodeRepl.write(String(counter));`,
    });
    assert.equal(t5.isError, false);
    assert.equal(t5.content[0].text, "52");

    // 5. Primordials frozen, eval/Function/WebAssembly blocked, Node globals absent, no `app` act regression
    const secCheck = await client.request("repl/run", {
      code: [
        `let protoFrozen = false;`,
        `try { Object.prototype.pwn = 1; } catch (e) { protoFrozen = true; }`,
        `let cuaFrozen = false;`,
        `try { cua.getApp = null; } catch (e) { cuaFrozen = true; }`,
        `let evalDenied = false;`,
        `try { eval("1+1"); } catch (e) { evalDenied = true; }`,
        `let fnDenied = false;`,
        `try { new Function("return 1")(); } catch (e) { fnDenied = true; }`,
        `const actOut = await app.act({ target: { text: "打开" }, reveal: { max_scroll_steps: 0 }, expect: { any_text: ["打开"] }, timeout_ms: 1500 });`,
        `nodeRepl.write(JSON.stringify({ protoFrozen, cuaFrozen, evalDenied, fnDenied, wasmType: typeof WebAssembly, procType: typeof process, hasHome: "homeDir" in nodeRepl, actStatus: actOut.status }));`,
      ].join("\n"),
    });
    assert.equal(secCheck.isError, false, JSON.stringify(secCheck));
    const secJson = JSON.parse(secCheck.content[0].text);
    assert.deepEqual(secJson, {
      protoFrozen: true,
      cuaFrozen: true,
      evalDenied: true,
      fnDenied: true,
      wasmType: "undefined",
      procType: "undefined",
      hasHome: false,
      actStatus: "ok",
    });

    // 6. js_reset wipes bindings (`counter` no longer exists) and re-arms once-per-session cua.core docs
    const resetRes = await client.request("repl/reset", {});
    assert.equal(resetRes.isError, false);
    const afterReset = await client.request("repl/run", {
      code: `const apps = await cua.listApps({ emit: false });\nnodeRepl.write(typeof counter + ":" + apps.length);`,
    });
    assert.equal(afterReset.isError, false);
    assert.equal(
      afterReset.content.some((c) => c.type === "text" && /Codex-Style Computer Use JavaScript API/.test(c.text)),
      true,
      "repl/reset must re-arm once-per-session cua.core docs"
    );
    assert.equal(
      afterReset.content.some((c) => c.type === "text" && c.text === "undefined:1"),
      true,
      `Expected undefined:1 after reset, got: ${JSON.stringify(afterReset.content)}`
    );

    // 7. Source size (>64 KiB) & 32-call cap enforced
    const oversizedSrc = `var x = "${"a".repeat(REPL_MAX_SOURCE_BYTES + 100)}";`;
    const bigSrcRes = await client.request("repl/run", { code: oversizedSrc });
    assert.equal(bigSrcRes.isError, true);
    assert.match(bigSrcRes.content[0].text, /SOURCE_TOO_LARGE/);

    const tooManyCalls = await client.request("repl/run", {
      code: `for (let i = 0; i < 33; i++) { await cua.listApps({ emit: false }); }`,
    });
    assert.equal(tooManyCalls.isError, true);
    assert.match(tooManyCalls.content[0].text, /RPC_CALL_LIMIT_EXCEEDED/);
  } finally {
    await client.close();
    await broker.close();
  }
});

test("Hardened REPL enforces CPU watchdog, wall-clock timeout, takeover mid-script abort, disconnect wipe, and 256 KiB truncation", async () => {
  const { sock, broker, getClickCount, resetCounters } = makeMockDesktopBrokerHarness();
  await broker.start();
  const client = new BrokerRpcClient({ socketPath: sock, enableFallback: false });

  try {
    // 1. Seed a binding first
    const seedRes = await client.request("repl/run", { code: `var persistentVal = 123;` });
    assert.equal(seedRes.isError, false);

    // 2. Wall-clock timeout on unresolving Promise -> SIGKILLs child + wipes bindings + next call works cleanly!
    const waitRes = await client.request("repl/run", {
      code: `await new Promise(() => {});`,
      timeout_ms: 250,
    });
    assert.equal(waitRes.isError, true);
    assert.match(waitRes.content[0].text, /timed out/i);

    const afterTimeout = await client.request("repl/run", {
      code: `nodeRepl.write(typeof persistentVal);`,
    });
    assert.equal(afterTimeout.isError, false);
    assert.equal(afterTimeout.content[0].text, "undefined", "Timeout must wipe prior bindings");

    // 3. CPU tight loop `while(true){}` interrupted cleanly around 2s CPU limit even when timeout_ms=15000
    const cpuStart = Date.now();
    const cpuRes = await client.request("repl/run", {
      code: `while (true) {}`,
      timeout_ms: 15_000,
    });
    const cpuElapsed = Date.now() - cpuStart;
    assert.equal(cpuRes.isError, true);
    assert.ok(cpuElapsed < 6000, `CPU tight loop must terminate near 2s CPU limit, took ${cpuElapsed}ms`);

    // 4. Mid-script human takeover pauses running script BEFORE `app.click()` and avoids #actionQueue deadlock
    resetCounters();
    await client.request("repl/run", {
      code: `var finder = await cua.getApp("com.apple.finder", { initialState: false });`,
    });
    const scriptPromise = client.request("repl/run", {
      code: [
        `await finder.query({ text: "打开" });`,
        `await new Promise((r) => setTimeout(r, 150));`,
        `await finder.click(1);`,
      ].join("\n"),
      timeout_ms: 5000,
    });
    // Wait long enough for finder.query to finish and set target while sleeping before finder.click(1)
    await new Promise((r) => setTimeout(r, 60));
    broker.takeoverController.requestPause({
      reason: "emergency_hotkey",
      source: "hotkey",
      label: "人类急停中断脚本",
    });
    const abortedScriptRes = await scriptPromise;
    assert.equal(abortedScriptRes.isError, true);
    assert.match(abortedScriptRes.content[0].text, /PAUSED/);
    assert.equal(getClickCount(), 0, "Takeover mid-script must kill runner before reaching app.click()");

    // 5. Disconnect wipes per-connection REPL session
    const c2 = new BrokerRpcClient({ socketPath: sock, enableFallback: false });
    await broker.takeoverController.resume({ expectedPauseEpoch: broker.state.pauseEpoch });
    await c2.request("repl/run", { code: `var c2Only = "secret";` });
    await c2.close();
    const c3 = new BrokerRpcClient({ socketPath: sock, enableFallback: false });
    const c3Check = await c3.request("repl/run", { code: `nodeRepl.write(typeof c2Only);` });
    assert.equal(c3Check.content[0].text, "undefined", "Disconnect must drop prior connection bindings");
    await c3.close();

    // 6. Output crossing 256 KiB including image + UTF-8 multibyte text + pill hint clamps strictly <= 256 KiB
    const hugeText = "中".repeat(120_000); // ~360 KiB UTF-8
    const clamped = truncateMcpResultTo256KiB({
      isError: false,
      content: [
        { type: "text", text: hugeText },
        { type: "image", mimeType: "image/png", data: Buffer.alloc(100_000, 0x41).toString("base64") },
        { type: "text", text: SIDECAR_PILL_MARKDOWN },
      ],
    });
    const clampedBytes = Buffer.byteLength(JSON.stringify(clamped), "utf8");
    assert.ok(clampedBytes <= REPL_MAX_RESULT_BYTES, `Expected <= ${REPL_MAX_RESULT_BYTES}B, got ${clampedBytes}`);
    assert.match(JSON.stringify(clamped), /结果已截断/);
  } finally {
    await client.close();
    await broker.close();
  }
});

test("Fail-closed SANDBOX_UNAVAILABLE, AGY_CUA_JS=off, BROKER_UNAVAILABLE, and non-replayable repl/run", async () => {
  // 1. Missing CUAScriptRunner binary -> fail closed with SANDBOX_UNAVAILABLE while structured tools still work
  const sock = path.join(tmpdir(), `cua-failclosed-${process.pid}-${Date.now()}.sock`);
  const peer = {
    async listTools() {
      return { tools: [{ name: "list_apps" }] };
    },
    async callTool() {
      return { isError: false, content: [{ type: "text", text: "Finder — com.apple.finder [running]" }] };
    },
    close() {},
  };
  const brokenBroker = new ComputerUseBrokerServer({
    webPort: 0,
    socketPath: sock,
    actionPeer: peer,
    streamPeer: peer,
    axBridge: null,
    launchHelperOnStart: false,
    scriptRunnerBinPath: "/nonexistent/CUAScriptRunner-Missing",
  });
  await brokenBroker.start();
  const client = new BrokerRpcClient({ socketPath: sock, enableFallback: false });

  try {
    const jsRes = await client.request("repl/run", { code: `nodeRepl.write(1 + 1);` });
    assert.equal(jsRes.isError, true);
    assert.match(jsRes.content[0].text, /SANDBOX_UNAVAILABLE/);

    // Structured MCP list_apps remains unaffected!
    const structRes = await client.request("tools/call", {
      name: "list_apps",
      arguments: {},
      source: "ai",
    });
    assert.equal(structRes.isError, false);

    // Rollback env flag AGY_CUA_JS=off disables js cleanly
    const prevFlag = process.env.AGY_CUA_JS;
    process.env.AGY_CUA_JS = "off";
    try {
      const offRes = await client.request("repl/run", { code: `nodeRepl.write(1 + 1);` });
      assert.equal(offRes.isError, true);
      assert.match(offRes.content[0].text, /SANDBOX_DISABLED/);
    } finally {
      if (prevFlag === undefined) delete process.env.AGY_CUA_JS;
      else process.env.AGY_CUA_JS = prevFlag;
    }
  } finally {
    await client.close();
    await brokenBroker.close();
  }

  // 2. BrokerRpcClient default fails closed with BROKER_UNAVAILABLE when primary socket is missing
  const missingClient = new BrokerRpcClient({
    socketPath: path.join(tmpdir(), `cua-missing-${process.pid}-${Date.now()}.sock`),
  });
  assert.equal(missingClient.enableFallback, false);
  await assert.rejects(
    () => missingClient.request("tools/call", { name: "click", arguments: {} }),
    (err) => err?.code === "BROKER_UNAVAILABLE" && /BROKER_UNAVAILABLE/.test(err.message)
  );
  await missingClient.close();

  // 3. Disconnecting mid-flight on `repl/run` NEVER replays it
  const crashSock = path.join(tmpdir(), `cua-repl-noreplay-${process.pid}-${Date.now()}.sock`);
  let runsReceived = 0;
  const crashingServer = net.createServer((conn) => {
    conn.on("data", (d) => {
      if (String(d).includes('"repl/run"')) {
        runsReceived += 1;
        conn.destroy();
      }
    });
  });
  await new Promise((r) => crashingServer.listen(crashSock, r));
  const noReplayClient = new BrokerRpcClient({ socketPath: crashSock });
  try {
    await assert.rejects(
      () => noReplayClient.request("repl/run", { code: `nodeRepl.write(1);` }),
      /closed|ECONNRESET|EPIPE/i
    );
    assert.equal(runsReceived, 1, "Mutating repl/run must never replay after write");
  } finally {
    await noReplayClient.close();
    await new Promise((r) => crashingServer.close(r));
  }
});

test("Codex 6.2 regressions: REPL rolls back uncommitted handles on error and rejects STALE_APP_HANDLE after PID restart", async () => {
  if (process.platform !== "darwin") return;
  const { sock, broker, getQueryCount, resetCounters } = makeMockDesktopBrokerHarness();
  await broker.start();
  const client = new BrokerRpcClient({ socketPath: sock, enableFallback: false });
  try {
    const failedTurn = await client.request("repl/run", {
      code: `var tmpHandle = await cua.getApp("com.apple.finder"); throw new Error("boom");`,
    });
    assert.equal(failedTurn.isError, true);
    const verifyUncommitted = await client.request("repl/run", {
      code: `nodeRepl.write(typeof tmpHandle);`,
    });
    assert.equal(verifyUncommitted.isError, false);
    assert.match(verifyUncommitted.content[0].text, /undefined/);

    const t1 = await client.request("repl/run", {
      code: `var finderHandle = await cua.getApp("com.apple.finder"); nodeRepl.write(finderHandle.id);`,
    });
    assert.equal(t1.isError, false);

    // Simulate process restart in broker registry (different pid + processToken)
    broker.registry.recordMeta(
      "com.apple.finder",
      { pid: process.pid + 1000, bundleId: "com.apple.finder" },
      { processToken: `${process.pid + 1000}:999.0` }
    );
    resetCounters();

    const t2 = await client.request("repl/run", {
      code: `await finderHandle.query({ text: "Documents" });`,
    });
    assert.equal(t2.isError, true);
    assert.match(t2.content[0].text, /STALE_APP_HANDLE/);
    assert.equal(getQueryCount(), 0);
  } finally {
    await client.close();
    await broker.close();
  }
});
