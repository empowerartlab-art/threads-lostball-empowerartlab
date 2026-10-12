// data/ig-queue.json の検査。画像ファイルの存在・事実IDの存在・禁止表現も見る。
// errors があれば終了コード1(投稿 workflow はここで止まる)。warnings は表示のみ。
import { readFile, access } from 'node:fs/promises';
import { validateIgQueue, IG_QUEUE_PATH, IG_MEDIA_DIR } from '../lib/ig-flow.mjs';

let queue = [];
try {
  queue = JSON.parse(await readFile(IG_QUEUE_PATH, 'utf8'));
} catch (err) {
  if (err.code !== 'ENOENT') throw err;
}
const factsRaw = JSON.parse(await readFile('data/verified-facts.json', 'utf8'));
const facts = Array.isArray(factsRaw) ? factsRaw : factsRaw.facts ?? [];
const { errors, warnings } = validateIgQueue(queue, { factIds: facts.map((f) => f.id) });
for (const p of queue) {
  for (const f of p.images ?? []) {
    try {
      await access(IG_MEDIA_DIR + f);
    } catch {
      errors.push(`${p.id}: image file missing ${IG_MEDIA_DIR}${f}`);
    }
  }
}
for (const w of warnings) console.log(`warning: ${w}`);
if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
console.log(`ok: ${queue.length} instagram posts (${queue.filter((p) => p.approved).length} approved)`);
