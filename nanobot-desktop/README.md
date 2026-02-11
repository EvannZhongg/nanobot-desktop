# Nanobot Desktop

基于 Tauri + React 的 Nanobot 桌面端，提供本地可视化入口来启动/监控代理进程、对话并管理工作区文件。

## 功能
- **Chat**：向 
anobot agent 发送消息，支持 Markdown/GFM 渲染，展示调试日志（工具调用、子代理、堆栈）。
- **Monitor**：一键启动/停止 agent 与 gateway，实时查看双通道日志。
- **Cron**：读取 ~/.nanobot/cron/jobs.json，查看已配置的定时任务。
- **Sessions**：浏览 ~/.nanobot/sessions/*.jsonl 会话记录、搜索、批量删除行。
- **Skills**：列出/创建/编辑 workspace/skills/<name>/SKILL.md，可删除整项技能。
- **Memory**：编辑 workspace/memory/MEMORY.md 与每日笔记（YYYY-MM-DD.md），支持新建与删除。

## 环境要求
- Node.js ≥ 18（含 npm）
- Rust 工具链 + Cargo（Tauri 2）
- Python ≥ 3.11，uv 已安装并在 PATH 中
- Windows/macOS/Linux（默认打包目标为 Windows .msi）

## 快速开始
1) 在仓库根目录安装后端依赖：
   uv sync
2) 进入桌面端目录：
   cd nanobot-desktop
3) 安装前端依赖：
   
pm install
4) 开发运行：
   
pm run tauri dev
5) 正式打包：
   
pm run tauri build

产物位于：
anobot-desktop/src-tauri/target/。

## 数据与配置
- 默认读取 ~/.nanobot/config.json
- 工作区默认 ~/.nanobot/workspace（可在 config.json 的 agents.defaults.workspace 覆盖）
- 会话目录：~/.nanobot/sessions
- 定时任务：~/.nanobot/cron/jobs.json
- 若设置环境变量 NANOBOT_HOME，以上路径会基于该目录
- 不再读取项目根目录 .env

## 使用提示
- 关闭窗口会隐藏到托盘，彻底退出请右键托盘图标 → Quit。
- 若消息不响应，先确认只运行了一个 
anobot gateway（多进程会互抢连接）。

## 目录说明
- 
anobot-desktop/：前端 + Tauri 后端
- 
anobot/：Python 核心与 CLI（桌面端直接调用）
- ridge/：示例桥接

## License
MIT License
