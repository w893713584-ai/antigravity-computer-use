#!/usr/bin/env node

import process from "node:process";
import {
  buildT3OneTimePillHint,
  detectMcpHost,
  formatT3LiveViewUrl,
  isMainModule,
} from "./constants.mjs";
import { BrokerRpcClient } from "./broker-client.mjs";
import { ONE_TIME_PILL_HINT, runJsonRpcStdioServer } from "./jsonrpc-stdio.mjs";
import {
  DEFAULT_REPL_TIMEOUT_MS,
  MAX_REPL_TIMEOUT_MS,
  getReplServerInstructions,
  getReplToolDefinitions,
  truncateMcpResultTo256KiB,
} from "./repl-schema.mjs";

export async function runReplMcpServer() {
  const broker = new BrokerRpcClient({ enableFallback: false });
  let cachedSidecarInfo = null;

  runJsonRpcStdioServer({
    serverInfo: { name: "codex-style-computer-use-repl", version: "1.1.6" },
    instructions: (_params, clientInfo) =>
      getReplServerInstructions({ host: detectMcpHost(process.env, clientInfo) }),
    onListTools: async (_params, _req, { clientInfo } = {}) => {
      const host = detectMcpHost(process.env, clientInfo);
      try {
        const res = await broker.request("repl/tools", { host }, { timeoutMs: 3000 });
        if (Array.isArray(res?.tools) && res.tools.length > 0) {
          return res;
        }
      } catch {}
      return { tools: getReplToolDefinitions({ host }) };
    },
    onCallTool: async (params, req, { attachPillHint, signal, clientInfo }) => {
      if (signal?.aborted) {
        return {
          isError: true,
          content: [{ type: "text", text: "[CANCELLED] 请求已取消。" }],
        };
      }
      const host = detectMcpHost(process.env, clientInfo);
      try {
        if (params.name === "js_reset") {
          return await broker.request("repl/reset", {}, { timeoutMs: 5000, signal });
        }
        if (params.name === "js") {
          if (host === "t3" && !cachedSidecarInfo) {
            cachedSidecarInfo = await broker
              .request("sidecar/info", {}, { timeoutMs: 1500 })
              .catch(() => null);
          }
          const t3LiveUrl =
            host === "t3"
              ? formatT3LiveViewUrl(cachedSidecarInfo?.webPort, cachedSidecarInfo?.uiToken)
              : "";
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
              host,
              ...(t3LiveUrl ? { t3LiveUrl } : {}),
            },
            {
              timeoutMs: Math.min(MAX_REPL_TIMEOUT_MS + 15_000, timeoutMs + 10_000),
              signal,
            }
          );
          const hint =
            host === "t3"
              ? buildT3OneTimePillHint(cachedSidecarInfo?.webPort, cachedSidecarInfo?.uiToken)
              : ONE_TIME_PILL_HINT;
          return truncateMcpResultTo256KiB(attachPillHint(rawResult, hint));
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
