import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import vm from "node:vm";

import { BackgroundActionExecutor } from "../src/action-executor.mjs";
import { AppSnapshotRegistry, buildElementDescriptor } from "../src/app-snapshot-registry.mjs";
import { BRIDGE_JXA_SOURCE, PersistentAxBridge } from "../src/ax-bridge.mjs";
import {
  dispatchBackgroundPointClick,
  dispatchBackgroundPointClickDetailed,
  parseSnapshotMetadata,
} from "../src/background-policy.mjs";
import { BrokerRpcClient } from "../src/broker-client.mjs";
import { ComputerUseBrokerServer } from "../src/broker-sidecar.mjs";
import { PROJECT_ROOT, UI_HTML_PATH } from "../src/constants.mjs";
import { FocusPolicyGuard } from "../src/focus-policy-guard.mjs";
import { verifySetValueObservation } from "../src/headless-engine.mjs";
import { runJsonRpcStdioServer } from "../src/jsonrpc-stdio.mjs";
import { NativeComputerUsePeer } from "../src/native-peer.mjs";
import { SidecarWebAdapter } from "../src/sidecar-web-adapter.mjs";
import { installCodexComputerUse, uninstallCodexComputerUse } from "../scripts/installer-lib.mjs";

test("Codex #8 & #12: dispatchBackgroundPointClick preserves boolean contract while Detailed reports accurate SkyLight vs app_post method", async () => {
  const badBool = await dispatchBackgroundPointClick(-1, 10, 10);
  assert.equal(badBool, false);
  assert.equal(typeof badBool, "boolean");

  const detailedNoFallback = await dispatchBackgroundPointClickDetailed(
    process.pid,
    20,
    30,
    {
      allowAppPostFallback: false,
      axBridge: {
        async postWindowClick(_pid, opts) {
          assert.equal(opts.allowAppPostFallback, false);
          return { delivered: false, method: null, reason: "skylight_unavailable" };
        },
      },
    }
  );
  assert.deepEqual(detailedNoFallback, { delivered: false, method: "window_post" });

  const detailedAppPost = await dispatchBackgroundPointClickDetailed(
    process.pid,
    20,
    30,
    {
      allowAppPostFallback: true,
      axBridge: {
        async postWindowClick() {
          return { delivered: true, method: "app_post" };
        },
      },
    }
  );
  assert.deepEqual(detailedAppPost, { delivered: true, method: "app_post" });
});

test("Codex #1 & #17: BrokerRpcClient never replays mutating call when disconnect precedes write callback, and tolerates non-object JSON frames", async () => {
  const sock = path.join(tmpdir(), `cua-codex-ambig-${process.pid}-${Date.now()}.sock`);
  let receivedClicks = 0;

  const server = net.createServer((conn) => {
    conn.setEncoding("utf8");
    conn.on("data", (chunk) => {
      if (chunk.includes('"click"')) {
        receivedClicks += 1;
        // Send non-object JSON noise + immediate RST/destroy
        conn.write("null\n42\n[]\n");
        conn.destroy();
      }
    });
  });
  await new Promise((r) => server.listen(sock, r));

  // Simulate delayed write callback so socket closes BEFORE conn.write callback runs
  const client = new BrokerRpcClient({ socketPath: sock, enableFallback: false });
  const origConnect = net.createConnection;
  net.createConnection = (...args) => {
    const rawSock = origConnect(...args);
    const origWrite = rawSock.write.bind(rawSock);
    rawSock.write = (data, cb) => {
      return origWrite(data, (err) => {
        setTimeout(() => cb?.(err), 60);
      });
    };
    return rawSock;
  };

  try {
    await assert.rejects(
      () =>
        client.request("tools/call", {
          name: "click",
          arguments: { app: "com.apple.finder", x: 10, y: 10 },
        }),
      /closed|ECONNRESET|EPIPE/i
    );
    assert.equal(
      receivedClicks,
      1,
      "Mutating click must NEVER be replayed when disconnect arrives before write callback"
    );
  } finally {
    net.createConnection = origConnect;
    await client.close();
    await new Promise((r) => server.close(r));
    rmSync(sock, { force: true });
  }
});

test("Codex #2, #3, #10, #11, #27: AppSnapshotRegistry & BackgroundActionExecutor enforce pinned snapshot isolation, fail-closed live AX, query window precedence, empty snapshot replacement, and fingerprint parity", async () => {
  // #27: Identifier-free fingerprint parity between get_app_state (`Value: "same text"`) and query (`"same text"`)
  const fromSnap = buildElementDescriptor({
    index: "4",
    role: "text field",
    primaryText: 'Value: "same text"',
  });
  const fromQuery = buildElementDescriptor({
    index: "4",
    role: "text field",
    primaryText: "same text",
    fallbackLabelToIdentifier: true,
    redactHelp: true,
    emptyRawTextAsNull: true,
  });
  assert.equal(fromSnap.fingerprint, fromQuery.fingerprint);

  // #2: s1:5 = Delete A, followed by partial query s2:5 = Delete B -> @s1:5 MUST be rejected as STALE_REF!
  let verifyMode = "ok";
  const boundIds = [];
  const registry = new AppSnapshotRegistry({
    axBridge: {
      enabled: true,
      async bindSnapshot(p) {
        boundIds.push(p.snapshotId);
        return { bound: true };
      },
      async verifyLiveRef({ snapshotId }) {
        if (verifyMode === "throw") {
          throw new Error("PersistentAxBridge timeout on verify_live_ref");
        }
        if (verifyMode === "evicted") {
          return { ok: false, skipped: "snapshot_not_retained", reason: "snapshot_not_retained" };
        }
        return { ok: true, snapshotId };
      },
    },
  });

  const s1Meta = parseSnapshotMetadata(
    [
      `App=com.example.App (pid ${process.pid})`,
      'Window: "Doc A", App: Demo.',
      "\t5 button Delete A",
      "\t9 button Keep Me",
    ].join("\n")
  );
  const mergedS1 = registry.recordMeta("com.example.App", s1Meta, {
    fromActionPeer: true,
    includeAx: true,
    includeScreenshot: true,
    actionDims: { width: 800, height: 600 },
  });
  assert.equal(mergedS1.snapshotId, "s1");

  // Query produces s2 on Doc A where #5 drifted to "Delete B"
  const mergedS2 = await registry.ingestQueryMatches("com.example.App", {
    window_title: "Doc A",
    matches: [{ index: 5, role: "button", title: "Delete B" }],
  });
  assert.equal(mergedS2.snapshotId, "s2");

  const driftCheck = await registry.validateTargetRef({
    app: "com.example.App",
    parsedRef: { ok: true, hasElementRef: true, snapshotId: "s1", rawIndex: "5", displayRef: "@s1:5" },
  });
  assert.equal(driftCheck.ok, false, "Overlapping query drift at #5 must fail @s1:5");
  assert.equal(driftCheck.errorCode, "STALE_REF");

  // Non-drifted @s1:9 must return validated snapshot s1 AND executor must pass s1 (NOT s2!) to windowClickFn!
  const validS1Ref = await registry.validateTargetRef({
    app: "com.example.App",
    parsedRef: { ok: true, hasElementRef: true, snapshotId: "s1", rawIndex: "9", displayRef: "@s1:9" },
  });
  assert.equal(validS1Ref.ok, true);
  assert.equal(validS1Ref.snapshot?.id, "s1");

  let clickSnapshotId = null;
  const executor = new BackgroundActionExecutor({
    actionPeer: { async callTool() { return { isError: false, content: [{ type: "text", text: "ok" }] }; } },
    focusPolicyGuard: new FocusPolicyGuard(),
    registry,
    windowClickFn: async (_pid, opts) => {
      clickSnapshotId = opts.snapshotId;
      return { delivered: true };
    },
  });
  await executor.dispatch({
    name: "click",
    app: "com.example.App",
    cleanArgs: { app: "com.example.App", element_index: "9", click_method: "window_post" },
    parsedRef: { ok: true, hasElementRef: true, snapshotId: "s1", rawIndex: "9", displayRef: "@s1:9" },
    validatedSnapshot: validS1Ref.snapshot,
    validatedElement: validS1Ref.element,
  });
  assert.equal(clickSnapshotId, "s1", "Executor must dispatch qualified @s1:9 against s1, not latest s2");

  // #3: Verifier timeout or evicted snapshot for qualified ref MUST fail closed!
  verifyMode = "throw";
  const timeoutCheck = await registry.validateTargetRef({
    app: "com.example.App",
    parsedRef: { ok: true, hasElementRef: true, snapshotId: "s1", rawIndex: "9", displayRef: "@s1:9" },
  });
  assert.equal(timeoutCheck.ok, false, "Thrown verifyLiveRef must fail closed instead of failing open");

  // #10: Query on a different window ("Doc B") must update windowTitle to "Doc B" rather than retaining cached "Doc A"
  verifyMode = "ok";
  const mergedDocB = await registry.ingestQueryMatches("com.example.App", {
    window_title: "Doc B",
    matches: [{ index: 1, role: "button", title: "Confirm B" }],
  });
  assert.equal(mergedDocB.windowTitle, "Doc B");

  // #11: Full empty AX snapshot must clear previous elements instead of resurrecting them
  const emptySnapMeta = parseSnapshotMetadata(
    [`App=com.example.App (pid ${process.pid})`, 'Window: "Doc B", App: Demo.'].join("\n")
  );
  const mergedEmpty = registry.recordMeta("com.example.App", emptySnapMeta, {
    fromActionPeer: true,
    includeAx: true,
    includeScreenshot: true,
  });
  assert.equal(mergedEmpty.elements.size, 0, "Empty full AX snapshot must not resurrect prior elements");
});

test("Codex #4, #12, #21, #22: JXA worker enforces bound target on sky_bypass focus gate, honors allowAppPostFallback, and readback verifies clear/secure fields accurately", async () => {
  // Evaluate JXA worker functions in an isolated VM mock to test handleVerifyEditableFocus & handleWindowClick directly
  const fakeFocusedEl = {
    role: "AXTextField",
    subrole: "",
    isEqual(other) {
      return other === fakeFocusedEl;
    },
  };
  const fakeOtherBoundEl = {
    role: "AXTextField",
    subrole: "",
    isEqual(other) {
      return other === fakeOtherBoundEl;
    },
  };
  let cgPostCount = 0;
  let cgWindows = [
    {
      kCGWindowNumber: 42,
      kCGWindowOwnerPID: 1234,
      kCGWindowLayer: 0,
      kCGWindowAlpha: 1,
      kCGWindowName: "Main",
      kCGWindowBounds: { X: 100, Y: 100, Width: 400, Height: 300 },
    },
  ];

  const sandbox = {
    ObjC: {
      import() {},
      bindFunction(fnName) {
        if (fnName === "SLEventPostToPid") {
          throw new Error("SkyLight symbol unavailable in sandbox");
        }
      },
      unwrap(v) {
        return v?.__val !== undefined ? v.__val : v;
      },
      deepUnwrap(v) {
        return v;
      },
      castRefToObject(r) {
        return r;
      },
    },
    Ref: () => [null],
    $: Object.assign((s) => ({ __val: s }), {
      CGWindowListCopyWindowInfo: () => cgWindows,
      AXUIElementCreateApplication: () => ({ role: "AXApplication", focused: fakeFocusedEl }),
      AXUIElementSetMessagingTimeout: () => 0,
      AXUIElementCopyAttributeValue: (el, attr, out) => {
        const key = attr?.__val || attr;
        if (key === "AXFocusedUIElement" && el.focused) {
          out[0] = el.focused;
          return 0;
        }
        if (key === "AXRole" && el.role) {
          out[0] = { __val: el.role };
          return 0;
        }
        if (key === "AXSubrole") {
          out[0] = { __val: el.subrole || "" };
          return 0;
        }
        return -25205;
      },
      AXIsProcessTrusted: () => true,
      NSFileHandle: {
        fileHandleWithStandardInput: { availableData: { length: 0 } },
        fileHandleWithStandardOutput: { writeData() {} },
      },
      NSProcessInfo: { processInfo: { systemUptime: 1 } },
      NSThread: { sleepForTimeInterval() {} },
      CGEventSourceCreate: () => ({}),
      CGEventCreateMouseEvent: () => ({}),
      CGEventSetTimestamp() {},
      CGEventSetIntegerValueField() {},
      CGEventSetDoubleValueField() {},
      CGEventPostToPid() {
        cgPostCount += 1;
      },
      CFRelease() {},
      kCGMouseEventClickState: 1,
      kCGMouseEventButtonNumber: 3,
    }),
  };
  vm.createContext(sandbox);
  vm.runInContext(BRIDGE_JXA_SOURCE, sandbox);

  // #4: Missing target binding when elementIndex is provided MUST return editable: false!
  const unboundFocus = sandbox.handleVerifyEditableFocus({
    pid: 1234,
    snapshotId: "s99",
    elementIndex: "5",
  });
  assert.equal(
    unboundFocus.editable,
    false,
    "sky_bypass focus gate must reject when target element handle is missing/unbound"
  );

  // Bound to a DIFFERENT element -> editable: false
  sandbox.retainedSnapshots.s1 = {
    pid: 1234,
    elements: { "5": { el: fakeOtherBoundEl } },
  };
  const wrongFocus = sandbox.handleVerifyEditableFocus({
    pid: 1234,
    snapshotId: "s1",
    elementIndex: "5",
  });
  assert.equal(wrongFocus.editable, false);

  // Bound to the ACTUAL focused element -> editable: true
  sandbox.retainedSnapshots.s1.elements["5"] = { el: fakeFocusedEl };
  const rightFocus = sandbox.handleVerifyEditableFocus({
    pid: 1234,
    snapshotId: "s1",
    elementIndex: "5",
  });
  assert.equal(rightFocus.editable, true);

  // #12: Without SkyLight symbol, handleWindowClick with default/false allowAppPostFallback MUST NOT post CGEventPostToPid!
  const noFallbackWin = sandbox.handleWindowClick({
    pid: 1234,
    screenCoords: true,
    x: 150,
    y: 150,
    wid: 42,
    windowBounds: { x: 100, y: 100, width: 400, height: 300 },
    allowAppPostFallback: false,
  });
  assert.equal(noFallbackWin.delivered, false);
  assert.equal(cgPostCount, 0);

  const yesFallbackWin = sandbox.handleWindowClick({
    pid: 1234,
    screenCoords: true,
    x: 150,
    y: 150,
    wid: 42,
    windowBounds: { x: 100, y: 100, width: 400, height: 300 },
    allowAppPostFallback: true,
  });
  assert.equal(yesFallbackWin.delivered, true);
  assert.equal(yesFallbackWin.method, "app_post");
  assert.equal(cgPostCount > 0, true);

  const postsBeforeMissing = cgPostCount;
  const missingWidWin = sandbox.handleWindowClick({
    pid: 1234,
    screenCoords: true,
    x: 150,
    y: 150,
    wid: 999,
    windowBounds: { x: 100, y: 100, width: 400, height: 300 },
    allowAppPostFallback: true,
  });
  assert.equal(missingWidWin.delivered, false);
  assert.equal(missingWidWin.reason, "window_not_found");
  assert.equal(cgPostCount, postsBeforeMissing);

  // #21: Clearing a nonempty field that stays nonempty MUST return verified: false!
  assert.equal(
    verifySetValueObservation({
      expectedValue: "",
      preElement: { rawText: 'Value: "still here"', isSecure: false },
      postElement: { rawText: 'Value: "still here"', isSecure: false },
    }).verified,
    false
  );
  assert.equal(
    verifySetValueObservation({
      expectedValue: "",
      preElement: { rawText: 'Value: "still here"', isSecure: false },
      postElement: { rawText: 'Value: ""', isSecure: false },
    }).verified,
    true
  );
  // Substring mismatch ("cat" vs "concatenate") MUST return verified: false!
  assert.equal(
    verifySetValueObservation({
      expectedValue: "cat",
      preElement: { rawText: 'Value: "old"', isSecure: false },
      postElement: { rawText: 'Value: "concatenate"', isSecure: false },
    }).verified,
    false
  );

  // #22: Unchanged secure field with directDeliveryVerified: false must remain delivered_unverified
  const reg = new AppSnapshotRegistry();
  const secMeta = parseSnapshotMetadata(
    [`App=com.example.Sec (pid ${process.pid})`, 'Window: "Login", App: Sec.', "\t2 AXSecureTextField ID: pwd"].join("\n")
  );
  reg.recordMeta("com.example.Sec", secMeta, { fromActionPeer: true, includeAx: true, includeScreenshot: false });
  const exec = new BackgroundActionExecutor({
    actionPeer: { async callTool() { return { isError: false, content: [] }; } },
    focusPolicyGuard: new FocusPolicyGuard(),
    registry: reg,
    postActionDelayMs: 0,
  });
  const secVerifyOut = await exec.verifyAndFormatReadBack({
    name: "set_value",
    cleanArgs: { app: "com.example.Sec", element_index: "2", value: "topsecret" },
    parsedRef: { ok: true, hasElementRef: true, rawIndex: "2" },
    result: { isError: false, content: [{ type: "text", text: "ok" }] },
    actionRouteKey: "set_value:native",
    directDeliveryVerified: false,
    preAppKey: "com.example.Sec",
    preSnapshot: reg.getLatestSnapshot("com.example.Sec"),
    preElement: reg.getMeta("com.example.Sec").elements.get("2"),
    preFrameDigest: "same-digest",
    readBackStateFn: async () => ({
      isError: false,
      content: [
        {
          type: "text",
          text: [`App=com.example.Sec (pid ${process.pid})`, 'Window: "Login", App: Sec.', "\t2 AXSecureTextField ID: pwd"].join("\n"),
        },
      ],
    }),
  });
  assert.equal(secVerifyOut.deliveryStatus, "delivered_unverified");
  assert.equal(secVerifyOut.verified, false);
});

test("Codex #5, #6, #7, #9, #13, #14, #19: Broker redacts outbound secrets, blocks quit-app relaunch on pinned refs, reclaims focus on throw/rapid mutations, blocks RPC source spoofing, validates drag bounds, and protects live sockets", async () => {
  // #9: Two rapid mutations across App A and App B must retain BOTH delayed sweep guards!
  let currentFront = { pid: 100, bundleId: "com.google.antigravity", displayName: "Antigravity" };
  const restoredPids = [];
  const rapidGuard = new FocusPolicyGuard({
    focusController: {
      async getFrontmostApp() {
        return currentFront;
      },
      async restoreFrontmostApp(pid) {
        restoredPids.push(pid);
        currentFront = { pid, bundleId: "com.google.antigravity", displayName: "Antigravity" };
        return true;
      },
      sweepDelaysMs: [45],
    },
    resolveTargetInfo: (app) =>
      app === "com.app.A"
        ? { pid: 201, bundleId: "com.app.A", appDisplayName: "AppA", appQuery: app }
        : { pid: 202, bundleId: "com.app.B", appDisplayName: "AppB", appQuery: app },
  });

  const scopeA = await rapidGuard.beginGuard("com.app.A");
  scopeA.finish("click:sky_click");
  const scopeB = await rapidGuard.beginGuard("com.app.B");
  scopeB.finish("click:sky_click");

  // App A steals focus 15ms later -> scopeA's timer MUST still be alive and reclaim + blacklist App A's sky_click!
  currentFront = { pid: 201, bundleId: "com.app.A", displayName: "AppA" };
  await new Promise((r) => setTimeout(r, 75));
  assert.equal(restoredPids.includes(100), true, "App A's sweep guard must not be canceled by App B");
  assert.equal(rapidGuard.isMethodBlocked(["com.app.A"], "click", "sky_click"), true);
  rapidGuard.close();

  // End-to-end Broker test for #5, #6, #7, #13, #14, #19
  const sock = path.join(tmpdir(), `cua-codex-broker-${process.pid}-${Date.now()}.sock`);
  const vaultPid = 999999;
  let appRunning = true;
  let throwOnClick = false;
  let raiseDispatched = 0;
  let dragDispatched = 0;
  let frontApp = { pid: 900, bundleId: "com.google.antigravity", displayName: "Antigravity" };
  const frontRestores = [];

  const peer = {
    async listTools() {
      return { tools: [{ name: "list_apps" }, { name: "get_app_state" }, { name: "query" }, { name: "click" }] };
    },
    async callTool(name, args) {
      if (name === "list_apps") {
        return {
          isError: false,
          content: [
            {
              type: "text",
              text: appRunning
                ? `VaultApp — com.example.Vault [running]`
                : `Finder — com.apple.finder [running]`,
            },
          ],
        };
      }
      if (name === "get_app_state") {
        return {
          isError: false,
          content: [
            {
              type: "text",
              text: [
                `App=com.example.Vault (pid ${vaultPid})`,
                'Window: "Vault", App: VaultApp.',
                '\t1 button Unlock',
                '\t2 secure text field Value: "SuperSecretCanary99" Help: SecretHint ID: vault_pwd',
              ].join("\n"),
            },
          ],
        };
      }
      if (name === "query") {
        return {
          isError: false,
          content: [
            {
              type: "text",
              text: JSON.stringify({
                window_title: "Vault",
                matches: [
                  {
                    index: 2,
                    role: "AXSecureTextField",
                    title: "SuperSecretCanary99",
                    value: "SuperSecretCanary99",
                    description: "SuperSecretCanary99",
                    text: "SuperSecretCanary99",
                    help: "SuperSecretCanary99",
                    identifier: "vault_pwd",
                  },
                ],
              }),
            },
          ],
        };
      }
      if (name === "perform_secondary_action" && /raise/iu.test(String(args.action))) {
        raiseDispatched += 1;
      }
      if (name === "click" && throwOnClick) {
        frontApp = { pid: vaultPid, bundleId: "com.example.Vault", displayName: "VaultApp" };
        throw new Error("actionPeer pipe disconnected mid-click");
      }
      return { isError: false, content: [{ type: "text", text: "ok" }] };
    },
    close() {},
  };

  const broker = new ComputerUseBrokerServer({
    webPort: 0,
    uiToken: "codex-tok",
    socketPath: sock,
    actionPeer: peer,
    streamPeer: peer,
    pointDragFn: async () => {
      dragDispatched += 1;
      return true;
    },
    focusController: {
      async getFrontmostApp() {
        return frontApp;
      },
      async restoreFrontmostApp(pid) {
        frontRestores.push(pid);
        frontApp = { pid, bundleId: "com.google.antigravity", displayName: "Antigravity" };
        return true;
      },
      sweepDelaysMs: [],
    },
  });
  await broker.start();
  const client = new BrokerRpcClient({ socketPath: sock, enableFallback: false });

  try {
    // #19: Competing broker on same live socketPath must fail without unlinking the live socket!
    const competing = new ComputerUseBrokerServer({
      webPort: 0,
      uiToken: "competing",
      socketPath: sock,
      actionPeer: peer,
      streamPeer: peer,
    });
    await assert.rejects(() => competing.start(), /already listening|in use/i);
    await competing.close();
    assert.equal(existsSync(sock), true, "Competing broker close() must not unlink live broker's socket");

    // #5: Outbound get_app_state & query responses must NEVER contain SuperSecretCanary99!
    const stateOut = await client.request("tools/call", {
      name: "get_app_state",
      arguments: { app: "com.example.Vault" },
    });
    const stateText = stateOut.content.map((c) => c.text || "").join("\n");
    assert.equal(stateText.includes("SuperSecretCanary99"), false, "get_app_state leaked password canary");

    const queryOut = await client.request("tools/call", {
      name: "query",
      arguments: { app: "com.example.Vault", role: "AXSecureTextField" },
    });
    const queryText = queryOut.content.map((c) => c.text || "").join("\n");
    assert.equal(queryText.includes("SuperSecretCanary99"), false, "query leaked password canary");

    // #13: Caller-supplied `source: "ui"` over RPC must NOT bypass Raise prohibition or paused state!
    const raiseRes = await client.request("tools/call", {
      name: "perform_secondary_action",
      arguments: { app: "com.example.Vault", element_index: "1", action: "Raise" },
      source: "ui",
    });
    assert.equal(raiseDispatched, 0, "RPC caller spoofing source:'ui' bypassed Raise prohibition");
    assert.match(raiseRes.content[0].text, /Skipped Raise/);

    // #14: Tiny Window Override drag must reject out-of-bounds endpoints!
    const meta = broker.registry.getMeta("com.example.Vault");
    meta.tinyWindowOverride = {
      wid: 55,
      bounds: { x: 100, y: 100, width: 200, height: 200 },
      imgWidth: 100,
      imgHeight: 100,
    };
    const badDrag = await client.request("tools/call", {
      name: "drag",
      arguments: { app: "com.example.Vault", from_x: -90, from_y: 10, to_x: 510, to_y: 50 },
    });
    assert.equal(badDrag.isError, true);
    assert.equal(dragDispatched, 0);
    meta.tinyWindowOverride = null;

    // #7: Thrown exception during dispatch MUST still reclaim stolen focus!
    throwOnClick = true;
    await assert.rejects(() =>
      client.request("tools/call", {
        name: "click",
        arguments: { app: "com.example.Vault", element_index: "1" },
      })
    );
    throwOnClick = false;
    assert.equal(frontRestores.includes(900), true, "Dispatch exception bypassed focus reclamation");

    // #6: App exits (`Cmd+Q`) -> stale pinned `@s1:1` MUST reject immediately with STALE_REF without relaunching!
    // Use a non-existent bundle query to verify launchAppInBackground isn't invoked or track state
    appRunning = false;
    const quitPinnedRes = await client.request("tools/call", {
      name: "click",
      arguments: { app: "com.example.Vault", element_index: "@s1:1" },
    });
    assert.equal(quitPinnedRes.isError, true);
    assert.match(quitPinnedRes.content[0].text, /ErrorCode:\s*STALE_REF/);
    assert.match(quitPinnedRes.content[0].text, /Delivery:\s*not_delivered/);
  } finally {
    await client.close();
    await broker.close();
  }
});

test("Codex #15, #16, #17, #18, #20, #28: Worker/stdin/JSON-RPC/HTTP boundary hardening & UI view-generation fencing", async () => {
  // #16: NativeComputerUsePeer attaches stdin 'error' listener so EPIPE cannot crash process
  const peer = new NativeComputerUsePeer({
    name: "epipe-test-peer",
    command: process.execPath,
    args: [
      "-e",
      `process.stdin.on("data", (d) => {
        const m = JSON.parse(String(d).trim());
        if (m.method === "initialize") {
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: {} }) + "\\n");
        } else {
          process.exit(1);
        }
      });`,
    ],
  });
  await peer.ensureStarted();
  assert.equal(peer.child.stdin.listenerCount("error") > 0, true, "child.stdin must have an error listener");
  // Emitting EPIPE directly on child.stdin must NOT throw uncaughtException
  peer.child.stdin.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
  peer.close();

  // #17: runJsonRpcStdioServer responds -32600 Invalid Request to `null\n`, `[]\n`, and `{"id":7,"method":123}\n`
  const input = new PassThrough();
  const output = new PassThrough();
  const lines = [];
  let outBuf = "";
  output.setEncoding("utf8");
  output.on("data", (c) => {
    outBuf += c;
    let nl;
    while ((nl = outBuf.indexOf("\n")) >= 0) {
      const l = outBuf.slice(0, nl).trim();
      outBuf = outBuf.slice(nl + 1);
      if (l) lines.push(JSON.parse(l));
    }
  });
  runJsonRpcStdioServer({
    serverInfo: { name: "test", version: "1.0.0" },
    onListTools: async () => ({ tools: [] }),
    onCallTool: async () => ({ content: [] }),
    input,
    output,
    registerSignals: false,
  });
  input.write('null\n[]\n{"jsonrpc":"2.0","id":7,"method":123}\n{"jsonrpc":"2.0","id":8,"method":"initialize","params":null}\n');
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(lines[0].error.code, -32600);
  assert.equal(lines[1].error.code, -32600);
  assert.equal(lines[2].id, 7);
  assert.equal(lines[2].error.code, -32600);
  assert.equal(lines[3].id, 8);
  assert.ok(lines[3].result.protocolVersion);

  // #18: SidecarWebAdapter returns HTTP 400 on malformed target `//[/` without unhandledRejection
  let unhandled = null;
  const onUnhandled = (err) => {
    unhandled = err;
  };
  process.on("unhandledRejection", onUnhandled);
  const web = new SidecarWebAdapter({
    webPort: 0,
    uiToken: "secret-tok",
    state: { permissions: {}, runningApps: [], recentActions: [], headlessStats: {} },
    brokerBootId: "boot-1",
    onInteract: async (app, data) => ({ ok: true, app, data }),
  });
  const port = await web.start();
  try {
    const statusCode = await new Promise((resolve, reject) => {
      const sock = net.createConnection({ host: "127.0.0.1", port }, () => {
        sock.write("GET //[/ HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
      });
      let raw = "";
      sock.setEncoding("utf8");
      sock.on("data", (d) => {
        raw += d;
      });
      sock.on("end", () => {
        const m = /^HTTP\/1\.[01]\s+(\d+)/.exec(raw);
        resolve(m ? Number(m[1]) : 0);
      });
      sock.on("error", reject);
    });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(unhandled, null, "Malformed HTTP URL must not cause unhandledRejection");
    assert.equal(statusCode === 400 || statusCode === 401, true);

    // #20: Server rejects stale brokerBootId on /api/interact
    const staleBootRes = await fetch(`http://127.0.0.1:${port}/api/interact`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Sidecar-Token": "secret-tok" },
      body: JSON.stringify({
        app: "com.example.AppA",
        brokerBootId: "old-boot-id",
        kind: "click",
        normX: 0.5,
        normY: 0.5,
      }),
    });
    assert.equal(staleBootRes.status, 409);
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
    await web.close();
  }

    // #20 & #28: Verify UI HTML fences loadFrame/singleClickTimer by viewGeneration and renders unified winMeta
  const uiHtml = readFileSync(UI_HTML_PATH, "utf8");
  assert.match(uiHtml, /viewGeneration/);
  assert.match(uiHtml, /renderWinMeta/);

  // #15: PersistentAxBridge fences worker close/stdout callbacks by generation so a stale worker's delayed close cannot reject Worker 2's pending requests!
  const spawnedWorkers = [];
  const bridge = new PersistentAxBridge({
    enabled: true,
    spawnFn() {
      const workerIdx = spawnedWorkers.length + 1;
      const proc = new EventEmitter();
      proc.exitCode = null;
      proc.killed = false;
      proc.stdout = new PassThrough();
      proc.stderr = new PassThrough();
      proc.stdin = new Writable({
        write(chunk, _enc, cb) {
          const msg = JSON.parse(String(chunk).trim());
          if (msg.method === "ping") {
            proc.stdout.write(`${JSON.stringify({ id: msg.id, ok: true, result: { pong: true } })}\n`);
          } else if (workerIdx === 2 && msg.method === "frontmost_app") {
            setTimeout(() => {
              proc.stdout.write(
                `${JSON.stringify({ id: msg.id, ok: true, result: { pid: 777, bundleId: "com.test.w2" } })}\n`
              );
            }, 35);
          }
          // Worker 1 hangs on non-ping requests to trigger timeout recycling!
          cb();
        },
      });
      proc.kill = () => {};
      spawnedWorkers.push(proc);
      return proc;
    },
  });

  // 1) Worker 1 starts and times out on a 25ms request -> recycled
  await assert.rejects(
    () => bridge.request("frontmost_app", {}, { timeoutMs: 25 }),
    /timeout/i
  );
  assert.equal(spawnedWorkers.length, 1);

  // 2) Worker 2 starts and sends an in-flight request; while in flight, Worker 1 emits delayed `close`!
  const w2Promise = bridge.request("frontmost_app", {}, { timeoutMs: 500 });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(spawnedWorkers.length, 2);
  spawnedWorkers[0].emit("close", 0, "SIGKILL");

  const w2Result = await w2Promise;
  assert.equal(w2Result.pid, 777, "Delayed close from Worker 1 must not abort Worker 2's pending request");
  bridge.close();
});

test("Codex #23, #24, #25, #26: Installer preserves 0600 mcp_config permissions, backs up mixed-ownership entries, preserves post-install user replacements, and aborts cleanup on corrupt mcp_config", async () => {
  const fakeHome = mkdtempSync(path.join(tmpdir(), "cua-codex-inst-"));
  const configDir = path.join(fakeHome, ".gemini", "config");
  const installDir = path.join(fakeHome, ".gemini", "codex-style-computer-use");
  mkdirSync(configDir, { recursive: true });

  const fakeOcuAppBin = path.join(
    configDir,
    "computer-use-1.1.3/node_modules/open-computer-use/dist/Open Computer Use.app/Contents/MacOS"
  );
  const fakeOcuReplDir = path.join(
    configDir,
    "computer-use-1.1.3/node_modules/open-computer-use/scripts/node-repl"
  );
  mkdirSync(fakeOcuAppBin, { recursive: true });
  mkdirSync(fakeOcuReplDir, { recursive: true });
  writeFileSync(path.join(fakeOcuAppBin, "OpenComputerUse"), "#!/bin/sh\n", { mode: 0o755 });
  writeFileSync(path.join(fakeOcuReplDir, "open-computer-use-repl.mjs"), "export {};\n");

  const mcpPath = path.join(configDir, "mcp_config.json");
  const foreignReplEntry = { command: "/foreign/repl-server", args: ["--stdio"] };

  try {
    // #23 & #26: Mixed ownership (`computer-use` already ours, `computer-use-js` foreign) + mode 0600
    writeFileSync(
      mcpPath,
      JSON.stringify(
        {
          mcpServers: {
            "computer-use": {
              command: "/custom/bin/node",
              args: [path.join(installDir, "src", "mcp-server.mjs")],
            },
            "computer-use-js": foreignReplEntry,
          },
        },
        null,
        2
      ),
      { mode: 0o600 }
    );

    await installCodexComputerUse({
      sourceRoot: PROJECT_ROOT,
      homeDir: fakeHome,
      installDir,
      nodeExecPath: "/custom/bin/node",
      skipDoctor: true,
      skipProcessKill: true,
      liveRpcFn: async () => false,
    });

    assert.equal(
      statSync(mcpPath).mode & 0o777,
      0o600,
      "mcp_config.json mode 0600 must be preserved across install"
    );

    // #24: User manually replaces `computer-use` after installation (even pointing to a separate checkout named `codex-style-computer-use`!)
    // -> uninstall must NOT overwrite user's replacement, while `computer-use-js` (still ours) must restore `foreignReplEntry`!
    const userReplacement = {
      command: "/user/node",
      args: ["/Users/dev/separate-fork/codex-style-computer-use/src/mcp-server.mjs"],
    };
    const afterInstallMcp = JSON.parse(readFileSync(mcpPath, "utf8"));
    afterInstallMcp.mcpServers["computer-use"] = userReplacement;
    writeFileSync(mcpPath, JSON.stringify(afterInstallMcp, null, 2), { mode: 0o600 });

    // #25: Corrupt mcp_config.json -> uninstall must fail BEFORE deleting installDir or recovery data!
    writeFileSync(mcpPath, "{ broken json", { mode: 0o600 });
    await assert.rejects(() =>
      uninstallCodexComputerUse({
        homeDir: fakeHome,
        installDir,
        skipProcessKill: true,
        liveRpcFn: async () => false,
      })
    );
    assert.equal(existsSync(installDir), true, "installDir must not be deleted when mcp_config restoration fails");

    // Fix mcp_config.json and run uninstall -> user's `computer-use` replacement stays, `computer-use-js` restores foreignReplEntry, mode stays 0600!
    writeFileSync(mcpPath, JSON.stringify(afterInstallMcp, null, 2), { mode: 0o600 });
    await uninstallCodexComputerUse({
      homeDir: fakeHome,
      installDir,
      skipProcessKill: true,
      liveRpcFn: async () => false,
    });

    assert.equal(statSync(mcpPath).mode & 0o777, 0o600);
    const finalMcp = JSON.parse(readFileSync(mcpPath, "utf8"));
    assert.deepEqual(finalMcp.mcpServers["computer-use"], userReplacement);
    assert.deepEqual(finalMcp.mcpServers["computer-use-js"], foreignReplEntry);
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test("Codex pass-2 verification: pinned Raise never relaunches quit app, early STALE_REF finalizes focus sweeps, missing postElement & unrelated frame changes never falsely verify set_value, and UI clears canvas on app switch", async () => {
  // #21 pass-2: Missing postElement must NOT match Value: "cat" from an unrelated field in readBackText
  const missingTargetObs = verifySetValueObservation({
    expectedValue: "cat",
    postElement: null,
    readBackText: '\t9 text field Value: "cat" ID: unrelated_field',
    isSecure: false,
  });
  assert.equal(missingTargetObs.verified, null);

  // #22 pass-2: Unrelated frame digest change (e.g. blinking caret/clock) must NOT verify secure field when directDeliveryVerified is false
  const reg = new AppSnapshotRegistry();
  const secMeta = parseSnapshotMetadata(
    [`App=com.example.Sec2 (pid ${process.pid})`, 'Window: "Login", App: Sec2.', "\t2 AXSecureTextField ID: pwd"].join("\n")
  );
  reg.recordMeta("com.example.Sec2", secMeta, { fromActionPeer: true, includeAx: true, includeScreenshot: true });
  const exec = new BackgroundActionExecutor({
    actionPeer: { async callTool() { return { isError: false, content: [] }; } },
    focusPolicyGuard: new FocusPolicyGuard(),
    registry: reg,
    postActionDelayMs: 0,
  });
  const secFrameChangedOut = await exec.verifyAndFormatReadBack({
    name: "set_value",
    cleanArgs: { app: "com.example.Sec2", element_index: "2", value: "topsecret" },
    parsedRef: { ok: true, hasElementRef: true, rawIndex: "2" },
    result: { isError: false, content: [{ type: "text", text: "ok" }] },
    actionRouteKey: "set_value:native",
    directDeliveryVerified: false,
    preAppKey: "com.example.Sec2",
    preSnapshot: reg.getLatestSnapshot("com.example.Sec2"),
    preElement: reg.getMeta("com.example.Sec2").elements.get("2"),
    preFrameDigest: "digest-before",
    readBackStateFn: async () => ({
      isError: false,
      content: [
        {
          type: "text",
          text: [`App=com.example.Sec2 (pid ${process.pid})`, 'Window: "Login", App: Sec2.', "\t2 AXSecureTextField ID: pwd"].join("\n"),
        },
        {
          type: "image",
          mimeType: "image/jpeg",
          data: Buffer.from("different-clock-pixels").toString("base64"),
        },
      ],
    }),
  });
  assert.equal(secFrameChangedOut.deliveryStatus, "delivered_unverified");
  assert.equal(secFrameChangedOut.verified, false);

  // #20 pass-2: UI clears displayedFrameApp on app switch and requires displayedFrameApp === currentAppIdentity() for canvas clicks
  const uiHtml = readFileSync(UI_HTML_PATH, "utf8");
  assert.match(uiHtml, /clearDisplayedCanvas/);
  assert.match(uiHtml, /requireRenderedFrame:\s*true/);

  // #6 & #7 pass-2:
  // 1) Pinned Raise (`@s1:1`) on an exited app returns STALE_REF without calling get_app_state or relaunching
  // 2) Stale click (`@s99:1`) that warms app state and returns early STALE_REF STILL finalizes focus sweep and reclaims delayed activation!
  const sock = path.join(tmpdir(), `cua-pass2-verify-${process.pid}-${Date.now()}.sock`);
  let appRunning = false;
  let stateCallsWhileQuit = 0;
  let frontApp = { pid: 901, bundleId: "com.google.antigravity", displayName: "Antigravity" };
  const restored = [];

  const peer = {
    async listTools() {
      return { tools: [{ name: "list_apps" }, { name: "get_app_state" }, { name: "click" }, { name: "perform_secondary_action" }] };
    },
    async callTool(name) {
      if (name === "list_apps") {
        return {
          isError: false,
          content: [
            {
              type: "text",
              text: appRunning
                ? `TargetApp — com.example.Pass2 [running]`
                : `Finder — com.apple.finder [running]`,
            },
          ],
        };
      }
      if (name === "get_app_state") {
        if (!appRunning) stateCallsWhileQuit += 1;
        return {
          isError: false,
          content: [
            {
              type: "text",
              text: [`App=com.example.Pass2 (pid ${process.pid})`, 'Window: "Main", App: TargetApp.', "\t1 button Go"].join("\n"),
            },
          ],
        };
      }
      return { isError: false, content: [{ type: "text", text: "ok" }] };
    },
    close() {},
  };

  const broker = new ComputerUseBrokerServer({
    webPort: 0,
    uiToken: "tok",
    socketPath: sock,
    actionPeer: peer,
    streamPeer: peer,
    focusController: {
      async getFrontmostApp() {
        return frontApp;
      },
      async restoreFrontmostApp(pid) {
        restored.push(pid);
        frontApp = { pid, bundleId: "com.google.antigravity", displayName: "Antigravity" };
        return true;
      },
      sweepDelaysMs: [35],
    },
  });
  await broker.start();
  const client = new BrokerRpcClient({ socketPath: sock, enableFallback: false });

  try {
    const pinnedRaiseOnQuit = await client.request("tools/call", {
      name: "perform_secondary_action",
      arguments: { app: "com.example.Pass2", element_index: "@s1:1", action: "Raise" },
    });
    assert.equal(pinnedRaiseOnQuit.isError, true);
    assert.match(pinnedRaiseOnQuit.content[0].text, /STALE_REF/);
    assert.equal(stateCallsWhileQuit, 0, "Pinned Raise on exited app must not warm/launch app");

    // Now app is running with cold cache; stale click `@s99:1` warms state and returns STALE_REF early,
    // then target app activates 15ms later -> sweep MUST reclaim focus!
    appRunning = true;
    const staleEarly = await client.request("tools/call", {
      name: "click",
      arguments: { app: "com.example.Pass2", element_index: "@s99:1" },
    });
    assert.equal(staleEarly.isError, true);
    assert.match(staleEarly.content[0].text, /STALE_REF/);

    frontApp = { pid: process.pid, bundleId: "com.example.Pass2", displayName: "TargetApp" };
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(restored.includes(901), true, "Early STALE_REF return after warm_state must finalize focus sweep");
  } finally {
    await client.close();
    await broker.close();
  }
});
