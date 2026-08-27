# macOS 跨平台编译 Windows 版本说明

本文记录 Gap Gone 在 Apple Silicon macOS 上交叉编译 Windows 版本时使用的方法、所需组件、不同交叉编译目标的区别，以及当前安装包打包失败的原因。

## 一、项目与构建结论

本项目是一个 Tauri v2 应用：

- 前端：React + TypeScript + Vite
- 桌面后端：Rust + Tauri
- 音频输入：CPAL
- 降噪：DeepFilterNet3
- 当前构建主机：Apple Silicon macOS（`aarch64-apple-darwin`）
- 当前目标：64 位 Windows（`x86_64`）

本次已经验证：

1. 前端 TypeScript 检查和 Vite 构建成功。
2. Rust Windows 目标编译成功。
3. 生成了 Windows PE32+ 64 位 `.exe` 文件。
4. NSIS 安装包生成失败，原因是缺少 `makensis.exe`。

因此，“应用本体编译成功”和“安装包生成成功”是两个不同阶段。目前完成的是前者。

## 二、使用 MinGW-w64 的编译方法

### 1. 安装 Rust Windows 目标

确保已经安装 Rust 和 rustup，然后执行：

```bash
rustup target add x86_64-pc-windows-gnu
```

`x86_64-pc-windows-gnu` 表示面向 64 位 Windows、使用 GNU/MinGW ABI 的 Rust 编译目标。

### 2. 安装 Windows GNU 链接器

当前使用的是 MinGW-w64 GCC。验证命令：

```bash
command -v x86_64-w64-mingw32-gcc
x86_64-w64-mingw32-gcc --version
```

本次实际使用的链接器是：

```text
/opt/homebrew/bin/x86_64-w64-mingw32-gcc
```

如果不使用 Homebrew，也可以使用 LLVM-MinGW、MacPorts、Conda 或 Nix 提供的 MinGW 工具链。关键是最终能够找到下面这个兼容目标的链接器：

```text
x86_64-w64-mingw32-gcc
```

### 3. 构建 Windows `.exe`

在项目根目录执行：

```bash
PATH="$HOME/.cargo/bin:$PATH" \
CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER="$(command -v x86_64-w64-mingw32-gcc)" \
pnpm tauri build --target x86_64-pc-windows-gnu --no-bundle
```

其中：

- `PATH` 确保能找到 rustup、cargo 和 tauri CLI。
- `CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER` 告诉 Cargo 使用 MinGW-w64 链接器。
- `--target x86_64-pc-windows-gnu` 指定 Windows 64 位 GNU 目标。
- `--no-bundle` 跳过 MSI/NSIS 安装包生成，只生成应用本体。

构建过程会自动执行项目配置中的：

```bash
pnpm build
```

该命令先检查 TypeScript，再生成 `dist/` 前端文件，随后由 Tauri 编译 Rust 后端并把前端资源嵌入应用。

### 4. Windows 文件的交付方式

当前已整理出的交付目录是：

```text
dist-windows/
├── gap-gone.exe
└── WebView2Loader.dll
```

Windows 用户应复制整个目录，而不是只复制 `.exe`。两个文件必须位于同一个文件夹中，然后双击：

```text
gap-gone.exe
```

目标电脑还需要安装 Microsoft Edge WebView2 Runtime。官方页面：

<https://developer.microsoft.com/microsoft-edge/webview2/>

下载页面中的 **Evergreen Standalone Installer x64** 即可。Windows 10/11 很多情况下已经安装了 WebView2，但并不保证所有电脑都有。

## 三、需要下载的组件

### A. 编译应用本体所需组件

| 组件 | 用途 | 获取方式 |
| --- | --- | --- |
| Node.js | 运行前端构建工具 | <https://nodejs.org/> |
| pnpm | 安装 JavaScript 依赖 | <https://pnpm.io/installation> |
| Rust + rustup | 编译 Tauri 的 Rust 后端 | <https://www.rust-lang.org/tools/install> |
| `x86_64-pc-windows-gnu` Rust 标准库 | 让 Rust 输出 Windows 64 位程序 | `rustup target add x86_64-pc-windows-gnu` |
| MinGW-w64 或 LLVM-MinGW | Windows GNU 链接器和运行时库 | 见下文的交叉编译器比较 |

项目的 JavaScript 依赖由 `pnpm install` 根据 `pnpm-lock.yaml` 安装；Rust 依赖由 Cargo 根据 `src-tauri/Cargo.toml` 和 `Cargo.lock` 下载。

### B. 生成安装包所需组件

| 组件 | 用途 | 备注 |
| --- | --- | --- |
| NSIS | 生成 `*-setup.exe` 安装程序 | 需要 `makensis`/`makensis.exe` |
| LLVM/LLD | MSVC 交叉编译时提供链接工具 | 推荐与 `cargo-xwin` 配合 |
| Windows SDK | 提供 Windows API、CRT 和导入库 | `cargo-xwin` 可以协助下载和准备 |
| WiX Toolset | 生成 `.msi` 安装包 | 通常只能在 Windows 上运行 |

NSIS 的官方页面：

<https://nsis.sourceforge.io/Download>

Tauri 官方文档对 macOS/Linux 交叉生成 NSIS 有说明，但该路径兼容性和测试程度不如在 Windows 构建。macOS 上如果本地包管理器不可用，可以考虑 MacPorts、Nix、Conda 或直接使用 Windows 虚拟机/GitHub Actions；NSIS 在 macOS 上没有像 Windows 那样统一、可靠的官方安装体验。

### C. 目标 Windows 电脑运行时所需组件

| 组件 | 用途 |
| --- | --- |
| `gap-gone.exe` | 应用程序本体 |
| `WebView2Loader.dll` | Tauri 加载 WebView2 的本地 DLL |
| Microsoft Edge WebView2 Runtime | 提供应用界面所使用的 WebView2 引擎 |

`WebView2Loader.dll` 必须和 `.exe` 放在同一目录。WebView2 Runtime 是目标电脑上的运行环境，不参与 macOS 编译。

## 四、交叉编译器和 Rust 目标的区别

这里容易把“Rust 编译目标”“链接器”“SDK”“安装包工具”混为一谈。它们承担的职责不同。

### 1. `x86_64-pc-windows-gnu`

- 面向 64 位 Windows。
- 使用 GNU/MinGW ABI。
- 通常配合 MinGW-w64 GCC 或 LLVM-MinGW。
- 在 macOS/Linux 上比较容易先生成 `.exe`。
- 本次项目使用的就是这个目标。
- Tauri 对该路径的跨平台打包支持属于实验性路径，兼容性不如 MSVC。

它适合：

- 快速验证 Windows `.exe` 是否能生成。
- 本地没有完整 Windows SDK 时做交叉编译。
- 暂时只需要应用本体、不需要正式安装器的场景。

### 2. `x86_64-pc-windows-msvc`

- 面向 64 位 Windows。
- 使用微软 MSVC ABI。
- 是 Tauri 官方更推荐的 Windows 目标。
- 通常需要 MSVC、Windows SDK 和微软兼容的链接环境。
- 在 macOS/Linux 上可使用 `cargo-xwin` 加 LLVM/LLD 进行交叉编译。

它适合：

- 正式发布的 Windows 版本。
- 与 Windows 原生库、SDK 和第三方依赖保持更好的兼容性。
- 配合 Tauri 生成 NSIS 安装包。

macOS 上的典型准备方式是：

```bash
rustup target add x86_64-pc-windows-msvc
cargo install --locked cargo-xwin
```

然后使用：

```bash
pnpm tauri build \
  --target x86_64-pc-windows-msvc \
  --runner cargo-xwin \
  --bundles nsis
```

该方案仍需要 LLVM、NSIS 和 Windows SDK，构建时间也会更长。

### 3. `x86_64-pc-windows-gnullvm`

- 同样面向 64 位 Windows。
- 使用 GNU 兼容 ABI，但链接路径以 LLVM 工具链为主。
- 它不是 MSVC 目标，也不是简单地把 `-gnu` 目标换一个名字。
- 需要 LLVM/MinGW 相关的导入库和运行时环境。
- 对 Tauri 项目来说通常不是第一选择，除非明确需要 LLVM GNU 链接链路。

### 4. 其他架构目标

| 目标 | 用途 |
| --- | --- |
| `i686-pc-windows-gnu` | 32 位 Windows，适用于较老的 32 位系统 |
| `aarch64-pc-windows-msvc` | Windows on ARM 64 位 |
| `arm64ec-pc-windows-msvc` | Windows ARM64EC 兼容场景 |

普通 Windows 10/11 电脑优先选择 `x86_64`。`i686` 会增加兼容性限制，ARM64 目标也不适合作为普通 x64 电脑的默认版本。

### 5. 各工具的职责对照

| 名称 | 它是什么 | 它不是什么 |
| --- | --- | --- |
| Rust target | Rust 的目标 ABI 和平台定义 | 不是完整编译器安装包 |
| MinGW-w64 GCC | GNU Windows 链接器和工具链 | 不是 Rust 本身 |
| LLVM-MinGW | 基于 LLVM/Clang 的 Windows GNU 工具链 | 不是安装包生成器 |
| `cargo-xwin` | 为 MSVC 交叉编译准备 Windows SDK/链接流程的 Cargo runner | 不是 Windows 虚拟机 |
| NSIS | Windows 安装包生成器 | 不是交叉编译器 |
| WiX | MSI 安装包生成工具 | 不是应用编译器 |
| WebView2 Runtime | 目标电脑上的网页渲染运行时 | 不是构建组件 |

## 五、当前打包问题

### 1. 实际错误

使用下面的命令时：

```bash
pnpm tauri build --target x86_64-pc-windows-gnu
```

Rust 编译阶段已经完成，并输出了：

```text
Finished `release` profile [optimized]
Built application at: .../audio-full-cut.exe
```

随后 Tauri 进入 NSIS 打包阶段，失败信息是：

```text
Running makensis to produce .../gap-gone_0.1.0_x64-setup.exe
failed to run command makensis.exe:
No such file or directory
```

这表示：

- `.exe` 应用本体已经成功生成。
- 失败发生在安装器生成阶段。
- 当前环境找不到 `makensis.exe`。
- 这不是 TypeScript、Rust 或业务代码编译错误。

### 2. 为什么 MSI 没有生成

项目的 `src-tauri/tauri.conf.json` 中配置了：

```json
"targets": "all"
```

这会让 Tauri 尝试生成所有可用格式。跨平台构建时：

- WiX MSI 通常只能在 Windows 上生成。
- NSIS 可以尝试跨平台生成，但需要正确安装并识别 NSIS 工具。
- 当前构建在 NSIS 阶段因缺少 `makensis.exe` 终止。

### 3. 当前可行方案

#### 方案 A：只发布可执行文件

继续使用：

```bash
pnpm tauri build --target x86_64-pc-windows-gnu --no-bundle
```

交付 `dist-windows/` 整个目录。该方案已经在本项目中验证成功。

#### 方案 B：在 macOS 上继续配置 NSIS

安装 macOS 可用的 NSIS、LLVM 和 Windows 交叉编译环境，然后只指定 NSIS：

```bash
pnpm tauri build \
  --target x86_64-pc-windows-msvc \
  --runner cargo-xwin \
  --bundles nsis
```

这条路径可以生成 `*-setup.exe`，但属于跨平台打包方案，可能还会遇到 NSIS 可执行文件名、插件、权限或 SDK 配置问题。

#### 方案 C：使用 Windows 或 GitHub Actions 打包

这是正式发布最稳妥的方案。在 `windows-latest` runner 或真实 Windows 电脑上执行：

```bash
pnpm install --frozen-lockfile
pnpm tauri build
```

Windows 环境可以正常安装 MSVC、Windows SDK、WiX 和 NSIS，通常可以同时生成：

```text
*.msi
*-setup.exe
```

如果使用 GitHub Actions，需要先把要构建的代码提交并推送到远程仓库；当前工作区中未提交的本地修改不会自动出现在远程构建机上。

## 六、推荐选择

| 目标 | 推荐方案 |
| --- | --- |
| 现在马上拿到可运行文件 | `x86_64-pc-windows-gnu` + `--no-bundle` |
| 本地 macOS 交叉生成 NSIS | `x86_64-pc-windows-msvc` + `cargo-xwin` + NSIS |
| 正式发布安装包 | Windows 电脑或 GitHub Actions |
| 需要 `.msi` | Windows 构建环境 |

当前项目的实际交付文件位于：

```text
/Users/baopeng/Work/github/gap-gone/dist-windows/
```

交付时请保留：

```text
gap-gone.exe
WebView2Loader.dll
```

并在目标 Windows 电脑上确认 WebView2 Runtime 已安装。
