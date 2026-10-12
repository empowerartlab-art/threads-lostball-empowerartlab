// 土曜の週次レビュー用: 次の火曜〜月曜の X 予定と承認状況を Markdown で出す(読み取りのみ・API は呼ばない)。
import { readFile } from 'node:fs/promises';
import { X_QUEUE_PATH } from '../lib/x-flow.mjs';
import { nextReviewWeek } from '../lib/ig-flow.mjs';
import { jstDateKey } from '../lib/target-date.mjs';

let queue = [];
try {
  queue = JSON.parse(await readFile(X_QUEUE_PATH, 'utf8'));
} catch (err) {
  if (err.code !== 'ENOENT') throw err;
}
const { start, end } = nextReviewWeek(process.env.TARGET_DATE || jstDateKey());
const items = queue.filter((p) => p.date >= start && p.date <= end).sort((a, b) => a.date.localeCompare(b.date));
const out = [`## X 来週の予定（${start}〜${end}）`, ''];
if (!items.length) out.push('- まだ1本もありません → Claude に「来週のXを作って」と依頼');
for (const p of items) out.push(`- ${p.date} ${p.approved ? '✅承認済み' : '⏳未承認'} ${p.id}「${p.text.split('\n')[0].slice(0, 30)}」`);
console.log(out.join('\n') + '\n');
