// 土曜の週次レビュー用: 次の火曜〜月曜の Instagram 予定と承認状況を Markdown で出す(読み取りのみ)。
import { readFile } from 'node:fs/promises';
import { IG_QUEUE_PATH, nextReviewWeek, igWeekMarkdown } from '../lib/ig-flow.mjs';
import { jstDateKey } from '../lib/target-date.mjs';

let queue = [];
try {
  queue = JSON.parse(await readFile(IG_QUEUE_PATH, 'utf8'));
} catch (err) {
  if (err.code !== 'ENOENT') throw err;
}
console.log(igWeekMarkdown(queue, nextReviewWeek(process.env.TARGET_DATE || jstDateKey())));

// トークン期限の見張り(期限の14日前から警告)
try {
  const { igTokenExpiresAt } = JSON.parse(await readFile('data/ig-account.json', 'utf8'));
  const days = Math.floor((new Date(igTokenExpiresAt) - Date.now()) / 86400000);
  if (Number.isFinite(days) && days <= 14) {
    console.log(`- ⚠️ Instagram の接続期限まであと${days}日（${igTokenExpiresAt.slice(0, 10)}）→ node scripts/connect-instagram.mjs で更新\n`);
  }
} catch {
  console.log('- ⚠️ Instagram はまだ接続されていません（data/ig-account.json なし）\n');
}
