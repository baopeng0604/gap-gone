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
  // 视频切片过渡的转场类型（smoothleft / wipeleft / dissolve / fadewhite）
  videoTransitionType: "gap-gone-video-transition-type",
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
 * 视频切片过渡的转场类型。**时长 = 0 时一律硬切，与此项无关。**
 *
 * 默认 `smoothleft`（平滑滑移）。为什么默认不是交叉溶解：溶解把两帧不同姿态的画面叠在
 * 一起，边缘成双影、细纹理互相交织，肉眼就是「锐化过度 + 密密麻麻的点」（实测混合帧的
 * 高频能量是普通帧的 1.66 倍、码率 5 倍）。
 *
 * 四个选项都留着，是因为「哪种最不显眼」得在用户自己的素材上看 —— 逐帧画面变动量实测
 * （普通素材基准 2.18）：平滑滑移 0.3 秒 2.32、划像 0.3 秒 2.41、交叉溶解 0.3 秒 2.83、
 * 闪白 0.3 秒 **32.55**（0.1 秒时 98.6，是基准的 45 倍）。闪白/闪黑是「请观众注意这里」
 * 的语言（转场、回忆、分屏），与「藏跳切」的目标相反，放在这里只为让用户自己排除它。
 */
export const VIDEO_TRANSITION_TYPES = [
  {
    value: "smoothleft",
    label: "平滑滑移",
    hint: "画面横向推入，两幅画面平移衔接",
  },
  {
    value: "wipeleft",
    label: "划像",
    hint: "一条边界扫过，画面本身不平移",
  },
  {
    value: "dissolve",
    label: "交叉溶解",
    hint: "两幅画面叠在一起淡化（会留双影、细纹交织）",
  },
  {
    value: "fadewhite",
    label: "闪白",
    hint: "画面先冲到纯白再回来 —— 最抢眼",
  },
] as const;

export type VideoTransitionType =
  (typeof VIDEO_TRANSITION_TYPES)[number]["value"];

const VIDEO_TRANSITION_TYPE_DEFAULT: VideoTransitionType = "smoothleft";

export function getVideoTransitionType(): VideoTransitionType {
  const raw = readString(SETTINGS_KEYS.videoTransitionType);
  return VIDEO_TRANSITION_TYPES.some((item) => item.value === raw)
    ? (raw as VideoTransitionType)
    : VIDEO_TRANSITION_TYPE_DEFAULT;
}

export function setVideoTransitionType(type: VideoTransitionType) {
  writeString(SETTINGS_KEYS.videoTransitionType, type);
}

/**
 * 视频切片过渡时长（秒）。**0 = 硬切**，默认 0.1。
 *
 * 默认取 0.1 秒（@30fps = 3 帧）而不是剪辑软件的常规转场时长：那些默认值（Premiere 30 帧、
 * DaVinci / Final Cut 1 秒、短视频工具 0.5 秒）是给**镜头之间**的转场用的；掩盖跳切相反，
 * 越短越不像「加了转场」—— 0.1 秒只够读成「甩了一下」，0.5 秒则是一整段持续平移，反而显眼。
 * 实测逐帧画面变动量：0.5 秒 1.84（比普通素材还平）、0.3 秒 2.32、0.2 秒 3.00、0.1 秒 5.21
 * —— 时长把同样的内容变化摊得越开，单帧越平，但「画面在平移」这件事持续得越久。
 */
export const VIDEO_TRANSITION_DEFAULT = 0.1;
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
