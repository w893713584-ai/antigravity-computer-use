import net from "node:net";
import { BROKER_SOCKET_PATH, MAX_LINE_BUFFER_BYTES } from "./constants.mjs";
import { ComputerUseBrokerServer } from "./broker-sidecar.mjs";

const DEFAULT_TIMEOUT_MS = 45_000;
const READ_ONLY_TOOLS = new Set(["list_apps", "get_app_state", "query"]);
const RECONNECTABLE_ERR_RE = /ENOENT|ECONNREFUSED|EACCES|EPIPE|ECONNRESET|socket closed/i;

function isMutatingRpc(method, params) {
  if (method === "repl/run" || method === "repl/reset") return true;
  if (method !== "tools/call") return false;
  if (params?.name === "get_app_state" && params?.arguments?.allow_launch === true) return true;
  return !READ_ONLY_TOOLS.has(params?.name);
}

function createAbortError(message = "Broker RPC aborted") {
  const err = new Error(message);
  err.name = "AbortError";
  err.aborted = true;
  return err;
}

async function sleepWithAbortSignal(ms, signal = null) {
  if (ms <= 0) return;
  if (signal?.aborted) throw createAbortError();
  await new Promise((resolve, reject) => {
    let timer = null;
    const onAbort = () => {
      if (timer) clearTimeout(timer);
      reject(createAbortError());
    };
    timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Connects MCP servers (`computer-use` and `computer-use-js`) to the running
 * Antigravity Sidecar Broker over Unix Domain Socket so every AI tool call
 * automatically streams into the Side-Pane Mini-Window without raising windows.
 */
export class BrokerRpcClient {
  constructor({ socketPath = BROKER_SOCKET_PATH, enableFallback = false } = {}) {
    this.socketPath = socketPath;
    this.enableFallback = enableFallback;
    this.conn = null;
    this.connecting = null;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = "";
    this.fallbackBroker = null;
  }

  #sendCancelNotification(requestId) {
    if (!this.conn || this.conn.destroyed || !this.conn.writable) return;
    try {
      this.conn.write(
        `${JSON.stringify({ jsonrpc: "2.0", method: "rpc/cancel", params: { requestId } })}\n`,
        () => {}
      );
    } catch {}
  }

  async #connectSocket() {
    if (this.conn && !this.conn.destroyed && this.conn.writable) return this.conn;
    if (this.connecting) return this.connecting;

    this.connecting = new Promise((resolve, reject) => {
      const socket = net.createConnection(this.socketPath);
      socket.setEncoding("utf8");

      const onError = (err) => {
        socket.destroy();
        reject(err);
      };

      socket.once("error", onError);
      socket.once("connect", () => {
        socket.removeListener("error", onError);
        this.conn = socket;
        this.buffer = "";
        socket.on("data", (chunk) => this.#onData(chunk));
        socket.on("error", (err) => this.#teardown(err));
        socket.on("close", () => this.#teardown(new Error("broker socket closed")));
        // Reclaim fallback broker resources once primary sidecar is back online
        if (this.fallbackBroker) {
          const fb = this.fallbackBroker;
          this.fallbackBroker = null;
          void fb.close().catch(() => {});
        }
        resolve(socket);
      });
    }).finally(() => {
      this.connecting = null;
    });

    return this.connecting;
  }

  #onData(chunk) {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer, "utf8") > MAX_LINE_BUFFER_BYTES) {
      this.#teardown(new Error("Broker RPC response exceeded 32MB limit"));
      return;
    }
    let nl;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
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
      const entry = this.pending.get(String(msg.id));
      if (!entry) continue;
      this.pending.delete(String(msg.id));
      if (entry.timer) clearTimeout(entry.timer);
      if (msg.error) {
        entry.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      } else {
        entry.resolve(msg.result);
      }
    }
  }

  #teardown(err) {
    if (this.conn) {
      try {
        this.conn.destroy();
      } catch {}
      this.conn = null;
    }
    for (const entry of this.pending.values()) {
      if (entry.timer) clearTimeout(entry.timer);
      const entryErr = new Error(err?.message || "broker socket closed", { cause: err });
      if (err?.code) entryErr.code = err.code;
      entryErr.dispatched = Boolean(entry.dispatched);
      entry.reject(entryErr);
    }
    this.pending.clear();
  }

  async #sendOnce(method, params, timeoutMs, signal = null) {
    if (signal?.aborted) {
      const abortErr = createAbortError();
      abortErr.dispatched = false;
      throw abortErr;
    }
    const conn = await this.#connectSocket();
    if (signal?.aborted) {
      const abortErr = createAbortError();
      abortErr.dispatched = false;
      throw abortErr;
    }
    if (conn.destroyed || !conn.writable) {
      const deadErr = new Error("broker socket closed");
      deadErr.dispatched = false;
      this.#teardown(deadErr);
      throw deadErr;
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        if (entry.timer) clearTimeout(entry.timer);
        if (signal && onAbort) {
          signal.removeEventListener("abort", onAbort);
        }
      };
      const entry = {
        resolve: (val) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(val);
        },
        reject: (err) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(err);
        },
        dispatched: false,
        timer:
          timeoutMs > 0
            ? setTimeout(() => {
                this.pending.delete(String(id));
                this.#sendCancelNotification(id);
                const timeoutErr = new Error(`Broker RPC ${method} timed out after ${timeoutMs}ms`);
                timeoutErr.dispatched = Boolean(entry.dispatched);
                entry.reject(timeoutErr);
              }, timeoutMs)
            : null,
      };
      const onAbort = () => {
        const abortErr = createAbortError();
        abortErr.dispatched = Boolean(entry.dispatched);
        this.pending.delete(String(id));
        this.#sendCancelNotification(id);
        entry.reject(abortErr);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(String(id), entry);

      try {
        const frame = `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
        // Mark potentially dispatched BEFORE handing bytes to OS socket so an executed
        // mutation can never replay if remote closes before the async write callback runs.
        entry.dispatched = true;
        conn.write(frame, (writeErr) => {
          if (writeErr) {
            if (!this.pending.has(String(id))) return;
            this.pending.delete(String(id));
            const localErr = new Error(writeErr?.message || "socket write failed", { cause: writeErr });
            if (writeErr?.code) localErr.code = writeErr.code;
            localErr.dispatched = true;
            this.#teardown(writeErr);
            entry.reject(localErr);
          }
        });
      } catch (syncErr) {
        this.pending.delete(String(id));
        const localErr = new Error(syncErr?.message || "socket write failed", { cause: syncErr });
        if (syncErr?.code) localErr.code = syncErr.code;
        localErr.dispatched = Boolean(entry.dispatched);
        this.#teardown(syncErr);
        entry.reject(localErr);
      }
    });
  }

  async #ensureFallbackBroker() {
    if (!this.fallbackBroker) {
      this.fallbackBroker = new ComputerUseBrokerServer({
        webPort: 0,
        socketPath: `${this.socketPath}.fallback-${process.pid}`,
        infoPath: null,
      });
    }
    return this.fallbackBroker;
  }

  async request(method, params = {}, timeoutOrOptions = DEFAULT_TIMEOUT_MS) {
    const isObjOpts = typeof timeoutOrOptions === "object" && timeoutOrOptions !== null;
    const timeoutMs = isObjOpts
      ? Number.isFinite(Number(timeoutOrOptions.timeoutMs))
        ? Number(timeoutOrOptions.timeoutMs)
        : DEFAULT_TIMEOUT_MS
      : timeoutOrOptions;
    const signal = isObjOpts ? timeoutOrOptions.signal || null : null;

    if (signal?.aborted) {
      throw createAbortError();
    }

    const mutating = isMutatingRpc(method, params);
    try {
      return await this.#sendOnce(method, params, timeoutMs, signal);
    } catch (err) {
      if (err?.aborted || signal?.aborted) {
        throw err?.aborted ? err : createAbortError();
      }
      // Never replay a mutating action if it was already written to the socket before disconnect!
      if (mutating && err?.dispatched) {
        throw err;
      }

      const errSig = String(err?.code || err?.message || "");
      if (!RECONNECTABLE_ERR_RE.test(errSig)) {
        throw err;
      }

      // Brief backoff + single reconnect attempt (abortable immediately if signal cancels)
      await sleepWithAbortSignal(150, signal);
      try {
        return await this.#sendOnce(method, params, timeoutMs, signal);
      } catch (retryErr) {
        if (retryErr?.aborted || signal?.aborted) {
          throw retryErr?.aborted ? retryErr : createAbortError();
        }
        if (mutating && retryErr?.dispatched) {
          throw retryErr;
        }
        if (
          this.enableFallback &&
          RECONNECTABLE_ERR_RE.test(String(retryErr?.code || retryErr?.message || ""))
        ) {
          if (signal?.aborted) throw createAbortError();
          const fb = await this.#ensureFallbackBroker();
          if (signal?.aborted) throw createAbortError();
          if (method === "tools/list") return fb.getToolsList();
          if (method === "tools/call") {
            return fb.executeToolCall(params?.name, params?.arguments || {}, {
              source: params?.source === "ai-repl" ? "ai-repl" : "ai",
              signal,
            });
          }
        }
        if (
          !this.enableFallback &&
          RECONNECTABLE_ERR_RE.test(String(retryErr?.code || retryErr?.message || ""))
        ) {
          const unavailErr = new Error(
            `[BROKER_UNAVAILABLE] 主 Sidecar Broker (${this.socketPath}) 不可达，已拒绝本地降级执行以免脱离接管控制 (${retryErr.message})`,
            { cause: retryErr }
          );
          unavailErr.code = "BROKER_UNAVAILABLE";
          unavailErr.dispatched = Boolean(retryErr?.dispatched);
          throw unavailErr;
        }
        throw retryErr;
      }
    }
  }

  async close() {
    this.#teardown(new Error("client closed"));
    if (this.fallbackBroker) {
      await this.fallbackBroker.close();
      this.fallbackBroker = null;
    }
  }
}
