import React, { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { 
  Brain, Plus, RefreshCw, Type, Minus, Plus as PlusIcon, ArrowUp, MessageSquare, 
  XCircle, FilePlus, UploadCloud, FileText, Image as ImageIcon, Square,
  Check, Copy, Activity, Settings2, Router, Users, ChevronDown, FolderOpen
} from "lucide-react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";

import type {
  TabKey, Message, Status,
  ConfigFilePayload, SessionInfo, Attachment
} from "./types";
import { now, MAX_INPUT_LINES } from "./utils/helpers";

import ErrorBoundary from "./components/ErrorBoundary";
import Sidebar from "./components/Sidebar";
import ChatMessageItem from "./components/ChatMessageItem";
import SidePanel from "./components/SidePanel";
import ToastContainer from "./components/ToastContainer";
import { AttachmentBar } from "./components/AttachmentBar";
import { ModelDropdown } from "./components/ModelDropdown";
import { DropZone } from "./components/DropZone";

import { useChat } from "./hooks/useChat";
import { useProcesses } from "./hooks/useProcesses";
import { useToast } from "./hooks/useToast";
import { useSettings } from "./hooks/useSettings";

const MonitorPanel = lazy(() => import("./components/MonitorPanel"));
const CronPanel = lazy(() => import("./components/CronPanel"));
const SessionsPanel = lazy(() => import("./components/SessionsPanel"));
const SkillsPanel = lazy(() => import("./components/SkillsPanel"));
const MemoryPanel = lazy(() => import("./components/MemoryPanel"));
const ModelPanel = lazy(() => import("./components/ModelPanel"));
const SettingsPanel = lazy(() => import("./components/SettingsPanel"));

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

  const [isDragging, setIsDragging] = useState(false);
  const dragCounter = useRef(0);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current++;
    if (e.dataTransfer.items && e.dataTransfer.items.length > 0) {
      setIsDragging(true);
    }
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current--;
    if (dragCounter.current === 0) {
      setIsDragging(false);
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    dragCounter.current = 0;

    const files = e.dataTransfer.files;
    if (files && files.length > 0) {
      // Assuming only one file for config import
      const file = files[0];
      setImportName(file.name);
      handleImport(file);
    }
  }, [handleImport]);

  return (
    <div
      className={`modal-backdrop ${isDragging ? "dragging" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-labelledby="config-modal-title"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <DropZone isDragging={isDragging} />
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
  const { t } = useSettings();

  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const chat = useChat(sessions);
  const {
    isSidePanelOpen, setIsSidePanelOpen,
    sidePanelMessageId, toggleSidePanel
  } = chat;

  const sidePanelContent = useMemo(() => {
    if (!sidePanelMessageId) return null;
    return chat.messages.find(m => m.id === sidePanelMessageId)?.content || null;
  }, [chat.messages, sidePanelMessageId]);
  const proc = useProcesses();

  const [isDragging, setIsDragging] = useState(false);
  const dragCounter = useRef(0);

  const handleFileAttachment = useCallback((file: File) => {
    // In Tauri, files dropped or selected via Dialog often have a 'path' property
    let path = (file as any).path || file.name;
    
    // Check if it's an absolute path (heuristic: starts with / or has drive letter like C:)
    const isAbsolutePath = path.startsWith("/") || /^[a-zA-Z]:\\/.test(path);
    
    const isImage = file.type.startsWith("image/");
    const attachment: Attachment = {
      id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      path,
      name: file.name,
      type: file.type,
      previewUrl: (isImage && isAbsolutePath) ? convertFileSrc(path) : undefined
    };
    chat.addAttachment(attachment);
  }, [chat]);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current++;
    if (e.dataTransfer.items && e.dataTransfer.items.length > 0) {
      setIsDragging(true);
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.stopPropagation();
    dragCounter.current--;
    if (dragCounter.current === 0) {
      setIsDragging(false);
    }
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    dragCounter.current = 0;

    const files = e.dataTransfer?.files;
    if (files) {
      for (let i = 0; i < files.length; i++) {
        handleFileAttachment(files[i]);
      }
    }
  }, [handleFileAttachment]);

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

  /* Health Alerts - round 12 optimization */
  const lastStatus = useRef({ agent: "", gateway: "" });
  useEffect(() => {
    if (proc.status.agent === "Crashed" && lastStatus.current.agent !== "Crashed") {
      toast.error("Agent crashed! Watchdog will attempt restart.");
    }
    if (proc.status.gateway === "Crashed" && lastStatus.current.gateway !== "Crashed") {
      toast.error("Gateway crashed! Watchdog will attempt restart.");
    }
    lastStatus.current = { 
      agent: String(proc.status.agent), 
      gateway: String(proc.status.gateway) 
    };
  }, [proc.status.agent, proc.status.gateway, toast]);

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
    if (tab === "chat") return "";
    return t(`nav.${tab}` as any);
  }, [tab, t]);

  /* Model dropdown toggle */
  const toggleModelDropdown = useCallback(() => setShowModelDropdown((p) => !p), []);

  /* Model select handler */
  const handleModelSelect = useCallback((m: string) => {
    chat.setSelectedModel(m);
    setShowModelDropdown(false);
  }, [chat]);

  return (
    <ErrorBoundary fallbackMessage="Nanobot Desktop encountered an error">
      <div className={`app-shell ${isDragging ? 'dragging' : ''}`}
         onDragEnter={handleDragEnter}
         onDragOver={handleDragOver}
         onDragLeave={handleDragLeave}
         onDrop={handleDrop}
      >
      <DropZone isDragging={isDragging} />
        <Sidebar 
          tab={tab} 
          setTab={setTab} 
          status={{
            ...proc.status,
            router: chat.sending,
            subagents: Object.values(chat.subagentStatuses).some(s => s.status !== "completed" && s.status !== "error")
          }} 
          currentSession={chat.currentSession} 
          onNewChat={chat.handleNewChat}
        />

        <main className="main">
          <div className="header">
            <h1>
              {tab === "chat" ? (
                <div className="chat-header-top-bar" style={STYLE_NO_DRAG}>
                  <div className="header-left command-center">
                    <div className="breadcrumb">
                      <span className="breadcrumb-root">Nanobot</span>
                      <span className="breadcrumb-separator">/</span>
                      <span className="breadcrumb-current">Chat</span>
                    </div>
                    <div className="session-selector-container">
                      <ChevronDown size={14} className="selector-icon" />
                      <select
                        value={chat.currentSession}
                        onChange={(e) => chat.setCurrentSession(e.target.value)}
                        className="clean-select session-select"
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
                  </div>
                  
                  <div className="header-right">
                    {chat.sending && (
                      <button 
                        onClick={chat.stopGeneration} 
                        className="clean-action-btn stop-btn" 
                        title="Stop Generation"
                      >
                        <XCircle size={14} />
                        <span>Stop</span>
                      </button>
                    )}
                    
                    <ModelDropdown
                      selectedModel={chat.selectedModel}
                      setSelectedModel={chat.setSelectedModel}
                      showDropdown={showModelDropdown}
                      setShowDropdown={setShowModelDropdown}
                      modelList={chat.modelList}
                      dropdownRef={modelDropdownRef}
                    />
                    
                    <div className="header-actions">
                      <button onClick={() => chat.setChatFontSize((s: number) => Math.max(10, s - 1))} className="clean-action-btn" title="Decrease Font"><Minus size={14} /></button>
                      <button onClick={() => chat.setChatFontSize((s: number) => Math.min(24, s + 1))} className="clean-action-btn" title="Increase Font"><Plus size={14} /></button>
                      <button onClick={chat.handleNewChat} className="clean-action-btn highlight" title="New Chat (Cmd+N)"><Plus size={16} /></button>
                      <button onClick={chat.handleRefreshChat} className="clean-action-btn" title="Refresh Chat"><RefreshCw size={14} /></button>
                    </div>
                  </div>
                </div>
              ) : tabTitle}
            </h1>
          </div>

          <ErrorBoundary fallbackMessage={`${tab} panel error`}>
            <div className="tab-panel-container" key={tab}>
              <Suspense fallback={<PanelFallback />}>
                {tab === "chat" ? (
                  <div className={`content ${isSidePanelOpen ? 'split' : ''}`}>
                    <div className="chat-section" style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 }}>
                      <div className="chat-list" ref={chat.chatListRef} onScroll={chat.handleHistoryScroll} aria-live="polite" aria-atomic="false">
                        {chat.messages.length === 0 && (
                          <div className="empty-state">
                            <div className="empty-state-icon">
                              <MessageSquare size={48} strokeWidth={1} />
                            </div>
                            <div className="empty-state-text">Start your journey</div>
                            <div className="empty-state-hint">Press Enter to send, Shift+Enter for new line</div>
                          </div>
                        )}
                        {chat.messages.map((msg: Message) => (
                          <ChatMessageItem
                            key={msg.id}
                            msg={msg}
                            chatFontSize={chat.chatFontSize}
                            isCollapsed={chat.collapsedMsgIds.has(msg.id)}
                            toggleCollapse={chat.toggleCollapse}
                            subagentStatuses={chat.subagentStatuses}
                            onCancelSubagent={chat.cancelSubagent}
                            onOpenSidePanel={toggleSidePanel}
                          />
                        ))}
                      {chat.sending && (
                        <div className="message-row bot" aria-busy="true" aria-label="Bot is typing">
                          <div className="bubble-wrapper">
                            <div className="bubble bot thinking">
                              <div className="bubble-body">
                                <Brain size={16} className="thinking-icon" />
                                <span className="thinking-text">思考中</span>
                                <span className="typing-cursor" />
                              </div>
                            </div>
                            <div className="bubble-footer" style={{ opacity: 1 }}>
                              <div className="meta-left">
                                <span className="role-badge">Assistant</span>
                                <span className="time-stamp">{now()}</span>
                              </div>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                    <div className="input-row-container">
                      {chat.activeTrigger && (
                        <div className="active-trigger-box">
                          <div className="trigger-badge">
                            {chat.activeTrigger === "@" ? (
                              <Users size={14} className="trigger-icon" />
                            ) : (
                              <FolderOpen size={14} className="trigger-icon" />
                            )}
                            <span className="trigger-label">
                              {chat.activeTrigger === "@" ? "Select Agent / Skill" : 
                               chat.activeTrigger === "!!" ? "Pin Directory Scope" : "Select File / Directory"}
                            </span>
                          </div>
                        </div>
                      )}
                      {chat.pinnedDirectory && (
                        <div className="pinned-scope">
                          <div className="scope-tag">
                            <Router size={12} className="scope-icon" />
                            <span className="scope-text">Scoped: {chat.pinnedDirectory}</span>
                            <button 
                              className="clear-scope" 
                              onClick={() => chat.setPinnedDirectory(null)}
                              title="Clear pinned scope"
                            >
                              <XCircle size={14} />
                            </button>
                          </div>
                        </div>
                      )}
                      <AttachmentBar
                        attachments={chat.attachments}
                        onRemove={chat.removeAttachment}
                      />
                      <div className="input-row">
                        <textarea
                          ref={chat.textareaRef}
                          rows={1}
                          value={chat.input}
                          onChange={(e) => chat.setInput(e.target.value)}
                          onKeyDown={chat.handleInputKeyDown}
                          onPaste={(e) => {
                            const items = e.clipboardData?.items;
                            if (!items) return;
                            for (let i = 0; i < items.length; i++) {
                              if (items[i].kind === "file") {
                                const f = items[i].getAsFile();
                                if (f) {
                                  e.preventDefault();
                                  handleFileAttachment(f);
                                }
                              }
                            }
                          }}
                          placeholder="Type a message... (Cmd+Enter to send)"
                          aria-label="Chat message input"
                        />
                        <button 
                          onClick={chat.sending ? chat.stopGeneration : chat.sendMessage} 
                          onMouseDown={(e) => e.preventDefault()}
                          disabled={!chat.sending && !chat.input.trim() && chat.attachments.length === 0}
                          className={`send-btn ${chat.sending ? 'stop-active' : ''}`}
                          aria-label={chat.sending ? "Stop generation" : "Send message"}
                        >
                          {chat.sending ? <Square size={16} fill="currentColor" /> : <ArrowUp size={20} />}
                        </button>
                      </div>
                    </div>
                  </div>
                  {isSidePanelOpen && (
                    <SidePanel 
                      content={sidePanelContent} 
                      isOpen={isSidePanelOpen} 
                      onClose={() => setIsSidePanelOpen(false)} 
                      width={chat.sidePanelWidth}
                      onResize={chat.setSidePanelWidth}
                      messages={chat.messages}
                      currentMessageId={chat.sidePanelMessageId}
                      onSelectMessage={chat.toggleSidePanel}
                    />
                  )}
                </div>
              ) : tab === "monitor" ? (
                  <MonitorPanel 
                    proc={proc} 
                    subagentStatuses={chat.subagentStatuses} 
                    onCancelSubagent={chat.cancelSubagent}
                    onCancelAllSubagents={chat.cancelAllSubagents}
                    onRefreshSubagents={chat.reloadSubagents}
                  />
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
                  <SkillsPanel toast={toast} pinnedDirectory={chat.pinnedDirectory} />
                ) : tab === "memory" ? (
                  <MemoryPanel toast={toast} />
                ) : tab === "models" ? (
                  <ModelPanel toast={toast} proc={proc} />
                ) : (
                  <SettingsPanel />
                )}
              </Suspense>
            </div>
          </ErrorBoundary>
        </main>

        {proc.configMissing && <OnboardModal proc={proc} toast={toast} />}
        <ToastContainer toasts={toast.toasts} onDismiss={toast.removeToast} />
      </div>
    </ErrorBoundary>
  );
}
