# AGENTS.md

面向 AI 编码代理的项目指南。人类开发者也可当作快速上手文档阅读。

## 项目是什么

Gap Gone：一款录音 + 音频编辑桌面应用（Tauri 2）。核心能力：录音（电平监控/削波检测）、静音检测与区间切除、DeepFilterNet3 降噪、编辑时间轴回放与 WAV 导出。

## 技术栈

- 前端：React 18 + TypeScript + Vite（`src/`）
- 桌面壳：Tauri 2（`src-tauri/`）
- Rust 音频：`cpal`（采集）、`hound`（WAV 读写）、`df-tract`（DeepFilterNet3 推理）
- 包管理：pnpm（仓库含 `pnpm-lock.yaml` 与 `pnpm-workspace.yaml`）

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

- `src/useRecorder.ts` — 录音 Hook。**双路径**：Tauri 桌面走原生命令（`start_recording` 等），浏览器/无命令时降级 Web Media API（getUserMedia + MediaRecorder）。改录音逻辑时两条路径都要考虑。
- `src/App.tsx` — 主界面与状态编排；`src/components/` 波形/时间轴组件；`src/utils/` 音频分析（静音检测）、降噪、WAV 导出。
- `src-tauri/src/lib.rs` — 全部原生命令与 cpal 录音流管理（`RecordingManager` 状态机）。

## 关键领域概念

见 `CONTEXT.md`（RecordingTake / AudioAsset / EditTimeline / TimeRange 等领域词汇与边界）。改功能前先读它，命名和注释保持与领域词汇一致。

## 硬约束（踩过坑的）

1. **Windows WASAPI 共享模式只接受设备默认混音格式**。`start_recording` 不能改声道数/采样率，否则 `Initialize` 返回 `AUDCLNT_E_UNSUPPORTED_FORMAT`。多声道在回调里 `downmix_to_mono` 下混。macOS 上不少 USB 麦默认 44.1 kHz，同样不要改设备格式。
2. **音频回调是实时线程**。不要在 cpal 回调里做磁盘 IO、锁竞争、跨进程 emit 等重活，否则 WASAPI 缓冲区超期（underrun/overrun，`AUDCLNT_E_BUFFER_ERROR`）。
3. **DeepFilterNet 降噪只接受 48 kHz 单声道 16-bit WAV**（`denoise_audio` 有校验）。采样率/声道不匹配由前端 `noiseReduction.ts` 的 `renderBuffer`（OfflineAudioContext）在处理前后做转换，不要把重采样塞进 Rust 侧。
4. **临时录音文件命名约定 `gap-gone-*.wav` 且必须位于系统 temp 目录**。`validate_temp_recording_path`（被 `delete_recording_file` / `denoise_audio` 复用）依赖该前缀与父目录做安全校验，改命名前先改校验。降噪临时路径由 `prepare_denoise_files` 生成，保证前缀合法。
5. **大文件禁止走 `Vec<u8>` 命令参数/返回值**。Tauri v2 自定义命令的参数走 JSON 数字数组序列化，长录音会卡死 IPC。一律走「临时文件 + 路径传参」：前端用 `@tauri-apps/plugin-fs` 的 `writeFile`/`readFile`（二进制 raw 传输），Rust 命令只收发路径字符串。capabilities 需含 `fs:allow-temp-read` / `fs:allow-temp-write`。
6. 录音错误通过 Tauri 事件 `recording-error` 上报前端；电平通过 `recording-level` 上报。

## 跨平台与 CI

- CI 有 Windows（`build-windows.yml`）和 macOS（`build-macos.yml`，Apple Silicon）两条构建线，均手动触发；改 Rust 依赖（尤其 df-tract/tract 这类重编译项）后两条线都要跑一遍验证。
- macOS 分发未配置签名与公证，CI 产物为 ad-hoc 签名，仅限自用；对外分发需配 Apple 证书 + notarization。

## 约定

- 文档与面向用户的错误消息用中文；代码注释中英混合，技术术语保留英文。
- `denoise` 是派生操作，绝不能覆盖原始录音。
- 前端 `dist/`、`node_modules/`、`src-tauri/target/` 均为产物目录，不要手工修改、不要提交构建噪音。
