# Antigravity Computer Use (Codex-Style)

[中文](./README.md) | [English](./README.en.md)

Non-intrusive background Computer Use MCP servers and a live Side-Pane Mini-Window for Google Antigravity on macOS — automate background applications without raising windows, stealing focus, or moving the user's cursor.

---

## Key Features

1. **Non-Intrusive Background Control (No Raising, No Focus Stealing, No Floating Cursor)**
   - Reuses a notarized/authorized `Open Computer Use.app` runtime (via optional dependency `open-computer-use`) and keeps occluded background windows rendering via `WindowOcclusionKeepAlive`.
   - Enforces read-only `window_placement: "keep"` alongside a Broker-managed Focus-Steal Guard (sub-frame reclaim sweeps and adaptive `SelfActivationTracker`), never calling foreground `activate`, `AXRaise`, or relaunching quit applications.
   - Launches apps silently with `open -g` only when explicitly requested, unhides `Cmd+H` windows in the background without stealing focus, routes clicks/keys through non-activating window-local or SkyLight channels, and suppresses the floating desktop cursor.

2. **Live Side-Pane Mini-Window (Antigravity Aux Pane Sidecar)**
   - Isolates accessibility element indexing (`ActionEngine`) from live visual streaming (`StreamEngine`) so streaming frames never overwrite cached `element_index` state.
   - Streams hardware-encoded H.264 frames from `CUADesktopHelper.app` (`ScreenCaptureKit` + `VideoToolbox`) to `WebCodecs` in the side pane, falling back automatically to same-window JPEG when unavailable.
   - Enforces a strict **Same-Window Proof** coordinate contract: arbitrary clicks are allowed only when the previewed window and target window identity/bounds match, degrading safely to read-only otherwise.

3. **Human Takeover Brake & Default-Deny Script Sandbox**
   - **Human Takeover (`TakeoverController`)**: Detects direct Mini-Window interactions, real user clicks on the target window, system app-switching gestures, and a global emergency hotkey (`Control+Option+Escape` by default), halting queued AI writes at the pre-IPC dispatch gate.
   - **Sandboxed REPL (`CUAScriptRunner.app`)**: Executes each `computer-use-js` turn in a fresh child process confined by a default-deny macOS Seatbelt profile (no network, no filesystem writes, no subprocess spawning) and a hardened JavaScriptCore VM (JIT, WASM, and `eval` disabled) while persisting serializable bindings and app handles across turns.

4. **Persistent Millisecond AX Bridge & Live Handle Verification**
   - **`PersistentAxBridge`**: Eliminates repeated `osascript` cold-start latency for sub-frame focus checks and rapid reclaim sweeps.
   - **Live `AXUIElementRef` Verification (`STALE_REF`)**: Binds version-pinned `@sN:index` element refs to live AX handles and relative window geometry, failing closed if the background DOM/UI mutates or opens a modal sheet before dispatch.
   - Lazily wakes Electron/Chromium accessibility trees (`AXManualAccessibility = true`) in the background and redacts `AXSecureTextField` controls while blocking keyboard-bypass routes on password fields.

---

## Requirements

- **OS**: macOS 14.0 (Sonoma) or later
- **Node.js**: >= 18 (Node.js 22 recommended)
- **Host App**: Google Antigravity
- **Building from source**: Xcode Command Line Tools (`swiftc`, `clang`, `codesign`)

---

## Installation & Removal

### Option 1: Install from Source

```bash
git clone https://github.com/w893713584-ai/antigravity-computer-use.git
cd antigravity-computer-use

# 1. Build native Swift/C helpers (CUADesktopHelper.app & CUAScriptRunner.app)
npm run build:native

# 2. Deploy to ~/.gemini/codex-style-computer-use and wire Antigravity MCP & Sidecar
npm run install-agy
```

### Option 2: Build a Shareable One-Click Installer

```bash
npm run pack-share
# Outputs dist/Codex风格ComputerUse一键安装包.zip
```

Unzip and run `双击安装.command` (or `bash 双击安装.command` in Terminal). See [使用说明.txt](./使用说明.txt) for Gatekeeper and setup details.

### macOS Permissions (Privacy & Security)

Grant the following permissions as needed in **System Settings → Privacy & Security** (missing permissions degrade gracefully):
1. **Accessibility**: `Antigravity.app`, `Open Computer Use.app`, `~/.gemini/codex-style-computer-use/native-runtime/CUADesktopHelper.app`
2. **Screen Recording**: `Open Computer Use.app`, `CUADesktopHelper.app` (required for live H.264 streaming)
3. **Input Monitoring**: `CUADesktopHelper.app` (required for hardware takeover detection and emergency hotkey)

### Uninstall

```bash
npm run uninstall-agy
# Or run ~/.gemini/codex-style-computer-use/双击卸载.command
```

---

## Repository Structure & Documentation

- `src/` — Broker server, MCP & REPL stdio servers, focus policy guard, AX bridge, geometry contract, WebSocket video hub, and Sidecar UI
- `native/DesktopHelper/` — Swift helper for ScreenCaptureKit capture, hardware H.264 encoding, and input takeover sensing
- `native/ScriptRunner/` — Swift/C Seatbelt + JavaScriptCore sandbox runner (with vendored `acorn`)
- `scripts/` — Native build (`build-native.mjs`), installer/uninstaller, and share-bundle packager
- `test/` — Unit test suite (uses injected test doubles; no macOS TCC dialogs during CI)
- Architecture docs:
  - [GLOSSARY.md](./GLOSSARY.md)
  - [docs/deepening-spec.md](./docs/deepening-spec.md)
  - [docs/adr/](./docs/adr/) (ADRs 0001–0006)
  - [docs/design/option-a-blueprint.md](./docs/design/option-a-blueprint.md)

---

## Development & Contributing

```bash
npm test
```

Contributions are welcome! Please review [CONTRIBUTING.md](./CONTRIBUTING.md) before opening a PR, and report security issues privately per [SECURITY.md](./SECURITY.md).

---

## License & Acknowledgments

- Licensed under the [MIT License](./LICENSE).
- See [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) for bundled/runtime dependencies and design acknowledgments, including:
  - [iFurySt/open-computer-use](https://github.com/iFurySt/open-computer-use) (MIT License) and its upstream attributions (`trycua/cua`, `asmvik/yabai`, `libwebp`)
  - [vercel-labs/agent-desktop](https://github.com/vercel-labs/agent-desktop) (Apache-2.0 License, design inspiration for headless `AXSelectedText` and `AXScrollBar` support)
  - [acornjs/acorn](https://github.com/acornjs/acorn) (MIT License, vendored in `native/ScriptRunner/vendor/acorn.js`)
