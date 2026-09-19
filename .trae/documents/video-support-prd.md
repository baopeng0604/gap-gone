# 视频导入 / 删片段 / 导出视频 PRD

## 摘要

在现有录音 + 音频剪辑能力之上，让 Gap Gone 支持导入视频文件（MP4 等），沿时间轴删除若干片段后，导出为视频文件。核心策略：**复用现有 AudioAsset 管线做剪辑，用系统 ffmpeg 做解封装/编码/封装**。

- 导入：`dialog.open` 取视频文件路径，ffmpeg 抽单声道 48 kHz 音轨喂给现有波形/切除管线；原文件原地不动，不进内存、不复制。
- 预览：新增 `<video>` 画面播放器，与现有音频时间轴 / 播放 / seek / 删区间同步。
- 导出：ffmpeg 按 `EditTimeline` 的保留区间重编码输出 MP4（H.264 + AAC），另提供关键帧流拷贝快速模式。
- 音频回写：降噪、响度归一化（LUFS）等音频编辑结果回写进导出视频的音轨，一步到位，无需二次编辑。
- 依赖：**不打包 ffmpeg**，调用系统路径，检测不到则弹框引导安装（顺带规避 GPL 授权）。

## 决策一览

| 分叉 | 结论 |
| --- | --- |
| 导出引擎 | ffmpeg，不打包，调系统路径，缺了弹框引导 |
| 视频预览 | 同步画面预览（`<video>` + 时间轴） |
| 切割编码 | 默认重编码（帧精确），可选「关键帧快速 copy」 |
| 音频处理范围 | 音频编辑（降噪 / 响度归一化）回写进视频音轨，一步到位；转录仍只读不回写 |
| 格式范围 | 输入多容器（ffmpeg 探测），输出固定 MP4 |

## 现状分析

整条编辑管线是「单轨 AudioBuffer」：导入 → `decodeAudioData` 解成 `AudioBuffer` → 波形 / 静音检测 / 降噪 / 时间轴 / 播放 / 导出全吃 `AudioBuffer`。没有任何视频概念。

- 导入：[App.tsx](file:///d:/Code/Github/gap-gone/src/App.tsx) `handleFileUpload` 用 `<input accept="audio/*">` + `decodeAudioData`，只认音频容器，MP4 解不了。
- 编辑模型：[regionUtils.ts](file:///d:/Code/Github/gap-gone/src/utils/regionUtils.ts) 的 `Region` / `EditTimeline` 是时间区间，媒体无关，可直接复用到视频。
- 播放：`AudioBufferSourceNode`，无 `<video>`（CSP 已放行 `media-src blob:`，`<video>` 直接可用）。
- 导出：[exportUtils.ts](file:///d:/Code/Github/gap-gone/src/utils/exportUtils.ts) 手写 WAV、[mp3Export.ts](file:///d:/Code/Github/gap-gone/src/utils/mp3Export.ts) 用 lamejs，全是前端 JS，无视频编码/封装。
- Rust 侧：[Cargo.toml](file:///d:/Code/Github/gap-gone/src-tauri/Cargo.toml) 仅 cpal/hound/ndarray/df/sherpa-onnx，无媒体容器库。

## 分模块实现

### 1. ffmpeg 探测 + 引导（Rust，量小）

新增命令 `detect_ffmpeg() -> Result<FfmpegInfo, String>`：

- 按 `PATH` 逐目录找 `ffmpeg` / `ffmpeg.exe`，再跑 `ffmpeg -version` 确认可执行并抓版本号。
- 顺带探测常见安装位置：Windows（`winget`/`scoop`/`choco` 安装位、`%LOCALAPPDATA%`、`C:\ffmpeg\bin` 等）、macOS（`/opt/homebrew/bin`、`/usr/local/bin`）。
- 返回 `{ found: bool, path: Option<String>, version: Option<String> }`。

前端进入视频流程前先探测：未找到则弹框，按平台给安装指引（Windows `winget install ffmpeg` / scoop；macOS `brew install ffmpeg`），并提供「手动指定 ffmpeg 路径」入口。`ffmpeg` 路径缓存到 `settings.ts`（key `gap-gone-ffmpeg-path`），用户手动指定的路径优先于 PATH 探测。

注意：命令编排需兼容多版本 ffmpeg（不依赖太新的 flag / filter）。**不引入 `ffmpeg-next` 等重编译依赖**，纯 `std::process::Command` 调用。

### 2. 视频导入（Rust + 前端，换一条路）

关键：视频导入不走 `<input type=file>` + `arrayBuffer`（拿不到真实路径、大文件撑爆内存），改用 `dialog.open` 拿路径。

- 前端新增 `handleVideoUpload`：`dialog.open({ filters: [{ name: 'Video', extensions: ['mp4','mov','mkv','webm','avi','m4v'] }] })` 拿到路径。
- Rust 新增 `probe_video(path) -> VideoProbe`：`ffmpeg -i` 探测时长、分辨率、编码、有无音轨、关键帧位置（`-skip_frame nokey -show_entries` 或运行时 `-select_streams`）。
- Rust 新增 `extract_video_audio(path) -> { audioPath }`：`ffmpeg -i 原视频 -vn -ac 1 -ar 48000 <gap-gone 临时目录>/gap-gone-video-audio-<ts>.wav`。
- 前端把抽出的 WAV `readFile` 后 `decodeAudioData` → 走现有 `setAudioBuffer` 流程（波形/静音/删除区间/播放全部复用，零改动），同时 `videoAssetRef.current = { path, probe }` 记录视频上下文。

边界：探测到无音轨 / 多音轨 / HEVC / 变帧率 / 带旋转 metadata 时，首版提示「暂不支持该视频」并中止导入（不硬扛）。

### 3. 视频预览（前端，新增组件）

- 新增 `VideoPreview` 组件：`<video>` 用 `blob:` URL（或 `convertFileSrc`）播原视频，静音（视频声音由现有 `AudioBufferSourceNode` 出）。
- 播放/暂停/seek/跳删区间三态同步：把现有 `nextPlayableTime` / `position` 逻辑同时作用到 `<video>.currentTime`；播放中点击波形/seek、暂停、停止，都要同步视频元素。
- 导出/降噪/响度等触发时与音频一样先 `stopPlayback`。

### 4. 视频导出（Rust，量最大）

新增命令 `export_video(inputPath, regions, outputPath, variant) -> Result<(), String>`，`regions` 走 JSON 文本（时间区间很小，不走大文件约束）。

- 输入：源视频真实路径、前端 `getKeptRegions` 反推出的保留区间列表、`dialog.save` 的输出路径、编码变体。
- `reencode`（默认）：`ffmpeg -i input -vf select/trim+concat -af atrim/concat → -c:v libx264 -c:a aac output.mp4`，切点帧精确。
  - 实现上更稳的做法：对每个保留区间用 `-ss start -to end -i input` 各切成独立片段，再 `concat demuxer` 拼接——避免滤镜图里 select 表达式的正负帧漏洞。
- `fastcopy`：关键帧对齐 `-ss/-to` + `-c copy` + `concat demuxer`，几乎零耗时；切点误差提示清楚。
- 进度：`-progress pipe:1` 读 `out_time_ms` / 总时长换算百分比，前端复用现有「处理中」样式展示；支持取消（kill 子进程 + 清理半成品 temp）。

输出路径经 `dialog.save` 拿到；导出后半成品临时文件（片段 + temp 音轨）在 `finally` 清理。

### 5. 音频编辑回写（替换原「只删片段」，一步到位）

目标：降噪、响度归一化（LUFS）等对视频音轨的编辑结果，在导出视频时回写，无需二次编辑。

实现路径（复用前端已有音频链，几乎零新增算法）：

1. 音轨的完整音频处理（降噪 DeepFilterNet → 响度归一化三段式 → 切除）已经在 `audioBuffer` 上完成，与纯音频链路一致，逻辑零改动。
2. 导出视频时：前端用 `buildExportBuffer(audioBuffer, deletedRegions)` 得到「处理后 + 已切除」的音轨，`bufferToWav` 写入临时目录 WAV。
3. ffmpeg 双输入 `-i 原视频 -i 处理后音轨.wav`：视频轨按同样的保留区间切 + 重编码（libx264），`-map 0:v -map 1:a` 用处理后音轨替换原音轨，编码 aac，输出 MP4。

音轨回写分档（保质量）：

- **未应用任何音频效果（只删片段）**：ffmpeg 直接切**原音轨**（`-map 0:a` atrim/concat，保留原声道数 / 码率特征），避免无谓降成 mono 48k。
- **应用过降噪 / 响度归一化**：走前端渲染的 mono 48k 处理后音轨回写（本项目的降噪 / LUFS 链本就是 mono）。

判定依据：`audioProcessed` 标记（降噪确认、响度归一化任一操作后置 true），导出时据此选档。

A/V 同步：两轨共用同一 `getKeptRegions` 保留区间，音频总时长 = 视频拼接总时长；帧对齐由 ffmpeg 时间戳保证，验收重点核对结尾与循环点无漂移。

- `accept="audio/*"` 的「打开」按钮与新的「打开视频」入口并存；视频模式下降噪 / 响度归一化按钮**保持可用**（不再置灰）。

## 边界与风险

1. **无音轨 / 多音轨 / HEVC / 变帧率 / 旋转 metadata**：首版检测到即提示不支持。
2. **ffmpeg 版本差异**：探测版本，命令只用稳定旗标；用户手动指定的 ffmpeg 可能很旧，失败时给明确错误。
3. **大文件**：视频几百 MB 到数 GB，全程「文件落盘 + 路径传参」，绝不 `Vec<u8>` / `arrayBuffer` 整段进内存/IPC。
4. **重编码耗时**：长视频重编码数分钟到数十分钟，进度回调必须可靠、可取消。
5. **临时目录**：视频抽出的音轨、导出片段统一落 `gap_gone_temp_dir()`，命名带 `gap-gone-` 前缀，过 `validate_temp_recording_path` 校验（或新增 video 专用校验，保持同一安全基线）。

## 文件改动清单

| 文件 | 改动 |
| --- | --- |
| `src-tauri/src/lib.rs`（或新建 `video.rs`） | `detect_ffmpeg` / `probe_video` / `extract_video_audio` / `export_video` 命令；`std::process::Command` 调 ffmpeg |
| `src-tauri/tauri.conf.json` | 无需新增 capability（ffmpeg 走 process 非 fs 权限）；版本号递增 |
| `src-tauri/Cargo.toml` | 版本号递增（无新重依赖） |
| `src/utils/settings.ts` | 新增 `gap-gone-ffmpeg-path` 等持久化 key |
| `src/components/VideoPreview.tsx` | 新建：`<video>` 画面播放器与时间轴同步 |
| `src/App.tsx` | `handleVideoUpload`、`videoAssetRef`、`audioProcessed` 标记、音频回写渲染（处理后音轨写 temp）、导出分支到 `export_video`、ffmpeg 缺失引导弹框 |
| `CONTEXT.md` | 新增 VideoAsset / VideoExportVariant 领域词与边界（已做） |
| `package.json` / `Cargo.toml` | 版本号同步递增 |

## 验证步骤

1. `cargo check`（src-tauri 下）+ `pnpm build`（tsc + vite）通过。
2. 无 ffmpeg 环境：进入视频流程弹框引导，安装后重探测可用。
3. 导入 MP4：波形正常、视频画面同步预览、seek/删区间画面跟随。
4. 删片段导出 reencode：MP4 可播、时长与保留区间一致、切点精确、音画同步。
5. 应用降噪 / 响度归一化后导出：处理后的音轨正确回写（听感与纯音频导出一致），音画同步、结尾无漂移。
6. fastcopy 模式：导出快，切点误差符合预期（关键帧附近）。
7. 边界：无音轨视频、HEVC 视频导入时提示不支持，不崩溃。
8. 大文件（>1GB）导入导出全程内存稳定、进度可取消，临时文件清理干净。