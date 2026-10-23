#!/usr/bin/env node
// daily-live-post.yml (commit-state step): push this run's new records without
// failing on a rebase conflict (lib/record-push.mjs). Records only; never posts.
// Usage: node scripts/push-records.mjs --message "<commit message>" <file> [<file>...]
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { pushRecords } from '../lib/record-push.mjs';
import { gitRunner } from '../lib/ig-persist.mjs';

const args = process.argv.slice(2);
const i = args.indexOf('--message');
const message = i >= 0 ? args[i + 1] : '';
const files = args.filter((a, j) => !(i >= 0 && (j === i || j === i + 1)));

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  if (!message || !files.length) {
    console.error('usage: node scripts/push-records.mjs --message "<commit message>" <file> [<file>...]');
    process.exit(2);
  }
  const run = gitRunner();
  const parse = (text) => JSON.parse(String(text));
  try {
    const r = await pushRecords({
      run,
      branch: process.env.GITHUB_REF_NAME || 'main',
      files,
      message,
      readAt: async (ref, path) => {
        let text;
        try {
          text = await run(['show', `${ref}:${path}`]);
        } catch {
          return null; // not in that commit
        }
        return parse(text);
      },
      readLocal: async (path) => {
        try {
          return parse(await readFile(path, 'utf8'));
        } catch (err) {
          if (err?.code === 'ENOENT') return null;
          throw err;
        }
      },
      writeLocal: (path, doc) => writeFile(path, `${JSON.stringify(doc, null, 2)}\n`, 'utf8'),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      log: console.log,
    });
    console.log(r.pushed ? 'records pushed' : 'nothing to push');
  } catch (err) {
    console.error(`records NOT pushed: ${err.message}`);
    process.exit(1);
  }
}
