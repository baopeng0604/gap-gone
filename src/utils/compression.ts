/**
 * 压缩（Compressor）：把大的音量压小、小的音量相对提上来，收窄整段动态。
 *
 * 处理链：软拐点压缩 → 自动补偿（补回平均压缩量）→ 真峰值限幅（复用 lufs.ts）。
 * 全程只改增益、不改波形，所以不会出现波形整形那类谐波与削波。
 *
 * 两点口径：
 * 1. 自动补偿只为了让单独试听时响度可比；如果之后又跑响度标准化，标准化会按
 *    实测 LUFS 重算增益，这份静态补偿在数学上会被抵消。
 * 2. 压缩是派生操作，全段处理、不支持选区，也绝不覆盖原始录音。
 */
import { measureTruePeakDb, renderLimited } from "./lufs";

export type CompressionPreset = "light" | "medium" | "strong";

interface CompressionParams {
  /** 压缩阈值（dBFS）。 */
  thresholdDb: number;
  /** 压缩比。 */
  ratio: number;
  /** 软拐点宽度（dB），阈值上下各占一半。 */
  kneeDb: number;
  /** 起音时间（ms）。 */
  attackMs: number;
  /** 释放时间（ms）。 */
  releaseMs: number;
}

export const COMPRESSION_PRESETS: Record<
  CompressionPreset,
  { label: string; params: CompressionParams }
> = {
  light: {
    label: "轻",
    params: {
      thresholdDb: -14,
      ratio: 1.5,
      kneeDb: 6,
      attackMs: 20,
      releaseMs: 250,
    },
  },
  medium: {
    label: "中",
    params: {
      thresholdDb: -18,
      ratio: 2,
      kneeDb: 6,
      attackMs: 15,
      releaseMs: 200,
    },
  },
  strong: {
    label: "强",
    params: {
      thresholdDb: -22,
      ratio: 3,
      kneeDb: 6,
      attackMs: 10,
      releaseMs: 150,
    },
  },
};

export const COMPRESSION_PRESET_LIST: CompressionPreset[] = [
  "light",
  "medium",
  "strong",
];

export interface CompressionResult {
  buffer: AudioBuffer;
  preset: CompressionPreset;
  /** 平均压缩量（dB，正数）：只有真正进入压缩区的采样参与统计。 */
  averageReductionDb: number;
  /** 自动补偿的静态增益（dB）。 */
  makeupDb: number;
  /** 补偿后为守住 ceiling 产生的最大限幅衰减（dB，≤0，与响度归一同一口径）。 */
  limiterGainReductionDb: number;
  /** 处理后真峰值（dBTP）。 */
  truePeakDb: number;
}

function toDb(value: number) {
  return value > 0 ? 20 * Math.log10(value) : Number.NEGATIVE_INFINITY;
}

/** 时间常数 → 一阶平滑系数（采样率相关）。 */
function smoothingCoefficient(sampleRate: number, timeMs: number) {
  const samples = Math.max(1, (timeMs / 1000) * sampleRate);
  return 1 - Math.exp(-1 / samples);
}

/** 软拐点静态曲线：返回该输入电平需要的增益（dB，≤0）。 */
function compressionGainDb(levelDb: number, params: CompressionParams): number {
  const slope = 1 - 1 / params.ratio;
  const over = levelDb - params.thresholdDb;
  const half = params.kneeDb / 2;
  if (over <= -half) return 0;
  if (over >= half) return -over * slope;
  // 拐点内用二次插值，与上下两段的端点导数衔接，避免折角带来听感突变。
  const x = over + half;
  return -(slope * x * x) / (2 * params.kneeDb);
}

/**
 * 压缩整段音频。ceilingDb 与响度标准化共用（WAV -1 dBTP / MP3 -1.5 dBTP），
 * 保证补偿后真峰值仍在交付上限以内。
 */
export function compressAudio(
  buffer: AudioBuffer,
  preset: CompressionPreset,
  ceilingDb: number,
): CompressionResult | null {
  if (buffer.length === 0) return null;
  const params = COMPRESSION_PRESETS[preset].params;
  const channelCount = buffer.numberOfChannels;
  const channels = Array.from({ length: channelCount }, (_, index) =>
    buffer.getChannelData(index),
  );
  const compressed = new AudioBuffer({
    length: buffer.length,
    numberOfChannels: channelCount,
    sampleRate: buffer.sampleRate,
  });
  const targets = Array.from({ length: channelCount }, (_, index) =>
    compressed.getChannelData(index),
  );

  const attack = smoothingCoefficient(buffer.sampleRate, params.attackMs);
  const release = smoothingCoefficient(buffer.sampleRate, params.releaseMs);
  const half = params.kneeDb / 2;
  // 单套增益作用于所有声道：分声道各算会破坏声像，立体声也容易相位打架。
  let envelope = 0;
  let reductionSum = 0;
  let reductionCount = 0;

  for (let i = 0; i < buffer.length; i++) {
    let peak = 0;
    for (let c = 0; c < channelCount; c++) {
      const magnitude = Math.abs(channels[c][i]);
      if (magnitude > peak) peak = magnitude;
    }
    envelope += (peak - envelope) * (peak > envelope ? attack : release);
    const levelDb = toDb(envelope);
    const over = levelDb - params.thresholdDb;
    const gainDb = compressionGainDb(levelDb, params);
    if (over > -half) {
      reductionSum += gainDb;
      reductionCount += 1;
    }
    const gain = 10 ** (gainDb / 20);
    for (let c = 0; c < channelCount; c++) {
      targets[c][i] = channels[c][i] * gain;
    }
  }

  const averageReductionDb =
    reductionCount > 0 ? -reductionSum / reductionCount : 0;
  const makeupDb = averageReductionDb;
  const rendered = renderLimited(
    compressed,
    10 ** (makeupDb / 20),
    10 ** (ceilingDb / 20),
  );
  return {
    buffer: rendered.buffer,
    preset,
    averageReductionDb,
    makeupDb,
    limiterGainReductionDb: rendered.gainReductionDb,
    truePeakDb: measureTruePeakDb(rendered.buffer),
  };
}