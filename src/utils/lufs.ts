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

export function lufsBand(lufs: number): LufsBand | null {
  if (!Number.isFinite(lufs)) return null;
  if (lufs < -16) return "quiet";
  if (lufs > -12) return "loud";
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
