# Antigravity Computer Use (Codex-Style)

[中文](./README.md) | [English](./README.en.md)

将 Google Antigravity 的 `computer-use` / `computer-use-js` 改造为与 Codex 一致的**macOS 后台无感操控 + 右侧 Aux Pane 实时小窗**体验。

---

## 核心特性

1. **后台无感操作（不置顶、不抢焦点、不误拉起已退出应用、无桌面悬浮光标）**
   - 复用本机已公证签名并授权的 `Open Computer Use.app`（可选依赖 `open-computer-use`），同时通过持久化 `WindowOcclusionKeepAlive` 让被遮挡的后台窗口持续渲染。
   - 全链路禁用原生前台恢复（`window_placement: "keep"`），由 Broker 接管非激活状态回读与 Focus-Steal Guard（毫秒级防抢焦点清扫 + 自适应 `SelfActivationTracker`），不调用 `activate`、`AXRaise` 或在用户退出应用后误重启。
   - 未启动应用仅在显式请求时通过 `open -g` 后台静默拉起；`Cmd+H` 隐藏应用仅后台 `unhide()` 不抢焦点；左键单双击与键盘输入优先走无激活窗口局部投递或 SkyLight 后台通道，并隐藏桌面悬浮光标。

2. **对话右侧实时小窗（Antigravity Aux Pane Sidecar）**
   - 通过双原生通道隔离 AX 元素索引与实时画面流，支持 `CUADesktopHelper.app` 的 ScreenCaptureKit + VideoToolbox H.264 硬件推流与 WebCodecs 解码，并在不支持时自动降级到同目标 JPEG 流。
   - 严格贯彻同窗坐标契约（Same-Window Proof）：只有确认小窗画面与派发目标为同一活体窗口且几何一致时才允许坐标点击，否则自动降级只读。
   - 实时展示虚拟光标轨迹、快照与护盾计数，并支持直接在小窗内单双击/右键/滚动/发送文本与快捷键，以及一键「跟随」、「暂停」与「置顶」。

3. **人类接管急停与独立沙箱脚本执行**
   - **人类接管刹车（`TakeoverController`）**：识别小窗交互、命中目标真实窗口的鼠标按下、系统切换手势与全局急停热键（默认 `Control+Option+Escape`），在写入原生 IPC 前同步拦停在途请求。
   - **独立沙箱脚本（`CUAScriptRunner.app`）**：`computer-use-js` 每次执行在全新进程内启用 macOS Seatbelt 默认拒绝策略（禁止网络、文件写入与进程派生）与禁用 JIT/WASM/`eval` 的 JavaScriptCore 环境，并支持跨轮次可序列化变量与 app 句柄持久化。

4. **常驻毫秒级无障碍桥接 & 活体句柄防护**
   - **常驻热桥 `PersistentAxBridge`**：免去反复启动 `osascript` 的冷启动开销，实现亚帧级焦点检测与抢焦点拉回。
   - **活体 `AXUIElementRef` 闭环防护（`STALE_REF`）**：为每次快照与 `query` 签发 `@sN:index` 并在热桥内绑定真实控件句柄与相对几何；后台窗口刷新、节点销毁或模态弹窗切换时在点击前拦截。
   - 后台按需唤醒 Electron / Chromium 懒加载无障碍树（`AXManualAccessibility = true`），并对 `AXSecureTextField` 自动脱敏且禁止走按键旁路。

---

## 环境要求

- **操作系统**：macOS 14.0 (Sonoma) 及以上
- **Node.js**：>= 18（推荐 Node.js 22）
- **宿主应用**：Google Antigravity
- **源码编译依赖**：Xcode Command Line Tools（包含 `swiftc`、`clang`、`codesign`，仅从源码构建时需要；一键安装包内已包含预编译产物）

---

## 安装与卸载

### 方式一：从源码安装（推荐开发者）

```bash
git clone https://github.com/w893713584-ai/antigravity-computer-use.git
cd antigravity-computer-use

# 1. 编译原生 Swift/C 助手 (CUADesktopHelper.app 与 CUAScriptRunner.app)
npm run build:native

# 2. 部署到 ~/.gemini/codex-style-computer-use 并配置 Antigravity MCP 与 Sidecar
npm run install-agy
```

### 方式二：构建一键分享安装包

```bash
npm run pack-share
# 生成 dist/Codex风格ComputerUse一键安装包.zip
```

解压后可运行目录内的 `双击安装.command`（或在终端执行 `bash 双击安装.command`）；完整步骤与 macOS Gatekeeper 说明见 [使用说明.txt](./使用说明.txt)。

### 首次使用授权（macOS 隐私与安全性）

首次使用请在「系统设置 → 隐私与安全性」按需开启以下权限（未全部开启时会自动降级对应能力）：
1. **辅助功能 (Accessibility)**：`Antigravity.app`、`Open Computer Use.app`、`~/.gemini/codex-style-computer-use/native-runtime/CUADesktopHelper.app`
2. **录屏与系统录音 (Screen Recording)**：`Open Computer Use.app`、`CUADesktopHelper.app`（启用 H.264 实时推流）
3. **输入监控 (Input Monitoring)**：`CUADesktopHelper.app`（启用真人接管刹车与急停热键）

### 卸载还原

```bash
npm run uninstall-agy
# 或运行安装目录中的 双击卸载.command
```

---

## 项目结构与文档

- `src/`：Broker 服务、MCP / REPL Server、策略守护、无障碍桥接、坐标契约、WebSocket 视频推流与 Sidecar UI
- `native/DesktopHelper/`：Swift 原生桌面采集、H.264 硬件编码与输入监控助手
- `native/ScriptRunner/`：Swift/C Seatbelt + JavaScriptCore 沙箱脚本执行器（内嵌 `acorn` 解析器）
- `scripts/`：原生构建（`build-native.mjs`）、安装/卸载器与一键安装包打包脚本
- `test/`：单元测试套件（使用注入替身，CI 下无需 TCC 弹窗）
- 架构与领域文档：
  - [GLOSSARY.md](./GLOSSARY.md) — 领域术语表
  - [docs/deepening-spec.md](./docs/deepening-spec.md) — 深模块架构重构说明
  - [docs/adr/](./docs/adr/) — 架构决策记录（ADR 0001–0006）
  - [docs/design/option-a-blueprint.md](./docs/design/option-a-blueprint.md) — 原生刹车、沙箱与视频流设计蓝图

---

## 开发测试与参与贡献

```bash
# 运行完整单元测试
npm test
```

欢迎提交 Issue 和 Pull Request！提交前请阅读 [CONTRIBUTING.md](./CONTRIBUTING.md) 中的后台无感与安全红线；如发现安全漏洞请遵循 [SECURITY.md](./SECURITY.md) 私密上报。

---

## 许可证与致谢

- 本项目源码基于 [MIT License](./LICENSE) 开源。
- 第三方组件与设计参考声明见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)，特别致谢：
  - [iFurySt/open-computer-use](https://github.com/iFurySt/open-computer-use)（MIT License）及其上游 `trycua/cua`、`asmvik/yabai`、`libwebp`
  - [vercel-labs/agent-desktop](https://github.com/vercel-labs/agent-desktop)（Apache-2.0 License，无头 `AXSelectedText` 与 `AXScrollBar` 设计参考）
  - [acornjs/acorn](https://github.com/acornjs/acorn)（MIT License，内嵌用于沙箱顶层语法解析）
