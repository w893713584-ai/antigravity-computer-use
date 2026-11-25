(function (root) {
  "use strict";

  var MAGIC = "CUV1";
  var HEADER_BYTES = 40;
  var PACKET_CONFIG = 1;
  var PACKET_ACCESS_UNIT = 2;
  var PACKET_STATUS = 3;
  var AU_FLAG_IDR = 0x01;

  function computeContainDisplayRect(containerWidth, containerHeight, contentWidth, contentHeight) {
    var cw = Number(containerWidth);
    var ch = Number(containerHeight);
    var vw = Number(contentWidth);
    var vh = Number(contentHeight);
    if (!(cw > 0) || !(ch > 0) || !(vw > 0) || !(vh > 0)) return null;
    var scale = Math.min(cw / vw, ch / vh);
    var width = vw * scale;
    var height = vh * scale;
    return {
      x: (cw - width) / 2,
      y: (ch - height) / 2,
      width: width,
      height: height,
    };
  }

  function pointerToNormalizedContent(offsetX, offsetY, visibleRect) {
    if (!visibleRect || !(visibleRect.width > 0) || !(visibleRect.height > 0)) {
      return null;
    }
    var relX = (Number(offsetX) - Number(visibleRect.x)) / Number(visibleRect.width);
    var relY = (Number(offsetY) - Number(visibleRect.y)) / Number(visibleRect.height);
    if (!Number.isFinite(relX) || !Number.isFinite(relY)) return null;
    if (relX < 0 || relX > 1 || relY < 0 || relY > 1) return null;
    return { normX: relX, normY: relY };
  }

  function projectCursor(windowPointPt, previewContentRectPt) {
    if (
      !windowPointPt ||
      !previewContentRectPt ||
      !Number.isFinite(Number(windowPointPt.x)) ||
      !Number.isFinite(Number(windowPointPt.y)) ||
      !(Number(previewContentRectPt.width) > 0) ||
      !(Number(previewContentRectPt.height) > 0)
    ) {
      return { visible: false, normX: null, normY: null };
    }
    var normX = (Number(windowPointPt.x) - Number(previewContentRectPt.x)) / Number(previewContentRectPt.width);
    var normY = (Number(windowPointPt.y) - Number(previewContentRectPt.y)) / Number(previewContentRectPt.height);
    if (normX < -0.02 || normX > 1.02 || normY < -0.02 || normY > 1.02) {
      return { visible: false, normX: null, normY: null };
    }
    return {
      visible: true,
      normX: Math.max(0, Math.min(1, normX)),
      normY: Math.max(0, Math.min(1, normY)),
    };
  }

  function base64ToUint8Array(b64) {
    var bin = atob(String(b64 || ""));
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i += 1) {
      out[i] = bin.charCodeAt(i);
    }
    return out;
  }

  function decodeCuv1Packet(arrayBuffer) {
    if (!arrayBuffer || arrayBuffer.byteLength < HEADER_BYTES) return null;
    var bytes = new Uint8Array(arrayBuffer);
    if (
      String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) !== MAGIC
    ) {
      return null;
    }
    var view = new DataView(arrayBuffer, 0, HEADER_BYTES);
    var type = view.getUint8(4);
    var flags = view.getUint8(5);
    var headerBytes = view.getUint16(6, false);
    if (headerBytes !== HEADER_BYTES) return null;
    var streamId = view.getUint32(8, false);
    var generation = view.getUint32(12, false);
    var seq = view.getUint32(16, false);
    var payloadBytes = view.getUint32(20, false);
    var ptsHi = view.getUint32(24, false);
    var ptsLo = view.getUint32(28, false);
    var ptsUs = ptsHi * 4294967296 + ptsLo;
    var durationUs = view.getUint32(32, false);
    var reserved = view.getUint32(36, false);
    if (reserved !== 0 || HEADER_BYTES + payloadBytes !== bytes.byteLength) {
      return null;
    }
    return {
      type: type,
      flags: flags,
      isIdr: type === PACKET_ACCESS_UNIT && (flags & AU_FLAG_IDR) !== 0,
      streamId: streamId,
      generation: generation,
      seq: seq,
      payloadBytes: payloadBytes,
      ptsUs: ptsUs,
      durationUs: durationUs,
      payload: bytes.subarray(HEADER_BYTES),
    };
  }

  function randomViewId() {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return "view-" + crypto.randomUUID();
    }
    return "view-" + Date.now() + "-" + Math.random().toString(16).slice(2, 10);
  }

  function PreviewVideoController(opts) {
    this.canvas = opts.canvas;
    this.ctx = this.canvas.getContext("2d");
    this.apiPost = opts.apiPost;
    this.getToken = opts.getToken || function () { return ""; };
    this.getBrokerBootId = opts.getBrokerBootId || function () { return ""; };
    this.onH264Frame = opts.onH264Frame || function () {};
    this.onTransportChange = opts.onTransportChange || function () {};

    this.viewId = randomViewId();
    this.targetKey = null;
    this.mode = "jpeg";
    this.fallbackReason = null;
    this.suppressedUntilCapabilityChange = false;
    this.streamId = 0;
    this.configuredGeneration = 0;
    this.latestConfig = null;
    this.ws = null;
    this.decoder = null;
    this.awaitIdr = true;
    this.expectNextSeq = 1;
    this.hasDrawnFirstFrame = false;
    this.renderedGeneration = 0;
    this.awaitingRecovery = false;
    this.firstFrameTimer = null;
    this.recoveryTimer = null;
    this.retryNotBeforeAt = 0;
    this.retryCooldownMs = opts.retryCooldownMs > 0 ? Number(opts.retryCooldownMs) : 5000;
    this.epoch = 0;
    this.hadServerView = false;
    this.pendingSeqForNextOutput = 0;
    this.pendingSeqQueue = [];
  }

  PreviewVideoController.prototype.isWebCodecsSupported = function () {
    return {
      ok: Boolean(
        root.isSecureContext &&
          typeof root.VideoDecoder === "function" &&
          typeof root.EncodedVideoChunk === "function"
      ),
      reason: !root.isSecureContext ? "insecure_context" : "webcodecs_unavailable",
    };
  };

  PreviewVideoController.prototype.resetCapabilitySuppression = function () {
    this.suppressedUntilCapabilityChange = false;
    this.retryNotBeforeAt = 0;
  };

  PreviewVideoController.prototype.clearTimers = function () {
    if (this.firstFrameTimer) {
      clearTimeout(this.firstFrameTimer);
      this.firstFrameTimer = null;
    }
    if (this.recoveryTimer) {
      clearTimeout(this.recoveryTimer);
      this.recoveryTimer = null;
    }
  };

  PreviewVideoController.prototype.closeDecoder = function () {
    if (this.decoder) {
      try {
        if (this.decoder.state !== "closed") {
          this.decoder.close();
        }
      } catch (_e) {}
      this.decoder = null;
    }
    this.pendingSeqQueue = [];
  };

  PreviewVideoController.prototype.closeWs = function () {
    if (this.ws) {
      try {
        this.ws.onopen = null;
        this.ws.onmessage = null;
        this.ws.onerror = null;
        this.ws.onclose = null;
        if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
          this.ws.close(1000, "switch");
        }
      } catch (_e) {}
      this.ws = null;
    }
  };

  PreviewVideoController.prototype.unsubscribeServer = function (reason, useKeepalive) {
    if (!this.hadServerView) return;
    this.hadServerView = false;
    var payload = {
      viewId: this.viewId,
      brokerBootId: this.getBrokerBootId(),
      action: "unsubscribe",
      reason: reason || "stop",
    };
    if (useKeepalive && typeof root.fetch === "function") {
      try {
        var tok = this.getToken ? this.getToken() : "";
        var url = "/api/video/control" + (tok ? "?token=" + encodeURIComponent(tok) : "");
        root
          .fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
            keepalive: true,
          })
          .catch(function () {});
        return;
      } catch (_e) {}
    }
    if (this.apiPost) {
      this.apiPost("/api/video/control", payload).catch(function () {});
    }
  };

  PreviewVideoController.prototype.stop = function (reason) {
    this.epoch += 1;
    this.clearTimers();
    this.closeWs();
    this.closeDecoder();
    if (
      reason === "pane_hidden" ||
      reason === "pagehide" ||
      reason === "superseded" ||
      reason === "no_target"
    ) {
      this.unsubscribeServer(reason, reason === "pagehide");
    }
    this.streamId = 0;
    this.configuredGeneration = 0;
    this.renderedGeneration = 0;
    this.latestConfig = null;
    this.hasDrawnFirstFrame = false;
    this.awaitIdr = true;
    this.awaitingRecovery = false;
    this.mode = "jpeg";
    this.fallbackReason = reason || null;
  };

  PreviewVideoController.prototype.triggerFallback = function (reason, suppress) {
    var curTarget = this.targetKey;
    var curStreamId = this.streamId;
    var epochNow = this.epoch;
    this.stop(reason);
    if (suppress) {
      this.suppressedUntilCapabilityChange = true;
    } else {
      this.retryNotBeforeAt = Date.now() + this.retryCooldownMs;
    }
    this.onTransportChange({ mode: "jpeg", reason: reason, targetKey: curTarget });
    if (curStreamId && this.apiPost) {
      this.apiPost("/api/video/control", {
        viewId: this.viewId,
        brokerBootId: this.getBrokerBootId(),
        action: "fallback",
        streamId: curStreamId,
        reason: reason,
      }).catch(function () {});
    }
    return epochNow;
  };

  PreviewVideoController.prototype.syncTarget = function (opts) {
    var nextKey = (opts && opts.targetKey) || "";
    var activeApp = (opts && opts.activeApp) || "";
    var streamPaused = Boolean(opts && opts.streamPaused);

    if (!activeApp || !nextKey || streamPaused) {
      if (this.targetKey || this.mode !== "jpeg") {
        this.targetKey = null;
        this.suppressedUntilCapabilityChange = false;
        this.retryNotBeforeAt = 0;
        this.stop("no_target");
        this.onTransportChange({ mode: streamPaused ? "paused" : "jpeg", reason: null, targetKey: null });
      }
      return;
    }

    if (nextKey !== this.targetKey) {
      this.targetKey = nextKey;
      this.suppressedUntilCapabilityChange = false;
      this.retryNotBeforeAt = 0;
      this.subscribe(nextKey);
      return;
    }

    if (
      this.mode === "jpeg" &&
      !this.suppressedUntilCapabilityChange &&
      Date.now() >= this.retryNotBeforeAt &&
      !this.ws
    ) {
      this.subscribe(nextKey);
    }
  };

  PreviewVideoController.prototype.subscribe = function (targetKey) {
    var self = this;
    this.stop("resubscribe");
    var myEpoch = this.epoch;
    var support = this.isWebCodecsSupported();
    if (!support.ok) {
      this.suppressedUntilCapabilityChange = true;
      this.onTransportChange({ mode: "jpeg", reason: support.reason, targetKey: targetKey });
      this.hadServerView = true;
      this.apiPost("/api/video/subscribe", {
        viewId: this.viewId,
        targetKey: targetKey,
        brokerBootId: this.getBrokerBootId(),
        supportsWebCodecs: false,
        webCodecsReason: support.reason,
      }).catch(function () {});
      return;
    }

    this.mode = "probe";
    this.hadServerView = true;
    this.onTransportChange({ mode: "jpeg", reason: "probing_h264", targetKey: targetKey });

    this.apiPost("/api/video/subscribe", {
      viewId: this.viewId,
      targetKey: targetKey,
      brokerBootId: this.getBrokerBootId(),
      supportsWebCodecs: true,
    })
      .then(function (res) {
        if (myEpoch !== self.epoch || self.targetKey !== targetKey) return;
        if (!res || res.mode !== "probe" || !res.wsPath) {
          var r = (res && res.reason) || "jpeg_only";
          var perm =
            r === "screen_recording_not_granted" ||
            r === "webcodecs_unavailable" ||
            r === "codec_unsupported" ||
            r === "video_rollback_jpeg";
          if (perm) self.suppressedUntilCapabilityChange = true;
          else self.retryNotBeforeAt = Date.now() + self.retryCooldownMs;
          self.mode = "jpeg";
          self.fallbackReason = r;
          self.onTransportChange({ mode: "jpeg", reason: r, targetKey: targetKey });
          return;
        }
        self.streamId = Number(res.streamId || 0);
        self.connectWebSocket(res.wsPath, targetKey, myEpoch, Number(res.firstFrameTimeoutMs) || 2000);
      })
      .catch(function () {
        if (myEpoch !== self.epoch) return;
        self.triggerFallback("subscribe_error", false);
      });
  };

  PreviewVideoController.prototype.connectWebSocket = function (wsPath, targetKey, myEpoch, timeoutMs) {
    var self = this;
    var proto = root.location.protocol === "https:" ? "wss:" : "ws:";
    var wsUrl = proto + "//" + root.location.host + wsPath;
    var ws;
    try {
      ws = new WebSocket(wsUrl, ["cua.h264.v1"]);
    } catch (_e) {
      this.triggerFallback("ws_construct_failed", false);
      return;
    }
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    this.firstFrameTimer = setTimeout(function () {
      self.firstFrameTimer = null;
      if (myEpoch === self.epoch && !self.hasDrawnFirstFrame) {
        self.triggerFallback("first_frame_timeout", false);
      }
    }, timeoutMs);

    ws.onmessage = function (ev) {
      if (myEpoch !== self.epoch || !(ev.data instanceof ArrayBuffer)) return;
      var pkt = decodeCuv1Packet(ev.data);
      if (!pkt || pkt.streamId !== self.streamId) return;
      if (pkt.type === PACKET_CONFIG) {
        self.handleConfigPacket(pkt, myEpoch);
      } else if (pkt.type === PACKET_ACCESS_UNIT) {
        self.handleAccessUnitPacket(pkt, myEpoch);
      }
    };

    ws.onerror = function () {
      if (myEpoch === self.epoch) {
        self.triggerFallback("ws_error", false);
      }
    };

    ws.onclose = function () {
      if (myEpoch === self.epoch && self.mode !== "jpeg") {
        self.triggerFallback("ws_closed", false);
      }
    };
  };

  PreviewVideoController.prototype.handleConfigPacket = function (pkt, myEpoch) {
    var self = this;
    var cfg;
    try {
      cfg = JSON.parse(new TextDecoder("utf-8").decode(pkt.payload));
    } catch (_e) {
      this.triggerFallback("invalid_config_json", false);
      return;
    }
    var avcCBytes;
    try {
      avcCBytes = base64ToUint8Array(cfg.avcC);
    } catch (_e2) {
      this.triggerFallback("invalid_avcc_base64", false);
      return;
    }

    var decoderCfg = {
      codec: cfg.codec,
      codedWidth: Number(cfg.codedWidth),
      codedHeight: Number(cfg.codedHeight),
      description: avcCBytes,
      optimizeForLatency: true,
    };

    root.VideoDecoder.isConfigSupported(decoderCfg)
      .then(function (support) {
        if (myEpoch !== self.epoch) return;
        if (!support || !support.supported) {
          self.triggerFallback("codec_unsupported", true);
          return;
        }
        self.latestConfig = cfg;
        self.configuredGeneration = pkt.generation;
        self.awaitIdr = true;
        self.expectNextSeq = 1;

        self.closeDecoder();
        self.decoder = new root.VideoDecoder({
          output: function (videoFrame) {
            try {
              if (myEpoch !== self.epoch || self.targetKey !== cfg.targetKey) {
                return;
              }
              var outSeq = self.pendingSeqQueue.shift() || self.pendingSeqForNextOutput || 1;
              var crop = cfg && cfg.sourceCropPx;
              var hasCrop = Boolean(crop && Number(crop.width) > 0 && Number(crop.height) > 0);
              var w = hasCrop
                ? Number(crop.width)
                : Number(cfg.codedWidth) || videoFrame.displayWidth || videoFrame.codedWidth;
              var h = hasCrop
                ? Number(crop.height)
                : Number(cfg.codedHeight) || videoFrame.displayHeight || videoFrame.codedHeight;
              if (w > 0 && h > 0 && (self.canvas.width !== w || self.canvas.height !== h)) {
                self.canvas.width = w;
                self.canvas.height = h;
              }
              if (hasCrop) {
                self.ctx.drawImage(
                  videoFrame,
                  Number(crop.x) || 0,
                  Number(crop.y) || 0,
                  w,
                  h,
                  0,
                  0,
                  self.canvas.width,
                  self.canvas.height
                );
              } else {
                self.ctx.drawImage(videoFrame, 0, 0, self.canvas.width, self.canvas.height);
              }

              var frameRef = {
                transport: "h264",
                brokerBootId: self.getBrokerBootId(),
                viewId: self.viewId || null,
                streamId: self.streamId,
                generation: pkt.generation,
                seq: outSeq,
                targetKey: cfg.targetKey,
                geometryRev: Number(cfg.geometryRev) || 1,
                windowId: null,
              };
              self.onH264Frame({
                frameRef: frameRef,
                codedWidth: w,
                codedHeight: h,
                contentRectPt: cfg.contentRectPt || null,
              });

              if (!self.hasDrawnFirstFrame || self.awaitingRecovery || self.renderedGeneration !== pkt.generation) {
                self.hasDrawnFirstFrame = true;
                self.awaitingRecovery = false;
                self.renderedGeneration = pkt.generation;
                self.mode = "h264";
                self.clearTimers();
                self.onTransportChange({ mode: "h264", reason: null, targetKey: self.targetKey });
                self.apiPost("/api/video/control", {
                  viewId: self.viewId,
                  brokerBootId: self.getBrokerBootId(),
                  action: "rendered",
                  streamId: self.streamId,
                  generation: pkt.generation,
                  seq: outSeq,
                }).catch(function () {});
              }
            } finally {
              try {
                videoFrame.close();
              } catch (_closeErr) {}
            }
          },
          error: function () {
            if (myEpoch === self.epoch) {
              self.closeDecoder();
              self.triggerFallback("decoder_runtime_error", false);
            }
          },
        });
        self.decoder.configure(decoderCfg);
        self.mode = "decode_ready";
        self.apiPost("/api/video/control", {
          viewId: self.viewId,
          brokerBootId: self.getBrokerBootId(),
          action: "decode_ready",
          streamId: self.streamId,
          generation: pkt.generation,
        }).catch(function () {});
      })
      .catch(function () {
        if (myEpoch === self.epoch) {
          self.triggerFallback("codec_probe_error", true);
        }
      });
  };

  PreviewVideoController.prototype.requestIdrRecovery = function (myEpoch) {
    var self = this;
    this.awaitIdr = true;
    this.awaitingRecovery = true;
    if (!this.recoveryTimer) {
      this.recoveryTimer = setTimeout(function () {
        self.recoveryTimer = null;
        if (myEpoch === self.epoch && self.awaitingRecovery) {
          self.triggerFallback("idr_recovery_timeout", false);
        }
      }, 1000);
    }
    this.apiPost("/api/video/control", {
      viewId: this.viewId,
      brokerBootId: this.getBrokerBootId(),
      action: "need_idr",
      streamId: this.streamId,
      generation: this.configuredGeneration,
    }).catch(function () {});
  };

  PreviewVideoController.prototype.handleAccessUnitPacket = function (pkt, myEpoch) {
    if (!this.decoder || this.decoder.state !== "configured") return;
    if (pkt.generation !== this.configuredGeneration) return;

    if (this.decoder.decodeQueueSize > 4) {
      this.requestIdrRecovery(myEpoch);
      return;
    }

    if (pkt.isIdr) {
      this.awaitIdr = false;
      this.awaitingRecovery = false;
      if (this.recoveryTimer) {
        clearTimeout(this.recoveryTimer);
        this.recoveryTimer = null;
      }
      this.expectNextSeq = pkt.seq;
    } else if (this.awaitIdr) {
      return;
    } else if (pkt.seq !== this.expectNextSeq) {
      this.requestIdrRecovery(myEpoch);
      return;
    }

    this.expectNextSeq = pkt.seq + 1;
    this.pendingSeqForNextOutput = pkt.seq;
    this.pendingSeqQueue.push(pkt.seq);
    if (this.pendingSeqQueue.length > 16) {
      this.pendingSeqQueue.shift();
    }

    try {
      var chunk = new root.EncodedVideoChunk({
        type: pkt.isIdr ? "key" : "delta",
        timestamp: pkt.ptsUs,
        duration: pkt.durationUs > 0 ? pkt.durationUs : undefined,
        data: pkt.payload,
      });
      this.decoder.decode(chunk);
    } catch (_e) {
      this.triggerFallback("chunk_decode_throw", false);
    }
  };

  root.CUAPreviewVideo = {
    computeContainDisplayRect: computeContainDisplayRect,
    pointerToNormalizedContent: pointerToNormalizedContent,
    projectCursor: projectCursor,
    decodeCuv1Packet: decodeCuv1Packet,
    PreviewVideoController: PreviewVideoController,
  };
})(window);
