import { execFile, spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { promisify } from "node:util";
import { MAX_LINE_BUFFER_BYTES } from "./constants.mjs";

const execFileAsync = promisify(execFile);
const DEFAULT_CALL_TIMEOUT_MS = 2500;

export function throwIfSentUnknown(res, label = "AX bridge write") {
  if (res?.deliveryState === "sent_unknown") {
    const err = new Error(`${label} (${res.reason || "sent_unknown"})`);
    err.code = "WRITE_OUTCOME_UNKNOWN";
    err.deliveryState = "sent_unknown";
    err.dispatched = true;
    throw err;
  }
  return res;
}

/**
 * Persistent warm JXA (`osascript -l JavaScript`) bridge to macOS ApplicationServices / AppKit / CoreGraphics.
 *
 * Eliminates ~60-90ms per-call subprocess spawn overhead (warm roundtrip ~0.25ms),
 * wakes lazy Chromium/Electron AX trees (`AXManualAccessibility`),
 * and retains live `AXUIElementRef` handles in memory across snapshots (`s1..sN`) so
 * background asynchronous DOM/view destruction, text mutation, modal sheets, and layout shifts
 * are caught BEFORE dispatching clicks (`STALE_REF`).
 */
export const BRIDGE_JXA_SOURCE = String.raw`
// codex-style-computer-use-ax-bridge
ObjC.import("CoreFoundation");
ObjC.import("Foundation");
ObjC.import("ApplicationServices");
ObjC.import("AppKit");
ObjC.import("CoreGraphics");

ObjC.bindFunction("CFRelease", ["void", ["void*"]]);
ObjC.bindFunction("CFCopyDescription", ["id", ["void*"]]);
ObjC.bindFunction("CFRunLoopRunInMode", ["int", ["void*", "double", "bool"]]);
try {
  ObjC.bindFunction("CFGetTypeID", ["unsigned long", ["void*"]]);
  ObjC.bindFunction("CFArrayGetCount", ["long", ["void*"]]);
  ObjC.bindFunction("CFArrayGetValueAtIndex", ["void*", ["void*", "long"]]);
} catch (e) {}
var hasUnicodeKeyboardFn = false;
try {
  ObjC.bindFunction("CGEventKeyboardSetUnicodeString", ["void", ["void*", "uint64_t", "void*"]]);
  hasUnicodeKeyboardFn = true;
} catch (e) {}
var hasSkyLightWindowPost = false;
try {
  $.NSBundle.bundleWithPath($("/System/Library/PrivateFrameworks/SkyLight.framework")).load;
  ObjC.bindFunction("CGEventSetWindowLocation", ["void", ["void*", "double", "double"]]);
  ObjC.bindFunction("SLEventPostToPid", ["void", ["int", "void*"]]);
  ObjC.bindFunction("SLEventSetIntegerValueField", ["void", ["void*", "uint32_t", "int64_t"]]);
  hasSkyLightWindowPost = true;
} catch (e) {}
var windowEventSeq = 1000;
var SYNTHETIC_EVENT_TAG = 0;
var USER_DATA_FIELD = typeof $.kCGEventSourceUserData === "number" ? $.kCGEventSourceUserData : 42;
function stampSyntheticUserData(ev, explicitTag) {
  var tag = explicitTag !== undefined && explicitTag !== null && Number(explicitTag) !== 0
    ? Number(explicitTag)
    : SYNTHETIC_EVENT_TAG;
  if (tag && ev) {
    try {
      $.CGEventSetIntegerValueField(ev, USER_DATA_FIELD, tag);
    } catch (e) {}
  }
}
var hasScreenCapturePreflight = false;
try {
  ObjC.bindFunction("CGPreflightScreenCaptureAccess", ["bool", []]);
  hasScreenCapturePreflight = true;
} catch (e) {}
var hasScrollWheel2Fn = typeof $.CGEventCreateScrollWheelEvent2 === "function";
var hasSetLocationFn = typeof $.CGEventSetLocation === "function";
var BATCH_ATTRS = null;
var BATCH_ATTR_KEYS = ["AXRole", "AXRoleDescription", "AXIdentifier", "AXDOMIdentifier", "AXTitle", "AXDescription", "AXHelp"];
var CF_STRING_TYPE_ID = -1;
try {
  if (typeof $.CFStringGetTypeID === "function" && typeof $.CFArrayGetCount === "function") {
    CF_STRING_TYPE_ID = Number($.CFStringGetTypeID());
  }
} catch (e) {}
try {
  if ($.NSMutableArray && $.NSMutableArray.array && typeof $.CFArrayCreateCopy === "function") {
    var _attrNs = $.NSMutableArray.array;
    for (var _bi = 0; _bi < BATCH_ATTR_KEYS.length; _bi++) {
      _attrNs.addObject($(BATCH_ATTR_KEYS[_bi]));
    }
    BATCH_ATTRS = $.CFArrayCreateCopy(null, _attrNs);
  } else {
    var _tmpAttrs = [];
    for (var _bi2 = 0; _bi2 < BATCH_ATTR_KEYS.length; _bi2++) {
      _tmpAttrs.push($(BATCH_ATTR_KEYS[_bi2]));
    }
    BATCH_ATTRS = $.NSArray.arrayWithArray(_tmpAttrs);
  }
} catch (e) {}

// Apply process-wide AX messaging timeout so child AXUIElementRefs never block for 6s
try {
  var sysWide = $.AXUIElementCreateSystemWide();
  $.AXUIElementSetMessagingTimeout(sysWide, 0.75);
} catch (e) {}

var MAX_RETAINED_SNAPSHOTS = 20;
var MAX_STDIN_BUFFER_CHARS = 4 * 1024 * 1024;
var EDITABLE_ROLES = {
  AXTextField: true,
  AXTextArea: true,
  AXSearchField: true,
  AXComboBox: true,
  AXSecureTextField: true
};
var SAFE_INSERT_ROLES = ["AXTextField", "AXTextArea", "AXSearchField", "AXComboBox"];

var retainedOrder = [];
var retainedSnapshots = {};

function pumpRunLoop() {
  try {
    $.CFRunLoopRunInMode($.kCFRunLoopDefaultMode, 0.0, true);
  } catch (e) {}
}

function castOutRefAndRelease(outRef) {
  if (!outRef) return null;
  var obj = ObjC.castRefToObject(outRef);
  try {
    $.CFRelease(outRef);
  } catch (e) {}
  return obj;
}

function readAttrWithCode(el, name) {
  var out = Ref();
  var code = Number($.AXUIElementCopyAttributeValue(el, $(name), out));
  if (code !== 0 || !out[0]) {
    return { code: code, val: null };
  }
  return { code: 0, val: castOutRefAndRelease(out[0]) };
}

function readAttr(el, name) {
  return readAttrWithCode(el, name).val;
}

function readStr(el, name) {
  var obj = readAttr(el, name);
  if (!obj) return "";
  try {
    var raw = ObjC.unwrap(obj);
    return raw === undefined || raw === null ? "" : String(raw);
  } catch (e) {
    return "";
  }
}

function readBool(el, name) {
  var obj = readAttr(el, name);
  if (!obj) return null;
  try {
    return Boolean(ObjC.unwrap(obj));
  } catch (e) {
    return null;
  }
}

function readBounds(el) {
  var posOut = Ref();
  var sizeOut = Ref();
  var pOk = Number($.AXUIElementCopyAttributeValue(el, $("AXPosition"), posOut)) === 0 && Boolean(posOut[0]);
  if (!pOk) return null;
  var sOk = Number($.AXUIElementCopyAttributeValue(el, $("AXSize"), sizeOut)) === 0 && Boolean(sizeOut[0]);
  try {
    if (!sOk) return null;
    var posDesc = String(ObjC.unwrap($.CFCopyDescription(posOut[0])) || "");
    var sizeDesc = String(ObjC.unwrap($.CFCopyDescription(sizeOut[0])) || "");
    var xm = /x:\s*(-?\d+(?:\.\d+)?)/.exec(posDesc);
    var ym = /y:\s*(-?\d+(?:\.\d+)?)/.exec(posDesc);
    var wm = /w:\s*(-?\d+(?:\.\d+)?)/.exec(sizeDesc);
    var hm = /h:\s*(-?\d+(?:\.\d+)?)/.exec(sizeDesc);
    if (!xm || !ym || !wm || !hm) return null;
    return {
      x: Number(xm[1]),
      y: Number(ym[1]),
      w: Number(wm[1]),
      h: Number(hm[1])
    };
  } catch (e) {
    return null;
  } finally {
    if (pOk && posOut[0]) {
      try { $.CFRelease(posOut[0]); } catch (e1) {}
    }
    if (sOk && sizeOut[0]) {
      try { $.CFRelease(sizeOut[0]); } catch (e2) {}
    }
  }
}

function getActionNames(el) {
  var out = Ref();
  if (Number($.AXUIElementCopyActionNames(el, out)) !== 0 || !out[0]) return [];
  var nsArr = castOutRefAndRelease(out[0]);
  var len = nsArr && nsArr.count ? Number(nsArr.count) : 0;
  var res = [];
  for (var i = 0; i < len; i++) {
    res.push(String(ObjC.unwrap(nsArr.objectAtIndex(i)) || ""));
  }
  return res;
}

function createAppElement(pid, timeoutSec) {
  var appEl = $.AXUIElementCreateApplication(pid);
  try {
    $.AXUIElementSetMessagingTimeout(appEl, timeoutSec || 0.75);
  } catch (e) {}
  return appEl;
}

function selectTargetWindow(appEl, preferredTitle) {
  var preferredWin = readAttr(appEl, "AXFocusedWindow") || readAttr(appEl, "AXMainWindow");
  if (preferredWin && (!preferredTitle || readStr(preferredWin, "AXTitle") === preferredTitle)) {
    return preferredWin;
  }
  var wins = readAttr(appEl, "AXWindows");
  var count = wins && wins.count ? Number(wins.count) : 0;
  if (preferredTitle) {
    for (var i = 0; i < count; i++) {
      var candidate = wins.objectAtIndex(i);
      if (readStr(candidate, "AXTitle") === preferredTitle) {
        return candidate;
      }
    }
  }
  if (preferredWin) return preferredWin;
  var mainWin = readAttr(appEl, "AXMainWindow") || readAttr(appEl, "AXFocusedWindow");
  if (mainWin) return mainWin;
  if (count > 0) {
    var best = wins.objectAtIndex(0);
    var bestArea = 0;
    for (var j = 0; j < count; j++) {
      var w = wins.objectAtIndex(j);
      var b = readBounds(w);
      var area = b ? b.w * b.h : 0;
      if (area > bestArea) {
        bestArea = area;
        best = w;
      }
    }
    return best;
  }
  return null;
}

function detectWindowModalState(appEl, winEl) {
  if (!winEl) return false;
  var sheets = readAttr(winEl, "AXSheets");
  if (sheets && sheets.count && Number(sheets.count) > 0) return true;
  var subrole = readStr(winEl, "AXSubrole");
  if (subrole === "AXDialog" || subrole === "AXSystemDialog") return true;
  var focusedWin = readAttr(appEl, "AXFocusedWindow");
  if (focusedWin) {
    var fRole = readStr(focusedWin, "AXSubrole");
    var fModal = readBool(focusedWin, "AXModal");
    if (fModal === true || fRole === "AXDialog" || fRole === "AXSystemDialog") {
      return true;
    }
  }
  return false;
}

function walkWindowPreorder(winEl, maxNodes, budgetSec) {
  var nodes = [];
  var incomplete = false;
  if (!winEl) return { nodes: nodes, incomplete: false };
  var nodeCap = Number(maxNodes) > 0 ? Number(maxNodes) : 1000;
  var deadlineSec = Number(budgetSec) > 0 ? Number(budgetSec) : 1.2;
  var startUptime = Number($.NSProcessInfo.processInfo.systemUptime || 0);
  var hasBatchApi = Boolean(BATCH_ATTRS && typeof $.AXUIElementCopyMultipleAttributeValues === "function");

  function safeExtractStr(val) {
    if (!val) return "";
    try {
      if (typeof val.isNil === "function" && val.isNil()) return "";
      if (typeof val.isKindOfClass === "function") {
        var nsStrCls = $.NSString && $.NSString.class ? $.NSString.class : $.NSString;
        if (!nsStrCls || !Boolean(val.isKindOfClass(nsStrCls))) return "";
      } else if (typeof val !== "string" && val.__val === undefined) {
        return "";
      }
      var s = ObjC.unwrap(val);
      return s === undefined || s === null ? "" : String(s);
    } catch (e) {
      return "";
    }
  }

  function readNodeAttrs(el) {
    if (hasBatchApi) {
      var batchOut = Ref();
      var err = Number($.AXUIElementCopyMultipleAttributeValues(el, BATCH_ATTRS, 0, batchOut));
      if (err === 0 && batchOut[0]) {
        var vals = ["", "", "", "", "", "", ""];
        if (typeof $.CFArrayGetCount === "function" && CF_STRING_TYPE_ID >= 0) {
          var cfRes = batchOut[0];
          var cnt = Math.min(7, Number($.CFArrayGetCount(cfRes)));
          for (var bi = 0; bi < cnt; bi++) {
            var p = $.CFArrayGetValueAtIndex(cfRes, bi);
            if (p && Number($.CFGetTypeID(p)) === CF_STRING_TYPE_ID) {
              var u = ObjC.unwrap(ObjC.castRefToObject(p));
              if (u !== undefined && u !== null) vals[bi] = String(u);
            }
          }
          try { $.CFRelease(cfRes); } catch (e) {}
        } else {
          var nsArr = castOutRefAndRelease(batchOut[0]);
          var ncnt = nsArr && nsArr.count ? Math.min(7, Number(nsArr.count)) : 0;
          for (var ni = 0; ni < ncnt; ni++) {
            vals[ni] = safeExtractStr(nsArr.objectAtIndex(ni));
          }
        }
        var axRole = vals[0];
        var ch = axRole === "AXStaticText" || axRole === "AXImage" ? null : readAttr(el, "AXChildren");
        return {
          axRole: axRole,
          roleDesc: vals[1],
          id: vals[2] || vals[3],
          title: vals[4],
          desc: vals[5],
          help: vals[6],
          children: ch
        };
      }
      if (err !== -25208) {
        return {
          axRole: "",
          roleDesc: "",
          id: "",
          title: "",
          desc: "",
          help: "",
          children: null
        };
      }
    }
    return {
      axRole: readStr(el, "AXRole"),
      roleDesc: readStr(el, "AXRoleDescription"),
      id: readStr(el, "AXIdentifier") || readStr(el, "AXDOMIdentifier"),
      title: readStr(el, "AXTitle"),
      desc: readStr(el, "AXDescription"),
      help: readStr(el, "AXHelp"),
      children: readAttr(el, "AXChildren")
    };
  }

  var stack = [winEl];
  while (stack.length > 0 && nodes.length < nodeCap) {
    if (nodes.length > 0 && (nodes.length & 7) === 0) {
      var elapsed = Number($.NSProcessInfo.processInfo.systemUptime || 0) - startUptime;
      if (elapsed >= deadlineSec) {
        incomplete = true;
        break;
      }
    }
    var cur = stack.pop();
    var info = readNodeAttrs(cur);
    nodes.push({
      order: nodes.length,
      el: cur,
      axRole: info.axRole,
      roleDesc: info.roleDesc,
      id: info.id,
      title: info.title,
      desc: info.desc,
      help: info.help,
      staticLabel: info.title || info.desc || ""
    });
    var ch = info.children;
    if (ch && ch.count) {
      var len = Math.min(Number(ch.count), nodeCap);
      for (var i = len - 1; i >= 0; i--) {
        stack.push(ch.objectAtIndex(i));
      }
    }
  }
  if (stack.length > 0 && nodes.length >= nodeCap) {
    incomplete = true;
  }
  return { nodes: nodes, incomplete: incomplete };
}

function normStr(s) {
  return String(s || "").trim().toLowerCase();
}

function roleMatches(metaRole, node) {
  if (!metaRole) return true;
  var want = normStr(metaRole);
  if (!want) return true;
  if (want === normStr(node.roleDesc) || want === normStr(node.axRole)) return true;
  var wantCompact = want.replace(/^ax/, "").replace(/\s+/g, "");
  var axCompact = normStr(node.axRole).replace(/^ax/, "").replace(/\s+/g, "");
  var descCompact = normStr(node.roleDesc).replace(/\s+/g, "");
  if (wantCompact && (wantCompact === axCompact || wantCompact === descCompact)) return true;
  return false;
}

function extractPrimaryHint(rawText) {
  if (!rawText || rawText === "[redacted]") return "";
  var cleaned = String(rawText)
    .replace(/,?\s*Value:\s*.*$/i, "")
    .replace(/\s+Selected(?:\s|$).*$/i, "")
    .replace(/\s+Focused(?:\s|$).*$/i, "")
    .trim();
  return cleaned;
}

function labelMatches(hint, helpHint, node) {
  if (!hint && !helpHint) return true;
  var h = normStr(hint);
  var t = normStr(node.title);
  var d = normStr(node.desc);
  var hp = normStr(node.help);
  if (h) {
    if (t === h || d === h || hp === h) return true;
    if (t && (h.indexOf(t) === 0 || t.indexOf(h) === 0)) return true;
    if (d && (h.indexOf(d) === 0 || d.indexOf(h) === 0)) return true;
  }
  if (helpHint && hp && hp === normStr(helpHint)) return true;
  return false;
}

function handlePermissions() {
  var ax = typeof $.AXIsProcessTrusted === "function" ? Boolean($.AXIsProcessTrusted()) : null;
  var sr = hasScreenCapturePreflight ? Boolean($.CGPreflightScreenCaptureAccess()) : null;
  return { platform: "darwin", accessibility: ax, screenRecording: sr };
}

function handleProcessInfo(params) {
  pumpRunLoop();
  var pid = Number(params.pid || 0);
  if (!pid || pid <= 0) return { alive: false, pid: pid };
  var app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(pid);
  if (!app || app.isNil() || Boolean(app.terminated)) {
    return { alive: false, pid: pid, guiApp: false };
  }
  var bid = app.bundleIdentifier && !app.bundleIdentifier.isNil() ? String(ObjC.unwrap(app.bundleIdentifier)) : null;
  var name = app.localizedName && !app.localizedName.isNil() ? String(ObjC.unwrap(app.localizedName)) : null;
  var launchTs = app.launchDate && !app.launchDate.isNil() ? Number(app.launchDate.timeIntervalSince1970) : null;
  var token = launchTs !== null ? (pid + ":" + launchTs.toFixed(6)) : null;
  return {
    alive: true,
    guiApp: true,
    pid: pid,
    bundleId: bid,
    displayName: name,
    launchTs: launchTs,
    processToken: token
  };
}

function handleFrontmostApp() {
  pumpRunLoop();
  var front = $.NSWorkspace.sharedWorkspace.frontmostApplication;
  if (!front || front.isNil()) return null;
  var pid = Number(front.processIdentifier);
  if (!pid || pid <= 0) return null;
  var bid = front.bundleIdentifier && !front.bundleIdentifier.isNil() ? String(ObjC.unwrap(front.bundleIdentifier)) : null;
  var name = front.localizedName && !front.localizedName.isNil() ? String(ObjC.unwrap(front.localizedName)) : null;
  var launchTs = front.launchDate && !front.launchDate.isNil() ? Number(front.launchDate.timeIntervalSince1970) : null;
  var token = launchTs !== null ? (pid + ":" + launchTs.toFixed(6)) : null;
  return { pid: pid, bundleId: bid, displayName: name, processToken: token };
}

function handleRestoreFrontmost(params) {
  var pid = Number(params.pid || 0);
  if (!pid || pid <= 0) return { ok: false, reason: "invalid_pid", definitive: true };
  function tokOf(a) {
    if (!a || a.isNil() || !a.launchDate || a.launchDate.isNil()) return null;
    return Number(a.processIdentifier) + ":" + Number(a.launchDate.timeIntervalSince1970).toFixed(6);
  }
  function tokMatch(a, b) {
    if (!a || !b) return true;
    var pa = String(a).split(":"), pb = String(b).split(":");
    return pa[0] === pb[0] && Math.abs(Number(pa[1]) - Number(pb[1])) <= 2.0;
  }
  var expFrontPid = Number(params.expectedFrontmostPid || 0);
  var expFrontTok = params.expectedFrontmostProcessToken ? String(params.expectedFrontmostProcessToken) : "";
  var expRestoreTok = params.expectedRestoreProcessToken ? String(params.expectedRestoreProcessToken) : "";
  if (expFrontPid > 0 || expFrontTok) {
    var cur = $.NSWorkspace.sharedWorkspace.frontmostApplication;
    if (!cur || cur.isNil()) {
      return { ok: false, reason: "foreground_changed", definitive: true };
    }
    if (expFrontPid > 0 && Number(cur.processIdentifier) !== expFrontPid) {
      return { ok: false, reason: "foreground_changed", definitive: true };
    }
    if (expFrontTok && !tokMatch(tokOf(cur), expFrontTok)) {
      return { ok: false, reason: "foreground_changed", definitive: true };
    }
  }
  var app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(pid);
  if (!app || app.isNil() || Boolean(app.terminated)) {
    return { ok: false, reason: "restore_target_exited", definitive: true };
  }
  if (expRestoreTok && !tokMatch(tokOf(app), expRestoreTok)) {
    return { ok: false, reason: "restore_target_restarted", definitive: true };
  }
  var ok = Boolean(app.activateWithOptions(2));
  return { ok: ok, definitive: true };
}

function handleFindRunningApp(params) {
  pumpRunLoop();
  var rawQuery = String(params.appQuery || "").trim();
  if (!rawQuery) return null;
  var want = rawQuery.replace(/\.app$/i, "").toLowerCase();
  var running = $.NSWorkspace.sharedWorkspace.runningApplications;
  var count = running && running.count ? Number(running.count) : 0;
  for (var i = 0; i < count; i++) {
    var app = running.objectAtIndex(i);
    if (!app || app.isNil() || Boolean(app.terminated)) continue;
    var pid = Number(app.processIdentifier);
    if (!pid || pid <= 0) continue;
    var bid = app.bundleIdentifier && !app.bundleIdentifier.isNil() ? String(ObjC.unwrap(app.bundleIdentifier)) : "";
    var name = app.localizedName && !app.localizedName.isNil() ? String(ObjC.unwrap(app.localizedName)) : "";
    var bidNorm = bid.toLowerCase();
    var nameNorm = name.replace(/\.app$/i, "").toLowerCase();
    if ((bidNorm && bidNorm === want) || (nameNorm && nameNorm === want)) {
      var launchTs = app.launchDate && !app.launchDate.isNil() ? Number(app.launchDate.timeIntervalSince1970) : null;
      return {
        alive: true,
        pid: pid,
        bundleId: bid || null,
        displayName: name || null,
        processToken: launchTs !== null ? (pid + ":" + launchTs.toFixed(6)) : null
      };
    }
  }
  return null;
}

function handleEnsureManualAx(params) {
  var pid = Number(params.pid || 0);
  if (!pid || pid <= 0) return { supported: false, changed: false, enabled: false, definitive: false };
  var appEl = createAppElement(pid, 0.5);
  var settableRef = Ref();
  var code = Number($.AXUIElementIsAttributeSettable(appEl, $("AXManualAccessibility"), settableRef));
  if (code !== 0 || !settableRef[0]) {
    // -25205 = AttributeUnsupported, -25212 = NoValue (definitive non-Chromium Cocoa app)
    var definitive = (code === 0 && !settableRef[0]) || code === -25205 || code === -25212;
    return { supported: false, changed: false, enabled: false, definitive: definitive, code: code };
  }
  var current = readBool(appEl, "AXManualAccessibility");
  if (current === true) {
    return { supported: true, changed: false, enabled: true, definitive: true, code: 0 };
  }
  var setCode = Number($.AXUIElementSetAttributeValue(appEl, $("AXManualAccessibility"), $(true)));
  return {
    supported: true,
    changed: setCode === 0,
    enabled: setCode === 0,
    definitive: setCode === 0,
    code: setCode
  };
}

function handleBindSnapshot(params) {
  var snapshotId = String(params.snapshotId || "");
  var pid = Number(params.pid || 0);
  if (!snapshotId || !pid || pid <= 0) {
    return { bound: false, boundCount: 0, windowBound: false };
  }
  var appEl = createAppElement(pid, 0.7);
  var winEl = selectTargetWindow(appEl, params.windowTitle || "");
  if (!winEl) {
    return { bound: false, boundCount: 0, windowBound: false };
  }
  var winTitle = readStr(winEl, "AXTitle");
  var winBounds = readBounds(winEl);
  var hasModal = detectWindowModalState(appEl, winEl);
  var inputEls = Array.isArray(params.elements) ? params.elements : [];
  var maxNodes = Math.min(1200, Math.max(1000, inputEls.length * 4));
  var bindStartUptime = Number($.NSProcessInfo.processInfo.systemUptime || 0);
  var budgetSec = Number(params.budgetSec) > 0 ? Number(params.budgetSec) : 1.2;
  var walked = walkWindowPreorder(winEl, maxNodes, budgetSec);
  var nodes = walked.nodes;
  var incomplete = Boolean(walked.incomplete);

  var usedOrders = {};
  var lastOrder = -1;
  var boundElements = {};
  var boundCount = 0;

  for (var i = 0; i < inputEls.length; i++) {
    if (i > 0 && (i & 7) === 0 && (Number($.NSProcessInfo.processInfo.systemUptime || 0) - bindStartUptime) >= budgetSec) {
      incomplete = true;
      break;
    }
    var item = inputEls[i];
    var idxStr = String(item.index);
    var matched = null;

    if (idxStr === "0" && nodes.length > 0 && roleMatches(item.role, nodes[0])) {
      matched = nodes[0];
    }

    if (!matched && item.identifier) {
      for (var j = 0; j < nodes.length; j++) {
        var n1 = nodes[j];
        if (!usedOrders[n1.order] && n1.id === item.identifier && roleMatches(item.role, n1)) {
          matched = n1;
          break;
        }
      }
    }

    if (!matched) {
      var hint = extractPrimaryHint(item.rawText);
      if (hint || item.help) {
        // Prefer monotonic preorder progression first, then fallback to any unused matching node
        for (var pass = 0; pass < 2 && !matched; pass++) {
          var startAt = pass === 0 ? Math.max(0, lastOrder + 1) : 0;
          for (var k = startAt; k < nodes.length; k++) {
            var n2 = nodes[k];
            if (usedOrders[n2.order]) continue;
            if (roleMatches(item.role, n2) && labelMatches(hint, item.help, n2)) {
              matched = n2;
              break;
            }
          }
        }
      }
    }

    if (matched) {
      usedOrders[matched.order] = true;
      if (matched.order > lastOrder) lastOrder = matched.order;
      var elBounds = readBounds(matched.el);
      boundElements[idxStr] = {
        el: matched.el,
        axRole: matched.axRole,
        roleDesc: matched.roleDesc,
        id: matched.id,
        staticLabel: matched.staticLabel,
        isEditable: Boolean(EDITABLE_ROLES[matched.axRole] || item.isSecure),
        relX: elBounds && winBounds ? elBounds.x - winBounds.x : null,
        relY: elBounds && winBounds ? elBounds.y - winBounds.y : null,
        w: elBounds ? elBounds.w : null,
        h: elBounds ? elBounds.h : null
      };
      boundCount += 1;
    }
  }

  if (!retainedSnapshots[snapshotId]) {
    retainedOrder.push(snapshotId);
    while (retainedOrder.length > MAX_RETAINED_SNAPSHOTS) {
      var oldest = retainedOrder.shift();
      delete retainedSnapshots[oldest];
    }
  }

  retainedSnapshots[snapshotId] = {
    pid: pid,
    appEl: appEl,
    windowEl: winEl,
    windowTitle: winTitle || String(params.windowTitle || ""),
    windowBounds: winBounds,
    hasModal: hasModal,
    elements: boundElements
  };

  return {
    bound: true,
    windowBound: true,
    boundCount: boundCount,
    totalVisited: nodes.length,
    hasModal: hasModal,
    incomplete: incomplete
  };
}

function handleVerifyLiveRef(params) {
  var snapshotId = String(params.snapshotId || "");
  var idxStr = params.elementIndex !== undefined && params.elementIndex !== null ? String(params.elementIndex) : null;
  var requireBound = Boolean(params.requireBound);
  var snap = snapshotId ? retainedSnapshots[snapshotId] : null;
  if (!snap) {
    return {
      ok: false,
      skipped: "snapshot_not_retained",
      reason: "snapshot_not_retained",
      message: "Snapshot " + snapshotId + " is no longer retained in live AX memory."
    };
  }
  if (params.expectedPid && snap.pid !== Number(params.expectedPid)) {
    return {
      ok: false,
      reason: "pid_mismatch",
      message: "Snapshot " + snapshotId + " belongs to PID " + snap.pid + ", expected " + params.expectedPid + "."
    };
  }

  // 1. Live Window liveness & asynchronous modal/title drift check
  if (snap.windowEl) {
    var winRoleRes = readAttrWithCode(snap.windowEl, "AXRole");
    if (winRoleRes.code === -25202 || !winRoleRes.val) {
      return {
        ok: false,
        reason: "window_destroyed_in_background",
        message: "Target window closed or recreated asynchronously after snapshot " + snapshotId + "."
      };
    }
    var liveWinTitle = readStr(snap.windowEl, "AXTitle");
    if (snap.windowTitle && liveWinTitle && liveWinTitle !== snap.windowTitle) {
      return {
        ok: false,
        reason: "window_changed_in_background",
        message: "Window title changed asynchronously ('" + snap.windowTitle + "' -> '" + liveWinTitle + "') after snapshot " + snapshotId + "."
      };
    }
    if (!snap.hasModal && detectWindowModalState(snap.appEl, snap.windowEl)) {
      return {
        ok: false,
        reason: "modal_sheet_appeared",
        message: "A modal dialog/sheet appeared asynchronously over the window after snapshot " + snapshotId + "."
      };
    }
  }

  if (idxStr === null) {
    return { ok: true };
  }
  if (!snap.elements || !snap.elements[idxStr]) {
    if (requireBound) {
      return {
        ok: false,
        skipped: "element_not_bound",
        reason: "element_not_bound",
        message: "Element @" + snapshotId + ":" + idxStr + " is not affirmatively bound in live AX memory."
      };
    }
    return { ok: true, skipped: "element_not_bound" };
  }

  var entry = snap.elements[idxStr];
  var roleRes = readAttrWithCode(entry.el, "AXRole");
  if (roleRes.code === -25202 || !roleRes.val) {
    return {
      ok: false,
      reason: "element_destroyed_in_background",
      message: "Element @" + snapshotId + ":" + idxStr + " was destroyed or unmounted asynchronously in the background."
    };
  }

  var liveAxRole = String(ObjC.unwrap(roleRes.val) || "");
  if (entry.axRole && liveAxRole && liveAxRole !== entry.axRole) {
    return {
      ok: false,
      reason: "element_mutated_in_background",
      message: "Element @" + snapshotId + ":" + idxStr + " changed role ('" + entry.axRole + "' -> '" + liveAxRole + "') in the background."
    };
  }

  // Verify element is still attached to a window (for non-window controls)
  if (liveAxRole !== "AXWindow") {
    var parentCheck = readAttrWithCode(entry.el, "AXParent");
    if (parentCheck.code === -25202 || !parentCheck.val) {
      return {
        ok: false,
        reason: "element_destroyed_in_background",
        message: "Element @" + snapshotId + ":" + idxStr + " detached from parent view in the background."
      };
    }
  }

  var liveId = readStr(entry.el, "AXIdentifier") || readStr(entry.el, "AXDOMIdentifier");
  if (entry.id && liveId !== entry.id) {
    return {
      ok: false,
      reason: "element_mutated_in_background",
      message: "Element @" + snapshotId + ":" + idxStr + " identifier changed ('" + entry.id + "' -> '" + liveId + "') in the background."
    };
  }

  if (!entry.isEditable && !entry.id && entry.staticLabel) {
    var liveLabel = readStr(entry.el, "AXTitle") || readStr(entry.el, "AXDescription");
    if (liveLabel && liveLabel !== entry.staticLabel) {
      return {
        ok: false,
        reason: "element_mutated_in_background",
        message: "Element @" + snapshotId + ":" + idxStr + " label changed ('" + entry.staticLabel + "' -> '" + liveLabel + "') in the background."
      };
    }
  }

  // Geometry visibility & window-relative layout shift check
  if (entry.w !== null && entry.h !== null && entry.w > 0 && entry.h > 0) {
    var liveElBounds = readBounds(entry.el);
    var liveWinBounds = snap.windowEl ? readBounds(snap.windowEl) : null;
    if (liveElBounds) {
      if (liveElBounds.w <= 0.5 || liveElBounds.h <= 0.5) {
        return {
          ok: false,
          reason: "element_hidden_in_background",
          message: "Element @" + snapshotId + ":" + idxStr + " collapsed to zero size in the background."
        };
      }
      if (liveWinBounds && entry.relX !== null && entry.relY !== null) {
        var oldCenterX = entry.relX + entry.w * 0.5;
        var oldCenterY = entry.relY + entry.h * 0.5;
        var newCenterX = (liveElBounds.x - liveWinBounds.x) + liveElBounds.w * 0.5;
        var newCenterY = (liveElBounds.y - liveWinBounds.y) + liveElBounds.h * 0.5;
        var maxDriftX = Math.max(16, entry.w * 0.55);
        var maxDriftY = Math.max(16, entry.h * 0.55);
        if (Math.abs(newCenterX - oldCenterX) > maxDriftX || Math.abs(newCenterY - oldCenterY) > maxDriftY) {
          return {
            ok: false,
            moved: true,
            reason: "element_moved_in_background",
            message: "Element @" + snapshotId + ":" + idxStr + " shifted position inside the window asynchronously."
          };
        }
      }
    }
  }

  return { ok: true };
}

function resolveElementHandle(pid, snapshotId, elementIndex, elementMeta) {
  if (snapshotId && elementIndex !== undefined && elementIndex !== null) {
    var snap = retainedSnapshots[String(snapshotId)];
    var bound = snap && snap.elements ? snap.elements[String(elementIndex)] : null;
    if (bound && bound.el && readAttrWithCode(bound.el, "AXRole").code === 0) {
      return { appEl: snap.appEl, winEl: snap.windowEl, el: bound.el };
    }
  }
  var appEl = createAppElement(pid, 0.75);
  var winEl = selectTargetWindow(appEl, "");
  if (!winEl) return { appEl: appEl, winEl: null, el: null };
  if (!elementMeta) return { appEl: appEl, winEl: winEl, el: null };

  var walkedRes = walkWindowPreorder(winEl, 400, 0.45);
  var nodes = walkedRes.nodes;
  if (elementMeta.identifier) {
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].id === elementMeta.identifier && roleMatches(elementMeta.role, nodes[i])) {
        return { appEl: appEl, winEl: winEl, el: nodes[i].el };
      }
    }
  }
  var hint = extractPrimaryHint(elementMeta.rawText);
  for (var j = 0; j < nodes.length; j++) {
    if (roleMatches(elementMeta.role, nodes[j]) && labelMatches(hint, elementMeta.help, nodes[j])) {
      return { appEl: appEl, winEl: winEl, el: nodes[j].el };
    }
  }
  return { appEl: appEl, winEl: winEl, el: null };
}

function isElementOrDescendant(candidateEl, rootEl) {
  if (!candidateEl || !rootEl) return false;
  var cur = candidateEl;
  var hops = 0;
  while (cur && hops < 6) {
    hops += 1;
    try {
      if (Boolean(cur.isEqual(rootEl))) return true;
    } catch (e) {}
    cur = readAttr(cur, "AXParent");
  }
  return false;
}

function handleVerifyEditableFocus(params) {
  var pid = Number(params.pid || 0);
  if (!pid || pid <= 0) {
    return { editable: false, role: null, singleLine: false, reason: "invalid_pid" };
  }
  var appEl = createAppElement(pid, 0.5);
  var focused = readAttr(appEl, "AXFocusedUIElement");
  if (!focused) {
    return { editable: false, role: null, singleLine: false, reason: "no_focused_element" };
  }
  var role = readStr(focused, "AXRole");
  if (SAFE_INSERT_ROLES.indexOf(role) < 0) {
    return { editable: false, role: role || null, singleLine: false, reason: "non_editable_role" };
  }
  var subrole = readStr(focused, "AXSubrole");
  if (subrole === "AXSecureTextField") {
    return { editable: false, role: role, singleLine: true, reason: "secure_field" };
  }
  if (params.elementIndex !== undefined && params.elementIndex !== null) {
    var targetEl = null;
    if (params.snapshotId) {
      var snap = retainedSnapshots[String(params.snapshotId)];
      var bound = snap && snap.elements ? snap.elements[String(params.elementIndex)] : null;
      if (bound && bound.el && readAttrWithCode(bound.el, "AXRole").code === 0) {
        targetEl = bound.el;
      }
    }
    if (!targetEl && params.elementMeta && params.elementMeta.identifier) {
      var resolved = resolveElementHandle(pid, params.snapshotId, params.elementIndex, {
        identifier: params.elementMeta.identifier,
        role: params.elementMeta.role || ""
      });
      if (resolved && resolved.el) {
        targetEl = resolved.el;
      }
    }
    if (!targetEl) {
      return {
        editable: false,
        role: role,
        singleLine: role !== "AXTextArea",
        reason: "target_not_bound"
      };
    }
    if (!isElementOrDescendant(focused, targetEl)) {
      return {
        editable: false,
        role: role,
        singleLine: role !== "AXTextArea",
        reason: "focus_on_different_element"
      };
    }
  }
  return {
    editable: true,
    role: role,
    singleLine: role !== "AXTextArea",
    reason: "ok"
  };
}

function handleInsertSelectedText(params) {
  var pid = Number(params.pid || 0);
  var text = String(params.text || "");
  if (!pid || pid <= 0 || !text.length) {
    return { delivered: false, verified: false, reason: "invalid_args" };
  }
  var appEl = createAppElement(pid, 0.75);
  var focused = readAttr(appEl, "AXFocusedUIElement");
  if (!focused) {
    return { delivered: false, verified: false, reason: "no_focused_element" };
  }
  var role = readStr(focused, "AXRole");
  if (SAFE_INSERT_ROLES.indexOf(role) < 0) {
    return { delivered: false, verified: false, reason: "unsupported_role", role: role };
  }
  var settableRef = Ref();
  if (Number($.AXUIElementIsAttributeSettable(focused, $("AXSelectedText"), settableRef)) !== 0 || !settableRef[0]) {
    return { delivered: false, verified: false, reason: "not_settable", role: role };
  }
  var beforeVal = readStr(focused, "AXValue");
  var setErr = Number($.AXUIElementSetAttributeValue(focused, $("AXSelectedText"), $(text)));
  if (setErr !== 0) {
    return { delivered: false, verified: false, reason: "ax_set_error", code: setErr };
  }
  var afterVal = readStr(focused, "AXValue");
  var verified = afterVal.indexOf(text) >= 0 || afterVal !== beforeVal;
  return { delivered: true, verified: Boolean(verified), reason: verified ? "ok" : "unverified" };
}

function findScrollBarFromElementOrWindow(resolved, barAttr, targetId) {
  // 1. Climb ancestors from target element if resolved (supports AXScrollArea, AXWebArea, AXTable, AXOutline, AXList, etc.)
  var cur = resolved.el;
  var hops = 0;
  while (cur && hops < 12) {
    hops += 1;
    var bar = readAttr(cur, barAttr);
    if (bar) return bar;
    cur = readAttr(cur, "AXParent");
  }
  // 2. Search target element descendants or window subtree
  var searchRoot = resolved.el || resolved.winEl;
  if (!searchRoot) return null;
  var queue = [searchRoot];
  var visits = 0;
  var fallbackBar = null;
  while (queue.length > 0 && visits < 200) {
    var node = queue.shift();
    visits += 1;
    var b = readAttr(node, barAttr);
    if (b) {
      if (!fallbackBar) fallbackBar = b;
      if (targetId && (readStr(node, "AXIdentifier") === targetId || readStr(node, "AXDOMIdentifier") === targetId)) {
        return b;
      }
      if (readStr(node, "AXRole") === "AXScrollArea" && !targetId) {
        return b;
      }
    }
    var ch = readAttr(node, "AXChildren");
    if (ch && ch.count) {
      var lim = Math.min(Number(ch.count), 40);
      for (var i = 0; i < lim; i++) queue.push(ch.objectAtIndex(i));
    }
  }
  if (fallbackBar || searchRoot === resolved.winEl || !resolved.winEl) return fallbackBar;
  return findScrollBarFromElementOrWindow({ el: null, winEl: resolved.winEl }, barAttr, targetId);
}

function handleScroll(params) {
  var pid = Number(params.pid || 0);
  if (!pid || pid <= 0) return { delivered: false, verified: false, reason: "invalid_pid" };
  var dir = String(params.direction || "down").toLowerCase();
  var isVertical = dir === "up" || dir === "down";
  var barAttr = isVertical ? "AXVerticalScrollBar" : "AXHorizontalScrollBar";
  var stepAction = dir === "down" || dir === "right" ? "AXIncrement" : "AXDecrement";
  var sign = dir === "down" || dir === "right" ? 1 : -1;
  var pageAmount = Math.max(0.1, Math.min(10, Number(params.pages) || 1));

  var resolved = resolveElementHandle(pid, params.snapshotId, params.elementIndex, params.elementMeta || null);
  var bar = findScrollBarFromElementOrWindow(
    resolved,
    barAttr,
    params.elementMeta && params.elementMeta.identifier ? params.elementMeta.identifier : null
  );
  if (!bar) {
    return { delivered: false, verified: false, reason: "no_scrollbar" };
  }

  var beforeObj = readAttr(bar, "AXValue");
  var beforeNum = beforeObj !== null ? Number(ObjC.unwrap(beforeObj)) : null;
  var didShift = false;
  if (Number.isFinite(beforeNum)) {
    var settableRef = Ref();
    if (Number($.AXUIElementIsAttributeSettable(bar, $("AXValue"), settableRef)) === 0 && settableRef[0]) {
      var nextVal = Math.max(0, Math.min(1, beforeNum + sign * 0.1 * pageAmount));
      if (Math.abs(nextVal - beforeNum) > 1e-6 && Number($.AXUIElementSetAttributeValue(bar, $("AXValue"), $(nextVal))) === 0) {
        didShift = true;
      }
    }
  }
  if (!didShift) {
    var steps = Math.max(1, Math.min(8, Math.round(pageAmount * 3)));
    for (var s = 0; s < steps; s++) {
      if (Number($.AXUIElementPerformAction(bar, $(stepAction))) === 0) didShift = true;
    }
  }
  var afterObj = readAttr(bar, "AXValue");
  var afterNum = afterObj !== null ? Number(ObjC.unwrap(afterObj)) : null;
  var verified = Number.isFinite(beforeNum) && Number.isFinite(afterNum) && Math.abs(afterNum - beforeNum) > 1e-5;
  return { delivered: didShift, verified: verified, reason: didShift ? "ok" : "inert_scrollbar" };
}

function handleContextMenu(params) {
  var pid = Number(params.pid || 0);
  if (!pid || pid <= 0) return { delivered: false, verified: false, reason: "invalid_pid" };
  var resolved = resolveElementHandle(pid, params.snapshotId, params.elementIndex, params.elementMeta || null);
  if (!resolved.el) {
    return { delivered: false, verified: false, reason: "element_not_found" };
  }
  var actions = getActionNames(resolved.el);
  if (actions.indexOf("AXShowMenu") < 0) {
    return { delivered: false, verified: false, reason: "not_advertised" };
  }
  var err = Number($.AXUIElementPerformAction(resolved.el, $("AXShowMenu")));
  return { delivered: err === 0, verified: err === 0, reason: err === 0 ? "ok" : "ax_error" };
}

function resolveTargetCgWindow(pid, preferredTitle, explicitWid, explicitBounds, targetAxBounds) {
  var cgRef = null;
  var cgList = [];
  try {
    cgRef = $.CGWindowListCopyWindowInfo(0, 0);
    if (cgRef) {
      cgList = ObjC.deepUnwrap(ObjC.castRefToObject(cgRef)) || [];
    }
  } catch (e) {
    cgList = [];
  } finally {
    if (cgRef) {
      try { $.CFRelease(cgRef); } catch (e2) {}
    }
  }

  var reqWid = explicitWid && Number(explicitWid) > 0 ? Number(explicitWid) : 0;
  if (reqWid > 0) {
    for (var j = 0; j < cgList.length; j++) {
      var cw = cgList[j];
      if (Number(cw.kCGWindowNumber) !== reqWid) continue;
      if (Number(cw.kCGWindowOwnerPID) !== pid) {
        return null;
      }
      var cwb = cw.kCGWindowBounds || {};
      var cbw = Number(cwb.Width || 0);
      var cbh = Number(cwb.Height || 0);
      if (cbw <= 0 || cbh <= 0) return null;
      return {
        wid: reqWid,
        title: String(cw.kCGWindowName || ""),
        x: Number(cwb.X || 0),
        y: Number(cwb.Y || 0),
        w: cbw,
        h: cbh
      };
    }
    return null;
  }

  var axBounds = targetAxBounds || null;
  var axTitle = preferredTitle ? String(preferredTitle) : "";
  if (!axBounds) {
    var appEl = createAppElement(pid, 0.75);
    var axWin = selectTargetWindow(appEl, axTitle);
    if (axWin) {
      var b = readBounds(axWin);
      if (b && b.w >= 120 && b.h >= 80) {
        axBounds = b;
      }
      if (!axTitle) {
        axTitle = readStr(axWin, "AXTitle");
      }
    }
  }

  var titleMatch = null;
  var bestLarge = null;
  var bestArea = 0;
  var firstValid = null;

  for (var i = 0; i < cgList.length; i++) {
    var w = cgList[i];
    if (Number(w.kCGWindowOwnerPID) !== pid) continue;
    if (Number(w.kCGWindowLayer || 0) !== 0) continue;
    var alpha = w.kCGWindowAlpha === undefined ? 1 : Number(w.kCGWindowAlpha);
    if (alpha <= 0.01) continue;
    var wb = w.kCGWindowBounds || {};
    var bx = Number(wb.X || 0);
    var by = Number(wb.Y || 0);
    var bw = Number(wb.Width || 0);
    var bh = Number(wb.Height || 0);
    if (bw < 120 || bh < 80) continue;
    var wid = Number(w.kCGWindowNumber || 0);
    var candidate = { wid: wid, title: String(w.kCGWindowName || ""), x: bx, y: by, w: bw, h: bh };
    if (!firstValid) firstValid = candidate;

    if (
      axBounds &&
      Math.abs(bx - axBounds.x) <= 4 &&
      Math.abs(by - axBounds.y) <= 4 &&
      Math.abs(bw - axBounds.w) <= 4 &&
      Math.abs(bh - axBounds.h) <= 4
    ) {
      return candidate;
    }
    if (!titleMatch && axTitle && String(w.kCGWindowName || "") === axTitle) {
      titleMatch = candidate;
    }
    if (bw >= 300 && bh >= 200) {
      var area = bw * bh;
      if (area > bestArea) {
        bestArea = area;
        bestLarge = candidate;
      }
    }
  }

  if (titleMatch) return titleMatch;
  if (bestLarge) return bestLarge;
  if (firstValid) return firstValid;
  if (axBounds && axBounds.w > 0 && axBounds.h > 0) {
    return { wid: 0, title: axTitle || "", x: axBounds.x, y: axBounds.y, w: axBounds.w, h: axBounds.h };
  }
  return null;
}

function handleFocusedWindow(params) {
  var pid = Number(params.pid || 0);
  if (!pid || pid <= 0) return { wid: null, title: null, windowBounds: null, windowIds: [] };
  var cgRef = null;
  var cgList = [];
  try {
    cgRef = $.CGWindowListCopyWindowInfo(0, 0);
    if (cgRef) {
      cgList = ObjC.deepUnwrap(ObjC.castRefToObject(cgRef)) || [];
    }
  } catch (e) {
    cgList = [];
  } finally {
    if (cgRef) {
      try { $.CFRelease(cgRef); } catch (e2) {}
    }
  }

  var windowIds = [];
  var pidWindows = [];
  for (var i = 0; i < cgList.length; i++) {
    var w = cgList[i];
    if (Number(w.kCGWindowOwnerPID) !== pid) continue;
    if (Number(w.kCGWindowLayer || 0) !== 0) continue;
    var alpha = w.kCGWindowAlpha === undefined ? 1 : Number(w.kCGWindowAlpha);
    if (alpha <= 0.01) continue;
    var wb = w.kCGWindowBounds || {};
    var bx = Number(wb.X || 0);
    var by = Number(wb.Y || 0);
    var bw = Number(wb.Width || 0);
    var bh = Number(wb.Height || 0);
    if (bw < 120 || bh < 80) continue;
    var widNum = Number(w.kCGWindowNumber || 0);
    if (widNum > 0) windowIds.push(widNum);
    pidWindows.push({
      wid: widNum,
      title: String(w.kCGWindowName || ""),
      x: bx,
      y: by,
      w: bw,
      h: bh
    });
  }

  var axBounds = null;
  var axTitle = "";
  try {
    var appEl = createAppElement(pid, 0.45);
    var axWin = readAttr(appEl, "AXFocusedWindow") || readAttr(appEl, "AXMainWindow");
    if (axWin) {
      var b = readBounds(axWin);
      if (b && b.w >= 120 && b.h >= 80) {
        axBounds = b;
      }
      var t = readStr(axWin, "AXTitle");
      if (t) axTitle = t;
    }
  } catch (e) {}

  if (!axBounds) {
    return { wid: null, title: axTitle || null, windowBounds: null, windowIds: windowIds };
  }

  for (var j = 0; j < pidWindows.length; j++) {
    var cand = pidWindows[j];
    if (
      cand.wid > 0 &&
      Math.abs(cand.x - axBounds.x) <= 4 &&
      Math.abs(cand.y - axBounds.y) <= 4 &&
      Math.abs(cand.w - axBounds.w) <= 4 &&
      Math.abs(cand.h - axBounds.h) <= 4
    ) {
      return {
        wid: cand.wid,
        title: cand.title || axTitle || null,
        windowBounds: { x: cand.x, y: cand.y, w: cand.w, h: cand.h },
        windowIds: windowIds
      };
    }
  }

  return { wid: null, title: axTitle || null, windowBounds: null, windowIds: windowIds };
}

function postSkyLightOrPidEvent(ev, pid, wid, localX, localY, useSkyLight, clickState, cgBtn, syntheticTag) {
  stampSyntheticUserData(ev, syntheticTag);
  if (useSkyLight) {
    var seq = ++windowEventSeq;
    $.SLEventSetIntegerValueField(ev, 0, seq);
    if (clickState !== undefined && clickState !== null) {
      $.SLEventSetIntegerValueField(ev, 1, clickState);
      $.SLEventSetIntegerValueField(ev, 3, cgBtn);
      $.SLEventSetIntegerValueField(ev, 7, 3);
    }
    $.SLEventSetIntegerValueField(ev, 40, pid);
    $.SLEventSetIntegerValueField(ev, 51, wid);
    $.SLEventSetIntegerValueField(ev, 91, wid);
    $.SLEventSetIntegerValueField(ev, 92, wid);
    $.CGEventSetWindowLocation(ev, localX, localY);
    $.SLEventPostToPid(pid, ev);
  } else {
    $.CGEventPostToPid(pid, ev);
  }
}

function handleWindowScroll(params) {
  var pid = Number(params.pid || 0);
  if (!pid || pid <= 0) return { delivered: false, verified: false, reason: "invalid_pid" };
  if (!hasScrollWheel2Fn) {
    return { delivered: false, verified: false, reason: "scroll_wheel_unavailable" };
  }

  var win = resolveTargetCgWindow(
    pid,
    params.windowTitle || "",
    params.wid || null,
    params.windowBounds || null,
    null
  );
  if (!win || win.w <= 0 || win.h <= 0) {
    return { delivered: false, verified: false, reason: "window_not_found" };
  }

  var useSkyLight = Boolean(hasSkyLightWindowPost && win.wid > 0);
  if (!useSkyLight && params.allowAppPostFallback !== true) {
    return {
      delivered: false,
      verified: false,
      method: null,
      reason: !hasSkyLightWindowPost ? "skylight_unavailable" : "window_id_unavailable"
    };
  }

  var localX = win.w * 0.5;
  var localY = win.h * 0.55;
  if (
    params.localPoint &&
    typeof params.localPoint === "object" &&
    Number.isFinite(Number(params.localPoint.x)) &&
    Number.isFinite(Number(params.localPoint.y))
  ) {
    localX = Number(params.localPoint.x);
    localY = Number(params.localPoint.y);
    if (localX < 0 || localY < 0 || localX > win.w + 1 || localY > win.h + 1) {
      return { delivered: false, verified: false, reason: "out_of_bounds" };
    }
  }
  var screenX = win.x + localX;
  var screenY = win.y + localY;

  var dir = String(params.direction || "down").toLowerCase();
  var isVertical = dir === "up" || dir === "down" || (dir !== "left" && dir !== "right");
  var totalDy = 0;
  var totalDx = 0;
  var explicitDelta =
    (params.deltaY !== null && params.deltaY !== undefined && Number.isFinite(Number(params.deltaY))) ||
    (params.deltaX !== null && params.deltaX !== undefined && Number.isFinite(Number(params.deltaX)));
  if (explicitDelta) {
    totalDy = params.deltaY !== null && params.deltaY !== undefined ? Math.round(Number(params.deltaY)) : 0;
    totalDx = params.deltaX !== null && params.deltaX !== undefined ? Math.round(Number(params.deltaX)) : 0;
    isVertical = Math.abs(totalDy) >= Math.abs(totalDx);
  } else {
    var pageAmount = Math.max(0.1, Math.min(3, Number(params.pages) || 0.7));
    var mag = Math.max(120, Math.min(2400, Math.round((isVertical ? win.h : win.w) * 0.65 * pageAmount)));
    if (dir === "down") totalDy = -mag;
    else if (dir === "up") totalDy = mag;
    else if (dir === "right") totalDx = -mag;
    else totalDx = mag;
  }

  var defaultSteps = explicitDelta ? 1 : 4;
  var steps = Math.max(1, Math.min(8, Math.round(Number(params.steps) || defaultSteps)));

  function postWheel(dy, dx) {
    var src = null;
    var ev = null;
    try {
      src = $.CGEventSourceCreate(0);
      ev = $.CGEventCreateScrollWheelEvent2(src, 0, isVertical && dx === 0 ? 1 : 2, dy, dx, 0);
      if (!src || !ev) return false;
      var ns = Math.floor($.NSProcessInfo.processInfo.systemUptime * 1e9);
      $.CGEventSetTimestamp(ev, ns);
      if (hasSetLocationFn) {
        $.CGEventSetLocation(ev, { x: screenX, y: screenY });
      }
      postSkyLightOrPidEvent(ev, pid, win.wid, localX, localY, useSkyLight, null, null, params.syntheticTag);
      return true;
    } finally {
      if (ev) { try { $.CFRelease(ev); } catch (e1) {} }
      if (src) { try { $.CFRelease(src); } catch (e2) {} }
    }
  }

  var moveSrc = null;
  var moveEv = null;
  try {
    moveSrc = $.CGEventSourceCreate(0);
    moveEv = $.CGEventCreateMouseEvent(moveSrc, 5, { x: screenX, y: screenY }, 0);
    if (moveSrc && moveEv) {
      var mNs = Math.floor($.NSProcessInfo.processInfo.systemUptime * 1e9);
      $.CGEventSetTimestamp(moveEv, mNs);
      postSkyLightOrPidEvent(moveEv, pid, win.wid, localX, localY, useSkyLight, null, null, params.syntheticTag);
    }
  } finally {
    if (moveEv) { try { $.CFRelease(moveEv); } catch (e3) {} }
    if (moveSrc) { try { $.CFRelease(moveSrc); } catch (e4) {} }
  }

  var postedAny = false;
  var sentDy = 0;
  var sentDx = 0;
  for (var i = 0; i < steps; i++) {
    var stepDy = i === steps - 1 ? totalDy - sentDy : Math.round(totalDy / steps);
    var stepDx = i === steps - 1 ? totalDx - sentDx : Math.round(totalDx / steps);
    sentDy += stepDy;
    sentDx += stepDx;
    if (postWheel(stepDy, stepDx)) postedAny = true;
    if (i + 1 < steps) $.NSThread.sleepForTimeInterval(0.015);
  }

  return {
    delivered: postedAny,
    verified: false,
    method: useSkyLight ? "window_post_scroll" : "app_post_scroll",
    wid: win.wid,
    localX: Number(localX.toFixed(2)),
    localY: Number(localY.toFixed(2)),
    deltaY: totalDy,
    deltaX: totalDx,
    reason: postedAny ? "ok" : "event_create_failed"
  };
}

function handleResolveActionTarget(params) {
  var pid = Number(params.pid || 0);
  if (!pid || pid <= 0) return { resolved: false, reason: "invalid_pid" };

  var win = resolveTargetCgWindow(
    pid,
    params.windowTitle || "",
    params.wid || null,
    params.windowBounds || null,
    null
  );
  if (!win || win.w <= 0 || win.h <= 0) {
    return { resolved: false, reason: "window_not_found" };
  }

  var targetLocal = null;
  if (
    params.localPoint &&
    typeof params.localPoint === "object" &&
    Number.isFinite(Number(params.localPoint.x)) &&
    Number.isFinite(Number(params.localPoint.y))
  ) {
    targetLocal = { x: Number(params.localPoint.x), y: Number(params.localPoint.y) };
  }

  var hitEl = null;
  if (params.elementIndex !== null && params.elementIndex !== undefined && String(params.elementIndex) !== "") {
    var byRef = resolveElementHandle(pid, params.snapshotId, String(params.elementIndex), params.elementMeta || null);
    if (byRef && byRef.el) {
      hitEl = byRef.el;
      if (!targetLocal) {
        var rb = readBounds(hitEl);
        if (rb && rb.w > 0 && rb.h > 0) {
          targetLocal = { x: rb.x + rb.w / 2 - win.x, y: rb.y + rb.h / 2 - win.y };
        }
      }
    }
  }

  if (!hitEl && targetLocal && typeof $.AXUIElementCopyElementAtPosition === "function") {
    try {
      var appEl = createAppElement(pid, 0.5);
      var out = Ref();
      if (Number($.AXUIElementCopyElementAtPosition(appEl, win.x + targetLocal.x, win.y + targetLocal.y, out)) === 0 && out[0]) {
        hitEl = castOutRefAndRelease(out[0]);
      }
    } catch (e) {}
  }

  var cardCandidate = null;
  if (hitEl) {
    var cur = hitEl;
    var CARD_ROLES = {
      AXButton: true,
      AXCell: true,
      AXRow: true,
      AXLink: true,
      AXRadioButton: true,
      AXCheckBox: true,
      AXMenuItem: true
    };
    for (var hops = 0; cur && hops <= 6; hops++) {
      var role = readStr(cur, "AXRole");
      if (role === "AXWindow" || role === "AXApplication" || role === "AXScrollArea") break;
      var bounds = readBounds(cur);
      var actions = getActionNames(cur);
      var hasPress = actions.indexOf("AXPress") >= 0;
      var withinWindow = bounds && bounds.w > 4 && bounds.h > 4 && !(bounds.w > win.w * 0.85 && bounds.h > win.h * 0.85);
      var looksCard =
        withinWindow &&
        (hasPress ||
          CARD_ROLES[role] ||
          (role === "AXGroup" && bounds.w >= 40 && bounds.h >= 24 && bounds.w <= win.w * 0.65 && bounds.h <= win.h * 0.55));
      if (looksCard) {
        if (cardCandidate && cardCandidate.hasAxPress && !hasPress) {
          break;
        }
        var lx = bounds.x - win.x;
        var ly = bounds.y - win.y;
        cardCandidate = {
          role: role,
          hasAxPress: hasPress,
          hops: hops,
          localBounds: { x: lx, y: ly, w: bounds.w, h: bounds.h },
          centerLocalPoint: { x: lx + bounds.w / 2, y: ly + bounds.h / 2 }
        };
        if (hasPress && (hops > 0 || CARD_ROLES[role])) break;
      }
      cur = readAttr(cur, "AXParent");
    }
  }

  return {
    resolved: Boolean(cardCandidate || targetLocal),
    wid: win.wid,
    windowTitle: win.title || null,
    windowBounds: { x: win.x, y: win.y, w: win.w, h: win.h },
    role: cardCandidate ? cardCandidate.role : null,
    hasAxPress: cardCandidate ? cardCandidate.hasAxPress : false,
    hops: cardCandidate ? cardCandidate.hops : 0,
    localBounds: cardCandidate ? cardCandidate.localBounds : null,
    centerLocalPoint: cardCandidate ? cardCandidate.centerLocalPoint : targetLocal,
    reason: cardCandidate ? "ax_card" : targetLocal ? "window_local_point" : "not_found"
  };
}

function handleWindowClick(params) {
  var pid = Number(params.pid || 0);
  if (!pid || pid <= 0) return { delivered: false, reason: "invalid_pid" };

  var hasLocalPoint = Boolean(
    params.localPoint &&
      typeof params.localPoint === "object" &&
      Number.isFinite(Number(params.localPoint.x)) &&
      Number.isFinite(Number(params.localPoint.y))
  );
  var hasElem = params.elementIndex !== null && params.elementIndex !== undefined && String(params.elementIndex) !== "";
  var elemIdxStr = hasElem ? String(params.elementIndex) : "";
  var hasXY =
    params.x !== null &&
    params.x !== undefined &&
    params.y !== null &&
    params.y !== undefined &&
    Number.isFinite(Number(params.x)) &&
    Number.isFinite(Number(params.y));

  if (!hasLocalPoint && !hasElem && !hasXY) {
    return { delivered: false, reason: "missing_target" };
  }
  if (!hasLocalPoint && !hasElem && params.screenCoords !== true && Number(params.frameWidth) > 0 && Number(params.frameHeight) > 0) {
    var preRx = Number(params.x);
    var preRy = Number(params.y);
    var preFw = Number(params.frameWidth);
    var preFh = Number(params.frameHeight);
    if (preRx < 0 || preRy < 0 || preRx > preFw + 1 || preRy > preFh + 1) {
      return { delivered: false, reason: "out_of_bounds" };
    }
  }

  var targetWinAxBounds = null;
  var elCenter = null;

  if (!hasLocalPoint && hasElem && elemIdxStr !== "0") {
    var resolved = resolveElementHandle(pid, params.snapshotId, elemIdxStr, params.elementMeta || null);
    if (!resolved.el) {
      return { delivered: false, reason: "element_not_found" };
    }
    var eb = readBounds(resolved.el);
    if (!eb || eb.w <= 0 || eb.h <= 0) {
      return { delivered: false, reason: "element_bounds_unavailable" };
    }
    elCenter = { x: eb.x + eb.w / 2, y: eb.y + eb.h / 2 };
    if (resolved.winEl) {
      var wb = readBounds(resolved.winEl);
      if (wb && wb.w >= 120 && wb.h >= 80) {
        targetWinAxBounds = wb;
      }
    }
  }

  var win = resolveTargetCgWindow(
    pid,
    params.windowTitle || "",
    params.wid || null,
    params.windowBounds || null,
    targetWinAxBounds
  );
  if (!win || win.w <= 0 || win.h <= 0) {
    return { delivered: false, reason: "window_not_found" };
  }

  if (hasLocalPoint && hasElem && elemIdxStr !== "0" && params.snapshotId && retainedSnapshots[String(params.snapshotId)]) {
    var liveRefRes = handleVerifyLiveRef({
      snapshotId: params.snapshotId,
      elementIndex: elemIdxStr,
      expectedPid: pid,
      requireBound: false
    });
    if (liveRefRes && liveRefRes.ok === false) {
      return { delivered: false, reason: liveRefRes.reason || "element_stale_in_background" };
    }
  }

  var localX = 0;
  var localY = 0;
  var screenX = 0;
  var screenY = 0;

  if ((hasLocalPoint || hasXY) && params.screenCoords !== true && params.expectedWindowSize && typeof params.expectedWindowSize === "object") {
    var expW = Number(params.expectedWindowSize.width || params.expectedWindowSize.w || 0);
    var expH = Number(params.expectedWindowSize.height || params.expectedWindowSize.h || 0);
    if (
      (expW > 0 && Math.abs(win.w - expW) > 4) ||
      (expH > 0 && Math.abs(win.h - expH) > 4)
    ) {
      return { delivered: false, reason: "window_resized" };
    }
  }

  if (hasLocalPoint) {
    var lpx = Number(params.localPoint.x);
    var lpy = Number(params.localPoint.y);
    if (lpx < 0 || lpy < 0 || lpx > win.w + 1 || lpy > win.h + 1) {
      return { delivered: false, reason: "out_of_bounds" };
    }
    localX = lpx;
    localY = lpy;
    screenX = win.x + localX;
    screenY = win.y + localY;
  } else if (elCenter) {
    screenX = elCenter.x;
    screenY = elCenter.y;
    localX = screenX - win.x;
    localY = screenY - win.y;
  } else if (hasElem && elemIdxStr === "0") {
    localX = win.w / 2;
    localY = win.h / 2;
    screenX = win.x + localX;
    screenY = win.y + localY;
  } else if (hasXY) {
    var rx = Number(params.x);
    var ry = Number(params.y);
    if (params.screenCoords === true) {
      screenX = rx;
      screenY = ry;
      localX = screenX - win.x;
      localY = screenY - win.y;
    } else {
      var fw = Number(params.frameWidth) > 0 ? Number(params.frameWidth) : win.w;
      var fh = Number(params.frameHeight) > 0 ? Number(params.frameHeight) : win.h;
      if (rx < 0 || ry < 0 || rx > fw + 1 || ry > fh + 1) {
        return { delivered: false, reason: "out_of_bounds" };
      }
      localX = (rx / fw) * win.w;
      localY = (ry / fh) * win.h;
      screenX = win.x + localX;
      screenY = win.y + localY;
    }
  } else {
    return { delivered: false, reason: "missing_target" };
  }

  var useSkyLight = Boolean(hasSkyLightWindowPost && win.wid > 0);
  if (!useSkyLight && params.allowAppPostFallback !== true) {
    return {
      delivered: false,
      method: null,
      reason: !hasSkyLightWindowPost ? "skylight_unavailable" : "window_id_unavailable"
    };
  }

  var btn = String(params.button || "left").toLowerCase();
  var downType = btn === "right" ? 3 : btn === "middle" ? 25 : 1;
  var upType = btn === "right" ? 4 : btn === "middle" ? 26 : 2;
  var cgBtn = btn === "right" ? 1 : btn === "middle" ? 2 : 0;
  var clickCount = Math.max(1, Math.min(3, Math.round(Number(params.clickCount) || 1)));

  function postStep(evType, clickState, pressure) {
    var src = null;
    var ev = null;
    try {
      src = $.CGEventSourceCreate(0);
      ev = $.CGEventCreateMouseEvent(src, evType, { x: screenX, y: screenY }, cgBtn);
      if (!src || !ev) return false;
      var ns = Math.floor($.NSProcessInfo.processInfo.systemUptime * 1e9);
      $.CGEventSetTimestamp(ev, ns);
      $.CGEventSetIntegerValueField(ev, $.kCGMouseEventClickState, clickState);
      $.CGEventSetIntegerValueField(ev, $.kCGMouseEventButtonNumber, cgBtn);
      if (pressure > 0) {
        $.CGEventSetDoubleValueField(ev, 38, pressure);
      }
      postSkyLightOrPidEvent(ev, pid, win.wid, localX, localY, useSkyLight, clickState, cgBtn, params.syntheticTag);
      return true;
    } finally {
      if (ev) { try { $.CFRelease(ev); } catch (e1) {} }
      if (src) { try { $.CFRelease(src); } catch (e2) {} }
    }
  }

  var anyPosted = false;
  var completedPairs = 0;
  try {
    if (postStep(5, 0, 0.0)) anyPosted = true;
    $.NSThread.sleepForTimeInterval(0.012);
    for (var c = 1; c <= clickCount; c++) {
      var dOk = postStep(downType, c, 1.0);
      if (dOk) anyPosted = true;
      $.NSThread.sleepForTimeInterval(0.022);
      var uOk = postStep(upType, c, 0.0);
      if (uOk) anyPosted = true;
      if (dOk && uOk) completedPairs += 1;
      if (c < clickCount) {
        $.NSThread.sleepForTimeInterval(0.028);
      }
    }
  } catch (postErr) {
    if (anyPosted) {
      return {
        delivered: false,
        deliveryState: "sent_unknown",
        method: useSkyLight ? "window_post" : "app_post",
        reason: "click_post_exception",
        wid: win.wid
      };
    }
    throw postErr;
  }

  if (!anyPosted) {
    return {
      delivered: false,
      method: null,
      reason: "event_post_failed",
      wid: win.wid
    };
  }
  if (completedPairs !== clickCount) {
    return {
      delivered: false,
      deliveryState: "sent_unknown",
      method: useSkyLight ? "window_post" : "app_post",
      reason: "partial_click_post",
      wid: win.wid
    };
  }

  return {
    delivered: true,
    method: useSkyLight ? "window_post" : "app_post",
    wid: win.wid,
    localX: Number(localX.toFixed(2)),
    localY: Number(localY.toFixed(2))
  };
}

var KEYCODE_MAP = (function () {
  var m = {
    a: 0, s: 1, d: 2, f: 3, h: 4, g: 5, z: 6, x: 7, c: 8, v: 9, b: 11,
    q: 12, w: 13, e: 14, r: 15, y: 16, t: 17, "1": 18, "2": 19, "3": 20,
    "4": 21, "6": 22, "5": 23, equal: 24, "=": 24, "9": 25, "7": 26,
    minus: 27, "-": 27, "8": 28, "0": 29, bracketright: 30, "]": 30,
    o: 31, u: 32, bracketleft: 33, "[": 33, i: 34, p: 35, l: 37, j: 38,
    apostrophe: 39, "'": 39, k: 40, semicolon: 41, ";": 41,
    comma: 43, ",": 43, slash: 44, "/": 44, n: 45, m: 46, period: 47, ".": 47,
    grave: 50,
    "return": 36, enter: 36, kp_enter: 76, tab: 48, space: 49, " ": 49,
    backspace: 51, "delete": 117, forwarddelete: 117, escape: 53, esc: 53,
    up: 126, arrowup: 126, down: 125, arrowdown: 125,
    left: 123, arrowleft: 123, right: 124, arrowright: 124,
    home: 115, end: 119, page_up: 116, pageup: 116, prior: 116,
    page_down: 121, pagedown: 121, next: 121,
    f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100,
    f9: 101, f10: 109, f11: 103, f12: 111, f13: 105, f14: 107, f15: 113,
    f16: 106, f17: 64, f18: 79, f19: 80, f20: 90,
    kp_0: 82, kp_1: 83, kp_2: 84, kp_3: 85, kp_4: 86, kp_5: 87, kp_6: 88,
    kp_7: 89, kp_8: 91, kp_9: 92, kp_decimal: 65, kp_multiply: 67,
    kp_plus: 69, kp_add: 69, kp_clear: 71, kp_divide: 75,
    kp_subtract: 78, kp_minus: 78, kp_equal: 81
  };
  m[String.fromCharCode(92)] = 42;
  m.backslash = 42;
  m[String.fromCharCode(96)] = 50;
  return m;
})();

var SHIFTED_ASCII_MAP = {
  "!": "1", "@": "2", "#": "3", "$": "4", "%": "5", "^": "6", "&": "7", "*": "8",
  "(": "9", ")": "0", "_": "-", "+": "=", "{": "[", "}": "]", "|": "backslash",
  ":": ";", "\"": "'", "<": ",", ">": ".", "?": "/", "~": "grave",
  exclam: "1", at: "2", numbersign: "3", dollar: "4", percent: "5",
  asciicircum: "6", ampersand: "7", asterisk: "8", parenleft: "9", parenright: "0",
  underscore: "-", plus: "=", braceleft: "[", braceright: "]", bar: "backslash",
  colon: ";", quotedbl: "'", less: ",", greater: ".", question: "/", asciitilde: "grave"
};

var MODIFIER_FLAG_MAP = {
  "super": 0x100000, super_l: 0x100000, super_r: 0x100000,
  cmd: 0x100000, command: 0x100000, meta: 0x100000, win: 0x100000,
  shift: 0x020000, shift_l: 0x020000, shift_r: 0x020000,
  ctrl: 0x040000, control: 0x040000, control_l: 0x040000, control_r: 0x040000,
  alt: 0x080000, option: 0x080000, opt: 0x080000, alt_l: 0x080000, alt_r: 0x080000
};

var STANDALONE_MOD_KEYCODE = {
  "super": 55, super_l: 55, super_r: 54, cmd: 55, command: 55, meta: 55,
  shift: 56, shift_l: 56, shift_r: 60,
  ctrl: 59, control: 59, control_l: 59, control_r: 62,
  alt: 58, option: 58, opt: 58, alt_l: 58, alt_r: 61
};

function parseKeyChord(chordStr) {
  var raw = String(chordStr || "").trim();
  if (!raw) return null;
  if (raw === "+") return { keyCode: 24, flags: 0x020000 };
  if (raw.length > 1 && raw.slice(-2) === "++") {
    var modPrefix = raw.slice(0, -2);
    if (!modPrefix || modPrefix.slice(-1) === "+") return null;
    var modParts = modPrefix.split("+");
    var plusFlags = 0;
    for (var m = 0; m < modParts.length; m++) {
      var mp = modParts[m].trim().toLowerCase();
      if (!mp || !MODIFIER_FLAG_MAP[mp]) return null;
      plusFlags = plusFlags | MODIFIER_FLAG_MAP[mp];
    }
    return { keyCode: 24, flags: plusFlags | 0x020000 };
  }
  var parts = raw.split("+");
  var flags = 0;
  for (var i = 0; i < parts.length - 1; i++) {
    var modToken = parts[i].trim().toLowerCase();
    if (!modToken || !MODIFIER_FLAG_MAP[modToken]) return null;
    flags = flags | MODIFIER_FLAG_MAP[modToken];
  }
  var keyToken = parts[parts.length - 1].trim();
  if (!keyToken) return null;
  var keyLower = keyToken.toLowerCase();
  if (parts.length === 1 && STANDALONE_MOD_KEYCODE[keyLower] !== undefined) {
    return { keyCode: STANDALONE_MOD_KEYCODE[keyLower], flags: MODIFIER_FLAG_MAP[keyLower] || 0 };
  }
  if (keyToken.length === 1 && keyToken >= "A" && keyToken <= "Z" && flags === 0) {
    flags = flags | 0x020000;
  }
  if (SHIFTED_ASCII_MAP[keyToken]) {
    flags = flags | 0x020000;
    keyLower = SHIFTED_ASCII_MAP[keyToken];
  } else if (SHIFTED_ASCII_MAP[keyLower]) {
    flags = flags | 0x020000;
    keyLower = SHIFTED_ASCII_MAP[keyLower];
  }
  var code = KEYCODE_MAP[keyLower];
  if (code === undefined) return null;
  return { keyCode: code, flags: flags };
}

function postRawKeyCode(pid, wid, keyCode, flags, syntheticTag) {
  var src = null;
  var down = null;
  var up = null;
  try {
    src = $.CGEventSourceCreate(0);
    down = $.CGEventCreateKeyboardEvent(src, keyCode, true);
    up = $.CGEventCreateKeyboardEvent(src, keyCode, false);
    if (!src || !down || !up) return;
    stampSyntheticUserData(down, syntheticTag);
    stampSyntheticUserData(up, syntheticTag);
    var nsDown = Math.floor($.NSProcessInfo.processInfo.systemUptime * 1e9);
    $.CGEventSetTimestamp(down, nsDown);
    $.CGEventSetFlags(down, flags || 0);
    if (hasSkyLightWindowPost) {
      $.SLEventSetIntegerValueField(down, 40, pid);
      if (wid > 0) $.SLEventSetIntegerValueField(down, 51, wid);
    }
    $.CGEventPostToPid(pid, down);
    $.NSThread.sleepForTimeInterval(0.010);
    var nsUp = Math.floor($.NSProcessInfo.processInfo.systemUptime * 1e9);
    $.CGEventSetTimestamp(up, nsUp);
    $.CGEventSetFlags(up, flags || 0);
    if (hasSkyLightWindowPost) {
      $.SLEventSetIntegerValueField(up, 40, pid);
      if (wid > 0) $.SLEventSetIntegerValueField(up, 51, wid);
    }
    $.CGEventPostToPid(pid, up);
  } finally {
    if (down) { try { $.CFRelease(down); } catch (e1) {} }
    if (up) { try { $.CFRelease(up); } catch (e2) {} }
    if (src) { try { $.CFRelease(src); } catch (e3) {} }
  }
}

function handleWindowKey(params) {
  var pid = Number(params.pid || 0);
  if (!pid || pid <= 0) return { delivered: false, reason: "invalid_pid" };
  var rawKey = String(params.key || "");
  if (!rawKey.trim()) return { delivered: false, reason: "empty_key" };

  var tokens = rawKey === " " ? ["space"] : rawKey.trim().split(/\s+/);
  var parsedChords = [];
  for (var i = 0; i < tokens.length; i++) {
    var parsed = parseKeyChord(tokens[i]);
    if (!parsed) {
      return { delivered: false, reason: "unsupported_key", key: tokens[i] };
    }
    parsedChords.push(parsed);
  }

  var reqWid = Number(params.wid || 0);
  var win = resolveTargetCgWindow(pid, params.windowTitle || "", reqWid > 0 ? reqWid : null, null, null);
  if (reqWid > 0 && (!win || !(win.wid > 0))) {
    return { delivered: false, reason: "window_not_found" };
  }
  var wid = win && win.wid > 0 ? win.wid : 0;

  for (var j = 0; j < parsedChords.length; j++) {
    postRawKeyCode(pid, wid, parsedChords[j].keyCode, parsedChords[j].flags, params.syntheticTag);
    if (j < parsedChords.length - 1) {
      $.NSThread.sleepForTimeInterval(0.012);
    }
  }
  return { delivered: true, wid: wid };
}

function postUnicodeChunk(pid, wid, chunkStr, syntheticTag) {
  var src = null;
  var down = null;
  var up = null;
  try {
    src = $.CGEventSourceCreate(0);
    down = $.CGEventCreateKeyboardEvent(src, 0, true);
    up = $.CGEventCreateKeyboardEvent(src, 0, false);
    if (!src || !down || !up) return;
    stampSyntheticUserData(down, syntheticTag);
    stampSyntheticUserData(up, syntheticTag);
    var nsStr = $(chunkStr);
    var uLen = Number(nsStr.length);
    var utf16Data = nsStr.dataUsingEncoding($.NSUTF16LittleEndianStringEncoding);
    if (!utf16Data || utf16Data.isNil()) return;
    $.CGEventSetTimestamp(down, Math.floor($.NSProcessInfo.processInfo.systemUptime * 1e9));
    $.CGEventSetFlags(down, 0);
    $.CGEventKeyboardSetUnicodeString(down, uLen, utf16Data.bytes);
    if (hasSkyLightWindowPost) {
      $.SLEventSetIntegerValueField(down, 40, pid);
      if (wid > 0) $.SLEventSetIntegerValueField(down, 51, wid);
    }
    $.CGEventPostToPid(pid, down);
    $.NSThread.sleepForTimeInterval(0.008);
    $.CGEventSetTimestamp(up, Math.floor($.NSProcessInfo.processInfo.systemUptime * 1e9));
    $.CGEventSetFlags(up, 0);
    $.CGEventKeyboardSetUnicodeString(up, uLen, utf16Data.bytes);
    if (hasSkyLightWindowPost) {
      $.SLEventSetIntegerValueField(up, 40, pid);
      if (wid > 0) $.SLEventSetIntegerValueField(up, 51, wid);
    }
    $.CGEventPostToPid(pid, up);
  } finally {
    if (down) { try { $.CFRelease(down); } catch (e1) {} }
    if (up) { try { $.CFRelease(up); } catch (e2) {} }
    if (src) { try { $.CFRelease(src); } catch (e3) {} }
  }
}

function handleWindowText(params) {
  var pid = Number(params.pid || 0);
  if (!pid || pid <= 0) return { delivered: false, reason: "invalid_pid" };
  if (!hasUnicodeKeyboardFn) return { delivered: false, reason: "unicode_fn_unavailable" };
  var text = String(params.text === undefined || params.text === null ? "" : params.text);
  if (!text.length) return { delivered: true, wid: 0 };

  var reqWid = Number(params.wid || 0);
  var win = resolveTargetCgWindow(pid, params.windowTitle || "", reqWid > 0 ? reqWid : null, null, null);
  if (reqWid > 0 && (!win || !(win.wid > 0))) {
    return { delivered: false, reason: "window_not_found" };
  }
  var wid = win && win.wid > 0 ? win.wid : 0;

  var CR = String.fromCharCode(13);
  var LF = String.fromCharCode(10);
  var TAB = String.fromCharCode(9);
  var i = 0;
  var cur = "";

  function flushRun() {
    if (!cur.length) return;
    postUnicodeChunk(pid, wid, cur, params.syntheticTag);
    cur = "";
    $.NSThread.sleepForTimeInterval(0.008);
  }

  while (i < text.length) {
    var ch = text.charAt(i);
    if (ch === CR) {
      flushRun();
      if (i + 1 < text.length && text.charAt(i + 1) === LF) i += 1;
      postRawKeyCode(pid, wid, 36, 0, params.syntheticTag);
      $.NSThread.sleepForTimeInterval(0.008);
      i += 1;
      continue;
    }
    if (ch === LF) {
      flushRun();
      postRawKeyCode(pid, wid, 36, 0, params.syntheticTag);
      $.NSThread.sleepForTimeInterval(0.008);
      i += 1;
      continue;
    }
    if (ch === TAB) {
      flushRun();
      postRawKeyCode(pid, wid, 48, 0, params.syntheticTag);
      $.NSThread.sleepForTimeInterval(0.008);
      i += 1;
      continue;
    }
    var code = text.charCodeAt(i);
    var nextCode = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
    var unitLen = (code >= 0xd800 && code <= 0xdbff && nextCode >= 0xdc00 && nextCode <= 0xdfff) ? 2 : 1;
    if (cur.length + unitLen > 16) {
      flushRun();
    }
    cur += text.slice(i, i + unitLen);
    i += unitLen;
  }
  flushRun();

  return { delivered: true, wid: wid };
}

function handleDropAppSnapshots(params) {
  var pid = Number(params.pid || 0);
  var snapshotIds = Array.isArray(params.snapshotIds) ? params.snapshotIds : [];
  for (var i = 0; i < snapshotIds.length; i++) {
    delete retainedSnapshots[String(snapshotIds[i])];
  }
  if (pid > 0) {
    for (var k in retainedSnapshots) {
      if (retainedSnapshots[k] && retainedSnapshots[k].pid === pid) {
        delete retainedSnapshots[k];
      }
    }
  }
  var nextOrder = [];
  for (var m = 0; m < retainedOrder.length; m++) {
    var sid = retainedOrder[m];
    if (retainedSnapshots[sid]) nextOrder.push(sid);
  }
  retainedOrder = nextOrder;
  return { ok: true };
}

var stdin = $.NSFileHandle.fileHandleWithStandardInput;
var stdout = $.NSFileHandle.fileHandleWithStandardOutput;
var NL = String.fromCharCode(10);
var buf = "";

function sendReply(payload) {
  var line = JSON.stringify(payload) + NL;
  var data = $(line).dataUsingEncoding($.NSUTF8StringEncoding);
  stdout.writeData(data);
}

while (true) {
  var chunkData = stdin.availableData;
  if (!chunkData || Number(chunkData.length) === 0) break;
  var chunkStr = ObjC.unwrap($.NSString.alloc.initWithDataEncoding(chunkData, $.NSUTF8StringEncoding));
  if (!chunkStr) continue;
  buf += chunkStr;
  if (buf.length > MAX_STDIN_BUFFER_CHARS) {
    buf = "";
    continue;
  }
  var idx;
  while ((idx = buf.indexOf(NL)) >= 0) {
    var rawLine = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!rawLine) continue;
    var req = null;
    try {
      req = JSON.parse(rawLine);
      var method = req.method;
      var p = req.params || {};
      var res;
      if (method === "ping") {
        if (p && Number(p.syntheticTag) > 0) SYNTHETIC_EVENT_TAG = Number(p.syntheticTag);
        res = { pong: true, syntheticTag: SYNTHETIC_EVENT_TAG };
      } else if (method === "set_synthetic_tag") {
        SYNTHETIC_EVENT_TAG = Number(p.syntheticTag || 0) || 0;
        res = { ok: true, syntheticTag: SYNTHETIC_EVENT_TAG };
      } else if (method === "permissions") res = handlePermissions();
      else if (method === "process_info") res = handleProcessInfo(p);
      else if (method === "find_running_app") res = handleFindRunningApp(p);
      else if (method === "frontmost_app") res = handleFrontmostApp();
      else if (method === "restore_frontmost") res = handleRestoreFrontmost(p);
      else if (method === "ensure_manual_ax") res = handleEnsureManualAx(p);
      else if (method === "bind_snapshot") res = handleBindSnapshot(p);
      else if (method === "verify_live_ref") res = handleVerifyLiveRef(p);
      else if (method === "verify_editable_focus") res = handleVerifyEditableFocus(p);
      else if (method === "insert_selected_text") res = handleInsertSelectedText(p);
      else if (method === "scroll") res = handleScroll(p);
      else if (method === "context_menu") res = handleContextMenu(p);
      else if (method === "window_click") res = handleWindowClick(p);
      else if (method === "window_scroll") res = handleWindowScroll(p);
      else if (method === "resolve_action_target") res = handleResolveActionTarget(p);
      else if (method === "focused_window") res = handleFocusedWindow(p);
      else if (method === "window_key") res = handleWindowKey(p);
      else if (method === "window_text") res = handleWindowText(p);
      else if (method === "drop_snapshots") res = handleDropAppSnapshots(p);
      else throw new Error("Unknown method: " + method);
      sendReply({ id: req.id, ok: true, result: res });
    } catch (err) {
      sendReply({
        id: req && req.id !== undefined ? req.id : null,
        ok: false,
        error: String((err && err.message) || err || "bridge_error")
      });
    }
  }
}
`;

const MUTATING_AX_BRIDGE_METHODS = new Set([
  "window_click",
  "window_key",
  "window_text",
  "window_scroll",
  "scroll",
  "context_menu",
  "insert_selected_text",
  "ensure_manual_ax",
  "restore_frontmost",
]);

export class PersistentAxBridge {
  #proc = null;
  #procGen = 0;
  #startingPromise = null;
  #nextId = 1;
  #pending = new Map();
  #sendChain = Promise.resolve();
  #processStartCache = new Map();
  #stdoutBuffer = "";
  #decoder = new StringDecoder("utf8");
  #closed = false;
  #enabled;
  #spawnFn;
  #syntheticEventTag = 0;

  constructor({
    enabled = process.platform === "darwin",
    spawnFn = spawn,
    syntheticEventTag = 0,
  } = {}) {
    this.#enabled = Boolean(enabled && (process.platform === "darwin" || spawnFn !== spawn));
    this.#spawnFn = spawnFn;
    this.#syntheticEventTag = Number(syntheticEventTag) || 0;
  }

  get syntheticEventTag() {
    return this.#syntheticEventTag;
  }

  setSyntheticEventTag(tag) {
    this.#syntheticEventTag = Number(tag) || 0;
    if (this.isRunning) {
      void this.request("set_synthetic_tag", { syntheticTag: this.#syntheticEventTag }, { timeoutMs: 800 }).catch(() => {});
    }
  }

  get enabled() {
    return Boolean(this.#enabled && !this.#closed);
  }

  get isRunning() {
    return Boolean(this.#proc && this.#proc.exitCode === null && !this.#proc.killed);
  }

  get pid() {
    return this.isRunning ? this.#proc?.pid || null : null;
  }

  #syncRefState() {
    if (!this.#proc) return;
    if (this.#pending.size > 0) {
      this.#proc.ref?.();
      this.#proc.stdout?.ref?.();
    } else {
      this.#proc.stdout?.unref?.();
      this.#proc.unref?.();
    }
  }

  async ensureStarted() {
    if (!this.#enabled || this.#closed) return false;
    if (this.isRunning) return true;
    if (this.#startingPromise) return this.#startingPromise;

    this.#startingPromise = new Promise((resolve) => {
      try {
        const gen = ++this.#procGen;
        const proc = this.#spawnFn("/usr/bin/osascript", ["-l", "JavaScript", "-e", BRIDGE_JXA_SOURCE], {
          stdio: ["pipe", "pipe", "pipe"],
        });
        this.#proc = proc;
        this.#stdoutBuffer = "";
        this.#decoder = new StringDecoder("utf8");

        proc.stdout.on("data", (chunk) => {
          if (this.#proc !== proc || this.#procGen !== gen) return;
          this.#onStdoutData(chunk, gen);
        });
        proc.stderr.on("data", () => {
          // Drain stderr to prevent pipe backpressure
        });
        proc.stdin.on("error", () => {
          // Handled on process close/exit
        });

        const onParentExit = () => {
          try {
            proc.kill("SIGKILL");
          } catch {}
        };
        process.once("exit", onParentExit);
        proc.__cleanupParentExit = () => {
          process.removeListener("exit", onParentExit);
        };

        let handledExit = false;
        const handleExit = (errOrReason) => {
          if (handledExit) return;
          handledExit = true;
          proc.__cleanupParentExit?.();
          const isCurrent = this.#proc === proc && this.#procGen === gen;
          if (isCurrent) {
            this.#proc = null;
            const leftover = this.#decoder.end();
            if (leftover) this.#stdoutBuffer += leftover;
            this.#stdoutBuffer = "";
          }
          const reason =
            errOrReason instanceof Error
              ? errOrReason
              : new Error(`PersistentAxBridge exited (${String(errOrReason ?? "closed")})`);
          for (const [reqId, entry] of this.#pending) {
            if (entry.gen !== gen) continue;
            this.#pending.delete(reqId);
            clearTimeout(entry.timer);
            if (entry.mutating && entry.dispatched) {
              const exitErr = new Error(reason.message);
              exitErr.code = "WRITE_OUTCOME_UNKNOWN";
              exitErr.deliveryState = "sent_unknown";
              exitErr.dispatched = true;
              entry.reject(exitErr);
            } else {
              entry.reject(reason);
            }
          }
          if (isCurrent) {
            this.#syncRefState();
          }
        };

        proc.once("error", (err) => {
          handleExit(err);
          resolve(false);
        });
        proc.once("close", (code, signal) => {
          handleExit(signal || code);
        });

        proc.stdout.unref?.();
        proc.stderr.unref?.();
        proc.stdin.unref?.();
        proc.unref?.();

        // Warmup ping so ObjC frameworks finish loading once on startup (bypasses #sendChain)
        this.#dispatchDirect("ping", { syntheticTag: this.#syntheticEventTag }, { timeoutMs: 3000 })
          .then(() => resolve(true))
          .catch(() => {
            if (this.#proc === proc && this.#procGen === gen) {
              this.#killImmediate("ping_failed");
            }
            resolve(false);
          });
      } catch {
        this.#proc = null;
        resolve(false);
      }
    }).finally(() => {
      this.#startingPromise = null;
    });

    return this.#startingPromise;
  }

  #onStdoutData(chunk, gen = this.#procGen) {
    this.#stdoutBuffer += this.#decoder.write(chunk);
    if (this.#stdoutBuffer.length > MAX_LINE_BUFFER_BYTES) {
      this.#stdoutBuffer = "";
      this.#killImmediate("buffer_overflow");
      return;
    }

    let nl;
    while ((nl = this.#stdoutBuffer.indexOf("\n")) >= 0) {
      const line = this.#stdoutBuffer.slice(0, nl).trim();
      this.#stdoutBuffer = this.#stdoutBuffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (!msg || typeof msg !== "object" || Array.isArray(msg) || msg.id === undefined || msg.id === null) {
        continue;
      }
      const entry = this.#pending.get(msg.id);
      if (!entry || entry.gen !== gen) continue;
      this.#pending.delete(msg.id);
      clearTimeout(entry.timer);
      this.#syncRefState();
      if (msg.ok) {
        entry.resolve(msg.result);
      } else {
        entry.reject(new Error(msg.error || "ax_bridge_error"));
      }
    }
  }

  #killImmediate(reason = "killed") {
    const proc = this.#proc;
    const gen = this.#procGen;
    this.#proc = null;
    this.#stdoutBuffer = "";
    this.#decoder = new StringDecoder("utf8");
    if (proc) {
      try {
        proc.stdin?.end();
      } catch {}
      try {
        proc.kill("SIGKILL");
      } catch {}
    }
    const errMsg = `PersistentAxBridge reset (${reason})`;
    for (const [reqId, entry] of this.#pending) {
      if (entry.gen !== gen) continue;
      this.#pending.delete(reqId);
      clearTimeout(entry.timer);
      const entryErr = new Error(errMsg);
      if (entry.mutating && entry.dispatched) {
        entryErr.code = "WRITE_OUTCOME_UNKNOWN";
        entryErr.deliveryState = "sent_unknown";
        entryErr.dispatched = true;
      }
      entry.reject(entryErr);
    }
  }

  request(method, params = {}, { timeoutMs = DEFAULT_CALL_TIMEOUT_MS, beforeWriteCheck = null } = {}) {
    if (!this.#enabled || this.#closed) {
      return Promise.reject(new Error("PersistentAxBridge is disabled or closed"));
    }
    const run = this.#sendChain.then(
      () => this.#dispatchDirect(method, params, { timeoutMs, beforeWriteCheck }),
      () => this.#dispatchDirect(method, params, { timeoutMs, beforeWriteCheck })
    );
    this.#sendChain = run.catch(() => {});
    return run;
  }

  async #dispatchDirect(
    method,
    params = {},
    { timeoutMs = DEFAULT_CALL_TIMEOUT_MS, beforeWriteCheck = null } = {}
  ) {
    if (!this.#enabled || this.#closed) {
      throw new Error("PersistentAxBridge is disabled or closed");
    }
    if (typeof beforeWriteCheck === "function") {
      beforeWriteCheck();
    }
    if (!this.isRunning && method !== "ping") {
      const ok = await this.ensureStarted();
      if (!ok || !this.isRunning) {
        throw new Error("Failed to start PersistentAxBridge");
      }
    }
    if (typeof beforeWriteCheck === "function") {
      beforeWriteCheck();
    }
    if (!this.#proc?.stdin?.writable) {
      throw new Error("PersistentAxBridge stdin not writable");
    }

    const proc = this.#proc;
    const gen = this.#procGen;
    const id = this.#nextId++;
    const mutating = MUTATING_AX_BRIDGE_METHODS.has(method);
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, timer: null, gen, mutating, dispatched: false };
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        this.#syncRefState();
        const err = new Error(`PersistentAxBridge timeout on ${method} (${timeoutMs}ms)`);
        if (mutating) {
          err.code = "WRITE_OUTCOME_UNKNOWN";
          err.deliveryState = "sent_unknown";
          err.dispatched = true;
        }
        const waitExit =
          mutating && proc && proc.exitCode === null && typeof proc.once === "function"
            ? new Promise((done) => {
                const t = setTimeout(done, 180);
                t.unref?.();
                proc.once("exit", () => {
                  clearTimeout(t);
                  done();
                });
              })
            : Promise.resolve();
        // A hung synchronous AX call wedges the single-threaded JXA worker -> recycle cleanly
        if (this.#proc === proc && this.#procGen === gen) {
          this.#killImmediate(`timeout:${method}`);
        }
        void waitExit.finally(() => reject(err));
      }, timeoutMs);
      entry.timer = timer;

      this.#pending.set(id, entry);
      this.#syncRefState();

      try {
        // ASCII-escape all non-ASCII UTF-16 code units (including surrogate pairs for emoji)
        // so OS pipe splits can NEVER bisect a multi-byte UTF-8 sequence
        const wireJson = JSON.stringify({ id, method, params }).replace(
          /[\u007f-\uffff]/g,
          (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`
        );
        entry.dispatched = true;
        proc.stdin.write(`${wireJson}\n`);
      } catch (err) {
        this.#pending.delete(id);
        clearTimeout(timer);
        this.#syncRefState();
        reject(err);
      }
    });
  }

  async checkPermissions() {
    return this.request("permissions", {}, { timeoutMs: 1800 });
  }

  async #ensureProcessToken(res) {
    const pid = Number(res?.pid || 0);
    if (!res || !res.alive) {
      if (pid > 0) this.#processStartCache.delete(pid);
      return res;
    }
    if (!res.processToken && process.platform === "darwin" && Number.isInteger(pid) && pid > 0) {
      const now = Date.now();
      let cached = this.#processStartCache.get(pid);
      if (cached && now - cached.at >= 2000) {
        cached = null;
        this.#processStartCache.delete(pid);
      }
      if (!cached) {
        try {
          const { stdout } = await execFileAsync("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
            timeout: 1200,
            env: { ...process.env, LC_ALL: "C" },
          });
          const ms = Date.parse(String(stdout || "").trim());
          if (Number.isFinite(ms)) {
            const ts = Math.floor(ms / 1000);
            cached = { launchTs: ts, processToken: `${pid}:${ts.toFixed(6)}`, at: now };
            if (this.#processStartCache.size >= 256) {
              this.#processStartCache.clear();
            }
            this.#processStartCache.set(pid, cached);
          }
        } catch {}
      }
      if (cached) {
        return {
          ...res,
          launchTs: cached.launchTs,
          processToken: cached.processToken,
        };
      }
    }
    return res;
  }

  async getProcessInfo(pid) {
    const res = await this.request("process_info", { pid }, { timeoutMs: 1000 });
    return this.#ensureProcessToken(res);
  }

  async findRunningApp(appQuery) {
    const res = await this.request("find_running_app", { appQuery }, { timeoutMs: 1200 });
    return this.#ensureProcessToken(res);
  }

  async getFrontmostApp() {
    return this.request("frontmost_app", {}, { timeoutMs: 1000 });
  }

  async restoreFrontmostAppDetailed(pid, opts = {}) {
    const res = await this.request(
      "restore_frontmost",
      { pid, ...(opts || {}) },
      { timeoutMs: 1200 }
    );
    return {
      ok: Boolean(res?.ok),
      reason: res?.reason || null,
      definitive: res?.definitive === true,
    };
  }

  async restoreFrontmostApp(pid, opts = {}) {
    const det = await this.restoreFrontmostAppDetailed(pid, opts);
    return det.ok;
  }

  async ensureManualAccessibility(pid) {
    return this.request("ensure_manual_ax", { pid }, { timeoutMs: 1200 });
  }

  async bindSnapshot({ snapshotId, pid, windowTitle, elements }) {
    const serialized = [];
    if (elements instanceof Map) {
      for (const [, el] of elements.entries()) {
        serialized.push({
          index: el.index,
          role: el.role || "",
          identifier: el.identifier || null,
          rawText: el.rawText || "",
          help: el.help || null,
          isSecure: Boolean(el.isSecure),
        });
      }
    } else if (Array.isArray(elements)) {
      serialized.push(...elements);
    }
    return this.request(
      "bind_snapshot",
      { snapshotId, pid, windowTitle: windowTitle || "", elements: serialized },
      { timeoutMs: 2200 }
    );
  }

  async verifyLiveRef({ snapshotId, elementIndex = null, expectedPid = null, requireBound = false }) {
    return this.request(
      "verify_live_ref",
      { snapshotId, elementIndex, expectedPid, requireBound },
      { timeoutMs: 1400 }
    );
  }

  async verifyEditableFocus(pid, { snapshotId = null, elementIndex = null, elementMeta = null } = {}) {
    return this.request(
      "verify_editable_focus",
      { pid, snapshotId, elementIndex, elementMeta },
      { timeoutMs: 1000 }
    );
  }

  async insertSelectedText(pid, text, { beforeWriteCheck = null } = {}) {
    return this.request("insert_selected_text", { pid, text }, { timeoutMs: 1800, beforeWriteCheck });
  }

  async scroll(
    pid,
    { snapshotId = null, elementIndex = null, elementMeta = null, direction = "down", pages = 1, beforeWriteCheck = null } = {}
  ) {
    return this.request(
      "scroll",
      { pid, snapshotId, elementIndex, elementMeta, direction, pages },
      { timeoutMs: 2200, beforeWriteCheck }
    );
  }

  async triggerContextMenu(
    pid,
    { snapshotId = null, elementIndex = null, elementMeta = null, beforeWriteCheck = null } = {}
  ) {
    return this.request(
      "context_menu",
      { pid, snapshotId, elementIndex, elementMeta },
      { timeoutMs: 1800, beforeWriteCheck }
    );
  }

  async postWindowClick(
    pid,
    {
      snapshotId = null,
      elementIndex = null,
      elementMeta = null,
      localPoint = null,
      expectedWindowSize = null,
      x = null,
      y = null,
      frameWidth = 0,
      frameHeight = 0,
      screenCoords = false,
      windowTitle = "",
      wid = null,
      windowBounds = null,
      button = "left",
      clickCount = 1,
      allowAppPostFallback = false,
      syntheticTag = null,
      beforeWriteCheck = null,
    } = {}
  ) {
    const res = await this.request(
      "window_click",
      {
        pid,
        snapshotId,
        elementIndex,
        elementMeta,
        localPoint,
        expectedWindowSize,
        x,
        y,
        frameWidth,
        frameHeight,
        screenCoords,
        windowTitle,
        wid,
        windowBounds,
        button,
        clickCount,
        allowAppPostFallback,
        syntheticTag: syntheticTag ?? this.#syntheticEventTag,
      },
      { timeoutMs: 2200, beforeWriteCheck }
    );
    return throwIfSentUnknown(res, "PersistentAxBridge partial click delivery");
  }

  async getFocusedWindowInfo(pid, { windowTitle = "" } = {}) {
    if (!Number.isInteger(pid) || pid <= 0 || !this.enabled) return null;
    return this.request("focused_window", { pid, windowTitle }, { timeoutMs: 800 }).catch(() => null);
  }

  async postWindowScroll(
    pid,
    {
      direction = "down",
      pages = 0.7,
      deltaY = null,
      deltaX = null,
      steps = null,
      localPoint = null,
      windowTitle = "",
      wid = null,
      windowBounds = null,
      allowAppPostFallback = false,
      syntheticTag = null,
      beforeWriteCheck = null,
    } = {}
  ) {
    return this.request(
      "window_scroll",
      {
        pid,
        direction,
        pages,
        deltaY,
        deltaX,
        steps,
        localPoint,
        windowTitle,
        wid,
        windowBounds,
        allowAppPostFallback,
        syntheticTag: syntheticTag ?? this.#syntheticEventTag,
      },
      { timeoutMs: 2200, beforeWriteCheck }
    );
  }

  async resolveActionTarget(
    pid,
    {
      snapshotId = null,
      elementIndex = null,
      elementMeta = null,
      localPoint = null,
      windowTitle = "",
      wid = null,
      windowBounds = null,
    } = {}
  ) {
    return this.request(
      "resolve_action_target",
      { pid, snapshotId, elementIndex, elementMeta, localPoint, windowTitle, wid, windowBounds },
      { timeoutMs: 1400 }
    );
  }

  async postWindowKey(pid, { key, windowTitle = "", wid = null, syntheticTag = null, beforeWriteCheck = null } = {}) {
    return this.request(
      "window_key",
      { pid, key, windowTitle, wid, syntheticTag: syntheticTag ?? this.#syntheticEventTag },
      { timeoutMs: 2200, beforeWriteCheck }
    );
  }

  async postWindowText(pid, { text, windowTitle = "", wid = null, syntheticTag = null, beforeWriteCheck = null } = {}) {
    const str = String(text ?? "");
    const specialCount = (str.match(/[\r\n\t]/gu) || []).length;
    const dynamicTimeout = Math.max(
      2500,
      Math.min(30_000, 1500 + str.length * 15 + specialCount * 45)
    );
    return this.request(
      "window_text",
      { pid, text, windowTitle, wid, syntheticTag: syntheticTag ?? this.#syntheticEventTag },
      { timeoutMs: dynamicTimeout, beforeWriteCheck }
    );
  }

  async dropSnapshots({ pid = null, snapshotIds = [] } = {}) {
    if (!this.isRunning) return { ok: true };
    return this.request("drop_snapshots", { pid, snapshotIds }, { timeoutMs: 800 }).catch(() => ({
      ok: false,
    }));
  }

  async close() {
    this.#closed = true;
    const proc = this.#proc;
    this.#proc = null;
    const err = new Error("PersistentAxBridge closed");
    for (const [, entry] of this.#pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.#pending.clear();

    if (!proc) return;
    proc.__cleanupParentExit?.();
    await new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(killTimer);
        resolve();
      };
      proc.once("close", finish);
      const killTimer = setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {}
        finish();
      }, 180);
      try {
        proc.stdin?.end();
      } catch {
        try {
          proc.kill("SIGTERM");
        } catch {}
      }
    });
  }
}

let sharedAxBridge = null;

export function getSharedAxBridge() {
  if (!sharedAxBridge) {
    sharedAxBridge = new PersistentAxBridge();
  }
  return sharedAxBridge;
}

export async function closeSharedAxBridge() {
  if (!sharedAxBridge) return;
  const instance = sharedAxBridge;
  sharedAxBridge = null;
  await instance.close();
}
