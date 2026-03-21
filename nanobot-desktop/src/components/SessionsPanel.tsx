/**
 * Sessions panel: browse, search, delete session messages.
 * All session-viewer state lives here.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Message, SessionInfo, SessionMessagePayload } from "../types";
import { HISTORY_BATCH } from "../utils/helpers";

type Props = {
  sessions: SessionInfo[];
  loadSessions: () => Promise<void>;
  sessionsLoading: boolean;
  toast: { success: (m: string) => void; error: (m: string) => void };
};

const mapSessionMessage = (msg: SessionMessagePayload, idx: number): Message => ({
  id: `sess-${msg.id}-${msg.line ?? idx}`,
  role:
    msg.role === "assistant" || msg.role === "bot"
      ? "bot"
      : msg.role === "user"
        ? "user"
        : "system",
  content: msg.content,
  createdAt: msg.createdAt || "(unknown)",
  line: msg.line ?? idx,
});

export default function SessionsPanel({ sessions, loadSessions, sessionsLoading, toast }: Props) {
  const [selectedSession, setSelectedSession] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [end, setEnd] = useState(false);
  const [selectedLines, setSelectedLines] = useState<Set<number>>(new Set());
  const [error, setError] = useState("");
  const searchTimerRef = useRef<number | null>(null);

  // Auto-select first session
  useEffect(() => {
    if (!selectedSession && sessions.length > 0) {
      selectSession(sessions[0].name);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions]);

  const loadMessages = useCallback(
    async (name: string, reset = false) => {
      if (loading || (!reset && end)) return;
      setLoading(true);
      setError("");
      try {
        const data = await invoke<SessionMessagePayload[]>("read_session_messages", {
          name,
          limit: HISTORY_BATCH,
          offset: reset ? 0 : offset,
          query: query.trim() || null,
        });
        const mapped = data.map((msg, idx) =>
          mapSessionMessage(msg, idx + (reset ? 0 : offset)),
        );
        if (reset) {
          setMessages(mapped);
          setOffset(mapped.length);
          setSelectedLines(new Set());
        } else {
          setMessages((prev) => [...prev, ...mapped]);
          setOffset((prev) => prev + mapped.length);
        }
        if (data.length < HISTORY_BATCH) setEnd(true);
        else if (reset) setEnd(false);
      } catch (err) {
        setError(String(err));
      } finally {
        setLoading(false);
      }
    },
    [loading, end, offset, query],
  );

  const selectSession = useCallback(
    (name: string) => {
      setSelectedSession(name);
      setOffset(0);
      setEnd(false);
      setMessages([]);
      setSelectedLines(new Set());
      // Need to reset state before loading — use setTimeout to ensure state is flushed
      setTimeout(() => {
        invoke<SessionMessagePayload[]>("read_session_messages", {
          name,
          limit: HISTORY_BATCH,
          offset: 0,
          query: query.trim() || null,
        })
          .then((data) => {
            const mapped = data.map((msg, idx) => mapSessionMessage(msg, idx));
            setMessages(mapped);
            setOffset(mapped.length);
            if (data.length < HISTORY_BATCH) setEnd(true);
          })
          .catch((err) => setError(String(err)));
      }, 0);
    },
    [query],
  );

  const toggleSelectLine = useCallback((line: number) => {
    setSelectedLines((prev) => {
      const next = new Set(prev);
      next.has(line) ? next.delete(line) : next.add(line);
      return next;
    });
  }, []);

  const deleteSelectedLines = useCallback(async () => {
    if (!selectedSession || selectedLines.size === 0) return;
    if (!window.confirm(`Delete ${selectedLines.size} selected message(s)?`)) return;
    try {
      const lines = Array.from(selectedLines).sort((a, b) => a - b);
      await invoke("delete_session_lines", { name: selectedSession, lines });
      setSelectedLines(new Set());
      setOffset(0);
      setEnd(false);
      toast.success(`Deleted ${lines.length} messages`);
      selectSession(selectedSession);
    } catch (err) {
      setError(String(err));
      toast.error(`Delete failed: ${err}`);
    }
  }, [selectedSession, selectedLines, selectSession, toast]);

  const handleSearchChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const val = e.target.value;
      setQuery(val);
      if (searchTimerRef.current) window.clearTimeout(searchTimerRef.current);
      searchTimerRef.current = window.setTimeout(() => {
        setOffset(0);
        setEnd(false);
        if (selectedSession) selectSession(selectedSession);
      }, 300);
    },
    [selectedSession, selectSession],
  );

  return (
    <div className="content">
      <div className="skills-layout sessions-layout">
        <div className="skills-list">
          <div className="skills-header">
            <div>Sessions: {sessions.length}</div>
            <button onClick={loadSessions} disabled={sessionsLoading}>
              {sessionsLoading ? "Refreshing..." : "Refresh"}
            </button>
          </div>
          {error && <div className="skills-error">{error}</div>}
          {sessions.length === 0 && !sessionsLoading && (
            <div className="empty-state">
              <div className="empty-state-icon">📋</div>
              <div className="empty-state-text">No sessions found</div>
            </div>
          )}
          {sessions.map((s) => (
            <div
              key={s.name}
              className={`skill-card clickable ${selectedSession === s.name ? "active" : ""}`}
              onClick={() => selectSession(s.name)}
            >
              <div className="skill-top">
                <div className="skill-title session-title">{s.name}</div>
                {s.modified ? (
                  <div className="skill-meta">
                    {new Date((s.modified || 0) * 1000).toLocaleString()}
                  </div>
                ) : null}
              </div>
              {s.size ? <div className="skill-meta">{(s.size / 1024).toFixed(1)} KB</div> : null}
              <div className="skill-path session-path">{s.path}</div>
            </div>
          ))}
        </div>

        <div className="skill-editor">
          <div className="editor-header">
            <div className="editor-title">
              <span>Session:</span>
              <span className="session-name">{selectedSession || "Select a session"}</span>
            </div>
            <div className="editor-actions" style={{ gap: 8 }}>
              <input
                type="text"
                placeholder="Search text..."
                value={query}
                onChange={handleSearchChange}
                style={{ width: 180 }}
                aria-label="Search session messages"
              />
              <button
                onClick={() => selectedSession && selectSession(selectedSession)}
                disabled={loading || !selectedSession}
              >
                {loading ? "Loading..." : "Reload"}
              </button>
              <button
                className="danger"
                onClick={deleteSelectedLines}
                disabled={loading || !selectedSession || selectedLines.size === 0}
              >
                Delete selected ({selectedLines.size})
              </button>
            </div>
          </div>

          <div className="chat-list" style={{ paddingRight: 6, gap: 10 }}>
            {messages.length === 0 && (
              <div className="skills-empty">{loading ? "Loading..." : "No messages yet."}</div>
            )}
            {messages.map((msg, idx) => (
              <div key={msg.id} className={`message-row ${msg.role === "user" ? "user" : "bot"}`}>
                <div className={`bubble ${msg.role === "user" ? "user" : "bot"}`}>
                  <div className="bubble-body">
                    <div style={{ whiteSpace: "pre-wrap" }}>{msg.content}</div>
                  </div>
                  <div className="bubble-meta session-bubble-meta">
                    <label className="session-select-label">
                      <input
                        type="checkbox"
                        checked={selectedLines.has((msg as any).line ?? idx)}
                        onChange={() => toggleSelectLine((msg as any).line ?? idx)}
                      />
                      <span>Select</span>
                    </label>
                    <span>
                      {msg.role} · {msg.createdAt}
                    </span>
                  </div>
                </div>
              </div>
            ))}
            {!end && selectedSession && messages.length > 0 && (
              <button
                className="load-more-btn"
                onClick={() => loadMessages(selectedSession, false)}
                disabled={loading}
              >
                {loading ? "Loading..." : "Load more"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
