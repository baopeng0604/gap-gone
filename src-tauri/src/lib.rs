use std::{
    fs::File,
    io::BufWriter,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
    time::{SystemTime, UNIX_EPOCH},
};

use cpal::{
    traits::{DeviceTrait, HostTrait, StreamTrait},
    Device, SampleFormat, Stream, StreamConfig,
};
use df::tract::{DfParams, DfTract, RuntimeParams};
use ndarray::Array2;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Default)]
struct RecordingManager {
    active: Mutex<Option<RecordingState>>,
    denoise_cancelled: AtomicBool,
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
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RecordingErrorPayload {
    message: String,
    /// 已 finalize 的部分录音文件；前端读取后进入试听，避免整段丢失。
    path: Option<String>,
}

fn input_devices() -> Result<Vec<(Device, String, bool)>, String> {
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
            let is_default = default_name.as_deref() == Some(name.as_str());
            (device, name, is_default)
        })
        .collect::<Vec<_>>())
}

#[tauri::command]
fn list_audio_input_devices() -> Result<Vec<AudioDevice>, String> {
    Ok(input_devices()?
        .into_iter()
        .map(|(_, label, is_default)| AudioDevice {
            id: label.clone(),
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
            while let Ok(command) = rx.recv() {
                match command {
                    WriterCommand::Samples(mono) => {
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
) -> impl FnMut(cpal::Error) + Send + 'static {
    move |error: cpal::Error| {
        // 音频线程上只做标记，清理交给独立线程。
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

fn temp_recording_path() -> PathBuf {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    std::env::temp_dir().join(format!("gap-gone-{timestamp}.wav"))
}

/// 校验路径必须是系统 temp 目录下的 gap-gone-* 文件，
/// 前端传来的任何读写路径都必须过这层校验，防止越权访问磁盘。
fn validate_temp_recording_path(path: &str) -> Result<PathBuf, String> {
    let candidate = PathBuf::from(path);
    let temp_dir = std::env::temp_dir();
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
    let temp_dir = std::env::temp_dir();
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
        if let Some((device, name, _)) = devices.into_iter().find(|(_, name, _)| name == id) {
            return Ok((device, name));
        }
        return Err("找不到所选录音设备".to_string());
    }
    if let Some(index) = devices.iter().position(|(_, _, is_default)| *is_default) {
        let (device, name, _) = devices.swap_remove(index);
        return Ok((device, name));
    }
    devices
        .pop()
        .map(|(device, name, _)| (device, name))
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
    let writer_tx = spawn_wav_writer(app.clone(), &path, spec, config.sample_rate)?;
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
            make_error_callback(app.clone(), Arc::clone(&errored)),
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
            make_error_callback(app.clone(), Arc::clone(&errored)),
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
            make_error_callback(app.clone(), Arc::clone(&errored)),
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
    let wav_bytes =
        std::fs::read(&input_path).map_err(|error| format!("无法读取降噪输入: {error}"))?;
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

    let attenuation = match preset.as_str() {
        "light" => 12.0,
        "strong" => 100.0,
        _ => 24.0,
    };
    let runtime = RuntimeParams::default_with_ch(1).with_atten_lim(attenuation);
    let mut model = DfTract::new(DfParams::default(), &runtime)
        .map_err(|error| format!("无法加载 DeepFilterNet3 模型: {error}"))?;
    let hop_size = model.hop_size;
    let mut enhanced = Vec::with_capacity(samples.len());

    let total_chunks = samples.chunks(hop_size).len().max(1);
    for (chunk_index, chunk) in samples.chunks(hop_size).enumerate() {
        if state.denoise_cancelled.load(Ordering::Relaxed) {
            return Err("降噪已取消".to_string());
        }
        let mut input = vec![0.0; hop_size];
        input[..chunk.len()].copy_from_slice(chunk);
        let input = Array2::from_shape_vec((1, hop_size), input)
            .map_err(|error| format!("降噪输入无效: {error}"))?;
        let mut output = Array2::<f32>::zeros((1, hop_size));
        model
            .process(input.view(), output.view_mut())
            .map_err(|error| format!("DeepFilterNet3 处理失败: {error}"))?;
        enhanced.extend(output.into_raw_vec());
        let _ = app.emit(
            "denoise-progress",
            ((chunk_index + 1) as f32 / total_chunks as f32) * 100.0,
        );
    }
    enhanced.truncate(samples.len());

    // 结果直接写到前端提供的 temp 路径，由前端读回并负责清理。
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: 48_000,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut writer = hound::WavWriter::create(&output_path, spec)
        .map_err(|error| format!("无法创建降噪结果: {error}"))?;
    for sample in enhanced {
        writer
            .write_sample((sample.clamp(-1.0, 1.0) * i16::MAX as f32).round() as i16)
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
            denoise_audio,
            cancel_denoise
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
