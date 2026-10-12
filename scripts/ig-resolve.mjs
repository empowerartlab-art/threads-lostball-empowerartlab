// Close an open Instagram journal entry after a human has looked at the profile.
// Usage: node scripts/ig-resolve.mjs --id <postId> --outcome published|not-published [--media-id <id>] --by <name> --yes
import { runIgResolve } from '../lib/ig-flow.mjs';
import { fileIo } from '../lib/json-io.mjs';

const arg = (n) => {
  const i = process.argv.indexOf(`--${n}`);
  return i === -1 ? undefined : process.argv[i + 1];
};
const id = arg('id');
const outcome = arg('outcome');
const by = arg('by');
if (!id || !by || !['published', 'not-published'].includes(outcome) || !process.argv.includes('--yes')) {
  console.error('usage: ig-resolve.mjs --id <postId> --outcome published|not-published [--media-id <id>] --by <name> --yes');
  process.exit(1);
}
const { code } = await runIgResolve({ io: fileIo, id, outcome, mediaId: arg('media-id'), by, now: () => new Date().toISOString(), log: console.log });
process.exit(code);
