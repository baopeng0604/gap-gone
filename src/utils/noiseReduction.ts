import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
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

async function processWithDeepFilterNet(
  context: AudioContext,
  source: AudioBuffer,
  preset: NoisePreset,
): Promise<AudioBuffer> {
  const wav = bufferToWav(source);
  const bytes = await invoke<number[]>("denoise_audio", {
    wavBytes: Array.from(new Uint8Array(await wav.arrayBuffer())),
    preset,
  });
  return context.decodeAudioData(new Uint8Array(bytes).buffer);
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

  if (isTauriDesktop() && target.sampleRate === 48000 && target.numberOfChannels === 1) {
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
