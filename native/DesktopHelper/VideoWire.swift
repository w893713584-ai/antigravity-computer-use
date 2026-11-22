import Darwin
import Foundation

enum VideoPacketType: UInt8 {
  case config = 1
  case accessUnit = 2
  case status = 3
}

enum VideoWireLimits {
  static let magic: [UInt8] = [0x43, 0x55, 0x56, 0x31] // "CUV1"
  static let headerBytes: UInt16 = 40
  static let auFlagIdr: UInt8 = 0x01
  static let maxConfigBytes = 16 * 1024
  static let maxAuBytes = 2 * 1024 * 1024
  static let maxStatusBytes = 4 * 1024
  static let maxQueuedPackets = 6
}

func buildVideoPacket(
  type: VideoPacketType,
  flags: UInt8 = 0,
  streamId: UInt32,
  generation: UInt32,
  seq: UInt32,
  ptsUs: UInt64,
  durationUs: UInt32 = 0,
  payload: Data
) -> Data? {
  let maxPayload: Int
  switch type {
  case .config:
    maxPayload = VideoWireLimits.maxConfigBytes
  case .accessUnit:
    maxPayload = VideoWireLimits.maxAuBytes
  case .status:
    maxPayload = VideoWireLimits.maxStatusBytes
  }
  guard payload.count <= maxPayload else { return nil }

  var packet = Data(capacity: Int(VideoWireLimits.headerBytes) + payload.count)
  packet.append(contentsOf: VideoWireLimits.magic)
  packet.append(type.rawValue)
  packet.append(type == .accessUnit ? (flags & VideoWireLimits.auFlagIdr) : 0)
  appendBigEndian(&packet, VideoWireLimits.headerBytes)
  appendBigEndian(&packet, streamId)
  appendBigEndian(&packet, generation)
  appendBigEndian(&packet, type == .accessUnit ? seq : 0)
  appendBigEndian(&packet, UInt32(payload.count))
  appendBigEndian(&packet, ptsUs)
  appendBigEndian(&packet, durationUs)
  appendBigEndian(&packet, UInt32(0)) // reserved = 0
  packet.append(payload)
  return packet
}

private func appendBigEndian<T: FixedWidthInteger>(_ data: inout Data, _ value: T) {
  var be = value.bigEndian
  withUnsafeBytes(of: &be) { raw in
    data.append(contentsOf: raw)
  }
}

func connectUnixStreamSocket(path: String, sendBufferSize: Int32? = nil) -> Int32 {
  let sock = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
  guard sock >= 0 else { return -1 }

  var noSigPipe: Int32 = 1
  _ = Darwin.setsockopt(sock, SOL_SOCKET, SO_NOSIGPIPE, &noSigPipe, socklen_t(MemoryLayout<Int32>.size))

  if let sendBufferSize, sendBufferSize > 0 {
    var sendBuf = sendBufferSize
    _ = Darwin.setsockopt(sock, SOL_SOCKET, SO_SNDBUF, &sendBuf, socklen_t(MemoryLayout<Int32>.size))
  }

  var addr = sockaddr_un()
  addr.sun_family = sa_family_t(AF_UNIX)
  let bytes = Array(path.utf8)
  let maxLen = MemoryLayout.size(ofValue: addr.sun_path)
  guard bytes.count < maxLen else {
    Darwin.close(sock)
    return -1
  }
  withUnsafeMutablePointer(to: &addr.sun_path) { ptr in
    ptr.withMemoryRebound(to: UInt8.self, capacity: maxLen) { dst in
      dst.initialize(repeating: 0, count: maxLen)
      for (i, b) in bytes.enumerated() {
        dst[i] = b
      }
    }
  }

  let addrLen = socklen_t(MemoryLayout<sa_family_t>.stride + bytes.count + 1)
  let res = withUnsafePointer(to: &addr) { ptr in
    ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { saPtr in
      Darwin.connect(sock, saPtr, addrLen)
    }
  }
  guard res == 0 else {
    Darwin.close(sock)
    return -1
  }
  return sock
}

final class UnixVideoClient {
  private let socketPath: String
  private let writeQueue = DispatchQueue(label: "io.codexstyle.cua.desktophelper.video-write")
  private let lock = NSLock()
  private var fd: Int32 = -1
  private var queuedNonIdrCount: Int = 0
  private var closed = false
  private var onDisconnect: (() -> Void)?

  init(socketPath: String, onDisconnect: (() -> Void)? = nil) {
    self.socketPath = socketPath
    self.onDisconnect = onDisconnect
  }

  func connect(authToken: String, brokerBootId: String) -> Bool {
    let sock = connectUnixStreamSocket(path: socketPath, sendBufferSize: 2 * 1024 * 1024)
    guard sock >= 0 else { return false }

    lock.lock()
    self.fd = sock
    self.closed = false
    lock.unlock()

    let helloObj: [String: Any] = [
      "type": "videoHello",
      "authToken": authToken,
      "brokerBootId": brokerBootId,
      "pid": ProcessInfo.processInfo.processIdentifier,
    ]
    if let helloData = try? JSONSerialization.data(withJSONObject: helloObj, options: []) {
      _ = sendStatus(streamId: 0, generation: 0, payload: helloData)
    }
    return true
  }

  var isConnected: Bool {
    lock.lock()
    defer { lock.unlock() }
    return fd >= 0 && !closed
  }

  func sendConfig(streamId: UInt32, generation: UInt32, ptsUs: UInt64, configObj: [String: Any]) -> Bool {
    guard JSONSerialization.isValidJSONObject(configObj),
          let payload = try? JSONSerialization.data(withJSONObject: configObj, options: []) else {
      return false
    }
    return enqueuePacket(
      type: .config,
      flags: 0,
      streamId: streamId,
      generation: generation,
      seq: 0,
      ptsUs: ptsUs,
      durationUs: 0,
      payload: payload
    )
  }

  func sendStatus(streamId: UInt32, generation: UInt32, ptsUs: UInt64 = 0, payload: Data) -> Bool {
    return enqueuePacket(
      type: .status,
      flags: 0,
      streamId: streamId,
      generation: generation,
      seq: 0,
      ptsUs: ptsUs,
      durationUs: 0,
      payload: payload
    )
  }

  func sendAccessUnit(
    streamId: UInt32,
    generation: UInt32,
    seq: UInt32,
    isIdr: Bool,
    ptsUs: UInt64,
    durationUs: UInt32,
    payload: Data
  ) -> Bool {
    lock.lock()
    let shouldDropNonIdr = !isIdr && queuedNonIdrCount >= VideoWireLimits.maxQueuedPackets
    lock.unlock()
    if shouldDropNonIdr {
      return false
    }
    return enqueuePacket(
      type: .accessUnit,
      flags: isIdr ? VideoWireLimits.auFlagIdr : 0,
      streamId: streamId,
      generation: generation,
      seq: seq,
      ptsUs: ptsUs,
      durationUs: durationUs,
      payload: payload
    )
  }

  private func enqueuePacket(
    type: VideoPacketType,
    flags: UInt8,
    streamId: UInt32,
    generation: UInt32,
    seq: UInt32,
    ptsUs: UInt64,
    durationUs: UInt32,
    payload: Data
  ) -> Bool {
    guard let packet = buildVideoPacket(
      type: type,
      flags: flags,
      streamId: streamId,
      generation: generation,
      seq: seq,
      ptsUs: ptsUs,
      durationUs: durationUs,
      payload: payload
    ) else {
      return false
    }

    let isNonIdr = (type == .accessUnit && (flags & VideoWireLimits.auFlagIdr) == 0)
    lock.lock()
    if closed || fd < 0 {
      lock.unlock()
      return false
    }
    if isNonIdr {
      queuedNonIdrCount += 1
    }
    lock.unlock()

    writeQueue.async { [weak self] in
      guard let self else { return }
      if isNonIdr {
        self.lock.lock()
        self.queuedNonIdrCount = max(0, self.queuedNonIdrCount - 1)
        self.lock.unlock()
      }
      self.writeAllBlocking(packet)
    }
    return true
  }

  private func writeAllBlocking(_ packet: Data) {
    lock.lock()
    let currentFd = fd
    let isClosed = closed
    lock.unlock()
    guard !isClosed, currentFd >= 0 else { return }

    packet.withUnsafeBytes { rawBuf in
      guard let base = rawBuf.baseAddress else { return }
      var sent = 0
      while sent < packet.count {
        let n = Darwin.write(currentFd, base.advanced(by: sent), packet.count - sent)
        if n > 0 {
          sent += n
        } else if errno == EINTR || errno == EAGAIN {
          usleep(1000)
        } else {
          self.close()
          DispatchQueue.main.async { [weak self] in
            self?.onDisconnect?()
          }
          return
        }
      }
    }
  }

  func close() {
    lock.lock()
    if !closed {
      closed = true
      if fd >= 0 {
        Darwin.close(fd)
        fd = -1
      }
    }
    lock.unlock()
  }
}
