import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const MACOS_PERMISSION_KINDS = Object.freeze([
  "accessibility",
  "screenRecording",
  "inputMonitoring",
]);

export const MACOS_PERMISSION_SPECS = Object.freeze({
  accessibility: Object.freeze({
    kind: "accessibility",
    labelZh: "辅助功能 / 设备控制",
    labelEn: "Accessibility",
    settingsUrl: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  }),
  screenRecording: Object.freeze({
    kind: "screenRecording",
    labelZh: "录屏与系统录音",
    labelEn: "Screen Recording",
    settingsUrl: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
  }),
  inputMonitoring: Object.freeze({
    kind: "inputMonitoring",
    labelZh: "输入监控",
    labelEn: "Input Monitoring",
    settingsUrl: "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent",
  }),
});

/**
 * Look up metadata and deep-link URL for a macOS TCC permission kind.
 */
export function getPermissionSpec(kind) {
  if (typeof kind !== "string") return null;
  return MACOS_PERMISSION_SPECS[kind.trim()] || null;
}

export function getPermissionSettingsUrl(kind) {
  return getPermissionSpec(kind)?.settingsUrl || null;
}

/**
 * Open the matching macOS System Settings Privacy pane for one permission kind.
 */
export async function openMacOsPermissionSettings(
  kind,
  { execFileFn = execFileAsync, platform = process.platform } = {}
) {
  if (platform !== "darwin") {
    return { ok: false, error: "non_darwin" };
  }
  const spec = getPermissionSpec(kind);
  if (!spec) {
    return { ok: false, error: "unsupported_permission_kind" };
  }
  try {
    await execFileFn("/usr/bin/open", [spec.settingsUrl], { timeout: 5000 });
    return {
      ok: true,
      kind: spec.kind,
      labelZh: spec.labelZh,
      labelEn: spec.labelEn,
      settingsUrl: spec.settingsUrl,
    };
  } catch (err) {
    return {
      ok: false,
      kind: spec.kind,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Compute currently missing macOS permissions from broker state and helper diagnostics.
 */
export function collectMissingPermissions(permissions, permissionComponents = null) {
  if (!permissions || permissions.platform !== "darwin") {
    return [];
  }
  const helperComp = permissionComponents?.desktopHelper || null;
  const helperCaps = helperComp?.capabilities || null;
  const helperStatus = helperComp?.status || "unavailable";
  const helperAvail = Boolean(helperStatus && helperStatus !== "unavailable");
  const ocuStreamVerified = permissionComponents?.ocuStream?.status === "verified";

  const missing = [];
  if (
    permissions.accessibility === false ||
    (helperAvail && helperCaps?.accessibilityTrusted === false)
  ) {
    missing.push("accessibility");
  }

  const missingScreenRecording =
    helperAvail && typeof helperCaps?.screenRecordingPreflight === "boolean"
      ? !helperCaps.screenRecordingPreflight
      : permissions.screenRecording === false && !ocuStreamVerified;
  if (missingScreenRecording) {
    missing.push("screenRecording");
  }

  const missingInputMonitoring = Boolean(
    helperAvail &&
      helperCaps &&
      (helperCaps.inputMonitoringPreflight === false ||
        (!helperCaps.mouseTapActive && !helperCaps.keyTapActive))
  );
  if (missingInputMonitoring) {
    missing.push("inputMonitoring");
  }

  return missing;
}
