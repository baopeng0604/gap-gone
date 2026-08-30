import { Mp3Encoder } from "@breezystack/lamejs";

/**
 * MP3 编码（@breezystack/lamejs，纯 JS，无 wasm，CSP 无需调整）。
 * 纯 JS 编码长音频需要数秒，按块分批让出主线程，避免界面冻结。
 */

const BLOCK_SIZE = 1152; // LAME 每块采样数
const BLOCKS_PER_YIELD = 100; // 每编码 100 块让出一次主线程

function floatToInt16(input: Float32Array): Int16Array {
  const output = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const sample = Math.max(-1, Math.min(1, input[i]));
    output[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return output;
}

/**
 * 把 AudioBuffer 编码为单声道 CBR MP3。
 * @param bitrate 码率 kbps（96 / 128 / 192）
 * @param onProgress 进度回调（0-1），可选
 */
export async function encodeMp3(
  buffer: AudioBuffer,
  bitrate: number,
  onProgress?: (ratio: number) => void,
): Promise<Blob> {
  // 多声道输入取第 0 声道（本项目录音链路本来就是 mono）
  const samples = floatToInt16(buffer.getChannelData(0));
  const encoder = new Mp3Encoder(1, buffer.sampleRate, bitrate);
  const chunks: Uint8Array[] = [];
  let blocksSinceYield = 0;

  for (let offset = 0; offset < samples.length; offset += BLOCK_SIZE) {
    const block = samples.subarray(offset, offset + BLOCK_SIZE);
    const encoded = encoder.encodeBuffer(block);
    if (encoded.length > 0) {
      chunks.push(new Uint8Array(encoded));
    }
    if (++blocksSinceYield >= BLOCKS_PER_YIELD) {
      blocksSinceYield = 0;
      onProgress?.(offset / samples.length);
      // 让出主线程，保持 UI 可响应
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  const flushed = encoder.flush();
  if (flushed.length > 0) {
    chunks.push(new Uint8Array(flushed));
  }
  onProgress?.(1);

  return new Blob(chunks as BlobPart[], { type: "audio/mpeg" });
}
