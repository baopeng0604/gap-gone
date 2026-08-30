# Gap Gone 产品与实现说明

## 产品定位

Gap Gone 是面向博客作者和内容创作者的本地录音、去静音和轻量音频剪辑工具。它保留语音备忘录的简单流程，同时提供可视化波形和人声降噪。

工具栏吸顶显示、宽度自适应：上排放去静音、降噪、转录、导出和帮助；下排放打开、录音、设置、播放及选择/切除/恢复/撤销/重做。详见「界面布局与交互」一节。

## 录音流程

1. 在录音设置中选择输入设备，点击“确定”关闭设置窗口。
2. 点击录音后先进入 3 秒准备倒计时（界面前两拍显示「准备」，最后一拍显示「开始」，与提示音三拍对齐）。倒计时期间不采集音频，并可点击取消。
3. 倒计时结束后开始录音，观察实时 RMS、Peak 和峰值保持 dBFS 电平。最长可录 15 分钟，到达上限会自动停止并保留已录内容（界面有提示）。
4. 录音中可以暂停/继续、取消或停止。取消会丢弃当前录音并返回编辑页。
5. 可选开启耳机监听。默认关闭，避免扬声器反馈。
6. 点击停止录音后预览当前录音。
7. 点击取消会删除临时录音；点击确定并编辑会进入波形编辑页。
   录音相关按钮会直接显示对应按键提示：暂停/继续 `P`、取消 `Esc`、停止 `S`；顶部录音按钮显示 `R`。

录音采样率跟随设备默认格式（Windows WASAPI 与 macOS CoreAudio 都只接受设备原生格式，常见为 48 kHz，部分 USB 麦为 44.1 kHz），统一在回调中下混为单声道 PCM WAV。macOS 和 Windows 使用 Rust/CPAL 原生采集，浏览器开发环境保留 Web Media API 回退。

录音电平中，-6 dBFS 以上显示黄色预警；检测到数字削波时，右侧 CLIP 标记会锁存为红色。点击红色标记只会清除提示，不会修改录音。
长条电平条按 dBFS 刻度标出 -24、-18、-12、-6 和 -3 dB，越靠右代表电平越高、越接近 0 dBFS。

### 录音流稳定性：buffer underrun/overrun 修复记录（2026-08-27）

**现象**：Windows 录音过程中报错 "A buffer underrun or overrun occurred"，录音中断；报错后再次点击录音被「已经有录音正在进行」拒绝，已录内容无法取回。

**存在的原因**

1. 报错本体是 WASAPI 的 `AUDCLNT_E_BUFFER_ERROR`：音频回调必须在单个缓冲处理周期（约 10ms）内完成，否则采集端点缓冲区被覆盖。
2. 原实现在 cpal 实时回调里做了三件重活：加 `Mutex` 锁、逐样本写磁盘（WAV）、每个音频块跨进程 emit 一次 `recording-level` IPC 事件（约 100 次/秒）。任何一项超时都会触发该错误。
3. 错误回调只向前端透传消息，不回收 Rust 侧 `RecordingManager` 状态：流已死但 `active` 仍为 `Some`，导致重录被拒、临时 WAV 永不 finalize。
4. 与「旧 buffer 未清空」无关：每次新录音都会新建独立的采集流与 WASAPI 端点缓冲，旧缓冲随流销毁。

**如何修改**

* `src-tauri/src/lib.rs`：

  * 实时回调只做下混 + 经 mpsc 通道入队；新增 `gap-gone-wav-writer` 线程负责磁盘写入与电平统计。

  * 电平事件按 \~100ms 聚合后 emit，不再逐音频块发送。

  * 流报错后由独立线程 `gap-gone-recording-recovery` 回收：停掉失效流、finalize 已写入的部分录音、通过 `recording-error` 事件把 `{message, path}` 发给前端。错误回调本身只置标记，避免在音频线程内 drop 流导致自 join 死锁。

  * `start_recording` 遇到已标记 errored 的残留状态会自动清理，不再卡住重录。

  * `stop_recording` / `cancel_recording` 改为向写入线程发送 Finalize 指令并等待回执；通道 FIFO 保证停止前所有采样块已写盘。

* `src/useRecorder.ts`：

  * `recording-error` 载荷改为 `{message, path}`：读到部分录音时直接进入试听页并提示中断原因；读不到时维持原错误提示。

**潜在的风险**

1. mpsc 无界队列：写入线程被磁盘或杀毒软件卡住时，内存按约 192 KB/s 增长（48 kHz 单声道 f32）。必要时可改为有界通道 + 丢块计数，当前不做。
2. `stop_recording` 等待写入线程回执，磁盘彻底 hang 时命令不返回；与旧实现的同步 finalize 风险等价，非新增。
3. 电平表粒度从 \~10ms 变为 \~100ms 聚合；削波检测不会漏判（窗口内取峰值最大值），仅显示粒度变粗。
4. 录音中设备错误的 UI 行为变化（全平台）：从错误提示页改为进入试听页并保留中断前的部分录音，提示「录音中断，已保留中断前的部分录音」。
5. 平台差异：若 macOS CoreAudio 某些过载只丢包不触发 cpal 错误回调，自动回收不会触发，界面停留「录音中」需手动停止；原实现同样未覆盖此场景。

macOS 回归建议：正常录音→停止→试听、暂停/继续、录音中拔出设备、降噪链路。

**复发补充（2026-08-28）**：修复上线后仍有用户几分钟内触发同一报错。根因：当时的策略是「任何流错误都拆流」，而 WASAPI 的 underrun/overrun（cpal 报 `ErrorKind::Xrun`）是**瞬时毛刺**——系统调度抖动、杀毒扫描、DPC 延迟都可能触发，只丢极少量采样，流本身还活着。二次修复：错误回调按 `error.kind()` 分流——`Xrun` 只计数（随 `recording-level` 事件的 `glitches` 字段上报，录音界面显示"采集毛刺 ×N"），录音继续；只有设备拔出/流失效等真致命错误才走回收保留流程。

### 跨平台兼容与 IPC 传输修复记录（2026-08-27）

**背景**：审核发现三个跨平台风险，本次全部修复。

**1. 非 48 kHz 设备降噪静默降级**

* 现象：`denoise_audio` 只接受 48 kHz 单声道，而录音直接采用设备默认采样率。macOS 上大量 USB 麦克风默认 44.1 kHz，这些设备会无声地退回效果较弱的「兼容性降噪」，界面无提示。

* 修改：`src/utils/noiseReduction.ts` 新增 `renderBuffer`，用 OfflineAudioContext 在送 DeepFilterNet3 前重采样/下混到 48 kHz 单声道，处理完再还原回原始采样率与声道数。桌面端任何设备格式都走 DeepFilterNet3，结果消息仍会标明实际使用的引擎。

**2. 大文件 IPC 传输卡死风险**

* 现象：`read_recording` 与 `denoise_audio` 用 `Vec<u8>` 收发 WAV 数据，Tauri v2 自定义命令参数走 JSON 数字数组序列化；10 分钟录音约 56 MB，会展开成数千万个数字，内存与序列化开销不可接受。

* 修改：改为「临时文件 + 路径传参」。

  * `src-tauri/src/lib.rs`：删除 `read_recording`；新增 `prepare_denoise_files`（由 Rust 生成合法的 `gap-gone-*` temp 路径对）；`denoise_audio` 改为收 `inputPath`/`outputPath`，从磁盘读入、写出到磁盘；路径校验统一收敛到 `validate_temp_recording_path`。

  * 前端：读录音与降噪结果改用 `@tauri-apps/plugin-fs` 的 `readFile`/`writeFile`（二进制 raw 传输，不经 JSON 数组）；capabilities 增加 `fs:allow-temp-read` / `fs:allow-temp-write`。

  * 降噪结束后前端经 `delete_recording_file` 清理两个临时文件；取消/失败路径在 `finally` 里同样清理。

**3. CI 只有 Windows 构建**

* 新增 `.github/workflows/build-macos.yml`（macos-latest，Apple Silicon），与 Windows 流水线同结构（npm ci + rust-cache + tauri build），手动触发。改 df-tract/tract 等重依赖后两条流水线都要跑。

* 注意：macOS 产物为 ad-hoc 签名，自用没问题；对外分发会被 Gatekeeper 拦截，需要另配 Apple 开发者证书与公证流程。

**4. 三项细节优化（2026-08-27 晚）**

* **CSP 安全基线**：`tauri.conf.json` 原为 `csp: null`。现配置生产严格 CSP（`script-src 'self'`、禁内联脚本）+ 独立 `devCsp`（放行 Vite HMR 的 `ws://localhost:1420` 与 React 内联 preamble）。注意 Tauri 规则：只设 `csp` 不设 `devCsp` 时开发模式会套用生产 CSP，HMR 直接挂掉。

* **设备 ID 稳定化**：录音设备选择原先直接用设备名当 ID，Mac 上接两台同名 USB 麦会选错。现改用 cpal `Device::id()`（WASAPI endpoint ID / CoreAudio UID），名称只做显示与兜底匹配。

* **DeepFilterNet 模型缓存**：`denoise_audio` 原先每次调用都重建 DfTract（解析 tract 图 + 初始化运行时，数秒等待）。由于 DfTract 内含 `Rc` 不是 `Send`，无法放进 Tauri State，现改为常驻 `gap-gone-denoise` 工作线程缓存复用，命令只投递任务。复用前通过 `init()` + `DFState::reset()` + `init_norm_states()` 重置流式状态，防止上一段音频的归一化状态串扰。首次加载时 Rust 发 `denoise-progress = -1`，前端显示「正在加载降噪模型…」而不是卡在 0%。

### 临时目录归类 / 设置持久化 / MP3 导出（2026-08-30）

**1. 临时文件统一归档到 temp/gap-gone/（0.1.4）**

* 录音、降噪、转录的全部临时文件从系统 temp 根目录移入 `temp/gap-gone/` 子目录（Rust 侧 `gap_gone_temp_dir()` 统一生成，写前 `create_dir_all`）。`validate_temp_recording_path` 安全校验同步收紧为 parent 必须是该子目录。

* 设置页新增「临时文件目录」状态行：显示占用空间与文件数量（async 命令 `temp_storage_status`，磁盘遍历放 `spawn_blocking`）+ 一键清理按钮（`clear_temp_files`）。正在录音的文件因写入线程持有句柄删除会失败，自动跳过，不会误删进行中的录音。

* 设置页「确定」按钮移到第一行（录音设备行）右侧。

**2. temp 子目录的 fs 权限坑（0.1.5，踩坑记录）**

临时文件移入子目录后录音报「无法完成录音文件」。根因：capabilities 的 `fs:allow-temp-read` / `fs:allow-temp-write` **只授权 temp 顶层文件，不含子目录**（Tauri v2 ACL 定义）。修复：追加 `fs:allow-temp-read-recursive` / `fs:allow-temp-write-recursive`。教训：凡涉及 fs scope 的路径层级变化，capability 要同步评估递归权限。capability 是构建期注入的，改动后需完全重启 `pnpm tauri dev`。

**3. 转录模型默认目录改为 \~/models/sense-voice（0.1.6）**

`transcribe.rs` 的 `model_dir()` 默认值从 `app_data_dir()/models/sense-voice` 改为 `home_dir()/models/sense-voice`（用户自定义目录优先级不变）。注意：旧位置已有模型的用户需手动迁移，否则首次转录会重新下载 230MB。

**4. 倒计时界面文案与音频解耦（0.1.6）**

倒计时大字从数字「3、2、1」改为「准备」（前两拍）/「开始」（最后一拍），总时长与节奏不变（仍与 countdown.mp3 的 0/1/2s 三拍对齐）。代码注释已说明：后续换更短提示音时只需调整拍数与间隔，显示逻辑不用动。

**5. 设置持久化（0.1.7）**

新建 `src/utils/settings.ts` 统一管理用户偏好（localStorage，Tauri WebView 按 app identifier 隔离落盘）。新增持久化的设置：录音设备（cpal 稳定 id，设备被拔时回退默认设备）、静音检测预设、降噪预设、转录面板显隐、导出格式、MP3 码率。已有的 `gap-gone-auto-transcribe` / `gap-gone-model-dir` 两个 key 沿用不迁移。选型说明：备选 `tauri-plugin-store`（JSON 文件）需要 Rust+JS 双端依赖与异步初始化竞态处理，对当前体量属过度设计；如未来要做设置导出/同步再迁移。

**6. MP3 导出（0.1.7）**

* 编码器 `@breezystack/lamejs`（lamejs 维护分支，纯 JS 无 wasm，CSP 零改动）。`src/utils/mp3Export.ts` 按 LAME 1152 采样块分批编码，每 100 块让出主线程（`setTimeout 0`），长录音编码期间 UI 不冻结（导出按钮复用 `isProcessing` 禁用）。

* 设置页新增「导出格式」：MP3（默认）/ WAV 单选 + MP3 码率单选（96 / 128 推荐 / 192 kbps CBR mono）。导出按钮文案、保存对话框 filter、默认文件名扩展名均跟随格式。

* 码率参考：语音场景 128 kbps mono 已达人耳听感透明（约 0.9 MB/分钟，为 WAV 单声道 5.76 MB/分钟的 1/6）；纯语音体积优先选 96；音乐为主选 192。

* 注：lamejs 若因环境限制无法走 pnpm 安装（如 TRAE 沙箱拦 store），可从 registry 下载 tarball 手动解压到 node\_modules 并登记 package.json，但 `pnpm-lock.yaml` 需事后在正常终端 `pnpm install` 补齐。

**7. bufferToWav 两个历史 bug 修复（0.1.7）**

* 头部写入变量 `pos` 被数据循环复用，导致每次 WAV 导出丢失开头 44 帧（约 0.9ms）音频、末尾多 44 帧零。改用独立帧索引。

* 16-bit 缩放表达式 `(0.5 + sample < 0 ? ...)` 因运算符优先级实际求值为 `(0.5 + sample) < 0`，仅低于 -0.5 的采样走 32768 分支。修正为标准 `sample < 0 ? sample * 32768 : sample * 32767`。

**8. 降噪输出响度说明（-4.2 dB 现象排查，无代码改动）**

用户反馈降噪后峰值约 -4.2 dB，疑有限幅器。全链路排查结论：**代码中无固定增益/限制器**（录音直通、电平表纯测量、DF3 的 STFT 前端 vorbis 窗 50% overlap 完美重构、写出只 clamp ±1）。该响度下降是 DeepFilterNet3 模型行为：训练目标为 SI-SDR（信噪比）而非响度保持，语音段 mask 平均略小于 1，输出整体比输入低几个 dB 属正常。影响：无音质损害（远离削波）；导出响度偏小；整体电平低时静音检测 dBFS 阈值相对变宽松。另一嫌疑是系统麦克风级别（Windows 默认常为 85%\~90%）——录音中电平表若也卡 -4.2 则与App无关。如需修正，业界常规是降噪后峰值归一化到 -1 dBFS（RNNoise 管线惯例），后续可加。

## 界面布局与交互（2026-08-28 重构）

**工具栏**：`fixed` 悬浮改为 `sticky` 吸顶 + 文档流排布，宽度 `fit-content` 自适应（`min-width: 1100px`）。波形的 `padding-top` 和所有浮层卡片（录音倒计时/设置/试听、提示条）的写死 `top` 全部删除，改为跟在工具栏后自然流式排布——工具栏高度变化时下方内容自动跟随，不再反复错位。注意一个 CSS 坑：`.container` 必须用 `overflow-x: clip` 而不是 `hidden`，后者会创建滚动容器导致内部 sticky 全部失效。窄屏渐进降级：≤1120px 隐藏快捷键徽标，≤960px 隐藏分组标签。按钮更名：「恢复本次检测」→「恢复检测」（与编辑工具「恢复」区分）、「录音设置」→「设置」。

**转录面板**：`sticky` 吸底常驻，列表高度约 4 行（132px）内部滚动。波形区设最小高度，保证至少完整露出 3 行（含词带）。

**播放光标跟随**：播放头所在行滚出可视区时 `scrollIntoView` 到视口中间（平滑滚动）；行仍可见时不动，不打断用户浏览。按 10 秒行粒度检测。

**Space 误触修复（2026-08-28）**：工具栏按钮点击后焦点残留在按钮上，浏览器默认行为会用空格激活聚焦按钮（曾导致按 Space 误触发「选择」而非播放）。修复：键盘焦点守卫白名单加入 Space，keydown 阶段 `preventDefault` 阻断按钮激活，Space 永远只触发播放/暂停。

**设置页**：录音设备选择之外新增——转录模型目录（文本框显示当前生效路径，可自定义并保存，「打开目录」按钮在文件管理器中直达；自定义路径存 localStorage，启动时经 `set_transcribe_model_dir` 同步到 Rust 侧 `RecordingManager.transcribe_model_dir`）、「录音确定编辑后自动转录」开关（默认开启；实现上直接把解码后的 AudioBuffer 传给转录函数，避免闭包读到未更新的状态）、临时文件目录占用统计与一键清理（见 2026-08-30 记录）、导出格式与 MP3 码率。「确定」按钮位于第一行右侧。注意：切换到没有模型文件的新目录时，首次转录会向新目录重新下载 230MB，可手动把 `model.int8.onnx` + `tokens.txt` 复制过去。

**设置持久化（2026-08-30）**：录音设备、静音/降噪预设、转录面板显隐、导出格式与码率、自动转录、模型目录均经 `src/utils/settings.ts` 存 localStorage，跨启动保留（详见 2026-08-30 改动记录）。

**录制时长上限**：最长 15 分钟，到达自动停止并保留已录内容（`useRecorder` 监听 duration，原生/Web 双路径共用）。

## 编辑语义

波形每行表示 10 秒，默认窗口为 1200×800，单行波形宽度为 1000px。

* 选择工具：左键拖拽建立降噪选区。

* 切除工具：左键拖拽标记需要跳过的区域。

* 恢复工具：左键拖拽恢复已标记区域。

* 右键拖拽：兼容快捷方式，标记跳过区域。

* 中键拖拽：兼容快捷方式，恢复跳过区域。

* 去静音预设：提供紧凑、自然、宽松三档，默认自然；控制静音区间两端保留的声音。

* 检测静音：使用 RMSE 分析并生成候选区间，候选结果会先以预览层显示，不会立即修改编辑时间轴。

* 应用检测：确认候选区间后将其加入跳过区间；清除候选则放弃本次预览。

* 恢复本次检测：只移除最近应用的自动检测结果，不影响手动切除。

* 撤销/重做：编辑区间使用非破坏性历史记录。

“去静音/跳过”会同时影响播放和导出，输出时长会缩短；它不等同于保留时间轴的静音效果。原始 AudioAsset 始终保留。自动检测区间和手动切除区间分开记录，恢复自动检测时不会误删手动编辑。

### 快捷键

* `Space`：播放 / 暂停。播放中点击波形会跳转并继续播放，暂停时点击只移动播放头。

* `D`：检测静音并生成候选预览。

* `X`：切换到切除工具，再按一次返回默认（点按定位）模式。

* `C`：切换到恢复工具，再按一次返回默认（点按定位）模式。

* `N`：一键降噪；`B`：恢复原始（撤回已确认的降噪版本）；`T`：转录文字。

* `R`：空闲时开始录音。

* `Shift+R`：恢复最近一次已经应用的自动检测结果。

* `P`：录音中暂停 / 继续。

* `S`：录音中停止并进入录音结果预览。

* `⌘/Ctrl+Z`：撤销；`⌘/Ctrl+Shift+Z`：重做。

* `⌘/Ctrl+S`：导出音频（默认 MP3，可在设置中切换 WAV）。

* `O`：打开音频文件。

* `Enter`：录音结束后确定并进入编辑。

* `Esc`：取消录音倒计时、录音中取消并返回编辑页，或取消录音结果；帮助打开时关闭帮助。

* `H` 或 `?`：打开帮助。

## 降噪

桌面应用内置标准 DeepFilterNet3 模型。模型使用 Rust 原生处理链，在 48 kHz 单声道音频上执行离线处理；录音为其他采样率或立体声时，前端会在处理前后自动重采样转换，任何设备都能使用模型降噪。模型约 8.5 MB，随应用分发，不需要联网下载。

降噪提供轻、中、强三档。没有选区时处理整段音频，有选区时只替换选区。降噪结果先进入试听预览，确认后才成为当前版本，取消试听会恢复处理前版本。

DeepFilterNet3 主要面向人声背景噪声。它不是无损处理器，强度过高时可能产生金属音、吞字或过度抑制环境声。第一阶段不使用约 35 MB 的低延迟变体，因为当前目标是录音后的离线编辑。

## 语音转录（SenseVoice）

桌面端内置 SenseVoice-Small（int8）本地离线转录，经 sherpa-onnx 官方 Rust binding 接入，无需联网、无需 API key。支持中/英/日/韩/粤语自动识别，但**不做说话人分离**（多人对话不区分说话人）。

点击工具栏「转录文字」（快捷键 `T`）开始：首次使用会先下载模型（约 230MB，显示下载进度），之后转录全程本地完成。模型目录可在「设置」中自定义（默认 `~/models/sense-voice`，旁边有「打开目录」按钮直达；0.1.6 起默认目录从应用数据目录改到用户主目录，旧位置已有模型的需手动迁移）；「设置」中的「录音确定编辑后自动转录」默认开启。转录结果以两种形态呈现：**每行波形下方的逐字词带**（字按时间戳与波形横向对齐，正在播放的字高亮，被切除区间覆盖的字划线置灰，点击对应位置即跳转——词带是"瞄准镜"，切除/恢复仍用拖拽工具画区间）和**波形下方的句子面板**（点击句子跳转，播放句高亮跟随，可导出 `.srt` 字幕和 `.txt` 文字稿）。转录锚定原始完整时间轴，切除/恢复不需要重跑。

### 时间戳精度说明

SenseVoice 是 CTC 架构，输出字级（中文）/子词级（英文）时间戳，分辨率约 60ms，典型偏差 ±100\~200ms。适合"点字定位再听辨剪辑"，不适合当作精确切割点直接下刀。

### 模型文件位置与手动下载

模型目录（默认为用户主目录下的 `~/models/sense-voice/`，Windows 即 `C:\Users\<用户名>\models\sense-voice\`；0.1.6 之前默认在应用数据目录）：

目录中需要两个文件（应用会自动检测，齐全即跳过下载）：

| 文件                | 大小       | 说明                         |
| ----------------- | -------- | -------------------------- |
| `model.int8.onnx` | 约 229 MB | SenseVoice-Small int8 量化模型 |
| `tokens.txt`      | 约 309 KB | 词表                         |

**手动下载（国内网络推荐，走 hf-mirror 镜像）。Windows PowerShell：**

```powershell
$dir = "$env:USERPROFILE\models\sense-voice"
New-Item -ItemType Directory -Force $dir
curl.exe -L -o "$dir\model.int8.onnx" "https://hf-mirror.com/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09/resolve/main/model.int8.onnx"
curl.exe -L -o "$dir\tokens.txt" "https://hf-mirror.com/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09/resolve/main/tokens.txt"
```

**macOS 终端：**

```bash
dir="$HOME/models/sense-voice"
mkdir -p "$dir"
curl -L -o "$dir/model.int8.onnx" "https://hf-mirror.com/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09/resolve/main/model.int8.onnx"
curl -L -o "$dir/tokens.txt" "https://hf-mirror.com/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09/resolve/main/tokens.txt"
```

海外网络把 `hf-mirror.com` 换成 `huggingface.co` 即可（URL 其余部分不变）。也可以用浏览器打开上述链接下载，再把两个文件放进模型目录。

### 实现要点

* `src-tauri/src/transcribe.rs`：识别器常驻 `gap-gone-transcribe` 工作线程（模型只加载一次）；整段音频按 \~60s 在低能量点切块，块间汇报真实进度并检查取消标记；词级 token 聚合成句子（滤除 `<|...|>` 元标签），切分策略：标点优先，超过 8s 未遇标点则在 >0.4s 的词间停顿处下刀，15s 硬切——口语化演讲常常整段无标点，纯标点切分会产生分钟级超长字幕段。

* 下载：HuggingFace 主站 → hf-mirror 镜像依次尝试，先写 `.partial` 再改名，中途取消/断网不会留下半个文件被误判为已就绪。

* 前端：`src/utils/transcribe.ts`（16 kHz 重采样 + 临时文件传参 + SRT/TXT 导出）、`src/components/TranscriptPanel.tsx`（句子面板）。

## 导出

默认导出 MP3（128 kbps CBR 单声道，`@breezystack/lamejs` 前端编码），可在设置中切换为 WAV（48 kHz、单声道、16-bit PCM）或调整 MP3 码率（96 / 128 / 192 kbps）。默认文件名带有精确到秒的日期时间前缀，例如 `20260823-233600-edited-audio.mp3`，减少意外覆盖。MP3 编码为纯 JS 实现，按块分批让出主线程，长录音导出期间界面不冻结。设置跨启动保留（`src/utils/settings.ts`，localStorage）。

体积参考（单声道）：WAV 约 5.76 MB/分钟；MP3 128 kbps 约 0.9 MB/分钟、96 kbps 约 0.7 MB/分钟、192 kbps 约 1.4 MB/分钟。

## 构建与运行产物

`pnpm build` 只生成前端静态资源，输出目录为 `dist/`。由于构建页面使用根路径资源，不建议直接双击 `dist/index.html`；查看生产前端应运行：

```bash
pnpm preview --host 127.0.0.1
```

开发服务器默认使用 `http://127.0.0.1:1420/`。如果该地址仍显示旧代码，需要停止旧的 Vite 进程后重新运行 `pnpm dev --host 127.0.0.1`。

在 `pnpm dev` 或 `pnpm preview` 的浏览器环境中导出 WAV 会直接触发浏览器下载；Tauri 桌面应用则使用系统保存对话框。

`pnpm tauri build` 会生成桌面应用安装产物，通常位于 `src-tauri/target/release/bundle/`。macOS 应用位于 `macos/`，磁盘镜像位于 `dmg/`；具体产物取决于当前操作系统和 Tauri 打包配置。

## 平台权限

* macOS 使用 `Info.plist` 的 `NSMicrophoneUsageDescription` 和音频输入 entitlement。

* Windows 处理桌面应用麦克风权限、设备占用和蓝牙设备切换。

* Linux 保持可构建，后续验证 ALSA、PulseAudio 和 PipeWire。

