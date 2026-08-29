//! SenseVoice 语音转录：模型下载 + 离线识别。
//!
//! 架构与降噪一致：识别器（含大模型）常驻 gap-gone-transcribe 工作线程，
//! 命令只投递任务；模型文件按需下载到应用数据目录，支持用户手动放置。
//! 大文件走「临时 WAV + 路径传参」，见 AGENTS.md 硬约束。

use std::{
    fs,
    io::{Read, Write},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc,
    },
};

use serde::Serialize;
use sherpa_onnx::{OfflineRecognizer, OfflineRecognizerConfig, OfflineSenseVoiceModelConfig};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_opener::OpenerExt;

use crate::{validate_temp_recording_path, RecordingManager};

/// 模型版本：sherpa-onnx 官方维护者发布的 SenseVoice-Small 多语言 int8。
/// 主站 HuggingFace，国内镜像 hf-mirror.com，两边文件一致。
const MODEL_REPO: &str = "csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09";
const MODEL_URLS: [&str; 2] = [
    "https://huggingface.co/{repo}/resolve/main",
    "https://hf-mirror.com/{repo}/resolve/main",
];
const MODEL_ONNX: &str = "model.int8.onnx";
const TOKENS_TXT: &str = "tokens.txt";

/// 分块目标时长（秒）。整段一次性 decode 无法给进度也无法取消，
/// 按 ~60s 在低能量点切块，块间检查取消标记并汇报进度。
const CHUNK_TARGET_SECS: usize = 60;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscribeModelStatus {
    pub ready: bool,
    pub model_dir: String,
    pub missing: Vec<String>,
}

#[derive(Clone, Serialize)]
pub struct TranscribeProgress {
    /// "download" | "load" | "transcribe"
    pub stage: String,
    /// 0-100；load 阶段无法量化，固定发 -1。
    pub percent: f32,
}

#[derive(Clone, Serialize)]
pub struct TranscriptSegment {
    pub start: f32,
    pub end: f32,
    pub text: String,
}

/// 字词级标注：贴在每行波形下方，按时间戳横向对齐。
#[derive(Clone, Serialize)]
pub struct TranscriptWord {
    pub start: f32,
    pub end: f32,
    pub text: String,
}

#[derive(Clone, Serialize)]
pub struct TranscriptResult {
    /// 句子级，供转录面板与 SRT/TXT 导出。
    pub segments: Vec<TranscriptSegment>,
    /// 字词级，供波形词带。
    pub words: Vec<TranscriptWord>,
}

pub struct TranscribeJob {
    pub input_path: PathBuf,
    pub model_dir: PathBuf,
    pub app: AppHandle,
    pub cancelled: Arc<AtomicBool>,
    pub respond: mpsc::Sender<Result<TranscriptResult, String>>,
}

/// 模型目录：用户自定义优先（RecordingManager.transcribe_model_dir），
/// 默认应用数据目录 models/sense-voice。
fn model_dir(app: &AppHandle, state: &State<'_, RecordingManager>) -> Result<PathBuf, String> {
    if let Some(custom) = state
        .transcribe_model_dir
        .lock()
        .map_err(|_| "模型路径状态不可用".to_string())?
        .clone()
    {
        return Ok(custom);
    }
    app.path()
        .app_data_dir()
        .map(|dir| dir.join("models").join("sense-voice"))
        .map_err(|error| format!("无法定位应用数据目录: {error}"))
}

/// 当前生效的模型目录（自定义或默认）。
#[tauri::command]
pub fn get_transcribe_model_dir(
    app: AppHandle,
    state: State<'_, RecordingManager>,
) -> Result<String, String> {
    model_dir(&app, &state).map(|dir| dir.to_string_lossy().to_string())
}

/// 设置自定义模型目录；传 None 恢复默认。
#[tauri::command]
pub fn set_transcribe_model_dir(
    state: State<'_, RecordingManager>,
    path: Option<String>,
) -> Result<(), String> {
    let mut guard = state
        .transcribe_model_dir
        .lock()
        .map_err(|_| "模型路径状态不可用".to_string())?;
    *guard = path.filter(|p| !p.trim().is_empty()).map(PathBuf::from);
    Ok(())
}

/// 在系统文件管理器中打开模型目录（不存在则先创建）。
#[tauri::command]
pub fn open_transcribe_model_dir(
    app: AppHandle,
    state: State<'_, RecordingManager>,
) -> Result<(), String> {
    let dir = model_dir(&app, &state)?;
    fs::create_dir_all(&dir).map_err(|error| format!("无法创建模型目录: {error}"))?;
    app.opener()
        .open_path(dir.to_string_lossy().to_string(), None::<&str>)
        .map_err(|error| format!("无法打开模型目录: {error}"))
}

fn emit_progress(app: &AppHandle, stage: &str, percent: f32) {
    let _ = app.emit(
        "transcribe-progress",
        TranscribeProgress {
            stage: stage.to_string(),
            percent,
        },
    );
}

#[tauri::command]
pub fn transcribe_model_status(
    app: AppHandle,
    state: State<'_, RecordingManager>,
) -> Result<TranscribeModelStatus, String> {
    let dir = model_dir(&app, &state)?;
    let missing = [MODEL_ONNX, TOKENS_TXT]
        .iter()
        .filter(|name| !dir.join(name).is_file())
        .map(|name| name.to_string())
        .collect::<Vec<_>>();
    Ok(TranscribeModelStatus {
        ready: missing.is_empty(),
        model_dir: dir.to_string_lossy().to_string(),
        missing,
    })
}

/// 下载单个模型文件：优先主站，失败回退镜像；先写 .partial 再改名，
/// 避免中途取消/断网留下半个文件被误判为 ready。
fn download_file(
    app: &AppHandle,
    dir: &PathBuf,
    name: &str,
    cancelled: &AtomicBool,
    progress_base: f32,
    progress_span: f32,
) -> Result<(), String> {
    let target = dir.join(name);
    if target.is_file() {
        return Ok(());
    }
    let partial = dir.join(format!("{name}.partial"));
    let mut last_error = String::new();
    for base in MODEL_URLS {
        let url = format!("{}/{name}", base.replace("{repo}", MODEL_REPO));
        let response = match ureq::get(&url).call() {
            Ok(response) => response,
            Err(error) => {
                last_error = format!("{error}");
                continue;
            }
        };
        let total = response
            .header("content-length")
            .and_then(|value| value.parse::<u64>().ok());
        let mut reader = response.into_reader();
        let mut file = match fs::File::create(&partial) {
            Ok(file) => file,
            Err(error) => return Err(format!("无法创建模型文件: {error}")),
        };
        let mut buffer = vec![0u8; 512 * 1024];
        let mut downloaded = 0u64;
        let mut failed: Option<String> = None;
        loop {
            if cancelled.load(Ordering::Relaxed) {
                failed = Some("下载已取消".to_string());
                break;
            }
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(count) => {
                    if let Err(error) = file.write_all(&buffer[..count]) {
                        failed = Some(format!("写入模型文件失败: {error}"));
                        break;
                    }
                    downloaded += count as u64;
                    if let Some(total) = total {
                        let fraction = downloaded as f32 / total as f32;
                        emit_progress(
                            app,
                            "download",
                            progress_base + fraction * progress_span,
                        );
                    }
                }
                Err(error) => {
                    failed = Some(format!("下载中断: {error}"));
                    break;
                }
            }
        }
        drop(file);
        if let Some(error) = failed {
            let _ = fs::remove_file(&partial);
            // 用户取消不再尝试镜像，直接返回。
            if error == "下载已取消" {
                return Err(error);
            }
            last_error = error;
            continue;
        }
        fs::rename(&partial, &target).map_err(|error| format!("无法保存模型文件: {error}"))?;
        return Ok(());
    }
    Err(format!("模型下载失败（已尝试全部镜像）: {last_error}"))
}

#[tauri::command]
pub fn download_transcribe_model(
    app: AppHandle,
    state: State<'_, RecordingManager>,
) -> Result<String, String> {
    state.transcribe_cancelled.store(false, Ordering::Relaxed);
    let dir = model_dir(&app, &state)?;
    fs::create_dir_all(&dir).map_err(|error| format!("无法创建模型目录: {error}"))?;
    // tokens.txt 只有几百 KB，给它 1% 进度区间；大头是 229MB 的 onnx。
    download_file(
        &app,
        &dir,
        TOKENS_TXT,
        &state.transcribe_cancelled,
        0.0,
        1.0,
    )?;
    download_file(
        &app,
        &dir,
        MODEL_ONNX,
        &state.transcribe_cancelled,
        1.0,
        99.0,
    )?;
    Ok(dir.to_string_lossy().to_string())
}

/// 生成转录输入的临时 WAV 路径（gap-gone- 前缀 + temp 目录，
/// 过 validate_temp_recording_path 校验）。
#[tauri::command]
pub fn prepare_transcribe_file() -> String {
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    std::env::temp_dir()
        .join(format!("gap-gone-transcribe-{timestamp}.wav"))
        .to_string_lossy()
        .to_string()
}

#[tauri::command]
pub fn cancel_transcribe(state: State<'_, RecordingManager>) {
    state.transcribe_cancelled.store(true, Ordering::Relaxed);
}

#[tauri::command]
pub fn start_transcription(
    app: AppHandle,
    state: State<'_, RecordingManager>,
    input_path: String,
) -> Result<TranscriptResult, String> {
    state.transcribe_cancelled.store(false, Ordering::Relaxed);
    let input_path = validate_temp_recording_path(&input_path)?;
    let dir = model_dir(&app, &state)?;
    if !dir.join(MODEL_ONNX).is_file() || !dir.join(TOKENS_TXT).is_file() {
        return Err("转录模型尚未下载".to_string());
    }

    // 识别器常驻工作线程，模型只加载一次；命令线程阻塞等结果。
    let tx = {
        let mut guard = state
            .transcribe_tx
            .lock()
            .map_err(|_| "转录状态不可用".to_string())?;
        if guard.is_none() {
            let (tx, rx) = mpsc::channel::<TranscribeJob>();
            std::thread::Builder::new()
                .name("gap-gone-transcribe".to_string())
                .spawn(move || transcribe_worker(rx))
                .map_err(|error| format!("无法启动转录线程: {error}"))?;
            *guard = Some(tx);
        }
        guard.as_ref().expect("转录线程刚刚已启动").clone()
    };
    let (respond_tx, respond_rx) = mpsc::channel();
    tx.send(TranscribeJob {
        input_path,
        model_dir: dir,
        app,
        cancelled: Arc::clone(&state.transcribe_cancelled),
        respond: respond_tx,
    })
    .map_err(|_| "转录线程已退出".to_string())?;
    match respond_rx.recv() {
        Ok(result) => result,
        Err(_) => Err("转录线程没有响应".to_string()),
    }
}

fn transcribe_worker(rx: mpsc::Receiver<TranscribeJob>) {
    let mut recognizer: Option<OfflineRecognizer> = None;
    while let Ok(job) = rx.recv() {
        let result = run_transcribe_job(&mut recognizer, &job);
        let _ = job.respond.send(result);
    }
}

/// 在目标切分点附近找能量最低的 100ms 窗口作为切块边界，
/// 避免把一个词切成两半。
fn find_split_points(samples: &[f32], sample_rate: usize) -> Vec<usize> {
    let target = CHUNK_TARGET_SECS * sample_rate;
    let frame = sample_rate / 10;
    let mut points = Vec::new();
    let mut cursor = 0usize;
    while samples.len() - cursor > target + 15 * sample_rate {
        let search_start = cursor + target - 15 * sample_rate;
        let search_end = (cursor + target + 5 * sample_rate).min(samples.len());
        let mut best = (cursor + target).min(samples.len());
        let mut best_rms = f32::MAX;
        let mut i = search_start;
        while i + frame <= search_end {
            let rms = (samples[i..i + frame].iter().map(|s| s * s).sum::<f32>()
                / frame as f32)
                .sqrt();
            if rms < best_rms {
                best_rms = rms;
                best = i;
            }
            i += frame;
        }
        if best <= cursor {
            best = cursor + target;
        }
        points.push(best);
        cursor = best;
    }
    points
}

/// 把词级 token + 时间戳拆成两份产物：
/// - words：逐 token 的词带数据（end 用下一 token 的 start 回填）
/// - segments：按标点聚合的句子（供面板与字幕导出）
/// SenseVoice 输出里夹带 <|zh|><|HAPPY|> 这类元标签，需要滤掉。
fn collect_transcript(
    tokens: &[String],
    timestamps: &[f32],
    offset: f32,
    words: &mut Vec<TranscriptWord>,
    segments: &mut Vec<TranscriptSegment>,
) {
    const SENTENCE_END: [char; 7] = ['。', '！', '？', '!', '?', '；', ';'];
    const CLAUSE_END: [char; 4] = ['，', ',', '、', '：'];
    const MAX_CLAUSE_CHARS: usize = 40;

    let mut kept: Vec<(&str, f32)> = Vec::with_capacity(tokens.len());
    for (index, token) in tokens.iter().enumerate() {
        if token.starts_with("<|") || token.trim().is_empty() {
            continue;
        }
        let ts = timestamps.get(index).copied().unwrap_or(0.0) + offset;
        kept.push((token.as_str(), ts));
    }

    // 词带：end 取下一词 start，末词给 0.3s 兜底宽度。
    let word_base = words.len();
    for (index, (token, ts)) in kept.iter().enumerate() {
        let end = kept
            .get(index + 1)
            .map(|(_, next_ts)| *next_ts)
            .unwrap_or(ts + 0.3);
        let text = token.trim();
        if !text.is_empty() {
            words.push(TranscriptWord {
                start: *ts,
                end,
                text: text.to_string(),
            });
        }
    }
    for index in word_base + 1..words.len() {
        if words[index - 1].end > words[index].start {
            words[index - 1].end = words[index].start;
        }
    }

    // 句子聚合：标点优先；口语化演讲常常整段无标点（实测一句话能超过 1 分钟），
    // 所以加时长兜底——超过 8s 后在 >0.4s 的词间停顿处下刀，15s 硬切。
    const SOFT_LIMIT_SECS: f32 = 8.0;
    const HARD_LIMIT_SECS: f32 = 15.0;
    const PAUSE_SPLIT_SECS: f32 = 0.4;

    let mut text = String::new();
    let mut start: Option<f32> = None;
    let mut last_ts = 0.0f32;
    let mut prev_ts: Option<f32> = None;
    let mut flush = |text: &mut String, start: &mut Option<f32>, end: f32| {
        let trimmed = text.trim();
        if !trimmed.is_empty() {
            segments.push(TranscriptSegment {
                start: start.unwrap_or(end),
                end,
                text: trimmed.to_string(),
            });
        }
        text.clear();
        *start = None;
    };

    for (token, ts) in &kept {
        let gap = prev_ts.map(|p| ts - p).unwrap_or(0.0);
        let segment_duration = start.map(|s| ts - s).unwrap_or(0.0);
        let overtime = segment_duration > SOFT_LIMIT_SECS && gap > PAUSE_SPLIT_SECS;
        let forced = segment_duration > HARD_LIMIT_SECS;
        if !text.is_empty() && (overtime || forced) {
            // 在当前词之前切开：上一段的结束取上一个词的时间。
            flush(&mut text, &mut start, prev_ts.unwrap_or(*ts) + 0.3);
        }
        if start.is_none() {
            start = Some(*ts);
        }
        text.push_str(token);
        last_ts = *ts;
        prev_ts = Some(*ts);
        let is_sentence_end = token
            .chars()
            .last()
            .is_some_and(|c| SENTENCE_END.contains(&c));
        let is_long_clause = text.chars().count() >= MAX_CLAUSE_CHARS
            && token.chars().last().is_some_and(|c| CLAUSE_END.contains(&c));
        if is_sentence_end || is_long_clause {
            flush(&mut text, &mut start, *ts);
        }
    }
    flush(&mut text, &mut start, last_ts + 0.5);

    // 用下一句的开始时间回填上一句的结束时间，时间轴更贴合。
    for index in 1..segments.len() {
        let next_start = segments[index].start;
        let previous = &mut segments[index - 1];
        if previous.end < next_start {
            previous.end = next_start;
        }
    }
}

fn run_transcribe_job(
    recognizer_slot: &mut Option<OfflineRecognizer>,
    job: &TranscribeJob,
) -> Result<TranscriptResult, String> {
    let wav_bytes =
        fs::read(&job.input_path).map_err(|error| format!("无法读取转录输入: {error}"))?;
    let mut reader = hound::WavReader::new(std::io::Cursor::new(wav_bytes))
        .map_err(|error| format!("无法读取 WAV: {error}"))?;
    let spec = reader.spec();
    if spec.channels != 1 || spec.sample_rate != 16_000 {
        return Err("转录输入需要 16 kHz 单声道 WAV".to_string());
    }
    let samples: Vec<f32> = reader
        .samples::<i16>()
        .map(|sample| {
            sample
                .map(|value| value as f32 / i16::MAX as f32)
                .map_err(|error| error.to_string())
        })
        .collect::<Result<Vec<_>, _>>()?;

    if recognizer_slot.is_none() {
        // 首次加载模型需要几秒，前端显示「正在加载模型」。
        emit_progress(&job.app, "load", -1.0);
        let mut config = OfflineRecognizerConfig::default();
        config.model_config.sense_voice = OfflineSenseVoiceModelConfig {
            model: Some(
                job.model_dir
                    .join(MODEL_ONNX)
                    .to_string_lossy()
                    .to_string(),
            ),
            language: Some("auto".to_string()),
            use_itn: true,
        };
        config.model_config.tokens = Some(
            job.model_dir
                .join(TOKENS_TXT)
                .to_string_lossy()
                .to_string(),
        );
        config.model_config.num_threads = 2;
        *recognizer_slot = Some(
            OfflineRecognizer::create(&config)
                .ok_or_else(|| "无法加载 SenseVoice 模型".to_string())?,
        );
    }
    let recognizer = recognizer_slot.as_mut().expect("模型刚刚已加载");

    // 按低能量点切块，块间可取消、可汇报真实进度。
    let sample_rate = 16_000usize;
    let mut boundaries = vec![0usize];
    boundaries.extend(find_split_points(&samples, sample_rate));
    boundaries.push(samples.len());

    let mut segments = Vec::new();
    let mut words = Vec::new();
    let total = (boundaries.len() - 1).max(1);
    for chunk_index in 0..boundaries.len() - 1 {
        if job.cancelled.load(Ordering::Relaxed) {
            return Err("转录已取消".to_string());
        }
        let begin = boundaries[chunk_index];
        let end = boundaries[chunk_index + 1];
        if end <= begin {
            continue;
        }
        let stream = recognizer.create_stream();
        stream.accept_waveform(sample_rate as i32, &samples[begin..end]);
        recognizer.decode(&stream);
        let result = stream
            .get_result()
            .ok_or_else(|| "转录失败：识别器没有返回结果".to_string())?;
        let timestamps = result.timestamps.unwrap_or_default();
        collect_transcript(
            &result.tokens,
            &timestamps,
            begin as f32 / sample_rate as f32,
            &mut words,
            &mut segments,
        );
        emit_progress(
            &job.app,
            "transcribe",
            ((chunk_index + 1) as f32 / total as f32) * 100.0,
        );
    }
    Ok(TranscriptResult { segments, words })
}
