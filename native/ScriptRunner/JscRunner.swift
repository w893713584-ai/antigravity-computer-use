import Dispatch
import Foundation
import JavaScriptCore

private let kCpuBudgetSeconds: Double = 2.0
private let kMaxLineBytes = 2 * 1024 * 1024

private weak var gActiveRunner: JscRunner?

private func jsStringToSwift(_ jsStr: JSStringRef) -> String {
  let maxLen = JSStringGetMaximumUTF8CStringSize(jsStr)
  if maxLen <= 1 { return "" }
  var buf = [CChar](repeating: 0, count: maxLen)
  let written = JSStringGetUTF8CString(jsStr, &buf, maxLen)
  if written <= 1 { return "" }
  return String(cString: buf)
}

private func valueToSwiftString(_ ctx: JSContextRef, _ value: JSValueRef?) -> String {
  guard let value else { return "" }
  var exc: JSValueRef?
  guard let jsStr = JSValueToStringCopy(ctx, value, &exc) else { return "" }
  defer { JSStringRelease(jsStr) }
  return jsStringToSwift(jsStr)
}

private func makeJsStringValue(_ ctx: JSContextRef, _ str: String) -> JSValueRef {
  let jsStr = str.withCString { JSStringCreateWithUTF8CString($0) }
  defer { JSStringRelease(jsStr) }
  return JSValueMakeString(ctx, jsStr)
}

private func formatJsException(_ ctx: JSContextRef, _ exc: JSValueRef?) -> (code: String, message: String) {
  guard let exc else { return ("JS_ERROR", "Unknown JavaScript error") }
  var code = "JS_ERROR"
  if let obj = JSValueToObject(ctx, exc, nil) {
    let nameKey = "name".withCString { JSStringCreateWithUTF8CString($0) }
    defer { JSStringRelease(nameKey) }
    var ignoreExc: JSValueRef?
    if let nameVal = JSObjectGetProperty(ctx, obj, nameKey, &ignoreExc) {
      let nameStr = valueToSwiftString(ctx, nameVal).trimmingCharacters(in: .whitespacesAndNewlines)
      if !nameStr.isEmpty && nameStr != "undefined" {
        code = nameStr
      }
    }
  }
  let msg = valueToSwiftString(ctx, exc)
  if msg.contains("Execution time limit exceeded") || msg.contains("terminated") {
    return ("CPU_TIME_LIMIT", msg.isEmpty ? "JavaScript CPU time limit exceeded" : msg)
  }
  return (code, msg.isEmpty ? "JavaScript exception" : msg)
}

private func writeNdjson(_ dict: [String: Any]) {
  guard JSONSerialization.isValidJSONObject(dict),
        let data = try? JSONSerialization.data(withJSONObject: dict, options: []),
        var line = String(data: data, encoding: .utf8)
  else {
    return
  }
  line.append("\n")
  if let outData = line.data(using: .utf8) {
    FileHandle.standardOutput.write(outData)
  }
}

private let hostRpcCallback: JSObjectCallAsFunctionCallback = { ctx, _, _, argumentCount, arguments, exception in
  guard let ctx, let runner = gActiveRunner else { return JSValueMakeUndefined(ctx) }
  guard argumentCount >= 1 else {
    exception?.pointee = makeJsStringValue(ctx, "host.rpc requires op name")
    return nil
  }
  let op = valueToSwiftString(ctx, arguments?[0])
  let argsJson = argumentCount >= 2 ? valueToSwiftString(ctx, arguments?[1]) : "{}"
  return runner.handleHostRpc(ctx: ctx, op: op, argsJson: argsJson, exception: exception)
}

private let hostEmitOutCallback: JSObjectCallAsFunctionCallback = { ctx, _, _, argumentCount, arguments, _ in
  guard let ctx, let runner = gActiveRunner, argumentCount >= 1 else { return JSValueMakeUndefined(ctx) }
  let itemJson = valueToSwiftString(ctx, arguments?[0])
  runner.handleEmitOut(itemJson: itemJson)
  return JSValueMakeUndefined(ctx)
}

private let hostScheduleTimerCallback: JSObjectCallAsFunctionCallback = { ctx, _, _, argumentCount, arguments, exception in
  guard let ctx, let runner = gActiveRunner, argumentCount >= 1 else { return JSValueMakeNumber(ctx, 0) }
  guard let fnObj = JSValueToObject(ctx, arguments?[0], exception) else { return JSValueMakeNumber(ctx, 0) }
  let delayMs = argumentCount >= 2 ? JSValueToNumber(ctx, arguments?[1], exception) : 0
  let id = runner.scheduleTimer(ctx: ctx, callback: fnObj, delayMs: delayMs)
  return JSValueMakeNumber(ctx, Double(id))
}

private let hostCancelTimerCallback: JSObjectCallAsFunctionCallback = { ctx, _, _, argumentCount, arguments, exception in
  guard let ctx, let runner = gActiveRunner, argumentCount >= 1 else { return JSValueMakeUndefined(ctx) }
  let id = Int(JSValueToNumber(ctx, arguments?[0], exception))
  runner.cancelTimer(ctx: ctx, id: id)
  return JSValueMakeUndefined(ctx)
}

private let onRunFulfillCallback: JSObjectCallAsFunctionCallback = { ctx, _, _, argumentCount, arguments, _ in
  guard let ctx, let runner = gActiveRunner else { return JSValueMakeUndefined(ctx) }
  let exportJson = argumentCount >= 1 ? valueToSwiftString(ctx, arguments?[0]) : "{}"
  runner.completeRunOk(exportJson: exportJson)
  return JSValueMakeUndefined(ctx)
}

private let onRunRejectCallback: JSObjectCallAsFunctionCallback = { ctx, _, _, argumentCount, arguments, _ in
  guard let ctx, let runner = gActiveRunner else { return JSValueMakeUndefined(ctx) }
  let errJson = argumentCount >= 1 ? valueToSwiftString(ctx, arguments?[0]) : "{}"
  runner.completeRunError(errJson: errJson)
  return JSValueMakeUndefined(ctx)
}

final class JscRunner {
  let jscQueue = DispatchQueue(label: "cua.script-runner.jsc")
  private var group: JSContextGroupRef!
  private var ctx: JSGlobalContextRef!
  private var evalDisabledMsg: JSStringRef!

  private var runnerHooksObj: JSObjectRef?
  private var activeRunId: String?
  private var runSettled = false
  private var nextCallId = 1
  private var nextTimerId = 1

  private struct PendingRpc {
    let resolveObj: JSObjectRef
    let rejectObj: JSObjectRef
  }
  private var pendingRpcs: [Int: PendingRpc] = [:]

  private struct ScheduledTimer {
    let source: DispatchSourceTimer
    let fnObj: JSObjectRef
  }
  private var timers: [Int: ScheduledTimer] = [:]

  init() {}

  func initializeAndSelfCheck() -> (ok: Bool, error: String?) {
    var result: (Bool, String?) = (false, "init failed")
    jscQueue.sync {
      gActiveRunner = self
      guard cua_jsc_spi_available() else {
        result = (false, "SANDBOX_UNAVAILABLE: required JavaScriptCore SPI symbols unavailable")
        return
      }
      guard let grp = JSContextGroupCreate() else {
        result = (false, "SANDBOX_UNAVAILABLE: JSContextGroupCreate failed")
        return
      }
      guard let globalCtx = JSGlobalContextCreateInGroup(grp, nil) else {
        JSContextGroupRelease(grp)
        result = (false, "SANDBOX_UNAVAILABLE: JSGlobalContextCreateInGroup failed")
        return
      }
      self.group = grp
      self.ctx = globalCtx
      self.evalDisabledMsg = "Dynamic code evaluation (eval/Function) is disabled in strict CUA sandbox".withCString {
        JSStringCreateWithUTF8CString($0)
      }

      installHostBridge()
      guard armCpuLimitOrFail() else {
        result = (false, "SANDBOX_UNAVAILABLE: CPU budget exhausted during startup")
        return
      }
      defer { cua_jsc_clear_cpu_limit(self.group) }

      if let acornErr = evalScriptExpectSuccess(EmbeddedScriptAssets.acornSource, url: "embedded://acorn.js") {
        result = (false, "SANDBOX_UNAVAILABLE: acorn load failed: \(acornErr)")
        return
      }

      var bootExc: JSValueRef?
      let bootScript = EmbeddedScriptAssets.bootstrapSource.withCString { JSStringCreateWithUTF8CString($0) }
      let bootUrl = "embedded://bootstrap.js".withCString { JSStringCreateWithUTF8CString($0) }
      defer {
        JSStringRelease(bootScript)
        JSStringRelease(bootUrl)
      }
      let bootVal = JSEvaluateScript(ctx, bootScript, nil, bootUrl, 1, &bootExc)
      if let bootExc {
        let (_, msg) = formatJsException(ctx, bootExc)
        result = (false, "SANDBOX_UNAVAILABLE: bootstrap failed: \(msg)")
        return
      }
      guard let hooks = JSValueToObject(ctx, bootVal, &bootExc) else {
        result = (false, "SANDBOX_UNAVAILABLE: bootstrap did not return host hooks")
        return
      }
      JSValueProtect(ctx, hooks)
      self.runnerHooksObj = hooks

      // Run mandatory JSC hardening startup self-checks BEFORE disabling eval so compiled checks test live eval/Function denial
      let selfCheckJs = """
      (function() {
        "use strict";
        if (typeof WebAssembly !== "undefined") {
          return "WebAssembly must be undefined when JSC_useWasm=false";
        }
        var formatted = new Intl.DateTimeFormat("zh-CN", { timeZone: "UTC" }).format(new Date(1700000000000));
        if (typeof formatted !== "string" || formatted.length === 0) {
          return "Intl check failed";
        }
        if ("中文测试".length !== 4 || typeof Promise.resolve(1).then !== "function") {
          return "CJK/Promise check failed";
        }
        return "OK";
      })();
      """
      var scExc: JSValueRef?
      let scJsStr = selfCheckJs.withCString { JSStringCreateWithUTF8CString($0) }
      defer { JSStringRelease(scJsStr) }
      let scVal = JSEvaluateScript(ctx, scJsStr, nil, nil, 1, &scExc)
      if scExc != nil || valueToSwiftString(ctx, scVal) != "OK" {
        result = (false, "SANDBOX_UNAVAILABLE: startup self-check failed: \(valueToSwiftString(ctx, scExc)) \(valueToSwiftString(ctx, scVal))")
        return
      }

      // Prepare compiled probes that call eval(...) and Function(...) to verify JSGlobalContextSetEvalEnabled(false) blocks both
      let evalProbeSrc = "(function() { try { eval('1+1'); return 'NOT_BLOCKED'; } catch (e) { return 'BLOCKED:' + e.message; } })"
      let fnProbeSrc = "(function() { try { return (new Function('return 1'))(); } catch (e) { return 'BLOCKED:' + e.message; } })"
      guard let evalProbeFn = compileFunction(evalProbeSrc), let fnProbeFn = compileFunction(fnProbeSrc) else {
        result = (false, "SANDBOX_UNAVAILABLE: failed to compile eval/Function security probes")
        return
      }

      // Lock down dynamic code generation NOW
      cua_jsc_set_eval_enabled(ctx, false, evalDisabledMsg)

      var pExc: JSValueRef?
      let evalProbeRes = JSObjectCallAsFunction(ctx, evalProbeFn, nil, 0, nil, &pExc)
      let fnProbeRes = JSObjectCallAsFunction(ctx, fnProbeFn, nil, 0, nil, &pExc)
      let evalOut = valueToSwiftString(ctx, evalProbeRes)
      let fnOut = valueToSwiftString(ctx, fnProbeRes)
      if !evalOut.hasPrefix("BLOCKED:") || !fnOut.hasPrefix("BLOCKED:") {
        result = (false, "SANDBOX_UNAVAILABLE: JSGlobalContextSetEvalEnabled(false) failed to block eval/Function (eval=\(evalOut), fn=\(fnOut))")
        return
      }

      result = (true, nil)
    }
    return result
  }

  private func compileFunction(_ source: String) -> JSObjectRef? {
    let s = source.withCString { JSStringCreateWithUTF8CString($0) }
    defer { JSStringRelease(s) }
    var exc: JSValueRef?
    guard let val = JSEvaluateScript(ctx, s, nil, nil, 1, &exc), exc == nil else { return nil }
    return JSValueToObject(ctx, val, nil)
  }

  private func evalScriptExpectSuccess(_ source: String, url: String) -> String? {
    let s = source.withCString { JSStringCreateWithUTF8CString($0) }
    let u = url.withCString { JSStringCreateWithUTF8CString($0) }
    defer {
      JSStringRelease(s)
      JSStringRelease(u)
    }
    var exc: JSValueRef?
    _ = JSEvaluateScript(ctx, s, nil, u, 1, &exc)
    if let exc {
      return formatJsException(ctx, exc).message
    }
    return nil
  }

  private func installHostBridge() {
    let globalObj = JSContextGetGlobalObject(ctx)
    let bridge = JSObjectMake(ctx, nil, nil)

    func setMethod(_ obj: JSObjectRef?, _ name: String, _ cb: @escaping JSObjectCallAsFunctionCallback) {
      let n = name.withCString { JSStringCreateWithUTF8CString($0) }
      defer { JSStringRelease(n) }
      let fn = JSObjectMakeFunctionWithCallback(ctx, n, cb)
      var exc: JSValueRef?
      JSObjectSetProperty(ctx, obj, n, fn, JSPropertyAttributes(kJSPropertyAttributeNone), &exc)
    }

    setMethod(bridge, "rpc", hostRpcCallback)
    setMethod(bridge, "emitOut", hostEmitOutCallback)
    setMethod(bridge, "scheduleTimer", hostScheduleTimerCallback)
    setMethod(bridge, "cancelTimer", hostCancelTimerCallback)

    let hostKey = "__cuaHost".withCString { JSStringCreateWithUTF8CString($0) }
    defer { JSStringRelease(hostKey) }
    var exc: JSValueRef?
    JSObjectSetProperty(ctx, globalObj, hostKey, bridge, JSPropertyAttributes(kJSPropertyAttributeNone), &exc)
  }

  @discardableResult
  private func armCpuLimitOrFail() -> Bool {
    let used = cua_process_cpu_seconds()
    if used >= kCpuBudgetSeconds {
      return false
    }
    cua_jsc_set_cpu_limit(group, max(0.05, kCpuBudgetSeconds - used))
    return true
  }

  func startStdinReader() {
    let readQueue = DispatchQueue(label: "cua.script-runner.stdin")
    readQueue.async { [weak self] in
      var buffer = Data()
      let stdinFd = FileHandle.standardInput
      while true {
        let chunk = stdinFd.availableData
        if chunk.isEmpty {
          // EOF
          self?.jscQueue.async {
            if self?.activeRunId != nil && !(self?.runSettled ?? true) {
              self?.finishWithError(code: "STDIN_CLOSED", message: "Broker closed stdin during run")
            }
            exit(0)
          }
          break
        }
        buffer.append(chunk)
        if buffer.count > kMaxLineBytes {
          self?.jscQueue.async {
            self?.finishWithError(code: "LINE_TOO_LARGE", message: "Broker NDJSON message exceeded 2 MiB limit")
            exit(1)
          }
          break
        }
        while let nlRange = buffer.firstRange(of: Data([0x0A])) {
          let lineData = buffer.subdata(in: 0..<nlRange.lowerBound)
          buffer.removeSubrange(0..<nlRange.upperBound)
          if lineData.isEmpty { continue }
          guard let msg = try? JSONSerialization.jsonObject(with: lineData, options: []) as? [String: Any] else {
            continue
          }
          self?.jscQueue.async {
            self?.handleBrokerMessage(msg)
          }
        }
      }
    }
  }

  private func handleBrokerMessage(_ msg: [String: Any]) {
    guard let type = msg["type"] as? String else { return }
    if type == "run" {
      handleRunMessage(msg)
    } else if type == "reply" {
      handleReplyMessage(msg)
    }
  }

  private func getHookFn(_ name: String) -> JSObjectRef? {
    guard let hooks = runnerHooksObj else { return nil }
    let k = name.withCString { JSStringCreateWithUTF8CString($0) }
    defer { JSStringRelease(k) }
    var exc: JSValueRef?
    guard let val = JSObjectGetProperty(ctx, hooks, k, &exc), exc == nil else { return nil }
    return JSValueToObject(ctx, val, nil)
  }

  private func handleRunMessage(_ msg: [String: Any]) {
    guard activeRunId == nil else { return }
    let runId = (msg["runId"] as? String) ?? "run-1"
    activeRunId = runId
    runSettled = false

    let code = (msg["code"] as? String) ?? ""
    let bindingsObj = msg["bindings"] ?? []
    let sessionObj = msg["session"] ?? [:]
    let reqMetaObj = msg["requestMeta"] ?? [:]

    let bindingsJson = encodeJsonString(bindingsObj) ?? "[]"
    let sessionJson = encodeJsonString(sessionObj) ?? "{}"
    let reqMetaJson = encodeJsonString(reqMetaObj) ?? "{}"

    guard armCpuLimitOrFail() else {
      finishWithError(code: "CPU_TIME_LIMIT", message: "CPU budget exceeded")
      exit(0)
    }

    guard let prepareFn = getHookFn("prepareRunPayload"),
          let importFn = getHookFn("importValForRun"),
          let commitFn = getHookFn("commitCapturedBindings"),
          let attachFn = getHookFn("attachPromiseCallbacks")
    else {
      cua_jsc_clear_cpu_limit(group)
      finishWithError(code: "SANDBOX_UNAVAILABLE", message: "Runner internal hooks missing")
      exit(1)
    }

    // Step 1: Parse & validate AST via Acorn (EvalEnabled stays false)
    var prepArgs: [JSValueRef?] = [
      makeJsStringValue(ctx, code),
      makeJsStringValue(ctx, bindingsJson),
      makeJsStringValue(ctx, sessionJson),
      makeJsStringValue(ctx, reqMetaJson),
    ]
    var prepExc: JSValueRef?
    let factorySrcVal = JSObjectCallAsFunction(ctx, prepareFn, nil, prepArgs.count, &prepArgs, &prepExc)
    if let prepExc {
      cua_jsc_clear_cpu_limit(group)
      let (errCode, errMsg) = formatJsException(ctx, prepExc)
      finishWithError(code: errCode, message: errMsg)
      exit(0)
    }
    let factorySource = valueToSwiftString(ctx, factorySrcVal)

    // Step 2: Briefly enable JSEvaluateScript ONLY to parse/build the wrapper factory closure, NEVER run user code with eval enabled!
    cua_jsc_set_eval_enabled(ctx, true, nil)
    let factoryJsStr = factorySource.withCString { JSStringCreateWithUTF8CString($0) }
    let userUrlStr = "user-repl://chunk".withCString { JSStringCreateWithUTF8CString($0) }
    var compExc: JSValueRef?
    let factoryVal = JSEvaluateScript(ctx, factoryJsStr, nil, userUrlStr, 1, &compExc)
    JSStringRelease(factoryJsStr)
    JSStringRelease(userUrlStr)
    cua_jsc_set_eval_enabled(ctx, false, evalDisabledMsg)

    if let compExc {
      cua_jsc_clear_cpu_limit(group)
      let (errCode, errMsg) = formatJsException(ctx, compExc)
      finishWithError(code: errCode, message: errMsg)
      exit(0)
    }
    guard let factoryObj = JSValueToObject(ctx, factoryVal, &compExc) else {
      cua_jsc_clear_cpu_limit(group)
      finishWithError(code: "SyntaxError", message: "Failed to build wrapper function")
      exit(0)
    }

    // Step 3: Call factory to bind `const`/`let` imports and obtain async user function
    var fArgs: [JSValueRef?] = [importFn, commitFn]
    var fExc: JSValueRef?
    let asyncFnVal = JSObjectCallAsFunction(ctx, factoryObj, nil, 2, &fArgs, &fExc)
    if let fExc {
      cua_jsc_clear_cpu_limit(group)
      let (errCode, errMsg) = formatJsException(ctx, fExc)
      finishWithError(code: errCode, message: errMsg)
      exit(0)
    }
    guard let asyncFnObj = JSValueToObject(ctx, asyncFnVal, &fExc) else {
      cua_jsc_clear_cpu_limit(group)
      finishWithError(code: "JS_ERROR", message: "Wrapper did not yield async function")
      exit(0)
    }

    // Step 4: Invoke async user function with eval DISABLED & CPU limit ARMED
    var runExc: JSValueRef?
    let promiseVal = JSObjectCallAsFunction(ctx, asyncFnObj, nil, 0, nil, &runExc)
    if let runExc {
      cua_jsc_clear_cpu_limit(group)
      let (errCode, errMsg) = formatJsException(ctx, runExc)
      finishWithError(code: errCode, message: errMsg)
      exit(0)
    }

    let okCbName = "onOk".withCString { JSStringCreateWithUTF8CString($0) }
    let errCbName = "onErr".withCString { JSStringCreateWithUTF8CString($0) }
    let okCb = JSObjectMakeFunctionWithCallback(ctx, okCbName, onRunFulfillCallback)
    let errCb = JSObjectMakeFunctionWithCallback(ctx, errCbName, onRunRejectCallback)
    JSStringRelease(okCbName)
    JSStringRelease(errCbName)

    var attachArgs: [JSValueRef?] = [promiseVal, okCb, errCb]
    var attachExc: JSValueRef?
    _ = JSObjectCallAsFunction(ctx, attachFn, nil, 3, &attachArgs, &attachExc)
    cua_jsc_clear_cpu_limit(group)
    if let attachExc {
      let (errCode, errMsg) = formatJsException(ctx, attachExc)
      finishWithError(code: errCode, message: errMsg)
      exit(0)
    }
  }

  func handleHostRpc(ctx: JSContextRef, op: String, argsJson: String, exception: UnsafeMutablePointer<JSValueRef?>?) -> JSValueRef? {
    guard let runId = activeRunId, !runSettled else {
      exception?.pointee = makeJsStringValue(ctx, "No active run")
      return nil
    }
    var resolveObj: JSObjectRef?
    var rejectObj: JSObjectRef?
    guard let promise = JSObjectMakeDeferredPromise(ctx, &resolveObj, &rejectObj, exception),
          let resFn = resolveObj,
          let rejFn = rejectObj
    else {
      return nil
    }
    let callId = nextCallId
    nextCallId += 1
    JSValueProtect(ctx, resFn)
    JSValueProtect(ctx, rejFn)
    pendingRpcs[callId] = PendingRpc(resolveObj: resFn, rejectObj: rejFn)

    var argsObj: Any = [:]
    if let d = argsJson.data(using: .utf8),
       let parsed = try? JSONSerialization.jsonObject(with: d, options: []) {
      argsObj = parsed
    }
    writeNdjson([
      "v": 1,
      "type": "call",
      "runId": runId,
      "id": callId,
      "op": op,
      "args": argsObj,
    ])
    return promise
  }

  private func handleReplyMessage(_ msg: [String: Any]) {
    guard !runSettled,
          let msgRunId = msg["runId"] as? String,
          msgRunId == activeRunId,
          let callId = msg["id"] as? Int,
          let entry = pendingRpcs.removeValue(forKey: callId)
    else {
      return
    }
    defer {
      JSValueUnprotect(ctx, entry.resolveObj)
      JSValueUnprotect(ctx, entry.rejectObj)
    }

    guard armCpuLimitOrFail() else {
      finishWithError(code: "CPU_TIME_LIMIT", message: "JavaScript CPU time limit exceeded")
      exit(0)
    }
    defer { cua_jsc_clear_cpu_limit(group) }

    let ok = (msg["ok"] as? Bool) ?? false
    if ok {
      let valJson = encodeJsonString(msg["value"] ?? NSNull()) ?? "null"
      var arg: JSValueRef? = makeJsStringValue(ctx, valJson)
      var exc: JSValueRef?
      _ = JSObjectCallAsFunction(ctx, entry.resolveObj, nil, 1, &arg, &exc)
      if let exc {
        let (code, errMsg) = formatJsException(ctx, exc)
        finishWithError(code: code, message: errMsg)
        exit(0)
      }
    } else {
      let errDict = msg["error"] as? [String: Any]
      let errMsg = (errDict?["message"] as? String) ?? "RPC call failed"
      var msgArg: JSValueRef? = makeJsStringValue(ctx, errMsg)
      var exc: JSValueRef?
      let errObj = JSObjectMakeError(ctx, 1, &msgArg, &exc)
      if let code = errDict?["code"] as? String {
        let codeKey = "code".withCString { JSStringCreateWithUTF8CString($0) }
        JSObjectSetProperty(ctx, errObj, codeKey, makeJsStringValue(ctx, code), JSPropertyAttributes(kJSPropertyAttributeNone), &exc)
        JSStringRelease(codeKey)
      }
      var rejArg: JSValueRef? = errObj
      _ = JSObjectCallAsFunction(ctx, entry.rejectObj, nil, 1, &rejArg, &exc)
      if let exc {
        let (code, fMsg) = formatJsException(ctx, exc)
        finishWithError(code: code, message: fMsg)
        exit(0)
      }
    }
  }

  func handleEmitOut(itemJson: String) {
    guard let runId = activeRunId, !runSettled,
          let data = itemJson.data(using: .utf8),
          let parsed = try? JSONSerialization.jsonObject(with: data, options: [])
    else { return }
    writeNdjson([
      "v": 1,
      "type": "out",
      "runId": runId,
      "item": parsed,
    ])
  }

  func scheduleTimer(ctx: JSContextRef, callback: JSObjectRef, delayMs: Double) -> Int {
    guard !runSettled else { return 0 }
    let id = nextTimerId
    nextTimerId += 1
    JSValueProtect(ctx, callback)
    let clampedMs = max(0, Int(delayMs.rounded()))
    let timer = DispatchSource.makeTimerSource(queue: jscQueue)
    timer.schedule(deadline: .now() + .milliseconds(clampedMs))
    timer.setEventHandler { [weak self] in
      guard let self, let entry = self.timers.removeValue(forKey: id) else { return }
      entry.source.cancel()
      defer { JSValueUnprotect(self.ctx, entry.fnObj) }
      guard !self.runSettled else { return }
      guard self.armCpuLimitOrFail() else {
        self.finishWithError(code: "CPU_TIME_LIMIT", message: "JavaScript CPU time limit exceeded")
        exit(0)
      }
      defer { cua_jsc_clear_cpu_limit(self.group) }
      var exc: JSValueRef?
      _ = JSObjectCallAsFunction(self.ctx, entry.fnObj, nil, 0, nil, &exc)
      if let exc {
        let (code, errMsg) = formatJsException(self.ctx, exc)
        self.finishWithError(code: code, message: errMsg)
        exit(0)
      }
    }
    timers[id] = ScheduledTimer(source: timer, fnObj: callback)
    timer.resume()
    return id
  }

  func cancelTimer(ctx: JSContextRef, id: Int) {
    guard let entry = timers.removeValue(forKey: id) else { return }
    entry.source.cancel()
    JSValueUnprotect(ctx, entry.fnObj)
  }

  private func cleanupTimersAndRpcs() {
    for (_, t) in timers {
      t.source.cancel()
      JSValueUnprotect(ctx, t.fnObj)
    }
    timers.removeAll()
    for (_, rpc) in pendingRpcs {
      JSValueUnprotect(ctx, rpc.resolveObj)
      JSValueUnprotect(ctx, rpc.rejectObj)
    }
    pendingRpcs.removeAll()
  }

  func completeRunOk(exportJson: String) {
    guard let runId = activeRunId, !runSettled else { return }
    runSettled = true
    cleanupTimersAndRpcs()

    var bindingsOut: Any = []
    var sessionOut: Any = [:]
    if let data = exportJson.data(using: .utf8),
       let parsed = try? JSONSerialization.jsonObject(with: data, options: []) as? [String: Any] {
      if let b = parsed["bindings"] { bindingsOut = b }
      if let s = parsed["session"] { sessionOut = s }
    }

    writeNdjson([
      "v": 1,
      "type": "done",
      "runId": runId,
      "ok": true,
      "bindings": bindingsOut,
      "session": sessionOut,
    ])
    exit(0)
  }

  func completeRunError(errJson: String) {
    var code = "JS_ERROR"
    var message = "Script failed"
    if let data = errJson.data(using: .utf8),
       let parsed = try? JSONSerialization.jsonObject(with: data, options: []) as? [String: Any] {
      if let c = parsed["code"] as? String { code = c }
      if let m = parsed["message"] as? String { message = m }
    }
    finishWithError(code: code, message: message)
    exit(0)
  }

  private func finishWithError(code: String, message: String) {
    guard let runId = activeRunId, !runSettled else { return }
    runSettled = true
    cleanupTimersAndRpcs()
    writeNdjson([
      "v": 1,
      "type": "done",
      "runId": runId,
      "ok": false,
      "error": [
        "code": code,
        "message": message,
      ],
    ])
  }

  private func encodeJsonString(_ value: Any) -> String? {
    if JSONSerialization.isValidJSONObject(value),
       let data = try? JSONSerialization.data(withJSONObject: value, options: []),
       let str = String(data: data, encoding: .utf8) {
      return str
    }
    if value is NSNull { return "null" }
    if let b = value as? Bool { return b ? "true" : "false" }
    if let n = value as? NSNumber { return n.stringValue }
    if let s = value as? String {
      if let data = try? JSONSerialization.data(withJSONObject: [s], options: []),
         let wrapped = String(data: data, encoding: .utf8),
         wrapped.count >= 2 {
        return String(wrapped.dropFirst().dropLast())
      }
    }
    return nil
  }
}
