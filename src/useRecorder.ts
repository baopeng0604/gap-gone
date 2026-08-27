import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface AudioInputDevice {
  deviceId: string;
  label: string;
}

export interface MonitorLevel {
  rms: number;
  peak: number;
  rmsDb: number;
  peakDb: number;
}

export type RecorderStatus =
  | "idle"
  | "requesting-permission"
  | "recording"
  | "review"
  | "error";

const emptyLevel: MonitorLevel = {
  rms: 0,
  peak: 0,
  rmsDb: Number.NEGATIVE_INFINITY,
  peakDb: Number.NEGATIVE_INFINITY,
};

function toDb(linear: number) {
  return linear > 0 ? 20 * Math.log10(linear) : Number.NEGATIVE_INFINITY;
}

function isTauriDesktop() {
  return Boolean((window as typeof window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
}

export function useRecorder() {
  const [devices, setDevices] = useState<AudioInputDevice[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState("");
  const [monitorEnabled, setMonitorEnabled] = useState(false);
  const [level, setLevel] = useState<MonitorLevel>(emptyLevel);
  const [peakHoldDb, setPeakHoldDb] = useState(Number.NEGATIVE_INFINITY);
  const [clipLatched, setClipLatched] = useState(false);
  const [status, setStatus] = useState<RecorderStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [recordedBlob, setRecordedBlob] = useState<Blob | null>(null);
  const [duration, setDuration] = useState(0);
  const [isPaused, setIsPaused] = useState(false);

  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const contextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const monitorGainRef = useRef<GainNode | null>(null);
  const animationRef = useRef<number | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef(0);
  const pausedAtRef = useRef<number | null>(null);
  const pausedDurationRef = useRef(0);
  const pausedRef = useRef(false);
  const stopResolverRef = useRef<((blob: Blob) => void) | null>(null);
  const discardStopRef = useRef(false);
  const nativePathRef = useRef<string | null>(null);
  const nativeUnlistenRef = useRef<UnlistenFn | null>(null);
  const nativeErrorUnlistenRef = useRef<UnlistenFn | null>(null);
  const nativeTimerRef = useRef<number | null>(null);

  const refreshDevices = useCallback(async () => {
    if (isTauriDesktop()) {
      try {
        const nativeDevices = await invoke<
          { id: string; label: string; isDefault: boolean }[]
        >("list_audio_input_devices");
        const inputs = nativeDevices.map((device) => ({
          deviceId: device.id,
          label: device.label || "未命名设备",
        }));
        setDevices(inputs);
        setSelectedDeviceId((current) => current || inputs[0]?.deviceId || "");
        return;
      } catch {
        // A webview without the native command falls back to Web Media APIs.
      }
    }
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
      const allDevices = await navigator.mediaDevices.enumerateDevices();
      const inputs = allDevices
        .filter((device) => device.kind === "audioinput")
        .map((device, index) => ({
          deviceId: device.deviceId,
          label: device.label || `麦克风 ${index + 1}`,
        }));
      setDevices(inputs);
      setSelectedDeviceId((current) => {
        if (current && inputs.some((device) => device.deviceId === current)) {
          return current;
        }
        return inputs[0]?.deviceId ?? "";
      });
    } catch {
      setError("无法读取录音设备列表");
    }
  }, []);

  useEffect(() => {
    void refreshDevices();
    const onDeviceChange = () => void refreshDevices();
    navigator.mediaDevices?.addEventListener?.("devicechange", onDeviceChange);
    return () =>
      navigator.mediaDevices?.removeEventListener?.(
        "devicechange",
        onDeviceChange,
      );
  }, [refreshDevices]);

  const stopMeter = useCallback(() => {
    if (animationRef.current !== null) {
      cancelAnimationFrame(animationRef.current);
      animationRef.current = null;
    }
    setLevel(emptyLevel);
    setPeakHoldDb(Number.NEGATIVE_INFINITY);
    setClipLatched(false);
    pausedRef.current = false;
  }, []);

  const pauseMeter = useCallback(() => {
    if (animationRef.current !== null) {
      cancelAnimationFrame(animationRef.current);
      animationRef.current = null;
    }
  }, []);

  const getElapsedDuration = useCallback(() => {
    if (!startedAtRef.current) return 0;
    const now = performance.now();
    const currentPause = pausedAtRef.current
      ? now - pausedAtRef.current
      : 0;
    return Math.max(
      0,
      (now - startedAtRef.current - pausedDurationRef.current - currentPause) /
        1000,
    );
  }, []);

  const cleanupAudio = useCallback(() => {
    stopMeter();
    monitorGainRef.current?.disconnect();
    analyserRef.current?.disconnect();
    contextRef.current?.close().catch(() => undefined);
    monitorGainRef.current = null;
    analyserRef.current = null;
    contextRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, [stopMeter]);

  const cleanupNative = useCallback(() => {
    nativeUnlistenRef.current?.();
    nativeUnlistenRef.current = null;
    nativeErrorUnlistenRef.current?.();
    nativeErrorUnlistenRef.current = null;
    if (nativeTimerRef.current !== null) {
      window.clearInterval(nativeTimerRef.current);
      nativeTimerRef.current = null;
    }
    nativePathRef.current = null;
  }, []);

  const startMeter = useCallback(() => {
    const analyser = analyserRef.current;
    if (!analyser) return;
    const data = new Float32Array(analyser.fftSize);
    const tick = () => {
      if (pausedRef.current) return;
      analyser.getFloatTimeDomainData(data);
      let sum = 0;
      let peak = 0;
      for (const sample of data) {
        sum += sample * sample;
        peak = Math.max(peak, Math.abs(sample));
      }
      const rms = Math.sqrt(sum / data.length);
      const rmsDb = toDb(rms);
      const peakDb = toDb(peak);
      setLevel({ rms: Math.min(1, rms * 3.2), peak, rmsDb, peakDb });
      setPeakHoldDb((current) => Math.max(current, peakDb));
      if (peak >= 0.999) setClipLatched(true);
      setDuration(getElapsedDuration());
      animationRef.current = requestAnimationFrame(tick);
    };
    tick();
  }, [getElapsedDuration]);

  useEffect(() => {
    const source = contextRef.current && streamRef.current
      ? contextRef.current.createMediaStreamSource(streamRef.current)
      : null;
    if (!source || !contextRef.current) return;
    const gain = contextRef.current.createGain();
    gain.gain.value = monitorEnabled ? 1 : 0;
    source.connect(gain);
    gain.connect(contextRef.current.destination);
    monitorGainRef.current = gain;
    return () => {
      source.disconnect();
      gain.disconnect();
      if (monitorGainRef.current === gain) monitorGainRef.current = null;
    };
  }, [monitorEnabled, status]);

  const startRecording = useCallback(async () => {
    setError(null);
    setRecordedBlob(null);
    setDuration(0);
    setIsPaused(false);
    pausedRef.current = false;
    pausedAtRef.current = null;
    pausedDurationRef.current = 0;
    stopMeter();
    if (isTauriDesktop()) {
      try {
        const result = await invoke<{ path: string }>("start_recording", {
          deviceId: selectedDeviceId || null,
        });
        nativePathRef.current = result.path;
        nativeUnlistenRef.current = await listen<{ rms: number; peak: number }>(
          "recording-level",
          (event) => {
            if (pausedRef.current) return;
            const rmsDb = toDb(event.payload.rms);
            const peakDb = toDb(event.payload.peak);
            setLevel({
              rms: Math.min(1, event.payload.rms * 3.2),
              peak: event.payload.peak,
              rmsDb,
              peakDb,
            });
            setPeakHoldDb((current) => Math.max(current, peakDb));
            if (event.payload.peak >= 0.999) setClipLatched(true);
          },
        );
        // Rust 端录音流出错（WASAPI underrun/overrun、设备拔出等）时会回收流，
        // 并保留已写入的部分录音；这里读回来直接进入试听，避免整段丢失。
        nativeErrorUnlistenRef.current = await listen<{
          message: string;
          path: string | null;
        }>("recording-error", async (event) => {
          const { message, path } = event.payload;
          let partialBlob: Blob | null = null;
          if (path) {
            try {
              const bytes = await invoke<number[]>("read_recording", { path });
              // 44 字节是 WAV 头，超过说明有实际采样数据。
              if (bytes.length > 44) {
                partialBlob = new Blob([new Uint8Array(bytes)], {
                  type: "audio/wav",
                });
                void invoke("delete_recording_file", { path }).catch(
                  () => undefined,
                );
              }
            } catch {
              // 部分录音读取失败时按普通错误处理。
            }
          }
          stopMeter();
          cleanupNative();
          setIsPaused(false);
          if (partialBlob) {
            setRecordedBlob(partialBlob);
            setDuration(getElapsedDuration());
            setStatus("review");
            setError(`录音中断（${message}），已保留中断前的部分录音，请试听确认`);
          } else {
            setRecordedBlob(null);
            setStatus("error");
            setError(message || "录音过程中发生错误");
          }
        });
        startedAtRef.current = performance.now();
        nativeTimerRef.current = window.setInterval(
          () =>
            setDuration(getElapsedDuration()),
          100,
        );
        setStatus("recording");
        return;
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        // 仅当命令不存在（浏览器开发预览）时降级到 Web Media API；
        // 原生录音的真实错误必须直接展示，否则用户只能看到无效的降级报错。
        const commandMissing =
          message.includes("start_recording") &&
          /not found|unknown|no such/i.test(message);
        if (!commandMissing) {
          setStatus("error");
          setError(message || "无法启动录音");
          return;
        }
      }
    }

    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      setStatus("error");
      setError("当前系统不支持本地录音");
      return;
    }

    setStatus("requesting-permission");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: selectedDeviceId ? { exact: selectedDeviceId } : undefined,
          channelCount: { ideal: 1 },
          sampleRate: { ideal: 48000 },
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
      streamRef.current = stream;
      await refreshDevices();

      const context = new AudioContext({ sampleRate: 48000 });
      if (context.state === "suspended") await context.resume();
      const source = context.createMediaStreamSource(stream);
      const analyser = context.createAnalyser();
      analyser.fftSize = 2048;
      source.connect(analyser);
      contextRef.current = context;
      analyserRef.current = analyser;

      const mimeType = [
        "audio/webm;codecs=opus",
        "audio/webm",
        "audio/mp4",
      ].find((candidate) => MediaRecorder.isTypeSupported(candidate));
      const recorder = new MediaRecorder(
        stream,
        mimeType ? { mimeType } : undefined,
      );
      chunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, {
          type: recorder.mimeType || "audio/webm",
        });
        if (discardStopRef.current) {
          discardStopRef.current = false;
          setIsPaused(false);
          stopMeter();
          cleanupAudio();
          return;
        }
        setRecordedBlob(blob);
        setStatus("review");
        setIsPaused(false);
        stopMeter();
        stopResolverRef.current?.(blob);
        stopResolverRef.current = null;
        cleanupAudio();
      };
      recorder.onerror = () => {
        setStatus("error");
        setError("录音过程中发生错误");
        cleanupAudio();
      };
      recorderRef.current = recorder;
      discardStopRef.current = false;
      startedAtRef.current = performance.now();
      recorder.start(100);
      setStatus("recording");
      startMeter();
    } catch (cause) {
      cleanupAudio();
      setStatus("error");
      setError(
        cause instanceof DOMException && cause.name === "NotAllowedError"
          ? "麦克风权限被拒绝，请在系统设置中允许访问"
          : "无法启动录音，请检查设备是否可用",
      );
    }
  }, [
    cleanupAudio,
    cleanupNative,
    refreshDevices,
    selectedDeviceId,
    startMeter,
    getElapsedDuration,
    stopMeter,
  ]);

  const stopRecording = useCallback(() => {
    if (nativePathRef.current) {
      const activePath = nativePathRef.current;
      return invoke<string>("stop_recording")
        .then((path) => invoke<number[]>("read_recording", { path }))
        .then((bytes) => {
          const blob = new Blob([new Uint8Array(bytes)], { type: "audio/wav" });
          setRecordedBlob(blob);
          setStatus("review");
          setIsPaused(false);
          stopMeter();
          cleanupNative();
          return blob;
        })
        .catch((cause) => {
          cleanupNative();
          setStatus("error");
          setError(
            cause instanceof Error ? cause.message : "无法完成录音文件",
          );
          throw cause;
        })
        .finally(() => {
          void invoke("delete_recording_file", { path: activePath });
        });
    }
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === "inactive") {
      return Promise.resolve(recordedBlob);
    }
    return new Promise<Blob>((resolve) => {
      stopResolverRef.current = resolve;
      recorder.stop();
      recorderRef.current = null;
    });
  }, [cleanupNative, recordedBlob, stopMeter]);

  const pauseRecording = useCallback(async () => {
    if (status !== "recording" || pausedRef.current) return;

    try {
      if (nativePathRef.current) {
        await invoke("pause_recording");
      } else {
        const recorder = recorderRef.current;
        if (!recorder || recorder.state !== "recording") return;
        recorder.pause();
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法暂停录音");
      return;
    }

    pausedAtRef.current = performance.now();
    pausedRef.current = true;
    setIsPaused(true);
    pauseMeter();
    setDuration(getElapsedDuration());
  }, [getElapsedDuration, pauseMeter, status]);

  const resumeRecording = useCallback(async () => {
    if (status !== "recording" || !pausedRef.current) return;

    try {
      if (nativePathRef.current) {
        await invoke("resume_recording");
      } else {
        const recorder = recorderRef.current;
        if (!recorder || recorder.state !== "paused") return;
        recorder.resume();
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法继续录音");
      return;
    }

    if (pausedAtRef.current !== null) {
      pausedDurationRef.current += performance.now() - pausedAtRef.current;
    }
    pausedAtRef.current = null;
    pausedRef.current = false;
    setIsPaused(false);
    startMeter();
  }, [startMeter, status]);

  const cancelRecording = useCallback(() => {
    if (nativePathRef.current) {
      void invoke("cancel_recording", { path: nativePathRef.current });
      cleanupNative();
    }
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      discardStopRef.current = true;
      recorder.stop();
    }
    recorderRef.current = null;
    chunksRef.current = [];
    stopResolverRef.current = null;
    setRecordedBlob(null);
    setDuration(0);
    setIsPaused(false);
    cleanupAudio();
    setStatus("idle");
  }, [cleanupAudio, cleanupNative]);

  const clearClip = useCallback(() => setClipLatched(false), []);

  const clearReview = useCallback(() => {
    setRecordedBlob(null);
    setDuration(0);
    setIsPaused(false);
    setStatus("idle");
  }, []);

  return {
    devices,
    selectedDeviceId,
    setSelectedDeviceId,
    monitorEnabled,
    setMonitorEnabled,
    level,
    peakHoldDb,
    clipLatched,
    clearClip,
    status,
    error,
    recordedBlob,
    isPaused,
    duration,
    refreshDevices,
    startRecording,
    stopRecording,
    pauseRecording,
    resumeRecording,
    cancelRecording,
    clearReview,
  };
}
