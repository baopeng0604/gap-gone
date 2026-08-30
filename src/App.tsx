import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import WaveformScore from "./components/WaveformScore";
import HelpModal from "./components/HelpModal";
import {
  getKeptRegions,
  mergeRegions,
  nextPlayableTime,
  normalizeRegions,
  subtractRegion,
  type Region,
} from "./utils/regionUtils";
import {
  buildExportBuffer,
  exportAudio,
  saveToDisk,
} from "./utils/exportUtils";
import { encodeMp3 } from "./utils/mp3Export";
import { extractKeyword } from "./utils/keywordExtract";
import {
  getExportBitrate,
  getExportFormat,
  getNoisePreset,
  getSilencePreset,
  getTranscriptVisible,
  setExportBitrate,
  setExportFormat,
  setNoisePreset as persistNoisePreset,
  setSilencePreset as persistSilencePreset,
  setTranscriptVisible as persistTranscriptVisible,
  type ExportBitrate,
  type ExportFormat,
} from "./utils/settings";
import { formatTimeStandard } from "./utils/timeUtils";
import {
  detectSilence,
  SILENCE_PRESETS,
  type SilencePreset,
} from "./utils/audioAnalysis";
import {
  applyNoiseReduction,
  cancelDeepFilterProcessing,
  type NoisePreset,
} from "./utils/noiseReduction";
import {
  cancelTranscribe,
  checkTranscribeModel,
  downloadTranscribeModel,
  getAutoTranscribe,
  getCustomModelDir,
  getTranscribeModelDir,
  isTauriDesktop,
  onTranscribeProgress,
  openTranscribeModelDir,
  runTranscription,
  setAutoTranscribe,
  setCustomModelDir,
  setTranscribeModelDir,
  type TranscriptResult,
  type TranscribeProgress,
} from "./utils/transcribe";
import TranscriptPanel from "./components/TranscriptPanel";
import WaveSidebar from "./components/WaveSidebar";
import { useRecorder } from "./useRecorder";
import countdownSfx from "./assets/countdown.mp3";
import "./App.css";

type EditMode = "seek" | "select" | "cut" | "restore";

interface EditState {
  manualRegions: Region[];
  autoRegions: Region[];
}

const emptyEditState: EditState = {
  manualRegions: [],
  autoRegions: [],
};

const silencePresetLabels: Record<SilencePreset, string> = {
  compact: "紧凑",
  natural: "自然",
  relaxed: "宽松",
};

function formatDb(value: number) {
  return Number.isFinite(value) ? `${value.toFixed(1)} dBFS` : "-∞ dBFS";
}

interface TempStorageStatus {
  bytes: number;
  fileCount: number;
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function createExportFileName(extension: string, keyword: string | null) {
  const now = new Date();
  const pad = (value: number) => value.toString().padStart(2, "0");
  const datePart = [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
  ].join("");
  const timePart = [
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join("");
  // 有关键词时「关键词-日期-时间」便于按主题聚簇；否则回退日期命名
  return keyword
    ? `${keyword}-${datePart}-${timePart}.${extension}`
    : `${datePart}-${timePart}-edited-audio.${extension}`;
}

const METER_MIN_DB = -30;
const METER_MARKS = [-24, -18, -12, -6, -3];

function meterPosition(db: number) {
  if (!Number.isFinite(db)) return 0;
  return Math.max(0, Math.min(1, (db - METER_MIN_DB) / -METER_MIN_DB));
}

function App() {
  const [audioBuffer, setAudioBuffer] = useState<AudioBuffer | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [editMode, setEditMode] = useState<EditMode>("seek");
  const [editState, setEditState] = useState<EditState>(emptyEditState);
  const [detectedSilenceRegions, setDetectedSilenceRegions] = useState<Region[]>(
    [],
  );
  const [selection, setSelection] = useState<Region | null>(null);
  const [history, setHistory] = useState<EditState[]>([]);
  const [future, setFuture] = useState<EditState[]>([]);
  const [noiseNotice, setNoiseNotice] = useState<string | null>(null);
  const noticeTimerRef = useRef<number>(0);

  /**
   * 展示提示：info（成功/结果通知）3 秒后自动消失；
   * error（失败）常驻，需手动关闭。新提示会替换旧提示并重置计时。
   */
  const notify = useCallback((message: string, kind: "info" | "error" = "info") => {
    window.clearTimeout(noticeTimerRef.current);
    setNoiseNotice(message);
    if (kind === "info") {
      noticeTimerRef.current = window.setTimeout(
        () => setNoiseNotice(null),
        3000,
      );
    }
  }, []);

  const dismissNotice = useCallback(() => {
    window.clearTimeout(noticeTimerRef.current);
    setNoiseNotice(null);
  }, []);

  useEffect(() => () => window.clearTimeout(noticeTimerRef.current), []);
  const [noisePreset, setNoisePreset] = useState<NoisePreset>(
    getNoisePreset() as NoisePreset,
  );
  const [silencePreset, setSilencePreset] = useState<SilencePreset>(
    getSilencePreset() as SilencePreset,
  );
  const [hasEnhancedAudio, setHasEnhancedAudio] = useState(false);
  const [showRecordingSetup, setShowRecordingSetup] = useState(false);
  const [modelDirInput, setModelDirInput] = useState("");
  const [autoTranscribeEnabled, setAutoTranscribeEnabled] = useState(
    getAutoTranscribe(),
  );
  const [recordingCountdown, setRecordingCountdown] = useState<number | null>(
    null,
  );
  const [isStartingRecording, setIsStartingRecording] = useState(false);
  const [denoisePreview, setDenoisePreview] = useState<AudioBuffer | null>(null);
  const [denoiseProgress, setDenoiseProgress] = useState<number | null>(null);
  const [transcript, setTranscript] = useState<TranscriptResult | null>(null);
  // 转录面板显隐与转录数据分离：关闭面板不丢数据，可在设置里重新打开。
  const [transcriptVisible, setTranscriptVisibleState] = useState(
    getTranscriptVisible,
  );
  const setTranscriptVisible = useCallback((visible: boolean) => {
    setTranscriptVisibleState(visible);
    persistTranscriptVisible(visible);
  }, []);
  // 导出格式与 MP3 码率（设置页可改，跨启动保留）
  const [exportFormat, setExportFormatState] =
    useState<ExportFormat>(getExportFormat);
  const [exportBitrate, setExportBitrateState] =
    useState<ExportBitrate>(getExportBitrate);
  // gap-gone 临时目录占用统计（设置页展示 + 一键清理）
  const [tempStorage, setTempStorage] = useState<TempStorageStatus | null>(
    null,
  );
  const [isClearingTemp, setIsClearingTemp] = useState(false);

  const refreshTempStorage = useCallback(async () => {
    try {
      setTempStorage(
        await invoke<TempStorageStatus>("temp_storage_status"),
      );
    } catch {
      setTempStorage(null);
    }
  }, []);

  // 打开设置页时拉一次临时目录占用统计
  useEffect(() => {
    if (showRecordingSetup && isTauriDesktop()) {
      void refreshTempStorage();
    }
  }, [showRecordingSetup, refreshTempStorage]);

  const handleClearTempFiles = useCallback(async () => {
    setIsClearingTemp(true);
    try {
      setTempStorage(await invoke<TempStorageStatus>("clear_temp_files"));
    } catch {
      notify("临时文件清理失败", "error");
    } finally {
      setIsClearingTemp(false);
    }
  }, []);

  const [transcribeProgress, setTranscribeProgress] =
    useState<TranscribeProgress | null>(null);
  const [playbackLevel, setPlaybackLevel] = useState<{
    rmsDb: number;
    peakDb: number;
  } | null>(null);
  const denoiseBaseRef = useRef<AudioBuffer | null>(null);

  const audioContextRef = useRef<AudioContext | null>(null);
  const originalBufferRef = useRef<AudioBuffer | null>(null);
  const currentTimeRef = useRef(0);
  const playbackTokenRef = useRef(0);
  const animationFrameRef = useRef<number | null>(null);
  const recordingCountdownRef = useRef<number | null>(null);
  const countdownAudioRef = useRef<HTMLAudioElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const waveformViewRef = useRef<HTMLDivElement>(null);
  const followRowRef = useRef(-1);
  const playbackRef = useRef<{
    token: number;
    segments: Region[];
    index: number;
    source: AudioBufferSourceNode | null;
    sourceStartedAt: number;
    sourceOffset: number;
  } | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const recorder = useRecorder();
  const deletedRegions = useMemo(
    () =>
      normalizeRegions([
        ...editState.manualRegions,
        ...editState.autoRegions,
      ]),
    [editState],
  );

  useEffect(() => {
    const AudioContextConstructor =
      window.AudioContext || (window as typeof window & { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const context = new AudioContextConstructor();
    audioContextRef.current = context;
    // 常驻分析节点：所有播放都路由经过它，供右侧音量刻度图读取实时电平。
    const analyser = context.createAnalyser();
    analyser.fftSize = 2048;
    analyser.connect(context.destination);
    analyserRef.current = analyser;
    const preventContextMenu = (event: MouseEvent) => event.preventDefault();
    document.addEventListener("contextmenu", preventContextMenu);

    return () => {
      playbackTokenRef.current += 1;
      if (animationFrameRef.current !== null) {
        cancelAnimationFrame(animationFrameRef.current);
      }
      try {
        playbackRef.current?.source?.stop();
      } catch {
        // The source may already be stopped.
      }
      if (recordingCountdownRef.current !== null) {
        window.clearInterval(recordingCountdownRef.current);
      }
      countdownAudioRef.current?.pause();
      countdownAudioRef.current = null;
      void context.close();
      document.removeEventListener("contextmenu", preventContextMenu);
    };
  }, []);

  // 应用启动时把 localStorage 里的自定义模型目录同步给 Rust；
  // 打开设置页时拉取当前生效目录用于展示。
  useEffect(() => {
    if (!isTauriDesktop()) return;
    const custom = getCustomModelDir();
    if (custom) void setTranscribeModelDir(custom).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!showRecordingSetup || !isTauriDesktop()) return;
    void getTranscribeModelDir().then(setModelDirInput).catch(() => undefined);
  }, [showRecordingSetup]);

  // 换音频后重置跟随行，保证新文件从第 0 行也能触发滚动。
  useEffect(() => {
    followRowRef.current = -1;
  }, [audioBuffer]);

  // 播放跟随：当前行变化时（含点击转录句/波形跳转），把该行滚动到视口居中，
  // 上一行/下一行同时可见，方便对照调整；行索引不变时早退，不打断手动浏览。
  useEffect(() => {
    if (!audioBuffer) return;
    const rowIndex = Math.floor(currentTime / 10);
    if (rowIndex === followRowRef.current) return;
    followRowRef.current = rowIndex;
    const container =
      waveformViewRef.current?.querySelector(".waveform-score-container");
    const row = container?.children[rowIndex] as HTMLElement | undefined;
    row?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [currentTime, audioBuffer]);

  const setPosition = useCallback((position: number) => {
    currentTimeRef.current = position;
    setCurrentTime(position);
  }, []);

  const getLivePosition = useCallback(() => {
    const playback = playbackRef.current;
    const context = audioContextRef.current;
    if (!playback || !context || !audioBuffer) return currentTimeRef.current;
    const segment = playback.segments[playback.index];
    return Math.min(
      segment.end,
      playback.sourceOffset + context.currentTime - playback.sourceStartedAt,
    );
  }, [audioBuffer]);

  const stopPlayback = useCallback(
    (updatePosition = true) => {
      const playback = playbackRef.current;
      if (updatePosition && playback) setPosition(getLivePosition());
      playbackTokenRef.current += 1;
      playbackRef.current = null;
      if (animationFrameRef.current !== null) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
      try {
        playback?.source?.stop();
      } catch {
        // The source may already be stopped.
      }
      setIsPlaying(false);
      setPlaybackLevel(null);
    },
    [getLivePosition, setPosition],
  );

  const startPlayback = useCallback(
    async (offset: number) => {
      if (!audioBuffer || !audioContextRef.current) return;
      if (audioContextRef.current.state === "suspended") {
        await audioContextRef.current.resume();
      }

      stopPlayback(false);
      const segments = getKeptRegions(deletedRegions, audioBuffer.duration);
      if (segments.length === 0) {
        setPosition(audioBuffer.duration);
        return;
      }

      const playableOffset = nextPlayableTime(
        offset,
        deletedRegions,
        audioBuffer.duration,
      );
      let index = segments.findIndex(
        (segment) =>
          playableOffset >= segment.start && playableOffset < segment.end,
      );
      if (index < 0) {
        setPosition(audioBuffer.duration);
        return;
      }

      const token = playbackTokenRef.current + 1;
      playbackTokenRef.current = token;

      const playSegment = (segmentIndex: number, sourceOffset: number) => {
        if (
          playbackTokenRef.current !== token ||
          !audioContextRef.current ||
          !audioBuffer
        ) {
          return;
        }
        const segment = segments[segmentIndex];
        const source = audioContextRef.current.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(analyserRef.current ?? audioContextRef.current.destination);
        playbackRef.current = {
          token,
          segments,
          index: segmentIndex,
          source,
          sourceStartedAt: audioContextRef.current.currentTime,
          sourceOffset,
        };
        source.onended = () => {
          if (playbackTokenRef.current !== token) return;
          const nextIndex = segmentIndex + 1;
          if (nextIndex < segments.length) {
            playSegment(nextIndex, segments[nextIndex].start);
          } else {
            playbackRef.current = null;
            setIsPlaying(false);
            setPlaybackLevel(null);
            setPosition(audioBuffer.duration);
          }
        };
        source.start(0, sourceOffset, segment.end - sourceOffset);
      };

      setIsPlaying(true);
      playSegment(index, Math.max(playableOffset, segments[index].start));
      const analyser = analyserRef.current;
      const samples = analyser ? new Float32Array(analyser.fftSize) : null;
      const animate = () => {
        if (playbackTokenRef.current !== token || !playbackRef.current) return;
        setPosition(getLivePosition());
        // 逐帧读取播放波形，换算 RMS/Peak dBFS 供右侧音量刻度图显示。
        if (analyser && samples) {
          analyser.getFloatTimeDomainData(samples);
          let sumSquares = 0;
          let peak = 0;
          for (let i = 0; i < samples.length; i++) {
            const v = samples[i];
            sumSquares += v * v;
            const abs = Math.abs(v);
            if (abs > peak) peak = abs;
          }
          const rms = Math.sqrt(sumSquares / samples.length);
          const toDb = (value: number) =>
            value > 0 ? 20 * Math.log10(value) : Number.NEGATIVE_INFINITY;
          setPlaybackLevel({ rmsDb: toDb(rms), peakDb: toDb(peak) });
        }
        animationFrameRef.current = requestAnimationFrame(animate);
      };
      animationFrameRef.current = requestAnimationFrame(animate);
    },
    [
      audioBuffer,
      deletedRegions,
      getLivePosition,
      setPosition,
      stopPlayback,
    ],
  );

  const togglePlayback = useCallback(() => {
    if (isPlaying) {
      stopPlayback(true);
      return;
    }
    void startPlayback(
      currentTimeRef.current >= (audioBuffer?.duration ?? 0)
        ? 0
        : currentTimeRef.current,
    );
  }, [audioBuffer, isPlaying, startPlayback, stopPlayback]);

  const resetEditing = () => {
    setPosition(0);
    setEditState(emptyEditState);
    setDetectedSilenceRegions([]);
    setSelection(null);
    setDenoisePreview(null);
    denoiseBaseRef.current = null;
    setHistory([]);
    setFuture([]);
  };

  const handleFileUpload = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = event.target.files?.[0];
    if (!file || !audioContextRef.current) return;
    setIsProcessing(true);
    stopPlayback(false);
    try {
      const decoded = await audioContextRef.current.decodeAudioData(
        await file.arrayBuffer(),
      );
      setAudioBuffer(decoded);
      originalBufferRef.current = decoded;
      setHasEnhancedAudio(false);
      setTranscript(null);
      resetEditing();
    } catch {
      notify("无法解析音频文件", "error");
    } finally {
      event.target.value = "";
      setIsProcessing(false);
    }
  };

  const handleSeek = (time: number) => {
    const position = audioBuffer
      ? nextPlayableTime(time, deletedRegions, audioBuffer.duration)
      : time;
    setPosition(position);
    if (isPlaying) void startPlayback(position);
  };

  const updateEditState = (next: EditState) => {
    setHistory((past) => [...past, editState]);
    setFuture([]);
    setEditState(next);
  };

  const handleRegionAdd = (start: number, end: number) => {
    if (!audioBuffer || end - start < 0.02) return;
    stopPlayback(true);
    updateEditState({
      ...editState,
      manualRegions: mergeRegions(
        editState.manualRegions,
        { start, end },
        audioBuffer.duration,
      ),
    });
  };

  const handleRegionRemove = (start: number, end: number) => {
    if (!audioBuffer || end - start < 0.02) return;
    stopPlayback(true);
    updateEditState({
      manualRegions: subtractRegion(
        editState.manualRegions,
        { start, end },
        audioBuffer.duration,
      ),
      autoRegions: subtractRegion(
        editState.autoRegions,
        { start, end },
        audioBuffer.duration,
      ),
    });
  };

  const undo = useCallback(() => {
    const previous = history[history.length - 1];
    if (!previous) return;
    setHistory((past) => past.slice(0, -1));
    setFuture((redo) => [editState, ...redo]);
    setEditState(previous);
  }, [editState, history]);

  const redo = useCallback(() => {
    const next = future[0];
    if (!next) return;
    setFuture((redoStack) => redoStack.slice(1));
    setHistory((past) => [...past, editState]);
    setEditState(next);
  }, [editState, future]);

  const handleDetectSilence = useCallback(() => {
    if (!audioBuffer) return;
    setIsProcessing(true);
    window.setTimeout(() => {
      try {
        const candidates = detectSilence(
          audioBuffer,
          SILENCE_PRESETS[silencePreset],
        );
        setDetectedSilenceRegions(candidates);
        if (candidates.length) {
          notify(
            `使用“${silencePresetLabels[silencePreset]}”预设检测到 ${candidates.length} 个静音候选片段，请检查波形后应用`,
          );
        } else {
          notify("未检测到符合条件的静音片段");
        }
      } catch {
        notify("静音分析失败", "error");
      } finally {
        setIsProcessing(false);
      }
    }, 0);
  }, [audioBuffer, silencePreset]);

  const applySilenceDetection = () => {
    if (!audioBuffer || !detectedSilenceRegions.length) return;
    stopPlayback(true);
    updateEditState({
      ...editState,
      autoRegions: normalizeRegions(
        detectedSilenceRegions,
        audioBuffer.duration,
      ),
    });
    setDetectedSilenceRegions([]);
    notify("已应用静音检测结果，可用“恢复本次检测”撤回");
  };

  const clearSilenceDetection = () => {
    setDetectedSilenceRegions([]);
    notify("已清除待应用的静音候选");
  };

  const restoreLastAutoDetection = useCallback(() => {
    if (!editState.autoRegions.length) return;
    stopPlayback(true);
    updateEditState({
      ...editState,
      autoRegions: [],
    });
    notify("已恢复本次自动检测结果，手动切除保持不变");
  }, [editState, stopPlayback]);

  const cancelRecordingCountdown = () => {
    if (recordingCountdownRef.current !== null) {
      window.clearInterval(recordingCountdownRef.current);
      recordingCountdownRef.current = null;
    }
    countdownAudioRef.current?.pause();
    countdownAudioRef.current = null;
    setRecordingCountdown(null);
  };

  const startRecordingWithCountdown = () => {
    if (
      recordingCountdownRef.current !== null ||
      isStartingRecording ||
      recorder.status === "recording" ||
      recorder.status === "requesting-permission" ||
      isProcessing
    ) {
      return;
    }

    // 倒计时语音（CC0，三个数字对齐到 0/1/2s，共 2.68s），恰在开录前喊完。
    // 界面文案与音频解耦：前两拍显示「准备」，最后一拍显示「开始」，
    // 后续换更短的提示音时只需调整这里的拍数与间隔。
    const countdownAudio = new Audio(countdownSfx);
    countdownAudio.volume = 0.7;
    countdownAudioRef.current = countdownAudio;
    void countdownAudio.play().catch(() => {
      // 自动播放被拒时静默失败，倒计时照常进行
    });

    let remaining = 3;
    setRecordingCountdown(remaining);
    recordingCountdownRef.current = window.setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) {
        if (recordingCountdownRef.current !== null) {
          window.clearInterval(recordingCountdownRef.current);
          recordingCountdownRef.current = null;
        }
        // 正常情况音频已播完；pause 兜底，避免残留外放被录进录音开头
        countdownAudioRef.current?.pause();
        countdownAudioRef.current = null;
        setRecordingCountdown(null);
        setIsStartingRecording(true);
        void recorder.startRecording().finally(() => {
          setIsStartingRecording(false);
        });
        return;
      }
      setRecordingCountdown(remaining);
    }, 1000);
  };

  const handleExport = useCallback(async () => {
    if (!audioBuffer) return;
    setIsProcessing(true);
    try {
      // MP3 为默认格式（纯 JS 编码，分块让出主线程）；WAV 走同步 PCM 编码
      const blob =
        exportFormat === "mp3"
          ? await encodeMp3(
              buildExportBuffer(audioBuffer, deletedRegions),
              exportBitrate,
            )
          : exportAudio(audioBuffer, deletedRegions);
      const saved = await saveToDisk(
        blob,
        createExportFileName(
          exportFormat,
          transcript ? extractKeyword(transcript.segments) : null,
        ),
      );
      if (saved) notify("导出成功");
    } catch (cause) {
      notify(
        cause instanceof Error ? cause.message : "导出失败，请重试",
        "error",
      );
    } finally {
      setIsProcessing(false);
    }
  }, [audioBuffer, deletedRegions, exportBitrate, exportFormat, transcript]);

  const confirmRecording = async () => {
    if (!recorder.recordedBlob || !audioContextRef.current) return;
    setIsProcessing(true);
    try {
      const decoded = await audioContextRef.current.decodeAudioData(
        await recorder.recordedBlob.arrayBuffer(),
      );
      setAudioBuffer(decoded);
      originalBufferRef.current = decoded;
      setHasEnhancedAudio(false);
      setTranscript(null);
      resetEditing();
      recorder.clearReview();
      // 设置页「自动转录」开启时，确定编辑后自动开始转录。
      // 注意必须传 decoded：audioBuffer 状态此刻尚未更新。
      if (autoTranscribeEnabled) {
        void handleTranscribe(decoded);
      }
    } catch {
      notify("无法解析这段录音", "error");
    } finally {
      setIsProcessing(false);
    }
  };

  const handleNoiseReduction = async () => {
    if (!audioBuffer || !audioContextRef.current) return;
    setIsProcessing(true);
    setDenoiseProgress(0);
    try {
      const result = await applyNoiseReduction(
        audioContextRef.current,
        audioBuffer,
        noisePreset,
        selection ?? undefined,
        setDenoiseProgress,
      );
      stopPlayback(false);
      denoiseBaseRef.current = audioBuffer;
      setDenoisePreview(result.buffer);
      setAudioBuffer(result.buffer);
      notify(
        `${result.engine} 已生成${noisePreset === "light" ? "轻度" : noisePreset === "strong" ? "强度" : "中度"}降噪试听，请播放确认`,
      );
    } catch {
      notify("降噪已取消或失败，原始音频未改变", "error");
    } finally {
      setDenoiseProgress(null);
      setIsProcessing(false);
    }
  };

  const cancelDenoiseProcessing = async () => {
    await cancelDeepFilterProcessing();
  };

  const handleTranscribe = async (source?: AudioBuffer) => {
    const target = source ?? audioBuffer;
    if (!target || !audioContextRef.current || !isTauriDesktop()) return;
    stopPlayback(false);
    setIsProcessing(true);
    setTranscribeProgress({ stage: "load", percent: -1 });
    const unlisten = await onTranscribeProgress(setTranscribeProgress);
    try {
      // 首次使用先下载模型（约 230MB），之后本地离线可用。
      const status = await checkTranscribeModel();
      if (!status.ready) {
        notify("首次使用转录需下载 SenseVoice 模型（约 230MB），下载中…");
        await downloadTranscribeModel();
      }
      const result = await runTranscription(target);
      setTranscript(result);
      setTranscriptVisible(true);
      notify(
        result.segments.length
          ? `转录完成，共 ${result.segments.length} 句，波形下方显示逐字对照，点击可跳转`
          : "转录完成，但没有识别到语音内容",
      );
    } catch (cause) {
      notify(
        String(cause).includes("取消")
          ? "转录已取消"
          : `转录失败：${cause instanceof Error ? cause.message : cause}`,
        String(cause).includes("取消") ? "info" : "error",
      );
    } finally {
      unlisten();
      setTranscribeProgress(null);
      setIsProcessing(false);
    }
  };

  const confirmNoiseReduction = () => {
    if (!denoisePreview) return;
    setDenoisePreview(null);
    denoiseBaseRef.current = null;
    setHasEnhancedAudio(true);
    notify("降噪版本已确认");
  };

  const cancelNoiseReduction = () => {
    if (denoiseBaseRef.current) {
      stopPlayback(false);
      setAudioBuffer(denoiseBaseRef.current);
      setPosition(0);
    }
    setDenoisePreview(null);
    denoiseBaseRef.current = null;
    notify("已取消降噪试听");
  };

  const restoreOriginal = () => {
    if (!originalBufferRef.current) return;
    stopPlayback(false);
    setAudioBuffer(originalBufferRef.current);
    setHasEnhancedAudio(false);
    setPosition(0);
  };

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (helpOpen) {
        if (event.key === "Escape") setHelpOpen(false);
        if (event.code === "Space") event.preventDefault();
        return;
      }

      if (event.key === "Escape") {
        if (recordingCountdown !== null) {
          event.preventDefault();
          cancelRecordingCountdown();
        } else if (recorder.status === "recording") {
          event.preventDefault();
          recorder.cancelRecording();
        } else if (recorder.status === "review" && recorder.recordedBlob) {
          event.preventDefault();
          recorder.cancelRecording();
        }
        return;
      }

      const target = event.target;
      const isTextEntryTarget =
        target instanceof HTMLElement &&
        target.closest(
          "input:not([type='checkbox']):not([type='radio']), textarea, [contenteditable='true']",
        );
      if (isTextEntryTarget || event.repeat) return;

      const hasPrimaryModifier = event.metaKey || event.ctrlKey;
      if (hasPrimaryModifier && !event.altKey && event.code === "KeyZ") {
        event.preventDefault();
        if (event.shiftKey) {
          redo();
        } else {
          undo();
        }
        return;
      }
      if (
        hasPrimaryModifier &&
        !event.altKey &&
        event.code === "KeyS" &&
        audioBuffer &&
        recorder.status !== "recording" &&
        !isProcessing
      ) {
        event.preventDefault();
        void handleExport();
        return;
      }

      // 工具栏按钮点击后焦点留在按钮上，这些快捷键仍要生效，
      // 因此焦点守卫只放行清单内的按键。
      // Space 必须放行：否则焦点在按钮上时，浏览器默认行为会用空格
      // 激活该按钮（曾导致按 Space 误触发「选择」而不是播放）。
      const isToolbarShortcut = [
        "KeyP",
        "KeyR",
        "KeyS",
        "KeyX",
        "KeyC",
        "KeyN",
        "KeyT",
        "KeyB",
        "Space",
      ].includes(event.code);
      if (
        target instanceof HTMLElement &&
        !isToolbarShortcut &&
        target.closest("select, button")
      ) {
        return;
      }

      if (event.code === "Enter" && recorder.status === "review") {
        event.preventDefault();
        void confirmRecording();
      } else if (
        event.code === "KeyO" &&
        recorder.status !== "recording" &&
        recordingCountdown === null &&
        !isStartingRecording &&
        !isProcessing
      ) {
        event.preventDefault();
        fileInputRef.current?.click();
      } else if (
        event.code === "KeyR" &&
        event.shiftKey &&
        audioBuffer &&
        recorder.status !== "recording" &&
        recorder.status !== "review" &&
        !isProcessing &&
        editState.autoRegions.length
      ) {
        event.preventDefault();
        restoreLastAutoDetection();
      } else if (
        event.code === "KeyS" &&
        recorder.status === "recording" &&
        !hasPrimaryModifier
      ) {
        event.preventDefault();
        void recorder.stopRecording();
      } else if (
        event.code === "KeyR" &&
        !event.shiftKey &&
        !hasPrimaryModifier &&
        recordingCountdown === null &&
        recorder.status !== "recording"
      ) {
        if (
          recorder.status !== "review" &&
          !isStartingRecording &&
          !isProcessing
        ) {
          event.preventDefault();
          startRecordingWithCountdown();
        }
      } else if (
        event.code === "KeyP" &&
        !hasPrimaryModifier &&
        recorder.status === "recording"
      ) {
        event.preventDefault();
        void (recorder.isPaused
          ? recorder.resumeRecording()
          : recorder.pauseRecording());
      } else if (event.code === "KeyD" && audioBuffer && !isProcessing) {
        event.preventDefault();
        handleDetectSilence();
      } else if (
        (event.code === "KeyX" || event.code === "KeyC") &&
        !hasPrimaryModifier &&
        !event.shiftKey &&
        audioBuffer &&
        recorder.status !== "recording"
      ) {
        // X = 切除，C = 恢复；再按一次回到默认（点按定位）模式，与按钮行为一致。
        event.preventDefault();
        const tool: EditMode = event.code === "KeyX" ? "cut" : "restore";
        setEditMode(editMode === tool ? "seek" : tool);
      } else if (
        event.code === "KeyN" &&
        !hasPrimaryModifier &&
        audioBuffer &&
        !isProcessing &&
        recorder.status !== "recording"
      ) {
        // N = 一键降噪
        event.preventDefault();
        void handleNoiseReduction();
      } else if (
        event.code === "KeyT" &&
        !hasPrimaryModifier &&
        audioBuffer &&
        !isProcessing &&
        recorder.status !== "recording" &&
        isTauriDesktop()
      ) {
        // T = 转录文字
        event.preventDefault();
        void handleTranscribe();
      } else if (
        event.code === "KeyB" &&
        !hasPrimaryModifier &&
        hasEnhancedAudio &&
        !isProcessing &&
        recorder.status !== "recording"
      ) {
        // B = 恢复原始（撤回已确认的降噪版本）
        event.preventDefault();
        restoreOriginal();
      } else if (
        event.code === "KeyH" ||
        event.key === "?" ||
        (event.code === "Slash" && event.shiftKey)
      ) {
        event.preventDefault();
        setHelpOpen(true);
      } else if (event.code === "Space") {
        event.preventDefault();
        togglePlayback();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    audioBuffer,
    cancelRecordingCountdown,
    confirmRecording,
    editMode,
    editState.autoRegions.length,
    handleExport,
    handleDetectSilence,
    helpOpen,
    isProcessing,
    isStartingRecording,
    recorder.cancelRecording,
    recorder.isPaused,
    recorder.pauseRecording,
    recorder.recordedBlob,
    recorder.resumeRecording,
    recorder.stopRecording,
    recorder.status,
    recordingCountdown,
    restoreLastAutoDetection,
    redo,
    startRecordingWithCountdown,
    togglePlayback,
    undo,
  ]);

  return (
    <main className="container">
      <div className="controls">
        <div className="controls-row controls-row-primary">
        {audioBuffer && (
          <div className="toolbar-time">
            {formatTimeStandard(currentTime)} /{" "}
            {formatTimeStandard(audioBuffer.duration)}
          </div>
        )}
        <div className="toolbar-group" aria-label="文件和录音">
          <label className="file-input-label" title="快捷键 O：打开音频">
            打开
            <span className="shortcut-key">O</span>
            <input
              ref={fileInputRef}
              type="file"
              accept="audio/*"
              onChange={handleFileUpload}
              style={{ display: "none" }}
            />
          </label>
          <button
            onClick={startRecordingWithCountdown}
            title="快捷键 R：开始录音"
            aria-keyshortcuts="R"
            disabled={
              recorder.status === "recording" ||
              recorder.status === "requesting-permission" ||
              recordingCountdown !== null ||
              isStartingRecording ||
              isProcessing
            }
          >
            {isStartingRecording
              ? "启动录音..."
              : recorder.status === "requesting-permission"
              ? "请求权限..."
              : "录音"}
            <span className="shortcut-key">R</span>
          </button>
          <button
            onClick={() => setShowRecordingSetup((visible) => !visible)}
            disabled={recordingCountdown !== null || isStartingRecording}
          >
            设置
          </button>
        </div>
        <span className="toolbar-divider" aria-hidden="true" />
        <div className="toolbar-group" aria-label="播放">
          <button
            onClick={togglePlayback}
            disabled={!audioBuffer}
            className={isPlaying ? "btn-playing" : ""}
          >
            {isPlaying ? "暂停" : "播放"}{" "}
            <span className="shortcut-key">Space</span>
          </button>
        </div>
        <span className="toolbar-divider" aria-hidden="true" />
        <div className="toolbar-group" aria-label="编辑">
          <button
            className={editMode === "select" ? "btn-tool-active" : ""}
            onClick={() =>
              setEditMode(editMode === "select" ? "seek" : "select")
            }
            disabled={!audioBuffer}
          >
            选择
          </button>
          <button
            className={editMode === "cut" ? "btn-tool-active" : ""}
            onClick={() => setEditMode(editMode === "cut" ? "seek" : "cut")}
            disabled={!audioBuffer}
            aria-keyshortcuts="X"
          >
            切除 <span className="shortcut-key">X</span>
          </button>
          <button
            className={editMode === "restore" ? "btn-tool-active" : ""}
            onClick={() =>
              setEditMode(editMode === "restore" ? "seek" : "restore")
            }
            disabled={!audioBuffer}
            aria-keyshortcuts="C"
          >
            恢复 <span className="shortcut-key">C</span>
          </button>
          <button onClick={undo} disabled={!history.length}>
            撤销 <span className="shortcut-key">⌘/Ctrl+Z</span>
          </button>
          <button onClick={redo} disabled={!future.length}>
            重做 <span className="shortcut-key">⌘/Ctrl+Shift+Z</span>
          </button>
        </div>
        </div>
        <div className="controls-row controls-row-secondary">
        <div className="toolbar-group silence-tools" aria-label="去静音">
          <span className="toolbar-label">去静音</span>
          <select
            className="silence-preset"
            value={silencePreset}
            onChange={(event) => {
              const preset = event.target.value as SilencePreset;
              setSilencePreset(preset);
              persistSilencePreset(preset);
              setDetectedSilenceRegions([]);
            }}
            disabled={!audioBuffer || isProcessing}
            aria-label="去静音保留量"
          >
            <option value="compact">紧凑</option>
            <option value="natural">自然</option>
            <option value="relaxed">宽松</option>
          </select>
          <button
            onClick={handleDetectSilence}
            disabled={!audioBuffer || isProcessing}
          >
            检测静音 <span className="shortcut-key">D</span>
          </button>
          {detectedSilenceRegions.length > 0 && (
            <>
              <span className="silence-candidate-count">
                待应用 {detectedSilenceRegions.length}
              </span>
              <button
                className="btn-tool-active"
                onClick={applySilenceDetection}
                disabled={isProcessing}
              >
                应用检测
              </button>
              <button onClick={clearSilenceDetection} disabled={isProcessing}>
                清除候选
              </button>
            </>
          )}
          <button
            onClick={restoreLastAutoDetection}
            disabled={!editState.autoRegions.length || isProcessing}
          >
            恢复检测 <span className="shortcut-key">Shift+R</span>
          </button>
        </div>
        <span className="toolbar-divider" aria-hidden="true" />
        <div className="toolbar-group" aria-label="降噪">
          <select
            className="noise-preset"
            value={noisePreset}
            onChange={(event) => {
              const preset = event.target.value as NoisePreset;
              setNoisePreset(preset);
              persistNoisePreset(preset);
            }}
            disabled={!audioBuffer || isProcessing}
            aria-label="降噪强度"
          >
            <option value="light">降噪：轻</option>
            <option value="medium">降噪：中</option>
            <option value="strong">降噪：强</option>
          </select>
          <button
            onClick={() => void handleNoiseReduction()}
            disabled={!audioBuffer || isProcessing}
          >
            一键降噪 <span className="shortcut-key">N</span>
          </button>
          {denoiseProgress !== null && (
            <>
              <span className="denoise-progress">
                {/* Rust 端首次加载模型时发 -1，之后才是真实百分比 */}
                {denoiseProgress < 0
                  ? "正在加载降噪模型…"
                  : `降噪 ${Math.round(denoiseProgress)}%`}
              </span>
              <button onClick={() => void cancelDenoiseProcessing()}>
                取消降噪
              </button>
            </>
          )}
          {denoisePreview && (
            <>
              <button
                className="btn-tool-active"
                onClick={confirmNoiseReduction}
              >
                确认降噪
              </button>
              <button onClick={cancelNoiseReduction}>取消试听</button>
            </>
          )}
          <button onClick={restoreOriginal} disabled={!hasEnhancedAudio}>
            恢复原始 <span className="shortcut-key">B</span>
          </button>
        </div>
        {isTauriDesktop() && (
          <>
            <span className="toolbar-divider" aria-hidden="true" />
            <div className="toolbar-group" aria-label="转录">
              <button
                onClick={() => void handleTranscribe()}
                disabled={!audioBuffer || isProcessing}
              >
                转录文字 <span className="shortcut-key">T</span>
              </button>
              {transcribeProgress && (
                <>
                  <span className="denoise-progress">
                    {transcribeProgress.stage === "download" &&
                      `下载模型 ${Math.round(transcribeProgress.percent)}%`}
                    {transcribeProgress.stage === "load" &&
                      "正在加载转录模型…"}
                    {transcribeProgress.stage === "transcribe" &&
                      `转录 ${Math.round(transcribeProgress.percent)}%`}
                  </span>
                  <button onClick={() => void cancelTranscribe()}>
                    取消转录
                  </button>
                </>
              )}
            </div>
          </>
        )}
        <span className="toolbar-divider" aria-hidden="true" />
        <div className="toolbar-group" aria-label="输出和帮助">
          <button onClick={handleExport} disabled={!audioBuffer || isProcessing}>
            导出 {exportFormat === "mp3" ? "MP3" : "WAV"}{" "}
            <span className="shortcut-key">⌘/Ctrl+S</span>
          </button>
          <button onClick={() => setHelpOpen(true)}>
            帮助 <span className="shortcut-key">H</span>
          </button>
        </div>
        </div>
      </div>

      {recordingCountdown !== null && (
        <section
          className="recording-countdown"
          role="status"
          aria-live="assertive"
        >
          <span className="countdown-number">
            {recordingCountdown > 1 ? "准备" : "开始"}
          </span>
          <p>
            {recordingCountdown > 1 ? "倒计时结束后开始录音" : "马上开始录音"}
          </p>
          <button
            onClick={cancelRecordingCountdown}
            title="快捷键 Esc：取消倒计时"
            aria-keyshortcuts="Escape"
          >
            取消 <span className="shortcut-key">Esc</span>
          </button>
        </section>
      )}

      {showRecordingSetup &&
        recorder.status !== "recording" &&
        recordingCountdown === null && (
        <section className="recording-setup">
          <div className="setup-row">
            <label className="setup-grow">
              录音设备
              <select
                value={recorder.selectedDeviceId}
                onChange={(event) =>
                  recorder.setSelectedDeviceId(event.target.value)
                }
              >
                {recorder.devices.length === 0 && (
                  <option value="">点击刷新设备列表</option>
                )}
                {recorder.devices.map((device) => (
                  <option key={device.deviceId} value={device.deviceId}>
                    {device.label}
                  </option>
                ))}
              </select>
            </label>
            <button onClick={() => void recorder.refreshDevices()}>刷新</button>
            <button onClick={() => setShowRecordingSetup(false)}>确定</button>
          </div>
          {isTauriDesktop() && (
            <>
              <div className="setup-row">
                <label className="setup-grow">
                  转录模型目录
                  <input
                    type="text"
                    value={modelDirInput}
                    placeholder="默认：~/models/sense-voice"
                    onChange={(event) => setModelDirInput(event.target.value)}
                  />
                </label>
                <button
                  onClick={() => {
                    const value = modelDirInput.trim();
                    setCustomModelDir(value || null);
                    void setTranscribeModelDir(value || null).catch(() =>
                      notify("模型目录保存失败", "error"),
                    );
                  }}
                >
                  保存
                </button>
                <button
                  onClick={() => void openTranscribeModelDir()}
                  title="在文件管理器中打开模型目录"
                >
                  打开目录
                </button>
              </div>
              <div className="setup-row">
                <label className="setup-checkbox">
                  <input
                    type="checkbox"
                    checked={autoTranscribeEnabled}
                    onChange={(event) => {
                      setAutoTranscribeEnabled(event.target.checked);
                      setAutoTranscribe(event.target.checked);
                    }}
                  />
                  录音确定编辑后自动转录
                </label>
              </div>
              <div className="setup-row">
                <label
                  className="setup-checkbox"
                  title={transcript ? "" : "当前没有转录结果，先执行一次转录"}
                >
                  <input
                    type="checkbox"
                    checked={transcriptVisible}
                    disabled={!transcript}
                    onChange={(event) =>
                      setTranscriptVisible(event.target.checked)
                    }
                  />
                  显示转录文字面板
                </label>
              </div>
              <div className="setup-row">
                <small>
                  临时文件目录：{tempStorage
                    ? `${formatBytes(tempStorage.bytes)} · ${tempStorage.fileCount} 个文件`
                    : "统计中…"}
                </small>
                <button
                  disabled={isClearingTemp || !tempStorage}
                  onClick={() => void handleClearTempFiles()}
                >
                  {isClearingTemp ? "清理中…" : "一键清理"}
                </button>
              </div>
            </>
          )}
          <div className="setup-row">
            <label className="setup-checkbox">导出格式</label>
            <label className="setup-checkbox">
              <input
                type="radio"
                name="export-format"
                checked={exportFormat === "mp3"}
                onChange={() => {
                  setExportFormatState("mp3");
                  setExportFormat("mp3");
                }}
              />
              MP3（默认）
            </label>
            <label className="setup-checkbox">
              <input
                type="radio"
                name="export-format"
                checked={exportFormat === "wav"}
                onChange={() => {
                  setExportFormatState("wav");
                  setExportFormat("wav");
                }}
              />
              WAV
            </label>
          </div>
          {exportFormat === "mp3" && (
            <div className="setup-row">
              <label className="setup-checkbox">MP3 码率</label>
              {([96, 128, 192] as const).map((bitrate) => (
                <label className="setup-checkbox" key={bitrate}>
                  <input
                    type="radio"
                    name="export-bitrate"
                    checked={exportBitrate === bitrate}
                    onChange={() => {
                      setExportBitrateState(bitrate);
                      setExportBitrate(bitrate);
                    }}
                  />
                  {bitrate} kbps{bitrate === 128 ? "（推荐）" : ""}
                </label>
              ))}
            </div>
          )}
          <div className="setup-row">
            <small>录音格式：48 kHz / mono / PCM WAV</small>
          </div>
        </section>
        )}

      {recorder.status === "recording" && (
        <section className="recording-panel">
          <div className="recording-panel-header">
            <strong
              className={recorder.isPaused ? "recording-status is-paused" : ""}
            >
              {recorder.isPaused ? "已暂停" : "正在录音"}{" "}
              {formatTimeStandard(recorder.duration)}
            </strong>
            {recorder.glitchCount > 0 && (
              <span className="recording-glitch-hint">
                采集毛刺 ×{recorder.glitchCount}（已自动忽略，不影响继续录音）
              </span>
            )}
            <label>
              输入设备
              <select
                value={recorder.selectedDeviceId}
                disabled
                onChange={(event) =>
                  recorder.setSelectedDeviceId(event.target.value)
                }
              >
                {recorder.devices.map((device) => (
                  <option key={device.deviceId} value={device.deviceId}>
                    {device.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="meter-line">
            <div className="meter-wrap">
              <div
                className={`meter${recorder.level.peakDb >= -6 ? " meter-warning" : ""}`}
                aria-label="实时输入电平"
              >
                <div
                  className="meter-rms"
                  style={{
                    transform: `scaleX(${meterPosition(recorder.level.rmsDb)})`,
                  }}
                />
                <div
                  className="meter-peak"
                  style={{
                    left: `${meterPosition(recorder.level.peakDb) * 100}%`,
                  }}
                />
                {METER_MARKS.map((db) => (
                  <span
                    key={db}
                    className="meter-tick"
                    style={{ left: `${meterPosition(db) * 100}%` }}
                  />
                ))}
              </div>
              <div className="meter-scale" aria-hidden="true">
                {METER_MARKS.map((db) => (
                  <span
                    key={db}
                    className="meter-scale-label"
                    style={{ left: `${meterPosition(db) * 100}%` }}
                  >
                    {db} dB
                  </span>
                ))}
              </div>
            </div>
            <button
              type="button"
              className={`clip-indicator${recorder.clipLatched ? " is-clipped" : ""}`}
              onClick={recorder.clearClip}
              title="点击清除削波提示"
              aria-label={
                recorder.clipLatched
                  ? "已检测到削波，点击清除提示"
                  : "未检测到削波"
              }
            >
              CLIP
            </button>
          </div>
          <div className="meter-readouts">
            <span>RMS {formatDb(recorder.level.rmsDb)}</span>
            <span>Peak {formatDb(recorder.level.peakDb)}</span>
            <span>保持 {formatDb(recorder.peakHoldDb)}</span>
          </div>
          <label className="monitor-toggle">
            <input
              type="checkbox"
              checked={recorder.monitorEnabled}
              onChange={(event) =>
                recorder.setMonitorEnabled(event.target.checked)
              }
            />
            耳机监听（请勿使用扬声器）
          </label>
          <div className="recording-actions">
            <button
              className={recorder.isPaused ? "btn-recording-resume" : ""}
              onClick={() =>
                void (recorder.isPaused
                  ? recorder.resumeRecording()
                  : recorder.pauseRecording())
              }
              title="快捷键 P：暂停/继续录音"
              aria-keyshortcuts="P"
            >
              {recorder.isPaused ? "继续" : "暂停"}{" "}
              <span className="shortcut-key">P</span>
            </button>
            <button
              onClick={recorder.cancelRecording}
              title="快捷键 Esc：取消录音并返回编辑页"
              aria-keyshortcuts="Escape"
            >
              取消 <span className="shortcut-key">Esc</span>
            </button>
            <button
              onClick={() => void recorder.stopRecording()}
              title="快捷键 S：停止录音"
              aria-keyshortcuts="S"
            >
              停止录音 <span className="shortcut-key">S</span>
            </button>
          </div>
        </section>
      )}

      {recorder.status === "review" && recorder.recordedBlob && (
        <section className="recording-review">
          <strong>录音完成</strong>
          <span>{formatTimeStandard(recorder.duration)}</span>
          <button
            onClick={recorder.cancelRecording}
            title="快捷键 Esc：取消录音结果"
            aria-keyshortcuts="Escape"
          >
            取消 <span className="shortcut-key">Esc</span>
          </button>
          <button
            onClick={() => void confirmRecording()}
            title="快捷键 Enter：确定并编辑"
            aria-keyshortcuts="Enter"
          >
            确定并编辑 <span className="shortcut-key">Enter</span>
          </button>
        </section>
      )}

      {recorder.error && <div className="inline-error">{recorder.error}</div>}
      {noiseNotice && (
        <div className="inline-notice" role="status">
          {noiseNotice}
          <button onClick={dismissNotice}>关闭</button>
        </div>
      )}

      <div className="waveform-view" ref={waveformViewRef}>
        {isProcessing && (
          <div className="loading-overlay">
            <div className="spinner" />
            <p>处理中...</p>
          </div>
        )}
        {audioBuffer ? (
          <WaveformScore
            buffer={audioBuffer}
            currentTime={currentTime}
            onSeek={handleSeek}
            regions={deletedRegions}
            onRegionAdd={handleRegionAdd}
            onRegionRemove={handleRegionRemove}
            editMode={editMode}
            selection={selection}
            onSelectionChange={setSelection}
            previewRegions={detectedSilenceRegions}
            words={transcript?.words ?? null}
          />
        ) : (
          <div className="empty-state">请打开音频或点击“录音”开始</div>
        )}
      </div>

      {audioBuffer && <WaveSidebar level={playbackLevel} />}

      {transcript && audioBuffer && transcriptVisible && (
        <TranscriptPanel
          segments={transcript.segments}
          currentTime={currentTime}
          deletedRegions={deletedRegions}
          onSeek={handleSeek}
          onClose={() => setTranscriptVisible(false)}
        />
      )}

      <HelpModal
        open={helpOpen}
        onClose={() => setHelpOpen(false)}
        editMode={editMode}
      />
    </main>
  );
}

export default App;
