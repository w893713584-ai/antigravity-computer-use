#!/usr/bin/env node

import process from "node:process";
import { SIDECAR_PILL_MARKDOWN, isMainModule } from "./constants.mjs";
import { BrokerRpcClient } from "./broker-client.mjs";
import { runJsonRpcStdioServer } from "./jsonrpc-stdio.mjs";
import {
  DEFAULT_REPL_TIMEOUT_MS,
  MAX_REPL_TIMEOUT_MS,
  REPL_SERVER_INSTRUCTIONS,
  getReplToolDefinitions,
  truncateMcpResultTo256KiB,
} from "./repl-schema.mjs";

export async function runReplMcpServer() {
  const broker = new BrokerRpcClient({ enableFallback: false });

  runJsonRpcStdioServer({
    serverInfo: { name: "codex-style-computer-use-repl", version: "1.1.2" },
    instructions: REPL_SERVER_INSTRUCTIONS,
    onListTools: async () => {
      try {
        const res = await broker.request("repl/tools", {}, { timeoutMs: 3000 });
        if (Array.isArray(res?.tools) && res.tools.length > 0) {
          return res;
        }
      } catch {}
      return { tools: getReplToolDefinitions() };
    },
    onCallTool: async (params, req, { attachPillHint, signal }) => {
      if (signal?.aborted) {
        return {
          isError: true,
          content: [{ type: "text", text: "[CANCELLED] 请求已取消。" }],
        };
      }
      try {
        if (params.name === "js_reset") {
          return await broker.request("repl/reset", {}, { timeoutMs: 5000, signal });
        }
        if (params.name === "js") {
          const reqTimeout = params.arguments?.timeout_ms;
          const timeoutMs =
            Number.isInteger(reqTimeout) && reqTimeout > 0
              ? Math.min(reqTimeout, MAX_REPL_TIMEOUT_MS)
              : DEFAULT_REPL_TIMEOUT_MS;
          const rawResult = await broker.request(
            "repl/run",
            {
              code: params.arguments?.code,
              timeout_ms: timeoutMs,
              title: params.arguments?.title,
              requestMeta: req._meta ?? {},
            },
            {
              timeoutMs: Math.min(MAX_REPL_TIMEOUT_MS + 15_000, timeoutMs + 10_000),
              signal,
            }
          );
          return truncateMcpResultTo256KiB(attachPillHint(rawResult));
        }
        throw new Error(`Unsupported tool: ${params.name}`);
      } catch (err) {
        if (signal?.aborted || err?.aborted) {
          return {
            isError: true,
            content: [{ type: "text", text: "[CANCELLED] 请求已取消。" }],
          };
        }
        const msg = err instanceof Error ? err.message : String(err);
        const text =
          err?.code === "BROKER_UNAVAILABLE" || /BROKER_UNAVAILABLE/u.test(msg)
            ? msg
            : `[REPL_RPC_ERROR] ${msg}`;
        return truncateMcpResultTo256KiB({
          isError: true,
          content: [{ type: "text", text }],
        });
      }
    },
    onClose: () => broker.close(),
  });
}

if (isMainModule(import.meta.url)) {
  runReplMcpServer().catch((err) => {
    console.error("[codex-style-computer-use-repl]", err);
    process.exit(1);
  });
}
