/**
 * Single chat message bubble component.
 * Memoized to prevent re-renders when other messages change.
 */
import React, { memo, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { 
  Copy, ChevronDown, ChevronUp, Terminal, 
  Cpu, Beaker, CheckCircle2, AlertCircle,
  Loader2, XCircle
} from "lucide-react";
import type { Message, AgentStatusEvent } from "../types";
import { cleanLogBlock, splitDebugContent } from "../utils/logUtils";

type Props = {
  msg: Message;
  chatFontSize: number;
  isCollapsed: boolean;
  toggleCollapse: (id: string) => void;
  subagentStatuses?: Record<string, AgentStatusEvent>;
  onCancelSubagent?: (agentId: string) => void;
};

const ChatMessageItem = memo(({ msg, chatFontSize, isCollapsed, toggleCollapse, subagentStatuses, onCancelSubagent }: Props) => {
  const parsed = useMemo(
    () => msg.role === "bot" ? splitDebugContent(msg.content) : null,
    [msg.content, msg.role]
  );

  const handleCopy = React.useCallback(() => {
    navigator.clipboard.writeText(msg.content).catch(() => {
      const textArea = document.createElement("textarea");
      textArea.value = msg.content;
      document.body.appendChild(textArea);
      textArea.select();
      try { document.execCommand('copy'); } catch (e) {}
      document.body.removeChild(textArea);
    });
  }, [msg.content]);

  const roleLabel = msg.role === "user" ? "You" : "Assistant";

  return (
    <div className={`message-row ${msg.role === "user" ? "user" : "bot"} ${isCollapsed ? "collapsed" : ""}`}>
      <div className="bubble-wrapper">
        <div className={`bubble ${msg.role === "user" ? "user" : "bot"}`}>
          <div className="bubble-body" style={{ fontSize: `${chatFontSize}px` }}>
            {isCollapsed ? (
              <div className="collapsed-indicator">*(Content Collapsed)*</div>
            ) : (
              <>
                {msg.attachments && msg.attachments.length > 0 && (
                  <div className="message-attachments">
                    {msg.attachments.map((at) => (
                      <div key={at.id} className="message-attachment-item">
                        {at.previewUrl ? (
                          <img src={at.previewUrl} alt={at.name} className="message-attachment-img" />
                        ) : (
                          <div className="message-attachment-file">
                            <span className="file-icon">{at.type.includes("pdf") ? "📄" : "📁"}</span>
                            <span className="file-name">{at.name}</span>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
                {parsed ? (
                  <>
                    {parsed.main ? (
                      <div className="markdown-body">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{parsed.main}</ReactMarkdown>
                      </div>
                    ) : null}
                    
                    <div className="debug-container">
                      {/* Live Subagent Statuses */}
                      {subagentStatuses && Object.entries(subagentStatuses).length > 0 && (
                        <div className="live-status-container">
                          {Object.entries(subagentStatuses).map(([agentId, status]) => {
                            // Only show if not completed or error, OR if it's very recent
                            const isActive = status.status !== "completed" && status.status !== "error";
                            if (!isActive) return null;

                            return (
                              <div key={agentId} className="live-status-item">
                                <div className="status-header">
                                  <div className="status-title">
                                    <Loader2 className="spinner" size={14} />
                                    <span>Subagent: {agentId.slice(0, 8)}</span>
                                  </div>
                                  <button 
                                    className="cancel-btn"
                                    onClick={() => onCancelSubagent?.(agentId)}
                                    title="Cancel task"
                                  >
                                    <XCircle size={14} />
                                  </button>
                                </div>
                                <div className="status-body">
                                  <div className="status-badge">{status.status}</div>
                                  <div className="status-text">{status.message || (status.tool_name ? `Using ${status.tool_name}...` : "Thinking...")}</div>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}

                      {parsed.tools && (
                        <details className="debug-details tool">
                          <summary>
                            <Terminal size={14} />
                            <span>Tools ({parsed.toolCount})</span>
                            <ChevronDown className="chevron" size={14} />
                          </summary>
                          <pre>{cleanLogBlock(parsed.tools)}</pre>
                        </details>
                      )}
                      {parsed.subagents && (
                        <details className="debug-details agent">
                          <summary>
                            <Cpu size={14} />
                            <span>Subagents ({parsed.subagentCount})</span>
                            <ChevronDown className="chevron" size={14} />
                          </summary>
                          <pre>{cleanLogBlock(parsed.subagents)}</pre>
                        </details>
                      )}
                      {parsed.debug && (
                        <details className="debug-details log">
                          <summary>
                            <Beaker size={14} />
                            <span>Debug Logs ({parsed.debugCount})</span>
                            <ChevronDown className="chevron" size={14} />
                          </summary>
                          <pre>{cleanLogBlock(parsed.debug)}</pre>
                        </details>
                      )}
                    </div>
                  </>
                ) : (
                  <div className="plain-text-body">{msg.content}</div>
                )}
              </>
            )}
          </div>
        </div>

        <div className="bubble-footer">
          <div className="meta-left">
            <span className="role-badge">{roleLabel}</span>
            <span className="time-stamp">{msg.createdAt}</span>
          </div>
          <div className="meta-actions">
            <button className="bubble-action-btn" onClick={() => toggleCollapse(msg.id)} title={isCollapsed ? "Expand" : "Collapse"}>
              {isCollapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
            </button>
            <button className="bubble-action-btn" onClick={handleCopy} title="Copy message">
              <Copy size={14} />
            </button>
          </div>
        </div>
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
