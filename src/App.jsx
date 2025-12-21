// src/App.jsx
import React, { useCallback, useEffect, useRef, useState } from "react";

/**
 * ⚠️ 보안 주의:
 * 브라우저/렌더러에서 OpenAI API Key를 직접 쓰는 건 데모/개발에서만 권장.
 * 프로덕션은 서버에서 Ephemeral Key 발급 후 연결하세요.
 */

const REALTIME_MODEL = "gpt-realtime";
const WS_URL = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(
  REALTIME_MODEL
)}`;

const TARGET_SR = 24000;

// ---- Snapshot / Fall monitor config ----
const SNAPSHOT_FPS = 1; // 1초에 1장
const SNAP_W = 320;
const SNAP_H = 180;
const SNAP_JPEG_QUALITY = 0.6;

// 낙상 판정이 연속 3회 나오면 ALERT
const FALL_FRAMES_REQUIRED = 3;

// ALERT 이후 “정상”이 연속 N회 나오면 OK로 복구
const STANDING_FRAMES_TO_CLEAR = 5;

// 낙상 알림 음성(로컬 스피커) 쿨다운
const FALL_ALERT_COOLDOWN_MS = 15_000;

// 웹으로 상태 신호 전송(옵션)
const FALL_WEBHOOK_URL = import.meta.env.VITE_FALL_WEBHOOK_URL || "";
const FALL_WEBHOOK_TOKEN = import.meta.env.VITE_FALL_WEBHOOK_TOKEN || "";
const DEVICE_ID = import.meta.env.VITE_DEVICE_ID || "homecam-001";

// 웹 상태 하트비트(옵션)
const WEB_HEARTBEAT_MS = 30_000;

// ---------------- Base64 helpers (audio) ----------------
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function base64ToUint8Array(base64) {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function pcm16BytesToFloat32(pcmBytes) {
  const view = new DataView(
    pcmBytes.buffer,
    pcmBytes.byteOffset,
    pcmBytes.byteLength
  );
  const sampleCount = Math.floor(pcmBytes.byteLength / 2);
  const out = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    const s = view.getInt16(i * 2, true);
    out[i] = s / 32768;
  }
  return out;
}

function float32ToPcm16ArrayBuffer(float32) {
  const buffer = new ArrayBuffer(float32.length * 2);
  const view = new DataView(buffer);
  let offset = 0;
  for (let i = 0; i < float32.length; i++, offset += 2) {
    let s = Math.max(-1, Math.min(1, float32[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buffer;
}

// ⭐ 핵심: 브라우저 입력 SR(보통 48000)을 24000으로 다운샘플
function downsampleFloat32(input, inputRate, outputRate) {
  if (inputRate === outputRate) return input;

  const ratio = inputRate / outputRate;
  const outLen = Math.max(1, Math.round(input.length / ratio));
  const out = new Float32Array(outLen);

  for (let i = 0; i < outLen; i++) {
    const idx = i * ratio;
    const idx0 = Math.floor(idx);
    const idx1 = Math.min(idx0 + 1, input.length - 1);
    const frac = idx - idx0;
    out[i] = input[idx0] * (1 - frac) + input[idx1] * frac;
  }
  return out;
}

function rmsLevel(float32) {
  let sum = 0;
  for (let i = 0; i < float32.length; i++) sum += float32[i] * float32[i];
  return Math.sqrt(sum / Math.max(1, float32.length));
}

function safeJsonParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

export default function App() {
  const [status, setStatus] = useState("초기화 중...");
  const [connected, setConnected] = useState(false);

  // ✅ Mic Capture(항상 ON) / Mic Send(전송 ON/OFF) 분리
  const [micOn, setMicOn] = useState(false); // 캡처 파이프라인 상태
  const [micSendOn, setMicSendOn] = useState(true); // 전송 스위치(버튼이 제어)
  const micSendOnRef = useRef(true);
  useEffect(() => {
    micSendOnRef.current = micSendOn;
  }, [micSendOn]);

  const [logs, setLogs] = useState([]);

  const [autoVoiceMode, setAutoVoiceMode] = useState(true); // 서버 VAD 기반 자동 대화
  const [playModelAudio, setPlayModelAudio] = useState(true);
  const [micLevel, setMicLevel] = useState(0);
  const [inSampleRate, setInSampleRate] = useState(null);

  const [aiFallMonitorOn, setAiFallMonitorOn] = useState(true);

  // Camera
  const videoRef = useRef(null);
  const streamRef = useRef(null);

  // Snapshot offscreen canvas
  const snapCanvasRef = useRef(null);

  // WS
  const wsRef = useRef(null);

  // Audio In (mic capture -> ws send)
  const audioInCtxRef = useRef(null);
  const micSourceRef = useRef(null);
  const micProcessorRef = useRef(null);
  const micZeroGainRef = useRef(null);

  // Audio Out (ws -> speakers)
  const audioOutCtxRef = useRef(null);
  const outGainRef = useRef(null);
  const nextPlayTimeRef = useRef(0);
  const playingSourcesRef = useRef([]);

  // response state
  const activeResponseIdRef = useRef(null);

  // session state
  const sessionReadyRef = useRef(false);
  const pendingAutoStartMicRef = useRef(false); // “세션/WS 준비되면 clear 등 할 것” 플래그

  // speech state
  const userSpeakingRef = useRef(false);
  const hadSpeechSinceLastCommitRef = useRef(false);
  const lastAutoCommitTsRef = useRef(0);

  // throttle mic meter update
  const lastMeterTsRef = useRef(0);

  // response routing
  const pendingNextResponseKindRef = useRef(null); // "fall_check" | "fall_alert" | "user_reply"
  const responseKindMapRef = useRef(new Map());
  const responseTextMapRef = useRef(new Map());

  // fall alert cooldown + state
  const lastFallAlertTsRef = useRef(0);
  const lastFallStateRef = useRef("unknown");

  // fall streak + web status
  const fallStreakRef = useRef(0);
  const standingStreakRef = useRef(0);
  const alertActiveRef = useRef(false);
  const lastWebPostTsRef = useRef(0);
  const lastWebStatusRef = useRef(null);

  // in-flight guard for fall check
  const fallCheckInFlightRef = useRef(false);

  // ✅ USB 웹캠(비디오)와 같은 groupId의 마이크 고정
  const preferredVideoIdRef = useRef(null);
  const preferredAudioIdRef = useRef(null);
  const preferredGroupIdRef = useRef(null);

  // ✅ 미디어 자동 복구
  const mediaRecoverTimerRef = useRef(null);
  const mediaRecoverAttemptRef = useRef(0);
  const mediaRecoverInFlightRef = useRef(false);

  // ✅ WS 자동 재연결
  const reconnectTimerRef = useRef(null);
  const reconnectAttemptRef = useRef(0);
  const autoReconnectRef = useRef(true);

  // ✅ 컴포넌트 생명주기 가드
  const destroyedRef = useRef(false);

  const pushLog = useCallback((msg) => {
    setLogs((prev) => [...prev, `[${new Date().toLocaleTimeString()}] ${msg}`]);
  }, []);

  const sendEvent = useCallback((obj) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(obj));
  }, []);

  // ---------------- Web notify (webhook) ----------------
  const postWebStatus = useCallback(
    async (statusKind, extra = {}) => {
      if (!FALL_WEBHOOK_URL) return;

      const now = Date.now();
      if (now - lastWebPostTsRef.current < 1000) return;
      lastWebPostTsRef.current = now;

      const payload = {
        device_id: DEVICE_ID,
        status: statusKind, // "ok" | "alert"
        ts: new Date().toISOString(),
        ...extra,
      };

      try {
        const res = await fetch(FALL_WEBHOOK_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-device-id": DEVICE_ID,
            ...(FALL_WEBHOOK_TOKEN
              ? { Authorization: `Bearer ${FALL_WEBHOOK_TOKEN}` }
              : {}),
          },
          body: JSON.stringify(payload),
        });

        if (!res.ok) {
          const t = await res.text().catch(() => "");
          throw new Error(`HTTP ${res.status} ${t}`.trim());
        }

        lastWebStatusRef.current = statusKind;
        pushLog(`🌐 web notify: ${statusKind}`);
      } catch (e) {
        pushLog(`🌐 web notify 실패: ${e?.message || e}`);
      }
    },
    [pushLog]
  );

  const maybePostWebStatusChanged = useCallback(
    (statusKind, extra = {}) => {
      if (lastWebStatusRef.current !== statusKind) {
        postWebStatus(statusKind, extra);
      }
    },
    [postWebStatus]
  );

  // ---------------- Snapshot helpers ----------------
  const captureSnapshotDataUrl = useCallback(() => {
    const video = videoRef.current;
    if (!video) return null;
    if (video.readyState < 2) return null;

    if (!snapCanvasRef.current) {
      snapCanvasRef.current = document.createElement("canvas");
    }
    const c = snapCanvasRef.current;
    c.width = SNAP_W;
    c.height = SNAP_H;

    const ctx = c.getContext("2d");
    if (!ctx) return null;

    ctx.drawImage(video, 0, 0, SNAP_W, SNAP_H);
    return c.toDataURL("image/jpeg", SNAP_JPEG_QUALITY);
  }, []);

  const attachSnapshotToConversation = useCallback(
    (dataUrl, text = "현재 웹캠 스냅샷입니다.") => {
      if (!dataUrl) return;
      sendEvent({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [
            { type: "input_image", image_url: dataUrl },
            { type: "input_text", text },
          ],
        },
      });
    },
    [sendEvent]
  );

  // ---------------- Audio Out ----------------
  const ensureAudioOut = useCallback(async () => {
    if (!audioOutCtxRef.current) {
      audioOutCtxRef.current = new (window.AudioContext ||
        window.webkitAudioContext)();
      outGainRef.current = audioOutCtxRef.current.createGain();
      outGainRef.current.gain.value = 1.0;
      outGainRef.current.connect(audioOutCtxRef.current.destination);
      nextPlayTimeRef.current = audioOutCtxRef.current.currentTime;
    }
    if (audioOutCtxRef.current.state !== "running") {
      await audioOutCtxRef.current.resume();
    }
  }, []);

  const stopAllOutputAudio = useCallback(() => {
    try {
      for (const src of playingSourcesRef.current) {
        try {
          src.stop();
        } catch {}
      }
    } finally {
      playingSourcesRef.current = [];
      if (audioOutCtxRef.current) {
        nextPlayTimeRef.current = audioOutCtxRef.current.currentTime;
      }
    }
  }, []);

  const enqueueModelAudioChunk = useCallback(
    async (base64Audio) => {
      if (!playModelAudio) return;

      try {
        await ensureAudioOut();
      } catch {
        return;
      }

      const pcmBytes = base64ToUint8Array(base64Audio);
      const float32 = pcm16BytesToFloat32(pcmBytes);

      const audioCtx = audioOutCtxRef.current;
      if (!audioCtx) return;

      const buffer = audioCtx.createBuffer(1, float32.length, TARGET_SR);
      buffer.copyToChannel(float32, 0);

      const src = audioCtx.createBufferSource();
      src.buffer = buffer;
      src.connect(outGainRef.current);

      const startAt = Math.max(audioCtx.currentTime, nextPlayTimeRef.current);
      src.start(startAt);
      nextPlayTimeRef.current = startAt + buffer.duration;

      playingSourcesRef.current.push(src);
      src.onended = () => {
        playingSourcesRef.current = playingSourcesRef.current.filter(
          (s) => s !== src
        );
      };
    },
    [ensureAudioOut, playModelAudio]
  );

  // ---------------- Mic capture (항상 ON) ----------------
  // ✅ state 토글 없이 노드만 정리하는 내부 함수(중요)
  const teardownMicNodesOnly = useCallback(() => {
    try {
      if (micProcessorRef.current) {
        micProcessorRef.current.disconnect();
        micProcessorRef.current.onaudioprocess = null;
        micProcessorRef.current = null;
      }
      if (micSourceRef.current) {
        micSourceRef.current.disconnect();
        micSourceRef.current = null;
      }
      if (micZeroGainRef.current) {
        micZeroGainRef.current.disconnect();
        micZeroGainRef.current = null;
      }
    } catch {}
  }, []);

  // ✅ 기존 stopMicCaptureHard는 유지하되, 내부에서는 teardown를 쓰게끔 변경(선택)
  const stopMicCaptureHard = useCallback(() => {
    teardownMicNodesOnly();
    setMicOn(false);
    setMicLevel(0);
    pushLog("🎤 마이크 캡처 중지(하드)");
  }, [pushLog, teardownMicNodesOnly]);

  // ✅ micOn(state)을 dependency에서 제거하고, 노드(ref) 존재로만 판단
  const ensureMicCapture = useCallback(async () => {
    // 이미 파이프라인 있으면 그대로
    if (micProcessorRef.current && micSourceRef.current && streamRef.current) {
      return true;
    }

    if (!streamRef.current) {
      pushLog("⚠ 마이크 캡처 시작 실패: streamRef 없음");
      return false;
    }

    try {
      if (!audioInCtxRef.current) {
        audioInCtxRef.current = new (window.AudioContext || window.webkitAudioContext)();
        setInSampleRate(audioInCtxRef.current.sampleRate);
        pushLog(`🎛️ mic AudioContext sampleRate = ${audioInCtxRef.current.sampleRate}Hz`);
      }
      const audioCtx = audioInCtxRef.current;

      if (audioCtx.state !== "running") {
        try {
          await audioCtx.resume();
        } catch {
          pushLog("⚠ AudioContext resume 실패(정책/환경). 다음 이벤트에서 재시도");
        }
      }

      // ✅ 노드만 정리 (setState 건드리지 않음)
      teardownMicNodesOnly();

      const source = audioCtx.createMediaStreamSource(streamRef.current);
      micSourceRef.current = source;

      const processor = audioCtx.createScriptProcessor(2048, 1, 1);
      micProcessorRef.current = processor;

      const zeroGain = audioCtx.createGain();
      zeroGain.gain.value = 0;
      micZeroGainRef.current = zeroGain;

      processor.onaudioprocess = (e) => {
        const input = e.inputBuffer.getChannelData(0);

        const now = performance.now();
        if (now - lastMeterTsRef.current > 200) {
          lastMeterTsRef.current = now;
          setMicLevel(Math.min(1, rmsLevel(input) * 6));
        }

        if (!micSendOnRef.current) return;
        const ws = wsRef.current;
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        if (!sessionReadyRef.current) return;

        const ds = downsampleFloat32(input, audioCtx.sampleRate, TARGET_SR);
        const pcm16 = float32ToPcm16ArrayBuffer(ds);
        const b64 = arrayBufferToBase64(pcm16);
        sendEvent({ type: "input_audio_buffer.append", audio: b64 });
      };

      source.connect(processor);
      processor.connect(zeroGain);
      zeroGain.connect(audioCtx.destination);

      // ✅ 여기서만 UI 상태 ON
      setMicOn(true);
      pushLog("🎤 마이크 캡처 파이프라인 ON");
      return true;
    } catch (e) {
      pushLog(`🎤 ensureMicCapture 실패: ${e?.message || e}`);
      return false;
    }
  }, [pushLog, sendEvent, teardownMicNodesOnly]);


  const restartMicCaptureForNewStream = useCallback(async () => {
    const ok = await ensureMicCapture();
    if (ok) pushLog("🎤 새 스트림 기준 마이크 캡처 재구성 완료");
  }, [ensureMicCapture, pushLog]);

  // ---------------- Mic “send” toggle (OFF해도 캡처는 유지) ----------------
  const startMicStreaming = useCallback(async () => {
    // 전송 ON
    const okCapture = await ensureMicCapture();
    if (!okCapture) return false;

    setMicSendOn(true);
    setStatus("마이크 캡처 ON / 입력 전송 ON");
    pushLog("🎤 입력 전송 ON");

    // 세션/WS 준비가 덜 됐으면 pending (준비되면 clear)
    if (
      !wsRef.current ||
      wsRef.current.readyState !== WebSocket.OPEN ||
      !sessionReadyRef.current
    ) {
      pendingAutoStartMicRef.current = true;
      return true;
    }

    sendEvent({ type: "input_audio_buffer.clear" });
    return true;
  }, [ensureMicCapture, pushLog, sendEvent]);

  const stopMicStreaming = useCallback(() => {
    // 전송 OFF(캡처 유지)
    setMicSendOn(false);
    setStatus("마이크 캡처 ON / 입력 전송 OFF");
    pushLog("🎤 입력 전송 OFF (캡처는 유지)");
  }, [pushLog]);

  // ---------------- Device pairing (USB webcam video + mic) + recovery ----------------
  const openStream = useCallback(async (videoId, audioId) => {
    const video = videoId
      ? { deviceId: { exact: videoId }, width: 640, height: 360 }
      : { width: 640, height: 360 };

    const audioBase = {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    };

    const audio = audioId
      ? { ...audioBase, deviceId: { exact: audioId } }
      : audioBase;

    return navigator.mediaDevices.getUserMedia({ video, audio });
  }, []);

  const acquirePairedStream = useCallback(async () => {
    // 1) 저장된 선호 deviceId로 먼저 시도
    let stream = await openStream(
      preferredVideoIdRef.current,
      preferredAudioIdRef.current
    );

    // 2) 권한 이후에 label/groupId가 채워지는 경우가 많음
    const devices = await navigator.mediaDevices.enumerateDevices();

    const vTrack = stream.getVideoTracks()[0] || null;
    const aTrack = stream.getAudioTracks()[0] || null;

    const vId = vTrack?.getSettings?.().deviceId || null;
    const aId = aTrack?.getSettings?.().deviceId || null;

    const vDev = vId
      ? devices.find((d) => d.kind === "videoinput" && d.deviceId === vId)
      : null;
    const groupId = vDev?.groupId || preferredGroupIdRef.current || null;

    if (vId) preferredVideoIdRef.current = vId;
    if (aId) preferredAudioIdRef.current = aId;
    if (groupId) preferredGroupIdRef.current = groupId;

    let pairedAudio = null;
    if (groupId) {
      pairedAudio = devices.find(
        (d) => d.kind === "audioinput" && d.groupId === groupId
      );
    }

    // 페어 오디오가 있고 현재 오디오와 다르면 정확히 다시 열기
    if (pairedAudio?.deviceId && pairedAudio.deviceId !== aId) {
      try {
        stream.getTracks().forEach((t) => t.stop());
      } catch {}

      preferredAudioIdRef.current = pairedAudio.deviceId;

      stream = await openStream(
        preferredVideoIdRef.current,
        preferredAudioIdRef.current
      );
    }

    return stream;
  }, [openStream]);

  const replaceStreamRef = useRef(null);

  const scheduleMediaRecovery = useCallback(
    (reason) => {
      if (destroyedRef.current) return;
      if (mediaRecoverInFlightRef.current) return;
      mediaRecoverInFlightRef.current = true;

      const attempt = mediaRecoverAttemptRef.current++;
      const delay = Math.min(1000 * Math.pow(2, attempt), 15000);

      pushLog(`🛠️ 미디어 복구 예약 (${reason}) in ${delay}ms`);

      if (mediaRecoverTimerRef.current) clearTimeout(mediaRecoverTimerRef.current);
      mediaRecoverTimerRef.current = setTimeout(async () => {
        if (destroyedRef.current) return;
        try {
          const newStream = await acquirePairedStream();
          const fn = replaceStreamRef.current;
          if (fn) await fn(newStream, reason);

          mediaRecoverAttemptRef.current = 0;
          pushLog("✅ 미디어 복구 성공");
        } catch (e) {
          pushLog(`❌ 미디어 복구 실패: ${e?.message || e}`);
          mediaRecoverInFlightRef.current = false;
          scheduleMediaRecovery("retry");
          return;
        } finally {
          mediaRecoverInFlightRef.current = false;
        }
      }, delay);
    },
    [acquirePairedStream, pushLog]
  );

  const replaceStream = useCallback(
    async (newStream, reason) => {
      const old = streamRef.current;

      // ✅ old 트랙의 ended 핸들러를 먼저 제거 (우리가 stop해도 복구 루프 안 돌게)
      if (old) {
        try {
          old.getTracks().forEach((t) => {
            t.onended = null;
          });
        } catch {}
      }

      // 새 스트림 적용
      streamRef.current = newStream;
      if (videoRef.current) videoRef.current.srcObject = newStream;

      pushLog(`🔁 스트림 교체 완료 (${reason})`);

      // old stop (이제 ended로 복구가 재귀되지 않음)
      if (old) {
        try {
          old.getTracks().forEach((t) => t.stop());
        } catch {}
      }

      // new 트랙 종료 감지
      try {
        newStream.getTracks().forEach((t) => {
          t.onended = () => scheduleMediaRecovery(`${t.kind}_ended`);
        });
      } catch {}

      // 마이크 캡처 파이프라인 재구성
      await restartMicCaptureForNewStream();
    },
    [pushLog, restartMicCaptureForNewStream, scheduleMediaRecovery]
  );


  useEffect(() => {
    replaceStreamRef.current = replaceStream;
  }, [replaceStream]);

  // ---------------- Session update ----------------
  const sendSessionUpdate = useCallback(() => {
    sendEvent({
      type: "session.update",
      session: {
        type: "realtime",
        model: REALTIME_MODEL,
        output_modalities: ["audio"],
        instructions:
          "너는 노인 돌봄 홈캠 안에 들어있는, 친절하고 느긋한 한국어 비서야. " +
          "항상 존댓말로 부드럽게 대답해줘. " +
          "사용자가 말하면 짧고 명확하게 응답해줘.",
        audio: {
          input: {
            format: { type: "audio/pcm", rate: TARGET_SR },
            turn_detection: autoVoiceMode ? { type: "semantic_vad" } : null,
          },
          output: {
            format: { type: "audio/pcm", rate: TARGET_SR },
            voice: "marin",
          },
        },
      },
    });
  }, [autoVoiceMode, sendEvent]);

  // ---------------- Fall check (1fps) ----------------
  const requestFallCheckOnce = useCallback(
    (dataUrl) => {
      if (!dataUrl) return;

      pendingNextResponseKindRef.current = "fall_check";
      sendEvent({
        type: "response.create",
        response: {
          conversation: "none",
          output_modalities: ["text"],
          max_output_tokens: 60,
          instructions:
            "You are a vision classifier. Determine if the person in the image is FALL (lying/collapsed) or STANDING/SITTING (not a fall). " +
            'Reply ONLY with strict JSON like: {"state":"fall"|"standing","confidence":0.0-1.0}. No extra text.',
          input: [
            {
              type: "message",
              role: "user",
              content: [
                { type: "input_text", text: "Classify the state: fall vs standing." },
                { type: "input_image", image_url: dataUrl },
              ],
            },
          ],
        },
      });
    },
    [sendEvent]
  );

  const triggerFallAlertVoice = useCallback(
    (dataUrl, confidence = null) => {
      const now = Date.now();
      if (now - lastFallAlertTsRef.current < FALL_ALERT_COOLDOWN_MS) return;
      lastFallAlertTsRef.current = now;

      pendingNextResponseKindRef.current = "fall_alert";
      sendEvent({
        type: "response.create",
        response: {
          conversation: "none",
          output_modalities: ["audio"],
          instructions:
            "너는 노인 돌봄 홈캠의 안전 알림 음성 비서야. " +
            "이미지를 보고 낙상(넘어짐)이 의심되면, 사용자에게 짧게 경고하고 괜찮으신지 확인해. " +
            "문장은 1~2문장으로 짧게. 존댓말. " +
            (confidence != null ? `추정 신뢰도: ${confidence}. ` : ""),
          input: [
            {
              type: "message",
              role: "user",
              content: [
                {
                  type: "input_text",
                  text: "낙상(넘어짐) 의심 상황입니다. 사용자에게 음성으로 경고하세요.",
                },
                { type: "input_image", image_url: dataUrl },
              ],
            },
          ],
        },
      });

      pushLog("🚨 (AI) 낙상 ALERT → 음성 경고 트리거");
    },
    [pushLog, sendEvent]
  );

  // ---------------- WS connect / events ----------------
  const connectRealtime = useCallback(async () => {
    const cur = wsRef.current;
    if (
      cur &&
      (cur.readyState === WebSocket.OPEN || cur.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    const apiKey = import.meta.env.VITE_OPENAI_API_KEY;
    if (!apiKey) {
      alert("VITE_OPENAI_API_KEY 환경변수가 없음");
      return;
    }

    autoReconnectRef.current = true;
    sessionReadyRef.current = false;
    pendingAutoStartMicRef.current = micSendOnRef.current; // 전송 ON이면 준비되면 clear/재시작

    setStatus("OpenAI Realtime WS 연결 중...");

    const ws = new WebSocket(WS_URL, ["realtime", `openai-insecure-api-key.${apiKey}`]);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      setStatus("OpenAI Realtime WS 연결 완료");
      pushLog("OpenAI Realtime WS 연결 완료");

      reconnectAttemptRef.current = 0;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }

      maybePostWebStatusChanged("ok", { reason: "ws_connected" });
    };

    ws.onerror = (err) => {
      console.error("WS error:", err);
      pushLog("WS error (콘솔 확인)");
    };

    ws.onclose = () => {
      setConnected(false);
      setStatus("Realtime WS 연결 종료");
      pushLog("Realtime WS 연결 종료");
      activeResponseIdRef.current = null;
      sessionReadyRef.current = false;

      if (micSendOnRef.current) pendingAutoStartMicRef.current = true;

      if (!autoReconnectRef.current) return;
      if (reconnectTimerRef.current) return;

      const attempt = reconnectAttemptRef.current++;
      const delay = Math.min(1000 * Math.pow(2, attempt), 30000);
      pushLog(`🔄 WS 재연결 예약 (${delay}ms)`);

      reconnectTimerRef.current = setTimeout(() => {
        reconnectTimerRef.current = null;
        connectRealtime();
      }, delay);
    };

    ws.onmessage = async (msg) => {
      let ev;
      try {
        ev = JSON.parse(msg.data);
      } catch {
        return;
      }

      if (ev.type === "response.created") {
        const rid = ev.response?.id || null;
        if (rid) {
          const kind = pendingNextResponseKindRef.current || "unknown";
          responseKindMapRef.current.set(rid, kind);
          pendingNextResponseKindRef.current = null;
          activeResponseIdRef.current = rid;
          pushLog(`response.created (${rid}) kind=${kind}`);
        }
        return;
      }

      switch (ev.type) {
        case "session.created": {
          pushLog("session.created 수신");
          sendSessionUpdate();
          pushLog("session.update 전송");

          // session.updated 오면 입력버퍼 clear 하려고 pending
          if (micSendOnRef.current) pendingAutoStartMicRef.current = true;
          break;
        }

        case "session.updated": {
          pushLog("session.updated 수신");
          sessionReadyRef.current = true;

          // 전송 ON이면, 세션 갱신 직후 버퍼 정리
          if (micSendOnRef.current) {
            sendEvent({ type: "input_audio_buffer.clear" });
          }

          // pending이면 캡처 보장 + pending 해제(성공했을 때)
          if (pendingAutoStartMicRef.current) {
            const ok = await ensureMicCapture();
            if (ok) {
              if (micSendOnRef.current) sendEvent({ type: "input_audio_buffer.clear" });
              pendingAutoStartMicRef.current = false;
              pushLog("🎤 pending 해제(세션 준비 완료)");
            }
          }
          break;
        }

        case "error": {
          const message = ev.error?.message || JSON.stringify(ev.error || ev);
          pushLog(`[서버 error] ${message}`);
          break;
        }

        // ----- VAD events -----
        case "input_audio_buffer.speech_started": {
          userSpeakingRef.current = true;
          hadSpeechSinceLastCommitRef.current = true;

          stopAllOutputAudio();

          if (activeResponseIdRef.current) {
            sendEvent({ type: "response.cancel" });
          }

          pushLog("🎙️ speech_started");
          break;
        }

        case "input_audio_buffer.speech_stopped": {
          userSpeakingRef.current = false;
          pushLog("🎙️ speech_stopped");

          if (autoVoiceMode && hadSpeechSinceLastCommitRef.current) {
            const now = Date.now();
            if (now - lastAutoCommitTsRef.current > 250) {
              lastAutoCommitTsRef.current = now;
              hadSpeechSinceLastCommitRef.current = false;

              const snap = captureSnapshotDataUrl();
              if (snap) attachSnapshotToConversation(snap, "사용자 발화 시점의 웹캠 스냅샷입니다.");

              pendingNextResponseKindRef.current = "user_reply";
              sendEvent({ type: "input_audio_buffer.commit" });
              sendEvent({ type: "response.create" });
              pushLog("✅ (AUTO) snapshot → commit → response.create");
            }
          }
          break;
        }

        case "input_audio_buffer.committed": {
          pushLog("✅ input_audio_buffer.committed");
          break;
        }

        // ----- Model audio bytes -----
        case "response.output_audio.delta": {
          if (ev.delta) enqueueModelAudioChunk(ev.delta);
          break;
        }

        // ----- Model audio transcript (for logs) -----
        case "response.output_audio_transcript.done": {
          const text = (ev.transcript || "").trim();
          if (text) pushLog(`assistant(audio): ${text}`);
          break;
        }

        // ----- Model text output (for out-of-band fall check) -----
        case "response.output_text.delta": {
          const rid = ev.response_id || activeResponseIdRef.current || "unknown";
          const prev = responseTextMapRef.current.get(rid) || "";
          responseTextMapRef.current.set(rid, prev + (ev.delta || ""));
          break;
        }

        case "response.output_text.done": {
          const rid = ev.response_id || activeResponseIdRef.current || "unknown";
          const prev = responseTextMapRef.current.get(rid) || "";
          const full = (ev.text || prev || "").trim();
          responseTextMapRef.current.set(rid, full);

          const kind = responseKindMapRef.current.get(rid);
          if (kind === "fall_check" && full) pushLog(`(fall_check text) ${full}`);
          break;
        }

        case "response.done": {
          const resp = ev.response || {};
          const rid = resp.id || activeResponseIdRef.current || null;
          const st = resp.status || "unknown";
          const kind = rid ? responseKindMapRef.current.get(rid) : null;

          pushLog(
            `response.done (status=${st})${rid ? ` id=${rid}` : ""}${kind ? ` kind=${kind}` : ""}`
          );

          if (st !== "completed") {
            const errMsg =
              resp.status_details?.error?.message || JSON.stringify(resp.status_details || {});
            if (errMsg && errMsg !== "{}") pushLog(`↳ status_details: ${errMsg}`);
          }

          if (rid && kind === "fall_check") {
            fallCheckInFlightRef.current = false;

            const text = (responseTextMapRef.current.get(rid) || "").trim();
            let state = null;
            let confidence = null;

            const j = safeJsonParse(text);
            if (j) {
              state = j?.state || null;
              confidence = typeof j?.confidence === "number" ? j.confidence : null;
            } else {
              const t = text.toLowerCase();
              if (t.includes("fall") || t.includes("넘어")) state = "fall";
              if (t.includes("standing") || t.includes("서있") || t.includes("정상"))
                state = "standing";
            }

            if (state === "fall") {
              lastFallStateRef.current = "fall";
              fallStreakRef.current += 1;
              standingStreakRef.current = 0;
              pushLog(`🧮 fallStreak = ${fallStreakRef.current}/${FALL_FRAMES_REQUIRED}`);

              if (!alertActiveRef.current && fallStreakRef.current >= FALL_FRAMES_REQUIRED) {
                alertActiveRef.current = true;

                const snap = captureSnapshotDataUrl() || null;
                triggerFallAlertVoice(snap, confidence);

                maybePostWebStatusChanged("alert", {
                  confidence,
                  fall_streak: fallStreakRef.current,
                  snapshot: snap,
                });

                pushLog("✅ ALERT ACTIVE (fall >= threshold)");
              }
            } else if (state === "standing") {
              lastFallStateRef.current = "standing";
              standingStreakRef.current += 1;
              fallStreakRef.current = 0;

              if (alertActiveRef.current && standingStreakRef.current >= STANDING_FRAMES_TO_CLEAR) {
                alertActiveRef.current = false;
                maybePostWebStatusChanged("ok", {
                  reason: "standing_recovered",
                  standing_streak: standingStreakRef.current,
                });
                pushLog("✅ ALERT CLEARED (standing streak)");
              }
            }

            responseTextMapRef.current.delete(rid);
            responseKindMapRef.current.delete(rid);
          }

          activeResponseIdRef.current = null;
          break;
        }

        default:
          break;
      }
    };
  }, [
    attachSnapshotToConversation,
    autoVoiceMode,
    captureSnapshotDataUrl,
    enqueueModelAudioChunk,
    ensureMicCapture,
    maybePostWebStatusChanged,
    pushLog,
    sendEvent,
    sendSessionUpdate,
    stopAllOutputAudio,
    triggerFallAlertVoice,
  ]);

  const disconnectRealtime = useCallback(() => {
    autoReconnectRef.current = false;

    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }

    stopAllOutputAudio();

    if (wsRef.current) {
      try {
        wsRef.current.close();
      } catch {}
      wsRef.current = null;
    }

    activeResponseIdRef.current = null;
    sessionReadyRef.current = false;
    pendingAutoStartMicRef.current = false;

    setConnected(false);
    setStatus("Realtime 연결 해제");
    pushLog("Realtime 연결 해제");
  }, [pushLog, stopAllOutputAudio]);

  // ---------------- Auto connect on app start ----------------
  useEffect(() => {
    const t = setTimeout(() => {
      connectRealtime();
    }, 100);
    return () => clearTimeout(t);
  }, [connectRealtime]);

  // ---------------- AI fall monitor loop (1 fps) ----------------
  useEffect(() => {
    if (!connected) return;
    if (!aiFallMonitorOn) return;
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;

    const intervalMs = Math.round(1000 / SNAPSHOT_FPS);

    const id = setInterval(() => {
      if (!sessionReadyRef.current) return;
      if (!videoRef.current) return;
      if (videoRef.current.readyState < 2) return;

      if (userSpeakingRef.current) return;
      if (fallCheckInFlightRef.current) return;

      const snap = captureSnapshotDataUrl();
      if (!snap) return;

      fallCheckInFlightRef.current = true;
      requestFallCheckOnce(snap);

      setTimeout(() => {
        fallCheckInFlightRef.current = false;
      }, 5000);
    }, intervalMs);

    return () => clearInterval(id);
  }, [aiFallMonitorOn, captureSnapshotDataUrl, connected, requestFallCheckOnce]);

  // 웹 하트비트(옵션)
  useEffect(() => {
    if (!FALL_WEBHOOK_URL) return;
    const id = setInterval(() => {
      const desired = alertActiveRef.current ? "alert" : "ok";
      postWebStatus(desired, { reason: "heartbeat" });
    }, WEB_HEARTBEAT_MS);
    return () => clearInterval(id);
  }, [postWebStatus]);

  // autoVoiceMode 토글 시, 연결되어 있으면 세션 업데이트 반영
  useEffect(() => {
    if (!connected) return;
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;

    sessionReadyRef.current = false;
    sendSessionUpdate();
    pushLog(`(설정 변경) session.update 전송: autoVoiceMode=${autoVoiceMode}`);

    if (autoVoiceMode && micSendOnRef.current) {
      pendingAutoStartMicRef.current = true;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoVoiceMode]);

  // ---------------- Camera + paired mic setup (앱 시작 시 캡처 항상 ON) ----------------
  useEffect(() => {
    destroyedRef.current = false;
    let cancelled = false;

    const onDevChange = () => scheduleMediaRecovery("devicechange");

    async function setupMedia() {
      try {
        setStatus("카메라/마이크 권한 요청 중...");

        const stream = await acquirePairedStream();
        if (cancelled) return;

        streamRef.current = stream;
        if (videoRef.current) videoRef.current.srcObject = stream;
        pushLog("카메라/마이크 스트림 준비 완료 (paired)");

        // 트랙 종료 감지 → 자동 복구
        try {
          stream.getTracks().forEach((t) => {
            t.onended = () => scheduleMediaRecovery(`${t.kind}_ended`);
          });
        } catch {}

        // // devicechange 감지 → 자동 복구
        // if (navigator.mediaDevices?.addEventListener) {
        //   navigator.mediaDevices.addEventListener("devicechange", onDevChange);
        // } else {
        //   // 구형 브라우저 대응(일렉트론에서는 대개 addEventListener 됨)
        //   navigator.mediaDevices.ondevicechange = onDevChange;
        // }

        await new Promise((resolve) => {
          if (!videoRef.current) return resolve();
          videoRef.current.onloadedmetadata = () => {
            videoRef.current.play();
            resolve();
          };
        });

        if (cancelled) return;

        // ✅ 앱 실행 즉시 “마이크 캡처 ON”
        await ensureMicCapture();

        setStatus("카메라 준비 완료 (마이크 캡처 ON)");
      } catch (err) {
        console.error(err);
        setStatus("카메라/마이크 초기화 실패");
        pushLog("카메라/마이크 초기화 실패: " + (err?.message || err));
        // 초기화 실패도 복구 예약
        scheduleMediaRecovery("init_failed");
      }
    }

    setupMedia();

    return () => {
      cancelled = true;
      destroyedRef.current = true;

      if (navigator.mediaDevices?.removeEventListener) {
        navigator.mediaDevices.removeEventListener("devicechange", onDevChange);
      } else {
        navigator.mediaDevices.ondevicechange = null;
      }

      if (mediaRecoverTimerRef.current) {
        clearTimeout(mediaRecoverTimerRef.current);
        mediaRecoverTimerRef.current = null;
      }

      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }

      stopAllOutputAudio();
      stopMicCaptureHard();

      if (audioInCtxRef.current) {
        audioInCtxRef.current.close();
        audioInCtxRef.current = null;
      }
      if (audioOutCtxRef.current) {
        audioOutCtxRef.current.close();
        audioOutCtxRef.current = null;
      }

      if (streamRef.current) {
        try {
          streamRef.current.getTracks().forEach((t) => t.stop());
        } catch {}
        streamRef.current = null;
      }

      if (wsRef.current) {
        try {
          wsRef.current.close();
        } catch {}
        wsRef.current = null;
      }
    };
  }, []);

  const micBarWidth = Math.round(micLevel * 100);

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#020617",
        color: "#e5e7eb",
        padding: "24px",
        display: "flex",
        flexDirection: "column",
        gap: "16px",
        fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
      }}
    >
      <h1 style={{ fontSize: "24px", fontWeight: 800 }}>
        🧓 홈캠 + Realtime “음성모드” + (1fps) OpenAI Vision 낙상 감지 → (3회) 웹 신호
      </h1>

      <div style={{ fontSize: "14px", opacity: 0.9 }}>
        상태: {status} / WS: {connected ? "connected" : "disconnected"} / MicCapture:{" "}
        {micOn ? "ON" : "OFF"} / Send: {micSendOn ? "ON" : "OFF"}{" "}
        {inSampleRate ? `(micSR=${inSampleRate}Hz → sendSR=${TARGET_SR}Hz)` : ""}
      </div>

      <div style={{ fontSize: "13px", opacity: 0.9 }}>
        AlertActive: <b>{alertActiveRef.current ? "YES" : "NO"}</b> / fallStreak:{" "}
        <b>{fallStreakRef.current}</b> / standingStreak: <b>{standingStreakRef.current}</b>
        <br />
        Webhook: <b>{FALL_WEBHOOK_URL ? "ON" : "OFF"}</b>{" "}
        {FALL_WEBHOOK_URL ? `(device_id=${DEVICE_ID})` : "(VITE_FALL_WEBHOOK_URL 미설정)"}
      </div>

      <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
        {connected ? (
          <button
            onClick={disconnectRealtime}
            style={{
              padding: "10px 18px",
              borderRadius: "999px",
              border: "none",
              cursor: "pointer",
              fontWeight: 800,
              backgroundColor: "#b91c1c",
              color: "#fff",
            }}
          >
            Realtime 끄기
          </button>
        ) : (
          <button
            onClick={connectRealtime}
            style={{
              padding: "10px 18px",
              borderRadius: "999px",
              border: "none",
              cursor: "pointer",
              fontWeight: 800,
              backgroundColor: "#2563eb",
              color: "#fff",
            }}
          >
            Realtime 켜기(재연결)
          </button>
        )}

        <button
          onClick={micSendOn ? stopMicStreaming : startMicStreaming}
          style={{
            padding: "10px 18px",
            borderRadius: "999px",
            border: "none",
            cursor: "pointer",
            fontWeight: 800,
            backgroundColor: micSendOn ? "#0f766e" : "#10b981",
            color: "#fff",
            opacity: 1,
          }}
          title="OFF를 눌러도 마이크 캡처는 유지되고, WS로 보내는 입력만 차단됩니다."
        >
          {micSendOn ? "입력 전송 OFF (캡처 유지)" : "입력 전송 ON"}
        </button>

        <button
          onClick={async () => {
            try {
              await ensureAudioOut();
              pushLog("🔊 오디오 컨텍스트 resume 완료 (재생 가능)");
            } catch {
              pushLog("🔊 오디오 resume 실패 (브라우저 정책/권한 확인)");
            }
          }}
          style={{
            padding: "10px 18px",
            borderRadius: "999px",
            border: "1px solid #334155",
            cursor: "pointer",
            fontWeight: 800,
            background: "transparent",
            color: "#e2e8f0",
          }}
          title="브라우저 자동재생 제한 때문에 필요할 수 있음"
        >
          오디오 활성화
        </button>

        <button
          onClick={() => {
            const desired = alertActiveRef.current ? "alert" : "ok";
            postWebStatus(desired, { reason: "manual_ping" });
          }}
          style={{
            padding: "10px 18px",
            borderRadius: "999px",
            border: "1px solid #334155",
            cursor: "pointer",
            fontWeight: 800,
            background: "transparent",
            color: "#e2e8f0",
          }}
        >
          웹 신호 테스트
        </button>

        <button
          onClick={() => setLogs([])}
          style={{
            padding: "10px 18px",
            borderRadius: "999px",
            border: "1px solid #334155",
            cursor: "pointer",
            fontWeight: 800,
            background: "transparent",
            color: "#e2e8f0",
          }}
        >
          로그 지우기
        </button>
      </div>

      <div style={{ display: "flex", gap: "24px", alignItems: "flex-start", flexWrap: "wrap" }}>
        {/* left */}
        <div
          style={{
            position: "relative",
            width: "640px",
            maxWidth: "100%",
            aspectRatio: "16 / 9",
            background: "#000",
            borderRadius: "16px",
            overflow: "hidden",
            border: "1px solid #1f2937",
          }}
        >
          <video
            ref={videoRef}
            autoPlay
            muted
            playsInline
            style={{
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
              objectFit: "cover",
            }}
          />
          <div
            style={{
              position: "absolute",
              left: "12px",
              bottom: "12px",
              padding: "4px 8px",
              fontSize: "12px",
              borderRadius: "999px",
              background: "rgba(15,23,42,0.7)",
              border: "1px solid rgba(148,163,184,0.4)",
            }}
          >
            웹캠 화면
          </div>
        </div>

        {/* right */}
        <div
          style={{
            flex: 1,
            minWidth: "300px",
            display: "flex",
            flexDirection: "column",
            gap: "12px",
          }}
        >
          <div
            style={{
              display: "flex",
              gap: "16px",
              flexWrap: "wrap",
              alignItems: "center",
              padding: "10px 12px",
              borderRadius: "12px",
              border: "1px solid #1f2937",
              background: "rgba(2,6,23,0.6)",
              fontSize: "13px",
            }}
          >
            <label style={{ display: "flex", gap: "8px", alignItems: "center" }}>
              <input
                type="checkbox"
                checked={autoVoiceMode}
                onChange={(e) => setAutoVoiceMode(e.target.checked)}
              />
              자동 음성모드(VAD)
            </label>

            <label style={{ display: "flex", gap: "8px", alignItems: "center" }}>
              <input
                type="checkbox"
                checked={playModelAudio}
                onChange={(e) => setPlayModelAudio(e.target.checked)}
              />
              모델 오디오 재생
            </label>

            <label style={{ display: "flex", gap: "8px", alignItems: "center" }}>
              <input
                type="checkbox"
                checked={aiFallMonitorOn}
                onChange={(e) => setAiFallMonitorOn(e.target.checked)}
              />
              1fps AI 낙상 감지(OpenAI Vision)
            </label>

            <div style={{ opacity: 0.9 }}>
              Mic level:
              <span
                style={{
                  display: "inline-block",
                  width: "140px",
                  height: "10px",
                  marginLeft: "8px",
                  borderRadius: "999px",
                  border: "1px solid #334155",
                  overflow: "hidden",
                  verticalAlign: "middle",
                }}
              >
                <span
                  style={{
                    display: "block",
                    width: `${micBarWidth}%`,
                    height: "100%",
                    background: "#22c55e",
                  }}
                />
              </span>
            </div>
          </div>

          <div style={{ fontSize: "12px", opacity: 0.85, lineHeight: 1.5 }}>
            - 낙상 판정은 <b>OpenAI Vision</b>에 스냅샷을 넣고 JSON으로 <b>fall/standing</b> 분류합니다.
            <br />
            - <b>낙상 3회 연속</b>이면 <b>ALERT</b>, 정상 <b>5회 연속</b>이면 복구합니다.
          </div>

          <div
            style={{
              flex: 1,
              minHeight: "280px",
              maxHeight: "380px",
              padding: "10px",
              borderRadius: "12px",
              background: "#020617",
              border: "1px solid #1f2937",
              overflowY: "auto",
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco",
              fontSize: "12px",
              lineHeight: 1.45,
            }}
          >
            {logs.length === 0 ? (
              <div style={{ opacity: 0.6 }}>
                로그가 여기 찍힙니다. (speech_started/stopped, response.done, fall_check, web notify 등)
              </div>
            ) : (
              logs.map((line, idx) => <div key={idx}>{line}</div>)
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
