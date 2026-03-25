/**
 * Custom hook for Agent/Gateway process management.
 * Handles start/stop/restart/toggle and status polling.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Status, LogEvent, LogState, ConfigFilePayload } from "../types";

export function useProcesses() {
  const [status, setStatus] = useState<Status>({ agent: false, gateway: false });
  const [procBusy, setProcBusy] = useState({ agent: false, gateway: false });
  const [logs, setLogs] = useState<LogState>({ agent: [], gateway: [] });
  const [configMissing, setConfigMissing] = useState(false);
  const [configMissingPath, setConfigMissingPath] = useState("");
  const [isBackendReachable, setIsBackendReachable] = useState(true);

  const pendingLogsRef = useRef<LogState>({ agent: [], gateway: [] });
  const logFlushTimerRef = useRef<number | null>(null);
  const monitorActiveRef = useRef(false);
  const statusFailCountRef = useRef(0);

  const refreshStatus = useCallback(async () => {
    try {
      const next = await invoke<Status>("get_status");
      setStatus(next);
      statusFailCountRef.current = 0;
      setIsBackendReachable(true);
    } catch (err) {
      statusFailCountRef.current += 1;
      // Mark unreachable after 3 consecutive failures
      if (statusFailCountRef.current >= 3) {
        setIsBackendReachable(false);
      }
      console.warn("refreshStatus failed", err);
    }
  }, []);

  const flushPendingLogs = useCallback(() => {
    const pending = pendingLogsRef.current;
    if (pending.agent.length === 0 && pending.gateway.length === 0) {
      logFlushTimerRef.current = null;
      return;
    }
    setLogs((prev) => {
      const mergeWithCap = (existing: LogEvent[], incoming: LogEvent[], cap: number) => {
        if (incoming.length >= cap) return incoming.slice(-cap);
        const total = existing.length + incoming.length;
        if (total <= cap) return [...existing, ...incoming];
        return [...existing.slice(-(cap - incoming.length)), ...incoming];
      };
      return {
        agent: mergeWithCap(prev.agent, pending.agent, 2000),
        gateway: mergeWithCap(prev.gateway, pending.gateway, 2000)
      };
    });
    pendingLogsRef.current = { agent: [], gateway: [] };
    logFlushTimerRef.current = null;
  }, []);

  const scheduleLogFlush = useCallback(() => {
    if (logFlushTimerRef.current !== null) return;
    logFlushTimerRef.current = window.setTimeout(flushPendingLogs, 200);
  }, [flushPendingLogs]);

  const loadInitialLogs = useCallback(async () => {
    const initial = await invoke<LogEvent[]>("get_logs");
    setLogs({
      agent: initial.filter((l) => l.kind === "agent").slice(-2000),
      gateway: initial.filter((l) => l.kind === "gateway").slice(-2000)
    });
  }, []);

  // Event listeners and status polling
  useEffect(() => {
    let unlistenLog: (() => void) | null = null;
    let unlistenExit: (() => void) | null = null;
    let unlistenConfig: (() => void) | null = null;
    let statusTimer: number | null = null;

    const setup = async () => {
      unlistenLog = await listen<LogEvent>("process-log", (event) => {
        if (!monitorActiveRef.current) return;
        const pending = pendingLogsRef.current;
        if (event.payload.kind === "agent") {
          pending.agent.push(event.payload);
          if (pending.agent.length > 5000) {
            pending.agent.splice(0, pending.agent.length - 5000);
          }
        } else {
          pending.gateway.push(event.payload);
          if (pending.gateway.length > 5000) {
            pending.gateway.splice(0, pending.gateway.length - 5000);
          }
        }
        scheduleLogFlush();
      });

      unlistenExit = await listen<{ kind: string }>("process-exit", () => {
        refreshStatus();
      });

      unlistenConfig = await listen<ConfigFilePayload>("config-missing", (event) => {
        setConfigMissing(true);
        setConfigMissingPath(event.payload.path);
      });
    };

    setup();
    refreshStatus();
    checkConfigMissing();
    statusTimer = window.setInterval(refreshStatus, 3000);

    const handleVisibility = () => {
      if (document.hidden) {
        if (statusTimer) { window.clearInterval(statusTimer); statusTimer = null; }
      } else {
        refreshStatus();
        if (!statusTimer) statusTimer = window.setInterval(refreshStatus, 3000);
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      if (unlistenLog) unlistenLog();
      if (unlistenExit) unlistenExit();
      if (unlistenConfig) unlistenConfig();
      if (logFlushTimerRef.current !== null) {
        window.clearTimeout(logFlushTimerRef.current);
        logFlushTimerRef.current = null;
      }
      if (statusTimer) window.clearInterval(statusTimer);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const checkConfigMissing = async () => {
    try {
      const payload = await invoke<ConfigFilePayload>("read_config_file");
      setConfigMissing(!payload.exists);
      setConfigMissingPath(payload.path);
    } catch {
      // ignore
    }
  };

  const startProc = useCallback(async (kind: "agent" | "gateway") => {
    try {
      await invoke("start_process", { kind });
    } catch (err) {
      console.error(`Failed to start ${kind}`, err);
    }
    refreshStatus();
  }, [refreshStatus]);

  const stopProc = useCallback(async (kind: "agent" | "gateway") => {
    try {
      await invoke("stop_process", { kind });
    } catch (err) {
      console.error(`Failed to stop ${kind}`, err);
    }
    refreshStatus();
  }, [refreshStatus]);

  const restartProc = useCallback(async (kind: "agent" | "gateway") => {
    if (procBusy[kind]) return;
    setProcBusy((prev) => ({ ...prev, [kind]: true }));
    try {
      await invoke("stop_process", { kind });
      await new Promise((resolve) => setTimeout(resolve, 200));
      await invoke("start_process", { kind });
    } finally {
      setProcBusy((prev) => ({ ...prev, [kind]: false }));
      refreshStatus();
    }
  }, [procBusy, refreshStatus]);

  const toggleProc = useCallback(async (kind: "agent" | "gateway") => {
    if (procBusy[kind]) return;
    setProcBusy((prev) => ({ ...prev, [kind]: true }));
    try {
      if (status[kind]) {
        await stopProc(kind);
      } else {
        await startProc(kind);
      }
    } finally {
      setProcBusy((prev) => ({ ...prev, [kind]: false }));
    }
  }, [procBusy, status, startProc, stopProc]);

  const startAllProcs = useCallback(async () => {
    try {
      await invoke("start_process", { kind: "gateway" });
      await invoke("start_process", { kind: "agent" });
    } catch (err) {
      console.error("Failed to start all processes", err);
    } finally {
      refreshStatus();
    }
  }, [refreshStatus]);

  const setMonitorActive = useCallback(async (active: boolean) => {
    if (active) {
      monitorActiveRef.current = true;
      pendingLogsRef.current = { agent: [], gateway: [] };
      if (logFlushTimerRef.current !== null) {
        window.clearTimeout(logFlushTimerRef.current);
        logFlushTimerRef.current = null;
      }
      setLogs({ agent: [], gateway: [] });
      await invoke("set_log_streaming", { enabled: true });
      await loadInitialLogs();
      flushPendingLogs();
    } else {
      monitorActiveRef.current = false;
      await invoke("set_log_streaming", { enabled: false });
    }
  }, [loadInitialLogs, flushPendingLogs]);

  return {
    status, procBusy, logs,
    configMissing, setConfigMissing,
    configMissingPath, setConfigMissingPath,
    isBackendReachable,
    refreshStatus,
    startProc, stopProc, restartProc, toggleProc, startAllProcs,
    setMonitorActive,
  };
}
