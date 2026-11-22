import { execFile, spawn } from "node:child_process";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { OPEN_COMPUTER_USE_BIN, buildNativeEnv } from "./constants.mjs";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_BUFFER_BYTES = 32 * 1024 * 1024;
const READ_ONLY_TOOLS = new Set(["list_apps", "get_app_state", "query"]);
const TRANSIENT_AGENT_ERR_RE =
  /agent closed the connection|NSCocoaErrorDomain\s+Code=3840|Code=3840|NSPOSIXErrorDomain\s+Code=61|exited\s*\(|child process is not running/iu;

let nextPeerNamespaceSeq = 1;

function isReadOnlyMcpRequest(method, params) {
  if (method === "tools/list" || method === "ping") return true;
  if (method === "tools/call" && READ_ONLY_TOOLS.has(params?.name)) {
    if (params?.name === "get_app_state" && params?.arguments?.allow_launch === true) {
      return false;
    }
    return true;
  }
  return false;
}

function extractMcpText(result) {
  if (!Array.isArray(result?.content)) return "";
  return result.content
    .filter((item) => item?.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n");
}

/**
 * Persistent, serialized JSON-RPC 2.0 client over `open-computer-use mcp`.
 * Maintains a single native process with an isolated app-agent socket namespace so
 * macOS WindowOcclusionKeepAlive pins and AX element index tables persist without contention.
 */
export class NativeComputerUsePeer extends EventEmitter {
  #ownsSocketNamespace = false;
  #everSpawned = false;
  #agentGenSeq = 0;
  #currentAgentInstanceId = null;

  constructor({
    name = "ocu-peer",
    command = OPEN_COMPUTER_USE_BIN,
    args = ["mcp"],
    envOverrides = {},
    ownsSocketNamespace = undefined,
    onMutatingTimeoutUnknown = null,
    onAgentInstanceCleared = null,
    onChildSpawned = null,
    agentReapFn = null,
    spawnFn = null,
  } = {}) {
    super();
    this.name = name;
    this.command = command;
    this.args = args;
    this.onMutatingTimeoutUnknown = onMutatingTimeoutUnknown;
    this.onAgentInstanceCleared = onAgentInstanceCleared;
    this.onChildSpawned = onChildSpawned;
    this.agentReapFn = agentReapFn;
    this.spawnFn = spawnFn;

    const providedNs =
      typeof envOverrides.OPEN_COMPUTER_USE_AGENT_SOCKET_NAMESPACE === "string"
        ? envOverrides.OPEN_COMPUTER_USE_AGENT_SOCKET_NAMESPACE.trim()
        : "";
    // Compact namespace (<= 14 chars) keeps macOS NSTemporaryDirectory sun_path well under 104 bytes.
    const resolvedNs = providedNs || `p${process.pid.toString(36)}-${nextPeerNamespaceSeq++}`;
    this.#ownsSocketNamespace =
      typeof ownsSocketNamespace === "boolean" ? ownsSocketNamespace : !providedNs;
    this.socketNamespace = resolvedNs;
    this.envOverrides = {
      ...envOverrides,
      OPEN_COMPUTER_USE_AGENT_SOCKET_NAMESPACE: resolvedNs,
    };

    this.child = null;
    this.initialized = false;
    this.initializing = null;
    this.disposed = false;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = "";
    this.stderrTail = "";
    this.queue = Promise.resolve();
  }

  async ensureStarted() {
    if (this.disposed) {
      throw new Error(`${this.name} has been disposed`);
    }
    if (this.child && this.initialized) {
      return;
    }
    if (this.initializing) {
      return this.initializing;
    }
    this.initializing = (async () => {
      this.#spawnChild();
      await this.#rawRequest(
        "initialize",
        {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: `codex-style-${this.name}`, version: "1.0.0" },
        },
        15_000
      );
      this.#rawNotify("notifications/initialized", {});
      this.initialized = true;
    })();
    try {
      await this.initializing;
    } catch (err) {
      this.#teardownChild(err);
      throw err;
    } finally {
      this.initializing = null;
    }
  }

  #spawnChild() {
    this.#everSpawned = true;
    this.#agentGenSeq += 1;
    this.#currentAgentInstanceId = `${this.name}-${this.#agentGenSeq}`;
    const child =
      typeof this.spawnFn === "function"
        ? this.spawnFn(this.command, this.args, {
            env: buildNativeEnv(this.envOverrides),
            stdio: ["pipe", "pipe", "pipe"],
          })
        : spawn(this.command, this.args, {
            env: buildNativeEnv(this.envOverrides),
            stdio: ["pipe", "pipe", "pipe"],
          });
    this.child = child;
    this.initialized = false;
    this.buffer = "";
    this.stderrTail = "";
    this.onChildSpawned?.(child.pid);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdin.on("error", (err) => {
      if (this.child !== child) return;
      this.#teardownChild(err);
    });

    child.stdout.on("data", (chunk) => {
      if (this.child !== child) return;
      this.#handleStdout(chunk);
    });

    child.stderr.on("data", (chunk) => {
      if (this.child !== child) return;
      this.stderrTail = (this.stderrTail + chunk).slice(-8192);
    });

    child.on("error", (err) => {
      if (this.child !== child) return;
      this.#teardownChild(err);
    });

    child.on("exit", (code, signal) => {
      if (this.child !== child) return;
      const detail = this.stderrTail.trim() ? `: ${this.stderrTail.trim()}` : "";
      this.#teardownChild(
        new Error(`${this.name} exited (code=${code ?? "null"}, signal=${signal ?? "null"})${detail}`)
      );
    });
  }

  #handleStdout(chunk) {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer, "utf8") > MAX_BUFFER_BYTES) {
      this.#teardownChild(new Error(`${this.name} stdout frame exceeded 32MB`));
      return;
    }
    for (;;) {
      const nl = this.buffer.indexOf("\n");
      if (nl < 0) break;
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
        continue;
      }
      if (msg.id !== undefined && msg.id !== null && this.pending.has(String(msg.id))) {
        const entry = this.pending.get(String(msg.id));
        this.pending.delete(String(msg.id));
        if (entry.timer) clearTimeout(entry.timer);
        if (msg.error) {
          entry.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        } else {
          entry.resolve(msg.result);
        }
      } else {
        this.emit("notification", msg);
      }
    }
  }

  #teardownChild(reason, { deferAgentClear = false } = {}) {
    const child = this.child;
    const clearedAgentId = this.#currentAgentInstanceId;
    const pendingMutating = Array.from(this.pending.values()).find((e) => e.mutating) || null;
    const shouldDefer = Boolean(deferAgentClear || pendingMutating);
    this.child = null;
    this.initialized = false;
    this.#currentAgentInstanceId = null;
    for (const entry of this.pending.values()) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(reason);
    }
    this.pending.clear();
    if (pendingMutating && !deferAgentClear && clearedAgentId) {
      this.onMutatingTimeoutUnknown?.(clearedAgentId, {
        method: pendingMutating.method,
        params: pendingMutating.params,
        reason: reason instanceof Error ? reason.message : String(reason),
      });
    }
    if (child && !child.killed) {
      try {
        child.stdin?.end?.();
        child.kill?.("SIGTERM");
        const killTimer = setTimeout(() => {
          try {
            child.kill?.("SIGKILL");
          } catch {}
        }, shouldDefer ? 250 : 1000);
        killTimer.unref();
      } catch {}
    }
    if (!clearedAgentId) return;
    if (!shouldDefer) {
      this.onAgentInstanceCleared?.(clearedAgentId);
      return;
    }
    let childExited = !child || child.exitCode !== null || typeof child.once !== "function";
    const waitChildExit = childExited
      ? Promise.resolve()
      : new Promise((resolve) => {
          const t = setTimeout(resolve, 350);
          t.unref?.();
          child.once("exit", () => {
            childExited = true;
            clearTimeout(t);
            resolve();
          });
        });
    void waitChildExit
      .then(async () => {
        if (typeof this.agentReapFn === "function") {
          const res = await this.agentReapFn(clearedAgentId);
          return res !== false && res?.reaped !== false;
        }
        const reapRes = await this.#cleanupIsolatedAgentDaemonAsync({ forceNamespaceCleanup: true });
        return Boolean(reapRes?.reaped) && childExited;
      })
      .then(
        (reaped) => {
          if (reaped) {
            this.onAgentInstanceCleared?.(clearedAgentId);
          }
        },
        () => {}
      );
  }

  #rawNotify(method, params = {}) {
    if (!this.child?.stdin?.writable) return;
    try {
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`, () => {});
    } catch {}
  }

  #rawRequest(method, params = {}, timeoutMs = DEFAULT_TIMEOUT_MS, { beforeWriteCheck = null } = {}) {
    if (!this.child) {
      return Promise.reject(new Error(`${this.name} child process is not running`));
    }
    if (typeof beforeWriteCheck === "function") {
      try {
        beforeWriteCheck();
      } catch (guardErr) {
        return Promise.reject(guardErr);
      }
    }
    const id = this.nextId++;
    const agentInstanceId = this.#currentAgentInstanceId || `${this.name}-${this.#agentGenSeq}`;
    const mutating = !isReadOnlyMcpRequest(method, params);
    return new Promise((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(String(id));
              const err = new Error(`${this.name} ${method} timed out after ${timeoutMs}ms`);
              err.dispatched = true;
              if (mutating) {
                err.code = "WRITE_OUTCOME_UNKNOWN";
                err.deliveryState = "sent_unknown";
                this.onMutatingTimeoutUnknown?.(agentInstanceId, { method, params, timeoutMs });
              }
              this.#teardownChild(err, { deferAgentClear: mutating });
              reject(err);
            }, timeoutMs)
          : null;
      this.pending.set(String(id), {
        resolve,
        reject,
        timer,
        mutating,
        agentInstanceId,
        method,
        params,
      });
      this.child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
        (writeErr) => {
          if (!writeErr) return;
          if (timer) clearTimeout(timer);
          this.pending.delete(String(id));
          reject(writeErr);
        }
      );
    });
  }

  #cleanupIsolatedAgentDaemonAsync({ forceNamespaceCleanup = false } = {}) {
    if (
      typeof this.spawnFn === "function" ||
      process.platform !== "darwin" ||
      (!this.#ownsSocketNamespace && !forceNamespaceCleanup) ||
      !this.#everSpawned ||
      !this.socketNamespace
    ) {
      return Promise.resolve({ reaped: true });
    }
    const nsHash = crypto.createHash("sha256").update(this.socketNamespace).digest("hex").slice(0, 16);
    const sockName = `open-computer-use-agent-${nsHash}.sock`;
    const sockFullPath = path.join(tmpdir(), sockName);
    return new Promise((resolve) => {
      try {
        const reaper = spawn(
          "/bin/sh",
          [
            "-c",
            'sleep 0.08; /usr/bin/pkill -TERM -f "$1" >/dev/null 2>&1 || true; sleep 0.06; if /usr/bin/pgrep -f "$1" >/dev/null 2>&1; then /usr/bin/pkill -KILL -f "$1" >/dev/null 2>&1 || true; sleep 0.05; fi; rm -f "$2"; if /usr/bin/pgrep -f "$1" >/dev/null 2>&1; then exit 1; fi; exit 0',
            "sh",
            sockName,
            sockFullPath,
          ],
          { detached: true, stdio: "ignore" }
        );
        const timer = setTimeout(() => resolve({ reaped: false }), 600);
        timer.unref?.();
        reaper.once("exit", (code) => {
          clearTimeout(timer);
          resolve({ reaped: code === 0 });
        });
        reaper.once("error", () => {
          clearTimeout(timer);
          resolve({ reaped: false });
        });
        reaper.unref();
      } catch {
        resolve({ reaped: false });
      }
    });
  }

  #cleanupIsolatedAgentDaemon({ forceNamespaceCleanup = false, agentInstanceId = null } = {}) {
    void this.#cleanupIsolatedAgentDaemonAsync({ forceNamespaceCleanup }).then((res) => {
      if (agentInstanceId && res?.reaped) {
        this.onAgentInstanceCleared?.(agentInstanceId);
      }
    });
  }

  /**
   * Serialized JSON-RPC request. Automatically boots/reboots the native MCP process,
   * and performs a single safe retry for read-only calls on transient app-agent disconnects.
   */
  request(method, params = {}, timeoutMs = DEFAULT_TIMEOUT_MS, options = {}) {
    const beforeWriteCheck =
      typeof options?.beforeWriteCheck === "function" ? options.beforeWriteCheck : null;
    const task = this.queue.then(async () => {
      try {
        beforeWriteCheck?.();
        await this.ensureStarted();
        const res = await this.#rawRequest(method, params, timeoutMs, { beforeWriteCheck });
        if (
          res?.isError &&
          isReadOnlyMcpRequest(method, params) &&
          TRANSIENT_AGENT_ERR_RE.test(extractMcpText(res))
        ) {
          throw new Error(extractMcpText(res));
        }
        return res;
      } catch (err) {
        if (
          !this.disposed &&
          !err?.aborted &&
          isReadOnlyMcpRequest(method, params) &&
          TRANSIENT_AGENT_ERR_RE.test(err instanceof Error ? err.message : String(err))
        ) {
          this.#teardownChild(err instanceof Error ? err : new Error(String(err)));
          this.#cleanupIsolatedAgentDaemon({ forceNamespaceCleanup: true });
          await new Promise((r) => setTimeout(r, 180));
          beforeWriteCheck?.();
          await this.ensureStarted();
          return this.#rawRequest(method, params, timeoutMs, { beforeWriteCheck });
        }
        throw err;
      }
    });
    // Ensure queue continues even if a single call rejects.
    this.queue = task.catch(() => {});
    return task;
  }

  callTool(name, args = {}, timeoutMs = DEFAULT_TIMEOUT_MS, options = {}) {
    return this.request("tools/call", { name, arguments: args }, timeoutMs, options);
  }

  listTools(timeoutMs = 10_000) {
    return this.request("tools/list", {}, timeoutMs);
  }

  close() {
    this.disposed = true;
    this.#teardownChild(new Error(`${this.name} closed`));
    this.#cleanupIsolatedAgentDaemon();
  }
}
