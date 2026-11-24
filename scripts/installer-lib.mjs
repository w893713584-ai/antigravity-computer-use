import { execFile } from "node:child_process";
import crypto from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import https from "node:https";
import http from "node:http";
import os, { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { stageAndInstallNativePayloads } from "../src/native-distribution.mjs";

const execFileAsync = promisify(execFile);

const SIDECAR_ID = "computer-use-preview";
const PREVIOUS_MCP_SNAPSHOT = ".previous-mcp-entries.json";
const GEMINI_RULE_BEGIN = "<!-- BEGIN CODEX-STYLE-COMPUTER-USE -->";
const GEMINI_RULE_END = "<!-- END CODEX-STYLE-COMPUTER-USE -->";
const MANAGED_GEMINI_RULE_BLOCK = `${GEMINI_RULE_BEGIN}
## Codex-Style Computer Use 小窗规则
- 当你在对话中首次使用 \`computer-use\` 或 \`computer-use-js\` 操作桌面应用时，必须在给用户的回复中附带一次 \`[Computer Use 小窗](sidecar://${SIDECAR_ID}/)\` 链接，方便用户在 Antigravity 右侧打开实时后台小窗。
- 操作普通后台应用时严禁调用 AppleScript \`activate\`、不带 \`-g\` 的 \`open -a\` 或 \`Raise\`，保持被操作窗口在后台运行、不置顶抢焦点。
- 特例：操作剪映专业版（\`com.lemon.lvpro\`）等 Qt6 自绘应用且后台滚轮、搜索框或弹窗失灵时，允许临时通过 \`osascript\` 将其 \`activate\` 到前台快速完成点击/输入，操作完成后立即退回后台或退出应用。
${GEMINI_RULE_END}`;

const STAGE_ITEMS = [
  "package.json",
  "README.md",
  "LICENSE",
  "THIRD_PARTY_NOTICES.md",
  "使用说明.txt",
  "双击安装.command",
  "双击卸载.command",
  "src",
  "scripts",
];

function discoverOcuRuntimeDirs(homeDir, installDir) {
  const dirs = [path.join(installDir, "node_modules", "open-computer-use")];
  const geminiCfg = path.join(homeDir, ".gemini", "config");
  if (existsSync(geminiCfg)) {
    try {
      const entries = readdirSync(geminiCfg)
        .filter((e) => e.startsWith("computer-use-"))
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
      for (const entry of entries) {
        dirs.push(path.join(geminiCfg, entry, "node_modules", "open-computer-use"));
      }
    } catch {}
  }
  dirs.push("/opt/homebrew/lib/node_modules/open-computer-use");
  dirs.push("/usr/local/lib/node_modules/open-computer-use");
  return dirs;
}

export function findInstalledOcuRuntime(homeDir, installDir) {
  for (const dir of discoverOcuRuntimeDirs(homeDir, installDir)) {
    const appBin = path.join(dir, "dist", "Open Computer Use.app", "Contents", "MacOS", "OpenComputerUse");
    const replMod = path.join(dir, "scripts", "node-repl", "open-computer-use-repl.mjs");
    if (existsSync(appBin)) {
      return { dir, appBin, replMod: existsSync(replMod) ? replMod : null };
    }
  }
  return null;
}

async function clearMacQuarantine(targetPath) {
  if (process.platform !== "darwin" || !existsSync(targetPath)) return;
  try {
    await execFileAsync("/usr/bin/xattr", ["-dr", "com.apple.quarantine", targetPath], {
      timeout: 8000,
    });
  } catch {}
}

function writeJsonAtomic(filePath, value, mode = undefined) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  let resolvedMode = mode;
  if (resolvedMode === undefined && existsSync(filePath)) {
    try {
      resolvedMode = statSync(filePath).mode & 0o777;
    } catch {}
  }
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(
    tmpPath,
    `${JSON.stringify(value, null, 2)}\n`,
    resolvedMode !== undefined ? { mode: resolvedMode } : undefined
  );
  if (resolvedMode !== undefined) {
    try {
      chmodSync(tmpPath, resolvedMode);
    } catch {}
  }
  renameSync(tmpPath, filePath);
}

function postJsonLocal({ protocol, port, pathName, csrfToken, body }) {
  const lib = protocol === "https:" ? https : http;
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = lib.request(
      {
        hostname: "127.0.0.1",
        port,
        path: pathName,
        method: "POST",
        rejectUnauthorized: false,
        timeout: 3000,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          "Connect-Protocol-Version": "1",
          "x-codeium-csrf-token": csrfToken,
        },
      },
      (res) => {
        res.resume();
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve(true);
          } else {
            reject(new Error(`HTTP ${res.statusCode}`));
          }
        });
      }
    );
    req.on("timeout", () => {
      req.destroy(new Error("timeout"));
    });
    req.on("error", reject);
    req.end(payload);
  });
}

/**
 * Communicate with running Antigravity `language_server` on macOS if open,
 * enabling/disabling the sidecar and hot-reloading MCP servers live.
 */
export async function syncLiveAntigravity({ enableSidecar }) {
  if (process.platform !== "darwin") return false;
  try {
    const { stdout: psOut } = await execFileAsync("/bin/ps", ["-axo", "pid=,command="], {
      timeout: 4000,
    });
    const line = psOut
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find(
        (l) =>
          l.includes("Antigravity.app/Contents/Resources/bin/language_server") &&
          l.includes("--csrf_token") &&
          !l.includes(" multicall ")
      );
    if (!line) return false;

    const pidMatch = /^(\d+)\s+/u.exec(line);
    const csrfMatch = /--csrf_token\s+([^\s]+)/u.exec(line);
    if (!pidMatch || !csrfMatch) return false;
    const pid = pidMatch[1];
    const csrfToken = csrfMatch[1];

    const { stdout: lsofOut } = await execFileAsync(
      "/usr/sbin/lsof",
      ["-Pan", "-p", pid, "-iTCP", "-sTCP:LISTEN"],
      { timeout: 4000 }
    );
    const ports = [];
    for (const row of lsofOut.split(/\r?\n/)) {
      const m = /127\.0\.0\.1:(\d+)\s+\(LISTEN\)/u.exec(row);
      if (m) ports.push(Number.parseInt(m[1], 10));
    }
    if (ports.length === 0) return false;

    for (const port of ports) {
      for (const protocol of ["https:", "http:"]) {
        try {
          await postJsonLocal({
            protocol,
            port,
            pathName: "/exa.language_server_pb.LanguageServerService/JetboxWriteState",
            csrfToken,
            body: {
              userConfig: {
                sidecars: {
                  [SIDECAR_ID]: { enabled: Boolean(enableSidecar) },
                },
              },
            },
          });
          await postJsonLocal({
            protocol,
            port,
            pathName: "/exa.language_server_pb.LanguageServerService/RefreshMcpServers",
            csrfToken,
            body: {},
          });
          return true;
        } catch {}
      }
    }
  } catch {}
  return false;
}

function isOwnSidecarProjectId(configDir, projectId) {
  if (typeof projectId !== "string") return false;
  const trimmed = projectId.trim();
  if (!trimmed || path.basename(trimmed) !== trimmed || trimmed === "." || trimmed === "..") {
    return false;
  }
  const projectMetaPath = path.join(configDir, "projects", `${trimmed}.json`);
  if (!existsSync(projectMetaPath)) return false;
  try {
    const meta = JSON.parse(readFileSync(projectMetaPath, "utf8"));
    return meta?.sidecar?.sidecarId === SIDECAR_ID;
  } catch {
    return false;
  }
}

function updateOfflineConfigSidecar(configDir, enabled) {
  const cfgPath = path.join(configDir, "config.json");
  let current = {};
  if (existsSync(cfgPath)) {
    try {
      current = JSON.parse(readFileSync(cfgPath, "utf8"));
    } catch {
      return;
    }
  }
  const sidecars = current.sidecars && typeof current.sidecars === "object" ? { ...current.sidecars } : {};
  if (enabled) {
    const nextEntry = {
      ...(sidecars[SIDECAR_ID] || { resolvedPermissions: null, schemaVersion: 1 }),
      enabled: true,
    };
    // Preserve host-assigned internal sidecar projectId, while stripping stale user-workspace projectIds.
    if (isOwnSidecarProjectId(configDir, nextEntry.projectId)) {
      nextEntry.projectId = nextEntry.projectId.trim();
    } else {
      delete nextEntry.projectId;
    }
    sidecars[SIDECAR_ID] = nextEntry;
  } else {
    delete sidecars[SIDECAR_ID];
  }
  writeJsonAtomic(cfgPath, { ...current, sidecars }, 0o600);
}

function upsertManagedGeminiRules(configDir) {
  const geminiMdPath = path.join(configDir, "GEMINI.md");
  const existing = existsSync(geminiMdPath) ? readFileSync(geminiMdPath, "utf8") : "";
  const blockRe = new RegExp(
    `${GEMINI_RULE_BEGIN.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}[\\s\\S]*?${GEMINI_RULE_END.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}`,
    "u"
  );
  let next;
  if (blockRe.test(existing)) {
    next = existing.replace(blockRe, MANAGED_GEMINI_RULE_BLOCK);
  } else if (existing.trim()) {
    next = `${existing.replace(/\s+$/u, "")}\n\n${MANAGED_GEMINI_RULE_BLOCK}\n`;
  } else {
    next = `${MANAGED_GEMINI_RULE_BLOCK}\n`;
  }
  writeFileSync(geminiMdPath, next, "utf8");
}

function removeManagedGeminiRules(configDir) {
  const geminiMdPath = path.join(configDir, "GEMINI.md");
  if (!existsSync(geminiMdPath)) return;
  const existing = readFileSync(geminiMdPath, "utf8");
  const blockRe = new RegExp(
    `\\n*${GEMINI_RULE_BEGIN.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}[\\s\\S]*?${GEMINI_RULE_END.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\n*`,
    "gu"
  );
  const cleaned = existing.replace(blockRe, "\n").trim();
  if (!cleaned) {
    rmSync(geminiMdPath, { force: true });
  } else {
    writeFileSync(geminiMdPath, `${cleaned}\n`, "utf8");
  }
}

function isOurMcpEntry(entry, installDir) {
  if (!entry || !Array.isArray(entry.args) || !installDir) return false;
  const bases = new Set([path.resolve(installDir)]);
  if (existsSync(installDir)) {
    try {
      bases.add(realpathSync(installDir));
    } catch {}
  }
  return entry.args.some((arg) => {
    if (typeof arg !== "string" || !arg.trim()) return false;
    const candidates = [path.resolve(arg)];
    if (existsSync(arg)) {
      try {
        candidates.push(realpathSync(arg));
      } catch {}
    }
    return candidates.some((candidate) =>
      Array.from(bases).some(
        (base) => candidate === base || candidate.startsWith(`${base}${path.sep}`)
      )
    );
  });
}

async function ensureOcuDependencyInstalled({ installDir, nodeExecPath, log }) {
  const npmCandidates = [
    path.join(path.dirname(nodeExecPath), "npm"),
    "/opt/homebrew/bin/npm",
    "/usr/local/bin/npm",
    "npm",
  ];
  const npmBin = npmCandidates.find((c) => c === "npm" || existsSync(c)) || "npm";
  const env = {
    ...process.env,
    PATH: `${path.dirname(nodeExecPath)}:/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ""}`,
  };

  log("正在下载底层公证签名组件 open-computer-use（首次安装约 30MB，请稍候）...");
  try {
    await execFileAsync(
      npmBin,
      ["install", "--no-audit", "--no-fund", "open-computer-use@^1.1.3"],
      { cwd: installDir, env, timeout: 180_000 }
    );
  } catch {
    log("默认源较慢，正在自动切换国内镜像源 (npmmirror) 重试...");
    await execFileAsync(
      npmBin,
      [
        "install",
        "--no-audit",
        "--no-fund",
        "--registry=https://registry.npmmirror.com",
        "open-computer-use@^1.1.3",
      ],
      { cwd: installDir, env, timeout: 180_000 }
    );
  }
}

async function terminateNativeRuntimeProcesses({ skipProcessKill = false } = {}) {
  if (skipProcessKill || process.platform !== "darwin") return;
  try {
    await execFileAsync(
      "/usr/bin/pkill",
      ["-TERM", "-f", "native-runtime/(CUADesktopHelper|CUAScriptRunner)\\.app"],
      { timeout: 3000 }
    );
  } catch {}
  try {
    await execFileAsync(
      "/usr/bin/pkill",
      ["-KILL", "-f", "native-runtime/CUAScriptRunner\\.app"],
      { timeout: 3000 }
    );
  } catch {}
}

async function terminateRunningBrokerAndAgents({ skipProcessKill = false } = {}) {
  if (skipProcessKill || process.platform !== "darwin") return;
  try {
    await execFileAsync(
      "/usr/bin/pkill",
      ["-TERM", "-f", "codex-style-computer-use/src/(broker-sidecar|mcp-server|mcp-repl-server)\\.mjs"],
      { timeout: 3000 }
    );
  } catch {}
  await terminateNativeRuntimeProcesses({ skipProcessKill });
  try {
    await execFileAsync(
      "/usr/bin/pkill",
      ["-KILL", "-f", "codex-style-computer-use-ax-bridge"],
      { timeout: 3000 }
    );
  } catch {}
  try {
    await execFileAsync(
      "/usr/bin/pkill",
      ["-TERM", "-f", "OpenComputerUse __open-computer-use-app-agent"],
      { timeout: 3000 }
    );
  } catch {}
  for (const ns of ["agy-action", "agy-stream"]) {
    const nsHash = crypto.createHash("sha256").update(ns).digest("hex").slice(0, 16);
    const sockName = `open-computer-use-agent-${nsHash}.sock`;
    try {
      await execFileAsync("/usr/bin/pkill", ["-TERM", "-f", sockName], { timeout: 3000 });
    } catch {}
    try {
      rmSync(path.join(os.tmpdir(), sockName), { force: true });
    } catch {}
  }
}

export async function installCodexComputerUse({
  sourceRoot,
  homeDir = process.env.HOME || homedir(),
  installDir = path.join(homeDir, ".gemini", "codex-style-computer-use"),
  nodeExecPath = process.execPath,
  skipDoctor = false,
  skipProcessKill = false,
  skipNativeSelfTest = false,
  darwinReleaseOverride = null,
  liveRpcFn = syncLiveAntigravity,
  log = console.log,
} = {}) {
  if (process.platform === "darwin" || darwinReleaseOverride) {
    const rel = String(darwinReleaseOverride || os.release() || "");
    const major = Number.parseInt(rel.split(".")[0], 10);
    if (Number.isInteger(major) && major > 0 && major < 23) {
      throw new Error("当前系统版本过低：Open Computer Use 需要 macOS 14.0 (Sonoma) 或更高版本。");
    }
  }

  const configDir = path.join(homeDir, ".gemini", "config");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(installDir, { recursive: true });

  // 1. Copy runtime files into ~/.gemini/codex-style-computer-use so user can delete ~/Downloads safely
  const resolvedSource = existsSync(sourceRoot) ? realpathSync(sourceRoot) : sourceRoot;
  const resolvedInstall = existsSync(installDir) ? realpathSync(installDir) : installDir;
  if (resolvedSource !== resolvedInstall) {
    for (const item of STAGE_ITEMS) {
      const srcPath = path.join(sourceRoot, item);
      if (!existsSync(srcPath)) continue;
      const dstPath = path.join(installDir, item);
      cpSync(srcPath, dstPath, { recursive: true, force: true });
    }
  }

  for (const cmdFile of ["双击安装.command", "双击卸载.command"]) {
    const p = path.join(installDir, cmdFile);
    if (existsSync(p)) {
      try {
        chmodSync(p, 0o755);
      } catch {}
    }
  }
  for (const item of STAGE_ITEMS) {
    const installedItem = path.join(installDir, item);
    if (existsSync(installedItem)) {
      await clearMacQuarantine(installedItem);
    }
  }

  // 1b. Stop any running native helpers/runners before atomic swap, then verify & stage native-runtime/
  await terminateNativeRuntimeProcesses({ skipProcessKill });
  const nativePayloads = await stageAndInstallNativePayloads({
    sourceRoot: existsSync(path.join(resolvedSource, "native-payloads")) ? resolvedSource : sourceRoot,
    installDir,
    darwinReleaseOverride,
    skipSelfTest: skipNativeSelfTest,
    log,
  });

  // 2. Ensure `open-computer-use` native runtime is present
  let runtime = findInstalledOcuRuntime(homeDir, installDir);
  let reusedExistingRuntime = Boolean(runtime);
  if (!runtime) {
    await ensureOcuDependencyInstalled({ installDir, nodeExecPath, log });
    runtime = findInstalledOcuRuntime(homeDir, installDir);
    if (!runtime) {
      throw new Error("未能找到或安装 open-computer-use 原生运行库，请检查网络连接后重试。");
    }
  }
  await clearMacQuarantine(path.join(runtime.dir, "dist", "Open Computer Use.app"));

  // 3. Write Antigravity Aux Pane Sidecar manifest
  const sidecarDir = path.join(configDir, "sidecars", SIDECAR_ID);
  mkdirSync(sidecarDir, { recursive: true });
  const sidecarManifest = {
    display_name: "Computer Use 小窗",
    description:
      "Codex 风格后台无感 Computer Use 侧面实时小窗（操作窗口不置顶、不抢焦点，支持实时画面预览、虚拟光标与小窗内直接点击交互）",
    command: nodeExecPath,
    args: [path.join(installDir, "src", "broker-sidecar.mjs")],
    restart_policy: "always",
    has_web_ui: true,
    ui_config: {
      display_name: "Computer Use 小窗",
      views: [
        {
          title: "Computer Use 小窗",
          path: "/",
          entrypoint: "SIDECAR_UI_ENTRYPOINT_AUX_PANE",
        },
      ],
    },
  };
  writeJsonAtomic(path.join(sidecarDir, "sidecar.json"), sidecarManifest);

  // 4. Backup & merge ~/.gemini/config/mcp_config.json without touching friend's other MCP servers
  const mcpPath = path.join(configDir, "mcp_config.json");
  let mcpData = { mcpServers: {} };
  if (existsSync(mcpPath)) {
    const rawMcp = readFileSync(mcpPath, "utf8");
    try {
      const parsed = JSON.parse(rawMcp);
      if (parsed && typeof parsed === "object") {
        mcpData = {
          ...parsed,
          mcpServers:
            parsed.mcpServers && typeof parsed.mcpServers === "object" ? { ...parsed.mcpServers } : {},
        };
      }
    } catch {
      throw new Error(`现有的 ${mcpPath} 不是合法 JSON，已中止修改以免损坏配置。`);
    }

    const prevSnapPath = path.join(installDir, PREVIOUS_MCP_SNAPSHOT);
    let existingSnap = null;
    if (existsSync(prevSnapPath)) {
      try {
        existingSnap = JSON.parse(readFileSync(prevSnapPath, "utf8"));
      } catch {}
    }

    const prevCu = mcpData.mcpServers["computer-use"];
    const prevCuJs = mcpData.mcpServers["computer-use-js"];
    const cuOwned = isOurMcpEntry(prevCu, installDir);
    const cuJsOwned = isOurMcpEntry(prevCuJs, installDir);

    const nextSnap = {
      hadComputerUse: !cuOwned
        ? prevCu !== undefined
        : Boolean(existingSnap?.hadComputerUse),
      computerUse: !cuOwned
        ? (prevCu ?? null)
        : (existingSnap?.computerUse ?? null),
      hadComputerUseJs: !cuJsOwned
        ? prevCuJs !== undefined
        : Boolean(existingSnap?.hadComputerUseJs),
      computerUseJs: !cuJsOwned
        ? (prevCuJs ?? null)
        : (existingSnap?.computerUseJs ?? null),
    };

    if (!existingSnap || !cuOwned || !cuJsOwned) {
      writeJsonAtomic(prevSnapPath, nextSnap, 0o600);
    }
    if ((!cuOwned && prevCu !== undefined) || (!cuJsOwned && prevCuJs !== undefined)) {
      writeFileSync(
        `${mcpPath}.backup-before-codex-cua-${Date.now()}`,
        rawMcp,
        { mode: 0o600 }
      );
    }
  } else {
    writeJsonAtomic(
      path.join(installDir, PREVIOUS_MCP_SNAPSHOT),
      {
        hadComputerUse: false,
        computerUse: null,
        hadComputerUseJs: false,
        computerUseJs: null,
      },
      0o600
    );
  }

  const existingMcpMode = existsSync(mcpPath) ? statSync(mcpPath).mode & 0o777 : 0o600;
  mcpData.mcpServers["computer-use"] = {
    command: nodeExecPath,
    args: [path.join(installDir, "src", "mcp-server.mjs")],
  };
  mcpData.mcpServers["computer-use-js"] = {
    command: nodeExecPath,
    args: [path.join(installDir, "src", "mcp-repl-server.mjs")],
  };
  writeJsonAtomic(mcpPath, mcpData, existingMcpMode);

  // 5. Write global GEMINI.md rule + clear any stale projectId in config.json + hot-reload Antigravity
  upsertManagedGeminiRules(configDir);
  updateOfflineConfigSidecar(configDir, true);
  await terminateRunningBrokerAndAgents({ skipProcessKill });
  const liveReloaded = await liveRpcFn({ enableSidecar: true });
  updateOfflineConfigSidecar(configDir, true);

  // 6. Run `OpenComputerUse doctor` once to verify macOS Accessibility & Screen Recording permissions
  let doctorOutput = "";
  if (!skipDoctor && process.platform === "darwin" && runtime?.appBin) {
    try {
      const { stdout, stderr } = await execFileAsync(runtime.appBin, ["doctor"], { timeout: 15_000 });
      doctorOutput = `${stdout || ""}${stderr || ""}`.trim();
    } catch (err) {
      doctorOutput = String(err?.stdout || err?.stderr || err?.message || "").trim();
    }
  }

  return {
    installDir,
    reusedExistingRuntime,
    liveReloaded,
    runtimeDir: runtime.dir,
    doctorOutput,
    nativePayloads,
  };
}

export async function uninstallCodexComputerUse({
  homeDir = process.env.HOME || homedir(),
  installDir = path.join(homeDir, ".gemini", "codex-style-computer-use"),
  skipProcessKill = false,
  liveRpcFn = syncLiveAntigravity,
} = {}) {
  const configDir = path.join(homeDir, ".gemini", "config");
  const mcpPath = path.join(configDir, "mcp_config.json");
  const prevSnapPath = path.join(installDir, PREVIOUS_MCP_SNAPSHOT);

  // 1. Restore previous MCP entries BEFORE deleting runtime/recovery files; propagate errors if corrupt/unwritable
  if (existsSync(mcpPath)) {
    const existingMcpMode = statSync(mcpPath).mode & 0o777;
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(mcpPath, "utf8"));
    } catch (err) {
      throw new Error(`无法解析 ${mcpPath}，已保留安装目录与备份文件以免丢失配置：${err.message}`);
    }
    const servers =
      parsed?.mcpServers && typeof parsed.mcpServers === "object" ? { ...parsed.mcpServers } : {};
    const snap = existsSync(prevSnapPath)
      ? JSON.parse(readFileSync(prevSnapPath, "utf8"))
      : null;

    if (isOurMcpEntry(servers["computer-use"], installDir)) {
      if (snap?.hadComputerUse && snap.computerUse) {
        servers["computer-use"] = snap.computerUse;
      } else {
        delete servers["computer-use"];
      }
    }
    if (isOurMcpEntry(servers["computer-use-js"], installDir)) {
      if (snap?.hadComputerUseJs && snap.computerUseJs) {
        servers["computer-use-js"] = snap.computerUseJs;
      } else {
        delete servers["computer-use-js"];
      }
    }
    writeJsonAtomic(mcpPath, { ...(parsed || {}), mcpServers: servers }, existingMcpMode);
  }

  // 2. Remove managed GEMINI.md rule block, disable sidecar, stop broker + app-agents & remove state files
  removeManagedGeminiRules(configDir);
  const liveReloaded = await liveRpcFn({ enableSidecar: false });
  updateOfflineConfigSidecar(configDir, false);
  await terminateRunningBrokerAndAgents({ skipProcessKill });

  const ocuStateDir = path.join(homeDir, ".config", "ocu");
  rmSync(path.join(ocuStateDir, "agy-cua.sock"), { force: true });
  rmSync(path.join(ocuStateDir, "agy-cua-sidecar.json"), { force: true });
  rmSync(path.join(configDir, "sidecars", SIDECAR_ID), { recursive: true, force: true });
  rmSync(installDir, { recursive: true, force: true });

  return { liveReloaded };
}
