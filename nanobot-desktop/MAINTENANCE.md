# 维护与更新流程规范 (Maintenance & Update Workflow)

本文档规定了 Nanobot Desktop 后续的日常拉取、本地调试与正式发布打包的规范流程，确保您可以随时通过 Git 找回最新的工作态。

## 一、 获取最新版代码 (Sync & Pull)
当需要从远端获取最新的更新（例如跨平台工作、获取其它 Agent 的修改）时，请执行以下命令：

```bash
# 1. 获取并合并远端 main 分支的最新内容
git pull origin main

# 2. 补全前端依赖 (如果有新增功能，如 @tauri-apps/plugin-dialog 等)
npm install

# 3. 补全后端/Rust 依赖
cd src-tauri && cargo fetch
cd ..
```

## 二、 本地开发调试 (Development)
开发阶段或验收新功能时，可以启动 Vite 的热更新环境：

```bash
# 执行完毕后桌面会自动弹起开发版的客户端窗口
npm run dev
```

## 三、 打包正式版 (Release)
一旦确认代码功能无误，即可生成跨平台的独立运行程序包供分发使用：

```bash
# 启动 Tauri 项目正式构建
npm run tauri build
```
执行成功后：
- 最新的 `dmg` / `app` 产物会在 `src-tauri/target/release/bundle/dmg/` （macOS）或相应平台文件夹中生成。

### 自动化一键拉取并安装到桌面 (macOS 专属)
为了避免每次都要手动下载并把 `.app` 移动到「应用程序」中，现在**我们提供了自动化的本地一键脚本**：

```bash
# 这个脚本会自动拉取 Git 最新代码，下载前后端依赖，然后构建 Release 并移动到 /Applications 目录！
npm run install:mac
```
安装结束后，您可随时通过 `Cmd + 空格` 并输入 `Nanobot Desktop` 从系统启动或者从 `Launchpad` 里找到它。

### 🤖 给 AI 助手 (Agent) 的自动化执行指令
**🔴 核心规则：**
当用户在对话中提到**“更新释放版本”**、**“获取最新版”**或**“重新编译安装”**时，AI 应当**默认自动走终端执行**拉取和构建，而**不需要**再让用户自己手动安装！
请 AI 识别意图后，直接在终端执行：
1. 切换目录：`cd /Users/joe/nanobot-desktop/nanobot-desktop`
2. 自动构建与安装：`npm run install:mac` 
（该脚本已内置 git pull、依赖安装、构建及一键复制到 `/Applications` 的流程）

**前置授权要求**：
- 请为该终端命令设置 `SafeToAutoRun=true` 自主执行，因为用户已做全局授权。
- 如果构建产物发生位置变动，只能放置在 `/Applications/` 或者源代码母目录中，**绝禁止**放置或转移到无关文件夹（如“辩论社文件”等错误路径）。

## 四、 提交流程规范 (Commit Convention)
如需手动提交更改，建议使用语义化标签规范 (Conventional Commits)：
- `feat:` 新增功能组件 (如新增某个面板、API 对接)
- `fix:` 修复各类漏洞、报错或 Bug
- `perf:` 专门改善性能的操作 (如 10 轮渲染级别的防懒惰优化)
- `chore:` 零散调整、依赖更新、打包文件变动等
