/**
 * Utility functions for formatting cron job data.
 */

export const formatCronValue = (value: any) => {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

export const formatCronSchedule = (schedule: any) => {
  if (!schedule || typeof schedule !== "object") return "unknown";
  if (schedule.kind === "every") {
    const everyMs = Number(schedule.everyMs || 0);
    if (!everyMs) return "every ?ms";
    if (everyMs % 3600000 === 0) return `every ${everyMs / 3600000}h`;
    if (everyMs % 60000 === 0) return `every ${everyMs / 60000}m`;
    if (everyMs % 1000 === 0) return `every ${everyMs / 1000}s`;
    return `every ${everyMs}ms`;
  }
  if (schedule.kind === "at") {
    const atMs = Number(schedule.atMs || 0);
    return atMs ? `at ${new Date(atMs).toLocaleString()}` : "at (unspecified)";
  }
  if (schedule.kind === "cron") {
    return schedule.expr ? `cron ${schedule.expr}` : "cron (empty)";
  }
  return "unknown";
};

export const formatCronNextRun = (state: any) => {
  const next = state?.nextRunAtMs;
  if (!next) return "n/a";
  return new Date(next).toLocaleString();
};

export const formatCronChannel = (payload: any) => {
  if (!payload?.deliver) return "local";
  const channel = payload.channel || "unknown";
  const to = payload.to ? ` → ${payload.to}` : "";
  return `${channel}${to}`;
};

export const formatCronJob = (value: any) => {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};
