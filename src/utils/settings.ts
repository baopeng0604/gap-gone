/**
 * 统一设置持久化模块：所有用户偏好走 localStorage（Tauri WebView 按
 * app identifier 隔离落盘，跨启动保留）。每个设置一对 get/set，
 * 读取时校验非法值并回退默认值。
 */

export const SETTINGS_KEYS = {
  deviceId: "gap-gone-device-id",
  silencePreset: "gap-gone-silence-preset",
  noisePreset: "gap-gone-noise-preset",
  transcriptVisible: "gap-gone-transcript-visible",
  exportFormat: "gap-gone-export-format",
  exportBitrate: "gap-gone-export-bitrate",
  // transcribe.ts 已有的两个 key 沿用，用户数据不迁移不丢失
  autoTranscribe: "gap-gone-auto-transcribe",
  modelDir: "gap-gone-model-dir",
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

/** 降噪预设（light / medium / strong，默认 medium）。 */
export function getNoisePreset(): string {
  const value = readString(SETTINGS_KEYS.noisePreset);
  return value === "light" || value === "strong" ? value : "medium";
}

export function setNoisePreset(preset: string) {
  writeString(SETTINGS_KEYS.noisePreset, preset);
}

/** 转录面板显隐（默认显示）。 */
export function getTranscriptVisible(): boolean {
  return readString(SETTINGS_KEYS.transcriptVisible) !== "0";
}

export function setTranscriptVisible(visible: boolean) {
  writeString(SETTINGS_KEYS.transcriptVisible, visible ? "1" : "0");
}

/** 导出格式（默认 MP3）。 */
export function getExportFormat(): ExportFormat {
  const value = readString(SETTINGS_KEYS.exportFormat);
  return value === "wav" ? "wav" : "mp3";
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
