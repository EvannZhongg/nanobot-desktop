import React, { useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { X, Copy, Maximize2 } from "lucide-react";
import ErrorBoundary from "./ErrorBoundary";

type Props = {
  content: string | null;
  isOpen: boolean;
  onClose: () => void;
  width: number;
  onResize: (width: number) => void;
  messages: any[];
  currentMessageId: string | null;
  onSelectMessage: (id: string) => void;
  title?: string;
};

const SidePanel: React.FC<Props> = React.memo(({ 
  content, isOpen, onClose, width, onResize, 
  messages, currentMessageId, onSelectMessage,
  title = "Execution List" 
}) => {
  if (!isOpen || !content) return null;

  // Round 31: Find other execution lists in session
  const otherLists = useMemo(() => {
    return messages.filter(m => {
      if (m.role !== "bot" || !m.content) return false;
      const hasExec = /^#+\s+(?:Task|Implementation Plan|执行清单|任务清单|方案|Workflow)/im.test(m.content) || 
                      (m.content.match(/^[ \t]*[-*+]\s+\[[ x/]\]/gm) || []).length >= 3;
      return hasExec;
    });
  }, [messages]);

  // Round 32: Progress Calculation
  const progress = useMemo(() => {
    const total = (content.match(/\[[ x/]\]/g) || []).length;
    if (total === 0) return 0;
    const completed = (content.match(/\[[x]\]/g) || []).length;
    return Math.round((completed / total) * 100);
  }, [content]);

  const handleCopy = () => {
    navigator.clipboard.writeText(content).catch(() => {});
  };

  const [isResizing, setIsResizing] = React.useState(false);

  const startResizing = React.useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
  }, []);

  React.useEffect(() => {
    if (!isResizing) return;

    const doResize = (e: MouseEvent) => {
      // Calculate new width: window.innerWidth - mouseX
      const newWidth = window.innerWidth - e.clientX;
      if (newWidth > 320 && newWidth < window.innerWidth * 0.8) {
        onResize(newWidth);
      }
    };

    const stopResizing = () => setIsResizing(false);

    window.addEventListener("mousemove", doResize);
    window.addEventListener("mouseup", stopResizing);
    return () => {
      window.removeEventListener("mousemove", doResize);
      window.removeEventListener("mouseup", stopResizing);
    };
  }, [isResizing, onResize]);

  // Round 33: Auto-scroll synchronization
  const bodyRef = React.useRef<HTMLDivElement>(null);
  const autoScrollRef = React.useRef(true);

  React.useEffect(() => {
    if (!autoScrollRef.current || !bodyRef.current) return;
    bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [content]);

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const isAtBottom = el.scrollHeight - el.scrollTop <= el.clientHeight + 60;
    autoScrollRef.current = isAtBottom;
  };

  // Round 38: Scroll to source message in chat
  const scrollToSource = React.useCallback(() => {
    if (!currentMessageId) return;
    const el = document.getElementById(`msg-${currentMessageId}`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.add("highlight-pulse");
      setTimeout(() => el.classList.remove("highlight-pulse"), 2000);
    }
  }, [currentMessageId]);

  // Round 44: Edge case guard
  const safeContent = content || "";
  if (!safeContent.trim()) return null;

  return (
    <div 
      className={`side-document-panel ${isResizing ? 'resizing' : ''}`}
      style={{ width: `${width}px` }}
      role="complementary"
      aria-label={title}
    >
      <div 
        className="side-panel-resizer" 
        onMouseDown={startResizing}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize panel"
      />
      
      <div className="side-panel-header" role="toolbar" aria-label="Panel actions">
        <div className="side-panel-title">
          <span className="title-icon" onClick={scrollToSource} style={{ cursor: 'pointer' }} title="Scroll to source message">📜</span>
          <div className="title-stack">
            <h3 onClick={scrollToSource} style={{ cursor: 'pointer' }}>{title}</h3>
            {progress > 0 && (
              <div className="progress-container">
                <div className="progress-bar-bg">
                  <div className="progress-bar-fill" style={{ width: `${progress}%` }} />
                </div>
                <span className="progress-text">{progress}%</span>
              </div>
            )}
          </div>
        </div>
        <div className="side-panel-actions">
          {otherLists.length > 1 && (
            <div className="list-nav-wrapper">
              <select 
                className="list-nav-select"
                value={currentMessageId || ""}
                onChange={(e) => onSelectMessage(e.target.value)}
              >
                {otherLists.map((m, idx) => {
                  const titleMatch = m.content.match(/^#+\s+(.*)/m);
                  const label = titleMatch ? titleMatch[1].slice(0, 25) : m.content.slice(0, 20);
                  return (
                    <option key={m.id} value={m.id}>
                      {idx + 1}. {label}
                    </option>
                  );
                })}
              </select>
            </div>
          )}
          <button onClick={handleCopy} className="panel-action-btn" title="Copy Content">
            <Copy size={16} />
          </button>
          <button 
            onClick={() => {
              const blob = new Blob([content || ""], { type: "text/markdown" });
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = url;
              a.download = `execution_list_${new Date().getTime()}.md`;
              a.click();
              URL.revokeObjectURL(url);
            }} 
            className="panel-action-btn" 
            title="Export as Markdown"
          >
            <Maximize2 size={16} />
          </button>
          <button onClick={onClose} className="panel-action-btn close" title="Close Panel">
            <X size={18} />
          </button>
        </div>
      </div>
      <div className="side-panel-body" ref={bodyRef} onScroll={handleScroll} role="document" aria-live="polite">
        <ErrorBoundary fallbackMessage="Failed to render execution list content">
          <div className="markdown-body">
            <ReactMarkdown 
              remarkPlugins={[remarkGfm]}
              components={{
                // Round 39: Collapsible Sections
                h2({ children, ...props }: any) {
                  return <details className="collapsible-section" open><summary className="collapsible-heading h2-heading">{children}</summary></details>;
                },
                h3({ children, ...props }: any) {
                  return <details className="collapsible-section"><summary className="collapsible-heading h3-heading">{children}</summary></details>;
                },
                code({ node, inline, className, children, ...props }: any) {
                  const match = /language-(\w+)/.exec(className || "");
                  const codeStr = String(children).replace(/\n$/, "");
                  
                  // Round 37: Run Action
                  const handleRun = () => {
                    // Logic to send to terminal/execution engine
                    // For now, we use a custom event or callback
                    window.dispatchEvent(new CustomEvent("nanobot-run-code", { detail: { code: codeStr } }));
                  };

                  return !inline ? (
                    <div className="code-block-wrapper">
                      <div className="code-block-header">
                        <span className="code-lang">{match ? match[1] : "text"}</span>
                        {(match?.[1] === "bash" || match?.[1] === "sh" || match?.[1] === "zsh") && (
                          <button onClick={handleRun} className="code-run-btn" title="Run in Terminal">
                            ▶️ Run
                          </button>
                        )}
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
              {safeContent}
            </ReactMarkdown>
          </div>
        </ErrorBoundary>
      </div>
    </div>
  );
});

export default SidePanel;
