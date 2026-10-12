// Publish today's approved Instagram post. Dry run unless BOTH `--live` is
// passed AND env LIVE_POST === "true" (workflow では Secret IG_LIVE_POST から渡す), and a live run also needs the claim
// that scripts/ig-claim.mjs proved is on the remote.
import { appendFileSync } from 'node:fs';
import { runIgPublish } from '../lib/ig-flow.mjs';
import { fileIo } from '../lib/json-io.mjs';
import { gitRunner } from '../lib/ig-persist.mjs';
import { jstDateKey } from '../lib/target-date.mjs';

const result = await runIgPublish({
  io: fileIo,
  git: gitRunner(),
  branch: process.env.GITHUB_REF_NAME || 'main',
  today: process.env.TARGET_DATE || jstDateKey(),
  live: process.argv.includes('--live') && process.env.LIVE_POST === 'true',
  token: process.env.IG_ACCESS_TOKEN,
  userId: process.env.IG_USER_ID,
  runId: process.env.GITHUB_RUN_ID || 'local',
  runAttempt: process.env.GITHUB_RUN_ATTEMPT || '1',
  now: () => new Date().toISOString(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  fetchImpl: fetch,
  log: console.log,
  errLog: console.error,
});
// workflow の Discord 通知用(秘密値は含めない)
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `stage=${result.stage ?? result.reason ?? (result.halted ? 'halted' : 'none')}\npost_id=${result.postId ?? ''}\n`);
}
process.exit(result.code);
