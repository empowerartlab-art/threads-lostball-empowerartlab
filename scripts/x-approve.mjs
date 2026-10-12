// The only way an X post becomes publishable.
// Usage: node scripts/x-approve.mjs --from 2026-10-14 --to 2026-10-19 --by <名前> --yes
//        node scripts/x-approve.mjs --id <postId> --by <名前> --yes
import { readFile, writeFile } from 'node:fs/promises';
import { X_QUEUE_PATH } from '../lib/x-flow.mjs';

const arg = (n) => {
  const i = process.argv.indexOf(`--${n}`);
  return i === -1 ? undefined : process.argv[i + 1];
};
const [id, from, to, by] = ['id', 'from', 'to', 'by'].map(arg);
if (!by || !process.argv.includes('--yes') || !(id || (from && to))) {
  console.error('usage: x-approve.mjs (--id <postId> | --from YYYY-MM-DD --to YYYY-MM-DD) --by NAME --yes');
  process.exit(1);
}
const queue = JSON.parse(await readFile(X_QUEUE_PATH, 'utf8'));
const targets = queue.filter((p) => (id ? p.id === id : p.date >= from && p.date <= to));
if (!targets.length) {
  console.error('no matching posts');
  process.exit(1);
}
const at = new Date().toISOString();
for (const p of targets) Object.assign(p, { approved: true, approvedBy: by, approvedAt: at });
await writeFile(X_QUEUE_PATH, JSON.stringify(queue, null, 2) + '\n');
for (const p of targets) console.log(`approved ${p.id} (${p.date}) by ${by}`);
console.log('run `node scripts/x-validate.mjs` next; approval does not bypass validation.');
