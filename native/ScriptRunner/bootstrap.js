(function () {
  "use strict";

  const __acorn = globalThis.acorn;
  const __host = globalThis.__cuaHost;

  try { delete globalThis.acorn; } catch {}
  try { delete globalThis.__cuaHost; } catch {}

  if (!__acorn || typeof __acorn.parse !== "function") {
    throw new Error("SANDBOX_UNAVAILABLE: embedded Acorn parser missing");
  }
  if (!__host || typeof __host.rpc !== "function" || typeof __host.emitOut !== "function") {
    throw new Error("SANDBOX_UNAVAILABLE: host bridge missing");
  }

  if (typeof globalThis.WebAssembly !== "undefined") {
    try { delete globalThis.WebAssembly; } catch {}
    if (typeof globalThis.WebAssembly !== "undefined") {
      throw new Error("SANDBOX_UNAVAILABLE: WebAssembly must be disabled via JSC_useWasm=false");
    }
  }

  const REPL_MAX_BINDINGS_BYTES = 65536;
  const REPL_MAX_CALLS_PER_RUN = 32;
  const COMPUTER_USE_GUIDANCE = [
    "## Codex-Style Computer Use JavaScript API",
    "",
    "- `await cua.getState({ emit? })`: list current apps.",
    "- `await cua.listApps({ emit? })`: list current apps.",
    "- `await cua.getApp(nameOrBundleID, { initialState? })`: bind an app in the background.",
    "- `await app.query({ text?, role?, exact?, limit?, maxNodes?, windowId? })`: macOS AX search.",
    "- `await app.act({ target, expect, windowId?, mouseButton?, clickCount?, reveal?, timeoutMs? })`: atomic locate+scroll+click+verify.",
    "- `await app.getAXState(options?)`, `await app.getScreenshot(options?)`, `await app.getAXStateAndScreenshot(options?)`.",
    "- `await app.click(elementIndexOrPoint, options?)`, `await app.scroll(elementIndex, direction, pages?)`, `await app.drag(from, to)`, `await app.typeText(text, options?)`, `await app.pressKey(key, options?)`, `await app.setValue(elementIndex, value)`, `await app.selectText(elementIndex, text, options?)`, `await app.performSecondaryAction(elementIndex, action)`.",
    "",
    "Side-pane live view: include `[Computer Use 小窗](sidecar://computer-use-preview/)` once in your first reply using Computer Use."
  ].join("\n");

  const B64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const B64_LOOKUP = new Uint8Array(256);
  B64_LOOKUP.fill(255);
  for (let i = 0; i < B64_CHARS.length; i++) {
    B64_LOOKUP[B64_CHARS.charCodeAt(i)] = i;
  }

  function decodeBase64(b64) {
    const clean = String(b64 || "").replace(/[\r\n\s]/g, "");
    if (!clean) return new Uint8Array(0);
    let pad = 0;
    if (clean.endsWith("==")) pad = 2;
    else if (clean.endsWith("=")) pad = 1;
    const outLen = Math.max(0, Math.floor((clean.length * 3) / 4) - pad);
    const out = new Uint8Array(outLen);
    let p = 0;
    for (let i = 0; i < clean.length; i += 4) {
      const a = B64_LOOKUP[clean.charCodeAt(i)];
      const b = B64_LOOKUP[clean.charCodeAt(i + 1)];
      const c = clean.charCodeAt(i + 2) === 61 ? 0 : B64_LOOKUP[clean.charCodeAt(i + 2)];
      const d = clean.charCodeAt(i + 3) === 61 ? 0 : B64_LOOKUP[clean.charCodeAt(i + 3)];
      if (a === 255 || b === 255 || c === 255 || d === 255) {
        throw new Error("Invalid base64 image payload");
      }
      const n = (a << 18) | (b << 12) | (c << 6) | d;
      if (p < outLen) out[p++] = (n >> 16) & 0xff;
      if (p < outLen) out[p++] = (n >> 8) & 0xff;
      if (p < outLen) out[p++] = n & 0xff;
    }
    return out;
  }

  function encodeBase64(bytes) {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let parts = [];
    for (let i = 0; i < u8.length; i += 3) {
      const a = u8[i];
      const hasB = i + 1 < u8.length;
      const hasC = i + 2 < u8.length;
      const b = hasB ? u8[i + 1] : 0;
      const c = hasC ? u8[i + 2] : 0;
      const n = (a << 16) | (b << 8) | c;
      parts.push(
        B64_CHARS[(n >> 18) & 63],
        B64_CHARS[(n >> 12) & 63],
        hasB ? B64_CHARS[(n >> 6) & 63] : "=",
        hasC ? B64_CHARS[n & 63] : "="
      );
    }
    return parts.join("");
  }

  function sniffMimeType(u8) {
    if (
      u8.length >= 8 &&
      u8[0] === 0x89 &&
      u8[1] === 0x50 &&
      u8[2] === 0x4e &&
      u8[3] === 0x47 &&
      u8[4] === 0x0d &&
      u8[5] === 0x0a &&
      u8[6] === 0x1a &&
      u8[7] === 0x0a
    ) {
      return "image/png";
    }
    if (u8.length >= 3 && u8[0] === 0xff && u8[1] === 0xd8 && u8[2] === 0xff) {
      return "image/jpeg";
    }
    if (
      u8.length >= 12 &&
      u8[0] === 0x52 &&
      u8[1] === 0x49 &&
      u8[2] === 0x46 &&
      u8[3] === 0x46 &&
      u8[8] === 0x57 &&
      u8[9] === 0x45 &&
      u8[10] === 0x42 &&
      u8[11] === 0x50
    ) {
      return "image/webp";
    }
    throw new Error("nodeRepl.emitImage could not infer PNG, JPEG, or WebP MIME type");
  }

  function isPlainObject(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
  }

  function formatValue(value, seen = new WeakSet(), depth = 0) {
    if (typeof value === "string") return value;
    if (value === null) return "null";
    if (value === undefined) return "undefined";
    if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
      return String(value);
    }
    if (typeof value === "symbol") return String(value);
    if (typeof value === "function") return `[Function: ${value.name || "anonymous"}]`;
    if (value instanceof Error) return value.stack || `${value.name}: ${value.message}`;
    if (value instanceof Uint8Array || ArrayBuffer.isView(value)) {
      return `Uint8Array(${value.byteLength})`;
    }
    if (typeof value === "object") {
      if (seen.has(value)) return "[Circular]";
      if (depth >= 6) return Array.isArray(value) ? "[Array]" : "[Object]";
      seen.add(value);
      try {
        if (Array.isArray(value)) {
          return `[ ${value.map((v) => formatValue(v, seen, depth + 1)).join(", ")} ]`;
        }
        const keys = Object.keys(value);
        if (keys.length === 0) return "{}";
        const entries = keys.map((k) => `${k}: ${formatValue(value[k], seen, depth + 1)}`);
        return `{ ${entries.join(", ")} }`;
      } catch {
        return "[Object]";
      }
    }
    return String(value);
  }

  function normalizeImage(value) {
    if (typeof value === "string") {
      if (!value.startsWith("data:image/")) {
        throw new Error("nodeRepl.emitImage accepts image data URLs or bytes");
      }
      const match = /^data:([^;,]+);base64,(.*)$/s.exec(value);
      if (!match) {
        throw new Error("nodeRepl.emitImage expected a base64 image data URL");
      }
      return { mimeType: match[1], data: match[2] };
    }
    if (value instanceof Uint8Array || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
      const bytes =
        value instanceof ArrayBuffer
          ? new Uint8Array(value)
          : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      return { mimeType: sniffMimeType(bytes), data: encodeBase64(bytes) };
    }
    if (isPlainObject(value) && value.bytes !== undefined) {
      const raw = value.bytes;
      const bytes =
        raw instanceof ArrayBuffer
          ? new Uint8Array(raw)
          : raw instanceof Uint8Array || ArrayBuffer.isView(raw)
            ? new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
            : null;
      if (!bytes) throw new Error("nodeRepl.emitImage expected Uint8Array or ArrayBuffer bytes");
      const mimeType = typeof value.mimeType === "string" ? value.mimeType : sniffMimeType(bytes);
      if (!mimeType.startsWith("image/")) {
        throw new Error("nodeRepl.emitImage expected an image MIME type");
      }
      return { mimeType, data: encodeBase64(bytes) };
    }
    throw new Error("nodeRepl.emitImage received an unsupported value");
  }

  function cloneJsonSafe(v) {
    if (v === null || typeof v === "boolean" || typeof v === "number" || typeof v === "string") return v;
    if (Array.isArray(v)) return v.map(cloneJsonSafe);
    if (typeof v === "object") {
      const out = {};
      for (const k of Object.keys(v)) {
        out[k] = cloneJsonSafe(v[k]);
      }
      return out;
    }
    return undefined;
  }

  let runActive = false;
  let currentRequestMeta = Object.freeze({});
  let rpcCallCount = 0;
  let rpcInFlight = false;
  let docsEmitted = false;
  let importedBindingMap = Object.create(null);
  let committedExportJson = null;

  const handleMetaMap = new WeakMap();
  const handleById = new Map();
  const sessionObj = Object.create(Object.prototype);

  function ensureRunActive() {
    if (!runActive) {
      throw new Error("nodeRepl / cua API is only available while js is executing");
    }
  }

  function emitTextItem(value, itemId) {
    ensureRunActive();
    const item = { type: "text", text: formatValue(value) };
    if (itemId) item._meta = { id: String(itemId) };
    __host.emitOut(JSON.stringify(item));
  }

  function emitImageItem(value) {
    ensureRunActive();
    const img = normalizeImage(value);
    __host.emitOut(JSON.stringify({ type: "image", mimeType: img.mimeType, data: img.data }));
  }

  async function callBroker(op, args) {
    ensureRunActive();
    if (rpcInFlight) {
      throw new Error("CONCURRENT_RPC_NOT_ALLOWED: only 1 in-flight desktop RPC per run is permitted");
    }
    if (rpcCallCount >= REPL_MAX_CALLS_PER_RUN) {
      throw new Error("RPC_CALL_LIMIT_EXCEEDED: max 32 desktop calls per run");
    }
    rpcCallCount += 1;
    rpcInFlight = true;
    try {
      const rawReply = await __host.rpc(op, JSON.stringify(args || {}));
      if (!rawReply) return null;
      return JSON.parse(rawReply);
    } finally {
      rpcInFlight = false;
    }
  }

  function optionsToSnapshotArgs(options = {}) {
    const args = {};
    if (options.textLimit !== undefined) args.text_limit = options.textLimit;
    if (options.maxTreeNodes !== undefined) args.max_tree_nodes = options.maxTreeNodes;
    if (options.maxTreeDepth !== undefined) args.max_tree_depth = options.maxTreeDepth;
    if (options.windowPlacement !== undefined) {
      if (options.windowPlacement === "agent_display") {
        throw new Error("windowPlacement 'agent_display' is disabled in background desktop mode");
      }
      args.window_placement = options.windowPlacement;
    }
    if (options.includeAX !== undefined) {
      if (typeof options.includeAX !== "boolean") throw new Error("includeAX must be a boolean");
      args.include_ax = options.includeAX;
    }
    if (options.includeScreenshot !== undefined) {
      if (typeof options.includeScreenshot !== "boolean") {
        throw new Error("includeScreenshot must be a boolean");
      }
      args.include_screenshot = options.includeScreenshot;
    }
    if (args.include_ax === false && args.include_screenshot === false) {
      throw new Error("At least one of includeAX or includeScreenshot must be true");
    }
    return args;
  }

  function resolveOptionAlias(options, camelKey, snakeKey, label) {
    const hasCamel = options[camelKey] !== undefined;
    const hasSnake = options[snakeKey] !== undefined;
    if (hasCamel && hasSnake && options[camelKey] !== options[snakeKey]) {
      throw new Error(`Conflicting ${label} options: ${camelKey} and ${snakeKey}`);
    }
    return hasCamel ? options[camelKey] : hasSnake ? options[snakeKey] : undefined;
  }

  function optionsToClickArgs(options = {}) {
    if (options !== undefined && options !== null && !isPlainObject(options)) {
      throw new Error("click expects an options object");
    }
    const opts = options || {};
    const args = {};
    const mouseButton = resolveOptionAlias(opts, "mouseButton", "mouse_button", "click");
    const clickCount = resolveOptionAlias(opts, "clickCount", "click_count", "click");
    const clickMethod = resolveOptionAlias(opts, "clickMethod", "click_method", "click");
    if (mouseButton !== undefined) args.mouse_button = mouseButton;
    if (clickCount !== undefined) args.click_count = clickCount;
    if (clickMethod !== undefined) args.click_method = clickMethod;
    return args;
  }

  function optionsToKeyArgs(options = {}) {
    if (options !== undefined && options !== null && !isPlainObject(options)) {
      throw new Error("key operation expects an options object");
    }
    const opts = options || {};
    const args = {};
    const keyMethod = resolveOptionAlias(opts, "keyMethod", "key_method", "key");
    if (keyMethod !== undefined) args.key_method = keyMethod;
    return args;
  }

  function createAppBinding(handleId, appName) {
    if (handleById.has(handleId)) {
      return handleById.get(handleId);
    }
    const obj = Object.freeze({
      async query(options = {}) {
        if (!isPlainObject(options)) throw new Error("app.query expects an options object");
        for (const key of Object.keys(options)) {
          if (!["text", "role", "exact", "limit", "maxNodes", "windowId"].includes(key)) {
            throw new Error(`Unknown query option: ${key}`);
          }
        }
        for (const key of ["text", "role"]) {
          if (options[key] !== undefined && (typeof options[key] !== "string" || options[key].length > 1000)) {
            throw new Error(`${key} must be a string of at most 1000 UTF-16 code units`);
          }
        }
        if (!(options.text && options.text.trim()) && !(options.role && options.role.trim())) {
          throw new Error("query requires text and/or role");
        }
        if (options.exact !== undefined && typeof options.exact !== "boolean") {
          throw new Error("exact must be true or false");
        }
        for (const key of ["limit", "maxNodes", "windowId"]) {
          if (
            options[key] !== undefined &&
            (!Number.isSafeInteger(options[key]) ||
              options[key] < 1 ||
              (key === "windowId" && options[key] > 0xffffffff))
          ) {
            throw new Error(`${key} must be a positive integer`);
          }
        }
        return await callBroker("app.query", {
          handleId,
          app: appName,
          text: options.text,
          role: options.role,
          exact: options.exact,
          limit: options.limit,
          max_nodes: options.maxNodes,
          window_id: options.windowId,
        });
      },

      async act(options = {}) {
        if (!isPlainObject(options)) throw new Error("app.act expects an options object");
        const actArgs = {
          handleId,
          app: appName,
          target: options.target,
          expect: options.expect,
        };
        if (options.windowId !== undefined || options.window_id !== undefined) {
          actArgs.window_id = options.windowId ?? options.window_id;
        }
        if (options.clickCount !== undefined || options.click_count !== undefined) {
          actArgs.click_count = options.clickCount ?? options.click_count;
        }
        if (options.mouseButton !== undefined || options.mouse_button !== undefined) {
          actArgs.mouse_button = options.mouseButton ?? options.mouse_button;
        }
        if (options.reveal !== undefined) {
          actArgs.reveal = options.reveal;
        }
        if (options.timeoutMs !== undefined || options.timeout_ms !== undefined) {
          actArgs.timeout_ms = options.timeoutMs ?? options.timeout_ms;
        }
        const reply = await callBroker("app.act", actArgs);
        if (options.emit === true && reply && typeof reply.imageBase64 === "string") {
          emitImageItem({
            bytes: decodeBase64(reply.imageBase64),
            mimeType: reply.imageMimeType || "image/jpeg",
          });
        }
        if (reply && typeof reply === "object" && "imageBase64" in reply) {
          const cloned = { ...reply };
          delete cloned.imageBase64;
          delete cloned.imageMimeType;
          return cloned;
        }
        return reply;
      },

      async getAXState(options = {}) {
        const snapArgs = optionsToSnapshotArgs(options);
        const reply = await callBroker("app.getAXState", { handleId, app: appName, ...snapArgs });
        const text = String(reply?.text || "");
        if (options.emit !== false && text) {
          emitTextItem(text, "cua.state");
        }
        return text;
      },

      async getScreenshot(options = {}) {
        const snapArgs = optionsToSnapshotArgs(options);
        const reply = await callBroker("app.getScreenshot", {
          handleId,
          app: appName,
          ...snapArgs,
          text_limit: 1,
        });
        if (!reply || typeof reply.data !== "string") {
          throw new Error(`Screenshot unavailable for ${appName}`);
        }
        const bytes = decodeBase64(reply.data);
        if (options.emit !== false) {
          emitImageItem({ bytes, mimeType: reply.mimeType || "image/jpeg" });
        }
        return bytes;
      },

      async getAXStateAndScreenshot(options = {}) {
        const snapArgs = optionsToSnapshotArgs(options);
        const reply = await callBroker("app.getAXStateAndScreenshot", {
          handleId,
          app: appName,
          ...snapArgs,
        });
        const state = String(reply?.state || "");
        if (options.emit !== false && state) {
          emitTextItem(state, "cua.state");
        }
        const images = Array.isArray(reply?.images) ? reply.images : [];
        let firstBytes = null;
        for (let i = 0; i < images.length; i++) {
          const item = images[i];
          if (item && typeof item.data === "string") {
            const u8 = decodeBase64(item.data);
            if (i === 0) firstBytes = u8;
            if (options.emit !== false) {
              emitImageItem({ bytes: u8, mimeType: item.mimeType || "image/jpeg" });
            }
          }
        }
        return firstBytes ? { state, screenshot: firstBytes } : { state };
      },

      async click(target, options = {}) {
        const targetArgs = Array.isArray(target)
          ? { x: target[0], y: target[1] }
          : { element_index: target };
        return await callBroker("app.click", {
          handleId,
          app: appName,
          ...targetArgs,
          ...optionsToClickArgs(options),
        });
      },

      async drag(from, to) {
        if (!Array.isArray(from) || !Array.isArray(to)) {
          throw new Error("drag requires [fromX, fromY], [toX, toY]");
        }
        return await callBroker("app.drag", {
          handleId,
          app: appName,
          from_x: from[0],
          from_y: from[1],
          to_x: to[0],
          to_y: to[1],
        });
      },

      async pressKey(key, options = {}) {
        return await callBroker("app.pressKey", {
          handleId,
          app: appName,
          key,
          ...optionsToKeyArgs(options),
        });
      },

      async scroll(target, direction, pages = 1) {
        if (Array.isArray(target)) {
          throw new Error("coordinate scroll is not supported by this Open Computer Use runtime");
        }
        return await callBroker("app.scroll", {
          handleId,
          app: appName,
          element_index: target,
          direction,
          pages,
        });
      },

      async setValue(elementIndex, value) {
        return await callBroker("app.setValue", {
          handleId,
          app: appName,
          element_index: elementIndex,
          value,
        });
      },

      async selectText(elementIndex, text, options = {}) {
        const index =
          typeof elementIndex === "string" && /^(0|[1-9]\d*)$/u.test(elementIndex)
            ? Number(elementIndex)
            : elementIndex;
        if (!Number.isSafeInteger(index) || index < 0) {
          throw new Error("selectText requires a non-negative integer element index");
        }
        if (typeof text !== "string" || !text.length) {
          throw new Error("selectText requires non-empty text");
        }
        if (!isPlainObject(options)) {
          throw new Error("selectText expects an options object");
        }
        for (const key of Object.keys(options)) {
          if (!["prefix", "suffix", "selection"].includes(key)) {
            throw new Error(`Unknown selectText option: ${key}`);
          }
        }
        for (const key of ["prefix", "suffix"]) {
          if (options[key] !== undefined && typeof options[key] !== "string") {
            throw new Error(`${key} must be a string`);
          }
        }
        if (
          options.selection !== undefined &&
          !["text", "cursor_before", "cursor_after"].includes(options.selection)
        ) {
          throw new Error("selection must be text, cursor_before or cursor_after");
        }
        await callBroker("app.selectText", {
          handleId,
          app: appName,
          element_index: elementIndex,
          text,
          prefix: options.prefix,
          suffix: options.suffix,
          selection: options.selection,
        });
      },

      async typeText(text, options = {}) {
        return await callBroker("app.typeText", {
          handleId,
          app: appName,
          text,
          ...optionsToKeyArgs(options),
        });
      },

      async performSecondaryAction(elementIndex, action) {
        await callBroker("app.performSecondaryAction", {
          handleId,
          app: appName,
          element_index: elementIndex,
          action,
        });
      },
    });
    handleMetaMap.set(obj, { handleId, app: appName });
    handleById.set(handleId, obj);
    return obj;
  }

  function emitDocsOnce() {
    if (docsEmitted) return;
    docsEmitted = true;
    emitTextItem(COMPUTER_USE_GUIDANCE, "cua.core");
  }

  const cuaApi = Object.freeze({
    async getState(options = {}) {
      emitDocsOnce();
      const reply = await callBroker("cua.getState", {});
      const apps = Array.isArray(reply?.apps) ? reply.apps : [];
      if (options.emit !== false) {
        emitTextItem(apps, "cua.state");
      }
      return { apps };
    },
    async listApps(options = {}) {
      emitDocsOnce();
      const state = await cuaApi.getState({ emit: false });
      if (options.emit !== false) {
        emitTextItem(state.apps, "cua.state");
      }
      return state.apps;
    },
    async getApp(app, options = {}) {
      if (typeof app !== "string" || !app.trim()) {
        throw new Error("getApp requires an app name or bundle ID");
      }
      if (
        !isPlainObject(options) ||
        (options.initialState !== undefined && typeof options.initialState !== "boolean")
      ) {
        throw new Error("initialState must be true or false");
      }
      emitDocsOnce();
      const reply = await callBroker("cua.getApp", {
        app: app.trim(),
        initialState: options.initialState !== false,
      });
      if (!reply || !reply.handleId) {
        throw new Error(`Failed to resolve app handle for ${app}`);
      }
      if (typeof reply.initialStateText === "string" && reply.initialStateText) {
        emitTextItem(reply.initialStateText);
      }
      return createAppBinding(String(reply.handleId), String(reply.app || app.trim()));
    },
    async rewriteDocumentation() {
      emitTextItem(COMPUTER_USE_GUIDANCE, "cua.core");
    },
  });

  const nodeReplApi = {
    write(value, itemId) {
      emitTextItem(value, itemId);
    },
    async emitImage(value) {
      emitImageItem(value);
    },
  };
  Object.defineProperty(nodeReplApi, "requestMeta", {
    enumerable: true,
    configurable: false,
    get() {
      return currentRequestMeta;
    },
  });
  Object.freeze(nodeReplApi);

  const originalPromiseThen = Promise.prototype.then;

  function serializeBindingValue(value, seen = new WeakSet(), depth = 0) {
    if (value === undefined) {
      return { ok: true, encoded: { __cuaType: "undefined" } };
    }
    if (value === null || typeof value === "boolean" || typeof value === "string") {
      return { ok: true, encoded: value };
    }
    if (typeof value === "number") {
      return Number.isFinite(value) ? { ok: true, encoded: value } : { ok: false };
    }
    if (typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
      return { ok: false };
    }
    if (typeof value === "object") {
      const handleMeta = handleMetaMap.get(value);
      if (handleMeta) {
        return {
          ok: true,
          encoded: { __cuaType: "appHandle", handleId: handleMeta.handleId, app: handleMeta.app },
        };
      }
      if (value instanceof Promise || typeof value.then === "function") {
        return { ok: false };
      }
      if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer || value instanceof RegExp || value instanceof Date) {
        return { ok: false };
      }
      if (seen.has(value) || depth >= 16) {
        return { ok: false };
      }
      seen.add(value);
      if (Array.isArray(value)) {
        const outArr = [];
        for (let i = 0; i < value.length; i++) {
          const itemRes = serializeBindingValue(value[i], seen, depth + 1);
          outArr.push(itemRes.ok ? itemRes.encoded : null);
        }
        return { ok: true, encoded: outArr };
      }
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        return { ok: false };
      }
      const outObj = {};
      for (const k of Object.keys(value)) {
        const valRes = serializeBindingValue(value[k], seen, depth + 1);
        if (valRes.ok) {
          outObj[k] = valRes.encoded;
        }
      }
      return { ok: true, encoded: outObj };
    }
    return { ok: false };
  }

  function deserializeBindingValue(encoded) {
    if (encoded === null || typeof encoded === "boolean" || typeof encoded === "number" || typeof encoded === "string") {
      return encoded;
    }
    if (Array.isArray(encoded)) {
      return encoded.map(deserializeBindingValue);
    }
    if (typeof encoded === "object") {
      if (encoded.__cuaType === "undefined") return undefined;
      if (encoded.__cuaType === "appHandle" && encoded.handleId) {
        return createAppBinding(String(encoded.handleId), String(encoded.app || ""));
      }
      const obj = {};
      for (const k of Object.keys(encoded)) {
        obj[k] = deserializeBindingValue(encoded[k]);
      }
      return obj;
    }
    return undefined;
  }

  function extractPatternIdentifiers(node, outNames) {
    if (!node || typeof node !== "object") return;
    switch (node.type) {
      case "Identifier":
        outNames.push(node.name);
        break;
      case "ObjectPattern":
        for (const prop of node.properties || []) {
          extractPatternIdentifiers(prop.type === "RestElement" ? prop.argument : prop.value, outNames);
        }
        break;
      case "ArrayPattern":
        for (const el of node.elements || []) {
          if (el) extractPatternIdentifiers(el, outNames);
        }
        break;
      case "RestElement":
        extractPatternIdentifiers(node.argument, outNames);
        break;
      case "AssignmentPattern":
        extractPatternIdentifiers(node.left, outNames);
        break;
      default:
        break;
    }
  }

  function collectHoistedVars(node, outVars) {
    if (!node || typeof node !== "object") return;
    if (
      node.type === "FunctionDeclaration" ||
      node.type === "FunctionExpression" ||
      node.type === "ArrowFunctionExpression" ||
      node.type === "ClassDeclaration" ||
      node.type === "ClassExpression"
    ) {
      return;
    }
    if (node.type === "VariableDeclaration" && node.kind === "var") {
      for (const d of node.declarations || []) {
        extractPatternIdentifiers(d.id, outVars);
      }
      return;
    }
    for (const key of Object.keys(node)) {
      if (key === "loc" || key === "range") continue;
      const val = node[key];
      if (Array.isArray(val)) {
        for (const child of val) collectHoistedVars(child, outVars);
      } else if (val && typeof val === "object" && typeof val.type === "string") {
        collectHoistedVars(val, outVars);
      }
    }
  }

  const HOST_RESERVED_NAMES = new Set([
    "cua",
    "nodeRepl",
    "session",
    "setTimeout",
    "clearTimeout",
    "queueMicrotask",
    "__cuaImport",
    "__cuaCommit",
  ]);

  function prepareRunPayload(code, priorBindingsJson, priorSessionJson, reqMetaJson) {
    if (typeof code !== "string" || !code.trim()) {
      throw new SyntaxError("js expects non-empty JavaScript source");
    }

    const priorBindings = priorBindingsJson ? JSON.parse(priorBindingsJson) : [];
    const priorSession = priorSessionJson ? JSON.parse(priorSessionJson) : {};
    currentRequestMeta = Object.freeze(cloneJsonSafe(reqMetaJson ? JSON.parse(reqMetaJson) : {}) || {});

    const ast = __acorn.parse(code, {
      ecmaVersion: "latest",
      sourceType: "script",
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: false,
      locations: false,
      ranges: false,
    });

    const priorMap = new Map();
    for (const item of Array.isArray(priorBindings) ? priorBindings : []) {
      if (item && typeof item.name === "string" && (item.kind === "var" || item.kind === "let" || item.kind === "const")) {
        priorMap.set(item.name, { kind: item.kind, value: item.value });
      }
    }

    const newDecls = new Map();
    const recordDecl = (name, kind) => {
      if (HOST_RESERVED_NAMES.has(name)) {
        throw new SyntaxError(`Identifier '${name}' is reserved by the CUA runtime`);
      }
      if (priorMap.has(name)) {
        const prev = priorMap.get(name);
        if (prev.kind !== "var" || kind !== "var") {
          throw new SyntaxError(`Identifier '${name}' has already been declared`);
        }
      }
      if (!newDecls.has(name)) {
        newDecls.set(name, kind);
      } else if (newDecls.get(name) !== "var" || kind !== "var") {
        throw new SyntaxError(`Identifier '${name}' has already been declared`);
      }
    };

    for (const stmt of ast.body || []) {
      if (
        stmt.type === "ImportDeclaration" ||
        stmt.type === "ExportNamedDeclaration" ||
        stmt.type === "ExportDefaultDeclaration" ||
        stmt.type === "ExportAllDeclaration"
      ) {
        throw new SyntaxError("import/export declarations are not allowed in CUA REPL");
      }
      if (stmt.type === "VariableDeclaration") {
        const names = [];
        for (const decl of stmt.declarations || []) {
          extractPatternIdentifiers(decl.id, names);
        }
        for (const name of names) recordDecl(name, stmt.kind);
      } else if (stmt.type === "FunctionDeclaration" && stmt.id?.name) {
        recordDecl(stmt.id.name, "var");
      } else if (stmt.type === "ClassDeclaration" && stmt.id?.name) {
        recordDecl(stmt.id.name, "let");
      } else {
        const nestedVars = [];
        collectHoistedVars(stmt, nestedVars);
        for (const name of nestedVars) recordDecl(name, "var");
      }
    }

    importedBindingMap = Object.create(null);
    const priorVars = [];
    const priorLexicals = [];
    const bindingKinds = Object.create(null);

    for (const [name, entry] of priorMap.entries()) {
      importedBindingMap[name] = deserializeBindingValue(entry.value);
      bindingKinds[name] = entry.kind;
      if (entry.kind === "var") priorVars.push(name);
      else priorLexicals.push({ name, kind: entry.kind });
    }
    for (const [name, kind] of newDecls.entries()) {
      bindingKinds[name] = kind;
    }

    for (const k of Object.keys(sessionObj)) {
      delete sessionObj[k];
    }
    if (priorSession && typeof priorSession === "object") {
      for (const k of Object.keys(priorSession)) {
        sessionObj[k] = deserializeBindingValue(priorSession[k]);
      }
    }

    const allExportNames = Array.from(new Set([...priorMap.keys(), ...newDecls.keys()]));
    const lexicalDeclsSrc = priorLexicals
      .map((e) => `${e.kind} ${e.name} = __cuaImport(${JSON.stringify(e.name)});`)
      .join("\n  ");
    const varDeclsSrc = priorVars
      .map((n) => `var ${n} = __cuaImport(${JSON.stringify(n)});`)
      .join("\n    ");
    const exportPairsSrc = allExportNames
      .map((n) => `[${JSON.stringify(n)}, ${JSON.stringify(bindingKinds[n])}, ${n}]`)
      .join(",\n      ");

    const factorySource =
      `(function(__cuaImport, __cuaCommit) {\n` +
      `  "use strict";\n` +
      `  ${lexicalDeclsSrc}\n` +
      `  return async function() {\n` +
      `    "use strict";\n` +
      `    ${varDeclsSrc}\n` +
      `${code}\n` +
      `;__cuaCommit([\n` +
      `      ${exportPairsSrc}\n` +
      `    ]);\n` +
      `  };\n` +
      `})`;

    committedExportJson = null;
    rpcCallCount = 0;
    rpcInFlight = false;
    runActive = true;
    return factorySource;
  }

  function importValForRun(name) {
    return importedBindingMap[name];
  }

  function commitCapturedBindings(pairs) {
    const outBindings = [];
    for (const entry of Array.isArray(pairs) ? pairs : []) {
      const name = entry[0];
      const kind = entry[1];
      const val = entry[2];
      const ser = serializeBindingValue(val);
      if (ser.ok) {
        outBindings.push({ name, kind, value: ser.encoded });
      }
    }
    const serSession = serializeBindingValue(sessionObj);
    const sessionOut = serSession.ok && serSession.encoded && typeof serSession.encoded === "object" ? serSession.encoded : {};
    const json = JSON.stringify({ bindings: outBindings, session: sessionOut });
    if (utf8ByteLength(json) > REPL_MAX_BINDINGS_BYTES) {
      throw new Error("BINDINGS_SIZE_LIMIT_EXCEEDED: persisted REPL state exceeded 64 KiB limit");
    }
    committedExportJson = json;
  }

  function utf8ByteLength(str) {
    let bytes = 0;
    for (let i = 0; i < str.length; i++) {
      const code = str.charCodeAt(i);
      if (code < 0x80) bytes += 1;
      else if (code < 0x800) bytes += 2;
      else if (code >= 0xd800 && code <= 0xdbff) {
        bytes += 4;
        i += 1;
      } else {
        bytes += 3;
      }
    }
    return bytes;
  }

  function attachPromiseCallbacks(promiseObj, onOk, onErr) {
    originalPromiseThen.call(
      promiseObj,
      () => {
        runActive = false;
        onOk(committedExportJson || '{"bindings":[],"session":{}}');
      },
      (err) => {
        runActive = false;
        const msg = err instanceof Error ? err.message : String(err);
        const name = err instanceof Error ? err.name : "Error";
        onErr(JSON.stringify({ code: name || "JS_ERROR", message: msg }));
      }
    );
  }

  // Expose internal runner hooks ONLY via non-enumerable symbol/closures passed directly to Swift bootstrap return value,
  // NEVER left as global properties after bootstrap completes.
  const hostRunnerExports = Object.freeze({
    prepareRunPayload,
    importValForRun,
    commitCapturedBindings,
    attachPromiseCallbacks,
  });

  // Install frozen global APIs cleanly BEFORE primordial freeze
  Object.defineProperty(globalThis, "cua", { value: cuaApi, enumerable: true, writable: false, configurable: false });
  Object.defineProperty(globalThis, "nodeRepl", { value: nodeReplApi, enumerable: true, writable: false, configurable: false });
  Object.defineProperty(globalThis, "session", { value: sessionObj, enumerable: true, writable: false, configurable: false });

  Object.defineProperty(globalThis, "setTimeout", {
    value: function setTimeout(fn, delay = 0, ...args) {
      ensureRunActive();
      if (typeof fn !== "function") throw new TypeError("setTimeout expects a callback function");
      const ms = Math.max(0, Math.min(300000, Number(delay) || 0));
      return __host.scheduleTimer(() => {
        if (!runActive) return;
        fn(...args);
      }, ms);
    },
    enumerable: true,
    writable: false,
    configurable: false,
  });
  Object.defineProperty(globalThis, "clearTimeout", {
    value: function clearTimeout(id) {
      __host.cancelTimer(Number(id) || 0);
    },
    enumerable: true,
    writable: false,
    configurable: false,
  });
  Object.defineProperty(globalThis, "queueMicrotask", {
    value: function queueMicrotask(fn) {
      ensureRunActive();
      if (typeof fn !== "function") throw new TypeError("queueMicrotask expects a function");
      Promise.resolve().then(() => {
        if (!runActive) return;
        fn();
      });
    },
    enumerable: true,
    writable: false,
    configurable: false,
  });

  // Deep-freeze JS primordials, prototypes, and built-in constructors safely without invoking getters
  const frozenSeen = new WeakSet();
  function safeDeepFreeze(root) {
    const queue = [root];
    while (queue.length > 0) {
      const cur = queue.pop();
      if (!cur || (typeof cur !== "object" && typeof cur !== "function")) continue;
      if (cur === sessionObj || frozenSeen.has(cur)) continue;
      frozenSeen.add(cur);
      let keys;
      try {
        keys = Reflect.ownKeys(cur);
      } catch {
        continue;
      }
      for (const k of keys) {
        let desc;
        try {
          desc = Object.getOwnPropertyDescriptor(cur, k);
        } catch {
          continue;
        }
        if (!desc || !("value" in desc)) continue;
        const child = desc.value;
        if (child && (typeof child === "object" || typeof child === "function")) {
          if (child !== sessionObj && child !== globalThis && !frozenSeen.has(child)) {
            queue.push(child);
          }
        }
      }
      try {
        if (cur !== globalThis) {
          Object.freeze(cur);
        }
      } catch {}
    }
  }

  const AsyncFnProto = Object.getPrototypeOf(async function () {});
  const GenFnProto = Object.getPrototypeOf(function* () {});
  const AsyncGenFnProto = Object.getPrototypeOf(async function* () {});
  const ArrayIterProto = Object.getPrototypeOf([][Symbol.iterator]());
  const StringIterProto = Object.getPrototypeOf(""[Symbol.iterator]());
  const MapIterProto = Object.getPrototypeOf(new Map()[Symbol.iterator]());
  const SetIterProto = Object.getPrototypeOf(new Set()[Symbol.iterator]());
  const TypedArrayCtor = Object.getPrototypeOf(Uint8Array);

  const primordialRoots = [
    Object,
    Function,
    Array,
    String,
    Number,
    Boolean,
    Symbol,
    BigInt,
    Math,
    Date,
    RegExp,
    Error,
    EvalError,
    RangeError,
    ReferenceError,
    SyntaxError,
    TypeError,
    URIError,
    AggregateError,
    JSON,
    Promise,
    Proxy,
    Reflect,
    Map,
    Set,
    WeakMap,
    WeakSet,
    ArrayBuffer,
    DataView,
    TypedArrayCtor,
    Int8Array,
    Uint8Array,
    Uint8ClampedArray,
    Int16Array,
    Uint16Array,
    Int32Array,
    Uint32Array,
    Float32Array,
    Float64Array,
    BigInt64Array,
    BigUint64Array,
    Intl,
    AsyncFnProto,
    AsyncFnProto?.constructor,
    GenFnProto,
    GenFnProto?.constructor,
    AsyncGenFnProto,
    AsyncGenFnProto?.constructor,
    ArrayIterProto,
    StringIterProto,
    MapIterProto,
    SetIterProto,
    cuaApi,
    nodeReplApi,
  ];
  for (const r of primordialRoots) {
    safeDeepFreeze(r);
  }
  for (const key of Reflect.ownKeys(globalThis)) {
    let desc;
    try {
      desc = Object.getOwnPropertyDescriptor(globalThis, key);
    } catch {
      continue;
    }
    if (desc && "value" in desc && desc.value && desc.value !== sessionObj && desc.value !== globalThis) {
      safeDeepFreeze(desc.value);
    }
  }

  return hostRunnerExports;
})();
