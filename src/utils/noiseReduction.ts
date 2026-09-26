import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { readFile, writeFile } from "@tauri-apps/plugin-fs";
import { analyseSource } from "./compression";
import { bufferToFloatWav } from "./exportUtils";
import type { Region } from "./regionUtils";

export type NoisePreset = "light" | "medium" | "strong";

export interface NoiseReductionResult {
  buffer: AudioBuffer;
  engine: "DeepFilterNet3" | "兼容性降噪";
  /** 回退到兼容性降噪的原因；引擎正常时为 undefined。界面必须把它显示出来。 */
  fallbackReason?: string;
}

function isTauriDesktop() {
  return Boolean(
    (window as typeof window & { __TAURI_INTERNALS__?: unknown })
      .__TAURI_INTERNALS__,
  );
}

export async function cancelDeepFilterProcessing() {
  if (isTauriDesktop()) await invoke("cancel_denoise");
}

function copyBufferRange(
  context: AudioContext,
  source: AudioBuffer,
  range: Region,
): AudioBuffer {
  const start = Math.max(0, Math.floor(range.start * source.sampleRate));
  const end = Math.min(source.length, Math.ceil(range.end * source.sampleRate));
  const result = context.createBuffer(
    source.numberOfChannels,
    Math.max(1, end - start),
    source.sampleRate,
  );
  for (let channel = 0; channel < source.numberOfChannels; channel++) {
    result.copyToChannel(
      source.getChannelData(channel).slice(start, end),
      channel,
    );
  }
  return result;
}

/**
 * 选区边界交叉淡化长度（秒）。降噪结果与原始在接缝处的电平/相位不连续，
 * 硬拼接会留下咔嗒声；10 ms 足够过渡又听不出。
 */
const REGION_FADE_SEC = 0.01;

function replaceBufferRange(
  context: AudioContext,
  source: AudioBuffer,
  processed: AudioBuffer,
  range: Region,
): AudioBuffer {
  const result = context.createBuffer(
    source.numberOfChannels,
    source.length,
    source.sampleRate,
  );
  const start = Math.max(0, Math.floor(range.start * source.sampleRate));
  for (let channel = 0; channel < source.numberOfChannels; channel++) {
    const data = source.getChannelData(channel).slice();
    const wet = processed.getChannelData(
      Math.min(channel, processed.numberOfChannels - 1),
    );
    // 重采样回原始采样率后长度可能差一两个采样，按两边都够的取。
    const count = Math.min(wet.length, Math.max(0, data.length - start));
    const fade = Math.min(
      Math.round(source.sampleRate * REGION_FADE_SEC),
      Math.floor(count / 2),
    );
    for (let i = 0; i < count; i++) {
      let weight = 1;
      if (fade > 0 && i < fade) weight = i / fade;
      else if (fade > 0 && i >= count - fade) weight = (count - i) / fade;
      const dry = data[start + i];
      data[start + i] = dry * (1 - weight) + wet[i] * weight;
    }
    result.copyToChannel(data, channel);
  }
  return result;
}

/**
 * 兼容性降噪：**仅在 DeepFilterNet 不可用时兜底，不是它的替代品**。
 *
 * 只做一件事：按整段块电平的低分位数估出底噪，把低于「底噪 + 余量」的部分按档位衰减，
 * 增益带起音/释放平滑。
 *
 * 旧实现有两个硬缺陷（0.1.57 修，正是「人声破音 + 强档更糟」的来源）：
 * ① 底噪取自**开头 250 ms**。口播通常一开口就是人声，于是估出来的「底噪」其实是语音
 *    电平，阈值被撑高、大量语音采样被误判为噪声 → 整段语音被压。强档（0.3 × 2.2 倍阈值）
 *    最严重，听感就是破音。
 * ② 逐采样直接换增益、没有任何平滑，在阈值上下反复开关会把波形切碎 —— 同样是破音。
 *    这里必须走平滑包络，**不要退回逐采样硬切换**。
 */
const COMPAT_PRESETS: Record<NoisePreset, { depthDb: number; marginDb: number }> = {
  light: { depthDb: 6, marginDb: 8 },
  medium: { depthDb: 10, marginDb: 6 },
  strong: { depthDb: 14, marginDb: 4 },
};

/** 兼容性降噪的时间常数（ms）：检测 10 ms，增益起音 5 ms、释放 80 ms。 */
const COMPAT_DETECTOR_MS = 10;
const COMPAT_ATTACK_MS = 5;
const COMPAT_RELEASE_MS = 80;
/** 从判定点到最大衰减的过渡宽度（dB）。 */
const COMPAT_SLOPE_DB = 10;

function compatibilityReduction(
  context: AudioContext,
  source: AudioBuffer,
  preset: NoisePreset,
): AudioBuffer {
  const result = context.createBuffer(
    source.numberOfChannels,
    source.length,
    source.sampleRate,
  );
  // 底噪取整段块电平的低分位数（与语音优化链同一套口径），不再取开头几百毫秒。
  const levels = analyseSource(source, [{ start: 0, end: source.duration }]);
  const thickness = COMPAT_PRESETS[preset];
  const thresholdDb = (levels?.noiseFloorDb ?? -60) + thickness.marginDb;
  const coefficient = (ms: number) =>
    1 - Math.exp(-1 / (source.sampleRate * (ms / 1000)));
  const detector = coefficient(COMPAT_DETECTOR_MS);
  const attack = coefficient(COMPAT_ATTACK_MS);
  const release = coefficient(COMPAT_RELEASE_MS);

  for (let channel = 0; channel < source.numberOfChannels; channel++) {
    const input = source.getChannelData(channel);
    const output = result.getChannelData(channel);
    let envelope = 0;
    let gainDb = 0;
    for (let i = 0; i < input.length; i++) {
      envelope += (input[i] * input[i] - envelope) * detector;
      // 夹一个有限下限，静音段才不会有 −∞ 参与运算
      const envDb = 20 * Math.log10(Math.max(Math.sqrt(envelope), 1e-6));
      const below = thresholdDb - envDb;
      const targetDb =
        below > 0
          ? -Math.min(
              thickness.depthDb,
              (below / COMPAT_SLOPE_DB) * thickness.depthDb,
            )
          : 0;
      gainDb += (targetDb - gainDb) * (targetDb > gainDb ? attack : release);
      output[i] = input[i] * 10 ** (gainDb / 20);
    }
  }
  return result;
}

/**
 * 读回 32-bit float WAV：降噪结果，以及 ffmpeg 从视频里抽出的音轨（video.rs 同样写 float）。
 *
 * 不走 `decodeAudioData`：格式是我们自己（或 ffmpeg）按约定写的，按 chunk 扫一遍就够了 ——
 * 省掉一次编解码往返，也不依赖 WebView 对 IEEE float WAV 的解码支持。
 * 按 chunk 扫描而不是写死偏移：hound 与 ffmpeg 写 float 时会用 40 字节的
 * WAVE_FORMAT_EXTENSIBLE，我们写的是 16 字节 PCMWAVEFORMAT，两种都要认。
 */
export function floatWavToBuffer(context: AudioContext, bytes: Uint8Array): AudioBuffer {
  const view = new DataView(
    bytes.buffer as ArrayBuffer,
    bytes.byteOffset,
    bytes.byteLength,
  );
  if (view.byteLength < 44) throw new Error("WAV 数据无效");
  if (
    view.getUint32(0, false) !== 0x52494646 || // "RIFF"
    view.getUint32(8, false) !== 0x57415645 // "WAVE"
  ) {
    throw new Error("WAV 数据无效");
  }
  let channels = 1;
  let sampleRate = 48000;
  let bits = 32;
  let dataOffset = -1;
  let dataLength = 0;
  let pos = 12;
  while (pos + 8 <= view.byteLength) {
    const id = view.getUint32(pos, false);
    const size = view.getUint32(pos + 4, true);
    const body = pos + 8;
    if (id === 0x666d7420) {
      // "fmt "：tag(2) ch(2) rate(4) byteRate(4) align(2) bits(2)
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bits = view.getUint16(body + 14, true);
    } else if (id === 0x64617461) {
      // "data"
      dataOffset = body;
      dataLength = Math.min(size, view.byteLength - body);
      break;
    }
    // chunk 按偶数字节对齐
    pos = body + size + (size & 1);
  }
  if (dataOffset < 0) throw new Error("WAV 缺少 data 块");
  if (bits !== 32) throw new Error(`WAV 位深应为 32 位，实际 ${bits} 位`);

  const frames = Math.floor(dataLength / 4 / Math.max(1, channels));
  if (frames <= 0) throw new Error("WAV 没有采样");
  const result = context.createBuffer(channels, frames, sampleRate);
  for (let c = 0; c < channels; c++) {
    const target = result.getChannelData(c);
    for (let i = 0; i < frames; i++) {
      target[i] = view.getFloat32(dataOffset + (i * channels + c) * 4, true);
    }
  }
  return result;
}

/**
 * 用 OfflineAudioContext 把音频重采样/ remix 到目标格式。
 * 格式已匹配时原样返回，不做无谓渲染。
 */
export async function renderBuffer(
  buffer: AudioBuffer,
  channels: number,
  sampleRate: number,
): Promise<AudioBuffer> {
  if (buffer.numberOfChannels === channels && buffer.sampleRate === sampleRate) {
    return buffer;
  }
  const length = Math.max(1, Math.ceil(buffer.duration * sampleRate));
  const offline = new OfflineAudioContext(channels, length, sampleRate);
  const sourceNode = offline.createBufferSource();
  sourceNode.buffer = buffer;
  sourceNode.connect(offline.destination);
  sourceNode.start();
  return offline.startRendering();
}

async function processWithDeepFilterNet(
  context: AudioContext,
  source: AudioBuffer,
  preset: NoisePreset,
): Promise<AudioBuffer> {
  // DeepFilterNet3 只接受 48 kHz 单声道：先离线重采样/下混，
  // 处理完再还原回原始格式。44.1 kHz 设备（Mac 上常见）不再静默降级。
  // 中间文件走 32-bit float WAV：素材电平偏低时 16-bit 会把底噪量化掉，
  // 而模型的抑制决策依赖对底噪的准确估计。
  const prepared = await renderBuffer(source, 1, 48000);
  const wav = bufferToFloatWav(prepared);
  // 大文件走「临时文件 + 路径传参」，Vec<u8> 经 JSON 序列化会卡死 IPC。
  const { inputPath, outputPath } = await invoke<{
    inputPath: string;
    outputPath: string;
  }>("prepare_denoise_files");
  await writeFile(inputPath, new Uint8Array(await wav.arrayBuffer()));
  try {
    await invoke("denoise_audio", { inputPath, outputPath, preset });
    const bytes = await readFile(outputPath);
    const denoised = floatWavToBuffer(context, bytes);
    // 还原回原始采样率与声道数，保证回填区间时长度对齐。
    return await renderBuffer(
      denoised,
      source.numberOfChannels,
      source.sampleRate,
    );
  } finally {
    void invoke("delete_recording_file", { path: inputPath }).catch(
      () => undefined,
    );
    void invoke("delete_recording_file", { path: outputPath }).catch(
      () => undefined,
    );
  }
}

export async function applyNoiseReduction(
  context: AudioContext,
  source: AudioBuffer,
  preset: NoisePreset,
  range?: Region,
  onProgress?: (progress: number) => void,
): Promise<NoiseReductionResult> {
  const target = range ? copyBufferRange(context, source, range) : source;
  let processed: AudioBuffer;
  let engine: NoiseReductionResult["engine"] = "兼容性降噪";
  let fallbackReason: string | undefined;

  // 采样率/声道不匹配时由 renderBuffer 在 DeepFilterNet 前后做转换，
  // 桌面端任何设备格式都优先走 DeepFilterNet3。
  if (isTauriDesktop()) {
    const unlisten = await listen<number>("denoise-progress", (event) =>
      onProgress?.(event.payload),
    );
    try {
      processed = await processWithDeepFilterNet(context, target, preset);
      engine = "DeepFilterNet3";
    } catch (cause) {
      if (String(cause).includes("取消")) throw cause;
      // **不要静默回退**：兜底算法的效果与 DeepFilterNet 差一个量级，
      // 用户必须知道实际用的是哪个引擎、以及为什么。原因一路带到界面。
      console.error("DeepFilterNet 降噪失败，回退到兼容性降噪", cause);
      fallbackReason = toReasonText(cause);
      processed = compatibilityReduction(context, target, preset);
    } finally {
      unlisten();
    }
  } else {
    processed = compatibilityReduction(context, target, preset);
    fallbackReason = "非桌面环境";
  }

  return {
    buffer: range
      ? replaceBufferRange(context, source, processed, range)
      : processed,
    engine,
    fallbackReason,
  };
}

/** 把 invoke 抛出的错误整理成一句能给用户看的话。 */
function toReasonText(cause: unknown): string {
  if (typeof cause === "string" && cause.trim()) return cause.trim();
  if (cause instanceof Error && cause.message) return cause.message;
  return "未知错误";
}
