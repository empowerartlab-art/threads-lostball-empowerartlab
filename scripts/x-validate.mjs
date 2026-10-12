// data/x-queue.json の検査。Threads の文章(日本語・英語)の丸写しは通さない。
// errors があれば終了コード1。warnings(断定表現など)は表示のみで、人が承認時に判断する。
import { readFile } from 'node:fs/promises';
import { validateXQueue, xWarnings, X_QUEUE_PATH } from '../lib/x-flow.mjs';
import { xWeight, hasLink } from '../lib/x-api.mjs';

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
const threadsTexts = [...texts((await readJson('data/draft-bank.json', {})).items), ...texts((await readJson('data/threads-posts.json', {})).posts)];
const errors = validateXQueue(queue, threadsTexts);
if (process.argv.includes('--list')) {
  for (const p of queue) console.log(`${p.date} ${p.approved ? '承認済み' : '未承認'} ${xWeight(p.text)}/280${hasLink(p.text) ? ' リンクあり' : ''} ${p.id}`);
}
for (const w of xWarnings(queue)) console.log(`warning: ${w}`);
if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
console.log(`ok: ${queue.length} x posts (${queue.filter((p) => p.approved).length} approved)`);
