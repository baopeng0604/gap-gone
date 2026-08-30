# AGENTS.md

面向 AI 编码代理的项目指南。人类开发者也可当作快速上手文档阅读。

## 项目是什么

Gap Gone：一款录音 + 音频编辑桌面应用（Tauri 2）。核心能力：录音（电平监控/削波检测）、静音检测与区间切除、DeepFilterNet3 降噪、编辑时间轴回放与 WAV 导出。

## 技术栈

* 前端：React 18 + TypeScript + Vite（`src/`）

* 桌面壳：Tauri 2（`src-tauri/`）

* Rust 音频：`cpal`（采集）、`hound`（WAV 读写）、`df-tract`（DeepFilterNet3 推理）

* 包管理：pnpm（仓库含 `pnpm-lock.yaml` 与 `pnpm-workspace.yaml`）

## 常用命令（项目根目录）

```bash
pnpm install            # 安装依赖
pnpm dev                # Vite 前端开发（http://127.0.0.1:1420）
pnpm build              # tsc 类型检查 + Vite 构建 → dist/
pnpm tauri dev          # 桌面开发版（Rust 后端 + WebView 前端）
pnpm tauri build        # 打包桌面应用 → src-tauri/target/release/bundle/
```

Rust 侧改动可用 `cargo check`/`cargo build`（在 `src-tauri/` 下）快速验证。

## 代码结构

* `src/useRecorder.ts` — 录音 Hook。**双路径**：Tauri 桌面走原生命令（`start_recording` 等），浏览器/无命令时降级 Web Media API（getUserMedia + MediaRecorder）。改录音逻辑时两条路径都要考虑。

* `src/App.tsx` — 主界面与状态编排；`src/components/` 波形/时间轴/转录面板组件；`src/utils/` 音频分析（静音检测）、降噪、转录、WAV 导出。

* `src-tauri/src/lib.rs` — 录音相关原生命令与 cpal 录音流管理（`RecordingManager` 状态机）；`src-tauri/src/transcribe.rs` — SenseVoice 转录（模型下载 + `gap-gone-transcribe` 工作线程）。

## 关键领域概念

见 `CONTEXT.md`（RecordingTake / AudioAsset / EditTimeline / TimeRange 等领域词汇与边界）。改功能前先读它，命名和注释保持与领域词汇一致。

## 硬约束（踩过坑的）

1. **Windows WASAPI 共享模式只接受设备默认混音格式**。`start_recording` 不能改声道数/采样率，否则 `Initialize` 返回 `AUDCLNT_E_UNSUPPORTED_FORMAT`。多声道在回调里 `downmix_to_mono` 下混。macOS 上不少 USB 麦默认 44.1 kHz，同样不要改设备格式。
2. **音频回调是实时线程**。不要在 cpal 回调里做磁盘 IO、锁竞争、跨进程 emit 等重活，否则 WASAPI 缓冲区超期（underrun/overrun，`AUDCLNT_E_BUFFER_ERROR`）。**注意区分错误级别**：`ErrorKind::Xrun` 是瞬时毛刺（丢极少采样，流还活着），只计数上报（`recording-level.glitches`），绝不能拆流；只有设备拔出等致命错误才走回收流程。
3. **DeepFilterNet 降噪只接受 48 kHz 单声道 16-bit WAV**（`denoise_audio` 有校验）。采样率/声道不匹配由前端 `noiseReduction.ts` 的 `renderBuffer`（OfflineAudioContext）在处理前后做转换，不要把重采样塞进 Rust 侧。
4. **临时录音文件命名约定** **`gap-gone-*.wav`** **且必须位于系统 temp 目录**。`validate_temp_recording_path`（被 `delete_recording_file` / `denoise_audio` 复用）依赖该前缀与父目录做安全校验，改命名前先改校验。降噪临时路径由 `prepare_denoise_files` 生成，保证前缀合法。
5. **大文件禁止走** **`Vec<u8>`** **命令参数/返回值**。Tauri v2 自定义命令的参数走 JSON 数字数组序列化，长录音会卡死 IPC。一律走「临时文件 + 路径传参」：前端用 `@tauri-apps/plugin-fs` 的 `writeFile`/`readFile`（二进制 raw 传输），Rust 命令只收发路径字符串。capabilities 需含 `fs:allow-temp-read` / `fs:allow-temp-write`。
6. **DfTract 不是 Send（内含 Rc），不能放进 Tauri State**。降噪模型常驻 `gap-gone-denoise` 工作线程并缓存复用；命令只投递 `DenoiseJob`。复用前必须 `init()` + `DFState::reset()` + `init_norm_states()` 重置流式状态，否则上一段音频的归一化状态会串扰下一段。SenseVoice 转录同理常驻 `gap-gone-transcribe` 线程。
7. **设备选择用 cpal** **`Device::id()`（平台稳定 ID）**，不要用设备名——两台同名 USB 麦会选错。名称只做显示 label 和兜底匹配。
8. **大模型不进安装包**。SenseVoice 模型（\~230MB）运行时下载到 `app_data_dir/models/sense-voice/`（HF 主站 + hf-mirror 镜像，`.partial` 过渡文件），支持用户手动放置；`transcribe_model_status` 是唯一就绪判定。
9. 录音错误通过 Tauri 事件 `recording-error` 上报前端；电平通过 `recording-level` 上报；降噪进度通过 `denoise-progress` 上报（-1 表示正在加载模型）；转录进度通过 `transcribe-progress` 上报（stage: download/load/transcribe）。

## 安全基线

* `tauri.conf.json` 配了严格 CSP（生产）与 `devCsp`（开发，含 Vite HMR 的 ws 与内联脚本豁免）。注意：**只设** **`csp`** **不设** **`devCsp`** **时开发模式也会套用生产 CSP，会卡死 Vite HMR**。新增前端资源类型（外部字体、media 元素、wasm 等）时两个 CSP 都要同步评估。

## 跨平台与 CI

* CI 有 Windows（`build-windows.yml`）和 macOS（`build-macos.yml`，Apple Silicon）两条构建线，均手动触发；改 Rust 依赖（尤其 df-tract/tract 这类重编译项）后两条线都要跑一遍验证。

* macOS 分发未配置签名与公证，CI 产物为 ad-hoc 签名，仅限自用；对外分发需配 Apple 证书 + notarization。

## 约定

* **版本号递增**：每次修改代码/配置完成后，把版本号 patch 位加 1（如 0.1.0 → 0.1.1），三处必须同步：`package.json`、`src-tauri/tauri.conf.json`（应用与安装包版本，运行时可见）、`src-tauri/Cargo.toml`（`Cargo.lock` 会在 cargo 构建时自动跟进）。纯文档微调（AGENTS.md/README/docs）可不递增。

* 文档与面向用户的错误消息用中文；代码注释中英混合，技术术语保留英文。

* `denoise` 是派生操作，绝不能覆盖原始录音。

* 前端 `dist/`、`node_modules/`、`src-tauri/target/` 均为产物目录，不要手工修改、不要提交构建噪音。

