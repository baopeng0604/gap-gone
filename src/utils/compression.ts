/**
 * 语音优化链（VoiceChain）：按固定顺序把录音修得「悦耳、响度够」。
 *
 * 链路：高通 80 Hz → 向下扩展 → 软拐点压缩 →（末尾交响度标准化收尾）。
 * 前三步只改增益或做线性滤波，不做波形整形；真峰值限幅在整条链路里只出现一次，
 * 就在末尾的响度标准化里（lufs.ts renderLimited），压缩段不再自己限幅。
 *
 * 六点口径：
 * 1. **参数自适应，不预设阈值**。先量素材自身的动态跨度（P90 − P10），再由档位「目标跨度」
 *    反推阈值与压缩比。剔除气口的门限锚在**噪声底**上（`噪声底 + 14 dB`），不锚在中位数上 ——
 *    中位数会随压缩移动（见 analyseSource 的注释），锚在它上面会让跨度前后不可比。
 *    跨度本身是相对量：麦克风增益整体平移时 P10 / P90 同步平移、差值不变，所以增益拧大拧小
 *    都不影响判定 —— 固定阈值做不到这一点（0.1.45 及以前：增益一漂，要么压空、要么压不动）。
 *    换麦克风同理。
 * 2. **检测器用真 RMS 做一阶指数平滑**，不是峰值包络。语音的峰值比有效值高 8 ~ 12 dB，
 *    按峰值判触发会让阈值照着尖峰设，结果只有偶发尖峰被压、整段起伏纹丝不动
 *    （0.1.43 的三档 -14 / -18 / -22 就是这个病）。
 * 3. **扩展器阈值夹在「噪声底」与「语音 P10」之间，且至少低于 P10 3 dB**。压缩的阈值
 *    就是 P10，扩展器一旦啃进语音最轻段，压缩量出的 P10 就成了假值，跨度自适应会自我
 *    打架；反过来阈值高于噪声底等于没做。两个模块共用同一份统计（SourceLevels）。
 * 4. **不做自动补偿**。「按最深处补偿」已在 0.1.49 删除：它是静态抬全段、抬完由限幅器
 *    收拾，波形必然变成平顶香肠；而且流水线末尾的响度归一会按实测 LUFS 重算增益，把
 *    这份补偿在数学上抵消掉 —— 收益归零，限幅留下的增益包络却不可逆。「峰值没变小」
 *    改由「目标 LUFS + 限幅上限」共同保证，播报如实给最终真峰值与限幅衰减。
 * 5. **所有统计只算保留区间**（getKeptRegions），与 integratedLufsFromBuffer 同口径。
 *    早先统计含已切除区间，切掉一段响噪音会把 P90 撑大、压缩比高估，对成片压过头。
 * 6. 链路是派生操作，全段处理、不支持选区，也绝不覆盖原始录音。
 */
import { getKeptRegions, type Region } from "./regionUtils";
import { Biquad } from "./lufs";

export type CompressionPreset = "light" | "medium" | "strong";

/** 压缩参数：阈值与压缩比由素材跨度生成，不写死在档位表里。 */
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

/**
 * 档位只回答一个问题：想把素材动态压到多窄（目标跨度，dB）。
 * 起音/释放按档位走 —— 压得越重，动手越快、放手也越快。
 */
export const COMPRESSION_PRESETS: Record<
  CompressionPreset,
  { label: string; targetSpanDb: number; attackMs: number; releaseMs: number }
> = {
  light: { label: "轻", targetSpanDb: 8, attackMs: 20, releaseMs: 250 },
  medium: { label: "中", targetSpanDb: 5, attackMs: 15, releaseMs: 200 },
  strong: { label: "强", targetSpanDb: 3, attackMs: 10, releaseMs: 150 },
};

export const COMPRESSION_PRESET_LIST: CompressionPreset[] = [
  "light",
  "medium",
  "strong",
];

/** 高通截止频率（Hz）：口播人声有效下限在 80 Hz 以上，再往下只有隆隆声与近讲堆积。 */
export const HIGH_PASS_HZ = 80;

/**
 * 语音门限相对**噪声底**的余量（dB）：低于「噪声底 + 该值」的块算气口，不参与跨度统计。
 * 取 14 是给扩展器留余量 —— 扩展器阈值最多只敢抬到「噪声底 + 6 dB / 语音 P10 − 3 dB」，
 * 门限显著高于它，气口才不会又被算回语音侧。
 */
const SPEECH_GATE_MARGIN_DB = 14;
/** 软拐点宽度（dB），阈值上下各占一半。 */
const KNEE_DB = 6;
/** 压缩比上限：再往上压会明显听出抽气，宁可压不够也要如实播报。 */
const MAX_RATIO = 4;
/** 可压量不到该值（dB）就判定「本来就稳」，直接不动，不为 0.1 dB 白跑一遍处理。 */
const MIN_USEFUL_REDUCTION_DB = 1;
/** 兜底阈值相对成片有效电平的下移量（dB）与兜底压缩比。 */
const FALLBACK_THRESHOLD_OFFSET_DB = 3;
const FALLBACK_RATIO = 2;
/** 压缩器的 RMS 检测窗口（ms）。取音节量级，比它更短会把每个波峰都当成触发点。 */
const DETECTOR_WINDOW_MS = 30;
/** 电平统计的分块长度（秒）与绝对静音门槛（dBFS）。 */
const RMS_BLOCK_SEC = 0.1;
const RMS_SILENCE_FLOOR_DB = -60;
/** 块电平的数值下限（dB）：杜绝 -Infinity 进分位数插值，否则相邻两个 -∞ 会算出 NaN。 */
const BLOCK_FLOOR_DB = -120;
/** 噪声底读数上限（dB）：低过它就已经听不见，再低没有意义。 */
const NOISE_FLOOR_CLAMP_DB = -70;
/** 噪声底取块电平的哪个分位数：停顿与气口通常占一成以上。 */
const NOISE_FLOOR_PERCENTILE = 0.1;
/** 剔除气口后至少要有这么多块（2 秒）才敢按分布生成参数，否则走兜底。 */
const MIN_ACTIVE_BLOCKS = 20;

/** 扩展器的 RMS 检测窗口（ms）：要能跟上词头，比压缩器短得多。 */
const EXPANDER_DETECTOR_MS = 10;
/** 信号回到阈值之上时增益张开的时间常数（ms）：必须快，否则词头被吃掉。 */
const EXPANDER_OPEN_MS = 8;
/** 信号落到阈值之下时增益合拢的时间常数（ms）：慢一点，避免词尾与气口被切。 */
const EXPANDER_CLOSE_MS = 250;
/** 扩展比例：阈值之下每低 1 dB 就多衰减 (ratio − 1) dB。 */
const EXPANDER_RATIO = 2;
/** 最大衰减（dB）：把气口压死会听出不自然的抽吸，留 12 dB 收手。 */
const EXPANDER_RANGE_DB = 12;
/** 阈值相对噪声底的上移量（dB）：只压噪声性质的成分。 */
const EXPANDER_KNEE_DB = 6;
/** 阈值相对语音 P10 的下移量（dB）：至少低这么多，保证扩展器不啃到语音。 */
const EXPANDER_SPEECH_MARGIN_DB = 3;
/** 底噪比语音有效电平低这么多（dB）就算够干净：扩展器据此自动跳过。 */
const CLEAN_SNR_MARGIN_DB = 30;

function toDb(value: number) {
  return value > 0 ? 20 * Math.log10(value) : Number.NEGATIVE_INFINITY;
}

/** 取各声道绝对值的最大者：单套增益下这才是正确的「联动」检测量。 */
function linkedMagnitude(channels: Float32Array[], index: number) {
  let magnitude = 0;
  for (let c = 0; c < channels.length; c++) {
    const abs = Math.abs(channels[c][index]);
    if (abs > magnitude) magnitude = abs;
  }
  return magnitude;
}

/** 线性插值分位数，输入必须已升序。 */
function percentile(sorted: number[], fraction: number) {
  if (sorted.length === 0) return Number.NEGATIVE_INFINITY;
  const index = (sorted.length - 1) * fraction;
  const low = Math.floor(index);
  const high = Math.ceil(index);
  if (low === high) return sorted[low];
  return sorted[low] + (sorted[high] - sorted[low]) * (index - low);
}

/** 时间常数 → 一阶平滑系数（采样率相关）。 */
function smoothingCoefficient(sampleRate: number, timeMs: number) {
  const samples = Math.max(1, (timeMs / 1000) * sampleRate);
  return 1 - Math.exp(-1 / samples);
}

/** 二阶 Butterworth 高通（RBJ 双线性变换，任意采样率）。线性滤波，不产生谐波。 */
function designHighPass(sampleRate: number, cutoffHz: number): Biquad {
  const k = Math.tan((Math.PI * cutoffHz) / sampleRate);
  const norm = 1 / (1 + Math.SQRT2 * k + k * k);
  return new Biquad(
    norm,
    -2 * norm,
    norm,
    2 * (k * k - 1) * norm,
    (1 - Math.SQRT2 * k + k * k) * norm,
  );
}

/**
 * 素材电平统计，只算保留区间。扩展器与压缩器共用同一份，避免两个模块各量一套、
 * 阈值互相矛盾（见文件头第 3 点）。
 */
export interface SourceLevels {
  /** 成片有效电平（块电平中位数，dBFS）。 */
  rmsDb: number;
  /** 噪声底（P10 块电平，dBFS）。 */
  noiseFloorDb: number;
  /** P10 / P90 块电平（dBFS）。 */
  p10Db: number;
  p90Db: number;
  /** 输入跨度 = P90 − P10（dB）。 */
  spanDb: number;
  /** 剔除气口后参与统计的块数。 */
  blockCount: number;
}

/** 逐块短时 RMS，按保留区间拼接，返回全部块电平与「有效」块电平（均升序）。 */
function collectBlockLevels(
  buffer: AudioBuffer,
  regions: Region[],
): { allDb: number[]; audibleDb: number[] } {
  const channelCount = buffer.numberOfChannels;
  const channels = Array.from({ length: channelCount }, (_, index) =>
    buffer.getChannelData(index),
  );
  const blockSize = Math.max(1, Math.round(buffer.sampleRate * RMS_BLOCK_SEC));
  const audibleFloor = 10 ** (RMS_SILENCE_FLOOR_DB / 20);
  const allDb: number[] = [];
  const audibleDb: number[] = [];
  for (const region of regions) {
    const regionStart = Math.max(0, Math.floor(region.start * buffer.sampleRate));
    const regionEnd = Math.min(
      buffer.length,
      Math.max(regionStart, Math.floor(region.end * buffer.sampleRate)),
    );
    for (let start = regionStart; start < regionEnd; start += blockSize) {
      const end = Math.min(regionEnd, start + blockSize);
      let sum = 0;
      for (let i = start; i < end; i++) {
        const magnitude = linkedMagnitude(channels, i);
        sum += magnitude * magnitude;
      }
      const rms = Math.sqrt(sum / (end - start));
      const levelDb = Math.max(BLOCK_FLOOR_DB, toDb(rms));
      allDb.push(levelDb);
      if (rms >= audibleFloor) audibleDb.push(levelDb);
    }
  }
  allDb.sort((a, b) => a - b);
  audibleDb.sort((a, b) => a - b);
  return { allDb, audibleDb };
}

/**
 * 量素材的电平分布。剔除气口的门限**锚在噪声底上，不锚在中位数上**。
 *
 * 为什么不能锚中位数（0.1.60 修）：中位数会随压缩移动，而压缩正是本函数的调用方之一。
 * 用它当基准会让「压缩前」与「压缩后」测的不是同一批块 —— 压缩把语音压低十几 dB → 中位数
 * 下降 → 门限跟着下降 → 原本被剔掉的气口重新进入统计 → 实测跨度反而变大，播报里于是出现
 * 「跨度 19.2 dB → 24.5 dB」这种荒谬读数。噪声底是气口的电平，压缩在气口处的增益≈0，
 * 它不随压缩移动，拿它当基准前后才可比。
 *
 * 也没有写死绝对 dB：噪声底本身就是绝对量，麦克风增益整体平移时它同步平移、门限跟着平移，
 * 判定不变。
 *
 * 门限另外夹在「中位数」以下：素材里根本没有气口时（全程连续说话），块电平的 P10 不是噪声底
 * 而是最轻的语音，此时门限若高过中位数就会把一半动态当成噪声切掉。
 *
 * 没有任何有效块（整段都在绝对静音门限以下）时返回 null，调用方据此放弃处理。
 */
export function analyseSource(
  buffer: AudioBuffer,
  regions: Region[],
  anchorNoiseFloorDb?: number,
): SourceLevels | null {
  if (buffer.length === 0 || regions.length === 0) return null;
  const { allDb, audibleDb } = collectBlockLevels(buffer, regions);
  if (audibleDb.length === 0) return null;
  const rmsDb = percentile(audibleDb, 0.5);
  const noiseFloorDb = Math.max(
    percentile(allDb, NOISE_FLOOR_PERCENTILE),
    NOISE_FLOOR_CLAMP_DB,
  );
  // 量压缩输出时传入**输入**的噪声底：同一条门限，前后才是同一批块。
  const gateDb = Math.min(
    (anchorNoiseFloorDb ?? noiseFloorDb) + SPEECH_GATE_MARGIN_DB,
    rmsDb,
  );
  const activeDb = audibleDb.filter((level) => level >= gateDb);
  const p10Db = percentile(activeDb, 0.1);
  const p90Db = percentile(activeDb, 0.9);
  return {
    rmsDb,
    noiseFloorDb,
    p10Db,
    p90Db,
    spanDb: p90Db - p10Db,
    blockCount: activeDb.length,
  };
}

/** 量某段音频的动态跨度（dB）；有效块太少（短录音）返回 null。 */
export function measureSpanDb(
  buffer: AudioBuffer,
  regions: Region[],
  anchorNoiseFloorDb?: number,
): number | null {
  const levels = analyseSource(buffer, regions, anchorNoiseFloorDb);
  if (!levels || levels.blockCount < MIN_ACTIVE_BLOCKS) return null;
  return levels.spanDb;
}

/** 扩展器被跳过的原因（播报要用），null 表示确实做了扩展。 */
export type ExpanderSkipReason = "clean" | "no-headroom";

export interface ExpanderPlan {
  /** 是否真的做了扩展。 */
  applied: boolean;
  /** 跳过原因；applied 为 true 时为 null。 */
  skipReason: ExpanderSkipReason | null;
  /** 本段噪声底（dBFS）。 */
  noiseFloorDb: number;
  /** 本段语音有效电平（dBFS）。 */
  speechRmsDb: number;
  /** 实际生效的阈值（dBFS）；跳过时为 null。 */
  thresholdDb: number | null;
  /** 最大衰减（dB，正数）。 */
  rangeDb: number;
}

/**
 * 由素材统计决定要不要做向下扩展、阈值定在哪里。
 * 两条自动跳过规则见常量注释：信噪比已经够好（clean）、阈值夹不进噪声底与语音之间
 * （no-headroom）时宁可不动 —— 扩展器做错比不做更糟。
 */
export function planExpander(levels: SourceLevels): ExpanderPlan {
  const base = {
    noiseFloorDb: levels.noiseFloorDb,
    speechRmsDb: levels.rmsDb,
    thresholdDb: null,
    rangeDb: 0,
  } as const;
  if (levels.rmsDb - levels.noiseFloorDb >= CLEAN_SNR_MARGIN_DB) {
    return { ...base, applied: false, skipReason: "clean" };
  }
  if (levels.p10Db - levels.noiseFloorDb <= EXPANDER_KNEE_DB + EXPANDER_SPEECH_MARGIN_DB) {
    return { ...base, applied: false, skipReason: "no-headroom" };
  }
  const thresholdDb = Math.min(
    levels.noiseFloorDb + EXPANDER_KNEE_DB,
    levels.p10Db - EXPANDER_SPEECH_MARGIN_DB,
  );
  return {
    ...base,
    applied: true,
    skipReason: null,
    thresholdDb,
    rangeDb: EXPANDER_RANGE_DB,
  };
}

/**
 * 执行向下扩展：阈值之下的成分按比例衰减，最多 rangeDb。
 * 增益曲线在最深处起手（0 dB）再合拢，保证任何情况下都不凭空衰减内容。
 */
function applyExpander(buffer: AudioBuffer, plan: ExpanderPlan): AudioBuffer {
  const thresholdDb = plan.thresholdDb ?? 0;
  const channelCount = buffer.numberOfChannels;
  const channels = Array.from({ length: channelCount }, (_, index) =>
    buffer.getChannelData(index),
  );
  const output = new AudioBuffer({
    length: buffer.length,
    numberOfChannels: channelCount,
    sampleRate: buffer.sampleRate,
  });
  const targets = Array.from({ length: channelCount }, (_, index) =>
    output.getChannelData(index),
  );
  const detector = smoothingCoefficient(buffer.sampleRate, EXPANDER_DETECTOR_MS);
  const open = smoothingCoefficient(buffer.sampleRate, EXPANDER_OPEN_MS);
  const close = smoothingCoefficient(buffer.sampleRate, EXPANDER_CLOSE_MS);
  const slope = EXPANDER_RATIO - 1;
  let meanSquare = 0;
  let gainDb = 0;

  for (let i = 0; i < buffer.length; i++) {
    const magnitude = linkedMagnitude(channels, i);
    // 真 RMS 检测：平方做一阶平滑再开方，跟的是有效值而不是尖峰。
    meanSquare += (magnitude * magnitude - meanSquare) * detector;
    const over = toDb(Math.sqrt(meanSquare)) - thresholdDb;
    const targetDb = over >= 0 ? 0 : Math.max(-plan.rangeDb, over * slope);
    gainDb += (targetDb - gainDb) * (targetDb > gainDb ? open : close);
    const gain = 10 ** (gainDb / 20);
    for (let c = 0; c < channelCount; c++) {
      targets[c][i] = channels[c][i] * gain;
    }
  }
  return output;
}

/** 高通：削掉隆隆声、桌面震动与近讲低频堆积。全段连续跑，保留区间边界的滤波器状态自然衔接。 */
function applyHighPass(buffer: AudioBuffer, cutoffHz: number): AudioBuffer {
  const channelCount = buffer.numberOfChannels;
  const output = new AudioBuffer({
    length: buffer.length,
    numberOfChannels: channelCount,
    sampleRate: buffer.sampleRate,
  });
  for (let c = 0; c < channelCount; c++) {
    const source = buffer.getChannelData(c);
    const target = output.getChannelData(c);
    const filter = designHighPass(buffer.sampleRate, cutoffHz);
    for (let i = 0; i < buffer.length; i++) {
      target[i] = filter.process(source[i]);
    }
  }
  return output;
}

/** 压缩执行计划：参数 + 生成依据（播报要用）。 */
export interface CompressionPlan {
  params: CompressionParams;
  /** 压缩前素材的成片有效电平（dBFS）。 */
  sourceRmsDb: number;
  /** 实测输入跨度（dB）；走兜底时为 null。 */
  sourceSpanDb: number | null;
  /** 该档的目标跨度（dB）。 */
  targetSpanDb: number;
  /** 是否已达压缩比上限：此时实际压不到目标跨度。 */
  capped: boolean;
  /** 是否走了短素材兜底参数。 */
  fallback: boolean;
  /** 素材本来就稳：调用方应直接跳过，不改动音频。 */
  skipped: boolean;
}

export interface CompressionResult extends CompressionPlan {
  buffer: AudioBuffer;
  preset: CompressionPreset;
  /** 平均压缩量（dB，正数）：只有真正进入压缩区的采样参与统计。 */
  averageReductionDb: number;
  /** 压缩后实测的输出跨度（dB）；有效块太少时为 null。 */
  outputSpanDb: number | null;
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
 * 由素材跨度反推参数：
 * - 阈值取在 P10 附近（配 6 dB 软拐点），让最低的有效段基本不动，只压大的。
 * - 压缩比 ≈ 输入跨度 ÷ 目标跨度：阈值之上的动态按 1/ratio 收缩，P90 才会落到
 *   「阈值 + 目标跨度」，整段跨度正好收到目标宽度。
 * - 压缩比封顶 4:1，封顶后如实标记 capped，由播报说明压不到目标。
 */
export function planCompression(
  levels: SourceLevels,
  preset: CompressionPreset,
): CompressionPlan {
  const meta = COMPRESSION_PRESETS[preset];
  const base = {
    kneeDb: KNEE_DB,
    attackMs: meta.attackMs,
    releaseMs: meta.releaseMs,
  };
  if (levels.blockCount < MIN_ACTIVE_BLOCKS) {
    // 素材太短（或有效块太少）：退回「有效电平 − 3 dB、2:1」的保守兜底。
    return {
      params: {
        ...base,
        thresholdDb: levels.rmsDb - FALLBACK_THRESHOLD_OFFSET_DB,
        ratio: FALLBACK_RATIO,
      },
      sourceRmsDb: levels.rmsDb,
      sourceSpanDb: null,
      targetSpanDb: meta.targetSpanDb,
      capped: false,
      fallback: true,
      skipped: false,
    };
  }
  const rawRatio = levels.spanDb / meta.targetSpanDb;
  return {
    params: {
      ...base,
      thresholdDb: levels.p10Db,
      ratio: Math.min(MAX_RATIO, Math.max(1, rawRatio)),
    },
    sourceRmsDb: levels.rmsDb,
    sourceSpanDb: levels.spanDb,
    targetSpanDb: meta.targetSpanDb,
    capped: rawRatio > MAX_RATIO,
    fallback: false,
    skipped: levels.spanDb - meta.targetSpanDb < MIN_USEFUL_REDUCTION_DB,
  };
}

/**
 * 压缩整段音频，只输出「改过增益、未经限幅」的结果 —— 峰值交给末尾的响度标准化收口。
 * 素材本来就稳（plan.skipped）时原样返回输入缓冲，调用方据此跳过状态变更。
 */
function applyCompression(
  buffer: AudioBuffer,
  levels: SourceLevels,
  preset: CompressionPreset,
  regions: Region[],
): CompressionResult {
  const plan = planCompression(levels, preset);
  if (plan.skipped) {
    return {
      ...plan,
      buffer,
      preset,
      averageReductionDb: 0,
      outputSpanDb: levels.spanDb,
    };
  }
  const { params } = plan;
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

  const detector = smoothingCoefficient(buffer.sampleRate, DETECTOR_WINDOW_MS);
  const attack = smoothingCoefficient(buffer.sampleRate, params.attackMs);
  const release = smoothingCoefficient(buffer.sampleRate, params.releaseMs);
  const half = params.kneeDb / 2;
  // 单套增益作用于所有声道：分声道各算会破坏声像，立体声也容易相位打架。
  let meanSquare = 0;
  let smoothedGainDb = 0;
  let reductionSum = 0;
  let reductionCount = 0;

  for (let i = 0; i < buffer.length; i++) {
    const magnitude = linkedMagnitude(channels, i);
    // 真 RMS 检测：先对平方做一阶平滑，再开方回幅度，得到的是有效值而不是尖峰。
    meanSquare += (magnitude * magnitude - meanSquare) * detector;
    const levelDb = toDb(Math.sqrt(meanSquare));
    const targetGainDb = compressionGainDb(levelDb, params);
    // 增益平滑：压下去要快（起音），放回来要慢（释放），否则会抽气。
    smoothedGainDb +=
      (targetGainDb - smoothedGainDb) *
      (targetGainDb < smoothedGainDb ? attack : release);
    if (levelDb - params.thresholdDb > -half) {
      reductionSum += smoothedGainDb;
      reductionCount += 1;
    }
    const gain = 10 ** (smoothedGainDb / 20);
    for (let c = 0; c < channelCount; c++) {
      targets[c][i] = channels[c][i] * gain;
    }
  }

  return {
    ...plan,
    buffer: compressed,
    preset,
    averageReductionDb:
      reductionCount > 0 ? -reductionSum / reductionCount : 0,
    // 用**输入**的噪声底当锚：输出自身的噪声底会被扩展器改掉，拿它当锚又会前后不可比。
    outputSpanDb: measureSpanDb(compressed, regions, levels.noiseFloorDb),
  };
}

/** 语音优化链的执行结果。 */
export interface ChainResult {
  /** 链路输出（只改增益与线性滤波，未经限幅），交给响度标准化收尾。 */
  buffer: AudioBuffer;
  /** 高通截止频率（Hz）。 */
  highPassHz: number;
  expander: ExpanderPlan;
  compression: CompressionResult;
}

/**
 * 跑完整条语音优化链。所有统计只算保留区间；增益与滤波作用于完整缓冲，
 * 这样处理结果与 EditTimeline 无关，用户之后改切除区间不需要重跑。
 *
 * 整段没有可测内容时返回 null，调用方据此提示。
 */
export function runVoiceChain(
  buffer: AudioBuffer,
  preset: CompressionPreset,
  deletedRegions: Region[] = [],
): ChainResult | null {
  if (buffer.length === 0) return null;
  const regions = getKeptRegions(deletedRegions, buffer.duration);
  if (regions.length === 0) return null;
  const highPassed = applyHighPass(buffer, HIGH_PASS_HZ);
  const levels = analyseSource(highPassed, regions);
  if (!levels) return null;
  const expander = planExpander(levels);
  const expanded = expander.applied ? applyExpander(highPassed, expander) : highPassed;
  return {
    buffer: expanded,
    highPassHz: HIGH_PASS_HZ,
    expander,
    compression: applyCompression(expanded, levels, preset, regions),
  };
}
