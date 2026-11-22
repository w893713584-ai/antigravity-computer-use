#!/usr/bin/env node

import { uninstallCodexComputerUse } from "./installer-lib.mjs";

async function main() {
  console.log("==================================================");
  console.log("  卸载 Codex 风格 Computer Use 侧面小窗插件");
  console.log("==================================================\n");

  const result = await uninstallCodexComputerUse();

  console.log("[完成] 已移除「Computer Use 小窗」侧栏配置与运行目录");
  console.log("[完成] 已自动还原你原有的 mcp_config.json 配置");
  console.log(
    result.liveReloaded
      ? "[完成] 已实时通知 Antigravity 刷新配置！"
      : "[完成] 重启一次 Antigravity 即可完全恢复。"
  );
}

main().catch((err) => {
  console.error(`\n[卸载失败] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
