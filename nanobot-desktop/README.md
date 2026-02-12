# Nanobot Desktop

基于 Tauri + React 的 Nanobot 桌面端，提供本地可视化入口来启动/监控代理进程、对话并管理工作区文件。

## 功能
- **Chat**：向 `nanobot agent` 发送消息，支持 Markdown/GFM 渲染，展示调试日志（工具调用、子代理、堆栈）。
- **Monitor**：一键启动/停止 agent 与 gateway，实时查看双通道日志。
- **Cron**：读取 `~/.nanobot/cron/jobs.json`，查看已配置的定时任务。
- **Sessions**：浏览 `~/.nanobot/sessions/*.jsonl` 会话记录、搜索、批量删除行。
- **Skills**：列出/创建/编辑 `workspace/skills/<name>/SKILL.md`，可删除整项技能。
- **Memory**：编辑 `workspace/memory/MEMORY.md` 与每日笔记（YYYY-MM-DD.md），支持新建与删除。
- **Config**：热更新 `~/.nanobot/config.json`，保存后自动重启 agent/gateway（若正在运行）。

## 环境要求
- Node.js ≥ 18（含 npm）
- Rust 工具链 + Cargo（Tauri 2）
- Python ≥ 3.11（构建时需要）

## 快速开始
1) 在仓库根目录安装后端依赖：
   `uv sync`
2) 进入桌面端目录：
   `cd nanobot-desktop`
3) 安装前端依赖：
   `npm install`
4) 开发运行：
   `npm run tauri dev`
5) 正式打包：
   `npm run tauri build`

产物位于：`nanobot-desktop/src-tauri/target/`。

## Release 内置 Python（方案 B）
Release 构建会自动打包 **Python 运行时 + 依赖 + nanobot 源码**，运行时不依赖 `uv`。

构建流程由 `npm run prepare:runtime` 完成，默认会：
- 拷贝内置 Python 到 `nanobot-desktop/resources/python`
- 安装依赖到 `nanobot-desktop/resources/site-packages`
- 生成 `runtime_manifest.txt`

可选环境变量：
- `NANOBOT_EMBED_PYTHON`：指定“可移动 Python”根目录（推荐）
- `NANOBOT_EMBED_PYTHON_ARCHIVE`：指定 `.zip` / `.tar.gz` 运行时包路径（脚本会自动解压）

若不设置，脚本会尝试使用当前系统 Python（可能体积大且不可移动，不推荐）。

## 数据与配置
- 默认读取 `~/.nanobot/config.json`
- 工作区默认 `~/.nanobot/workspace`（可在 `config.json` 的 `agents.defaults.workspace` 覆盖）
- 会话目录：`~/.nanobot/sessions`
- 定时任务：`~/.nanobot/cron/jobs.json`
- 若设置环境变量 `NANOBOT_HOME`，以上路径会基于该目录
- 不再读取项目根目录 `.env`

## 使用提示
- 关闭窗口会隐藏到托盘，彻底退出请右键托盘图标 → Quit。
- 若消息不响应，先确认只运行了一个 `nanobot gateway`（多进程会互抢连接）。
- 首次启动若检测不到 `config.json`，会自动执行 `nanobot onboard`。

## 开发日志与排障
Windows / PowerShell 常用命令：

基础开发启动：
```
npm run tauri dev
```

将后端日志输出到 `tauri dev` 终端：
```
$env:NANOBOT_TAURI_LOG_STDOUT="1"; npm run tauri dev
```

打开更详细日志（注意日志量会显著增加）：
```
$env:NANOBOT_TAURI_LOG_STDOUT="1"
$env:LOGURU_LEVEL="DEBUG"
$env:NANOBOT_GATEWAY_VERBOSE="1"
npm run tauri dev
```

指定配置目录（便于多配置切换）：
```
$env:NANOBOT_HOME="D:\Personal_Project\pythonlearning\.nanobot"
npm run tauri dev
```

可选：开启进程扫描（默认关闭，避免 WMI 卡顿）：
```
$env:NANOBOT_SCAN_PROCS="1"
```

若编译失败提示 `nanobot-desktop.exe` 被占用，请先退出正在运行的桌面端进程后再编译。

## 目录说明
- `nanobot-desktop/`：前端 + Tauri 后端
- `nanobot/`：Python 核心与 CLI（桌面端直接调用）
- `bridge/`：示例桥接

## License
MIT License
