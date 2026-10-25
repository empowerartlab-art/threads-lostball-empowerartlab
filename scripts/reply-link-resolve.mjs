// 返信の結果が分からなかったとき、人が Threads でその投稿を見てから、開いた記録を閉じる。
//   node scripts/reply-link-resolve.mjs --id lb-2026-10-28-night-ja --outcome published --reply-id 123 --by KEITA --yes
//   node scripts/reply-link-resolve.mjs --id lb-2026-10-28-night-ja --outcome not-published --by KEITA --yes
// data/reply-link-journal.json(と data/reply-links.json)を書き換える。commit・push は自分で行う。
import { runReplyResolve } from '../lib/reply-link.mjs';
import { fileIo } from '../lib/json-io.mjs';

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
};
const id = arg('id');
const outcome = arg('outcome');
const by = arg('by');
if (!id || !by || !['published', 'not-published'].includes(outcome) || !process.argv.includes('--yes')) {
  console.error('usage: reply-link-resolve.mjs --id <postId> --outcome published|not-published [--reply-id ID] --by NAME --yes');
  process.exit(1);
}
const { code } = await runReplyResolve({ io: fileIo, id, outcome, replyId: arg('reply-id'), by, now: () => new Date().toISOString(), log: console.log });
process.exit(code);
