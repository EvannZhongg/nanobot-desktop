#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet, VecDeque};
use std::io::{BufReader, Read};
use std::path::{Component, Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::UNIX_EPOCH;
use tauri::menu::Menu;
use tauri::{AppHandle, Emitter, Manager, State, WindowEvent};

mod oauth;
mod indexer;
mod vector;
mod tray;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;
const MAX_LOG_LINES: usize = 2000;
static PRINT_LOGS: OnceLock<bool> = OnceLock::new();
static SCAN_PROCS: OnceLock<bool> = OnceLock::new();

fn get_now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[derive(Default)]
pub struct ProcState {
    pub agent: Option<Child>,
    pub gateway: Option<Child>,
    pub active_generation: Option<u32>,
    pub logs: VecDeque<LogPayload>,
    pub emit_logs: bool,
    pub subagent_registry: HashMap<String, SubagentInfo>,
    pub status_cache: Option<(StatusPayload, std::time::Instant)>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SubagentInfo {
    pub agent_id: String,
    pub chat_id: String,
    pub status: String,
    pub message: Option<String>,
    pub tool_name: Option<String>,
    pub tool_args: Option<Value>,
    pub tool_history: Vec<ToolExecution>,
    pub start_time: u64,
    pub last_update: u64,
    pub pid: Option<u32>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ToolExecution {
    pub name: String,
    pub args: Value,
    pub timestamp: u64,
}

#[derive(Serialize, Clone)]
pub struct LogPayload {
    pub kind: String,
    pub line: String,
    pub stream: String,
}

#[derive(Serialize, Clone)]
struct ProcessExitPayload {
    kind: String,
}

#[derive(Serialize, Clone)]
pub struct StatusPayload {
    pub agent: bool,
    pub gateway: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SkillInfo {
    name: String,
    path: String,
    has_skill_md: bool,
    modified: Option<u64>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SkillFilePayload {
    name: String,
    path: String,
    content: String,
    exists: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct MemoryFileInfo {
    name: String,
    path: String,
    modified: Option<u64>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct MemoryFilePayload {
    name: String,
    path: String,
    content: String,
    exists: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ConfigFilePayload {
    path: String,
    content: String,
    exists: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SessionMessagePayload {
    id: String,
    role: String,
    content: String,
    created_at: String,
    line: usize,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SessionInfo {
    name: String,
    path: String,
    size: Option<u64>,
    modified: Option<u64>,
}

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("..")
}

fn normalize_path(path: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        let s = path.to_string_lossy();
        if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
            return PathBuf::from(format!(r"\\{}", rest));
        }
        if let Some(rest) = s.strip_prefix(r"\\?\") {
            return PathBuf::from(rest);
        }
    }
    path.to_path_buf()
}

fn home_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        if let Some(home) = std::env::var_os("USERPROFILE") {
            return Some(PathBuf::from(home));
        }
        let drive = std::env::var_os("HOMEDRIVE");
        let path = std::env::var_os("HOMEPATH");
        if let (Some(drive), Some(path)) = (drive, path) {
            return Some(PathBuf::from(drive).join(path));
        }
        None
    }
    #[cfg(not(windows))]
    {
        std::env::var_os("HOME").map(PathBuf::from)
    }
}

fn nanobot_home() -> PathBuf {
    if let Some(home) = std::env::var_os("NANOBOT_HOME") {
        let trimmed = home.to_string_lossy().trim().to_string();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }
    if let Some(home) = home_dir() {
        return home.join(".nanobot");
    }
    repo_root().join(".nanobot")
}

fn config_path() -> PathBuf {
    nanobot_home().join("config.json")
}

fn expand_tilde(path: &str) -> PathBuf {
    if let Some(home) = home_dir() {
        if path == "~" {
            return home;
        }
        if let Some(rest) = path.strip_prefix("~/").or_else(|| path.strip_prefix("~\\")) {
            return home.join(rest);
        }
    }
    PathBuf::from(path)
}

fn read_config_workspace() -> Option<PathBuf> {
    let contents = std::fs::read_to_string(config_path()).ok()?;
    let parsed: Value = serde_json::from_str(&contents).ok()?;
    let workspace = parsed
        .get("agents")?
        .get("defaults")?
        .get("workspace")?
        .as_str()?;
    Some(expand_tilde(workspace))
}

fn resource_root_candidates(app: &AppHandle) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut seen: HashSet<PathBuf> = HashSet::new();
    let mut push = |path: PathBuf| {
        let normalized = normalize_path(&path);
        if normalized.exists() && seen.insert(normalized.clone()) {
            out.push(normalized);
        }
    };

    if let Ok(path) = app.path().resource_dir() {
        push(path);
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let dir = dir.to_path_buf();
            push(dir.clone());
            push(dir.join("resources"));
            push(dir.join("resources").join("_up_"));
            push(dir.join("_up_"));
        }
    }

    let dev_resources = repo_root()
        .join("nanobot-desktop")
        .join("src-tauri")
        .join("resources");
    push(dev_resources);
    out
}

fn find_resource_subdir(app: &AppHandle, name: &str) -> Option<PathBuf> {
    for root in resource_root_candidates(app) {
        let direct = root.join(name);
        if direct.exists() {
            return Some(direct);
        }
        let nested = root.join("resources").join(name);
        if nested.exists() {
            return Some(nested);
        }
    }
    None
}

fn embedded_python_root(app: &AppHandle) -> Option<PathBuf> {
    find_resource_subdir(app, "python")
}

fn embedded_site_packages(app: &AppHandle) -> Option<PathBuf> {
    find_resource_subdir(app, "site-packages")
}

fn embedded_python_exe(app: &AppHandle) -> Option<PathBuf> {
    let root = embedded_python_root(app)?;
    #[cfg(windows)]
    {
        let exe = root.join("python.exe");
        if exe.exists() {
            return Some(exe);
        }
        let exe = root.join("Scripts").join("python.exe");
        if exe.exists() {
            return Some(exe);
        }
    }
    #[cfg(not(windows))]
    {
        let exe = root.join("bin").join("python3");
        if exe.exists() {
            return Some(exe);
        }
        let exe = root.join("bin").join("python");
        if exe.exists() {
            return Some(exe);
        }
    }
    None
}

fn local_venv_python() -> Option<PathBuf> {
    let root = repo_root().join(".venv");
    #[cfg(windows)]
    {
        let exe = root.join("Scripts").join("python.exe");
        if exe.exists() {
            return Some(exe);
        }
    }
    #[cfg(not(windows))]
    {
        let exe = root.join("bin").join("python3");
        if exe.exists() {
            return Some(exe);
        }
        let exe = root.join("bin").join("python");
        if exe.exists() {
            return Some(exe);
        }
    }
    None
}

fn build_pythonpath(app: &AppHandle, use_embedded: bool) -> Option<String> {
    let mut paths: Vec<PathBuf> = Vec::new();
    if let Some(site) = embedded_site_packages(app) {
        paths.push(normalize_path(&site));
    }
    if !use_embedded {
        let root = repo_root();
        if root.exists() {
            paths.push(normalize_path(&root));
        }
    }
    if let Some(existing) = std::env::var_os("PYTHONPATH") {
        paths.extend(std::env::split_paths(&existing));
    }
    if paths.is_empty() {
        return None;
    }
    std::env::join_paths(paths).ok().and_then(|p| p.into_string().ok())
}

fn base_command(app: &AppHandle) -> Command {
    let embedded_python = embedded_python_exe(app);
    let venv_python = local_venv_python();
    let use_embedded = embedded_python.is_some();
    let python = embedded_python
        .or(venv_python)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| "python".to_string());
    let python_path = build_pythonpath(app, use_embedded);
    if *PRINT_LOGS.get_or_init(|| std::env::var_os("NANOBOT_TAURI_LOG_STDOUT").is_some()) {
        println!("[nanobot-desktop] python={python}");
        if let Some(root) = embedded_python_root(app) {
            println!("[nanobot-desktop] embedded_python_root={}", root.display());
        }
        if let Some(site) = embedded_site_packages(app) {
            println!("[nanobot-desktop] embedded_site_packages={}", site.display());
        }
        if let Some(path) = python_path.as_ref() {
            println!("[nanobot-desktop] PYTHONPATH={path}");
        }
    }
    let mut cmd = Command::new(python);
    let root = repo_root();
    if root.exists() {
        cmd.current_dir(&root);
    } else if let Some(home) = home_dir() {
        cmd.current_dir(&home);
    }
    cmd.env("PYTHONIOENCODING", "utf-8");
    cmd.env("PYTHONUTF8", "1");
    cmd.env("PYTHONUNBUFFERED", "1");
    if std::env::var_os("LOGURU_LEVEL").is_none() {
        cmd.env("LOGURU_LEVEL", "INFO");
    }
    cmd.env("LOGURU_ENQUEUE", "True");
    cmd.env("TERM", "dumb");
    cmd.env("COLUMNS", "120");
    cmd.env("NO_COLOR", "1");
    cmd.env("RICH_DISABLE", "1");
    // Forward proxy settings from system environment if set (never hardcode)
    if let Some(proxy) = std::env::var_os("HTTP_PROXY").or_else(|| std::env::var_os("http_proxy")) {
        cmd.env("HTTP_PROXY", &proxy);
    }
    if let Some(proxy) = std::env::var_os("HTTPS_PROXY").or_else(|| std::env::var_os("https_proxy")) {
        cmd.env("HTTPS_PROXY", &proxy);
    }
    if use_embedded {
        if let Some(pyhome) = embedded_python_root(app) {
            let normalized = normalize_path(&pyhome);
            cmd.env("PYTHONHOME", normalized.to_string_lossy().to_string());
        }
        cmd.env("PYTHONNOUSERSITE", "1");
        cmd.env("PYTHONDONTWRITEBYTECODE", "1");
    }
    if let Some(python_path) = python_path {
        cmd.env("PYTHONPATH", python_path);
    }
    if std::env::var_os("NANOBOT_HOME").is_none() {
        cmd.env("NANOBOT_HOME", nanobot_home().to_string_lossy().to_string());
    }
    #[cfg(windows)]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

fn emit_config_missing(app: &AppHandle) {
    let path = config_path();
    let payload = ConfigFilePayload {
        path: path.to_string_lossy().to_string(),
        content: String::new(),
        exists: false,
    };
    let _ = app.emit("config-missing", payload);
}

fn run_onboard_inner(app: &AppHandle) -> Result<(), String> {
    let path = config_path();
    if path.exists() {
        return Ok(());
    }
    emit_log(
        app,
        "gateway",
        format!("Config not found at {}. Running onboard...", path.display()),
        "stdout",
    );
    let mut cmd = base_command(app);
    cmd.args(["-m", "nanobot", "onboard"]);
    match cmd.status() {
        Ok(status) if status.success() => {
            emit_log(app, "gateway", "Onboard completed".to_string(), "stdout");
            Ok(())
        }
        Ok(status) => {
            let msg = format!("Onboard failed (exit code {}).", status);
            emit_log(app, "gateway", msg.clone(), "stderr");
            Err(msg)
        }
        Err(err) => {
            let msg = format!("Onboard failed: {err}");
            emit_log(app, "gateway", msg.clone(), "stderr");
            Err(msg)
        }
    }
}

fn workspace_root() -> PathBuf {
    read_config_workspace().unwrap_or_else(|| nanobot_home().join("workspace"))
}

fn workspace_skills_dir() -> PathBuf {
    workspace_root().join("skills")
}

fn workspace_memory_dir() -> PathBuf {
    workspace_root().join("memory")
}

fn sessions_dir() -> PathBuf {
    nanobot_home().join("sessions")
}

fn validate_skill_name(name: &str) -> Result<(), String> {
    let mut comps = Path::new(name).components();
    match (comps.next(), comps.next()) {
        (Some(Component::Normal(_)), None) => Ok(()),
        _ => Err("invalid skill name".to_string()),
    }
}

fn is_date_memory_name(name: &str) -> bool {
    if name.len() != 13 {
        return false;
    }
    let bytes = name.as_bytes();
    for &idx in &[0usize, 1, 2, 3, 5, 6, 8, 9] {
        if !bytes[idx].is_ascii_digit() {
            return false;
        }
    }
    bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes[10] == b'.'
        && bytes[11] == b'm'
        && bytes[12] == b'd'
}

fn validate_memory_name(name: &str) -> Result<(), String> {
    if name == "MEMORY.md" {
        return Ok(());
    }
    if is_date_memory_name(name) {
        return Ok(());
    }
    Err("invalid memory name".to_string())
}

pub(crate) fn emit_log(app: &AppHandle, kind: &str, line: String, stream: &str) {
    let payload = LogPayload {
        kind: kind.to_string(),
        line,
        stream: stream.to_string(),
    };
    if *PRINT_LOGS.get_or_init(|| std::env::var_os("NANOBOT_TAURI_LOG_STDOUT").is_some()) {
        println!("[{kind}][{stream}] {}", payload.line);
    }
    let mut should_emit = false;
    if let Ok(mut guard) = app.state::<Arc<Mutex<ProcState>>>().lock() {
        guard.logs.push_back(payload.clone());
        if guard.logs.len() > MAX_LOG_LINES {
            guard.logs.pop_front();
        }
        should_emit = guard.emit_logs;
    }
    if should_emit {
        let _ = app.emit("process-log", payload);
    }
}

fn spawn_reader(
    app: AppHandle,
    kind: String,
    stream: String,
    mut reader: impl Read + Send + 'static,
) {
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        let mut pending = String::new();
        loop {
            let read = match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => n,
                Err(_) => break,
            };
            let chunk = String::from_utf8_lossy(&buf[..read]);
            pending.push_str(&chunk);

            loop {
                let split_at = pending
                    .find(['\n', '\r'])
                    .unwrap_or(usize::MAX);
                if split_at == usize::MAX {
                    break;
                }
                let line = pending[..split_at].trim_end().to_string();
                pending = pending[split_at + 1..].to_string();
                if !line.trim().is_empty() {
                    if line.contains("__STATUS__") {
                        if let Some(pos) = line.find("__STATUS__") {
                            let json_part = &line[pos + 10..];
                            if let Ok(payload) = serde_json::from_str::<Value>(json_part) {
                                // Update registry
                                if let Some(state_handle) = app.try_state::<Arc<Mutex<ProcState>>>() {
                                    let state = state_handle.inner().clone();
                                    let mut s = state.lock().unwrap();
                                    
                                    if let (Some(agent_id), Some(status)) = (
                                        payload.get("agent_id").and_then(|v| v.as_str()),
                                        payload.get("status").and_then(|v| v.as_str())
                                    ) {
                                        let entry = s.subagent_registry.entry(agent_id.to_string()).or_insert_with(|| SubagentInfo {
                                            agent_id: agent_id.to_string(),
                                            chat_id: payload.get("chat_id").and_then(|v| v.as_str()).unwrap_or_default().to_string(),
                                            status: status.to_string(),
                                            message: payload.get("message").and_then(|v| v.as_str()).map(|s| s.to_string()),
                                            tool_name: payload.get("tool_name").and_then(|v| v.as_str()).map(|s| s.to_string()),
                                            tool_args: payload.get("tool_args").cloned(),
                                            tool_history: Vec::new(),
                                            start_time: get_now_ms(),
                                            last_update: get_now_ms(),
                                            pid: payload.get("pid").and_then(|v| v.as_u64()).map(|p| p as u32),
                                        });
                                        
                                        entry.status = status.to_string();
                                        entry.message = payload.get("message").and_then(|v| v.as_str()).map(|s| s.to_string());
                                        entry.last_update = get_now_ms();
                                        if let Some(pid) = payload.get("pid").and_then(|v| v.as_u64()) {
                                            entry.pid = Some(pid as u32);
                                        }
                                        
                                        if status == "tool_call" {
                                            if let (Some(name), Some(args)) = (
                                                payload.get("tool_name").and_then(|v| v.as_str()),
                                                payload.get("tool_args")
                                            ) {
                                                entry.tool_name = Some(name.to_string());
                                                entry.tool_args = Some(args.clone());
                                                entry.tool_history.push(ToolExecution {
                                                    name: name.to_string(),
                                                    args: args.clone(),
                                                    timestamp: get_now_ms(),
                                                });
                                            }
                                        }
                                    }
                                    let _ = app.emit("agent-status", payload.clone());
                                    continue;
                                }
                            }
                        }
                    }
                    
                    if line.contains("Spawned subagent") && line.contains("PID:") {
                        static RE: OnceLock<regex::Regex> = OnceLock::new();
                        let re = RE.get_or_init(|| regex::Regex::new(r"Spawned subagent ([a-f0-9-]+).*PID: (\d+)").unwrap());
                        if let Some(caps) = re.captures(&line) {
                            let agent_id = caps.get(1).map(|m| m.as_str().to_string());
                            let pid = caps.get(2).and_then(|m| m.as_str().parse::<u32>().ok());
                            
                            if let (Some(id), Some(p)) = (agent_id, pid) {
                                let id_str: String = id;
                                if let Some(state_handle) = app.try_state::<Arc<Mutex<ProcState>>>() {
                                    let mut s = state_handle.lock().unwrap();
                                    let entry = s.subagent_registry.entry(id_str.clone()).or_insert_with(|| SubagentInfo {
                                        agent_id: id_str.clone(),
                                        chat_id: "".to_string(),
                                        status: "thinking".to_string(),
                                        message: None,
                                        tool_name: None,
                                        tool_args: None,
                                        tool_history: Vec::new(),
                                        start_time: get_now_ms(),
                                        last_update: get_now_ms(),
                                        pid: Some(p),
                                    });
                                    entry.pid = Some(p);
                                }
                            }
                        }
                    }
                    emit_log(&app, &kind, line, &stream);
                }
            }

            if pending.len() > 2048 {
                let line = pending.trim_end().to_string();
                if !line.trim().is_empty() {
                    emit_log(&app, &kind, line, &stream);
                }
                pending.clear();
            }
        }

        if !pending.trim().is_empty() {
            emit_log(&app, &kind, pending.trim_end().to_string(), &stream);
        }
        emit_log(
            &app,
            &kind,
            "Process exited or stream closed".to_string(),
            "stderr",
        );
        let _ = app.emit("process-exit", ProcessExitPayload { kind: kind.clone() });
    });
}

pub fn refresh_child(child: &mut Option<Child>) -> bool {
    if let Some(proc) = child.as_mut() {
        if let Ok(Some(_)) = proc.try_wait() {
            *child = None;
            return false;
        }
        return true;
    }
    false
}

fn kill_process_tree(pid: u32) {
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .status();
    }
    #[cfg(not(windows))]
    {
        // Best-effort cross-platform cleanup
        let _ = Command::new("pkill")
            .args(["-9", "-P", &pid.to_string()])
            .status();
        let _ = Command::new("kill")
            .args(["-9", &pid.to_string()])
            .status();
    }
}

pub fn kill_matching_processes(kind: &str) {
    #[cfg(windows)]
    {
        let pattern = match kind {
            "agent" => "nanobot agent",
            "gateway" => "nanobot gateway",
            _ => return,
        };
        let cmd = format!(
            r#"Get-CimInstance Win32_Process | Where-Object {{ $_.CommandLine -match '{}' }} | Stop-Process -Id {{$_.ProcessId}} -Force"#,
            pattern
        );
        let mut ps = Command::new("powershell");
        ps.args(["-NoProfile", "-WindowStyle", "Hidden", "-Command", &cmd]);
        ps.creation_flags(CREATE_NO_WINDOW);
        let _ = ps.status();
    }
    #[cfg(not(windows))]
    {
        let pattern = match kind {
            "agent" => "nanobot agent",
            "gateway" => "nanobot gateway",
            _ => return,
        };
        // pkill -f matches full command line; best-effort cleanup.
        let _ = Command::new("pkill").args(["-f", pattern]).status();
    }
}

fn is_matching_process_running(kind: &str) -> bool {
    let pattern = match kind {
        "agent" => "nanobot agent",
        "gateway" => "nanobot gateway",
        _ => return false,
    };
    #[cfg(windows)]
    {
        let cmd = format!(
            "if (Get-CimInstance Win32_Process | Where-Object {{ $_.CommandLine -match '{}' }} | Select-Object -First 1) {{ exit 0 }} else {{ exit 1 }}",
            pattern
        );
        let mut ps = Command::new("powershell");
        ps.args(["-NoProfile", "-WindowStyle", "Hidden", "-Command", &cmd]);
        ps.creation_flags(CREATE_NO_WINDOW);
        return ps
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
    }
    #[cfg(not(windows))]
    {
        Command::new("pgrep")
            .args(["-f", pattern])
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }
}

pub fn stop_all_processes(state: &Arc<Mutex<ProcState>>) {
    if let Ok(mut guard) = state.lock() {
        if let Some(mut child) = guard.agent.take() {
            let pid = child.id();
            let _ = child.kill();
            kill_process_tree(pid);
        }
        if let Some(mut child) = guard.gateway.take() {
            let pid = child.id();
            let _ = child.kill();
            kill_process_tree(pid);
        }
    }
}

fn start_process_inner(
    kind: &str,
    state: &Arc<Mutex<ProcState>>,
    app: &AppHandle,
) -> Result<(), String> {
    {
        let mut guard = state.lock().map_err(|_| "state lock".to_string())?;
        match kind {
            "agent" => {
                if refresh_child(&mut guard.agent) {
                    return Ok(());
                }
            }
            "gateway" => {
                if refresh_child(&mut guard.gateway) {
                    return Ok(());
                }
            }
            _ => return Err("unknown process".to_string()),
        }
    }

    match kind {
        "agent" => {
            let mut cmd = base_command(app);
            cmd.args(["-u", "-m", "nanobot", "agent", "--daemon"])
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .stdin(Stdio::piped());
            let mut child = cmd.spawn().map_err(|e| {
                emit_log(
                    app,
                    "agent",
                    format!("Failed to start agent: {e}"),
                    "stderr",
                );
                e.to_string()
            })?;

            if let Some(stdout) = child.stdout.take() {
                spawn_reader(
                    app.clone(),
                    "agent".to_string(),
                    "stdout".to_string(),
                    BufReader::new(stdout),
                );
            }
            if let Some(stderr) = child.stderr.take() {
                spawn_reader(
                    app.clone(),
                    "agent".to_string(),
                    "stderr".to_string(),
                    BufReader::new(stderr),
                );
            }

            {
                let mut guard = state.lock().map_err(|_| "state lock".to_string())?;
                guard.agent = Some(child);
            }
            emit_log(app, "agent", "Agent started".to_string(), "stdout");
        }
        "gateway" => {
            let mut cmd = base_command(app);
            cmd.args(["-u", "-m", "nanobot", "gateway"])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .stdin(Stdio::null());
            if std::env::var_os("NANOBOT_GATEWAY_VERBOSE").is_some() {
                cmd.arg("--verbose");
            }
            let mut child = cmd.spawn().map_err(|e| {
                emit_log(
                    app,
                    "gateway",
                    format!("Failed to start gateway: {e}"),
                    "stderr",
                );
                e.to_string()
            })?;

            if let Some(stdout) = child.stdout.take() {
                spawn_reader(
                    app.clone(),
                    "gateway".to_string(),
                    "stdout".to_string(),
                    BufReader::new(stdout),
                );
            }
            if let Some(stderr) = child.stderr.take() {
                spawn_reader(
                    app.clone(),
                    "gateway".to_string(),
                    "stderr".to_string(),
                    BufReader::new(stderr),
                );
            }

            {
                let mut guard = state.lock().map_err(|_| "state lock".to_string())?;
                guard.gateway = Some(child);
            }
            emit_log(app, "gateway", "Gateway started".to_string(), "stdout");
        }
        _ => return Err("unknown process".to_string()),
    }
    Ok(())
}

#[tauri::command]
fn get_status(state: State<Arc<Mutex<ProcState>>>) -> StatusPayload {
    let mut guard = state.lock().expect("state");
    
    // Check cache (2 second ttl)
    if let Some((cached, instant)) = &guard.status_cache {
        if instant.elapsed() < std::time::Duration::from_secs(2) {
            return cached.clone();
        }
    }

    let agent_managed = refresh_child(&mut guard.agent);
    let gateway_managed = refresh_child(&mut guard.gateway);
    let scan = *SCAN_PROCS
        .get_or_init(|| std::env::var_os("NANOBOT_SCAN_PROCS").is_some());
    
    let agent = if agent_managed { true } 
               else if scan { is_matching_process_running("agent") } 
               else { false };
               
    let gateway = if gateway_managed { true } 
                 else if scan { is_matching_process_running("gateway") } 
                 else { false };
                 
    let payload = StatusPayload { agent, gateway };
    guard.status_cache = Some((payload.clone(), std::time::Instant::now()));
    payload
}

#[tauri::command]
fn get_logs(state: State<Arc<Mutex<ProcState>>>) -> Vec<LogPayload> {
    let guard = state.lock().expect("state");
    guard.logs.iter().cloned().collect()
}

#[tauri::command]
fn set_log_streaming(enabled: bool, state: State<Arc<Mutex<ProcState>>>) {
    if let Ok(mut guard) = state.lock() {
        guard.emit_logs = enabled;
    }
}

#[tauri::command]
fn list_workspace_skills(path: Option<String>) -> Result<Vec<SkillInfo>, String> {
    let dir = if let Some(p) = path {
        PathBuf::from(p)
    } else {
        workspace_skills_dir()
    };
    if !dir.exists() {
        return Ok(Vec::new());
    }

    let mut skills = Vec::new();
    for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let name = path
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "unknown".to_string());
        let skill_md = path.join("SKILL.md");
        let has_skill_md = skill_md.exists();
        let modified = if has_skill_md {
            std::fs::metadata(&skill_md)
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
        } else {
            None
        };
        skills.push(SkillInfo {
            name,
            path: skill_md.to_string_lossy().to_string(),
            has_skill_md,
            modified,
        });
    }

    skills.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(skills)
}

#[tauri::command]
fn read_skill_file(name: String) -> Result<SkillFilePayload, String> {
    validate_skill_name(&name)?;
    let dir = workspace_skills_dir().join(&name);
    let skill_md = dir.join("SKILL.md");
    let exists = skill_md.exists();
    let content = if exists {
        std::fs::read_to_string(&skill_md).map_err(|e| e.to_string())?
    } else {
        String::new()
    };
    Ok(SkillFilePayload {
        name,
        path: skill_md.to_string_lossy().to_string(),
        content,
        exists,
    })
}

#[tauri::command]
fn save_skill_file(name: String, content: String) -> Result<(), String> {
    validate_skill_name(&name)?;
    let dir = workspace_skills_dir().join(&name);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let skill_md = dir.join("SKILL.md");
    std::fs::write(&skill_md, content).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn delete_skill(name: String) -> Result<(), String> {
    validate_skill_name(&name)?;
    let dir = workspace_skills_dir().join(&name);
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn list_memory_files() -> Result<Vec<MemoryFileInfo>, String> {
    let dir = workspace_memory_dir();
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut items = Vec::new();
    for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let name = match path.file_name() {
            Some(n) => n.to_string_lossy().to_string(),
            None => continue,
        };
        if !is_date_memory_name(&name) {
            continue;
        }
        let modified = std::fs::metadata(&path)
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs());
        items.push(MemoryFileInfo {
            name: name.clone(),
            path: path.to_string_lossy().to_string(),
            modified,
        });
    }
    items.sort_by(|a, b| b.name.cmp(&a.name));
    Ok(items)
}

#[tauri::command]
fn read_memory_file(name: String) -> Result<MemoryFilePayload, String> {
    validate_memory_name(&name)?;
    let dir = workspace_memory_dir();
    let path = dir.join(&name);
    let exists = path.exists();
    let content = if exists {
        std::fs::read_to_string(&path).map_err(|e| e.to_string())?
    } else {
        String::new()
    };
    Ok(MemoryFilePayload {
        name,
        path: path.to_string_lossy().to_string(),
        content,
        exists,
    })
}

#[tauri::command]
fn read_config_file() -> Result<ConfigFilePayload, String> {
    let path = config_path();
    let exists = path.exists();
    let content = if exists {
        std::fs::read_to_string(&path).map_err(|e| e.to_string())?
    } else {
        String::new()
    };
    Ok(ConfigFilePayload {
        path: path.to_string_lossy().to_string(),
        content,
        exists,
    })
}

#[tauri::command]
fn read_cron_jobs() -> Result<Value, String> {
    let path = nanobot_home().join("cron").join("jobs.json");
    let contents = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(_) => return Ok(json!({"version": null, "jobs": []})),
    };
    let parsed: Value = serde_json::from_str(&contents).unwrap_or_else(|_| json!({}));
    let version = parsed.get("version").cloned().unwrap_or(json!(null));
    let jobs = parsed.get("jobs").cloned().unwrap_or_else(|| json!([]));
    Ok(json!({
        "version": version,
        "jobs": jobs
    }))
}

#[tauri::command]
fn delete_cron_job(job_id: String) -> Result<bool, String> {
    let path = nanobot_home().join("cron").join("jobs.json");
    let contents = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(_) => return Ok(false),
    };
    let mut data: Value = serde_json::from_str(&contents)
        .unwrap_or_else(|_| json!({"version": 1, "jobs": []}));
    let jobs = data
        .get_mut("jobs")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| "invalid cron store".to_string())?;
    let before = jobs.len();
    jobs.retain(|job| job.get("id").and_then(Value::as_str) != Some(job_id.as_str()));
    let removed = jobs.len() < before;
    if removed {
        if data.get("version").is_none() {
            data["version"] = json!(1);
        }
        std::fs::write(&path, serde_json::to_string_pretty(&data).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    }
    Ok(removed)
}

#[tauri::command]
fn read_session_history(limit: usize, offset: usize) -> Result<Vec<SessionMessagePayload>, String> {
    let lim = limit.max(1);
    read_session_file("cli_direct.jsonl", lim, offset, None)
}

fn read_session_file(
    name: &str,
    limit: usize,
    offset: usize,
    query: Option<&str>,
) -> Result<Vec<SessionMessagePayload>, String> {
    let path = sessions_dir().join(name);
    if !path.exists() {
        return Ok(Vec::new());
    }

    use std::io::{Seek, SeekFrom, Read};
    let mut file = std::fs::File::open(&path).map_err(|e| e.to_string())?;
    let file_len = file.metadata().map_err(|e| e.to_string())?.len();
    
    let mut rows: Vec<SessionMessagePayload> = Vec::new();
    let lower_query = query.as_ref().map(|q| q.to_lowercase());

    // If there is a query, we MUST read the whole file currently because index-less search is global.
    // However, if no query, we can seek from the end.
    if lower_query.is_some() {
        let reader = std::io::BufReader::new(file);
        use std::io::BufRead;
        for (idx, line_res) in reader.lines().enumerate() {
            let line = line_res.map_err(|e| e.to_string())?;
            let trimmed = line.trim();
            if trimmed.is_empty() || trimmed.contains("\"_type\":") { continue; }
            if let Some(q) = lower_query.as_ref() {
                if !trimmed.to_lowercase().contains(q) { continue; }
            }
            if let Ok(val) = serde_json::from_str::<Value>(trimmed) {
                rows.push(parse_session_row(val, idx));
            }
        }
        let total = rows.len();
        if offset >= total { return Ok(Vec::new()); }
        let end = total.saturating_sub(offset);
        let start = end.saturating_sub(limit);
        return Ok(rows[start..end].to_vec());
    }

    // High performance SEEK-FROM-END logic for pagination (No Query)
    let mut cursor = file_len;
    let mut buffer = vec![0u8; 8192];
    let mut leftovers = Vec::new();
    let mut lines_collected = Vec::new();
    let target_count = limit + offset;

    while cursor > 0 && lines_collected.len() < target_count {
        let read_size = std::cmp::min(cursor, buffer.len() as u64);
        cursor -= read_size;
        file.seek(SeekFrom::Start(cursor)).map_err(|e| e.to_string())?;
        file.read_exact(&mut buffer[..read_size as usize]).map_err(|e| e.to_string())?;

        let mut pos = read_size as usize;
        while pos > 0 {
            pos -= 1;
            if buffer[pos] == b'\n' {
                let mut line_bytes = buffer[pos + 1..read_size as usize].to_vec();
                line_bytes.extend_from_slice(&leftovers);
                if !line_bytes.is_empty() {
                    lines_collected.push(line_bytes);
                }
                leftovers.clear();
                // If we have enough lines, we can stop
                if lines_collected.len() >= target_count { break; }
            }
        }
        if lines_collected.len() < target_count {
            let mut new_leftovers = buffer[0..pos + (if pos == 0 && buffer[0] != b'\n' {1} else {0})].to_vec();
            new_leftovers.extend_from_slice(&leftovers);
            leftovers = new_leftovers;
        }
    }
    // Handle very first line
    if !leftovers.is_empty() && lines_collected.len() < target_count {
        lines_collected.push(leftovers);
    }

    // Now lines_collected has messages in REVERSE order from the end of the file.
    // Skip 'offset' and take 'limit'
    let subset = lines_collected.iter()
        .skip(offset)
        .take(limit)
        .filter_map(|bytes| {
            let line = String::from_utf8_lossy(bytes);
            let trimmed = line.trim();
            if trimmed.is_empty() || trimmed.contains("\"_type\":") { return None; }
            serde_json::from_str::<Value>(trimmed).ok()
        })
        .enumerate()
        .map(|(i, val)| parse_session_row(val, offset + i))
        .collect::<Vec<_>>();

    // We want to return them in chronological order for the frontend
    let mut result = subset;
    result.reverse();
    Ok(result)
}

fn parse_session_row(val: Value, idx: usize) -> SessionMessagePayload {
    let content = val.get("content").and_then(Value::as_str).unwrap_or("").to_string();
    let role = val.get("role").and_then(Value::as_str).unwrap_or("system").to_string();
    let created_at = val.get("timestamp")
        .or_else(|| val.get("created_at"))
        .or_else(|| val.get("updated_at"))
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_string();

    SessionMessagePayload {
        id: format!("{}-{}", created_at, idx),
        role,
        content,
        created_at,
        line: idx,
    }
}

#[tauri::command]
fn list_sessions() -> Result<Vec<SessionInfo>, String> {
    let dir = sessions_dir();
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut items = Vec::new();
    for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        if path.file_name().and_then(|s| s.to_str()) == Some("cli_direct.jsonl") {
            // Skip the live chat session history to avoid leaking it into the Sessions tab
            continue;
        }
        if path.extension().and_then(|s| s.to_str()) != Some("jsonl") {
            continue;
        }
        let metadata = entry.metadata().ok();
        let size = metadata.as_ref().map(|m| m.len());
        let modified = metadata
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs());
        let name = path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        items.push(SessionInfo {
            name: name.clone(),
            path: path.to_string_lossy().to_string(),
            size,
            modified,
        });
    }
    items.sort_by(|a, b| b.modified.cmp(&a.modified));
    Ok(items)
}

#[tauri::command]
fn read_session_messages(
    name: String,
    limit: usize,
    offset: usize,
    query: Option<String>,
) -> Result<Vec<SessionMessagePayload>, String> {
    if name.contains(std::path::MAIN_SEPARATOR) {
        return Err("invalid session name".to_string());
    }
    read_session_file(&name, limit.max(1), offset, query.as_deref())
}

#[tauri::command]
fn delete_session_line(name: String, line: usize) -> Result<(), String> {
    if name.contains(std::path::MAIN_SEPARATOR) {
        return Err("invalid session name".to_string());
    }
    let path = sessions_dir().join(&name);
    let data = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let mut lines: Vec<&str> = data.lines().collect();
    if line >= lines.len() {
        return Err("line out of range".to_string());
    }
    lines.remove(line);
    std::fs::write(&path, lines.join("\n")).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn delete_session_lines(name: String, mut lines: Vec<usize>) -> Result<(), String> {
    if name.contains(std::path::MAIN_SEPARATOR) {
        return Err("invalid session name".to_string());
    }
    let path = sessions_dir().join(&name);
    let data = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let mut entries: Vec<&str> = data.lines().collect();
    lines.sort_unstable();
    lines.dedup();
    for idx in lines.into_iter().rev() {
        if idx < entries.len() {
            entries.remove(idx);
        }
    }
    std::fs::write(&path, entries.join("\n")).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn save_memory_file(name: String, content: String) -> Result<(), String> {
    validate_memory_name(&name)?;
    let dir = workspace_memory_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(&name);
    std::fs::write(&path, content).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn save_config_file(content: String) -> Result<(), String> {
    let parsed: Value = serde_json::from_str(&content)
        .map_err(|e| format!("Invalid JSON: {e}"))?;
    if !parsed.is_object() {
        return Err("Config must be a JSON object.".to_string());
    }
    let path = config_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, content).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn run_onboard(app: AppHandle) -> Result<(), String> {
    run_onboard_inner(&app)
}

#[tauri::command]
fn delete_memory_file(name: String) -> Result<(), String> {
    validate_memory_name(&name)?;
    if name == "MEMORY.md" {
        return Err("cannot delete MEMORY.md".to_string());
    }
    let dir = workspace_memory_dir();
    let path = dir.join(&name);
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn start_process(
    kind: String,
    state: State<Arc<Mutex<ProcState>>>,
    app: AppHandle,
) -> Result<(), String> {
    start_process_inner(kind.as_str(), state.inner(), &app)
}

#[tauri::command]
fn stop_process(kind: String, state: State<Arc<Mutex<ProcState>>>) -> Result<(), String> {
    let mut guard = state.lock().map_err(|_| "state lock".to_string())?;
    match kind.as_str() {
        "agent" => {
            if let Some(mut child) = guard.agent.take() {
                let pid = child.id();
                let _ = child.kill();
                kill_process_tree(pid);
            }
            kill_matching_processes("agent");
        }
        "gateway" => {
            if let Some(mut child) = guard.gateway.take() {
                let pid = child.id();
                let _ = child.kill();
                kill_process_tree(pid);
            }
            kill_matching_processes("gateway");
        }
        _ => return Err("unknown process".to_string()),
    }
    Ok(())
}

#[tauri::command]
async fn send_agent_message(
    app: AppHandle,
    message: String,
    session_id: String,
    model: Option<String>,
    media: Option<Vec<String>>,
) -> Result<String, String> {
    emit_log(
        &app,
        "agent",
        format!("User: {}", truncate_line(&message, 200)),
        "stdout",
    );
    
    let (tx, rx) = std::sync::mpsc::channel();
    let app_inner = app.clone();
    
    tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = base_command(&app_inner);
        let mut cli_args = vec![
            "-m".to_string(),
            "nanobot".to_string(),
            "agent".to_string(),
            "chat".to_string(),
            "--message".to_string(),
            message,
            "--session-id".to_string(),
            session_id,
        ];
        if let Some(m) = model {
            cli_args.push("--model".to_string());
            cli_args.push(m);
        }
        if let Some(md) = media {
            for m in md {
                cli_args.push("--attachment".to_string());
                cli_args.push(m);
            }
        }
        
        cmd.args(cli_args)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .stdin(Stdio::null());

        match cmd.spawn() {
            Ok(child) => {
                let pid = child.id();
                if let Ok(mut guard) = app_inner.state::<Arc<Mutex<ProcState>>>().lock() {
                    guard.active_generation = Some(pid);
                }

                let output = child.wait_with_output();
                
                if let Ok(mut guard) = app_inner.state::<Arc<Mutex<ProcState>>>().lock() {
                    if guard.active_generation == Some(pid) {
                        guard.active_generation = None;
                    }
                }

                let _ = app_inner.emit("process-exit", ProcessExitPayload { kind: "agent-task".to_string() });

                match output {
                    Ok(out) => {
                        let mut combined = String::new();
                        combined.push_str(&String::from_utf8_lossy(&out.stdout));
                        combined.push_str(&String::from_utf8_lossy(&out.stderr));
                        let _ = tx.send(Ok(combined));
                    }
                    Err(e) => {
                        let _ = tx.send(Err(e.to_string()));
                    }
                }
            }
            Err(e) => {
                let _ = tx.send(Err(e.to_string()));
            }
        }
    });

    let combined = rx.recv().map_err(|e| e.to_string())??;

    let cleaned = strip_ansi(combined.as_str());
    for line in cleaned.lines() {
        if !line.trim().is_empty() {
            emit_log(&app, "agent", line.to_string(), "stdout");
        }
    }
    Ok(cleaned.trim().to_string())
}

#[tauri::command]
async fn cancel_all_subagents(state: tauri::State<'_, Arc<Mutex<ProcState>>>) -> Result<(), String> {
    let mut guard = state.lock().map_err(|_| "poisoned")?;
    let pids: Vec<u32> = guard.subagent_registry.values().filter_map(|s| s.pid).collect();
    
    for pid in pids {
        let _ = Command::new("kill").arg("-9").arg(pid.to_string()).status();
    }
    
    // Update all active ones to error
    for info in guard.subagent_registry.values_mut() {
        if info.status != "completed" && info.status != "error" {
            info.status = "error".to_string();
            info.message = Some("All tasks stopped".to_string());
        }
    }
    
    Ok(())
}

#[tauri::command]
async fn cancel_subagent(app: AppHandle, agent_id: String) -> Result<(), String> {
    emit_log(&app, "agent", format!("Cancelling subagent {}", agent_id), "stdout");
    
    // 1. Try stored PID first (force kill)
    if let Ok(guard) = app.state::<Arc<Mutex<ProcState>>>().lock() {
        if let Some(info) = guard.subagent_registry.get(&agent_id) {
            if let Some(pid) = info.pid {
                let _ = Command::new("kill").arg("-9").arg(pid.to_string()).status();
            }
        }
    }

    // 2. Also try the normal CLI cancel way in background
    let app_for_bg = app.clone();
    let agent_id_for_bg = agent_id.clone();
    let _ = tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let mut cmd = base_command(&app_for_bg);
        cmd.args([
            "-m", "nanobot", "agent", 
            "--cancel-subagent", &agent_id_for_bg
        ])
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .stdin(Stdio::null());

        let output = cmd.output().map_err(|e| e.to_string())?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).to_string());
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?;

    // 3. Update registry status
    if let Ok(mut guard) = app.state::<Arc<Mutex<ProcState>>>().lock() {
        if let Some(info) = guard.subagent_registry.get_mut(&agent_id) {
            info.status = "error".to_string();
            info.message = Some("Cancelled by user".to_string());
        }
    }
    
    Ok(())
}

fn truncate_line(s: &str, max_len: usize) -> String {
    if s.chars().count() <= max_len {
        return s.to_string();
    }
    s.chars().take(max_len).collect::<String>() + "..."
}

fn strip_ansi(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\u{1b}' {
            // Potential ANSI escape sequence ESC [ ... <char>
            if let Some('[') = chars.peek() {
                let _ = chars.next(); // consume '['
                while let Some(c) = chars.next() {
                    if (0x40..=0x7E).contains(&(c as u8)) {
                        break;
                    }
                }
            } else {
                // Just ESC followed by something else, skip the ESC
            }
        } else {
            out.push(ch);
        }
    }
    out
}

#[tauri::command]
fn stop_generation(state: State<Arc<Mutex<ProcState>>>) -> Result<(), String> {
    let mut guard = state.lock().map_err(|_| "state lock".to_string())?;
    if let Some(pid) = guard.active_generation.take() {
        kill_process_tree(pid);
        Ok(())
    } else {
        Err("no active generation".to_string())
    }
}

#[tauri::command]
fn get_subagent_registry(state: State<'_, Arc<Mutex<ProcState>>>) -> HashMap<String, SubagentInfo> {
    let s = state.lock().unwrap();
    s.subagent_registry.clone()
}

#[tauri::command]
fn clear_subagent_registry(state: State<'_, Arc<Mutex<ProcState>>>) {
    let mut s = state.lock().unwrap();
    s.subagent_registry.clear();
}

fn main() {
    let state = Arc::new(Mutex::new(ProcState::default()));
    let db_path = nanobot_home().join("vector.db");
    let db_conn = vector::init_db(db_path.to_str().unwrap()).expect("Failed to init SQLite db");
    let db_state = vector::DbState(Mutex::new(db_conn));

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(state)
        .manage(db_state)
        .setup(|app| {
            #[cfg(target_os = "macos")]
            if let Ok(app_menu) = Menu::default(app.handle()) {
                let _ = app.set_menu(app_menu);
            }

            if let Some(window) = app.get_webview_window("main") {
                let icon_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("icons")
                    .join("icon.png");
                if let Ok(icon) = tauri::image::Image::from_path(icon_path) {
                    let _ = window.set_icon(icon);
                }
            }

            tray::init(app.handle())?;

            let handle = app.handle();
            let state = app.state::<Arc<Mutex<ProcState>>>().inner().clone();

            if config_path().exists() {
                let _ = start_process_inner("agent", &state, &handle);
                let _ = start_process_inner("gateway", &state, &handle);
            } else {
                emit_log(
                    &handle,
                    "gateway",
                    format!(
                        "Config not found at {}. Waiting for setup...",
                        config_path().display()
                    ),
                    "stderr",
                );
                emit_config_missing(&handle);
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                window.hide().ok();
                api.prevent_close();
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_status,
            get_logs,
            set_log_streaming,
            list_workspace_skills,
            read_skill_file,
            save_skill_file,
            delete_skill,
            list_memory_files,
            read_memory_file,
            save_memory_file,
            delete_memory_file,
            read_config_file,
            save_config_file,
            run_onboard,
            read_session_history,
            list_sessions,
            read_session_messages,
            delete_session_line,
            delete_session_lines,
            read_cron_jobs,
            delete_cron_job,
            start_process,
            stop_process,
            send_agent_message,
            cancel_subagent,
            cancel_all_subagents,
            stop_generation,
            get_subagent_registry,
            clear_subagent_registry,
            oauth::start_browser_oauth,
            oauth::start_device_oauth,
            oauth::poll_device_oauth,
            indexer::search_workspace,
            vector::chunk_and_store,
            vector::search_chunks
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
