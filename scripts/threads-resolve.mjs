// data/threads-journal.json の開いた記録(claimed / unknown)を、人が Threads のプロフィールを
// 目で確認したあとに閉じる。閉じるまで Threads の本番の実行は全部の枠で止まる。
// 使い方:
//   node scripts/threads-resolve.mjs --id <postId> --outcome published|not-published [--threads-id <id>] --by <名前> --yes
// published なら data/threads-posts.json に記録が無いとき追記する。終わったら2つのファイルを commit / push する。
import { runThreadsResolve } from '../lib/threads-claim.mjs';
import { fileIo } from '../lib/json-io.mjs';

const arg = (n) => {
  const i = process.argv.indexOf(`--${n}`);
  return i === -1 ? undefined : process.argv[i + 1];
};
const id = arg('id');
const outcome = arg('outcome');
const by = arg('by');
if (!id || !by || !['published', 'not-published'].includes(outcome) || !process.argv.includes('--yes')) {
  console.error('usage: threads-resolve.mjs --id <postId> --outcome published|not-published [--threads-id <id>] --by <name> --yes');
  process.exit(1);
}
const { code } = await runThreadsResolve({ io: fileIo, id, outcome, threadsId: arg('threads-id'), by, now: () => new Date().toISOString(), log: console.log });
process.exit(code);
