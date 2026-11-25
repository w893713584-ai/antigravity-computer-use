#!/usr/bin/env node

import process from "node:process";
import {
  SIDECAR_PILL_MARKDOWN,
  buildT3OneTimePillHint,
  detectMcpHost,
  isMainModule,
} from "./constants.mjs";
import { BrokerRpcClient } from "./broker-client.mjs";
import { SNAPSHOT_REF_DOC } from "./headless-engine.mjs";
import { ONE_TIME_PILL_HINT, runJsonRpcStdioServer } from "./jsonrpc-stdio.mjs";

const SHARED_OPERATING_RULES = `Operating rules:
- Begin by calling \`get_app_state\` to observe the target app before acting in a new turn.
- Prefer \`act\` when locating and clicking UI targets that may require scrolling or verifying state changes (e.g. list items, cards, tabs, modals): it atomically locates, deduplicates nested matches, scrolls if needed, clicks once in the background, and verifies your \`expect\` condition.
- Windows remain in the background automatically (via SkyLight \`sky_click\` / \`sky_key\`, \`window_post\`, and WindowServer occlusion keep-alive). For ordinary apps, NEVER run AppleScript \`activate\`, \`open -a\` (without \`-g\`), or \`perform_secondary_action(..., "Raise")\` unless the user explicitly asks to bring the window to the front.
- 特例：操作剪映专业版（\`com.lemon.lvpro\`）等 Qt6 自绘应用且后台滚轮、搜索框或弹窗失灵时，允许临时通过 \`osascript\` 将其 \`activate\` 到前台快速完成点击/输入，操作完成后立即退回后台或退出应用。
- Prefer element-targeted actions (\`act\`, \`element_index\`, or \`query\`) or \`set_value\` when available; coordinate clicks are also delivered in the background without moving the user's cursor.
- Ask the user before destructive or externally visible actions such as sending messages, deleting files, or purchasing.`;

export const SERVER_INSTRUCTIONS = `Computer Use tools let you interact with macOS apps in the background WITHOUT bringing windows to the front or stealing user focus.

Live Side-Pane Mini-Window:
- A live Codex-style mini-window sidecar streams the target app window in Antigravity's right-hand auxiliary pane.
- On the FIRST turn in a conversation where you use Computer Use, include ${SIDECAR_PILL_MARKDOWN} once in your reply so the user can toggle the live mini-window on the side of the chat.

${SHARED_OPERATING_RULES}`;

const T3_SERVER_INSTRUCTIONS = `Computer Use tools let you interact with macOS apps in the background WITHOUT bringing windows to the front or stealing user focus.

Live Side-Pane Mini-Window:
- A local live mini-window HTTP stream runs in the background. On the FIRST turn where you use Computer Use, include the local HTTP live mini-window link from the tool output once in your reply (do not emit \`sidecar://\` links in T3 Code).

${SHARED_OPERATING_RULES}`;

export function getStaticFallbackTools({ host = "antigravity" } = {}) {
  const pillSuffix =
    host === "t3"
      ? "\nSide-pane live view: include the local HTTP live mini-window link from the first tool result once in your reply."
      : `\nSide-pane live view: include ${SIDECAR_PILL_MARKDOWN} once in your first reply using Computer Use so the user can open the right-hand live mini-window.`;
  const refSuffix = `\n${SNAPSHOT_REF_DOC}`;
  return [
    {
      name: "list_apps",
      description: `List running and launchable macOS applications without activating windows.${pillSuffix}`,
      inputSchema: { type: "object", additionalProperties: false, properties: {} },
    },
    {
      name: "get_app_state",
      description: `Read the accessibility tree and/or screenshot of a target macOS application in the background.${pillSuffix}${refSuffix}`,
      inputSchema: {
        type: "object",
        required: ["app"],
        properties: {
          app: { type: "string" },
          include_ax: { type: "boolean" },
          include_screenshot: { type: "boolean" },
          text_limit: { type: ["integer", "string"] },
          max_tree_nodes: { type: "integer" },
          max_tree_depth: { type: "integer" },
          window_placement: { type: "string" },
        },
      },
    },
    {
      name: "query",
      description: `Search macOS Accessibility elements in a target app by text and/or role.${refSuffix}`,
      inputSchema: {
        type: "object",
        required: ["app"],
        properties: {
          app: { type: "string" },
          text: { type: "string" },
          role: { type: "string" },
          exact: { type: "boolean" },
          limit: { type: "integer" },
          max_nodes: { type: "integer" },
          window_id: { type: "number" },
        },
      },
    },
    {
      name: "act",
      description:
        "Atomically locate a UI target (with optional background reveal scrolling), deduplicate nested matches, click its interactive control/card once in the background, and verify an explicit semantic postcondition (`expect`).",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["app", "target", "expect"],
        properties: {
          app: { type: "string" },
          window_id: { type: "number" },
          target: {
            type: "object",
            additionalProperties: false,
            properties: {
              text: { type: "string" },
              role: { type: "string" },
              exact: { type: "boolean" },
            },
          },
          click_count: { type: "integer", minimum: 1, maximum: 3 },
          mouse_button: { type: "string", enum: ["left", "right", "middle"] },
          reveal: {
            type: "object",
            additionalProperties: false,
            properties: {
              direction: { type: "string", enum: ["down", "up", "left", "right"] },
              max_scroll_steps: { type: "integer", minimum: 0, maximum: 10 },
              pages_per_step: { type: "number", minimum: 0.15, maximum: 1.5 },
            },
          },
          expect: {
            type: "object",
            additionalProperties: false,
            properties: {
              any_text: { type: "array", items: { type: "string" } },
              all_text: { type: "array", items: { type: "string" } },
              text_disappears: { type: "array", items: { type: "string" } },
              window_title_contains: { type: "string" },
            },
          },
          timeout_ms: { type: "integer", minimum: 40, maximum: 25000 },
        },
      },
    },
    {
      name: "click",
      description: "Click an element index (`@sN:index`) or window screenshot coordinates in the background.",
      inputSchema: {
        type: "object",
        required: ["app"],
        properties: {
          app: { type: "string" },
          element_index: { type: ["string", "integer"] },
          x: { type: "number" },
          y: { type: "number" },
          mouse_button: { type: "string", enum: ["left", "right", "middle"] },
          click_count: { type: "integer", minimum: 1, maximum: 3 },
          click_method: {
            type: "string",
            enum: ["auto", "sky_click", "window_post", "app_post", "accessibility", "global"],
          },
        },
      },
    },
    {
      name: "drag",
      description: "Drag between coordinates or on an element in the background.",
      inputSchema: {
        type: "object",
        required: ["app"],
        properties: {
          app: { type: "string" },
          element_index: { type: ["string", "integer"] },
          from_x: { type: "number" },
          from_y: { type: "number" },
          to_x: { type: "number" },
          to_y: { type: "number" },
        },
      },
    },
    {
      name: "scroll",
      description: "Scroll an element or window in the background.",
      inputSchema: {
        type: "object",
        required: ["app", "direction"],
        properties: {
          app: { type: "string" },
          element_index: { type: ["string", "integer"] },
          direction: { type: "string", enum: ["up", "down", "left", "right"] },
          pages: { type: "number" },
        },
      },
    },
    {
      name: "press_key",
      description: "Send a keyboard shortcut or key chord to a target app in the background.",
      inputSchema: {
        type: "object",
        required: ["app", "key"],
        properties: {
          app: { type: "string" },
          key: { type: "string" },
          key_method: { type: "string", enum: ["auto", "sky_key", "window_key", "global"] },
        },
      },
    },
    {
      name: "type_text",
      description: "Type text into the focused element of a target app in the background.",
      inputSchema: {
        type: "object",
        required: ["app", "text"],
        properties: {
          app: { type: "string" },
          text: { type: "string" },
          key_method: { type: "string", enum: ["auto", "sky_key", "window_key", "global"] },
        },
      },
    },
    {
      name: "set_value",
      description: "Set the value of an editable element in a target app in the background.",
      inputSchema: {
        type: "object",
        required: ["app", "element_index", "value"],
        properties: {
          app: { type: "string" },
          element_index: { type: ["string", "integer"] },
          value: { type: "string" },
        },
      },
    },
    {
      name: "select_text",
      description: "Select text inside an editable element in a target app in the background.",
      inputSchema: {
        type: "object",
        required: ["app", "element_index", "text"],
        properties: {
          app: { type: "string" },
          element_index: { type: ["string", "integer"] },
          text: { type: "string" },
          prefix: { type: "string" },
          suffix: { type: "string" },
          selection: { type: "string", enum: ["text", "cursor_before", "cursor_after"] },
        },
      },
    },
    {
      name: "perform_secondary_action",
      description: "Perform an accessibility action on a target element in the background.",
      inputSchema: {
        type: "object",
        required: ["app", "element_index", "action"],
        properties: {
          app: { type: "string" },
          element_index: { type: ["string", "integer"] },
          action: { type: "string" },
        },
      },
    },
  ];
}

export async function runMcpServer() {
  const broker = new BrokerRpcClient();
  let cachedT3Hint = null;

  runJsonRpcStdioServer({
    serverInfo: { name: "codex-style-computer-use", version: "1.1.6" },
    instructions: (_params, clientInfo) =>
      detectMcpHost(process.env, clientInfo) === "t3"
        ? T3_SERVER_INSTRUCTIONS
        : SERVER_INSTRUCTIONS,
    onListTools: async (_params, _req, { clientInfo } = {}) => {
      const host = detectMcpHost(process.env, clientInfo);
      try {
        const res = await broker.request("tools/list", { host }, { timeoutMs: 6500 });
        if (Array.isArray(res?.tools) && res.tools.length > 0) {
          return res;
        }
      } catch {}
      return { tools: getStaticFallbackTools({ host }) };
    },
    onCallTool: async (params, _req, { attachPillHint, signal, clientInfo }) => {
      if (signal?.aborted) {
        return {
          isError: true,
          content: [{ type: "text", text: "[CANCELLED] 请求已取消。" }],
        };
      }
      const host = detectMcpHost(process.env, clientInfo);
      const rawResult = await broker.request(
        "tools/call",
        {
          name: params.name,
          arguments: params.arguments || {},
          source: "ai",
        },
        { signal }
      );
      if (host === "t3") {
        if (!cachedT3Hint && rawResult && !rawResult.isError) {
          const info = await broker.request("sidecar/info", {}, { timeoutMs: 1500 }).catch(() => null);
          cachedT3Hint = buildT3OneTimePillHint(info?.webPort, info?.uiToken);
        }
        return attachPillHint(rawResult, cachedT3Hint || buildT3OneTimePillHint(0, ""));
      }
      return attachPillHint(rawResult, ONE_TIME_PILL_HINT);
    },
    onClose: () => broker.close(),
  });
}

if (isMainModule(import.meta.url)) {
  runMcpServer().catch((err) => {
    console.error("[codex-style-computer-use mcp]", err);
    process.exit(1);
  });
}
