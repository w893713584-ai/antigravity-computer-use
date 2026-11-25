# Antigravity Computer Use (Codex-Style)

[中文](./README.md) | [English](./README.en.md)

Turn Google Antigravity's `computer-use` and `computer-use-js` into a **non-intrusive macOS background automation + live Side-Pane Mini-Window** workflow matching Codex: AI automates background desktop applications without raising windows or stealing your keyboard/mouse focus, while streaming live video and actions into Antigravity's right-hand auxiliary pane with instant human takeover braking.

---

## 1. Project Overview & Architecture

The system is built across **4 coordinated layers** centered around a single shared `ComputerUseBrokerServer` (UDS JSON-RPC + Local HTTP/WebSocket Sidecar):

| Layer | Core Files / Directories | Responsibilities |
| :--- | :--- | :--- |
| **MCP Entry Points** | [`src/mcp-server.mjs`](./src/mcp-server.mjs)<br>[`src/mcp-repl-server.mjs`](./src/mcp-repl-server.mjs) | Exposes `computer-use` tools and `computer-use-js` (`js` / `js_reset`) persistent sandboxed REPL tools to Antigravity; attaches `[Computer Use 小窗](sidecar://computer-use-preview/)` once on the first successful call. |
| **Broker & Deep Modules** | [`src/broker-sidecar.mjs`](./src/broker-sidecar.mjs)<br>[`src/action-executor.mjs`](./src/action-executor.mjs)<br>[`src/act-executor.mjs`](./src/act-executor.mjs)<br>[`src/focus-policy-guard.mjs`](./src/focus-policy-guard.mjs)<br>[`src/app-snapshot-registry.mjs`](./src/app-snapshot-registry.mjs) | Unified AX snapshot & `@sN:index` ledger, window-scoped focus-steal guard (Route Scope), Pre-IPC human takeover write gate, Same-Window Proof coordinate contract, structured `Delivery Receipt`, and closed-loop read-back verification. |
| **Native Bridge & Video Plane** | [`src/ax-bridge.mjs`](./src/ax-bridge.mjs)<br>[`native/DesktopHelper/`](./native/DesktopHelper/)<br>[`src/preview-stream.mjs`](./src/preview-stream.mjs)<br>[`src/sidecar-web.mjs`](./src/sidecar-web.mjs) | Resident JXA Accessibility hot bridge (`PersistentAxBridge`) + Swift `CUADesktopHelper.app` for `ScreenCaptureKit` + `VideoToolbox` H.264 streaming, strict AX-to-WID lookup, `CGEventTap` hardware takeover sensing, and the Sidecar web UI. |
| **Sandbox & Packaging** | [`native/ScriptRunner/`](./native/ScriptRunner/)<br>[`scripts/`](./scripts/) | `CUAScriptRunner.app` (default-deny macOS Seatbelt profile + JIT/WASM/`eval`-disabled JSC VM with vendored `acorn`); native build (`build:native`), Antigravity live installer (`install-agy`), and share-bundle packager (`pack-share`). |

---

## 2. Core Features

### 1. Non-Intrusive Background Control (No Raising, No Focus Stealing, No Floating Cursor)
- **Dual Native Peer Isolation ([ADR-0001](./docs/adr/0001-dual-native-peers-for-action-and-stream.md))**: Reuses `Open Computer Use.app` (via optional dependency `open-computer-use`) with separate `ActionEngine` and `StreamEngine` peers so background video frames never overwrite active `element_index` tables.
- **Full-Path Non-Activation**: Enforces `window_placement: "keep"` and `WindowOcclusionKeepAlive` so occluded background windows keep rendering. Launches stopped apps only when requested via silent `open -g`, unhides `Cmd+H` windows without activating them, and clears state cleanly if the user quits the target app.
- **Window-Scoped Focus-Steal Guard ([ADR-0007](./docs/adr/0007-window-scoped-focus-attribution-and-structured-receipts.md))**:
  - `PersistentAxBridge` detects focus steals and reclaims the user's prior frontmost app within sub-frame sweeps, re-sampling foreground on failed restores so an intermediate app switch is never overwritten.
  - **Window-Local Delivery Floor ([ADR-0003](./docs/adr/0003-non-blockable-window-local-delivery-floor.md))**: `window_post` and `window_key` are never blacklisted.
  - **Scoped Route Penalties**: Focus-steal penalties are keyed by `(pid, processToken, windowId)` Route Scope and isolated between click and keyboard routes; legitimate Home→Editor new-window transitions and `observationalOnly` post-action read-backs never poison future `sky_click` routes.

### 2. Live Side-Pane Mini-Window & Same-Window Proof
- **Hardware H.264 + Adaptive Same-WID JPEG**: Streams live video from `CUADesktopHelper.app` (`ScreenCaptureKit` + `VideoToolbox` H.264) into `WebCodecs`; when a window reports `offscreen` or hardware capture is unavailable, preserves target binding and degrades gracefully to same-WID JPEG or paused read-only mode until the window returns on-screen.
- **Same-Window Proof Contract ([ADR-0006](./docs/adr/0006-window-point-canonical-geometry-and-dual-uds-video-plane.md))**: Coordinate clicks are dispatched only when the active preview/screenshot geometry and `windowId` match the target window (failing fast on `window_resized` or cross-WID `query` mismatches) to prevent mis-clicking sibling windows.
- **Interactive Sidecar Controls**: Displays AI virtual cursor trails, action feed, and focus-shield counters, while letting the user click/double-click/right-click/scroll/type directly inside the mini-window, toggle Follow AI, Pause/Resume, or Raise once on demand.

### 3. Human Takeover Brake & Default-Deny Script Sandbox
- **Dual-Tier Takeover Brake ([ADR-0004](./docs/adr/0004-dual-tier-human-takeover-with-drain-gate.md))**: Detects direct mini-window interaction, real user input hitting the target window, app-switching gestures, and a global emergency hotkey (`Control+Option+Escape` by default). Synchronous Pause Epoch checks + a **Pre-IPC Write Gate** block in-flight writes before native dispatch and surface `WRITE_OUTCOME_UNKNOWN` rather than replaying ambiguous writes.
- **Sandboxed REPL ([ADR-0005](./docs/adr/0005-fresh-process-seatbelt-jsc-script-sandbox.md))**: Each `computer-use-js` `js` invocation runs in a fresh `CUAScriptRunner.app` child process under a default-deny macOS Seatbelt profile (no network, no filesystem writes, no subprocesses) and hardened JavaScriptCore (JIT, WASM, `eval`, and `Function` disabled), persisting serializable bindings and returning broker-owned `Delivery Receipt` objects (`{ ok, delivery, route, executedRoute, requestedRoute }`).

### 4. Live Handle Protection, Observational Read-Back & Atomic `act`
- **Live `AXUIElementRef` Verification (`STALE_REF`)**: Binds versioned `@sN:index` element refs to live AX handles and relative geometry, blocking stale dispatches after UI mutation or modal transitions. Wakes Electron/Chromium `AXManualAccessibility` in the background on demand, redacts `AXSecureTextField` secrets, and blocks keyboard bypass on password fields.
- **Atomic `act` Tool**: Finds targets, deduplicates nested matches, auto-scrolls containers when needed, clicks once in the background, and verifies declarative `expect` postconditions.
- **Strict Observational Read-Back**: Post-action read-back runs in `observationalOnly` mode (never launching apps, waking AX, or promoting tiny windows). Visual pixel diffs alone stay `delivered_unverified`, reserving `delivered_verified` for structural AX changes, verified value reads, or confirmed direct delivery.

---

## 3. Strengths, Limitations & Trade-Offs

### Strengths
1. **Uninterrupted Human Workflow**: Keeps windows in the background without stealing focus or hijacking the physical cursor during normal operation.
2. **Full Visibility & Instant Emergency Braking**: The live Aux Pane mini-window lets you supervise every AI step in real time and halt queued writes within milliseconds using real mouse/keyboard input or `Control+Option+Escape`.
3. **Strong Safety & Correctness Guards**: Enforces `STALE_REF` live handle validation, Same-Window Proof geometry checks, password-field redaction, `WRITE_OUTCOME_UNKNOWN` non-replay, and a Seatbelt + hardened JSC sandbox.
4. **Low Latency & High Maintainability**: `PersistentAxBridge` removes repeated `osascript` cold starts, hardware H.264 cuts capture overhead, and deep modules allow fast, TCC-free CI testing.

### Cons & Limitations
1. **Platform & Host Coupling**: Built exclusively for **macOS 14.0+** and **Google Antigravity / T3 Code (Antigravity Provider)**; no Windows or Linux support. When running inside T3 Code standalone (without Antigravity Desktop open), the live mini-window opens via its local `http://127.0.0.1:<port>/?token=...` preview URL instead of `sidecar://`.
2. **TCC Permissions & Ad-Hoc Signature Friction**: Full capabilities require Accessibility, Screen Recording, and Input Monitoring approvals. Because local builds of `CUADesktopHelper.app` use ad-hoc signing, reinstalling/upgrading can leave macOS holding a stale TCC entry — requiring you to remove (`−`) and re-add (`+`) the app in System Settings if permission prompts persist.
3. **App-Specific Responder Chains & Fullscreen Spaces**: Custom-drawn apps, games, fullscreen Space windows, or freshly opened sub-windows in certain Qt/Electron apps may ignore synthetic background events until the user clicks inside that window once to initialize its internal responder chain.
4. **OS Coupling & Resident Resource Overhead**: Uses low-level SkyLight, `CGEvent`, and `ScreenCaptureKit` APIs that can require updates across future major macOS releases, alongside modest background memory/power usage for the broker, JXA bridge, and video stream.
5. **Closed-Loop Overhead**: Pre-write gates, live ref checks, and post-action read-backs add a small per-step latency compared to unverified blind coordinate clicking.

---

## 4. Usage Guide

### Requirements
- **OS**: macOS 14.0 (Sonoma) or later
- **Node.js**: >= 18 (Node.js 22 recommended)
- **Host App**: Google Antigravity or T3 Code (Antigravity Provider)
- **From Source Only**: Xcode Command Line Tools (`swiftc`, `clang`, `codesign`)

### Installation

#### Option 1: Build & Install from Source (Recommended for Developers)
```bash
git clone https://github.com/w893713584-ai/antigravity-computer-use.git
cd antigravity-computer-use

# 1. Compile native Swift/C helpers (CUAScriptRunner.app & CUADesktopHelper.app)
npm run build:native

# 2. Deploy to ~/.gemini/codex-style-computer-use and configure Antigravity MCP & Sidecar
npm run install-agy
```

#### Option 2: Shareable One-Click Installer
```bash
# Generates dist/Codex风格ComputerUse一键安装包.zip
npm run pack-share
```
Unzip and run in Terminal (bypasses macOS 15 Sequoia Gatekeeper quarantine prompts reliably):
```bash
bash /path/to/Codex风格ComputerUse一键安装包/双击安装.command
```
> GUI Finder opening steps and Gatekeeper notes are included in [使用说明.txt](./使用说明.txt).

### First-Time macOS Permissions (System Settings → Privacy & Security)
Grant permissions as needed (missing permissions degrade individual features gracefully):
1. **Accessibility**: `Antigravity.app` (plus `T3 Code (Beta).app` / `T3 Code.app` when running inside T3 Code), `Open Computer Use.app`, `~/.gemini/codex-style-computer-use/native-runtime/CUADesktopHelper.app`
2. **Screen Recording**: `Open Computer Use.app`, `CUADesktopHelper.app` (plus `T3 Code (Beta).app` / `T3 Code.app` when using T3 Code; enables live H.264 streaming and window capture)
3. **Input Monitoring**: `CUADesktopHelper.app` (enables hardware takeover detection and global emergency hotkey)

> Tip: When clicking `+` in System Settings, press `Command + Shift + G` and paste `~/.gemini/codex-style-computer-use/native-runtime/CUADesktopHelper.app`.

### Daily Usage in Antigravity
- **Open the Live Mini-Window**: On the first Computer Use call in a chat, the reply includes a `[Computer Use 小窗](sidecar://computer-use-preview/)` link — click it to open the live pane beside the conversation.
- **Mini-Window Controls**:
  - Toggle **Follow AI**, **Pause / Resume AI**, or **Bring to Front** from the header controls.
  - Interact directly inside the live view (left/right click, double-click, scroll, type text, send hotkeys).
  - **Emergency Stop**: Press `Control + Option + Escape` globally at any time to freeze and cancel AI writes before native dispatch.
- **MCP Tool Reference**:
  - `computer-use`: `list_apps`, `get_app_state`, `query`, `click`, `drag`, `scroll`, `type_text`, `press_key`, `set_value`, `select_text`, `perform_secondary_action`, `act`.
  - `computer-use-js`: `js` (sandboxed persistent REPL exposing `cua.getApp`, `app.getAXState`, `app.query`, `app.act`, `app.click`, `app.typeText`, `app.pressKey`, `app.scroll`, `app.setValue`, etc., returning `{ ok, delivery, route, executedRoute, requestedRoute }`) and `js_reset`.

```js
// Example using computer-use-js (`js` tool)
const app = await cua.getApp("Finder", { initialState: false });
await app.getAXState();
const res = await app.act({
  target: { text: "New Folder" },
  expect: { any_text: ["untitled folder"] },
});
nodeRepl.write(JSON.stringify(res));
```

### Troubleshooting
- **Blank Preview / Missing Video**: Verify Screen Recording permission for `CUADesktopHelper.app`. After upgrading/reinstalling, remove (`−`) and re-add (`+`) it if macOS holds a cached ad-hoc signature entry.
- **`offscreen` / Paused Read-Only Status**: The window is minimized or on another macOS Space. Restore it or use **Bring to Front** once in the side pane.
- **`STALE_REF` or Cross-Window Coordinate Rejection**: UI elements mutated or window bounds changed after the last snapshot; call `get_app_state` to refresh geometry and refs.
- **Newly Opened Sub-Window Ignores Background Events**: Some complex Qt/Electron windows (e.g., freshly opened editor tabs) require a single manual click inside the window to arm their responder chain before continuing in background mode.

### Uninstall
```bash
npm run uninstall-agy
# Or run ~/.gemini/codex-style-computer-use/双击卸载.command
```

---

## 5. Repository Structure & Documentation

- [`src/`](./src/) — Broker server, MCP & sandboxed REPL servers, `FocusPolicyGuard`, `AppSnapshotRegistry`, `BackgroundActionExecutor`, `AtomicActExecutor`, `TakeoverController`, `PersistentAxBridge`, `PreviewStreamManager`, WebSocket hub, and Sidecar UI
- [`native/DesktopHelper/`](./native/DesktopHelper/) — Swift helper for ScreenCaptureKit capture, VideoToolbox H.264 encoding, window inventory, and `CGEventTap` input sensing
- [`native/ScriptRunner/`](./native/ScriptRunner/) — Swift/C Seatbelt + JavaScriptCore sandbox runner (with vendored `acorn`)
- [`scripts/`](./scripts/) — Native build (`build-native.mjs`), installer/uninstaller, and share-bundle packager (`pack-share.mjs`)
- [`test/`](./test/) — Unit test suite using injected test doubles (runs cleanly in CI with zero TCC dialogs)
- Architecture docs:
  - [GLOSSARY.md](./GLOSSARY.md)
  - [docs/deepening-spec.md](./docs/deepening-spec.md)
  - [docs/adr/](./docs/adr/) (ADRs 0001–0007, including [ADR-0007 Window-Scoped Focus Attribution & Structured Receipts](./docs/adr/0007-window-scoped-focus-attribution-and-structured-receipts.md))
  - [docs/design/option-a-blueprint.md](./docs/design/option-a-blueprint.md)

---

## 6. Development & Contributing

```bash
npm test
```

Contributions are welcome! Please review [CONTRIBUTING.md](./CONTRIBUTING.md) before opening a PR, and report security vulnerabilities privately per [SECURITY.md](./SECURITY.md).

---

## 7. License & Acknowledgments

- Licensed under the [MIT License](./LICENSE).
- See [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) for bundled/runtime dependencies and design acknowledgments, including:
  - [iFurySt/open-computer-use](https://github.com/iFurySt/open-computer-use) (MIT License) and its upstream attributions (`trycua/cua`, `asmvik/yabai`, `libwebp`)
  - [vercel-labs/agent-desktop](https://github.com/vercel-labs/agent-desktop) (Apache-2.0 License, design inspiration for headless `AXSelectedText` and `AXScrollBar` support)
  - [acornjs/acorn](https://github.com/acornjs/acorn) (MIT License, vendored in `native/ScriptRunner/vendor/acorn.js`)
