# Antigravity Computer Use (Codex-Style)

[中文](./README.md) | [English](./README.en.md)

将 Google Antigravity 的 `computer-use` 与 `computer-use-js` 改造为与 Codex 一致的 **macOS 后台无感操控 + 对话右侧 Aux Pane 实时小窗** 系统：AI 在你当前工作毫无被打断的情况下操作后台桌面应用，同时把画面与动作实时串流到右侧小窗，支持人类毫秒级接管刹车与急停。

---

## 一、项目内容（架构组成）

本项目由 **4 个协同层** 组成，围绕一个单机共享的 `ComputerUseBrokerServer`（UDS JSON-RPC + Local HTTP/WebSocket Sidecar）运转：

| 层级 | 核心目录 / 入口 | 主要职责 |
| :--- | :--- | :--- |
| **MCP 接入层** | [`src/mcp-server.mjs`](./src/mcp-server.mjs)<br>[`src/mcp-repl-server.mjs`](./src/mcp-repl-server.mjs) | 向 Antigravity 暴露 `computer-use` 工具集与 `computer-use-js`（`js` / `js_reset`）持久脚本工具；首轮非错调用自动注入 `[Computer Use 小窗](sidecar://computer-use-preview/)` 入口。 |
| **核心调度层 (Broker & 深模块)** | [`src/broker-sidecar.mjs`](./src/broker-sidecar.mjs)<br>[`src/action-executor.mjs`](./src/action-executor.mjs)<br>[`src/act-executor.mjs`](./src/act-executor.mjs)<br>[`src/focus-policy-guard.mjs`](./src/focus-policy-guard.mjs)<br>[`src/app-snapshot-registry.mjs`](./src/app-snapshot-registry.mjs) | 统一维护无障碍快照与 `@sN:index` 账本、窗口作用域防抢焦点守护（Route Scope）、Pre-IPC 接管刹车门禁、同窗坐标契约（Same-Window Proof）、结构化 `Delivery Receipt` 与闭环回读。 |
| **原生桥接与实时流** | [`src/ax-bridge.mjs`](./src/ax-bridge.mjs)<br>[`native/DesktopHelper/`](./native/DesktopHelper/)<br>[`src/preview-stream.mjs`](./src/preview-stream.mjs)<br>[`src/sidecar-web.mjs`](./src/sidecar-web.mjs) | 常驻 JXA 无障碍热桥（`PersistentAxBridge`）+ Swift `CUADesktopHelper.app`：负责 `ScreenCaptureKit` + `VideoToolbox` H.264 硬件推流、严格 AX→WID 窗体查表、CGEventTap 真人输入接管感知与小窗 UI。 |
| **独立沙箱与安装工具链** | [`native/ScriptRunner/`](./native/ScriptRunner/)<br>[`scripts/`](./scripts/) | `CUAScriptRunner.app`（macOS Seatbelt 默认拒绝策略 + 禁用 JIT/WASM/`eval` 的 JSC VM + 嵌入 `acorn`）；一键原生编译（`build:native`）、Antigravity 集成部署（`install-agy`）与分享包生成（`pack-share`）。 |

---

## 二、核心功能

### 1. 后台无感操控（不置顶、不抢焦点、不挪光标）
- **双底层运行时隔离**：复用 `Open Computer Use.app`（可选依赖 `open-computer-use`），通过 `ActionEngine`（无障碍交互）与 `StreamEngine`（画面采集）双 peer 隔离（[ADR-0001](./docs/adr/0001-dual-native-peers-for-action-and-stream.md)），后台推流永不覆盖 AI 正在使用的 `element_index` 序号表。
- **全链路禁前台激活**：强制写入 `window_placement: "keep"`，启用 `WindowOcclusionKeepAlive` 让被遮挡后台窗口持续渲染。未运行应用仅按请求通过 `open -g` 后台拉起；`Cmd+H` 隐藏窗口仅静默 `unhide()`；用户退出应用后立即清状态、绝不擅自重启。
- **窗口级防抢焦点守护（Focus-Steal Guard + ADR-0007）**：
  - 常驻毫秒热桥监控前台归属并在微秒/亚帧级别把焦点拉回用户原应用，失败时重采真实前台避免覆盖用户新切换的应用。
  - **Window-Local Delivery Floor（[ADR-0003](./docs/adr/0003-non-blockable-window-local-delivery-floor.md)）**：`window_post` 与 `window_key` 窗口局部投递通道**永不被拉黑**。
  - **Window-Scoped Route Penalty（[ADR-0007](./docs/adr/0007-window-scoped-focus-attribution-and-structured-receipts.md)）**：抢焦点惩罚按 `(pid, processToken, windowId)` 窗口作用域记录，区分点击与键盘通道；Home→Editor 正常弹新窗和纯观测回读（`observationalOnly`）不再误伤全局 `sky_click`。

### 2. 对话右侧实时小窗（Aux Pane Sidecar & 同窗坐标契约）
- **硬件 H.264 + 同窗 JPEG 自适应推流**：优先使用 `CUADesktopHelper.app`（`ScreenCaptureKit` + `VideoToolbox` H.264）推送至小窗 WebCodecs 解码；当窗口处于 `offscreen`（最小化/切换 Space）或缺少硬件通道时，保持目标窗绑定并自动降级为同 WID JPEG 或暂停只读态，待窗口回到屏幕即自动恢复。
- **Same-Window Proof 同窗坐标契约（[ADR-0006](./docs/adr/0006-window-point-canonical-geometry-and-dual-uds-video-plane.md)）**：严格对比截图尺寸/窗体 bounds 与目标窗口 `wid`，交叉窗口 `query` 自动清空旧截图证明，窗口尺寸改变触发 `window_resized` 快速失败，杜绝把 A 窗口坐标点到 B 窗口。
- **双向小窗交互**：实时呈现 AI 虚拟光标轨迹、操作记录与防抢焦点护盾计数，同时支持人类直接在小窗内左/右键点击、双击、滚轮、输入文本、快捷键，以及切换「跟随」「暂停/恢复」「置顶」。

### 3. 人类接管刹车与默认拒绝沙箱（Takeover & Sandbox）
- **双层人类接管刹车（[ADR-0004](./docs/adr/0004-dual-tier-human-takeover-with-drain-gate.md)）**：识别小窗操控、命中目标真窗口的鼠标/键盘事件、系统切换手势以及全局急停热键（默认 `Control+Option+Escape`）。通过 Pause Epoch 版本号与 **Pre-IPC Write Gate** 在每一次原生写入前同步拦截，对写入结果未知的中断返回 `WRITE_OUTCOME_UNKNOWN` 而非盲目重放。
- **默认拒绝 JS 沙箱（[ADR-0005](./docs/adr/0005-fresh-process-seatbelt-jsc-script-sandbox.md)）**：`computer-use-js` 的 `js` 工具在独立子进程 `CUAScriptRunner.app` 内运行：macOS Seatbelt 默认拒绝网络、文件写和子进程派生，JavaScriptCore 禁用 JIT / WASM / `eval` / `Function`，并支持跨轮次 `var/let/const` 与 `app` 句柄持久化及结构化 `Delivery Receipt`。

### 4. 活体句柄防护、纯观测回读与原子 `act`
- **活体 `AXUIElementRef` 闭环（`STALE_REF`）**：快照与 `query` 为控件签发版本化 `@sN:index` 并绑定真实句柄，点击前校验控件未失效或被模态窗替换；后台按需唤醒 Electron/Chromium `AXManualAccessibility`，自动脱敏 `AXSecureTextField` 并禁用其键盘旁路。
- **`act` 原子工具**：在单次调用内完成目标查找、嵌套去重、自动滚动、后台单击与 `expect` 后置条件校验。
- **`observationalOnly` 回读与严谨验证**：动作后的状态回读严格禁止触发拉起、唤醒 AX 或提升主窗；单帧像素变化仅作观察提示，只有结构化 AX 变化、输入值校验通过或直投确认才签发 `delivered_verified`。

---

## 三、优缺点与适用边界

### 优点（Strengths）
1. **彻底解放人类桌面工作流**：正常场景下不弹窗、不抢焦点、不挪物理鼠标，人在前台写代码/看文档的同时，AI 可在后台静默操作其他窗口。
2. **全程可视、可审计、可随时急停**：右侧 Aux Pane 实时转播后台画面与 AI 点击位置，一旦 AI 动作偏离预期，用户随时点击桌面/小窗或按 `Control+Option+Escape` 即可在原生写入前刹停。
3. **工程级防误触与安全边界**：具备 `STALE_REF` 活体校验、Same-Window Proof 同窗几何核验、密码框脱敏、`WRITE_OUTCOME_UNKNOWN` 禁重放以及 Seatbelt + 无 JIT JSC 默认拒绝沙箱。
4. **高性能与低冷启动延迟**：常驻 JXA 热桥消除反复启动 `osascript` 的几十毫秒开销；硬件 H.264 推流降低 CPU 与 IPC 传输负担；深模块设计与注入替身测试支持无 TCC 弹窗的高速单元测试与 CI。

### 缺点与局限（Cons & Limitations）
1. **平台与宿主强绑定**：仅支持 **macOS 14.0+（Apple Silicon / Intel Mac）** 及 **Google Antigravity / T3 Code（Antigravity Provider）**，不支持 Windows 或 Linux；在 T3 Code 独立运行（未打开 Antigravity 桌面端）时，实时小窗通过本地 `http://127.0.0.1:<port>/?token=...` 链接在浏览器或预览面板打开。
2. **高度依赖系统隐私权限且升级需注意 ad-hoc 签名**：完整能力需要分别授予 **辅助功能**、**录屏**、**输入监控** 权限。由于原生助手默认使用本地 ad-hoc 签名，**升级覆盖安装新版后**系统可能沿用旧签名缓存——若授权开关已打开但仍提示缺权限，需在「系统设置 → 隐私与安全性」中先移除再重新添加 `CUADesktopHelper.app`。
3. **复杂自研界面与全屏应用仍有边界**：部分重度自研渲染软件、全屏独占 Space 应用、游戏或刚新建且尚未建立键盘/鼠标响应链的 Qt/Electron 窗口（如剪映新建编辑页）可能会忽略纯后台事件——此时仍可能需要人工在该窗口轻点一下以激活其内部响应链。
4. **macOS 系统版本风险与常驻资源开销**：依赖 SkyLight、CGEvent 与 ScreenCaptureKit 等底层接口，未来 macOS 大版本更新可能需要同步适配；常驻 Broker、JXA 桥与硬件视频编码会占用一定的后台内存与电量。
5. **稳态安全性带来的轻微单步延时**：每次写操作包含前置冻结检查、活体校验及后置闭环状态回读，单步耗时略高于不加校验的盲目坐标点击。

---

## 四、使用说明

### 1. 环境要求
- **操作系统**：macOS 14.0 (Sonoma) 或更高版本
- **Node.js**：>= 18（推荐 Node.js 22）
- **宿主应用**：Google Antigravity 或 T3 Code（Antigravity Provider）
- **源码编译额外依赖**：Xcode Command Line Tools（含 `swiftc`、`clang`、`codesign`；若使用一键分享安装包则无需手动编译）

### 2. 安装与部署

#### 方式一：从源码构建并安装（推荐开发者）
```bash
git clone https://github.com/w893713584-ai/antigravity-computer-use.git
cd antigravity-computer-use

# 1. 编译原生助手 (CUAScriptRunner.app 与 CUADesktopHelper.app)
npm run build:native

# 2. 部署到 ~/.gemini/codex-style-computer-use 并写入 Antigravity 配置与热刷新
npm run install-agy
```

#### 方式二：打包与使用一键分享安装包
```bash
# 生成 dist/Codex风格ComputerUse一键安装包.zip
npm run pack-share
```
解压后推荐直接在终端执行（可绕过 macOS 15 Gatekeeper 拦截）：
```bash
bash /path/to/Codex风格ComputerUse一键安装包/双击安装.command
```
> 图形界面双击说明及 macOS Gatekeeper 放行步骤另见 [使用说明.txt](./使用说明.txt)。

### 3. 首次授权（系统设置 → 隐私与安全性）
请按需勾选以下权限（未全部开启时会自动降级至基础模式，推荐一次配齐）：
1. **辅助功能 (Accessibility)**：`Antigravity.app`（若在 T3 Code 中使用还需勾选 `T3 Code (Beta).app` / `T3 Code.app`）、`Open Computer Use.app`、`~/.gemini/codex-style-computer-use/native-runtime/CUADesktopHelper.app`
2. **录屏与系统录音 (Screen Recording)**：`Open Computer Use.app`、`CUADesktopHelper.app`（在 T3 Code 中使用建议同时勾选 `T3 Code (Beta).app` / `T3 Code.app`，以启用 H.264 实时小窗画面与精准窗口采集）
3. **输入监控 (Input Monitoring)**：`CUADesktopHelper.app`（启用真人接管自动刹车与全局急停热键）

> 在系统设置权限列表中点击「+」后按 `Command + Shift + G`，粘贴以下路径即可快速选中：  
> `~/.gemini/codex-style-computer-use/native-runtime/CUADesktopHelper.app`

### 4. 在 Antigravity 对话中使用
- **打开实时小窗**：AI 在首轮调用 Computer Use 时会在回复中自动附上 `[Computer Use 小窗](sidecar://computer-use-preview/)`，点击即可在 Antigravity 右侧打开实时监控小窗。
- **右侧小窗操控**：
  - 点击右上工具栏可切换 **跟随 AI 当前窗口**、**手动暂停 / 恢复 AI**、**一键置顶目标窗口**。
  - 在小窗画面内可直接单击/双击/右键、滚轮滚动，或在输入栏发送文本与快捷键。
  - **急停快捷键**：默认按下 `Control + Option + Escape`，可在任何时刻立即冻结并中断 AI 在途操作。
- **可用 MCP 工具概览**：
  - `computer-use`（结构化桌面工具）：`list_apps`、`get_app_state`、`query`、`click`、`drag`、`scroll`、`type_text`、`press_key`、`set_value`、`select_text`、`perform_secondary_action`、`act`。
  - `computer-use-js`（持久沙箱脚本）：`js`（支持 `cua.getApp` / `app.getAXState` / `app.query` / `app.act` / `app.click` / `app.typeText` / `app.pressKey` / `app.scroll` / `app.setValue` 等， 返回 `{ ok, delivery, route, executedRoute, requestedRoute }` 结构化回执）、`js_reset`。

```js
// computer-use-js (`js` 工具) 示例
const app = await cua.getApp("Finder", { initialState: false });
await app.getAXState();
const res = await app.act({
  target: { text: "新建文件夹" },
  expect: { any_text: ["未命名文件夹"] },
});
nodeRepl.write(JSON.stringify(res));
```

### 5. 常见问题与排查
- **小窗黑屏 / 无实时画面**：确认已对 `CUADesktopHelper.app` 开启「录屏与系统录音」权限；若刚覆盖安装新版，请先在权限列表用「−」移出再重新「+」添加一次以刷新 ad-hoc 签名授权。
- **小窗提示 `offscreen` / 只读暂停**：目标窗口被最小化或置于其他桌面 Space；可继续用 AX 元素操作或点小窗「置顶」恢复推流。
- **报 `STALE_REF` 或坐标点击被同窗契约拒绝**：目标界面在快照后发生了变化、重排或尺寸调整，重新调用一次 `get_app_state` 刷新快照与画面尺寸即可。
- **极少数复杂软件（如新建编辑页）后台点击无反应**：部分自研渲染框架在新窗口首次激活前不派发后台事件，可先切过去轻点一下内容区激活响应链，之后再切回前台让 AI 在后台继续。

### 6. 卸载与还原
```bash
npm run uninstall-agy
# 或直接运行 ~/.gemini/codex-style-computer-use/双击卸载.command
```

---

## 五、项目结构与架构文档

- [`src/`](./src/)：Broker 服务、MCP 与沙箱 REPL 入口、`FocusPolicyGuard`、`AppSnapshotRegistry`、`BackgroundActionExecutor`、`AtomicActExecutor`、`TakeoverController`、`PersistentAxBridge`、`PreviewStreamManager`、WebSocket 推流与 Sidecar 前端 UI
- [`native/DesktopHelper/`](./native/DesktopHelper/)：Swift 原生 ScreenCaptureKit 采集、VideoToolbox H.264 编码、窗口清单查表与 CGEventTap 输入接管感知助手
- [`native/ScriptRunner/`](./native/ScriptRunner/)：Swift/C Seatbelt + JavaScriptCore 沙箱脚本执行器（内嵌 `acorn`）
- [`scripts/`](./scripts/)：原生构建（`build-native.mjs`）、Antigravity 部署/卸载器与一键安装包打包脚本（`pack-share.mjs`）
- [`test/`](./test/)：单元测试套件（使用注入替身，CI 下无需 macOS TCC 弹窗）
- 架构与领域文档：
  - [GLOSSARY.md](./GLOSSARY.md) — 领域术语表
  - [docs/deepening-spec.md](./docs/deepening-spec.md) — 深模块架构重构说明
  - [docs/adr/](./docs/adr/) — 架构决策记录（ADR 0001–0007，含 [ADR-0007 窗口作用域焦点归因与结构化回执](./docs/adr/0007-window-scoped-focus-attribution-and-structured-receipts.md)）
  - [docs/design/option-a-blueprint.md](./docs/design/option-a-blueprint.md) — 原生刹车、沙箱与视频流设计蓝图

---

## 六、开发测试与参与贡献

```bash
# 运行完整单元测试（macOS 无 TCC 弹窗，自动校验原生构建与核心语义）
npm test
```

欢迎提交 Issue 和 Pull Request！提交前请阅读 [CONTRIBUTING.md](./CONTRIBUTING.md) 中的后台无感与安全红线；如发现安全漏洞请遵循 [SECURITY.md](./SECURITY.md) 私密上报。

---

## 七、许可证与致谢

- 本项目源码基于 [MIT License](./LICENSE) 开源。
- 第三方组件与设计参考声明见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)，特别致谢：
  - [iFurySt/open-computer-use](https://github.com/iFurySt/open-computer-use)（MIT License）及其上游 `trycua/cua`、`asmvik/yabai`、`libwebp`
  - [vercel-labs/agent-desktop](https://github.com/vercel-labs/agent-desktop)（Apache-2.0 License，无头 `AXSelectedText` 与 `AXScrollBar` 设计参考）
  - [acornjs/acorn](https://github.com/acornjs/acorn)（MIT License，内嵌用于沙箱顶层语法解析）
