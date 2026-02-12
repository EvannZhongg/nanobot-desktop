#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{HashSet, VecDeque};
use std::io::{BufReader, Read};
use std::path::{Component, Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::UNIX_EPOCH;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, State, WindowEvent};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;
const MAX_LOG_LINES: usize = 2000;
static PRINT_LOGS: OnceLock<bool> = OnceLock::new();
static SCAN_PROCS: OnceLock<bool> = OnceLock::new();

#[derive(Default)]
struct ProcState {
    agent: Option<Child>,
    gateway: Option<Child>,
    logs: VecDeque<LogPayload>,
    emit_logs: bool,
}

#[derive(Serialize, Clone)]
struct LogPayload {
    kind: String,
    line: String,
    stream: String,
}

#[derive(Serialize, Clone)]
struct ProcessExitPayload {
    kind: String,
}

#[derive(Serialize)]
struct StatusPayload {
    agent: bool,
    gateway: bool,
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

fn emit_log(app: &AppHandle, kind: &str, line: String, stream: &str) {
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
                    .find(|c| c == '\n' || c == '\r')
                    .unwrap_or(usize::MAX);
                if split_at == usize::MAX {
                    break;
                }
                let line = pending[..split_at].trim_end().to_string();
                pending = pending[split_at + 1..].to_string();
                if !line.trim().is_empty() {
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

fn refresh_child(child: &mut Option<Child>) -> bool {
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
            .args(["-TERM", "-P", &pid.to_string()])
            .status();
        let _ = Command::new("kill")
            .args(["-TERM", &pid.to_string()])
            .status();
    }
}

fn kill_matching_processes(kind: &str) {
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
        return Command::new("pgrep")
            .args(["-f", pattern])
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
    }
}

fn stop_all_processes(state: &Arc<Mutex<ProcState>>) {
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
    let agent_managed = refresh_child(&mut guard.agent);
    let gateway_managed = refresh_child(&mut guard.gateway);
    let scan = *SCAN_PROCS
        .get_or_init(|| std::env::var_os("NANOBOT_SCAN_PROCS").is_some());
    let agent = if agent_managed {
        true
    } else if scan {
        is_matching_process_running("agent")
    } else {
        false
    };
    let gateway = if gateway_managed {
        true
    } else if scan {
        is_matching_process_running("gateway")
    } else {
        false
    };
    StatusPayload { agent, gateway }
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
fn list_workspace_skills() -> Result<Vec<SkillInfo>, String> {
    let dir = workspace_skills_dir();
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
    let data = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(_) => return Ok(Vec::new()),
    };
    let mut rows: Vec<SessionMessagePayload> = Vec::new();
    let lower_query = query.map(|q| q.to_lowercase());

    for (idx, line) in data.lines().enumerate() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let val: Value = match serde_json::from_str(trimmed) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if val.get("_type").is_some() {
            continue;
        }
        let content = val
            .get("content")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        if content.is_empty() {
            continue;
        }
        if let Some(q) = lower_query.as_ref() {
            if !content.to_lowercase().contains(q) {
                continue;
            }
        }
        let role = val
            .get("role")
            .and_then(Value::as_str)
            .unwrap_or("system")
            .to_string();
        let created_at = val
            .get("timestamp")
            .or_else(|| val.get("created_at"))
            .or_else(|| val.get("updated_at"))
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_string();

        rows.push(SessionMessagePayload {
            id: format!("{}-{}", created_at, idx),
            role,
            content,
            created_at,
            line: idx,
        });
    }

    let total = rows.len();
    if offset >= total {
        return Ok(Vec::new());
    }
    let end = total.saturating_sub(offset);
    let start = end.saturating_sub(limit);
    let slice = rows[start..end].to_vec();
    Ok(slice)
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
        let size = metadata.as_ref().and_then(|m| Some(m.len()));
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
) -> Result<String, String> {
    emit_log(
        &app,
        "agent",
        format!("User: {}", truncate_line(&message, 200)),
        "stdout",
    );
    let app_handle = app.clone();
    let combined = tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let mut cmd = base_command(&app_handle);
        cmd.args([
            "-m",
            "nanobot",
            "agent",
            "--message",
            &message,
            "--session",
            &session_id,
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null());

        let output = cmd.output().map_err(|e| e.to_string())?;
        let mut combined = String::new();
        combined.push_str(&String::from_utf8_lossy(&output.stdout));
        combined.push_str(&String::from_utf8_lossy(&output.stderr));

        Ok(combined)
    })
    .await
    .map_err(|e| e.to_string())??;

    let cleaned = strip_ansi(combined.as_str());
    for line in cleaned.lines() {
        if !line.trim().is_empty() {
            emit_log(&app, "agent", line.to_string(), "stdout");
        }
    }
    Ok(cleaned.trim().to_string())
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
            while let Some(next) = chars.next() {
                if ('@'..='~').contains(&next) {
                    break;
                }
            }
        } else {
            out.push(ch);
        }
    }
    out
}

fn main() {
    let state = Arc::new(Mutex::new(ProcState::default()));

    tauri::Builder::default()
        .manage(state)
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                let icon_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("icons")
                    .join("icon.png");
                if let Ok(icon) = tauri::image::Image::from_path(icon_path) {
                    let _ = window.set_icon(icon);
                }
            }

            let show = MenuItem::with_id(app, "show", "Show", true, None::<&str>)?;
            let hide = MenuItem::with_id(app, "hide", "Hide", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &hide, &quit])?;

            if let Some(tray) = app.tray_by_id("main") {
                tray.set_menu(Some(menu))?;
                tray.on_menu_event(|app, event| match event.id().as_ref() {
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "hide" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.hide();
                        }
                    }
                    "quit" => {
                        // Ensure child processes exit with the desktop app.
                        let state = app.state::<Arc<Mutex<ProcState>>>().inner().clone();
                        stop_all_processes(&state);
                        // Best-effort cleanup for any lingering nanobot processes.
                        kill_matching_processes("agent");
                        kill_matching_processes("gateway");
                        app.exit(0);
                    }
                    _ => {}
                });
                tray.on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button,
                        button_state,
                        ..
                    } = event
                    {
                        if button == MouseButton::Left && button_state == MouseButtonState::Up {
                            if let Some(window) = tray.app_handle().get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                    }
                });
            }

            let state = app.state::<Arc<Mutex<ProcState>>>().inner().clone();
            let handle = app.handle().clone();
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
            send_agent_message
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
