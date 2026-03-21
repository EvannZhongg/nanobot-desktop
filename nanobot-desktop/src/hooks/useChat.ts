/**
 * Custom hook for chat state and logic.
 * Manages messages, input, sending, history, model selection.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { Message, SessionMessagePayload, SessionInfo, Attachment, AgentStatusEvent } from "../types";
import { now, HISTORY_BATCH } from "../utils/helpers";

const DEFAULT_MODELS = [
  "System Default"
];

export function useChat(sessions: SessionInfo[]) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [currentSession, setCurrentSession] = useState("cli_direct");
  const [chatFontSize, setChatFontSize] = useState<number>(() => {
    const saved = localStorage.getItem("nanobot-chat-font-size");
    return saved ? Number(saved) : 14;
  });
  const [selectedModel, setSelectedModel] = useState<string>("System Default");
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [collapsedMsgIds, setCollapsedMsgIds] = useState<Set<string>>(new Set());
  const [lastSelectedFolder, setLastSelectedFolder] = useState<string | null>(null);
  const [pinnedDirectory, setPinnedDirectory] = useState<string | null>(null);
  const [activeTrigger, setActiveTrigger] = useState<string | null>(null);
  const [historyOffset, setHistoryOffset] = useState(0);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyEnd, setHistoryEnd] = useState(false);
  const [subagentStatuses, setSubagentStatuses] = useState<Record<string, AgentStatusEvent>>({});

  const chatListRef = useRef<HTMLDivElement | null>(null);
  const autoScrollRef = useRef(true);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Stable refs for event handlers to avoid recreation on keystrokes
  const stateRef = useRef({ input, currentSession, selectedModel, attachments });
  const sessRef = useRef(currentSession); // Added for session check during history load

  useEffect(() => {
    stateRef.current = { input, currentSession, selectedModel, attachments };
    sessRef.current = currentSession;
  }, [input, currentSession, selectedModel, attachments]);

  // Persist font size
  useEffect(() => {
    localStorage.setItem("nanobot-chat-font-size", String(chatFontSize));
  }, [chatFontSize]);

  // Sync with Rust-side persistent registry on mount
  useEffect(() => {
    invoke<Record<string, AgentStatusEvent>>("get_subagent_registry")
      .then((registry) => {
        if (registry && Object.keys(registry).length > 0) {
          setSubagentStatuses(registry);
        }
      })
      .catch((err) => console.error("Failed to fetch subagent registry", err));
  }, []);

  useEffect(() => {
    const unlisten = (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      return listen<AgentStatusEvent>("agent-status", (event) => {
        setSubagentStatuses((prev) => {
          const payload = event.payload;
          const existing = prev[payload.agentId];
          
          return {
            ...prev,
            [payload.agentId]: {
              ...existing,
              ...payload
            },
          };
        });
      });
    })();
    return () => { unlisten.then((fn) => fn()); };
  }, []);

  const modelList = useMemo(() => {
    const seen = new Set(DEFAULT_MODELS);
    return [...DEFAULT_MODELS, ...availableModels.filter(m => !seen.has(m))];
  }, [availableModels]);

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

  const toggleCollapse = useCallback((id: string) => {
    setCollapsedMsgIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleNewChat = useCallback(() => {
    setCurrentSession(`gui_${Date.now()}`);
    setMessages([]);
    setHistoryOffset(0);
    setHistoryEnd(false);
  }, []);

  const handleRefreshChat = useCallback(() => {
    setMessages([]);
    setHistoryOffset(0);
    setHistoryEnd(false);
  }, []);

  const loadHistoryChunk = async (opts: { initial?: boolean; preserveScroll?: boolean } = {}) => {
    const { preserveScroll = false } = opts;
    if (historyLoading || historyEnd) return 0;
    setHistoryLoading(true);
    try {
      const sessionFileName = (currentSession.endsWith(".md") || currentSession.endsWith(".jsonl"))
        ? currentSession
        : `${currentSession}.jsonl`;

      const data = await invoke<SessionMessagePayload[]>("read_session_messages", {
        limit: HISTORY_BATCH,
        offset: historyOffset,
        name: sessionFileName
      });

      // Check if session changed while loading
      if (currentSession !== sessRef.current) return 0;

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

  const addAttachment = useCallback((attachment: Attachment) => {
    setAttachments((prev) => {
      if (prev.some(a => a.path === attachment.path)) return prev;
      return [...prev, attachment];
    });
  }, []);

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  }, []);

  const sendMessage = useCallback(async () => {
    const { input: currentInput, currentSession: sess, selectedModel: mod, attachments: currentAttachments } = stateRef.current;
    const text = currentInput.trim();
    if (!text && currentAttachments.length === 0 || sending) return;
    
    setInput("");
    setAttachments([]);

    const userMsg: Message = {
      id: `${Date.now()}-user`,
      role: "user",
      content: text,
      createdAt: now(),
      attachments: currentAttachments.length > 0 ? [...currentAttachments] : undefined,
    };
    autoScrollRef.current = true;
    setMessages((prev) => [...prev, userMsg]);

    setSending(true);
    try {
      const response = await invoke<string>("send_agent_message", {
        message: text,
        sessionId: sess,
        model: mod === "System Default" || !mod.trim() ? null : mod.trim(),
        media: currentAttachments.length > 0 ? currentAttachments.map((a: Attachment) => a.path) : null,
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
  }, [sending]);

  const handleInputKeyDown = useCallback((event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      sendMessage();
    }
  }, [sendMessage]);

  const switchSession = useCallback((name: string) => {
    setCurrentSession(name);
    setMessages([]);
    setAttachments([]);
    setHistoryOffset(0);
    setHistoryEnd(false);
  }, []);

  const triggerLock = useRef(false);

  const handleInputChange = useCallback(async (newText: string) => {
    setInput(newText);

    if (triggerLock.current) return;
    
    const match = newText.match(/(?:^|\s)(!{1,3}|@)$/);
    if (!match) {
      if (activeTrigger) setActiveTrigger(null);
      return;
    }

    const trigger = match[1];
    
    if (trigger === "!!!") {
      setPinnedDirectory(null);
      setInput(newText.slice(0, -3).trimEnd());
      setActiveTrigger(null);
      return;
    }

    setActiveTrigger(trigger);
    const isPinTrigger = trigger === "!!";
    const isDirTrigger = trigger === "!" || isPinTrigger;
    
    triggerLock.current = true;
    try {
      const selected = await open({
        directory: isDirTrigger,
        multiple: false,
        defaultPath: isPinTrigger ? (lastSelectedFolder ?? undefined) : (pinnedDirectory ?? lastSelectedFolder ?? undefined)
      });
      
      if (selected && typeof selected === "string") {
        if (isPinTrigger) {
          setPinnedDirectory(selected);
          setLastSelectedFolder(selected);
        } else if (isDirTrigger) {
          setLastSelectedFolder(selected);
        }

        setInput(current => {
          if (current.endsWith(trigger)) {
            return current.slice(0, -trigger.length).trimEnd() + " " + selected + " ";
          }
          return current;
        });
      }
    } catch (err) {
      console.error("Trigger fail", err);
    } finally {
      setTimeout(() => { triggerLock.current = false; }, 500);
      setActiveTrigger(null);
    }
  }, [lastSelectedFolder, pinnedDirectory, currentSession]); 

  const cancelSubagent = useCallback(async (agentId: string) => {
    try {
      await invoke("cancel_subagent", { agentId });
    } catch (err) {
      console.error("Failed to cancel subagent", err);
    }
  }, []);

  const reloadSubagents = useCallback(async () => {
    try {
      const registry = await invoke<Record<string, AgentStatusEvent>>("get_subagent_registry");
      setSubagentStatuses(registry || {});
    } catch (err) {
      console.error("Failed to reload subagent registry", err);
    }
  }, []);

  const cancelAllSubagents = useCallback(async () => {
    try {
      await invoke("cancel_all_subagents");
      await reloadSubagents();
    } catch (err) {
      console.error("Cancel all fail", err);
    }
  }, [reloadSubagents]);

  const stopGeneration = useCallback(async () => {
    setSending(false);
    try {
      await invoke("stop_generation");
    } catch (err) {
      console.error("Failed to stop generation", err);
    }
  }, []);

  return {
    messages, setMessages, input, setInput: handleInputChange, sending,
    currentSession, setCurrentSession: switchSession,
    chatFontSize, setChatFontSize,
    selectedModel, setSelectedModel,
    availableModels, setAvailableModels,
    collapsedMsgIds, toggleCollapse,
    historyOffset, historyLoading, historyEnd,
    chatListRef, autoScrollRef, textareaRef,
    modelList,
    handleNewChat, handleRefreshChat,
    loadHistoryChunk,    handleHistoryScroll,
    sendMessage, handleInputKeyDown,
    attachments, addAttachment, removeAttachment,
    pinnedDirectory, setPinnedDirectory,
    activeTrigger,
    subagentStatuses, cancelSubagent, cancelAllSubagents, stopGeneration,
    reloadSubagents,
  };
}
