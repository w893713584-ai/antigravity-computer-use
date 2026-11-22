import { execFile } from "node:child_process";
import crypto from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  DESKTOP_HELPER_APP_PATH,
  NATIVE_PAYLOADS_DIR,
  NATIVE_RUNTIME_DIR,
  SCRIPT_RUNNER_APP_PATH,
  getExpectedNativeBundleId,
} from "./constants.mjs";

const execFileAsync = promisify(execFile);

export const EXPECTED_NATIVE_MANIFEST_VERSION = 1;

export function sha256File(filePath) {
  return crypto.createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

export async function inspectInfoPlist(appPath) {
  const plistPath = path.join(appPath, "Contents", "Info.plist");
  if (!existsSync(plistPath)) return null;
  if (process.platform === "darwin") {
    try {
      const { stdout } = await execFileAsync("/usr/bin/plutil", ["-convert", "json", "-o", "-", plistPath], {
        timeout: 4000,
      });
      return JSON.parse(stdout);
    } catch {}
  }
  const xml = readFileSync(plistPath, "utf8");
  const getKey = (k) => {
    const m = new RegExp(`<key>${k}</key>\\s*<string>([^<]*)</string>`, "u").exec(xml);
    return m ? m[1] : null;
  };
  return {
    CFBundleIdentifier: getKey("CFBundleIdentifier"),
    CFBundleExecutable: getKey("CFBundleExecutable"),
    CFBundleVersion: getKey("CFBundleVersion"),
    LSMinimumSystemVersion: getKey("LSMinimumSystemVersion"),
  };
}

export async function inspectCodesign(appPath) {
  if (process.platform !== "darwin") {
    return { valid: true, adhoc: false, identifier: null, teamId: null, flags: [] };
  }
  try {
    await execFileAsync("/usr/bin/codesign", ["--verify", "--deep", "--strict", appPath], {
      timeout: 8000,
    });
  } catch (err) {
    return {
      valid: false,
      error: String(err?.stderr || err?.message || "codesign_verify_failed").trim(),
    };
  }
  try {
    // codesign -dvvv prints metadata to stderr
    const { stdout, stderr } = await execFileAsync("/usr/bin/codesign", ["-dvvv", appPath], {
      timeout: 5000,
    }).catch((e) => ({ stdout: e.stdout || "", stderr: e.stderr || "" }));
    const raw = `${stdout || ""}\n${stderr || ""}`;
    const idMatch = /^Identifier=(.+)$/mu.exec(raw);
    const teamMatch = /^TeamIdentifier=(.+)$/mu.exec(raw);
    const sigMatch = /^Signature=(.+)$/mu.exec(raw);
    const flagsMatch = /^CodeDirectory.*flags=([^\n]+)$/mu.exec(raw);
    const adhoc =
      Boolean(sigMatch && sigMatch[1].trim() === "adhoc") ||
      Boolean(flagsMatch && flagsMatch[1].includes("adhoc")) ||
      (teamMatch ? teamMatch[1].trim() === "not set" : false);
    return {
      valid: true,
      adhoc,
      identifier: idMatch ? idMatch[1].trim() : null,
      teamId: teamMatch && teamMatch[1].trim() !== "not set" ? teamMatch[1].trim() : null,
      raw,
    };
  } catch (err) {
    return {
      valid: false,
      error: String(err?.message || err),
    };
  }
}

export async function runScriptRunnerDenialSelfTest(binPath) {
  if (process.platform !== "darwin") {
    return { ok: true, skipped: true };
  }
  const homeProbe = os.homedir() || "/Users";
  const tmpProbeDir = mkdtempSync(path.join("/tmp", "cua-sb-test-"));
  const udsPath = path.join(tmpProbeDir, "p.sock");
  const tmpWritePath = path.join(tmpProbeDir, "w.txt");
  let server = null;
  try {
    server = net.createServer();
    await new Promise((resolve) => server.listen(udsPath, resolve));
    const { stdout } = await execFileAsync(
      binPath,
      [
        "--self-test-denials",
        "--probe-home",
        homeProbe,
        "--probe-tmp",
        tmpWritePath,
        "--probe-uds",
        udsPath,
      ],
      {
        env: {
          PATH: "/usr/bin:/bin",
          LANG: "en_US.UTF-8",
          JSC_useJIT: "false",
          JSC_useWasm: "false",
          JSC_validateOptions: "true",
        },
        timeout: 6000,
      }
    );
    const parsed = JSON.parse(String(stdout || "").trim());
    return { ok: Boolean(parsed?.ok), report: parsed };
  } catch (err) {
    const out = String(err?.stdout || "").trim();
    let parsed = null;
    try {
      parsed = JSON.parse(out);
    } catch {}
    return {
      ok: false,
      error: String(err?.stderr || err?.message || "self_test_denials_failed").trim(),
      report: parsed,
    };
  } finally {
    if (server) {
      await new Promise((resolve) => server.close(() => resolve()));
    }
    rmSync(tmpProbeDir, { recursive: true, force: true });
  }
}

export async function runDesktopHelperEncoderSelfTest(binPath) {
  if (process.platform !== "darwin") {
    return { ok: true, skipped: true };
  }
  try {
    const { stdout } = await execFileAsync(binPath, ["--self-test-encoder"], {
      env: { PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8" },
      timeout: 6000,
    });
    const parsed = JSON.parse(String(stdout || "").trim());
    return {
      ok: Boolean(parsed?.ok && parsed?.isIdr && Number(parsed?.auBytes) > 0),
      ...parsed,
    };
  } catch (err) {
    const out = String(err?.stdout || "").trim();
    let parsed = null;
    try {
      parsed = JSON.parse(out);
    } catch {}
    return {
      ok: false,
      error: parsed?.error || String(err?.stderr || err?.message || "encoder_self_test_failed").trim(),
      ...parsed,
    };
  }
}

export async function verifyNativeAppBundle(
  appPath,
  {
    role,
    expectedBundleId = null,
    requiredTeamId = null,
    expectedArchs = null,
    signingMode = null,
    skipSelfTest = false,
  } = {}
) {
  const execName = role === "desktopHelper" ? "CUADesktopHelper" : "CUAScriptRunner";
  const binPath = path.join(appPath, "Contents", "MacOS", execName);
  if (!existsSync(appPath) || !existsSync(binPath)) {
    return { ok: false, reason: "bundle_or_binary_missing", binPath };
  }

  const plist = await inspectInfoPlist(appPath);
  const actualBundleId = plist?.CFBundleIdentifier || null;
  if (!actualBundleId) {
    return { ok: false, reason: "missing_bundle_identifier" };
  }
  const minOsRaw = plist?.LSMinimumSystemVersion ? String(plist.LSMinimumSystemVersion).trim() : null;
  if (minOsRaw) {
    const major = Number.parseInt(minOsRaw.split(".")[0], 10);
    if (Number.isFinite(major) && major < 14) {
      return { ok: false, reason: `min_os_too_low:${minOsRaw}` };
    }
  }

  const signInfo = await inspectCodesign(appPath);
  if (!signInfo.valid) {
    return { ok: false, reason: `codesign_invalid:${signInfo.error || "unknown"}` };
  }

  const allowedDevId = getExpectedNativeBundleId(role, { isDev: true });
  const allowedProdId = getExpectedNativeBundleId(role, { isDev: false });
  if (expectedBundleId && actualBundleId !== expectedBundleId) {
    return {
      ok: false,
      reason: `bundle_id_mismatch:expected=${expectedBundleId}:actual=${actualBundleId}`,
    };
  }
  if (![allowedDevId, allowedProdId].includes(actualBundleId)) {
    return { ok: false, reason: `unexpected_bundle_id:${actualBundleId}` };
  }
  if (process.platform === "darwin") {
    if (signInfo.identifier && signInfo.identifier !== actualBundleId) {
      return {
        ok: false,
        reason: `codesign_identifier_mismatch:${signInfo.identifier}!=${actualBundleId}`,
      };
    }
    if (requiredTeamId && signInfo.teamId !== requiredTeamId) {
      return { ok: false, reason: `team_mismatch:${signInfo.teamId}!=${requiredTeamId}` };
    }
    if (signingMode && signingMode !== "adhoc") {
      if (signInfo.adhoc) {
        return { ok: false, reason: "expected_signed_not_adhoc" };
      }
      if (!requiredTeamId) {
        return { ok: false, reason: "missing_required_team_id" };
      }
    }
    if (!signInfo.adhoc && actualBundleId === allowedDevId && !process.env.AGY_CUA_CODESIGN_IDENTITY) {
      // signed with formal identity -> allowed only when using prod ID unless explicitly testing
    } else if (signInfo.adhoc && actualBundleId === allowedProdId) {
      return { ok: false, reason: "adhoc_must_not_use_prod_bundle_id" };
    }
  }

  let archs = [];
  if (process.platform === "darwin") {
    try {
      const { stdout } = await execFileAsync("/usr/bin/lipo", ["-archs", binPath], { timeout: 3000 });
      archs = String(stdout || "")
        .trim()
        .split(/\s+/u)
        .filter(Boolean);
    } catch {}
    if (Array.isArray(expectedArchs) && expectedArchs.length > 0) {
      const missingArch = expectedArchs.find((arch) => !archs.includes(arch));
      if (missingArch) {
        return { ok: false, reason: `missing_expected_arch:${missingArch}`, archs };
      }
    }
  }

  if (role === "scriptRunner" && !skipSelfTest && process.platform === "darwin") {
    const sbRes = await runScriptRunnerDenialSelfTest(binPath);
    if (!sbRes.ok) {
      return {
        ok: false,
        reason: `seatbelt_self_test_failed:${sbRes.error || JSON.stringify(sbRes.report)}`,
        bundleId: actualBundleId,
      };
    }
  }

  return {
    ok: true,
    role,
    appPath,
    binPath,
    bundleId: actualBundleId,
    adhoc: Boolean(signInfo.adhoc),
    teamId: signInfo.teamId || null,
    archs,
  };
}

function replaceBundleAtomically(stagedAppPath, targetAppPath) {
  const runtimeDir = path.dirname(targetAppPath);
  mkdirSync(runtimeDir, { recursive: true });
  const suffix = `${process.pid}-${Date.now()}`;
  const nextPath = path.join(runtimeDir, `.${path.basename(targetAppPath)}.next-${suffix}`);
  const backupPath = `${targetAppPath}.prev-${suffix}`;
  rmSync(nextPath, { recursive: true, force: true });
  cpSync(stagedAppPath, nextPath, { recursive: true });
  const hadPrevious = existsSync(targetAppPath);
  let movedPrevious = false;
  try {
    if (hadPrevious) {
      renameSync(targetAppPath, backupPath);
      movedPrevious = true;
    }
    renameSync(nextPath, targetAppPath);
    if (movedPrevious) {
      rmSync(backupPath, { recursive: true, force: true });
    }
    return { installed: true, rolledBack: false };
  } catch (err) {
    rmSync(nextPath, { recursive: true, force: true });
    rmSync(targetAppPath, { recursive: true, force: true });
    if (movedPrevious && existsSync(backupPath)) {
      try {
        renameSync(backupPath, targetAppPath);
        return { installed: false, rolledBack: true, error: err?.message || String(err) };
      } catch {}
    }
    throw err;
  }
}

/**
 * Unpack, SHA-verify, codesign-verify, and atomically install CUADesktopHelper.app &
 * CUAScriptRunner.app into `<installDir>/native-runtime/` with independent component
 * degradation and previous-verified-bundle preservation on failure.
 */
export async function stageAndInstallNativePayloads({
  sourceRoot,
  installDir,
  darwinReleaseOverride = null,
  skipSelfTest = false,
  log = () => {},
} = {}) {
  const payloadsDir = path.join(sourceRoot, "native-payloads");
  const manifestPath = path.join(payloadsDir, "manifest.json");
  const destRuntimeDir = path.join(installDir, "native-runtime");
  mkdirSync(destRuntimeDir, { recursive: true });

  const componentSpecs = [
    { role: "desktopHelper", appName: "CUADesktopHelper.app", key: "desktopHelper" },
    { role: "scriptRunner", appName: "CUAScriptRunner.app", key: "scriptRunner" },
  ];

  const report = {
    manifestFound: existsSync(manifestPath),
    components: {},
  };

  if (darwinReleaseOverride && Number.parseInt(String(darwinReleaseOverride).split(".")[0], 10) < 23) {
    return report;
  }

  let manifest = null;
  if (report.manifestFound) {
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch (err) {
      report.manifestError = err?.message || String(err);
    }
  }

  const stageBase = mkdtempSync(path.join(os.tmpdir(), "cua-native-stage-"));
  try {
    for (const spec of componentSpecs) {
      const targetApp = path.join(destRuntimeDir, spec.appName);
      const entry = manifest?.components?.[spec.key] || null;
      const zipFile = entry?.zipFile ? path.join(payloadsDir, entry.zipFile) : null;

      if (!entry || !zipFile || !existsSync(zipFile)) {
        // Check whether a previously verified runtime bundle can be kept safely
        if (existsSync(targetApp)) {
          const prevCheck = await verifyNativeAppBundle(targetApp, {
            role: spec.role,
            skipSelfTest,
          });
          if (prevCheck.ok) {
            report.components[spec.key] = {
              status: "preserved_previous",
              reason: "payload_missing",
              bundleId: prevCheck.bundleId,
            };
            continue;
          }
        }
        report.components[spec.key] = {
          status: "degraded",
          reason: !manifest ? "manifest_missing_or_invalid" : "payload_zip_missing",
        };
        continue;
      }

      const actualZipSha = sha256File(zipFile);
      if (entry.zipSha256 && actualZipSha !== entry.zipSha256) {
        if (existsSync(targetApp)) {
          const prevCheck = await verifyNativeAppBundle(targetApp, {
            role: spec.role,
            skipSelfTest,
          });
          if (prevCheck.ok) {
            report.components[spec.key] = {
              status: "preserved_previous",
              reason: "zip_sha256_mismatch",
              bundleId: prevCheck.bundleId,
            };
            continue;
          }
        }
        report.components[spec.key] = {
          status: "degraded",
          reason: "zip_sha256_mismatch",
        };
        continue;
      }

      const compStageDir = path.join(stageBase, spec.key);
      mkdirSync(compStageDir, { recursive: true });
      try {
        if (process.platform === "darwin") {
          await execFileAsync("/usr/bin/ditto", ["-x", "-k", zipFile, compStageDir], {
            timeout: 15_000,
          });
        } else {
          throw new Error("non_darwin_unpack_unsupported");
        }
      } catch (err) {
        report.components[spec.key] = {
          status: "degraded",
          reason: `unpack_failed:${err?.message || err}`,
        };
        continue;
      }

      const stagedApp = path.join(compStageDir, spec.appName);
      // Only clear quarantine on explicit ad-hoc dev bundles; keep Gatekeeper intact on notarized Developer ID builds
      if (process.platform === "darwin" && entry.signingMode === "adhoc" && existsSync(stagedApp)) {
        await execFileAsync("/usr/bin/xattr", ["-dr", "com.apple.quarantine", stagedApp], {
          timeout: 5000,
        }).catch(() => {});
      }

      const check = await verifyNativeAppBundle(stagedApp, {
        role: spec.role,
        expectedBundleId: entry.bundleId || null,
        requiredTeamId: entry.teamId || null,
        expectedArchs: Array.isArray(entry.archs) ? entry.archs : null,
        signingMode: entry.signingMode || null,
        skipSelfTest,
      });

      if (!check.ok) {
        if (existsSync(targetApp)) {
          const prevCheck = await verifyNativeAppBundle(targetApp, {
            role: spec.role,
            skipSelfTest,
          });
          if (prevCheck.ok) {
            report.components[spec.key] = {
              status: "preserved_previous",
              reason: check.reason,
              bundleId: prevCheck.bundleId,
            };
            continue;
          }
        }
        report.components[spec.key] = {
          status: "degraded",
          reason: check.reason,
        };
        continue;
      }

      const execName = spec.role === "desktopHelper" ? "CUADesktopHelper" : "CUAScriptRunner";
      const targetBin = path.join(targetApp, "Contents", "MacOS", execName);
      const stagedBin = path.join(stagedApp, "Contents", "MacOS", execName);
      const targetPlist = path.join(targetApp, "Contents", "Info.plist");
      const stagedPlist = path.join(stagedApp, "Contents", "Info.plist");
      if (
        existsSync(targetApp) &&
        existsSync(targetBin) &&
        existsSync(stagedBin) &&
        existsSync(targetPlist) &&
        existsSync(stagedPlist) &&
        sha256File(targetBin) === sha256File(stagedBin) &&
        readFileSync(targetPlist).equals(readFileSync(stagedPlist))
      ) {
        const existingCheck = await verifyNativeAppBundle(targetApp, {
          role: spec.role,
          expectedBundleId: entry.bundleId || null,
          requiredTeamId: entry.teamId || null,
          expectedArchs: Array.isArray(entry.archs) ? entry.archs : null,
          signingMode: entry.signingMode || null,
          skipSelfTest: true,
        });
        if (existingCheck.ok) {
          log(
            `已复用无变更原生组件 ${spec.appName} (${existingCheck.bundleId}${existingCheck.adhoc ? " · adhoc" : ""})`
          );
          report.components[spec.key] = {
            status: "installed",
            reusedInPlace: true,
            bundleId: existingCheck.bundleId,
            adhoc: existingCheck.adhoc,
            archs: existingCheck.archs,
          };
          continue;
        }
      }

      const swapRes = replaceBundleAtomically(stagedApp, targetApp);
      if (process.platform === "darwin" && entry.signingMode === "adhoc") {
        await execFileAsync("/usr/bin/xattr", ["-dr", "com.apple.quarantine", targetApp], {
          timeout: 5000,
        }).catch(() => {});
      }
      log(`已验证并安装原生组件 ${spec.appName} (${check.bundleId}${check.adhoc ? " · adhoc" : ""})`);
      report.components[spec.key] = {
        status: swapRes.installed ? "installed" : "preserved_previous",
        bundleId: check.bundleId,
        adhoc: check.adhoc,
        archs: check.archs,
      };
    }
  } finally {
    rmSync(stageBase, { recursive: true, force: true });
  }

  return report;
}

export function resolveDefaultNativeBundlePaths() {
  return {
    nativeRuntimeDir: NATIVE_RUNTIME_DIR,
    nativePayloadsDir: NATIVE_PAYLOADS_DIR,
    desktopHelperAppPath: DESKTOP_HELPER_APP_PATH,
    scriptRunnerAppPath: SCRIPT_RUNNER_APP_PATH,
  };
}
