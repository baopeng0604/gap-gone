import { Region } from "./regionUtils";

export interface SilenceDetectionOptions {
  /** 静音阈值（dBFS），块 RMS 低于该值算安静。 */
  thresholdDb?: number;
  minDuration?: number; // seconds, default 0.3
  padding?: number; // legacy symmetric padding override
  leadingPadding?: number; // seconds to keep before the next speech
  trailingPadding?: number; // seconds to keep after the previous speech
}

export type SilencePreset = "compact" | "natural" | "relaxed";

export const SILENCE_PRESETS: Record<
  SilencePreset,
  Pick<SilenceDetectionOptions, "minDuration" | "leadingPadding" | "trailingPadding">
> = {
  compact: { minDuration: 0.2, leadingPadding: 0.06, trailingPadding: 0.06 },
  natural: { minDuration: 0.3, leadingPadding: 0.12, trailingPadding: 0.12 },
  relaxed: { minDuration: 0.4, leadingPadding: 0.18, trailingPadding: 0.18 },
};

/** 默认阈值 -36.5 dBFS（等价早先硬编码的线性 0.015）。 */
export const SILENCE_THRESHOLD_DEFAULT = -36.5;
/** 允许的阈值区间：高于 -20 会把气口和弱尾音一起切掉，低于 -60 基本检不到东西。 */
export const SILENCE_THRESHOLD_RANGE = { min: -60, max: -20 };
export const SILENCE_THRESHOLD_PRESETS = [
  { label: "激进 -30", threshold: -30 },
  { label: "标准 -36.5", threshold: -36.5 },
  { label: "保守 -45", threshold: -45 },
] as const;

/**
 * 滞回宽度（dB）：已判为静音后，需要高出阈值这么多才判回有声。
 * 底噪在阈值附近抖动时，没有它会导致状态反复翻转、静音段被切碎后全部丢弃。
 */
const HYSTERESIS_DB = 6;
/** 相邻静音区间空隙不超过该值（秒）就合并，之后再套 minDuration 与两端保留量。 */
const GAP_TOLERANCE = 0.15;
/** 块级电平的中值滤波窗口（块数，奇数），用来抹掉单块瞬时尖峰。 */
const MEDIAN_WINDOW = 3;

/** 逐块算 RMS 并转 dBFS（含跨声道能量平均）。 */
function chunkLevelsDb(
  buffer: AudioBuffer,
  channels: Float32Array[],
  chunkLength: number,
): number[] {
  const levels: number[] = [];
  for (let i = 0; i < buffer.length; i += chunkLength) {
    const size = Math.min(chunkLength, buffer.length - i);
    let sum = 0;
    for (const channel of channels) {
      for (let k = 0; k < size; k++) {
        const sample = channel[i + k];
        sum += sample * sample;
      }
    }
    const rms = Math.sqrt(sum / (size * channels.length));
    levels.push(rms > 0 ? 20 * Math.log10(rms) : Number.NEGATIVE_INFINITY);
  }
  return levels;
}

/** 滑动中值滤波，边缘用可用邻域。 */
function medianFilter(values: number[], window: number): number[] {
  const half = Math.floor(window / 2);
  return values.map((_, index) => {
    const slice = values.slice(
      Math.max(0, index - half),
      Math.min(values.length, index + half + 1),
    );
    const sorted = [...slice].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  });
}

/** 合并空隙不超过 tolerance 秒的相邻区间（入参按起点有序且互不重叠）。 */
function mergeNearby(regions: Region[], tolerance: number): Region[] {
  return regions.reduce<Region[]>((merged, region) => {
    const previous = merged[merged.length - 1];
    if (previous && region.start - previous.end <= tolerance) {
      return [
        ...merged.slice(0, -1),
        { start: previous.start, end: Math.max(previous.end, region.end) },
      ];
    }
    return [...merged, { start: region.start, end: region.end }];
  }, []);
}

export function detectSilence(
  buffer: AudioBuffer,
  options: SilenceDetectionOptions = {}
): Region[] {
  const {
    thresholdDb = SILENCE_THRESHOLD_DEFAULT,
    minDuration = 0.3,
    padding,
    leadingPadding = padding ?? 0.12,
    trailingPadding = padding ?? 0.12,
  } = options;

  const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) =>
    buffer.getChannelData(i),
  );
  const sampleRate = buffer.sampleRate;
  const chunkLength = 4096; // Processing chunk size
  const levels = medianFilter(
    chunkLevelsDb(buffer, channels, chunkLength),
    MEDIAN_WINDOW,
  );

  const raw: Region[] = [];
  let isSilence = false;
  let silenceStart = 0;

  levels.forEach((db, index) => {
    const time = (index * chunkLength) / sampleRate;
    if (!isSilence) {
      if (db < thresholdDb) {
        isSilence = true;
        silenceStart = time;
      }
      return;
    }
    if (db > thresholdDb + HYSTERESIS_DB) {
      raw.push({ start: silenceStart, end: time });
      isSilence = false;
    }
  });

  if (isSilence) {
    raw.push({ start: silenceStart, end: buffer.duration });
  }

  return mergeNearby(raw, GAP_TOLERANCE)
    .filter((region) => region.end - region.start >= minDuration)
    .map((region) => ({
      start: Math.min(buffer.duration, region.start + leadingPadding),
      end: Math.max(0, region.end - trailingPadding),
    }))
    .filter((region) => region.end > region.start);
}
