import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BROKER_SOCKET_PATH,
  BROKER_SPAWN_LOCK_PATH,
  MAX_LINE_BUFFER_BYTES,
  sanitizeHostEnv,
} from "./constants.mjs";
import { ComputerUseBrokerServer } from "./broker-sidecar.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_BROKER_SCRIPT_PATH = path.join(__dirname, "broker-sidecar.mjs");
const DEFAULT_TIMEOUT_MS = 45_000;
const READ_ONLY_TOOLS = new Set(["list_apps", "get_app_state", "query"]);
const RECONNECTABLE_ERR_RE = /ENOENT|ECONNREFUSED|EACCES|EPIPE|ECONNRESET|socket closed/i;
const MISSING_DAEMON_ERR_RE = /ENOENT|ECONNREFUSED/i;

function isMutatingRpc(method, params) {
  if (method === "repl/run" || method === "repl/reset") return true;
  if (method !== "tools/call") return false;
  if (params?.name === "get_app_state" && params?.arguments?.allow_launch === true) return true;
  return !READ_ONLY_TOOLS.has(params?.name);
}

function isPidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
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
 * Antigravity Sidecar Broker (or on-demand standalone Broker in T3 Code) over
 * Unix Domain Socket so every AI tool call streams into the Mini-Window without raising windows.
 */
export class BrokerRpcClient {
  constructor({
    socketPath = BROKER_SOCKET_PATH,
    enableFallback = false,
    autoSpawn = socketPath === BROKER_SOCKET_PATH && !process.env.AGY_CUA_BROKER_SOCK,
    spawnFn = spawn,
    brokerScriptPath = DEFAULT_BROKER_SCRIPT_PATH,
    lockPath = BROKER_SPAWN_LOCK_PATH,
    clientSessionId = crypto.randomUUID(),
  } = {}) {
    this.socketPath = socketPath;
    this.enableFallback = enableFallback;
    this.autoSpawn = Boolean(autoSpawn);
    this.spawnFn = spawnFn;
    this.brokerScriptPath = brokerScriptPath;
    this.lockPath = lockPath;
    this.clientSessionId = clientSessionId;
    this.conn = null;
    this.connecting = null;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = "";
    this.bufBytes = 0;
    this.scanOffset = 0;
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

  async #probeSocketReady() {
    return new Promise((resolve) => {
      let settled = false;
      const done = (ok) => {
        if (settled) return;
        settled = true;
        try {
          s.destroy();
        } catch {}
        resolve(ok);
      };
      const s = net.createConnection(this.socketPath);
      const t = setTimeout(() => done(false), 250);
      t.unref?.();
      s.once("connect", () => {
        clearTimeout(t);
        done(true);
      });
      s.once("error", () => {
        clearTimeout(t);
        done(false);
      });
    });
  }

  #tryAcquireSpawnLock() {
    if (!this.lockPath) return true;
    try {
      mkdirSync(path.dirname(this.lockPath), { recursive: true, mode: 0o700 });
    } catch {}
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const fd = openSync(this.lockPath, "wx", 0o600);
        try {
          writeSync(fd, JSON.stringify({ pid: process.pid, ts: Date.now() }));
        } catch {}
        try {
          closeSync(fd);
        } catch {}
        return true;
      } catch (err) {
        if (err?.code !== "EEXIST" || attempt > 0) return false;
        try {
          const st = statSync(this.lockPath);
          let lockPid = 0;
          try {
            const parsed = JSON.parse(readFileSync(this.lockPath, "utf8"));
            lockPid = Number(parsed?.pid || 0);
          } catch {}
          const isStale =
            Date.now() - st.mtimeMs > 10_000 || (lockPid > 0 && !isPidAlive(lockPid));
          if (!isStale) return false;
          rmSync(this.lockPath, { force: true });
        } catch {
          return false;
        }
      }
    }
    return false;
  }

  async #ensureDaemonBroker(signal = null) {
    if (!this.autoSpawn || signal?.aborted) return false;
    if (await this.#probeSocketReady()) return true;

    const ownsLock = this.#tryAcquireSpawnLock();
    try {
      if (ownsLock && typeof this.spawnFn === "function") {
        const child = this.spawnFn(process.execPath, [this.brokerScriptPath], {
          detached: true,
          stdio: "ignore",
          env: sanitizeHostEnv(process.env),
        });
        child?.on?.("error", () => {});
        child?.unref?.();
      }

      const deadline = Date.now() + 6000;
      while (Date.now() < deadline) {
        if (signal?.aborted) throw createAbortError();
        if (await this.#probeSocketReady()) {
          return true;
        }
        await sleepWithAbortSignal(100, signal);
      }
      return await this.#probeSocketReady();
    } finally {
      if (ownsLock && this.lockPath && existsSync(this.lockPath)) {
        try {
          rmSync(this.lockPath, { force: true });
        } catch {}
      }
    }
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
        this.bufBytes = 0;
        this.scanOffset = 0;
        socket.on("data", (chunk) => {
          if (this.conn !== socket) return;
          this.#onData(chunk);
        });
        socket.on("error", (err) => {
          if (this.conn !== socket) return;
          this.#teardown(err, socket);
        });
        socket.on("close", () => {
          if (this.conn !== socket) return;
          this.#teardown(new Error("broker socket closed"), socket);
        });
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
    const strChunk = String(chunk);
    this.buffer += strChunk;
    this.bufBytes += Buffer.byteLength(strChunk, "utf8");
    if (this.bufBytes > MAX_LINE_BUFFER_BYTES) {
      this.#teardown(new Error("Broker RPC response exceeded 32MB limit"));
      return;
    }
    for (;;) {
      const nl = this.buffer.indexOf("\n", this.scanOffset);
      if (nl < 0) {
        this.scanOffset = this.buffer.length;
        break;
      }
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      this.scanOffset = 0;
      this.bufBytes = this.buffer.length ? Buffer.byteLength(this.buffer, "utf8") : 0;
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

  #teardown(err, targetSocket = null) {
    if (targetSocket && this.conn && this.conn !== targetSocket) {
      try {
        targetSocket.destroy();
      } catch {}
      return;
    }
    if (this.conn) {
      try {
        this.conn.destroy();
      } catch {}
      this.conn = null;
    }
    this.buffer = "";
    this.bufBytes = 0;
    this.scanOffset = 0;
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
      this.#teardown(deadErr, conn);
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
            this.#teardown(writeErr, conn);
            entry.reject(localErr);
          }
        });
      } catch (syncErr) {
        this.pending.delete(String(id));
        const localErr = new Error(syncErr?.message || "socket write failed", { cause: syncErr });
        if (syncErr?.code) localErr.code = syncErr.code;
        localErr.dispatched = Boolean(entry.dispatched);
        this.#teardown(syncErr, conn);
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

    const effectiveParams =
      (method === "repl/run" || method === "repl/reset") &&
      params &&
      typeof params === "object" &&
      !params.clientSessionId
        ? { ...params, clientSessionId: this.clientSessionId }
        : params;

    const mutating = isMutatingRpc(method, effectiveParams);
    try {
      return await this.#sendOnce(method, effectiveParams, timeoutMs, signal);
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

      if (this.autoSpawn && MISSING_DAEMON_ERR_RE.test(errSig)) {
        await this.#ensureDaemonBroker(signal);
      } else {
        await sleepWithAbortSignal(150, signal);
      }

      try {
        return await this.#sendOnce(method, effectiveParams, timeoutMs, signal);
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
            return fb.executeToolCall(effectiveParams?.name, effectiveParams?.arguments || {}, {
              source: effectiveParams?.source === "ai-repl" ? "ai-repl" : "ai",
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
