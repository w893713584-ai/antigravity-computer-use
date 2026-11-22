#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# 自动解除微信/浏览器下载带来的 macOS Gatekeeper 隔离标记
/usr/bin/xattr -dr com.apple.quarantine "$SCRIPT_DIR" 2>/dev/null || true

# 自动补齐 macOS 常见 Node.js 安装路径（Homebrew / Volta / fnm / mise / asdf / nvm）
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.volta/bin:$HOME/.local/share/mise/shims:$HOME/.asdf/shims:$PATH"

if ! command -v node >/dev/null 2>&1; then
  if [ -d "$HOME/.nvm/versions/node" ]; then
    LATEST_NVM="$(ls -1d "$HOME/.nvm/versions/node/"* 2>/dev/null | sort -V | tail -n 1 || true)"
    if [ -n "$LATEST_NVM" ] && [ -x "$LATEST_NVM/bin/node" ]; then
      export PATH="$LATEST_NVM/bin:$PATH"
    fi
  fi
fi

if ! command -v node >/dev/null 2>&1; then
  if [ -d "$HOME/Library/Application Support/fnm/node-versions" ]; then
    LATEST_FNM="$(ls -1d "$HOME/Library/Application Support/fnm/node-versions/"*/installation/bin 2>/dev/null | sort -V | tail -n 1 || true)"
    if [ -n "$LATEST_FNM" ] && [ -x "$LATEST_FNM/node" ]; then
      export PATH="$LATEST_FNM:$PATH"
    fi
  fi
fi

if ! command -v node >/dev/null 2>&1; then
  echo "=================================================="
  echo "  未检测到 Node.js (需要 Node.js 18 或更高版本)"
  echo "=================================================="
  echo "请先安装 Node.js 后再双击本脚本："
  echo "  • 方法 1（有 Homebrew）：在终端运行 brew install node"
  echo "  • 方法 2（安装包）：访问 https://nodejs.org 下载 LTS 安装包"
  echo ""
  if [ -t 0 ]; then
    read -r -p "按回车键关闭窗口..." _ || true
  fi
  exit 1
fi

NODE_BIN="$(command -v node)"
"$NODE_BIN" "$SCRIPT_DIR/scripts/install-agy.mjs"

echo ""
if [ -t 0 ]; then
  read -r -p "按回车键关闭窗口..." _ || true
fi
