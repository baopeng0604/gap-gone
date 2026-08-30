import { Region } from "./regionUtils";
import { save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import { getKeptRegions as getTimelineKeptRegions } from "./regionUtils";

export async function saveToDisk(blob: Blob, defaultName: string) {
  if (!isTauriDesktop()) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = defaultName;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
    return true;
  }

  const arrayBuffer = await blob.arrayBuffer();
  const uint8Array = new Uint8Array(arrayBuffer);
  const extension = defaultName.split(".").pop()?.toLowerCase() ?? "wav";

  try {
    const path = await save({
      defaultPath: defaultName,
      filters: [{ name: extension.toUpperCase(), extensions: [extension] }],
    });

    if (path) {
      await writeFile(path, uint8Array);
      return true;
    }
  } catch (err) {
    console.error("Tauri save failed:", err);
    throw err;
  }
  return false;
}

function isTauriDesktop() {
  return Boolean(
    (window as typeof window & { __TAURI_INTERNALS__?: unknown })
      .__TAURI_INTERNALS__,
  );
}

export function getKeptRegions(deletedRegions: Region[], totalDuration: number): Region[] {
  return getTimelineKeptRegions(deletedRegions, totalDuration);
}

/**
 * 按保留区间拼接出导出用 AudioBuffer（WAV / MP3 共用）。
 */
export function buildExportBuffer(
  buffer: AudioBuffer,
  deletedRegions: Region[]
): AudioBuffer {
  const keptRegions = getKeptRegions(deletedRegions, buffer.duration);
  if (keptRegions.length === 0) {
    throw new Error("不能导出空音频，请至少恢复一段内容");
  }
  const sampleRate = buffer.sampleRate;
  const numberOfChannels = buffer.numberOfChannels;

  // Calculate total duration in samples consistently
  let totalSamples = 0;
  for (const region of keptRegions) {
    const startSample = Math.floor(region.start * sampleRate);
    const endSample = Math.floor(region.end * sampleRate);
    totalSamples += (endSample - startSample);
  }

  // Create new buffer data
  const outputBuffer = new AudioBuffer({
    length: totalSamples,
    numberOfChannels: numberOfChannels,
    sampleRate: sampleRate,
  });

  for (let channel = 0; channel < numberOfChannels; channel++) {
    const outputData = outputBuffer.getChannelData(channel);
    const inputData = buffer.getChannelData(channel);
    let offset = 0;

    for (const region of keptRegions) {
      const startSample = Math.floor(region.start * sampleRate);
      const endSample = Math.floor(region.end * sampleRate);
      const length = endSample - startSample;

      if (startSample < inputData.length && length > 0) {
        const chunk = inputData.slice(
          startSample,
          Math.min(inputData.length, startSample + length),
        );
        const writableLength = Math.min(chunk.length, outputData.length - offset);
        if (writableLength > 0) {
          outputData.set(chunk.slice(0, writableLength), offset);
          offset += writableLength;
        }
      }
    }
  }

  return outputBuffer;
}

export function exportAudio(
  buffer: AudioBuffer,
  deletedRegions: Region[]
): Blob {
  return bufferToWav(buildExportBuffer(buffer, deletedRegions));
}

// Simple WAV encoder
export function bufferToWav(abuffer: AudioBuffer): Blob {
  const numOfChan = abuffer.numberOfChannels,
    length = abuffer.length * numOfChan * 2 + 44,
    buffer = new ArrayBuffer(length),
    view = new DataView(buffer),
    channels = [],
    sampleRate = abuffer.sampleRate;
  let offset = 0,
    pos = 0;

  // write WAVE header
  setUint32(0x46464952); // "RIFF"
  setUint32(length - 8); // file length - 8
  setUint32(0x45564157); // "WAVE"

  setUint32(0x20746d66); // "fmt " chunk
  setUint32(16); // length = 16
  setUint16(1); // PCM (uncompressed)
  setUint16(numOfChan);
  setUint32(sampleRate);
  setUint32(sampleRate * 2 * numOfChan); // avg. bytes/sec
  setUint16(numOfChan * 2); // block-align
  setUint16(16); // 16-bit (hardcoded in this simple converter)

  setUint32(0x61746164); // "data" - chunk
  setUint32(length - pos - 4); // chunk length

  // write interleaved data
  for (let i = 0; i < abuffer.numberOfChannels; i++)
    channels.push(abuffer.getChannelData(i));

  // 独立帧索引：pos 在写头部时已推进到 44，直接复用会跳过前 44 帧
  let frame = 0;
  while (frame < abuffer.length) {
    for (let i = 0; i < numOfChan; i++) {
      // interleave channels
      let sample = Math.max(-1, Math.min(1, channels[i][frame])); // clamp
      sample = sample < 0 ? sample * 32768 : sample * 32767; // scale to 16-bit
      view.setInt16(44 + offset, sample | 0, true);
      offset += 2;
    }
    frame++;
  }

  return new Blob([buffer], { type: "audio/wav" });

  function setUint16(data: any) {
    view.setUint16(pos, data, true);
    pos += 2;
  }

  function setUint32(data: any) {
    view.setUint32(pos, data, true);
    pos += 4;
  }
}
