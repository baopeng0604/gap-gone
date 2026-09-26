import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { readFile, writeFile } from "@tauri-apps/plugin-fs";
import WaveformScore from "./components/WaveformScore";
import HelpModal from "./components/HelpModal";
import PlaybackSidebar, {
  SPEED_STEPS,
} from "./components/PlaybackSidebar";
import VideoPreview from "./components/VideoPreview";
import {
  getKeptRegions,
  mapRangeToKept,
  mergeRegions,
  nextPlayableTime,
  normalizeRegions,
  subtractRegion,
  type Region,
} from "./utils/regionUtils";
import {
  bufferToWav,
  buildExportBuffer,
  exportAudio,
  saveToDisk,
} from "./utils/exportUtils";
import { encodeMp3 } from "./utils/mp3Export";
import { extractKeyword } from "./utils/keywordExtract";
import {
  getCompressionPreset,
  getExportBitrate,
  getExportFormat,
  getFfmpegPath,
  getLufsTarget,
  getNoisePreset,
  getSilencePreset,
  getSilenceThreshold,
  getTranscriptVisible,
  getVideoTransition,
  getVideoTransitionType,
  getVideoVariant,
  LUFS_TARGET_PRESETS,
  LUFS_TARGET_RANGE,
  setCompressionPreset as persistCompressionPreset,
  setExportBitrate,
  setExportFormat,
  setFfmpegPath as persistFfmpegPath,
  setLufsTarget as persistLufsTarget,
  setNoisePreset as persistNoisePreset,
  setSilencePreset as persistSilencePreset,
  setSilenceThreshold as persistSilenceThreshold,
  setTranscriptVisible as persistTranscriptVisible,
  setVideoTransition as persistVideoTransition,
  setVideoTransitionType as persistVideoTransitionType,
  setVideoVariant as persistVideoVariant,
  VIDEO_TRANSITION_RANGE,
  VIDEO_TRANSITION_TYPES,
  type ExportBitrate,
  type ExportFormat,
  type VideoExportVariant,
  type VideoTransitionType,
} from "./utils/settings";
import { formatTimeStandard } from "./utils/timeUtils";
import {
  detectSilence,
  SILENCE_PRESETS,
  SILENCE_THRESHOLD_PRESETS,
  SILENCE_THRESHOLD_RANGE,
  type SilencePreset,
} from "./utils/audioAnalysis";
import {
  applyNoiseReduction,
  cancelDeepFilterProcessing,
  floatWavToBuffer,
  type NoisePreset,
} from "./utils/noiseReduction";
import {
  COMPRESSION_PRESETS,
  COMPRESSION_PRESET_LIST,
  runVoiceChain,
  type ChainResult,
  type CompressionPreset,
} from "./utils/compression";
import {
  buildSrt,
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
  transcribeModelStatusText,
  type TranscriptResult,
  type TranscribeModelStatus,
  type TranscribeProgress,
} from "./utils/transcribe";
import {
  formatLufs,
  integratedLufsFromBuffer,
  lufsBand,
  lufsBandLabel,
  normalizeLoudness,
  type LoudnessNormalizeResult,
} from "./utils/lufs";
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

/** 设置面板打开时的快照，「取消」据此把本次改动回退。 */
interface SetupSnapshot {
  deviceId: string;
  /** 后端当前生效的模型目录；异步取，未取到时保持 undefined（不回退该项）。 */
  modelDir?: string | null;
  autoTranscribe: boolean;
  transcriptVisible: boolean;
  silenceThreshold: number;
  lufsTarget: number;
  exportFormat: ExportFormat;
  exportBitrate: ExportBitrate;
  videoVariant: VideoExportVariant;
  videoTransition: number;
  videoTransitionType: VideoTransitionType;
  /** 设置页「ffmpeg 路径」输入框当时的值（含 Windows 默认值）。 */
  ffmpegPath: string;
}

const silencePresetLabels: Record<SilencePreset, string> = {
  compact: "紧凑",
  natural: "自然",
  relaxed: "宽松",
};

/** detect_ffmpeg 的返回：系统 / 用户指定路径的 ffmpeg 探测结果。 */
interface FfmpegInfo {
  found: boolean;
  path: string | null;
  version: string | null;
  /** 该构建是否带 libx264：决定「精确重编码」档能不能用。 */
  hasLibx264: boolean;
  /** 该构建是否带 xfade 滤镜：决定「切片过渡」能不能用（精简构建可能没有）。 */
  hasXfade: boolean;
}

/** probe_video 的返回（ffprobe JSON 提炼）。 */
interface VideoProbe {
  duration: number;
  width: number;
  height: number;
  videoCodec: string;
  audioCodec: string;
  sampleRate: number;
  channels: number;
  audioBitrate: number | null;
  /** 画面是否带旋转元数据（手机竖拍）：允许导入，但禁用「无损快速」。 */
  rotated: boolean;
  /** 画面是否含 B 帧：含则禁用「无损快速」（输出侧 seek 会整段丢掉第一个 GOP）。 */
  hasBFrames: boolean;
  /** 源视频帧率的分数串（ffprobe r_frame_rate，如 "30/1"）：过渡按帧取整要用。 */
  fps: string;
  /** 关键帧时间戳（秒，升序，ffprobe 原始精度）。无损快速档只能从关键帧起切。 */
  keyframes: number[];
}

/** 已导入视频的上下文；存在即处于视频模式，导出走 export_video。 */
interface VideoAsset {
  /** 原视频绝对路径（ffmpeg 输入）。 */
  path: string;
  /** convertFileSrc 转出的 asset 协议地址（<video> 预览用）。 */
  src: string;
  /** 原音轨码率，回写 AAC 时用作码率下限。 */
  audioBitrate: number | null;
  /** 视频编码名（h264 / hevc…）。非 H.264 只能走精确重编码。 */
  videoCodec: string;
  /** 原音轨声道数，重编码回写 AAC 时用来定码率下限（每声道 96k）。 */
  channels: number;
  /** 是否带旋转元数据，带则只能走精确重编码。 */
  rotated: boolean;
  /** 是否含 B 帧，含则只能走精确重编码（原因见 VideoProbe.hasBFrames）。 */
  hasBFrames: boolean;
  /** 源视频帧率的分数串（ffprobe r_frame_rate），切片过渡按帧取整与 xfade 都要用。 */
  fps: string;
  /** 关键帧时间戳（秒，升序），无损快速档的吸附基准。 */
  keyframes: number[];
}

/**
 * 无损快速档的切点吸附：往 1 ms 的让位等细节见 fastcopyPlan；
 * 档位类型 VideoExportVariant 来自 settings.ts（它是持久化的用户偏好）。
 */

/**
 * 吸附后的起点再往回让 1 ms。关键帧时间戳是 6 位小数（如 16.666667，真值 16.6666666…），
 * 直接拿它当 `-ss`，一旦被四舍五入抬高就会越过关键帧 —— 输出侧 seek 会因此丢掉整段画面。
 */
const FASTCOPY_SEEK_EPSILON = 0.001;
/**
 * 短于一帧的过渡没有意义（30 fps 下 0.034 秒 ≈ 1 帧），按硬切处理。
 * 与 Rust 的 `MIN_FRAME_SECONDS` 同一个值，改一处要改两处。
 */
const MIN_TRANSITION_SECONDS = 0.034;

/** ffprobe 的 r_frame_rate 是分数串（"30/1"、"30000/1001"），换算成每秒帧数。 */
function parseFrameRate(rate: string): number {
  const [numerator, denominator] = rate.split("/").map(Number);
  if (!Number.isFinite(numerator)) return 0;
  if (!Number.isFinite(denominator) || denominator <= 0) return numerator || 0;
  return numerator / denominator;
}

function lastKeyframeAtOrBefore(keyframes: number[], time: number): number {
  let result = 0;
  for (const keyframe of keyframes) {
    if (keyframe <= time + 1e-9) {
      result = keyframe;
    } else {
      break;
    }
  }
  return result;
}

function maxKeyframeInterval(keyframes: number[]): number {
  let max = 0;
  for (let index = 1; index < keyframes.length; index += 1) {
    max = Math.max(max, keyframes[index] - keyframes[index - 1]);
  }
  return max;
}

function formatDb(value: number) {
  return Number.isFinite(value) ? `${value.toFixed(1)} dBFS` : "-∞ dBFS";
}

function LufsReadout({ lufs, target }: { lufs: number; target: number }) {
  const band = lufsBand(lufs, target);
  return (
    <span
      className={band ? `lufs-readout lufs-${band}` : "lufs-readout"}
      title={`成片 Integrated LUFS，当前目标 ${target} LUFS`}
    >
      {formatLufs(lufs)}
      {band ? ` ${lufsBandLabel(band)}` : ""}
    </span>
  );
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

const METER_MIN_DB = -60;
const METER_MARKS = [-60, -54, -48, -42, -36, -30, -24, -18, -12, -6, 0];
/**
 * 录音目标区间 -12 ~ -6 dBFS。太低信噪比不够，太高留不出余量；
 * 表上画一条半透明目标带，让「有没有落进去」一眼可见。
 */
const METER_TARGET_RANGE = { min: -12, max: -6 };
/**
 * 播放电平的采样窗口（秒）。与 Rust 端录音上报的聚合窗口同值，
 * 两侧读数才是同一把尺子。
 */
const PLAYBACK_METER_WINDOW_SEC = 0.1;
/**
 * 真峰值上限：WAV 按播客规范 -1 dBTP；MP3 有损编码还会额外过冲 0.5 dB 左右，
 * 所以交付 MP3 时压到 -1.5 dBTP，避免编码完反而越线。
 */
const LUFS_CEILING_DB_WAV = -1;
const LUFS_CEILING_DB_MP3 = -1.5;
/** 限幅衰减超过这个量，说明素材动态明显偏大，值得提示用户。 */
const LUFS_HEAVY_LIMIT_DB = 6;

/**
 * 设置页「转录模型目录」的占位提示。Windows 上默认目录在仓库内（与 Rust 侧
 * `WINDOWS_MODELS_ROOT` 对应，见 `src-tauri/src/transcribe.rs`），其余平台是用户主目录。
 * 输入框真正显示的目录由后端 `get_transcribe_model_dir` 给，这里只是输入框为空时的提示。
 */
const DEFAULT_MODEL_DIR_HINT =
  typeof navigator !== "undefined" && /windows/i.test(navigator.userAgent)
    ? "默认：D:\\Code\\Github\\gap-gone\\models\\sense-voice"
    : "默认：~/models/sense-voice";

function formatTruePeak(db: number) {
  return Number.isFinite(db) ? `${db.toFixed(1)} dBTP` : "-∞ dBTP";
}

/** 标准化结果播报：响度、真峰值、限幅衰减，外加不达标时的原因。 */
function loudnessReport(
  result: LoudnessNormalizeResult,
  targetLufs: number,
  ceilingDb: number,
) {
  const parts = [
    `响度 ${formatLufs(result.beforeLufs)} → ${formatLufs(result.afterLufs)}（目标 ${targetLufs}）`,
    `真峰值 ${formatTruePeak(result.truePeakDb)}（上限 ${ceilingDb}）`,
    `限幅衰减 ${result.gainReductionDb.toFixed(1)} dB`,
  ];
  if (result.gainReductionDb > LUFS_HEAVY_LIMIT_DB) {
    parts.push("素材动态偏大，限幅较深，可考虑先做压缩");
  }
  if (!result.converged) {
    parts.push(`未收敛到目标，已迭代 ${result.passes} 轮`);
  }
  parts.push("已保留处理前版本，可用「撤销响度」回退");
  return parts.join(" · ");
}

/**
 * 语音优化链播报：链路各步与响度标准化结果一次说完。
 *
 * 为什么合并播报：这是一条流水线（高通 → 扩展 → 压缩 → 归一），用户点一次就该看到
 * 最终结果；分两段播报会有两条「已保留处理前版本」的收尾句，啰嗦且互相打架。
 *
 * 不再播报「自动补偿」：0.1.49 起压缩不做补偿，峰值改由「目标 LUFS + 限幅上限」共同
 * 保证，所以最终真峰值与限幅衰减这两个数就是用户该信的那两个。
 */
function compressionReport(
  result: ChainResult,
  normalized: LoudnessNormalizeResult | null,
  targetLufs: number,
  ceilingDb: number,
) {
  const { compression, expander } = result;
  const label = COMPRESSION_PRESETS[compression.preset].label;
  const steps = [`高通 ${result.highPassHz} Hz`];
  if (expander.applied && expander.thresholdDb !== null) {
    steps.push(
      `扩展底噪（阈值 ${expander.thresholdDb.toFixed(0)} dBFS、最多 ${expander.rangeDb} dB）`,
    );
  } else if (expander.skipReason === "clean") {
    steps.push(`底噪已够干净（${formatDb(expander.noiseFloorDb)}），未做扩展`);
  } else {
    steps.push("底噪与语音挨得太近，未做扩展");
  }
  const parts: string[] = [`已做语音优化：${steps.join(" · ")}`];
  if (compression.skipped) {
    parts.push(
      compression.sourceSpanDb === null
        ? "这段本来就很稳，无需压缩"
        : `这段本来就很稳（跨度 ${compression.sourceSpanDb.toFixed(1)} dB 已接近目标 ${compression.targetSpanDb} dB），无需压缩`,
    );
  } else {
    const { thresholdDb, ratio } = compression.params;
    const generated = `阈值 ${thresholdDb.toFixed(0)} dBFS、压缩比 ${ratio.toFixed(1)}:1`;
    if (compression.sourceSpanDb === null) {
      parts.push(`已按「${label}」档压缩（素材太短，用保守参数：${generated}）`);
    } else {
      const span =
        compression.outputSpanDb === null
          ? `跨度 ${compression.sourceSpanDb.toFixed(1)} dB`
          : `跨度 ${compression.sourceSpanDb.toFixed(1)} dB → ${compression.outputSpanDb.toFixed(1)} dB`;
      parts.push(
        `已按「${label}」档压缩（${span}，目标 ${compression.targetSpanDb} dB，${generated}）`,
      );
    }
    parts.push(
      `成片有效电平 ${formatDb(compression.sourceRmsDb)}`,
      `平均压掉 ${compression.averageReductionDb.toFixed(1)} dB`,
    );
    if (compression.capped) {
      parts.push("已达压缩比上限 4:1，再往上压会听出抽气");
    }
    if (compression.averageReductionDb < 1) {
      parts.push("几乎没压到：输入电平太低，先调高麦克风增益");
    }
  }
  if (normalized) {
    parts.push(
      `响度 ${formatLufs(normalized.beforeLufs)} → ${formatLufs(normalized.afterLufs)}（目标 ${targetLufs}）`,
      `最终真峰值 ${formatTruePeak(normalized.truePeakDb)}（上限 ${ceilingDb}）`,
      `限幅衰减 ${normalized.gainReductionDb.toFixed(1)} dB`,
    );
    if (normalized.gainReductionDb > LUFS_HEAVY_LIMIT_DB) {
      parts.push("限幅较深，可换更轻的档位或调低响度目标");
    }
    if (!normalized.converged) {
      parts.push(`未收敛到目标，已迭代 ${normalized.passes} 轮`);
    }
  } else {
    parts.push("响度标准化失败，已保留优化结果，可单独点「响度标准化」重试");
  }
  parts.push("已保留处理前版本，可用「撤销压缩」整体回退");
  return parts.join(" · ");
}

/**
 * 段边界比较容差（秒）。播放位置是按帧更新的近似值，比较时留一点余量，
 * 避免浮点误差在段尾反复触发同一次跳转。5 ms 的提前量听不出来。
 */
const PLAYBACK_EDGE_EPSILON = 0.005;

/**
 * 变速不变调：Chromium/WebKit 认 `preservesPitch`，老 WebKit 只认
 * `webkitPreservesPitch`（标准名出现前的写法），两个都设。
 */
function setPitchPreserved(element: HTMLMediaElement, preserved: boolean) {
  const target = element as HTMLMediaElement & {
    preservesPitch?: boolean;
    webkitPreservesPitch?: boolean;
  };
  target.preservesPitch = preserved;
  target.webkitPreservesPitch = preserved;
}

function meterPosition(db: number) {
  if (!Number.isFinite(db)) return 0;
  return Math.max(0, Math.min(1, (db - METER_MIN_DB) / -METER_MIN_DB));
}

/**
 * 录音峰值表的视觉弹道：升起贴峰值，约 60 dB/s 落下；
 * 峰值针保持 1.2s 再下落。数字读数仍用瞬时值，这里只驱动条子。
 */
function usePeakMeterBallistics(peakDb: number, running: boolean) {
  const [barDb, setBarDb] = useState(Number.NEGATIVE_INFINITY);
  const [holdDb, setHoldDb] = useState(Number.NEGATIVE_INFINITY);
  const peakDbRef = useRef(peakDb);
  peakDbRef.current = peakDb;

  useEffect(() => {
    if (!running) {
      setBarDb(Number.NEGATIVE_INFINITY);
      setHoldDb(Number.NEGATIVE_INFINITY);
      return;
    }
    let bar = Number.NEGATIVE_INFINITY;
    let hold = Number.NEGATIVE_INFINITY;
    let holdUntil = 0;
    let last = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const target = Number.isFinite(peakDbRef.current)
        ? peakDbRef.current
        : Number.NEGATIVE_INFINITY;
      if (!Number.isFinite(bar) || target >= bar) {
        bar = target;
      } else {
        bar = Math.max(target, bar - 60 * dt);
      }
      if (!Number.isFinite(hold) || target >= hold) {
        hold = target;
        holdUntil = now + 1200;
      } else if (now > holdUntil) {
        hold = Math.max(target, hold - 40 * dt);
      }
      setBarDb(bar);
      setHoldDb(hold);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [running]);

  return { barDb, holdDb };
}

function toDb(value: number) {
  return value > 0 ? 20 * Math.log10(value) : Number.NEGATIVE_INFINITY;
}

/**
 * 从当前播放位置取一个窗口的采样算 RMS/Peak，不依赖 AnalyserNode 过音频图。
 * 窗口长度由调用方按秒数换算（见 PLAYBACK_METER_WINDOW_SEC），不再写死。
 * 多声道按所有声道下混后统计：只读左声道会低估立体声素材的峰值，
 * 与整段峰值（bufferTruePeakDb）的口径也不一致。
 */
function levelFromBuffer(buffer: AudioBuffer, time: number, windowSize: number) {
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, index) =>
    buffer.getChannelData(index),
  );
  const sampleCount = channels[0].length;
  const start = Math.max(
    0,
    Math.min(sampleCount - 1, Math.floor(time * buffer.sampleRate)),
  );
  const end = Math.min(sampleCount, start + windowSize);
  const count = Math.max(1, end - start);
  let sumSquares = 0;
  let peak = 0;
  for (let i = start; i < end; i++) {
    let sample = channels[0][i];
    if (channels.length > 1) {
      sample = 0;
      for (const data of channels) sample += data[i];
      sample /= channels.length;
    }
    sumSquares += sample * sample;
    const abs = Math.abs(sample);
    if (abs > peak) peak = abs;
  }
  return {
    rmsDb: toDb(Math.sqrt(sumSquares / count)),
    peakDb: toDb(peak),
  };
}

/** 整段音频真实峰值（dBFS）。波形画布按 ±1.0 原样映射，峰值近 0 才会顶满行高。 */
function bufferTruePeakDb(buffer: AudioBuffer) {
  let peak = 0;
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < data.length; i++) {
      const abs = Math.abs(data[i]);
      if (abs > peak) peak = abs;
    }
  }
  return toDb(peak);
}

function App() {
  const [audioBuffer, setAudioBuffer] = useState<AudioBuffer | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  // 播放速度与循环是会话内的监听参数，不落盘：重启回到 1.0× 且不循环。
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const [looping, setLooping] = useState(false);
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
  /** 设置面板打开时的快照，供「取消」回退；面板关闭时清空。 */
  const setupSnapshotRef = useRef<SetupSnapshot | null>(null);

  // ---- 视频模式的状态：videoAsset 为 null 即纯音频模式 ----
  const [videoAsset, setVideoAsset] = useState<VideoAsset | null>(null);
  const [ffmpegInfo, setFfmpegInfo] = useState<FfmpegInfo | null>(null);
  const [ffmpegGuideOpen, setFfmpegGuideOpen] = useState(false);
  /** 设置页「ffmpeg 路径」输入框（即时生效：失焦/回车/选文件后立刻重探）。 */
  const [ffmpegPathInput, setFfmpegPathInput] = useState<string>(() =>
    getFfmpegPath(),
  );
  /** 导入阶段：extract = ffmpeg 抽音轨（有百分比），decode = 前端解析进缓冲。 */
  const [videoImportStage, setVideoImportStage] = useState<
    "extract" | "decode" | null
  >(null);
  const [videoImportProgress, setVideoImportProgress] = useState<number | null>(
    null,
  );
  // 视频导出档位与切片过渡时长是**持久化偏好**（在设置页里改，跨启动保留），
  // 「是否顺带写一份字幕」仍是会话内选择。
  const [videoExportVariant, setVideoVariantState] = useState<VideoExportVariant>(
    () => getVideoVariant(),
  );
  const [videoTransition, setVideoTransitionState] = useState<number>(() =>
    getVideoTransition(),
  );
  const [videoTransitionType, setVideoTransitionTypeState] =
    useState<VideoTransitionType>(() => getVideoTransitionType());
  const [videoExportProgress, setVideoExportProgress] = useState<number | null>(
    null,
  );
  const [exportSubtitles, setExportSubtitles] = useState(false);
  /** 已放行给 asset 协议的视频路径，换素材或关闭视频时收回。 */
  const assetAllowedRef = useRef<string | null>(null);

  /**
   * 展示提示：info（成功/结果通知）3 秒后自动消失；
   * progress（进行中）留到下一条提示替换；error（失败）常驻，需手动关闭。
   * 新提示会替换旧提示并重置计时。
   */
  const notify = useCallback(
    (message: string, kind: "info" | "error" | "progress" = "info") => {
      window.clearTimeout(noticeTimerRef.current);
      setNoiseNotice(message);
      if (kind === "info") {
        noticeTimerRef.current = window.setTimeout(
          () => setNoiseNotice(null),
          3000,
        );
      }
    },
    [],
  );

  const dismissNotice = useCallback(() => {
    window.clearTimeout(noticeTimerRef.current);
    setNoiseNotice(null);
  }, []);

  useEffect(() => () => window.clearTimeout(noticeTimerRef.current), []);
  const [noisePreset, setNoisePreset] = useState<NoisePreset>(
    getNoisePreset() as NoisePreset,
  );
  const [compressionPreset, setCompressionPreset] = useState<CompressionPreset>(
    getCompressionPreset() as CompressionPreset,
  );
  const [silencePreset, setSilencePreset] = useState<SilencePreset>(
    getSilencePreset() as SilencePreset,
  );
  const [silenceThresholdDb, setSilenceThresholdDb] = useState(
    getSilenceThreshold(),
  );
  // 输入框用文本态，避免输入「-」这类中间态被数字解析吃掉。
  const [silenceThresholdInput, setSilenceThresholdInput] = useState(() =>
    String(getSilenceThreshold()),
  );
  const [hasEnhancedAudio, setHasEnhancedAudio] = useState(false);
  const [hasLoudnessApplied, setHasLoudnessApplied] = useState(false);
  const [hasCompressionApplied, setHasCompressionApplied] = useState(false);
  const [lufsTargetDb, setLufsTargetDb] = useState(getLufsTarget());
  // 输入框用文本态，避免输入「-」这类中间态被数字解析吃掉。
  const [lufsTargetInput, setLufsTargetInput] = useState(() =>
    String(getLufsTarget()),
  );
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
  const [modelStatus, setModelStatus] = useState<TranscribeModelStatus | null>(
    null,
  );
  const [modelDownloadPercent, setModelDownloadPercent] = useState<number | null>(
    null,
  );
  const [modelDownloadError, setModelDownloadError] = useState<string | null>(
    null,
  );
  /** 转录与标点模型文件齐备：据此禁用「下载模型」，避免无意义的重复下载。 */
  const modelReady = Boolean(modelStatus?.ready && modelStatus.punctReady);

  const refreshTempStorage = useCallback(async () => {
    try {
      setTempStorage(
        await invoke<TempStorageStatus>("temp_storage_status"),
      );
    } catch {
      setTempStorage(null);
    }
  }, []);

  const refreshModelStatus = useCallback(async () => {
    if (!isTauriDesktop()) return;
    try {
      setModelStatus(await checkTranscribeModel());
    } catch {
      setModelStatus(null);
    }
  }, []);

  const handleDownloadModels = useCallback(async () => {
    if (!isTauriDesktop() || modelDownloadPercent !== null) return;
    setModelDownloadError(null);
    setModelDownloadPercent(0);
    const unlisten = await onTranscribeProgress((progress) => {
      if (progress.stage === "download" || progress.stage === "punctuation") {
        setModelDownloadPercent(Math.max(0, progress.percent));
      }
    });
    try {
      await downloadTranscribeModel();
      await refreshModelStatus();
    } catch (cause) {
      setModelDownloadError(
        cause instanceof Error ? cause.message : String(cause),
      );
      await refreshModelStatus();
    } finally {
      unlisten();
      setModelDownloadPercent(null);
    }
  }, [modelDownloadPercent, refreshModelStatus]);

  // 打开设置页时拉一次临时目录占用统计
  useEffect(() => {
    if (showRecordingSetup && isTauriDesktop()) {
      void refreshTempStorage();
      void refreshModelStatus();
    }
  }, [showRecordingSetup, refreshTempStorage, refreshModelStatus]);

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
  /** 响度标准化前的缓冲快照，供「撤销响度」回退。 */
  const loudnessBaseRef = useRef<AudioBuffer | null>(null);
  /**
   * 最近一次压缩的输入快照。压缩永远从这份基准重算（替换而非叠加），
   * 所以重复点「压缩」只是换档位，不会一层层压下去。
   */
  const compressBaseRef = useRef<AudioBuffer | null>(null);

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
  /**
   * 播放用媒体元素。变速不变调只能靠它：AudioBufferSourceNode 的
   * playbackRate 是磁带式变速（变快必升调），媒体元素的 preservesPitch
   * 才由浏览器做时间伸缩。
   */
  const mediaRef = useRef<HTMLAudioElement | null>(null);
  /** 媒体源（编码后的 WAV blob URL）与它对应的缓冲；缓冲没变就不重复编码。 */
  const mediaSourceRef = useRef<{ buffer: AudioBuffer; url: string } | null>(
    null,
  );
  /** 循环开关的实时值：rAF 与 onended 回调里要读最新值，不能捕获旧状态。 */
  const loopingRef = useRef(false);
  const recorder = useRecorder();
  const recordingMeter = usePeakMeterBallistics(
    recorder.level.peakDb,
    recorder.status === "recording" && !recorder.isPaused,
  );
  const deletedRegions = useMemo(
    () =>
      normalizeRegions([
        ...editState.manualRegions,
        ...editState.autoRegions,
      ]),
    [editState],
  );
  const filePeakDb = useMemo(
    () => (audioBuffer ? bufferTruePeakDb(audioBuffer) : null),
    [audioBuffer],
  );
  const timelineLufs = useMemo(
    () =>
      audioBuffer
        ? integratedLufsFromBuffer(audioBuffer, deletedRegions)
        : Number.NEGATIVE_INFINITY,
    [audioBuffer, deletedRegions],
  );

  useEffect(() => {
    const AudioContextConstructor =
      window.AudioContext || (window as typeof window & { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const context = new AudioContextConstructor();
    audioContextRef.current = context;
    // 播放走媒体元素，AudioContext 从此只负责解码与离线渲染（降噪）。
    const media = new Audio();
    media.preload = "auto";
    setPitchPreserved(media, true);
    mediaRef.current = media;
    const preventContextMenu = (event: MouseEvent) => event.preventDefault();
    document.addEventListener("contextmenu", preventContextMenu);

    return () => {
      playbackTokenRef.current += 1;
      if (animationFrameRef.current !== null) {
        cancelAnimationFrame(animationFrameRef.current);
      }
      media.pause();
      media.removeAttribute("src");
      mediaRef.current = null;
      const mediaSource = mediaSourceRef.current;
      if (mediaSource) {
        URL.revokeObjectURL(mediaSource.url);
        mediaSourceRef.current = null;
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
    if (!showRecordingSetup) {
      setupSnapshotRef.current = null;
      return;
    }
    // 打开面板即记录快照，「取消」按它回退本次改动：设置是即时生效的，
    // 没有快照就无"取消"可言。故意只跟开关——面板打开期间的值变动不能覆盖快照。
    setupSnapshotRef.current = {
      deviceId: recorder.selectedDeviceId,
      autoTranscribe: autoTranscribeEnabled,
      transcriptVisible,
      silenceThreshold: silenceThresholdDb,
      lufsTarget: lufsTargetDb,
      exportFormat,
      exportBitrate,
      videoVariant: videoExportVariant,
      videoTransition,
      videoTransitionType,
      ffmpegPath: getFfmpegPath(),
    };
    if (isTauriDesktop()) {
      // 当前生效的模型目录存在后端，异步取回来补齐快照（没取到就别回退它）
      void getTranscribeModelDir()
        .then((dir) => {
          if (setupSnapshotRef.current) setupSnapshotRef.current.modelDir = dir;
          setModelDirInput(dir);
        })
        .catch(() => undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  /** 当前缓冲对应的媒体源：缓冲没变就复用，变了才重新编码一份 WAV。 */
  const syncMediaSource = useCallback((buffer: AudioBuffer) => {
    if (mediaSourceRef.current?.buffer === buffer) return;
    const url = URL.createObjectURL(bufferToWav(buffer));
    const previous = mediaSourceRef.current;
    mediaSourceRef.current = { buffer, url };
    const media = mediaRef.current;
    if (media) {
      media.src = url;
      media.load();
    }
    if (previous) URL.revokeObjectURL(previous.url);
  }, []);

  /**
   * 缓冲变化后重建播放源。WAV 编码是同步的，长录音会占住主线程一会儿，
   * 所以延到下一帧，先让"加载完成/处理完成"的画面画出来。
   */
  useEffect(() => {
    if (!audioBuffer) return;
    const timer = window.setTimeout(() => syncMediaSource(audioBuffer), 0);
    return () => window.clearTimeout(timer);
  }, [audioBuffer, syncMediaSource]);

  /** 变速对媒体元素是即时的，播放中拖动滑条就能听到效果。 */
  useEffect(() => {
    const media = mediaRef.current;
    if (media) media.playbackRate = playbackSpeed;
  }, [playbackSpeed]);

  /** 成片起点（第一个保留区间的起点）；整段被切除时返回 null。 */
  const firstKeptStart = useCallback(
    (buffer: AudioBuffer, regions: Region[]) => {
      const segments = getKeptRegions(regions, buffer.duration);
      return segments.length ? segments[0].start : null;
    },
    [],
  );

  const stopPlayback = useCallback(
    (updatePosition = true) => {
      const media = mediaRef.current;
      const wasPlaying = animationFrameRef.current !== null;
      playbackTokenRef.current += 1;
      if (animationFrameRef.current !== null) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
      if (media) {
        // currentTime 是源时间轴上的位置，变速播放时也不用换算。
        if (updatePosition && wasPlaying) setPosition(media.currentTime);
        media.onended = null;
        media.pause();
      }
      setIsPlaying(false);
      setPlaybackLevel(null);
    },
    [setPosition],
  );

  const startPlayback = useCallback(
    async (offset: number) => {
      if (!audioBuffer) return;
      const media = mediaRef.current;
      if (!media) return;

      stopPlayback(false);
      const segments = getKeptRegions(deletedRegions, audioBuffer.duration);
      if (segments.length === 0) {
        // 领域边界要求：全部时间轴被跳过时必须给出明确结果，不能静默无声
        setPosition(audioBuffer.duration);
        notify("当前时间轴已全部被切除，没有可播放的内容", "error");
        return;
      }

      const playableOffset = nextPlayableTime(
        offset,
        deletedRegions,
        audioBuffer.duration,
      );
      const index = segments.findIndex(
        (segment) =>
          playableOffset >= segment.start && playableOffset < segment.end,
      );
      if (index < 0) {
        setPosition(audioBuffer.duration);
        return;
      }

      syncMediaSource(audioBuffer);
      media.playbackRate = playbackSpeed;
      setPitchPreserved(media, true);

      const token = playbackTokenRef.current + 1;
      playbackTokenRef.current = token;
      media.onended = () => {
        if (playbackTokenRef.current !== token) return;
        const loopStart = firstKeptStart(audioBuffer, deletedRegions);
        // 循环回到成片起点，而不是文件 0——文件开头可能已经被切除。
        if (loopingRef.current && loopStart !== null) {
          media.currentTime = loopStart;
          void media.play().catch(() => undefined);
          return;
        }
        stopPlayback(false);
        setPosition(audioBuffer.duration);
      };

      // 当前正在播的保留段索引。切除区间靠"段尾到了就跳到下一段开头"实现，
      // 索引状态由我们自己持有——不能每帧拿 currentTime 重新推导：规范允许
      // 脚本运行期间读到滞后的播放位置，那会导致同一次跳转被反复下发，
      // 媒体元素不停重启 seek，最终卡在段边界上不动。
      let segmentIndex = index;
      const start = Math.max(playableOffset, segments[index].start);
      // 元数据未就绪时直接赋值会被丢弃，等 loadedmetadata 再定位（正常路径
      // 早就预编码好了，走不到这里）。
      if (media.readyState >= 1) {
        media.currentTime = start;
      } else {
        media.addEventListener(
          "loadedmetadata",
          () => {
            media.currentTime = start;
          },
          { once: true },
        );
      }

      setIsPlaying(true);
      try {
        await media.play();
      } catch {
        setIsPlaying(false);
        return;
      }

      const animate = () => {
        if (playbackTokenRef.current !== token || !mediaRef.current) return;
        const current = mediaRef.current;
        let position = current.currentTime;
        const segment = segments[segmentIndex];

        if (position >= segment.end - PLAYBACK_EDGE_EPSILON) {
          const nextIndex = segmentIndex + 1;
          if (nextIndex < segments.length) {
            // 当前保留段播完：跳到下一段开头。先推进索引再发 seek，
            // 这样即使 seek 晚一帧才落地，也不会重复下发同一次跳转。
            segmentIndex = nextIndex;
            position = segments[nextIndex].start;
            current.currentTime = position;
          } else if (segment.end < audioBuffer.duration - PLAYBACK_EDGE_EPSILON) {
            // 最后一段之后还有被切除的尾巴：到段尾即收尾，不让媒体播过去
            stopPlayback(false);
            setPosition(audioBuffer.duration);
            return;
          }
          // 否则：最后一段一直延伸到音频末尾，交给 ended 处理——循环要在这里回环，
          // 提前 stop 会把回环机会掐掉。
        } else if (
          position < segment.start - PLAYBACK_EDGE_EPSILON &&
          !current.seeking
        ) {
          // 上一次 seek 被打断或还没落地：补一次。目标值固定，重复下发是幂等的。
          position = segment.start;
          current.currentTime = position;
        }

        setPosition(position);
        setPlaybackLevel(
          levelFromBuffer(
            audioBuffer,
            position,
            Math.round(audioBuffer.sampleRate * PLAYBACK_METER_WINDOW_SEC),
          ),
        );
        animationFrameRef.current = requestAnimationFrame(animate);
      };
      animationFrameRef.current = requestAnimationFrame(animate);
    },
    [
      audioBuffer,
      deletedRegions,
      firstKeptStart,
      notify,
      playbackSpeed,
      setPosition,
      stopPlayback,
      syncMediaSource,
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

  /** 循环开关同步到 ref：rAF 与 onended 回调要读实时值。 */
  useEffect(() => {
    loopingRef.current = looping;
  }, [looping]);

  /**
   * 循环开关兼作播放控制：点亮就从成片开头开始播，熄灭就停止播放。
   * 起点与回环点都是成片起点（第一个保留区间），反复听开头时行为稳定。
   */
  const toggleLoop = useCallback(() => {
    const next = !looping;
    setLooping(next);
    if (!next) {
      stopPlayback(true);
      notify("循环播放已关闭");
      return;
    }
    const start = audioBuffer
      ? firstKeptStart(audioBuffer, deletedRegions)
      : null;
    notify("循环播放已开启，从成片开头播放");
    void startPlayback(start ?? 0);
  }, [
    audioBuffer,
    deletedRegions,
    firstKeptStart,
    looping,
    notify,
    startPlayback,
    stopPlayback,
  ]);

  /** 从头播放：offset 0 会被吸附到成片第一个保留区间的起点。 */
  const playFromStart = useCallback(() => {
    void startPlayback(0);
  }, [startPlayback]);

  const resetSpeed = useCallback(() => setPlaybackSpeed(1), []);

  /** 速度上下移一档，到达端点即停。 */
  const stepSpeed = useCallback((direction: number) => {
    setPlaybackSpeed((current) => {
      const index = SPEED_STEPS.indexOf(current);
      const base = index < 0 ? SPEED_STEPS.indexOf(1) : index;
      const next = Math.max(0, Math.min(SPEED_STEPS.length - 1, base + direction));
      return SPEED_STEPS[next];
    });
  }, []);

  const resetEditing = () => {
    setPosition(0);
    setEditState(emptyEditState);
    setDetectedSilenceRegions([]);
    setSelection(null);
    setDenoisePreview(null);
    denoiseBaseRef.current = null;
    loudnessBaseRef.current = null;
    compressBaseRef.current = null;
    setHasLoudnessApplied(false);
    setHasCompressionApplied(false);
    setHistory([]);
    setFuture([]);
  };

  /** 设置/录音入口把波形预览与页面滚回顶部，保证提示、倒计时等可见。 */
  const scrollPreviewToTop = useCallback(() => {
    waveformViewRef.current?.scrollTo({ top: 0, left: 0 });
    window.scrollTo({ top: 0, left: 0 });
  }, []);

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
      clearVideoAsset();
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
    if (isPlaying) {
      // 播放中跳转要重建播放会话：保留段索引必须跟着新位置重算，
      // 否则段状态机会把播放头拉回它自己认定的当前段。
      void startPlayback(position);
      return;
    }
    const media = mediaRef.current;
    if (media) media.currentTime = position;
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
        const candidates = detectSilence(audioBuffer, {
          ...SILENCE_PRESETS[silencePreset],
          thresholdDb: silenceThresholdDb,
        });
        setDetectedSilenceRegions(candidates);
        if (candidates.length) {
          notify(
            `使用“${silencePresetLabels[silencePreset]}”预设（阈值 ${silenceThresholdDb} dBFS）检测到 ${candidates.length} 个静音候选片段，请检查波形后应用`,
          );
        } else {
          notify(`未检测到符合条件的静音片段（当前阈值 ${silenceThresholdDb} dBFS）`);
        }
      } catch {
        notify("静音分析失败", "error");
      } finally {
        setIsProcessing(false);
      }
    }, 0);
  }, [audioBuffer, silencePreset, silenceThresholdDb]);

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

    scrollPreviewToTop();

    // 播放中直接开录会导致录音和回放混在一起，先停掉播放再进倒计时。
    stopPlayback(true);

    // 倒计时语音（CC0，"3、2、1"对齐 0/1/2s，全长 2.68s；总时长 2s 时
    // 开录瞬间会把尾音掐断，后续换更短的提示音即可完全对齐）。
    // 界面文案与音频解耦：0.25s 步进计时，总 2s——前 1.5s 显示「准备」，
    // 最后 0.5s 显示「开始」，提示"现在就要开口"。
    const countdownAudio = new Audio(countdownSfx);
    countdownAudio.volume = 0.7;
    countdownAudioRef.current = countdownAudio;
    void countdownAudio.play().catch(() => {
      // 自动播放被拒时静默失败，倒计时照常进行
    });

    // remaining 以 0.25s 为单位：8 → 0，共 2 秒。
    let remaining = 8;
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
    }, 250);
  };

  // ---- 视频模式：ffmpeg 解析 / 导入 / 导出 ----

  /**
   * 音轨是否被处理过（降噪 / 压缩 / 响度归一化任一）。
   * 处理过就必须把前端渲染的成片音轨回写进视频；只做过切除则一律 copy 原音轨，
   * 保住原始声道数与码率。
   */
  const audioProcessed =
    hasEnhancedAudio || hasLoudnessApplied || hasCompressionApplied;

  /**
   * 无损快速档（画面不重编码）只能从关键帧起切。这里按探测到的关键帧算出：本次剪辑的切点
   * 是否都落在关键帧上、吸附会造成多大偏移。不满足就不能硬上 —— 吸附会把切点整体挪到
   * 关键帧（OBS 默认关键帧间隔可达 8.3 秒），删除区间可能直接失效。
   * fullCover 表示整段保留（没有剪切）：这种导出只是重新封装，任何编码都安全。
   */
  const fastcopyPlan = useMemo(() => {
    if (!videoAsset || !audioBuffer) return null;
    const kept = getKeptRegions(deletedRegions, audioBuffer.duration);
    // 吸附后的区间：起点退到「不超过该点的最近关键帧」，终点不变（`-t` 精确）。
    // 吸附只会让这一档**少删**（残留一小截静音），不会吃掉人声：起点只会往前挪，
    // 且下面用 previousEnd 挡住「挪进上一段保留内容里」的情况。
    const snapped: Region[] = [];
    let safe = kept.length > 0;
    let maxShift = 0;
    let previousEnd = 0;
    for (const region of kept) {
      const keyframe = lastKeyframeAtOrBefore(videoAsset.keyframes, region.start);
      maxShift = Math.max(maxShift, region.start - keyframe);
      // 吸附点退回到上一个保留区间的尾巴里 → 等于把已经删掉的内容又搬回来（时间轴重叠）
      if (keyframe < previousEnd - 0.05) safe = false;
      // 吸附后这段没有画面了
      if (keyframe >= region.end) safe = false;
      snapped.push({ start: keyframe, end: region.end });
      previousEnd = region.end;
    }
    const fullCover =
      kept.length === 1 &&
      kept[0].start <= 0.05 &&
      kept[0].end >= audioBuffer.duration - 0.05;
    return {
      kept,
      /** 吸附后的保留区间：既传给导出命令，也用作字幕重映射的成片时间轴。 */
      snapped,
      /** 吸附是否安全（不会与保留内容重叠）。不要求偏移多小 —— 偏移就是「少删的那一截」。 */
      safe,
      maxShift,
      fullCover,
      keyframeInterval: maxKeyframeInterval(videoAsset.keyframes),
    };
  }, [videoAsset, audioBuffer, deletedRegions]);

  /**
   * 无损快速档的适用条件：
   * - 整段保留（没有剪切）→ 只是重新封装，任何编码都安全；
   * - 有剪切 → 必须是 H.264、无旋转元数据、无 B 帧，且**切点能安全吸附到关键帧**
   *   （吸附不会挪进上一段保留内容里）、音频未被处理过。
   *   HEVC 上输出侧 seek 会静默丢帧（实测 2 秒只剩 34 帧）；带旋转的素材在 concat 后
   *   不保证还留着 display matrix；有 B 帧的素材输出侧 seek 会整段丢掉第一个 GOP
   *   （实测 1 秒关键帧、请求 5 秒只拿到 122 帧）；处理过音频的音轨起点没法跟着视频吸附到关键帧。
   *   **吸附本身不算不可用**（0.1.66 起）：它只会让成片「少删一小截」（残留静音），
   *   代价由 `maxShift` 如实告知；只有「会与保留内容重叠」才判为不可用。
   */
  const fastcopyAvailable =
    Boolean(fastcopyPlan) &&
    !audioProcessed &&
    (fastcopyPlan!.fullCover ||
      (fastcopyPlan!.safe &&
        videoAsset?.videoCodec === "h264" &&
        !videoAsset?.hasBFrames &&
        !videoAsset?.rotated));
  /** 实际使用的档位：选了快速档但不可用时降级为精确重编码，并在导出前说明原因。 */
  const effectiveVariant: VideoExportVariant =
    videoExportVariant === "fastcopy" && fastcopyAvailable ? "fastcopy" : "reencode";
  const fastcopyFallbackReason = useMemo(() => {
    if (videoExportVariant !== "fastcopy" || fastcopyAvailable) return null;
    if (audioProcessed) return "音轨已被处理过（降噪 / 压缩 / 响度归一化）";
    if (videoAsset && videoAsset.videoCodec !== "h264") {
      return `该素材是 ${videoAsset.videoCodec.toUpperCase()} 编码，无损快速会丢画面（将转成 H.264）`;
    }
    if (videoAsset?.hasBFrames) {
      return "该素材含 B 帧，无损快速会丢掉切点后的整段画面";
    }
    if (videoAsset?.rotated) return "该素材带旋转元数据，拼接后方向不保证正确";
    if (!fastcopyPlan?.safe) {
      const interval = fastcopyPlan?.keyframeInterval ?? 0;
      return interval > 0
        ? `切点吸附到关键帧会与保留内容重叠（该素材关键帧间隔约 ${interval.toFixed(1)} 秒）`
        : "切点吸附到关键帧会与保留内容重叠";
    }
    return null;
  }, [videoExportVariant, fastcopyAvailable, audioProcessed, fastcopyPlan, videoAsset]);

  /**
   * 逐接缝的过渡时长（秒，长度 = 保留区间数 − 1；0 = 硬切）。这是导出与字幕换算的
   * **唯一来源**，Rust 侧只做兜底钳制、不再自己推导。三条规则：
   * - **只在「精确编码」档生效**：无损快切是 `-c:v copy`，画面根本没解码，做不了过渡；
   * - **按帧取整**（0.3 秒 @30fps = 9 帧）：xfade 与 concat 都按帧走，不取整会攒出
   *   ±1 帧 × 接缝数的偏差，把字幕推歪；
   * - **短段保护**：每处接缝最多取相邻两段各一半，否则会把短的那段吃光。
   */
  const transitionPlan = useMemo(() => {
    const kept = fastcopyPlan?.kept ?? [];
    if (
      effectiveVariant !== "reencode" ||
      videoTransition <= 0 ||
      kept.length < 2 ||
      // 没有 xfade 就做不了过渡（精简构建可能缺失），这里直接退成硬切，
      // 导出前的提示会把原因说明白，而不是让导出跑到一半报 Filter not found。
      !ffmpegInfo?.hasXfade
    ) {
      return [] as number[];
    }
    const fps = videoAsset ? parseFrameRate(videoAsset.fps) : 0;
    return kept.slice(0, -1).map((region, index) => {
      const next = kept[index + 1];
      const limit = Math.min(
        (region.end - region.start) / 2,
        (next.end - next.start) / 2,
      );
      const seconds = Math.min(videoTransition, limit);
      if (seconds < MIN_TRANSITION_SECONDS) return 0;
      return fps > 0
        ? Math.round(seconds * fps) / fps
        : Math.round(seconds * 1000) / 1000;
    });
  }, [effectiveVariant, videoTransition, fastcopyPlan, videoAsset, ffmpegInfo]);

  /** 收回 asset 协议的单个文件放行。 */
  const releaseVideoAsset = useCallback((path: string | null) => {
    if (!path) return;
    if (assetAllowedRef.current === path) assetAllowedRef.current = null;
    void invoke("forbid_video_asset", { path }).catch(() => undefined);
  }, []);

  /** 退出视频模式（打开音频文件、新录音时调用）。 */
  const clearVideoAsset = useCallback(() => {
    releaseVideoAsset(assetAllowedRef.current);
    setVideoAsset(null);
  }, [releaseVideoAsset]);

  /**
   * 解析可用的 ffmpeg 路径。showGuide 为 true 时（用户主动打开视频）未找到就弹出
   * 引导弹框；启动时的那次静默探测传 false，只把结果填进设置页的状态行。
   */
  const resolveFfmpeg = useCallback(
    async (showGuide = true): Promise<string | null> => {
      if (!isTauriDesktop()) return null;
      const custom = getFfmpegPath();
      let info = await invoke<FfmpegInfo>("detect_ffmpeg", {
        customPath: custom || null,
      });
      if (!info.found && custom) {
        // 指定路径失效（换机器 / 升级后移动），回退自动探测，别卡住视频功能
        info = await invoke<FfmpegInfo>("detect_ffmpeg", { customPath: null });
      }
      setFfmpegInfo(info);
      if (!info.found || !info.path) {
        if (showGuide) setFfmpegGuideOpen(true);
        return null;
      }
      return info.path;
    },
    [],
  );

  // 启动时静默探一次：设置页的「ffmpeg 路径」行不必等用户打开视频才有状态。
  useEffect(() => {
    void resolveFfmpeg(false);
  }, [resolveFfmpeg]);

  const recheckFfmpeg = useCallback(async () => {
    const ffmpeg = await resolveFfmpeg();
    if (ffmpeg) {
      setFfmpegGuideOpen(false);
      notify("ffmpeg 已就绪，可以打开视频了");
    }
  }, [resolveFfmpeg, notify]);

  /**
   * 应用设置页里填的 ffmpeg 路径：写盘 + 重新探测一次并回报结果。
   * 传空串 = 清空输入（Windows 回落到默认值，其他平台回到自动探测）；
   * 走 resolveFfmpeg 是为了复用「指定路径失效则回退自动探测」这条逻辑。
   */
  const applyFfmpegPath = useCallback(
    async (path: string) => {
      persistFfmpegPath(path);
      setFfmpegPathInput(path || getFfmpegPath());
      const resolved = await resolveFfmpeg(false);
      if (resolved) {
        setFfmpegGuideOpen(false);
        notify(`ffmpeg 已就绪：${resolved}`);
      } else {
        notify("该路径无法运行 ffmpeg，请确认选的是 ffmpeg 可执行文件", "error");
      }
    },
    [notify, resolveFfmpeg],
  );

  const pickFfmpegPath = useCallback(async () => {
    const picked = await openDialog({
      multiple: false,
      // 非 Windows 的可执行文件没有扩展名，不设过滤器（设置过滤器会让它从列表里消失）
      filters: navigator.userAgent.includes("Windows")
        ? [{ name: "ffmpeg 可执行文件", extensions: ["exe"] }]
        : undefined,
    });
    const path = typeof picked === "string" ? picked : null;
    if (!path) return;
    await applyFfmpegPath(path);
  }, [applyFfmpegPath]);

  /**
   * 打开视频：dialog 拿路径（不走 <input type=file>，大文件不进内存）→
   * ffmpeg 抽音轨到临时目录 → 前端解析进现有编辑管线，波形 / 静音 / 切除全部复用。
   */
  const handleVideoUpload = useCallback(async () => {
    if (!isTauriDesktop() || !audioContextRef.current) return;
    if (
      isProcessing ||
      recorder.status === "recording" ||
      recordingCountdown !== null
    ) {
      return;
    }
    const ffmpeg = await resolveFfmpeg();
    if (!ffmpeg) return; // 引导弹框已打开
    const picked = await openDialog({
      multiple: false,
      filters: [
        {
          name: "视频",
          extensions: ["mp4", "mov", "mkv", "webm", "avi", "m4v"],
        },
      ],
    });
    const path = typeof picked === "string" ? picked : null;
    if (!path) return;
    setIsProcessing(true);
    setVideoImportStage("extract");
    setVideoImportProgress(0);
    let extractedPath: string | null = null;
    let unlistenExtract: (() => void) | null = null;
    try {
      const probe = await invoke<VideoProbe>("probe_video", { ffmpeg, path });
      // 抽音轨进度：payload 是当前秒数，占总进度 0-95%，留 5% 给前端解析
      unlistenExtract = await listen<number>(
        "video-extract-progress",
        (event) => {
          if (probe.duration > 0) {
            setVideoImportProgress(
              Math.min(95, (event.payload / probe.duration) * 95),
            );
          }
        },
      );
      extractedPath = await invoke<string>("extract_video_audio", {
        ffmpeg,
        videoPath: path,
      });
      setVideoImportProgress(95);
      setVideoImportStage("decode");
      stopPlayback(false);
      // ffmpeg 写的是 32-bit float WAV，自解析读回（与降噪结果同一条路），
      // 不走 decodeAudioData：float WAVE_FORMAT_EXTENSIBLE 的解码支持视 WebView 而定。
      const decoded = floatWavToBuffer(
        audioContextRef.current,
        await readFile(extractedPath),
      );
      // asset 协议只放行当前这一个视频文件，放新的之前先收回旧的
      releaseVideoAsset(assetAllowedRef.current);
      await invoke("allow_video_asset", { path });
      assetAllowedRef.current = path;
      setAudioBuffer(decoded);
      originalBufferRef.current = decoded;
      setHasEnhancedAudio(false);
      setTranscript(null);
      resetEditing();
      setVideoAsset({
        path,
        src: convertFileSrc(path),
        audioBitrate: probe.audioBitrate,
        videoCodec: probe.videoCodec,
        channels: probe.channels,
        rotated: probe.rotated ?? false,
        hasBFrames: probe.hasBFrames ?? false,
        fps: probe.fps ?? "30/1",
        keyframes: probe.keyframes ?? [0],
      });
      notify(
        `视频已导入（${probe.width}×${probe.height}，${probe.videoCodec.toUpperCase()}，音轨 ${probe.sampleRate} Hz）：照常编辑波形与区间，导出时生成视频`,
      );
    } catch (cause) {
      notify(
        `视频导入失败：${cause instanceof Error ? cause.message : String(cause)}`,
        "error",
      );
    } finally {
      unlistenExtract?.();
      setVideoImportStage(null);
      setVideoImportProgress(null);
      setIsProcessing(false);
      if (extractedPath) {
        void invoke("delete_recording_file", { path: extractedPath }).catch(
          () => undefined,
        );
      }
    }
  }, [
    isProcessing,
    recorder.status,
    recordingCountdown,
    resolveFfmpeg,
    stopPlayback,
    releaseVideoAsset,
    notify,
  ]);

  /**
   * 视频导出。未处理过音频时 ffmpeg 直接切原音轨（-c:a copy，保留原声道与码率）；
   * 处理过降噪 / 压缩 / 响度归一化时，把「处理后 + 已切除」的音轨写临时 WAV 回写。
   * 默认档不重编码画面（快、无损），代价是切点落在关键帧附近。
   */
  const handleVideoExport = useCallback(async () => {
    if (!audioBuffer || !videoAsset) return;
    const ffmpeg = await resolveFfmpeg();
    if (!ffmpeg) return; // 引导弹框已打开
    if (effectiveVariant === "reencode" && ffmpegInfo && !ffmpegInfo.hasLibx264) {
      notify(
        `当前 ffmpeg（${ffmpegInfo.path ?? "未知路径"}）不带 libx264，无法精确重编码。请手动指定一份完整构建，或把 OBS 的关键帧间隔设为 1 秒后重录`,
        "error",
      );
      return;
    }
    if (fastcopyFallbackReason) {
      notify(
        transitionPlan.some((value) => value > 0)
          ? `本次改用「精确重编码」：${fastcopyFallbackReason}（接缝会做过渡）`
          : `本次改用「精确重编码」：${fastcopyFallbackReason}`,
      );
    } else if (effectiveVariant === "reencode" && transitionPlan.some((value) => value > 0)) {
      notify("本次用「精确重编码」，接缝会做平滑滑移过渡");
    }
    // 短段保护生效时如实说一声：这类接缝的过渡比设置值短（或直接退回硬切）
    const shortenedJoins = transitionPlan.filter(
      (value) => value > 0 && value < videoTransition - 0.001,
    ).length;
    if (shortenedJoins > 0) {
      notify(`有 ${shortenedJoins} 处接缝因相邻片段过短，过渡时长已自动缩短`);
    }
    // 设了过渡时长但这份 ffmpeg 做不了过渡：明确说明本次按硬切走，别让人以为已经生效
    if (
      videoTransition > 0 &&
      effectiveVariant === "reencode" &&
      ffmpegInfo &&
      !ffmpegInfo.hasXfade &&
      deletedRegions.length > 0
    ) {
      notify("当前 ffmpeg 不带 xfade 滤镜，本次按硬切导出（可在设置里指定另一份 ffmpeg）");
    }
    const outputPath = await saveDialog({
      defaultPath: createExportFileName(
        "mp4",
        transcript ? extractKeyword(transcript.segments) : null,
      ),
      filters: [{ name: "MP4 视频", extensions: ["mp4"] }],
    });
    if (!outputPath) return;
    stopPlayback(false);
    setVideoExportProgress(0);
    const unlisten = await listen<number>("video-export-progress", (event) => {
      setVideoExportProgress(Math.max(0, event.payload));
    });
    let processedAudioPath: string | null = null;
    let subtitlePath: string | null = null;
    try {
      let audioPath: string | null = null;
      if (audioProcessed) {
        const wav = bufferToWav(buildExportBuffer(audioBuffer, deletedRegions));
        const prepared = await invoke<string>("prepare_video_export_audio");
        await writeFile(prepared, new Uint8Array(await wav.arrayBuffer()));
        processedAudioPath = prepared;
        audioPath = prepared;
      }
      if (exportSubtitles && transcript) {
        // 转录时间码在源时间轴上，成片已跳过切除区间，必须重映射到成片时间轴。
        // - 无损快切档的成片时间轴以「吸附后的保留区间」为准（每段多留一小截）；
        // - 精确编码档若有过渡，每个接缝还会让成片短 t 秒（重叠式过渡）。
        // 不按实际成片时间轴换算的话，字幕会随吸附点/过渡点累积错位。
        const keptForSubtitles =
          effectiveVariant === "fastcopy" ? fastcopyPlan?.snapped : undefined;
        const transitionsForSubtitles =
          effectiveVariant === "reencode" && transitionPlan.length
            ? transitionPlan
            : undefined;
        const cues = transcript.segments.flatMap((segment) =>
          mapRangeToKept(
            segment,
            deletedRegions,
            audioBuffer.duration,
            keptForSubtitles,
            transitionsForSubtitles,
          ).map(
            (piece) => ({ start: piece.start, end: piece.end, text: segment.text }),
          ),
        );
        const prepared = await invoke<string>("prepare_video_export_subtitles");
        await writeFile(prepared, new TextEncoder().encode(buildSrt(cues)));
        subtitlePath = prepared;
      }
      const kept =
        fastcopyPlan?.kept ?? getKeptRegions(deletedRegions, audioBuffer.duration);
      if (!kept.length) {
        throw new Error("不能导出空视频，请至少保留一段内容");
      }
      // 无损快速档把每段起点吸附到「不超过该点的最近关键帧」，再往回让 1 ms
      // （关键帧时间戳只有 6 位小数，抬高一点就会越过它，输出侧 seek 会因此丢掉整段画面）。
      // 吸附结果统一由 fastcopyPlan 算好，不要在这里再推导一遍。
      const planned =
        effectiveVariant === "fastcopy"
          ? (fastcopyPlan?.snapped ?? kept).map((region) => ({
              start: Math.max(0, region.start - FASTCOPY_SEEK_EPSILON),
              end: region.end,
            }))
          : kept;
      const regionsJson = JSON.stringify(
        planned.map((region) => [
          Number(region.start.toFixed(6)),
          Number(region.end.toFixed(6)),
        ]),
      );
      await invoke("export_video", {
        ffmpeg,
        inputPath: videoAsset.path,
        audioPath,
        subtitlesPath: subtitlePath,
        regionsJson,
        transitionsJson: JSON.stringify(transitionPlan),
        transitionType: videoTransitionType,
        fps: videoAsset.fps,
        outputPath,
        variant: effectiveVariant,
        totalDuration: audioBuffer.duration,
        sourceBitrate: videoAsset.audioBitrate,
        sourceChannels: videoAsset.channels,
      });
      const appliedTransitions = transitionPlan.filter((value) => value > 0);
      const transitionNote = appliedTransitions.length
        ? `（精确编码：${appliedTransitions.length} 处${
            VIDEO_TRANSITION_TYPES.find((item) => item.value === videoTransitionType)
              ?.label ?? "过渡"
          }，成片比硬切短 ${appliedTransitions.reduce((sum, value) => sum + value, 0).toFixed(1)} 秒）`
        : "";
      // 无损快切档的代价也要如实说：切点吸附到关键帧等于少删了一小截静音
      const snapNote =
        fastcopyPlan && !fastcopyPlan.fullCover && fastcopyPlan.maxShift > 0.02
          ? `，切点吸附到关键帧（最多少删 ${fastcopyPlan.maxShift.toFixed(1)} 秒静音）`
          : "";
      notify(
        effectiveVariant === "fastcopy"
          ? `视频导出成功${subtitlePath ? "，字幕已写到视频旁边" : ""}（无损快切：画面未重编码${snapNote}）`
          : `视频导出成功${subtitlePath ? "，字幕已写到视频旁边" : ""}${transitionNote}`,
      );
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (message.includes("取消")) {
        notify("视频导出已取消");
      } else {
        notify(`视频导出失败：${message}`, "error");
      }
    } finally {
      unlisten();
      setVideoExportProgress(null);
      if (processedAudioPath) {
        void invoke("delete_recording_file", { path: processedAudioPath }).catch(
          () => undefined,
        );
      }
      if (subtitlePath) {
        void invoke("delete_recording_file", { path: subtitlePath }).catch(
          () => undefined,
        );
      }
    }
  }, [
    audioBuffer,
    videoAsset,
    audioProcessed,
    deletedRegions,
    exportSubtitles,
    videoExportVariant,
    effectiveVariant,
    transitionPlan,
    videoTransition,
    fastcopyPlan,
    fastcopyFallbackReason,
    ffmpegInfo,
    transcript,
    resolveFfmpeg,
    stopPlayback,
    notify,
  ]);

  const handleExport = useCallback(async () => {
    if (!audioBuffer) return;
    if (videoAsset) {
      await handleVideoExport();
      return;
    }
    setIsProcessing(true);
    try {
      // WAV 为默认格式（同步 PCM 编码）；MP3 走纯 JS 编码，分块让出主线程
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
  }, [
    audioBuffer,
    deletedRegions,
    exportBitrate,
    exportFormat,
    videoAsset,
    handleVideoExport,
    transcript,
  ]);

  const confirmRecording = async () => {
    if (!recorder.recordedBlob || !audioContextRef.current) return;
    setIsProcessing(true);
    let decoded: AudioBuffer | null = null;
    try {
      decoded = await audioContextRef.current.decodeAudioData(
        await recorder.recordedBlob.arrayBuffer(),
      );
      setAudioBuffer(decoded);
      originalBufferRef.current = decoded;
      setHasEnhancedAudio(false);
      setTranscript(null);
      resetEditing();
      clearVideoAsset();
      recorder.clearReview();
    } catch {
      notify("无法解析这段录音", "error");
    } finally {
      setIsProcessing(false);
    }
    // 设置页「自动转录」开启时，确定编辑后自动开始转录。
    // 必须在 isProcessing 清掉之后再调，避免 finally 把转录中的状态冲掉。
    // 必须传 decoded：audioBuffer 状态此刻尚未更新。
    if (decoded && autoTranscribeEnabled) {
      void handleTranscribe(decoded);
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
      const degree =
        noisePreset === "light" ? "轻度" : noisePreset === "strong" ? "强度" : "中度";
      if (result.fallbackReason) {
        // 兜底算法和 DeepFilterNet 差一个量级，必须让用户看到，不能悄悄降级
        notify(
          `已生成${degree}降噪试听，但 DeepFilterNet 未生效（${result.fallbackReason}），已改用基础降噪、效果会明显更差`,
          "error",
        );
      } else {
        notify(`${result.engine} 已生成${degree}降噪试听，请播放确认`);
      }
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

  /**
   * 一键响度标准化：静态增益 + 真峰值限幅，迭代收敛到目标 LUFS。
   * 处理前留一份快照，「撤销响度」可回退（Ctrl+Z 只管区间编辑，回不到这里）。
   */
  const handleLoudnessNormalize = useCallback(() => {
    if (!audioBuffer) return;
    const ceilingDb =
      exportFormat === "mp3" ? LUFS_CEILING_DB_MP3 : LUFS_CEILING_DB_WAV;
    setIsProcessing(true);
    // 重算是同步的，先让「处理中」遮罩渲染出去再开算。用 setTimeout 让遮罩先渲染。
    window.setTimeout(() => {
      try {
        const result = normalizeLoudness(audioBuffer, {
          targetLufs: lufsTargetDb,
          ceilingDb,
          deletedRegions,
        });
        if (!result) {
          notify("无法测量当前响度，请先留出可导出的音频内容", "error");
          return;
        }
        stopPlayback(false);
        loudnessBaseRef.current = audioBuffer;
        setHasLoudnessApplied(true);
        setAudioBuffer(result.buffer);
        notify(loudnessReport(result, lufsTargetDb, ceilingDb), "progress");
      } catch {
        notify("响度标准化失败，原始音频未改变", "error");
      } finally {
        setIsProcessing(false);
      }
    }, 0);
  }, [
    audioBuffer,
    deletedRegions,
    exportFormat,
    lufsTargetDb,
    notify,
    stopPlayback,
  ]);

  const revertLoudness = () => {
    if (!loudnessBaseRef.current) return;
    stopPlayback(false);
    setAudioBuffer(loudnessBaseRef.current);
    loudnessBaseRef.current = null;
    setHasLoudnessApplied(false);
    setPosition(0);
    notify("已回退到响度标准化之前");
  };

  /**
   * 一键语音优化：高通 80 Hz → 向下扩展 → 软拐点压缩 → 响度标准化。
   *
   * 为什么把归一并进来：链路只把动态压平、把音色修顺，不负责把整体响度拉到目标，
   * 分两步点容易漏，所以点一次做到位。「响度标准化」按钮保持单纯归一、行为不变。
   *
   * 为什么压缩段不补偿、也不限幅：补偿是静态抬全段，抬完由限幅器收拾，波形必然变平顶；
   * 而归一随后会按实测 LUFS 重算增益，把这份补偿在数学上抵消掉 —— 收益归零，限幅留下的
   * 增益包络却不可逆。峰值改由「目标 LUFS + 限幅上限」共同保证（0.1.49）。
   *
   * 基准语义（防止叠压、防止归一失效）：
   * - 已单独做过响度归一：必须先作废归一。归一是按旧动态算出的静态增益，压缩改了
   *   动态它就不再成立，所以按 loudnessBaseRef 回退后再算（流水线末尾会重新归一）。
   * - 之前压缩过：从 compressBaseRef 重算 —— 重复点是「换档位」而不是「压第二遍」。
   * - 撤销粒度：「撤销压缩」整体回退到压缩前（含流水线里那次归一）；「撤销响度」只退
   *   归一那一步、保留压缩结果 —— 两个按钮一起亮时先撤响度再撤压缩，顺序自然。
   */
  const handleCompression = useCallback(() => {
    if (!audioBuffer) return;
    const ceilingDb =
      exportFormat === "mp3" ? LUFS_CEILING_DB_MP3 : LUFS_CEILING_DB_WAV;
    const base =
      compressBaseRef.current ??
      (hasLoudnessApplied ? loudnessBaseRef.current ?? audioBuffer : audioBuffer);
    setIsProcessing(true);
    // 全段重算是同步的，先让「处理中」遮罩画出来再开算。
    window.setTimeout(() => {
      try {
        // 素材本来就稳、或没有可测内容时，runVoiceChain 照常返回（压缩那步会跳过）。
        const chained = runVoiceChain(base, compressionPreset, deletedRegions);
        if (!chained) {
          notify("当前音频没有可处理的内容", "error");
          return;
        }
        // 第二步：响度标准化。动态与音色交给链路，响度与真峰值上限由这一步定。
        const normalized = normalizeLoudness(chained.buffer, {
          targetLufs: lufsTargetDb,
          ceilingDb,
          deletedRegions,
        });
        stopPlayback(false);
        compressBaseRef.current = base;
        setHasCompressionApplied(true);
        if (normalized) {
          loudnessBaseRef.current = chained.buffer;
          setHasLoudnessApplied(true);
          setAudioBuffer(normalized.buffer);
        } else {
          loudnessBaseRef.current = null;
          setHasLoudnessApplied(false);
          setAudioBuffer(chained.buffer);
        }
        notify(
          compressionReport(chained, normalized, lufsTargetDb, ceilingDb),
          "progress",
        );
      } catch {
        notify("压缩失败，原始音频未改变", "error");
      } finally {
        setIsProcessing(false);
      }
    }, 0);
  }, [
    audioBuffer,
    compressionPreset,
    deletedRegions,
    exportFormat,
    hasLoudnessApplied,
    lufsTargetDb,
    notify,
    stopPlayback,
  ]);

  const revertCompression = () => {
    if (!compressBaseRef.current) return;
    stopPlayback(false);
    setAudioBuffer(compressBaseRef.current);
    compressBaseRef.current = null;
    setHasCompressionApplied(false);
    // 压在压缩版本之上的响度归一一起回退，快照随之作废。
    loudnessBaseRef.current = null;
    setHasLoudnessApplied(false);
    setPosition(0);
    notify("已回退到压缩之前的版本");
  };

  /** 目标 LUFS 落库：夹到合法区间，同时把输入框文本同步成规范值。 */
  const commitLufsTarget = useCallback((target: number) => {
    const clamped = Math.max(
      LUFS_TARGET_RANGE.min,
      Math.min(LUFS_TARGET_RANGE.max, Math.round(target * 10) / 10),
    );
    setLufsTargetDb(clamped);
    setLufsTargetInput(String(clamped));
    persistLufsTarget(clamped);
  }, []);

  /** 静音阈值落库：夹到合法区间，同时把输入框文本同步成规范值并清掉旧候选。 */
  const commitSilenceThreshold = useCallback((threshold: number) => {
    const clamped = Math.max(
      SILENCE_THRESHOLD_RANGE.min,
      Math.min(SILENCE_THRESHOLD_RANGE.max, Math.round(threshold * 10) / 10),
    );
    setSilenceThresholdDb(clamped);
    setSilenceThresholdInput(String(clamped));
    persistSilenceThreshold(clamped);
    setDetectedSilenceRegions([]);
  }, []);

  const handleTranscribe = async (source?: AudioBuffer) => {
    const target = source ?? audioBuffer;
    if (!target || !audioContextRef.current || !isTauriDesktop()) return;
    if (modelDownloadPercent !== null) return;
    stopPlayback(false);
    setIsProcessing(true);
    setTranscribeProgress({ stage: "load", percent: -1 });
    notify("正在加载转录模型…", "progress");
    const unlisten = await onTranscribeProgress((progress) => {
      setTranscribeProgress(progress);
      if (progress.stage === "load") {
        notify("正在加载转录模型…", "progress");
      }
    });
    try {
      // 首次使用先下载模型（约 230MB），之后本地离线可用。
      const status = await checkTranscribeModel();
      if (!status.ready || !status.punctReady) {
        if (!status.ready) {
          notify("首次使用转录需下载 SenseVoice 模型（约 230MB），下载中…", "progress");
        } else {
          notify("正在补全标点模型…", "progress");
        }
        await downloadTranscribeModel();
        notify("正在加载转录模型…", "progress");
      }
      const result = await runTranscription(target);
      setTranscript(result);
      setTranscriptVisible(true);
      notify(
        result.segments.length
          ? `转录完成，共 ${result.segments.length} 句，波形下方显示逐字对照，点击可跳转`
          : "转录完成，但没有识别到语音内容",
      );
      if (!result.punctuated) {
        notify("标点模型不可用（下载失败或无网络），本次输出无标点", "error");
      }
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
    // 降噪改写了缓冲，响度快照与压缩基准随之失效，避免回退时把降噪成果一起吞掉。
    loudnessBaseRef.current = null;
    compressBaseRef.current = null;
    setHasLoudnessApplied(false);
    setHasCompressionApplied(false);
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
    loudnessBaseRef.current = null;
    compressBaseRef.current = null;
    setHasLoudnessApplied(false);
    setHasCompressionApplied(false);
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
          // range 是播放速度滑条：焦点停在它上面时快捷键仍要生效，
          // 方向键换档由原生行为处理。
          "input:not([type='checkbox']):not([type='radio']):not([type='range']), textarea, [contenteditable='true']",
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
        "KeyR",
        "KeyS",
        "KeyX",
        "KeyC",
        "KeyN",
        "KeyL",
        "KeyT",
        "KeyB",
        "KeyP",
        "BracketLeft",
        "BracketRight",
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
        event.code === "KeyL" &&
        event.shiftKey &&
        !hasPrimaryModifier &&
        audioBuffer &&
        !isProcessing &&
        recorder.status !== "recording"
      ) {
        // ⇧L = 一键响度标准化（统一到设置里的目标 LUFS）
        event.preventDefault();
        handleLoudnessNormalize();
      } else if (
        event.code === "KeyT" &&
        !hasPrimaryModifier &&
        audioBuffer &&
        !isProcessing &&
        modelDownloadPercent === null &&
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
        (event.code === "BracketLeft" || event.code === "BracketRight") &&
        !hasPrimaryModifier &&
        audioBuffer &&
        !isProcessing &&
        recorder.status !== "recording"
      ) {
        // [ = 减速一档，] = 加速一档
        event.preventDefault();
        stepSpeed(event.code === "BracketRight" ? 1 : -1);
      } else if (
        event.code === "KeyP" &&
        !hasPrimaryModifier &&
        audioBuffer &&
        !isProcessing &&
        recorder.status !== "recording"
      ) {
        // P = 从头播放（只从成片开头开始，不改动切除区间）
        event.preventDefault();
        playFromStart();
      } else if (
        event.code === "KeyL" &&
        !event.shiftKey &&
        !hasPrimaryModifier &&
        audioBuffer &&
        !isProcessing &&
        recorder.status !== "recording"
      ) {
        // L = 循环播放开关（点亮即从成片开头开始播）
        event.preventDefault();
        toggleLoop();
      } else if (
        event.code === "KeyH" ||
        event.key === "?" ||
        (event.code === "Slash" && event.shiftKey)
      ) {
        event.preventDefault();
        setHelpOpen(true);
      } else if (event.code === "Space") {
        event.preventDefault();
        if (recorder.status === "recording") {
          // 录音中 Space = 暂停/继续录音（P 键已移除，统一到 Space）。
          void (recorder.isPaused
            ? recorder.resumeRecording()
            : recorder.pauseRecording());
        } else if (
          recordingCountdown === null &&
          recorder.status !== "review"
        ) {
          // 倒计时与录音待确认期间吞掉 Space，防止误触旧音频回放造成混音。
          togglePlayback();
        }
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
    handleLoudnessNormalize,
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
    playFromStart,
    restoreLastAutoDetection,
    redo,
    startRecordingWithCountdown,
    stepSpeed,
    toggleLoop,
    togglePlayback,
    undo,
  ]);

  /**
   * 「取消」：把面板打开期间改动过的设置全部回退到打开时的快照。
   * 需要单独列的只有面板里那几项即时生效的设置；工具栏上的静音预设、
   * 降噪预设不在面板内，不参与回退。
   */
  const cancelSetup = () => {
    const snapshot = setupSnapshotRef.current;
    setShowRecordingSetup(false);
    if (!snapshot) return;
    recorder.setSelectedDeviceId(snapshot.deviceId);
    setAutoTranscribeEnabled(snapshot.autoTranscribe);
    setAutoTranscribe(snapshot.autoTranscribe);
    setTranscriptVisible(snapshot.transcriptVisible);
    commitSilenceThreshold(snapshot.silenceThreshold);
    commitLufsTarget(snapshot.lufsTarget);
    setExportFormatState(snapshot.exportFormat);
    setExportFormat(snapshot.exportFormat);
    setExportBitrateState(snapshot.exportBitrate);
    setExportBitrate(snapshot.exportBitrate);
    setVideoVariantState(snapshot.videoVariant);
    persistVideoVariant(snapshot.videoVariant);
    setVideoTransitionState(snapshot.videoTransition);
    persistVideoTransition(snapshot.videoTransition);
    setVideoTransitionTypeState(snapshot.videoTransitionType);
    persistVideoTransitionType(snapshot.videoTransitionType);
    // ffmpeg 路径也回退并静默重探一次（不弹引导框、不发提示，本函数末尾统一提示）
    if (isTauriDesktop() && snapshot.ffmpegPath !== getFfmpegPath()) {
      persistFfmpegPath(snapshot.ffmpegPath);
      setFfmpegPathInput(snapshot.ffmpegPath);
      void resolveFfmpeg(false);
    }
    // 模型目录从后端读，快照可能还没补上：没取到就别回退，免得把自定义目录冲成默认
    if (isTauriDesktop() && snapshot.modelDir !== undefined) {
      setModelDirInput(snapshot.modelDir ?? "");
      setCustomModelDir(snapshot.modelDir);
      void setTranscribeModelDir(snapshot.modelDir)
        .then(() => refreshModelStatus())
        .catch(() => notify("模型目录恢复失败", "error"));
    }
    notify("已撤回本次设置改动");
  };

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
        <span className="toolbar-divider" aria-hidden="true" />
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
        {isTauriDesktop() && (
          <>
            <span className="toolbar-divider" aria-hidden="true" />
            <div className="toolbar-group" aria-label="转录">
              <button
                onClick={() => void handleTranscribe()}
                disabled={!audioBuffer || isProcessing || modelDownloadPercent !== null}
              >
                转录文字 <span className="shortcut-key">T</span>
              </button>
              {transcribeProgress && (
                <>
                  <span className="denoise-progress">
                    {transcribeProgress.stage === "download" &&
                      `下载模型 ${Math.round(transcribeProgress.percent)}%`}
                    {transcribeProgress.stage === "transcribe" &&
                      `转录 ${Math.round(transcribeProgress.percent)}%`}
                    {transcribeProgress.stage === "punctuation" &&
                      (transcribeProgress.percent < 0
                        ? "正在准备标点模型…"
                        : `下载标点模型 ${Math.round(transcribeProgress.percent)}%`)}
                  </span>
                  <button onClick={() => void cancelTranscribe()}>
                    取消转录
                  </button>
                </>
              )}
            </div>
          </>
        )}
        </div>
        <div className="controls-row controls-row-secondary">
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
          {isTauriDesktop() && (
            <button
              onClick={() => void handleVideoUpload()}
              disabled={
                isProcessing ||
                recorder.status === "recording" ||
                recordingCountdown !== null
              }
              title="导入视频文件：抽出音轨照常编辑，导出时生成 MP4（需要系统 ffmpeg）"
            >
              打开视频
            </button>
          )}
          {videoImportStage && (
            <span className="denoise-progress">
              {videoImportStage === "extract"
                ? `提取音轨 ${Math.round(videoImportProgress ?? 0)}%`
                : "解析音轨…"}
            </span>
          )}
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
            onClick={() => {
              const next = !showRecordingSetup;
              setShowRecordingSetup(next);
              // 进入设置页时滚回顶部，让提示信息/设置内容可见
              if (next) scrollPreviewToTop();
            }}
            disabled={recordingCountdown !== null || isStartingRecording}
          >
            设置
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
          <select
            className="noise-preset"
            value={compressionPreset}
            onChange={(event) => {
              const preset = event.target.value as CompressionPreset;
              setCompressionPreset(preset);
              persistCompressionPreset(preset);
            }}
            disabled={!audioBuffer || isProcessing}
            aria-label="压缩档位"
            title={`压缩档位＝目标跨度：自动量出这段录音自身的起伏跨度（只算保留区间），再把它压到「轻 8 / 中 5 / 强 3」dB，与麦克风增益大小无关`}
          >
            {COMPRESSION_PRESET_LIST.map((preset) => (
              <option key={preset} value={preset}>
                压缩：{COMPRESSION_PRESETS[preset].label}
              </option>
            ))}
          </select>
          <button
            onClick={handleCompression}
            disabled={!audioBuffer || isProcessing}
            title={`一键语音优化：高通 80 Hz → 向下扩展（底噪够干净时自动跳过）→ 软拐点压缩 → 响度标准化（全链唯一一次真峰值限幅）。自动量出这段录音的起伏跨度（只算保留区间），按档位压到 ${COMPRESSION_PRESETS[compressionPreset].targetSpanDb} dB（与麦克风增益大小无关），压完直接归一到 ${lufsTargetDb} LUFS（上限 ${exportFormat === "mp3" ? LUFS_CEILING_DB_MP3 : LUFS_CEILING_DB_WAV} dBTP）`}
          >
            压缩
          </button>
          {audioBuffer && !hasEnhancedAudio && (
            <span
              className="chain-hint"
              title="扩展器只兜得住残余底噪：先「一键降噪」再优化，成品更干净"
            >
              建议先降噪
            </span>
          )}
          {hasCompressionApplied && (
            <button
              onClick={revertCompression}
              title="回退到压缩之前的版本（含流水线里那次响度标准化；重复点「压缩」是换档位，不会叠压）"
            >
              撤销压缩
            </button>
          )}
          <button
            onClick={handleLoudnessNormalize}
            disabled={!audioBuffer || isProcessing}
            aria-keyshortcuts="Shift+L"
            title={`快捷键 ⇧L：把成片响度归一至 ${lufsTargetDb} LUFS，真峰值限幅防削波`}
          >
            响度标准化 <span className="shortcut-key">⇧L</span>
          </button>
          {hasLoudnessApplied && (
            <button
              onClick={revertLoudness}
              title="回退到响度标准化之前的版本"
            >
              撤销响度
            </button>
          )}
          <button onClick={restoreOriginal} disabled={!hasEnhancedAudio}>
            恢复原始 <span className="shortcut-key">B</span>
          </button>
        </div>
        <span className="toolbar-divider" aria-hidden="true" />
        <div className="toolbar-group" aria-label="输出和帮助">
          {videoAsset && (
            <label
              className="video-subtitle-toggle"
              title="把转录结果按成片时间轴重映射后，与视频一起导出为同名 .srt（需要先转录）"
            >
              <input
                type="checkbox"
                checked={exportSubtitles}
                disabled={!transcript}
                onChange={(event) => setExportSubtitles(event.target.checked)}
              />
              字幕 SRT
            </label>
          )}
          <button
            onClick={handleExport}
            disabled={!audioBuffer || isProcessing || videoExportProgress !== null}
          >
            导出 {videoAsset ? "视频" : exportFormat === "mp3" ? "MP3" : "WAV"}{" "}
            <span className="shortcut-key">⌘/Ctrl+S</span>
          </button>
          {videoExportProgress !== null && (
            <>
              <span className="denoise-progress">
                导出视频 {Math.round(videoExportProgress)}%
              </span>
              <button
                onClick={() =>
                  void invoke("cancel_video_export").catch(() => undefined)
                }
              >
                取消导出
              </button>
            </>
          )}
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
            {recordingCountdown > 2 ? "准备" : "开始"}
          </span>
          <p>
            {recordingCountdown > 2 ? "倒计时结束后开始录音" : "马上开始录音"}
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
            <button
              onClick={cancelSetup}
              title="撤回本次打开设置后改动的项目，恢复成打开前的值"
            >
              取消
            </button>
          </div>
          {isTauriDesktop() && (
            <>
              <div className="setup-row">
                <label className="setup-grow">
                  转录模型目录
                  <input
                    type="text"
                    value={modelDirInput}
                    placeholder={DEFAULT_MODEL_DIR_HINT}
                    onChange={(event) => setModelDirInput(event.target.value)}
                  />
                </label>
                <button
                  onClick={() => {
                    const value = modelDirInput.trim();
                    setCustomModelDir(value || null);
                    void setTranscribeModelDir(value || null)
                      .then(() => refreshModelStatus())
                      .catch(() => notify("模型目录保存失败", "error"));
                  }}
                  title="把输入框里的路径写入配置并重新检查模型状态"
                >
                  应用路径
                </button>
                <button
                  onClick={() => void openTranscribeModelDir()}
                  title="在文件管理器中打开模型目录"
                >
                  打开目录
                </button>
                <button
                  onClick={() => void handleDownloadModels()}
                  disabled={
                    modelDownloadPercent !== null ||
                    Boolean(transcribeProgress) ||
                    modelReady
                  }
                  title={
                    modelReady
                      ? "SenseVoice 与标点模型均已就绪，无需重复下载"
                      : "下载 SenseVoice 与标点模型；已存在的文件会跳过"
                  }
                >
                  {modelDownloadPercent !== null
                    ? `下载中 ${Math.round(modelDownloadPercent)}%`
                    : "下载模型"}
                </button>
              </div>
              <div className="setup-row">
                <small
                  className={
                    modelDownloadError
                      ? "model-status is-error"
                      : modelReady
                        ? "model-status is-ready"
                        : "model-status"
                  }
                >
                  {modelDownloadError
                    ? `下载失败：${modelDownloadError}`
                    : modelDownloadPercent !== null
                      ? `正在下载 ${Math.round(modelDownloadPercent)}%`
                      : modelStatus
                        ? transcribeModelStatusText(modelStatus)
                        : "状态检查中…"}
                </small>
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
            <label className="setup-checkbox">静音阈值</label>
            {SILENCE_THRESHOLD_PRESETS.map((preset) => (
              <label className="setup-checkbox" key={preset.label}>
                <input
                  type="radio"
                  name="silence-threshold"
                  checked={silenceThresholdDb === preset.threshold}
                  onChange={() => commitSilenceThreshold(preset.threshold)}
                />
                {preset.label}
              </label>
            ))}
            <label className="setup-checkbox">
              <input
                type="number"
                step="1"
                min={SILENCE_THRESHOLD_RANGE.min}
                max={SILENCE_THRESHOLD_RANGE.max}
                value={silenceThresholdInput}
                onChange={(event) =>
                  setSilenceThresholdInput(event.target.value)
                }
                onBlur={() => {
                  const parsed = Number(silenceThresholdInput);
                  commitSilenceThreshold(
                    Number.isFinite(parsed) ? parsed : silenceThresholdDb,
                  );
                }}
              />
              dBFS
            </label>
          </div>
          <div className="setup-row">
            <label className="setup-checkbox">响度目标</label>
            {LUFS_TARGET_PRESETS.map((preset) => (
              <label className="setup-checkbox" key={preset.label}>
                <input
                  type="radio"
                  name="lufs-target"
                  checked={lufsTargetDb === preset.target}
                  onChange={() => commitLufsTarget(preset.target)}
                />
                {preset.label}
              </label>
            ))}
            <label className="setup-checkbox">
              <input
                type="number"
                step="0.5"
                min={LUFS_TARGET_RANGE.min}
                max={LUFS_TARGET_RANGE.max}
                value={lufsTargetInput}
                onChange={(event) => setLufsTargetInput(event.target.value)}
                onBlur={() => {
                  const parsed = Number(lufsTargetInput);
                  commitLufsTarget(
                    Number.isFinite(parsed) ? parsed : lufsTargetDb,
                  );
                }}
              />
              LUFS
            </label>
          </div>
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
              MP3
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
              WAV（默认）
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
          {isTauriDesktop() && (
            <>
              <div className="setup-row">
                <label className="setup-grow">
                  ffmpeg 路径
                  <input
                    type="text"
                    value={ffmpegPathInput}
                    placeholder="留空则自动探测系统 PATH"
                    onChange={(event) => setFfmpegPathInput(event.target.value)}
                    onBlur={() => {
                      const value = ffmpegPathInput.trim();
                      if (value !== getFfmpegPath()) void applyFfmpegPath(value);
                    }}
                  />
                </label>
                <button
                  onClick={() => void pickFfmpegPath()}
                  title="选择一个 ffmpeg 可执行文件"
                >
                  选择…
                </button>
              </div>
              <div className="setup-row">
                <small>
                  {!ffmpegInfo
                    ? "检测中…"
                    : !ffmpegInfo.found
                      ? "未找到可运行的 ffmpeg：视频导入与导出不可用（填的路径不存在时会回退自动探测）"
                      : `${ffmpegInfo.version ?? "ffmpeg"}｜${
                          ffmpegInfo.hasLibx264
                            ? "含 libx264"
                            : "不含 libx264，精确编码不可用"
                        }｜${
                          ffmpegInfo.hasXfade
                            ? "含 xfade，可用切片过渡"
                            : "不含 xfade，切片过渡不可用"
                        }`}
                </small>
              </div>
            </>
          )}
          {videoAsset && (
            <>
              <div className="setup-row">
                <label className="setup-checkbox">视频导出档位</label>
                <label className="setup-checkbox">
                  <input
                    type="radio"
                    name="video-variant"
                    checked={videoExportVariant === "fastcopy"}
                    onChange={() => {
                      setVideoVariantState("fastcopy");
                      persistVideoVariant("fastcopy");
                    }}
                  />
                  无损快切（默认）
                </label>
                <label className="setup-checkbox">
                  <input
                    type="radio"
                    name="video-variant"
                    checked={videoExportVariant === "reencode"}
                    onChange={() => {
                      setVideoVariantState("reencode");
                      persistVideoVariant("reencode");
                    }}
                  />
                  精确编码
                </label>
              </div>
              <div className="setup-row">
                <label className="setup-checkbox">转场类型</label>
                {VIDEO_TRANSITION_TYPES.map((item) => (
                  <label className="setup-checkbox" key={item.value} title={item.hint}>
                    <input
                      type="radio"
                      name="video-transition-type"
                      checked={videoTransitionType === item.value}
                      disabled={
                        videoExportVariant !== "reencode" || !ffmpegInfo?.hasXfade
                      }
                      onChange={() => {
                        setVideoTransitionTypeState(item.value);
                        persistVideoTransitionType(item.value);
                      }}
                    />
                    {item.label}
                  </label>
                ))}
              </div>
              <div className="setup-row">
                <label className="setup-checkbox">切片过渡</label>
                <input
                  type="range"
                  className="setup-range"
                  min={VIDEO_TRANSITION_RANGE.min}
                  max={VIDEO_TRANSITION_RANGE.max}
                  step={VIDEO_TRANSITION_RANGE.step}
                  value={videoTransition}
                  disabled={
                    videoExportVariant !== "reencode" || !ffmpegInfo?.hasXfade
                  }
                  onChange={(event) => {
                    const value = Number(event.target.value);
                    setVideoTransitionState(value);
                    persistVideoTransition(value);
                  }}
                  aria-label="切片过渡时长"
                />
                <small>
                  {videoTransition === 0 ? "硬切" : `${videoTransition.toFixed(1)} 秒`}
                </small>
              </div>
              <div className="setup-row">
                <small>
                  {videoExportVariant !== "reencode"
                    ? "「无损快切」不重编码画面，做不了过渡 —— 切到「精确编码」后上面这两项才生效。"
                    : videoTransition === 0
                      ? "接缝处硬切（当前设置）。现代口播里跳切本身也很常见，不必非要加过渡。"
                      : `接缝处做 ${videoTransition.toFixed(1)} 秒${
                          VIDEO_TRANSITION_TYPES.find(
                            (item) => item.value === videoTransitionType,
                          )?.label ?? "过渡"
                        }（${
                          VIDEO_TRANSITION_TYPES.find(
                            (item) => item.value === videoTransitionType,
                          )?.hint ?? ""
                        }；声音不跟着变，在接缝处硬拼接、两端各加 5 毫秒微淡），成片会比硬切短 ${videoTransition.toFixed(1)} 秒 × 接缝数。越短越不像加了转场 —— 0.1 秒只够读成「甩了一下」，拉到 0 就是硬切。`}
                  {" 过渡只在导出时应用，预览仍是硬切。"}
                </small>
              </div>
              {ffmpegInfo &&
                (!ffmpegInfo.hasLibx264 || !ffmpegInfo.hasXfade) && (
                  <div className="setup-row">
                    <small>
                      {!ffmpegInfo.hasLibx264
                        ? "当前 ffmpeg 不带 libx264，「精确编码」不可用 —— 在上面填一份完整构建的路径"
                        : "当前 ffmpeg 不带 xfade 滤镜，「切片过渡」不可用（导出会按硬切）—— 在上面填一份完整构建的路径"}
                    </small>
                  </div>
                )}
            </>
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
                className={`meter${recordingMeter.barDb >= -6 ? " meter-warning" : ""}`}
                aria-label="实时输入峰值电平"
              >
                {/* 底柱 = RMS（说话的平均水平），下面两根白针分别是瞬时峰值与保持 */}
                <div
                  className="meter-rms"
                  style={{
                    transform: `scaleX(${meterPosition(recorder.level.rmsDb)})`,
                  }}
                />
                {/* 目标带只管峰值：看白针落点，底柱（RMS）本来就低于它 */}
                <span
                  className="meter-target-band"
                  style={{
                    left: `${meterPosition(METER_TARGET_RANGE.min) * 100}%`,
                    width: `${
                      (meterPosition(METER_TARGET_RANGE.max) -
                        meterPosition(METER_TARGET_RANGE.min)) *
                      100
                    }%`,
                  }}
                  title={`${METER_TARGET_RANGE.min} ~ ${METER_TARGET_RANGE.max} dBFS：期望的录音峰值区间（看白针，不看底柱）`}
                />
                <div
                  className="meter-bar"
                  style={{
                    left: `${meterPosition(recordingMeter.barDb) * 100}%`,
                    opacity: Number.isFinite(recordingMeter.barDb) ? 1 : 0,
                  }}
                />
                <div
                  className="meter-peak"
                  style={{
                    left: `${meterPosition(recordingMeter.holdDb) * 100}%`,
                    opacity: Number.isFinite(recordingMeter.holdDb) ? 1 : 0,
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
            <LufsReadout lufs={recorder.level.lufs} target={lufsTargetDb} />
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
              title="快捷键 Space：暂停/继续录音"
              aria-keyshortcuts="Space"
            >
              {recorder.isPaused ? "继续" : "暂停"}{" "}
              <span className="shortcut-key">Space</span>
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

      {ffmpegGuideOpen && (
        <section
          className="recording-setup ffmpeg-guide"
          role="dialog"
          aria-label="需要安装 ffmpeg"
        >
          <div className="setup-row">
            <strong>视频功能需要系统 ffmpeg</strong>
          </div>
          <p>
            视频的导入与导出都由系统 ffmpeg 完成（应用不内置 ffmpeg）。安装后点「重新检测」：
          </p>
          <p className="ffmpeg-guide-command">
            {navigator.userAgent.includes("Windows")
              ? "winget install Gyan.FFmpeg ／ scoop install ffmpeg ／ choco install ffmpeg"
              : "brew install ffmpeg"}
          </p>
          <div className="setup-row">
            <button onClick={() => void recheckFfmpeg()}>重新检测</button>
            <button onClick={() => setFfmpegGuideOpen(false)}>关闭</button>
          </div>
          {ffmpegInfo?.path && (
            <div className="setup-row">
              <small>
                当前：{ffmpegInfo.version ?? "ffmpeg"}
                ｜
                {ffmpegInfo.hasLibx264
                  ? "包含 libx264，可用精确重编码"
                  : "不含 libx264，精确重编码不可用"}
                ｜{ffmpegInfo.hasXfade ? "含 xfade，可用切片过渡" : "不含 xfade，切片过渡不可用"}
              </small>
            </div>
          )}
          <div className="setup-row">
            <small>
              要指定某一份 ffmpeg，请在设置页的「ffmpeg 路径」里填或选（应用不内置 ffmpeg）。
            </small>
          </div>
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
        {isProcessing && !transcribeProgress && (
          <div className="loading-overlay">
            <div className="spinner" />
            <p>处理中...</p>
          </div>
        )}
        {videoAsset && (
          <VideoPreview
            src={videoAsset.src}
            position={currentTime}
            isPlaying={isPlaying}
            playbackRate={playbackSpeed}
          />
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

      {audioBuffer && (
        <WaveSidebar
          level={playbackLevel}
          filePeakDb={filePeakDb}
          lufs={timelineLufs}
          lufsTarget={lufsTargetDb}
        />
      )}

      {audioBuffer && (
        <PlaybackSidebar
          speed={playbackSpeed}
          onSpeedChange={setPlaybackSpeed}
          onSpeedReset={resetSpeed}
          onPlayFromStart={playFromStart}
          looping={looping}
          onToggleLoop={toggleLoop}
          disabled={isProcessing || recorder.status === "recording"}
        />
      )}

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
