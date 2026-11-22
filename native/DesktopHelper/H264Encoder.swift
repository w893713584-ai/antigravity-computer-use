import CoreMedia
import CoreVideo
import Foundation
import VideoToolbox

struct H264EncoderConfigSnapshot: Equatable {
  let codec: String
  let avcCBase64: String
  let codedWidth: Int
  let codedHeight: Int
  let displayWidth: Int
  let displayHeight: Int
  let contentRectPt: [String: Double]
  let sourceCropPx: [String: Int]?
  let geometryVerified: Bool
}

final class H264HardwareEncoder {
  private let streamId: UInt32
  private let encodeQueue = DispatchQueue(label: "io.codexstyle.cua.desktophelper.vt-encode")
  private var session: VTCompressionSession?
  private var width: Int32 = 0
  private var height: Int32 = 0
  private var generation: UInt32 = 0
  private var auSeq: UInt32 = 0
  private var lastConfig: H264EncoderConfigSnapshot?
  private var lastConfigKey: String = ""
  private var invalidated = false
  private var pendingFrames = 0
  private var submittedWithoutOutputCount = 0
  private var firstUnansweredSubmitNs: UInt64 = 0

  private let onConfig: (UInt32, UInt64, [String: Any]) -> Void
  private let onAccessUnit: (UInt32, UInt32, Bool, UInt64, UInt32, Data) -> Void
  private let onError: (String, String) -> Void

  init(
    streamId: UInt32,
    onConfig: @escaping (UInt32, UInt64, [String: Any]) -> Void,
    onAccessUnit: @escaping (UInt32, UInt32, Bool, UInt64, UInt32, Data) -> Void,
    onError: @escaping (String, String) -> Void
  ) {
    self.streamId = streamId
    self.onConfig = onConfig
    self.onAccessUnit = onAccessUnit
    self.onError = onError
  }

  var currentGeneration: UInt32 {
    encodeQueue.sync { generation }
  }

  var isBusy: Bool {
    encodeQueue.sync { pendingFrames > 0 }
  }

  func configure(width newWidth: Int, height newHeight: Int) -> Result<Void, NSError> {
    return encodeQueue.sync {
      guard !invalidated else {
        return .failure(NSError(domain: "H264Encoder", code: -1, userInfo: [NSLocalizedDescriptionKey: "encoder_invalidated"]))
      }
      let evenW = max(2, Int32(newWidth & ~1))
      let evenH = max(2, Int32(newHeight & ~1))
      if session != nil && width == evenW && height == evenH {
        return .success(())
      }

      destroySessionLocked()
      self.width = evenW
      self.height = evenH
      self.lastConfigKey = ""
      self.lastConfig = nil

      let specCandidates: [[String: Any]] = [
        [
          kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder as String: true,
          kVTVideoEncoderSpecification_EnableLowLatencyRateControl as String: true,
        ],
        [
          kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder as String: true,
        ],
      ]

      var createdSession: VTCompressionSession?
      var lastStatus: OSStatus = noErr
      var sawNonHwSession = false
      var lastFailureError: NSError?
      for spec in specCandidates {
        var outSession: VTCompressionSession?
        let st = VTCompressionSessionCreate(
          allocator: kCFAllocatorDefault,
          width: evenW,
          height: evenH,
          codecType: kCMVideoCodecType_H264,
          encoderSpecification: spec as CFDictionary,
          imageBufferAttributes: nil,
          compressedDataAllocator: nil,
          outputCallback: nil,
          refcon: nil,
          compressionSessionOut: &outSession
        )
        guard st == noErr, let s = outSession else {
          lastStatus = st
          continue
        }

        var usingHwPtr: Unmanaged<AnyObject>?
        let hwCheck = VTSessionCopyProperty(
          s,
          key: kVTCompressionPropertyKey_UsingHardwareAcceleratedVideoEncoder,
          allocator: kCFAllocatorDefault,
          valueOut: &usingHwPtr
        )
        let usingHwVal = usingHwPtr?.takeRetainedValue()
        let isHw = (hwCheck == noErr) && ((usingHwVal as? NSNumber)?.boolValue == true)
        guard isHw else {
          sawNonHwSession = true
          VTCompressionSessionInvalidate(s)
          continue
        }

        // Prefer Constrained Baseline AutoLevel, fallback to hardware Baseline AutoLevel.
        let profStatus = VTSessionSetProperty(
          s,
          key: kVTCompressionPropertyKey_ProfileLevel,
          value: kVTProfileLevel_H264_ConstrainedBaseline_AutoLevel
        )
        if profStatus != noErr {
          let baseStatus = VTSessionSetProperty(
            s,
            key: kVTCompressionPropertyKey_ProfileLevel,
            value: kVTProfileLevel_H264_Baseline_AutoLevel
          )
          if baseStatus != noErr {
            VTCompressionSessionInvalidate(s)
            lastFailureError = NSError(
              domain: "H264Encoder",
              code: Int(baseStatus),
              userInfo: [NSLocalizedDescriptionKey: "h264_profile_level_failed:\(baseStatus)"]
            )
            continue
          }
        }

        let requiredProps: [(CFString, CFTypeRef)] = [
          (kVTCompressionPropertyKey_RealTime, kCFBooleanTrue),
          (kVTCompressionPropertyKey_AllowFrameReordering, kCFBooleanFalse),
          (kVTCompressionPropertyKey_AverageBitRate, 2_500_000 as CFNumber),
          (kVTCompressionPropertyKey_MaxKeyFrameInterval, 40 as CFNumber),
          (kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration, 2.0 as CFNumber),
        ]
        var propFailed = false
        for (k, v) in requiredProps {
          let propSt = VTSessionSetProperty(s, key: k, value: v)
          if propSt != noErr {
            VTCompressionSessionInvalidate(s)
            lastFailureError = NSError(
              domain: "H264Encoder",
              code: Int(propSt),
              userInfo: [NSLocalizedDescriptionKey: "vt_required_property_failed:\(k):\(propSt)"]
            )
            propFailed = true
            break
          }
        }
        if propFailed {
          continue
        }

        // Best-effort low-latency hints
        _ = VTSessionSetProperty(s, key: kVTCompressionPropertyKey_ExpectedFrameRate, value: 20 as CFNumber)
        _ = VTSessionSetProperty(s, key: kVTCompressionPropertyKey_PrioritizeEncodingSpeedOverQuality, value: kCFBooleanTrue)

        let prepStatus = VTCompressionSessionPrepareToEncodeFrames(s)
        if prepStatus != noErr {
          VTCompressionSessionInvalidate(s)
          lastFailureError = NSError(
            domain: "H264Encoder",
            code: Int(prepStatus),
            userInfo: [NSLocalizedDescriptionKey: "vt_prepare_failed:\(prepStatus)"]
          )
          continue
        }

        createdSession = s
        break
      }

      guard let s = createdSession else {
        if let err = lastFailureError {
          return .failure(err)
        }
        let msg = sawNonHwSession
          ? "hardware_encoder_required_but_inactive"
          : "hardware_h264_session_create_failed:\(lastStatus)"
        return .failure(
          NSError(
            domain: "H264Encoder",
            code: sawNonHwSession ? -2 : Int(lastStatus),
            userInfo: [NSLocalizedDescriptionKey: msg]
          )
        )
      }

      self.session = s
      self.generation += 1
      self.auSeq = 0
      return .success(())
    }
  }

  func encode(
    pixelBuffer: CVPixelBuffer,
    ptsUs: UInt64,
    durationUs: UInt32,
    forceKeyframe: Bool,
    codedWidth: Int,
    codedHeight: Int,
    displayWidth: Int,
    displayHeight: Int,
    contentRectPt: [String: Double],
    sourceCropPx: [String: Int]? = nil,
    geometryVerified: Bool = true,
    geometryChanged: Bool,
    targetKey: String,
    geometryRev: Int,
    dropIfBusy: Bool
  ) -> Bool {
    var shouldEnqueue = true
    var vtStalled = false
    encodeQueue.sync {
      if invalidated {
        shouldEnqueue = false
        return
      }
      if submittedWithoutOutputCount >= 1 {
        let nowNs = DispatchTime.now().uptimeNanoseconds
        if firstUnansweredSubmitNs > 0 && nowNs &- firstUnansweredSubmitNs > 1_500_000_000 {
          vtStalled = true
          destroySessionLocked()
          pendingFrames = 0
          return
        }
      }
      if dropIfBusy && pendingFrames > 0 {
        shouldEnqueue = false
        return
      }
    }
    if vtStalled {
      onError("vt_stalled_no_output", "VideoToolbox accepted frames for >1.5s without producing output")
      return false
    }
    if !shouldEnqueue { return false }

    if let configErr = configure(width: codedWidth, height: codedHeight).failureError {
      onError("vt_configure_failed", configErr.localizedDescription)
      return false
    }

    var localSession: VTCompressionSession?
    var needForce = forceKeyframe
    var armedDeadlineNs: UInt64 = 0
    encodeQueue.sync {
      guard !invalidated, let s = session else { return }
      localSession = s
      if geometryChanged || lastConfig == nil {
        generation += 1
        auSeq = 0
        lastConfigKey = ""
        needForce = true
      }
      if submittedWithoutOutputCount == 0 {
        let submitNs = DispatchTime.now().uptimeNanoseconds
        firstUnansweredSubmitNs = submitNs
        armedDeadlineNs = submitNs
      }
      submittedWithoutOutputCount += 1
      pendingFrames += 1
    }
    if armedDeadlineNs != 0 {
      encodeQueue.asyncAfter(deadline: .now() + 1.55) { [weak self] in
        guard let self,
              !self.invalidated,
              self.submittedWithoutOutputCount >= 1,
              self.firstUnansweredSubmitNs == armedDeadlineNs else {
          return
        }
        self.destroySessionLocked()
        self.pendingFrames = 0
        self.submittedWithoutOutputCount = 0
        self.firstUnansweredSubmitNs = 0
        DispatchQueue.global(qos: .userInitiated).async {
          self.onError("vt_stalled_no_output", "VideoToolbox accepted a frame for >1.5s without producing output")
        }
      }
    }
    guard let s = localSession else { return false }

    let pts = CMTime(value: Int64(ptsUs), timescale: 1_000_000)
    let dur = durationUs > 0 ? CMTime(value: Int64(durationUs), timescale: 1_000_000) : CMTime.invalid
    let frameProps: CFDictionary? = needForce
      ? ([kVTEncodeFrameOptionKey_ForceKeyFrame as String: true] as CFDictionary)
      : nil

    let status = VTCompressionSessionEncodeFrame(
      s,
      imageBuffer: pixelBuffer,
      presentationTimeStamp: pts,
      duration: dur,
      frameProperties: frameProps,
      infoFlagsOut: nil
    ) { [weak self] cbStatus, _, sampleBuffer in
      guard let self else { return }
      self.encodeQueue.async {
        self.pendingFrames = max(0, self.pendingFrames - 1)
        guard !self.invalidated else { return }
        if cbStatus != noErr {
          self.onError("vt_encode_callback_error", "VideoToolbox encode error \(cbStatus)")
          return
        }
        guard let sampleBuffer else { return }
        self.handleEncodedSampleBufferLocked(
          sampleBuffer,
          ptsUs: ptsUs,
          durationUs: durationUs,
          codedWidth: codedWidth,
          codedHeight: codedHeight,
          displayWidth: displayWidth,
          displayHeight: displayHeight,
          contentRectPt: contentRectPt,
          sourceCropPx: sourceCropPx,
          geometryVerified: geometryVerified,
          targetKey: targetKey,
          geometryRev: geometryRev
        )
      }
    }

    if status != noErr {
      encodeQueue.async { [weak self] in
        guard let self else { return }
        self.pendingFrames = max(0, self.pendingFrames - 1)
        self.submittedWithoutOutputCount = max(0, self.submittedWithoutOutputCount - 1)
        if self.submittedWithoutOutputCount == 0 {
          self.firstUnansweredSubmitNs = 0
        }
        self.onError("vt_encode_submit_error", "VTCompressionSessionEncodeFrame failed \(status)")
      }
      return false
    }
    return true
  }

  private func handleEncodedSampleBufferLocked(
    _ sampleBuffer: CMSampleBuffer,
    ptsUs: UInt64,
    durationUs: UInt32,
    codedWidth: Int,
    codedHeight: Int,
    displayWidth: Int,
    displayHeight: Int,
    contentRectPt: [String: Double],
    sourceCropPx: [String: Int]?,
    geometryVerified: Bool,
    targetKey: String,
    geometryRev: Int
  ) {
    submittedWithoutOutputCount = 0
    firstUnansweredSubmitNs = 0
    guard let fmtDesc = CMSampleBufferGetFormatDescription(sampleBuffer) else {
      return
    }
    guard let parsedFmt = extractH264AvcC(from: fmtDesc) else {
      onError("vt_missing_avcc", "Failed to extract SPS/PPS from format description")
      return
    }
    guard let blockBuf = CMSampleBufferGetDataBuffer(sampleBuffer) else {
      return
    }
    guard let normalizedAu = normalizeAvccAccessUnit(
      blockBuffer: blockBuf,
      nalUnitHeaderLength: parsedFmt.nalUnitHeaderLength
    ) else {
      return
    }

    let cfgSnapshot = H264EncoderConfigSnapshot(
      codec: parsedFmt.codec,
      avcCBase64: parsedFmt.avcC.base64EncodedString(),
      codedWidth: codedWidth,
      codedHeight: codedHeight,
      displayWidth: displayWidth,
      displayHeight: displayHeight,
      contentRectPt: contentRectPt,
      sourceCropPx: sourceCropPx,
      geometryVerified: geometryVerified
    )
    let rectKey = "\(contentRectPt["x"] ?? 0),\(contentRectPt["y"] ?? 0),\(contentRectPt["width"] ?? 0),\(contentRectPt["height"] ?? 0)"
    let cropKey = sourceCropPx.map { "\($0["x"] ?? 0),\($0["y"] ?? 0),\($0["width"] ?? 0),\($0["height"] ?? 0)" } ?? "full"
    let nextConfigKey = "\(parsedFmt.codec)|\(cfgSnapshot.avcCBase64)|\(codedWidth)x\(codedHeight)|\(displayWidth)x\(displayHeight)|\(rectKey)|\(cropKey)|\(geometryVerified ? 1 : 0)|\(targetKey)|\(geometryRev)"

    if nextConfigKey != lastConfigKey {
      if lastConfig != nil {
        // Configuration changed mid-stream: advance generation on an IDR boundary.
        generation += 1
        auSeq = 0
      }
      lastConfig = cfgSnapshot
      lastConfigKey = nextConfigKey
      var cfgObj: [String: Any] = [
        "codec": cfgSnapshot.codec,
        "avcC": cfgSnapshot.avcCBase64,
        "codedWidth": cfgSnapshot.codedWidth,
        "codedHeight": cfgSnapshot.codedHeight,
        "displayWidth": cfgSnapshot.displayWidth,
        "displayHeight": cfgSnapshot.displayHeight,
        "targetKey": targetKey,
        "geometryRev": geometryRev,
        "contentRectPt": contentRectPt,
        "geometryVerified": geometryVerified,
      ]
      if let sourceCropPx {
        cfgObj["sourceCropPx"] = sourceCropPx
      }
      onConfig(generation, ptsUs, cfgObj)
    }

    auSeq &+= 1
    if auSeq == 0 { auSeq = 1 }
    onAccessUnit(
      generation,
      auSeq,
      normalizedAu.containsIdrNal,
      ptsUs,
      durationUs,
      normalizedAu.data
    )
  }

  private func destroySessionLocked() {
    submittedWithoutOutputCount = 0
    firstUnansweredSubmitNs = 0
    if let s = session {
      VTCompressionSessionInvalidate(s)
      session = nil
    }
  }

  func invalidate() {
    encodeQueue.sync {
      invalidated = true
      destroySessionLocked()
    }
  }
}

private extension Result {
  var failureError: Failure? {
    if case .failure(let err) = self { return err }
    return nil
  }
}

private func extractH264AvcC(from fmtDesc: CMFormatDescription) -> (avcC: Data, codec: String, nalUnitHeaderLength: Int32)? {
  var count: Int = 0
  var nalHeaderLen: Int32 = 4
  let countStatus = CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
    fmtDesc,
    parameterSetIndex: 0,
    parameterSetPointerOut: nil,
    parameterSetSizeOut: nil,
    parameterSetCountOut: &count,
    nalUnitHeaderLengthOut: &nalHeaderLen
  )
  guard countStatus == noErr, count > 0 else { return nil }

  var spsList: [Data] = []
  var ppsList: [Data] = []

  for idx in 0..<count {
    var ptr: UnsafePointer<UInt8>?
    var size: Int = 0
    let st = CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
      fmtDesc,
      parameterSetIndex: idx,
      parameterSetPointerOut: &ptr,
      parameterSetSizeOut: &size,
      parameterSetCountOut: nil,
      nalUnitHeaderLengthOut: nil
    )
    guard st == noErr, let p = ptr, size > 0 else { continue }
    let nalData = Data(bytes: p, count: size)
    let nalType = nalData[0] & 0x1F
    if nalType == 7 {
      spsList.append(nalData)
    } else if nalType == 8 {
      ppsList.append(nalData)
    }
  }

  guard let primarySps = spsList.first, primarySps.count >= 4, !ppsList.isEmpty else {
    return nil
  }

  let profileIdc = primarySps[1]
  let profileCompat = primarySps[2]
  let levelIdc = primarySps[3]
  let codec = String(format: "avc1.%02x%02x%02x", profileIdc, profileCompat, levelIdc)

  var avcC = Data()
  avcC.append(1) // configurationVersion
  avcC.append(profileIdc)
  avcC.append(profileCompat)
  avcC.append(levelIdc)
  avcC.append(0xFF) // 6 bits reserved (111111) + lengthSizeMinusOne (3 -> 4-byte lengths)
  avcC.append(UInt8(0xE0 | (min(spsList.count, 31) & 0x1F)))
  for sps in spsList.prefix(31) {
    let len = UInt16(sps.count).bigEndian
    withUnsafeBytes(of: len) { avcC.append(contentsOf: $0) }
    avcC.append(sps)
  }
  avcC.append(UInt8(min(ppsList.count, 255) & 0xFF))
  for pps in ppsList.prefix(255) {
    let len = UInt16(pps.count).bigEndian
    withUnsafeBytes(of: len) { avcC.append(contentsOf: $0) }
    avcC.append(pps)
  }

  return (avcC, codec, nalHeaderLen)
}

private func normalizeAvccAccessUnit(
  blockBuffer: CMBlockBuffer,
  nalUnitHeaderLength: Int32
) -> (data: Data, containsIdrNal: Bool)? {
  let lenFieldBytes = Int(nalUnitHeaderLength)
  guard [1, 2, 4].contains(lenFieldBytes) else { return nil }

  let totalLen = CMBlockBufferGetDataLength(blockBuffer)
  guard totalLen > lenFieldBytes else { return nil }

  var raw = Data(count: totalLen)
  let copyStatus = raw.withUnsafeMutableBytes { rawPtr -> OSStatus in
    guard let base = rawPtr.baseAddress else { return kCMBlockBufferBadLengthParameterErr }
    return CMBlockBufferCopyDataBytes(blockBuffer, atOffset: 0, dataLength: totalLen, destination: base)
  }
  guard copyStatus == kCMBlockBufferNoErr else { return nil }

  var containsIdr = false
  var offset = 0
  var normalized = lenFieldBytes == 4 ? Data() : Data(capacity: totalLen + 32)

  while offset + lenFieldBytes <= totalLen {
    var nalSize = 0
    for i in 0..<lenFieldBytes {
      nalSize = (nalSize << 8) | Int(raw[offset + i])
    }
    offset += lenFieldBytes
    guard nalSize > 0, offset + nalSize <= totalLen else {
      return nil
    }
    let nalType = raw[offset] & 0x1F
    if nalType == 5 {
      containsIdr = true
    }
    if lenFieldBytes != 4 {
      var lenBE = UInt32(nalSize).bigEndian
      withUnsafeBytes(of: &lenBE) { normalized.append(contentsOf: $0) }
      normalized.append(raw[offset..<(offset + nalSize)])
    }
    offset += nalSize
  }

  guard offset == totalLen else { return nil }
  return (lenFieldBytes == 4 ? raw : normalized, containsIdr)
}
