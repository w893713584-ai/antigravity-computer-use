import {
  extractResultText,
  parseAppsList,
} from "./background-policy.mjs";
import { REPL_MAX_RESULT_BYTES, SIDECAR_PILL_MARKDOWN } from "./constants.mjs";

export const DEFAULT_REPL_TIMEOUT_MS = 30_000;
export const MAX_REPL_TIMEOUT_MS = 300_000;

export const REPL_ALLOWED_OPS = new Set([
  "cua.getState",
  "cua.listApps",
  "cua.getApp",
  "app.query",
  "app.act",
  "app.getAXState",
  "app.getScreenshot",
  "app.getAXStateAndScreenshot",
  "app.click",
  "app.drag",
  "app.pressKey",
  "app.scroll",
  "app.setValue",
  "app.selectText",
  "app.typeText",
  "app.performSecondaryAction",
]);

const REPL_TOOL_NOTE = `\nSide-pane live view: include ${SIDECAR_PILL_MARKDOWN} once in your first reply using Computer Use so the user can open the right-hand live mini-window.`;

export const REPL_SERVER_INSTRUCTIONS = `UI automation through a persistent JavaScript REPL using the initialized \`cua\` API — running inside a hardened OS-level Seatbelt + JavaScriptCore sandbox without bringing windows to the front or stealing focus.

Live Side-Pane Mini-Window:
- Every \`cua\` app interaction automatically streams into the user's right-hand Side-Pane Mini-Window.
- On the FIRST turn in a conversation where you use Computer Use, include ${SIDECAR_PILL_MARKDOWN} once in your reply so the user can open the live mini-window on the side of the chat.

Usage:
- Bind an app with \`var app = await cua.getApp("Example App")\` (or \`{ initialState: false }\` followed by \`app.query({ text, role })\` or \`app.act({ target, expect })\`).
- Top-level bindings (\`var\`, \`let\`, \`const\`) and \`session\` persist across \`js\` turns until \`js_reset\` or error abort.
- NEVER invoke AppleScript \`activate\` or \`open -a\` without \`-g\`. Ask the user before destructive or externally visible actions.`;

export function getReplToolDefinitions() {
  const annotations = { destructiveHint: false, openWorldHint: false };
  return [
    {
      name: "js",
      description:
        `Run JavaScript in a sandboxed persistent Computer Use REPL with top-level await and the initialized \`cua\` API. Top-level var/let/const bindings and \`session\` persist across calls until \`js_reset\`. Supports \`app.query\`, \`app.act\`, \`app.getAXState\`, \`app.getScreenshot\` (Uint8Array), \`app.click\`, \`app.typeText\`, \`app.pressKey\`, \`app.scroll\`, \`app.setValue\`, \`app.selectText\`, \`app.drag\`, \`app.performSecondaryAction\`, plus \`nodeRepl.write\` / \`nodeRepl.emitImage\`.${REPL_TOOL_NOTE}`,
      annotations,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          code: {
            type: "string",
            minLength: 1,
            description: "JavaScript source to execute with top-level await and the initialized cua API.",
          },
          timeout_ms: {
            type: "integer",
            minimum: 1,
            maximum: MAX_REPL_TIMEOUT_MS,
            description: "Optional wall-clock timeout in milliseconds (default 30000, max 300000).",
          },
          title: {
            type: "string",
            minLength: 1,
            maxLength: 80,
            description: "Short user-facing description of what this code is doing.",
          },
        },
        required: ["code"],
      },
    },
    {
      name: "js_reset",
      description:
        "Reset the persistent sandboxed Computer Use JavaScript session and discard all bindings/handles created by prior js calls.",
      annotations: { ...annotations, readOnlyHint: true },
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
    },
  ];
}

export function normalizeReplSnapshotArgs(args = {}) {
  const out = {};
  if (args.text_limit !== undefined) out.text_limit = args.text_limit;
  if (args.max_tree_nodes !== undefined) out.max_tree_nodes = args.max_tree_nodes;
  if (args.max_tree_depth !== undefined) out.max_tree_depth = args.max_tree_depth;
  if (args.include_ax !== undefined) out.include_ax = Boolean(args.include_ax);
  if (args.include_screenshot !== undefined) out.include_screenshot = Boolean(args.include_screenshot);
  // Enforce background read-only placement regardless of caller flags
  out.window_placement = "keep";
  return out;
}

export function buildBrokerToolCallForReplOp(op, args = {}, boundApp = null) {
  if (!REPL_ALLOWED_OPS.has(op)) {
    throw new Error(`FORBIDDEN_REPL_OP: ${op}`);
  }
  const app = boundApp || (typeof args.app === "string" ? args.app.trim() : "");
  switch (op) {
    case "cua.getState":
    case "cua.listApps":
      return { toolName: "list_apps", toolArgs: {} };
    case "cua.getApp":
      return {
        toolName: "get_app_state",
        toolArgs: { app, text_limit: "max", window_placement: "keep" },
      };
    case "app.query":
      return {
        toolName: "query",
        toolArgs: {
          app,
          ...(args.text !== undefined ? { text: String(args.text) } : {}),
          ...(args.role !== undefined ? { role: String(args.role) } : {}),
          ...(args.exact !== undefined ? { exact: Boolean(args.exact) } : {}),
          ...(args.limit !== undefined ? { limit: Number(args.limit) } : {}),
          ...(args.max_nodes !== undefined ? { max_nodes: Number(args.max_nodes) } : {}),
          ...(args.window_id !== undefined ? { window_id: Number(args.window_id) } : {}),
        },
      };
    case "app.act":
      return {
        toolName: "act",
        toolArgs: {
          app,
          target: args.target,
          expect: args.expect,
          ...(args.window_id !== undefined ? { window_id: Number(args.window_id) } : {}),
          ...(args.click_count !== undefined ? { click_count: Number(args.click_count) } : {}),
          ...(args.mouse_button !== undefined ? { mouse_button: String(args.mouse_button) } : {}),
          ...(args.reveal !== undefined ? { reveal: args.reveal } : {}),
          ...(args.timeout_ms !== undefined ? { timeout_ms: Number(args.timeout_ms) } : {}),
        },
      };
    case "app.getAXState":
      return {
        toolName: "get_app_state",
        toolArgs: { app, ...normalizeReplSnapshotArgs(args) },
      };
    case "app.getScreenshot":
      return {
        toolName: "get_app_state",
        toolArgs: { app, ...normalizeReplSnapshotArgs(args), text_limit: 1 },
      };
    case "app.getAXStateAndScreenshot":
      return {
        toolName: "get_app_state",
        toolArgs: { app, ...normalizeReplSnapshotArgs(args) },
      };
    case "app.click":
      return {
        toolName: "click",
        toolArgs: {
          app,
          ...(args.element_index !== undefined ? { element_index: String(args.element_index) } : {}),
          ...(args.x !== undefined ? { x: Number(args.x) } : {}),
          ...(args.y !== undefined ? { y: Number(args.y) } : {}),
          ...(args.mouse_button !== undefined ? { mouse_button: String(args.mouse_button) } : {}),
          ...(args.click_count !== undefined ? { click_count: Number(args.click_count) } : {}),
          ...(args.click_method !== undefined ? { click_method: String(args.click_method) } : {}),
        },
      };
    case "app.drag":
      return {
        toolName: "drag",
        toolArgs: {
          app,
          from_x: Number(args.from_x),
          from_y: Number(args.from_y),
          to_x: Number(args.to_x),
          to_y: Number(args.to_y),
        },
      };
    case "app.pressKey":
      return {
        toolName: "press_key",
        toolArgs: {
          app,
          key: String(args.key ?? ""),
          ...(args.key_method !== undefined ? { key_method: String(args.key_method) } : {}),
        },
      };
    case "app.scroll":
      return {
        toolName: "scroll",
        toolArgs: {
          app,
          element_index: String(args.element_index ?? "0"),
          direction: String(args.direction ?? "down"),
          ...(args.pages !== undefined ? { pages: Number(args.pages) } : {}),
        },
      };
    case "app.setValue":
      return {
        toolName: "set_value",
        toolArgs: {
          app,
          element_index: String(args.element_index ?? ""),
          value: String(args.value ?? ""),
        },
      };
    case "app.selectText":
      return {
        toolName: "select_text",
        toolArgs: {
          app,
          element_index: String(args.element_index ?? ""),
          text: String(args.text ?? ""),
          ...(args.prefix !== undefined ? { prefix: String(args.prefix) } : {}),
          ...(args.suffix !== undefined ? { suffix: String(args.suffix) } : {}),
          ...(args.selection !== undefined ? { selection: String(args.selection) } : {}),
        },
      };
    case "app.typeText":
      return {
        toolName: "type_text",
        toolArgs: {
          app,
          text: String(args.text ?? ""),
          ...(args.key_method !== undefined ? { key_method: String(args.key_method) } : {}),
        },
      };
    case "app.performSecondaryAction":
      return {
        toolName: "perform_secondary_action",
        toolArgs: {
          app,
          element_index: String(args.element_index ?? ""),
          action: String(args.action ?? ""),
        },
      };
    default:
      throw new Error(`FORBIDDEN_REPL_OP: ${op}`);
  }
}

export function formatAppsForRepl(rawResult) {
  const text = extractResultText(rawResult);
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed;
  } catch {}
  return parseAppsList(text).map((a) => ({
    id: a.bundleId || a.displayName,
    displayName: a.displayName,
    ...(a.isRunning ? { isRunning: true } : {}),
    ...(a.isFrontmost ? { isFrontmost: true } : {}),
  }));
}

function sliceStringToUtf8Bytes(str, maxUtf8Bytes) {
  if (maxUtf8Bytes <= 0) return "";
  const buf = Buffer.from(str, "utf8");
  if (buf.length <= maxUtf8Bytes) return str;
  // Walk back from maxUtf8Bytes if inside UTF-8 continuation bytes (0b10xxxxxx)
  let end = maxUtf8Bytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) {
    end -= 1;
  }
  return buf.subarray(0, end).toString("utf8");
}

function sanitizeMcpItem(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  if (item.type === "text" && typeof item.text === "string") {
    const out = { type: "text", text: item.text };
    if (item._meta && typeof item._meta.id === "string") {
      out._meta = { id: item._meta.id };
    }
    return out;
  }
  if (
    item.type === "image" &&
    typeof item.data === "string" &&
    typeof item.mimeType === "string" &&
    item.mimeType.startsWith("image/")
  ) {
    return {
      type: "image",
      mimeType: item.mimeType,
      data: item.data,
    };
  }
  return null;
}

/**
 * Enforce `Buffer.byteLength(JSON.stringify(result), "utf8") <= maxBytes` (256 KiB)
 * including text, images, errors, and pill hint by omitting oversized images and trimming
 * UTF-8 text cleanly while appending a single truncation notice.
 */
export function truncateMcpResultTo256KiB(result, maxBytes = REPL_MAX_RESULT_BYTES) {
  const normalizedItems = Array.isArray(result?.content)
    ? result.content.map(sanitizeMcpItem).filter(Boolean)
    : [];
  const base = {
    content: normalizedItems,
    isError: Boolean(result?.isError),
  };
  if (Buffer.byteLength(JSON.stringify(base), "utf8") <= maxBytes) {
    return base;
  }

  const noticeText = "\n[结果已截断：总输出超过 256 KiB 限制]";
  const noticeItem = { type: "text", text: noticeText };
  const kept = [];
  const envelopeOverhead = () =>
    Buffer.byteLength(JSON.stringify({ content: [...kept, noticeItem], isError: base.isError }), "utf8");

  for (const item of normalizedItems) {
    const nextCandidate = { content: [...kept, item, noticeItem], isError: base.isError };
    if (Buffer.byteLength(JSON.stringify(nextCandidate), "utf8") <= maxBytes) {
      kept.push(item);
      continue;
    }

    if (item.type === "image") {
      const omittedNote = {
        type: "text",
        text: `[已省略超限图片 (${item.mimeType}, ~${Math.round(Buffer.byteLength(item.data, "utf8") / 1024)} KiB)]`,
      };
      if (
        Buffer.byteLength(
          JSON.stringify({ content: [...kept, omittedNote, noticeItem], isError: base.isError }),
          "utf8"
        ) <= maxBytes
      ) {
        kept.push(omittedNote);
      }
      break;
    }

    if (item.type === "text") {
      const budgetLeft = maxBytes - envelopeOverhead() - 24;
      if (budgetLeft > 16) {
        let trimmed = sliceStringToUtf8Bytes(item.text, Math.floor(budgetLeft / 2));
        // Refine upwards safely while keeping serialized JSON <= maxBytes
        while (trimmed.length < item.text.length) {
          const test = sliceStringToUtf8Bytes(item.text, Buffer.byteLength(trimmed, "utf8") + 64);
          if (test === trimmed) break;
          const trial = {
            content: [...kept, { type: "text", text: test }, noticeItem],
            isError: base.isError,
          };
          if (Buffer.byteLength(JSON.stringify(trial), "utf8") <= maxBytes) {
            trimmed = test;
          } else {
            break;
          }
        }
        if (trimmed) {
          kept.push({ type: "text", text: trimmed });
        }
      }
      break;
    }
  }

  // Last-resort safety clamp if base overhead was already tight
  while (
    kept.length > 0 &&
    Buffer.byteLength(
      JSON.stringify({ content: [...kept, noticeItem], isError: base.isError }),
      "utf8"
    ) > maxBytes
  ) {
    kept.pop();
  }

  return {
    content: [...kept, noticeItem],
    isError: base.isError,
  };
}
