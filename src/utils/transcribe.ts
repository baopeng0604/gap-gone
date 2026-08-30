import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { writeFile } from "@tauri-apps/plugin-fs";
import { save } from "@tauri-apps/plugin-dialog";
import { bufferToWav } from "./exportUtils";
import { renderBuffer } from "./noiseReduction";
import { SETTINGS_KEYS } from "./settings";

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
  /** 是否成功施加标点恢复（标点模型不可用时为 false）。 */
  punctuated: boolean;
}

export type TranscribeStage = "download" | "load" | "transcribe" | "punctuation";

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

/** 当前生效的模型目录（自定义优先，否则应用数据目录默认值）。 */
export function getTranscribeModelDir(): Promise<string> {
  return invoke<string>("get_transcribe_model_dir");
}

/** 设置自定义模型目录；传 null 恢复默认。 */
export function setTranscribeModelDir(path: string | null): Promise<void> {
  return invoke("set_transcribe_model_dir", { path });
}

/** 在系统文件管理器中打开模型目录。 */
export function openTranscribeModelDir(): Promise<void> {
  return invoke("open_transcribe_model_dir");
}

/** 自动转录开关（localStorage，默认开）。 */
export function getAutoTranscribe(): boolean {
  try {
    return localStorage.getItem(SETTINGS_KEYS.autoTranscribe) !== "0";
  } catch {
    return true;
  }
}

export function setAutoTranscribe(enabled: boolean) {
  try {
    localStorage.setItem(SETTINGS_KEYS.autoTranscribe, enabled ? "1" : "0");
  } catch {
    // localStorage 不可用时静默降级
  }
}

/** 自定义模型目录（localStorage 持久化，应用启动时同步到 Rust 侧）。 */
export function getCustomModelDir(): string | null {
  try {
    return localStorage.getItem(SETTINGS_KEYS.modelDir);
  } catch {
    return null;
  }
}

export function setCustomModelDir(path: string | null) {
  try {
    if (path && path.trim()) {
      localStorage.setItem(SETTINGS_KEYS.modelDir, path.trim());
    } else {
      localStorage.removeItem(SETTINGS_KEYS.modelDir);
    }
  } catch {
    // localStorage 不可用时静默降级
  }
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

/** 句末标点：软上限下遇到句号/问号/叹号即收段。 */
const SENTENCE_END = /[。！？!?…]$/;
/** 语音停顿达到该秒数视为话题边界，强制分段。 */
const PARAGRAPH_PAUSE_SECONDS = 1.5;
/** 段落软上限：达到后在下一个句末标点处分段。 */
const PARAGRAPH_SOFT_LIMIT = 120;
/** 段落硬上限：无标点也强制分段，避免一段无限长。 */
const PARAGRAPH_HARD_LIMIT = 200;

/** 单条字幕上限：时长（秒）与字符数（约两行 21 字）。 */
const SRT_MAX_CUE_SECS = 7;
const SRT_MAX_CUE_CHARS = 42;
/** 停顿超过该值不合并（话题边界）。 */
const SRT_MERGE_PAUSE_SECS = 0.6;

/**
 * 字幕分句：每个 segment 内部按句末标点拆成单句，
 * 时间戳按字符占比在 start/end 间线性插值（误差远小于字幕可读阈值）。
 * 标点恢复（0.1.10）之前 segment 靠时长兜底切分，一条里常挤着多个句子。
 */
function splitSegmentIntoSentences(segment: TranscriptSegment): TranscriptSegment[] {
  const text = segment.text.trim();
  if (!text) return [];
  const sentences: string[] = [];
  let current = "";
  for (const char of text) {
    current += char;
    if (/[。！？!?…]/.test(char)) {
      sentences.push(current);
      current = "";
    }
  }
  if (current.trim()) sentences.push(current);
  if (sentences.length <= 1) {
    return [{ ...segment, text }];
  }
  const duration = segment.end - segment.start;
  const totalChars = sentences.reduce((sum, s) => sum + s.length, 0);
  let cursor = segment.start;
  return sentences.map((sentence) => {
    const share = (sentence.length / totalChars) * duration;
    const piece = {
      start: cursor,
      end: cursor + share,
      text: sentence.trim(),
    };
    cursor += share;
    return piece;
  });
}

/**
 * 组装字幕条：碎句（过短）合并到前一条，超长不合并。
 * 返回最终的 segment 列表（时间轴连续）。
 */
function mergeShortCues(cues: TranscriptSegment[]): TranscriptSegment[] {
  const merged: TranscriptSegment[] = [];
  for (const cue of cues) {
    const previous = merged[merged.length - 1];
    const pause = previous ? cue.start - previous.end : Infinity;
    const joinedChars = previous ? previous.text.length + cue.text.length : 0;
    const joinedSecs = previous ? cue.end - previous.start : Infinity;
    if (
      previous &&
      pause <= SRT_MERGE_PAUSE_SECS &&
      joinedChars <= SRT_MAX_CUE_CHARS &&
      joinedSecs <= SRT_MAX_CUE_SECS
    ) {
      previous.text += cue.text;
      previous.end = cue.end;
    } else {
      merged.push({ ...cue });
    }
  }
  return merged;
}

export function buildSrt(segments: TranscriptSegment[]): string {
  // 分句分段：先按句末标点拆多句长条，再合并停顿极短的碎句，
  // 让每条字幕尽量是「一句完整的话」且时长/长度适合阅读。
  const cues = mergeShortCues(segments.flatMap(splitSegmentIntoSentences));
  return cues
    .map(
      (cue, index) =>
        `${index + 1}\n${formatSrtTime(cue.start)} --> ${formatSrtTime(cue.end)}\n${cue.text}`,
    )
    .join("\n\n");
}

export function buildTxt(segments: TranscriptSegment[]): string {
  // 纯文字稿（自动分句分段，不带时间戳）：
  // SenseVoice 的 segment 是短语音碎片，直接逐行输出会碎不成文。
  // 分段规则：① 相邻句间语音停顿 ≥ PARAGRAPH_PAUSE 秒视为话题边界；
  // ② 段落积累到软上限后，在句末标点处收段；③ 无标点时到硬上限强制收段。
  // 段内拼接：中文直接相连，英文词之间补空格。
  // 带时间戳的逐段对照是 SRT 的职责。
  const paragraphs: string[] = [];
  let current = "";

  const endParagraph = () => {
    const trimmed = current.trim();
    if (trimmed) paragraphs.push(trimmed);
    current = "";
  };

  segments.forEach((segment, index) => {
    const text = segment.text.trim();
    if (!text) return;
    const needsSpace =
      /[A-Za-z0-9,;:.]$/.test(current) && /^[A-Za-z0-9]/.test(text);
    current += (needsSpace ? " " : "") + text;

    const next = segments[index + 1];
    const pause = next ? next.start - segment.end : Infinity;
    if (
      pause >= PARAGRAPH_PAUSE_SECONDS ||
      current.length >= PARAGRAPH_HARD_LIMIT ||
      (current.length >= PARAGRAPH_SOFT_LIMIT && SENTENCE_END.test(text))
    ) {
      endParagraph();
    }
  });
  endParagraph();
  return paragraphs.join("\n\n");
}

/** 写文本到系统剪贴板，返回是否成功（含 execCommand 兜底）。 */
async function copyText(content: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(content);
    return true;
  } catch {
    // 剪贴板 API 不可用时的兜底（隐藏 textarea + execCommand）
    const textarea = document.createElement("textarea");
    textarea.value = content;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(textarea);
    return ok;
  }
}

/** 把纯文字稿（自动分段版）复制到系统剪贴板，返回是否成功。 */
export async function copyTranscriptText(
  segments: TranscriptSegment[],
): Promise<boolean> {
  return copyText(buildTxt(segments));
}

/** 把 SRT 字幕（分句优化版）复制到系统剪贴板，返回是否成功。 */
export async function copySrtText(
  segments: TranscriptSegment[],
): Promise<boolean> {
  return copyText(buildSrt(segments));
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
