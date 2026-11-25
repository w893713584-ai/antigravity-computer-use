import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { ComputerUseBrokerServer } from "../src/broker-sidecar.mjs";
import { DESKTOP_HELPER_BIN_PATH, PROJECT_ROOT } from "../src/constants.mjs";
import {
  MACOS_PERMISSION_KINDS,
  collectMissingPermissions,
  getPermissionSettingsUrl,
  openMacOsPermissionSettings,
} from "../src/macos-permissions.mjs";
import {
  DEFAULT_LOCAL_CODESIGN_IDENTITY,
  classifyCodesignIdentity,
  parseCodesignIdentities,
  parseCodesignOutput,
  resolveCodesignIdentity,
  verifyNativeAppBundle,
} from "../src/native-distribution.mjs";
import { runPermissionGuide } from "../scripts/open-permissions.mjs";
import {
  generateLocalCodesignArtifacts,
  setupLocalCodesignCertificate,
} from "../scripts/setup-local-codesign-cert.mjs";

const execFileAsync = promisify(execFile);

test("macos-permissions maps all 3 TCC panes, invokes open safely, and collects missing items", async () => {
  assert.deepEqual(MACOS_PERMISSION_KINDS, [
    "accessibility",
    "screenRecording",
    "inputMonitoring",
  ]);
  assert.equal(
    getPermissionSettingsUrl("accessibility"),
    "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
  );
  assert.equal(
    getPermissionSettingsUrl("screenRecording"),
    "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
  );
  assert.equal(
    getPermissionSettingsUrl("inputMonitoring"),
    "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent"
  );
  assert.equal(getPermissionSettingsUrl("unknown"), null);

  const nonDarwin = await openMacOsPermissionSettings("accessibility", { platform: "linux" });
  assert.equal(nonDarwin.ok, false);
  assert.equal(nonDarwin.error, "non_darwin");

  const invalidKind = await openMacOsPermissionSettings("camera", { platform: "darwin" });
  assert.equal(invalidKind.ok, false);
  assert.equal(invalidKind.error, "unsupported_permission_kind");

  const calls = [];
  for (const kind of MACOS_PERMISSION_KINDS) {
    const res = await openMacOsPermissionSettings(kind, {
      platform: "darwin",
      execFileFn: async (bin, args, opts) => {
        calls.push({ bin, args, opts });
      },
    });
    assert.equal(res.ok, true);
    assert.equal(res.kind, kind);
    assert.equal(res.settingsUrl, getPermissionSettingsUrl(kind));
  }
  assert.equal(calls.length, 3);
  assert.deepEqual(
    calls.map((c) => [c.bin, c.args[0]]),
    [
      ["/usr/bin/open", getPermissionSettingsUrl("accessibility")],
      ["/usr/bin/open", getPermissionSettingsUrl("screenRecording")],
      ["/usr/bin/open", getPermissionSettingsUrl("inputMonitoring")],
    ]
  );

  assert.deepEqual(
    collectMissingPermissions(
      { platform: "darwin", accessibility: false, screenRecording: true },
      {
        desktopHelper: {
          status: "baseline",
          capabilities: {
            accessibilityTrusted: true,
            screenRecordingPreflight: true,
            inputMonitoringPreflight: false,
            mouseTapActive: false,
            keyTapActive: false,
          },
        },
      }
    ),
    ["accessibility", "inputMonitoring"]
  );

  assert.deepEqual(
    collectMissingPermissions(
      { platform: "darwin", accessibility: true, screenRecording: false },
      {
        ocuStream: { status: "verified" },
        desktopHelper: {
          status: "enhanced",
          capabilities: {
            accessibilityTrusted: true,
            screenRecordingPreflight: true,
            inputMonitoringPreflight: true,
            mouseTapActive: true,
            keyTapActive: true,
          },
        },
      }
    ),
    []
  );
});

test("native-distribution parses identities, classifies local_cert vs adhoc vs developer_id, and enforces bundle rules", async () => {
  const sampleFindIdentity = `
  1) 0123456789ABCDEF0123456789ABCDEF01234567 "Codex CUA Local Code Signing"
  2) FEDCBA9876543210FEDCBA9876543210FEDCBA98 "Developer ID Application: Example Corp (TEAM123456)"
  1) 0123456789ABCDEF0123456789ABCDEF01234567 "Codex CUA Local Code Signing"
     2 valid identities found
`;
  const parsed = parseCodesignIdentities(sampleFindIdentity);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].name, DEFAULT_LOCAL_CODESIGN_IDENTITY);

  assert.equal(classifyCodesignIdentity("-"), "adhoc");
  assert.equal(classifyCodesignIdentity("Codex CUA Local Code Signing"), "local_cert");
  assert.equal(
    classifyCodesignIdentity("Developer ID Application: Example Corp (TEAM123456)"),
    "developer_id"
  );

  assert.deepEqual(
    resolveCodesignIdentity({
      platform: "darwin",
      env: { AGY_CUA_CODESIGN_IDENTITY: "My Custom Cert" },
      findIdentitiesFn: () => sampleFindIdentity,
    }),
    { identity: "My Custom Cert", signingMode: "local_cert", source: "env" }
  );

  assert.deepEqual(
    resolveCodesignIdentity({
      platform: "darwin",
      env: {},
      findIdentitiesFn: () => sampleFindIdentity,
    }),
    {
      identity: DEFAULT_LOCAL_CODESIGN_IDENTITY,
      signingMode: "local_cert",
      source: "auto_keychain",
      certHash: "0123456789ABCDEF0123456789ABCDEF01234567",
    }
  );

  assert.deepEqual(
    resolveCodesignIdentity({
      platform: "darwin",
      env: { AGY_CUA_ALLOW_AUTO_LOCAL_CERT: "0" },
      findIdentitiesFn: () => sampleFindIdentity,
    }),
    { identity: "-", signingMode: "adhoc", source: "default" }
  );

  assert.deepEqual(
    resolveCodesignIdentity({
      platform: "darwin",
      env: {},
      findIdentitiesFn: () => "0 valid identities found",
    }),
    { identity: "-", signingMode: "adhoc", source: "default" }
  );

  const adhocInfo = parseCodesignOutput(
    "Identifier=io.codexstyle.cua.desktop-helper.dev\nSignature=adhoc\nTeamIdentifier=not set\nCDHash=aaaa1111"
  );
  assert.equal(adhocInfo.adhoc, true);
  assert.equal(adhocInfo.signingMode, "adhoc");

  const localCertInfo = parseCodesignOutput(
    "Identifier=io.codexstyle.cua.desktop-helper.dev\nAuthority=Codex CUA Local Code Signing\nTeamIdentifier=not set\nCDHash=bbbb2222"
  );
  assert.equal(localCertInfo.adhoc, false);
  assert.equal(localCertInfo.signingMode, "local_cert");
  assert.deepEqual(localCertInfo.authorities, ["Codex CUA Local Code Signing"]);

  const devIdInfo = parseCodesignOutput(
    "Identifier=io.codexstyle.cua.desktop-helper\nAuthority=Developer ID Application: Example\nTeamIdentifier=TEAM123456\nCDHash=cccc3333"
  );
  assert.equal(devIdInfo.adhoc, false);
  assert.equal(devIdInfo.signingMode, "developer_id");
  assert.equal(devIdInfo.teamId, "TEAM123456");

  // verifyNativeAppBundle checks using synthetic dummy bundle + injected inspectCodesignFn
  const tmpAppRoot = mkdtempSync(path.join(tmpdir(), "cua-verify-bundle-"));
  const devApp = path.join(tmpAppRoot, "Dev.app");
  const prodApp = path.join(tmpAppRoot, "Prod.app");
  for (const [appDir, bundleId] of [
    [devApp, "io.codexstyle.cua.desktop-helper.dev"],
    [prodApp, "io.codexstyle.cua.desktop-helper"],
  ]) {
    mkdirSync(path.join(appDir, "Contents", "MacOS"), { recursive: true });
    writeFileSync(path.join(appDir, "Contents", "MacOS", "CUADesktopHelper"), "#!/bin/sh\n", {
      mode: 0o755,
    });
    writeFileSync(
      path.join(appDir, "Contents", "Info.plist"),
      `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>${bundleId}</string>
  <key>CFBundleExecutable</key><string>CUADesktopHelper</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
</dict></plist>`
    );
  }

  try {
    const okLocal = await verifyNativeAppBundle(devApp, {
      role: "desktopHelper",
      signingMode: "local_cert",
      skipSelfTest: true,
      inspectCodesignFn: async () => ({
        valid: true,
        adhoc: false,
        signingMode: "local_cert",
        identifier: "io.codexstyle.cua.desktop-helper.dev",
        teamId: null,
        authorities: [DEFAULT_LOCAL_CODESIGN_IDENTITY],
        cdhash: "bbbb2222",
      }),
    });
    assert.equal(okLocal.ok, true);
    assert.equal(okLocal.signingMode, "local_cert");

    const rejectedProd = await verifyNativeAppBundle(prodApp, {
      role: "desktopHelper",
      signingMode: "local_cert",
      skipSelfTest: true,
      inspectCodesignFn: async () => ({
        valid: true,
        adhoc: false,
        signingMode: "local_cert",
        identifier: "io.codexstyle.cua.desktop-helper",
        teamId: null,
        authorities: [DEFAULT_LOCAL_CODESIGN_IDENTITY],
        cdhash: "bbbb2222",
      }),
    });
    assert.equal(rejectedProd.ok, false);
    assert.equal(rejectedProd.reason, "local_cert_must_not_use_prod_bundle_id");

    const rejectedDevId = await verifyNativeAppBundle(devApp, {
      role: "desktopHelper",
      signingMode: "developer_id",
      skipSelfTest: true,
      inspectCodesignFn: async () => ({
        valid: true,
        adhoc: false,
        signingMode: "local_cert",
        identifier: "io.codexstyle.cua.desktop-helper.dev",
        teamId: null,
        authorities: [DEFAULT_LOCAL_CODESIGN_IDENTITY],
        cdhash: "bbbb2222",
      }),
    });
    assert.equal(rejectedDevId.ok, false);
    assert.equal(rejectedDevId.reason, "expected_developer_id_not_local_cert");
  } finally {
    rmSync(tmpAppRoot, { recursive: true, force: true });
  }
});

test("setup-local-codesign-cert generates valid Code Signing X.509/PKCS12 in /tmp and handles idempotent keychain flow", () => {
  const workDir = mkdtempSync(path.join(tmpdir(), "cua-openssl-test-"));
  try {
    const passphrase = "test-passphrase-123";
    const artifacts = generateLocalCodesignArtifacts({
      certName: DEFAULT_LOCAL_CODESIGN_IDENTITY,
      workDir,
      passphrase,
    });
    const x509Text = execFileSync(
      "/usr/bin/openssl",
      ["x509", "-in", artifacts.certPath, "-text", "-noout"],
      { encoding: "utf8" }
    );
    assert.match(x509Text, /CN\s*=\s*Codex CUA Local Code Signing/);
    assert.match(x509Text, /Digital Signature/);
    assert.match(x509Text, /Code Signing/);

    const pkcs12Check = execFileSync(
      "/usr/bin/openssl",
      ["pkcs12", "-in", artifacts.p12Path, "-nokeys", "-passin", "env:CUA_P12_PASS"],
      {
        env: { ...process.env, CUA_P12_PASS: passphrase },
        encoding: "utf8",
      }
    );
    assert.match(pkcs12Check, /BEGIN CERTIFICATE/);

    // 1. Existing identity -> skips creation cleanly without touching security import
    const skippedCalls = [];
    const skipRes = setupLocalCodesignCertificate({
      platform: "darwin",
      log: () => {},
      execFileSyncFn: (bin, args) => {
        skippedCalls.push([bin, ...args]);
        return `  1) AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA "${DEFAULT_LOCAL_CODESIGN_IDENTITY}"\n`;
      },
    });
    assert.equal(skipRes.ok, true);
    assert.equal(skipRes.alreadyExists, true);
    assert.equal(skippedCalls.length, 1);

    // 2. Absent identity -> creates cert/p12, imports into target keychain, and trusts for codeSign
    let findCalls = 0;
    const securityCmds = [];
    const createRes = setupLocalCodesignCertificate({
      platform: "darwin",
      keychainPath: "/tmp/fake-login.keychain-db",
      log: () => {},
      execFileSyncFn: (bin, args, opts) => {
        if (bin === "/usr/bin/openssl") {
          return execFileSync(bin, args, opts);
        }
        securityCmds.push([bin, ...args]);
        if (args[0] === "find-identity") {
          findCalls += 1;
          return findCalls === 1
            ? "     0 valid identities found\n"
            : `  1) BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB "${DEFAULT_LOCAL_CODESIGN_IDENTITY}"\n`;
        }
        return "";
      },
    });
    assert.equal(createRes.ok, true);
    assert.equal(createRes.alreadyExists, false);
    assert.equal(securityCmds.some((c) => c[1] === "import" && c.includes("/tmp/fake-login.keychain-db")), true);
    assert.equal(
      securityCmds.some((c) => c[1] === "add-trusted-cert" && c.includes("codeSign")),
      true
    );
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("open-permissions CLI helper probes binary, opens only missing panes, and respects flags", async () => {
  const fakeAppRoot = mkdtempSync(path.join(tmpdir(), "cua-open-perm-"));
  const helperAppPath = path.join(fakeAppRoot, "CUADesktopHelper.app");
  const helperBin = path.join(helperAppPath, "Contents", "MacOS", "CUADesktopHelper");
  mkdirSync(path.dirname(helperBin), { recursive: true });
  writeFileSync(helperBin, "#!/bin/sh\n", { mode: 0o755 });

  try {
    const execCalls = [];
    const opened = [];
    const res1 = await runPermissionGuide({
      platform: "darwin",
      helperAppPath,
      register: true,
      open: true,
      isTty: false,
      log: () => {},
      execFileAsyncFn: async (bin, args) => {
        execCalls.push([bin, ...args]);
        return {
          stdout: JSON.stringify({
            ok: true,
            registered: true,
            accessibility: false,
            screenRecording: true,
            inputMonitoring: false,
            missing: ["accessibility", "inputMonitoring"],
          }),
        };
      },
      openSettingsFn: async (kind) => {
        opened.push(kind);
        return { ok: true, kind };
      },
    });
    assert.equal(res1.ok, true);
    assert.deepEqual(execCalls, [[helperBin, "--register-permissions"]]);
    assert.deepEqual(res1.targetKinds, ["accessibility", "inputMonitoring"]);
    assert.deepEqual(opened, ["accessibility"]);

    // TTY prompt mode steps through both missing panes sequentially
    const openedTty = [];
    const prompted = [];
    const resTty = await runPermissionGuide({
      platform: "darwin",
      helperAppPath,
      register: false,
      open: true,
      isTty: true,
      log: () => {},
      execFileAsyncFn: async (_bin, args) => {
        assert.deepEqual(args, ["--check-permissions"]);
        return {
          stdout: JSON.stringify({
            ok: true,
            registered: false,
            accessibility: false,
            screenRecording: true,
            inputMonitoring: false,
          }),
        };
      },
      openSettingsFn: async (kind) => {
        openedTty.push(kind);
        return { ok: true, kind };
      },
      promptNextFn: async (kind) => {
        prompted.push(kind);
        return true;
      },
    });
    assert.deepEqual(prompted, ["inputMonitoring"]);
    assert.deepEqual(openedTty, ["accessibility", "inputMonitoring"]);
    assert.deepEqual(resTty.openedKinds, ["accessibility", "inputMonitoring"]);

    // --no-open never invokes openSettingsFn, and --kind targets explicitly
    const openedNoOpen = [];
    await runPermissionGuide({
      platform: "darwin",
      helperAppPath,
      register: false,
      open: false,
      log: () => {},
      execFileAsyncFn: async () => ({
        stdout: JSON.stringify({
          ok: true,
          accessibility: false,
          screenRecording: false,
          inputMonitoring: false,
        }),
      }),
      openSettingsFn: async (kind) => {
        openedNoOpen.push(kind);
        return { ok: true, kind };
      },
    });
    assert.deepEqual(openedNoOpen, []);

    const openedSpecific = [];
    await runPermissionGuide({
      platform: "darwin",
      helperAppPath,
      kind: "screenRecording",
      register: true,
      open: true,
      log: () => {},
      execFileAsyncFn: async () => ({
        stdout: JSON.stringify({
          ok: true,
          accessibility: true,
          screenRecording: true,
          inputMonitoring: true,
        }),
      }),
      openSettingsFn: async (kind) => {
        openedSpecific.push(kind);
        return { ok: true, kind };
      },
    });
    assert.deepEqual(openedSpecific, ["screenRecording"]);
  } finally {
    rmSync(fakeAppRoot, { recursive: true, force: true });
  }
});

test("Broker HTTP permission routes handle accessibility, all, openSettings, and disconnected helper fallback", async () => {
  const sock = path.join(tmpdir(), `cua-perm-routes-${process.pid}-${Date.now()}.sock`);
  const token = "perm-route-test-token";
  let helperConnected = true;
  const helperRequests = [];
  const settingsOpened = [];

  const fakeHelper = {
    get available() {
      return helperConnected;
    },
    async start() {
      return this.getDiagnostics();
    },
    getDiagnostics() {
      return {
        available: helperConnected,
        videoAvailable: helperConnected,
        authenticated: helperConnected,
        pid: helperConnected ? 12345 : null,
        bundleId: "io.codexstyle.cua.desktop-helper.dev",
        reason: helperConnected ? null : "helper_disconnected",
        capabilities: {
          screenRecordingPreflight: false,
          inputMonitoringPreflight: false,
          accessibilityTrusted: false,
          mouseTapActive: false,
          keyTapActive: false,
          hotkeyActive: false,
          fallbackReason: "input_monitoring_not_granted",
        },
      };
    },
    async setTakeoverTargets() {
      return true;
    },
    async resetTakeoverLatch() {
      return true;
    },
    async requestPermission(kind) {
      helperRequests.push(kind);
      return { granted: false, kind, capabilities: this.getDiagnostics().capabilities };
    },
    async close() {},
  };

  const fakePeer = {
    child: null,
    isConnected: false,
    async callTool() {
      return { content: [{ type: "text", text: "[]" }] };
    },
    async close() {},
  };
  const fakeAxBridge = {
    pid: null,
    async checkPermissions() {
      return { platform: "darwin", accessibility: false, screenRecording: false };
    },
    async close() {},
  };

  const broker = new ComputerUseBrokerServer({
    webPort: 0,
    uiToken: token,
    socketPath: sock,
    actionPeer: fakePeer,
    streamPeer: fakePeer,
    axBridge: fakeAxBridge,
    desktopHelperClient: fakeHelper,
    permissionsFn: async () => ({ platform: "darwin", accessibility: false, screenRecording: false }),
    openPermissionSettingsFn: async (kind) => {
      settingsOpened.push(kind);
      return {
        ok: true,
        kind,
        labelZh: kind,
        settingsUrl: getPermissionSettingsUrl(kind),
      };
    },
    focusController: {
      async getFrontmostApp() {
        return null;
      },
      async restoreFrontmostApp() {
        return true;
      },
      sweepDelaysMs: [],
    },
  });

  const { webPort } = await broker.start();
  const postJson = async (pathname, body) => {
    const res = await fetch(`http://127.0.0.1:${webPort}${pathname}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Sidecar-Token": token,
      },
      body: JSON.stringify(body),
    });
    return { status: res.status, data: await res.json() };
  };

  try {
    const rAx = await postJson("/api/permissions/request", {
      kind: "accessibility",
      openSettings: true,
    });
    assert.equal(rAx.status, 200);
    assert.equal(rAx.data.ok, true);
    assert.equal(rAx.data.openedSettings?.kind, "accessibility");

    const rAll = await postJson("/api/permissions/request", {
      kind: "all",
      openSettings: true,
    });
    assert.equal(rAll.status, 200);
    assert.equal(rAll.data.ok, true);
    assert.equal(rAll.data.openedSettings?.kind, "accessibility");
    assert.deepEqual(helperRequests, ["accessibility", "all"]);

    const rDirect = await postJson("/api/permissions/open-settings", {
      kind: "inputMonitoring",
    });
    assert.equal(rDirect.status, 200);
    assert.equal(rDirect.data.ok, true);
    assert.equal(rDirect.data.kind, "inputMonitoring");

    const rBad = await postJson("/api/permissions/open-settings", {
      kind: "microphone",
    });
    assert.equal(rBad.status, 400);
    assert.equal(rBad.data.ok, false);

    // Disconnected helper flow
    helperConnected = false;
    const rDisconnectedNoOpen = await postJson("/api/permissions/request", {
      kind: "all",
      openSettings: false,
    });
    assert.equal(rDisconnectedNoOpen.status, 400);
    assert.equal(rDisconnectedNoOpen.data.ok, false);

    const rDisconnectedOpen = await postJson("/api/permissions/request", {
      kind: "all",
      openSettings: true,
    });
    assert.equal(rDisconnectedOpen.status, 200);
    assert.equal(rDisconnectedOpen.data.ok, true);
    assert.equal(rDisconnectedOpen.data.openedSettings?.kind, "accessibility");

    const rDisconnectedDirect = await postJson("/api/permissions/open-settings", {
      kind: "screenRecording",
    });
    assert.equal(rDisconnectedDirect.status, 200);
    assert.equal(rDisconnectedDirect.data.ok, true);
    assert.equal(rDisconnectedDirect.data.kind, "screenRecording");

    assert.deepEqual(settingsOpened, [
      "accessibility",
      "accessibility",
      "inputMonitoring",
      "accessibility",
      "screenRecording",
    ]);
  } finally {
    await broker.close();
  }
});

test("CUADesktopHelper --check-permissions emits structured JSON without prompting", async () => {
  if (process.platform !== "darwin") return;
  const binPath = DESKTOP_HELPER_BIN_PATH;
  const { stdout } = await execFileAsync(binPath, ["--check-permissions"], { timeout: 5000 });
  const parsed = JSON.parse(String(stdout || "").trim());
  assert.equal(parsed.ok, true);
  assert.equal(parsed.registered, false);
  assert.equal(typeof parsed.accessibility, "boolean");
  assert.equal(typeof parsed.screenRecording, "boolean");
  assert.equal(typeof parsed.inputMonitoring, "boolean");
  assert.equal(Array.isArray(parsed.missing), true);
  assert.equal(readFileSync(path.join(PROJECT_ROOT, "src", "ui", "index.html"), "utf8").includes(".innerHTML"), false);
});
