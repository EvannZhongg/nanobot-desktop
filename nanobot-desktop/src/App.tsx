import React, { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

import type {
  TabKey, Message, Status,
  ConfigFilePayload, SessionInfo
} from "./types";
import { now, MAX_INPUT_LINES } from "./utils/helpers";

import ErrorBoundary from "./components/ErrorBoundary";
import Sidebar from "./components/Sidebar";
import ChatMessageItem from "./components/ChatMessageItem";
import ToastContainer from "./components/ToastContainer";
import { useChat } from "./hooks/useChat";
import { useProcesses } from "./hooks/useProcesses";
import { useToast } from "./hooks/useToast";

/* -- Lazy-loaded panel components (code-split per tab) -- */
const MonitorPanel = lazy(() => import("./components/MonitorPanel"));
const CronPanel = lazy(() => import("./components/CronPanel"));
const SkillsPanel = lazy(() => import("./components/SkillsPanel"));
const SessionsPanel = lazy(() => import("./components/SessionsPanel"));
const MemoryPanel = lazy(() => import("./components/MemoryPanel"));
const ModelPanel = lazy(() => import("./components/ModelPanel"));

/* -- Constant style objects to avoid re-creation on every render -- */
const STYLE_NO_DRAG = { WebkitAppRegion: "no-drag" } as React.CSSProperties;
const STYLE_MODEL_WRAPPER: React.CSSProperties = {
  position: "relative", display: "inline-flex", alignItems: "center", marginRight: "8px",
  ...(STYLE_NO_DRAG as any)
};


/* -- Loading fallback for lazy panels -- */
const PanelFallback = () => (
  <div className="content">
    <div className="empty-state">
      <div className="empty-state-icon">⏳</div>
      <div className="empty-state-text">Loading...</div>
    </div>
  </div>
);

/* -- Onboard modal (only rendered when config missing) -- */
const OnboardModal = React.memo(function OnboardModal({
  proc, toast,
}: {
  proc: ReturnType<typeof useProcesses>;
  toast: ReturnType<typeof useToast>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [importName, setImportName] = useState("");
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const handleImport = useCallback(async (file: File) => {
    setBusy(true);
    setError("");
    try {
      const text = await file.text();
      try { JSON.parse(text); } catch { throw new Error("Invalid JSON file"); }
      await invoke("save_config_file", { content: text });
      proc.setConfigMissing(false);
      await proc.startAllProcs();
      toast.success("Config imported successfully");
    } catch (err) {
      setError(String(err));
      toast.error(`Import failed: ${err}`);
    } finally {
      setBusy(false);
    }
  }, [proc, toast]);

  const handleOnboard = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      await invoke("run_onboard");
      proc.setConfigMissing(false);
      await proc.startAllProcs();
      toast.success("Onboard completed!");
    } catch (err) {
      setError(String(err));
      toast.error(`Onboard failed: ${err}`);
    } finally {
      setBusy(false);
    }
  }, [proc, toast]);

  const handleFileChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setImportName(file.name);
    handleImport(file);
    event.target.value = "";
  }, [handleImport]);

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="config-modal-title">
      <div className="modal-card">
        <h3 id="config-modal-title">未找到配置文件</h3>
        <p>当前未检测到配置文件。你可以选择已有的 config.json，或运行 nanobot onboard 进行初始化。</p>
        <div className="modal-path">目标路径：{proc.configMissingPath || "~/.nanobot/config.json"}</div>
        <div className="modal-actions">
          <button onClick={() => fileInputRef.current?.click()} disabled={busy}>选择 config.json</button>
          <button onClick={handleOnboard} disabled={busy}>运行 onboard</button>
        </div>
        {importName && <div className="modal-hint">已选择：{importName}</div>}
        {error && <div className="modal-error">{error}</div>}
        <input ref={fileInputRef} type="file" accept=".json,application/json" onChange={handleFileChange} className="modal-file-input" />
      </div>
    </div>
  );
});


export default function App() {
  const [showModelDropdown, setShowModelDropdown] = useState(false);
  const modelDropdownRef = useRef<HTMLDivElement | null>(null);
  const [tab, setTab] = useState<TabKey>("chat");
  const toast = useToast();

  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const chat = useChat(sessions);
  const proc = useProcesses();

  /* Load models from config on mount */
  useEffect(() => {
    invoke<ConfigFilePayload>("read_config_file").then((payload) => {
      if (payload.exists && payload.content) {
        try {
          const cfg = JSON.parse(payload.content);
          const models = new Set<string>();
          // Extract model from agents config
          if (cfg.agents) {
            Object.values(cfg.agents).forEach((agent: any) => {
              if (typeof agent === "object" && agent !== null && agent.model) {
                models.add(agent.model);
              }
            });
          }
          // Extract from explicit models array
          if (Array.isArray(cfg.models)) {
            cfg.models.forEach((m: string) => models.add(m));
          }
          // Extract default model
          if (cfg.agents?.defaults?.model) {
            models.add(cfg.agents.defaults.model);
          }
          // Extract provider-based model suggestions (Removed per request)
          chat.setAvailableModels(Array.from(models));
        } catch (e) {
          console.warn("Config parse error:", e);
        }
      }
    }).catch(() => {});
  }, []);

  /* Close model dropdown when clicking outside */
  useEffect(() => {
    if (!showModelDropdown) return;
    const handler = (e: MouseEvent) => {
      if (modelDropdownRef.current && !modelDropdownRef.current.contains(e.target as Node)) {
        setShowModelDropdown(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showModelDropdown]);

  /* Textarea auto-height - round 5 layout optimization */
  useLayoutEffect(() => {
    const el = chat.textareaRef.current;
    if (!el) return;
    const style = window.getComputedStyle(el);
    const lineHeight = parseFloat(style.lineHeight || "20");
    const padding = parseFloat(style.paddingTop || "0") + parseFloat(style.paddingBottom || "0");
    const minHeightRaw = parseFloat(style.minHeight || "0");
    const minHeight = Number.isFinite(minHeightRaw) && minHeightRaw > 0 ? minHeightRaw : lineHeight + padding;
    const maxHeight = lineHeight * MAX_INPUT_LINES + padding;
    el.style.height = "auto";
    const nextHeight = Math.min(Math.max(el.scrollHeight, minHeight), maxHeight);
    el.style.height = `${nextHeight}px`;
    el.style.overflowY = el.scrollHeight > maxHeight ? "auto" : "hidden";
  }, [chat.input]);

  /* Load history when switching to chat tab */
  useEffect(() => {
    if (tab !== "chat") return;
    if (chat.historyOffset > 0 || chat.historyLoading || chat.historyEnd) return;
    chat.loadHistoryChunk({ initial: true }).then(() => {
      requestAnimationFrame(() => {
        const node = chat.chatListRef.current;
        if (node) node.scrollTop = node.scrollHeight;
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  /* Auto-scroll chat */
  useEffect(() => {
    if (tab !== "chat" || !chat.autoScrollRef.current) return;
    const node = chat.chatListRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [chat.messages, tab]);

  /* Load sessions for chat and sessions tab */
  const loadSessions = useCallback(async () => {
    setSessionsLoading(true);
    try {
      const items = await invoke<SessionInfo[]>("list_sessions");
      setSessions(items);
    } catch (err) {
      console.error("Failed to load sessions", err);
    } finally {
      setSessionsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (tab === "sessions" || tab === "chat") loadSessions();
  }, [tab, loadSessions]);

  /* Keyboard shortcuts */
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key === "n") {
        e.preventDefault();
        chat.handleNewChat();
        setTab("chat");
        toast.info("New chat created");
      }
      if (meta && e.key === "7") { e.preventDefault(); setTab("models"); }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [chat.handleNewChat, toast]);

  /* Tab header title */
  const tabTitle = useMemo(() => {
    const map: Record<TabKey, string> = {
      chat: "", monitor: "Monitor", cron: "Cron",
      sessions: "Sessions", skills: "Skills",
      memory: "Memory", models: "Models",
    };
    return map[tab];
  }, [tab]);

  /* Model dropdown toggle */
  const toggleModelDropdown = useCallback(() => setShowModelDropdown((p) => !p), []);

  /* Model select handler */
  const handleModelSelect = useCallback((m: string) => {
    chat.setSelectedModel(m);
    setShowModelDropdown(false);
  }, [chat]);

  return (
    <ErrorBoundary fallbackMessage="Nanobot Desktop encountered an error">
      <div className="app-shell">
        <Sidebar tab={tab} setTab={setTab} status={proc.status} currentSession={chat.currentSession} />

        <main className="main">
          <div className="header">
            <h1>
              {tab === "chat" ? (
                <div className="chat-header-top-bar" style={STYLE_NO_DRAG}>
                  <div className="header-left">
                    <span className="header-title">Chat</span>
                    <select
                      value={chat.currentSession}
                      onChange={(e) => chat.setCurrentSession(e.target.value)}
                      className="clean-select"
                      aria-label="Select session"
                    >
                      {sessions.map((s) => (
                        <option key={s.name} value={s.name}>{s.name}</option>
                      ))}
                      {!sessions.some((s) => s.name === chat.currentSession) && (
                        <option value={chat.currentSession}>{chat.currentSession}</option>
                      )}
                    </select>
                  </div>
                  
                  <div className="header-right">
                    <div ref={modelDropdownRef} style={STYLE_MODEL_WRAPPER}>
                      <input
                        value={chat.selectedModel}
                        onChange={(e) => chat.setSelectedModel(e.target.value)}
                        onFocus={() => setShowModelDropdown(true)}
                        onClick={() => setShowModelDropdown(true)}
                        className="clean-model-input"
                        placeholder="Model configured..."
                      />
                      <button onClick={toggleModelDropdown} className="clean-dropdown-arrow" aria-label="Toggle model dropdown">▼</button>
                      {showModelDropdown && (
                        <div className="clean-model-dropdown">
                          {chat.modelList.map((m) => (
                            <div
                              key={m}
                              className={`model-dropdown-item ${chat.selectedModel === m ? "selected" : ""}`}
                              onClick={() => handleModelSelect(m)}
                            >
                              {m}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                    
                    <div className="header-actions">
                      <button onClick={() => chat.setChatFontSize((s) => Math.max(10, s - 1))} className="clean-action-btn" title="Decrease Font">a</button>
                      <button onClick={() => chat.setChatFontSize((s) => Math.min(24, s + 1))} className="clean-action-btn" title="Increase Font">A</button>
                      <button onClick={chat.handleNewChat} className="clean-action-btn highlight" title="New Chat (Cmd+N)"><span>＋</span></button>
                      <button onClick={chat.handleRefreshChat} className="clean-action-btn" title="Refresh Chat"><span>↻</span></button>
                    </div>
                  </div>
                </div>
              ) : tabTitle}
            </h1>
          </div>

          <ErrorBoundary fallbackMessage={`${tab} panel error`}>
            <Suspense fallback={<PanelFallback />}>
              {tab === "chat" ? (
                <div className="content">
                  <div className="chat-list" ref={chat.chatListRef} onScroll={chat.handleHistoryScroll} aria-live="polite" aria-atomic="false">
                    {chat.messages.length === 0 && (
                      <div className="empty-state">
                        <div className="empty-state-icon">💬</div>
                        <div className="empty-state-text">Start by sending a message</div>
                        <div className="empty-state-hint">Press Enter to send, Shift+Enter for new line</div>
                      </div>
                    )}
                    {chat.messages.map((msg) => (
                      <ChatMessageItem
                        key={msg.id}
                        msg={msg}
                        chatFontSize={chat.chatFontSize}
                        isCollapsed={chat.collapsedMsgIds.has(msg.id)}
                        toggleCollapse={chat.toggleCollapse}
                      />
                    ))}
                    {chat.sending && (
                      <div className="message-row bot" aria-busy="true" aria-label="Bot is typing">
                        <div className="bubble bot thinking">
                          <div className="bubble-body">
                            <span className="thinking-text">正在思考</span>
                            <span className="thinking-dots"><span /><span /><span /></span>
                          </div>
                        </div>
                        <div className="bubble-meta">assistant · {now()}</div>
                      </div>
                    )}
                  </div>
                  <div className="input-row">
                    <textarea
                      ref={chat.textareaRef}
                      rows={1}
                      value={chat.input}
                      onChange={(e) => chat.setInput(e.target.value)}
                      onKeyDown={chat.handleInputKeyDown}
                      placeholder="Type a message... (Enter to send, Shift+Enter for new line)"
                      aria-label="Chat message input"
                    />
                    <button 
                      onClick={chat.sendMessage} 
                      onMouseDown={(e) => e.preventDefault()}
                      disabled={chat.sending} 
                      aria-label="Send message"
                    >
                      {chat.sending ? "…" : "↑"}
                    </button>
                  </div>
                </div>
              ) : tab === "monitor" ? (
                <MonitorPanel proc={proc} />
              ) : tab === "cron" ? (
                <CronPanel toast={toast} proc={proc} />
              ) : tab === "sessions" ? (
                <SessionsPanel
                  sessions={sessions}
                  loadSessions={loadSessions}
                  sessionsLoading={sessionsLoading}
                  toast={toast}
                />
              ) : tab === "skills" ? (
                <SkillsPanel toast={toast} />
              ) : tab === "memory" ? (
                <MemoryPanel toast={toast} />
              ) : (
                <ModelPanel toast={toast} proc={proc} />
              )}
            </Suspense>
          </ErrorBoundary>
        </main>

        {proc.configMissing && <OnboardModal proc={proc} toast={toast} />}
        <ToastContainer toasts={toast.toasts} onDismiss={toast.removeToast} />
      </div>
    </ErrorBoundary>
  );
}
