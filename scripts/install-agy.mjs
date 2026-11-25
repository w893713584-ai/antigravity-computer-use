#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { installCodexComputerUse } from "./installer-lib.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sourceRoot = path.resolve(__dirname, "..");

async function main() {
  console.log("==================================================");
  console.log("  Codex 风格 Computer Use（后台无感 + 右侧实时小窗）");
  console.log("==================================================\n");

  const result = await installCodexComputerUse({
    sourceRoot,
    log: (msg) => console.log(`[安装] ${msg}`),
  });

  console.log(`[完成] 已安装至固定目录: ${result.installDir}`);
  const nativeComponents = result.nativePayloads?.components || {};
  for (const [key, label] of [
    ["desktopHelper", "CUADesktopHelper.app (精准人工接管刹车)"],
    ["scriptRunner", "CUAScriptRunner.app (Seatbelt + JSC 沙盒)"],
  ]) {
    const info = nativeComponents[key];
    if (!info) continue;
    if (info.status === "installed" || info.status === "preserved_previous") {
      console.log(
        `[完成] 原生组件 ${label}: ${info.status === "preserved_previous" ? "保留已验证版本" : "已验证并安装"} (${info.bundleId || ""})`
      );
    } else {
      console.log(`[降级] 原生组件 ${label} 未就绪 (${info.reason || "unavailable"})，基础结构化控制仍可用`);
    }
  }
  console.log(
    result.reusedExistingRuntime
      ? "[完成] 已自动复用本机已安装的 Open Computer Use.app（无需重复下载）"
      : `[完成] 已自动下载并配置 Open Computer Use.app (${result.runtimeDir})`
  );
  console.log(
    result.liveReloaded
      ? "[完成] 已实时连接正在运行的 Antigravity，自动启用「Computer Use 小窗」并热刷新 MCP！"
      : "[完成] 已写入 Antigravity 配置（打开或重启一次 Antigravity 即可生效）"
  );
  if (result.t3SyncedCount > 0) {
    console.log(`[完成] 已同步更新 ${result.t3SyncedCount} 个 T3 Code (Antigravity Provider) 配置实例！`);
  }

  if (result.doctorOutput) {
    console.log("\n[macOS 权限状态检查]");
    console.log(result.doctorOutput);
  }

  const helperRuntimePath = path.join(result.installDir, "native-runtime", "CUADesktopHelper.app");
  console.log("\n[系统权限配置清单（系统设置 → 隐私与安全性）]");
  console.log("  • 辅助功能 (Accessibility)：Antigravity.app（若在 T3 Code 中使用还需勾选 T3 Code (Beta).app / T3 Code.app）+ Open Computer Use.app + CUADesktopHelper.app");
  console.log("  • 录屏与系统录音 (Screen Recording)：Open Computer Use.app + CUADesktopHelper.app（在 T3 Code 中使用建议同时勾选 T3 Code (Beta).app / T3 Code.app）");
  console.log("  • 输入监控 (Input Monitoring)：CUADesktopHelper.app");
  console.log(`  • CUADesktopHelper 路径（选「+」后按 ⌘⇧G 粘贴）：${helperRuntimePath}`);
  console.log("  * 若新版升级后某项权限开关看似已开但仍提示未授权，请先选中 CUADesktopHelper 点「−」移出后再点「+」重加一次。");

  console.log("\n安装全部完成！现在可以在 Antigravity 对话中直接使用 Computer Use，解压包可随时删除。");
}

main().catch((err) => {
  console.error(`\n[安装失败] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
