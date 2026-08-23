import { Region } from "./regionUtils";

export interface SilenceDetectionOptions {
  threshold?: number; // 0 to 1, default 0.015
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

export function detectSilence(
  buffer: AudioBuffer,
  options: SilenceDetectionOptions = {}
): Region[] {
  const {
    threshold = 0.015, // Slightly stricter threshold
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
  const regions: Region[] = [];

  let isSilence = false;
  let silenceStart = 0;
  
  // Helper to get RMSE of a chunk
  const getRMSE = (startIdx: number, len: number) => {
    let sum = 0;
    for (let i = 0; i < len; i++) {
      const index = startIdx + i;
      if (index >= buffer.length) break;
      for (const channel of channels) {
        sum += channel[index] * channel[index];
      }
    }
    const sampleCount = Math.max(1, Math.min(len, buffer.length - startIdx));
    return Math.sqrt(sum / (sampleCount * channels.length));
  };

  for (let i = 0; i < buffer.length; i += chunkLength) {
    const chunkSize = Math.min(chunkLength, buffer.length - i);
    const rmse = getRMSE(i, chunkSize);

    if (rmse < threshold) {
      if (!isSilence) {
        isSilence = true;
        silenceStart = i / sampleRate;
      }
    } else if (isSilence) {
      const silenceEnd = i / sampleRate;
      if (silenceEnd - silenceStart >= minDuration) {
        regions.push({ start: silenceStart, end: silenceEnd });
      }
      isSilence = false;
    }
  }

  if (isSilence) {
    const silenceEnd = buffer.duration;
    if (silenceEnd - silenceStart >= minDuration) {
      regions.push({ start: silenceStart, end: silenceEnd });
    }
  }

  return regions
    .map((region) => ({
      start: Math.min(buffer.duration, region.start + leadingPadding),
      end: Math.max(0, region.end - trailingPadding),
    }))
    .filter((region) => region.end > region.start);
}
