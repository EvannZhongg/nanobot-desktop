import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

type TabKey = "chat" | "monitor" | "cron" | "sessions" | "skills" | "memory" | "config";

type Message = {
  id: string;
  role: "user" | "bot" | "system";
  content: string;
  createdAt: string;
  line?: number;
};

type LogEvent = {
  kind: "agent" | "gateway";
  line: string;
  stream: "stdout" | "stderr";
};

type LogState = {
  agent: LogEvent[];
  gateway: LogEvent[];
};

type Status = {
  agent: boolean;
  gateway: boolean;
};

type SkillItem = {
  name: string;
  path: string;
  hasSkillMd: boolean;
  modified?: number;
};

type SkillFile = {
  name: string;
  path: string;
  content: string;
  exists: boolean;
};

type MemoryFileInfo = {
  name: string;
  path: string;
  modified?: number;
};

type MemoryFilePayload = {
  name: string;
  path: string;
  content: string;
  exists: boolean;
};

type ConfigFilePayload = {
  path: string;
  content: string;
  exists: boolean;
};

type CronData = {
  version: number | null;
  jobs: any[];
};

type SessionMessagePayload = {
  id: string;
  role: string;
  content: string;
  createdAt: string;
  line?: number;
};

const SESSION_ID = "gui:default";
const MAX_INPUT_LINES = 6;
const HISTORY_BATCH = 10;

const now = () => new Date().toLocaleTimeString();
const todayFileName = () => {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}.md`;
};
const LOG_LINE_RE =
  /(^\s*(DEBUG|INFO|WARN|WARNING|ERROR):)|(\|\s*(DEBUG|INFO|WARN|WARNING|ERROR)\s*\|)|(\bnanobot\.)/;
const TRACE_START_RE = /(Traceback|Exception ignored in:|ResourceWarning|ValueError)/;
const TRACE_CONT_RE = /^(\s+|File\s+".*?",\s+line\s+\d+|^\^+)/;
const LOG_MARKERS = [
  /\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}/,
  /\b(INFO|DEBUG|WARN(?:ING)?|ERROR)\b/,
  /\bnanobot\./,
  /Executing tool:/,
  /Spawned subagent/,
  /Subagent/
];
const TOOL_RE = /Executing tool:/;
const SUBAGENT_RE = /(Spawned subagent|Subagent \[|Subagent .*starting task)/;
const ANSI_RE = /\x1b\[[0-9;]*m/g;
const ANSI_ARTIFACT_RE = /\b\d{1,3}m(?=(\d{4}-\d{2}-\d{2}|\s*\||[A-Za-z]))/g;

const formatCronValue = (value: any) => {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const formatCronSchedule = (schedule: any) => {
  if (!schedule || typeof schedule !== "object") return "unknown";
  if (schedule.kind === "every") {
    const everyMs = Number(schedule.everyMs || 0);
    if (!everyMs) return "every ?ms";
    if (everyMs % 3600000 === 0) return `every ${everyMs / 3600000}h`;
    if (everyMs % 60000 === 0) return `every ${everyMs / 60000}m`;
    if (everyMs % 1000 === 0) return `every ${everyMs / 1000}s`;
    return `every ${everyMs}ms`;
  }
  if (schedule.kind === "at") {
    const atMs = Number(schedule.atMs || 0);
    return atMs ? `at ${new Date(atMs).toLocaleString()}` : "at (unspecified)";
  }
  if (schedule.kind === "cron") {
    return schedule.expr ? `cron ${schedule.expr}` : "cron (empty)";
  }
  return "unknown";
};

const formatCronNextRun = (state: any) => {
  const next = state?.nextRunAtMs;
  if (!next) return "n/a";
  return new Date(next).toLocaleString();
};

const formatCronChannel = (payload: any) => {
  if (!payload?.deliver) return "local";
  const channel = payload.channel || "unknown";
  const to = payload.to ? ` → ${payload.to}` : "";
  return `${channel}${to}`;
};

const formatCronJob = (value: any) => {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

const cleanLogLine = (line: string) => {
  let cleaned = line.replace(ANSI_RE, "");
  const looksLikeLog =
    LOG_LINE_RE.test(cleaned) || cleaned.includes("|") || cleaned.includes("nanobot.");
  if (looksLikeLog) {
    cleaned = cleaned.replace(ANSI_ARTIFACT_RE, "");
  }
  return cleaned.trimEnd();
};

const cleanLogBlock = (block: string) =>
  block
    .split(/\r?\n/)
    .map((line) => cleanLogLine(line))
    .join("\n")
    .trim();

const findLogIndex = (line: string) => {
  let idx = -1;
  for (const pattern of LOG_MARKERS) {
    const match = pattern.exec(line);
    if (match && (idx === -1 || match.index < idx)) {
      idx = match.index;
    }
  }
  return idx;
};

const splitDebugContent = (content: string) => {
  const lines = content.split(/\r?\n/);
  const debugLines: string[] = [];
  const toolLines: string[] = [];
  const subagentLines: string[] = [];
  const mainLines: string[] = [];
  let inTrace = false;
  for (const line of lines) {
    const trimmed = line.trimEnd();
    if (!trimmed) {
      if (inTrace) {
        debugLines.push(trimmed);
      } else {
        mainLines.push(trimmed);
      }
      continue;
    }

    const splitAt = findLogIndex(trimmed);
    if (splitAt > 0) {
      let head = trimmed.slice(0, splitAt).trim();
      head = head.replace(/\b\d{1,3}m$/, "").trim();
      const tail = trimmed.slice(splitAt).trim();
      if (head) mainLines.push(head);
      if (tail) {
        const cleanedTail = cleanLogLine(tail);
        if (TOOL_RE.test(cleanedTail)) {
          toolLines.push(cleanedTail);
        } else if (SUBAGENT_RE.test(cleanedTail)) {
          subagentLines.push(cleanedTail);
        } else {
          debugLines.push(cleanedTail);
        }
      }
      continue;
    }

    if (TRACE_START_RE.test(trimmed)) {
      inTrace = true;
      debugLines.push(cleanLogLine(trimmed));
      continue;
    }

    if (inTrace) {
      if (TRACE_CONT_RE.test(trimmed)) {
        debugLines.push(cleanLogLine(trimmed));
        continue;
      }
      inTrace = false;
    }

    const cleaned = cleanLogLine(trimmed);
    if (LOG_LINE_RE.test(cleaned)) {
      if (TOOL_RE.test(cleaned)) {
        toolLines.push(cleaned);
      } else if (SUBAGENT_RE.test(cleaned)) {
        subagentLines.push(cleaned);
      } else {
        debugLines.push(cleaned);
      }
    } else {
      mainLines.push(trimmed);
    }
  }
  return {
    main: mainLines.join("\n").trim(),
    debug: debugLines.join("\n").trim(),
    debugCount: debugLines.length,
    tools: toolLines.join("\n").trim(),
    toolCount: toolLines.length,
    subagents: subagentLines.join("\n").trim(),
    subagentCount: subagentLines.length
  };
};

export default function App() {
  const [tab, setTab] = useState<TabKey>("chat");
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [logs, setLogs] = useState<LogState>({ agent: [], gateway: [] });
  const [status, setStatus] = useState<Status>({ agent: false, gateway: false });
  const [procBusy, setProcBusy] = useState({ agent: false, gateway: false });
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const chatListRef = useRef<HTMLDivElement | null>(null);
  const autoScrollRef = useRef(true);
  const [historyOffset, setHistoryOffset] = useState(0);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyEnd, setHistoryEnd] = useState(false);
  const agentLogRef = useRef<HTMLDivElement | null>(null);
  const gatewayLogRef = useRef<HTMLDivElement | null>(null);
  const [cronData, setCronData] = useState<CronData>({ version: null, jobs: [] });
  const [cronLoading, setCronLoading] = useState(false);
  const [cronError, setCronError] = useState("");
  const [cronDeleting, setCronDeleting] = useState<string | null>(null);
  const [cronExpanded, setCronExpanded] = useState<Set<string>>(new Set());
  const [selectedSessionLines, setSelectedSessionLines] = useState<Set<number>>(new Set());
  const [sessions, setSessions] = useState<{ name: string; path: string; size?: number; modified?: number }[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [sessionsError, setSessionsError] = useState("");
  const [selectedSession, setSelectedSession] = useState<string | null>(null);
  const [sessionMessages, setSessionMessages] = useState<Message[]>([]);
  const [sessionQuery, setSessionQuery] = useState("");
  const [sessionOffset, setSessionOffset] = useState(0);
  const [sessionLoading, setSessionLoading] = useState(false);
  const [sessionEnd, setSessionEnd] = useState(false);
  const [skills, setSkills] = useState<SkillItem[]>([]);
  const [skillsLoading, setSkillsLoading] = useState(false);
  const [skillsError, setSkillsError] = useState("");
  const [editingSkill, setEditingSkill] = useState<SkillFile | null>(null);
  const [editorContent, setEditorContent] = useState("");
  const [editorSaving, setEditorSaving] = useState(false);
  const [editorDirty, setEditorDirty] = useState(false);
  const [memoryFiles, setMemoryFiles] = useState<MemoryFileInfo[]>([]);
  const [memoryLoading, setMemoryLoading] = useState(false);
  const [memoryError, setMemoryError] = useState("");
  const [editingMemory, setEditingMemory] = useState<MemoryFilePayload | null>(null);
  const [memoryContent, setMemoryContent] = useState("");
  const [memorySaving, setMemorySaving] = useState(false);
  const [memoryDirty, setMemoryDirty] = useState(false);
  const [configFile, setConfigFile] = useState<ConfigFilePayload | null>(null);
  const [configContent, setConfigContent] = useState("");
  const [configLoading, setConfigLoading] = useState(false);
  const [configSaving, setConfigSaving] = useState(false);
  const [configDirty, setConfigDirty] = useState(false);
  const [configError, setConfigError] = useState("");
  const [configMissing, setConfigMissing] = useState(false);
  const [configMissingPath, setConfigMissingPath] = useState("");
  const [configInitBusy, setConfigInitBusy] = useState(false);
  const [configInitError, setConfigInitError] = useState("");
  const [configImportName, setConfigImportName] = useState("");
  const configFileInputRef = useRef<HTMLInputElement | null>(null);
  const pendingLogsRef = useRef<LogState>({ agent: [], gateway: [] });
  const logFlushTimerRef = useRef<number | null>(null);
  const monitorActiveRef = useRef(false);

  const agentLogText = useMemo(() => {
    if (tab !== "monitor") return "";
    return logs.agent
      .map((l) => `[${l.stream}] ${cleanLogLine(l.line)}`)
      .join("\n");
  }, [logs.agent, tab]);

  const gatewayLogText = useMemo(() => {
    if (tab !== "monitor") return "";
    return logs.gateway
      .map((l) => `[${l.stream}] ${cleanLogLine(l.line)}`)
      .join("\n");
  }, [logs.gateway, tab]);

  const mapHistoryMessage = (msg: SessionMessagePayload, idx: number): Message => ({
    id: `hist-${msg.id}-${idx}`,
    role: msg.role === "assistant" || msg.role === "bot"
      ? "bot"
      : msg.role === "user"
        ? "user"
        : "system",
    content: msg.content,
    createdAt: msg.createdAt || "(unknown)"
  });

  const mapSessionMessage = (msg: SessionMessagePayload, idx: number): Message => ({
    id: `sess-${msg.id}-${msg.line ?? idx}`,
    role: msg.role === "assistant" || msg.role === "bot"
      ? "bot"
      : msg.role === "user"
        ? "user"
        : "system",
    content: msg.content,
    createdAt: msg.createdAt || "(unknown)",
    line: msg.line ?? idx,
  });

  const flushPendingLogs = () => {
    const pending = pendingLogsRef.current;
    if (pending.agent.length === 0 && pending.gateway.length === 0) {
      logFlushTimerRef.current = null;
      return;
    }
    setLogs((prev) => ({
      agent: [...prev.agent, ...pending.agent].slice(-2000),
      gateway: [...prev.gateway, ...pending.gateway].slice(-2000)
    }));
    pendingLogsRef.current = { agent: [], gateway: [] };
    logFlushTimerRef.current = null;
  };

  const scheduleLogFlush = () => {
    if (logFlushTimerRef.current !== null) return;
    logFlushTimerRef.current = window.setTimeout(flushPendingLogs, 200);
  };

  const loadHistoryChunk = async (opts: { initial?: boolean; preserveScroll?: boolean } = {}) => {
    const { initial = false, preserveScroll = false } = opts;
    if (historyLoading || historyEnd) return 0;
    setHistoryLoading(true);
    try {
      const data = await invoke<SessionMessagePayload[]>("read_session_history", {
        limit: HISTORY_BATCH,
        offset: historyOffset
      });
      const mapped = data
        .map((msg, idx) => mapHistoryMessage(msg, idx + historyOffset))
        .filter((m) => m.content.trim().length > 0);
      if (mapped.length === 0) {
        setHistoryEnd(true);
        return 0;
      }

      const node = chatListRef.current;
      const prevHeight = node?.scrollHeight ?? 0;
      const prevTop = node?.scrollTop ?? 0;

      autoScrollRef.current = !preserveScroll;
      setMessages((prev) => [...mapped, ...prev]);
      setHistoryOffset((prev) => prev + mapped.length);

      if (preserveScroll && node) {
        requestAnimationFrame(() => {
          const n = chatListRef.current;
          if (!n) return;
          const newHeight = n.scrollHeight;
          n.scrollTop = newHeight - prevHeight + prevTop;
        });
      }
      return mapped.length;
    } catch (err) {
      console.error("history load failed", err);
      setHistoryEnd(true);
      return 0;
    } finally {
      setHistoryLoading(false);
    }
  };

  const handleHistoryScroll = () => {
    const node = chatListRef.current;
    if (!node || historyLoading || historyEnd) return;
    if (node.scrollTop <= 8) {
      loadHistoryChunk({ preserveScroll: true });
    }
  };

  const handleSessionLoadMore = () => {
    if (!selectedSession) return;
    loadSessionMessages(selectedSession, false);
  };

  useEffect(() => {
    let unlistenLog: (() => void) | null = null;
    let unlistenExit: (() => void) | null = null;
    let unlistenConfig: (() => void) | null = null;
    let statusTimer: number | null = null;

    const setup = async () => {
      unlistenLog = await listen<LogEvent>("process-log", (event) => {
        if (!monitorActiveRef.current) {
          return;
        }
        const pending = pendingLogsRef.current;
        if (event.payload.kind === "agent") {
          pending.agent.push(event.payload);
          if (pending.agent.length > 5000) {
            pending.agent.splice(0, pending.agent.length - 5000);
          }
        } else {
          pending.gateway.push(event.payload);
          if (pending.gateway.length > 5000) {
            pending.gateway.splice(0, pending.gateway.length - 5000);
          }
        }
        scheduleLogFlush();
      });

      unlistenExit = await listen<{ kind: string }>("process-exit", () => {
        refreshStatus();
      });

      unlistenConfig = await listen<ConfigFilePayload>("config-missing", (event) => {
        setConfigMissing(true);
        setConfigMissingPath(event.payload.path);
      });
    };

    setup();
    refreshStatus();
    checkConfigMissing();
    statusTimer = window.setInterval(() => {
      refreshStatus();
    }, 2000);

    return () => {
      if (unlistenLog) unlistenLog();
      if (unlistenExit) unlistenExit();
      if (unlistenConfig) unlistenConfig();
      if (logFlushTimerRef.current !== null) {
        window.clearTimeout(logFlushTimerRef.current);
        logFlushTimerRef.current = null;
      }
      if (statusTimer) window.clearInterval(statusTimer);
    };
  }, []);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    const style = window.getComputedStyle(el);
    const lineHeight = parseFloat(style.lineHeight || "20");
    const padding =
      parseFloat(style.paddingTop || "0") + parseFloat(style.paddingBottom || "0");
    const minHeightRaw = parseFloat(style.minHeight || "0");
    const minHeight =
      Number.isFinite(minHeightRaw) && minHeightRaw > 0
        ? minHeightRaw
        : lineHeight + padding;
    const maxHeight = lineHeight * MAX_INPUT_LINES + padding;

    el.style.height = "auto";
    const nextHeight = Math.min(Math.max(el.scrollHeight, minHeight), maxHeight);
    el.style.height = `${nextHeight}px`;
    el.style.overflowY = el.scrollHeight > maxHeight ? "auto" : "hidden";
  }, [input]);

  useEffect(() => {
    if (tab !== "chat") return;
    if (historyOffset > 0 || historyLoading || historyEnd) return;
    loadHistoryChunk({ initial: true }).then(() => {
      requestAnimationFrame(() => {
        const node = chatListRef.current;
        if (node) {
          node.scrollTop = node.scrollHeight;
        }
      });
    });
  }, [tab, historyOffset, historyLoading, historyEnd]);

  useEffect(() => {
    if (tab !== "chat") return;
    if (!autoScrollRef.current) return;
    const node = chatListRef.current;
    if (node) {
      node.scrollTop = node.scrollHeight;
    }
  }, [messages, tab]);

  useEffect(() => {
    if (tab !== "monitor") return;
    const scrollToBottom = (ref: React.RefObject<HTMLDivElement>) => {
      const node = ref.current;
      if (!node) return;
      node.scrollTop = node.scrollHeight;
    };
    requestAnimationFrame(() => {
      scrollToBottom(agentLogRef);
      scrollToBottom(gatewayLogRef);
    });
  }, [tab, agentLogText, gatewayLogText]);

  useEffect(() => {
    const updateStreaming = async () => {
      if (tab === "monitor") {
        monitorActiveRef.current = true;
        pendingLogsRef.current = { agent: [], gateway: [] };
        if (logFlushTimerRef.current !== null) {
          window.clearTimeout(logFlushTimerRef.current);
          logFlushTimerRef.current = null;
        }
        setLogs({ agent: [], gateway: [] });
        await invoke("set_log_streaming", { enabled: true });
        await loadInitialLogs();
        flushPendingLogs();
        return;
      }
      monitorActiveRef.current = false;
      await invoke("set_log_streaming", { enabled: false });
    };

    updateStreaming().catch((err) => {
      console.warn("log streaming toggle failed", err);
    });
  }, [tab]);

  useEffect(() => {
    if (tab === "skills") {
      loadSkills();
    }
    if (tab === "cron") {
      loadCronJobs();
    }
    if (tab === "sessions") {
      loadSessions();
    }
  }, [tab]);

  useEffect(() => {
    if (tab === "memory") {
      loadMemoryFiles();
    }
  }, [tab]);

  useEffect(() => {
    if (tab === "config") {
      loadConfigFile();
    }
  }, [tab]);

  const refreshStatus = async () => {
    const next = await invoke<Status>("get_status");
    setStatus(next);
  };

  const loadCronJobs = async () => {
    setCronLoading(true);
    setCronError("");
    try {
      const data = await invoke<CronData>("read_cron_jobs");
      const jobs = Array.isArray(data?.jobs) ? data.jobs : [];
      jobs.sort((a, b) => {
        const aNext = a?.state?.nextRunAtMs ?? Number.MAX_SAFE_INTEGER;
        const bNext = b?.state?.nextRunAtMs ?? Number.MAX_SAFE_INTEGER;
        if (aNext !== bNext) return aNext - bNext;
        const aCreated = a?.createdAtMs ?? 0;
        const bCreated = b?.createdAtMs ?? 0;
        return aCreated - bCreated;
      });
      setCronData({
        version: data?.version ?? null,
        jobs
      });
    } catch (err) {
      setCronError(String(err));
    } finally {
      setCronLoading(false);
    }
  };

  const toggleCronExpanded = (id: string) => {
    setCronExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const deleteCronJob = async (job: any) => {
    const id = job?.id;
    if (!id) {
      setCronError("Invalid job id");
      return;
    }
    const ok = window.confirm(`Delete cron job "${job?.name || id}"?`);
    if (!ok) return;
    setCronDeleting(id);
    try {
      const removed = await invoke<boolean>("delete_cron_job", { jobId: id });
      if (!removed) {
        setCronError("Job not found or already removed.");
        return;
      }
      await loadCronJobs();
      if (status.gateway) {
        await restartProc("gateway");
      }
    } catch (err) {
      setCronError(String(err));
    } finally {
      setCronDeleting(null);
    }
  };

  const loadInitialLogs = async () => {
    const initial = await invoke<LogEvent[]>("get_logs");
    setLogs({
      agent: initial.filter((l) => l.kind === "agent").slice(-2000),
      gateway: initial.filter((l) => l.kind === "gateway").slice(-2000)
    });
  };

  const loadSkills = async () => {
    setSkillsLoading(true);
    setSkillsError("");
    try {
      const items = await invoke<SkillItem[]>("list_workspace_skills");
      setSkills(items);
    } catch (err) {
      setSkillsError(String(err));
    } finally {
      setSkillsLoading(false);
    }
  };

  const loadSessions = async () => {
    setSessionsLoading(true);
    setSessionsError("");
    try {
      const items = await invoke<{ name: string; path: string; size?: number; modified?: number }[]>(
        "list_sessions"
      );
      setSessions(items);
      if (!selectedSession && items.length > 0) {
        setSelectedSession(items[0].name);
        setSessionOffset(0);
        setSessionEnd(false);
        setSessionMessages([]);
        await loadSessionMessages(items[0].name, true);
      }
    } catch (err) {
      setSessionsError(String(err));
    } finally {
      setSessionsLoading(false);
    }
  };

  const loadSessionMessages = async (name: string, reset = false) => {
    if (sessionLoading || sessionEnd) return;
    setSessionLoading(true);
    setSessionsError("");
    try {
      const data = await invoke<SessionMessagePayload[]>("read_session_messages", {
        name,
        limit: HISTORY_BATCH,
        offset: reset ? 0 : sessionOffset,
        query: sessionQuery.trim() || null
      });
      const mapped = data.map((msg, idx) => mapSessionMessage(msg, idx + sessionOffset));
      if (reset) {
        setSessionMessages(mapped);
        setSessionOffset(mapped.length);
        setSelectedSessionLines(new Set());
      } else {
        setSessionMessages((prev) => [...prev, ...mapped]);
        setSessionOffset((prev) => prev + mapped.length);
      }
      if (data.length < HISTORY_BATCH) {
        setSessionEnd(true);
      }
    } catch (err) {
      setSessionsError(String(err));
    } finally {
      setSessionLoading(false);
    }
  };

  const deleteSessionLine = async (name: string, line?: number) => {
    if (line === undefined) return;
    setSelectedSessionLines((prev) => {
      const next = new Set(prev);
      next.add(line);
      return next;
    });
  };

  const toggleSelectLine = (line: number) => {
    setSelectedSessionLines((prev) => {
      const next = new Set(prev);
      if (next.has(line)) {
        next.delete(line);
      } else {
        next.add(line);
      }
      return next;
    });
  };

  const deleteSelectedLines = async () => {
    if (!selectedSession || selectedSessionLines.size === 0) return;
    const ok = window.confirm(`Delete ${selectedSessionLines.size} selected message(s)?`);
    if (!ok) return;
    try {
      const lines = Array.from(selectedSessionLines).sort((a, b) => a - b);
      await invoke("delete_session_lines", { name: selectedSession, lines });
      setSelectedSessionLines(new Set());
      setSessionOffset(0);
      setSessionEnd(false);
      await loadSessionMessages(selectedSession, true);
    } catch (err) {
      setSessionsError(String(err));
    }
  };

  const openSkill = async (name: string) => {
    try {
      const payload = await invoke<SkillFile>("read_skill_file", { name });
      setEditingSkill(payload);
      setEditorContent(payload.content);
      setEditorDirty(false);
    } catch (err) {
      setSkillsError(String(err));
    }
  };

  const saveSkill = async () => {
    if (!editingSkill || editorSaving) return;
    setEditorSaving(true);
    try {
      await invoke("save_skill_file", { name: editingSkill.name, content: editorContent });
      setEditorDirty(false);
      await loadSkills();
    } catch (err) {
      setSkillsError(String(err));
    } finally {
      setEditorSaving(false);
    }
  };

  const deleteSkill = async (name: string) => {
    const ok = window.confirm(`Delete skill \"${name}\"? This will remove its folder.`);
    if (!ok) return;
    try {
      await invoke("delete_skill", { name });
      if (editingSkill?.name === name) {
        setEditingSkill(null);
        setEditorContent("");
        setEditorDirty(false);
      }
      await loadSkills();
    } catch (err) {
      setSkillsError(String(err));
    }
  };

  const loadMemoryFiles = async () => {
    setMemoryLoading(true);
    setMemoryError("");
    try {
      const items = await invoke<MemoryFileInfo[]>("list_memory_files");
      setMemoryFiles(items);
    } catch (err) {
      setMemoryError(String(err));
    } finally {
      setMemoryLoading(false);
    }
  };

  const loadConfigFile = async () => {
    setConfigLoading(true);
    setConfigError("");
    try {
      const payload = await invoke<ConfigFilePayload>("read_config_file");
      setConfigFile(payload);
      setConfigContent(payload.content || "");
      setConfigDirty(false);
      setConfigMissing(!payload.exists);
      setConfigMissingPath(payload.path);
    } catch (err) {
      setConfigError(String(err));
    } finally {
      setConfigLoading(false);
    }
  };

  const checkConfigMissing = async () => {
    try {
      const payload = await invoke<ConfigFilePayload>("read_config_file");
      setConfigMissing(!payload.exists);
      setConfigMissingPath(payload.path);
    } catch (err) {
      setConfigInitError(String(err));
    }
  };

  const startAllProcs = async () => {
    try {
      await invoke("start_process", { kind: "gateway" });
      await invoke("start_process", { kind: "agent" });
    } catch (err) {
      setConfigInitError(String(err));
    } finally {
      refreshStatus();
    }
  };

  const handleConfigImport = async (file: File) => {
    setConfigInitBusy(true);
    setConfigInitError("");
    try {
      const text = await file.text();
      await invoke("save_config_file", { content: text });
      await loadConfigFile();
      setConfigMissing(false);
      await startAllProcs();
    } catch (err) {
      setConfigInitError(String(err));
    } finally {
      setConfigInitBusy(false);
    }
  };

  const handleOnboard = async () => {
    setConfigInitBusy(true);
    setConfigInitError("");
    try {
      await invoke("run_onboard");
      await loadConfigFile();
      setConfigMissing(false);
      await startAllProcs();
    } catch (err) {
      setConfigInitError(String(err));
    } finally {
      setConfigInitBusy(false);
    }
  };

  const triggerConfigPicker = () => {
    configFileInputRef.current?.click();
  };

  const handleConfigFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setConfigImportName(file.name);
    handleConfigImport(file);
    event.target.value = "";
  };

  const saveConfigFile = async () => {
    if (configSaving) return;
    setConfigSaving(true);
    setConfigError("");
    try {
      await invoke("save_config_file", { content: configContent });
      setConfigDirty(false);
      await loadConfigFile();
      const current = await invoke<Status>("get_status");
      setStatus(current);
      if (current.gateway) {
        await restartProc("gateway");
      }
      if (current.agent) {
        await restartProc("agent");
      }
    } catch (err) {
      setConfigError(String(err));
    } finally {
      setConfigSaving(false);
    }
  };
  const openMemory = async (name: string) => {
    try {
      const payload = await invoke<MemoryFilePayload>("read_memory_file", { name });
      setEditingMemory(payload);
      setMemoryContent(payload.content);
      setMemoryDirty(false);
    } catch (err) {
      setMemoryError(String(err));
    }
  };

  const saveMemory = async () => {
    if (!editingMemory || memorySaving) return;
    setMemorySaving(true);
    try {
      await invoke("save_memory_file", {
        name: editingMemory.name,
        content: memoryContent
      });
      setMemoryDirty(false);
      await loadMemoryFiles();
    } catch (err) {
      setMemoryError(String(err));
    } finally {
      setMemorySaving(false);
    }
  };

  const deleteMemory = async (name: string) => {
    const ok = window.confirm(`Delete memory file \"${name}\"?`);
    if (!ok) return;
    try {
      await invoke("delete_memory_file", { name });
      if (editingMemory?.name === name) {
        setEditingMemory(null);
        setMemoryContent("");
        setMemoryDirty(false);
      }
      await loadMemoryFiles();
    } catch (err) {
      setMemoryError(String(err));
    }
  };

  const startProc = async (kind: "agent" | "gateway") => {
    await invoke("start_process", { kind });
    refreshStatus();
  };

  const stopProc = async (kind: "agent" | "gateway") => {
    await invoke("stop_process", { kind });
    refreshStatus();
  };

  const restartProc = async (kind: "agent" | "gateway") => {
    if (procBusy[kind]) return;
    setProcBusy((prev) => ({ ...prev, [kind]: true }));
    try {
      await invoke("stop_process", { kind });
      await new Promise((resolve) => setTimeout(resolve, 200));
      await invoke("start_process", { kind });
    } finally {
      setProcBusy((prev) => ({ ...prev, [kind]: false }));
      refreshStatus();
    }
  };

  const toggleProc = async (kind: "agent" | "gateway") => {
    if (procBusy[kind]) return;
    setProcBusy((prev) => ({ ...prev, [kind]: true }));
    try {
      if (status[kind]) {
        await stopProc(kind);
      } else {
        await startProc(kind);
      }
    } finally {
      setProcBusy((prev) => ({ ...prev, [kind]: false }));
    }
  };

  const sendMessage = async () => {
    const text = input.trim();
    if (!text || sending) return;
    setInput("");
    const userMsg: Message = {
      id: `${Date.now()}-user`,
      role: "user",
      content: text,
      createdAt: now()
    };
    autoScrollRef.current = true;
    setMessages((prev) => [...prev, userMsg]);

    setSending(true);
    try {
      const response = await invoke<string>("send_agent_message", {
        message: text,
        sessionId: SESSION_ID
      });
      const botMsg: Message = {
        id: `${Date.now()}-bot`,
        role: "bot",
        content: response.trim() || "(no response)",
        createdAt: now()
      };
      autoScrollRef.current = true;
      setMessages((prev) => [...prev, botMsg]);
    } catch (err) {
      const botMsg: Message = {
        id: `${Date.now()}-err`,
        role: "system",
        content: `Error: ${String(err)}`,
        createdAt: now()
      };
      autoScrollRef.current = true;
      setMessages((prev) => [...prev, botMsg]);
    } finally {
      setSending(false);
    }
  };

  const handleInputKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      sendMessage();
    }
  };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">Nanobot Desktop</div>
        <div className="nav">
          <button
            className={tab === "chat" ? "active" : ""}
            onClick={() => setTab("chat")}
          >
            Chat
          </button>
          <button
            className={tab === "monitor" ? "active" : ""}
            onClick={() => setTab("monitor")}
          >
            Monitor
          </button>
          <button
            className={tab === "cron" ? "active" : ""}
            onClick={() => setTab("cron")}
          >
            Cron
          </button>
          <button
            className={tab === "sessions" ? "active" : ""}
            onClick={() => setTab("sessions")}
          >
            Sessions
          </button>
          <button
            className={tab === "skills" ? "active" : ""}
            onClick={() => setTab("skills")}
          >
            Skills
          </button>
          <button
            className={tab === "memory" ? "active" : ""}
            onClick={() => setTab("memory")}
          >
            Memory
          </button>
          <button
            className={tab === "config" ? "active" : ""}
            onClick={() => setTab("config")}
          >
            Config
          </button>
        </div>
        <div className="sidebar-footer">
          <div className="status-row">
            <span className="status-text">
              Agent:
              <span
                className={`breath-dot agent ${status.agent ? "on" : "off"}`}
                title={`Agent ${status.agent ? "running" : "stopped"}`}
              />
              <span className="status-text-label">
                {status.agent ? "running" : "stopped"}
              </span>
            </span>
          </div>
          <div className="status-row">
            <span className="status-text">
              Gateway:
              <span
                className={`breath-dot gateway ${status.gateway ? "on" : "off"}`}
                title={`Gateway ${status.gateway ? "running" : "stopped"}`}
              />
              <span className="status-text-label">
                {status.gateway ? "running" : "stopped"}
              </span>
            </span>
          </div>
          <div className="status-row session-row">
            <span className="session-label">Session</span>
            <span className="session">{SESSION_ID}</span>
          </div>
        </div>
      </aside>

      <main className="main">
        <div className="header">
          <h1>
            {tab === "chat"
              ? "Chat"
              : tab === "monitor"
                ? "Monitor"
                : tab === "cron"
                  ? "Cron"
                  : tab === "sessions"
                    ? "Sessions"
                  : tab === "skills"
                    ? "Skills"
                    : tab === "memory"
                      ? "Memory"
                      : "Config"}
          </h1>
          <div className="meta">Window close will hide to tray</div>
        </div>

        {tab === "chat" ? (
          <div className="content">
            <div className="chat-list" ref={chatListRef} onScroll={handleHistoryScroll}>
              {messages.length === 0 && (
                <div className="message-row bot">
                  <div className="bubble bot">
                    <div className="content">Start by sending a message.</div>
                  </div>
                  <div className="bubble-meta">system · {now()}</div>
                </div>
              )}
              {messages.map((msg) => (
                <div
                  key={msg.id}
                  className={`message-row ${msg.role === "user" ? "user" : "bot"}`}
                >
                  <div className={`bubble ${msg.role === "user" ? "user" : "bot"}`}>
                    <div className="content">
                      {msg.role === "bot" ? (() => {
                        const {
                          main,
                          debug,
                          debugCount,
                          tools,
                          toolCount,
                          subagents,
                          subagentCount
                        } = splitDebugContent(msg.content);
                        return (
                          <>
                            {main ? (
                              <ReactMarkdown remarkPlugins={[remarkGfm]}>{main}</ReactMarkdown>
                            ) : null}
                            {tools ? (
                              <details className="debug-details">
                                <summary>调用工具（{toolCount}）</summary>
                                <pre>{cleanLogBlock(tools)}</pre>
                              </details>
                            ) : null}
                            {subagents ? (
                              <details className="debug-details">
                                <summary>子代理（{subagentCount}）</summary>
                                <pre>{cleanLogBlock(subagents)}</pre>
                              </details>
                            ) : null}
                            {debug ? (
                              <details className="debug-details">
                                <summary>调试日志（{debugCount}）</summary>
                                <pre>{cleanLogBlock(debug)}</pre>
                              </details>
                            ) : null}
                          </>
                        );
                      })() : (
                        <div style={{ whiteSpace: "pre-wrap" }}>{msg.content}</div>
                      )}
                    </div>
                  </div>
                  <div className="bubble-meta">
                    {msg.role} · {msg.createdAt}
                  </div>
                </div>
              ))}
              {sending && (
                <div className="message-row bot">
                  <div className="bubble bot thinking">
                    <div className="content">
                      <span className="thinking-text">正在思考</span>
                      <span className="thinking-dots">
                        <span />
                        <span />
                        <span />
                      </span>
                    </div>
                  </div>
                  <div className="bubble-meta">assistant · {now()}</div>
                </div>
              )}
            </div>

            <div className="input-row">
              <textarea
                ref={textareaRef}
                rows={1}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleInputKeyDown}
                placeholder="Type a message..."
              />
              <button onClick={sendMessage} disabled={sending} aria-label="Send">
                {sending ? "…" : "↑"}
              </button>
            </div>
          </div>
        ) : tab === "monitor" ? (
          <div className="content">
            <div className="monitor-grid">
              <div className="card">
                <div className="card-row">
                  <h3>Agent</h3>
                  <button
                    className={status.agent ? "stop" : ""}
                    onClick={() => toggleProc("agent")}
                    disabled={procBusy.agent}
                  >
                    {status.agent ? "Stop" : "Start"}
                  </button>
                </div>
              </div>

              <div className="card">
                <div className="card-row">
                  <h3>Gateway</h3>
                  <button
                    className={status.gateway ? "stop" : ""}
                    onClick={() => toggleProc("gateway")}
                    disabled={procBusy.gateway}
                  >
                    {status.gateway ? "Stop" : "Start"}
                  </button>
                </div>
              </div>
            </div>

            <div className="monitor-logs">
              <div className="card">
                <h3>Agent Logs</h3>
                <div className="log-pane" ref={agentLogRef}>
                  <pre>{agentLogText || "No logs yet."}</pre>
                </div>
              </div>
              <div className="card">
                <h3>Gateway Logs</h3>
                <div className="log-pane" ref={gatewayLogRef}>
                  <pre>{gatewayLogText || "No logs yet."}</pre>
                </div>
              </div>
            </div>
          </div>
        ) : tab === "cron" ? (
          <div className="content">
            <div className="card">
              <div className="card-row">
                <h3>Cron Jobs</h3>
                <div style={{ color: "var(--muted)", fontSize: 12 }}>
                  Version: {cronData.version ?? "n/a"}
                </div>
              </div>
              {cronLoading ? (
                <div className="skills-empty">Loading...</div>
              ) : cronError ? (
                <div className="skills-error">{cronError}</div>
              ) : cronData.jobs.length === 0 ? (
                <div className="skills-empty">No jobs configured.</div>
              ) : (
                <div className="skills-list cron-list">
                  {cronData.jobs.map((job: any, idx) => {
                    const id = job?.id || `job-${idx}`;
                    const expanded = cronExpanded.has(id);
                    return (
                      <div className="skill-card cron-item" key={id}>
                        <div className="cron-summary">
                          <div>
                            <div className="cron-title">
                              {job?.name || job?.id || `Job ${idx + 1}`}
                            </div>
                            <div className="cron-meta">
                              {formatCronSchedule(job?.schedule)} · Next: {formatCronNextRun(job?.state)}
                            </div>
                            <div className="cron-meta">
                              {formatCronChannel(job?.payload)} · {job?.enabled ? "enabled" : "disabled"}
                            </div>
                          </div>
                          <div className="cron-actions">
                            <button
                              onClick={() => toggleCronExpanded(id)}
                              className="cron-btn"
                            >
                              {expanded ? "Hide" : "Details"}
                            </button>
                            <button
                              onClick={() => deleteCronJob(job)}
                              className="cron-btn danger"
                              disabled={cronDeleting === id}
                            >
                              {cronDeleting === id ? "Deleting..." : "Delete"}
                            </button>
                          </div>
                        </div>
                        {expanded && (
                          <div className="cron-details">
                            <pre>{formatCronJob(job)}</pre>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        ) : tab === "sessions" ? (
          <div className="content">
            <div className="skills-layout sessions-layout">
              <div className="skills-list">
                <div className="skills-header">
                  <div>Sessions: {sessions.length}</div>
                  <button onClick={loadSessions} disabled={sessionsLoading}>
                    {sessionsLoading ? "Refreshing..." : "Refresh"}
                  </button>
                </div>
                {sessionsError && <div className="skills-error">{sessionsError}</div>}
                {sessions.length === 0 && !sessionsLoading && (
                  <div className="skills-empty">No sessions found.</div>
                )}
                {sessions.map((s) => (
                  <div
                    key={s.name}
                    className={`skill-card ${selectedSession === s.name ? "active" : ""}`}
                    style={{ cursor: "pointer" }}
                    onClick={() => {
                      setSelectedSession(s.name);
                      setSessionOffset(0);
                      setSessionEnd(false);
                      setSessionMessages([]);
                      setSelectedSessionLines(new Set());
                      loadSessionMessages(s.name, true);
                    }}
                  >
                    <div className="skill-top">
                      <div className="skill-title session-title">{s.name}</div>
                      {s.modified ? (
                        <div className="skill-meta">
                          {new Date((s.modified || 0) * 1000).toLocaleString()}
                        </div>
                      ) : null}
                    </div>
                    {s.size ? (
                      <div className="skill-meta">{(s.size / 1024).toFixed(1)} KB</div>
                    ) : null}
                    <div className="skill-path session-path">{s.path}</div>
                  </div>
                ))}
              </div>

              <div className="skill-editor">
                <div className="editor-header">
                  <div className="editor-title">
                    <span>Session:</span>
                    <span className="session-name">
                      {selectedSession || "Select a session"}
                    </span>
                  </div>
                  <div className="editor-actions" style={{ gap: 8 }}>
                    <input
                      type="text"
                      placeholder="Search text..."
                      value={sessionQuery}
                      onChange={(e) => {
                        setSessionQuery(e.target.value);
                        setSessionOffset(0);
                        setSessionEnd(false);
                        if (selectedSession) {
                          loadSessionMessages(selectedSession, true);
                        }
                      }}
                      style={{ width: 180 }}
                    />
                    <button
                      onClick={() => selectedSession && loadSessionMessages(selectedSession, true)}
                      disabled={sessionLoading || !selectedSession}
                    >
                      {sessionLoading ? "Loading..." : "Reload"}
                    </button>
                    <button
                      className="danger"
                      onClick={deleteSelectedLines}
                      disabled={
                        sessionLoading ||
                        !selectedSession ||
                        selectedSessionLines.size === 0
                      }
                    >
                      Delete selected
                    </button>
                  </div>
                </div>

                <div className="chat-list" style={{ paddingRight: 6, gap: 10 }}>
                  {sessionMessages.length === 0 && (
                    <div className="skills-empty">
                      {sessionLoading ? "Loading..." : "No messages yet."}
                    </div>
                  )}
                  {sessionMessages.map((msg, idx) => (
                    <div
                      key={msg.id}
                      className={`message-row ${msg.role === "user" ? "user" : "bot"}`}
                    >
                      <div className={`bubble ${msg.role === "user" ? "user" : "bot"}`}>
                        <div className="content">
                          <div style={{ whiteSpace: "pre-wrap" }}>{msg.content}</div>
                        </div>
                        <div className="bubble-meta" style={{ marginTop: 4, display: "flex", alignItems: "center", gap: 10 }}>
                          <label style={{ display: "inline-flex", alignItems: "center", gap: 4, cursor: "pointer" }}>
                            <input
                              type="checkbox"
                              checked={selectedSessionLines.has((msg as any).line ?? idx)}
                              onChange={() => toggleSelectLine((msg as any).line ?? idx)}
                            />
                            <span>Select</span>
                          </label>
                          <span>{msg.role} · {msg.createdAt}</span>
                        </div>
                      </div>
                    </div>
                  ))}
                  {!sessionEnd && selectedSession && sessionMessages.length > 0 && (
                    <button
                      style={{
                        border: "1px solid var(--border)",
                        borderRadius: 10,
                        padding: "8px 12px",
                        cursor: "pointer",
                        background: "#eef5ff",
                        color: "#1d4ed8",
                        fontWeight: 600
                      }}
                      onClick={handleSessionLoadMore}
                      disabled={sessionLoading}
                    >
                      {sessionLoading ? "Loading..." : "Load more"}
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>
        ) : tab === "skills" ? (
          <div className="content">
            <div className="skills-header">
              <div>
                Workspace skills: {skills.length}
              </div>
              <button onClick={loadSkills} disabled={skillsLoading}>
                {skillsLoading ? "Refreshing..." : "Refresh"}
              </button>
            </div>
            {skillsError && <div className="skills-error">{skillsError}</div>}
            <div className="skills-layout">
              <div className="skills-list">
                {skills.length === 0 && !skillsLoading && (
                  <div className="skills-empty">No skills found in workspace/skills.</div>
                )}
                {skills.map((skill) => (
                  <div
                    key={skill.name}
                    className={`skill-card ${editingSkill?.name === skill.name ? "active" : ""}`}
                  >
                    <div className="skill-top">
                      <div className="skill-title">{skill.name}</div>
                      <div className="skill-actions">
                        <button onClick={() => openSkill(skill.name)}>
                          {skill.hasSkillMd ? "Open" : "Create"}
                        </button>
                        <button className="danger" onClick={() => deleteSkill(skill.name)}>
                          Delete
                        </button>
                      </div>
                    </div>
                    <div className="skill-meta">
                      {skill.hasSkillMd ? "SKILL.md" : "Missing SKILL.md"}
                    </div>
                    <div className="skill-path">{skill.path}</div>
                    {skill.modified ? (
                      <div className="skill-meta">
                        Updated: {new Date(skill.modified * 1000).toLocaleString()}
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
              <div className="skill-editor">
                {editingSkill ? (
                  <>
                    <div className="editor-header">
                      <div className="editor-title">
                        Editing: {editingSkill.name}
                      </div>
                      <div className="editor-actions">
                        <button
                          onClick={saveSkill}
                          disabled={editorSaving || !editorDirty}
                        >
                          {editorSaving ? "Saving..." : "Save"}
                        </button>
                        <button
                          className="ghost"
                          onClick={() => {
                            setEditingSkill(null);
                            setEditorContent("");
                            setEditorDirty(false);
                          }}
                        >
                          Close
                        </button>
                      </div>
                    </div>
                    <textarea
                      className="editor-textarea"
                      value={editorContent}
                      onChange={(e) => {
                        setEditorContent(e.target.value);
                        setEditorDirty(true);
                      }}
                    />
                    <div className="editor-hint">
                      {editingSkill.path}
                    </div>
                  </>
                ) : (
                  <div className="skills-empty">Select a skill to edit.</div>
                )}
              </div>
            </div>
          </div>
        ) : tab === "memory" ? (
          <div className="content">
            <div className="memory-header">
              <div>Daily memories: {memoryFiles.length}</div>
              <div className="memory-actions">
                <button
                  onClick={() => openMemory("MEMORY.md")}
                  className="ghost"
                >
                  Open MEMORY.md
                </button>
                <button
                  onClick={() => openMemory(todayFileName())}
                >
                  New Today
                </button>
                <button onClick={loadMemoryFiles} disabled={memoryLoading}>
                  {memoryLoading ? "Refreshing..." : "Refresh"}
                </button>
              </div>
            </div>
            {memoryError && <div className="skills-error">{memoryError}</div>}
            <div className="memory-layout">
              <div className="memory-list">
                {memoryFiles.length === 0 && !memoryLoading && (
                  <div className="skills-empty">No daily memory files yet.</div>
                )}
                {memoryFiles.map((file) => (
                  <div
                    key={file.name}
                    className={`memory-card ${editingMemory?.name === file.name ? "active" : ""}`}
                  >
                    <div className="memory-top">
                      <div className="memory-title">{file.name.replace(".md", "")}</div>
                      <div className="memory-actions">
                        <button onClick={() => openMemory(file.name)}>Open</button>
                        <button className="danger" onClick={() => deleteMemory(file.name)}>
                          Delete
                        </button>
                      </div>
                    </div>
                    <div className="skill-path">{file.path}</div>
                    {file.modified ? (
                      <div className="skill-meta">
                        Updated: {new Date(file.modified * 1000).toLocaleString()}
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
              <div className="memory-editor">
                {editingMemory ? (
                  <>
                    <div className="editor-header">
                      <div className="editor-title">
                        Editing: {editingMemory.name}
                      </div>
                      <div className="editor-actions">
                        <button
                          onClick={saveMemory}
                          disabled={memorySaving || !memoryDirty}
                        >
                          {memorySaving ? "Saving..." : "Save"}
                        </button>
                        <button
                          className="ghost"
                          onClick={() => {
                            setEditingMemory(null);
                            setMemoryContent("");
                            setMemoryDirty(false);
                          }}
                        >
                          Close
                        </button>
                      </div>
                    </div>
                    <textarea
                      className="editor-textarea"
                      value={memoryContent}
                      onChange={(e) => {
                        setMemoryContent(e.target.value);
                        setMemoryDirty(true);
                      }}
                    />
                    <div className="editor-hint">{editingMemory.path}</div>
                  </>
                ) : (
                  <div className="skills-empty">Select a memory file to edit.</div>
                )}
              </div>
            </div>
          </div>
        ) : (
          <div className="content">
            <div className="card">
              <div className="card-row">
                <div>
                  <h3>Config</h3>
                  <div className="skill-meta" style={{ marginTop: 6 }}>
                    {configFile?.path || "~/.nanobot/config.json"}
                  </div>
                </div>
                <div className="editor-actions">
                  <button onClick={loadConfigFile} disabled={configLoading}>
                    {configLoading ? "Loading..." : "Refresh"}
                  </button>
                  <button
                    onClick={saveConfigFile}
                    disabled={configSaving || !configDirty}
                  >
                    {configSaving ? "Saving..." : "Save"}
                  </button>
                </div>
              </div>
              {configError && <div className="skills-error">{configError}</div>}
              <textarea
                className="editor-textarea"
                value={configContent}
                onChange={(e) => {
                  setConfigContent(e.target.value);
                  setConfigDirty(true);
                }}
                placeholder="config.json content..."
              />
              <div className="editor-hint">
                Changes are saved to disk. Restart gateway/agent if needed.
              </div>
            </div>
          </div>
        )}
      </main>

      {configMissing && (
        <div className="modal-backdrop">
          <div className="modal-card">
            <h3>未找到配置文件</h3>
            <p>
              当前未检测到配置文件。你可以选择已有的 config.json，或运行
              nanobot onboard 进行初始化。
            </p>
            <div className="modal-path">
              目标路径：{configMissingPath || "~/.nanobot/config.json"}
            </div>
            <div className="modal-actions">
              <button onClick={triggerConfigPicker} disabled={configInitBusy}>
                选择 config.json
              </button>
              <button onClick={handleOnboard} disabled={configInitBusy}>
                运行 onboard
              </button>
            </div>
            {configImportName && (
              <div className="modal-hint">已选择：{configImportName}</div>
            )}
            {configInitError && <div className="modal-error">{configInitError}</div>}
            <input
              ref={configFileInputRef}
              type="file"
              accept=".json,application/json"
              onChange={handleConfigFileChange}
              className="modal-file-input"
            />
          </div>
        </div>
      )}
    </div>
  );
}
