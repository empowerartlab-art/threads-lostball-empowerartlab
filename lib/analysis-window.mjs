// Which posts the Saturday weekly review analyses (owner decision 2026-10-17).
//
// The review looks at the posts of the 7 days Saturday..Friday before the run
// (JST). The posting/approval week stays Tuesday..Monday; only the analysis
// period changes. The first review in this cycle (Saturday 2026-10-24) covers
// 2026-10-12..2026-10-23 so nothing between the old and new cycle is skipped.
// A run on another weekday (manual run) analyses the last complete Sat..Fri.
// Pure logic: no I/O.

const DAY_MS = 24 * 3600 * 1000;
const JST_MS = 9 * 3600 * 1000;
export const FIRST_WINDOW = { end: '2026-10-23', start: '2026-10-12' };

const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
export const jstDateOf = (now) => new Date(now.getTime() + JST_MS).toISOString().slice(0, 10);

// { start, end } JST dates (inclusive) and { since, until } ISO instants
// (since inclusive, until exclusive) for a run at `now`.
export function analysisWindow(now = new Date()) {
  const today = jstDateOf(now);
  const weekday = new Date(`${today}T00:00:00Z`).getUTCDay(); // 0 Sun .. 6 Sat
  const back = (weekday + 2) % 7 || 7; // days back to the last Friday strictly before today
  const end = addDays(today, -back);
  const start = end === FIRST_WINDOW.end ? FIRST_WINDOW.start : addDays(end, -6);
  const since = new Date(Date.parse(`${start}T00:00:00Z`) - JST_MS).toISOString();
  const until = new Date(Date.parse(`${addDays(end, 1)}T00:00:00Z`) - JST_MS).toISOString();
  return { start, end, since, until };
}

// "10/12〜10/23" for headings.
export function windowLabel({ start, end }) {
  const md = (d) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
  return `${md(start)}〜${md(end)}`;
}

// True when a post is younger than 24 hours at `now` (its numbers are still
// growing, so compare it with care).
export const under24h = (timestamp, now = new Date()) => now.getTime() - Date.parse(timestamp) < DAY_MS;
