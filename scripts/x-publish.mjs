// この枠(env X_RUN。scripts/x-resolve-run.mjs が決める)・この日(env TARGET_DATE)の承認済み X 投稿を1本出す。
// --live かつ env LIVE_POST === "true"(workflow では Secret X_LIVE_POST から渡す)
// の両方がそろわない限り dry-run。live でも scripts/x-claim.mjs の予約が GitHub 上にないと投稿しない。
import { appendFileSync } from 'node:fs';
import { runXPublish } from '../lib/x-flow.mjs';
import { xRunFromEnv } from '../lib/x-run-env.mjs';
import { fileIo } from '../lib/json-io.mjs';
import { gitRunner } from '../lib/ig-persist.mjs';

const { today, plan } = xRunFromEnv();
const result = await runXPublish({
  io: fileIo,
  git: gitRunner(),
  branch: process.env.GITHUB_REF_NAME || 'main',
  today,
  plan,
  live: process.argv.includes('--live') && process.env.LIVE_POST === 'true',
  creds: {
    apiKey: process.env.X_API_KEY,
    apiSecret: process.env.X_API_SECRET,
    accessToken: process.env.X_ACCESS_TOKEN,
    accessSecret: process.env.X_ACCESS_TOKEN_SECRET,
  },
  runId: process.env.GITHUB_RUN_ID || 'local',
  runAttempt: process.env.GITHUB_RUN_ATTEMPT || '1',
  now: () => new Date().toISOString(),
  fetchImpl: fetch,
  log: console.log,
  errLog: console.error,
});
// workflow の Discord 通知用(秘密値は含めない)
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `stage=${result.stage ?? result.reason ?? (result.halted ? 'halted' : 'none')}\npost_id=${result.postId ?? ''}\n`);
}
process.exit(result.code);
