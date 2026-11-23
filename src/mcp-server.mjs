#!/usr/bin/env node

import process from "node:process";
import { SIDECAR_PILL_MARKDOWN, isMainModule } from "./constants.mjs";
import { BrokerRpcClient } from "./broker-client.mjs";
import { runJsonRpcStdioServer } from "./jsonrpc-stdio.mjs";

const SERVER_INSTRUCTIONS = `Computer Use tools let you interact with macOS apps in the background WITHOUT bringing windows to the front or stealing user focus.

Live Side-Pane Mini-Window:
- A live Codex-style mini-window sidecar streams the target app window in Antigravity's right-hand auxiliary pane.
- On the FIRST turn in a conversation where you use Computer Use, include ${SIDECAR_PILL_MARKDOWN} once in your reply so the user can toggle the live mini-window on the side of the chat.

Operating rules:
- Begin by calling \`get_app_state\` to observe the target app before acting in a new turn.
- Prefer \`act\` when locating and clicking UI targets that may require scrolling or verifying state changes (e.g. list items, cards, tabs, modals): it atomically locates, deduplicates nested matches, scrolls if needed, clicks once in the background, and verifies your \`expect\` condition.
- Windows remain in the background automatically (via SkyLight \`sky_click\` / \`sky_key\`, \`window_post\`, and WindowServer occlusion keep-alive). NEVER run AppleScript \`activate\`, \`open -a\` (without \`-g\`), or \`perform_secondary_action(..., "Raise")\` unless the user explicitly asks to bring the window to the front.
- Prefer element-targeted actions (\`act\`, \`element_index\`, or \`query\`) or \`set_value\` when available; coordinate clicks are also delivered in the background without moving the user's cursor.
- Ask the user before destructive or externally visible actions such as sending messages, deleting files, or purchasing.`;

export async function runMcpServer() {
  const broker = new BrokerRpcClient();
  runJsonRpcStdioServer({
    serverInfo: { name: "codex-style-computer-use", version: "1.1.3" },
    instructions: SERVER_INSTRUCTIONS,
    onListTools: () => broker.request("tools/list", {}),
    onCallTool: async (params, _req, { attachPillHint, signal }) => {
      if (signal?.aborted) {
        return {
          isError: true,
          content: [{ type: "text", text: "[CANCELLED] 请求已取消。" }],
        };
      }
      const rawResult = await broker.request(
        "tools/call",
        {
          name: params.name,
          arguments: params.arguments || {},
          source: "ai",
        },
        { signal }
      );
      return attachPillHint(rawResult);
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
