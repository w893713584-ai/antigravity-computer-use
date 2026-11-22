# Codex-Style Computer Use

Non-intrusive background desktop automation for macOS that observes and operates target application windows without raising them, moving the user's cursor, or stealing focus, paired with a live Side-Pane Mini-Window.

## Observation & Addressing

**Snapshot**:
An immutable point-in-time observation of a target application's window metadata, visual frame, and numbered accessibility elements, identified by a monotonic version identifier.
_Avoid_: Screen dump, tree cache, state frame

**Qualified Element Ref**:
A version-pinned element address bound to a specific Snapshot that fails closed whenever the target window, application process generation, or live accessibility node mutates before dispatch.
_Avoid_: Selector, raw index, node pointer

**Tiny Window Override**:
Automatic substitution of a target application's auxiliary floating widget or orb with its main standard window for frame capture and coordinate mapping.
_Avoid_: Orb hack, fallback screenshot

## Background Execution & Focus Safety

**Focus Steal**:
Unsolicited foreground activation by a background target application during automation, immediately reclaimed so the user's active window retains focus.
_Avoid_: Window pop, focus glitch, activation flash

**Delivery Route**:
A named non-activating input channel for sending mouse, keyboard, scroll, or value mutations to a background application, adaptively ranked per **Route Scope** with isolated click and keyboard risk based on prior **Focus Steals**.
_Avoid_: Click mode, fallback handler, input driver

**Route Scope**:
The execution identity (`pid`, process instance token, and targeted window ID when known) within which adaptive **Delivery Route** penalties apply, preventing self-activation on one window or process generation from penalizing unrelated windows or keyboard input.
_Avoid_: Penalty key, app blacklist, focus context

**Delivery Receipt**:
The structured outcome record (`delivery` verification status, `route` executed, and optional `requestedRoute`) returned natively across internal and scripted automation interfaces rather than parsed from display text.
_Avoid_: Footer tag, status string, log badge

**Window-Local Delivery Floor**:
The lowest-focus-footprint window-targeted Delivery Routes that never emit synthetic activation signals and are never permanently blacklisted even when a clicked application control self-activates.
_Avoid_: Fallback post, raw PID click

**Window-Local Point**:
Logical coordinates measured relative to the target window's top-left corner (`x: 0..width`, `y: 0..height`), explicitly converted at the single Action Executor seam before mapping to scaled screenshot pixels or global screen coordinates.
_Avoid_: Normalized pixel, raw coordinate, display offset

**Atomic Intent (`act`)**:
A single serialized target-locate, progressive reveal scroll, single background click, and semantic postcondition verification transaction that fails closed on ambiguity, scroll stagnation, or continuous video playback without replaying clicks.
_Avoid_: Blind click macro, retry loop, frame-diff heuristic

## Preview & Same-Window Geometry

**Target Key**:
The composite identity of a specific live application window tracked across process restarts and window recreation.
_Avoid_: Window handle, stream key, app ID

**Same-Window Proof**:
Verified evidence that the window shown in the Side-Pane Mini-Window and the window receiving a coordinate action are the exact same live window with unchanged logical bounds; without it, arbitrary coordinate input degrades to read-only.
_Avoid_: Bounds check, active app match, frame freshness

**Preview Stream**:
A continuous visual feed of a single Target Key rendered in the Side-Pane Mini-Window while preserving identical Window-Local Point coordinates across video and still-frame transports.
_Avoid_: Screen mirror, display capture, frame loop

## Live Supervision & Human Takeover

**Side-Pane Mini-Window**:
The auxiliary preview and control pane beside the chat that streams background application frames, renders telemetry, and accepts direct user pause, raise, or background input.
_Avoid_: Virtual desktop, overlay window

**Human Takeover**:
Immediate transfer of control from automation to the person at the keyboard whenever deliberate human interaction targets the automated window, the Side-Pane Mini-Window, or the emergency stop shortcut.
_Avoid_: Auto-pause, idle break, focus interrupt

**Pause Epoch**:
A monotonically advancing generation counter incremented on every Human Takeover so queued or in-flight automation work from an earlier generation can never resume or replay after unpausing.
_Avoid_: Pause flag, cancel token, lock bit

**Drain Gate**:
The brief transitional phase after a Human Takeover during which already-sent operating system inputs finish settling before manual input from the Side-Pane Mini-Window is dispatched.
_Avoid_: Action flush, mutex wait, sleep barrier

**Synthetic Input Tag**:
A per-session marker carried by automation-generated input events so Human Takeover sensors never mistake the system's own background actions for human intervention.
_Avoid_: Echo filter, timestamp cooldown, event flag

## Sandboxed Scripting

**Script Session**:
A multi-turn automation workspace that preserves serializable bindings and application references across turns while executing each turn in a fresh, isolated runtime with no network or filesystem access.
_Avoid_: Persistent VM, Node worker, eval context
