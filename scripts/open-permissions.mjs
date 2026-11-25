#!/usr/bin/env node

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { isMainModule } from "../src/constants.mjs";
import {
  MACOS_PERMISSION_KINDS,
  MACOS_PERMISSION_SPECS,
  openMacOsPermissionSettings,
} from "../src/macos-permissions.mjs";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = path.resolve(__dirname, "..");

const CLI_LABELS_ZH = Object.freeze({
  accessibility: "辅助功能 / 设备控制和数据访问 (Accessibility)",
  screenRecording: "录屏与系统录音 (Screen Recording)",
  inputMonitoring: "输入监控 (Input Monitoring)",
});

export function resolveDesktopHelperAppPath({
  homeDir = process.env.HOME || homedir(),
  repoRoot = defaultRepoRoot,
} = {}) {
  const installedApp = path.join(
    homeDir,
    ".gemini",
    "codex-style-computer-use",
    "native-runtime",
    "CUADesktopHelper.app"
  );
  const installedBin = path.join(installedApp, "Contents", "MacOS", "CUADesktopHelper");
  if (existsSync(installedBin)) {
    return installedApp;
  }
  const repoApp = path.join(repoRoot, "native-runtime", "CUADesktopHelper.app");
  return repoApp;
}

export async function probeOrRegisterHelperPermissions({
  helperBinPath,
  register = true,
  execFileAsyncFn = execFileAsync,
} = {}) {
  if (!helperBinPath || !existsSync(helperBinPath)) {
    throw new Error(`未找到 CUADesktopHelper 可执行文件: ${helperBinPath || "(empty)"}`);
  }
  const flag = register ? "--register-permissions" : "--check-permissions";
  const { stdout } = await execFileAsyncFn(helperBinPath, [flag], { timeout: 8000 });
  const parsed = JSON.parse(String(stdout || "").trim() || "{}");
  return {
    ok: Boolean(parsed?.ok),
    registered: Boolean(parsed?.registered),
    accessibility: Boolean(parsed?.accessibility),
    screenRecording: Boolean(parsed?.screenRecording),
    inputMonitoring: Boolean(parsed?.inputMonitoring),
    missing: Array.isArray(parsed?.missing)
      ? parsed.missing
      : MACOS_PERMISSION_KINDS.filter((k) => !parsed?.[k]),
  };
}

export async function runPermissionGuide({
  kind = "all",
  register = true,
  open = true,
  helperAppPath = resolveDesktopHelperAppPath(),
  execFileAsyncFn = execFileAsync,
  openSettingsFn = openMacOsPermissionSettings,
  promptNextFn = null,
  isTty = Boolean(process.stdin.isTTY && process.stdout.isTTY),
  log = console.log,
  platform = process.platform,
} = {}) {
  if (platform !== "darwin") {
    log("[permissions] 当前系统不是 macOS，无需配置 TCC 权限。");
    return { ok: false, reason: "non_darwin", openedKinds: [] };
  }
  const normalizedKind = String(kind || "all").trim();
  if (normalizedKind !== "all" && !MACOS_PERMISSION_SPECS[normalizedKind]) {
    throw new Error(`不支持的权限类型: ${normalizedKind}`);
  }

  const helperBinPath = path.join(helperAppPath, "Contents", "MacOS", "CUADesktopHelper");
  const status = await probeOrRegisterHelperPermissions({
    helperBinPath,
    register,
    execFileAsyncFn,
  });

  log("\n[macOS 权限检测结果]");
  log(`  Helper 路径: ${helperAppPath}`);
  for (const k of MACOS_PERMISSION_KINDS) {
    const ok = Boolean(status[k]);
    log(`  ${ok ? "✅" : "❌"} ${CLI_LABELS_ZH[k]}: ${ok ? "已授权" : "未授权"}`);
  }

  const targetKinds =
    normalizedKind === "all"
      ? MACOS_PERMISSION_KINDS.filter((k) => !status[k])
      : [normalizedKind];

  const openedKinds = [];
  if (open && targetKinds.length > 0) {
    const first = targetKinds[0];
    const firstRes = await openSettingsFn(first);
    if (firstRes?.ok) {
      openedKinds.push(first);
      log(`\n[已打开系统设置] ${CLI_LABELS_ZH[first]}`);
    } else {
      log(`\n[打开设置失败] ${CLI_LABELS_ZH[first]}: ${firstRes?.error || "unknown"}`);
    }

    const remaining = targetKinds.slice(1);
    if (remaining.length > 0) {
      if (isTty && typeof promptNextFn === "function") {
        for (const nextKind of remaining) {
          const shouldContinue = await promptNextFn(nextKind, CLI_LABELS_ZH[nextKind]);
          if (!shouldContinue) break;
          const res = await openSettingsFn(nextKind);
          if (res?.ok) {
            openedKinds.push(nextKind);
            log(`[已打开系统设置] ${CLI_LABELS_ZH[nextKind]}`);
          }
        }
      } else {
        log("\n[其余待开启权限页面]");
        for (const rem of remaining) {
          log(`  • ${CLI_LABELS_ZH[rem]} -> npm run permissions:guide -- --kind ${rem}`);
        }
      }
    }
  } else if (targetKinds.length === 0) {
    log("\n[完成] 三项系统权限均已生效！");
  }

  return {
    ok: true,
    helperAppPath,
    status,
    targetKinds,
    openedKinds,
  };
}

function parseCliArgs(argv) {
  let kind = "all";
  let register = true;
  let open = true;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--check-only") {
      register = false;
      open = false;
    } else if (arg === "--no-register") {
      register = false;
    } else if (arg === "--no-open") {
      open = false;
    } else if (arg === "--kind" && i + 1 < argv.length) {
      kind = argv[++i];
    }
  }
  return { kind, register, open };
}

if (isMainModule(import.meta.url)) {
  const { kind, register, open } = parseCliArgs(process.argv.slice(2));
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const promptNextFn = interactive
    ? async (_nextKind, label) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        try {
          const answer = await rl.question(`\n勾选完成后按 Enter 跳转下一项「${label}」（输入 q 退出）: `);
          return answer.trim().toLowerCase() !== "q";
        } finally {
          rl.close();
        }
      }
    : null;

  runPermissionGuide({
    kind,
    register,
    open,
    isTty: interactive,
    promptNextFn,
  }).catch((err) => {
    console.error(`[permissions] 失败: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
