import React, { useEffect, useMemo, useRef } from "react";
import { Brain, XCircle, Activity, Clock, Trash, ChevronRight } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { cleanLogLine } from "../utils/logUtils";
import type { AgentStatusEvent, ToolExecution } from "../types";

type Props = {
  proc: {
    status: { agent: boolean; gateway: boolean };
    procBusy: { agent: boolean; gateway: boolean };
    logs: { agent: { stream: string; line: string }[]; gateway: { stream: string; line: string }[] };
    toggleProc: (kind: "agent" | "gateway") => void;
    setMonitorActive: (active: boolean) => Promise<void>;
  };
  subagentStatuses: Record<string, AgentStatusEvent>;
  onCancelSubagent: (id: string) => void;
  onRefreshSubagents: () => void;
};

export default function MonitorPanel({ proc, subagentStatuses, onCancelSubagent, onRefreshSubagents }: Props) {
  const agentLogRef = useRef<HTMLDivElement | null>(null);
  const gatewayLogRef = useRef<HTMLDivElement | null>(null);

  const activeSubagents = useMemo(() => {
    return Object.values(subagentStatuses).filter(s => s.status !== "completed" && s.status !== "error");
  }, [subagentStatuses]);

  const completedSubagents = useMemo(() => {
    return Object.values(subagentStatuses).filter(s => s.status === "completed" || s.status === "error");
  }, [subagentStatuses]);

  const handleClearRegistry = async () => {
    try {
      await invoke("clear_subagent_registry");
      onRefreshSubagents();
    } catch (err) {
      console.error("Failed to clear registry", err);
    }
  };

  const agentLogText = useMemo(
    () => proc.logs.agent.map((l) => `[${l.stream}] ${cleanLogLine(l.line)}`).join("\n"),
    [proc.logs.agent],
  );

  const gatewayLogText = useMemo(
    () => proc.logs.gateway.map((l) => `[${l.stream}] ${cleanLogLine(l.line)}`).join("\n"),
    [proc.logs.gateway],
  );

  // Auto-scroll logs
  useEffect(() => {
    const scroll = (ref: React.RefObject<HTMLDivElement>) => {
      const node = ref.current;
      if (node) node.scrollTop = node.scrollHeight;
    };
    requestAnimationFrame(() => {
      scroll(agentLogRef);
      scroll(gatewayLogRef);
    });
  }, [agentLogText, gatewayLogText]);

  // Enable streaming when mounted, disable on unmount
  useEffect(() => {
    proc.setMonitorActive(true).catch((err) => console.warn("log streaming toggle failed", err));
    return () => {
      proc.setMonitorActive(false).catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const renderSubagentCard = (s: AgentStatusEvent) => (
    <div key={s.agent_id} className={`subagent-card animate-fade-in ${s.status}`}>
      <div className="subagent-card-header">
        <div className="subagent-title-info">
          <span className="subagent-id">ID: {s.agent_id.slice(0, 8)}...</span>
          <span className="subagent-time">
            <Clock size={10} />
            {s.last_update ? new Date(s.last_update).toLocaleTimeString() : "--:--"}
          </span>
        </div>
        {s.status !== "completed" && s.status !== "error" && (
          <button 
            className="cancel-btn-small" 
            onClick={() => onCancelSubagent(s.agent_id)}
            title="Stop Subagent"
          >
            <XCircle size={14} />
          </button>
        )}
      </div>
      
      <div className="subagent-card-body">
        <div className={`status-badge ${s.status}`}>{s.status}</div>
        <div className="subagent-msg">{s.message || "Working..."}</div>
        
        {s.tool_history && s.tool_history.length > 0 && (
          <div className="execution-history">
            <div className="history-label">Execution steps:</div>
            <div className="history-steps">
              {s.tool_history.map((tool, idx) => (
                <div key={idx} className="history-step" title={JSON.stringify(tool.args)}>
                  <ChevronRight size={12} className="step-arrow" />
                  <span className="step-name">{tool.name}</span>
                </div>
              ))}
              {s.status === "tool_call" && s.tool_name && !s.tool_history.some(t => t.name === s.tool_name) && (
                <div className="history-step active">
                  <ChevronRight size={12} className="step-arrow" />
                  <span className="step-name">{s.tool_name}</span>
                  <span className="step-pulse" />
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );

  return (
    <div className="content monitor-panel">
      <div className="monitor-grid">
        <div className="card">
          <div className="card-row">
            <div className="status-header">
              <Activity size={18} className="icon-blue" />
              <h3>Agent</h3>
            </div>
            <button
              className={proc.status.agent ? "stop" : ""}
              onClick={() => proc.toggleProc("agent")}
              disabled={proc.procBusy.agent}
            >
              {proc.status.agent ? "Stop" : "Start"}
            </button>
          </div>
        </div>
        <div className="card">
          <div className="card-row">
            <div className="status-header">
              <Activity size={18} className="icon-green" />
              <h3>Gateway</h3>
            </div>
            <button
              className={proc.status.gateway ? "stop" : ""}
              onClick={() => proc.toggleProc("gateway")}
              disabled={proc.procBusy.gateway}
            >
              {proc.status.gateway ? "Stop" : "Start"}
            </button>
          </div>
        </div>
      </div>

      <div className="subagent-monitor-section">
        <div className="section-header">
          <div className="header-left">
            <Brain size={20} className="icon-purple" />
            <h3>Active Subagents ({activeSubagents.length})</h3>
          </div>
          {completedSubagents.length > 0 && (
            <button className="clear-btn-small" onClick={handleClearRegistry} title="Clear Handled">
              <Trash size={14} />
              Clear Hist
            </button>
          )}
        </div>
        <div className="subagent-grid">
          {activeSubagents.length === 0 && completedSubagents.length === 0 ? (
            <div className="empty-subagents">No active subagents</div>
          ) : (
            <>
              {activeSubagents.map(renderSubagentCard)}
              {completedSubagents.map(renderSubagentCard)}
            </>
          )}
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
  );
}
