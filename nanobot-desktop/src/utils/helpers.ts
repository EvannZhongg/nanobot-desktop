/**
 * Shared helper functions.
 */

/** Current time formatted as locale string. */
export const now = () => new Date().toLocaleTimeString();

/** Today's date as an .md filename (e.g. "2026-03-21.md"). */
export const todayFileName = () => {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}.md`;
};

/** Shared constants. */
export const MAX_INPUT_LINES = 6;
export const HISTORY_BATCH = 10;
