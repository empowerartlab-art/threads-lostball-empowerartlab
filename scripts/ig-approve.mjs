// The only way an Instagram post becomes publishable.
// Usage: node scripts/ig-approve.mjs --id <postId> --by <名前> --yes
import { readFile, writeFile } from 'node:fs/promises';
import { validateIgQueue, IG_QUEUE_PATH } from '../lib/ig-flow.mjs';

const arg = (n) => {
  const i = process.argv.indexOf(`--${n}`);
  return i === -1 ? undefined : process.argv[i + 1];
};
const id = arg('id');
const by = arg('by');
if (!id || !by || !process.argv.includes('--yes')) {
  console.error('usage: ig-approve.mjs --id <postId> --by NAME --yes');
  process.exit(1);
}
const queue = JSON.parse(await readFile(IG_QUEUE_PATH, 'utf8'));
const post = queue.find((p) => p.id === id);
if (!post) {
  console.error(`no post ${id}`);
  process.exit(1);
}
Object.assign(post, { approved: true, approvedBy: by, approvedAt: new Date().toISOString() });
const { errors } = validateIgQueue(queue);
if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
await writeFile(IG_QUEUE_PATH, JSON.stringify(queue, null, 2) + '\n');
console.log(`approved ${id} (${post.date}) by ${by}`);
