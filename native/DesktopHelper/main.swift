import AppKit
import CoreVideo
import Foundation

private func runEncoderSelfTestAndExit() -> Never {
  var pbOut: CVPixelBuffer?
  let attrs: [String: Any] = [
    kCVPixelBufferIOSurfacePropertiesKey as String: [:],
  ]
  let pbStatus = CVPixelBufferCreate(
    kCFAllocatorDefault,
    640,
    360,
    kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
    attrs as CFDictionary,
    &pbOut
  )
  guard pbStatus == kCVReturnSuccess, let pixelBuffer = pbOut else {
    print("{\"ok\":false,\"error\":\"pixel_buffer_create_failed:\\(pbStatus)\"}")
    exit(1)
  }

  let sem = DispatchSemaphore(value: 0)
  let lock = NSLock()
  var gotConfig: [String: Any]?
  var gotIdr = false
  var gotAuBytes = 0
  var gotError: String?

  let encoder = H264HardwareEncoder(
    streamId: 1,
    onConfig: { _, _, cfg in
      lock.lock()
      gotConfig = cfg
      let ready = (gotConfig != nil && gotAuBytes > 0) || gotError != nil
      lock.unlock()
      if ready { sem.signal() }
    },
    onAccessUnit: { _, _, isIdr, _, _, data in
      lock.lock()
      if isIdr { gotIdr = true }
      gotAuBytes = data.count
      let ready = (gotConfig != nil && gotAuBytes > 0) || gotError != nil
      lock.unlock()
      if ready { sem.signal() }
    },
    onError: { code, message in
      lock.lock()
      gotError = "\(code):\(message)"
      lock.unlock()
      sem.signal()
    }
  )

  if case .failure(let err) = encoder.configure(width: 640, height: 360) {
    encoder.invalidate()
    let safeErr = err.localizedDescription.replacingOccurrences(of: "\"", with: "'")
    print("{\"ok\":false,\"error\":\"\(safeErr)\"}")
    exit(1)
  }

  let submitted = encoder.encode(
    pixelBuffer: pixelBuffer,
    ptsUs: 1_000,
    durationUs: 50_000,
    forceKeyframe: true,
    codedWidth: 640,
    codedHeight: 360,
    displayWidth: 640,
    displayHeight: 360,
    contentRectPt: ["x": 0.0, "y": 0.0, "width": 640.0, "height": 360.0],
    geometryChanged: false,
    targetKey: "v1|1||1|1",
    geometryRev: 1,
    dropIfBusy: false
  )
  if !submitted {
    encoder.invalidate()
    print("{\"ok\":false,\"error\":\"encode_submit_failed\"}")
    exit(1)
  }

  _ = sem.wait(timeout: .now() + 2.0)
  encoder.invalidate()

  lock.lock()
  let cfgCopy = gotConfig
  let idrCopy = gotIdr
  let auLenCopy = gotAuBytes
  let errCopy = gotError
  lock.unlock()

  guard errCopy == nil,
        let cfgCopy,
        let codec = cfgCopy["codec"] as? String,
        let avcC = cfgCopy["avcC"] as? String,
        auLenCopy > 0 else {
    let safeErr = (errCopy ?? "encoder_self_test_incomplete").replacingOccurrences(of: "\"", with: "'")
    print("{\"ok\":false,\"error\":\"\(safeErr)\"}")
    exit(1)
  }

  let report: [String: Any] = [
    "ok": true,
    "codec": codec,
    "avcCLen": avcC.count,
    "auBytes": auLenCopy,
    "isIdr": idrCopy,
  ]
  if let jsonData = try? JSONSerialization.data(withJSONObject: report, options: []),
     let jsonStr = String(data: jsonData, encoding: .utf8) {
    print(jsonStr)
  } else {
    print("{\"ok\":true,\"isIdr\":\(idrCopy),\"auBytes\":\(auLenCopy)}")
  }
  exit(0)
}

if CommandLine.arguments.contains("--self-test-encoder") {
  runEncoderSelfTestAndExit()
}

private func parseRendezvousArg() -> String? {
  let args = CommandLine.arguments
  for idx in 0..<args.count {
    if args[idx] == "--rendezvous", idx + 1 < args.count {
      return args[idx + 1]
    }
  }
  return ProcessInfo.processInfo.environment["AGY_CUA_HELPER_RENDEZVOUS"]
}

guard let rendezvousPath = parseRendezvousArg(), !rendezvousPath.isEmpty else {
  fputs("[CUADesktopHelper] missing --rendezvous <path>\n", stderr)
  exit(2)
}

guard let data = try? Data(contentsOf: URL(fileURLWithPath: rendezvousPath)),
      let config = try? JSONDecoder().decode(RendezvousConfig.self, from: data) else {
  fputs("[CUADesktopHelper] failed to load rendezvous file at \(rendezvousPath)\n", stderr)
  exit(3)
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)

let controller = DesktopHelperController(config: config)
controller.start()

signal(SIGTERM) { _ in exit(0) }
signal(SIGINT) { _ in exit(0) }

app.run()
