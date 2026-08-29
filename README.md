# Gap Gone ✂️🔇

**Gap Gone** 是一个本地录音与音频剪辑工具，专为快速录制人声、跳过静音片段和清理背景噪声而生。基于 **Tauri** 和 **React** 构建。

![App Screenshot](./screenshot.png) <!-- 你可以在稍后截图放入 -->

## ✨ 核心特性

- **🚀 本地极速处理**: 所有处理均在本地完成，无需上传文件，隐私绝对安全。
- **🌊 多行波形乐谱**: 独特的“乐谱式”波形布局，长音频一目了然，无需频繁横向滚动。
- **🤖 智能去静音**: 内置 RMSE 算法，支持紧凑、自然、宽松三档保留策略；检测结果先预览，确认后才应用。
- **🛡️ 非破坏性编辑**: 智能识别仅标记“删除区域”，原文件不受影响。
- **🖱️ 高效交互**:
  - **右键拖拽**: 标记/添加删除区域。
  - **中键拖拽**: 擦除/恢复删除区域。
  - **空格键**: 播放/暂停。
- **本地录音**: 选择输入设备，录音前 3 秒倒计时，实时查看 RMS/Peak dBFS 电平，录音中可暂停、取消或停止。
- **削波提示**: -6 dBFS 以上显示黄色预警，检测到数字削波时右侧 CLIP 红标锁存，点击即可清除。
- **电平刻度**: 录音长条标出 -24、-18、-12、-6 和 -3 dB，越靠右越接近 0 dBFS。
- **多行波形乐谱**: 每行代表 10 秒，默认 1280×800 窗口完整显示 1000px 波形，最小窗口宽度 1100。
- **非破坏性编辑**: 手动切除、自动检测、恢复、撤销/重做都不会覆盖原始录音。
- **智能降噪**: 桌面端使用标准 DeepFilterNet3 离线处理，提供轻、中、强三档并支持试听。
- **播放时跳过**: 标记的片段在播放和 WAV 导出时都会跳过，成片时长会缩短。
- **WAV 导出**: 第一阶段导出 48 kHz、单声道 PCM WAV。

工具栏分为两行：上排放去静音、降噪、导出和帮助；下排放打开、录音、播放及选择/切除/恢复/撤销/重做。

## 🛠️ 技术栈

- **Core**: [Tauri v2](https://tauri.app) (Rust)
- **Frontend**: React + TypeScript + Vite
- **Audio Processing**: Web Audio API + Rust/CPAL + DeepFilterNet3

## 📦 安装与运行

### 前提条件

- [Rust](https://www.rust-lang.org/tools/install)（含 cargo）
- [Node.js](https://nodejs.org)（建议 18+）
- **Windows 额外要求**：MSVC Build Tools（含 C++ 桌面开发工作负载）+ WebView2 运行时（Windows 10/11 通常已预装）

### 克隆项目

```bash
git clone https://github.com/your-username/gap-gone.git
cd gap-gone
```

### 安装依赖

```bash
# npm（默认）
npm install

# 或 pnpm
pnpm install
```

> 项目默认配置为 npm（`tauri.conf.json` 中 `beforeBuildCommand` 为 `npm run build`）。切换到 pnpm 时需同步修改该配置并提交 `pnpm-lock.yaml`。

### 启动开发模式

```bash
# npm
npm run tauri dev

# pnpm
pnpm tauri dev
```

开发服务器地址：`http://localhost:1420/`。如果仍显示旧界面，停止旧 Vite 进程后重新运行即可。

### 构建应用

```bash
# npm
npm run tauri build

# pnpm
pnpm tauri build
```

> 首次编译需下载并编译全部 Rust 依赖（含 DeepFilterNet3 + tract），耗时约 30–60 分钟；后续增量编译会快很多。

### 构建产物位置

构建完成后，产物位于 `src-tauri/target/release/`：

| 平台 | 可执行文件 | 安装包 |
|---|---|---|
| **Windows** | `gap-gone.exe` | `bundle/nsis/gap-gone_0.1.0_x64-setup.exe`（NSIS）、`bundle/msi/*.msi`（MSI） |
| **macOS** | `gap-gone.app` | `bundle/dmg/gap-gone_*.dmg` |
| **Linux** | — | `bundle/deb/*.deb`、`bundle/appimage/*.AppImage` |

可执行文件可直接双击运行，安装包用于分发。

### 仅构建前端

```bash
# npm
npm run build

# pnpm
pnpm build
```

输出到 `dist/`。不要直接双击 `dist/index.html`，资源路径和部分 Tauri API 需要通过 HTTP 服务加载。预览前端：

```bash
npm run preview -- --host 127.0.0.1
# 或 pnpm preview --host 127.0.0.1
```

### CI 自动构建（GitHub Actions）

项目内置 `.github/workflows/build-windows.yml`，可在 GitHub Actions 上自动构建 Windows 安装包：

- **手动触发**：仓库 Actions 页面 → 选中 "Build Windows App" → Run workflow（可选择任意分支）
- **推送触发**（可选）：取消 `on.push` 部分的注释即可在推送时自动构建

构建产物会作为 Artifact 上传，可在 Actions 运行页面下载。

## 🎮 使用指南

1. 先打开录音设置选择麦克风，点击 **“确定”** 关闭设置窗口，再点击 **“录音”**，或直接打开音频文件。
2. 点击录音后先显示 3、2、1；倒计时期间可以取消，结束后才开始采集。
3. 录音时查看 RMS、Peak 和峰值保持 dBFS，可点击 **“暂停”**、**“取消”** 或 **“停止录音”**。
4. 停止录音后选择 **“取消”** 或 **“确定并编辑”**。
5. 在编辑页选择去静音预设，点击 **“检测静音”**，检查波形候选区间后点击 **“应用检测”**；不满意时可 **“清除候选”** 或 **“恢复本次检测”**。
6. 使用选择、切除、恢复和撤销/重做工具；选择切除或恢复后也可以直接拖拽波形。
7. 选择降噪强度，点击 **“一键降噪”**，播放试听后确认或取消。
8. 满意后点击 **“导出 WAV”**，保存处理后的音频文件；默认文件名会带有精确到秒的日期时间前缀，例如 `20260823-233600-edited-audio.wav`。

## ⌨️ 快捷键与鼠标操作

- `Space`：播放 / 暂停；播放中点击波形会跳转并继续播放，暂停时点击只移动播放头。
- `D`：检测静音并生成候选预览。
- `R`：空闲时开始录音。
- `Shift+R`：恢复最近一次已经应用的自动检测结果，不影响手动切除。
- `P`：录音中暂停 / 继续。
- `S`：录音中停止并进入录音结果预览。
- `⌘/Ctrl+Z`：撤销；`⌘/Ctrl+Shift+Z`：重做。
- `⌘/Ctrl+S`：导出 WAV。
- `O`：打开音频文件。
- `Enter`：录音结束后确定并进入编辑。
- `Esc`：取消录音倒计时、录音中取消并返回编辑页，或取消录音结果；帮助打开时关闭帮助。
- `H` 或 `?`：打开帮助。
- 右键拖拽切除，中键拖拽恢复；左键行为由当前选择、切除或恢复工具决定。

去静音检测与手动编辑使用独立的区间来源。自动检测恢复时只移除自动检测结果，手动切除会继续保留；所有操作都支持撤销和重做。

## DeepFilterNet3

标准模型在桌面端本地运行，不上传音频。模型文件约 8.5 MB，参考实现以 48 kHz 单声道语音为目标，典型算法延迟约 40 ms。第一阶段只做录音后的离线处理，因此不需要约 35 MB 的低延迟模型。降噪不是无损操作，强档可能产生伪影，请保留原始版本并用试听结果选择强度。

## 📄 License

[MIT](./LICENSE)
