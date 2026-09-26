// 视频支持：ffmpeg 侧车（sidecar）调用。
// 不打包 ffmpeg、不引入 ffmpeg-next 等重编译依赖，纯 std::process::Command；
// 媒体数据全程「文件落盘 + 路径传参」，绝不经 IPC 传输字节。
// 导入链路：probe_video 校验 → extract_video_audio 抽源格式音轨（前端解码进现有编辑管线）。
// 导出链路：每个保留区间切独立片段 → concat demuxer 拼接。
//
// 三条踩过坑的接线（改动前先看，详见 AGENTS.md 硬约束 19）：
// 1. **绝不要加 `-avoid_negative_ts make_zero`**。输入侧 `-ss` 会把请求点之前的内容一起读进来
//    （时间戳为负，用来当解码参考帧），而 make_zero 会把这些 pre-roll「扶正」保留下来 ——
//    等效于把切点拉回文件开头：实测请求 [5.000, 8.000] 切出的是 [0, 8.000]（首帧与源 0 秒
//    那一帧逐像素一致）。去掉它，muxer 只保留负时间戳之后的包，呈现起点才等于请求点。
// 2. **无损快速档（fastcopy）只能从关键帧起切，且必须用输出侧 `-ss`**（放在 `-i` 之后）：
//    输出侧 seek 会把关键帧之前的 pre-roll 丢掉，产出体积 = 真实时长、时间轴连续，concat 才
//    干净；输入侧 seek 虽能对齐呈现，但每段会把「到上一个关键帧为止」的数据整段写进文件
//    （实测 3 秒的段装进了 240 个包 / 6.33 MB），而 concat demuxer 不认 edit list，会把
//    pre-roll 一起拼进去，产出时间轴重叠的垃圾。切点吸附本身由前端按关键帧列表算好再传进来。
// 3. 抽音轨必须写 32-bit float WAV：口播有效电平常在 −30 dBFS，16-bit 下底噪那段只剩个位数
//    bit，而降噪模型的抑制决策正依赖对底噪的准确估计（见 AGENTS.md 硬约束 3）。
// 4. **切片过渡（精确编码档）也走「逐段 + concat」**：每个接缝单独产一段交叉溶解
//    （前段主体尾 t 秒 与 后段主体头 t 秒，画面 `xfade`，输出 t 秒），与普通段一起交给
//    concat。这与「对整段跑一次 xfade(offset = 前段时长 − t)」等价，但复用了同一条链路。
//    三个必须记住的点：① 过渡段要**显式给 `fps=<源帧率>`**，xfade 不收帧率未知的输入
//    （报 `current rate of 1/0 is invalid`）；② 编码参数必须与普通段**逐项一致**
//    （libx264 veryfast crf 20 yuv420p + aac 同码率），否则 concat 拼不上；
//    ③ **音频不要用 `acrossfade`** —— 它在 0.3 秒级的短窗口上偶发一帧都不输出，下游 aac
//    报 `Could not open encoder before EOF` 整次导出失败（改用 `concat` 硬拼接两段 d/2
//    窗口 + 两端 5 ms 微淡）。滤镜参数还要用具名写法（`settb=tb=` 等），位置写法只有
//    ffmpeg 7.0+ 认。重叠式溶解会让成片比硬切**短 Σt**，前端据此重映射字幕。

use std::{
    io::{BufRead, BufReader, Read},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{SystemTime, UNIX_EPOCH},
};

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::{gap_gone_temp_dir, validate_temp_recording_path};

/// 视频导出期间的共享状态：当前 ffmpeg 子进程（供取消 kill）与取消标记。
#[derive(Default)]
pub(crate) struct VideoExportManager {
    child: Arc<Mutex<Option<Child>>>,
    cancelled: Arc<AtomicBool>,
    running: AtomicBool,
}

/// 导出/清理失败的临时文件守卫：无论成功、失败还是取消，离开作用域即删除。
struct TempGuard(Vec<PathBuf>);

impl TempGuard {
    fn track(&mut self, path: PathBuf) {
        self.0.push(path);
    }
}

impl Drop for TempGuard {
    fn drop(&mut self) {
        for path in &self.0 {
            let _ = std::fs::remove_file(path);
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FfmpegInfo {
    found: bool,
    path: Option<String>,
    version: Option<String>,
    /// 该构建是否带 libx264（精确重编码档的唯一依赖）。
    /// 系统里常有多份 ffmpeg（应用自带的精简构建），带不带它决定能不能重编码，
    /// 前端据此禁用/提示，不要等到导出时才报 Unknown encoder。
    has_libx264: bool,
    /// 该构建是否带 `xfade` 滤镜（切片过渡的唯一依赖）。精简构建可能没有它，
    /// 前端据此禁用「切片过渡」而不是等导出时报 `Filter not found`。
    has_xfade: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VideoProbe {
    duration: f64,
    width: u32,
    height: u32,
    video_codec: String,
    audio_codec: String,
    sample_rate: u32,
    channels: u16,
    /// 原音轨码率（bps）。回写 AAC 时码率下限不低于它。
    audio_bitrate: Option<u32>,
    /// 画面是否带旋转元数据（手机竖拍常见）。
    /// 它不再是拒绝导入的理由：copy 会保留元数据、重编码由 ffmpeg 的 autorotate 把旋转
    /// 烘进像素，两条路的方向都对。但它会让「无损快速」档被禁用 —— 因为 concat 不保证
    /// 把 display matrix 带进成片，由前端判定后强制走重编码。
    rotated: bool,
    /// 视频是否含 B 帧（`has_b_frames > 0`）。有 B 帧就必须禁用「无损快速」：
    /// 输出侧 `-ss` 按 dts 丢包，而 B 帧重排让每个关键帧的 dts 比 pts 早若干帧，
    /// 目标点落在关键帧 pts 上时关键帧自己会被丢掉 → ffmpeg 等下一个关键帧 →
    /// **整段丢掉一个 GOP 的画面**（实测 1 秒关键帧的素材：请求 5 秒只拿到 122 帧 / 5.067 秒，
    /// 首包 pts=1.000；输入侧 seek 虽有完整帧，但带 pre-roll 的段经 concat demuxer 会报
    /// `non monotonically increasing dts`）。无 B 帧的流 dts=pts，一切正常。
    has_b_frames: bool,
    /// 源视频帧率的原始分数串（ffprobe 的 `r_frame_rate`，如 "30/1"、"30000/1001"）。
    /// 精确编码档做切片过渡时 `xfade` 要求显式帧率（不给会报
    /// `The inputs needs to be a constant frame rate; current rate of 1/0 is invalid`），
    /// 前端也用它把过渡时长换算成整数帧。
    fps: String,
    /// 视频关键帧时间戳（秒，升序，保留 ffprobe 的原始精度）。
    /// 无损快速档只能在关键帧上切，前端用它算出吸附后的切点并如实告知偏移量。
    /// **不要四舍五入**：关键帧 16.666667 写成 16.667 就会让 seek 越过它、整段没有画面。
    keyframes: Vec<f64>,
}

fn ffmpeg_command(program: &str) -> Command {
    let mut command = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW：release 版每次调 ffmpeg 不闪控制台黑窗
        command.creation_flags(0x0800_0000);
    }
    command
}

fn timestamp_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn truncate(text: &str, max_chars: usize) -> String {
    let trimmed = text.trim();
    if trimmed.chars().count() <= max_chars {
        trimmed.to_string()
    } else {
        format!("{}…", trimmed.chars().take(max_chars).collect::<String>())
    }
}

/// 保留**末尾**的截断。ffmpeg 的报错永远在最后几行，而 `Input #0 … Duration …` 这类
/// 输入信息在最前面 —— 用 `truncate` 截头会让真正的错误整段丢掉（线上就是这么丢的：
/// 用户看到的报错只有输入横幅，查不到原因）。
fn truncate_tail(text: &str, max_chars: usize) -> String {
    let trimmed = text.trim();
    if trimmed.chars().count() <= max_chars {
        return trimmed.to_string();
    }
    let tail: String = trimmed
        .chars()
        .rev()
        .take(max_chars)
        .collect::<String>()
        .chars()
        .rev()
        .collect();
    format!("…{tail}")
}

/// 统一的终端日志。`pnpm tauri dev` 的那个终端窗口是排查的第一现场：错误只 return 给前端时，
/// 终端上一片安静，出问题只能靠界面里那行 toast（而 toast 只有 300 字符、还会被用户关掉）。
/// 前缀统一成 `[gap-gone][阶段][级别]`，方便在混杂的输出里过滤。debug 构建带 console、
/// release 不带（见 main.rs 的 `windows_subsystem`），所以这里不必按构建类型分叉。
fn log_line(level: &str, stage: &str, message: &str) {
    eprintln!("[gap-gone][{stage}][{level}] {message}");
}

/// 关键步骤的选路信息（选中了哪份 ffmpeg、按哪个档位导出）：**不是错误**，
/// 但出问题时第一批要看的就是它。
fn log_info(stage: &str, message: &str) {
    log_line("info", stage, message);
}

fn log_error(stage: &str, message: &str) {
    log_line("error", stage, message);
}

/// 「打日志 + 返回同一个错误」。命令里每个非 ffmpeg 的失败分支都走它，
/// 免得漏掉某一条路径之后又出现「终端上什么都没有」。
fn fail<T>(stage: &str, message: String) -> Result<T, String> {
    log_error(stage, &message);
    Err(message)
}

/// 「校验前端传来的临时文件路径 + 失败打日志」。
/// 这条校验失败会直接否掉整次导出（例如权限/前缀不符），必须能在终端看到。
fn validate_temp_path(stage: &str, path: &str) -> Result<PathBuf, String> {
    validate_temp_recording_path(path).map_err(|error| {
        log_error(stage, &error);
        error
    })
}

/// 把命令行还原成可直接复制粘贴重跑的一行 —— 这条命令能手工复现问题，
/// 比任何转述都有用（关键帧/seek 那批坑都是这么定位的）。
fn format_command(program: &str, args: &[String]) -> String {
    let mut line = program.to_string();
    for arg in args {
        line.push(' ');
        if arg.contains(' ') || arg.contains('"') {
            line.push('"');
            line.push_str(arg);
            line.push('"');
        } else {
            line.push_str(arg);
        }
    }
    line
}

/// ffmpeg/ffprobe 失败时的统一日志：命令 + stderr 末尾（不截断到 300 —— 那是给界面看的，
/// 终端里给全一点，省得为了看报错再去翻临时文件）。
fn log_command_failure(stage: &str, program: &str, args: &[String], stderr: &str) {
    log_error(
        stage,
        &format!(
            "命令失败：\n  {}\n  stderr 末尾：\n{}",
            format_command(program, args),
            truncate_tail(stderr, 2000)
        ),
    );
}

fn verify_ffmpeg(path: &Path) -> Option<String> {
    let output = ffmpeg_command(&path.to_string_lossy())
        .arg("-version")
        .stdin(Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let first = text.lines().next()?.trim().to_string();
    if first.contains("ffmpeg version") {
        Some(first)
    } else {
        None
    }
}

/// 该构建是否带指定编码器。系统里常有多份 ffmpeg（应用自带的精简构建往往没有 libx264），
/// 探测时必须把它们区分开，否则精确重编码档会在导出时直接报 `Unknown encoder 'libx264'`。
fn has_encoder(path: &Path, name: &str) -> bool {
    let Ok(output) = ffmpeg_command(&path.to_string_lossy())
        .args(["-hide_banner", "-encoders"])
        .stdin(Stdio::null())
        .output()
    else {
        return false;
    };
    String::from_utf8_lossy(&output.stdout).contains(name)
}

/// 该构建是否带指定滤镜。切片过渡依赖 `xfade`（交叉溶解）—— 实测有些精简构建
/// （例如某编辑器自带的 6.1.1）连 `xfade` 都没有，选中它时过渡会在导出时才报
/// `Filter not found`。和 libx264 一样提前探测，前端据此禁用过渡。
fn has_filter(path: &Path, name: &str) -> bool {
    let Ok(output) = ffmpeg_command(&path.to_string_lossy())
        .args(["-hide_banner", "-filters"])
        .stdin(Stdio::null())
        .output()
    else {
        return false;
    };
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .any(|line| line.split_whitespace().any(|token| token == name))
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
}

/// PATH 各目录 + 常见安装位（winget/scoop/choco/brew 等）。
fn binary_candidates(name: &str) -> Vec<PathBuf> {
    let exe = if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    };
    let mut candidates = Vec::new();
    if let Some(path_var) = std::env::var_os("PATH") {
        candidates.extend(std::env::split_paths(&path_var).map(|dir| dir.join(&exe)));
    }
    if cfg!(windows) {
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            candidates.push(
                PathBuf::from(&local)
                    .join(r"Microsoft\WinGet\Links")
                    .join(&exe),
            );
        }
        if let Some(home) = home_dir() {
            candidates.push(home.join(r"scoop\shims").join(&exe));
        }
        candidates.push(PathBuf::from(r"C:\ProgramData\chocolatey\bin").join(&exe));
        candidates.push(PathBuf::from(r"C:\ffmpeg\bin").join(&exe));
    }
    if cfg!(target_os = "macos") {
        candidates.push(PathBuf::from("/opt/homebrew/bin").join(&exe));
        candidates.push(PathBuf::from("/usr/local/bin").join(&exe));
    }
    candidates
}

/// 探测系统 ffmpeg。custom_path（用户手动指定）优先并验证可运行。
/// 自动模式在候选里**优先选带 libx264 的那一份**：PATH 前面常是某个应用自带的精简
/// 构建（实测：Krita 自带的那份既没有 libx264 也没有 lavfi），选中它会让精确重编码档报
/// `Unknown encoder 'libx264'`，而用户明明装了完整版却查不出原因。
#[tauri::command]
pub(crate) async fn detect_ffmpeg(custom_path: Option<String>) -> Result<FfmpegInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(custom) = custom_path {
            let path = PathBuf::from(&custom);
            return match verify_ffmpeg(&path) {
                Some(version) => {
                    log_info("ffmpeg", &format!("使用指定路径：{custom}（{version}）"));
                    FfmpegInfo {
                        found: true,
                        path: Some(custom),
                        version: Some(version),
                        has_libx264: has_encoder(&path, "libx264"),
                        has_xfade: has_filter(&path, "xfade"),
                    }
                }
                None => {
                    log_error("ffmpeg", &format!("指定路径不可用：{custom}"));
                    not_found_ffmpeg()
                }
            };
        }
        let mut fallback: Option<FfmpegInfo> = None;
        for candidate in binary_candidates("ffmpeg") {
            if !candidate.is_file() {
                continue;
            }
            let Some(version) = verify_ffmpeg(&candidate) else {
                continue;
            };
            let has_libx264 = has_encoder(&candidate, "libx264");
            let info = FfmpegInfo {
                found: true,
                path: Some(candidate.to_string_lossy().to_string()),
                version: Some(version),
                has_libx264,
                has_xfade: has_filter(&candidate, "xfade"),
            };
            if has_libx264 {
                log_info(
                    "ffmpeg",
                    &format!("自动探测选中：{}", candidate.to_string_lossy()),
                );
                return info;
            }
            if fallback.is_none() {
                fallback = Some(info);
            }
        }
        match &fallback {
            Some(info) => log_error(
                "ffmpeg",
                &format!(
                    "自动探测只找到不带 libx264 的构建：{}（精确编码不可用）",
                    info.path.as_deref().unwrap_or("?")
                ),
            ),
            None => log_error("ffmpeg", "自动探测未找到任何可用的 ffmpeg"),
        }
        fallback.unwrap_or_else(not_found_ffmpeg)
    })
    .await
    .map_err(|_| "ffmpeg 探测线程异常退出".to_string())
}

fn not_found_ffmpeg() -> FfmpegInfo {
    FfmpegInfo {
        found: false,
        path: None,
        version: None,
        has_libx264: false,
        has_xfade: false,
    }
}

/// 找到可用的 ffprobe：优先与 ffmpeg 同目录，其次按 PATH / 常见安装位搜一遍。
/// 不能只认「同目录」—— 有的发行包只把 ffmpeg.exe 链进 PATH，同目录下没有 ffprobe，
/// 那会让整个视频流程报「不支持的视频」，把安装问题误报成格式问题。
fn ffprobe_path(ffmpeg: &str) -> Result<PathBuf, String> {
    let missing = || {
        "未找到 ffprobe：请安装包含 ffprobe 的完整 ffmpeg（winget / brew / scoop 均默认成对安装）"
            .to_string()
    };
    let beside_ffmpeg = PathBuf::from(ffmpeg)
        .parent()
        .map(|dir| dir.join(if cfg!(windows) { "ffprobe.exe" } else { "ffprobe" }))
        .filter(|path| path.is_file());
    if let Some(path) = beside_ffmpeg {
        return Ok(path);
    }
    for candidate in binary_candidates("ffprobe") {
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    Err(missing())
}

/// ffprobe 的 num/den 帧率字符串转 f64。
fn parse_rate(rate: &str) -> Option<f64> {
    let (num, den) = rate.split_once('/')?;
    let num: f64 = num.trim().parse().ok()?;
    let den: f64 = den.trim().parse().ok()?;
    if den <= 0.0 {
        return None;
    }
    Some(num / den)
}

fn stream_start_time(stream: &Value) -> f64 {
    stream["start_time"]
        .as_str()
        .and_then(|time| time.parse::<f64>().ok())
        .filter(|time| time.is_finite())
        .unwrap_or(0.0)
}

fn parse_video_probe(value: &Value) -> Result<VideoProbe, String> {
    let streams = value["streams"].as_array().cloned().unwrap_or_default();
    let video_streams: Vec<&Value> = streams
        .iter()
        .filter(|stream| {
            stream["codec_type"].as_str() == Some("video")
                && stream["disposition"]["attached_pic"].as_i64() != Some(1)
        })
        .collect();
    let audio_streams: Vec<&Value> = streams
        .iter()
        .filter(|stream| stream["codec_type"].as_str() == Some("audio"))
        .collect();

    if video_streams.is_empty() {
        return Err("该文件没有视频轨".to_string());
    }
    if video_streams.len() > 1 {
        return Err("多视频轨的视频暂不支持".to_string());
    }
    if audio_streams.is_empty() {
        return Err("该视频没有音轨，无法进入音频编辑流程".to_string());
    }
    if audio_streams.len() > 1 {
        return Err("多音轨视频暂不支持".to_string());
    }

    let video = video_streams[0];
    let audio = audio_streams[0];
    let video_codec = video["codec_name"].as_str().unwrap_or("unknown").to_string();

    // 旋转元数据（手机竖拍）：允许导入，但会让「无损快速」档被禁用（前端判定）。
    // copy 会保留 display matrix、重编码由 autorotate 把旋转烘进像素，方向都不会错。
    let rotated_by_side_data = video["side_data_list"].as_array().is_some_and(|entries| {
        entries.iter().any(|entry| {
            entry["rotation"]
                .as_f64()
                .is_some_and(|rotation| rotation.abs() > 0.01)
        })
    });
    let rotated_by_tag = video["tags"]["rotate"]
        .as_str()
        .and_then(|rotate| rotate.parse::<f64>().ok())
        .is_some_and(|rotation| rotation.abs() > 0.01);
    let rotated = rotated_by_side_data || rotated_by_tag;
    // B 帧：有它就不能走「无损快速」（原因见 VideoProbe.has_b_frames 的注释）
    let has_b_frames = video["has_b_frames"].as_i64().unwrap_or(0) > 0;

    // 变帧率：r_frame_rate 与 avg_frame_rate 差异过大视为 VFR。
    // NTSC 惯用的 30 vs 29.97 只差 0.1%，1.5 倍容差不会误伤。
    let base_rate = video["r_frame_rate"].as_str().and_then(parse_rate);
    let average_rate = video["avg_frame_rate"].as_str().and_then(parse_rate);
    if let (Some(base), Some(average)) = (base_rate, average_rate) {
        if base > 0.0 && average > 0.0 && (base / average > 1.5 || average / base > 1.5) {
            return Err("变帧率视频暂不支持".to_string());
        }
    }
    // 帧率的原始分数串原样带上（"30/1"、"30000/1001"）：xfade 要求显式帧率，
    // 前端也用它把过渡时长换算成整数帧。取不到就退回 r_frame_rate 的解析值。
    let fps = video["r_frame_rate"]
        .as_str()
        .filter(|rate| rate.contains('/'))
        .map(str::to_string)
        .or_else(|| base_rate.map(|rate| format!("{rate:.6}")))
        .unwrap_or_else(|| "30".to_string());

    // 音轨与画面起点不一致（例如音轨比画面晚 0.5 s）时，抽出的音轨会从 0 起算，
    // 编辑期与导出的画面就对不上。亚帧级差异（AAC 预卷等）在 50 ms 内，放行。
    let start_offset = (stream_start_time(audio) - stream_start_time(video)).abs();
    if start_offset > 0.05 {
        return Err(format!(
            "该视频的音轨与画面起点相差 {:.2} 秒，首版不支持，请先用 ffmpeg 对齐后再导入",
            start_offset
        ));
    }

    let duration = value["format"]["duration"]
        .as_str()
        .and_then(|duration| duration.parse::<f64>().ok())
        .or_else(|| video["duration"].as_str().and_then(|d| d.parse::<f64>().ok()))
        .ok_or_else(|| "无法读取视频时长".to_string())?;
    if !duration.is_finite() || duration <= 0.0 {
        return Err("视频时长无效".to_string());
    }

    Ok(VideoProbe {
        duration,
        width: video["width"].as_u64().unwrap_or(0) as u32,
        height: video["height"].as_u64().unwrap_or(0) as u32,
        video_codec,
        audio_codec: audio["codec_name"].as_str().unwrap_or("unknown").to_string(),
        sample_rate: audio["sample_rate"]
            .as_str()
            .and_then(|rate| rate.parse().ok())
            .unwrap_or(0),
        channels: audio["channels"].as_u64().unwrap_or(0) as u16,
        audio_bitrate: audio["bit_rate"].as_str().and_then(|rate| rate.parse().ok()),
        rotated,
        has_b_frames,
        fps,
        // 关键帧由 probe_video 追加（多跑一次 ffprobe，见 video_keyframes）
        keyframes: Vec::new(),
    })
}

/// 视频关键帧时间戳（秒，升序）。`-skip_frame nokey` 让解码器只输出关键帧，
/// 比扫全部 packet 便宜，也不受 fragmented MP4（OBS 默认写的碎片 MP4，没有 stss 表）
/// 的 packet 标记影响。**原样保留 ffprobe 给的精度**，不要在这里四舍五入。
fn video_keyframes(ffprobe: &Path, path: &str) -> Result<Vec<f64>, String> {
    let output = ffmpeg_command(&ffprobe.to_string_lossy())
        .args([
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-skip_frame",
            "nokey",
            "-show_entries",
            "frame=pts_time",
            "-of",
            "csv=p=0",
        ])
        .arg(path)
        .stdin(Stdio::null())
        .output()
        .map_err(|error| format!("无法启动 ffprobe: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "读取关键帧失败: {}",
            truncate(&String::from_utf8_lossy(&output.stderr), 200)
        ));
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let mut keyframes: Vec<f64> = text
        .split_whitespace()
        .filter_map(|token| token.trim_end_matches(',').parse::<f64>().ok())
        .filter(|time| time.is_finite() && *time >= 0.0)
        .collect();
    keyframes.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    keyframes.dedup();
    if keyframes.is_empty() {
        // 一个关键帧都读不到时退回「整段起点」：前端会认为切点都不在关键帧上，
        // 从而把无损快速档判为不可用，而不是给出错误的吸附结果。
        keyframes.push(0.0);
    }
    Ok(keyframes)
}

/// 探测视频（时长 / 分辨率 / 编码 / 音轨 / 关键帧），并做边界校验：
/// 无音轨、多音轨、变帧率、音画起点不一致一律拒绝导入。
/// **HEVC 与带旋转元数据的素材允许导入**（2026-09-26 实测后放开）：它们不能走
/// 「无损快速」（HEVC 上输出侧 seek 会静默丢帧、concat 也可能丢掉 display matrix），
/// 由前端据 `video_codec` / `rotated` 强制改用精确重编码（HEVC 输出 H.264）。
#[tauri::command]
pub(crate) async fn probe_video(ffmpeg: String, path: String) -> Result<VideoProbe, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let result = probe_video_inner(&ffmpeg, &path);
        if let Err(error) = &result {
            // 「不支持该视频」的那几种拒绝理由也要打到终端：分类是代码判的，
            // 光看界面提示分不清是格式问题还是 ffprobe 缺失
            log_error("视频探测", error);
        }
        result
    })
    .await
    .map_err(|_| "视频探测线程异常退出".to_string())?
}

fn probe_video_inner(ffmpeg: &str, path: &str) -> Result<VideoProbe, String> {
    let candidate = PathBuf::from(path);
    if !candidate.is_file() {
        return Err("找不到视频文件".to_string());
    }
    let ffprobe = ffprobe_path(ffmpeg)?;
    let args: Vec<String> = vec![
        "-v".into(),
        "error".into(),
        "-print_format".into(),
        "json".into(),
        "-show_format".into(),
        "-show_streams".into(),
        path.to_string(),
    ];
    let program = ffprobe.to_string_lossy().to_string();
    let output = ffmpeg_command(&program)
        .args(&args)
        .stdin(Stdio::null())
        .output()
        .map_err(|error| format!("无法启动 ffprobe: {error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        log_command_failure("视频探测", &program, &args, &stderr);
        return Err(format!("视频探测失败: {}", truncate(&stderr, 300)));
    }
    let value: Value = serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("无法解析视频信息: {error}"))?;
    let mut probe = parse_video_probe(&value)?;
    probe.keyframes = video_keyframes(&ffprobe, path)?;
    Ok(probe)
}

/// 抽出视频音轨为临时 WAV（32-bit float）。
/// 采样率与声道数**保持源文件的原始格式**——编辑期听到的就是原声，转换只在
/// 需要时（降噪）由前端 noiseReduction 的 renderBuffer 自己做，不在这里加 -ac / -ar。
/// 位深不能退回 16-bit：见文件头注释第 2 条。
/// 进度事件 `video-extract-progress`：payload = 当前秒数（f32），
/// 前端用 probe 拿到的总时长换算百分比。
#[tauri::command]
pub(crate) async fn extract_video_audio(
    app: AppHandle,
    ffmpeg: String,
    video_path: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let candidate = PathBuf::from(&video_path);
        if !candidate.is_file() {
            return Err("找不到视频文件".to_string());
        }
        let temp_dir = gap_gone_temp_dir();
        let _ = std::fs::create_dir_all(&temp_dir);
        let wav = temp_dir.join(format!("gap-gone-video-audio-{}.wav", timestamp_ms()));

        // -progress pipe:1 输出逐行进度，-nostats 关闭统计行
        let args: Vec<String> = vec![
            "-y".into(),
            "-hide_banner".into(),
            "-loglevel".into(),
            "error".into(),
            "-progress".into(),
            "pipe:1".into(),
            "-nostats".into(),
            "-nostdin".into(),
            "-i".into(),
            video_path.clone(),
            "-vn".into(),
            "-map".into(),
            "0:a:0".into(),
            "-c:a".into(),
            "pcm_f32le".into(),
            wav.to_string_lossy().to_string(),
        ];
        let mut child = ffmpeg_command(&ffmpeg)
            .args(&args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| format!("无法启动 ffmpeg: {error}"))?;

        let stdout = child.stdout.take();
        // stderr 单独线程排空，防止管道写满 64KB 与 stdout 死锁
        let stderr = child.stderr.take();
        let stderr_pump = std::thread::spawn(move || {
            let mut buf = Vec::new();
            if let Some(mut s) = stderr {
                let _ = s.read_to_end(&mut buf);
            }
            buf
        });

        // 逐行读取 ffmpeg 进度，实时 emit 给前端
        if let Some(stdout) = stdout {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                if let Some(value) = line.strip_prefix("out_time_ms=") {
                    if let Ok(micros) = value.trim().parse::<f64>() {
                        let seconds = (micros / 1_000_000.0).max(0.0) as f32;
                        let _ = app.emit("video-extract-progress", seconds);
                    }
                }
            }
        }

        let status = child
            .wait()
            .map_err(|error| format!("无法等待 ffmpeg 退出: {error}"))?;

        if !status.success() {
            let _ = std::fs::remove_file(&wav);
            let stderr_text = stderr_pump.join().unwrap_or_default();
            let stderr_text = String::from_utf8_lossy(&stderr_text).to_string();
            log_command_failure("抽取音轨", &ffmpeg, &args, &stderr_text);
            return Err(format!("抽取音轨失败: {}", truncate(&stderr_text, 300)));
        }
        if !wav.is_file() || std::fs::metadata(&wav).map(|m| m.len()).unwrap_or(0) == 0 {
            let _ = std::fs::remove_file(&wav);
            log_error("抽取音轨", "ffmpeg 没有产出音频文件");
            return Err("抽取音轨失败：ffmpeg 没有产出音频文件".to_string());
        }
        Ok(wav.to_string_lossy().to_string())
    })
    .await
    .map_err(|_| "抽音轨线程异常退出".to_string())?
}

/// 生成处理后音轨的临时落盘路径（前端 buildExportBuffer + bufferToWav 写入，
/// export_video 读取），保证落在 gap-gone 临时目录且过路径校验。
#[tauri::command]
pub(crate) fn prepare_video_export_audio() -> String {
    let temp_dir = gap_gone_temp_dir();
    let _ = std::fs::create_dir_all(&temp_dir);
    temp_dir
        .join(format!("gap-gone-video-export-audio-{}.wav", timestamp_ms()))
        .to_string_lossy()
        .to_string()
}

/// 生成「成片时间轴的字幕」临时落盘路径：前端把重映射后的 SRT 文本写进去，
/// export_video 在视频导出成功后复制到成片旁边。走临时文件而不是直接写目标目录，
/// 是因为目标目录的 fs 权限只覆盖用户刚选中的那个文件。
#[tauri::command]
pub(crate) fn prepare_video_export_subtitles() -> String {
    let temp_dir = gap_gone_temp_dir();
    let _ = std::fs::create_dir_all(&temp_dir);
    temp_dir
        .join(format!(
            "gap-gone-video-export-subtitle-{}.srt",
            timestamp_ms()
        ))
        .to_string_lossy()
        .to_string()
}

/// 放行单个视频文件给前端 asset 协议（`<video>` 预览用）。
/// assetProtocol 的静态 scope 是空的：整机文件不开放，只放行用户当前导入的这一个，
/// 换素材或关闭视频时由前端调 forbid_video_asset 收回。
#[tauri::command]
pub(crate) fn allow_video_asset(app: AppHandle, path: String) -> Result<(), String> {
    let candidate = PathBuf::from(&path);
    if !candidate.is_file() {
        return Err("找不到视频文件".to_string());
    }
    app.asset_protocol_scope()
        .allow_file(&candidate)
        .map_err(|error| format!("无法放行视频预览: {error}"))
}

#[tauri::command]
pub(crate) fn forbid_video_asset(app: AppHandle, path: String) {
    let _ = app.asset_protocol_scope().forbid_file(PathBuf::from(&path));
}

fn emit_progress(app: &AppHandle, percent: f32) {
    let _ = app.emit("video-export-progress", percent);
}

/// 某个片段里的视频包数（只数包、不解码）。0 表示这一段没有任何画面 ——
/// 无损快速档的 `-ss` 一旦越过关键帧，切出来的就是这种空段。
fn segment_video_packets(ffprobe: &Path, path: &Path) -> u64 {
    let Ok(output) = ffmpeg_command(&ffprobe.to_string_lossy())
        .args([
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-count_packets",
            "-show_entries",
            "stream=nb_read_packets",
            "-of",
            "csv=p=0",
        ])
        .arg(path)
        .stdin(Stdio::null())
        .output()
    else {
        return 0;
    };
    String::from_utf8_lossy(&output.stdout)
        .split_whitespace()
        .filter_map(|token| token.trim_end_matches(',').parse::<u64>().ok())
        .sum()
}

/// 容器时长（秒）。读不到就返回 None —— 读不到时不做判定，不要误拦正常导出。
fn media_duration(ffprobe: &Path, path: &Path) -> Option<f64> {
    let output = ffmpeg_command(&ffprobe.to_string_lossy())
        .args([
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "csv=p=0",
        ])
        .arg(path)
        .stdin(Stdio::null())
        .output()
        .ok()?;
    String::from_utf8_lossy(&output.stdout)
        .trim()
        .parse::<f64>()
        .ok()
}

/// 运行一条 ffmpeg 命令：进度经 -progress pipe:1 换算成全局百分比发事件。
/// 取消 = cancel_video_export 置标记并 kill 子进程 → 管道 EOF → wait 返回。
/// map_progress 负责把本段完成度（0..1）映射到全局 0..100。
fn run_ffmpeg(
    app: &AppHandle,
    ffmpeg: &str,
    args: &[String],
    child_slot: &Arc<Mutex<Option<Child>>>,
    cancelled: &AtomicBool,
    stage_duration: f64,
    map_progress: impl Fn(f64) -> f32,
) -> Result<(), String> {
    let mut full_args: Vec<String> = args.to_vec();
    full_args.push("-progress".into());
    full_args.push("pipe:1".into());
    full_args.push("-nostats".into());
    full_args.push("-nostdin".into());

    // 设了 GAP_GONE_FFMPEG_TRACE 就把每条命令原样打出来。
    // 为什么需要它：曾经用**手写**的命令去验证导出（参数与程序生成的略有出入），
    // 结果漏掉了 `-b:a:192k` 这类只有真实命令才有的问题（0.1.69）。想验证导出，
    // 就得验**程序真正发出的这条命令**，不是照着它重写一遍。
    if std::env::var_os("GAP_GONE_FFMPEG_TRACE").is_some() {
        log_info("ffmpeg", &format!("命令：{}", format_command(ffmpeg, &full_args)));
    }

    let mut child = ffmpeg_command(ffmpeg)
        .args(&full_args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("无法启动 ffmpeg: {error}"))?;
    let stdout = child.stdout.take();
    // stderr 单独线程排空，避免管道写满 64KB 后与 stdout 死锁。
    let stderr = child.stderr.take();
    let stderr_pump = std::thread::spawn(move || {
        let mut buffer = Vec::new();
        if let Some(mut stderr) = stderr {
            let _ = stderr.read_to_end(&mut buffer);
        }
        buffer
    });
    {
        let mut slot = child_slot
            .lock()
            .map_err(|_| "导出状态不可用".to_string())?;
        *slot = Some(child);
    }

    let mut last_percent = -1.0f32;
    if let Some(stdout) = stdout {
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            // out_time_ms 名不副实，单位是微秒（ffmpeg 历史遗留）
            if let Some(value) = line.strip_prefix("out_time_ms=") {
                if let Ok(micros) = value.trim().parse::<f64>() {
                    let stage_seconds = (micros / 1_000_000.0).clamp(0.0, stage_duration);
                    let percent = map_progress(if stage_duration > 0.0 {
                        stage_seconds / stage_duration
                    } else {
                        1.0
                    });
                    if percent >= last_percent + 1.0 || percent >= 100.0 {
                        emit_progress(app, percent.clamp(0.0, 100.0));
                        last_percent = percent;
                    }
                }
            }
            if cancelled.load(Ordering::SeqCst) {
                break;
            }
        }
    }

    let mut child = match child_slot.lock() {
        Ok(mut slot) => slot.take(),
        Err(_) => None,
    };
    let status = if let Some(child) = child.as_mut() {
        child
            .wait()
            .map_err(|error| format!("无法等待 ffmpeg 退出: {error}"))?
    } else if cancelled.load(Ordering::SeqCst) {
        return Err("已取消导出视频".to_string());
    } else {
        return Err("导出状态不可用".to_string());
    };
    let stderr_text = stderr_pump
        .join()
        .map(|bytes| String::from_utf8_lossy(&bytes).to_string())
        .unwrap_or_default();

    if cancelled.load(Ordering::SeqCst) {
        return Err("已取消导出视频".to_string());
    }
    if !status.success() {
        // 终端给全（命令 + stderr 末尾）；界面只留末尾 300 字符：真正的错误在最后，
        // 前面先是 Input #0 的横幅（见 truncate_tail）
        log_command_failure("视频导出", ffmpeg, &full_args, &stderr_text);
        return Err(format!("ffmpeg 导出失败: {}", truncate_tail(&stderr_text, 300)));
    }
    Ok(())
}

/// 短于一帧的区间/过渡没有意义，按「跳过」处理（30 fps 下 0.034 秒 ≈ 1 帧）。
const MIN_FRAME_SECONDS: f64 = 0.034;

/// 把一个「源文件 + 窗口」作为输入塞进命令行（输入侧 `-ss` + `-t`）。
/// 过渡段要 4 个窗口（视频 2 个、音频 2 个），拆出来避免把同一段参数写四遍。
fn push_window_input(args: &mut Vec<String>, source: &Path, start: f64, duration: f64) {
    args.push("-ss".into());
    args.push(format!("{:.3}", start.max(0.0)));
    args.push("-t".into());
    args.push(format!("{duration:.3}"));
    args.push("-i".into());
    args.push(source.to_string_lossy().to_string());
}

/// AAC 码率参数：**必须写成两个 argv**（`-b:a` + `192k`）。
///
/// 写成单个 `-b:a:192k` 会静默炸掉整条命令：ffmpeg 的 `find_option` 只在**第一个 `:`**
/// 处比对选项名，于是整串 `a:192k` 被当成流标识符，而**紧随其后的那个 argv 被当成选项值
/// 吃掉**（值本身没人校验，所以不报「无效码率」这种直接的错）。紧跟其后若是 `-t 4.630`，
/// 被吃掉的是 `-t`、`4.630` 就成了**裸输出文件名**，报的却是
/// `Unable to choose an output format for '4.630'` —— 看起来完全不像码率参数的问题。
/// 实测 ffmpeg 7.1.1 与 8.0.1 行为一致（0.1.69 定位）。
fn push_aac_bitrate(args: &mut Vec<String>, kbps: u32) {
    args.push("-b:a".into());
    args.push(format!("{kbps}k"));
}

/// 转场类型白名单。**绝不把前端传来的字符串直接拼进 filter**：那是滤镜图，
/// 拼错的轻则导不出、重则能塞进任意滤镜参数（例如 `,drawtext=...`）。
/// 认不出的值一律退回默认的 `smoothleft` 并打日志。
fn sanitize_transition_type(requested: Option<&str>) -> &'static str {
    match requested {
        Some("smoothleft") | None => "smoothleft",
        Some("wipeleft") => "wipeleft",
        Some("dissolve") => "dissolve",
        Some("fadewhite") => "fadewhite",
        Some(other) => {
            log_error(
                "视频导出",
                &format!("未知的转场类型 {other}，回退 smoothleft"),
            );
            "smoothleft"
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn run_video_export(
    app: &AppHandle,
    ffmpeg: &str,
    input: &Path,
    audio: Option<&Path>,
    regions: &[(f64, f64)],
    transitions: &[f64],
    fps: &str,
    transition_type: &str,
    output: &Path,
    fastcopy: bool,
    total_duration: f64,
    source_bitrate: Option<u32>,
    source_channels: Option<u16>,
    child_slot: &Arc<Mutex<Option<Child>>>,
    cancelled: &Arc<AtomicBool>,
) -> Result<(), String> {
    // AAC 回写码率：单声道 ≥96k / 立体声 ≥192k（每声道 96k），且不低于源音轨码率
    let aac_kbps = |channels: u16| -> u32 {
        let floor = channels.max(1) as u32 * 96;
        let source_kbps = source_bitrate.map(|bps| (bps + 999) / 1000).unwrap_or(0);
        floor.max(source_kbps).min(320)
    };
    // 处理后音轨的声道数（WAV 头里读，前端渲染时已还原原格式）
    let replaced_channels = match audio {
        Some(path) => Some(
            hound::WavReader::open(path)
                .map_err(|error| format!("无法读取处理后音轨: {error}"))?
                .spec()
                .channels,
        ),
        None => None,
    };

    // 段切片有两种 seek 口径，**不要混用**（原因见文件头注释 1、2）：
    // - fastcopy（无损快速）：输出侧 `-ss`（在 -i 之后），把关键帧之前的 pre-roll 丢掉，
    //   段的物理包数 = 真实时长，concat 拼出来的时间轴才连续；起点由前端吸附到关键帧。
    //   只作用于源音轨本身（处理后音轨走 reencode），所以这里把「有处理后音轨」一律
    //   归到 reencode —— 否则两条流会各自 seek、对不齐。
    // - reencode（精确）：输入侧 `-ss`，解码丢弃到精确点，帧精确。
    let fastcopy = fastcopy && audio.is_none();

    // 整段保留且未应用音频效果 → 纯 remux，不重编码（快速无损）
    let full_cover =
        regions.len() == 1 && regions[0].0 <= 0.05 && regions[0].1 >= total_duration - 0.05;

    // 切片过渡（精确编码档独有）：每个接缝 t 秒由相邻两段各取 t 秒交叉溶解而成，
    // 所以成片比硬切短 Σt。t 由前端算好（按帧取整 + 「短段各取一半」保护），这里再做一次
    // 兜底钳制 —— 取满会把某一段吃光。**快速档与纯 remux 一律硬切**：那是 `-c:v copy`，
    // 根本没有解码后的画面可供混合。
    let transitions: Vec<f64> = (0..regions.len().saturating_sub(1))
        .map(|index| {
            if fastcopy || full_cover {
                return 0.0;
            }
            let requested = transitions.get(index).copied().unwrap_or(0.0);
            let (start_a, end_a) = regions[index];
            let (start_b, end_b) = regions[index + 1];
            let limit = ((end_a - start_a).max(0.0) / 2.0).min((end_b - start_b).max(0.0) / 2.0);
            let clamped = requested.clamp(0.0, limit);
            if clamped < MIN_FRAME_SECONDS {
                0.0
            } else {
                clamped
            }
        })
        .collect();

    let temp_dir = gap_gone_temp_dir();
    let _ = std::fs::create_dir_all(&temp_dir);
    let timestamp = timestamp_ms();
    let mut guard = TempGuard(Vec::new());
    // 段产出后校验用（防止「切点越过关键帧 → 空段 → concat 拼出时间轴重叠的垃圾」）
    let ffprobe = ffprobe_path(ffmpeg)?;

    if full_cover {
        let mut args: Vec<String> = vec![
            "-y".into(),
            "-hide_banner".into(),
            "-i".into(),
            input.to_string_lossy().to_string(),
        ];
        if let Some(audio) = audio {
            args.push("-i".into());
            args.push(audio.to_string_lossy().to_string());
        }
        args.push("-map".into());
        args.push("0:v:0".into());
        args.push("-map".into());
        args.push(if audio.is_some() { "1:a:0" } else { "0:a:0" }.into());
        args.push("-c:v".into());
        args.push("copy".into());
        if let Some(channels) = replaced_channels {
            args.push("-c:a".into());
            args.push("aac".into());
            push_aac_bitrate(&mut args, aac_kbps(channels));
            // 容器长度跟较短的那条流：音轨是前端从整段音频渲染出来的，
            // 不裁剪的话音轨比画面长时会拖出一条只有声音的尾巴。
            args.push("-shortest".into());
        } else {
            args.push("-c:a".into());
            args.push("copy".into());
        }
        args.push("-movflags".into());
        args.push("+faststart".into());
        args.push(output.to_string_lossy().to_string());
        run_ffmpeg(
            app,
            ffmpeg,
            &args,
            child_slot,
            cancelled,
            total_duration,
            |f| (f * 100.0) as f32,
        )?;
        emit_progress(app, 100.0);
        return Ok(());
    }

    // 逐区间切片：-ss 输入定位（重编码时解码丢弃到精确点，copy 时关键帧对齐），
    // 比滤镜图 select/trim 稳；每段独立编码再 concat。
    // 成片时长 = 各保留区间之和 − 被过渡重叠掉的那部分（Σt）。
    let total: f64 = regions
        .iter()
        .map(|(start, end)| (end - start).max(0.0))
        .sum::<f64>()
        - transitions.iter().sum::<f64>();
    if total <= 0.0 {
        return fail("视频导出", "不能导出空视频，请至少保留一段内容".to_string());
    }
    let mut done = 0.0f64;
    // 处理后音轨是「已拼接时间轴」：第 i 段对应的音频起点 = 前 i 段时长之和
    let mut audio_offset = 0.0f64;
    let mut segment_paths: Vec<PathBuf> = Vec::new();

    for (index, (start, end)) in regions.iter().enumerate() {
        if cancelled.load(Ordering::SeqCst) {
            return Err("已取消导出视频".to_string());
        }
        let full_duration = (end - start).max(0.0);
        // 相邻接缝会从本段头部/尾部各取 t 秒去做交叉溶解，本段只导出中间的「主体」
        let head_trim = if index > 0 { transitions[index - 1] } else { 0.0 };
        let tail_trim = transitions.get(index).copied().unwrap_or(0.0);
        let body_start = start + head_trim;
        let body_end = (end - tail_trim).max(body_start);
        let duration = body_end - body_start;
        // 短于一帧的区间跳过视频切片；音频偏移仍按完整时长累计，保持后续段对齐
        let encode_segment = duration >= MIN_FRAME_SECONDS;
        if encode_segment {
            let segment_path =
                temp_dir.join(format!("gap-gone-video-seg-{timestamp}-{index}.mp4"));
            guard.track(segment_path.clone());
            let mut args: Vec<String> = vec!["-y".into(), "-hide_banner".into()];
            if fastcopy {
                // 输出侧 seek：丢 pre-roll，段的物理包数 = 真实时长。
                // 起点已被前端吸附到「不超过关键帧」的值（关键帧时间戳本身有 6 位小数，
                // 直接拿它当 -ss 一旦被四舍五入抬高就会越过关键帧），这里保留 4 位小数。
                args.push("-i".into());
                args.push(input.to_string_lossy().to_string());
                args.push("-ss".into());
                args.push(format!("{:.4}", body_start.max(0.0)));
            } else {
                args.push("-ss".into());
                args.push(format!("{body_start:.3}"));
                args.push("-i".into());
                args.push(input.to_string_lossy().to_string());
                if let Some(audio) = audio {
                    args.push("-ss".into());
                    args.push(format!("{audio_offset:.3}"));
                    args.push("-i".into());
                    args.push(audio.to_string_lossy().to_string());
                }
            }
            args.push("-map".into());
            args.push("0:v:0".into());
            args.push("-map".into());
            args.push(if audio.is_some() { "1:a:0" } else { "0:a:0" }.into());
            args.push("-c:v".into());
            if fastcopy {
                args.push("copy".into());
            } else {
                args.push("libx264".into());
                args.push("-preset".into());
                args.push("veryfast".into());
                args.push("-crf".into());
                args.push("20".into());
                // 兼容性：部分输入是 10bit/422，统一转 8bit 420
                args.push("-pix_fmt".into());
                args.push("yuv420p".into());
            }
            if fastcopy {
                // 无损快速：音轨原样拷贝（这条路上音频一定未被处理过，见上面的 fastcopy 归一）
                args.push("-c:a".into());
                args.push("copy".into());
            } else {
                // 精确重编码：音轨也重编码为 AAC。**不能在这里 copy 源音轨** ——
                // 手机录的素材常带 skip samples 前置边数据（实测一个 AAC 首包带
                // `Skip Samples,41231` = 0.859 秒），copy 会把它带进每一段，而 concat
                // 按时间戳累加后整片错位（实测 6 秒成片变 6.863 秒、音画差 0.86 秒）。
                // 重编码会重新生成干净的时间戳（改后实测 6.021 秒 / 180 帧，音频逐块吻合）。
                args.push("-c:a".into());
                args.push("aac".into());
                push_aac_bitrate(
                    &mut args,
                    aac_kbps(replaced_channels.or(source_channels).unwrap_or(2)),
                );
            }
            // 必须每个片段都带 -t：`-ss` 只决定起点，不带它这一段会一路切到片尾。
            args.push("-t".into());
            args.push(format!("{duration:.3}"));
            args.push(segment_path.to_string_lossy().to_string());
            run_ffmpeg(app, ffmpeg, &args, child_slot, cancelled, duration, |f| {
                (((done + f * duration) / total * 95.0) as f32).clamp(0.0, 95.0)
            })?;
            // 空段会让 concat 拼出时间轴重叠的垃圾（实测 3.5 秒的成片变成 10.9 秒），
            // 宁可在这里明确失败：多半是切点落在了关键帧之间。
            if segment_video_packets(&ffprobe, &segment_path) == 0 {
                return fail(
                    "视频导出",
                    format!(
                        "第 {} 个保留区间没有导出任何画面（无损快速只能从关键帧起切），请改用「精确重编码」",
                        index + 1
                    ),
                );
            }
            segment_paths.push(segment_path);
        }
        done += duration;
        // 过渡段：**画面交叉溶解，音频在过渡中点硬拼接**（两端各 5 毫秒微淡）。
        //
        // 音频为什么不用 `acrossfade`：实测它在 0.3 秒级的短窗口上**偶发一帧都不输出**
        // （同一条命令连跑 5 次会混出 92 字节的空文件），下游 aac 编码器于是报
        // `Could not open encoder before EOF` / `Conversion failed!` —— 也就是用户看到的
        // 「ffmpeg 导出失败（Input #0 … 之后再报错）」。换成 `concat` 后连跑 6 次逐字节一致。
        // 顺带的好处：口播素材上音频交叉淡化会把相邻两句叠在一起，硬拼接 + 微淡更干净。
        //
        // 两个音频窗口各取 d/2，合起来正好 d 秒 —— 与画面溶解时长一致，不会累积音画错位。
        if tail_trim >= MIN_FRAME_SECONDS {
            let piece_path =
                temp_dir.join(format!("gap-gone-video-xfade-{timestamp}-{index}.mp4"));
            guard.track(piece_path.clone());
            // 过渡段的两个视频窗口 = 两侧**被裁掉的那两截**，正好接在主体之外，
            // 所以既不会有内容重复也不会丢内容：
            //   本段尾巴 [body_end, body_end + t] 与 下一段头部 [start_{i+1}, start_{i+1} + t]
            // 注意起点不要写成 `body_end - t` / `start_{i+1} + t` —— 那会把过渡窗口挪进主体里，
            // 结果是 A 的最后一截永远不出现、B 的开头被播两遍。**这两个错法都实际发生过**：
            // `start + t` 在 0.1.67 修掉，`body_end - t` 在 0.1.71 修掉（注释写对了、代码写错了，
            // 而验证只看帧数与时长，两个错法的帧数完全一样，所以一直没暴露）。
            // 判据必须是**内容**：过渡段第 0 帧应与源上 `body_end` 那一帧几乎一致
            // （PSNR ≈ 43 dB），与 `body_end - t` 那一帧则应明显不像（≈ 19 dB）。
            let next_region_start = regions[index + 1].0;
            let audio_after = audio_offset + full_duration;
            let half = tail_trim / 2.0;
            // 微淡：盖住硬拼接处的咔嗒声。取 d 的 1/10 且不超过 5 毫秒。
            let micro_fade = (tail_trim / 10.0).min(0.005).max(0.001);
            let mut args: Vec<String> = vec!["-y".into(), "-hide_banner".into()];
            // 输入 0/1：视频窗口各**正好** d 秒（xfade 的 offset=0 要求输入 1 时长恰为 d）
            push_window_input(&mut args, input, body_end, tail_trim);
            push_window_input(&mut args, input, next_region_start, tail_trim);
            // 输入 2/3：音频窗口各 d/2 秒，取「两侧**被裁掉那一截的前半**」——
            // 与视频窗口（两侧被裁掉那一整截）端点对齐，所以过渡段起点的音频正好接在
            // 本段主体的最后一个采样之后，不会重复也不会跳内容（0.1.70 修）：
            //   本段：[body_end, body_end + d/2]（被裁掉的尾巴 [body_end, end] 的前半）
            //   下段：[next_start, next_start + d/2]（被裁掉的头部 [start, start + d] 的前半）
            // **不要**退回「主体末尾往前 d/2」（`body_end - d/2`）：那落在主体已播过的一截里，
            // 接缝处会重复约 d/2（默认 150 ms）的音频，而被裁掉那一截的音频永远不出现。
            // 处理后音轨是「已拼接时间轴」，同一位置换算成 audio_after - d 起算。
            let audio_source = audio.unwrap_or(input);
            let (audio_a_start, audio_b_start) = if audio.is_some() {
                (audio_after - tail_trim, audio_after)
            } else {
                (body_end, next_region_start)
            };
            push_window_input(&mut args, audio_source, audio_a_start, half);
            push_window_input(&mut args, audio_source, audio_b_start, half);
            // 滤镜参数一律用**具名**写法（`settb=tb=` / `setpts=expr=` / `fps=fps=`）：
            // 位置写法（`settb=AVTB`、`setpts=PTS-STARTPTS`）只有 ffmpeg 7.0+ 认，
            // 实测 6.1.1 直接报 `No option name near 'AVTB'`。
            //
            // 转场类型由用户选（设置页下拉），默认 `smoothleft`（平滑滑移）。
            // **默认不是 `dissolve`**（0.1.72 换）：交叉溶解把两帧不同姿态的画面叠在一起 ——
            // 边缘成双影、细纹理互相交织，用户看到的「像锐化过度 + 密密麻麻的点」就是它。
            // 实测同一个接缝上，溶解的混合帧 `edgedetect` 平均亮度是普通帧的 1.66 倍、
            // 码率 5 倍（25.2 vs 5.2 Mbps）；换滑移后回到普通帧水平。
            // 交叉溶解适合表达「时间流逝」，而这里的用途是**掩盖跳切**，滑移/划像才是常规做法。
            // 顺带记下其它选项的量级（逐帧画面变动量，普通素材基准 2.18）：划像 2.41、
            // 溶解 2.83、闪白 32.55（0.1 秒时 98.6）—— 闪白是「请观众注意」的语言，别设成默认。
            let filter = format!(
                "[0:v]settb=tb=AVTB,setpts=expr=PTS-STARTPTS,fps=fps={fps}[v0];\
                 [1:v]settb=tb=AVTB,setpts=expr=PTS-STARTPTS,fps=fps={fps}[v1];\
                 [v0][v1]xfade=transition={transition}:duration={duration:.3}:offset=0,format=yuv420p[v];\
                 [2:a][3:a]concat=n=2:v=0:a=1,afade=t=in:st=0:d={fade:.3},\
                 afade=t=out:st={fade_out:.3}:d={fade:.3}[a]",
                fps = fps,
                transition = transition_type,
                duration = tail_trim,
                fade = micro_fade,
                fade_out = (tail_trim - micro_fade).max(0.0),
            );
            args.push("-filter_complex".into());
            args.push(filter);
            args.push("-map".into());
            args.push("[v]".into());
            args.push("-map".into());
            args.push("[a]".into());
            // 编码参数必须与普通段逐项一致，否则 concat 拼不上
            args.extend([
                "-c:v".into(),
                "libx264".into(),
                "-preset".into(),
                "veryfast".into(),
                "-crf".into(),
                "20".into(),
                "-pix_fmt".into(),
                "yuv420p".into(),
                "-c:a".into(),
                "aac".into(),
            ]);
            push_aac_bitrate(
                &mut args,
                aac_kbps(replaced_channels.or(source_channels).unwrap_or(2)),
            );
            args.push(piece_path.to_string_lossy().to_string());
            run_ffmpeg(app, ffmpeg, &args, child_slot, cancelled, tail_trim, |f| {
                (((done + f * tail_trim) / total * 95.0) as f32).clamp(0.0, 95.0)
            })
            .map_err(|error| {
                format!(
                    "过渡段（第 {}–{} 个保留区间之间）导出失败：{error}",
                    index + 1,
                    index + 2
                )
            })?;
            if segment_video_packets(&ffprobe, &piece_path) == 0 {
                return fail(
                    "视频导出",
                    format!(
                        "第 {} 与第 {} 个保留区间之间的过渡段没有导出画面",
                        index + 1,
                        index + 2
                    ),
                );
            }
            segment_paths.push(piece_path);
            done += tail_trim;
        }
        audio_offset += full_duration;
    }

    if segment_paths.is_empty() {
        return fail("视频导出", "没有可导出的视频区间".to_string());
    }

    // concat demuxer 拼接（所有片段编码参数一致，-c copy 秒级完成）
    let list_path = temp_dir.join(format!("gap-gone-video-concat-{timestamp}.txt"));
    guard.track(list_path.clone());
    let mut list = String::new();
    for path in &segment_paths {
        // concat 清单里的单引号转义：' → '\''
        let escaped = path.to_string_lossy().replace('\'', "'\\''");
        list.push_str(&format!("file '{escaped}'\n"));
    }
    std::fs::write(&list_path, list).map_err(|error| format!("无法写入拼接清单: {error}"))?;

    let concat_args: Vec<String> = vec![
        "-y".into(),
        "-hide_banner".into(),
        "-f".into(),
        "concat".into(),
        "-safe".into(),
        "0".into(),
        "-i".into(),
        list_path.to_string_lossy().to_string(),
        "-c".into(),
        "copy".into(),
        "-movflags".into(),
        "+faststart".into(),
        output.to_string_lossy().to_string(),
    ];
    let concat_result = run_ffmpeg(app, ffmpeg, &concat_args, child_slot, cancelled, total, |f| {
        (95.0 + f * 5.0) as f32
    });
    if concat_result.is_err() {
        // 失败/取消不留半成品
        let _ = std::fs::remove_file(output);
    }
    concat_result?;
    // 拼接后校验成片时长。段的音频时间戳异常时（例如手机 AAC 带 skip samples 前置边数据），
    // concat 会按段时长累加出偏长的片子 —— 宁可报错让用户改用精确重编码，也不要静默交付。
    // 正常导出的偏差只有几帧（实测 0.008 秒），0.3 秒的阈值足够宽松。
    if let Some(actual) = media_duration(&ffprobe, output) {
        if (actual - total).abs() > 0.3 {
            let _ = std::fs::remove_file(output);
            return fail(
                "视频导出",
                format!(
                    "拼接后的成片时长 {actual:.2} 秒与预期 {total:.2} 秒不符（源音轨时间戳异常），请改用「精确重编码」"
                ),
            );
        }
    }
    emit_progress(app, 100.0);
    Ok(())
}

/// 视频导出。regions_json 是保留区间 [start, end] 数组（原视频时间轴）。
/// audio_path 提供（应用过降噪/压缩/响度归一化）时替换原音轨为前端渲染的处理后音轨；
/// 否则 -c:a copy 保留原音轨特征。variant: "fastcopy"（默认，不重编码）/ "reencode"（帧精确）。
/// transitions_json 是**逐接缝的过渡时长**（秒，长度 = 区间数 − 1，0 = 硬切），只在
/// reencode 档生效；transition_type 是转场类型（白名单见 sanitize_transition_type）；
/// fps 是源视频帧率的原始分数串（如 "30/1"），xfade 要求显式帧率。
/// subtitles_path 提供时，导出成功后把该临时字幕文件复制到成片旁边（同名 .srt）。
#[tauri::command]
pub(crate) async fn export_video(
    app: AppHandle,
    state: State<'_, VideoExportManager>,
    ffmpeg: String,
    input_path: String,
    audio_path: Option<String>,
    subtitles_path: Option<String>,
    regions_json: String,
    transitions_json: Option<String>,
    transition_type: Option<String>,
    fps: Option<String>,
    output_path: String,
    variant: String,
    total_duration: f64,
    source_bitrate: Option<u32>,
    source_channels: Option<u16>,
) -> Result<(), String> {
    // 参数校验放在占用导出锁之前，失败路径不需要解锁
    let input = PathBuf::from(&input_path);
    if !input.is_file() {
        return fail("视频导出", "找不到源视频文件".to_string());
    }
    let audio = match audio_path.as_deref() {
        Some(path) => Some(validate_temp_path("视频导出", path)?),
        None => None,
    };
    let subtitles = match subtitles_path.as_deref() {
        Some(path) => Some(validate_temp_path("视频导出", path)?),
        None => None,
    };
    let output = PathBuf::from(&output_path);
    let mut regions: Vec<(f64, f64)> = match serde_json::from_str(&regions_json) {
        Ok(regions) => regions,
        Err(_) => return fail("视频导出", "保留区间数据无效".to_string()),
    };
    if regions.is_empty() {
        return fail("视频导出", "不能导出空视频，请至少保留一段内容".to_string());
    }
    regions.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    let fastcopy = variant != "reencode";
    // 过渡时长由前端算好（已按帧取整、已做「短段各取一半」保护）；这里只做长度与范围校验，
    // 缺项按硬切处理，绝不因为参数问题把成片算错。
    let transitions: Vec<f64> = transitions_json
        .as_deref()
        .and_then(|json| serde_json::from_str::<Vec<f64>>(json).ok())
        .unwrap_or_default();
    let fps = fps.unwrap_or_else(|| "30/1".to_string());
    let transition_type = sanitize_transition_type(transition_type.as_deref());

    // 导出计划先落一行到终端：出问题时第一件事就是对照它看「按哪个档位、切了哪几段」，
    // 而这些参数来自前端，光看界面复现不出来。
    log_info(
        "视频导出",
        &format!(
            "开始：{}｜保留 {} 段 {:?}｜过渡 {transition_type} {:?}｜fps {fps}｜{}｜输出 {output_path}",
            if fastcopy { "无损快速" } else { "精确重编码" },
            regions.len(),
            regions,
            transitions,
            if audio_path.is_some() {
                "回写处理后音轨"
            } else {
                "原音轨"
            },
        ),
    );

    if state.running.swap(true, Ordering::SeqCst) {
        return Err("已有视频导出正在进行".to_string());
    }
    state.cancelled.store(false, Ordering::SeqCst);
    let child_slot = Arc::clone(&state.child);
    let cancelled = Arc::clone(&state.cancelled);
    // 导出在后台线程跑，output 的所有权要给进去；后面写字幕还要用它（clone 一份）
    let export_output = output.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        run_video_export(
            &app,
            &ffmpeg,
            &input,
            audio.as_deref(),
            &regions,
            &transitions,
            &fps,
            transition_type,
            &export_output,
            fastcopy,
            total_duration,
            source_bitrate,
            source_channels,
            &child_slot,
            &cancelled,
        )
    })
    .await
    .map_err(|_| "视频导出线程异常退出".to_string())
    .and_then(|inner| inner);
    state.running.store(false, Ordering::SeqCst);
    if let Ok(mut slot) = state.child.lock() {
        *slot = None;
    }
    // 字幕只在视频成功导出后才落盘；写失败要说清「视频已经导出」，
    // 否则用户会以为整次导出白做了。
    if result.is_ok() {
        if let Some(subtitles) = subtitles {
            let target = output.with_extension("srt");
            if let Err(error) = std::fs::copy(&subtitles, &target) {
                return fail(
                    "视频导出",
                    format!("视频已导出，但字幕文件写出失败: {error}"),
                );
            }
        }
    }
    result
}

#[tauri::command]
pub(crate) fn cancel_video_export(state: State<'_, VideoExportManager>) {
    state.cancelled.store(true, Ordering::SeqCst);
    if let Ok(mut slot) = state.child.lock() {
        if let Some(child) = slot.as_mut() {
            let _ = child.kill();
        }
    }
}
