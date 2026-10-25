// 返信でリンク: 質問の投稿を1回チェックする(lib/reply-link.mjs)。
//   node scripts/reply-link.mjs --decide   -> RUN_SLOT=<check> / RUN_DATE=<JST date>($GITHUB_ENV 用)
//   node scripts/reply-link.mjs [--live]    -> チェックする。本番になるのは、--live を付け、かつ
//                                             環境変数 LIVE_REPLY === "true" と LIVE_POST === "true" のときだけ。
//                                             それ以外は dry-run(表示を見るだけ。書かない・返信しない)。
// Env: SLOT_INPUT, RUN_SCHEDULE, TARGET_DATE(resolveCheck を参照), RUN_SLOT / RUN_DATE(決定済みのとき),
//      THREADS_ACCESS_TOKEN / THREADS_USER_ID(ログには出さない)。
import { runReplyLink, resolveCheck, CHECKS } from '../lib/reply-link.mjs';
import { fileIo } from '../lib/json-io.mjs';
import { gitRunner } from '../lib/ig-persist.mjs';

const SLOT_LABELS = { morning: '朝', noon: '昼', night: '夜' };

let check;
let date;
try {
  ({ check, date } = process.env.RUN_SLOT && process.env.RUN_DATE ? { check: process.env.RUN_SLOT, date: process.env.RUN_DATE } : resolveCheck(process.env));
  if (!CHECKS[check]) throw new Error(`unknown check "${check}"`);
} catch (err) {
  console.error(`cannot decide the check: ${err.message}`);
  process.exit(1);
}

if (process.argv.includes('--decide')) {
  console.log(`RUN_SLOT=${check}`);
  console.log(`RUN_DATE=${date}`);
  const c = CHECKS[check];
  console.error(`check=${check}(${SLOT_LABELS[c.slot]}の日本語の投稿の${c.after / 60}時間後 ${c.time} JST) date=${date}`);
  process.exit(0);
}

const { code } = await runReplyLink({
  io: fileIo,
  git: gitRunner(),
  branch: process.env.GITHUB_REF_NAME || 'main',
  check,
  runDate: date,
  live: process.argv.includes('--live') && process.env.LIVE_REPLY === 'true' && process.env.LIVE_POST === 'true',
  token: process.env.THREADS_ACCESS_TOKEN,
  userId: process.env.THREADS_USER_ID,
  runId: process.env.GITHUB_RUN_ID || 'local',
  runAttempt: process.env.GITHUB_RUN_ATTEMPT || '1',
  now: () => new Date().toISOString(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  fetchImpl: fetch,
  log: console.log,
  errLog: console.error,
});
process.exit(code);
