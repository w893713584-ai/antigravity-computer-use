#!/bin/bash
{
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.volta/bin:$HOME/.local/share/mise/shims:$HOME/.asdf/shims:$PATH"

if ! command -v node >/dev/null 2>&1 && [ -d "$HOME/.nvm/versions/node" ]; then
  LATEST_NVM="$(ls -1d "$HOME/.nvm/versions/node/"* 2>/dev/null | sort -V | tail -n 1 || true)"
  if [ -n "$LATEST_NVM" ] && [ -x "$LATEST_NVM/bin/node" ]; then
    export PATH="$LATEST_NVM/bin:$PATH"
  fi
fi

if ! command -v node >/dev/null 2>&1 && [ -d "$HOME/Library/Application Support/fnm/node-versions" ]; then
  LATEST_FNM="$(ls -1d "$HOME/Library/Application Support/fnm/node-versions/"*/installation/bin 2>/dev/null | sort -V | tail -n 1 || true)"
  if [ -n "$LATEST_FNM" ] && [ -x "$LATEST_FNM/node" ]; then
    export PATH="$LATEST_FNM:$PATH"
  fi
fi

if ! command -v node >/dev/null 2>&1; then
  echo "未检测到 Node.js，无法自动执行卸载脚本。"
  if [ -t 0 ]; then
    read -r -p "按回车键关闭窗口..." _ || true
  fi
  exit 1
fi

NODE_BIN="$(command -v node)"
"$NODE_BIN" "$SCRIPT_DIR/scripts/uninstall-agy.mjs"

echo ""
if [ -t 0 ]; then
  read -r -p "按回车键关闭窗口..." _ || true
fi
exit 0
}
