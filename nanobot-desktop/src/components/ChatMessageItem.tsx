import React, { memo, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { 
  Copy, ChevronDown, ChevronUp, Terminal, 
  Cpu, Beaker, CheckCircle2, AlertCircle,
  FileText, Image as ImageIcon, EyeOff, Loader2, XCircle
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

const BotAvatar = () => (
  <div className="avatar bot-avatar">
    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M12 2C6.47715 2 2 6.47715 2 12C2 17.5228 6.47715 22 12 22C17.5228 22 22 17.5228 22 12C22 6.47715 17.5228 2 12 2Z" fill="url(#bot-grad)" />
      <path d="M12 18V12M12 12V6M12 12H18M12 12H6" stroke="white" strokeWidth="2" strokeLinecap="round" />
      <defs>
        <linearGradient id="bot-grad" x1="2" y1="2" x2="22" y2="22" gradientUnits="userSpaceOnUse">
          <stop stopColor="#6366f1" />
          <stop offset="1" stopColor="#a855f7" />
        </linearGradient>
      </defs>
    </svg>
  </div>
);

const UserAvatar = () => (
  <div className="avatar user-avatar">
    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="12" cy="12" r="10" fill="rgba(255, 255, 255, 0.1)" stroke="rgba(255, 255, 255, 0.2)" strokeWidth="1" />
      <path d="M12 14C14.2091 14 16 12.2091 16 10C16 7.79086 14.2091 6 12 6C9.79086 6 8 7.79086 8 10C8 12.2091 9.79086 14 12 14Z" fill="white" fillOpacity="0.8" />
      <path d="M18 19C18 16.2386 15.3137 14 12 14C8.68629 14 6 16.2386 6 19" stroke="white" strokeWidth="2" strokeLinecap="round" />
    </svg>
  </div>
);

const ChatMessageItem = memo(({ 
  msg, 
  chatFontSize, 
  isCollapsed, 
  toggleCollapse, 
  subagentStatuses, 
  onCancelSubagent 
}: Props) => {
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
      <div className="message-avatar-container">
        {msg.role === "bot" ? <BotAvatar /> : <UserAvatar />}
      </div>
      <div className="bubble-wrapper">
        <div className={`bubble ${msg.role === "user" ? "user" : "bot"}`}>
          <div className="bubble-body" style={{ fontSize: `${chatFontSize}px` }}>
            {isCollapsed ? (
              <div className="collapsed-indicator">
                <EyeOff size={14} />
                <span>Content Collapsed</span>
              </div>
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
                            <span className="file-icon">
                              {at.type.includes("image") ? <ImageIcon size={18} /> : <FileText size={18} />}
                            </span>
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
                        <ReactMarkdown 
                          remarkPlugins={[remarkGfm]}
                          components={{
                            code({ node, inline, className, children, ...props }: any) {
                              const match = /language-(\w+)/.exec(className || "");
                              return !inline ? (
                                <div className="code-block-wrapper">
                                  <div className="code-block-header">
                                    <span className="code-lang">{match ? match[1] : "text"}</span>
                                    <button 
                                      className="code-copy-btn"
                                      onClick={() => {
                                        navigator.clipboard.writeText(String(children).replace(/\n$/, ""));
                                      }}
                                    >
                                      <Copy size={12} />
                                    </button>
                                  </div>
                                  <pre className={className} {...props}>
                                    <code>{children}</code>
                                  </pre>
                                </div>
                              ) : (
                                <code className={className} {...props}>
                                  {children}
                                </code>
                              );
                            }
                          }}
                        >
                          {parsed.main}
                        </ReactMarkdown>
                      </div>
                    ) : null}
                    
                    <div className="debug-container">
                      {/* Live Subagent Statuses */}
                      {subagentStatuses && Object.entries(subagentStatuses).length > 0 && (
                        <div className="live-status-container">
                          {Object.entries(subagentStatuses).map(([agentId, status]) => {
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
    prev.toggleCollapse === next.toggleCollapse &&
    prev.subagentStatuses === next.subagentStatuses &&
    prev.onCancelSubagent === next.onCancelSubagent
  );
});

export default ChatMessageItem;
