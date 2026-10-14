// 土曜の週次レビュー用: 次の火曜〜月曜の X 予定と承認状況を Markdown で出す(読み取りのみ・API は呼ばない)。
// 2026-10-20 以降は1日3本×7日＝21本。足りない枠には元にする日本語 Threads を並べる(lib/x-week.mjs)。
import { readFile } from 'node:fs/promises';
import { X_QUEUE_PATH } from '../lib/x-flow.mjs';
import { nextReviewWeek } from '../lib/ig-flow.mjs';
import { jstDateKey } from '../lib/target-date.mjs';
import { xWeekMarkdown } from '../lib/x-week.mjs';

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}
const queue = await readJson(X_QUEUE_PATH, []);
const threadsItems = [...((await readJson('data/draft-bank.json', {})).items ?? []), ...((await readJson('data/draft-bank-candidates.json', {})).items ?? [])];
console.log(xWeekMarkdown(queue, threadsItems, nextReviewWeek(process.env.TARGET_DATE || jstDateKey())));
