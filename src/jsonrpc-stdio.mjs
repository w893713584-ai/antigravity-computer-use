import process from "node:process";
import { MAX_LINE_BUFFER_BYTES, SIDECAR_PILL_MARKDOWN } from "./constants.mjs";

export const ONE_TIME_PILL_HINT = `[Side-pane live view: include ${SIDECAR_PILL_MARKDOWN} once in your reply to the user so the live mini-window opens on the right side of Antigravity.]`;

export function createOneTimePillHintAttacher(defaultHint = ONE_TIME_PILL_HINT) {
  let pillHintSent = false;
  return function attachPillHint(result, overrideHintText = null) {
    if (pillHintSent || !result || result.isError || !Array.isArray(result.content)) {
      return result;
    }
    const hintText = overrideHintText || defaultHint;
    if (!hintText) return result;
    pillHintSent = true;
    return {
      ...result,
      content: [...result.content, { type: "text", text: hintText }],
    };
  };
}

/**
 * Shared JSON-RPC 2.0 stdio transport adapter for `mcp-server.mjs` and `mcp-repl-server.mjs`.
 * Handles line-delimited framing, 32MB buffer guard, serialized async request execution,
 * `initialize` / `ping` / `tools/list` / `tools/call` routing, one-time Sidecar pill hint
 * injection, and signal/EOF shutdown.
 */
export function runJsonRpcStdioServer({
  serverInfo,
  instructions = "",
  onListTools,
  onCallTool,
  onClose = async () => {},
  input = process.stdin,
  output = process.stdout,
  registerSignals = true,
  abortOnEnd = input === process.stdin,
  maxLineBufferBytes = MAX_LINE_BUFFER_BYTES,
}) {
  let buffer = "";
  let bufBytes = 0;
  let scanOffset = 0;
  let discardingOversizedLine = false;
  let endedCleanly = false;
  let queue = Promise.resolve();
  let clientInfo = null;
  const attachPillHint = createOneTimePillHintAttacher();
  const stdioAbortController = new AbortController();
  const inFlightControllers = new Map();
  const cancelledRequestIds = new Set();

  function abortRequestById(requestId, reason = "notifications/cancelled") {
    if (requestId === undefined || requestId === null) return;
    const key = String(requestId);
    const ctrl = inFlightControllers.get(key);
    if (ctrl) {
      if (!ctrl.signal.aborted) ctrl.abort(new Error(reason));
      return;
    }
    if (cancelledRequestIds.size >= 256) cancelledRequestIds.clear();
    cancelledRequestIds.add(key);
  }

  function abortAll(reason = "transport_closed") {
    if (!stdioAbortController.signal.aborted) {
      stdioAbortController.abort(new Error(reason));
    }
    for (const ctrl of inFlightControllers.values()) {
      if (!ctrl.signal.aborted) ctrl.abort(new Error(reason));
    }
    inFlightControllers.clear();
  }

  function send(payload) {
    if (!output || output.destroyed || output.writableEnded) return;
    try {
      output.write(`${JSON.stringify(payload)}\n`);
    } catch {}
  }

  function isPlainObject(v) {
    return typeof v === "object" && v !== null && !Array.isArray(v);
  }

  async function handleLine(line) {
    let req;
    try {
      req = JSON.parse(line);
    } catch {
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      return;
    }

    if (
      !isPlainObject(req) ||
      typeof req.method !== "string" ||
      (req.params !== undefined && req.params !== null && !isPlainObject(req.params))
    ) {
      const errId =
        isPlainObject(req) &&
        (typeof req.id === "string" || typeof req.id === "number" || req.id === null)
          ? req.id
          : null;
      send({
        jsonrpc: "2.0",
        id: errId,
        error: { code: -32600, message: "Invalid Request" },
      });
      return;
    }

    const { id, method } = req;
    const params = isPlainObject(req.params) ? req.params : {};
    if (id === undefined) {
      return;
    }

    let currentCallSignal = null;
    try {
      if (method === "initialize") {
        if (isPlainObject(params.clientInfo)) {
          clientInfo = params.clientInfo;
        }
        const resolvedInstructions =
          typeof instructions === "function" ? instructions(params, clientInfo) : instructions;
        send({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: params.protocolVersion || "2025-06-18",
            capabilities: { tools: { listChanged: false } },
            serverInfo,
            instructions: resolvedInstructions,
          },
        });
        return;
      }

      if (method === "ping") {
        send({ jsonrpc: "2.0", id, result: {} });
        return;
      }

      if (method === "tools/list") {
        const result = await onListTools(params, req, { clientInfo });
        send({ jsonrpc: "2.0", id, result });
        return;
      }

      if (method === "tools/call") {
        const callAbort = new AbortController();
        currentCallSignal = callAbort.signal;
        const key = String(id);
        const onStdioAbort = () => {
          if (!callAbort.signal.aborted) {
            callAbort.abort(stdioAbortController.signal.reason || new Error("stdio_closed"));
          }
        };
        if (stdioAbortController.signal.aborted) {
          callAbort.abort(stdioAbortController.signal.reason || new Error("stdio_closed"));
        } else if (cancelledRequestIds.delete(key)) {
          callAbort.abort(new Error("notifications/cancelled"));
        } else {
          stdioAbortController.signal.addEventListener("abort", onStdioAbort, { once: true });
        }
        inFlightControllers.set(key, callAbort);
        try {
          if (callAbort.signal.aborted) {
            return;
          }
          const result = await onCallTool(params, req, {
            attachPillHint,
            signal: callAbort.signal,
            clientInfo,
          });
          if (!callAbort.signal.aborted) {
            send({ jsonrpc: "2.0", id, result });
          }
        } finally {
          inFlightControllers.delete(key);
          stdioAbortController.signal.removeEventListener("abort", onStdioAbort);
        }
        return;
      }

      send({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Unsupported MCP method: ${method}` },
      });
    } catch (err) {
      if (currentCallSignal?.aborted || stdioAbortController.signal.aborted || err?.aborted) {
        return;
      }
      send({
        jsonrpc: "2.0",
        id,
        error: {
          code: -32603,
          message: err instanceof Error ? err.message : String(err),
        },
      });
    }
  }

  function enqueueOversizedError() {
    queue = queue
      .then(() => {
        send({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32600, message: "Request exceeded 32MB limit" },
        });
      })
      .catch(() => {});
  }

  input.setEncoding?.("utf8");
  input.on("data", (chunk) => {
    let incoming = String(chunk);
    if (discardingOversizedLine) {
      const nl = incoming.indexOf("\n");
      if (nl < 0) return;
      discardingOversizedLine = false;
      incoming = incoming.slice(nl + 1);
    }

    buffer += incoming;
    bufBytes += Buffer.byteLength(incoming, "utf8");
    for (;;) {
      const nl = buffer.indexOf("\n", scanOffset);
      if (nl < 0) {
        scanOffset = buffer.length;
        break;
      }
      const rawLine = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      scanOffset = 0;
      bufBytes = buffer.length ? Buffer.byteLength(buffer, "utf8") : 0;
      if (Buffer.byteLength(rawLine, "utf8") > maxLineBufferBytes) {
        enqueueOversizedError();
        continue;
      }
      const line = rawLine.trim();
      if (line) {
        let quickMethod = null;
        if (
          line.includes("cancelled") ||
          line.includes('"initialize"') ||
          line.includes('"ping"') ||
          line.includes('"tools/list"')
        ) {
          try {
            const quick = JSON.parse(line);
            if (isPlainObject(quick) && typeof quick.method === "string") {
              quickMethod = quick.method;
              if (quick.method === "notifications/cancelled") {
                abortRequestById(quick.params?.requestId, "notifications/cancelled");
              }
            }
          } catch {}
        }
        if (
          inFlightControllers.size > 0 &&
          (quickMethod === "ping" || quickMethod === "tools/list")
        ) {
          void handleLine(line).catch(() => {});
        } else {
          queue = queue.then(() => handleLine(line)).catch(() => {});
        }
      }
    }

    if (bufBytes > maxLineBufferBytes) {
      buffer = "";
      bufBytes = 0;
      scanOffset = 0;
      discardingOversizedLine = true;
      enqueueOversizedError();
    }
  });

  const signalHandlers = [];
  let closePromise = null;
  function closeOnce() {
    if (!closePromise) {
      for (const [sig, fn] of signalHandlers) {
        process.removeListener(sig, fn);
      }
      signalHandlers.length = 0;
      closePromise = Promise.resolve().then(() => onClose());
    }
    return closePromise;
  }

  if (registerSignals) {
    for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
      const fn = () => {
        abortAll(sig);
        closeOnce()
          .catch(() => {})
          .finally(() => process.exit(0));
      };
      signalHandlers.push([sig, fn]);
      process.on(sig, fn);
    }
  }

  input.on("error", () => abortAll("stdin_error"));
  output.on("error", () => abortAll("stdout_error"));
  output.on("close", () => abortAll("stdout_close"));
  input.on("close", () => {
    if (abortOnEnd || !endedCleanly) {
      abortAll("stdin_close");
    }
    if (!endedCleanly) {
      void closeOnce()
        .catch(() => {})
        .finally(() => {
          if (input === process.stdin && registerSignals) {
            process.exit(0);
          }
        });
    }
  });
  input.on("end", () => {
    endedCleanly = true;
    if (abortOnEnd) {
      abortAll("stdin_end");
    }
    queue.finally(() => {
      void closeOnce()
        .catch(() => {})
        .finally(() => {
          if (input === process.stdin && registerSignals) {
            process.exit(0);
          }
        });
    });
  });

  return { attachPillHint };
}
