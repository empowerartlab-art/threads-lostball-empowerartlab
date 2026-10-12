// Put today's X publish intent on the remote before anything is published.
// Writes GITHUB_OUTPUT skip=true when there is nothing to post today.
import { appendFileSync } from 'node:fs';
import { runXClaim, jstToday } from '../lib/x-flow.mjs';
import { fileIo } from '../lib/json-io.mjs';
import { gitRunner } from '../lib/ig-persist.mjs';

const result = await runXClaim({
  io: fileIo,
  git: gitRunner(),
  branch: process.env.GITHUB_REF_NAME || 'main',
  today: process.env.TARGET_DATE || jstToday(),
  runId: process.env.GITHUB_RUN_ID || 'local',
  runAttempt: process.env.GITHUB_RUN_ATTEMPT || '1',
  now: () => new Date().toISOString(),
  log: console.log,
});
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `skip=${result.skip ? 'true' : 'false'}\n`);
process.exit(result.code);
