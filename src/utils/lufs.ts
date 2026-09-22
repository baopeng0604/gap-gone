/**
 * ITU-R BS.1770-4 Integrated loudness（LUFS）。
 * 与 src-tauri/src/lufs.rs 同一套 K 计权 + 门限，录音实时值与成片读数才对得上。
 */
import { getKeptRegions, type Region } from "./regionUtils";

const BLOCK_SEC = 0.4;
const HOP_SEC = 0.1;
const ABSOLUTE_GATE = -70;
const RELATIVE_OFFSET = -10;
const LOUDNESS_OFFSET = -0.691;

export type LufsBand = "quiet" | "ok" | "loud";

/** 「达标」容差：与目标响度的偏差在此以内算达标。 */
export const LUFS_BAND_TOLERANCE_DB = 1.5;

/** 达标判定按用户设定的目标口径走，不再是写死的 -20 ~ -16。 */
export function lufsBand(lufs: number, targetLufs: number): LufsBand | null {
  if (!Number.isFinite(lufs)) return null;
  if (lufs < targetLufs - LUFS_BAND_TOLERANCE_DB) return "quiet";
  if (lufs > targetLufs + LUFS_BAND_TOLERANCE_DB) return "loud";
  return "ok";
}

export function lufsBandLabel(band: LufsBand): string {
  if (band === "quiet") return "偏弱";
  if (band === "loud") return "偏响";
  return "达标";
}

export function formatLufs(lufs: number): string {
  return Number.isFinite(lufs) ? `${lufs.toFixed(1)} LUFS` : "— LUFS";
}

class Biquad {
  z1 = 0;
  z2 = 0;
  constructor(
    private b0: number,
    private b1: number,
    private b2: number,
    private a1: number,
    private a2: number,
  ) {}

  process(x: number): number {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }
}

/** libebur128 同款：高频搁架 + RLB 高通（双线性变换，任意采样率）。 */
function kWeightFilters(sampleRate: number): [Biquad, Biquad] {
  const shelfDb = 3.999843853973347;
  const shelfF0 = 1681.974450955533;
  const shelfQ = 0.7071752369554196;
  const shelfK = Math.tan((Math.PI * shelfF0) / sampleRate);
  const vh = 10 ** (shelfDb / 20);
  const vb = vh ** 0.4996667741545416;
  let a0 = 1 + shelfK / shelfQ + shelfK * shelfK;
  const pre = new Biquad(
    (vh + (vb * shelfK) / shelfQ + shelfK * shelfK) / a0,
    (2 * (shelfK * shelfK - vh)) / a0,
    (vh - (vb * shelfK) / shelfQ + shelfK * shelfK) / a0,
    (2 * (shelfK * shelfK - 1)) / a0,
    (1 - shelfK / shelfQ + shelfK * shelfK) / a0,
  );

  const rlbF0 = 38.13547087613982;
  const rlbQ = 0.5003270373238773;
  const rlbK = Math.tan((Math.PI * rlbF0) / sampleRate);
  a0 = 1 + rlbK / rlbQ + rlbK * rlbK;
  const rlb = new Biquad(
    1 / a0,
    -2 / a0,
    1 / a0,
    (2 * (rlbK * rlbK - 1)) / a0,
    (1 - rlbK / rlbQ + rlbK * rlbK) / a0,
  );
  return [pre, rlb];
}

function loudnessFromMeanSquare(meanSquare: number): number {
  if (!(meanSquare > 0)) return Number.NEGATIVE_INFINITY;
  return LOUDNESS_OFFSET + 10 * Math.log10(meanSquare);
}

export class IntegratedLoudness {
  private readonly pre: Biquad[] = [];
  private readonly rlb: Biquad[] = [];
  private readonly hopLen: number;
  private readonly hopsPerBlock: number;
  private pending: number[][];
  private hopMeanSquares: number[] = [];
  private blockMeanSquares: number[] = [];

  constructor(sampleRate: number, channelCount: number) {
    const channels = Math.max(1, Math.min(2, channelCount));
    for (let i = 0; i < channels; i++) {
      const [pre, rlb] = kWeightFilters(sampleRate);
      this.pre.push(pre);
      this.rlb.push(rlb);
    }
    this.hopLen = Math.max(1, Math.round(sampleRate * HOP_SEC));
    this.hopsPerBlock = Math.max(1, Math.round(BLOCK_SEC / HOP_SEC));
    this.pending = Array.from({ length: channels }, () => []);
  }

  /** 追加交错或按声道分开的单声道块。 */
  pushMono(samples: ArrayLike<number>) {
    this.pushChannel(0, samples);
    this.flushHops();
  }

  pushChannel(channel: number, samples: ArrayLike<number>) {
    if (channel >= this.pending.length) return;
    const pending = this.pending[channel];
    const pre = this.pre[channel];
    const rlb = this.rlb[channel];
    for (let i = 0; i < samples.length; i++) {
      pending.push(rlb.process(pre.process(samples[i])));
    }
  }

  /** 多声道同一段：各声道等长。 */
  pushAligned(channels: ArrayLike<number>[]) {
    const count = Math.min(this.pending.length, channels.length);
    const length = channels[0]?.length ?? 0;
    for (let c = 0; c < count; c++) {
      const data = channels[c];
      const pre = this.pre[c];
      const rlb = this.rlb[c];
      const pending = this.pending[c];
      for (let i = 0; i < length; i++) {
        pending.push(rlb.process(pre.process(data[i] ?? 0)));
      }
    }
    this.flushHops();
  }

  private flushHops() {
    while (this.pending.every((channel) => channel.length >= this.hopLen)) {
      let meanSquare = 0;
      for (const channel of this.pending) {
        let sum = 0;
        for (let i = 0; i < this.hopLen; i++) {
          const sample = channel[i];
          sum += sample * sample;
        }
        meanSquare += sum / this.hopLen;
        channel.splice(0, this.hopLen);
      }
      this.hopMeanSquares.push(meanSquare);
      if (this.hopMeanSquares.length >= this.hopsPerBlock) {
        const start = this.hopMeanSquares.length - this.hopsPerBlock;
        let block = 0;
        for (let i = start; i < this.hopMeanSquares.length; i++) {
          block += this.hopMeanSquares[i];
        }
        this.blockMeanSquares.push(block / this.hopsPerBlock);
      }
    }
  }

  integrated(): number {
    if (this.blockMeanSquares.length === 0) return Number.NEGATIVE_INFINITY;
    const aboveAbsolute = this.blockMeanSquares.filter(
      (meanSquare) => loudnessFromMeanSquare(meanSquare) > ABSOLUTE_GATE,
    );
    if (aboveAbsolute.length === 0) return Number.NEGATIVE_INFINITY;
    const gatedMean =
      aboveAbsolute.reduce((sum, value) => sum + value, 0) / aboveAbsolute.length;
    const relative = loudnessFromMeanSquare(gatedMean) + RELATIVE_OFFSET;
    const aboveRelative = aboveAbsolute.filter(
      (meanSquare) => loudnessFromMeanSquare(meanSquare) > relative,
    );
    if (aboveRelative.length === 0) return Number.NEGATIVE_INFINITY;
    const finalMean =
      aboveRelative.reduce((sum, value) => sum + value, 0) / aboveRelative.length;
    return loudnessFromMeanSquare(finalMean);
  }
}

/** 成片 Integrated LUFS：按即将导出的保留区间拼接后计算，切除不计。 */
export function integratedLufsFromBuffer(
  buffer: AudioBuffer,
  deletedRegions: Region[] = [],
): number {
  const kept = getKeptRegions(deletedRegions, buffer.duration);
  if (kept.length === 0) return Number.NEGATIVE_INFINITY;
  const channelCount = Math.min(2, buffer.numberOfChannels);
  const meter = new IntegratedLoudness(buffer.sampleRate, channelCount);
  const channels = Array.from({ length: channelCount }, (_, index) =>
    buffer.getChannelData(index),
  );
  for (const region of kept) {
    const start = Math.max(0, Math.floor(region.start * buffer.sampleRate));
    const end = Math.min(
      buffer.length,
      Math.max(start, Math.floor(region.end * buffer.sampleRate)),
    );
    if (end <= start) continue;
    const slices = channels.map((channel) => channel.subarray(start, end));
    meter.pushAligned(slices);
  }
  return meter.integrated();
}

function toDb(value: number): number {
  return value > 0 ? 20 * Math.log10(value) : Number.NEGATIVE_INFINITY;
}

/*
 * 真峰值与时间域限幅。
 *
 * 旧实现用静态波形整形压峰（逐采样改写波形形状），有两个治不好的毛病：
 * 一是改波形必然产生谐波，听感发毛；二是过冲一大就压不回 ceiling 以内，
 * 最后仍靠导出时硬 clamp 兜底 —— 那才是真正削波的来源。
 *
 * 这里只改增益、不动波形：4 倍过采样重建真峰值 → 求该点所需衰减 →
 * 前瞻窗口取最小值（波峰到来之前增益就已经降下去）→ 释放端限速平滑 →
 * 乘到信号上。因此输出真峰值不会超过 ceiling。
 */

const OS_PHASES = 4;
const OS_HALF_TAPS = 4;

/** 每相插值系数：窗函数 sinc，按相归一化到单位增益（p = 0 退化为单位冲击）。 */
function buildOversampleTaps(): number[][] {
  const windowHalf = OS_PHASES * (OS_HALF_TAPS + 1) - 1;
  const taps: number[][] = [];
  for (let phase = 0; phase < OS_PHASES; phase++) {
    const row: number[] = [];
    let sum = 0;
    for (let d = -OS_HALF_TAPS; d <= OS_HALF_TAPS; d++) {
      const t = OS_PHASES * d + phase;
      const ratio = t / windowHalf;
      const window =
        0.42 +
        0.5 * Math.cos(Math.PI * ratio) +
        0.08 * Math.cos(2 * Math.PI * ratio);
      const sinc =
        t === 0
          ? 1
          : Math.sin((Math.PI * t) / OS_PHASES) / ((Math.PI * t) / OS_PHASES);
      const value = (sinc * window) / OS_PHASES;
      row.push(value);
      sum += value;
    }
    for (let i = 0; i < row.length; i++) row[i] /= sum;
    taps.push(row);
  }
  return taps;
}

const OS_TAPS = buildOversampleTaps();

/** 三角不等式上界系数：Σ|系数| 的最大值，用来保守跳过不可能逼近 ceiling 的样本。 */
const OS_L1_BOUND = OS_TAPS.reduce(
  (worst, row) =>
    Math.max(worst, row.reduce((sum, value) => sum + Math.abs(value), 0)),
  0,
);

const GATE_BLOCK = 64;

/** 分块样本峰值；前后各补一个 0 块，便于直接取邻域上界。 */
function blockPeaks(channels: Float32Array[]): Float32Array {
  const length = channels[0]?.length ?? 0;
  const peaks = new Float32Array(Math.ceil(length / GATE_BLOCK) + 2);
  for (const data of channels) {
    for (let i = 0; i < length; i++) {
      const magnitude = Math.abs(data[i]);
      const block = ((i / GATE_BLOCK) | 0) + 1;
      if (magnitude > peaks[block]) peaks[block] = magnitude;
    }
  }
  return peaks;
}

/** 保守的局部上界：任意样本 ±OS_HALF_TAPS 邻域的最大值都不会超过它。 */
function localUpperBound(peaks: Float32Array, index: number): number {
  const block = ((index / GATE_BLOCK) | 0) + 1;
  return Math.max(peaks[block - 1], peaks[block], peaks[block + 1]);
}

/** 4 倍过采样重建的单点真峰值（多声道取最大）。 */
function truePeakAt(channels: Float32Array[], index: number): number {
  let peak = 0;
  for (const data of channels) {
    for (const taps of OS_TAPS) {
      let acc = 0;
      for (let i = 0; i < taps.length; i++) {
        const at = index + OS_HALF_TAPS - i;
        if (at >= 0 && at < data.length) acc += data[at] * taps[i];
      }
      const magnitude = Math.abs(acc);
      if (magnitude > peak) peak = magnitude;
    }
  }
  return peak;
}

/**
 * 整段真峰值（dBTP）。p = 0 相是单位冲击，样本峰值本身就是可达的真峰值下界；
 * 再按三角不等式上界跳过绝大多数样本，只重建可能更高的点。
 */
export function measureTruePeakDb(buffer: AudioBuffer): number {
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, index) =>
    buffer.getChannelData(index),
  );
  const length = buffer.length;
  const peaks = blockPeaks(channels);
  let best = 0;
  for (const data of channels) {
    for (let i = 0; i < length; i++) {
      const magnitude = Math.abs(data[i]);
      if (magnitude > best) best = magnitude;
    }
  }
  for (let n = 0; n < length; n++) {
    if (OS_L1_BOUND * localUpperBound(peaks, n) <= best) continue;
    const exact = truePeakAt(channels, n);
    if (exact > best) best = exact;
  }
  return toDb(best);
}

const LIMITER_LOOKAHEAD_SEC = 0.005;
/** 增益释放速度 dB/s；只影响听感，不影响 ceiling 保证。 */
const LIMITER_RELEASE_DB_PER_SEC = 80;
const LIMITER_CHUNK_SAMPLES = 1 << 16;

/**
 * 静态增益 + 前瞻真峰值限幅：out[n] = in[n] · gainLinear · s[n]，
 * 且 s[n] 不超过前瞻窗口内各点所需的衰减，因此输出真峰值恒不超过 ceiling。
 */
function renderLimited(
  buffer: AudioBuffer,
  gainLinear: number,
  ceilingLinear: number,
): { buffer: AudioBuffer; gainReductionDb: number } {
  const length = buffer.length;
  const channelCount = buffer.numberOfChannels;
  const channels = Array.from({ length: channelCount }, (_, index) =>
    buffer.getChannelData(index),
  );
  const output = new AudioBuffer({
    length,
    numberOfChannels: channelCount,
    sampleRate: buffer.sampleRate,
  });
  const targets = Array.from({ length: channelCount }, (_, index) =>
    output.getChannelData(index),
  );
  const peaks = blockPeaks(channels);

  const lookahead = Math.max(
    1,
    Math.round(buffer.sampleRate * LIMITER_LOOKAHEAD_SEC),
  );
  const windowLength = lookahead + 1;
  const releaseStep =
    10 ** (LIMITER_RELEASE_DB_PER_SEC / (20 * buffer.sampleRate));
  const chunk = Math.min(LIMITER_CHUNK_SAMPLES, length);
  const size = chunk + windowLength;
  const required = new Float32Array(size);
  const prefixMin = new Float32Array(size);
  const suffixMin = new Float32Array(size);
  let released = 1;
  let gainReduction = 1;

  for (let start = 0; start < length; start += chunk) {
    const count = Math.min(chunk, length - start);
    // 1) 每点所需增益（1 = 不衰减）；局部上界够不到的样本跳过真峰值重建。
    for (let i = 0; i < size; i++) {
      const n = start + i;
      if (n >= length) {
        required[i] = 1;
        continue;
      }
      if (OS_L1_BOUND * gainLinear * localUpperBound(peaks, n) <= ceilingLinear) {
        required[i] = 1;
        continue;
      }
      const peak = truePeakAt(channels, n) * gainLinear;
      required[i] = peak > ceilingLinear ? ceilingLinear / peak : 1;
    }
    // 2) 前瞻窗口最小值：按窗口长度分块做前后缀最小值，O(n) 且无队列开销。
    for (let block = 0; block < size; block += windowLength) {
      const end = Math.min(size, block + windowLength);
      let running = Number.POSITIVE_INFINITY;
      for (let i = block; i < end; i++) {
        running = Math.min(running, required[i]);
        prefixMin[i] = running;
      }
      running = Number.POSITIVE_INFINITY;
      for (let i = end - 1; i >= block; i--) {
        running = Math.min(running, required[i]);
        suffixMin[i] = running;
      }
    }
    // 3) 释放端限速平滑，再乘回信号。
    for (let i = 0; i < count; i++) {
      const windowed = Math.min(suffixMin[i], prefixMin[i + windowLength - 1]);
      released = Math.min(windowed, Math.min(1, released * releaseStep));
      if (released < gainReduction) gainReduction = released;
      for (let c = 0; c < channelCount; c++) {
        targets[c][start + i] = channels[c][start + i] * gainLinear * released;
      }
    }
  }
  return { buffer: output, gainReductionDb: toDb(gainReduction) };
}

export interface LoudnessNormalizeOptions {
  /** 目标 Integrated LUFS。 */
  targetLufs: number;
  /** 真峰值上限（dBTP）。 */
  ceilingDb: number;
  /** 成片口径：切除区间不计入响度测量。 */
  deletedRegions?: Region[];
  toleranceDb?: number;
  maxPasses?: number;
}

export interface LoudnessNormalizeResult {
  buffer: AudioBuffer;
  beforeLufs: number;
  afterLufs: number;
  truePeakDb: number;
  /** 本次限幅的最大衰减量（dB，0 表示完全没压）。 */
  gainReductionDb: number;
  /** 本次施加的静态增益（dB）。 */
  gainDb: number;
  passes: number;
  converged: boolean;
}

const NORMALIZE_TOLERANCE_DB = 0.3;
const NORMALIZE_MAX_PASSES = 4;

/**
 * 一键响度标准化：静态增益 + 真峰值限幅，迭代收敛。
 * 限幅会拉低响度、ceiling 又要按实测真峰值收紧，两者互相影响，所以跑
 * 「渲染 → 重测 → 修正」最多 maxPasses 轮，直到响度进容差且真峰值不过线。
 */
export function normalizeLoudness(
  buffer: AudioBuffer,
  options: LoudnessNormalizeOptions,
): LoudnessNormalizeResult | null {
  const { targetLufs, ceilingDb, deletedRegions = [] } = options;
  const toleranceDb = options.toleranceDb ?? NORMALIZE_TOLERANCE_DB;
  const maxPasses = options.maxPasses ?? NORMALIZE_MAX_PASSES;
  const beforeLufs = integratedLufsFromBuffer(buffer, deletedRegions);
  if (!Number.isFinite(beforeLufs)) return null;

  let gainDb = targetLufs - beforeLufs;
  let ceiling = ceilingDb;
  let result: LoudnessNormalizeResult | null = null;

  for (let pass = 1; pass <= maxPasses; pass++) {
    const rendered = renderLimited(
      buffer,
      10 ** (gainDb / 20),
      10 ** (ceiling / 20),
    );
    const afterLufs = integratedLufsFromBuffer(rendered.buffer, deletedRegions);
    const truePeakDb = measureTruePeakDb(rendered.buffer);
    result = {
      buffer: rendered.buffer,
      beforeLufs,
      afterLufs,
      truePeakDb,
      gainReductionDb: rendered.gainReductionDb,
      gainDb,
      passes: pass,
      converged: false,
    };
    const loudnessDelta = targetLufs - afterLufs;
    if (!Number.isFinite(loudnessDelta)) break;
    const loudnessOk = Math.abs(loudnessDelta) <= toleranceDb;
    const peakOver = truePeakDb - ceiling;
    if (loudnessOk && peakOver <= 0.05) {
      result.converged = true;
      break;
    }
    if (!loudnessOk) gainDb += loudnessDelta;
    if (peakOver > 0.05) ceiling -= peakOver;
  }
  return result;
}
