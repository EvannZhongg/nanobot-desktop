/**
 * Custom hook for chat state and logic.
 * Manages messages, input, sending, history, model selection.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { Message, SessionMessagePayload, SessionInfo } from "../types";
import { now, HISTORY_BATCH } from "../utils/helpers";

const DEFAULT_MODELS = [
  "System Default"
];

export function useChat(sessions: SessionInfo[]) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [currentSession, setCurrentSession] = useState("cli_direct");
  const [chatFontSize, setChatFontSize] = useState<number>(() => {
    const saved = localStorage.getItem("nanobot-chat-font-size");
    return saved ? Number(saved) : 14;
  });
  const [selectedModel, setSelectedModel] = useState<string>("System Default");
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [collapsedMsgIds, setCollapsedMsgIds] = useState<Set<string>>(new Set());
  const [lastSelectedFolder, setLastSelectedFolder] = useState<string | null>(null);
  const [historyOffset, setHistoryOffset] = useState(0);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyEnd, setHistoryEnd] = useState(false);

  const chatListRef = useRef<HTMLDivElement | null>(null);
  const autoScrollRef = useRef(true);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Stable refs for event handlers to avoid recreation on keystrokes
  const stateRef = useRef({ input, currentSession, selectedModel });
  useEffect(() => {
    stateRef.current = { input, currentSession, selectedModel };
  }, [input, currentSession, selectedModel]);

  // Persist font size
  useEffect(() => {
    localStorage.setItem("nanobot-chat-font-size", String(chatFontSize));
  }, [chatFontSize]);

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

  const sendMessage = useCallback(async () => {
    const { input: currentInput, currentSession: sess, selectedModel: mod } = stateRef.current;
    const text = currentInput.trim();
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
        sessionId: sess,
        model: mod === "System Default" || !mod.trim() ? null : mod.trim()
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
    setHistoryOffset(0);
    setHistoryEnd(false);
  }, []);

  const handleInputChange = useCallback(async (newText: string) => {
    if (newText.endsWith(" !")) {
      const selected = await open({ directory: true });
      if (selected && typeof selected === "string") {
        setLastSelectedFolder(selected);
        setInput(newText.slice(0, -2) + " " + selected + " ");
      } else {
        setInput(newText.slice(0, -1)); // revert the "!" just in case they cancelled, or leave it? Let's leave it as " !" but avoid re-triggering. Wait, if we just remove the "!", they can type again if they want.
        setInput(newText.slice(0, -2) + " "); 
      }
      return;
    }
    
    if (newText.endsWith(" @")) {
      const selected = await open({ 
        directory: false, 
        defaultPath: lastSelectedFolder ?? undefined 
      });
      if (selected && typeof selected === "string") {
        setInput(newText.slice(0, -2) + " " + selected + " ");
      } else {
        setInput(newText.slice(0, -2) + " ");
      }
      return;
    }

    setInput(newText);
  }, [lastSelectedFolder]);

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
    loadHistoryChunk, handleHistoryScroll,
    sendMessage, handleInputKeyDown,
  };
}
