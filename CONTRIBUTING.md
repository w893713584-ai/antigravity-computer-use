# Contributing / 参与贡献

[中文](#中文) | [English](#english)

---

## 中文

欢迎提 Issue 和 Pull Request！提交改动前，请花两分钟阅读本项目不可破坏的核心约束。

### 本地开发与验证

**环境要求**：macOS 14.0+、Node.js >= 18、Xcode Command Line Tools（`swiftc`、`clang`、`codesign`）。

```bash
# 1. 编译本地 Swift/C 原生组件（CUADesktopHelper.app 与 CUAScriptRunner.app）
npm run build:native

# 2. 运行全部单元测试（CI 默认不依赖系统 TCC 弹窗）
npm test

# 3. 可选：生成一键分享安装包（输出到 dist/）
npm run pack-share
```

### 核心架构不变量（红线）

请务必先阅读 [GLOSSARY.md](./GLOSSARY.md) 与 [docs/adr/](./docs/adr/) 了解设计边界。所有 PR 不得破坏以下约束：

1. **后台无感（严禁抢焦点 / 置顶）**：
   - 严禁对被控后台应用调用 AppleScript `activate`、不带 `-g` 的 `open -a`、`activateWithOptions` 或 `AXRaise`（仅限小窗内用户显式点击「置顶」按钮）。
   - 保持 `window_placement: "keep"` 只读策略与 `Window-Local Delivery Floor`（`window_post` / `window_key` 永不被永久拉黑）。
2. **写入闸门与同窗证明**：
   - 所有桌面原生写入（OCU peer `stdin.write`、JXA bridge、直接 AX 写入、launch/unhide）在最终派发前必须通过 `TakeoverController.assertMayDispatch(...)` 校验。
   - 未通过同窗证明（Same-Window Proof）时，任意像素坐标点击必须降级为只读拒绝。
3. **沙箱默认拒绝策略**：
   - `CUAScriptRunner` 的 Seatbelt profile（`native/ScriptRunner/strict.sb`）与 JSC 禁用 JIT/WASM/eval 策略必须维持 default-deny，任何对系统资源的放行需伴随正向与拒绝单测。
4. **代码与测试**：
   - 每个 PR 尽量聚焦单一改动，补充或更新对应的 `test/*.test.mjs` 用例，并确保 `npm test` 全部通过。

---

## English

Issues and pull requests are welcome! Before submitting changes, please review the core invariants that keep background desktop automation safe and non-intrusive.

### Local Development & Verification

**Prerequisites**: macOS 14.0+, Node.js >= 18, and Xcode Command Line Tools (`swiftc`, `clang`, `codesign`).

```bash
# 1. Build native Swift/C helpers (CUADesktopHelper.app & CUAScriptRunner.app)
npm run build:native

# 2. Run the full test suite (runs without triggering macOS TCC prompts)
npm test

# 3. Optional: generate the shareable one-click ZIP archive under dist/
npm run pack-share
```

### Core Architectural Invariants

Please read [GLOSSARY.md](./GLOSSARY.md) and [docs/adr/](./docs/adr/) before making architectural changes. All PRs must preserve:

1. **Non-Intrusive Background Execution (No Focus Stealing / No Raising)**:
   - Never invoke AppleScript `activate`, `open -a` without `-g`, `activateWithOptions`, or `AXRaise` on background target apps (except when the user explicitly clicks the "Bring to Front" control in the Mini-Window).
   - Preserve read-only `window_placement: "keep"` and the `Window-Local Delivery Floor` (`window_post` / `window_key` must never be permanently blacklisted).
2. **Pre-IPC Write Gate & Same-Window Proof**:
   - Every native desktop write (OCU peer `stdin.write`, JXA bridge dispatch, direct AX mutation, launch/unhide) must check `TakeoverController.assertMayDispatch(...)` immediately before dispatch.
   - Without verified Same-Window Proof, arbitrary coordinate clicks must fail closed as read-only.
3. **Default-Deny Script Sandbox**:
   - `CUAScriptRunner`'s Seatbelt profile (`native/ScriptRunner/strict.sb`) and JSC hardening (`useJIT=false`, `useWasm=false`, eval disabled) must remain default-deny. Any whitelist expansion requires both allow and deny regression tests.
4. **Focused PRs & Tests**:
   - Keep each PR focused on a single concern, add or update tests under `test/*.test.mjs`, and verify `npm test` passes completely.
