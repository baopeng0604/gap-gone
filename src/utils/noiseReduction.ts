import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { readFile, writeFile } from "@tauri-apps/plugin-fs";
import { bufferToWav } from "./exportUtils";
import type { Region } from "./regionUtils";

export type NoisePreset = "light" | "medium" | "strong";

export interface NoiseReductionResult {
  buffer: AudioBuffer;
  engine: "DeepFilterNet3" | "兼容性降噪";
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
  for (let channel = 0; channel < source.numberOfChannels; channel++) {
    const data = source.getChannelData(channel).slice();
    const start = Math.max(0, Math.floor(range.start * source.sampleRate));
    data.set(
      processed
        .getChannelData(Math.min(channel, processed.numberOfChannels - 1))
        .slice(0, Math.min(processed.length, data.length - start)),
      start,
    );
    result.copyToChannel(data, channel);
  }
  return result;
}

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
  const profileLength = Math.min(
    source.length,
    Math.max(1, Math.floor(source.sampleRate * 0.25)),
  );
  const factors = { light: 0.78, medium: 0.54, strong: 0.3 };
  const factor = factors[preset];

  for (let channel = 0; channel < source.numberOfChannels; channel++) {
    const input = source.getChannelData(channel);
    let noiseRms = 0;
    for (let i = 0; i < profileLength; i++) noiseRms += input[i] ** 2;
    noiseRms = Math.sqrt(noiseRms / profileLength);
    const output = new Float32Array(input.length);
    for (let i = 0; i < input.length; i++) {
      const amplitude = Math.abs(input[i]);
      const reduction =
        amplitude < noiseRms * (preset === "strong" ? 2.2 : 1.45)
          ? factor
          : 1;
      output[i] = input[i] * reduction;
    }
    result.copyToChannel(output, channel);
  }
  return result;
}

/** fs 插件返回的 Uint8Array 转成独立 ArrayBuffer，供 decodeAudioData 使用。 */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
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
  const prepared = await renderBuffer(source, 1, 48000);
  const wav = bufferToWav(prepared);
  // 大文件走「临时文件 + 路径传参」，Vec<u8> 经 JSON 序列化会卡死 IPC。
  const { inputPath, outputPath } = await invoke<{
    inputPath: string;
    outputPath: string;
  }>("prepare_denoise_files");
  await writeFile(inputPath, new Uint8Array(await wav.arrayBuffer()));
  try {
    await invoke("denoise_audio", { inputPath, outputPath, preset });
    const bytes = await readFile(outputPath);
    const denoised = await context.decodeAudioData(toArrayBuffer(bytes));
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
      processed = compatibilityReduction(context, target, preset);
    } finally {
      unlisten();
    }
  } else {
    processed = compatibilityReduction(context, target, preset);
  }

  return {
    buffer: range
      ? replaceBufferRange(context, source, processed, range)
      : processed,
    engine,
  };
}
