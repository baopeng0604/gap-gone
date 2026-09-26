/**
 * 统一设置持久化模块：所有用户偏好走 localStorage（Tauri WebView 按
 * app identifier 隔离落盘，跨启动保留）。每个设置一对 get/set，
 * 读取时校验非法值并回退默认值。
 */

import {
  SILENCE_THRESHOLD_DEFAULT,
  SILENCE_THRESHOLD_RANGE,
} from "./audioAnalysis";

export const SETTINGS_KEYS = {
  deviceId: "gap-gone-device-id",
  silencePreset: "gap-gone-silence-preset",
  silenceThreshold: "gap-gone-silence-threshold",
  noisePreset: "gap-gone-noise-preset",
  compressionPreset: "gap-gone-compression-preset",
  transcriptVisible: "gap-gone-transcript-visible",
  exportFormat: "gap-gone-export-format",
  exportBitrate: "gap-gone-export-bitrate",
  lufsTarget: "gap-gone-lufs-target",
  // transcribe.ts 已有的两个 key 沿用，用户数据不迁移不丢失
  autoTranscribe: "gap-gone-auto-transcribe",
  modelDir: "gap-gone-model-dir",
  // 用户手动指定的 ffmpeg 路径（视频导入/导出依赖系统 ffmpeg）
  ffmpegPath: "gap-gone-ffmpeg-path",
  // 视频导出档位（长期偏好；实际导出时素材不满足条件会自动降级并在导出前提示）
  videoVariant: "gap-gone-video-variant",
  // 视频切片过渡时长（秒，0 = 硬切；只在「精确编码」档生效）
  videoTransition: "gap-gone-video-transition",
} as const;

export type ExportFormat = "mp3" | "wav";
export type ExportBitrate = 96 | 128 | 192;

const EXPORT_BITRATES: ExportBitrate[] = [96, 128, 192];

function readString(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeString(key: string, value: string | null) {
  try {
    if (value === null) {
      localStorage.removeItem(key);
    } else {
      localStorage.setItem(key, value);
    }
  } catch {
    // localStorage 不可用时静默降级为内存态（本次会话内仍有效）
  }
}

/** 录音设备（cpal 稳定 id；设备不存在时由 useRecorder 的回退逻辑处理）。 */
export function getDeviceId(): string {
  return readString(SETTINGS_KEYS.deviceId) ?? "";
}

export function setDeviceId(id: string) {
  writeString(SETTINGS_KEYS.deviceId, id || null);
}

/** 静音检测预设（compact / natural / relaxed，默认 natural）。 */
export function getSilencePreset(): string {
  const value = readString(SETTINGS_KEYS.silencePreset);
  return value === "compact" || value === "relaxed" ? value : "natural";
}

export function setSilencePreset(preset: string) {
  writeString(SETTINGS_KEYS.silencePreset, preset);
}

/** 静音检测阈值（dBFS，默认 -36.5，与静音检测算法默认值同源）。 */
export function getSilenceThreshold(): number {
  const raw = readString(SETTINGS_KEYS.silenceThreshold);
  if (raw === null) return SILENCE_THRESHOLD_DEFAULT;
  const value = Number(raw);
  if (!Number.isFinite(value)) return SILENCE_THRESHOLD_DEFAULT;
  if (
    value < SILENCE_THRESHOLD_RANGE.min ||
    value > SILENCE_THRESHOLD_RANGE.max
  ) {
    return SILENCE_THRESHOLD_DEFAULT;
  }
  return value;
}

export function setSilenceThreshold(threshold: number) {
  const clamped = Math.max(
    SILENCE_THRESHOLD_RANGE.min,
    Math.min(SILENCE_THRESHOLD_RANGE.max, threshold),
  );
  writeString(SETTINGS_KEYS.silenceThreshold, String(Math.round(clamped * 10) / 10));
}

/** 降噪预设（light / medium / strong，默认 medium）。 */
export function getNoisePreset(): string {
  const value = readString(SETTINGS_KEYS.noisePreset);
  return value === "light" || value === "strong" ? value : "medium";
}

export function setNoisePreset(preset: string) {
  writeString(SETTINGS_KEYS.noisePreset, preset);
}

/** 压缩预设（light / medium / strong，默认 medium）。 */
export function getCompressionPreset(): string {
  const value = readString(SETTINGS_KEYS.compressionPreset);
  return value === "light" || value === "strong" ? value : "medium";
}

export function setCompressionPreset(preset: string) {
  writeString(SETTINGS_KEYS.compressionPreset, preset);
}

/** 转录面板显隐（默认显示）。 */
export function getTranscriptVisible(): boolean {
  return readString(SETTINGS_KEYS.transcriptVisible) !== "0";
}

export function setTranscriptVisible(visible: boolean) {
  writeString(SETTINGS_KEYS.transcriptVisible, visible ? "1" : "0");
}

/** 导出格式（默认 WAV：无损母版，不再压一次有损编码；要小体积时在设置里切 MP3）。 */
export function getExportFormat(): ExportFormat {
  const value = readString(SETTINGS_KEYS.exportFormat);
  return value === "mp3" ? "mp3" : "wav";
}

export function setExportFormat(format: ExportFormat) {
  writeString(SETTINGS_KEYS.exportFormat, format);
}

/** MP3 码率 kbps CBR（默认 128）。 */
export function getExportBitrate(): ExportBitrate {
  const value = Number(readString(SETTINGS_KEYS.exportBitrate));
  return (EXPORT_BITRATES as number[]).includes(value)
    ? (value as ExportBitrate)
    : 128;
}

export function setExportBitrate(bitrate: ExportBitrate) {
  writeString(SETTINGS_KEYS.exportBitrate, String(bitrate));
}

/**
 * 响度标准化目标（Integrated LUFS）。默认 -19：Apple Podcasts 对单声道节目的规范值，
 * 也是本应用口播录音的常规交付口径。注意单双声道口径：BS.1770 对单声道按单通道权重
 * 量测，所以同一个单声道文件在立体声系统回放会比读数响 3 dB —— 这就是「单声道 -19 /
 * 立体声 -16」那 3 dB 的来源。-23 是 EBU R128 广播标准（美国 ATSC A/85 为 -24 LKFS），
 * -14 对齐短视频平台。
 */
export const LUFS_TARGET_PRESETS = [
  { label: "广播 -23", target: -23 },
  { label: "播客 -19", target: -19 },
  { label: "短视频 -14", target: -14 },
] as const;

const LUFS_TARGET_DEFAULT = -19;
/** 允许的目标区间：高于 -6 LUFS 已经没有动态可言，低于 -30 基本没有意义。 */
export const LUFS_TARGET_RANGE = { min: -30, max: -6 };

export function getLufsTarget(): number {
  const raw = readString(SETTINGS_KEYS.lufsTarget);
  if (raw === null) return LUFS_TARGET_DEFAULT;
  const value = Number(raw);
  if (!Number.isFinite(value)) return LUFS_TARGET_DEFAULT;
  if (value < LUFS_TARGET_RANGE.min || value > LUFS_TARGET_RANGE.max) {
    return LUFS_TARGET_DEFAULT;
  }
  return value;
}

export function setLufsTarget(target: number) {
  const clamped = Math.max(
    LUFS_TARGET_RANGE.min,
    Math.min(LUFS_TARGET_RANGE.max, target),
  );
  writeString(SETTINGS_KEYS.lufsTarget, String(Math.round(clamped * 10) / 10));
}

/**
 * ffmpeg 可执行文件在 Windows 上的默认路径。
 *
 * 为什么给一个具体路径当默认值：系统 PATH 里排在前面的常是某个应用自带的精简构建
 * （实测 Krita 那份既没有 libx264 也没有 xfade），自动探测挑中它之后，「精确编码」
 * 与「切片过渡」会莫名不可用，用户按提示重装 ffmpeg 也查不出原因。这里默认指向一份
 * 完整构建（LosslessCut 自带，实测含 libx264 + xfade）。**该文件不存在时
 * detect_ffmpeg 会回落到自动探测**（见 App.tsx 的 resolveFfmpeg），换台机器不会卡住。
 */
export const DEFAULT_FFMPEG_PATH =
  "D:\\ProgramData\\LosslessCut-win-x64\\resources\\ffmpeg.exe";

/** 用户指定的 ffmpeg 路径；未指定时 Windows 返回默认值，其他平台返回空串（走自动探测）。 */
export function getFfmpegPath(): string {
  const stored = readString(SETTINGS_KEYS.ffmpegPath);
  if (stored) return stored;
  return navigator.userAgent.includes("Windows") ? DEFAULT_FFMPEG_PATH : "";
}

export function setFfmpegPath(path: string) {
  writeString(SETTINGS_KEYS.ffmpegPath, path || null);
}

/** 视频导出档位：fastcopy（无损快切，不重编码）/ reencode（精确编码，逐帧切）。 */
export type VideoExportVariant = "fastcopy" | "reencode";

/**
 * 视频导出档位（默认 fastcopy）。**它只是长期偏好**：素材不满足快速档条件时
 * （HEVC / 含 B 帧 / 带旋转 / 已处理过音频 / 切点无法安全吸附），导出会自动降级为
 * reencode 并在导出前说明原因 —— 所以不要在设置页里把它当成"本次一定这么走"。
 */
export function getVideoVariant(): VideoExportVariant {
  return readString(SETTINGS_KEYS.videoVariant) === "reencode"
    ? "reencode"
    : "fastcopy";
}

export function setVideoVariant(variant: VideoExportVariant) {
  writeString(SETTINGS_KEYS.videoVariant, variant);
}

/**
 * 视频切片过渡时长（秒）。**0 = 硬切**，默认 0.3。
 *
 * 0.3 秒是"消隐跳切"的常用值：剪辑软件的转场默认时长普遍是 1 秒（Premiere 的 30 帧、
 * DaVinci 与 Final Cut 的 Standard Duration），短视频工具的转场默认 0.5 秒，但那些是给
 * 镜头切换用的；隐藏跳切要短得多（业内实操多在 0.1~0.3 秒），再长就不像在藏剪辑点、
 * 而像刻意加了个转场，且音频是同步交叉淡化，越长越多字会被叠在一起。
 */
export const VIDEO_TRANSITION_DEFAULT = 0.3;
/** 可调区间（秒）与步进。0 表示硬切。 */
export const VIDEO_TRANSITION_RANGE = { min: 0, max: 1, step: 0.1 } as const;

export function getVideoTransition(): number {
  const raw = readString(SETTINGS_KEYS.videoTransition);
  if (raw === null) return VIDEO_TRANSITION_DEFAULT;
  const value = Number(raw);
  if (!Number.isFinite(value)) return VIDEO_TRANSITION_DEFAULT;
  if (
    value < VIDEO_TRANSITION_RANGE.min ||
    value > VIDEO_TRANSITION_RANGE.max
  ) {
    return VIDEO_TRANSITION_DEFAULT;
  }
  return Math.round(value * 10) / 10;
}

export function setVideoTransition(seconds: number) {
  const clamped = Math.max(
    VIDEO_TRANSITION_RANGE.min,
    Math.min(VIDEO_TRANSITION_RANGE.max, seconds),
  );
  writeString(SETTINGS_KEYS.videoTransition, String(Math.round(clamped * 10) / 10));
}
