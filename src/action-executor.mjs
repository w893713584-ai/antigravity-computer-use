import {
  dispatchBackgroundPointClickDetailed,
  dispatchBackgroundPointDrag,
  extractResultImage,
  extractResultText,
  unhideAppWithoutActivating,
} from "./background-policy.mjs";
import { normalizeElementBounds } from "./app-snapshot-registry.mjs";
import { formatDeliveryRoute } from "./focus-policy-guard.mjs";
import { TakeoverAbortedError } from "./takeover-controller.mjs";
import {
  buildStaleRefToolResult,
  computeFrameDigest,
  shouldAttemptSelectedTextFastPath,
  tryHeadlessBackgroundScroll,
  tryHeadlessContextMenu,
  tryHeadlessSelectedTextInsert,
  tryWindowKey,
  tryWindowPostClick,
  tryWindowScroll,
  tryWindowText,
  verifyEditableTextFocus,
  verifySetValueObservation,
} from "./headless-engine.mjs";

export const STALE_SNAPSHOT_RE =
  /requires a current.*target window|no longer exists|stale window|No window bounds|coordinate input requires a delivered screenshot|Screenshot omitted|No app state|Run get_app_state|previous element indexes invalidated|Read AX before element-targeted actions/iu;

export function appendResultFooter(result, footerText) {
  if (!result || !footerText || !Array.isArray(result.content)) return result;
  const content = result.content.map((item) => ({ ...item }));
  const firstTextIdx = content.findIndex(
    (item) => item?.type === "text" && typeof item.text === "string"
  );
  if (firstTextIdx >= 0) {
    if (!content[firstTextIdx].text.includes(footerText)) {
      content[firstTextIdx].text = content[firstTextIdx].text
        ? `${content[firstTextIdx].text}\n${footerText}`
        : footerText;
    }
  } else {
    content.unshift({ type: "text", text: footerText });
  }
  return { ...result, content };
}

function isValidTinyOverrideGeometry(ov) {
  return Boolean(
    ov &&
      ov.bounds &&
      Number.isFinite(ov.imgWidth) &&
      ov.imgWidth > 0 &&
      Number.isFinite(ov.imgHeight) &&
      ov.imgHeight > 0 &&
      Number.isFinite(ov.bounds.x) &&
      Number.isFinite(ov.bounds.y) &&
      Number.isFinite(ov.bounds.width) &&
      ov.bounds.width > 0 &&
      Number.isFinite(ov.bounds.height) &&
      ov.bounds.height > 0
  );
}

function isWithinTinyOverrideBounds(ov, x, y) {
  return x >= 0 && y >= 0 && x <= ov.imgWidth + 1 && y <= ov.imgHeight + 1;
}

function mapTinyOverridePoint(ov, x, y) {
  return {
    screenX: ov.bounds.x + (x / ov.imgWidth) * ov.bounds.width,
    screenY: ov.bounds.y + (y / ov.imgHeight) * ov.bounds.height,
  };
}

/**
 * Single authoritative pure coordinate seam: convert window-local logical points
 * (e.g., OCU `query` `bounds` or `AXPosition - winOrigin`) into encoded screenshot
 * pixels for `click({ x, y })`, absorbing Retina scaling & `MAX_DIMENSION=1280`.
 */
export function windowPointToScreenshotPixel(
  point,
  { windowWidth, windowHeight, imageWidth, imageHeight } = {}
) {
  const px = Number(point?.x);
  const py = Number(point?.y);
  const ww = Number(windowWidth);
  const wh = Number(windowHeight);
  const iw = Number(imageWidth);
  const ih = Number(imageHeight);
  if (
    !Number.isFinite(px) ||
    !Number.isFinite(py) ||
    !(ww > 0) ||
    !(wh > 0) ||
    !(iw > 0) ||
    !(ih > 0)
  ) {
    return null;
  }
  return {
    x: (px * iw) / ww,
    y: (py * ih) / wh,
  };
}

/**
 * Inverse seam: convert encoded screenshot pixels back into window-local logical points
 * (`pointWindowPt`) for `window_post` / `window_scroll`.
 */
export function screenshotPixelToWindowPoint(
  pixel,
  { windowWidth, windowHeight, imageWidth, imageHeight } = {}
) {
  const sx = Number(pixel?.x);
  const sy = Number(pixel?.y);
  const ww = Number(windowWidth);
  const wh = Number(windowHeight);
  const iw = Number(imageWidth);
  const ih = Number(imageHeight);
  if (
    !Number.isFinite(sx) ||
    !Number.isFinite(sy) ||
    !(ww > 0) ||
    !(wh > 0) ||
    !(iw > 0) ||
    !(ih > 0)
  ) {
    return null;
  }
  return {
    x: (sx * ww) / iw,
    y: (sy * wh) / ih,
  };
}

/**
 * Compute center point of `targetBox`, clipped inside `clipBox` (e.g., visible list viewport)
 * when provided and intersecting; falls back to `targetBox` center if no overlap.
 */
export function clipBoxIntersectionCenter(targetBox, clipBox = null) {
  if (!targetBox || !(Number(targetBox.w) > 0) || !(Number(targetBox.h) > 0)) return null;
  const tx1 = Number(targetBox.x);
  const ty1 = Number(targetBox.y);
  const tx2 = tx1 + Number(targetBox.w);
  const ty2 = ty1 + Number(targetBox.h);
  if (clipBox && Number(clipBox.w) > 0 && Number(clipBox.h) > 0) {
    const cx1 = Number(clipBox.x);
    const cy1 = Number(clipBox.y);
    const cx2 = cx1 + Number(clipBox.w);
    const cy2 = cy1 + Number(clipBox.h);
    const ix1 = Math.max(tx1, cx1);
    const iy1 = Math.max(ty1, cy1);
    const ix2 = Math.min(tx2, cx2);
    const iy2 = Math.min(ty2, cy2);
    if (ix2 > ix1 && iy2 > iy1) {
      return { x: (ix1 + ix2) / 2, y: (iy1 + iy2) / 2 };
    }
  }
  return { x: (tx1 + tx2) / 2, y: (ty1 + ty2) / 2 };
}

/**
 * Deduplicate nested parent/child `query` matches on the same UI control/card
 * while keeping independently actionable overlapping controls distinct (preventing
 * false AMBIGUOUS_TARGET without silently swallowing separate interactive buttons).
 */
export function dedupeSpatiallyOverlappingMatches(matches = []) {
  if (!Array.isArray(matches) || matches.length <= 1) return Array.isArray(matches) ? matches : [];
  const normBox = (m) => {
    const b = normalizeElementBounds(m?.bounds || m?.frame);
    return b ? { ...b, area: b.w * b.h } : null;
  };
  const overlapRatio = (a, b) => {
    const ix1 = Math.max(a.x, b.x);
    const iy1 = Math.max(a.y, b.y);
    const ix2 = Math.min(a.x + a.w, b.x + b.w);
    const iy2 = Math.min(a.y + a.h, b.y + b.h);
    if (ix2 <= ix1 || iy2 <= iy1) return 0;
    const inter = (ix2 - ix1) * (iy2 - iy1);
    const minArea = Math.min(a.area, b.area);
    return minArea > 0 ? inter / minArea : 0;
  };
  const clickableBonus = (m) => {
    const r = String(m?.role || "").toLowerCase();
    return /button|cell|menuitem|tab|checkbox|radio|link/.test(r) ? 1 : 0;
  };
  const primaryLabel = (m) =>
    String(m?.title || m?.label || m?.text || m?.description || m?.value || m?.identifier || "")
      .trim()
      .toLowerCase();
  const representsSameControl = (a, b) => {
    // Only collapse two clickable controls when they share an identifier or identical label (or one lacks own identity)
    if (a.clickRank > 0 && b.clickRank > 0) {
      const idA = String(a.match?.identifier || "").trim();
      const idB = String(b.match?.identifier || "").trim();
      if (idA && idB) return idA === idB;
      const lblA = primaryLabel(a.match);
      const lblB = primaryLabel(b.match);
      if (lblA && lblB) return lblA === lblB;
    }
    return true;
  };

  // Strict weak ordering: smaller area first, then clickable rank, then original order
  const decorated = matches.map((m, origIdx) => ({
    match: m,
    origIdx,
    box: normBox(m),
    clickRank: clickableBonus(m),
  }));
  decorated.sort((a, b) => {
    if (a.box && !b.box) return -1;
    if (!a.box && b.box) return 1;
    if (a.box && b.box && a.box.area !== b.box.area) return a.box.area - b.box.area;
    if (a.clickRank !== b.clickRank) return b.clickRank - a.clickRank;
    return a.origIdx - b.origIdx;
  });

  const kept = [];
  for (const item of decorated) {
    if (!item.box) {
      kept.push(item);
      continue;
    }
    const existingIdx = kept.findIndex(
      (k) => k.box && overlapRatio(item.box, k.box) >= 0.7 && representsSameControl(item, k)
    );
    if (existingIdx < 0) {
      kept.push(item);
    } else if (item.clickRank > kept[existingIdx].clickRank) {
      // Promote wrapping clickable container (e.g. AXButton card) over plain text descendant
      kept[existingIdx] = item;
    }
  }
  return kept.map((k) => k.match);
}

/**
 * Deep Module: BackgroundActionExecutor
 *
 * Encapsulates Delivery Route selection and dispatch (Window-Local Delivery Floor,
 * SkyLight / CGEvent cascade, Tiny Window Override coordinate remapping,
 * AXShowMenu / AXScrollBar / AXSelectedText direct routes, and set_value sky_bypass
 * with editable-focus safety gate) plus closed-loop post-action readback verification.
 */
export class BackgroundActionExecutor {
  constructor({
    actionPeer,
    axBridge = null,
    focusPolicyGuard,
    registry,
    unhideAppFn = unhideAppWithoutActivating,
    refreshActionStateFn = null,
    pointClickFn = dispatchBackgroundPointClickDetailed,
    pointDragFn = dispatchBackgroundPointDrag,
    editableFocusFn = verifyEditableTextFocus,
    selectedTextInsertFn = tryHeadlessSelectedTextInsert,
    axScrollFallbackFn = tryHeadlessBackgroundScroll,
    contextMenuFallbackFn = tryHeadlessContextMenu,
    windowClickFn = tryWindowPostClick,
    windowKeyFn = tryWindowKey,
    windowTextFn = tryWindowText,
    windowScrollFn = tryWindowScroll,
    takeoverController = null,
    postActionDelayMs = 55,
    windowTransitionRetryDelayMs = 220,
  } = {}) {
    this.actionPeer = actionPeer;
    this.axBridge = axBridge;
    this.focusPolicyGuard = focusPolicyGuard;
    this.registry = registry;
    this.unhideAppFn = unhideAppFn;
    this.refreshActionStateFn = refreshActionStateFn;
    this.pointClickFn = pointClickFn;
    this.pointDragFn = pointDragFn;
    this.editableFocusFn = editableFocusFn;
    this.selectedTextInsertFn = selectedTextInsertFn;
    this.axScrollFallbackFn = axScrollFallbackFn;
    this.contextMenuFallbackFn = contextMenuFallbackFn;
    this.windowClickFn = windowClickFn;
    this.windowKeyFn = windowKeyFn;
    this.windowTextFn = windowTextFn;
    this.windowScrollFn = windowScrollFn;
    this.takeoverController = takeoverController;
    this.postActionDelayMs = postActionDelayMs;
    this.windowTransitionRetryDelayMs = windowTransitionRetryDelayMs;
  }

  #beforeWrite(operation, isRead = false) {
    this.takeoverController?.assertMayDispatch(operation, { isRead });
  }

  #trackWrite(operation, promise, routeKey = null) {
    if (!this.takeoverController) return promise;
    return this.takeoverController.trackNativeWrite(operation, promise, { routeKey });
  }

  #rethrowIfAborted(err) {
    if (err?.aborted) throw err;
    if (err?.deliveryState === "sent_unknown" || err?.code === "WRITE_OUTCOME_UNKNOWN") {
      throw new TakeoverAbortedError(
        err?.message || "窗口操作写入结果未知，已阻断后续回退点击以防重复触发。",
        {
          code: "WRITE_OUTCOME_UNKNOWN",
          deliveryState: "sent_unknown",
        }
      );
    }
  }

  #buildReservedHotkeyErrorIfBlocked(toolName, key, operation) {
    if (
      toolName === "press_key" &&
      operation?.isAi &&
      this.takeoverController?.isReservedHotkey(key)
    ) {
      return {
        isError: true,
        fatal: true,
        content: [
          {
            type: "text",
            text: `[RESERVED_HOTKEY] 禁止 AI 发送人类急停热键 "${key}"。`,
          },
        ],
      };
    }
    return null;
  }

  async #callActionPeerWithRecovery(
    toolName,
    callArgs,
    app,
    { shouldFollow = true, allowAutoRefresh = true, operation = null, timeoutMs = undefined } = {}
  ) {
    const routeTag =
      toolName === "click" || toolName === "drag"
        ? `${toolName}:${callArgs?.click_method || "native"}`
        : toolName === "press_key" || toolName === "type_text"
          ? `${toolName}:${callArgs?.key_method || "native"}`
          : toolName;
    const beforeWriteCheck = () => this.#beforeWrite(operation, false);
    beforeWriteCheck();
    let lastRes = await this.#trackWrite(
      operation,
      this.actionPeer.callTool(toolName, callArgs, timeoutMs, { beforeWriteCheck }),
      routeTag
    );
    if (!lastRes?.isError) return lastRes;

    const errText = extractResultText(lastRes);
    if (/target app is hidden/iu.test(errText)) {
      beforeWriteCheck();
      const meta = this.registry.getMeta(app);
      await this.#trackWrite(operation, this.unhideAppFn(meta?.pid, app), `${toolName}:unhide`);
      beforeWriteCheck();
      lastRes = await this.#trackWrite(
        operation,
        this.actionPeer.callTool(toolName, callArgs, timeoutMs, { beforeWriteCheck }),
        routeTag
      );
      if (!lastRes?.isError) return lastRes;
    }

    if (
      allowAutoRefresh &&
      typeof this.refreshActionStateFn === "function" &&
      STALE_SNAPSHOT_RE.test(extractResultText(lastRes))
    ) {
      this.#beforeWrite(operation, true);
      const refreshRes = await this.refreshActionStateFn(app, { shouldFollow, operation });
      if (refreshRes?.isError) return lastRes;
      beforeWriteCheck();
      lastRes = await this.#trackWrite(
        operation,
        this.actionPeer.callTool(toolName, callArgs, timeoutMs, { beforeWriteCheck }),
        routeTag
      );
    }

    return lastRes;
  }

  async #dispatchClickMethod(method, ctx) {
    const {
      app,
      cleanArgs,
      parsedRef,
      preMeta,
      preSnapshot,
      preElement,
      shouldFollow,
      allowAutoRefresh,
      fallbackDims = { width: 0, height: 0 },
      operation = null,
    } = ctx;

    if (method === "window_post") {
      if (!(preMeta?.pid > 0) || typeof this.windowClickFn !== "function") {
        return {
          isError: true,
          content: [{ type: "text", text: "Window-local click bridge unavailable." }],
        };
      }
      const beforeWriteCheck = () => this.#beforeWrite(operation, false);
      beforeWriteCheck();
      const frameWidth = preMeta?.actionFrameWidth || fallbackDims.width || 0;
      const frameHeight = preMeta?.actionFrameHeight || fallbackDims.height || 0;
      const winRes = await this.#trackWrite(
        operation,
        this.windowClickFn(preMeta.pid, {
          axBridge: this.axBridge,
          snapshotId: preSnapshot?.id || null,
          elementIndex: parsedRef?.hasElementRef ? parsedRef.rawIndex : null,
          elementMeta: preElement || null,
          x: cleanArgs.x ?? null,
          y: cleanArgs.y ?? null,
          frameWidth,
          frameHeight,
          windowTitle: preMeta?.windowTitle || "",
          wid: preMeta?.tinyWindowOverride?.wid || null,
          windowBounds: preMeta?.tinyWindowOverride?.bounds || null,
          button: cleanArgs.mouse_button || "left",
          clickCount: cleanArgs.click_count ?? 1,
          syntheticTag: this.takeoverController?.syntheticEventTag || 0,
          beforeWriteCheck,
        }),
        "click:window_post"
      ).catch((err) => {
        this.#rethrowIfAborted(err);
        return { delivered: false, reason: err?.message || "window_click_error" };
      });
      if (winRes?.delivered) {
        return { isError: false, content: [{ type: "text", text: "ok" }] };
      }
      return {
        isError: true,
        fatal: winRes?.reason === "out_of_bounds",
        content: [
          {
            type: "text",
            text:
              winRes?.reason === "out_of_bounds"
                ? "Click coordinates are outside the current window screenshot bounds."
                : `Window-local click unavailable (${winRes?.reason || "unavailable"}).`,
          },
        ],
      };
    }

    return this.#callActionPeerWithRecovery(
      "click",
      { ...cleanArgs, click_method: method },
      app,
      { shouldFollow, allowAutoRefresh, operation }
    );
  }

  async #dispatchKeyMethod(toolName, method, ctx) {
    const { app, cleanArgs, preMeta, shouldFollow, allowAutoRefresh, operation = null } = ctx;
    const hotkeyBlock = this.#buildReservedHotkeyErrorIfBlocked(toolName, cleanArgs.key, operation);
    if (hotkeyBlock) {
      return hotkeyBlock;
    }
    if (method === "window_key") {
      const beforeWriteCheck = () => this.#beforeWrite(operation, false);
      beforeWriteCheck();
      if (toolName === "press_key" && preMeta?.pid > 0 && typeof this.windowKeyFn === "function") {
        const keyRes = await this.#trackWrite(
          operation,
          this.windowKeyFn(preMeta.pid, cleanArgs.key, {
            axBridge: this.axBridge,
            windowTitle: preMeta?.windowTitle || "",
            wid: preMeta?.tinyWindowOverride?.wid || null,
            syntheticTag: this.takeoverController?.syntheticEventTag || 0,
            beforeWriteCheck,
          }),
          "press_key:window_key"
        ).catch((err) => {
          this.#rethrowIfAborted(err);
          return { delivered: false, reason: err?.message || "window_key_error" };
        });
        if (keyRes?.delivered) {
          return { isError: false, content: [{ type: "text", text: "ok" }] };
        }
        const keyReason = keyRes?.reason || "unavailable";
        return {
          isError: true,
          reason: keyReason,
          fatal: keyReason !== "bridge_unavailable",
          content: [
            {
              type: "text",
              text: `Window key delivery failed (${keyReason}).`,
            },
          ],
        };
      }
      if (toolName === "type_text" && preMeta?.pid > 0 && typeof this.windowTextFn === "function") {
        const txtRes = await this.#trackWrite(
          operation,
          this.windowTextFn(preMeta.pid, String(cleanArgs.text ?? ""), {
            axBridge: this.axBridge,
            windowTitle: preMeta?.windowTitle || "",
            wid: preMeta?.tinyWindowOverride?.wid || null,
            syntheticTag: this.takeoverController?.syntheticEventTag || 0,
            beforeWriteCheck,
          }),
          "type_text:window_key"
        ).catch((err) => {
          this.#rethrowIfAborted(err);
          return { delivered: false, reason: err?.message || "window_text_error" };
        });
        if (txtRes?.delivered) {
          return { isError: false, content: [{ type: "text", text: "ok" }] };
        }
        const txtReason = txtRes?.reason || "unavailable";
        return {
          isError: true,
          reason: txtReason,
          fatal: txtReason !== "bridge_unavailable" && txtReason !== "unicode_fn_unavailable",
          content: [
            {
              type: "text",
              text: `Window text delivery failed (${txtReason}).`,
            },
          ],
        };
      }
      return {
        isError: true,
        reason: "bridge_unavailable",
        content: [{ type: "text", text: "Window key bridge unavailable." }],
      };
    }

    return this.#callActionPeerWithRecovery(
      toolName,
      { ...cleanArgs, key_method: method },
      app,
      { shouldFollow, allowAutoRefresh, operation }
    );
  }

  async #executeBackgroundSetValueBypass(ctx) {
    const { app, cleanArgs, aliases, preAppKey, preMeta, preSnapshot, preElement } = ctx;
    const clickMethods = this.focusPolicyGuard.planClick(
      { app, element_index: cleanArgs.element_index },
      aliases
    );
    const bypassClickCtx = {
      ...ctx,
      cleanArgs: { app, element_index: cleanArgs.element_index },
      parsedRef: {
        ok: true,
        hasElementRef: true,
        snapshotId: preSnapshot?.id || null,
        rawIndex: String(cleanArgs.element_index),
      },
    };

    let focusedOk = false;
    for (const method of clickMethods) {
      const clickRes = await this.#dispatchClickMethod(method, bypassClickCtx);
      if (!clickRes?.isError) {
        focusedOk = true;
        break;
      }
      if (clickRes?.fatal) break;
    }
    if (!focusedOk) return { ok: false };

    const focusCheck =
      typeof this.editableFocusFn === "function"
        ? await this.editableFocusFn(preMeta?.pid, {
            axBridge: this.axBridge,
            snapshotId: preSnapshot?.id || null,
            elementIndex: cleanArgs.element_index,
            fallbackElementMeta: preElement,
          }).catch(() => ({ editable: false }))
        : { editable: false };
    if (!focusCheck?.editable) {
      return { ok: false };
    }

    const pressKeyMethods = this.focusPolicyGuard.planKey("press_key", { app }, aliases);
    const runBypassPressKey = async (key) => {
      for (const method of pressKeyMethods) {
        const res = await this.#dispatchKeyMethod("press_key", method, {
          ...ctx,
          cleanArgs: { app, key },
          allowAutoRefresh: false,
        });
        if (!res?.isError || res?.fatal) return res;
      }
      return { isError: true };
    };

    const selAllRes = await runBypassPressKey("cmd+a");
    if (selAllRes?.isError) return { ok: false };

    const clearRes = await runBypassPressKey("BackSpace");
    if (clearRes?.isError) return { ok: false };

    const targetValue = String(cleanArgs.value ?? "");
    if (!targetValue.length) {
      return {
        ok: true,
        verified: false,
        result: {
          isError: false,
          content: [{ type: "text", text: "Value cleared via background sky_bypass." }],
        },
      };
    }

    if (
      preMeta?.pid > 0 &&
      !this.focusPolicyGuard.isMethodBlocked(aliases, "type_text", "ax_selected_text") &&
      typeof this.selectedTextInsertFn === "function" &&
      shouldAttemptSelectedTextFastPath(preAppKey, targetValue)
    ) {
      const axIns = await this.#trackWrite(
        ctx.operation,
        this.selectedTextInsertFn(preMeta.pid, targetValue, {
          axBridge: this.axBridge,
          beforeWriteCheck: () => this.#beforeWrite(ctx.operation, false),
        }),
        "set_value:ax_selected_text"
      ).catch((err) => {
        this.#rethrowIfAborted(err);
        return null;
      });
      if (axIns?.delivered) {
        return {
          ok: true,
          verified: Boolean(axIns.verified),
          result: {
            isError: false,
            content: [
              { type: "text", text: "Value set via background sky_bypass (AXSelectedText)." },
            ],
          },
        };
      }
    }

    const safeKeyText = focusCheck.singleLine
      ? targetValue.replace(/[\r\n]+/gu, " ")
      : targetValue;
    const typeKeyMethods = this.focusPolicyGuard.planKey("type_text", { app }, aliases);
    let typeRes = null;
    for (const method of typeKeyMethods) {
      typeRes = await this.#dispatchKeyMethod("type_text", method, {
        ...ctx,
        cleanArgs: { app, text: safeKeyText },
        allowAutoRefresh: false,
      });
      if (!typeRes?.isError || typeRes?.fatal) break;
    }
    if (!typeRes || typeRes.isError) return { ok: false };
    return {
      ok: true,
      verified: false,
      result: typeRes,
    };
  }

  async dispatch({
    name,
    app,
    cleanArgs,
    parsedRef,
    validatedSnapshot = null,
    validatedElement = null,
    shouldFollow = true,
    eventSource = "ai",
    fallbackDims = { width: 0, height: 0 },
    operation = null,
    windowDelivery = null,
  }) {
    let result = null;
    let actionRouteKey = name;
    let directDeliveryVerified = false;
    let actionEvent = null;

    const allowAutoRefresh = !parsedRef?.snapshotId;
    const preMeta = app ? this.registry.getMeta(app) : null;
    const aliases = app ? this.registry.aliasesFor(app, preMeta) : [];
    const preAppKey = preMeta?.bundleId || app || "";
    const preSnapshot =
      validatedSnapshot ||
      (parsedRef?.snapshotId ? this.registry.ledger.getSnapshot(parsedRef.snapshotId) : null) ||
      this.registry.getLatestSnapshot(preAppKey);
    const preElement =
      validatedElement ||
      (parsedRef?.hasElementRef
        ? preSnapshot?.elements?.get(parsedRef.rawIndex) ||
          preMeta?.elements?.get(parsedRef.rawIndex) ||
          null
        : null);
    const preFrameDigest = preMeta?.lastImageDigest || null;
    const ctx = {
      app,
      cleanArgs,
      parsedRef,
      aliases,
      preAppKey,
      preMeta,
      preSnapshot,
      preElement,
      shouldFollow,
      allowAutoRefresh,
      fallbackDims,
      operation,
      windowDelivery,
    };

    if (name === "click") {
      const { normX, normY } = this.registry.resolveCursorNorm(app, cleanArgs, fallbackDims);
      const targetDesc = parsedRef?.hasElementRef
        ? this.registry.describeElement(app, cleanArgs.element_index)
        : windowDelivery?.localPoint
          ? `坐标 (${Math.round(windowDelivery.localPoint.x)}, ${Math.round(windowDelivery.localPoint.y)} pt)`
          : `坐标 (${Math.round(cleanArgs.x)}, ${Math.round(cleanArgs.y)})`;
      const ov = preMeta?.tinyWindowOverride;

      if (windowDelivery?.route === "window_post") {
        const targetPid = Number(windowDelivery.pid || preMeta?.pid || 0);
        if (!(targetPid > 0) || typeof this.windowClickFn !== "function") {
          actionRouteKey = formatDeliveryRoute("click", "window_post");
          result = {
            isError: true,
            content: [{ type: "text", text: "Window-local click bridge unavailable." }],
          };
        } else {
          const beforeWriteCheck = () => this.#beforeWrite(operation, false);
          beforeWriteCheck();
          const wb = windowDelivery.windowBoundsPt || null;
          const winRes = await this.#trackWrite(
            operation,
            this.windowClickFn(targetPid, {
              axBridge: this.axBridge,
              localPoint: windowDelivery.localPoint,
              expectedWindowSize:
                windowDelivery.expectedWindowSize ||
                (wb ? { width: wb.width ?? wb.w, height: wb.height ?? wb.h } : null),
              wid: windowDelivery.windowId || null,
              windowTitle: windowDelivery.windowTitle || preMeta?.windowTitle || "",
              windowBounds: wb
                ? {
                    x: wb.x ?? 0,
                    y: wb.y ?? 0,
                    width: wb.width ?? wb.w,
                    height: wb.height ?? wb.h,
                  }
                : null,
              button: cleanArgs.mouse_button || "left",
              clickCount: cleanArgs.click_count ?? 1,
              allowAppPostFallback: Boolean(windowDelivery.allowAppPostFallback),
              syntheticTag: this.takeoverController?.syntheticEventTag || 0,
              beforeWriteCheck,
            }),
            "click:window_post"
          ).catch((err) => {
            this.#rethrowIfAborted(err);
            return { delivered: false, reason: err?.message || "window_click_error" };
          });
          actionRouteKey = formatDeliveryRoute("click", winRes?.method || "window_post");
          result = winRes?.delivered
            ? { isError: false, content: [{ type: "text", text: "ok" }] }
            : {
                isError: true,
                content: [
                  {
                    type: "text",
                    text: `Window-local click rejected (${winRes?.reason || "unavailable"}).`,
                  },
                ],
              };
        }
      } else if (
        !parsedRef?.hasElementRef &&
        Number.isFinite(cleanArgs.x) &&
        Number.isFinite(cleanArgs.y) &&
        isValidTinyOverrideGeometry(ov) &&
        preMeta?.pid > 0 &&
        typeof this.pointClickFn === "function"
      ) {
        if (!isWithinTinyOverrideBounds(ov, cleanArgs.x, cleanArgs.y)) {
          actionRouteKey = formatDeliveryRoute(
            "click",
            cleanArgs.click_method === "window_post" ? "window_post" : "app_post"
          );
          result = {
            isError: true,
            content: [
              {
                type: "text",
                text: "Click coordinates are outside the current window screenshot bounds.",
              },
            ],
          };
        } else {
          this.#beforeWrite(operation, false);
          const { screenX, screenY } = mapTinyOverridePoint(ov, cleanArgs.x, cleanArgs.y);
          const allowAppPostFallback =
            cleanArgs.click_method !== "window_post" &&
            !this.focusPolicyGuard.isMethodBlocked(aliases, "click", "app_post");
          const rawClick = await this.#trackWrite(
            operation,
            this.pointClickFn(preMeta.pid, screenX, screenY, {
              button: cleanArgs.mouse_button || "left",
              clickCount: cleanArgs.click_count ?? 1,
              axBridge: this.axBridge,
              wid: ov.wid || null,
              bounds: ov.bounds,
              allowAppPostFallback,
              syntheticTag: this.takeoverController?.syntheticEventTag || 0,
            }),
            "click:point_override"
          );
          const ok =
            typeof rawClick === "object" && rawClick !== null
              ? Boolean(rawClick.delivered)
              : Boolean(rawClick);
          const effectiveMethod =
            (typeof rawClick === "object" && rawClick?.method) ||
            (cleanArgs.click_method === "window_post" ? "window_post" : "app_post");
          actionRouteKey = formatDeliveryRoute("click", effectiveMethod);
          result = ok
            ? { isError: false, content: [{ type: "text", text: "ok" }] }
            : { isError: true, content: [{ type: "text", text: "Background point click failed." }] };
        }
      } else {
        const methods = this.focusPolicyGuard.planClick(cleanArgs, aliases);
        let lastRes = null;
        for (const method of methods) {
          actionRouteKey = formatDeliveryRoute("click", method);
          lastRes = await this.#dispatchClickMethod(method, ctx);
          if (!lastRes?.isError || lastRes?.fatal) break;
        }

        if (
          lastRes?.isError &&
          (cleanArgs.mouse_button || "left") === "right" &&
          parsedRef?.hasElementRef &&
          preMeta?.pid > 0 &&
          !this.focusPolicyGuard.isMethodBlocked(aliases, "click", "ax_show_menu") &&
          typeof this.contextMenuFallbackFn === "function"
        ) {
          const beforeWriteCheck = () => this.#beforeWrite(operation, false);
          beforeWriteCheck();
          const menuRes = await this.#trackWrite(
            operation,
            this.contextMenuFallbackFn(preMeta.pid, preElement, {
              axBridge: this.axBridge,
              snapshotId: preSnapshot?.id || null,
              elementIndex: parsedRef.rawIndex,
              beforeWriteCheck,
            }),
            "click:ax_show_menu"
          ).catch((err) => {
            this.#rethrowIfAborted(err);
            return null;
          });
          if (menuRes?.delivered) {
            actionRouteKey = formatDeliveryRoute("click", "ax_show_menu");
            directDeliveryVerified = Boolean(menuRes.verified);
            lastRes = {
              isError: false,
              content: [{ type: "text", text: "Context menu triggered via AXShowMenu." }],
            };
          }
        }
        result = lastRes;
      }

      const clickPrefix =
        (cleanArgs.mouse_button || "left") === "right"
          ? "右键点击"
          : (cleanArgs.click_count ?? 1) >= 2
            ? "双击"
            : "点击";
      const meta = this.registry.getMeta(app);
      const resolvedWinPt = this.registry.resolveActionWindowPoint(
        app,
        windowDelivery?.localPoint
          ? {
              ...cleanArgs,
              windowPointPt: windowDelivery.localPoint,
              windowId: windowDelivery.windowId,
            }
          : cleanArgs,
        preElement
      );
      const evtNormX =
        Number.isFinite(windowDelivery?.normX) ? windowDelivery.normX : normX;
      const evtNormY =
        Number.isFinite(windowDelivery?.normY) ? windowDelivery.normY : normY;
      actionEvent = {
        type: "click",
        label: `${clickPrefix} · ${targetDesc}`,
        source: eventSource,
        normX: evtNormX,
        normY: evtNormY,
        ...(resolvedWinPt?.windowPointPt ? { windowPointPt: resolvedWinPt.windowPointPt } : {}),
        ...(resolvedWinPt?.windowId ? { windowId: resolvedWinPt.windowId } : {}),
        app: meta?.appDisplayName || app,
        targetApp: meta?.bundleId || app,
      };
    } else if (name === "type_text" || name === "press_key") {
      let lastRes = this.#buildReservedHotkeyErrorIfBlocked(name, cleanArgs.key, operation);
      if (lastRes) {
        // Blocked before dispatching any key event
      } else if (
        name === "type_text" &&
        (!cleanArgs.key_method || cleanArgs.key_method === "auto") &&
        preMeta?.pid > 0 &&
        !this.focusPolicyGuard.isMethodBlocked(aliases, "type_text", "ax_selected_text") &&
        typeof this.selectedTextInsertFn === "function" &&
        shouldAttemptSelectedTextFastPath(preAppKey, cleanArgs.text)
      ) {
        const beforeWriteCheck = () => this.#beforeWrite(operation, false);
        beforeWriteCheck();
        const axRes = await this.#trackWrite(
          operation,
          this.selectedTextInsertFn(preMeta.pid, cleanArgs.text, {
            axBridge: this.axBridge,
            beforeWriteCheck,
          }),
          "type_text:ax_selected_text"
        ).catch((err) => {
          this.#rethrowIfAborted(err);
          return null;
        });
        if (axRes?.delivered) {
          actionRouteKey = formatDeliveryRoute("type_text", "ax_selected_text");
          directDeliveryVerified = Boolean(axRes.verified);
          lastRes = {
            isError: false,
            content: [{ type: "text", text: "Text inserted via AXSelectedText." }],
          };
        }
      }

      if (!lastRes) {
        const methods = this.focusPolicyGuard.planKey(name, cleanArgs, aliases);
        for (const method of methods) {
          actionRouteKey = formatDeliveryRoute(name, method);
          lastRes = await this.#dispatchKeyMethod(name, method, ctx);
          if (!lastRes?.isError || lastRes?.fatal) break;
        }
      }

      result = lastRes;
      const preview =
        name === "type_text"
          ? `输入「${String(cleanArgs.text || "").slice(0, 24)}${String(cleanArgs.text || "").length > 24 ? "…" : ""}」`
          : `按键 ${cleanArgs.key}`;
      const meta = this.registry.getMeta(app);
      actionEvent = {
        type: "key",
        label: preview,
        source: eventSource,
        app: meta?.appDisplayName || app,
        targetApp: meta?.bundleId || app,
      };
    } else {
      const ov = preMeta?.tinyWindowOverride;
      const startX = Number.isFinite(cleanArgs.from_x) ? cleanArgs.from_x : cleanArgs.x;
      const startY = Number.isFinite(cleanArgs.from_y) ? cleanArgs.from_y : cleanArgs.y;

      if (
        name === "drag" &&
        Number.isFinite(startX) &&
        Number.isFinite(startY) &&
        Number.isFinite(cleanArgs.to_x) &&
        Number.isFinite(cleanArgs.to_y) &&
        isValidTinyOverrideGeometry(ov) &&
        preMeta?.pid > 0 &&
        typeof this.pointDragFn === "function"
      ) {
        actionRouteKey = formatDeliveryRoute("drag", "app_post");
        if (
          !isWithinTinyOverrideBounds(ov, startX, startY) ||
          !isWithinTinyOverrideBounds(ov, cleanArgs.to_x, cleanArgs.to_y)
        ) {
          result = {
            isError: true,
            content: [
              {
                type: "text",
                text: "Drag coordinates are outside the current window screenshot bounds.",
              },
            ],
          };
        } else {
          this.#beforeWrite(operation, false);
          const fromPt = mapTinyOverridePoint(ov, startX, startY);
          const toPt = mapTinyOverridePoint(ov, cleanArgs.to_x, cleanArgs.to_y);
          const ok = await this.#trackWrite(
            operation,
            this.pointDragFn(
              preMeta.pid,
              fromPt.screenX,
              fromPt.screenY,
              toPt.screenX,
              toPt.screenY,
              { syntheticTag: this.takeoverController?.syntheticEventTag || 0 }
            ),
            "drag:app_post"
          );
          result = ok
            ? { isError: false, content: [{ type: "text", text: "Drag delivered via app_post" }] }
            : { isError: true, content: [{ type: "text", text: "Background point drag failed." }] };
        }
      } else {
        let handledViaBypass = false;
        if (name === "scroll" && windowDelivery?.route === "window_post" && typeof this.windowScrollFn === "function") {
          const targetPid = Number(windowDelivery.pid || preMeta?.pid || 0);
          if (targetPid > 0) {
            const beforeWriteCheck = () => this.#beforeWrite(operation, false);
            beforeWriteCheck();
            const wb = windowDelivery.windowBoundsPt || null;
            const winScroll = await this.#trackWrite(
              operation,
              this.windowScrollFn(targetPid, {
                axBridge: this.axBridge,
                direction: cleanArgs.direction,
                pages: cleanArgs.pages,
                wid: windowDelivery.windowId || null,
                windowBounds: wb
                  ? {
                      x: wb.x ?? 0,
                      y: wb.y ?? 0,
                      width: wb.width ?? wb.w,
                      height: wb.height ?? wb.h,
                    }
                  : null,
                windowTitle: windowDelivery.windowTitle || preMeta?.windowTitle || "",
                localPoint: windowDelivery.localPoint || null,
                allowAppPostFallback: Boolean(windowDelivery.allowAppPostFallback),
                syntheticTag: this.takeoverController?.syntheticEventTag || 0,
                beforeWriteCheck,
              }),
              "scroll:window_post_scroll"
            ).catch((err) => {
              this.#rethrowIfAborted(err);
              return null;
            });
            actionRouteKey = formatDeliveryRoute(
              "scroll",
              winScroll?.method || "window_post_scroll"
            );
            result = winScroll?.delivered
              ? { isError: false, content: [{ type: "text", text: "Scrolled via window_post_scroll." }] }
              : {
                  isError: true,
                  content: [
                    {
                      type: "text",
                      text: `Window-local scroll failed (${winScroll?.reason || "unavailable"}).`,
                    },
                  ],
                };
            handledViaBypass = true;
          }
        }
        if (!handledViaBypass && name === "set_value") {
          actionRouteKey = formatDeliveryRoute("set_value", "native");
          const hasPriorNativeSteal = this.focusPolicyGuard.hasPriorSteal(
            aliases,
            "set_value:native",
            "set_value"
          );
          if (parsedRef?.hasElementRef && !preElement?.isSecure && hasPriorNativeSteal) {
            const bypass = await this.#executeBackgroundSetValueBypass(ctx);
            if (bypass?.ok) {
              handledViaBypass = true;
              actionRouteKey = formatDeliveryRoute("set_value", "sky_bypass");
              directDeliveryVerified = Boolean(bypass.verified);
              result = bypass.result;
            }
          }
        }

        if (!handledViaBypass) {
          result = await this.#callActionPeerWithRecovery(name, cleanArgs, app, {
            shouldFollow,
            allowAutoRefresh,
            operation,
          });
        }

        if (
          name === "scroll" &&
          result?.isError &&
          preMeta?.pid > 0 &&
          (!windowDelivery || windowDelivery.allowAppPostFallback !== false) &&
          !this.focusPolicyGuard.isMethodBlocked(aliases, "scroll", "ax_scrollbar") &&
          typeof this.axScrollFallbackFn === "function"
        ) {
          const beforeWriteCheck = () => this.#beforeWrite(operation, false);
          beforeWriteCheck();
          const axScroll = await this.#trackWrite(
            operation,
            this.axScrollFallbackFn(
              preMeta.pid,
              preElement,
              cleanArgs.direction,
              cleanArgs.pages,
              {
                axBridge: this.axBridge,
                snapshotId: preSnapshot?.id || null,
                elementIndex: parsedRef?.hasElementRef ? parsedRef.rawIndex : null,
                beforeWriteCheck,
              }
            ),
            "scroll:ax_scrollbar"
          ).catch((err) => {
            this.#rethrowIfAborted(err);
            return null;
          });
          if (axScroll?.delivered) {
            actionRouteKey = formatDeliveryRoute("scroll", "ax_scrollbar");
            directDeliveryVerified = Boolean(axScroll.verified);
            result = {
              isError: false,
              content: [{ type: "text", text: "Scrolled via AXScrollBar." }],
            };
          }
        }
      }

      const meta = this.registry.getMeta(app);
      const w = meta?.actionFrameWidth || fallbackDims.width || 0;
      const h = meta?.actionFrameHeight || fallbackDims.height || 0;
      const { normX, normY } =
        name === "drag" &&
        w > 0 &&
        h > 0 &&
        Number.isFinite(cleanArgs.to_x) &&
        Number.isFinite(cleanArgs.to_y)
          ? { normX: cleanArgs.to_x / w, normY: cleanArgs.to_y / h }
          : this.registry.resolveCursorNorm(app, cleanArgs, fallbackDims);
      const dragTargetText =
        Number.isFinite(cleanArgs.to_x) && Number.isFinite(cleanArgs.to_y)
          ? `(${Math.round(cleanArgs.to_x)}, ${Math.round(cleanArgs.to_y)})`
          : parsedRef?.hasElementRef
            ? this.registry.describeElement(app, cleanArgs.element_index)
            : "目标位置";
      const actionLabels = {
        scroll: `滚动 ${cleanArgs.direction} (${cleanArgs.pages ?? 1} 页)`,
        drag: `拖拽 → ${dragTargetText}`,
        set_value: `填写 ${this.registry.describeElement(app, cleanArgs.element_index)}`,
        select_text: `选中文本「${String(cleanArgs.text || "").slice(0, 18)}」`,
        perform_secondary_action: `动作 ${cleanArgs.action} · ${this.registry.describeElement(app, cleanArgs.element_index)}`,
      };
      const resolvedWinPt = this.registry.resolveActionWindowPoint(
        app,
        name === "drag" && Number.isFinite(cleanArgs.to_x) && Number.isFinite(cleanArgs.to_y)
          ? { ...cleanArgs, x: cleanArgs.to_x, y: cleanArgs.to_y }
          : cleanArgs,
        preElement
      );
      actionEvent = {
        type: name,
        label: actionLabels[name] || name,
        source: eventSource,
        normX,
        normY,
        ...(resolvedWinPt?.windowPointPt ? { windowPointPt: resolvedWinPt.windowPointPt } : {}),
        ...(resolvedWinPt?.windowId ? { windowId: resolvedWinPt.windowId } : {}),
        app: meta?.appDisplayName || app,
        targetApp: meta?.bundleId || app,
      };
    }

    if (parsedRef?.snapshotId && result?.isError && STALE_SNAPSHOT_RE.test(extractResultText(result))) {
      const latestNow = this.registry.getLatestSnapshot(preAppKey);
      return {
        result: buildStaleRefToolResult({
          errorCode: "STALE_REF",
          message: `Native AX cache invalidated for pinned ref '${parsedRef.displayRef}'. Call get_app_state before retrying.`,
          currentSnapshotId: latestNow?.id || null,
        }),
        actionRouteKey,
        directDeliveryVerified,
        actionEvent,
        isStalePinnedRef: true,
        preAppKey,
        preSnapshot,
        preElement,
        preFrameDigest,
      };
    }

    return {
      result,
      actionRouteKey,
      directDeliveryVerified,
      actionEvent,
      isStalePinnedRef: false,
      preAppKey,
      preSnapshot,
      preElement,
      preFrameDigest,
    };
  }

  async verifyAndFormatReadBack({
    name,
    cleanArgs,
    parsedRef,
    result,
    actionRouteKey,
    directDeliveryVerified = false,
    preAppKey,
    preSnapshot,
    preElement,
    preFrameDigest,
    checkAppRunningFn,
    readBackStateFn,
    onReclaimFocusFn = null,
  }) {
    const actionNote = extractResultText(result)
      .replace(/^ok\s*/iu, "")
      .trim();

    if (this.postActionDelayMs > 0) {
      await new Promise((r) => setTimeout(r, this.postActionDelayMs));
    }

    let readBack = await readBackStateFn();
    if (readBack?.isError && typeof checkAppRunningFn === "function") {
      const stillRunning = await checkAppRunningFn();
      if (stillRunning?.running) {
        if (this.windowTransitionRetryDelayMs > 0) {
          await new Promise((r) => setTimeout(r, this.windowTransitionRetryDelayMs));
        }
        readBack = await readBackStateFn();
      }
    }

    if (typeof onReclaimFocusFn === "function") {
      await onReclaimFocusFn();
    }

    if (readBack?.isError) {
      return { result, deliveryStatus: "delivered_unverified", verified: false };
    }

    const postSnapshot = this.registry.getLatestSnapshot(preAppKey);
    const readBackImg = extractResultImage(readBack);
    const postFrameDigest = readBackImg?.data
      ? computeFrameDigest(Buffer.from(readBackImg.data, "base64"))
      : null;
    const uiChanged =
      preSnapshot && postSnapshot && postSnapshot.id !== preSnapshot.id
        ? Boolean(
            postSnapshot.uiChangedSinceCapture ||
              preSnapshot.stale ||
              (postSnapshot.windowTitle || "") !== (preSnapshot.windowTitle || "")
          )
        : false;
    const frameChanged = Boolean(
      preFrameDigest && postFrameDigest && preFrameDigest !== postFrameDigest
    );

    let deliveryStatus = "delivered_unverified";
    let verificationNote = "";
    if (name === "set_value") {
      const postEl =
        parsedRef?.hasElementRef && postSnapshot?.elements?.get(parsedRef.rawIndex)
          ? postSnapshot.elements.get(parsedRef.rawIndex)
          : null;
      const check = verifySetValueObservation({
        expectedValue: cleanArgs.value,
        postElement: postEl,
        preElement,
        readBackText: extractResultText(readBack),
        isSecure: Boolean(preElement?.isSecure || postEl?.isSecure),
      });
      if (check.redacted) {
        if (directDeliveryVerified) {
          deliveryStatus = "delivered_verified";
        }
        verificationNote = check.note || "Secure field write completed [value redacted]";
      } else if (check.verified === true || (check.verified === null && directDeliveryVerified)) {
        deliveryStatus = "delivered_verified";
      } else if (check.verified === false) {
        verificationNote = `set_value readback still observed '${String(check.observed || "").slice(0, 40)}'`;
      }
    } else if (directDeliveryVerified || uiChanged || frameChanged) {
      deliveryStatus = "delivered_verified";
    }

    const verified = deliveryStatus === "delivered_verified";
    const deliveryFooter = `[Delivery: ${deliveryStatus} | Route: ${actionRouteKey}${verificationNote ? ` | ${verificationNote}` : ""}]`;
    const mergedResult =
      actionNote && Array.isArray(readBack.content)
        ? {
            ...readBack,
            content: [{ type: "text", text: actionNote }, ...readBack.content],
          }
        : readBack;

    return {
      result: appendResultFooter(mergedResult, deliveryFooter),
      deliveryStatus,
      verified,
    };
  }

  async #isJxaPostTrusted() {
    if (typeof this.axBridge?.checkPermissions !== "function") return true;
    const perms = await this.axBridge.checkPermissions().catch(() => null);
    return perms?.accessibility !== false;
  }

  async executeActScroll({
    app,
    pid,
    meta,
    snapshotId = null,
    direction = "down",
    pages = 0.7,
    windowId = null,
    localPoint = null,
    timeoutMs = null,
    operation = null,
  } = {}) {
    const aliases = app ? this.registry.aliasesFor(app, meta) : [];
    const wid =
      Number(windowId) > 0
        ? Number(windowId)
        : meta?.tinyWindowOverride?.wid || meta?.windowId || null;
    const beforeWriteCheck = () => this.#beforeWrite(operation, false);

    if (
      pid > 0 &&
      typeof this.axScrollFallbackFn === "function" &&
      !this.focusPolicyGuard.isMethodBlocked(aliases, "scroll", "ax_scrollbar")
    ) {
      beforeWriteCheck();
      const axRes = await this.#trackWrite(
        operation,
        this.axScrollFallbackFn(pid, null, direction, pages, {
          axBridge: this.axBridge,
          snapshotId,
          elementIndex: "0",
          beforeWriteCheck,
        }),
        "scroll:ax_scrollbar"
      ).catch((err) => {
        this.#rethrowIfAborted(err);
        return null;
      });
      if (axRes?.delivered && axRes?.verified) {
        return { delivered: true, route: formatDeliveryRoute("scroll", "ax_scrollbar") };
      }
    }

    const jxaTrusted = await this.#isJxaPostTrusted();
    if (jxaTrusted && pid > 0 && typeof this.windowScrollFn === "function") {
      beforeWriteCheck();
      const allowAppPostFallback = !this.focusPolicyGuard.isMethodBlocked(aliases, "click", "app_post");
      const winBounds =
        meta?.windowBounds || meta?.tinyWindowOverride?.bounds || null;
      const winRes = await this.#trackWrite(
        operation,
        this.windowScrollFn(pid, {
          axBridge: this.axBridge,
          direction,
          pages,
          wid,
          windowBounds: winBounds
            ? {
                x: winBounds.x ?? 0,
                y: winBounds.y ?? 0,
                width: winBounds.w ?? winBounds.width,
                height: winBounds.h ?? winBounds.height,
              }
            : null,
          windowTitle: meta?.windowTitle || "",
          localPoint,
          allowAppPostFallback,
          syntheticTag: this.takeoverController?.syntheticEventTag || 0,
          beforeWriteCheck,
        }),
        "scroll:window_post_scroll"
      ).catch((err) => {
        this.#rethrowIfAborted(err);
        return null;
      });
      if (winRes?.delivered) {
        return {
          delivered: true,
          route: formatDeliveryRoute("scroll", winRes.method || "window_post_scroll"),
        };
      }
    }

    if (
      !(Number(windowId) > 0) &&
      !this.focusPolicyGuard.hasPriorSteal(aliases, "scroll:native", "click:sky_click")
    ) {
      beforeWriteCheck();
      const callTimeout = Number(timeoutMs) > 0 ? Math.max(50, Math.min(8000, timeoutMs)) : undefined;
      const nativeRes = await this.#trackWrite(
        operation,
        this.actionPeer.callTool("scroll", { app, direction, pages }, callTimeout, { beforeWriteCheck }),
        "scroll:native"
      ).catch((err) => {
        this.#rethrowIfAborted(err);
        return null;
      });
      if (nativeRes && !nativeRes.isError) {
        return { delivered: true, route: formatDeliveryRoute("scroll", "native") };
      }
    }

    return { delivered: false, route: null };
  }

  async executeActClick({
    app,
    pid,
    meta,
    snapshotId = null,
    match,
    resolvedTarget = null,
    explicitWindowId = null,
    windowTitle = "",
    mouseButton = "left",
    clickCount = 1,
    signal = null,
    remainingBudgetMs = null,
    operation = null,
  } = {}) {
    const aliases = app ? this.registry.aliasesFor(app, meta) : [];
    const beforeWriteCheck = () => this.#beforeWrite(operation, false);
    const rawBounds = normalizeElementBounds(match?.bounds || match?.frame);
    const initialLocalPoint = rawBounds
      ? { x: rawBounds.x + rawBounds.w / 2, y: rawBounds.y + rawBounds.h / 2 }
      : null;

    // Logical window size only from genuine logical geometry — never encoded pixels (`actionFrameWidth`/`Height`)
    const logicalWinBounds =
      normalizeElementBounds(resolvedTarget?.windowBounds) ||
      normalizeElementBounds(meta?.windowBounds) ||
      normalizeElementBounds(meta?.tinyWindowOverride?.bounds) ||
      null;
    const windowSize = logicalWinBounds
      ? { width: logicalWinBounds.w, height: logicalWinBounds.h }
      : null;
    const windowClipBox = windowSize ? { x: 0, y: 0, w: windowSize.width, h: windowSize.height } : null;

    const cardBounds = normalizeElementBounds(resolvedTarget?.localBounds);
    const finalLocalPoint =
      clipBoxIntersectionCenter(cardBounds || rawBounds, windowClipBox) ||
      (resolvedTarget?.centerLocalPoint &&
      Number.isFinite(Number(resolvedTarget.centerLocalPoint.x)) &&
      Number.isFinite(Number(resolvedTarget.centerLocalPoint.y))
        ? { x: Number(resolvedTarget.centerLocalPoint.x), y: Number(resolvedTarget.centerLocalPoint.y) }
        : null) ||
      initialLocalPoint;

    const effectiveWid =
      Number(explicitWindowId) > 0
        ? Number(explicitWindowId)
        : resolvedTarget?.wid || meta?.tinyWindowOverride?.wid || meta?.windowId || null;

    const methods = this.focusPolicyGuard.planClick({ click_method: "auto" }, aliases);
    const allowWindowPost = !this.focusPolicyGuard.isMethodBlocked(aliases, "click", "window_post");
    const allowAppPostFallback = !this.focusPolicyGuard.isMethodBlocked(aliases, "click", "app_post");

    const jxaTrusted = await this.#isJxaPostTrusted();
    let routeKey = formatDeliveryRoute("click", "window_post");
    let failureReason = null;

    if (jxaTrusted && pid > 0 && allowWindowPost && typeof this.windowClickFn === "function" && finalLocalPoint) {
      if (signal?.aborted) {
        return { delivered: false, clicksSent: 0, aborted: true, routeKey, failureReason: "cancelled" };
      }
      beforeWriteCheck();
      const elemMeta =
        match?.index !== undefined ? meta?.elements?.get(String(match.index)) || null : null;
      const winRes = await this.#trackWrite(
        operation,
        this.windowClickFn(pid, {
          axBridge: this.axBridge,
          snapshotId,
          elementIndex: match?.index !== undefined ? String(match.index) : null,
          elementMeta: elemMeta,
          localPoint: finalLocalPoint,
          expectedWindowSize: windowSize,
          windowTitle: windowTitle || meta?.windowTitle || "",
          wid: effectiveWid,
          windowBounds: logicalWinBounds
            ? {
                x: logicalWinBounds.x,
                y: logicalWinBounds.y,
                width: logicalWinBounds.w,
                height: logicalWinBounds.h,
              }
            : null,
          button: mouseButton,
          clickCount,
          allowAppPostFallback,
          syntheticTag: this.takeoverController?.syntheticEventTag || 0,
          beforeWriteCheck,
        }),
        "click:window_post"
      ).catch((err) => {
        this.#rethrowIfAborted(err);
        return { delivered: false, reason: err?.message || "window_click_error" };
      });

      if (winRes?.delivered) {
        routeKey = formatDeliveryRoute("click", winRes.method || "window_post");
        return {
          delivered: true,
          clicksSent: 1,
          aborted: false,
          routeKey,
          failureReason: null,
          localPoint: finalLocalPoint,
        };
      }
      failureReason = winRes?.reason || "window_post_unavailable";
      if (
        winRes?.reason === "window_resized" ||
        winRes?.reason === "out_of_bounds" ||
        /^(?:element|window)_(?:destroyed|mutated|hidden|moved|changed)_in_background$|^modal_sheet_appeared$/u.test(
          String(winRes?.reason || "")
        )
      ) {
        return { delivered: false, clicksSent: 0, aborted: false, routeKey, failureReason };
      }
    }

    if (signal?.aborted) {
      return { delivered: false, clicksSent: 0, aborted: true, routeKey, failureReason: "cancelled" };
    }

    if (methods.includes("sky_click") && !this.focusPolicyGuard.hasPriorSteal(aliases, "click:sky_click")) {
      const canMapPx =
        !(Number(explicitWindowId) > 0) &&
        finalLocalPoint &&
        windowSize &&
        meta?.actionFrameWidth > 0 &&
        meta?.actionFrameHeight > 0;
      const px = canMapPx
        ? windowPointToScreenshotPixel(finalLocalPoint, {
            windowWidth: windowSize.width,
            windowHeight: windowSize.height,
            imageWidth: meta.actionFrameWidth,
            imageHeight: meta.actionFrameHeight,
          })
        : null;
      const matchWid = Number(match?.window_id || 0);
      const isPinned = Number(explicitWindowId) > 0;
      const elemMeta =
        match?.index !== undefined ? meta?.elements?.get(String(match.index)) : null;
      const hasPinnedMatchWid =
        matchWid === Number(explicitWindowId) ||
        Number(elemMeta?.windowId || 0) === Number(explicitWindowId);
      const hasSnapshotProvenance = Boolean(elemMeta && elemMeta.origin);
      const canUseIdx =
        match?.index !== undefined &&
        (!isPinned || (hasPinnedMatchWid && hasSnapshotProvenance));
      const preferCardPx = !isPinned && resolvedTarget?.reason === "ax_card" && Boolean(px);
      const clickArgs = preferCardPx
        ? {
            app,
            click_method: "sky_click",
            x: Math.round(px.x),
            y: Math.round(px.y),
            mouse_button: mouseButton,
            click_count: clickCount,
          }
        : canUseIdx
          ? {
              app,
              click_method: "sky_click",
              element_index: String(match.index),
              mouse_button: mouseButton,
              click_count: clickCount,
            }
          : px
            ? {
                app,
                click_method: "sky_click",
                x: Math.round(px.x),
                y: Math.round(px.y),
                mouse_button: mouseButton,
                click_count: clickCount,
              }
            : null;

      if (clickArgs) {
        beforeWriteCheck();
        routeKey = formatDeliveryRoute("click", "sky_click");
        const callTimeout =
          Number(remainingBudgetMs) > 0 ? Math.max(50, Math.min(8000, remainingBudgetMs)) : undefined;
        const nativeClick = await this.#trackWrite(
          operation,
          this.actionPeer.callTool("click", clickArgs, callTimeout, { beforeWriteCheck }),
          "click:sky_click"
        ).catch((err) => {
          this.#rethrowIfAborted(err);
          return null;
        });
        if (nativeClick && !nativeClick.isError) {
          return {
            delivered: true,
            clicksSent: 1,
            aborted: false,
            routeKey,
            failureReason: null,
            localPoint: finalLocalPoint,
          };
        }
        return {
          delivered: false,
          clicksSent: 1,
          aborted: false,
          routeKey,
          failureReason: extractResultText(nativeClick) || failureReason || "sky_click_failed",
        };
      }
    }

    return {
      delivered: false,
      clicksSent: 0,
      aborted: false,
      routeKey,
      failureReason: failureReason || "click_route_blocked",
    };
  }
}
