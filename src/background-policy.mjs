import { execFile } from "node:child_process";
import crypto from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  SECURE_ROLE_RE,
  isSecureTextRole,
  buildElementDescriptor,
} from "./app-snapshot-registry.mjs";
import { rethrowIfWriteOutcomeUnknown, throwIfSentUnknown } from "./ax-bridge.mjs";

export { SECURE_ROLE_RE, isSecureTextRole };

const execFileAsync = promisify(execFile);

/**
 * Extract text content from an MCP CallToolResult.
 */
export function extractResultText(result) {
  return (result?.content ?? [])
    .filter((item) => item?.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n");
}

/**
 * Extract first image item ({ data, mimeType }) from an MCP CallToolResult.
 */
export function extractResultImage(result) {
  return (result?.content ?? []).find(
    (item) => item?.type === "image" && typeof item.data === "string"
  );
}

/**
 * Parse JPEG / PNG / WebP dimensions directly from image bytes in <0.1ms.
 */
export function parseImageDimensions(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 16) return null;

  // PNG: signature 89 50 4E 47 0D 0A 1A 0A + IHDR width/height at bytes 16..23
  if (
    bytes.length >= 24 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return {
      width: bytes.readUInt32BE(16),
      height: bytes.readUInt32BE(20),
    };
  }

  // JPEG: scan markers for SOF0..SOF3, SOF5..SOF7, SOF9..SOF11, SOF13..SOF15
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset++;
        continue;
      }
      while (offset < bytes.length && bytes[offset] === 0xff) offset++;
      if (offset >= bytes.length) break;
      const marker = bytes[offset++];
      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
        continue;
      }
      if (offset + 2 > bytes.length) break;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) break;
      const isSOF =
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf);
      if (isSOF && length >= 7) {
        return {
          height: bytes.readUInt16BE(offset + 3),
          width: bytes.readUInt16BE(offset + 5),
        };
      }
      offset += length;
    }
  }

  // WebP: RIFF....WEBPVP8X / VP8 / VP8L
  if (
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  ) {
    const chunk = bytes.toString("ascii", 12, 16);
    if (chunk === "VP8X" && bytes.length >= 30) {
      return {
        width: 1 + bytes.readUIntLE(24, 3),
        height: 1 + bytes.readUIntLE(27, 3),
      };
    }
    if (chunk === "VP8L" && bytes.length >= 25 && bytes[20] === 0x2f) {
      const b0 = bytes[21];
      const b1 = bytes[22];
      const b2 = bytes[23];
      const b3 = bytes[24];
      return {
        width: 1 + (((b1 & 0x3f) << 8) | b0),
        height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)),
      };
    }
  }

  return null;
}

/**
 * Parse OpenComputerUse `list_apps` text output into structured entries.
 */
export function parseAppsList(text) {
  if (!text || !text.trim() || /^No running top-level apps/u.test(text.trim())) {
    return [];
  }
  return text
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return null;
      const match = /^(.*?)\s+(?:—|--)\s+(.+?)\s+\[([^\]]*)\]$/u.exec(trimmed);
      if (!match) {
        return { displayName: trimmed, bundleId: trimmed, isRunning: false, isFrontmost: false };
      }
      const [, displayName, bundleId, rawFlags] = match;
      const flags = rawFlags.split(/,\s*/);
      return {
        displayName: displayName.trim(),
        bundleId: bundleId.trim(),
        isRunning: flags.includes("running"),
        isFrontmost: flags.includes("frontmost"),
      };
    })
    .filter(Boolean);
}

/**
 * Fast O(1) kernel check (~0.002ms) for whether a known PID is still alive,
 * without touching NSWorkspace or launching anything.
 */
export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

/**
 * Find a currently-running app entry in parsed `list_apps` output by bundleId or display name.
 */
export function findRunningApp(apps, appQuery) {
  if (typeof appQuery !== "string" || !Array.isArray(apps)) return null;
  const needle = appQuery.trim().replace(/\.app$/iu, "").toLowerCase();
  const rawNeedle = appQuery.trim().toLowerCase();
  if (!needle) return null;
  return (
    apps.find((a) => {
      if (!a.isRunning) return false;
      const bid = a.bundleId?.toLowerCase();
      const name = a.displayName?.toLowerCase();
      return bid === rawNeedle || name === rawNeedle || name === needle;
    }) || null
  );
}

/**
 * Distinguish macOS CFBundleIdentifiers (e.g. "com.google.GeminiMacOS", "com.jetbrains.pycharm_ce")
 * from app names or ".app" bundle names (e.g. "Firefox.app", "Safari").
 */
export function isLikelyBundleId(appQuery) {
  if (typeof appQuery !== "string") return false;
  const trimmed = appQuery.trim();
  if (!trimmed || trimmed.startsWith("-") || /\.app$/iu.test(trimmed)) return false;
  return /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)+$/u.test(trimmed);
}

function sanitizeAppQuery(appQuery) {
  if (typeof appQuery !== "string") return null;
  const trimmed = appQuery.trim();
  if (!trimmed || trimmed.startsWith("-")) return null;
  return trimmed;
}

const MULTIWORD_ROLE_LINE_RE =
  /^\t*(\d+)\s+((?:secure\s+text\s+field|search\s+text\s+field|text\s+field|text\s+area|pop\s+up\s+button|menu\s+button|radio\s+button|toggle\s+button|check\s+box|combo\s+box|scroll\s+area|scroll\s+bar|split\s+group|tab\s+group|radio\s+group|web\s+area|standard\s+window|system\s+dialog|outline\s+row|table\s+row|menu\s+bar\s+item|menu\s+item|toolbar\s+button|disclosure\s+triangle|color\s+well|level\s+indicator|static\s+text))\b(?:\s+(.*))?$/iu;

/**
 * Parse OpenComputerUse `get_app_state` text output into rich metadata + element descriptors.
 */
export function parseSnapshotMetadata(text) {
  const meta = {
    bundleId: null,
    pid: null,
    windowTitle: null,
    appDisplayName: null,
    occludedNote: false,
    elementsPartial: false,
    elements: new Map(),
  };
  if (!text) return meta;

  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (!meta.bundleId) {
      const appMatch = /^App=([^\s]+)\s+\(pid\s+(\d+)\)/u.exec(line);
      if (appMatch) {
        meta.bundleId = appMatch[1];
        meta.pid = Number.parseInt(appMatch[2], 10);
        continue;
      }
    }
    if (!meta.windowTitle) {
      const winMatch = /^Window:\s+"(.*)",\s+App:\s+(.+)\.$/u.exec(line);
      if (winMatch) {
        meta.windowTitle = winMatch[1];
        meta.appDisplayName = winMatch[2];
        continue;
      }
    }
    if (line.startsWith("Note: this window is covered or on another Space")) {
      meta.occludedNote = true;
      continue;
    }
    if (/^\s*(?:\[\d+\s+more\b|\.\.\.|.*?\b(?:truncated|omitted)\b)/iu.test(line)) {
      meta.elementsPartial = true;
    }
    const elMatch =
      MULTIWORD_ROLE_LINE_RE.exec(line) || /^\t*(\d+)\s+([^\s]+)(?:\s+(.*))?$/u.exec(line);
    if (elMatch) {
      const index = elMatch[1];
      const role = elMatch[2];
      const tail = elMatch[3] || "";
      const secMatch = /\bSecondary Actions:\s*(.+?)(?=\s+(?:Help|ID):|$)/u.exec(tail);
      const helpMatch = /\bHelp:\s*(.+?)(?=\s+(?:Secondary Actions|ID):|$)/u.exec(tail);
      const idMatch = /\bID:\s*(.+?)(?=\s+(?:Secondary Actions|Help):|$)/u.exec(tail);

      const secondaryActions = secMatch
        ? secMatch[1]
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : [];
      const help = helpMatch ? helpMatch[1].trim() : null;
      const identifier = idMatch ? idMatch[1].trim() : null;

      const rest = tail
        .replace(/,?\s*\bSecondary Actions:.*$/u, "")
        .replace(/\s+\bHelp:.*$/u, "")
        .replace(/\s+\bID:.*$/u, "")
        .trim();

      meta.elements.set(
        index,
        buildElementDescriptor({
          index,
          role,
          primaryText: rest,
          identifier,
          help,
          secondaryActions,
        })
      );
    }
  }
  return meta;
}

/**
 * Detect Qt6 mini floating dialog subwindows (e.g. 剪映's 92x92 `0 对话框` with no business child nodes)
 * that hijack `AXMainWindow` / `AXFocusedWindow`.
 */
export function isMiniEmptyDialogSnapshot(text, imgDims = null) {
  if (!text || typeof text !== "string") return false;
  if (imgDims && Number(imgDims.width) >= 600 && Number(imgDims.height) >= 400) {
    return false;
  }
  const meta = parseSnapshotMetadata(text);
  if (meta.elementsPartial) return false;
  const root = meta.elements.get("0");
  if (!root || !/^(?:对话框|系统对话框|(?:system\s+)?dialog)$/iu.test(String(root.role || "").trim())) {
    return false;
  }
  for (const [idx, el] of meta.elements.entries()) {
    if (idx === "0") continue;
    const role = String(el.role || "").trim();
    const isWindowChromeOnly =
      !el.primaryText &&
      !el.identifier &&
      /^(?:关闭按钮|最小化按钮|缩放按钮|全屏按钮|close\s+button|minimize\s+button|zoom\s+button|full\s*screen\s+button)$/iu.test(
        role
      );
    if (!isWindowChromeOnly) {
      return false;
    }
  }
  return true;
}

/**
 * Redact password/secret values, labels, and tooltips from raw `get_app_state` text lines
 * so outbound MCP tool results never leak secure field contents.
 */
export function redactSecureSnapshotText(text) {
  if (!text || typeof text !== "string") return text;
  const lines = text.split(/\r?\n/);
  let mutated = false;
  const out = lines.map((line) => {
    const elMatch =
      MULTIWORD_ROLE_LINE_RE.exec(line) || /^(\t*)(\d+)\s+([^\s]+)(?:\s+(.*))?$/u.exec(line);
    if (!elMatch) return line;
    const isMulti = elMatch.length === 4;
    const indent = isMulti ? (/^\t*/u.exec(line)?.[0] || "") : elMatch[1];
    const index = isMulti ? elMatch[1] : elMatch[2];
    const role = isMulti ? elMatch[2] : elMatch[3];
    const tail = (isMulti ? elMatch[3] : elMatch[4]) || "";
    if (!isSecureTextRole(role)) return line;

    const secMatch = /\bSecondary Actions:\s*(.+?)(?=\s+(?:Help|ID):|$)/u.exec(tail);
    const idMatch = /\bID:\s*(.+?)(?=\s+(?:Secondary Actions|Help):|$)/u.exec(tail);
    const rest = tail
      .replace(/,?\s*\bSecondary Actions:.*$/u, "")
      .replace(/\s+\bHelp:.*$/u, "")
      .replace(/\s+\bID:.*$/u, "")
      .trim();
    const hasHelp = /\bHelp:\s*/u.test(tail);
    if (!rest && !hasHelp) return line;

    mutated = true;
    const parts = [`${indent}${index} ${role}`];
    if (rest) parts.push("[redacted]");
    if (secMatch) parts.push(`Secondary Actions: ${secMatch[1].trim()}`);
    if (idMatch) parts.push(`ID: ${idMatch[1].trim()}`);
    return parts.join(" ");
  });
  return mutated ? out.join("\n") : text;
}

export function redactToolResultSecureText(result) {
  if (!result || !Array.isArray(result.content)) return result;
  let changed = false;
  const nextContent = result.content.map((item) => {
    if (item?.type === "text" && typeof item.text === "string") {
      const redacted = redactSecureSnapshotText(item.text);
      if (redacted !== item.text) {
        changed = true;
        return { ...item, text: redacted };
      }
    }
    return item;
  });
  return changed ? { ...result, content: nextContent } : result;
}

/**
 * Launch an app on macOS in the background WITHOUT bringing it to the foreground (-g).
 */
export async function launchAppInBackground(appQuery) {
  if (process.platform !== "darwin") return false;
  const target = sanitizeAppQuery(appQuery);
  if (!target) return false;
  const flag = isLikelyBundleId(target) ? "-b" : "-a";
  try {
    await execFileAsync("/usr/bin/open", ["-g", flag, target], { timeout: 6000 });
    await new Promise((r) => setTimeout(r, 450));
    return true;
  } catch {
    return false;
  }
}

/**
 * Unhide a hidden (Cmd+H) macOS app in-place behind the active app WITHOUT activating it.
 * Supports unhiding by PID or by bundle identifier / localized app name.
 */
export async function unhideAppWithoutActivating(pid, appQuery = null) {
  if (process.platform !== "darwin") return false;
  let script = null;
  if (Number.isInteger(pid) && pid > 0) {
    script = `ObjC.import("AppKit"); var a = $.NSRunningApplication.runningApplicationWithProcessIdentifier(${pid}); if (a && !a.isNil()) { a.unhide(); "ok"; } else { "none"; }`;
  } else {
    const target = sanitizeAppQuery(appQuery);
    if (!target) return false;
    const needleLiteral = JSON.stringify(target.replace(/\.app$/iu, "").toLowerCase());
    const rawLiteral = JSON.stringify(target.toLowerCase());
    script = `ObjC.import("AppKit"); var apps = $.NSWorkspace.sharedWorkspace.runningApplications; var n = apps.count; var hit = false; for (var i = 0; i < n; i++) { var a = apps.objectAtIndex(i); var bid = a.bundleIdentifier.isNil() ? "" : ObjC.unwrap(a.bundleIdentifier).toLowerCase(); var nm = a.localizedName.isNil() ? "" : ObjC.unwrap(a.localizedName).toLowerCase(); if (bid === ${rawLiteral} || nm === ${rawLiteral} || nm === ${needleLiteral}) { a.unhide(); hit = true; } } hit ? "ok" : "none";`;
  }
  try {
    await execFileAsync("/usr/bin/osascript", ["-l", "JavaScript", "-e", script], { timeout: 3000 });
    await new Promise((r) => setTimeout(r, 150));
    return true;
  } catch {
    return false;
  }
}

/**
 * Explicitly bring an app to the foreground ONLY when the user clicks "置顶" in the UI.
 */
export async function bringAppToFrontExplicit(appQuery, pid) {
  if (process.platform !== "darwin") return false;
  if (Number.isInteger(pid) && pid > 0 && isProcessAlive(pid)) {
    const script = `ObjC.import("AppKit"); var a = $.NSRunningApplication.runningApplicationWithProcessIdentifier(${pid}); if (a && !a.isNil()) { a.unhide(); a.activateWithOptions(3); "ok"; }`;
    try {
      await execFileAsync("/usr/bin/osascript", ["-l", "JavaScript", "-e", script], { timeout: 3000 });
      return true;
    } catch {}
  }
  const target = sanitizeAppQuery(appQuery);
  if (!target) return false;
  try {
    await execFileAsync("/usr/bin/open", [isLikelyBundleId(target) ? "-b" : "-a", target], { timeout: 4000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Parse `/usr/bin/lsappinfo info -only pid -only bundleid <asn>` output,
 * including line-1 localized display name (e.g. `"剪映专业版" ASN:0x0-...:`).
 */
export function parseLsappinfoFront(rawOutput) {
  if (typeof rawOutput !== "string" || !rawOutput.trim()) return null;
  const pidMatch = /\bpid\s*=\s*(\d+)/u.exec(rawOutput);
  if (!pidMatch) return null;
  const pid = Number.parseInt(pidMatch[1], 10);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const bundleMatch = /\bbundleID="([^"]+)"/u.exec(rawOutput);
  const headerNameMatch = /^\s*"([^"]+)"\s+ASN:/mu.exec(rawOutput);
  const lsDisplayMatch = /\bLSDisplayName="([^"]+)"/u.exec(rawOutput);
  const rawName = (headerNameMatch?.[1] || lsDisplayMatch?.[1] || "").trim();
  return {
    pid,
    bundleId: bundleMatch ? bundleMatch[1] : null,
    displayName: rawName || null,
  };
}

export {
  matchesTargetIdentity,
  didTargetStealFocus,
  planBackgroundClickMethods,
  planBackgroundKeyMethods,
} from "./focus-policy-guard.mjs";

/**
 * Sub-millisecond (~0.5ms via warm `axBridge`) or fast (~10ms via `lsappinfo`) read-only query
 * of the current frontmost macOS GUI application.
 */
export async function getFrontmostAppFast({ axBridge = null } = {}) {
  if (process.platform !== "darwin") return null;
  if (axBridge && typeof axBridge.getFrontmostApp === "function") {
    try {
      const info = await axBridge.getFrontmostApp();
      if (info?.pid > 0) return info;
    } catch {}
  }
  try {
    const { stdout: asnOut } = await execFileAsync("/usr/bin/lsappinfo", ["front"], { timeout: 1200 });
    const asn = String(asnOut || "").trim();
    if (!asn || asn.startsWith("-") || !/^ASN:/u.test(asn)) return null;
    const { stdout: infoOut } = await execFileAsync(
      "/usr/bin/lsappinfo",
      ["info", "-only", "pid", "-only", "bundleid", asn],
      { timeout: 1200 }
    );
    return parseLsappinfoFront(infoOut);
  } catch {
    return null;
  }
}

/**
 * Restore keyboard/window focus back to `pid` immediately (<1ms via warm `axBridge`, or `osascript` fallback)
 * if a background target app (e.g. Qt/剪映) self-activated.
 * Uses NSApplicationActivateIgnoringOtherApps (2) so only the user's previously active window returns to front.
 */
export async function restoreFrontmostAppFast(
  pid,
  {
    axBridge = null,
    expectedFrontmostPid = null,
    expectedFrontmostProcessToken = null,
    expectedRestoreProcessToken = null,
  } = {}
) {
  if (process.platform !== "darwin") return false;
  if (!Number.isInteger(pid) || pid <= 0 || !isProcessAlive(pid)) return false;
  const opts = {
    expectedFrontmostPid,
    expectedFrontmostProcessToken,
    expectedRestoreProcessToken,
  };
  if (axBridge && typeof axBridge.restoreFrontmostAppDetailed === "function") {
    try {
      const det = await axBridge.restoreFrontmostAppDetailed(pid, opts);
      if (det?.ok) return true;
      if (det?.definitive) return false;
    } catch {}
  } else if (axBridge && typeof axBridge.restoreFrontmostApp === "function") {
    try {
      const ok = await axBridge.restoreFrontmostApp(pid, opts);
      if (ok) return true;
    } catch {}
  }
  const expFrontLit = Number(expectedFrontmostPid) > 0 ? Number(expectedFrontmostPid) : 0;
  const expFrontTokLit = JSON.stringify(expectedFrontmostProcessToken || "");
  const expRestoreTokLit = JSON.stringify(expectedRestoreProcessToken || "");
  const script = [
    'ObjC.import("AppKit");',
    'function tokOf(app) { if (!app || app.isNil() || !app.launchDate || app.launchDate.isNil()) return null; return Number(app.processIdentifier) + ":" + Number(app.launchDate.timeIntervalSince1970).toFixed(6); }',
    'function tokMatch(a, b) { if (!a || !b) return true; var pa = String(a).split(":"), pb = String(b).split(":"); return pa[0] === pb[0] && Math.abs(Number(pa[1]) - Number(pb[1])) <= 2.0; }',
    `var expFrontPid = ${expFrontLit}; var expFrontTok = ${expFrontTokLit}; var expRestoreTok = ${expRestoreTokLit};`,
    "var cur = $.NSWorkspace.sharedWorkspace.frontmostApplication;",
    'if (expFrontPid > 0) { if (!cur || cur.isNil() || Number(cur.processIdentifier) !== expFrontPid) { "foreground_changed"; } else if (expFrontTok && !tokMatch(tokOf(cur), expFrontTok)) { "foreground_token_changed"; } else { var a = $.NSRunningApplication.runningApplicationWithProcessIdentifier(' + pid + '); if (a && !a.isNil() && !Boolean(a.terminated) && (!expRestoreTok || tokMatch(tokOf(a), expRestoreTok))) { a.activateWithOptions(2) ? "ok" : "fail"; } else { "none"; } } } else { var a = $.NSRunningApplication.runningApplicationWithProcessIdentifier(' + pid + '); if (a && !a.isNil() && !Boolean(a.terminated) && (!expRestoreTok || tokMatch(tokOf(a), expRestoreTok))) { a.activateWithOptions(2) ? "ok" : "fail"; } else { "none"; } }',
  ].join(" ");
  try {
    const { stdout } = await execFileAsync("/usr/bin/osascript", ["-l", "JavaScript", "-e", script], {
      timeout: 2000,
    });
    return String(stdout || "").trim() === "ok";
  } catch {
    return false;
  }
}

const NON_MAIN_WINDOW_SUBROLES = new Set(["AXDialog", "AXSystemDialog", "AXFloatingWindow"]);

export function pickPromotableMainWindow(mainWindow, windows = []) {
  if (
    mainWindow &&
    !NON_MAIN_WINDOW_SUBROLES.has(String(mainWindow.subrole || "")) &&
    Number(mainWindow.width) >= 300 &&
    Number(mainWindow.height) >= 200
  ) {
    return mainWindow;
  }
  let bestStd = null;
  let bestStdArea = 0;
  let bestAny = null;
  let bestAnyArea = 0;
  for (const candidate of Array.isArray(windows) ? windows : []) {
    if (!candidate) continue;
    const width = Number(candidate.width || 0);
    const height = Number(candidate.height || 0);
    if (width < 300 || height < 200) continue;
    const area = width * height;
    if (String(candidate.subrole || "") === "AXStandardWindow" && area > bestStdArea) {
      bestStdArea = area;
      bestStd = candidate;
    }
    if (area > bestAnyArea) {
      bestAnyArea = area;
      bestAny = candidate;
    }
  }
  return bestStd || bestAny || null;
}

export function buildPromoteMainWindowJxaScript(pid) {
  return [
    'ObjC.import("ApplicationServices");',
    'ObjC.import("Foundation");',
    '(function() {',
    '  function getSubrole(el) {',
    '    var subOut = Ref();',
    '    if ($.AXUIElementCopyAttributeValue(el, $("AXSubrole"), subOut) === 0 && subOut[0]) {',
    '      return String(ObjC.unwrap(ObjC.castRefToObject(subOut[0])) || "");',
    '    }',
    '    return "";',
    '  }',
    '  function getSize(el) {',
    '    var sizeOut = Ref();',
    '    if ($.AXUIElementCopyAttributeValue(el, $("AXSize"), sizeOut) === 0 && sizeOut[0]) {',
    '      try {',
    '        var desc = String(ObjC.unwrap($.CFCopyDescription(sizeOut[0])) || "");',
    '        var wm = /w:\\s*(-?\\d+(?:\\.\\d+)?)/.exec(desc);',
    '        var hm = /h:\\s*(-?\\d+(?:\\.\\d+)?)/.exec(desc);',
    '        if (wm && hm) return { width: Number(wm[1]), height: Number(hm[1]) };',
    '      } catch (e) {}',
    '    }',
    '    return null;',
    '  }',
    `  var appEl = $.AXUIElementCreateApplication(${pid});`,
    '  var mainOut = Ref();',
    '  var win = null;',
    '  if ($.AXUIElementCopyAttributeValue(appEl, $("AXMainWindow"), mainOut) === 0 && mainOut[0]) {',
    '    var mainSub = getSubrole(mainOut[0]);',
    '    var mainSz = getSize(mainOut[0]);',
    '    if (mainSub !== "AXDialog" && mainSub !== "AXSystemDialog" && mainSub !== "AXFloatingWindow" && mainSz && mainSz.width >= 300 && mainSz.height >= 200) {',
    '      win = mainOut[0];',
    '    }',
    '  }',
    '  if (!win) {',
    '    var listOut = Ref();',
    '    if ($.AXUIElementCopyAttributeValue(appEl, $("AXWindows"), listOut) === 0 && listOut[0]) {',
    '      var arr = ObjC.castRefToObject(listOut[0]);',
    '      var n = arr ? arr.count : 0;',
    '      var bestStd = null, bestStdArea = 0, bestAny = null, bestAnyArea = 0;',
    '      for (var i = 0; i < n; i++) {',
    '        var candidate = arr.objectAtIndex(i);',
    '        var sub = getSubrole(candidate);',
    '        var sz = getSize(candidate);',
    '        if (!sz || sz.width < 300 || sz.height < 200) continue;',
    '        var area = sz.width * sz.height;',
    '        if (sub === "AXStandardWindow" && area > bestStdArea) { bestStdArea = area; bestStd = candidate; }',
    '        if (area > bestAnyArea) { bestAnyArea = area; bestAny = candidate; }',
    '      }',
    '      win = bestStd || bestAny;',
    '    }',
    '  }',
    '  if (win) {',
    '    $.AXUIElementSetAttributeValue(win, $("AXMain"), $.kCFBooleanTrue);',
    '    $.AXUIElementSetAttributeValue(win, $("AXFocused"), $.kCFBooleanTrue);',
    '    return "ok";',
    '  }',
    '  return "none";',
    '})();',
  ].join(" ");
}

/**
 * Stage 1 fix for tiny floating widget/orb/dialog subwindows (e.g. 剪映's 42x42 orb or 92x92 Qt6 `AXDialog`):
 * Validate `AXMainWindow` (`AXSubrole !== "AXDialog"` and `AXSize >= 300x200`); if invalid, scan `AXWindows`
 * for the largest `>= 300x200` `AXStandardWindow` (or largest `>= 300x200` window if none is `AXStandardWindow`),
 * and promote it to `AXMain` + `AXFocused` in the background WITHOUT calling `AXRaise` or `activate`.
 */
export async function promoteMainWindowFocusInBackground(
  pid,
  { execFileFn = execFileAsync, settleMs = 40 } = {}
) {
  if (process.platform !== "darwin") return false;
  if (!Number.isInteger(pid) || pid <= 0 || !isProcessAlive(pid)) return false;

  const script = buildPromoteMainWindowJxaScript(pid);

  try {
    const { stdout } = await execFileFn("/usr/bin/osascript", ["-l", "JavaScript", "-e", script], {
      timeout: 1500,
    });
    if (String(stdout || "").trim() === "ok") {
      if (settleMs > 0) {
        await new Promise((r) => setTimeout(r, settleMs));
      }
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * When a desktop app owns a tiny floating widget/orb subwindow (e.g. 剪映's 42x42 pt = 84x84 px
 * AI assistant floating ball) that temporarily holds AXFocusedWindow, capture its real main
 * editor window (`Width >= 300 && Height >= 200`, `layer == 0`, `onScreen`) in the background
 * via CoreGraphics window ID (`screencapture -o -l <wid>`) without changing window focus.
 * Also returns `wid` and screen-point `bounds` so coordinate clicks/drags map accurately!
 */
export async function captureMainWindowFallbackJpeg(pid) {
  if (process.platform !== "darwin") return null;
  if (!Number.isInteger(pid) || pid <= 0 || !isProcessAlive(pid)) return null;

  const findWinScript = [
    'ObjC.import("CoreGraphics");',
    'ObjC.import("Foundation");',
    'ObjC.bindFunction("CFRelease", ["void", ["void*"]]);',
    "var ref = $.CGWindowListCopyWindowInfo($.kCGWindowListOptionAll, 0);",
    "var list = ref ? (ObjC.deepUnwrap(ObjC.castRefToObject(ref)) || []) : [];",
    "if (ref) { try { $.CFRelease(ref); } catch (e) {} }",
    "var best = null, bestArea = 0;",
    "for (var i = 0; i < list.length; i++) {",
    "  var w = list[i];",
    `  if (w.kCGWindowOwnerPID !== ${pid}) continue;`,
    "  if ((w.kCGWindowLayer || 0) !== 0) continue;",
    "  if (w.kCGWindowAlpha !== undefined && Number(w.kCGWindowAlpha) <= 0.01) continue;",
    "  var b = w.kCGWindowBounds || {};",
    "  var width = Number(b.Width || 0), height = Number(b.Height || 0);",
    "  if (width < 300 || height < 200) continue;",
    "  var area = width * height * (w.kCGWindowIsOnscreen ? 2 : 1);",
    "  if (area > bestArea) {",
    "    bestArea = area;",
    "    best = {",
    "      wid: Number(w.kCGWindowNumber || 0),",
    "      x: Number(b.X || 0),",
    "      y: Number(b.Y || 0),",
    "      width: width,",
    "      height: height,",
    '      windowTitle: String(w.kCGWindowName || "")',
    "    };",
    "  }",
    "}",
    "best ? JSON.stringify(best) : '';",
  ].join(" ");

  let winInfo = null;
  try {
    const { stdout } = await execFileAsync("/usr/bin/osascript", ["-l", "JavaScript", "-e", findWinScript], {
      timeout: 1500,
    });
    const trimmed = String(stdout || "").trim();
    if (trimmed) winInfo = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!winInfo || !Number.isInteger(winInfo.wid) || winInfo.wid <= 0) return null;

  const safeTmp = os.tmpdir().includes("/.t3/") || !existsSync(os.tmpdir()) ? "/tmp" : os.tmpdir();
  const tmpFile = path.join(safeTmp, `agy-cua-mainwin-${pid}-${crypto.randomUUID()}.jpg`);
  try {
    await execFileAsync(
      "/usr/sbin/screencapture",
      ["-o", "-l", String(winInfo.wid), "-t", "jpg", "-x", tmpFile],
      { timeout: 3000 }
    );
    let bytes = readFileSync(tmpFile);
    if (!bytes || bytes.length === 0) return null;
    let dims = parseImageDimensions(bytes);
    // Downscale ONLY if larger than 1280px (never upscale small windows)
    if (dims && Math.max(dims.width, dims.height) > 1280) {
      await execFileAsync("/usr/bin/sips", ["-Z", "1280", tmpFile], { timeout: 3000 });
      bytes = readFileSync(tmpFile);
      dims = parseImageDimensions(bytes) || dims;
    }
    return {
      data: bytes.toString("base64"),
      mimeType: "image/jpeg",
      wid: winInfo.wid,
      bounds: {
        x: winInfo.x,
        y: winInfo.y,
        width: winInfo.width,
        height: winInfo.height,
      },
      imgWidth: dims?.width || winInfo.width,
      imgHeight: dims?.height || winInfo.height,
      windowTitle: winInfo.windowTitle || null,
    };
  } catch {
    return null;
  } finally {
    try {
      rmSync(tmpFile, { force: true });
    } catch {}
  }
}

const CG_EVENT_SOURCE_USER_DATA_FIELD = 42;
const JXA_TRUST_GUARD_PREAMBLE =
  'if (typeof $.AXIsProcessTrusted !== "function" || !$.AXIsProcessTrusted()) { return "untrusted"; }';

async function runJxaPointScript(script, { partialReason, unknownReason, timeoutMs = 2500 }) {
  try {
    const { stdout } = await execFileAsync("/usr/bin/osascript", ["-l", "JavaScript", "-e", script], {
      timeout: timeoutMs,
    });
    const out = String(stdout || "").trim();
    if (out === "untrusted") {
      return {
        delivered: false,
        deliveryState: "not_sent",
        method: "app_post",
        reason: "jxa_accessibility_untrusted",
      };
    }
    if (out === "ok") {
      return { delivered: true, deliveryState: "delivered", method: "app_post" };
    }
    if (out === "sent_unknown") {
      return {
        delivered: false,
        deliveryState: "sent_unknown",
        method: "app_post",
        reason: partialReason,
      };
    }
    return {
      delivered: false,
      deliveryState: "not_sent",
      method: "app_post",
      reason: "event_create_failed",
    };
  } catch {
    return {
      delivered: false,
      deliveryState: "sent_unknown",
      method: "app_post",
      reason: unknownReason,
    };
  }
}

/**
 * Non-activating PID/window-targeted background coordinate click used when a
 * stubborn custom floating orb prevents `OpenComputerUse`'s internal snapshot bounds from
 * matching the main editor window. Never moves the physical pointer or raises windows.
 */
export async function dispatchBackgroundPointClickDetailed(
  pid,
  screenX,
  screenY,
  {
    button = "left",
    clickCount = 1,
    axBridge = null,
    wid = null,
    bounds = null,
    allowAppPostFallback = true,
    syntheticTag = 0,
    beforeWriteCheck = null,
  } = {}
) {
  if (process.platform !== "darwin") return { delivered: false, method: null };
  if (!Number.isInteger(pid) || pid <= 0 || !isProcessAlive(pid)) {
    return { delivered: false, method: null };
  }
  if (!Number.isFinite(screenX) || !Number.isFinite(screenY)) {
    return { delivered: false, method: null };
  }

  if (axBridge && typeof axBridge.postWindowClick === "function") {
    try {
      const res = await axBridge.postWindowClick(pid, {
        x: screenX,
        y: screenY,
        screenCoords: true,
        wid,
        windowBounds: bounds,
        button,
        clickCount,
        allowAppPostFallback,
        syntheticTag,
        beforeWriteCheck,
      });
      throwIfSentUnknown(res, "point_click");
      if (res?.delivered) {
        return {
          delivered: true,
          method: res.method === "app_post" ? "app_post" : "window_post",
        };
      }
      if (res?.reason === "jxa_accessibility_untrusted") {
        return {
          delivered: false,
          deliveryState: "not_sent",
          method: "window_post",
          reason: "jxa_accessibility_untrusted",
        };
      }
      if (
        res?.reason &&
        res.reason !== "skylight_unavailable" &&
        res.reason !== "window_id_unavailable"
      ) {
        return {
          delivered: false,
          deliveryState: res.deliveryState || "not_sent",
          method: res.method || "window_post",
          reason: res.reason,
        };
      }
    } catch (err) {
      rethrowIfWriteOutcomeUnknown(err);
    }
  }

  if (!allowAppPostFallback) {
    return { delivered: false, method: "window_post" };
  }
  beforeWriteCheck?.();

  const btn = String(button || "left").toLowerCase();
  const count = Math.max(1, Math.min(3, Number.parseInt(String(clickCount ?? 1), 10) || 1));
  const downConst =
    btn === "right"
      ? "$.kCGEventRightMouseDown"
      : btn === "middle"
        ? "$.kCGEventOtherMouseDown"
        : "$.kCGEventLeftMouseDown";
  const upConst =
    btn === "right"
      ? "$.kCGEventRightMouseUp"
      : btn === "middle"
        ? "$.kCGEventOtherMouseUp"
        : "$.kCGEventLeftMouseUp";
  const btnConst =
    btn === "right"
      ? "$.kCGMouseButtonRight"
      : btn === "middle"
        ? "$.kCGMouseButtonCenter"
        : "$.kCGMouseButtonLeft";

  const ptX = Number(screenX.toFixed(2));
  const ptY = Number(screenY.toFixed(2));
  const tagNum = Number(syntheticTag) > 0 ? Number(syntheticTag) : 0;
  const script = [
    "(function () {",
    'ObjC.import("ApplicationServices");',
    'ObjC.import("CoreGraphics");',
    'ObjC.bindFunction("CFRelease", ["void", ["void*"]]);',
    JXA_TRUST_GUARD_PREAMBLE,
    `var pt = { x: ${ptX}, y: ${ptY} };`,
    `var tag = ${tagNum};`,
    "var anyPosted = false;",
    "try {",
    `for (var c = 1; c <= ${count}; c++) {`,
    `  var down = $.CGEventCreateMouseEvent(null, ${downConst}, pt, ${btnConst});`,
    `  var up = $.CGEventCreateMouseEvent(null, ${upConst}, pt, ${btnConst});`,
    '  if (!down || !up) { if (down) $.CFRelease(down); if (up) $.CFRelease(up); return anyPosted ? "sent_unknown" : "not_sent"; }',
    `  if (tag) { $.CGEventSetIntegerValueField(down, ${CG_EVENT_SOURCE_USER_DATA_FIELD}, tag); $.CGEventSetIntegerValueField(up, ${CG_EVENT_SOURCE_USER_DATA_FIELD}, tag); }`,
    "  $.CGEventSetIntegerValueField(down, $.kCGMouseEventClickState, c);",
    "  $.CGEventSetIntegerValueField(up, $.kCGMouseEventClickState, c);",
    "  anyPosted = true;",
    `  $.CGEventPostToPid(${pid}, down);`,
    "  $.CFRelease(down);",
    "  $.usleep(18000);",
    `  $.CGEventPostToPid(${pid}, up);`,
    "  $.CFRelease(up);",
    "  if (c < " + count + ") $.usleep(28000);",
    "}",
    'return "ok";',
    '} catch (e) { return anyPosted ? "sent_unknown" : "not_sent"; }',
    "})();",
  ].join(" ");

  return runJxaPointScript(script, {
    partialReason: "partial_point_click_post",
    unknownReason: "point_click_outcome_unknown",
    timeoutMs: 2500,
  });
}

export async function dispatchBackgroundPointClick(pid, screenX, screenY, options = {}) {
  const res = await dispatchBackgroundPointClickDetailed(pid, screenX, screenY, options);
  return Boolean(res?.delivered);
}

/**
 * Non-activating PID-targeted background drag (`CGEventPostToPid`) mapped directly in screen points.
 */
export async function dispatchBackgroundPointDragDetailed(
  pid,
  fromScreenX,
  fromScreenY,
  toScreenX,
  toScreenY,
  { syntheticTag = 0, beforeWriteCheck = null } = {}
) {
  if (process.platform !== "darwin") {
    return { delivered: false, deliveryState: "not_sent", method: null, reason: "unsupported_platform" };
  }
  if (!Number.isInteger(pid) || pid <= 0 || !isProcessAlive(pid)) {
    return { delivered: false, deliveryState: "not_sent", method: null, reason: "process_not_alive" };
  }
  if (
    !Number.isFinite(fromScreenX) ||
    !Number.isFinite(fromScreenY) ||
    !Number.isFinite(toScreenX) ||
    !Number.isFinite(toScreenY)
  ) {
    return { delivered: false, deliveryState: "not_sent", method: null, reason: "invalid_coordinates" };
  }

  const x0 = Number(fromScreenX.toFixed(2));
  const y0 = Number(fromScreenY.toFixed(2));
  const x1 = Number(toScreenX.toFixed(2));
  const y1 = Number(toScreenY.toFixed(2));
  const tagNum = Number(syntheticTag) > 0 ? Number(syntheticTag) : 0;
  const script = [
    "(function () {",
    'ObjC.import("ApplicationServices");',
    'ObjC.import("CoreGraphics");',
    'ObjC.bindFunction("CFRelease", ["void", ["void*"]]);',
    JXA_TRUST_GUARD_PREAMBLE,
    `var p0 = { x: ${x0}, y: ${y0} }, p1 = { x: ${x1}, y: ${y1} };`,
    `var tag = ${tagNum};`,
    "var anyPosted = false;",
    "var upPosted = false;",
    "var lastDragPt = p0;",
    "var postRescueUp = function () {",
    "  if (!anyPosted || upPosted) return;",
    "  try {",
    "    var rUp = $.CGEventCreateMouseEvent(null, $.kCGEventLeftMouseUp, lastDragPt, $.kCGMouseButtonLeft);",
    "    if (rUp) {",
    `      if (tag) $.CGEventSetIntegerValueField(rUp, ${CG_EVENT_SOURCE_USER_DATA_FIELD}, tag);`,
    `      $.CGEventPostToPid(${pid}, rUp);`,
    "      $.CFRelease(rUp);",
    "      upPosted = true;",
    "    }",
    "  } catch (eu) {}",
    "};",
    "try {",
    "var down = $.CGEventCreateMouseEvent(null, $.kCGEventLeftMouseDown, p0, $.kCGMouseButtonLeft);",
    'if (!down) { return "not_sent"; }',
    `if (tag) $.CGEventSetIntegerValueField(down, ${CG_EVENT_SOURCE_USER_DATA_FIELD}, tag);`,
    "anyPosted = true;",
    `$.CGEventPostToPid(${pid}, down);`,
    "$.CFRelease(down);",
    "for (var s = 1; s <= 5; s++) {",
    "  $.usleep(14000);",
    "  var t = s / 5;",
    "  var pm = { x: p0.x + (p1.x - p0.x) * t, y: p0.y + (p1.y - p0.y) * t };",
    "  lastDragPt = pm;",
    "  var drag = $.CGEventCreateMouseEvent(null, $.kCGEventLeftMouseDragged, pm, $.kCGMouseButtonLeft);",
    '  if (!drag) { postRescueUp(); return "sent_unknown"; }',
    `  if (tag) $.CGEventSetIntegerValueField(drag, ${CG_EVENT_SOURCE_USER_DATA_FIELD}, tag);`,
    `  $.CGEventPostToPid(${pid}, drag);`,
    "  $.CFRelease(drag);",
    "}",
    "$.usleep(18000);",
    "lastDragPt = p1;",
    "var up = $.CGEventCreateMouseEvent(null, $.kCGEventLeftMouseUp, p1, $.kCGMouseButtonLeft);",
    'if (!up) { return "sent_unknown"; }',
    `if (tag) $.CGEventSetIntegerValueField(up, ${CG_EVENT_SOURCE_USER_DATA_FIELD}, tag);`,
    "upPosted = true;",
    `$.CGEventPostToPid(${pid}, up);`,
    "$.CFRelease(up);",
    'return "ok";',
    '} catch (e) { postRescueUp(); return anyPosted ? "sent_unknown" : "not_sent"; }',
    "})();",
  ].join(" ");

  beforeWriteCheck?.();

  return runJxaPointScript(script, {
    partialReason: "partial_point_drag_post",
    unknownReason: "point_drag_outcome_unknown",
    timeoutMs: 3000,
  });
}

export async function dispatchBackgroundPointDrag(
  pid,
  fromScreenX,
  fromScreenY,
  toScreenX,
  toScreenY,
  options = {}
) {
  const res = await dispatchBackgroundPointDragDetailed(
    pid,
    fromScreenX,
    fromScreenY,
    toScreenX,
    toScreenY,
    options
  );
  return Boolean(res?.delivered);
}
