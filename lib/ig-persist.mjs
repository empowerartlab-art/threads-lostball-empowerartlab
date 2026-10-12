// Durable persistence for the journal.
//
// "Durable" here means: present on the remote branch. A file written on the
// runner is gone when the job ends, so a local write is never treated as
// persistence -- every helper below ends by reading the remote back.
//
// This uses the git remote the repository already has. No new service, no new
// dependency. `run(args)` is injected so tests drive it without git or network.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);


export const gitRunner = (cwd = process.cwd()) => async (args) => {
  const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: 10 * 1024 * 1024 });
  return stdout;
};

// The journal as it exists on the remote right now. A missing file reads as
// empty; anything else (network down, bad ref) throws, because "I could not
// look" must not be mistaken for "nothing is there".
export async function remoteJournal({ run, branch, path }) {
  await run(['fetch', 'origin', branch]);
  let raw;
  try {
    raw = await run(['show', `FETCH_HEAD:${path}`]);
  } catch {
    return [];
  }
  const text = String(raw).trim();
  return text ? JSON.parse(text) : [];
}

// Commit `files` and prove the commit reached the remote. Returns the journal
// as the remote now has it. Throws when the push did not land -- callers must
// read a throw as "not persisted", which must mean "do not publish".
export async function pushAndVerify({ run, branch, files, message, guard = null, path }) {
  await run(['add', '--', ...files]);
  const staged = String(await run(['diff', '--cached', '--name-only'])).trim();
  if (!staged) throw new Error('nothing staged: refusing to report persistence that did not happen');
  await run(['commit', '-m', message]);
  try {
    await run(['push', 'origin', `HEAD:${branch}`]);
  } catch {
    // Someone else pushed first. Inspect what landed before rebasing, so a
    // racing claim is never replayed on top of and published twice.
    if (guard) guard(await remoteJournal({ run, branch, path }));
    await run(['pull', '--rebase', 'origin', branch]);
    await run(['push', 'origin', `HEAD:${branch}`]);
  }
  return await remoteJournal({ run, branch, path });
}
