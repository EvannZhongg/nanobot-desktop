/**
 * Cron jobs panel: list, expand, delete cron jobs.
 * All cron-specific state lives here, not in App.
 */
import React, { useCallback, useEffect, useState } from "react";
import { Clock } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import type { CronData, CronJob } from "../types";
import {
  formatCronSchedule, formatCronNextRun,
  formatCronChannel, formatCronJob,
} from "../utils/cronUtils";

type Props = {
  toast: { success: (m: string) => void; error: (m: string) => void; warning: (m: string) => void };
  proc: {
    status: { gateway: string | boolean };
    restartProc: (kind: "agent" | "gateway") => Promise<void>;
  };
};

export default function CronPanel({ toast, proc }: Props) {
  const [cronData, setCronData] = useState<CronData>({ version: null, jobs: [] });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [deleting, setDeleting] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const loadCronJobs = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await invoke<CronData>("read_cron_jobs");
      const jobs = Array.isArray(data?.jobs) ? data.jobs : [];
      jobs.sort((a, b) => {
        const aNext = a?.state?.nextRunAtMs ?? Number.MAX_SAFE_INTEGER;
        const bNext = b?.state?.nextRunAtMs ?? Number.MAX_SAFE_INTEGER;
        if (aNext !== bNext) return aNext - bNext;
        return (a?.createdAtMs ?? 0) - (b?.createdAtMs ?? 0);
      });
      setCronData({ version: data?.version ?? null, jobs });
    } catch (err) {
      setError(String(err));
      toast.error(`Failed to load cron: ${err}`);
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { loadCronJobs(); }, [loadCronJobs]);

  const toggleExpanded = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }, []);

  const deleteCronJob = useCallback(async (job: CronJob) => {
    const id = job?.id;
    if (!id) { setError("Invalid job id"); return; }
    if (!window.confirm(`Delete cron job "${job?.name || id}"?`)) return;
    setDeleting(id);
    try {
      const removed = await invoke<boolean>("delete_cron_job", { jobId: id });
      if (!removed) { toast.warning("Job not found or already removed."); return; }
      toast.success("Cron job deleted");
      await loadCronJobs();
      if (proc.status.gateway === "Running") await proc.restartProc("gateway");
    } catch (err) {
      setError(String(err));
      toast.error(`Delete failed: ${err}`);
    } finally {
      setDeleting(null);
    }
  }, [loadCronJobs, proc, toast]);

  return (
    <div className="content">
      <div className="card">
        <div className="card-row">
          <h3>Cron Jobs</h3>
          <div style={{ color: "var(--muted)", fontSize: 12 }}>
            Version: {cronData.version ?? "n/a"}
          </div>
        </div>
        {loading ? (
          <div className="skills-empty">Loading...</div>
        ) : error ? (
          <div className="skills-error">{error}</div>
        ) : cronData.jobs.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">
              <Clock size={32} />
            </div>
            <div className="empty-state-text">No jobs configured</div>
            <div className="empty-state-hint">Setup automated tasks and scheduled events in your configuration.</div>
          </div>
        ) : (
          <div className="skills-list cron-list">
            {cronData.jobs.map((job, idx) => {
              const id = job?.id || `job-${idx}`;
              const isExpanded = expanded.has(id);
              return (
                <div className="skill-card cron-item" key={id}>
                  <div className="cron-summary">
                    <div>
                      <div className="cron-title">{job?.name || job?.id || `Job ${idx + 1}`}</div>
                      <div className="cron-meta">
                        {formatCronSchedule(job?.schedule)} · Next: {formatCronNextRun(job?.state)}
                      </div>
                      <div className="cron-meta">
                        {formatCronChannel(job?.payload)} · {job?.enabled ? "enabled" : "disabled"}
                      </div>
                    </div>
                    <div className="cron-actions">
                      <button onClick={() => toggleExpanded(id)} className="cron-btn">
                        {isExpanded ? "Hide" : "Details"}
                      </button>
                      <button
                        onClick={() => deleteCronJob(job)}
                        className="cron-btn danger"
                        disabled={deleting === id}
                      >
                        {deleting === id ? "Deleting..." : "Delete"}
                      </button>
                    </div>
                  </div>
                  {isExpanded && (
                    <div className="cron-details">
                      <pre>{formatCronJob(job)}</pre>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
