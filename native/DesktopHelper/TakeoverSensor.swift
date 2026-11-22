import AppKit
import ApplicationServices
import Carbon.HIToolbox
import CoreGraphics
import Foundation

struct HelperCapabilities: Codable, Equatable {
  let screenRecordingPreflight: Bool
  let inputMonitoringPreflight: Bool
  let accessibilityTrusted: Bool
  let mouseTapActive: Bool
  let keyTapActive: Bool
  let hotkeyActive: Bool
  let secureInputActive: Bool
  let sessionLocked: Bool
  let fallbackReason: String?
}

struct SensorEventPayload: Encodable {
  let type: String
  let sourceClass: String
  let sourceTag: Int64?
  let sourcePid: Int32?
  let pid: Int32?
  let processToken: String?
  let frontmostPid: Int32?
  let focusedWindowId: Int64?
  let hasHumanSwitchGesture: Bool?
  let isRepeat: Bool?
  let hit: HitTestResult?
  let timestampNs: UInt64
}

private enum RawTapEventKind {
  case mouseDown
  case keyDown
  case keyUp
  case flagsChanged
}

private struct RawTapEvent {
  let kind: RawTapEventKind
  let locationPt: CGPoint
  let keyCode: Int64
  let isRepeat: Bool
  let flags: CGEventFlags
  let sourceUserData: Int64
  let sourcePid: Int32
  let timestampNs: UInt64
}

private struct ParsedHotkey {
  let spec: String
  let keyCode: Int64
  let requiredMask: CGEventFlags
}

private let kKeyCodeTab: Int64 = 48
private let kRelevantModifierMask: CGEventFlags = [.maskControl, .maskAlternate, .maskCommand, .maskShift]
private let kKeyCodeByName: [String: Int64] = [
  "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9,
  "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19,
  "3": 20, "4": 21, "6": 22, "5": 23, "9": 25, "7": 26, "8": 28, "0": 29, "o": 31,
  "u": 32, "i": 34, "p": 35, "return": 36, "enter": 36, "l": 37, "j": 38, "k": 40,
  "n": 45, "m": 46, "tab": 48, "space": 49, "escape": 53, "esc": 53,
  "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97,
  "f7": 98, "f8": 100, "f9": 101, "f10": 109, "f11": 103, "f12": 111,
]

private func parseEmergencyHotkeySpec(_ rawSpec: String?) -> ParsedHotkey? {
  let raw = (rawSpec ?? "ctrl+opt+escape").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
  guard !raw.isEmpty, !raw.contains(where: { $0.isWhitespace }) else { return nil }
  let parts = raw.split(separator: "+").map(String.init)
  guard parts.count >= 2 else { return nil }
  var mask: CGEventFlags = []
  for token in parts.dropLast() {
    switch token {
    case "ctrl", "control", "control_l", "control_r":
      mask.insert(.maskControl)
    case "opt", "option", "alt", "alt_l", "alt_r":
      mask.insert(.maskAlternate)
    case "cmd", "command", "super", "super_l", "super_r", "meta", "win":
      mask.insert(.maskCommand)
    case "shift", "shift_l", "shift_r":
      mask.insert(.maskShift)
    default:
      return nil
    }
  }
  guard !mask.isEmpty, let code = kKeyCodeByName[parts.last ?? ""] else {
    return nil
  }
  return ParsedHotkey(spec: raw, keyCode: code, requiredMask: mask)
}

private func isCGSessionScreenLocked() -> Bool {
  guard let dict = CGSessionCopyCurrentDictionary() as? [String: Any] else { return false }
  return (dict["CGSSessionScreenIsLocked"] as? Bool) ?? ((dict["CGSSessionScreenIsLocked"] as? NSNumber)?.boolValue ?? false)
}

final class TakeoverSensor {
  private let sensorQueue = DispatchQueue(label: "io.codexstyle.cua.desktophelper.sensor")
  private let stateLock = NSLock()
  private let syntheticTag: Int64
  private let onSensorEvent: (SensorEventPayload) -> Void
  private let onCapabilitiesChanged: (HelperCapabilities) -> Void

  private var tapThread: Thread?
  private var tapRunLoop: CFRunLoop?
  private var mouseTap: CFMachPort?
  private var keyTap: CFMachPort?
  private var mouseSource: CFRunLoopSource?
  private var keySource: CFRunLoopSource?
  private var workspaceObserver: NSObjectProtocol?
  private var lockObserver: NSObjectProtocol?
  private var unlockObserver: NSObjectProtocol?
  private var capabilityTimer: DispatchSourceTimer?

  private var mouseTapActive = false
  private var keyTapActive = false
  private var fallbackReason: String?
  private var sessionLocked = isCGSessionScreenLocked()
  private var hotkeyConfigValid = true
  private var parsedHotkey = parseEmergencyHotkeySpec("ctrl+opt+escape")!
  private var trustedAutomationPids: Set<Int32> = [ProcessInfo.processInfo.processIdentifier]
  private var lastEmittedCapabilities: HelperCapabilities?
  private var hotkeyLatched = false
  private var lastHumanSwitchGestureNs: UInt64 = 0
  private var started = false

  init(
    syntheticTag: Int64,
    emergencyHotkey: String? = nil,
    trustedPids: [Int32] = [],
    onSensorEvent: @escaping (SensorEventPayload) -> Void,
    onCapabilitiesChanged: @escaping (HelperCapabilities) -> Void
  ) {
    self.syntheticTag = syntheticTag
    if let parsed = parseEmergencyHotkeySpec(emergencyHotkey) {
      self.parsedHotkey = parsed
      self.hotkeyConfigValid = true
    } else if let emergencyHotkey, !emergencyHotkey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
      self.hotkeyConfigValid = false
    }
    for pid in trustedPids where pid > 0 {
      self.trustedAutomationPids.insert(pid)
    }
    self.onSensorEvent = onSensorEvent
    self.onCapabilitiesChanged = onCapabilitiesChanged
  }

  func setTrustedAutomationPids(_ pids: [Int32]) {
    var nextSet: Set<Int32> = [ProcessInfo.processInfo.processIdentifier]
    for p in pids where p > 0 {
      nextSet.insert(p)
    }
    stateLock.lock()
    trustedAutomationPids = nextSet
    stateLock.unlock()
  }

  @discardableResult
  func setEmergencyHotkey(_ rawSpec: String?) -> Bool {
    if let parsed = parseEmergencyHotkeySpec(rawSpec) {
      stateLock.lock()
      parsedHotkey = parsed
      hotkeyConfigValid = true
      stateLock.unlock()
      emitCapabilitiesIfChanged()
      return true
    }
    stateLock.lock()
    hotkeyConfigValid = false
    stateLock.unlock()
    emitCapabilitiesIfChanged()
    return false
  }

  func start() {
    guard !started else { return }
    started = true
    installWorkspaceObserver()
    installScreenLockObservers()
    startTapThread()
    startCapabilityMonitor()
  }

  func stop() {
    guard started else { return }
    started = false
    capabilityTimer?.cancel()
    capabilityTimer = nil
    if let obs = workspaceObserver {
      NSWorkspace.shared.notificationCenter.removeObserver(obs)
      workspaceObserver = nil
    }
    if let obs = lockObserver {
      DistributedNotificationCenter.default().removeObserver(obs)
      lockObserver = nil
    }
    if let obs = unlockObserver {
      DistributedNotificationCenter.default().removeObserver(obs)
      unlockObserver = nil
    }
    let rl = tapRunLoop
    if let rl {
      CFRunLoopPerformBlock(rl, CFRunLoopMode.defaultMode.rawValue) { [weak self] in
        self?.teardownTapsOnTapThread()
        CFRunLoopStop(rl)
      }
      CFRunLoopWakeUp(rl)
    }
  }

  func resetLatch() {
    sensorQueue.async { [weak self] in
      self?.hotkeyLatched = false
      self?.lastHumanSwitchGestureNs = 0
    }
  }

  func currentCapabilities() -> HelperCapabilities {
    let inputPreflight = CGPreflightListenEventAccess()
    let srPreflight = CGPreflightScreenCaptureAccess()
    let axTrusted = AXIsProcessTrusted()
    let secureInput = IsSecureEventInputEnabled()
    let cgLocked = isCGSessionScreenLocked()

    stateLock.lock()
    sessionLocked = cgLocked
    let locked = cgLocked
    let mTap = mouseTapActive
    let kTap = keyTapActive
    let rawFallback = fallbackReason
    let hkValid = hotkeyConfigValid
    let isStarted = started
    stateLock.unlock()

    let effMouse = !locked && mTap
    let effKey = !locked && !secureInput && kTap
    let effHotkey = effKey && hkValid

    let effectiveFallback: String?
    if locked {
      effectiveFallback = "session_locked"
    } else if secureInput && !effKey {
      effectiveFallback = rawFallback ?? "secure_input_active"
    } else if !hkValid {
      effectiveFallback = "invalid_hotkey_config"
    } else if let rawFallback {
      effectiveFallback = rawFallback
    } else if !effMouse && !effKey {
      effectiveFallback = inputPreflight
        ? (isStarted ? "tap_initializing" : "not_started")
        : "input_monitoring_not_granted"
    } else {
      effectiveFallback = nil
    }

    return HelperCapabilities(
      screenRecordingPreflight: srPreflight,
      inputMonitoringPreflight: inputPreflight,
      accessibilityTrusted: axTrusted,
      mouseTapActive: effMouse,
      keyTapActive: effKey,
      hotkeyActive: effHotkey,
      secureInputActive: secureInput,
      sessionLocked: locked,
      fallbackReason: effectiveFallback
    )
  }

  private func emitCapabilitiesIfChanged() {
    let caps = currentCapabilities()
    var changed = false
    stateLock.lock()
    if lastEmittedCapabilities != caps {
      lastEmittedCapabilities = caps
      changed = true
    }
    stateLock.unlock()
    if changed {
      onCapabilitiesChanged(caps)
    }
  }

  func refreshTaps() {
    guard let rl = tapRunLoop else { return }
    CFRunLoopPerformBlock(rl, CFRunLoopMode.defaultMode.rawValue) { [weak self] in
      self?.installTapsOnTapThread()
    }
    CFRunLoopWakeUp(rl)
  }

  private func installWorkspaceObserver() {
    workspaceObserver = NSWorkspace.shared.notificationCenter.addObserver(
      forName: NSWorkspace.didActivateApplicationNotification,
      object: nil,
      queue: nil
    ) { [weak self] note in
      guard let self else { return }
      let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
      let pid = app?.processIdentifier ?? 0
      let nowNs = DispatchTime.now().uptimeNanoseconds
      let token = WindowInventory.processToken(for: pid)
      self.sensorQueue.async {
        guard pid > 0 else { return }
        let dtNs = nowNs >= self.lastHumanSwitchGestureNs ? (nowNs - self.lastHumanSwitchGestureNs) : UInt64.max
        let caps = self.currentCapabilities()
        let hasSwitchGesture = (caps.mouseTapActive || caps.keyTapActive) && dtNs <= 900_000_000
        let focusedWid = WindowInventory.focusedWindowId(for: pid)
        let evt = SensorEventPayload(
          type: "app_activated",
          sourceClass: hasSwitchGesture ? "human" : "unknown",
          sourceTag: nil,
          sourcePid: nil,
          pid: pid,
          processToken: token,
          frontmostPid: pid,
          focusedWindowId: focusedWid,
          hasHumanSwitchGesture: hasSwitchGesture,
          isRepeat: nil,
          hit: nil,
          timestampNs: nowNs
        )
        self.onSensorEvent(evt)
      }
    }
  }

  private func installScreenLockObservers() {
    let center = DistributedNotificationCenter.default()
    lockObserver = center.addObserver(
      forName: NSNotification.Name("com.apple.screenIsLocked"),
      object: nil,
      queue: nil
    ) { [weak self] _ in
      guard let self else { return }
      self.stateLock.lock()
      self.sessionLocked = true
      self.stateLock.unlock()
      self.emitCapabilitiesIfChanged()
    }
    unlockObserver = center.addObserver(
      forName: NSNotification.Name("com.apple.screenIsUnlocked"),
      object: nil,
      queue: nil
    ) { [weak self] _ in
      guard let self else { return }
      self.stateLock.lock()
      self.sessionLocked = false
      self.stateLock.unlock()
      self.refreshTaps()
      self.emitCapabilitiesIfChanged()
      self.sensorQueue.asyncAfter(deadline: .now() + 0.20) { [weak self] in
        self?.emitCapabilitiesIfChanged()
      }
    }
  }

  private func startCapabilityMonitor() {
    let timer = DispatchSource.makeTimerSource(queue: sensorQueue)
    timer.schedule(deadline: .now() + 2.0, repeating: 2.0)
    timer.setEventHandler { [weak self] in
      self?.emitCapabilitiesIfChanged()
    }
    timer.resume()
    capabilityTimer = timer
  }

  private func startTapThread() {
    let readySem = DispatchSemaphore(value: 0)
    let thread = Thread { [weak self] in
      guard let self else {
        readySem.signal()
        return
      }
      self.tapRunLoop = CFRunLoopGetCurrent()
      self.installTapsOnTapThread()
      readySem.signal()
      CFRunLoopRun()
    }
    thread.name = "io.codexstyle.cua.desktophelper.eventtap"
    thread.start()
    self.tapThread = thread
    _ = readySem.wait(timeout: .now() + 2.0)
  }

  private func teardownTapsOnTapThread() {
    if let rl = CFRunLoopGetCurrent() {
      if let s = mouseSource { CFRunLoopRemoveSource(rl, s, .commonModes) }
      if let s = keySource { CFRunLoopRemoveSource(rl, s, .commonModes) }
    }
    if let mt = mouseTap { CGEvent.tapEnable(tap: mt, enable: false) }
    if let kt = keyTap { CGEvent.tapEnable(tap: kt, enable: false) }
    mouseSource = nil
    keySource = nil
    mouseTap = nil
    keyTap = nil
    stateLock.lock()
    mouseTapActive = false
    keyTapActive = false
    stateLock.unlock()
  }

  private func installTapsOnTapThread() {
    teardownTapsOnTapThread()
    guard let rl = CFRunLoopGetCurrent() else { return }
    let selfPtr = Unmanaged.passUnretained(self).toOpaque()

    var nextMouseActive = false
    var nextKeyActive = false

    let mouseMask: CGEventMask =
      (1 << CGEventType.leftMouseDown.rawValue) |
      (1 << CGEventType.rightMouseDown.rawValue) |
      (1 << CGEventType.otherMouseDown.rawValue)

    if let mTap = CGEvent.tapCreate(
      tap: .cgSessionEventTap,
      place: .headInsertEventTap,
      options: .listenOnly,
      eventsOfInterest: mouseMask,
      callback: { proxy, type, event, userInfo in
        guard let userInfo else { return Unmanaged.passUnretained(event) }
        let sensor = Unmanaged<TakeoverSensor>.fromOpaque(userInfo).takeUnretainedValue()
        return sensor.handleTapCallback(proxy: proxy, type: type, event: event, isMouseTap: true)
      },
      userInfo: selfPtr
    ) {
      let src = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, mTap, 0)
      CFRunLoopAddSource(rl, src, .commonModes)
      CGEvent.tapEnable(tap: mTap, enable: true)
      self.mouseTap = mTap
      self.mouseSource = src
      nextMouseActive = CGEvent.tapIsEnabled(tap: mTap)
    }

    let keyMask: CGEventMask =
      (1 << CGEventType.keyDown.rawValue) |
      (1 << CGEventType.keyUp.rawValue) |
      (1 << CGEventType.flagsChanged.rawValue)

    if let kTap = CGEvent.tapCreate(
      tap: .cgSessionEventTap,
      place: .headInsertEventTap,
      options: .listenOnly,
      eventsOfInterest: keyMask,
      callback: { proxy, type, event, userInfo in
        guard let userInfo else { return Unmanaged.passUnretained(event) }
        let sensor = Unmanaged<TakeoverSensor>.fromOpaque(userInfo).takeUnretainedValue()
        return sensor.handleTapCallback(proxy: proxy, type: type, event: event, isMouseTap: false)
      },
      userInfo: selfPtr
    ) {
      let src = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, kTap, 0)
      CFRunLoopAddSource(rl, src, .commonModes)
      CGEvent.tapEnable(tap: kTap, enable: true)
      self.keyTap = kTap
      self.keySource = src
      nextKeyActive = CGEvent.tapIsEnabled(tap: kTap)
    }

    let nextReason: String?
    if !nextMouseActive && !nextKeyActive {
      nextReason = CGPreflightListenEventAccess()
        ? "cg_session_tap_create_failed"
        : "input_monitoring_not_granted"
    } else if !nextKeyActive {
      nextReason = "key_tap_unavailable"
    } else {
      nextReason = nil
    }
    stateLock.lock()
    mouseTapActive = nextMouseActive
    keyTapActive = nextKeyActive
    fallbackReason = nextReason
    stateLock.unlock()
    emitCapabilitiesIfChanged()
  }

  private func handleTapCallback(
    proxy: CGEventTapProxy,
    type: CGEventType,
    event: CGEvent,
    isMouseTap: Bool
  ) -> Unmanaged<CGEvent>? {
    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
      let tap = isMouseTap ? mouseTap : keyTap
      if let tap {
        CGEvent.tapEnable(tap: tap, enable: true)
        let stillEnabled = CGEvent.tapIsEnabled(tap: tap)
        if !stillEnabled {
          stateLock.lock()
          if isMouseTap { mouseTapActive = false } else { keyTapActive = false }
          fallbackReason = type == .tapDisabledByUserInput ? "tap_disabled_by_user" : "tap_disabled_by_timeout"
          stateLock.unlock()
          emitCapabilitiesIfChanged()
        }
      }
      return Unmanaged.passUnretained(event)
    }

    let userData = event.getIntegerValueField(.eventSourceUserData)
    if syntheticTag != 0 && userData == syntheticTag {
      return Unmanaged.passUnretained(event)
    }

    let kind: RawTapEventKind
    switch type {
    case .leftMouseDown, .rightMouseDown, .otherMouseDown:
      kind = .mouseDown
    case .keyDown:
      kind = .keyDown
    case .keyUp:
      kind = .keyUp
    case .flagsChanged:
      kind = .flagsChanged
    default:
      return Unmanaged.passUnretained(event)
    }

    let rawSourcePid = event.getIntegerValueField(.eventSourceUnixProcessID)
    let sourcePid: Int32 = rawSourcePid > 0 ? Int32(clamping: rawSourcePid) : 0

    // Never extract typed character strings from keyboard events; inspect keyCode/flags only.
    let raw = RawTapEvent(
      kind: kind,
      locationPt: event.location,
      keyCode: (kind == .keyDown || kind == .keyUp) ? event.getIntegerValueField(.keyboardEventKeycode) : -1,
      isRepeat: (kind == .keyDown) ? (event.getIntegerValueField(.keyboardEventAutorepeat) != 0) : false,
      flags: event.flags,
      sourceUserData: userData,
      sourcePid: sourcePid,
      timestampNs: DispatchTime.now().uptimeNanoseconds
    )
    sensorQueue.async { [weak self] in
      self?.processRawTapEvent(raw)
    }
    return Unmanaged.passUnretained(event)
  }

  private func processRawTapEvent(_ raw: RawTapEvent) {
    if syntheticTag != 0 && raw.sourceUserData == syntheticTag {
      return
    }

    let caps = currentCapabilities()
    if caps.sessionLocked {
      hotkeyLatched = false
      return
    }

    stateLock.lock()
    let hotkey = parsedHotkey
    let hotkeyValid = hotkeyConfigValid
    let isTrustedSource = raw.sourcePid > 0 && trustedAutomationPids.contains(raw.sourcePid)
    stateLock.unlock()

    switch raw.kind {
    case .flagsChanged:
      if !raw.flags.contains(hotkey.requiredMask) {
        hotkeyLatched = false
      }
    case .keyUp:
      if raw.keyCode == hotkey.keyCode || !raw.flags.contains(hotkey.requiredMask) {
        hotkeyLatched = false
      }
    case .keyDown:
      let modsExact = caps.hotkeyActive && hotkeyValid && raw.flags.intersection(kRelevantModifierMask) == hotkey.requiredMask
      if caps.hotkeyActive && hotkeyValid && raw.keyCode == hotkey.keyCode && modsExact {
        let shouldFire = !raw.isRepeat && !hotkeyLatched
        hotkeyLatched = true
        if shouldFire {
          onSensorEvent(
            SensorEventPayload(
              type: "emergency_hotkey",
              sourceClass: "human",
              sourceTag: raw.sourceUserData,
              sourcePid: raw.sourcePid > 0 ? raw.sourcePid : nil,
              pid: nil,
              processToken: nil,
              frontmostPid: nil,
              focusedWindowId: nil,
              hasHumanSwitchGesture: nil,
              isRepeat: false,
              hit: nil,
              timestampNs: raw.timestampNs
            )
          )
        }
        return
      }
      if !caps.keyTapActive {
        return
      }
      if isTrustedSource {
        return
      }
      if raw.keyCode == kKeyCodeTab && raw.flags.contains(.maskCommand) {
        lastHumanSwitchGestureNs = raw.timestampNs
        return
      }
      let front = WindowInventory.frontmostAppInfo()
      onSensorEvent(
        SensorEventPayload(
          type: "key_down",
          sourceClass: "human",
          sourceTag: raw.sourceUserData,
          sourcePid: raw.sourcePid > 0 ? raw.sourcePid : nil,
          pid: front?.pid,
          processToken: front?.processToken,
          frontmostPid: front?.pid,
          focusedWindowId: front?.focusedWindowId,
          hasHumanSwitchGesture: nil,
          isRepeat: raw.isRepeat,
          hit: nil,
          timestampNs: raw.timestampNs
        )
      )
    case .mouseDown:
      if !caps.mouseTapActive {
        return
      }
      if isTrustedSource {
        return
      }
      let hit = WindowInventory.hitTest(pointPt: raw.locationPt)
      if hit.ownerName == "Dock" {
        lastHumanSwitchGestureNs = raw.timestampNs
      }
      onSensorEvent(
        SensorEventPayload(
          type: "mouse_down",
          sourceClass: "human",
          sourceTag: raw.sourceUserData,
          sourcePid: raw.sourcePid > 0 ? raw.sourcePid : nil,
          pid: hit.pid,
          processToken: hit.processToken,
          frontmostPid: nil,
          focusedWindowId: nil,
          hasHumanSwitchGesture: nil,
          isRepeat: nil,
          hit: hit,
          timestampNs: raw.timestampNs
        )
      )
    }
  }
}
