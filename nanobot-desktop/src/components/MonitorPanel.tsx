/**
 * Monitor panel: Agent / Gateway process control + log display.
 * Extracted from App.tsx to reduce main bundle re-renders.
 */
import React, { useEffect, useMemo, useRef } from "react";
import { cleanLogLine } from "../utils/logUtils";

type Props = {
  proc: {
    status: { agent: boolean; gateway: boolean };
    procBusy: { agent: boolean; gateway: boolean };
    logs: { agent: { stream: string; line: string }[]; gateway: { stream: string; line: string }[] };
    toggleProc: (kind: "agent" | "gateway") => void;
    setMonitorActive: (active: boolean) => Promise<void>;
  };
};

export default function MonitorPanel({ proc }: Props) {
  const agentLogRef = useRef<HTMLDivElement | null>(null);
  const gatewayLogRef = useRef<HTMLDivElement | null>(null);

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

  return (
    <div className="content">
      <div className="monitor-grid">
        <div className="card">
          <div className="card-row">
            <h3>Agent</h3>
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
            <h3>Gateway</h3>
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
