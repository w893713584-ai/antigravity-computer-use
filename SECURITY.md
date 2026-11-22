# Security Policy / 安全策略

[中文](#中文) | [English](#english)

---

## 中文

### 安全边界说明

本项目涉及 macOS 辅助功能（Accessibility）、屏幕录制（Screen Recording）、输入监控（Input Monitoring）与本地自动化脚本执行，主要安全边界如下：

- **本地回环服务隔离**：Sidecar HTTP / SSE / WebSocket 服务仅监听 `127.0.0.1` 回环地址，并通过启动期随机生成的认证 Token 与单次 WebSocket Ticket 进行访问校验（同时校验 `Host` 与 `Origin`）。
- **脚本执行沙箱**：`computer-use-js` 通过独立的 `CUAScriptRunner.app` 子进程执行用户脚本，启用 macOS Seatbelt 默认拒绝策略（`native/ScriptRunner/strict.sb`，禁止网络、文件写入与子进程派生），关闭 JSC JIT/WASM/`eval`，并施加 CPU 时间片、墙钟与输出体积上限。
- **敏感输入框脱敏**：所有 `AXSecureTextField` 密码/密钥输入框自动脱敏，且禁止回退至键盘按键模拟通道。

### 漏洞上报方式

**请勿通过公开 Issue 报告未修复的安全漏洞。**

请使用本仓库 GitHub **Security** 标签页中的 **Report a vulnerability**（Private Vulnerability Reporting）功能私密提交：
- 漏洞影响模块与复现步骤（尽量提供最小复现用例）
- 受影响的 macOS 版本与运行模式
- 潜在安全影响与修复建议（如有）

---

## English

### Security Architecture

This project interacts with macOS Accessibility, Screen Recording, Input Monitoring, and automated script execution. Key security boundaries include:

- **Loopback Service Isolation**: The Sidecar HTTP/SSE/WebSocket server binds strictly to `127.0.0.1` and enforces per-boot authentication tokens, single-use WebSocket tickets, and strict `Host`/`Origin` checks.
- **Sandboxed Script Execution**: `computer-use-js` runs each turn in a fresh `CUAScriptRunner.app` child process confined by a default-deny macOS Seatbelt profile (`native/ScriptRunner/strict.sb`, blocking network, filesystem writes, and process spawning), with JSC JIT, WASM, and `eval` disabled alongside CPU and wall-clock watchdogs.
- **Secure Input Redaction**: `AXSecureTextField` controls are redacted in snapshots and blocked from keyboard-bypass input routes.

### Reporting a Vulnerability

**Please do not open public GitHub Issues for undisclosed security vulnerabilities.**

Use GitHub's **Private Vulnerability Reporting** ("Report a vulnerability" under the repository's **Security** tab) and include:
- Affected component and minimal reproduction steps
- macOS version and runtime configuration
- Potential security impact and suggested mitigation (if known)
