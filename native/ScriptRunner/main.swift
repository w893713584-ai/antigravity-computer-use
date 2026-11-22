import Dispatch
import Foundation

// 1. Minimal descriptors BEFORE Seatbelt: close all inherited FDs above stdin/stdout/stderr.
cua_close_extra_fds()

// 2. Parse explicit diagnostic probe arguments BEFORE entering Seatbelt (no env home reads needed inside probes if passed).
let args = CommandLine.arguments
let isSelfTestDenials = args.contains("--self-test-denials")
func argValue(_ flag: String) -> String? {
  guard let idx = args.firstIndex(of: flag), idx + 1 < args.count else { return nil }
  return args[idx + 1]
}
let probeHome = argValue("--probe-home")
let probeTmp = argValue("--probe-tmp")
let probeUds = argValue("--probe-uds")

// 3. Install OS resource limits (RLIMIT_CPU soft=2s, hard=3s; RLIMIT_CORE=0).
var rlimitErrno: Int32 = 0
guard cua_install_rlimits(2, 3, &rlimitErrno) else {
  let errLine = "{\"v\":1,\"type\":\"fatal\",\"error\":{\"code\":\"SANDBOX_UNAVAILABLE\",\"message\":\"setrlimit failed errno=\(rlimitErrno)\"}}\n"
  FileHandle.standardOutput.write(Data(errLine.utf8))
  exit(2)
}

// 4. Enter macOS Seatbelt `(deny default)` sandbox via signed embedded profile.
var sbErrBuf = [CChar](repeating: 0, count: 1024)
let entered = EmbeddedScriptAssets.strictSandboxProfile.withCString { profPtr in
  cua_enter_seatbelt(profPtr, &sbErrBuf, sbErrBuf.count)
}
guard entered else {
  let msg = String(cString: sbErrBuf)
  let safeMsg = msg.replacingOccurrences(of: "\"", with: "'")
  let errLine = "{\"v\":1,\"type\":\"fatal\",\"error\":{\"code\":\"SANDBOX_UNAVAILABLE\",\"message\":\"sandbox_init failed: \(safeMsg)\"}}\n"
  FileHandle.standardOutput.write(Data(errLine.utf8))
  exit(2)
}

// 5. Optional kernel denial self-test mode (runs inside active Seatbelt sandbox).
if isSelfTestDenials {
  var jsonBuf = [CChar](repeating: 0, count: 2048)
  let ok = cua_probe_denials(probeHome, probeTmp, probeUds, &jsonBuf, jsonBuf.count)
  let outStr = String(cString: jsonBuf) + "\n"
  FileHandle.standardOutput.write(Data(outStr.utf8))
  exit(ok ? 0 : 3)
}

// 6. Initialize hardened JavaScriptCore VM + run startup self-checks BEFORE emitting `ready`.
let runner = JscRunner()
let initRes = runner.initializeAndSelfCheck()
guard initRes.ok else {
  let errPayload: [String: Any] = [
    "v": 1,
    "type": "fatal",
    "error": [
      "code": "SANDBOX_UNAVAILABLE",
      "message": initRes.error ?? "JSC initialization failed",
    ],
  ]
  if let data = try? JSONSerialization.data(withJSONObject: errPayload, options: []) {
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
  }
  exit(2)
}

let readyMsg = "{\"v\":1,\"type\":\"ready\",\"profile\":\"strict-v1\"}\n"
FileHandle.standardOutput.write(Data(readyMsg.utf8))
runner.startStdinReader()
dispatchMain()
