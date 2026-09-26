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
3. **DeepFilterNet 降噪中间文件必须走 32-bit float WAV**。`denoise_audio` 只接受 48 kHz 单声道 WAV（hound 读得进 int16 与 float32）；采样率/声道不匹配由前端 `noiseReduction.ts` 的 `renderBuffer`（OfflineAudioContext）在处理前后做转换，不要把重采样塞进 Rust 侧。**不要退回 16-bit**（0.1.52 修）：口播录音的有效电平常在 −30 dBFS 量级，16-bit 下底噪那一段只剩个位数 bit，而模型的抑制决策正依赖对底噪的准确估计 —— 精度先丢，抑制质量跟着掉。前端写 `bufferToFloatWav`，Rust 侧输出也写 float，**不要再 clamp 到 ±1 再转 int**。前端读回走 `floatWavToBuffer` **自解析 WAV，不要用 `decodeAudioData`**：格式是我们自己写的，按 chunk 扫一遍即可，既不依赖 WebView 对 IEEE float WAV 的支持，也省一次编解码往返；**必须按 chunk 扫描，不能写死 44 字节偏移**（hound 写 float 时用 40 字节的 WAVE_FORMAT_EXTENSIBLE，我们写 16 字节的 PCMWAVEFORMAT，两种都得认）。**选区降噪必须做交叉淡化**（`replaceBufferRange`，10 ms）：降噪结果与原始在接缝处电平/相位不连续，硬拼接会留咔嗒声。
4. **临时录音文件命名约定** **`gap-gone-*.wav`** **且必须位于系统 temp 目录下的** **`gap-gone/`** **子目录**（Rust 侧统一用 `gap_gone_temp_dir()` 生成路径）。`validate_temp_recording_path`（被 `delete_recording_file` / `denoise_audio` 复用）依赖该前缀与父目录做安全校验，改命名或目录前先改校验。降噪临时路径由 `prepare_denoise_files` 生成，保证前缀合法。
5. **大文件禁止走** **`Vec<u8>`** **命令参数/返回值**。Tauri v2 自定义命令的参数走 JSON 数字数组序列化，长录音会卡死 IPC。一律走「临时文件 + 路径传参」：前端用 `@tauri-apps/plugin-fs` 的 `writeFile`/`readFile`（二进制 raw 传输），Rust 命令只收发路径字符串。capabilities 需同时含 `fs:allow-temp-read(-recursive)` / `fs:allow-temp-write(-recursive)`——**非递归权限只授权 temp 顶层文件，不含子目录**（踩过坑：临时文件移入 `temp/gap-gone/` 后读取被拒，报「无法完成录音文件」）。capability 是构建期注入的，改动后必须完全重启 `pnpm tauri dev`。
6. **DfTract 不是 Send（内含 Rc），不能放进 Tauri State；也绝不要缓存复用 —— 每个降噪任务都要新建模型**。模型只在 `gap-gone-denoise` 工作线程里创建与使用，命令只投递 `DenoiseJob`。**`init()` / `DFState::reset()` / `init_norm_states()` 这三行绝对不要调**（0.1.61 实测定位，见硬约束 14）。`DfTract::new` 已经把内部状态准备好了，再「重置」一次会**清掉滚动缓冲与归一化状态**，模型要再过 `df_order` 帧（5 帧 = 2400 采样 = 50 ms）才把它们填回来。后果两条：① 真实算法延迟从 **480** 变成 2880；② 输出在 5–16 kHz 上凭空多出最多 **+24 dB** 的改动（230 个块里 63 个高频上升），听感就是用户报的「人声发毛、明显异常」—— 找同一条素材、同一档位对照官方 `enhance_wav`（从不调用这三行），它逐块高频改动的最大值只有 −0.1 dB、一个块都没上升。0.1.59 曾用这套重置实测过「它不能复位滚动缓冲」，那个结论本身没错，但当时没追问**「那为什么要调它」**。（另：`denoise_worker` 仍然不缓存模型、每个任务重建 —— 复用会让输出漂移，这一条是 0.1.59 在还调着重置的条件下测的，去掉重置后没重新验证，但重建只要一两秒，先保留。）SenseVoice 转录同理常驻 `gap-gone-transcribe` 线程。
7. **设备选择用 cpal** **`Device::id()`（平台稳定 ID）**，不要用设备名——两台同名 USB 麦会选错。名称只做显示 label 和兜底匹配。
8. **大模型不进安装包**。SenseVoice 模型（\~230MB）运行时下载到默认模型根目录，支持用户手动放置。**Windows 上默认根目录是仓库内的 `D:\Code\Github\gap-gone\models`**（本机自用、模型已手动放好；`WINDOWS_MODELS_ROOT` 只在它的上层目录存在时才采用，换机器会自动回落到主目录，见 `transcribe.rs` 的 `default_models_root`）；其他平台与回落路径一律是用户主目录的 `~/models`（0.1.6 起默认；此前为 `app_data_dir/models/`。HF 主站 + hf-mirror 镜像，`.partial` 过渡文件）。转录模型在其下的 `sense-voice/`，标点恢复模型（CT-Transformer int8，75MB）在同级 `punctuation-ct-zh-en/`。`transcribe_model_status` 是唯一就绪判定（`ready` = 转录文件齐全，`punctReady` = 标点文件齐全）。设置页「下载模型」一次拉齐两者（已存在则跳过）；转录时若仍缺文件也会再下。标点失败自动降级为无标点输出（`TranscriptResult.punctuated` 标记），绝不阻塞转录。**排查「改了默认值却还是旧路径」时先看 localStorage 的 `gap-gone-model-dir`**：前端启动时会把自定义目录经 `set_transcribe_model_dir` 推给 Rust，自定义优先于默认，要清空输入框点一次「应用路径」才会清掉。`models/` 已在 `.gitignore`，别把几百 MB 模型提交进仓库。
9. 录音错误通过 Tauri 事件 `recording-error` 上报前端；电平通过 `recording-level` 上报（含 RMS/Peak 与累计 Integrated `lufs`）；降噪进度通过 `denoise-progress` 上报（-1 表示正在加载模型）；转录进度通过 `transcribe-progress` 上报（stage: download/load/transcribe/punctuation）。
10. **播放走 `<audio>` 媒体元素，不要退回 `AudioBufferSourceNode`**。变速不变调只有媒体元素的 `preservesPitch` 能做（老 WebKit 还要一并设 `webkitPreservesPitch`），`AudioBufferSourceNode.playbackRate` 是磁带式变速，变快必升调。播放源是当前缓冲编码出的 16-bit WAV blob，因此 `audio.currentTime` 本身就是源时间轴位置，变速播放也不用做时间换算。两个易踩点：① 切除区间靠**保留段索引**跳过——rAF 里只把当前位置与「当前保留段」的端点比，越过段尾才跳到下一段开头并推进索引；**不要**每帧拿 `currentTime` 去 `nextPlayableTime` 重新推导该不该 seek：规范允许脚本运行期间读到滞后的播放位置（MDN: the reported playback position must remain stable while scripts are running），那会让同一次跳转被反复下发、媒体元素不停重启 seek，最后卡在段边界不出声（0.1.38 的真实 bug）。播放中用户跳转必须重建会话（走 `startPlayback`），否则段索引与新位置不一致。② 电平表仍从 buffer 抽样（`levelFromBuffer`），**不要**为了取电平把 `MediaElementSource`/`AnalyserNode` 串进音频图——macOS WKWebView 上会吞掉声音。AudioContext 从此只负责解码与离线渲染。
11. **播放源的编码时机与内存代价**。媒体源只在 `audioBuffer` 身份变化时重编码（打开/录完/降噪/响度归一/撤销），切除区间只改 `deletedRegions`，不触发重编码。`bufferToWav` 是同步的，长录音会占住主线程一会儿，所以要延到下一帧执行，先让「加载完成/处理完成」的画面画出来。内存上 AudioBuffer 与 16-bit WAV 会同时存在；若超长录音撑不住，改用「写临时 WAV + Tauri asset protocol」，改动面只在 `syncMediaSource` 一处。
12. **两侧电平表必须同口径**。录音侧由 Rust 每 100 ms（`sample_rate/10`）聚合上报 `recording-level`；播放侧 `levelFromBuffer` 也必须取 100 ms 窗口（`PLAYBACK_METER_WINDOW_SEC`），**不要**退回写死的 2048 采样——窗口不同，再叠加「录音侧有保持、播放侧没有」，同一段语音的 Peak 读数能差十几 dB（用户最常见的困惑，0.1.43 修）。稳定读数只用整段样本峰值：录音侧「保持」（`peakHoldDb`）与播放侧 `filePeakDb`（`bufferTruePeakDb`）同量纲、不随播放位置变，瞬时值只驱动条子与峰值针。录音表 -12 ~ -6 dBFS 画目标带（`METER_TARGET_RANGE`），落在带内即期望电平。表形上两处都是「RMS 柱 + 峰值白针」，录音侧另有保持白针；**柱与针一律不加 CSS 过渡**，rAF 已是逐帧刷新，再叠 60 ms 只会拖尾显得迟缓（0.1.45 删掉了）。注意录音侧底柱从前是峰值、和 RMS 同位置重叠，峰值恒 ≥ RMS 所以淡色 RMS 被完全盖住、只看得见一条（0.1.45 把峰值改成细针才拆开）。目标带只管峰值，别让它对着 RMS 底柱。
13. **一键语音优化链：链路顺序、自适应口径与播报都别乱改**。0.1.49 起「压缩」按钮从单纯压缩升级为整条链路，顺序固定「高通 80 Hz → 向下扩展 → 软拐点压缩 → 响度标准化」（`runVoiceChain`，`compression.ts`）。**真峰值限幅在整条链里只允许出现一次，就在末尾的归一里**（`normalizeLoudness` 内部的 `renderLimited`；它每轮都是从自己的输入重渲染，所以内部不叠加）——压缩段**不要**再自己调 `renderLimited`。**降噪（DeepFilterNet3）不入链**：它是异步工作线程（加载模型、可取消、耗时几十秒），塞进链路会把秒级按钮变成黑箱；它保持独立步骤，链路只在按钮旁给「建议先降噪」的灰字提示（`hasEnhancedAudio` 为 false 时显示，样式类 `.chain-hint`），残余底噪由扩展器兜。**高通复用 `lufs.ts` 导出的 `Biquad`**（`designHighPass` 现算 RBJ 系数），别再写第二套滤波器。**不要重新引入「自动补偿」**：0.1.46 的按最深处补偿（`makeupDb = -deepestGainDb`）已在 0.1.49 删除，它是静态抬全段、抬完由限幅器收拾，波形必然变成平顶香肠；更关键的是流水线末尾的归一按实测 LUFS 重算增益，会把这份补偿在数学上抵消 —— 收益归零，限幅留下的增益包络却不可逆。**「峰值没变小」由「目标 LUFS + 限幅上限」共同保证**，不靠抬全段假装。`compressBaseRef` 存「最近一次链路的输入」，重复点永远是换档位重算、不会叠压；基准在新录音/导入/恢复原始/确认降噪时清空，响度归一只清响度基准、**不**清压缩基准。压缩改了动态就让之前那次响度归一失效（按 `loudnessBaseRef` 回退后重算），**不要再提示用户「请重新点一次」**（0.1.48 前的旧文案）。撤销两级：「撤销压缩」整体回退到链路前，「撤销响度」只退归一那一步。**所有电平统计只算保留区间**（`getKeptRegions`），与 `integratedLufsFromBuffer` 同口径 —— 早先统计含已切除区间，切掉一段响噪音会把 P90 撑大、压缩比高估，对成片压过头。**扩展器与压缩器必须共用同一份统计**（`analyseSource` 的 `SourceLevels`），且扩展器阈值必须夹在「噪声底」与「语音 P10」之间、至少低于 P10 3 dB（`min(噪声底 + 6, P10 − 3)`）：压缩阈值就是 P10，扩展器一旦啃进语音最轻段，压缩量出的 P10 就成了假值，跨度自适应会自我打架；反过来阈值高于噪声底等于没做。扩展器做错比不做更糟，两条自动跳过规则不能删（底噪比语音有效电平低 30 dB 以上＝信噪比够好；阈值夹不出余量）。时间常数也要分开：扩展器 10 ms 检测 + 8 ms 张开 + 250 ms 合拢（张开慢了会吃词头），压缩器 30 ms 检测 + 档位起音/释放。**检测器一律用真 RMS 的一阶指数平滑，不要退回峰值包络**：语音峰值比有效值高 8 ~ 12 dB，按峰值判触发会让阈值照着尖峰设，结果只有偶发尖峰被压、整段起伏纹丝不动（0.1.43 的 -14 / -18 / -22 就是这个病，用户反馈「压不到」）。**阈值与压缩比必须由素材跨度生成，不要退回写死的三档阈值**。档位只声明「目标跨度」（轻 8 / 中 5 / 强 3 dB），`planCompression` 用 `analyseSource` 量出的输入跨度（P90 − P10）反推：压缩比 ≈ 输入跨度 ÷ 目标跨度（封顶 4:1）、阈值取 P10 附近（6 dB 软拐点）。测跨度剔气口的门限**必须锚在噪声底上（`噪声底 + SPEECH_GATE_MARGIN_DB`，现为 14 dB），绝不能锚在块电平中位数上**（0.1.60 修）。锚中位数有两个必炸的后果：① **中位数会随压缩移动，而压缩就是这条链的一环** —— 压缩把语音压低十几 dB → 中位数下降 → 门限跟着下降 → 原本被剔掉的气口重新进入统计，实测「输出跨度」反而比输入更大，播报里于是出现「跨度 19.2 dB → 24.5 dB」这种自相矛盾的读数（用户会以为压缩反了）；② 中等信噪比素材上气口只比中位数低约 19 dB，落不进「中位数 − 20 dB」的门限，气口于是被算成语音，**P10 直接变成气口电平** —— 压缩阈值落在气口上、压缩比一路顶到 4:1，同时扩展器的 `no-headroom` 判据（`P10 − 噪声底 > 9 dB`）恒不成立而**永久跳过**（0.1.60 实测：SNR 18.8 dB 的素材上 headroom 只有 1.59 dB）。噪声底是气口的电平，压缩在气口处增益≈0，它不随压缩移动；它同时是绝对量，麦克风增益整体平移时同步平移、门限跟着平移，判定不变 —— 所以锚它既不漂、也不随压缩移动。门限另外夹在「中位数」以下：素材全程连续说话、根本没有气口时，块电平的 P10 不是噪声底而是最轻的语音，此时门限高过中位数就会把一半动态当成噪声切掉。**量压缩输出时必须把「输入的噪声底」当锚传进 `measureSpanDb`**（`analyseSource` 的第三个参数），否则前后测的仍不是同一批块。写死阈值假定用户的输入增益落在预设区间里，事实不是 —— 0.1.45 的 -28 / -32 / -36 一漂就压空或压不动。三种边界都要如实播报，不许假装：`capped`（顶到 4:1 仍达不到目标跨度）、短素材兜底（剔气口后有效块不足 2 秒 → 「成片有效电平 − 3 dB、压缩比 2:1」）、`skipped`（跨度与目标差不到 1 dB）。**`skipped` 只跳过压缩那一步，链路仍要继续做响度标准化**，别写成提前 return，否则用户点「压缩」会以为功能坏了。播报里必须给「输入跨度 → 输出跨度」「成片有效电平」「平均压掉多少 dB」「扩展器是否生效及其阈值」「最终真峰值 + 限幅衰减」，压不到 1 dB 时直接提示用户去调麦克风增益 —— **别再播报「自动补偿 +X dB」**，压缩后峰值与最终真峰值两个数字并排会互相拆台，用户读到的是承诺→违约。

14. **DeepFilterNet 的引擎配置与运行时参数都必须对齐官方口径，别沿用库默认**。**模型用低延迟变体（`default-model-ll`，见硬约束 18）**。模型构造要用 `RuntimeParams::default_with_ch(1).with_thresholds(-15.0, 35.0, 35.0).with_mask_reduce(ReduceMask::MAX)`（`denoise_runtime_params()`），**不要**直接传 `default_with_ch(1)`（库默认是 −10 / 30 / 20 且 `reduce_mask: MEAN`）。crate 的 `apply_stages` 拿这三个阈值按帧的 local SNR 决定做多少处理：lsnr > `max_db_erb_thresh` → **整帧原封不动**（连增益都不算）；`max_db_df_thresh` < lsnr ≤ `max_db_erb_thresh` → 只做 ERB 掩蔽、**跳过 DeepFilter 第二级**；lsnr < `min_db_thresh` → 全零掩蔽。库默认的 df 阈值只有 20 dB，恰好把口播里「有语音、底下压着一层底噪」的帧（local SNR 约 20 ~ 35 dB）划进「跳过 DF」甚至「整帧不动」——**降噪在最需要它的地方被提前关掉**，实测听感就是「一说话噪声更明显」（0.1.53 用户实测后定位，官方 `enhance_wav.rs` 与 `capi.rs` 都是 −15 / 35 / 35）。这三个阈值只在 `DfTract::new` 时生效，**没有运行时 setter**；运行时可改的只有 `set_atten_lim`（档位）与 `set_pf_beta`（post-filter）。**`atten_lim` 不是「每频段最多压 N dB」**，而是「把原始含噪频谱按 `10^(−N/20)` 的比例全频段掺回输出」——轻档 12 dB 掺回 25%、中档 24 dB 掺回 6.3%、强档 36 dB 掺回 1.6%（原来给的是 100 dB，等于 `None`／完全不掺回，0.1.56 起封顶在 36 dB。**0.1.60 曾据一次实测断言「24 dB 以上整段阶梯空转」，0.1.61 已把它推翻**：那批数据是在还调着那套重置（见硬约束 6）的条件下跑的，而重置本身就会扰动输出。去掉重置后重测同一条素材，停顿段抑制量是 **轻 10.4 / 中 15.9 / 强 19.4 / 极限48 20.4 / 不掺回100 20.2 dB** —— 阶梯一直有效到约 48 dB 才饱和，36 与 48 之间还有约 1 dB。所以「档位没区分度」是假象。至于「100 dB 会在低信噪比素材上挖谱洞、压出破音」那个听感，仍然出自兜底算法时期（见硬约束 15/18），但**36 dB 这个封顶该不该留，需要一次干净的（无重置）听感实测再定**），改档位前先想清这一点。**必须补偿 `process` 的算法延迟，公式与官方一致、不要往里加 `df_order`**：`delay = fft_size − hop_size + lookahead × hop_size`（本模型 = 960 − 480 + 0 = **480 采样 = 10 ms**）。**官方 `enhance_wav` 的公式本来就是对的。**（0.1.59 曾在此断言「官方漏了 `df_order`、我们补 2880 才对」—— 那是**错的**：多出来的 5 帧来自同一个任务里多调的那套重置（见硬约束 6），当时两个错误正好抵消，自检一直报「滞后 0 采样」，把真正的问题盖住了。）**判据**：只跑 `diagnostic_denoise_alignment`，它打印的滞后应为 **0 采样**；偏了就会是 `hop_size`（480）的整数倍 —— 例如仍带着重置却按 480 补，会报 −2400。若想更硬，可用原始波形在中段做互相关复核（与官方输出对输入的 ρ 同量级）。**不补的话整段降噪会整体滞后**（与视频/字幕对不齐），**选区降噪直接错位**（交叉淡化只能盖住电平跳变，盖不住内容错位）。post-filter **保持关闭（`set_pf_beta(0.0)`）**。它会在「掩蔽不确定」的频点上再压一层，官方 CLI 默认 0.02，但**代价是语音失真**：低信噪比素材上「不确定」的频点特别多，0.1.54 试开 0.02 的结果是残余噪声没消掉、人声先发毛/破音，0.1.55 回退（用户实测）。另外注意链上顺序：post-filter 在「掺回原始噪声」之前跑（见 crate 的 `process`），所以它本来也压不掉 `atten_lim` 掺回的那部分 —— 那部分只能靠调档位来减（强档不掺）。

15. **降噪的调参有天花板，别指望旋钮能救回低信噪比素材**。DFN 的取舍就一条：`atten_lim` 大 → 留残余噪声（中档 24 dB 掺回 6.3%），`atten_lim` 往满里调到 `None` → 模型全力抑制，低信噪比素材上可能吐出谱洞与帧间抖动。**注意：0.1.53~0.1.55 那批「中档留残余、强档人声破音」的听感全部来自兜底算法，不是 DeepFilterNet**（见硬约束 18），所以「该素材已经到头了」这个结论必须在引擎真正跑起来之后重新判定 —— 别再拿那批听感当证据去否参数口径。**0.1.60 做过一次重判，0.1.61 又把那次重判推翻了** —— 历史值得记：0.1.60 用同一条素材跑「轻 12 / 中 24 / 强 36 / 极限 48 / 不掺回 100」，得到停顿段 −55.8 / −57.8 / −58.0 / −58.9 / −59.0 dBFS，于是断言「抑制在 ≈ 9.5 dB 处饱和、24 dB 以上无区分度、轻中强实际只有两态」。**但那批数据是在还调着那套重置（见硬约束 6）的条件下测的**，而重置本身会在 5–16 kHz 上凭空加最多 +24 dB 的东西、并扰动抑制量。去掉重置后重测（同素材、同档位）：停顿段抑制量 **10.4 / 15.9 / 19.4 / 20.4 / 20.2 dB**，即阶梯有效到约 48 dB 才饱和，语音段只降 1.5 ~ 1.6 dB。所以「天花板把手脚捆死了」这个判断**目前不成立**，降噪侧还有档位可用；真正被重置破坏的是高频（0.1.61 已修）。延迟补偿的判据仍然有效，但正确值是 **480 采样**（见硬约束 14）。每任务重建模型的输出仍逐采样可复现（自检断言）。**教训**：自检只报「滞后 0 采样」就以为万事大吉 —— 它测的是两个错误相抵的结果；**要顺带比「与官方参考实现的差异」**，见硬约束 16。

16. **去嘶声（7 kHz 以上高频压制）已在 0.1.58 移除，别再无条件加回来**。它当初的理由是「DeepFilterNet 的 DeepFilter 只覆盖约 5 kHz 以下，人声段那层嘶嘶是从高频漏出来的」——**但支撑它的证据（中档留残余、强档人声破音的听感）全部来自兜底算法，不是 DeepFilterNet**（见硬约束 18）。引擎真正跑起来之后再叠一层最多 10 dB 的高频衰减，只会把语音削「闷」、加重「发重」感，属于在没有证据的前提下动音色。要加回来必须先有**在 DFN 正常工作时**测到的残余高频噪声证据，并从更温和的深度（≤ 4 dB）起步。**0.1.60 曾据一批实测把它当成「偶发、窄时、宽带的模型伪影」，0.1.61 查明那个诊断是错的**：那 46 ~ 63 个（约 1/3）高频上升的块、最大 +24 dB，**根本不是模型产生的，而是同一个任务里多调的那套 `init()`/`reset()`/`init_norm_states()` 造成的**（见硬约束 6）。去掉重置后，同一条素材、同一档位下逐块 5–16 kHz 改动为：中位 −1.2 dB、P90 −0.3 dB、**最大值 −0.1 dB、0 个块上升**，与官方 `enhance_wav` 的输出逐块统计完全一致。**所以现在没有任何证据支持「加一层高频压制」**，去嘶声维持删除。**方法论仍然要记两条**：① 判断「是不是我们代码的问题」时，**要拿官方参考实现做同素材同参数的对照**，只跟自己的输入比容易把接线 bug 误当成模型特性；② **分带电平不能只对片段求和**（会被单个爆点主导 —— 最初把 15 个停顿块的功率求和得出「整体 +9 dB」，拆成逐块才发现是其中 2 个块贡献的，其余 13 个都在降），也不能只看一两个孤立指标 —— 同一个现象换一种统计口径（「逐块与输入相减」vs「块相对邻块的孤立度」）会给出不同画面，要两个都看。原实现见 git 历史（`applyDeHiss`，0.1.56 引入）。

17. **降噪失败绝不许静默回退到兼容性降噪**。桌面端 `applyNoiseReduction`（`noiseReduction.ts`）在 DeepFilterNet 路径抛错时会兜底调 `compatibilityReduction`，**这个兜底必须把原因一路带到界面**（`NoiseReductionResult.fallbackReason` → App 用 `error` 样式的 toast 明确写出「DeepFilterNet 未生效（原因）」），**不要再写成「悄悄换算法、promise 正常 resolve、只把引擎名塞进一句成功提示」**。原因：兜底算法与 DeepFilterNet 差一个量级，静默降级会让用户以为「降噪就这水平」，更糟的是让所有基于 DeepFilterNet 的调参（阈值口径、`atten_lim`、post-filter、延迟补偿……）都在解决一条根本没跑起来的路径上 —— 0.1.53~0.1.55 连续四轮调参、用户反复试听却「没有任何改进」，这个风险是真实的。兜底算法本身也有两个必须记住的硬缺陷（0.1.57 修）：**底噪不能取开头 250 ms** —— 口播一开口就是人声，估出来的「底噪」其实是语音电平，阈值被撑高、大量语音采样被误判成噪声压掉（强档 0.3 倍因子 + 2.2 倍阈值最严重）；**增益必须走平滑包络（检测 10 ms、起音 5 ms、释放 80 ms），绝不能逐采样按阈值硬切换** —— 那会在阈值上下反复开关、把波形切碎，听感就是「人声破音」。兜底的电平口径复用 `analyseSource`（整段块电平的低分位数），另写降噪兜底时不要自立一套。

18. **降噪引擎必须用 DeepFilterNet3 低延迟变体（`default-model-ll`），不是标准变体 —— 这是「能不能跑」的问题，不是性能取舍**。标准 `default-model` 的图在 tract 0.21.4 上过不了 codegen 之后的图压缩（`duplicate name /convt3/Conv.bias`），模型**加载直接失败**；失败又被 `noiseReduction.ts` 的兜底接住，于是降噪悄悄退化成那个粗糙的逐采样增益门 —— 所有基于 DeepFilterNet 的调参（阈值口径、`atten_lim`、post-filter、延迟补偿、float 中间格式）全都作用在一条没跑起来的路径上（0.1.53~0.1.56 四轮全部无效；0.1.57 靠自检定位）。低延迟变体同架构（48000 / hop 480 / fft 960 / nb_df 96），只是 lookahead 从 2 帧降到 0，恰好绕开那个算子（算法延迟按公式现算：`fft_size − hop_size + lookahead × hop_size`，本模型 = **480 采样 = 10 ms**，见硬约束 14。注意 0.1.59~0.1.60 期间这里写的是「2880 采样 = 60 ms」，**那个数字是错的** —— 多出来的 2400 来自同一个任务里多调的那套重置；`delay` 一律由 `model.lookahead` 等字段现算，不要写死数字），`DfParams::default()` 会优先取 `default-model-ll`。**动这块之前先跑两个自检**：① `cargo test --lib deepfilternet_engine_works` —— 不需要录音也不需要界面，加载 + 真推理几个 hop + 断言输出全是有限值，一次就能回答「引擎到底还能不能用」；② `GAP_GONE_DENOISE_TEST_WAV=<真实口播 wav> cargo test --lib diagnostic_denoise_alignment -- --nocapture` —— 用真实素材跑生产路径（复用同一个 `enhance_samples`），打印每档的滞后 / ρ / 块电平 P10·P50·P90，并把结果落盘到 `temp/gap-gone-dfntest/` 供人耳复核。档位循环已扩成「轻 / 中 / 强 / 极限48 / 不掺回100 + 中档复跑」，**复跑与首跑逐采样比对（断言）**，把「每任务重建模型确实复位了滚动缓冲」锁死；截取长度用 `GAP_GONE_DENOISE_TEST_SECONDS` 改（默认 15 秒，`0` 表示整段 —— debug 版推理很慢，素材多长自己掂量）。**这两个自检必须留着** —— 这类失败只在运行期暴露，而它曾经让用户连续四轮试听都「没有任何改进」却查不出原因。另外：`df` 的 rev `d375b2d` 只和 tract 0.21.4 的 API 对得上，`Cargo.toml` 里那 9 个 tract 版本必须整体锁死（升到 0.21.18 会因 `symbol_table` → `symbols` 等改动编译不过）；要升就 rev 和那 9 行一起动，升完立刻跑上面那个自检。

## 未结项（0.1.60 留待彻查）

0.1.60 那一轮改动留了尾巴，别当成已完成。现象、复现步骤与排查方向写在 `docs.md` 的「未结项（0.1.60 留待彻查）」，这里只列清单与判据：

1. **`SPEECH_GATE_MARGIN_DB = 14` 是拍的起点，需要用耳朵定**（`src/utils/compression.ts`）。它决定「多安静的块算气口」。偏大 → 把最轻的语音当成气口剔掉，跨度量小、阈值偏高，**轻的句子带不上来**；偏小 → 又回到「阈值落在气口上、压缩比顶 4:1、扩展器恒跳过」。**硬下限是必须大于 `EXPANDER_KNEE_DB + EXPANDER_SPEECH_MARGIN_DB`（= 9 dB）**，否则扩展器的 `no-headroom` 判据又会恒成立。判据：拿起伏明显的素材跑一次「压缩：中」，听最轻的几句有没有被带上来。**影响面（2026-09-26 实测）**：只动压缩那一环（阈值 / 跨度 / 压缩比 / 压掉量），**不产生失真、不改音色**（`applyCompression` 的增益恒 ≤ 0，只衰减不抬升），扩展器阈值与它无关；敏感度是连续无跳变的（余量 8 → 22：压缩比 2.93 → 1.60、平均压掉 7.3 → 2.0 dB），所以拍错不会翻车。可用区间 **12 ~ 18**，≥ 20 会被「夹在中位数以下」那个保护接管。
2. ~~降噪会在个别块上凭空抬高 5–16 kHz（偶发伪影）~~ —— **0.1.61 已定位并修复，关闭**。根因是每个降噪任务里多调的那套 `init()`/`reset()`/`init_norm_states()`（见硬约束 6），**不是模型、也不是 `atten_lim`**（当时测出「与档位无关」，恰恰是因为根因在接线里）。修复后同素材同档位的逐块 5–16 kHz 改动为「中位 −1.2 / P90 −0.3 / 最大值 −0.1 dB / 0 个块上升」，与官方参考实现逐块一致。当时的现场记录（影响面速查表、绝对电平表、听点 6.5 s 与 9.3 s）保留在 `docs.md` 的对应小节，可作前后对照。
3. **归一与真峰值限幅是校验盲区**。到目前为止对链路的数字复刻只覆盖到压缩为止（高通 / 扩展 / 压缩），播报里的「响度前 → 后 / 最终真峰值 / 限幅衰减」没有独立校验手段；下次再怀疑播报数字时先补上这一段，否则又会把复刻误差误判成代码 bug。
4. **导出位深 / 采样率：已评估、结论已定、暂不实施**（详见 `docs.md` 的「导出位深与采样率评估」）。要点：① 链路里有**两处** 16-bit，上游是**录音落盘**（`lib.rs` 的 `WavSpec` 写 i16，而设备多数给 float32 —— 浮点采样一进门就被砍），下游是 `bufferToWav` 的硬编码 16-bit；② **改 24-bit 的听感收益为零**（16-bit 量化噪声 ≈ −101 dBFS，比这类素材 −47 dBFS 的底噪低 54 dB，早被掩蔽），它的价值只在**交接与往返**（48 kHz / 24-bit 是视频后期与 DAW 的通用工作格式）；③ 两处比位深更值得动的地方 —— **采样率跟随设备、不保证 48 kHz**（`buildExportBuffer` 不重采样，44.1 kHz 麦就会导 44.1 kHz），以及 `bufferToWav` 里 `sample | 0` 是**向零截断**而不是四舍五入；④ 真要动时：**`bufferToWav` 不能整体改**（播放源、转录输入、导出三处共用），必须给导出单写一个 24-bit 编码器 + 设置项 `exportFormat` / `exportBitrate` 旁边加位深。

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

