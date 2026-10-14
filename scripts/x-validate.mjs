// data/x-queue.json の検査。Threads の文章(日本語・英語)の丸写し・ほぼ写しは通さない。
// 2026-10-20 以降は1日3本(朝・昼・夜)の枠がちょうど1件ずつ(lib/x-slots.mjs)。
// errors があれば終了コード1。warnings(断定表現など)は表示のみで、人が承認時に判断する。
// URL 入りの投稿は料金が約13倍($0.20。URLなしは $0.015)なので、毎回大きく警告する。
import { readFile } from 'node:fs/promises';
import { validateXQueue, xWarnings, linkCostWarnings, X_QUEUE_PATH } from '../lib/x-flow.mjs';
import { xWeight, hasLink } from '../lib/x-api.mjs';
import { xSlotInfo } from '../lib/x-slots.mjs';

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}
const texts = (list) => (list ?? []).flatMap((p) => [p.bodyJa, p.bodyEn]).filter(Boolean);

const queue = await readJson(X_QUEUE_PATH, []);
const threadsTexts = [
  ...texts((await readJson('data/draft-bank.json', {})).items),
  ...texts((await readJson('data/draft-bank-candidates.json', {})).items),
  ...texts((await readJson('data/threads-posts.json', {})).posts),
];
const facts = (await readJson('data/verified-facts.json', { facts: [] })).facts ?? [];
const errors = validateXQueue(queue, { threadsTexts, facts });
if (process.argv.includes('--list')) {
  for (const p of queue) {
    const when = p.slot ? `${p.slot}(${xSlotInfo(p.slot)?.time ?? '?'})` : '05:53';
    console.log(`${p.date} ${when} ${p.approved ? '承認済み' : '未承認'} ${xWeight(p.text ?? '')}/280${hasLink(p.text ?? '') ? ' ⚠️URLあり' : ''} ${p.id}`);
  }
}
for (const w of xWarnings(queue)) console.log(`warning: ${w}`);
for (const w of linkCostWarnings(queue)) console.log(`::warning::${w}`);
if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
console.log(`ok: ${queue.length} x posts (${queue.filter((p) => p.approved).length} approved)`);
