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

/** 用户手动指定的 ffmpeg 路径（空串 = 未指定，走自动探测）。 */
export function getFfmpegPath(): string {
  return readString(SETTINGS_KEYS.ffmpegPath) ?? "";
}

export function setFfmpegPath(path: string) {
  writeString(SETTINGS_KEYS.ffmpegPath, path || null);
}
