import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { extractResultImage, extractResultText } from "./background-policy.mjs";
import {
  REPL_MAX_BINDINGS_BYTES,
  REPL_MAX_CALLS_PER_RUN,
  REPL_MAX_LINE_BYTES,
  REPL_MAX_SOURCE_BYTES,
  SCRIPT_RUNNER_APP_PATH,
  SCRIPT_RUNNER_BIN_PATH,
} from "./constants.mjs";
import { verifyNativeAppBundle } from "./native-distribution.mjs";
import {
  DEFAULT_REPL_TIMEOUT_MS,
  MAX_REPL_TIMEOUT_MS,
  REPL_ALLOWED_OPS,
  buildBrokerToolCallForReplOp,
  formatAppsForRepl,
  getReplToolDefinitions,
  truncateMcpResultTo256KiB,
} from "./repl-schema.mjs";
import { isTakeoverAbortedError } from "./takeover-controller.mjs";

function extractImagesFromResult(result) {
  if (!Array.isArray(result?.content)) return [];
  return result.content
    .filter((item) => item?.type === "image" && typeof item.data === "string")
    .map((item) => ({
      mimeType: item.mimeType || "image/jpeg",
      data: item.data,
    }));
}

function classifyToolErrorCode(text) {
  const m = /^\[([A-Z0-9_]+)\]/u.exec(String(text || "").trim());
  return m ? m[1] : "TOOL_ERROR";
}

function validateBindingsPayload(bindings, sessionData) {
  if (!Array.isArray(bindings)) {
    throw new Error("INVALID_BINDINGS_PAYLOAD");
  }
  const normalizedBindings = [];
  for (const item of bindings) {
    if (!item || typeof item !== "object" || typeof item.name !== "string") continue;
    if (!["var", "let", "const"].includes(item.kind)) continue;
    normalizedBindings.push({
      name: item.name,
      kind: item.kind,
      value: item.value,
    });
  }
  const normalizedSession =
    sessionData && typeof sessionData === "object" && !Array.isArray(sessionData)
      ? sessionData
      : {};
  const totalBytes = Buffer.byteLength(
    JSON.stringify({ bindings: normalizedBindings, session: normalizedSession }),
    "utf8"
  );
  if (totalBytes > REPL_MAX_BINDINGS_BYTES) {
    throw new Error("BINDINGS_SIZE_LIMIT_EXCEEDED: persisted REPL state exceeded 64 KiB limit");
  }
  return { bindings: normalizedBindings, session: normalizedSession };
}

/**
 * Per-connection hardened JavaScript sandbox orchestrator.
 * Spawns a fresh OS Seatbelt (`sandbox_init`) + hardened JSC (`CUAScriptRunner.app`) child
 * per `js` turn, maintains serialized bindings & app handles on the Broker outside `#actionQueue`,
 * and fails closed (`SANDBOX_UNAVAILABLE`) if the native runner or self-check is unavailable.
 */
export class StrictReplSessionManager {
  #broker;
  #sessions = new Map();
  #verifiedCache = null;
  #activeRunCount = 0;
  #runWaiters = [];

  constructor({
    broker,
    scriptRunnerAppPath = SCRIPT_RUNNER_APP_PATH,
    scriptRunnerBinPath = SCRIPT_RUNNER_BIN_PATH,
    verifyRunner = true,
    maxConcurrentRuns = 2,
  } = {}) {
    this.#broker = broker;
    this.scriptRunnerAppPath = scriptRunnerAppPath;
    this.scriptRunnerBinPath = scriptRunnerBinPath;
    this.verifyRunner = verifyRunner;
    this.maxConcurrentRuns = Math.max(1, Number(maxConcurrentRuns) || 2);
  }

  async #acquireRunSlot(signal = null) {
    if (this.#activeRunCount < this.maxConcurrentRuns) {
      this.#activeRunCount += 1;
      return;
    }
    await new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error("CANCELLED"));
        return;
      }
      const entry = { resolve: null, onAbort: null };
      const onAbort = () => {
        const idx = this.#runWaiters.indexOf(entry);
        if (idx >= 0) this.#runWaiters.splice(idx, 1);
        reject(new Error("CANCELLED"));
      };
      entry.onAbort = onAbort;
      entry.resolve = () => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#runWaiters.push(entry);
    });
  }

  #releaseRunSlot() {
    while (this.#runWaiters.length > 0) {
      const next = this.#runWaiters.shift();
      if (next?.resolve) {
        next.resolve();
        return;
      }
    }
    this.#activeRunCount = Math.max(0, this.#activeRunCount - 1);
  }

  getToolDefinitions() {
    return { tools: getReplToolDefinitions() };
  }

  #getOrCreateSession(sessionId) {
    const key = String(sessionId || "default");
    let s = this.#sessions.get(key);
    if (!s) {
      s = {
        sessionId: key,
        bindings: [],
        session: {},
        appHandles: new Map(),
        nextHandleSeq: 1,
        docsEmitted: false,
        activeAbortController: null,
        activeChild: null,
        queue: Promise.resolve(),
      };
      this.#sessions.set(key, s);
    }
    return s;
  }

  #wipeSessionState(sessionState) {
    sessionState.bindings = [];
    sessionState.session = {};
    sessionState.appHandles.clear();
    sessionState.docsEmitted = false;
  }

  async #ensureVerifiedRunnerBinary() {
    const binPath = this.scriptRunnerBinPath || SCRIPT_RUNNER_BIN_PATH;
    if (!binPath || !existsSync(binPath)) {
      return {
        ok: false,
        reason: `CUAScriptRunner binary missing at ${binPath}`,
      };
    }

    if (!this.verifyRunner || binPath !== SCRIPT_RUNNER_BIN_PATH) {
      return { ok: true, binPath };
    }

    if (!existsSync(this.scriptRunnerAppPath)) {
      return {
        ok: false,
        reason: `CUAScriptRunner.app bundle missing at ${this.scriptRunnerAppPath}`,
      };
    }

    const st = statSync(binPath);
    if (
      this.#verifiedCache &&
      this.#verifiedCache.binPath === binPath &&
      this.#verifiedCache.mtimeMs === st.mtimeMs &&
      this.#verifiedCache.size === st.size
    ) {
      return this.#verifiedCache.result;
    }

    const check = await verifyNativeAppBundle(this.scriptRunnerAppPath, {
      role: "scriptRunner",
      skipSelfTest: false,
    });
    const res = check.ok
      ? { ok: true, binPath }
      : { ok: false, reason: check.reason || "runner_verification_failed" };
    if (res.ok) {
      this.#verifiedCache = {
        binPath,
        mtimeMs: st.mtimeMs,
        size: st.size,
        result: res,
      };
    }
    return res;
  }

  async reset(sessionId) {
    const session = this.#getOrCreateSession(sessionId);
    if (session.activeAbortController && !session.activeAbortController.signal.aborted) {
      session.activeAbortController.abort(new Error("js_reset"));
    }
    if (session.activeChild && session.activeChild.exitCode === null) {
      try {
        session.activeChild.kill("SIGKILL");
      } catch {}
    }
    const task = session.queue
      .catch(() => {})
      .then(() => {
        this.#wipeSessionState(session);
        return {
          content: [{ type: "text", text: "Computer Use JavaScript session reset" }],
          isError: false,
        };
      });
    session.queue = task.catch(() => {});
    return task;
  }

  async closeSession(sessionId) {
    const key = String(sessionId || "");
    const session = this.#sessions.get(key);
    if (!session) return;
    this.#sessions.delete(key);
    if (session.activeAbortController && !session.activeAbortController.signal.aborted) {
      session.activeAbortController.abort(new Error("session_closed"));
    }
    if (session.activeChild && session.activeChild.exitCode === null) {
      try {
        session.activeChild.kill("SIGKILL");
      } catch {}
    }
    this.#wipeSessionState(session);
  }

  async closeAll() {
    const ids = Array.from(this.#sessions.keys());
    for (const id of ids) {
      await this.closeSession(id);
    }
  }

  run(sessionId, params = {}, { signal = null } = {}) {
    const session = this.#getOrCreateSession(sessionId);
    const task = session.queue
      .catch(() => {})
      .then(() => this.#runUnlocked(session, params, { signal }));
    session.queue = task.catch(() => {});
    return task;
  }

  async #runUnlocked(session, params = {}, { signal = null } = {}) {
    if (process.env.AGY_CUA_JS === "off") {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: "[SANDBOX_DISABLED] AGY_CUA_JS=off 已禁用 js 脚本执行；结构化 computer-use 工具仍可正常使用。",
          },
        ],
      };
    }

    const code = params?.code;
    if (typeof code !== "string" || !code.trim()) {
      return {
        isError: true,
        content: [{ type: "text", text: "Error: js expects non-empty JavaScript source" }],
      };
    }
    if (Buffer.byteLength(code, "utf8") > REPL_MAX_SOURCE_BYTES) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Error: [SOURCE_TOO_LARGE] js source exceeds ${REPL_MAX_SOURCE_BYTES} bytes limit`,
          },
        ],
      };
    }

    const runnerCheck = await this.#ensureVerifiedRunnerBinary();
    if (!runnerCheck.ok) {
      this.#wipeSessionState(session);
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `[SANDBOX_UNAVAILABLE] Strict Seatbelt+JSC script sandbox is unavailable (${runnerCheck.reason}). Fallback to unsandboxed Node worker is disabled; structured computer-use tools remain available.`,
          },
        ],
      };
    }

    if (signal?.aborted) {
      this.#wipeSessionState(session);
      return {
        isError: true,
        content: [{ type: "text", text: "[CANCELLED] 请求已在启动前取消。" }],
      };
    }

    const reqTimeout = params?.timeout_ms;
    const timeoutMs =
      Number.isInteger(reqTimeout) && reqTimeout > 0
        ? Math.min(reqTimeout, MAX_REPL_TIMEOUT_MS)
        : DEFAULT_REPL_TIMEOUT_MS;

    const runAbort = new AbortController();
    const onExternalAbort = () => {
      if (!runAbort.signal.aborted) {
        runAbort.abort(signal?.reason || new Error("CANCELLED"));
      }
    };
    signal?.addEventListener("abort", onExternalAbort, { once: true });

    let operation;
    try {
      operation = this.#broker.takeoverController.admit({
        name: "repl:run",
        isAi: true,
        isMutating: false,
        allowReadWhenPaused: true,
        signal: runAbort.signal,
      });
      operation.isRepl = true;
    } catch (err) {
      signal?.removeEventListener("abort", onExternalAbort);
      if (isTakeoverAbortedError(err)) {
        return {
          isError: true,
          content: [{ type: "text", text: `[${err.code}] ${err.message}` }],
        };
      }
      throw err;
    }

    session.activeAbortController = runAbort;
    const runId = `r-${crypto.randomBytes(6).toString("hex")}`;
    const collectedContent = [];
    const pendingHandles = new Map();
    let runEmittedDocs = false;
    let callCount = 0;
    let callInFlight = false;
    let timedOut = false;
    let abortedReason = null;

    let slotAcquired = false;
    let child = null;
    const killChildNow = (why) => {
      if (!abortedReason && why) abortedReason = why;
      if (!runAbort.signal.aborted) {
        const reasonErr = new Error(why?.message || String(why || "REPL execution aborted"));
        if (why?.code) reasonErr.code = why.code;
        runAbort.abort(reasonErr);
      }
      if (child && child.exitCode === null && child.signalCode === null) {
        try {
          child.kill("SIGKILL");
        } catch {}
      }
    };

    try {
      await this.#acquireRunSlot(operation.signal);
      slotAcquired = true;
    } catch {
      signal?.removeEventListener("abort", onExternalAbort);
      this.#broker.takeoverController.clearOperation(operation);
      if (session.activeAbortController === runAbort) {
        session.activeAbortController = null;
      }
      const isPause =
        operation.signal.reason?.code === "PAUSED" || this.#broker.takeoverController.paused;
      if (isPause) {
        this.#wipeSessionState(session);
        return {
          isError: true,
          content: [{ type: "text", text: `Error: [PAUSED] ${operation.signal.reason?.message || "Computer Use 已被暂停。"}` }],
        };
      }
      this.#wipeSessionState(session);
      return {
        isError: true,
        content: [{ type: "text", text: "Error: [CANCELLED] js execution cancelled while waiting for sandbox slot" }],
      };
    }

    const cleanEnv = {
      PATH: "/usr/bin:/bin",
      LANG: "en_US.UTF-8",
      JSC_useJIT: "false",
      JSC_useWasm: "false",
      JSC_validateOptions: "true",
    };

    child = spawn(runnerCheck.binPath, [], {
      env: cleanEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin?.on?.("error", () => {});
    session.activeChild = child;

    const onOpAbort = () => {
      const reason = operation.signal.reason;
      if (isTakeoverAbortedError(reason)) {
        killChildNow({ code: reason.code || "PAUSED", message: reason.message });
      } else {
        killChildNow({ code: "CANCELLED", message: "js execution cancelled" });
      }
    };
    operation.signal.addEventListener("abort", onOpAbort, { once: true });

    const wallTimer = setTimeout(() => {
      timedOut = true;
      killChildNow({
        code: "TIMEOUT",
        message: `js execution timed out after ${timeoutMs} ms; session reset`,
      });
    }, timeoutMs);
    wallTimer.unref?.();

    const sendToChild = (obj) => {
      if (child.stdin?.destroyed || !child.stdin?.writable) return false;
      try {
        child.stdin.write(`${JSON.stringify(obj)}\n`);
        return true;
      } catch {
        return false;
      }
    };

    const handleRpcCall = async (msg) => {
      if (msg.runId !== runId) return;
      const replyErr = (code, message) => {
        sendToChild({ v: 1, type: "reply", runId, id: msg.id, ok: false, error: { code, message } });
      };

      if (timedOut || runAbort.signal.aborted || operation.signal.aborted) {
        replyErr(
          timedOut ? "TIMEOUT" : "CANCELLED",
          timedOut ? "js execution timed out before dispatching RPC" : "REPL execution already aborted"
        );
        return;
      }

      if (callInFlight) {
        replyErr("CONCURRENT_RPC_NOT_ALLOWED", "Only 1 in-flight desktop RPC per run is permitted");
        return;
      }
      callCount += 1;
      if (callCount > REPL_MAX_CALLS_PER_RUN) {
        replyErr("RPC_CALL_LIMIT_EXCEEDED", `Exceeded max ${REPL_MAX_CALLS_PER_RUN} desktop calls per run`);
        return;
      }

      const op = String(msg.op || "");
      const args = msg.args && typeof msg.args === "object" && !Array.isArray(msg.args) ? msg.args : {};
      if (!REPL_ALLOWED_OPS.has(op)) {
        replyErr("FORBIDDEN_REPL_OP", `Disallowed REPL operation: ${op}`);
        return;
      }

      callInFlight = true;
      try {
        if (timedOut || runAbort.signal.aborted || operation.signal.aborted) {
          replyErr(timedOut ? "TIMEOUT" : "CANCELLED", "REPL execution already aborted");
          return;
        }
        if (op === "cua.getState" || op === "cua.listApps") {
          const raw = await this.#broker.executeToolCall("list_apps", {}, {
            source: "ai-repl",
            parentOperation: operation,
            signal: operation.signal,
            isRepl: true,
          });
          if (raw?.isError) {
            const msgTxt = extractResultText(raw);
            replyErr(classifyToolErrorCode(msgTxt), msgTxt);
            return;
          }
          sendToChild({
            v: 1,
            type: "reply",
            runId,
            id: msg.id,
            ok: true,
            value: { apps: formatAppsForRepl(raw) },
          });
          return;
        }

        if (op === "cua.getApp") {
          const reqApp = typeof args.app === "string" ? args.app.trim() : "";
          if (!reqApp) {
            replyErr("INVALID_ARGS", "getApp requires app name or bundle ID");
            return;
          }
          let initialStateText = "";
          if (args.initialState !== false) {
            const stateRes = await this.#broker.executeToolCall(
              "get_app_state",
              { app: reqApp, text_limit: "max", window_placement: "keep" },
              {
                source: "ai-repl",
                parentOperation: operation,
                signal: operation.signal,
                isRepl: true,
              }
            );
            if (stateRes?.isError) {
              const msgTxt = extractResultText(stateRes);
              replyErr(classifyToolErrorCode(msgTxt), msgTxt);
              return;
            }
            initialStateText = extractResultText(stateRes);
          }
          if (timedOut || runAbort.signal.aborted || operation.signal.aborted) {
            replyErr(
              timedOut ? "TIMEOUT" : "CANCELLED",
              "REPL execution aborted before creating app handle"
            );
            return;
          }
          const appMeta = this.#broker.registry.getMeta(reqApp);
          const handleId = `h-${session.nextHandleSeq++}`;
          pendingHandles.set(handleId, {
            handleId,
            app: reqApp,
            pid: appMeta?.pid || null,
            processToken: appMeta?.processToken || null,
          });
          sendToChild({
            v: 1,
            type: "reply",
            runId,
            id: msg.id,
            ok: true,
            value: {
              handleId,
              app: reqApp,
              ...(initialStateText ? { initialStateText } : {}),
            },
          });
          return;
        }

        const handleId = String(args.handleId || "");
        const handle = pendingHandles.get(handleId) || session.appHandles.get(handleId);
        if (!handle) {
          replyErr("INVALID_APP_HANDLE", `App handle "${handleId}" is missing or expired`);
          return;
        }
        const liveMeta = this.#broker.registry.getMeta(handle.app);
        if (
          (handle.pid && liveMeta?.pid && liveMeta.pid !== handle.pid) ||
          (handle.processToken &&
            liveMeta?.processToken &&
            liveMeta.processToken !== handle.processToken)
        ) {
          replyErr(
            "STALE_APP_HANDLE",
            `[STALE_APP_HANDLE] App handle "${handleId}" is stale (process restarted or changed); call cua.getApp again`
          );
          return;
        }
        if (!handle.pid && liveMeta?.pid) {
          handle.pid = liveMeta.pid;
          handle.processToken = liveMeta.processToken || handle.processToken || null;
        }

        const { toolName, toolArgs } = buildBrokerToolCallForReplOp(op, args, handle.app);
        if (timedOut || runAbort.signal.aborted || operation.signal.aborted) {
          replyErr(timedOut ? "TIMEOUT" : "CANCELLED", "REPL execution aborted before broker dispatch");
          return;
        }
        const toolRes = await this.#broker.executeToolCall(toolName, toolArgs, {
          source: "ai-repl",
          parentOperation: operation,
          signal: operation.signal,
          isRepl: true,
        });
        const postMeta = this.#broker.registry.getMeta(handle.app);
        if (!handle.pid && postMeta?.pid) {
          handle.pid = postMeta.pid;
          handle.processToken = postMeta.processToken || handle.processToken || null;
        }

        if (toolRes?.isError) {
          const errText = extractResultText(toolRes) || `${toolName} failed`;
          replyErr(classifyToolErrorCode(errText), errText);
          return;
        }

        if (op === "app.query") {
          const parsed = JSON.parse(extractResultText(toolRes) || "{}");
          sendToChild({ v: 1, type: "reply", runId, id: msg.id, ok: true, value: parsed });
          return;
        }
        if (op === "app.act") {
          const rawTxt = extractResultText(toolRes) || "{}";
          let parsed = {};
          try {
            parsed = JSON.parse(rawTxt);
          } catch {
            parsed = { rawText: rawTxt };
          }
          const img = extractResultImage(toolRes);
          sendToChild({
            v: 1,
            type: "reply",
            runId,
            id: msg.id,
            ok: true,
            value: {
              ...parsed,
              ...(img?.data ? { imageBase64: img.data, imageMimeType: img.mimeType || "image/jpeg" } : {}),
            },
          });
          return;
        }
        if (op === "app.getAXState") {
          sendToChild({
            v: 1,
            type: "reply",
            runId,
            id: msg.id,
            ok: true,
            value: { text: extractResultText(toolRes) },
          });
          return;
        }
        if (op === "app.getScreenshot") {
          const img = extractResultImage(toolRes);
          if (!img?.data) {
            replyErr("SCREENSHOT_UNAVAILABLE", `Screenshot unavailable for ${handle.app}`);
            return;
          }
          sendToChild({
            v: 1,
            type: "reply",
            runId,
            id: msg.id,
            ok: true,
            value: { mimeType: img.mimeType || "image/jpeg", data: img.data },
          });
          return;
        }
        if (op === "app.getAXStateAndScreenshot") {
          sendToChild({
            v: 1,
            type: "reply",
            runId,
            id: msg.id,
            ok: true,
            value: {
              state: extractResultText(toolRes),
              images: extractImagesFromResult(toolRes),
            },
          });
          return;
        }

        const receipt = toolRes?._deliveryReceipt || null;
        sendToChild({
          v: 1,
          type: "reply",
          runId,
          id: msg.id,
          ok: true,
          value: receipt
            ? {
                ok: true,
                ...(receipt.delivery ? { delivery: receipt.delivery } : {}),
                ...(receipt.route ? { route: receipt.route } : {}),
                ...(receipt.executedRoute ? { executedRoute: receipt.executedRoute } : {}),
                ...(receipt.requestedRoute ? { requestedRoute: receipt.requestedRoute } : {}),
              }
            : { ok: true },
        });
      } catch (err) {
        if (isTakeoverAbortedError(err)) {
          killChildNow({ code: err.code || "PAUSED", message: err.message });
          replyErr(err.code || "PAUSED", err.message);
          return;
        }
        replyErr("REPL_RPC_ERROR", err instanceof Error ? err.message : String(err));
      } finally {
        callInFlight = false;
      }
    };

    try {
      const outcome = await new Promise((resolve) => {
        let settled = false;
        let stdoutBuf = "";
        let stderrBuf = "";
        let readySeen = false;
        let runSent = false;

        const finish = (res) => {
          if (settled) return;
          settled = true;
          resolve(res);
        };

        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (d) => {
          stderrBuf = (stderrBuf + String(d)).slice(-4096);
        });

        child.stdout.on("data", (chunk) => {
          stdoutBuf += chunk;
          if (Buffer.byteLength(stdoutBuf, "utf8") > REPL_MAX_LINE_BYTES) {
            killChildNow({ code: "LINE_TOO_LARGE", message: "Runner stdout exceeded 2 MiB line limit" });
            return;
          }
          let nl;
          while ((nl = stdoutBuf.indexOf("\n")) >= 0) {
            const line = stdoutBuf.slice(0, nl).trim();
            stdoutBuf = stdoutBuf.slice(nl + 1);
            if (!line) continue;
            let msg;
            try {
              msg = JSON.parse(line);
            } catch {
              continue;
            }
            if (!msg || typeof msg !== "object" || Array.isArray(msg)) continue;

            if (msg.type === "fatal") {
              finish({
                kind: "fatal",
                code: msg.error?.code || "SANDBOX_UNAVAILABLE",
                message: msg.error?.message || "Sandbox startup failed",
              });
              killChildNow();
              return;
            }

            if (msg.type === "ready" && !readySeen) {
              readySeen = true;
              if (!runSent) {
                runSent = true;
                sendToChild({
                  v: 1,
                  type: "run",
                  runId,
                  code,
                  bindings: session.bindings,
                  session: session.session,
                  requestMeta: params?.requestMeta || {},
                  timeoutMs,
                });
              }
              continue;
            }

            if (msg.runId && msg.runId !== runId) continue;

            if (msg.type === "out" && msg.item) {
              if (msg.item?._meta?.id === "cua.core") {
                if (session.docsEmitted || runEmittedDocs) continue;
                runEmittedDocs = true;
              }
              if (collectedContent.length < 256) {
                if (msg.item.type === "text") {
                  collectedContent.push({ type: "text", text: String(msg.item.text ?? "") });
                } else if (msg.item.type === "image") {
                  collectedContent.push({
                    type: "image",
                    mimeType: String(msg.item.mimeType || "image/jpeg"),
                    data: String(msg.item.data || ""),
                  });
                } else {
                  collectedContent.push(msg.item);
                }
              }
              continue;
            }

            if (msg.type === "call") {
              void handleRpcCall(msg);
              continue;
            }

            if (msg.type === "done") {
              finish({
                kind: "done",
                ok: Boolean(msg.ok),
                bindings: msg.bindings,
                session: msg.session,
                error: msg.error || null,
              });
              return;
            }
          }
        });

        child.on("error", (err) => {
          finish({
            kind: "crash",
            code: "SANDBOX_UNAVAILABLE",
            message: err?.message || "Failed to spawn CUAScriptRunner",
          });
        });

        child.on("exit", (exitCode, exitSignal) => {
          if (abortedReason) {
            finish({
              kind: "aborted",
              code: abortedReason.code,
              message: abortedReason.message,
            });
          } else if (exitSignal === "SIGXCPU") {
            finish({
              kind: "cpu_limit",
              code: "CPU_TIME_LIMIT",
              message: "JavaScript CPU time limit exceeded (RLIMIT_CPU)",
            });
          } else if (!readySeen) {
            finish({
              kind: "fatal",
              code: "SANDBOX_UNAVAILABLE",
              message: `CUAScriptRunner failed before ready (code=${exitCode}, signal=${exitSignal})${stderrBuf ? `: ${stderrBuf.trim()}` : ""}`,
            });
          } else {
            finish({
              kind: "crash",
              code: "RUNNER_CRASHED",
              message: `CUAScriptRunner exited unexpectedly (code=${exitCode}, signal=${exitSignal})${stderrBuf ? `: ${stderrBuf.trim()}` : ""}`,
            });
          }
        });
      });

      if (outcome.kind === "done" && outcome.ok) {
        if (callInFlight) {
          this.#wipeSessionState(session);
          collectedContent.push({
            type: "text",
            text: "Error: [INCOMPLETE_RPC] Script exited while a desktop tool call was still in flight; session reset",
          });
          return truncateMcpResultTo256KiB({ content: collectedContent, isError: true });
        }
        const canCommit =
          !timedOut &&
          !operation.signal.aborted &&
          operation.epoch === this.#broker.takeoverController.pauseEpoch;
        if (canCommit) {
          try {
            const committed = validateBindingsPayload(outcome.bindings, outcome.session);
            session.bindings = committed.bindings;
            session.session = committed.session;
            for (const [k, v] of pendingHandles) {
              session.appHandles.set(k, v);
            }
            if (runEmittedDocs) {
              session.docsEmitted = true;
            }
          } catch (commitErr) {
            collectedContent.push({
              type: "text",
              text: `Error: ${commitErr instanceof Error ? commitErr.message : String(commitErr)}`,
            });
            return truncateMcpResultTo256KiB({ content: collectedContent, isError: true });
          }
        }
        if (collectedContent.length === 0) {
          collectedContent.push({ type: "text", text: "(no output)" });
        }
        return truncateMcpResultTo256KiB({ content: collectedContent, isError: false });
      }

      if (outcome.kind === "done" && !outcome.ok) {
        const errCode = String(outcome.error?.code || "JS_ERROR");
        const errMsg = String(outcome.error?.message || "Script failed");
        const isTakeoverErr = errCode === "PAUSED" || errCode === "CANCELLED";
        const isCpuErr = errCode === "CPU_TIME_LIMIT";
        if (isTakeoverErr || isCpuErr) {
          // Wipe bindings & handles on CPU limit or takeover/cancel; preserve only on ordinary JS errors
          this.#wipeSessionState(session);
        }
        collectedContent.push({
          type: "text",
          text: isTakeoverErr ? `Error: [${errCode}] ${errMsg}` : `Error: ${errMsg}`,
        });
        return truncateMcpResultTo256KiB({ content: collectedContent, isError: true });
      }

      // Timeout, CPU kill, crash, fatal sandbox error, pause, or cancel -> ALWAYS wipe session!
      this.#wipeSessionState(session);
      const errText =
        outcome.code === "SANDBOX_UNAVAILABLE" ||
        outcome.code === "PAUSED" ||
        outcome.code === "CANCELLED"
          ? `Error: [${outcome.code}] ${outcome.message}`
          : `Error: ${outcome.message}`;
      collectedContent.push({ type: "text", text: errText });
      return truncateMcpResultTo256KiB({ content: collectedContent, isError: true });
    } finally {
      clearTimeout(wallTimer);
      operation.signal.removeEventListener("abort", onOpAbort);
      signal?.removeEventListener("abort", onExternalAbort);
      this.#broker.takeoverController.clearOperation(operation);
      if (session.activeAbortController === runAbort) {
        session.activeAbortController = null;
      }
      if (session.activeChild === child) {
        session.activeChild = null;
      }
      killChildNow();
      if (timedOut) {
        this.#wipeSessionState(session);
      }
      if (slotAcquired) {
        this.#releaseRunSlot();
      }
    }
  }
}
