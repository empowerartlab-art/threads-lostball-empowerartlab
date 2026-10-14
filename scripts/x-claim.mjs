// Put this slot's X publish intent on the remote before anything is published.
// The slot comes from X_RUN (scripts/x-resolve-run.mjs), the date from TARGET_DATE.
// Writes GITHUB_OUTPUT skip=true when there is nothing to post today.
import { appendFileSync } from 'node:fs';
import { runXClaim } from '../lib/x-flow.mjs';
import { xRunFromEnv } from '../lib/x-run-env.mjs';
import { fileIo } from '../lib/json-io.mjs';
import { gitRunner } from '../lib/ig-persist.mjs';

const { today, plan } = xRunFromEnv();
const result = await runXClaim({
  io: fileIo,
  git: gitRunner(),
  branch: process.env.GITHUB_REF_NAME || 'main',
  today,
  plan,
  runId: process.env.GITHUB_RUN_ID || 'local',
  runAttempt: process.env.GITHUB_RUN_ATTEMPT || '1',
  now: () => new Date().toISOString(),
  log: console.log,
});
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `skip=${result.skip ? 'true' : 'false'}\n`);
process.exit(result.code);
