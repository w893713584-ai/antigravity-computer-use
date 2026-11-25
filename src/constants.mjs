import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(__dirname, "..");

const HOME = process.env.HOME || homedir();

function discoverInstalledOcuDirs() {
  const geminiConfigDir = path.join(HOME, ".gemini", "config");
  if (!existsSync(geminiConfigDir)) return [];
  try {
    return readdirSync(geminiConfigDir)
      .filter((entry) => entry.startsWith("computer-use-"))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      .map((entry) => path.join(geminiConfigDir, entry, "node_modules", "open-computer-use"));
  } catch {
    return [];
  }
}

const INSTALLED_OCU_DIRS = [
  path.join(PROJECT_ROOT, "node_modules", "open-computer-use"),
  ...discoverInstalledOcuDirs(),
  path.join(HOME, ".gemini/config/computer-use-1.1.3/node_modules/open-computer-use"),
  "/opt/homebrew/lib/node_modules/open-computer-use",
  "/usr/local/lib/node_modules/open-computer-use",
];

function findMatchedOcuDir() {
  for (const dir of INSTALLED_OCU_DIRS) {
    const appBin = path.join(dir, "dist", "Open Computer Use.app", "Contents", "MacOS", "OpenComputerUse");
    const replMod = path.join(dir, "scripts", "node-repl", "open-computer-use-repl.mjs");
    if (existsSync(appBin) && existsSync(replMod)) {
      return { appBin, replMod };
    }
  }
  return null;
}

const MATCHED_OCU = findMatchedOcuDir();

const CANDIDATE_OCU_BINS = [
  process.env.OCU_BIN,
  MATCHED_OCU?.appBin,
  ...INSTALLED_OCU_DIRS.map((dir) =>
    path.join(dir, "dist", "Open Computer Use.app", "Contents", "MacOS", "OpenComputerUse")
  ),
  ...INSTALLED_OCU_DIRS.map((dir) => path.resolve(dir, "..", ".bin", "open-computer-use")),
  "/opt/homebrew/bin/open-computer-use",
  "/usr/local/bin/open-computer-use",
].filter(Boolean);

export const OPEN_COMPUTER_USE_BIN =
  CANDIDATE_OCU_BINS.find((candidate) => existsSync(candidate)) || "open-computer-use";

const CANDIDATE_REPL_MODULES = [
  process.env.OCU_REPL_MODULE,
  MATCHED_OCU?.replMod,
  ...INSTALLED_OCU_DIRS.map((dir) =>
    path.join(dir, "scripts", "node-repl", "open-computer-use-repl.mjs")
  ),
].filter(Boolean);

const resolvedReplPath =
  CANDIDATE_REPL_MODULES.find((candidate) =>
    candidate.startsWith("file://") ? existsSync(fileURLToPath(candidate)) : existsSync(candidate)
  ) || CANDIDATE_REPL_MODULES[0];

export const OPEN_COMPUTER_USE_REPL_MODULE = resolvedReplPath.startsWith("file://")
  ? resolvedReplPath
  : pathToFileURL(resolvedReplPath).href;

export const SIDECAR_PRELOAD_PATH = path.join(
  HOME,
  ".gemini/config/node_modules/sidecar_sdk/preload.js"
);

export const UI_HTML_PATH = path.join(__dirname, "ui", "index.html");
export const PREVIEW_VIDEO_JS_PATH = path.join(__dirname, "ui", "preview-video.js");

// Rollback switch for Phase 2 H.264 video streaming ("jpeg" or "off" forces JPEG-only mode).
export const VIDEO_MODE_ENV = (process.env.AGY_CUA_VIDEO || "auto").trim().toLowerCase();

export const VIDEO_WIRE_MAGIC = "CUV1";
export const VIDEO_WIRE_HEADER_BYTES = 40;
export const VIDEO_PACKET_TYPE = Object.freeze({
  CONFIG: 1,
  ACCESS_UNIT: 2,
  STATUS: 3,
});
export const VIDEO_AU_FLAG_IDR = 0x01;
export const VIDEO_MAX_CONFIG_BYTES = 16 * 1024;
export const VIDEO_MAX_AU_BYTES = 2 * 1024 * 1024;
export const VIDEO_MAX_STATUS_BYTES = 4 * 1024;
export const VIDEO_WS_SUBPROTOCOL = "cua.h264.v1";
export const VIDEO_MAX_ACTIVE_TARGETS = 2;
export const VIDEO_TARGET_WARM_HOLD_MS = 3000;
export const VIDEO_MAX_FPS = 20;
export const VIDEO_MAX_DIMENSION = 1280;
export const VIDEO_FIRST_FRAME_TIMEOUT_MS = 2000;
export const VIDEO_IDR_RECOVERY_TIMEOUT_MS = 1000;
export const VIDEO_BACKPRESSURE_MAX_AGE_MS = 300;
export const VIDEO_TICKET_TTL_MS = 10_000;

// Keep socket path well under macOS 104-byte sockaddr_un.sun_path limit.
export const BROKER_STATE_DIR = path.join(HOME, ".config", "ocu");
export const BROKER_SOCKET_PATH =
  process.env.AGY_CUA_BROKER_SOCK || path.join(BROKER_STATE_DIR, "agy-cua.sock");
export const BROKER_INFO_PATH = path.join(BROKER_STATE_DIR, "agy-cua-sidecar.json");
export const BROKER_SPAWN_LOCK_PATH = path.join(BROKER_STATE_DIR, "agy-cua-spawn.lock");

export const NATIVE_RUNTIME_DIR = path.join(PROJECT_ROOT, "native-runtime");
export const NATIVE_PAYLOADS_DIR = path.join(PROJECT_ROOT, "native-payloads");
export const DESKTOP_HELPER_APP_PATH =
  process.env.AGY_CUA_DESKTOP_HELPER_APP ||
  path.join(NATIVE_RUNTIME_DIR, "CUADesktopHelper.app");
export const DESKTOP_HELPER_BIN_PATH = path.join(
  DESKTOP_HELPER_APP_PATH,
  "Contents",
  "MacOS",
  "CUADesktopHelper"
);
export const SCRIPT_RUNNER_APP_PATH =
  process.env.AGY_CUA_SCRIPT_RUNNER_APP ||
  path.join(NATIVE_RUNTIME_DIR, "CUAScriptRunner.app");
export const SCRIPT_RUNNER_BIN_PATH = path.join(
  SCRIPT_RUNNER_APP_PATH,
  "Contents",
  "MacOS",
  "CUAScriptRunner"
);

export function getExpectedNativeBundleId(role, { isDev = !process.env.AGY_CUA_CODESIGN_IDENTITY } = {}) {
  const prefix = (process.env.AGY_CUA_BUNDLE_ID_PREFIX || "io.codexstyle.cua").replace(/\.+$/u, "");
  const suffix = role === "desktopHelper" ? "desktop-helper" : "script-runner";
  return isDev ? `${prefix}.${suffix}.dev` : `${prefix}.${suffix}`;
}

export const REPL_MAX_SOURCE_BYTES = 64 * 1024;
export const REPL_MAX_BINDINGS_BYTES = 64 * 1024;
export const REPL_MAX_CALLS_PER_RUN = 32;
export const REPL_MAX_LINE_BYTES = 2 * 1024 * 1024;
export const REPL_MAX_RESULT_BYTES = 256 * 1024;
export const REPL_CPU_LIMIT_SEC = 2;
export const REPL_CPU_HARD_LIMIT_SEC = 3;
export const DEFAULT_EMERGENCY_HOTKEY = "ctrl+opt+escape";
export const EMERGENCY_HOTKEY =
  (process.env.AGY_CUA_EMERGENCY_HOTKEY || DEFAULT_EMERGENCY_HOTKEY).trim().toLowerCase() ||
  DEFAULT_EMERGENCY_HOTKEY;

export const SIDECAR_ID = "computer-use-preview";
export const SIDECAR_PILL_MARKDOWN = `[Computer Use 小窗](sidecar://${SIDECAR_ID}/)`;

let cachedDarwinShortTmpDir = null;

function isShortSafeTmpDir(dirPath) {
  if (typeof dirPath !== "string" || !dirPath.trim()) return false;
  if (dirPath.includes("/.t3/")) return false;
  try {
    const resolved = path.resolve(dirPath.trim());
    return Buffer.byteLength(resolved, "utf8") <= 56 && existsSync(resolved);
  } catch {
    return false;
  }
}

export function resolveSafeSystemTmpDir(rawEnv = process.env) {
  const candidate = rawEnv?.TMPDIR;
  if (process.platform !== "darwin") {
    return typeof candidate === "string" && candidate.trim() ? candidate.trim() : "/tmp";
  }
  if (isShortSafeTmpDir(candidate)) {
    return path.resolve(candidate.trim());
  }
  if (!cachedDarwinShortTmpDir || !existsSync(cachedDarwinShortTmpDir)) {
    let resolved = "/tmp";
    try {
      const darwinTmp = execFileSync("/usr/bin/getconf", ["DARWIN_USER_TEMP_DIR"], {
        encoding: "utf8",
        timeout: 1000,
      }).trim();
      if (isShortSafeTmpDir(darwinTmp)) {
        resolved = path.resolve(darwinTmp);
      }
    } catch {}
    cachedDarwinShortTmpDir = resolved;
  }
  return cachedDarwinShortTmpDir;
}

export function sanitizeHostEnv(rawEnv = process.env) {
  const clean = {};
  for (const [k, v] of Object.entries(rawEnv || {})) {
    if (
      k === "ELECTRON_RUN_AS_NODE" ||
      k === "GEMINI_HOME" ||
      k === "AGY_ACP_FORCE_FILE_STORAGE" ||
      /^AGY_(ACP|CLI)_/u.test(k)
    ) {
      continue;
    }
    if (v !== undefined) {
      clean[k] = v;
    }
  }
  clean.TMPDIR = resolveSafeSystemTmpDir(rawEnv);
  return clean;
}

export function detectMcpHost(env = process.env, clientInfo = null) {
  const explicit = String(env?.AGY_CUA_HOST || "").trim().toLowerCase();
  if (explicit === "t3" || explicit === "antigravity") {
    return explicit;
  }
  const clientName = String(clientInfo?.name || "").trim().toLowerCase();
  if (clientName.includes("t3")) {
    return "t3";
  }
  if (!env?.NODE_TEST_CONTEXT && !env?.AGY_CUA_BROKER_SOCK) {
    if (
      String(env?.GEMINI_HOME || "").includes("/.t3/") ||
      String(env?.XPC_SERVICE_NAME || "").startsWith("application.com.t3tools.") ||
      Boolean(
        env?.T3CODE_THREAD_ID || env?.T3CODE_DESKTOP_HOST_SCOPE || env?.T3_ACP_MCP_ENDPOINT
      )
    ) {
      return "t3";
    }
  }
  return "antigravity";
}

export function formatT3LiveViewUrl(webPort, uiToken = "") {
  const port = Number(webPort || 0);
  if (!(port > 0)) return "";
  const tokenParam = uiToken ? `?token=${encodeURIComponent(String(uiToken))}` : "";
  return `http://127.0.0.1:${port}/${tokenParam}`;
}

export function buildT3OneTimePillHint(webPort, uiToken = "") {
  const url = formatT3LiveViewUrl(webPort, uiToken);
  if (url) {
    return `[Side-pane live view: in T3 Code, include [Computer Use 实时小窗](${url}) once in your reply so the user can open the live mini-window in preview or browser.]`;
  }
  return "[Side-pane live view: running in T3 Code background mode without stealing window focus.]";
}

export const MAX_LINE_BUFFER_BYTES = 32 * 1024 * 1024;
export const MAX_HTTP_BODY_BYTES = 1024 * 1024;

export function isMainModule(importMetaUrl) {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(importMetaUrl));
  } catch {
    return false;
  }
}

export function buildNativeEnv(overrides = {}) {
  return {
    ...sanitizeHostEnv(process.env),
    // Hide floating desktop cursor: cursor renders inside the side-pane mini-window instead.
    OPEN_COMPUTER_USE_VISUAL_CURSOR: "0",
    // Keep windows in-place on desktop behind active windows (Codex unlocked desktop behavior).
    OPEN_COMPUTER_USE_VIRTUAL_DISPLAY_ENABLED: "false",
    // Disable native post-action read-back (.recoverVisible / AppDiscovery.resolve) so mutating
    // actions never foreground-activate or relaunch closed/quit apps; broker handles .readOnly read-back.
    OPEN_COMPUTER_USE_ACTION_READ_BACK: "0",
    // Hard-disable global physical pointer fallbacks (which call activateWithOptions:1).
    OPEN_COMPUTER_USE_ALLOW_GLOBAL_POINTER_FALLBACKS: "0",
    // Keep SkyLight synthetic focus ultra-brief (~4ms) on apps that still use native sky_click;
    // self-activating Qt/custom apps bypass sky_click/sky_key completely via JXA window_post.
    OPEN_COMPUTER_USE_SKY_CLICK_DELAY_SCALE: "0.25",
    OPEN_COMPUTER_USE_FOCUS_RECORD_SETTLE_MS: "4",
    // Fast, crisp JPEG encoding with identical coordinate geometry across action & stream engines.
    OPEN_COMPUTER_USE_IMAGE_FORMAT: "jpg",
    OPEN_COMPUTER_USE_IMAGE_JPEG_QUALITY: "0.80",
    OPEN_COMPUTER_USE_IMAGE_MAX_DIMENSION: "1280",
    ...overrides,
  };
}
