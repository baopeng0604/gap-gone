import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { writeFile } from "@tauri-apps/plugin-fs";
import { save } from "@tauri-apps/plugin-dialog";
import { bufferToWav } from "./exportUtils";
import { renderBuffer } from "./noiseReduction";

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

/** 字词级标注：贴在每行波形下方，按时间戳横向对齐。 */
export interface TranscriptWord {
  start: number;
  end: number;
  text: string;
}

export interface TranscriptResult {
  /** 句子级：转录面板与 SRT/TXT 导出。 */
  segments: TranscriptSegment[];
  /** 字词级：波形词带。 */
  words: TranscriptWord[];
}

export type TranscribeStage = "download" | "load" | "transcribe";

export interface TranscribeProgress {
  stage: TranscribeStage;
  /** 0-100；load 阶段为 -1（无法量化）。 */
  percent: number;
}

export interface TranscribeModelStatus {
  ready: boolean;
  modelDir: string;
  missing: string[];
}

export function isTauriDesktop() {
  return Boolean(
    (window as typeof window & { __TAURI_INTERNALS__?: unknown })
      .__TAURI_INTERNALS__,
  );
}

export function checkTranscribeModel(): Promise<TranscribeModelStatus> {
  return invoke<TranscribeModelStatus>("transcribe_model_status");
}

export function downloadTranscribeModel(): Promise<string> {
  return invoke<string>("download_transcribe_model");
}

export async function cancelTranscribe() {
  if (isTauriDesktop()) await invoke("cancel_transcribe");
}

export function onTranscribeProgress(
  callback: (progress: TranscribeProgress) => void,
): Promise<UnlistenFn> {
  return listen<TranscribeProgress>("transcribe-progress", (event) =>
    callback(event.payload),
  );
}

/**
 * 整段转录：重采样到 16 kHz 单声道 → 写临时 WAV → 原生命令识别。
 * 大文件走「临时文件 + 路径传参」，同降噪链路（见 AGENTS.md 硬约束 5）。
 */
export async function runTranscription(
  source: AudioBuffer,
): Promise<TranscriptResult> {
  const prepared = await renderBuffer(source, 1, 16000);
  const wav = bufferToWav(prepared);
  const inputPath = await invoke<string>("prepare_transcribe_file");
  await writeFile(inputPath, new Uint8Array(await wav.arrayBuffer()));
  try {
    return await invoke<TranscriptResult>("start_transcription", {
      inputPath,
    });
  } finally {
    void invoke("delete_recording_file", { path: inputPath }).catch(
      () => undefined,
    );
  }
}

function pad2(value: number) {
  return String(value).padStart(2, "0");
}

function formatSrtTime(seconds: number): string {
  const total = Math.max(0, seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = Math.floor(total % 60);
  const millis = Math.round((total % 1) * 1000);
  return `${pad2(hours)}:${pad2(minutes)}:${pad2(secs)},${String(millis).padStart(3, "0")}`;
}

export function buildSrt(segments: TranscriptSegment[]): string {
  return segments
    .map(
      (segment, index) =>
        `${index + 1}\n${formatSrtTime(segment.start)} --> ${formatSrtTime(segment.end)}\n${segment.text}`,
    )
    .join("\n\n");
}

export function buildTxt(segments: TranscriptSegment[]): string {
  // 纯文字稿：整段文本，不带时间戳（按句分行仅为了阅读分段）。
  // 带时间戳的逐段对照是 SRT 的职责。
  return segments.map((segment) => segment.text).join("\n");
}

/** 导出字幕/文字稿，系统保存对话框选位置。返回是否成功保存。 */
export async function exportTranscript(
  segments: TranscriptSegment[],
  kind: "srt" | "txt",
): Promise<boolean> {
  const content = kind === "srt" ? buildSrt(segments) : buildTxt(segments);
  const defaultName = `transcript.${kind}`;
  if (!isTauriDesktop()) {
    const url = URL.createObjectURL(new Blob([content], { type: "text/plain" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = defaultName;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
    return true;
  }
  const path = await save({
    defaultPath: defaultName,
    filters: [{ name: kind.toUpperCase(), extensions: [kind] }],
  });
  if (!path) return false;
  await writeFile(path, new TextEncoder().encode(content));
  return true;
}
