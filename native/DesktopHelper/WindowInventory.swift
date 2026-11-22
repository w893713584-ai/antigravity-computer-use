import AppKit
import ApplicationServices
import CoreGraphics
import Darwin
import Foundation

typealias AXUIElementGetWindowFn = @convention(c) (AXUIElement, UnsafeMutablePointer<CGWindowID>) -> AXError

private let axGetWindowSymbol: AXUIElementGetWindowFn? = {
  guard let sym = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "_AXUIElementGetWindow") else {
    return nil
  }
  return unsafeBitCast(sym, to: AXUIElementGetWindowFn.self)
}()

struct WindowRectPt: Codable {
  let x: Double
  let y: Double
  let width: Double
  let height: Double
}

struct WindowSummary: Codable {
  let pid: Int32
  let processToken: String?
  let windowId: Int64
  let layer: Int
  let ownerName: String
  let bundleId: String?
  let title: String
  let alpha: Double
  let onScreen: Bool
  let boundsPt: WindowRectPt
}

struct HitTestResult: Codable {
  let state: String // "hit" | "miss" | "unknown"
  let reason: String?
  let pid: Int32?
  let processToken: String?
  let windowId: Int64?
  let layer: Int?
  let ownerName: String?
  let title: String?
  let boundsPt: WindowRectPt?
  let occludedByOther: Bool
  let confirmedModalParentWindowId: Int64?
}

struct FrontmostInfo: Codable {
  let pid: Int32
  let bundleId: String?
  let displayName: String?
  let processToken: String?
  let focusedWindowId: Int64?
}

enum WindowInventory {
  static func processToken(for pid: Int32) -> String? {
    guard pid > 0 else { return nil }
    var info = proc_bsdinfo()
    let size = Int32(MemoryLayout<proc_bsdinfo>.stride)
    let ret = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, size)
    if ret == size {
      let sec = info.pbi_start_tvsec
      if sec > 0 {
        return "\(pid):\(sec).000000"
      }
    }
    if let app = NSRunningApplication(processIdentifier: pid), let launch = app.launchDate {
      return "\(pid):\(Int64(launch.timeIntervalSince1970)).000000"
    }
    return nil
  }

  static func rawOnScreenWindows() -> [[String: Any]]? {
    let opts: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
    return CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]]
  }

  static func rawAllWindows() -> [[String: Any]]? {
    let opts: CGWindowListOption = [.optionAll, .excludeDesktopElements]
    return CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]]
  }

  private static func entries(_ raw: [[String: Any]], containPid pid: Int32, windowId: Int64) -> Bool {
    guard pid > 0, windowId > 0 else { return false }
    for entry in raw {
      guard let entryPid = (entry[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value,
            let entryWid = (entry[kCGWindowNumber as String] as? NSNumber)?.int64Value else {
        continue
      }
      if entryPid == pid && entryWid == windowId {
        return true
      }
    }
    return false
  }

  static func windowExists(pid: Int32, windowId: Int64) -> Bool? {
    guard let raw = rawAllWindows() else { return nil }
    return entries(raw, containPid: pid, windowId: windowId)
  }

  static func isWindowOnScreen(pid: Int32, windowId: Int64) -> Bool? {
    guard let raw = rawOnScreenWindows() else { return nil }
    return entries(raw, containPid: pid, windowId: windowId)
  }

  static func parseBounds(_ dict: Any?) -> WindowRectPt? {
    guard let cfDict = dict as? NSDictionary else { return nil }
    var rect = CGRect.zero
    guard CGRectMakeWithDictionaryRepresentation(cfDict, &rect) else { return nil }
    return WindowRectPt(
      x: Double(rect.origin.x),
      y: Double(rect.origin.y),
      width: Double(rect.size.width),
      height: Double(rect.size.height)
    )
  }

  static func listWindows(filterPid: Int32? = nil) -> [WindowSummary] {
    let raw = rawOnScreenWindows() ?? []
    var bundleByPid: [Int32: String] = [:]
    var tokenByPid: [Int32: String] = [:]
    var out: [WindowSummary] = []
    for entry in raw {
      guard let pidNum = entry[kCGWindowOwnerPID as String] as? NSNumber,
            let widNum = entry[kCGWindowNumber as String] as? NSNumber,
            let bounds = parseBounds(entry[kCGWindowBounds as String]) else {
        continue
      }
      let pid = pidNum.int32Value
      if let filterPid, pid != filterPid { continue }
      if bounds.width < 1 || bounds.height < 1 { continue }
      let layer = (entry[kCGWindowLayer as String] as? NSNumber)?.intValue ?? 0
      let alpha = (entry[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1.0
      if alpha <= 0.01 { continue }
      let ownerName = (entry[kCGWindowOwnerName as String] as? String) ?? ""
      let title = (entry[kCGWindowName as String] as? String) ?? ""
      let onScreen = (entry[kCGWindowIsOnscreen as String] as? NSNumber)?.boolValue ?? true
      let bundleId: String?
      if let cached = bundleByPid[pid] {
        bundleId = cached.isEmpty ? nil : cached
      } else {
        let bid = NSRunningApplication(processIdentifier: pid)?.bundleIdentifier ?? ""
        bundleByPid[pid] = bid
        bundleId = bid.isEmpty ? nil : bid
      }
      let procToken: String?
      if let cachedTok = tokenByPid[pid] {
        procToken = cachedTok.isEmpty ? nil : cachedTok
      } else {
        let tok = processToken(for: pid) ?? ""
        tokenByPid[pid] = tok
        procToken = tok.isEmpty ? nil : tok
      }
      out.append(
        WindowSummary(
          pid: pid,
          processToken: procToken,
          windowId: widNum.int64Value,
          layer: layer,
          ownerName: ownerName,
          bundleId: bundleId,
          title: title,
          alpha: alpha,
          onScreen: onScreen,
          boundsPt: bounds
        )
      )
    }
    return out
  }

  /// Front-to-back Quartz hit test WITHOUT pre-filtering non-target layers.
  /// If an overlay, menu, dialog, or other application is above `targetPid`/`targetWindowId`,
  /// the click belongs to that front window (or returns "unknown" on ambiguous transparent overlays).
  static func hitTest(pointPt: CGPoint) -> HitTestResult {
    let raw = rawOnScreenWindows() ?? []
    if raw.isEmpty {
      return HitTestResult(
        state: "unknown",
        reason: "window_list_empty",
        pid: nil,
        processToken: nil,
        windowId: nil,
        layer: nil,
        ownerName: nil,
        title: nil,
        boundsPt: nil,
        occludedByOther: false,
        confirmedModalParentWindowId: nil
      )
    }

    for entry in raw {
      guard let bounds = parseBounds(entry[kCGWindowBounds as String]) else { continue }
      if bounds.width < 1 || bounds.height < 1 { continue }
      let layer = (entry[kCGWindowLayer as String] as? NSNumber)?.intValue ?? 0
      // Skip below-desktop background layers; keep all normal, floating, modal, menu, popup, overlay layers.
      if layer < 0 { continue }

      let ownerName = (entry[kCGWindowOwnerName as String] as? String) ?? ""
      // WindowServer system cursor / screenshot guard windows should not steal geometry hit-tests if transparent.
      let alpha = (entry[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1.0
      let rect = CGRect(x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height)
      if !rect.contains(pointPt) { continue }

      if ownerName == "Window Server" && alpha < 0.05 {
        continue
      }
      // Ambiguous low-alpha overlay: return "unknown" so caller fails safe instead of misattributing behind it.
      if alpha < 0.15 {
        return HitTestResult(
          state: "unknown",
          reason: "transparent_overlay",
          pid: nil,
          processToken: nil,
          windowId: nil,
          layer: layer,
          ownerName: ownerName,
          title: nil,
          boundsPt: bounds,
          occludedByOther: false,
          confirmedModalParentWindowId: nil
        )
      }

      guard let pidNum = entry[kCGWindowOwnerPID as String] as? NSNumber,
            let widNum = entry[kCGWindowNumber as String] as? NSNumber else {
        return HitTestResult(
          state: "unknown",
          reason: "incomplete_window_entry",
          pid: nil,
          processToken: nil,
          windowId: nil,
          layer: layer,
          ownerName: ownerName,
          title: nil,
          boundsPt: bounds,
          occludedByOther: false,
          confirmedModalParentWindowId: nil
        )
      }

      let pid = pidNum.int32Value
      let wid = widNum.int64Value
      let title = (entry[kCGWindowName as String] as? String) ?? ""
      let modalParentWid = resolveConfirmedModalParentWindowId(pid: pid, windowId: wid)
      return HitTestResult(
        state: "hit",
        reason: nil,
        pid: pid,
        processToken: processToken(for: pid),
        windowId: wid,
        layer: layer,
        ownerName: ownerName,
        title: title,
        boundsPt: bounds,
        occludedByOther: false,
        confirmedModalParentWindowId: modalParentWid
      )
    }

    return HitTestResult(
      state: "miss",
      reason: "no_window_at_point",
      pid: nil,
      processToken: nil,
      windowId: nil,
      layer: nil,
      ownerName: nil,
      title: nil,
      boundsPt: nil,
      occludedByOther: false,
      confirmedModalParentWindowId: nil
    )
  }

  static func resolveConfirmedModalParentWindowId(pid: Int32, windowId: Int64) -> Int64? {
    guard pid > 0, windowId > 0, AXIsProcessTrusted(), let getWin = axGetWindowSymbol else {
      return nil
    }
    let appEl = AXUIElementCreateApplication(pid)
    var winsVal: AnyObject?
    guard AXUIElementCopyAttributeValue(appEl, kAXWindowsAttribute as CFString, &winsVal) == .success,
          let winArr = winsVal as? [AnyObject] else {
      return nil
    }

    var targetEl: AXUIElement?
    for item in winArr.prefix(24) {
      let winEl = unsafeBitCast(item, to: AXUIElement.self)
      var w: CGWindowID = 0
      if getWin(winEl, &w) == .success && Int64(w) == windowId {
        targetEl = winEl
        break
      }
    }
    guard let winEl = targetEl else { return nil }

    var subroleVal: AnyObject?
    _ = AXUIElementCopyAttributeValue(winEl, kAXSubroleAttribute as CFString, &subroleVal)
    let subrole = (subroleVal as? String) ?? ""

    var modalVal: AnyObject?
    _ = AXUIElementCopyAttributeValue(winEl, kAXModalAttribute as CFString, &modalVal)
    let isModal = (modalVal as? NSNumber)?.boolValue == true

    guard isModal || subrole == "AXSheet" || subrole == "AXDialog" || subrole == "AXSystemDialog" else {
      return nil
    }

    var parentVal: AnyObject?
    guard AXUIElementCopyAttributeValue(winEl, kAXParentAttribute as CFString, &parentVal) == .success,
          let parentObj = parentVal else {
      return nil
    }
    let parentEl = unsafeBitCast(parentObj, to: AXUIElement.self)
    var parentWid: CGWindowID = 0
    if getWin(parentEl, &parentWid) == .success && parentWid > 0 && Int64(parentWid) != windowId {
      return Int64(parentWid)
    }
    return nil
  }

  static func focusedWindowId(for pid: Int32) -> Int64? {
    guard pid > 0, AXIsProcessTrusted(), let getWin = axGetWindowSymbol else {
      return nil
    }
    let appEl = AXUIElementCreateApplication(pid)
    var val: AnyObject?
    let err = AXUIElementCopyAttributeValue(appEl, kAXFocusedWindowAttribute as CFString, &val)
    guard err == .success, let cfObj = val else { return nil }
    let winEl = unsafeBitCast(cfObj, to: AXUIElement.self)
    var wid: CGWindowID = 0
    if getWin(winEl, &wid) == .success && wid > 0 {
      return Int64(wid)
    }
    return nil
  }

  static func allWindowIds(for pid: Int32) -> [Int64] {
    guard pid > 0, let raw = rawAllWindows() else { return [] }
    var ids: [Int64] = []
    for entry in raw {
      guard let entryPid = (entry[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value,
            entryPid == pid,
            let widNum = entry[kCGWindowNumber as String] as? NSNumber else {
        continue
      }
      let layer = (entry[kCGWindowLayer as String] as? NSNumber)?.intValue ?? 0
      let alpha = (entry[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1.0
      if layer != 0 || alpha <= 0.01 { continue }
      if let b = parseBounds(entry[kCGWindowBounds as String]), b.width >= 120, b.height >= 80 {
        ids.append(widNum.int64Value)
      }
    }
    return ids
  }

  static func focusedWindowInfo(for pid: Int32) -> [String: Any] {
    let allIds = allWindowIds(for: pid)
    guard pid > 0, let wid = focusedWindowId(for: pid) else {
      return [
        "wid": NSNull(),
        "title": NSNull(),
        "windowBounds": NSNull(),
        "windowIds": allIds,
      ]
    }
    var title: String?
    var boundsDict: [String: Double]?
    if let raw = rawAllWindows() {
      for entry in raw {
        guard let entryPid = (entry[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value,
              entryPid == pid,
              let widNum = entry[kCGWindowNumber as String] as? NSNumber,
              widNum.int64Value == wid else {
          continue
        }
        let rawTitle = (entry[kCGWindowName as String] as? String) ?? ""
        title = rawTitle.isEmpty ? nil : rawTitle
        if let b = parseBounds(entry[kCGWindowBounds as String]), b.width > 0, b.height > 0 {
          boundsDict = ["x": b.x, "y": b.y, "w": b.width, "h": b.height]
        }
        break
      }
    }
    return [
      "wid": wid,
      "title": title ?? NSNull(),
      "windowBounds": boundsDict ?? NSNull(),
      "windowIds": allIds,
    ]
  }

  static func frontmostAppInfo() -> FrontmostInfo? {
    guard let app = NSWorkspace.shared.frontmostApplication else { return nil }
    let pid = app.processIdentifier
    return FrontmostInfo(
      pid: pid,
      bundleId: app.bundleIdentifier,
      displayName: app.localizedName,
      processToken: processToken(for: pid),
      focusedWindowId: focusedWindowId(for: pid)
    )
  }
}
