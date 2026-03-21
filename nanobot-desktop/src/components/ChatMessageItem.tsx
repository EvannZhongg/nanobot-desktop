/**
 * Single chat message bubble component.
 * Memoized to prevent re-renders when other messages change.
 */
import React, { memo, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Message } from "../types";
import { cleanLogBlock, splitDebugContent } from "../utils/logUtils";

type Props = {
  msg: Message;
  chatFontSize: number;
  isCollapsed: boolean;
  toggleCollapse: (id: string) => void;
};

const ChatMessageItem = memo(({ msg, chatFontSize, isCollapsed, toggleCollapse }: Props) => {
  const parsed = useMemo(
    () => msg.role === "bot" ? splitDebugContent(msg.content) : null,
    [msg.content, msg.role]
  );

  const handleCopy = React.useCallback(() => {
    navigator.clipboard.writeText(msg.content).catch(() => {
      // fallback: select and copy (can be implemented via temp textarea)
      const textArea = document.createElement("textarea");
      textArea.value = msg.content;
      document.body.appendChild(textArea);
      textArea.select();
      try { document.execCommand('copy'); } catch (e) {}
      document.body.removeChild(textArea);
    });
  }, [msg.content]);

  return (
    <div className={`message-row ${msg.role === "user" ? "user" : "bot"}`}>
      <div className={`bubble ${msg.role === "user" ? "user" : "bot"}`}>
        <div className="bubble-body" style={{ fontSize: `${chatFontSize}px` }}>
          {isCollapsed ? (
            <div className="collapsed-indicator">*(Content Collapsed)*</div>
          ) : parsed ? (
            <>
              {parsed.main ? (
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{parsed.main}</ReactMarkdown>
              ) : null}
              {parsed.tools ? (
                <details className="debug-details">
                  <summary>调用工具（{parsed.toolCount}）</summary>
                  <pre>{cleanLogBlock(parsed.tools)}</pre>
                </details>
              ) : null}
              {parsed.subagents ? (
                <details className="debug-details">
                  <summary>子代理（{parsed.subagentCount}）</summary>
                  <pre>{cleanLogBlock(parsed.subagents)}</pre>
                </details>
              ) : null}
              {parsed.debug ? (
                <details className="debug-details">
                  <summary>调试日志（{parsed.debugCount}）</summary>
                  <pre>{cleanLogBlock(parsed.debug)}</pre>
                </details>
              ) : null}
            </>
          ) : (
            <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{msg.content}</div>
          )}
        </div>
      </div>
      <div className="bubble-meta">
        {msg.role} · {msg.createdAt}
        <button className="collapse-btn" onClick={() => toggleCollapse(msg.id)} aria-expanded={!isCollapsed} aria-label={isCollapsed ? "Expand message" : "Collapse message"}>
          {isCollapsed ? "展开 (Expand)" : "收起 (Collapse)"}
        </button>
        <button className="copy-btn" onClick={handleCopy} title="Copy message" aria-label="Copy message content">
          📋
        </button>
      </div>
    </div>
  );
}, (prev, next) => {
  return (
    prev.msg.content === next.msg.content &&
    prev.msg.id === next.msg.id &&
    prev.chatFontSize === next.chatFontSize &&
    prev.isCollapsed === next.isCollapsed &&
    prev.toggleCollapse === next.toggleCollapse
  );
});

export default ChatMessageItem;
