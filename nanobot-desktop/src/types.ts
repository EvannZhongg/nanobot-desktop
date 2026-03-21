/**
 * Shared type definitions for Nanobot Desktop.
 */

export type TabKey = "chat" | "monitor" | "cron" | "sessions" | "skills" | "memory" | "models" | "settings";

export type Attachment = {
  id: string;
  path: string;
  name: string;
  type: string;
  previewUrl?: string;
};

export type Message = {
  id: string;
  role: "user" | "bot" | "system";
  content: string;
  createdAt: string;
  line?: number;
  attachments?: Attachment[];
};

export type LogEvent = {
  kind: "agent" | "gateway";
  line: string;
  stream: "stdout" | "stderr";
};

export type LogState = {
  agent: LogEvent[];
  gateway: LogEvent[];
};

export type Status = {
  agent: boolean;
  gateway: boolean;
  router?: boolean;
  subagents?: boolean;
};

export type SkillItem = {
  name: string;
  path: string;
  hasSkillMd: boolean;
  modified?: number;
};

export type SkillFile = {
  name: string;
  path: string;
  content: string;
  exists: boolean;
};

export type MemoryFileInfo = {
  name: string;
  path: string;
  modified?: number;
};

export type MemoryFilePayload = {
  name: string;
  path: string;
  content: string;
  exists: boolean;
};

export type ConfigFilePayload = {
  path: string;
  content: string;
  exists: boolean;
};

export type CronSchedule = {
  kind: "every" | "at" | "cron";
  everyMs?: number;
  atMs?: number;
  expr?: string;
};

export type CronJobState = {
  nextRunAtMs?: number;
  lastRunAtMs?: number;
};

export type CronJobPayload = {
  deliver?: boolean;
  channel?: string;
  to?: string;
  message?: string;
};

export type CronJob = {
  id: string;
  name?: string;
  enabled?: boolean;
  schedule?: CronSchedule;
  state?: CronJobState;
  payload?: CronJobPayload;
  createdAtMs?: number;
};

export type CronData = {
  version: number | null;
  jobs: CronJob[];
};

export type SessionMessagePayload = {
  id: string;
  role: string;
  content: string;
  createdAt: string;
  line?: number;
};

export type SessionInfo = {
  name: string;
  path: string;
  size?: number;
  modified?: number;
};

export type ToolExecution = {
  name: string;
  args: any;
  timestamp: number;
};

export type AgentStatusEvent = {
  agentId: string;
  chatId: string;
  status: "thinking" | "tool_call" | "progress" | "completed" | "error";
  message?: string;
  toolName?: string;
  toolArgs?: any;
  toolHistory?: ToolExecution[];
  startTime?: number;
  lastUpdate?: number;
  timestamp?: string;
  metadata?: Record<string, any>;
};
