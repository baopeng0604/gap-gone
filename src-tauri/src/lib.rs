use std::{
    fs::File,
    io::BufWriter,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc, Arc, Mutex,
    },
    time::{SystemTime, UNIX_EPOCH},
};

use cpal::{
    traits::{DeviceTrait, HostTrait, StreamTrait},
    Device, SampleFormat, Stream, StreamConfig,
};
use df::tract::{DfParams, DfTract, ReduceMask, RuntimeParams};
use ndarray::Array2;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

mod lufs;
mod transcribe;

#[derive(Default)]
pub(crate) struct RecordingManager {
    active: Mutex<Option<RecordingState>>,
    /// 与降噪工作线程共享的取消标记。
    denoise_cancelled: Arc<AtomicBool>,
    /// 降噪工作线程的任务入口。DfTract 含 Rc 不是 Send，
    /// 模型只能常驻该线程，首次降噪时惰性启动。
    denoise_tx: Mutex<Option<mpsc::Sender<DenoiseJob>>>,
    /// 与转录工作线程共享的取消标记。
    transcribe_cancelled: Arc<AtomicBool>,
    /// 转录工作线程的任务入口（SenseVoice 识别器常驻该线程）。
    transcribe_tx: Mutex<Option<mpsc::Sender<transcribe::TranscribeJob>>>,
    /// 自定义模型目录（设置页可改）；None = 应用数据目录默认值。
    transcribe_model_dir: Mutex<Option<PathBuf>>,
}

/// 写入线程的指令。实时音频回调里只入队采样块，
/// 磁盘写入、电平统计与 IPC 事件全部由专用线程承担，
/// 避免回调超过 WASAPI 单个缓冲处理周期触发
/// AUDCLNT_E_BUFFER_ERROR（underrun/overrun）。
enum WriterCommand {
    Samples(Vec<f32>),
    Finalize {
        respond: Option<mpsc::Sender<Result<(), String>>>,
    },
}

struct RecordingState {
    stream: Stream,
    writer_tx: mpsc::Sender<WriterCommand>,
    path: PathBuf,
    paused: bool,
    /// 流已报错、正等待或正在回收。
    /// start_recording 依据它区分「真在录音」与「可清理的残留状态」。
    errored: Arc<AtomicBool>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AudioDevice {
    id: String,
    label: String,
    is_default: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RecordingStarted {
    path: String,
    sample_rate: u32,
    channels: u16,
}

#[derive(Clone, Serialize)]
struct RecordingLevel {
    rms: f32,
    peak: f32,
    /// 截至目前被容忍的瞬时 underrun/overrun（Xrun）次数。
    /// 这类毛刺只丢极少采样，不致命，不中断录音。
    glitches: u32,
    /// 从开录起累计的 Integrated LUFS；数据不足时为 None。
    lufs: Option<f32>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RecordingErrorPayload {
    message: String,
    /// 已 finalize 的部分录音文件；前端读取后进入试听，避免整段丢失。
    path: Option<String>,
}

/// 返回 (device, id, label, is_default)。
/// id 使用 cpal DeviceId（WASAPI endpoint id / CoreAudio UID），
/// 平台级稳定且唯一；两台同名 USB 麦也能区分。
/// 个别后端拿不到 id 时退回设备名（有同名撞车风险，属兜底）。
fn input_devices() -> Result<Vec<(Device, String, String, bool)>, String> {
    let host = cpal::default_host();
    let default_name = host
        .default_input_device()
        .and_then(|device| device.description().ok())
        .map(|description| description.name().to_string());
    Ok(host
        .input_devices()
        .map_err(|error| format!("无法列出录音设备: {error}"))?
        .map(|device| {
            let name = device
                .description()
                .map(|description| description.name().to_string())
                .unwrap_or_else(|_| "未命名设备".to_string());
            let id = device
                .id()
                .map(|id| id.to_string())
                .unwrap_or_else(|_| name.clone());
            let is_default = default_name.as_deref() == Some(name.as_str());
            (device, id, name, is_default)
        })
        .collect::<Vec<_>>())
}

#[tauri::command]
fn list_audio_input_devices() -> Result<Vec<AudioDevice>, String> {
    Ok(input_devices()?
        .into_iter()
        .map(|(_, id, label, is_default)| AudioDevice {
            id,
            label,
            is_default,
        })
        .collect())
}

/// 把交错的立体声或多声道数据下混为单声道。
/// Windows WASAPI 共享模式下采集流只接受设备混音格式，
/// 声道数必须与设备一致，因此只能在回调里转成单声道。
fn downmix_to_mono(data: &[f32], channels: usize) -> Vec<f32> {
    if channels <= 1 {
        return data.to_vec();
    }
    data.chunks(channels)
        .map(|frame| frame.iter().sum::<f32>() / frame.len() as f32)
        .collect()
}

/// 启动 WAV 写入线程：接收实时回调入队的采样块，
/// 写盘并按 ~100ms 聚合电平事件（原来每个音频块 emit 一次，
/// 高频 IPC + 回调内磁盘 IO 是 underrun 的主因）。
fn spawn_wav_writer(
    app: AppHandle,
    path: &PathBuf,
    spec: hound::WavSpec,
    sample_rate: u32,
    glitches: Arc<AtomicUsize>,
) -> Result<mpsc::Sender<WriterCommand>, String> {
    let writer: hound::WavWriter<BufWriter<File>> = hound::WavWriter::create(path, spec)
        .map_err(|error| format!("无法创建临时录音文件: {error}"))?;
    let (tx, rx) = mpsc::channel::<WriterCommand>();
    let emit_window = (sample_rate / 10).max(1) as usize;
    std::thread::Builder::new()
        .name("gap-gone-wav-writer".to_string())
        .spawn(move || {
            let mut writer = writer;
            let mut sum_sq = 0.0f32;
            let mut peak = 0.0f32;
            let mut samples_seen = 0usize;
            let mut loudness = crate::lufs::IntegratedLoudness::new(sample_rate);
            while let Ok(command) = rx.recv() {
                match command {
                    WriterCommand::Samples(mono) => {
                        loudness.push_mono(&mono);
                        for sample in &mono {
                            sum_sq += sample * sample;
                            peak = peak.max(sample.abs());
                            let value = (*sample * i16::MAX as f32)
                                .clamp(i16::MIN as f32, i16::MAX as f32) as i16;
                            let _ = writer.write_sample(value);
                        }
                        samples_seen += mono.len();
                        if samples_seen >= emit_window {
                            let rms = (sum_sq / samples_seen as f32).sqrt().min(1.0);
                            let _ = app.emit(
                                "recording-level",
                                RecordingLevel {
                                    rms,
                                    peak: peak.min(1.0),
                                    glitches: glitches.load(Ordering::Relaxed) as u32,
                                    lufs: loudness.integrated(),
                                },
                            );
                            sum_sq = 0.0;
                            peak = 0.0;
                            samples_seen = 0;
                        }
                    }
                    WriterCommand::Finalize { respond } => {
                        // 通道 FIFO 保证 Finalize 前的采样块都已写盘。
                        let result = writer
                            .finalize()
                            .map_err(|error| format!("无法完成录音文件: {error}"));
                        if let Some(respond) = respond {
                            let _ = respond.send(result);
                        }
                        return;
                    }
                }
            }
            // 发送端全部关闭却没收到 Finalize：兜底 finalize。
            let _ = writer.finalize();
        })
        .map_err(|error| format!("无法启动录音写入线程: {error}"))?;
    Ok(tx)
}

/// WASAPI 流报错（underrun/overrun、设备拔出、被占用等）后的回收：
/// 停掉失效的流、finalize 已写入的部分录音并通知前端。
/// 必须在独立线程执行——drop(Stream) 会 join 音频回调线程，
/// 在回调线程里自 drop 会死锁，所以在错误回调里只做标记。
fn recover_failed_recording(app: AppHandle, error: cpal::Error) {
    let manager = app.state::<RecordingManager>();
    let Ok(mut guard) = manager.active.lock() else {
        return;
    };
    // 只回收已标记 errored 的流：回收线程与 start_recording 抢锁可能滞后，
    // 不能误杀 start 刚刚建立的新录音。
    let stale = guard
        .as_ref()
        .is_some_and(|recording| recording.errored.load(Ordering::Relaxed));
    if !stale {
        return;
    }
    let Some(recording) = guard.take() else {
        return;
    };
    drop(guard);
    drop(recording.stream);
    // finalize 已采集数据：录音中断时保住中断前的部分。
    let _ = recording
        .writer_tx
        .send(WriterCommand::Finalize { respond: None });
    let payload = RecordingErrorPayload {
        message: error.to_string(),
        path: Some(recording.path.to_string_lossy().to_string()),
    };
    let _ = app.emit("recording-error", payload);
}

fn make_error_callback(
    app: AppHandle,
    errored: Arc<AtomicBool>,
    glitches: Arc<AtomicUsize>,
) -> impl FnMut(cpal::Error) + Send + 'static {
    move |error: cpal::Error| {
        // Xrun（buffer underrun/overrun）是瞬时毛刺：系统调度抖动、
        // 杀毒扫描等都可能触发，丢的是极少量采样，流本身还活着。
        // 只计数（由写入线程随电平事件上报），不拆录音。
        // 上一版的「任何错误都回收」把它当成了致命错误，导致几分钟就断录。
        if error.kind() == cpal::ErrorKind::Xrun {
            glitches.fetch_add(1, Ordering::Relaxed);
            return;
        }
        // 真致命错误（设备拔出、流失效等）：音频线程上只做标记，
        // 清理交给独立线程。
        if errored.swap(true, Ordering::Relaxed) {
            return;
        }
        let app = app.clone();
        std::thread::Builder::new()
            .name("gap-gone-recording-recovery".to_string())
            .spawn(move || recover_failed_recording(app, error))
            .ok();
    }
}

/// Gap Gone 专属临时目录：系统 temp 下的 gap-gone 子目录。
/// 录音 / 降噪 / 转录的临时文件统一落在这里，便于统计占用与一键清理。
pub(crate) fn gap_gone_temp_dir() -> PathBuf {
    std::env::temp_dir().join("gap-gone")
}

fn temp_recording_path() -> PathBuf {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let dir = gap_gone_temp_dir();
    // 目录可能被用户清空或删除，生成路径时确保存在
    let _ = std::fs::create_dir_all(&dir);
    dir.join(format!("gap-gone-{timestamp}.wav"))
}

/// 校验路径必须是 gap-gone 临时目录（系统 temp 下的 gap-gone 子目录）下的
/// gap-gone-* 文件，前端传来的任何读写路径都必须过这层校验，防止越权访问磁盘。
pub(crate) fn validate_temp_recording_path(path: &str) -> Result<PathBuf, String> {
    let candidate = PathBuf::from(path);
    let temp_dir = gap_gone_temp_dir();
    let file_name = candidate
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "录音文件路径无效".to_string())?;
    if !file_name.starts_with("gap-gone-") || candidate.parent() != Some(temp_dir.as_path()) {
        return Err("只能访问 Gap Gone 临时录音文件".to_string());
    }
    Ok(candidate)
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DenoiseFiles {
    input_path: String,
    output_path: String,
}

/// 降噪走「临时文件 + 路径传参」：前端把 WAV 写入 inputPath，
/// Rust 读入处理、写出 outputPath，前端再读回。
/// 避免大文件 Vec<u8> 走 JSON 数组序列化卡死 IPC。
/// 路径由 Rust 生成，保证一定落在 temp 目录且带 gap-gone- 前缀。
#[tauri::command]
fn prepare_denoise_files() -> DenoiseFiles {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let temp_dir = gap_gone_temp_dir();
    let _ = std::fs::create_dir_all(&temp_dir);
    DenoiseFiles {
        input_path: temp_dir
            .join(format!("gap-gone-denoise-input-{timestamp}.wav"))
            .to_string_lossy()
            .to_string(),
        output_path: temp_dir
            .join(format!("gap-gone-denoise-output-{timestamp}.wav"))
            .to_string_lossy()
            .to_string(),
    }
}

fn choose_device(device_id: Option<&str>) -> Result<(Device, String), String> {
    let mut devices = input_devices()?;
    if let Some(id) = device_id {
        // 优先按稳定 id 匹配；兜底按名称匹配（兼容旧前端缓存的 name 型 id）。
        if let Some(index) = devices
            .iter()
            .position(|(_, device_id, name, _)| device_id == id || name == id)
        {
            let (device, _, name, _) = devices.swap_remove(index);
            return Ok((device, name));
        }
        return Err("找不到所选录音设备".to_string());
    }
    if let Some(index) = devices.iter().position(|(_, _, _, is_default)| *is_default) {
        let (device, _, name, _) = devices.swap_remove(index);
        return Ok((device, name));
    }
    devices
        .pop()
        .map(|(device, _, name, _)| (device, name))
        .ok_or_else(|| "没有可用的录音设备".to_string())
}

#[tauri::command]
fn start_recording(
    app: AppHandle,
    state: State<'_, RecordingManager>,
    device_id: Option<String>,
) -> Result<RecordingStarted, String> {
    let mut active = state
        .active
        .lock()
        .map_err(|_| "录音状态不可用".to_string())?;
    if let Some(existing) = active.as_ref() {
        if existing.errored.load(Ordering::Relaxed) {
            // 上一条流已报错但回收线程尚未完成：清掉残留再开新录音，
            // 避免用户被「已经有录音正在进行」卡住无法重录。
            if let Some(stale) = active.take() {
                drop(stale.stream);
                let _ = stale
                    .writer_tx
                    .send(WriterCommand::Finalize { respond: None });
                let _ = std::fs::remove_file(stale.path);
            }
        } else {
            return Err("已经有录音正在进行".to_string());
        }
    }

    let (device, _) = choose_device(device_id.as_deref())?;
    let supported = device
        .default_input_config()
        .map_err(|error| format!("无法读取录音设备格式: {error}"))?;
    // Windows WASAPI 共享模式的采集流只接受设备混音格式；
    // 不能改动声道数或采样率，否则 Initialize 返回
    // AUDCLNT_E_UNSUPPORTED_FORMAT（表现为能选设备但无法录音）。
    // 因此这里原样使用默认配置，回调里再下混为单声道。
    let config: StreamConfig = supported.config();
    let channels = config.channels as usize;
    let sample_format = supported.sample_format();
    let path = temp_recording_path();
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: config.sample_rate,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let glitches = Arc::new(AtomicUsize::new(0));
    let writer_tx = spawn_wav_writer(
        app.clone(),
        &path,
        spec,
        config.sample_rate,
        Arc::clone(&glitches),
    )?;
    let errored = Arc::new(AtomicBool::new(false));

    let stream = match sample_format {
        SampleFormat::F32 => device.build_input_stream(
            config.clone(),
            {
                let writer_tx = writer_tx.clone();
                move |data: &[f32], _| {
                    // 实时回调只做下混 + 入队；磁盘/IPC 全在写入线程。
                    let mono = downmix_to_mono(data, channels);
                    let _ = writer_tx.send(WriterCommand::Samples(mono));
                }
            },
            make_error_callback(app.clone(), Arc::clone(&errored), Arc::clone(&glitches)),
            None,
        ),
        SampleFormat::I16 => device.build_input_stream(
            config.clone(),
            {
                let writer_tx = writer_tx.clone();
                move |data: &[i16], _| {
                    let samples: Vec<f32> = data
                        .iter()
                        .map(|sample| *sample as f32 / i16::MAX as f32)
                        .collect();
                    let mono = downmix_to_mono(&samples, channels);
                    let _ = writer_tx.send(WriterCommand::Samples(mono));
                }
            },
            make_error_callback(app.clone(), Arc::clone(&errored), Arc::clone(&glitches)),
            None,
        ),
        SampleFormat::U16 => device.build_input_stream(
            config.clone(),
            {
                let writer_tx = writer_tx.clone();
                move |data: &[u16], _| {
                    let samples: Vec<f32> = data
                        .iter()
                        .map(|sample| *sample as f32 / 32768.0 - 1.0)
                        .collect();
                    let mono = downmix_to_mono(&samples, channels);
                    let _ = writer_tx.send(WriterCommand::Samples(mono));
                }
            },
            make_error_callback(app.clone(), Arc::clone(&errored), Arc::clone(&glitches)),
            None,
        ),
        other => return Err(format!("暂不支持录音格式 {other:?}")),
    };
    let stream = match stream {
        Ok(stream) => stream,
        Err(error) => {
            // 写入线程会因通道关闭自行退出，这里只需清理空文件。
            let _ = std::fs::remove_file(&path);
            return Err(format!("无法启动录音流: {error}"));
        }
    };
    if let Err(error) = stream.play() {
        let _ = std::fs::remove_file(&path);
        return Err(format!("无法播放录音流: {error}"));
    }
    *active = Some(RecordingState {
        stream,
        writer_tx,
        path: path.clone(),
        paused: false,
        errored,
    });
    Ok(RecordingStarted {
        path: path.to_string_lossy().to_string(),
        sample_rate: config.sample_rate,
        channels: 1,
    })
}

#[tauri::command]
fn pause_recording(state: State<'_, RecordingManager>) -> Result<(), String> {
    let mut active = state
        .active
        .lock()
        .map_err(|_| "录音状态不可用".to_string())?;
    let recording = active
        .as_mut()
        .ok_or_else(|| "当前没有正在进行的录音".to_string())?;
    if recording.paused {
        return Ok(());
    }
    recording
        .stream
        .pause()
        .map_err(|error| format!("无法暂停录音流: {error}"))?;
    recording.paused = true;
    Ok(())
}

#[tauri::command]
fn resume_recording(state: State<'_, RecordingManager>) -> Result<(), String> {
    let mut active = state
        .active
        .lock()
        .map_err(|_| "录音状态不可用".to_string())?;
    let recording = active
        .as_mut()
        .ok_or_else(|| "当前没有正在进行的录音".to_string())?;
    if !recording.paused {
        return Ok(());
    }
    recording
        .stream
        .play()
        .map_err(|error| format!("无法继续录音流: {error}"))?;
    recording.paused = false;
    Ok(())
}

#[tauri::command]
fn stop_recording(state: State<'_, RecordingManager>) -> Result<String, String> {
    let recording = state
        .active
        .lock()
        .map_err(|_| "录音状态不可用".to_string())?
        .take()
        .ok_or_else(|| "当前没有正在进行的录音".to_string())?;
    // 先停流（join 音频线程；回调只入队，会立即返回），
    // 再让写入线程把队列里的采样写完并 finalize。
    drop(recording.stream);
    let (respond_tx, respond_rx) = mpsc::channel();
    recording
        .writer_tx
        .send(WriterCommand::Finalize {
            respond: Some(respond_tx),
        })
        .map_err(|_| "录音写入线程已退出".to_string())?;
    match respond_rx.recv() {
        Ok(result) => result?,
        Err(_) => return Err("录音写入线程没有响应".to_string()),
    }
    Ok(recording.path.to_string_lossy().to_string())
}

#[tauri::command]
fn cancel_recording(
    state: State<'_, RecordingManager>,
    path: Option<String>,
) -> Result<(), String> {
    let recording = state
        .active
        .lock()
        .map_err(|_| "录音状态不可用".to_string())?
        .take();
    if let Some(recording) = recording {
        drop(recording.stream);
        let _ = recording
            .writer_tx
            .send(WriterCommand::Finalize { respond: None });
        let _ = std::fs::remove_file(recording.path);
    } else if let Some(path) = path {
        let _ = remove_recording_file(&path);
    }
    Ok(())
}

fn remove_recording_file(path: &str) -> Result<(), String> {
    let candidate = validate_temp_recording_path(path)?;
    std::fs::remove_file(candidate).map_err(|error| format!("无法删除临时录音: {error}"))
}

#[tauri::command]
fn delete_recording_file(path: String) -> Result<(), String> {
    remove_recording_file(&path)
}

/// gap-gone 临时目录的占用统计（设置页展示用）。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TempStorageStatus {
    bytes: u64,
    file_count: u64,
}

fn scan_gap_gone_temp_dir() -> TempStorageStatus {
    let dir = gap_gone_temp_dir();
    let mut bytes = 0u64;
    let mut file_count = 0u64;
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            if let Ok(metadata) = entry.metadata() {
                if metadata.is_file() {
                    bytes += metadata.len();
                    file_count += 1;
                }
            }
        }
    }
    TempStorageStatus { bytes, file_count }
}

/// 统计 gap-gone 临时目录的占用空间与文件数量。
/// 目录遍历有磁盘 IO，放 spawn_blocking 避免阻塞 async runtime。
#[tauri::command]
async fn temp_storage_status() -> Result<TempStorageStatus, String> {
    tauri::async_runtime::spawn_blocking(scan_gap_gone_temp_dir)
        .await
        .map_err(|_| "临时目录统计失败".to_string())
}

/// 一键清理 gap-gone 临时目录。
/// 正在写入的录音文件（写入线程持有句柄）删除会失败，自动跳过，
/// 不会影响进行中的录音。返回清理后的剩余占用。
#[tauri::command]
async fn clear_temp_files() -> Result<TempStorageStatus, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let dir = gap_gone_temp_dir();
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_file() {
                    // 删除失败（文件被占用等）直接跳过，继续清其余文件
                    let _ = std::fs::remove_file(path);
                }
            }
        }
        scan_gap_gone_temp_dir()
    })
    .await
    .map_err(|_| "临时目录清理失败".to_string())
}

#[tauri::command]
fn denoise_audio(
    app: AppHandle,
    state: State<'_, RecordingManager>,
    input_path: String,
    output_path: String,
    preset: String,
) -> Result<(), String> {
    state.denoise_cancelled.store(false, Ordering::Relaxed);
    let input_path = validate_temp_recording_path(&input_path)?;
    let output_path = validate_temp_recording_path(&output_path)?;

    // DfTract 内含 Rc，不是 Send，不能放进 Tauri State 跨线程共享。
    // 因此模型常驻一个专用工作线程（gap-gone-denoise），命令只投递任务；
    // 线程内缓存模型，避免每次降噪都花数秒重建 tract 运行时。
    let tx = {
        let mut guard = state
            .denoise_tx
            .lock()
            .map_err(|_| "降噪状态不可用".to_string())?;
        if guard.is_none() {
            let (tx, rx) = mpsc::channel::<DenoiseJob>();
            std::thread::Builder::new()
                .name("gap-gone-denoise".to_string())
                .spawn(move || denoise_worker(rx))
                .map_err(|error| format!("无法启动降噪线程: {error}"))?;
            *guard = Some(tx);
        }
        guard.as_ref().expect("降噪线程刚刚已启动").clone()
    };
    let (respond_tx, respond_rx) = mpsc::channel();
    tx.send(DenoiseJob {
        input_path,
        output_path,
        preset,
        app,
        cancelled: Arc::clone(&state.denoise_cancelled),
        respond: respond_tx,
    })
    .map_err(|_| "降噪线程已退出".to_string())?;
    match respond_rx.recv() {
        Ok(result) => result,
        Err(_) => Err("降噪线程没有响应".to_string()),
    }
}

struct DenoiseJob {
    input_path: PathBuf,
    output_path: PathBuf,
    preset: String,
    app: AppHandle,
    cancelled: Arc<AtomicBool>,
    respond: mpsc::Sender<Result<(), String>>,
}

/// 降噪工作线程：独占 DfTract 实例，逐个处理投递来的任务。
fn denoise_worker(rx: mpsc::Receiver<DenoiseJob>) {
    while let Ok(job) = rx.recv() {
        let result = run_denoise_job(&job);
        let _ = job.respond.send(result);
    }
}

/// 降噪引擎的运行时参数。**必须与官方 `enhance_wav` / C API 的口径一致**（硬约束 14），
/// 两边的取值都不是随手写的：
///
/// - 三个 lsnr 阈值用官方口径（−15 / 35 / 35），不能沿用 `default_with_ch` 的库默认
///   （−10 / 30 / 20）。`apply_stages` 会拿它们按帧的 local SNR 决定做多少处理：
///   lsnr > `max_db_erb_thresh` → 整帧原封不动；`max_db_df_thresh` < lsnr ≤
///   `max_db_erb_thresh` → 只做 ERB 掩蔽、**跳过 DeepFilter 第二级**。库默认的 df 阈值
///   只有 20 dB，恰好把口播里「有语音、底下压着一层底噪」的帧（约 20 ~ 35 dB）划进
///   「跳过 DF」甚至「整帧不动」—— 等于把降噪在最需要它的地方提前关掉。
/// - `mask_reduce` 用 **MAX**，不用库默认的 MEAN。单声道下两者数值等价，但 **MEAN 会在
///   ERB 解码器里额外拼一条 `Reduce<Sum>` + 除法子图，而 DFN3 的图在 tract 0.21.4 上
///   过不了 codegen 后的图压缩**（报 `duplicate name /convt3/Conv.bias`）。
///   这个错误会让整个模型加载失败、降噪静默退化成兜底算法 —— 一直在用的其实是
///   兜底算法，而所有基于 DeepFilterNet 的调参全部无效。改回 MEAN 前先跑自检测试。
fn denoise_runtime_params() -> RuntimeParams {
    RuntimeParams::default_with_ch(1)
        .with_thresholds(-15.0, 35.0, 35.0)
        .with_mask_reduce(ReduceMask::MAX)
}

/// 核心降噪：把 `samples` 过一遍模型，返回**与输入等长、逐采样对齐**的结果。
///
/// 生产路径（`run_denoise_job`）与自检共用这一段，保证「测的就是实际跑的逻辑」。
/// `on_chunk` 每处理完一个 hop 回调一次（已处理块数、总块数），返回 false 表示中止。
fn enhance_samples(
    model: &mut DfTract,
    samples: &[f32],
    mut on_chunk: impl FnMut(usize, usize) -> bool,
) -> Result<Vec<f32>, String> {
    let hop_size = model.hop_size;
    // process 的输出相对输入滞后 delay 个采样（STFT 帧延迟 + 模型前瞻），官方
    // enhance_wav 的 --compensate-delay 就是丢掉这一段。不补的话整段会晚几十毫秒
    // （与视频/字幕对不齐），选区降噪更是直接错位。做法：输入尾部补 delay 个零，
    // 输出整体前移 delay，长度仍与输入一致。
    // 注意 `df_order` 这一项：crate 的 process 把输出取自滚动缓冲里**最旧**的那一帧，
    // 而缓冲长度是 (df_order + conv_lookahead) 帧，所以真实延迟要算上 df_order 帧 ——
    // 官方 enhance_wav 的 `fft_size − hop_size + lookahead × hop_size` **漏了这一项**，
    // 照抄会让整段输出晚 5 个 hop（实测 2400 采样 = 50 ms，`--compensate-delay` 同样漏）。
    // 本模型：960 − 480 + 5 × 480 = 2880。
    let delay = model.fft_size.saturating_sub(hop_size).saturating_add(
        model
            .df_order
            .saturating_add(model.lookahead)
            .saturating_mul(hop_size),
    );
    let total = samples.len() + delay;
    let total_chunks = total.div_ceil(hop_size).max(1);
    let mut enhanced: Vec<f32> = Vec::with_capacity(samples.len());
    // 已经产出的原始输出采样数（未补偿前），用来决定每个块要丢掉多少个开头采样。
    let mut emitted = 0usize;

    for chunk_index in 0..total_chunks {
        let start = chunk_index * hop_size;
        let end = (start + hop_size).min(total);
        let mut input = vec![0.0; hop_size];
        for i in start..end {
            // 越界部分就是尾部补的零
            input[i - start] = samples.get(i).copied().unwrap_or(0.0);
        }
        let input = Array2::from_shape_vec((1, hop_size), input)
            .map_err(|error| format!("降噪输入无效: {error}"))?;
        let mut output = Array2::<f32>::zeros((1, hop_size));
        model
            .process(input.view(), output.view_mut())
            .map_err(|error| format!("DeepFilterNet 处理失败: {error}"))?;
        let mut chunk_out = output.into_raw_vec();
        if emitted < delay {
            chunk_out.drain(..(delay - emitted).min(chunk_out.len()));
        }
        emitted += hop_size;
        enhanced.extend(chunk_out);
        if !on_chunk(chunk_index + 1, total_chunks) {
            return Err("降噪已取消".to_string());
        }
    }
    enhanced.truncate(samples.len());
    Ok(enhanced)
}

fn run_denoise_job(job: &DenoiseJob) -> Result<(), String> {
    let wav_bytes = std::fs::read(&job.input_path)
        .map_err(|error| format!("无法读取降噪输入: {error}"))?;
    let mut reader = hound::WavReader::new(std::io::Cursor::new(wav_bytes))
        .map_err(|error| format!("无法读取 WAV: {error}"))?;
    let input_spec = reader.spec();
    if input_spec.channels != 1 || input_spec.sample_rate != 48_000 {
        return Err("DeepFilterNet3 处理需要 48 kHz 单声道 WAV".to_string());
    }

    let samples: Vec<f32> = match input_spec.sample_format {
        hound::SampleFormat::Int => reader
            .samples::<i16>()
            .map(|sample| {
                sample
                    .map(|value| value as f32 / i16::MAX as f32)
                    .map_err(|error| error.to_string())
            })
            .collect::<Result<Vec<_>, _>>()?,
        hound::SampleFormat::Float => reader
            .samples::<f32>()
            .map(|sample| sample.map_err(|error| error.to_string()))
            .collect::<Result<Vec<_>, _>>()?,
    };

    // `atten_lim` 的语义是「把原始含噪频谱掺回输出的比例上限」（10^(−N/20)），
    // **不是**「每频段最多压 N dB」。100 dB 等于 `None`（完全不掺回、模型全力抑制）——
    // 低信噪比素材上会挖出谱洞、人声发破音，用户实测「强档完全不能用」，
    // 所以强档封顶在 36 dB（掺回 1.6%），而不是放任不限。
    let attenuation = match job.preset.as_str() {
        "light" => 12.0,
        "strong" => 36.0,
        _ => 24.0,
    };
    // **每个任务都新建模型，不要复用缓存。**
    //
    // 「init() + DFState::reset() + init_norm_states()」这套重置**并不能**复位模型内部的
    // 滚动缓冲：复用同一个模型连跑三次同一段音频，输出相对输入分别晚 50 / 100 / 150 ms
    // （实测，每次多漂 `df_order` 帧）；而每次重建模型，三次结果逐采样一致。所以重建是
    // 唯一可靠的复位方式，代价是每个任务多花一两秒加载模型。
    // 加载前先通知前端，界面显示「正在加载模型」而不是卡在 0%。
    let _ = job.app.emit("denoise-progress", -1.0f32);
    // 用 `{error:#}` 而不是 `{error}`：tract 的报错是带上下文的链
    // （最外层只有「running pass codegen」这种无信息量的壳），
    // 必须把内层原因一起印出来，否则根本查不到是哪个算子出的问题。
    let mut model = DfTract::new(DfParams::default(), &denoise_runtime_params())
        .map_err(|error| format!("无法加载 DeepFilterNet3 模型: {error:#}"))?;
    model.set_atten_lim(attenuation);
    // post-filter 保持关闭（beta 0）。它会在「掩蔽不确定」的频点上再压一层，官方 CLI 默认
    // 0.02，但代价是语音失真 —— 低信噪比素材上「掩蔽不确定」的频点特别多，结果残余噪声没
    // 消掉、人声先毛了。0.1.54 开过 0.02，用户实测「强档人声破音」，故回退（0.1.55）。
    // 注意链上顺序：PF 在「掺回原始噪声」之前跑，所以它本来也压不掉 atten_lim 掺回的那部分。
    model.set_pf_beta(0.0);
    model
        .init()
        .map_err(|error| format!("无法重置降噪模型状态: {error}"))?;
    let nb_df = model.nb_df;
    for df_state in &mut model.df_states {
        df_state.reset();
        df_state.init_norm_states(nb_df);
    }
    let enhanced = enhance_samples(&mut model, &samples, |done, total| {
        let _ = job
            .app
            .emit("denoise-progress", (done as f32 / total as f32) * 100.0);
        !job.cancelled.load(Ordering::Relaxed)
    })?;

    // 结果直接写到前端提供的 temp 路径，由前端读回并负责清理。
    // 写 32-bit float：素材电平偏低时（口播常见）16-bit 会把底噪那一段量化掉，
    // 而模型的抑制决策依赖对底噪的准确估计；float 写盘时也不必削顶。
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: 48_000,
        bits_per_sample: 32,
        sample_format: hound::SampleFormat::Float,
    };
    let mut writer = hound::WavWriter::create(&job.output_path, spec)
        .map_err(|error| format!("无法创建降噪结果: {error}"))?;
    for sample in enhanced {
        writer
            .write_sample(sample)
            .map_err(|error| format!("无法写入降噪结果: {error}"))?;
    }
    writer
        .finalize()
        .map_err(|error| format!("无法完成降噪结果: {error}"))?;
    Ok(())
}

#[tauri::command]
fn cancel_denoise(state: State<'_, RecordingManager>) {
    state.denoise_cancelled.store(true, Ordering::Relaxed);
}

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {name}! You've been greeted from Rust!")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(RecordingManager::default())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            greet,
            list_audio_input_devices,
            start_recording,
            pause_recording,
            resume_recording,
            stop_recording,
            cancel_recording,
            prepare_denoise_files,
            delete_recording_file,
            temp_storage_status,
            clear_temp_files,
            denoise_audio,
            cancel_denoise,
            transcribe::transcribe_model_status,
            transcribe::download_transcribe_model,
            transcribe::prepare_transcribe_file,
            transcribe::start_transcription,
            transcribe::cancel_transcribe,
            transcribe::get_transcribe_model_dir,
            transcribe::set_transcribe_model_dir,
            transcribe::open_transcribe_model_dir
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 幅度包络（|x| 经 10 ms 一阶低通）：对基音周期性不敏感，用它做互相关才能把
    /// 「真实的时间对齐」和「基音周期的假象」分开 —— 男声 100 Hz 的周期正好是 480
    /// 采样（= 1 个 hop），用原始波形做相关时 lag 0 与 lag 480 看起来一样像。
    fn envelope(signal: &[f32], sr: usize) -> Vec<f32> {
        let coefficient = 1.0 - (-1.0f32 / (sr as f32 * 0.01)).exp();
        let mut state = 0.0;
        signal
            .iter()
            .map(|sample| {
                state += (sample.abs() - state) * coefficient;
                state
            })
            .collect()
    }

    /// 降噪引擎自检：模型能不能加载 + 推理能不能出有限值。
    ///
    /// DFN 的图能不能被 tract 编译成可执行模型，是整条降噪链的前提，而它只在**运行期**
    /// 暴露（`into_optimized()` 里那个 codegen pass）。这一步曾经失败过：标准 DFN3 的图
    /// 报 `duplicate name /convt3/Conv.bias`，模型加载失败，降噪于是静默退化成兜底算法，
    /// 所有基于 DeepFilterNet 的参数调整全部无效 —— 用户连续四轮试听都「没有任何改进」，
    /// 问题却在依赖版本组合上。现在改用低延迟变体（见 Cargo.toml 的注释）。
    ///
    /// 跑法：`cargo test --lib deepfilternet_engine_works -- --nocapture`
    /// 它不需要录音、不需要界面，一次就能回答「降噪引擎到底还能不能用」。
    #[test]
    fn deepfilternet_engine_works() {
        // anyhow 的 Debug 会打印完整上下文链，正是定位算子所需的
        let mut model = DfTract::new(DfParams::default(), &denoise_runtime_params())
            .unwrap_or_else(|error| panic!("DFN 模型加载失败: {error:?}"));
        println!(
            "DFN 加载成功: sr={} hop={} fft={} nb_df={} lookahead={} conv_lookahead={} df_lookahead={} df_order={}",
            model.sr,
            model.hop_size,
            model.fft_size,
            model.nb_df,
            model.lookahead,
            model.conv_lookahead,
            model.df_lookahead,
            model.df_order
        );

        // 加载成功还不够：真跑几个 hop，确认推理出得来、且输出全是有限值。
        // NaN 会毁掉整段声音却不会报错，所以这一步必须断言。
        let nb_df = model.nb_df;
        let hop_size = model.hop_size;
        model.init().expect("无法重置模型状态");
        for state in &mut model.df_states {
            state.reset();
            state.init_norm_states(nb_df);
        }
        for amplitude in [0.0f32, 0.1, -0.1] {
            let chunk = Array2::from_shape_vec((1, hop_size), vec![amplitude; hop_size])
                .expect("构造输入失败");
            let mut output = Array2::<f32>::zeros((1, hop_size));
            model
                .process(chunk.view(), output.view_mut())
                .expect("推理失败");
            assert!(
                output.iter().all(|value| value.is_finite()),
                "推理输出了非有限值"
            );
        }
        println!("DFN 推理自检通过");
    }

    /// 诊断：把**真实录音**走一遍生产路径，量化输出是否正常。
    ///
    /// 为什么必须是真实语音：DeepFilterNet 是语音模型，合成音（正弦堆/噪声）会被它当噪声
    /// 处理，测出来的数全是「模型对非语音的反应」，与真语音无关（试过，输出与输入的互相关
    /// 只有 0.55 ~ 0.6，而且周期性信号会把滞后测量变成周期性模糊）。
    ///
    /// 用法（不给路径就跳过）：
    /// ```text
    /// $env:GAP_GONE_DENOISE_TEST_WAV="D:\some\take.wav"
    /// $env:GAP_GONE_DENOISE_TEST_SECONDS="0"   # 可选，默认只取前 15 秒；0 表示整段
    /// cargo test --lib diagnostic_denoise_alignment -- --nocapture
    /// ```
    /// 输出：每个档位的 ① 真实滞后（验证延迟补偿）② ρ(输入,输出)（模型改动多大）
    /// ③ 块电平 P10 / P50 / P90 变化（P10 ≈ 停顿/底噪，就是「噪声降了多少」）
    /// ④ 中档复跑与首跑逐采样比对（验证每任务重建模型确实复位了滚动缓冲）；
    /// 并把处理结果写到 temp 下便于人耳复核。
    #[test]
    fn diagnostic_denoise_alignment() {
        let Ok(path) = std::env::var("GAP_GONE_DENOISE_TEST_WAV") else {
            println!("跳过：未设置 GAP_GONE_DENOISE_TEST_WAV");
            return;
        };
        let Ok(bytes) = std::fs::read(&path) else {
            println!("跳过：读不到 {path}");
            return;
        };
        let mut reader = hound::WavReader::new(std::io::Cursor::new(bytes)).expect("解析 WAV 失败");
        let spec = reader.spec();
        let channels = spec.channels as usize;
        let raw: Vec<f32> = match spec.sample_format {
            hound::SampleFormat::Int => reader
                .samples::<i16>()
                .map(|s| s.unwrap() as f32 / 32768.0)
                .collect(),
            hound::SampleFormat::Float => reader.samples::<f32>().map(|s| s.unwrap()).collect(),
        };
        let monaural: Vec<f32> = if channels == 1 {
            raw
        } else {
            raw.chunks(channels)
                .map(|frame| frame.iter().sum::<f32>() / channels as f32)
                .collect()
        };

        const SR: usize = 48_000;
        // 调试版推理与相关搜索都慢，默认只取前 15 秒（素材再长也只截这一段）。
        // 需要整段素材时用 GAP_GONE_DENOISE_TEST_SECONDS 覆盖，<= 0 表示不截断。
        let max_seconds: f32 = std::env::var("GAP_GONE_DENOISE_TEST_SECONDS")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(15.0);
        let input: Vec<f32> = if spec.sample_rate as usize == SR {
            monaural
        } else {
            let ratio = SR as f64 / spec.sample_rate as f64;
            let length = (monaural.len() as f64 * ratio) as usize;
            (0..length)
                .map(|i| {
                    let position = i as f64 / ratio;
                    let index = position.floor() as usize;
                    let frac = (position - index as f64) as f32;
                    let a = monaural.get(index).copied().unwrap_or(0.0);
                    let b = monaural.get(index + 1).copied().unwrap_or(a);
                    a + (b - a) * frac
                })
                .collect()
        };
        let input: Vec<f32> = if max_seconds > 0.0 {
            input
                .into_iter()
                .take((SR as f32 * max_seconds) as usize)
                .collect()
        } else {
            input
        };
        let rms = (input.iter().map(|s| s * s).sum::<f32>() / input.len().max(1) as f32).sqrt();
        println!(
            "素材：{:.2} 秒 / {} Hz {} 声道，活动电平约 {:.1} dBFS",
            input.len() as f32 / SR as f32,
            spec.sample_rate,
            spec.channels,
            20.0 * rms.max(1e-9).log10()
        );
        // 各档位的噪声抑制**上限**：atten_lim 的语义是把原始含噪谱按 10^(−N/20) 掺回输出
        // （libDF tract.rs 的 process 里那句 `scaled_add(lim, spec_noisy)`），所以无论模型
        // 多好，噪声最多只能降 N dB。下面的 P10（≈ 停顿/底噪）读数要与此对照着看：
        // 贴住上限说明「底噪还听得见」是档位选轻了；离上限很远说明卡在模型侧 ——
        // 低 local-SNR 的帧走了 zero-mask 或跳过 DeepFilter 的分支，再调 atten_lim 无用。
        println!(
            "各档位噪声抑制上限：轻 12 / 中 24 / 强 36 / 极限48 = 48 dB；不掺回100 = 无上限（None）"
        );

        // 归一化互相关（b 相对 a 平移 lag，按 step 抽样）
        fn rho(a: &[f32], b: &[f32], lag: isize, step: usize) -> f64 {
            let n = a.len() as isize;
            let (mut ab, mut aa, mut bb) = (0.0f64, 0.0f64, 0.0f64);
            let mut i = 0isize;
            while i < n {
                let j = i + lag;
                if j >= 0 && j < n {
                    let (x, y) = (a[i as usize] as f64, b[j as usize] as f64);
                    ab += x * y;
                    aa += x * x;
                    bb += y * y;
                }
                i += step as isize;
            }
            if aa <= 0.0 || bb <= 0.0 {
                0.0
            } else {
                ab / (aa.sqrt() * bb.sqrt())
            }
        }
        fn blocks(signal: &[f32], sr: usize) -> Vec<f32> {
            let size = sr / 10;
            signal
                .chunks(size)
                .map(|c| {
                    let ms = c.iter().map(|s| s * s).sum::<f32>() / c.len() as f32;
                    if ms <= 1e-12 {
                        -120.0
                    } else {
                        10.0 * ms.log10()
                    }
                })
                .collect()
        }
        // 轻 / 中 / 强 各跑一次，量「噪声到底降了多少」；另加两档探边界 ——
        // 48 dB 与 100 dB（`set_atten_lim(100)` 等于 `None`，完全不掺回原始含噪谱）。
        // 24 → 36 实测只多 0.3 dB，所以要分清是「模型已到头」还是「被封顶」；
        // 封顶这一决定与 0.1.56 同期，同样出自引擎跑不起来的那段时期，必须重判。
        // 中档再复跑一次并逐采样比对，把「每个任务重建模型 → 结果可复现」从口头结论
        // 升级成断言（复用同一个模型会让输出每次多漂 df_order 帧，正是 0.1.59 修的坑）。
        let presets = [
            ("轻", 12.0f32),
            ("中", 24.0),
            ("强", 36.0),
            ("极限48", 48.0),
            ("不掺回100", 100.0),
            ("中-复跑", 24.0),
        ];
        let mut outputs: Vec<(String, Vec<f32>)> = Vec::new();
        for (label, attenuation) in presets {
            // 每个任务都新建模型（生产路径同样如此，见 run_denoise_job 的注释）
            let mut model = DfTract::new(DfParams::default(), &denoise_runtime_params())
                .expect("模型加载失败");
            model.set_atten_lim(attenuation);
            model.set_pf_beta(0.0);
            model.init().expect("重置失败");
            let nb_df = model.nb_df;
            for state in &mut model.df_states {
                state.reset();
                state.init_norm_states(nb_df);
            }
            let out = enhance_samples(&mut model, &input, |_, _| true).expect("推理失败");
            let envelope_in = envelope(&input, SR);
            let envelope_out = envelope(&out, SR);

            // ① 真实滞后：先在 ±0.5 秒内粗搜（步长 1/400），再细化到 1 采样。用包络相关，
            // 避免被基音周期骗（见 envelope 的注释）。
            let mut best = (0isize, f64::MIN);
            let mut lag = -24_000isize;
            while lag <= 24_000 {
                let value = rho(&envelope_in, &envelope_out, lag, 48);
                if value > best.1 {
                    best = (lag, value);
                }
                lag += 48;
            }
            let mut refined = best;
            let mut fine = best.0 - 48;
            while fine <= best.0 + 48 {
                let value = rho(&envelope_in, &envelope_out, fine, 1);
                if value > refined.1 {
                    refined = (fine, value);
                }
                fine += 1;
            }
            // ③ 直接对比输入与输出的块电平分位数 —— 「噪声到底降了没有」最直接的读数：
            // P10 ≈ 停顿/底噪，P50 ≈ 语音常态，P90 ≈ 响亮的语音。
            // （活动/停顿分区那套在这类连续语音素材上会失效，不再用。）
            let in_levels = blocks(&input, SR);
            let out_levels = blocks(&out, SR);
            let pick = |values: &mut Vec<f32>, q: f32| -> f32 {
                values.sort_by(|a, b| a.partial_cmp(b).unwrap());
                values[((values.len() - 1) as f32 * q) as usize]
            };
            println!(
                "{label}档: 滞后 {:>6} 采样（{:>6.1} ms）ρ(0)={:.3} 最佳 ρ={:.3} | 块电平 P10 {:.1}→{:.1} P50 {:.1}→{:.1} P90 {:.1}→{:.1} dB",
                refined.0,
                refined.0 as f64 * 1000.0 / SR as f64,
                rho(&input, &out, 0, 1),
                refined.1,
                pick(&mut in_levels.clone(), 0.10),
                pick(&mut out_levels.clone(), 0.10),
                pick(&mut in_levels.clone(), 0.50),
                pick(&mut out_levels.clone(), 0.50),
                pick(&mut in_levels.clone(), 0.90),
                pick(&mut out_levels.clone(), 0.90),
            );

            // 落盘便于人耳复核
            let dir = std::env::temp_dir().join("gap-gone-dfntest");
            let _ = std::fs::create_dir_all(&dir);
            let spec = hound::WavSpec {
                channels: 1,
                sample_rate: SR as u32,
                bits_per_sample: 32,
                sample_format: hound::SampleFormat::Float,
            };
            let mut writer =
                hound::WavWriter::create(dir.join(format!("denoise-{label}.wav")), spec)
                    .expect("写 WAV 失败");
            for sample in &out {
                writer.write_sample(*sample).expect("写采样失败");
            }
            writer.finalize().expect("收尾失败");
            outputs.push((label.to_string(), out));
        }

        // 可复现性：同一档位两次必须逐采样一致（模型重建确实复位了内部的滚动缓冲）。
        let found = |name: &str| {
            outputs
                .iter()
                .find(|(label, _)| label == name)
                .map(|(_, out)| out)
        };
        if let (Some(first), Some(again)) = (found("中"), found("中-复跑")) {
            assert_eq!(first.len(), again.len(), "同一档位两次输出长度不一致");
            assert!(
                first.iter().zip(again).all(|(a, b)| a == b),
                "同一档位两次结果不一致：模型重建并没有复位滚动缓冲"
            );
            println!("可复现性：中档两次输出逐采样一致");
        }
    }
}
