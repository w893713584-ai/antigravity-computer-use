import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { PROJECT_ROOT } from "../src/constants.mjs";
import { sha256File, stageAndInstallNativePayloads, verifyNativeAppBundle } from "../src/native-distribution.mjs";
import {
  findInstalledOcuRuntime,
  installCodexComputerUse,
  uninstallCodexComputerUse,
} from "../scripts/installer-lib.mjs";
import { buildShareZip } from "../scripts/pack-share.mjs";

test("One-click installer stages files to ~/.gemini/codex-style-computer-use, merges mcp_config idempotently, and uninstalls cleanly", async () => {
  const fakeHome = mkdtempSync(path.join(tmpdir(), "agy-cua-home-"));
  const configDir = path.join(fakeHome, ".gemini", "config");
  mkdirSync(configDir, { recursive: true });

  // Simulate friend's pre-existing mcp_config.json and config.json (mode 0600)
  const originalMcp = {
    mcpServers: {
      puppeteer: { command: "/opt/homebrew/bin/mcp-server-puppeteer" },
      "computer-use": { command: "/old/open-computer-use", args: ["mcp"] },
    },
  };
  writeFileSync(path.join(configDir, "mcp_config.json"), JSON.stringify(originalMcp, null, 2));
  writeFileSync(
    path.join(configDir, "config.json"),
    JSON.stringify(
      {
        plugins: { gdocs: { enabled: true } },
        userSettings: { theme: "dark" },
        sidecars: {
          "computer-use-preview": {
            enabled: true,
            projectId: "35e2fecc-b247-46ca-a261-cb4d7be9776d",
            schemaVersion: 1,
          },
        },
      },
      null,
      2
    ),
    { mode: 0o600 }
  );
  writeFileSync(path.join(configDir, "GEMINI.md"), "# User Existing Rule\nKeep answers concise.\n");

  // Pretend open-computer-use is already present in ~/.gemini/config/computer-use-1.1.3 so npm install is skipped
  const fakeOcuAppBin = path.join(
    configDir,
    "computer-use-1.1.3/node_modules/open-computer-use/dist/Open Computer Use.app/Contents/MacOS"
  );
  const fakeOcuReplDir = path.join(
    configDir,
    "computer-use-1.1.3/node_modules/open-computer-use/scripts/node-repl"
  );
  mkdirSync(fakeOcuAppBin, { recursive: true });
  mkdirSync(fakeOcuReplDir, { recursive: true });
  writeFileSync(path.join(fakeOcuAppBin, "OpenComputerUse"), "#!/bin/sh\n", { mode: 0o755 });
  writeFileSync(path.join(fakeOcuReplDir, "open-computer-use-repl.mjs"), "export {};\n");

  const installDir = path.join(fakeHome, ".gemini", "codex-style-computer-use");

  try {
    // 1. First install from PROJECT_ROOT (simulating ~/Downloads unzipped folder)
    const res1 = await installCodexComputerUse({
      sourceRoot: PROJECT_ROOT,
      homeDir: fakeHome,
      installDir,
      nodeExecPath: "/custom/bin/node",
      skipDoctor: true,
      skipProcessKill: true,
      liveRpcFn: async () => false, // simulate Antigravity offline
    });
    assert.equal(res1.reusedExistingRuntime, true);
    assert.equal(existsSync(path.join(installDir, "src", "broker-sidecar.mjs")), true);
    assert.equal(existsSync(path.join(installDir, "src", "ui", "preview-video.js")), true);
    assert.equal(res1.nativePayloads?.manifestFound, true);
    assert.equal(res1.nativePayloads?.components?.desktopHelper?.status, "installed");
    assert.equal(res1.nativePayloads?.components?.scriptRunner?.status, "installed");

    const installedHelperApp = path.join(installDir, "native-runtime", "CUADesktopHelper.app");
    const installedRunnerApp = path.join(installDir, "native-runtime", "CUAScriptRunner.app");
    assert.equal(existsSync(installedHelperApp), true);
    assert.equal(existsSync(installedRunnerApp), true);
    if (process.platform === "darwin") {
      const runnerVerify = await verifyNativeAppBundle(installedRunnerApp, {
        role: "scriptRunner",
        skipSelfTest: false,
      });
      assert.equal(runnerVerify.ok, true, JSON.stringify(runnerVerify));
    }

    // Sidecar manifest must point to friend's installDir and resolved node binary
    const sidecarJson = JSON.parse(
      readFileSync(path.join(configDir, "sidecars", "computer-use-preview", "sidecar.json"), "utf8")
    );
    assert.equal(sidecarJson.command, "/custom/bin/node");
    assert.equal(sidecarJson.args[0], path.join(installDir, "src", "broker-sidecar.mjs"));

    // mcp_config.json must keep `puppeteer` untouched and point `computer-use` & `computer-use-js` to installDir
    const mergedMcp = JSON.parse(readFileSync(path.join(configDir, "mcp_config.json"), "utf8"));
    assert.deepEqual(mergedMcp.mcpServers.puppeteer, originalMcp.mcpServers.puppeteer);
    assert.equal(mergedMcp.mcpServers["computer-use"].command, "/custom/bin/node");
    assert.equal(mergedMcp.mcpServers["computer-use"].args[0], path.join(installDir, "src", "mcp-server.mjs"));
    assert.equal(
      mergedMcp.mcpServers["computer-use-js"].args[0],
      path.join(installDir, "src", "mcp-repl-server.mjs")
    );

    // Offline config.json must preserve plugins & userSettings, clear stale projectId, and keep mode 0600
    const updatedCfg = JSON.parse(readFileSync(path.join(configDir, "config.json"), "utf8"));
    assert.equal(updatedCfg.plugins.gdocs.enabled, true);
    assert.equal(updatedCfg.userSettings.theme, "dark");
    assert.equal(updatedCfg.sidecars["computer-use-preview"].enabled, true);
    assert.equal(
      updatedCfg.sidecars["computer-use-preview"].projectId,
      undefined,
      "Stale projectId must be stripped so sidecar is visible in all workspaces"
    );
    assert.equal(statSync(path.join(configDir, "config.json")).mode & 0o777, 0o600);

    // Global GEMINI.md must contain user's existing rule PLUS managed sidecar pill rule & Qt6 exception
    const geminiMdAfterInstall = readFileSync(path.join(configDir, "GEMINI.md"), "utf8");
    assert.match(geminiMdAfterInstall, /# User Existing Rule/);
    assert.match(geminiMdAfterInstall, /sidecar:\/\/computer-use-preview\//);
    assert.match(geminiMdAfterInstall, /com\.lemon\.lvpro/);
    assert.match(geminiMdAfterInstall, /Qt6/);

    // 2. Second install (idempotency + liveRpcFn=true): must NOT clobber saved original `/old/open-computer-use` entry,
    // AND must still strip workspace-scoped projectId while preserving host-assigned own sidecar projectId!
    const projectsDir = path.join(configDir, "projects");
    mkdirSync(projectsDir, { recursive: true });
    writeFileSync(
      path.join(projectsDir, "stale-project-id-during-live-sync.json"),
      JSON.stringify({ id: "stale-project-id-during-live-sync", rootPath: "/Users/demo/workspace" }, null, 2)
    );
    writeFileSync(
      path.join(configDir, "config.json"),
      JSON.stringify(
        {
          ...updatedCfg,
          sidecars: {
            "computer-use-preview": {
              enabled: true,
              projectId: "stale-project-id-during-live-sync",
              schemaVersion: 1,
            },
          },
        },
        null,
        2
      ),
      { mode: 0o600 }
    );
    await installCodexComputerUse({
      sourceRoot: PROJECT_ROOT,
      homeDir: fakeHome,
      installDir,
      nodeExecPath: "/custom/bin/node",
      skipDoctor: true,
      skipProcessKill: true,
      liveRpcFn: async () => true,
    });
    const cfgAfterLiveInstall = JSON.parse(readFileSync(path.join(configDir, "config.json"), "utf8"));
    assert.equal(
      cfgAfterLiveInstall.sidecars["computer-use-preview"].projectId,
      undefined,
      "User-workspace projectId must be stripped from config.json when liveRpcFn returns true"
    );

    // 2b. Host-assigned internal sidecar projectId (`sidecar.sidecarId === "computer-use-preview"`) MUST be preserved!
    const ownSidecarProjectId = "b8c4e0f1-1111-4222-8333-abcdef123456";
    writeFileSync(
      path.join(projectsDir, `${ownSidecarProjectId}.json`),
      JSON.stringify(
        {
          id: ownSidecarProjectId,
          sidecar: { sidecarId: "computer-use-preview" },
        },
        null,
        2
      )
    );
    writeFileSync(
      path.join(configDir, "config.json"),
      JSON.stringify(
        {
          ...cfgAfterLiveInstall,
          sidecars: {
            "computer-use-preview": {
              enabled: true,
              projectId: ownSidecarProjectId,
              schemaVersion: 1,
            },
          },
        },
        null,
        2
      ),
      { mode: 0o600 }
    );
    await installCodexComputerUse({
      sourceRoot: PROJECT_ROOT,
      homeDir: fakeHome,
      installDir,
      nodeExecPath: "/custom/bin/node",
      skipDoctor: true,
      skipProcessKill: true,
      liveRpcFn: async () => true,
    });
    const cfgWithOwnSidecarId = JSON.parse(readFileSync(path.join(configDir, "config.json"), "utf8"));
    assert.equal(
      cfgWithOwnSidecarId.sidecars["computer-use-preview"].projectId,
      ownSidecarProjectId,
      "Host-assigned internal sidecar projectId must be preserved across installs"
    );

    // Create simulated broker socket & info files to verify uninstall cleans them up
    const ocuDir = path.join(fakeHome, ".config", "ocu");
    mkdirSync(ocuDir, { recursive: true });
    writeFileSync(path.join(ocuDir, "agy-cua.sock"), "");
    writeFileSync(path.join(ocuDir, "agy-cua-sidecar.json"), "{}");

    // 3. Uninstall: must restore `/old/open-computer-use`, remove `computer-use-js`, keep `puppeteer`, and clean up files
    await uninstallCodexComputerUse({
      homeDir: fakeHome,
      installDir,
      liveRpcFn: async () => false,
      skipProcessKill: true,
    });

    const restoredMcp = JSON.parse(readFileSync(path.join(configDir, "mcp_config.json"), "utf8"));
    assert.deepEqual(restoredMcp.mcpServers.puppeteer, originalMcp.mcpServers.puppeteer);
    assert.deepEqual(restoredMcp.mcpServers["computer-use"], originalMcp.mcpServers["computer-use"]);
    assert.equal(restoredMcp.mcpServers["computer-use-js"], undefined);
    assert.equal(existsSync(path.join(configDir, "sidecars", "computer-use-preview")), false);
    assert.equal(existsSync(installDir), false);
    assert.equal(existsSync(path.join(ocuDir, "agy-cua.sock")), false);
    assert.equal(existsSync(path.join(ocuDir, "agy-cua-sidecar.json")), false);

    // 4. Reject macOS < 14.0 (darwin kernel < 23) with clear Chinese message
    await assert.rejects(
      () =>
        installCodexComputerUse({
          sourceRoot: PROJECT_ROOT,
          homeDir: fakeHome,
          installDir,
          skipDoctor: true,
          darwinReleaseOverride: "22.6.0",
        }),
      /macOS 14\.0/
    );

    // Managed GEMINI.md rule block must be cleanly removed while user's rule remains intact
    const geminiMdAfterUninstall = readFileSync(path.join(configDir, "GEMINI.md"), "utf8");
    assert.match(geminiMdAfterUninstall, /# User Existing Rule/);
    assert.equal(geminiMdAfterUninstall.includes("sidecar://computer-use-preview/"), false);
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test("buildShareZip sets UTF-8 bit 11 and preserves +x permissions on Chinese .command launchers", () => {
  const tmpDir = mkdtempSync(path.join(tmpdir(), "agy-cua-zip-"));
  const testZip = path.join(tmpDir, "Codex风格ComputerUse一键安装包.zip");
  const extractDir = path.join(tmpDir, "extracted");

  try {
    const { bytes } = buildShareZip({ sourceRoot: PROJECT_ROOT, outZip: testZip });
    assert.equal(bytes > 10_000, true);

    // Extract using macOS Archive Utility engine (ditto)
    execFileSync("/usr/bin/ditto", ["-x", "-k", testZip, extractDir]);

    const rootDir = path.join(extractDir, "Codex风格ComputerUse一键安装包");
    const installCmd = path.join(rootDir, "双击安装.command");
    const uninstallCmd = path.join(rootDir, "双击卸载.command");
    const guideTxt = path.join(rootDir, "使用说明.txt");

    assert.equal(existsSync(installCmd), true);
    assert.equal(existsSync(uninstallCmd), true);
    assert.equal(existsSync(guideTxt), true);
    assert.equal((statSync(installCmd).mode & 0o111) !== 0, true);
    assert.equal((statSync(uninstallCmd).mode & 0o111) !== 0, true);

    assert.equal(existsSync(path.join(rootDir, "src", "ui", "preview-video.js")), true, "Share ZIP must include src/ui/preview-video.js");
    const extractedManifest = path.join(rootDir, "native-payloads", "manifest.json");
    const extractedHelperZip = path.join(rootDir, "native-payloads", "CUADesktopHelper.app.zip");
    const extractedRunnerZip = path.join(rootDir, "native-payloads", "CUAScriptRunner.app.zip");
    assert.equal(existsSync(extractedManifest), true, "Share ZIP must bundle native-payloads/manifest.json");
    assert.equal(existsSync(extractedHelperZip), true, "Share ZIP must bundle CUADesktopHelper.app.zip");
    assert.equal(existsSync(extractedRunnerZip), true, "Share ZIP must bundle CUAScriptRunner.app.zip");
    const manifestJson = JSON.parse(readFileSync(extractedManifest, "utf8"));
    assert.equal(
      sha256File(extractedRunnerZip),
      manifestJson.components.scriptRunner.zipSha256,
      "Extracted runner ZIP SHA-256 must match bundled manifest.json"
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("findInstalledOcuRuntime succeeds without open-computer-use-repl.mjs and native staging supports independent degradation & atomic rollback", async () => {
  const fakeHome = mkdtempSync(path.join(tmpdir(), "agy-cua-native-inst-"));
  const fakeSource = path.join(fakeHome, "fake-source");
  const configDir = path.join(fakeHome, ".gemini", "config");
  const installDir = path.join(fakeHome, ".gemini", "codex-style-computer-use");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(fakeSource, { recursive: true });

  const fakeOcuAppBin = path.join(
    configDir,
    "computer-use-1.2.0/node_modules/open-computer-use/dist/Open Computer Use.app/Contents/MacOS"
  );
  mkdirSync(fakeOcuAppBin, { recursive: true });
  writeFileSync(path.join(fakeOcuAppBin, "OpenComputerUse"), "#!/bin/sh\n", { mode: 0o755 });

  try {
    // 1. OCU runtime discovery works with OpenComputerUse binary alone (no open-computer-use-repl.mjs required)
    const discovered = findInstalledOcuRuntime(fakeHome, installDir);
    assert.ok(discovered, "Expected findInstalledOcuRuntime to locate OpenComputerUse binary");
    assert.equal(discovered.replMod, null);

    // Prepare a mutable source tree containing native-payloads from PROJECT_ROOT
    for (const rel of ["package.json", "src", "scripts", "native-payloads"]) {
      cpSync(path.join(PROJECT_ROOT, rel), path.join(fakeSource, rel), { recursive: true });
    }

    // 2. Independent degradation: corrupt CUAScriptRunner.app.zip while keeping CUADesktopHelper.app.zip valid
    const badRunnerZip = path.join(fakeSource, "native-payloads", "CUAScriptRunner.app.zip");
    writeFileSync(badRunnerZip, Buffer.from("corrupted zip payload"));

    const degradedRes = await installCodexComputerUse({
      sourceRoot: fakeSource,
      homeDir: fakeHome,
      installDir,
      nodeExecPath: "/custom/bin/node",
      skipDoctor: true,
      skipProcessKill: true,
      liveRpcFn: async () => false,
      log: () => {},
    });
    assert.equal(degradedRes.reusedExistingRuntime, true);
    assert.equal(degradedRes.nativePayloads.components.desktopHelper.status, "installed");
    assert.equal(degradedRes.nativePayloads.components.scriptRunner.status, "degraded");
    assert.equal(degradedRes.nativePayloads.components.scriptRunner.reason, "zip_sha256_mismatch");
    assert.equal(existsSync(path.join(installDir, "native-runtime", "CUADesktopHelper.app")), true);
    assert.equal(existsSync(path.join(installDir, "native-runtime", "CUAScriptRunner.app")), false);

    // 3. Install full valid native payloads first
    const validRes = await installCodexComputerUse({
      sourceRoot: PROJECT_ROOT,
      homeDir: fakeHome,
      installDir,
      nodeExecPath: "/custom/bin/node",
      skipDoctor: true,
      skipProcessKill: true,
      liveRpcFn: async () => false,
      log: () => {},
    });
    assert.equal(validRes.nativePayloads.components.scriptRunner.status, "installed");
    const installedRunnerApp = path.join(installDir, "native-runtime", "CUAScriptRunner.app");
    assert.equal(existsSync(installedRunnerApp), true);

    // 4. Atomic rollback on upgrade with tampered codesign inside zip (matching updated zipSha256)
    const tamperWorkDir = path.join(fakeHome, "tamper-work");
    mkdirSync(tamperWorkDir, { recursive: true });
    execFileSync("/usr/bin/ditto", [
      "-x",
      "-k",
      path.join(PROJECT_ROOT, "native-payloads", "CUAScriptRunner.app.zip"),
      tamperWorkDir,
    ]);
    const tamperedBin = path.join(tamperWorkDir, "CUAScriptRunner.app", "Contents", "MacOS", "CUAScriptRunner");
    writeFileSync(tamperedBin, Buffer.from("#!/bin/sh\necho tampered\n"), { mode: 0o755 });
    execFileSync("/usr/bin/ditto", [
      "-c",
      "-k",
      "--keepParent",
      "--sequesterRsrc",
      path.join(tamperWorkDir, "CUAScriptRunner.app"),
      badRunnerZip,
    ]);
    const fakeManifestPath = path.join(fakeSource, "native-payloads", "manifest.json");
    const fakeManifest = JSON.parse(readFileSync(fakeManifestPath, "utf8"));
    fakeManifest.components.scriptRunner.zipSha256 = sha256File(badRunnerZip);
    writeFileSync(fakeManifestPath, JSON.stringify(fakeManifest, null, 2));

    const rollbackRes = await installCodexComputerUse({
      sourceRoot: fakeSource,
      homeDir: fakeHome,
      installDir,
      nodeExecPath: "/custom/bin/node",
      skipDoctor: true,
      skipProcessKill: true,
      liveRpcFn: async () => false,
      log: () => {},
    });
    assert.equal(rollbackRes.nativePayloads.components.scriptRunner.status, "preserved_previous");
    assert.match(rollbackRes.nativePayloads.components.scriptRunner.reason, /codesign_invalid/);
    if (process.platform === "darwin") {
      const stillValid = await verifyNativeAppBundle(installedRunnerApp, {
        role: "scriptRunner",
        skipSelfTest: false,
      });
      assert.equal(stillValid.ok, true, "Previous verified CUAScriptRunner.app must remain intact after failed upgrade");
    }
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test("stageAndInstallNativePayloads reuses identical installed bundles in place to preserve TCC CDHash & inode", async () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "agy-cua-reuse-"));
  const installDir = path.join(tempRoot, "runtime");
  mkdirSync(installDir, { recursive: true });

  try {
    const first = await stageAndInstallNativePayloads({
      sourceRoot: PROJECT_ROOT,
      installDir,
      skipSelfTest: true,
      log: () => {},
    });
    assert.equal(first.components.desktopHelper.status, "installed");
    assert.equal(Boolean(first.components.desktopHelper.reusedInPlace), false);
    assert.equal(first.components.scriptRunner.status, "installed");

    const desktopHelperBin = path.join(
      installDir,
      "native-runtime",
      "CUADesktopHelper.app",
      "Contents",
      "MacOS",
      "CUADesktopHelper"
    );
    const inoBefore = statSync(desktopHelperBin).ino;

    const second = await stageAndInstallNativePayloads({
      sourceRoot: PROJECT_ROOT,
      installDir,
      skipSelfTest: true,
      log: () => {},
    });
    assert.equal(second.components.desktopHelper.status, "installed");
    assert.equal(second.components.desktopHelper.reusedInPlace, true);
    assert.equal(second.components.scriptRunner.status, "installed");
    assert.equal(second.components.scriptRunner.reusedInPlace, true);
    assert.equal(
      statSync(desktopHelperBin).ino,
      inoBefore,
      "Reusing unchanged CUADesktopHelper.app must keep identical binary inode for TCC continuity"
    );
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("Codex 6.2 regressions: installer enforces expectedArchs/signingMode and leaves no .next staging directories", async () => {
  if (process.platform !== "darwin") return;
  const tempRoot = mkdtempSync(path.join(tmpdir(), "agy-cua-atomic-"));
  const installDir = path.join(tempRoot, "runtime");
  mkdirSync(installDir, { recursive: true });
  try {
    const res = await stageAndInstallNativePayloads({
      sourceRoot: PROJECT_ROOT,
      installDir,
      skipSelfTest: true,
      log: () => {},
    });
    assert.equal(res.components.desktopHelper.status, "installed");
    const entries = readdirSync(path.join(installDir, "native-runtime"));
    assert.equal(entries.some((n) => n.includes(".next-") || n.includes(".prev-")), false);

    const installedHelper = path.join(installDir, "native-runtime", "CUADesktopHelper.app");
    const wrongArch = await verifyNativeAppBundle(installedHelper, {
      role: "desktopHelper",
      expectedArchs: ["nonexistent_arch"],
      skipSelfTest: true,
    });
    assert.equal(wrongArch.ok, false);
    assert.match(wrongArch.reason, /^missing_expected_arch:/);

    const wrongSign = await verifyNativeAppBundle(installedHelper, {
      role: "desktopHelper",
      signingMode: "developer_id",
      skipSelfTest: true,
    });
    assert.equal(wrongSign.ok, false);
    assert.equal(wrongSign.reason, "expected_signed_not_adhoc");
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
