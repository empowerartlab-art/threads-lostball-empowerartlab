// Close an open X journal entry after a human has looked at the profile.
// Usage: node scripts/x-resolve.mjs --id <postId> --outcome published|not-published [--x-id <id>] --by <name> --yes
import { runXResolve } from '../lib/x-flow.mjs';
import { fileIo } from '../lib/json-io.mjs';

const arg = (n) => {
  const i = process.argv.indexOf(`--${n}`);
  return i === -1 ? undefined : process.argv[i + 1];
};
const id = arg('id');
const outcome = arg('outcome');
const by = arg('by');
if (!id || !by || !['published', 'not-published'].includes(outcome) || !process.argv.includes('--yes')) {
  console.error('usage: x-resolve.mjs --id <postId> --outcome published|not-published [--x-id <id>] --by <name> --yes');
  process.exit(1);
}
const { code } = await runXResolve({ io: fileIo, id, outcome, xId: arg('x-id'), by, now: () => new Date().toISOString(), log: console.log });
process.exit(code);
