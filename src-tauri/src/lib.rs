use std::{
    fs::File,
    io::BufWriter,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
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
use tauri::{AppHandle, Emitter, State};

#[derive(Default)]
struct RecordingManager {
    active: Mutex<Option<RecordingState>>,
    denoise_cancelled: AtomicBool,
}

struct RecordingState {
    stream: Stream,
    writer: Arc<Mutex<Option<hound::WavWriter<BufWriter<File>>>>>,
    path: PathBuf,
    paused: bool,
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

fn write_level(app: &AppHandle, samples: &[f32]) {
    if samples.is_empty() {
        return;
    }
    let mut sum = 0.0;
    let mut peak: f32 = 0.0;
    for sample in samples {
        sum += sample * sample;
        peak = peak.max(sample.abs());
    }
    let _ = app.emit(
        "recording-level",
        RecordingLevel {
            rms: (sum / samples.len() as f32).sqrt().min(1.0),
            peak: peak.min(1.0),
        },
    );
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

fn write_mono_block(
    app: &AppHandle,
    writer: &Arc<Mutex<Option<hound::WavWriter<BufWriter<File>>>>>,
    mono: &[f32],
) {
    write_level(app, mono);
    if let Ok(mut guard) = writer.lock() {
        if let Some(writer) = guard.as_mut() {
            for sample in mono {
                let value = (*sample * i16::MAX as f32)
                    .clamp(i16::MIN as f32, i16::MAX as f32) as i16;
                let _ = writer.write_sample(value);
            }
        }
    }
}

fn temp_recording_path() -> PathBuf {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    std::env::temp_dir().join(format!("gap-gone-{timestamp}.wav"))
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
    if active.is_some() {
        return Err("已经有录音正在进行".to_string());
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
    let writer = Arc::new(Mutex::new(Some(
        hound::WavWriter::create(&path, spec)
            .map_err(|error| format!("无法创建临时录音文件: {error}"))?,
    )));
    let callback_writer = Arc::clone(&writer);
    let callback_app = app.clone();
    let make_error_callback = || {
        let error_app = app.clone();
        move |error: cpal::Error| {
            let _ = error_app.emit("recording-error", error.to_string());
        }
    };

    let stream = match sample_format {
        SampleFormat::F32 => device.build_input_stream(
            config.clone(),
            move |data: &[f32], _| {
                let mono = downmix_to_mono(data, channels);
                write_mono_block(&callback_app, &callback_writer, &mono);
            },
            make_error_callback(),
            None,
        ),
        SampleFormat::I16 => {
            let callback_writer = Arc::clone(&writer);
            let callback_app = app.clone();
            device.build_input_stream(
                config.clone(),
                move |data: &[i16], _| {
                    let samples: Vec<f32> = data
                        .iter()
                        .map(|sample| *sample as f32 / i16::MAX as f32)
                        .collect();
                    let mono = downmix_to_mono(&samples, channels);
                    write_mono_block(&callback_app, &callback_writer, &mono);
                },
                make_error_callback(),
                None,
            )
        }
        SampleFormat::U16 => {
            let callback_writer = Arc::clone(&writer);
            let callback_app = app.clone();
            device.build_input_stream(
                config.clone(),
                move |data: &[u16], _| {
                    let samples: Vec<f32> = data
                        .iter()
                        .map(|sample| *sample as f32 / 32768.0 - 1.0)
                        .collect();
                    let mono = downmix_to_mono(&samples, channels);
                    write_mono_block(&callback_app, &callback_writer, &mono);
                },
                make_error_callback(),
                None,
            )
        }
        other => return Err(format!("暂不支持录音格式 {other:?}")),
    }
    .map_err(|error| format!("无法启动录音流: {error}"))?;

    stream
        .play()
        .map_err(|error| format!("无法播放录音流: {error}"))?;
    *active = Some(RecordingState {
        stream,
        writer,
        path: path.clone(),
        paused: false,
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
    drop(recording.stream);
    let path = recording.path.clone();
    let writer = recording
        .writer
        .lock()
        .map_err(|_| "录音文件不可用".to_string())?
        .take()
        .ok_or_else(|| "录音文件已经关闭".to_string())?;
    writer
        .finalize()
        .map_err(|error| format!("无法完成录音文件: {error}"))?;
    Ok(path.to_string_lossy().to_string())
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
        let _ = std::fs::remove_file(recording.path);
    } else if let Some(path) = path {
        let _ = remove_recording_file(&path);
    }
    Ok(())
}

fn remove_recording_file(path: &str) -> Result<(), String> {
    let candidate = PathBuf::from(path);
    let temp_dir = std::env::temp_dir();
    let file_name = candidate
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "录音文件路径无效".to_string())?;
    if !file_name.starts_with("gap-gone-") || candidate.parent() != Some(temp_dir.as_path()) {
        return Err("只能访问 Gap Gone 临时录音文件".to_string());
    }
    std::fs::remove_file(candidate).map_err(|error| format!("无法删除临时录音: {error}"))
}

#[tauri::command]
fn read_recording(path: String) -> Result<Vec<u8>, String> {
    let candidate = PathBuf::from(&path);
    let temp_dir = std::env::temp_dir();
    let file_name = candidate
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "录音文件路径无效".to_string())?;
    if !file_name.starts_with("gap-gone-") || candidate.parent() != Some(temp_dir.as_path()) {
        return Err("只能读取 Gap Gone 临时录音文件".to_string());
    }
    std::fs::read(candidate).map_err(|error| format!("无法读取录音文件: {error}"))
}

#[tauri::command]
fn delete_recording_file(path: String) -> Result<(), String> {
    remove_recording_file(&path)
}

#[tauri::command]
fn denoise_audio(
    app: AppHandle,
    state: State<'_, RecordingManager>,
    wav_bytes: Vec<u8>,
    preset: String,
) -> Result<Vec<u8>, String> {
    state.denoise_cancelled.store(false, Ordering::Relaxed);
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

    let output_path = temp_recording_path().with_file_name("gap-gone-denoised.wav");
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
    let result = std::fs::read(&output_path).map_err(|error| format!("无法读取降噪结果: {error}"));
    let _ = std::fs::remove_file(output_path);
    result
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
            read_recording,
            delete_recording_file,
            denoise_audio,
            cancel_denoise
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
