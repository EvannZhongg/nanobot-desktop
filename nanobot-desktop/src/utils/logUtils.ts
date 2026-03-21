/**
 * Log line parsing and cleaning utilities.
 */

const LOG_LINE_RE =
  /(^\s*(DEBUG|INFO|WARN|WARNING|ERROR):)|(\|\s*(DEBUG|INFO|WARN|WARNING|ERROR)\s*\|)|(\bnanobot\.)/;
const TRACE_START_RE = /(Traceback|Exception ignored in:|ResourceWarning|ValueError)/;
const TRACE_CONT_RE = /^(\s+|File\s+".*?",\s+line\s+\d+|^\^+)/;
const LOG_MARKERS = [
  /\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}/,
  /\b(INFO|DEBUG|WARN(?:ING)?|ERROR)\b/,
  /\bnanobot\./,
  /Executing tool:/,
  /Spawned subagent/,
  /Subagent/
];
const TOOL_RE = /Executing tool:/;
const SUBAGENT_RE = /(Spawned subagent|Subagent \[|Subagent .*starting task)/;
const ANSI_RE = /\x1b\[[0-9;]*m/g;
const ANSI_ARTIFACT_RE = /\b\d{1,3}m(?=(\d{4}-\d{2}-\d{2}|\s*\||[A-Za-z]))/g;

/**
 * Strip ANSI escape codes and log-related artifacts from a single log line.
 */
export const cleanLogLine = (line: string) => {
  let cleaned = line.replace(ANSI_RE, "");
  const looksLikeLog =
    LOG_LINE_RE.test(cleaned) || cleaned.includes("|") || cleaned.includes("nanobot.");
  if (looksLikeLog) {
    cleaned = cleaned.replace(ANSI_ARTIFACT_RE, "");
  }
  return cleaned.trimEnd();
};

/**
 * Clean an entire block of log text (split/join lines).
 */
export const cleanLogBlock = (block: string) =>
  block
    .split(/\r?\n/)
    .map((line) => cleanLogLine(line))
    .join("\n")
    .trim();

/**
 * Find the earliest index in `line` where a log marker pattern matches.
 */
const findLogIndex = (line: string) => {
  let idx = -1;
  for (const pattern of LOG_MARKERS) {
    const match = pattern.exec(line);
    if (match && (idx === -1 || match.index < idx)) {
      idx = match.index;
    }
  }
  return idx;
};

/**
 * Split a bot message into main content vs debug/tool/subagent log lines.
 */
export const splitDebugContent = (content: string) => {
  const lines = content.split(/\r?\n/);
  const debugLines: string[] = [];
  const toolLines: string[] = [];
  const subagentLines: string[] = [];
  const mainLines: string[] = [];
  let inTrace = false;
  for (const line of lines) {
    const trimmed = line.trimEnd();
    if (!trimmed) {
      if (inTrace) {
        debugLines.push(trimmed);
      } else {
        mainLines.push(trimmed);
      }
      continue;
    }

    const splitAt = findLogIndex(trimmed);
    if (splitAt > 0) {
      let head = trimmed.slice(0, splitAt).trim();
      head = head.replace(/\b\d{1,3}m$/, "").trim();
      const tail = trimmed.slice(splitAt).trim();
      if (head) mainLines.push(head);
      if (tail) {
        const cleanedTail = cleanLogLine(tail);
        if (TOOL_RE.test(cleanedTail)) {
          toolLines.push(cleanedTail);
        } else if (SUBAGENT_RE.test(cleanedTail)) {
          subagentLines.push(cleanedTail);
        } else {
          debugLines.push(cleanedTail);
        }
      }
      continue;
    }

    if (TRACE_START_RE.test(trimmed)) {
      inTrace = true;
      debugLines.push(cleanLogLine(trimmed));
      continue;
    }

    if (inTrace) {
      if (TRACE_CONT_RE.test(trimmed)) {
        debugLines.push(cleanLogLine(trimmed));
        continue;
      }
      inTrace = false;
    }

    const cleaned = cleanLogLine(trimmed);
    if (LOG_LINE_RE.test(cleaned)) {
      if (TOOL_RE.test(cleaned)) {
        toolLines.push(cleaned);
      } else if (SUBAGENT_RE.test(cleaned)) {
        subagentLines.push(cleaned);
      } else {
        debugLines.push(cleaned);
      }
    } else {
      mainLines.push(trimmed);
    }
  }
  return {
    main: mainLines.join("\n").trim(),
    debug: debugLines.join("\n").trim(),
    debugCount: debugLines.length,
    tools: toolLines.join("\n").trim(),
    toolCount: toolLines.length,
    subagents: subagentLines.join("\n").trim(),
    subagentCount: subagentLines.length
  };
};
