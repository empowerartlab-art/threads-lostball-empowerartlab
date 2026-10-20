// この枠(THREADS_RUN)・この日(TARGET_DATE)に出す Threads の1件を、投稿する前に
// data/threads-journal.json に予約(claim)として書き、GitHub に push して読み戻す(lib/threads-claim.mjs)。
// 何も投稿しない。--live かつ env LIVE_POST === "true"(Secret)のときだけ動く(それ以外は予約しない)。
// GITHUB_OUTPUT: skip=true|false / claimed=true|false / post_id / reason
// 終了コード 1 = 未解決の記録で停止中・予約を push できない → 後の投稿 step は動かない(投稿しない)。
import { appendFileSync } from 'node:fs';
import { runThreadsClaim } from '../lib/threads-claim.mjs';
import { fileIo } from '../lib/json-io.mjs';
import { gitRunner } from '../lib/ig-persist.mjs';
import { jstDateKey } from '../lib/target-date.mjs';

const out = (pairs) => {
  if (!process.env.GITHUB_OUTPUT) return;
  appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(pairs).map(([k, v]) => `${k}=${String(v ?? '').replace(/[\r\n]+/g, ' ')}\n`).join(''));
};

if (!(process.argv.includes('--live') && process.env.LIVE_POST === 'true')) {
  console.log('dry-run (--live と LIVE_POST="true" の両方がそろっていない): 予約しません');
  out({ skip: 'true', claimed: 'false', post_id: '', reason: 'dry-run' });
  process.exit(0);
}

const run = process.env.THREADS_RUN || '';
const todayKey = process.env.TARGET_DATE || jstDateKey();
if (!run || !/^\d{4}-\d{2}-\d{2}$/.test(todayKey)) {
  console.error(`THREADS_RUN / TARGET_DATE が不正です(run="${run}" date="${todayKey}")。予約も投稿もしません`);
  out({ skip: 'false', claimed: 'false', post_id: '', reason: 'bad-input' });
  process.exit(1);
}

const result = await runThreadsClaim({
  io: fileIo,
  git: gitRunner(),
  branch: process.env.GITHUB_REF_NAME || 'main',
  todayKey,
  run,
  runId: process.env.GITHUB_RUN_ID || 'local',
  runAttempt: process.env.GITHUB_RUN_ATTEMPT || '1',
  now: () => new Date().toISOString(),
  log: console.log,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
});
out({ skip: result.skip ? 'true' : 'false', claimed: result.claim ? 'true' : 'false', post_id: result.postId ?? '', reason: result.reason ?? '' });
process.exit(result.code);
