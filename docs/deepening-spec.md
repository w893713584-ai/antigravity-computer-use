# Deep Module Architecture Optimization Spec

## Goal
Refactor `codex-style-computer-use` using Matt Pocock's `codebase-design` (`DEEPENING.md`), `domain-modeling`, and `tdd` principles so high-friction cross-file logic collapses into deep modules with small public interfaces, strong locality, and seam-level testability — without breaking any existing public export, constructor option, or non-intrusive macOS background control invariant.

## Required Deliverables & Invariants

1. **Domain Model & Architecture Decision Records (`domain-modeling`)**
   - `GLOSSARY.md` defining ubiquitous domain terms in pure domain language (zero implementation details).
   - `docs/adr/0001..0003` recording hard-to-reverse architectural decisions (`Dual Native Peers`, `Persistent JXA Bridge`, `Non-Blockable Window-Local Delivery Floor`).

2. **Deep Module 1 — `FocusPolicyGuard` (`src/focus-policy-guard.mjs`)**
   - Unify Focus Steal detection (`matchesTargetIdentity`, `didTargetStealFocus`), adaptive route blacklisting (`SelfActivationTracker`), Window-Local Delivery Floor (`window_post`, `window_key`), background route planning (`planClick`, `planKey`), and post-action focus sweep / epoch cancellation into one module.
   - Preserve re-exports from `src/background-policy.mjs` and `src/headless-engine.mjs` for 100% backward compatibility.
   - Never permanently blacklist `window_post` or `window_key`, even if focus guard reclaims a transient self-activation.

3. **Deep Module 2 — `AppSnapshotRegistry` (`src/app-snapshot-registry.mjs`)**
   - Unify `get_app_state` and `query` element descriptor construction (`buildElementDescriptor`), secure password redaction (`isSecureTextRole`), `SnapshotLedger` issuance, Electron `AXManualAccessibility` wake memoization, serialized `axBridge.bindSnapshot` ordering, and pre-dispatch `@sN:index` validation (`validateTargetRef`).

4. **Deep Module 3 — `BackgroundActionExecutor` (`src/action-executor.mjs`)**
   - Encapsulate background input routing (`window_post`, `window_key`, `sky_click`, `app_post`, `tinyWindowOverride` screen remapping, `AXShowMenu` / `AXScrollBar` / `AXSelectedText` fast-paths, and `set_value:sky_bypass` with editable-focus safety gate and single-line newline sanitization) plus closed-loop post-action readback verification (`verifyAndFormatReadBack`).

5. **Deep Module 4 — Transport Adapters (`src/jsonrpc-stdio.mjs` & `src/sidecar-web-adapter.mjs`)**
   - Deduplicate JSON-RPC 2.0 stdio framing, 32MB line guard, FIFO serialization, and one-time `[Computer Use 小窗](sidecar://computer-use-preview/)` pill-hint attachment across `src/mcp-server.mjs` and `src/mcp-repl-server.mjs`.
   - Extract HTTP/SSE endpoints, Sidecar token authentication, AgentAPI forwarding, frame deduplication, and adaptive live-stream polling out of `src/broker-sidecar.mjs` into `SidecarWebAdapter`.

6. **Backward Compatibility & Non-Intrusive Safety**
   - Preserve all `ComputerUseBrokerServer` constructor options, public methods (`start`, `close`, `executeToolCall`, `getToolsList`, `refreshAppsList`), and `state` shape.
   - Never invoke foreground `activate`, `open -a` without `-g`, or `Raise` on background apps (except explicit user `/api/bring-to-front`).
   - Pass all existing tests (`policy`, `broker`, `installer`) plus new public-seam tests (`test/deep-modules.test.mjs`).
