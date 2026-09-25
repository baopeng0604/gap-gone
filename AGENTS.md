# AGENTS.md

面向 AI 编码代理的项目指南。人类开发者也可当作快速上手文档阅读。

## 项目是什么

Gap Gone：一款录音 + 音频编辑桌面应用（Tauri 2）。核心能力：录音（电平监控/削波检测）、静音检测与区间切除、DeepFilterNet3 降噪、一键语音优化（高通 → 向下扩展 → 自适应压缩 → 响度归一）、本地转录（SenseVoice）、编辑时间轴回放与 MP3/WAV 导出。

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

* `src/App.tsx` — 主界面与状态编排，播放引擎也在这里（见硬约束 10、11）；`src/components/` 波形/时间轴/转录面板组件，其中 `PlaybackSidebar.tsx` 是左侧播放栏（从头播放、循环、变速）；`src/utils/` 音频分析（静音检测）、降噪、转录、一键语音优化链（`compression.ts`：高通 / 向下扩展 / 自适应压缩）、响度与真峰值限幅（`lufs.ts`：K 计权 LUFS、4× 过采样真峰值、前瞻限幅、`normalizeLoudness`）、MP3/WAV 导出、设置持久化（`settings.ts`，localStorage，新增用户设置一律走这里，key 前缀 `gap-gone-`）。

* `src-tauri/src/lib.rs` — 录音相关原生命令与 cpal 录音流管理（`RecordingManager` 状态机）；`src-tauri/src/transcribe.rs` — SenseVoice 转录（模型下载 + `gap-gone-transcribe` 工作线程）。

## 关键领域概念

见 `CONTEXT.md`（RecordingTake / AudioAsset / EditTimeline / TimeRange 等领域词汇与边界）。改功能前先读它，命名和注释保持与领域词汇一致。

## 硬约束（踩过坑的）

1. **Windows WASAPI 共享模式只接受设备默认混音格式**。`start_recording` 不能改声道数/采样率，否则 `Initialize` 返回 `AUDCLNT_E_UNSUPPORTED_FORMAT`。多声道在回调里 `downmix_to_mono` 下混。macOS 上不少 USB 麦默认 44.1 kHz，同样不要改设备格式。
2. **音频回调是实时线程**。不要在 cpal 回调里做磁盘 IO、锁竞争、跨进程 emit 等重活，否则 WASAPI 缓冲区超期（underrun/overrun，`AUDCLNT_E_BUFFER_ERROR`）。**注意区分错误级别**：`ErrorKind::Xrun` 是瞬时毛刺（丢极少采样，流还活着），只计数上报（`recording-level.glitches`），绝不能拆流；只有设备拔出等致命错误才走回收流程。
3. **DeepFilterNet 降噪只接受 48 kHz 单声道 16-bit WAV**（`denoise_audio` 有校验）。采样率/声道不匹配由前端 `noiseReduction.ts` 的 `renderBuffer`（OfflineAudioContext）在处理前后做转换，不要把重采样塞进 Rust 侧。
4. **临时录音文件命名约定** **`gap-gone-*.wav`** **且必须位于系统 temp 目录下的** **`gap-gone/`** **子目录**（Rust 侧统一用 `gap_gone_temp_dir()` 生成路径）。`validate_temp_recording_path`（被 `delete_recording_file` / `denoise_audio` 复用）依赖该前缀与父目录做安全校验，改命名或目录前先改校验。降噪临时路径由 `prepare_denoise_files` 生成，保证前缀合法。
5. **大文件禁止走** **`Vec<u8>`** **命令参数/返回值**。Tauri v2 自定义命令的参数走 JSON 数字数组序列化，长录音会卡死 IPC。一律走「临时文件 + 路径传参」：前端用 `@tauri-apps/plugin-fs` 的 `writeFile`/`readFile`（二进制 raw 传输），Rust 命令只收发路径字符串。capabilities 需同时含 `fs:allow-temp-read(-recursive)` / `fs:allow-temp-write(-recursive)`——**非递归权限只授权 temp 顶层文件，不含子目录**（踩过坑：临时文件移入 `temp/gap-gone/` 后读取被拒，报「无法完成录音文件」）。capability 是构建期注入的，改动后必须完全重启 `pnpm tauri dev`。
6. **DfTract 不是 Send（内含 Rc），不能放进 Tauri State**。降噪模型常驻 `gap-gone-denoise` 工作线程并缓存复用；命令只投递 `DenoiseJob`。复用前必须 `init()` + `DFState::reset()` + `init_norm_states()` 重置流式状态，否则上一段音频的归一化状态会串扰下一段。SenseVoice 转录同理常驻 `gap-gone-transcribe` 线程。
7. **设备选择用 cpal** **`Device::id()`（平台稳定 ID）**，不要用设备名——两台同名 USB 麦会选错。名称只做显示 label 和兜底匹配。
8. **大模型不进安装包**。SenseVoice 模型（\~230MB）运行时下载到默认模型根目录，支持用户手动放置。**Windows 上默认根目录是仓库内的 `D:\Code\Github\gap-gone\models`**（本机自用、模型已手动放好；`WINDOWS_MODELS_ROOT` 只在它的上层目录存在时才采用，换机器会自动回落到主目录，见 `transcribe.rs` 的 `default_models_root`）；其他平台与回落路径一律是用户主目录的 `~/models`（0.1.6 起默认；此前为 `app_data_dir/models/`。HF 主站 + hf-mirror 镜像，`.partial` 过渡文件）。转录模型在其下的 `sense-voice/`，标点恢复模型（CT-Transformer int8，75MB）在同级 `punctuation-ct-zh-en/`。`transcribe_model_status` 是唯一就绪判定（`ready` = 转录文件齐全，`punctReady` = 标点文件齐全）。设置页「下载模型」一次拉齐两者（已存在则跳过）；转录时若仍缺文件也会再下。标点失败自动降级为无标点输出（`TranscriptResult.punctuated` 标记），绝不阻塞转录。**排查「改了默认值却还是旧路径」时先看 localStorage 的 `gap-gone-model-dir`**：前端启动时会把自定义目录经 `set_transcribe_model_dir` 推给 Rust，自定义优先于默认，要清空输入框点一次「应用路径」才会清掉。`models/` 已在 `.gitignore`，别把几百 MB 模型提交进仓库。
9. 录音错误通过 Tauri 事件 `recording-error` 上报前端；电平通过 `recording-level` 上报（含 RMS/Peak 与累计 Integrated `lufs`）；降噪进度通过 `denoise-progress` 上报（-1 表示正在加载模型）；转录进度通过 `transcribe-progress` 上报（stage: download/load/transcribe/punctuation）。
10. **播放走 `<audio>` 媒体元素，不要退回 `AudioBufferSourceNode`**。变速不变调只有媒体元素的 `preservesPitch` 能做（老 WebKit 还要一并设 `webkitPreservesPitch`），`AudioBufferSourceNode.playbackRate` 是磁带式变速，变快必升调。播放源是当前缓冲编码出的 16-bit WAV blob，因此 `audio.currentTime` 本身就是源时间轴位置，变速播放也不用做时间换算。两个易踩点：① 切除区间靠**保留段索引**跳过——rAF 里只把当前位置与「当前保留段」的端点比，越过段尾才跳到下一段开头并推进索引；**不要**每帧拿 `currentTime` 去 `nextPlayableTime` 重新推导该不该 seek：规范允许脚本运行期间读到滞后的播放位置（MDN: the reported playback position must remain stable while scripts are running），那会让同一次跳转被反复下发、媒体元素不停重启 seek，最后卡在段边界不出声（0.1.38 的真实 bug）。播放中用户跳转必须重建会话（走 `startPlayback`），否则段索引与新位置不一致。② 电平表仍从 buffer 抽样（`levelFromBuffer`），**不要**为了取电平把 `MediaElementSource`/`AnalyserNode` 串进音频图——macOS WKWebView 上会吞掉声音。AudioContext 从此只负责解码与离线渲染。
11. **播放源的编码时机与内存代价**。媒体源只在 `audioBuffer` 身份变化时重编码（打开/录完/降噪/响度归一/撤销），切除区间只改 `deletedRegions`，不触发重编码。`bufferToWav` 是同步的，长录音会占住主线程一会儿，所以要延到下一帧执行，先让「加载完成/处理完成」的画面画出来。内存上 AudioBuffer 与 16-bit WAV 会同时存在；若超长录音撑不住，改用「写临时 WAV + Tauri asset protocol」，改动面只在 `syncMediaSource` 一处。
12. **两侧电平表必须同口径**。录音侧由 Rust 每 100 ms（`sample_rate/10`）聚合上报 `recording-level`；播放侧 `levelFromBuffer` 也必须取 100 ms 窗口（`PLAYBACK_METER_WINDOW_SEC`），**不要**退回写死的 2048 采样——窗口不同，再叠加「录音侧有保持、播放侧没有」，同一段语音的 Peak 读数能差十几 dB（用户最常见的困惑，0.1.43 修）。稳定读数只用整段样本峰值：录音侧「保持」（`peakHoldDb`）与播放侧 `filePeakDb`（`bufferTruePeakDb`）同量纲、不随播放位置变，瞬时值只驱动条子与峰值针。录音表 -12 ~ -6 dBFS 画目标带（`METER_TARGET_RANGE`），落在带内即期望电平。表形上两处都是「RMS 柱 + 峰值白针」，录音侧另有保持白针；**柱与针一律不加 CSS 过渡**，rAF 已是逐帧刷新，再叠 60 ms 只会拖尾显得迟缓（0.1.45 删掉了）。注意录音侧底柱从前是峰值、和 RMS 同位置重叠，峰值恒 ≥ RMS 所以淡色 RMS 被完全盖住、只看得见一条（0.1.45 把峰值改成细针才拆开）。目标带只管峰值，别让它对着 RMS 底柱。
13. **一键语音优化链：链路顺序、自适应口径与播报都别乱改**。0.1.49 起「压缩」按钮从单纯压缩升级为整条链路，顺序固定「高通 80 Hz → 向下扩展 → 软拐点压缩 → 响度标准化」（`runVoiceChain`，`compression.ts`）。**真峰值限幅在整条链里只允许出现一次，就在末尾的归一里**（`normalizeLoudness` 内部的 `renderLimited`；它每轮都是从自己的输入重渲染，所以内部不叠加）——压缩段**不要**再自己调 `renderLimited`。**降噪（DeepFilterNet3）不入链**：它是异步工作线程（加载模型、可取消、耗时几十秒），塞进链路会把秒级按钮变成黑箱；它保持独立步骤，链路只在按钮旁给「建议先降噪」的灰字提示（`hasEnhancedAudio` 为 false 时显示，样式类 `.chain-hint`），残余底噪由扩展器兜。**高通复用 `lufs.ts` 导出的 `Biquad`**（`designHighPass` 现算 RBJ 系数），别再写第二套滤波器。**不要重新引入「自动补偿」**：0.1.46 的按最深处补偿（`makeupDb = -deepestGainDb`）已在 0.1.49 删除，它是静态抬全段、抬完由限幅器收拾，波形必然变成平顶香肠；更关键的是流水线末尾的归一按实测 LUFS 重算增益，会把这份补偿在数学上抵消 —— 收益归零，限幅留下的增益包络却不可逆。**「峰值没变小」由「目标 LUFS + 限幅上限」共同保证**，不靠抬全段假装。`compressBaseRef` 存「最近一次链路的输入」，重复点永远是换档位重算、不会叠压；基准在新录音/导入/恢复原始/确认降噪时清空，响度归一只清响度基准、**不**清压缩基准。压缩改了动态就让之前那次响度归一失效（按 `loudnessBaseRef` 回退后重算），**不要再提示用户「请重新点一次」**（0.1.48 前的旧文案）。撤销两级：「撤销压缩」整体回退到链路前，「撤销响度」只退归一那一步。**所有电平统计只算保留区间**（`getKeptRegions`），与 `integratedLufsFromBuffer` 同口径 —— 早先统计含已切除区间，切掉一段响噪音会把 P90 撑大、压缩比高估，对成片压过头。**扩展器与压缩器必须共用同一份统计**（`analyseSource` 的 `SourceLevels`），且扩展器阈值必须夹在「噪声底」与「语音 P10」之间、至少低于 P10 3 dB（`min(噪声底 + 6, P10 − 3)`）：压缩阈值就是 P10，扩展器一旦啃进语音最轻段，压缩量出的 P10 就成了假值，跨度自适应会自我打架；反过来阈值高于噪声底等于没做。扩展器做错比不做更糟，两条自动跳过规则不能删（底噪比语音有效电平低 30 dB 以上＝信噪比够好；阈值夹不出余量）。时间常数也要分开：扩展器 10 ms 检测 + 8 ms 张开 + 250 ms 合拢（张开慢了会吃词头），压缩器 30 ms 检测 + 档位起音/释放。**检测器一律用真 RMS 的一阶指数平滑，不要退回峰值包络**：语音峰值比有效值高 8 ~ 12 dB，按峰值判触发会让阈值照着尖峰设，结果只有偶发尖峰被压、整段起伏纹丝不动（0.1.43 的 -14 / -18 / -22 就是这个病，用户反馈「压不到」）。**阈值与压缩比必须由素材跨度生成，不要退回写死的三档阈值**。档位只声明「目标跨度」（轻 8 / 中 5 / 强 3 dB），`planCompression` 用 `analyseSource` 量出的输入跨度（P90 − P10）反推：压缩比 ≈ 输入跨度 ÷ 目标跨度（封顶 4:1）、阈值取 P10 附近（6 dB 软拐点）。测跨度剔气口必须用**相对门限**（本段块电平中位数 − 20 dB），绝对 dB 门限会跟着增益漂：增益拧小 10 dB，原本有效的块会集体掉进门限以下被误剔，跨度就量歪了。写死阈值假定用户的输入增益落在预设区间里，事实不是 —— 0.1.45 的 -28 / -32 / -36 一漂就压空或压不动。三种边界都要如实播报，不许假装：`capped`（顶到 4:1 仍达不到目标跨度）、短素材兜底（剔气口后有效块不足 2 秒 → 「成片有效电平 − 3 dB、压缩比 2:1」）、`skipped`（跨度与目标差不到 1 dB）。**`skipped` 只跳过压缩那一步，链路仍要继续做响度标准化**，别写成提前 return，否则用户点「压缩」会以为功能坏了。播报里必须给「输入跨度 → 输出跨度」「成片有效电平」「平均压掉多少 dB」「扩展器是否生效及其阈值」「最终真峰值 + 限幅衰减」，压不到 1 dB 时直接提示用户去调麦克风增益 —— **别再播报「自动补偿 +X dB」**，压缩后峰值与最终真峰值两个数字并排会互相拆台，用户读到的是承诺→违约。

## 安全基线

* `tauri.conf.json` 配了严格 CSP（生产）与 `devCsp`（开发，含 Vite HMR 的 ws 与内联脚本豁免）。注意：**只设** **`csp`** **不设** **`devCsp`** **时开发模式也会套用生产 CSP，会卡死 Vite HMR**。新增前端资源类型（外部字体、media 元素、wasm 等）时两个 CSP 都要同步评估。

## 跨平台与 CI

* CI 有 Windows（`build-windows.yml`）和 macOS（`build-macos.yml`，Apple Silicon）两条构建线，均手动触发；改 Rust 依赖（尤其 df-tract/tract 这类重编译项）后两条线都要跑一遍验证。

* macOS 分发未配置签名与公证，CI 产物为 ad-hoc 签名，仅限自用；对外分发需配 Apple 证书 + notarization。

## 约定

* **版本号递增**：每次修改代码/配置完成后，把版本号 patch 位加 1（如 0.1.0 → 0.1.1），三处必须同步：`package.json`、`src-tauri/tauri.conf.json`（应用与安装包版本，运行时可见）、`src-tauri/Cargo.toml`（`Cargo.lock` 会在 cargo 构建时自动跟进）。纯文档微调（AGENTS.md/README/docs）可不递增。

* **功能改动要留档**：领域词汇与语义边界写进 `CONTEXT.md`，面向开发者/代理的踩坑与约束写进本文件（AGENTS.md），面向用户的能力与操作写进 `README.md`。新增功能或改语义时三份一起看，别只改代码。

* 文档与面向用户的错误消息用中文；代码注释中英混合，技术术语保留英文。

* `denoise` 是派生操作，绝不能覆盖原始录音。

* **播放速度与循环是会话内参数**，不写 localStorage：重启回到 1.0× 且不循环。它们是试听工具而不是文件属性，持久化容易让人误以为音频本身变快了、或者导出会跟着变。

* **改快捷键要同步四处**：`handleKeyDown` 的分支、`isToolbarShortcut` 白名单、按钮的 `aria-keyshortcuts` 与角标、`HelpModal` 的快捷键表。注意 `L` 已归循环播放，响度标准化是 `⇧L`；`[` `]` 调播放速度，别被 range 滑条的焦点守卫挡掉（该守卫已排除 `input[type=range]`）。

* 前端 `dist/`、`node_modules/`、`src-tauri/target/` 均为产物目录，不要手工修改、不要提交构建噪音。

