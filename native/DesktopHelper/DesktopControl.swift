import AppKit
import CoreGraphics
import Darwin
import Foundation

struct RendezvousConfig: Decodable {
  let controlSocket: String
  let videoSocket: String?
  let brokerBootId: String
  let authToken: String
  let syntheticTag: Int64?
  let emergencyHotkey: String?
  let trustedPids: [Int32]?
}

final class UnixControlClient {
  private let socketPath: String
  private var fd: Int32 = -1
  private let writeQueue = DispatchQueue(label: "io.codexstyle.cua.desktophelper.write")
  private var readSource: DispatchSourceRead?
  private var readBuffer = Data()
  private let onMessage: ([String: Any]) -> Void
  private let onDisconnect: () -> Void

  init(
    socketPath: String,
    onMessage: @escaping ([String: Any]) -> Void,
    onDisconnect: @escaping () -> Void
  ) {
    self.socketPath = socketPath
    self.onMessage = onMessage
    self.onDisconnect = onDisconnect
  }

  func connect() -> Bool {
    let sock = connectUnixStreamSocket(path: socketPath)
    guard sock >= 0 else { return false }

    // Non-blocking read for DispatchSource
    let flags = fcntl(sock, F_GETFL, 0)
    if flags >= 0 {
      _ = fcntl(sock, F_SETFL, flags | O_NONBLOCK)
    }
    self.fd = sock

    let src = DispatchSource.makeReadSource(fileDescriptor: sock, queue: DispatchQueue.global(qos: .userInitiated))
    src.setEventHandler { [weak self] in
      self?.drainReadable()
    }
    src.setCancelHandler { [weak self] in
      self?.closeFd()
    }
    src.resume()
    self.readSource = src
    return true
  }

  func sendJson(_ obj: Any) {
    guard JSONSerialization.isValidJSONObject(obj),
          let data = try? JSONSerialization.data(withJSONObject: obj, options: []),
          var line = String(data: data, encoding: .utf8) else {
      return
    }
    line.append("\n")
    let outData = Data(line.utf8)
    writeQueue.async { [weak self] in
      guard let self, self.fd >= 0 else { return }
      outData.withUnsafeBytes { rawBuf in
        guard let base = rawBuf.baseAddress else { return }
        var sent = 0
        while sent < outData.count {
          let n = Darwin.write(self.fd, base.advanced(by: sent), outData.count - sent)
          if n > 0 {
            sent += n
          } else if errno == EINTR || errno == EAGAIN {
            usleep(1000)
          } else {
            DispatchQueue.main.async { self.onDisconnect() }
            return
          }
        }
      }
    }
  }

  private func drainReadable() {
    guard fd >= 0 else { return }
    var buf = [UInt8](repeating: 0, count: 65536)
    while true {
      let n = Darwin.read(fd, &buf, buf.count)
      if n > 0 {
        readBuffer.append(contentsOf: buf[0..<n])
        if readBuffer.count > 4 * 1024 * 1024 {
          readBuffer.removeAll()
          onDisconnect()
          return
        }
        extractLines()
      } else if n == 0 {
        DispatchQueue.main.async { self.onDisconnect() }
        return
      } else {
        if errno == EAGAIN || errno == EWOULDBLOCK {
          return
        }
        DispatchQueue.main.async { self.onDisconnect() }
        return
      }
    }
  }

  private func extractLines() {
    while let nlIdx = readBuffer.firstIndex(of: 0x0A) {
      let lineData = readBuffer.subdata(in: 0..<nlIdx)
      readBuffer.removeSubrange(0...nlIdx)
      if lineData.isEmpty { continue }
      guard let parsed = try? JSONSerialization.jsonObject(with: lineData, options: []),
            let dict = parsed as? [String: Any] else {
        continue
      }
      onMessage(dict)
    }
  }

  private func closeFd() {
    if fd >= 0 {
      Darwin.close(fd)
      fd = -1
    }
  }

  func close() {
    readSource?.cancel()
    readSource = nil
    closeFd()
  }
}

final class DesktopHelperController {
  private let config: RendezvousConfig
  private let bundleId: String
  private var client: UnixControlClient?
  private var videoClient: UnixVideoClient?
  private var captureManager: CaptureSessionManager?
  private var sensor: TakeoverSensor?

  init(config: RendezvousConfig) {
    self.config = config
    self.bundleId = Bundle.main.bundleIdentifier ?? "io.codexstyle.cua.desktop-helper"
  }

  func start() {
    let client = UnixControlClient(
      socketPath: config.controlSocket,
      onMessage: { [weak self] msg in self?.handleMessage(msg) },
      onDisconnect: { [weak self] in self?.shutdownAndExit(code: 0) }
    )
    guard client.connect() else {
      fputs("[CUADesktopHelper] failed to connect control socket\n", stderr)
      exit(1)
    }
    self.client = client

    if let videoSock = config.videoSocket, !videoSock.isEmpty {
      let vc = UnixVideoClient(
        socketPath: videoSock,
        onDisconnect: { [weak self] in
          self?.captureManager?.stopAll()
        }
      )
      if vc.connect(authToken: config.authToken, brokerBootId: config.brokerBootId) {
        self.videoClient = vc
        self.captureManager = CaptureSessionManager(
          videoClient: vc,
          onStatusNotification: { [weak self] status in self?.emitStreamStatus(status) }
        )
      }
    }

    let sensor = TakeoverSensor(
      syntheticTag: config.syntheticTag ?? 0,
      emergencyHotkey: config.emergencyHotkey,
      trustedPids: config.trustedPids ?? [],
      onSensorEvent: { [weak self] evt in self?.emitSensorEvent(evt) },
      onCapabilitiesChanged: { [weak self] caps in self?.emitCapabilities(caps) }
    )
    self.sensor = sensor

    // Always send authenticated `hello` BEFORE starting taps so initial `capabilities` /
    // `takeoverEvent` frames never precede the handshake on the Unix socket.
    let capsDict = encodeToJsonObject(sensor.currentCapabilities()) ?? [:]
    client.sendJson([
      "v": 1,
      "type": "hello",
      "authToken": config.authToken,
      "brokerBootId": config.brokerBootId,
      "pid": ProcessInfo.processInfo.processIdentifier,
      "bundleId": bundleId,
      "videoConnected": videoClient?.isConnected ?? false,
      "capabilities": capsDict,
    ])

    sensor.start()
  }

  private func emitStreamStatus(_ status: [String: Any]) {
    client?.sendJson([
      "v": 1,
      "type": "streamStatus",
      "status": status,
    ])
  }

  private func emitSensorEvent(_ evt: SensorEventPayload) {
    guard let payload = encodeToJsonObject(evt) else { return }
    client?.sendJson([
      "v": 1,
      "type": "takeoverEvent",
      "event": payload,
    ])
  }

  private func emitCapabilities(_ caps: HelperCapabilities) {
    guard let payload = encodeToJsonObject(caps) else { return }
    client?.sendJson([
      "v": 1,
      "type": "capabilities",
      "capabilities": payload,
    ])
  }

  private func handleMessage(_ msg: [String: Any]) {
    let id = msg["id"]
    guard let op = msg["op"] as? String else { return }
    let params = (msg["params"] as? [String: Any]) ?? [:]

    func replyOk(_ result: [String: Any]) {
      var packet: [String: Any] = ["v": 1, "type": "reply", "ok": true, "result": result]
      if let id { packet["id"] = id }
      client?.sendJson(packet)
    }

    func replyErr(_ code: String, _ message: String) {
      var packet: [String: Any] = [
        "v": 1,
        "type": "reply",
        "ok": false,
        "error": ["code": code, "message": message],
      ]
      if let id { packet["id"] = id }
      client?.sendJson(packet)
    }

    switch op {
    case "ping":
      replyOk([
        "pong": true,
        "pid": ProcessInfo.processInfo.processIdentifier,
        "ts": Int64(Date().timeIntervalSince1970 * 1000),
      ])

    case "probe":
      let caps = sensor?.currentCapabilities()
      replyOk([
        "pid": ProcessInfo.processInfo.processIdentifier,
        "bundleId": bundleId,
        "capabilities": caps.flatMap(encodeToJsonObject) ?? [:],
      ])

    case "listWindows":
      let filterPid = (params["pid"] as? NSNumber)?.int32Value
      let wins = WindowInventory.listWindows(filterPid: filterPid)
      let arr = wins.compactMap(encodeToJsonObject)
      replyOk(["windows": arr])

    case "setTakeoverTargets":
      let targets = (params["targets"] as? [[String: Any]]) ?? []
      if let trustedRaw = params["trustedPids"] as? [NSNumber] {
        sensor?.setTrustedAutomationPids(trustedRaw.map { $0.int32Value })
      }
      replyOk(["count": targets.count])

    case "setEmergencyHotkey":
      let spec = params["hotkey"] as? String
      let valid = sensor?.setEmergencyHotkey(spec) ?? false
      replyOk(["valid": valid])

    case "resetTakeoverLatch":
      sensor?.resetLatch()
      replyOk(["reset": true])

    case "requestPermission":
      let kind = (params["kind"] as? String) ?? ""
      if kind == "screenRecording" {
        let granted = CGRequestScreenCaptureAccess()
        replyOk([
          "kind": kind,
          "granted": granted,
          "capabilities": sensor.flatMap { encodeToJsonObject($0.currentCapabilities()) } ?? [:],
        ])
      } else if kind == "inputMonitoring" {
        let granted = CGRequestListenEventAccess()
        if granted {
          sensor?.refreshTaps()
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { [weak self] in
          guard let self else { return }
          replyOk([
            "kind": kind,
            "granted": granted,
            "capabilities": self.sensor.flatMap { encodeToJsonObject($0.currentCapabilities()) } ?? [:],
          ])
        }
      } else {
        replyErr("INVALID_ARGS", "Unknown permission kind: \(kind)")
      }

    case "start", "startStream":
      guard let captureManager else {
        replyErr("VIDEO_UNAVAILABLE", "Video channel not connected")
        return
      }
      let pid = (params["pid"] as? NSNumber)?.int32Value ?? 0
      let processToken = params["processToken"] as? String
      let windowId = (params["windowId"] as? NSNumber)?.int64Value ?? 0
      let targetKey = (params["targetKey"] as? String) ?? ""
      let geometryRev = (params["geometryRev"] as? NSNumber)?.intValue ?? 1
      captureManager.startStream(
        pid: pid,
        processToken: processToken,
        windowId: windowId,
        targetKey: targetKey,
        geometryRev: geometryRev
      ) { res in
        switch res {
        case .success(let info):
          replyOk(info)
        case .failure(let err):
          replyErr("STREAM_START_FAILED", err.localizedDescription)
        }
      }

    case "stop", "stopStream":
      let sid = (params["streamId"] as? NSNumber)?.uint32Value ?? 0
      let stopped = captureManager?.stopStream(streamId: sid) ?? false
      replyOk(["streamId": sid, "stopped": stopped])

    case "keyframe", "requestKeyframe":
      let sid = (params["streamId"] as? NSNumber)?.uint32Value ?? 0
      let targetKey = params["targetKey"] as? String
      let geometryRev = (params["geometryRev"] as? NSNumber)?.intValue
      let ok = captureManager?.requestKeyframe(streamId: sid, targetKey: targetKey, geometryRev: geometryRev) ?? false
      replyOk(["streamId": sid, "requested": ok])

    case "captureWindowJpeg":
      guard let captureManager else {
        replyErr("VIDEO_UNAVAILABLE", "Video channel not connected")
        return
      }
      let pid = (params["pid"] as? NSNumber)?.int32Value ?? 0
      let processToken = params["processToken"] as? String
      let windowId = (params["windowId"] as? NSNumber)?.int64Value ?? 0
      captureManager.captureSingleWindowJpeg(
        pid: pid,
        processToken: processToken,
        windowId: windowId
      ) { res in
        switch res {
        case .success(let imgInfo):
          replyOk(imgInfo)
        case .failure(let err):
          replyErr("CAPTURE_FAILED", err.localizedDescription)
        }
      }

    case "shutdown":
      replyOk(["shuttingDown": true])
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak self] in
        self?.shutdownAndExit(code: 0)
      }

    default:
      replyErr("UNSUPPORTED_OP", "Unsupported op: \(op)")
    }
  }

  private func shutdownAndExit(code: Int32) {
    captureManager?.stopAll()
    sensor?.stop()
    videoClient?.close()
    client?.close()
    exit(code)
  }
}

private func encodeToJsonObject<T: Encodable>(_ value: T) -> Any? {
  guard let data = try? JSONEncoder().encode(value) else { return nil }
  return try? JSONSerialization.jsonObject(with: data, options: [])
}
