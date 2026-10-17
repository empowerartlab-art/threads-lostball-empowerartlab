// Prints the "Instagram reactions" section of the Saturday review (Markdown on
// stdout) and appends a follower snapshot to data/ig-stats.json so next week
// can show the change. Read-only toward Instagram. Never exits non-zero: a
// failure becomes a warning line in the review instead of blocking the Issue.
import { readFile, writeFile } from 'node:fs/promises';
import { analysisWindow, windowLabel } from '../lib/analysis-window.mjs';
import { collectIgStats, igStatsMarkdown, igStatsFailureMarkdown } from '../lib/ig-insights.mjs';

const STATS_PATH = 'data/ig-stats.json';
const token = process.env.IG_ACCESS_TOKEN;
const userId = process.env.IG_USER_ID;
// Posts of the Saturday..Friday before this run (lib/analysis-window.mjs).
const win = analysisWindow();

let history = [];
try {
  history = JSON.parse(await readFile(STATS_PATH, 'utf8'));
} catch (err) {
  if (err.code !== 'ENOENT') throw err;
}

if (!token || !userId) {
  console.log(igStatsFailureMarkdown('IG_ACCESS_TOKEN / IG_USER_ID が設定されていません', []));
} else {
  try {
    const stats = await collectIgStats({ token, userId, since: win.since, until: win.until });
    const prev = history.at(-1)?.followers ?? null;
    console.log(igStatsMarkdown(stats, { prevFollowers: prev, period: windowLabel(win) }));
    history.push({ at: new Date().toISOString(), followers: stats.followers, mediaCount: stats.mediaCount });
    await writeFile(STATS_PATH, JSON.stringify(history, null, 2) + '\n');
  } catch (err) {
    console.log(igStatsFailureMarkdown(err, [token, userId]));
  }
}
