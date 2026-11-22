#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { getFrontmostAppFast } from "../src/background-policy.mjs";
import { BrokerRpcClient } from "../src/broker-client.mjs";
import { ComputerUseBrokerServer } from "../src/broker-sidecar.mjs";
import {
  DESKTOP_HELPER_APP_PATH,
  DESKTOP_HELPER_BIN_PATH,
  SCRIPT_RUNNER_APP_PATH,
  SCRIPT_RUNNER_BIN_PATH,
} from "../src/constants.mjs";
import {
  runDesktopHelperEncoderSelfTest,
  runScriptRunnerDenialSelfTest,
  verifyNativeAppBundle,
} from "../src/native-distribution.mjs";

const execFileAsync = promisify(execFile);

async function getSwVers() {
  if (process.platform !== "darwin") {
    return { platform: process.platform, release: os.release() };
  }
  const { stdout } = await execFileAsync("/usr/bin/sw_vers", [], { timeout: 3000 });
  const out = {};
  for (const line of String(stdout || "").split(/\r?\n/u)) {
    const m = /^([^:]+):\s*(.+)$/u.exec(line.trim());
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

async function getPhysicalCursorLocation() {
  if (process.platform !== "darwin") return { x: 0, y: 0 };
  const script =
    'ObjC.import("CoreGraphics"); const ev = $.CGEventCreate(null); const pt = $.CGEventGetLocation(ev); JSON.stringify({ x: pt.x, y: pt.y });';
  const { stdout } = await execFileAsync("/usr/bin/osascript", ["-l", "JavaScript", "-e", script], {
    timeout: 4000,
  });
  return JSON.parse(String(stdout || "{}").trim());
}

async function verifyZeroProgrammaticCursorMove(opFn, { maxAttempts = 3 } = {}) {
  let last = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const before = await getPhysicalCursorLocation();
    const result = await opFn();
    const after = await getPhysicalCursorLocation();
    const delta = Math.hypot(
      Number(after.x || 0) - Number(before.x || 0),
      Number(after.y || 0) - Number(before.y || 0)
    );
    last = { attempt, before, after, delta, result };
    if (delta === 0) {
      return last;
    }
    // Brief yield in case the human trackpad just moved across the previous ~120ms window
    await new Promise((r) => setTimeout(r, 120));
  }
  return last;
}

async function main() {
  if (process.platform !== "darwin") {
    console.log(JSON.stringify({ ok: true, skipped: true, reason: "non_darwin" }, null, 2));
    return;
  }

  const report = {
    ok: false,
    timestamp: new Date().toISOString(),
    os: await getSwVers(),
    bundles: {},
    seatbeltSelfTest: null,
    desktopHelperLive: null,
    scriptRunnerLive: {},
    invariants: {},
  };

  const frontBefore = await getFrontmostAppFast();

  // 1. Bundle signature & universal arch verification
  const helperVerify = await verifyNativeAppBundle(DESKTOP_HELPER_APP_PATH, {
    role: "desktopHelper",
    skipSelfTest: true,
  });
  const runnerVerify = await verifyNativeAppBundle(SCRIPT_RUNNER_APP_PATH, {
    role: "scriptRunner",
    skipSelfTest: true,
  });
  assert.equal(helperVerify.ok, true, `CUADesktopHelper verification failed: ${JSON.stringify(helperVerify)}`);
  assert.equal(runnerVerify.ok, true, `CUAScriptRunner verification failed: ${JSON.stringify(runnerVerify)}`);
  assert.equal(helperVerify.archs.includes("arm64") && helperVerify.archs.includes("x86_64"), true);
  assert.equal(runnerVerify.archs.includes("arm64") && runnerVerify.archs.includes("x86_64"), true);

  report.bundles = {
    desktopHelper: helperVerify,
    scriptRunner: runnerVerify,
  };

  // 2. Direct Seatbelt kernel denial + H.264 hardware encoder self-tests
  const denials = await runScriptRunnerDenialSelfTest(SCRIPT_RUNNER_BIN_PATH);
  assert.equal(denials.ok, true, `Seatbelt denial self-test failed: ${JSON.stringify(denials)}`);
  report.seatbeltSelfTest = denials.report;

  const encoderSelfTest = await runDesktopHelperEncoderSelfTest(DESKTOP_HELPER_BIN_PATH);
  assert.equal(
    encoderSelfTest.ok,
    true,
    `CUADesktopHelper encoder self-test failed: ${JSON.stringify(encoderSelfTest)}`
  );
  report.encoderSelfTest = encoderSelfTest;

  // 3. Live isolated Broker + real CUADesktopHelper.app + real CUAScriptRunner.app
  const tempSock = path.join(
    "/tmp",
    `cua-live-verify-${process.pid}-${crypto.randomBytes(4).toString("hex")}.sock`
  );
  const readOnlyActionPeer = {
    async listTools() {
      return {
        tools: [{ name: "list_apps" }],
      };
    },
    async callTool(name) {
      if (name === "list_apps") {
        const front = await getFrontmostAppFast();
        const label = front?.bundleId || "com.apple.finder";
        return {
          isError: false,
          content: [{ type: "text", text: `Current — ${label} [frontmost, running]` }],
        };
      }
      return { isError: true, content: [{ type: "text", text: `Unsupported in live verify: ${name}` }] };
    },
    close() {},
  };
  const noopStreamPeer = {
    async listTools() {
      return { tools: [] };
    },
    async callTool() {
      return { isError: false, content: [] };
    },
    close() {},
  };

  const brokerToken = crypto.randomBytes(12).toString("hex");
  const broker = new ComputerUseBrokerServer({
    webPort: 0,
    uiToken: brokerToken,
    socketPath: tempSock,
    infoPath: null,
    actionPeer: readOnlyActionPeer,
    streamPeer: noopStreamPeer,
    axBridge: null,
    launchHelperOnStart: true,
    scriptRunnerBinPath: SCRIPT_RUNNER_BIN_PATH,
  });

  const client = new BrokerRpcClient({ socketPath: tempSock, enableFallback: false });

  try {
    const { webPort } = await broker.start();

    // Give DesktopHelper c.sock + v.sock UDS handshakes a brief moment
    const helperDeadline = Date.now() + 4000;
    while (
      (!broker.desktopHelperClient?.available || !broker.desktopHelperClient?.videoAvailable) &&
      Date.now() < helperDeadline
    ) {
      await new Promise((r) => setTimeout(r, 80));
    }

    const helperDiag = broker.desktopHelperClient?.getDiagnostics() || null;
    assert.equal(helperDiag?.available, true, `CUADesktopHelper failed to connect: ${JSON.stringify(helperDiag)}`);
    assert.equal(
      helperDiag?.videoAvailable,
      true,
      `CUADesktopHelper v.sock video handshake failed: ${JSON.stringify(helperDiag)}`
    );
    const cursorCheck = await verifyZeroProgrammaticCursorMove(async () => {
      const helperProbe = await broker.desktopHelperClient.probe();
      const helperWindows = await broker.desktopHelperClient.listWindows();
      const replPing = await client.request("repl/run", {
        code: `nodeRepl.write(String((await cua.listApps({ emit: false })).length));`,
      });
      assert.equal(replPing.isError, false, JSON.stringify(replPing));
      return { helperProbe, helperWindows };
    });
    assert.equal(
      cursorCheck.delta,
      0,
      `Physical cursor moved across all attempts: ${JSON.stringify(cursorCheck)}`
    );
    const { helperProbe, helperWindows } = cursorCheck.result;

    // 2b. Phase 2 web/video/permission endpoints & stale/unproven 409 zero-write guards
    const videoJsRes = await fetch(`http://127.0.0.1:${webPort}/preview-video.js?token=${brokerToken}`);
    assert.equal(videoJsRes.status, 200);
    const videoJsText = await videoJsRes.text();
    assert.match(videoJsText, /PreviewVideoController/);

    const permsRes = await (
      await fetch(`http://127.0.0.1:${webPort}/api/permissions?token=${brokerToken}`)
    ).json();
    assert.equal(permsRes.version, 2);
    assert.ok(permsRes.components?.ocu?.action);
    assert.ok(permsRes.components?.desktopHelper?.preflight);
    assert.equal(permsRes.components?.desktopHelper?.activeCapabilities?.videoAvailable, true);

    const staleJpgRes = await fetch(
      `http://127.0.0.1:${webPort}/api/frame.jpg?token=${brokerToken}&seq=999999&boot=${encodeURIComponent(broker.brokerBootId)}`
    );
    assert.equal(staleJpgRes.status, 409);

    const srPreflight = Boolean(helperDiag.capabilities?.screenRecordingPreflight);
    const sampleWin =
      Array.isArray(helperWindows) && helperWindows.length > 0
        ? helperWindows.find((w) => w.layer === 0 && w.boundsPt?.width >= 200 && w.boundsPt?.height >= 150) ||
          helperWindows[0]
        : { pid: 999999, windowId: 1, boundsPt: { x: 0, y: 0, width: 800, height: 600 } };
    const geom = broker.previewStreamManager.syncActiveGeometry({
      pid: sampleWin.pid,
      windowId: sampleWin.windowId,
      windowBoundsPt: sampleWin.boundsPt,
      explicitWindowId: true,
      jxaTrusted: false, // Unproven explicit WID -> readOnly: true
    });
    const unprovenInteract = await fetch(`http://127.0.0.1:${webPort}/api/interact?token=${brokerToken}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Sidecar-Token": brokerToken },
      body: JSON.stringify({
        app: "com.apple.finder",
        brokerBootId: broker.brokerBootId,
        frameRef: {
          brokerBootId: broker.brokerBootId,
          targetKey: geom.targetKey,
          geometryRev: geom.geometryRev,
          seq: 1,
          windowId: sampleWin.windowId,
        },
        kind: "click",
        normX: 0.5,
        normY: 0.5,
      }),
    });
    assert.equal(unprovenInteract.status, 409, "Expected 409 UNPROVEN_SAME_WINDOW for unproven explicit WID");

    let subRes = null;
    if (!srPreflight) {
      subRes = await (
        await fetch(`http://127.0.0.1:${webPort}/api/video/subscribe?token=${brokerToken}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Sidecar-Token": brokerToken },
          body: JSON.stringify({
            viewId: "live-verify-view",
            targetKey: geom.targetKey,
            brokerBootId: broker.brokerBootId,
            supportsWebCodecs: true,
          }),
        })
      ).json();
      assert.equal(
        subRes.mode,
        "jpeg",
        `Expected graceful JPEG fallback without Screen Recording TCC: ${JSON.stringify(subRes)}`
      );
      assert.equal(subRes.reason, "screen_recording_not_granted", JSON.stringify(subRes));
    } else if (Array.isArray(helperWindows) && helperWindows.length > 0) {
      subRes = await (
        await fetch(`http://127.0.0.1:${webPort}/api/video/subscribe?token=${brokerToken}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Sidecar-Token": brokerToken },
          body: JSON.stringify({
            viewId: "live-verify-view",
            targetKey: geom.targetKey,
            brokerBootId: broker.brokerBootId,
            supportsWebCodecs: true,
          }),
        })
      ).json();
      assert.equal(subRes.mode, "probe", `Expected live H.264 probe when Screen Recording is granted: ${JSON.stringify(subRes)}`);
      await fetch(`http://127.0.0.1:${webPort}/api/video/control?token=${brokerToken}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Sidecar-Token": brokerToken },
        body: JSON.stringify({
          viewId: "live-verify-view",
          brokerBootId: broker.brokerBootId,
          action: "unsubscribe",
        }),
      });
    }

    report.desktopHelperLive = {
      available: helperDiag.available,
      videoAvailable: helperDiag.videoAvailable,
      pid: helperDiag.pid,
      bundleId: helperDiag.bundleId,
      capabilities: helperProbe?.capabilities || helperDiag.capabilities,
      windowCount: Array.isArray(helperWindows) ? helperWindows.length : 0,
      videoSubscribeResult: subRes,
      permissionsV2Ok: permsRes.version === 2,
    };
    report.invariants.cursorCheck = {
      attemptsUsed: cursorCheck.attempt,
      before: cursorCheck.before,
      after: cursorCheck.after,
      delta: cursorCheck.delta,
    };

    // 3a. JSC runtime check (Intl + CJK + Promise + no WebAssembly + blocked eval/Function + Broker listApps RPC)
    const jscCheck = await client.request("repl/run", {
      code: [
        `var persistedBeforeTimeout = "keep_me";`,
        `const apps = await cua.listApps({ emit: false });`,
        `const formatted = new Intl.DateTimeFormat("zh-CN", { timeZone: "UTC" }).format(new Date(1700000000000));`,
        `let evalBlocked = false; try { eval("1+1"); } catch (e) { evalBlocked = true; }`,
        `let fnBlocked = false; try { new Function("return 1")(); } catch (e) { fnBlocked = true; }`,
        `const pVal = await Promise.resolve("中文Promise正常");`,
        `nodeRepl.write(JSON.stringify({`,
        `  wasmType: typeof WebAssembly,`,
        `  evalBlocked,`,
        `  fnBlocked,`,
        `  formatted,`,
        `  pVal,`,
        `  appCount: apps.length`,
        `}));`,
      ].join("\n"),
    });
    assert.equal(jscCheck.isError, false, JSON.stringify(jscCheck));
    const parsedJsc = JSON.parse(
      jscCheck.content.find((c) => c.type === "text" && c.text.startsWith("{")).text
    );
    assert.equal(parsedJsc.wasmType, "undefined");
    assert.equal(parsedJsc.evalBlocked, true);
    assert.equal(parsedJsc.fnBlocked, true);
    assert.equal(parsedJsc.formatted, "2023/11/14");
    assert.equal(parsedJsc.pVal, "中文Promise正常");
    assert.equal(parsedJsc.appCount >= 1, true);
    report.scriptRunnerLive.runtimeCheck = parsedJsc;

    // 3b. Pending Promise wall-clock timeout -> SIGKILL + wipe bindings
    const wallT0 = Date.now();
    const timeoutRes = await client.request("repl/run", {
      code: `await new Promise(() => {});`,
      timeout_ms: 350,
    });
    const wallElapsedMs = Date.now() - wallT0;
    assert.equal(timeoutRes.isError, true);
    assert.match(timeoutRes.content.map((c) => c.text).join("\n"), /timed out/i);

    const afterTimeoutRes = await client.request("repl/run", {
      code: `nodeRepl.write(typeof persistedBeforeTimeout);`,
    });
    assert.equal(afterTimeoutRes.isError, false);
    assert.equal(afterTimeoutRes.content[0].text, "undefined");
    report.scriptRunnerLive.wallClockKill = { elapsedMs: wallElapsedMs, sessionWiped: true };

    // 3c. CPU watchdog (`while(true){}`) -> ~2s RLIMIT_CPU kill
    const cpuT0 = Date.now();
    const cpuRes = await client.request("repl/run", {
      code: `while (true) {}`,
      timeout_ms: 8000,
    });
    const cpuElapsedMs = Date.now() - cpuT0;
    assert.equal(cpuRes.isError, true);
    assert.match(cpuRes.content.map((c) => c.text).join("\n"), /CPU time limit/i);
    assert.equal(cpuElapsedMs < 6000, true, `CPU loop took too long: ${cpuElapsedMs}ms`);
    report.scriptRunnerLive.cpuWatchdogKill = { elapsedMs: cpuElapsedMs };

    // 3d. Takeover pause/drain/resume integration on real Broker + real CUADesktopHelper
    const pauseRes = broker.takeoverController.requestPause({
      reason: "verify_live_native",
      label: "Live gate pause/drain check",
      source: "verify-live-native",
    });
    assert.equal(pauseRes.paused, true);
    const drained = await broker.takeoverController.waitForDrain({ timeoutMs: 2000 });
    assert.equal(drained, true);
    assert.equal(broker.state.paused, true);
    const resumeRes = await broker.takeoverController.resume();
    assert.equal(resumeRes.ok, true);
    assert.equal(broker.state.paused, false);

    // Confirm REPL still works after CPU watchdog + pause/resume
    const postResume = await client.request("repl/run", {
      code: `nodeRepl.write("post_resume_ok");`,
    });
    assert.equal(postResume.isError, false);
    assert.equal(postResume.content[0].text, "post_resume_ok");
  } finally {
    await client.close().catch(() => {});
    await broker.close().catch(() => {});
    if (existsSync(tempSock)) {
      rmSync(tempSock, { force: true });
    }
  }

  const frontAfter = await getFrontmostAppFast();

  report.invariants = {
    ...report.invariants,
    frontBefore,
    frontAfter,
    frontUnchanged:
      frontBefore?.pid === frontAfter?.pid && frontBefore?.bundleId === frontAfter?.bundleId,
  };

  assert.equal(
    report.invariants.frontUnchanged,
    true,
    `Focus changed unexpectedly: ${JSON.stringify({ frontBefore, frontAfter })}`
  );

  report.ok = true;
  console.log(JSON.stringify(report, null, 2));
}

main().catch((err) => {
  console.error(
    JSON.stringify(
      {
        ok: false,
        error: err instanceof Error ? err.stack || err.message : String(err),
      },
      null,
      2
    )
  );
  process.exit(1);
});
