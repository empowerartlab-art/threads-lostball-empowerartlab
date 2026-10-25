// data/ig-queue.json の検査。画像・動画(リール)ファイルの存在・事実IDの存在・禁止表現も見る。
// errors があれば終了コード1(投稿 workflow はここで止まる)。warnings は表示のみ。
import { readFile, access } from 'node:fs/promises';
import { validateIgQueue, IG_QUEUE_PATH, IG_MEDIA_DIR } from '../lib/ig-flow.mjs';
import { CHARACTER_HETARO } from '../lib/media-guard.mjs';

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
  // ヘタ郎の画像は別リポジトリ(hetaro-media の GitHub Pages)にある。置き場の検査は validateIgQueue、
  // 実在の確認は投稿直前の HEAD チェック(lib/ig-flow.mjs)で行う。
  if (p.mediaType === CHARACTER_HETARO) continue;
  // リールの動画・表紙も画像と同じ assets/instagram/ に置く(動画は GitHub Pages、表紙は raw の URL で渡す)。
  const files = [...(p.images ?? []), ...(typeof p.video === 'string' ? [p.video] : []), ...(typeof p.cover === 'string' ? [p.cover] : [])];
  for (const f of files) {
    try {
      await access(IG_MEDIA_DIR + f);
    } catch {
      errors.push(`${p.id}: media file missing ${IG_MEDIA_DIR}${f}`);
    }
  }
}
for (const w of warnings) console.log(`warning: ${w}`);
if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
console.log(`ok: ${queue.length} instagram posts (${queue.filter((p) => p.approved).length} approved)`);
