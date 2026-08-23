# 编译产物与运行说明

本文说明 Gap Gone 的前端构建产物、开发运行方式和 Tauri 桌面应用打包位置。

## 1. 构建前端文件

在项目根目录执行：

```bash
cd /Users/baopeng/Work/github/gap-gone
pnpm install
pnpm build
```

`pnpm build` 会先进行 TypeScript 类型检查，再生成前端静态文件。

构建结果位于：

```text
dist/
```

其中包括：

```text
dist/index.html
dist/assets/
```

文件名中的 hash 会随着每次构建变化。

## 2. 运行前端构建结果

不要直接双击 `dist/index.html`。Vite 构建页面使用根路径资源，直接以 `file://` 打开可能找不到 JavaScript 和 CSS 文件；部分 Tauri API 也只能在桌面环境中使用。

建议使用生产预览服务器：

```bash
cd /Users/baopeng/Work/github/gap-gone
pnpm preview --host 127.0.0.1
```

然后打开终端显示的地址，通常是：

```text
http://127.0.0.1:4173/
```

在浏览器开发/预览页面导出 WAV 时会直接下载文件；Tauri 桌面版会弹出系统保存对话框。

## 3. 运行开发版本

```bash
cd /Users/baopeng/Work/github/gap-gone
pnpm dev --host 127.0.0.1
```

开发地址通常是：

```text
http://127.0.0.1:1420/
```

如果 1420 端口上的页面仍显示旧代码，请先在运行旧 Vite 服务的终端按 `Ctrl+C`，再重新执行上面的命令。也可以先查看占用端口的进程：

```bash
lsof -nP -iTCP:1420 -sTCP:LISTEN
```

## 4. 运行 Tauri 桌面开发版

```bash
cd /Users/baopeng/Work/github/gap-gone
PATH="$HOME/.cargo/bin:$PATH" pnpm tauri dev
```

这会启动 Rust 后端和 Tauri 窗口。Tauri 开发配置使用 `http://localhost:1420` 作为前端地址。

## 5. 打包桌面应用

```bash
cd /Users/baopeng/Work/github/gap-gone
PATH="$HOME/.cargo/bin:$PATH" pnpm tauri build
```

通常的打包输出目录是：

```text
src-tauri/target/release/bundle/
```

macOS 常见产物：

```text
src-tauri/target/release/bundle/macos/gap-gone.app
src-tauri/target/release/bundle/dmg/gap-gone_*.dmg
```

在 macOS 上打开 `.app`：

```bash
open "src-tauri/target/release/bundle/macos/gap-gone.app"
```

如果只需要运行应用，优先打开 `.app`；`.dmg` 是用于分发和安装的磁盘镜像。

## 6. Markdown 文档的打开方式

本文是 Markdown 文档，不需要单独编译。可以直接用 VS Code、Cursor 或其他 Markdown 阅读器打开：

```bash
open BUILD.md
```

也可以在项目根目录用编辑器打开 `README.md`、`docs.md` 和本文。

## 当前构建状态

截至本文更新时，前端 `pnpm build` 已成功完成。最近一次构建产物仍位于项目根目录的 `dist/` 中。
