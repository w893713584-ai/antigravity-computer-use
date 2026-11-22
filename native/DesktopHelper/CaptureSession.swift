import AppKit
import CoreGraphics
import CoreMedia
import CoreVideo
import Foundation
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

enum CaptureErrorCode {
  static let screenRecordingNotGranted = "screen_recording_not_granted"
  static let windowNotFound = "window_not_found"
  static let maxStreamsReached = "max_streams_reached"
  static let streamStartFailed = "stream_start_failed"
}

private func computeTargetCodedSize(windowSizePt: CGSize, scaleFactor: CGFloat, maxDim: Int = 1280) -> (Int, Int) {
  let rawW = max(2.0, windowSizePt.width * max(1.0, scaleFactor))
  let rawH = max(2.0, windowSizePt.height * max(1.0, scaleFactor))
  let longest = max(rawW, rawH)
  let ratio = longest > CGFloat(maxDim) ? CGFloat(maxDim) / longest : 1.0
  var w = Int((rawW * ratio).rounded())
  var h = Int((rawH * ratio).rounded())
  w = max(2, min(maxDim, w & ~1))
  h = max(2, min(maxDim, h & ~1))
  if w == 0 { w = 2 }
  if h == 0 { h = 2 }
  return (w, h)
}

private func monotonicMicros() -> UInt64 {
  return DispatchTime.now().uptimeNanoseconds / 1_000
}

private func jpegDataFromCGImage(_ cgImage: CGImage, quality: Double = 0.80, maxDimension: Int = 1280) -> (Data, Int, Int)? {
  var targetImage = cgImage
  let origW = cgImage.width
  let origH = cgImage.height
  if max(origW, origH) > maxDimension && maxDimension > 0 {
    let scale = Double(maxDimension) / Double(max(origW, origH))
    let dstW = max(2, Int((Double(origW) * scale).rounded()) & ~1)
    let dstH = max(2, Int((Double(origH) * scale).rounded()) & ~1)
    if let colorSpace = CGColorSpace(name: CGColorSpace.sRGB),
       let ctx = CGContext(
         data: nil,
         width: dstW,
         height: dstH,
         bitsPerComponent: 8,
         bytesPerRow: 0,
         space: colorSpace,
         bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue
       ) {
      ctx.interpolationQuality = .high
      ctx.draw(cgImage, in: CGRect(x: 0, y: 0, width: dstW, height: dstH))
      if let scaled = ctx.makeImage() {
        targetImage = scaled
      }
    }
  }

  let outData = NSMutableData()
  guard let dest = CGImageDestinationCreateWithData(outData, UTType.jpeg.identifier as CFString, 1, nil) else {
    return nil
  }
  let props: [CFString: Any] = [kCGImageDestinationLossyCompressionQuality: max(0.1, min(1.0, quality))]
  CGImageDestinationAddImage(dest, targetImage, props as CFDictionary)
  guard CGImageDestinationFinalize(dest) else { return nil }
  return (outData as Data, targetImage.width, targetImage.height)
}

final class ManagedCaptureStream: NSObject, SCStreamOutput, SCStreamDelegate {
  let streamId: UInt32
  let targetPid: Int32
  let targetProcessToken: String?
  let targetWindowId: CGWindowID
  var targetKey: String
  var geometryRev: Int

  private let sampleQueue: DispatchQueue
  private let lock = NSLock()
  private var stream: SCStream?
  private var encoder: H264HardwareEncoder?
  private var videoClient: UnixVideoClient
  private var onStatusNotification: ([String: Any]) -> Void
  private var basePtsUs: UInt64 = 0
  private var lastPtsUs: UInt64 = 0
  private var lastPixelBuffer: CVPixelBuffer?
  private var lastFrameLuma8x8: [UInt8] = []
  private var lastContentRectPt: [String: Double] = ["x": 0, "y": 0, "width": 0, "height": 0]
  private var lastSourceCropPx: [String: Int]? = nil
  private var lastGeometryVerified: Bool = true
  private var lastWindowBoundsPt = WindowRectPt(x: 0, y: 0, width: 0, height: 0)
  private var lastCodedWidth: Int = 0
  private var lastCodedHeight: Int = 0
  private var lastDisplayWidth: Int = 0
  private var lastDisplayHeight: Int = 0
  private var lastScaleFactor: Double = 1.0
  private var pendingForceKeyframe = true
  private var stopped = false
  private var lastSampleAtNs: UInt64 = 0
  private var lastStatusState: String = "starting"
  private var stallProbeInFlight = false
  private var watchdogTimer: DispatchSourceTimer?
  private var currentWindow: SCWindow?
  private var isUpdatingConfig = false

  init(
    streamId: UInt32,
    pid: Int32,
    processToken: String?,
    windowId: CGWindowID,
    targetKey: String,
    geometryRev: Int,
    videoClient: UnixVideoClient,
    onStatusNotification: @escaping ([String: Any]) -> Void
  ) {
    self.streamId = streamId
    self.targetPid = pid
    self.targetProcessToken = processToken
    self.targetWindowId = windowId
    self.targetKey = targetKey
    self.geometryRev = geometryRev
    self.videoClient = videoClient
    self.onStatusNotification = onStatusNotification
    self.sampleQueue = DispatchQueue(label: "io.codexstyle.cua.desktophelper.sc.\(streamId)")
    super.init()
  }

  func start(scWindow: SCWindow, completion: @escaping (Result<[String: Any], NSError>) -> Void) {
    guard CGPreflightScreenCaptureAccess() else {
      completion(.failure(NSError(
        domain: "CaptureSession",
        code: 403,
        userInfo: [NSLocalizedDescriptionKey: CaptureErrorCode.screenRecordingNotGranted]
      )))
      return
    }

    if let expectedTok = targetProcessToken {
      let actualTok = WindowInventory.processToken(for: targetPid)
      if let actualTok, actualTok != expectedTok {
        completion(.failure(NSError(
          domain: "CaptureSession",
          code: 409,
          userInfo: [NSLocalizedDescriptionKey: "process_token_mismatch"]
        )))
        return
      }
    }

    let filter = SCContentFilter(desktopIndependentWindow: scWindow)
    let info = SCShareableContent.info(for: filter)
    let winFrame = scWindow.frame
    let scale = CGFloat(max(1.0, Double(info.pointPixelScale)))
    let (codedW, codedH) = computeTargetCodedSize(windowSizePt: winFrame.size, scaleFactor: scale, maxDim: 1280)

    self.currentWindow = scWindow
    self.lastWindowBoundsPt = WindowRectPt(
      x: Double(winFrame.origin.x),
      y: Double(winFrame.origin.y),
      width: Double(winFrame.size.width),
      height: Double(winFrame.size.height)
    )
    self.lastContentRectPt = [
      "x": 0,
      "y": 0,
      "width": Double(winFrame.size.width),
      "height": Double(winFrame.size.height),
    ]
    self.lastCodedWidth = codedW
    self.lastCodedHeight = codedH
    self.lastDisplayWidth = codedW
    self.lastDisplayHeight = codedH
    self.lastScaleFactor = Double(scale)
    self.basePtsUs = monotonicMicros()
    self.lastPtsUs = 0

    let enc = H264HardwareEncoder(
      streamId: streamId,
      onConfig: { [weak self] gen, ptsUs, cfgObj in
        guard let self, !self.isStopped else { return }
        _ = self.videoClient.sendConfig(streamId: self.streamId, generation: gen, ptsUs: ptsUs, configObj: cfgObj)
      },
      onAccessUnit: { [weak self] gen, seq, isIdr, ptsUs, durUs, data in
        guard let self, !self.isStopped else { return }
        _ = self.videoClient.sendAccessUnit(
          streamId: self.streamId,
          generation: gen,
          seq: seq,
          isIdr: isIdr,
          ptsUs: ptsUs,
          durationUs: durUs,
          payload: data
        )
      },
      onError: { [weak self] code, message in
        self?.emitStreamStatus(state: "encoder_error", reason: "\(code):\(message)")
      }
    )

    if case .failure(let err) = enc.configure(width: codedW, height: codedH) {
      enc.invalidate()
      completion(.failure(err))
      return
    }
    self.encoder = enc

    let cfg = makeStreamConfiguration(codedW: codedW, codedH: codedH)
    let scStream = SCStream(filter: filter, configuration: cfg, delegate: self)
    do {
      try scStream.addStreamOutput(self, type: .screen, sampleHandlerQueue: sampleQueue)
    } catch {
      enc.invalidate()
      completion(.failure(error as NSError))
      return
    }
    self.stream = scStream

    scStream.startCapture { [weak self] error in
      guard let self else { return }
      if let error {
        self.stop()
        completion(.failure(error as NSError))
        return
      }
      self.lock.lock()
      self.lastSampleAtNs = DispatchTime.now().uptimeNanoseconds
      self.lastStatusState = "streaming"
      self.lock.unlock()
      self.startWatchdog()
      completion(.success([
        "streamId": self.streamId,
        "targetKey": self.targetKey,
        "geometryRev": self.geometryRev,
        "windowId": Int64(self.targetWindowId),
        "codedWidth": codedW,
        "codedHeight": codedH,
        "boundsPt": [
          "x": Double(winFrame.origin.x),
          "y": Double(winFrame.origin.y),
          "width": Double(winFrame.size.width),
          "height": Double(winFrame.size.height),
        ],
        "scaleFactor": Double(scale),
      ]))
    }
  }

  private static func luma8x8FromPixelBuffer(_ pb: CVPixelBuffer, crop: [String: Int]? = nil) -> [UInt8] {
    CVPixelBufferLockBaseAddress(pb, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(pb, .readOnly) }
    guard CVPixelBufferIsPlanar(pb), CVPixelBufferGetPlaneCount(pb) >= 1,
          let base = CVPixelBufferGetBaseAddressOfPlane(pb, 0) else {
      return []
    }
    let w = CVPixelBufferGetWidthOfPlane(pb, 0)
    let h = CVPixelBufferGetHeightOfPlane(pb, 0)
    let bpr = CVPixelBufferGetBytesPerRowOfPlane(pb, 0)
    guard w >= 2, h >= 2, bpr >= w else { return [] }
    let cx = max(0, min(w - 1, crop?["x"] ?? 0))
    let cy = max(0, min(h - 1, crop?["y"] ?? 0))
    let cw = max(1, min(w - cx, crop?["width"] ?? w))
    let ch = max(1, min(h - cy, crop?["height"] ?? h))
    let ptr = base.assumingMemoryBound(to: UInt8.self)
    var out = [UInt8](repeating: 0, count: 64)
    for row in 0..<8 {
      let sy = cy + min(ch - 1, (row * 2 + 1) * ch / 16)
      for col in 0..<8 {
        let sx = cx + min(cw - 1, (col * 2 + 1) * cw / 16)
        let rawY = Int(ptr[sy * bpr + sx])
        let normY = max(0, min(255, ((max(16, min(235, rawY)) - 16) * 255) / 219))
        out[row * 8 + col] = UInt8(normY)
      }
    }
    return out
  }

  private static func luma8x8FromCGImage(_ img: CGImage) -> [UInt8] {
    var out = [UInt8](repeating: 0, count: 64)
    let gray = CGColorSpaceCreateDeviceGray()
    let ok = out.withUnsafeMutableBytes { buf -> Bool in
      guard let ptr = buf.baseAddress,
            let ctx = CGContext(
              data: ptr,
              width: 8,
              height: 8,
              bitsPerComponent: 8,
              bytesPerRow: 8,
              space: gray,
              bitmapInfo: CGImageAlphaInfo.none.rawValue
            ) else {
        return false
      }
      ctx.interpolationQuality = .medium
      ctx.draw(img, in: CGRect(x: 0, y: 0, width: 8, height: 8))
      return true
    }
    return ok ? out : []
  }

  private func makeStreamConfiguration(codedW: Int, codedH: Int) -> SCStreamConfiguration {
    let cfg = SCStreamConfiguration()
    cfg.width = codedW
    cfg.height = codedH
    cfg.minimumFrameInterval = CMTime(value: 1, timescale: 20)
    cfg.queueDepth = 3
    cfg.showsCursor = false
    cfg.capturesAudio = false
    cfg.pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
    cfg.preservesAspectRatio = true
    cfg.scalesToFit = true
    cfg.ignoreShadowsSingleWindow = true
    return cfg
  }

  private var isStopped: Bool {
    lock.lock()
    defer { lock.unlock() }
    return stopped
  }

  private func nextMonotonicPtsUsLocked() -> UInt64 {
    let now = monotonicMicros()
    let rawRel = now >= basePtsUs ? (now - basePtsUs) : 0
    let pts = max(rawRel, lastPtsUs + 1)
    lastPtsUs = pts
    return pts
  }

  func requestKeyframe(targetKey: String? = nil, geometryRev: Int? = nil) -> Bool {
    lock.lock()
    if stopped {
      lock.unlock()
      return false
    }
    if let tk = targetKey, !tk.isEmpty { self.targetKey = tk }
    if let rev = geometryRev, rev > 0 { self.geometryRev = rev }
    pendingForceKeyframe = true
    let cachedPb = lastPixelBuffer
    let cW = lastCodedWidth
    let cH = lastCodedHeight
    let dW = lastDisplayWidth
    let dH = lastDisplayHeight
    let rectPt = lastContentRectPt
    let cropPx = lastSourceCropPx
    let geomOk = lastGeometryVerified
    let tk = self.targetKey
    let rev = self.geometryRev
    let enc = encoder
    lock.unlock()

    // Static windows do not emit new SC frames on demand; re-encode cached buffer with a fresh monotonic PTS.
    if let pb = cachedPb, let enc {
      let ptsUs = lock.withLock { nextMonotonicPtsUsLocked() }
      return enc.encode(
        pixelBuffer: pb,
        ptsUs: ptsUs,
        durationUs: 50_000,
        forceKeyframe: true,
        codedWidth: cW,
        codedHeight: cH,
        displayWidth: dW,
        displayHeight: dH,
        contentRectPt: rectPt,
        sourceCropPx: cropPx,
        geometryVerified: geomOk,
        geometryChanged: false,
        targetKey: tk,
        geometryRev: rev,
        dropIfBusy: false
      )
    }
    return true
  }

  func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
    guard type == .screen, !isStopped else { return }
    let nowNs = DispatchTime.now().uptimeNanoseconds

    var frameStatus: SCFrameStatus = .complete
    var contentRect: CGRect?
    var scaleFactor: Double = lastScaleFactor
    var contentScale: Double = 1.0
    if let attachmentsList = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
       let att = attachmentsList.first {
      if let rawSt = att[SCStreamFrameInfo.status] as? Int, let parsedSt = SCFrameStatus(rawValue: rawSt) {
        frameStatus = parsedSt
      }
      if let sf = (att[SCStreamFrameInfo.scaleFactor] as? NSNumber)?.doubleValue, sf >= 1.0 {
        scaleFactor = sf
      }
      if let cs = (att[SCStreamFrameInfo.contentScale] as? NSNumber)?.doubleValue, cs > 0 {
        contentScale = cs
      }
      if let cfVal = att[SCStreamFrameInfo.contentRect],
         CFGetTypeID(cfVal as CFTypeRef) == CFDictionaryGetTypeID() {
        let cfDict = unsafeBitCast(cfVal as CFTypeRef, to: CFDictionary.self)
        var r = CGRect.zero
        if CGRectMakeWithDictionaryRepresentation(cfDict, &r), r.width > 0, r.height > 0 {
          contentRect = r
        }
      }
    }

    switch frameStatus {
    case .idle:
      lock.lock()
      lastSampleAtNs = nowNs
      let prevState = lastStatusState
      lastStatusState = "idle"
      lock.unlock()
      if prevState != "streaming" && prevState != "idle" {
        emitStreamStatus(state: "streaming", reason: "resumed_idle")
      }
      return
    case .blank:
      lock.lock()
      lastSampleAtNs = nowNs
      lastStatusState = "blank"
      lock.unlock()
      emitStreamStatus(state: "blank", reason: "sc_frame_blank")
      return
    case .suspended:
      lock.lock()
      lastSampleAtNs = nowNs
      lastStatusState = "suspended"
      lock.unlock()
      emitStreamStatus(state: "suspended", reason: "sc_frame_suspended")
      return
    case .stopped:
      emitStreamStatus(state: "stopped", reason: "sc_frame_stopped")
      return
    case .started, .complete:
      break
    @unknown default:
      break
    }

    guard let pb = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
    let pbW = CVPixelBufferGetWidth(pb)
    let pbH = CVPixelBufferGetHeight(pb)
    guard pbW >= 2, pbH >= 2 else { return }

    // Look up authoritative live Quartz bounds (single window, background-safe).
    let liveWin = WindowInventory.listWindows(filterPid: targetPid).first { $0.windowId == Int64(targetWindowId) }
    var winBoundsPt = lastWindowBoundsPt
    var geomChanged = false
    if let liveWin {
      if !liveWin.onScreen {
        emitStreamStatus(state: "window_minimized", reason: "window_offscreen_or_minimized")
      }
      if abs(liveWin.boundsPt.width - winBoundsPt.width) > 1.0 ||
         abs(liveWin.boundsPt.height - winBoundsPt.height) > 1.0 ||
         abs(liveWin.boundsPt.x - winBoundsPt.x) > 1.0 ||
         abs(liveWin.boundsPt.y - winBoundsPt.y) > 1.0 {
        winBoundsPt = liveWin.boundsPt
        geomChanged = true
      }
    }

    // Reconfigure capture resolution if the window resized significantly so H.264 fits tightly without padding.
    if let liveWin, !isUpdatingConfig {
      let (idealW, idealH) = computeTargetCodedSize(
        windowSizePt: CGSize(width: liveWin.boundsPt.width, height: liveWin.boundsPt.height),
        scaleFactor: CGFloat(scaleFactor),
        maxDim: 1280
      )
      if abs(idealW - lastCodedWidth) > 2 || abs(idealH - lastCodedHeight) > 2 {
        isUpdatingConfig = true
        let newCfg = makeStreamConfiguration(codedW: idealW, codedH: idealH)
        stream.updateConfiguration(newCfg) { [weak self] _ in
          self?.lock.withLock { self?.isUpdatingConfig = false }
        }
      }
    }
    if pbW != lastCodedWidth || pbH != lastCodedHeight {
      geomChanged = true
    }

    // Compute visible content crop inside coded pixels & verify against windowBoundsPt * contentScale.
    var contentRectPt = [
      "x": 0.0,
      "y": 0.0,
      "width": max(1.0, winBoundsPt.width),
      "height": max(1.0, winBoundsPt.height),
    ]
    var sourceCropPx: [String: Int]? = nil
    var displayW = pbW
    var displayH = pbH
    var geometryVerified = false

    if let r = contentRect, r.width > 0, r.height > 0 {
      let pxScale = (Double(r.width) * scaleFactor <= Double(pbW) + 4.0 &&
                     Double(r.height) * scaleFactor <= Double(pbH) + 4.0) ? scaleFactor : 1.0
      let rawSx = Int((Double(r.origin.x) * pxScale).rounded())
      let rawSy = Int((Double(r.origin.y) * pxScale).rounded())
      let rawSw = Int((Double(r.width) * pxScale).rounded())
      let rawSh = Int((Double(r.height) * pxScale).rounded())
      let inBufferBounds =
        rawSx >= -2 &&
        rawSy >= -2 &&
        rawSw >= 2 &&
        rawSh >= 2 &&
        (rawSx + rawSw) <= pbW + 2 &&
        (rawSy + rawSh) <= pbH + 2
      let sx = max(0, min(pbW - 2, rawSx))
      let sy = max(0, min(pbH - 2, rawSy))
      let sw = max(2, min(pbW - sx, rawSw))
      let sh = max(2, min(pbH - sy, rawSh))
      if sx > 1 || sy > 1 || sw < pbW - 2 || sh < pbH - 2 {
        sourceCropPx = ["x": sx, "y": sy, "width": sw, "height": sh]
        displayW = sw
        displayH = sh
      }

      let winW = max(1.0, winBoundsPt.width)
      let winH = max(1.0, winBoundsPt.height)
      let tolW = max(6.0, winW * 0.06)
      let tolH = max(6.0, winH * 0.06)
      let effScale = max(0.01, contentScale)
      let candidateScales = [effScale, max(0.01, scaleFactor * effScale), max(0.01, scaleFactor)]
      let originNearZeroPx = abs(Double(r.origin.x) * pxScale) <= 4.0 && abs(Double(r.origin.y) * pxScale) <= 4.0
      let scaleMatch = candidateScales.contains { s in
        abs(Double(r.width) / s - winW) <= tolW && abs(Double(r.height) / s - winH) <= tolH
      }
      let inferredX = Double(r.origin.x) / effScale
      let inferredY = Double(r.origin.y) / effScale
      let inferredW = Double(r.width) / effScale
      let inferredH = Double(r.height) / effScale
      let cropAspect = Double(sw) / Double(max(1, sh))
      let rectAspect = max(0.001, Double(r.width) / max(1.0, Double(r.height)))
      let subAspectDiff = abs(cropAspect - rectAspect) / rectAspect

      if inBufferBounds && scaleMatch && originNearZeroPx {
        geometryVerified = true
        contentRectPt = [
          "x": 0.0,
          "y": 0.0,
          "width": winW,
          "height": winH,
        ]
      } else if inBufferBounds &&
                subAspectDiff <= 0.06 &&
                inferredX >= -(tolW * 0.25) &&
                inferredY >= -(tolH * 0.25) &&
                inferredW > 0 &&
                inferredH > 0 &&
                (inferredX + inferredW) <= winW + tolW &&
                (inferredY + inferredH) <= winH + tolH {
        geometryVerified = true
        contentRectPt = [
          "x": max(0.0, min(winW - 1.0, inferredX)),
          "y": max(0.0, min(winH - 1.0, inferredY)),
          "width": max(1.0, min(winW, inferredW)),
          "height": max(1.0, min(winH, inferredH)),
        ]
      } else {
        geometryVerified = false
      }
    }

    var shouldForce = false
    var encRef: H264HardwareEncoder?
    var ptsUs: UInt64 = 0
    var nextRev = geometryRev
    var tk = targetKey
    let lumaSig = Self.luma8x8FromPixelBuffer(pb, crop: sourceCropPx)

    lock.lock()
    lastSampleAtNs = nowNs
    let prevState = lastStatusState
    lastStatusState = "streaming"
    if lastSourceCropPx != sourceCropPx {
      geomChanged = true
    }
    if geomChanged {
      geometryRev += 1
      nextRev = geometryRev
    }
    lastWindowBoundsPt = winBoundsPt
    lastContentRectPt = contentRectPt
    lastSourceCropPx = sourceCropPx
    lastGeometryVerified = geometryVerified
    lastCodedWidth = pbW
    lastCodedHeight = pbH
    lastDisplayWidth = displayW
    lastDisplayHeight = displayH
    lastScaleFactor = scaleFactor
    lastPixelBuffer = pb
    lastFrameLuma8x8 = lumaSig
    shouldForce = pendingForceKeyframe || geomChanged
    pendingForceKeyframe = false
    encRef = encoder
    tk = targetKey
    ptsUs = nextMonotonicPtsUsLocked()
    lock.unlock()

    if prevState != "streaming" {
      emitStreamStatus(state: "streaming", reason: "frame_complete", extra: [
        "boundsPt": [
          "x": winBoundsPt.x,
          "y": winBoundsPt.y,
          "width": winBoundsPt.width,
          "height": winBoundsPt.height,
        ],
        "geometryRev": nextRev,
        "scaleFactor": scaleFactor,
      ])
    } else if geomChanged {
      emitStreamStatus(state: "geometry_changed", reason: "window_bounds_updated", extra: [
        "boundsPt": [
          "x": winBoundsPt.x,
          "y": winBoundsPt.y,
          "width": winBoundsPt.width,
          "height": winBoundsPt.height,
        ],
        "geometryRev": nextRev,
        "scaleFactor": scaleFactor,
      ])
    }

    guard let encRef else { return }
    let accepted = encRef.encode(
      pixelBuffer: pb,
      ptsUs: ptsUs,
      durationUs: 50_000,
      forceKeyframe: shouldForce,
      codedWidth: pbW,
      codedHeight: pbH,
      displayWidth: displayW,
      displayHeight: displayH,
      contentRectPt: contentRectPt,
      sourceCropPx: sourceCropPx,
      geometryVerified: geometryVerified,
      geometryChanged: geomChanged,
      targetKey: tk,
      geometryRev: nextRev,
      dropIfBusy: !shouldForce
    )
    if !accepted && shouldForce {
      lock.withLock { pendingForceKeyframe = true }
    }
  }

  func stream(_ stream: SCStream, didStopWithError error: Error) {
    emitStreamStatus(state: "stopped", reason: error.localizedDescription)
  }

  private func startWatchdog() {
    let timer = DispatchSource.makeTimerSource(queue: sampleQueue)
    timer.schedule(deadline: .now() + 2.0, repeating: 1.0)
    timer.setEventHandler { [weak self] in
      guard let self, !self.isStopped else { return }
      let nowNs = DispatchTime.now().uptimeNanoseconds
      let (elapsedNs, state, scWin, alreadyProbing) = self.lock.withLock {
        (nowNs &- self.lastSampleAtNs, self.lastStatusState, self.currentWindow, self.stallProbeInFlight)
      }
      guard elapsedNs > 2_000_000_000 && state != "idle" && state != "stalled" else { return }
      let stillExists = WindowInventory.listWindows(filterPid: self.targetPid).contains {
        $0.windowId == Int64(self.targetWindowId)
      }
      if !stillExists {
        self.lock.withLock { self.lastStatusState = "window_closed" }
        self.emitStreamStatus(state: "window_closed", reason: "window_missing")
        return
      }
      guard !alreadyProbing, let scWin else { return }
      self.lock.withLock { self.stallProbeInFlight = true }

      let probeLock = NSLock()
      var probeFinished = false
      let timeoutItem = DispatchWorkItem { [weak self] in
        guard let self else { return }
        let shouldFail = probeLock.withLock { () -> Bool in
          if probeFinished { return false }
          probeFinished = true
          return true
        }
        guard shouldFail, !self.isStopped else { return }
        self.lock.withLock {
          self.stallProbeInFlight = false
          self.lastStatusState = "stalled"
        }
        self.emitStreamStatus(state: "stalled", reason: "no_sample_2s_probe_timeout")
      }
      self.sampleQueue.asyncAfter(deadline: .now() + 1.2, execute: timeoutItem)

      let filter = SCContentFilter(desktopIndependentWindow: scWin)
      let cfg = SCStreamConfiguration()
      cfg.width = 64
      cfg.height = 64
      cfg.showsCursor = false
      cfg.capturesAudio = false
      cfg.ignoreShadowsSingleWindow = true
      SCScreenshotManager.captureImage(contentFilter: filter, configuration: cfg) { [weak self] cgImg, _ in
        guard let self else { return }
        let isOwner = probeLock.withLock { () -> Bool in
          if probeFinished { return false }
          probeFinished = true
          return true
        }
        timeoutItem.cancel()
        guard isOwner else { return }
        if !self.isStopped, let img = cgImg, img.width >= 2, img.height >= 2 {
          let prevLuma = self.lock.withLock { self.lastFrameLuma8x8 }
          let probeLuma = Self.luma8x8FromCGImage(img)
          var diverged = false
          if prevLuma.count == 64 && probeLuma.count == 64 {
            var sumDiff = 0
            for i in 0..<64 {
              sumDiff += abs(Int(prevLuma[i]) - Int(probeLuma[i]))
            }
            diverged = (Double(sumDiff) / 64.0) > 14.0
          }
          let doneNs = DispatchTime.now().uptimeNanoseconds
          if diverged {
            self.lock.withLock {
              self.stallProbeInFlight = false
              self.lastStatusState = "stalled"
            }
            self.emitStreamStatus(state: "stalled", reason: "no_sample_2s_content_diverged")
          } else {
            self.lock.withLock {
              self.stallProbeInFlight = false
              self.lastSampleAtNs = doneNs
              self.lastStatusState = "idle"
            }
          }
        } else if !self.isStopped {
          self.lock.withLock {
            self.stallProbeInFlight = false
            self.lastStatusState = "stalled"
          }
          self.emitStreamStatus(state: "stalled", reason: "no_sample_2s_probe_failed")
        } else {
          self.lock.withLock { self.stallProbeInFlight = false }
        }
      }
    }
    timer.resume()
    self.watchdogTimer = timer
  }

  private func emitStreamStatus(state: String, reason: String, extra: [String: Any] = [:]) {
    var payload: [String: Any] = [
      "type": "streamStatus",
      "streamId": streamId,
      "targetKey": targetKey,
      "windowId": Int64(targetWindowId),
      "state": state,
      "reason": reason,
    ]
    for (k, v) in extra {
      payload[k] = v
    }
    if let data = try? JSONSerialization.data(withJSONObject: payload, options: []) {
      let gen = encoder?.currentGeneration ?? 0
      _ = videoClient.sendStatus(streamId: streamId, generation: gen, ptsUs: 0, payload: data)
    }
    onStatusNotification(payload)
  }

  func stop() {
    var sc: SCStream?
    var enc: H264HardwareEncoder?
    var wd: DispatchSourceTimer?
    lock.lock()
    if stopped {
      lock.unlock()
      return
    }
    stopped = true
    sc = stream
    stream = nil
    enc = encoder
    encoder = nil
    wd = watchdogTimer
    watchdogTimer = nil
    lastPixelBuffer = nil
    lock.unlock()

    wd?.cancel()
    sc?.stopCapture { _ in }
    enc?.invalidate()
  }
}

final class CaptureSessionManager {
  static let maxActiveStreams = 2

  private let lock = NSLock()
  private var streamsById: [UInt32: ManagedCaptureStream] = [:]
  private var nextStreamId: UInt32 = 1
  private let videoClient: UnixVideoClient
  private let onStatusNotification: ([String: Any]) -> Void

  init(videoClient: UnixVideoClient, onStatusNotification: @escaping ([String: Any]) -> Void) {
    self.videoClient = videoClient
    self.onStatusNotification = onStatusNotification
  }

  func startStream(
    pid: Int32,
    processToken: String?,
    windowId: Int64,
    targetKey: String,
    geometryRev: Int,
    completion: @escaping (Result<[String: Any], NSError>) -> Void
  ) {
    guard CGPreflightScreenCaptureAccess() else {
      completion(.failure(NSError(
        domain: "CaptureSessionManager",
        code: 403,
        userInfo: [NSLocalizedDescriptionKey: CaptureErrorCode.screenRecordingNotGranted]
      )))
      return
    }
    guard pid > 0, windowId > 0 else {
      completion(.failure(NSError(
        domain: "CaptureSessionManager",
        code: 400,
        userInfo: [NSLocalizedDescriptionKey: "invalid_pid_or_window_id"]
      )))
      return
    }

    let canAllocate = lock.withLock { streamsById.count < Self.maxActiveStreams }
    guard canAllocate else {
      completion(.failure(NSError(
        domain: "CaptureSessionManager",
        code: 429,
        userInfo: [NSLocalizedDescriptionKey: CaptureErrorCode.maxStreamsReached]
      )))
      return
    }

    SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: false) { [weak self] content, error in
      guard let self else { return }
      if let error {
        completion(.failure(error as NSError))
        return
      }
      guard let scWindow = content?.windows.first(where: {
        $0.windowID == CGWindowID(windowId) && ($0.owningApplication?.processID ?? 0) == pid
      }) else {
        completion(.failure(NSError(
          domain: "CaptureSessionManager",
          code: 404,
          userInfo: [NSLocalizedDescriptionKey: CaptureErrorCode.windowNotFound]
        )))
        return
      }

      let sid: UInt32 = self.lock.withLock {
        guard self.streamsById.count < Self.maxActiveStreams else { return 0 }
        let id = self.nextStreamId
        self.nextStreamId &+= 1
        if self.nextStreamId == 0 { self.nextStreamId = 1 }
        let managed = ManagedCaptureStream(
          streamId: id,
          pid: pid,
          processToken: processToken,
          windowId: scWindow.windowID,
          targetKey: targetKey,
          geometryRev: geometryRev,
          videoClient: self.videoClient,
          onStatusNotification: self.onStatusNotification
        )
        self.streamsById[id] = managed
        return id
      }
      guard sid > 0, let managed = self.lock.withLock({ self.streamsById[sid] }) else {
        completion(.failure(NSError(
          domain: "CaptureSessionManager",
          code: 429,
          userInfo: [NSLocalizedDescriptionKey: CaptureErrorCode.maxStreamsReached]
        )))
        return
      }

      managed.start(scWindow: scWindow) { res in
        if case .failure = res {
          _ = self.lock.withLock { self.streamsById.removeValue(forKey: sid) }
        }
        completion(res)
      }
    }
  }

  func stopStream(streamId: UInt32) -> Bool {
    let removed = lock.withLock { streamsById.removeValue(forKey: streamId) }
    removed?.stop()
    return removed != nil
  }

  func requestKeyframe(streamId: UInt32, targetKey: String? = nil, geometryRev: Int? = nil) -> Bool {
    let stream = lock.withLock { streamsById[streamId] }
    return stream?.requestKeyframe(targetKey: targetKey, geometryRev: geometryRev) ?? false
  }

  func captureSingleWindowJpeg(
    pid: Int32,
    processToken: String?,
    windowId: Int64,
    completion: @escaping (Result<[String: Any], NSError>) -> Void
  ) {
    guard CGPreflightScreenCaptureAccess() else {
      completion(.failure(NSError(
        domain: "CaptureSessionManager",
        code: 403,
        userInfo: [NSLocalizedDescriptionKey: CaptureErrorCode.screenRecordingNotGranted]
      )))
      return
    }
    if let expectedTok = processToken, let actualTok = WindowInventory.processToken(for: pid), actualTok != expectedTok {
      completion(.failure(NSError(
        domain: "CaptureSessionManager",
        code: 409,
        userInfo: [NSLocalizedDescriptionKey: "process_token_mismatch"]
      )))
      return
    }

    SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: false) { content, error in
      if let error {
        completion(.failure(error as NSError))
        return
      }
      guard let scWindow = content?.windows.first(where: {
        $0.windowID == CGWindowID(windowId) && ($0.owningApplication?.processID ?? 0) == pid
      }) else {
        completion(.failure(NSError(
          domain: "CaptureSessionManager",
          code: 404,
          userInfo: [NSLocalizedDescriptionKey: CaptureErrorCode.windowNotFound]
        )))
        return
      }
      let filter = SCContentFilter(desktopIndependentWindow: scWindow)
      let info = SCShareableContent.info(for: filter)
      let scale = CGFloat(max(1.0, Double(info.pointPixelScale)))
      let (w, h) = computeTargetCodedSize(windowSizePt: scWindow.frame.size, scaleFactor: scale, maxDim: 1280)
      let cfg = SCStreamConfiguration()
      cfg.width = w
      cfg.height = h
      cfg.showsCursor = false
      cfg.ignoreShadowsSingleWindow = true
      cfg.preservesAspectRatio = true
      cfg.scalesToFit = true

      SCScreenshotManager.captureImage(contentFilter: filter, configuration: cfg) { cgImage, err in
        if let err {
          completion(.failure(err as NSError))
          return
        }
        guard let cgImage, let (jpegData, outW, outH) = jpegDataFromCGImage(cgImage) else {
          completion(.failure(NSError(
            domain: "CaptureSessionManager",
            code: 500,
            userInfo: [NSLocalizedDescriptionKey: "jpeg_encode_failed"]
          )))
          return
        }
        let bounds = scWindow.frame
        completion(.success([
          "data": jpegData.base64EncodedString(),
          "mimeType": "image/jpeg",
          "width": outW,
          "height": outH,
          "windowId": Int64(scWindow.windowID),
          "pid": pid,
          "processToken": WindowInventory.processToken(for: pid) as Any,
          "title": scWindow.title ?? "",
          "boundsPt": [
            "x": Double(bounds.origin.x),
            "y": Double(bounds.origin.y),
            "width": Double(bounds.size.width),
            "height": Double(bounds.size.height),
          ],
          "scaleFactor": Double(scale),
        ]))
      }
    }
  }

  func stopAll() {
    let all = lock.withLock { () -> [ManagedCaptureStream] in
      let vals = Array(streamsById.values)
      streamsById.removeAll()
      return vals
    }
    for s in all {
      s.stop()
    }
  }
}

private extension NSLock {
  func withLock<T>(_ body: () -> T) -> T {
    lock()
    defer { unlock() }
    return body()
  }
}
