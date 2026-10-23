// Push this run's new JSON records (data/threads-posts.json and the journal's
// 'published' entry) without ever failing on a rebase conflict.
//
// Why: on 2026-10-21 the night (ja) and night_en Threads runs both appended to
// data/threads-posts.json; the second run's `git pull --rebase` stopped on a
// conflict (both sides changed the end of the same array, count and updatedAt),
// so a post that was live on Threads was not recorded and had to be added by
// hand. A text merge cannot resolve two appends; a JSON merge can.
//
// How: remember what THIS run appended (local file minus the HEAD version),
// then on every attempt: fetch, move HEAD to the remote tip without touching
// the working tree (`reset --mixed`), re-read the latest remote file, append the
// remembered entries that are not on the remote yet, commit only these files
// and push. A rejected push repeats the same with the newer remote (max 5).
// Nothing here ever posts or re-posts; it only records.
//
// Every effect is injected (git runner, file reads/writes, sleep), so tests need
// no git and no network.

export const RECORD_PUSH_ATTEMPTS = 5;

const key = (entry) => JSON.stringify(entry);

// The array a records file holds: the file itself (journal) or its `posts`.
export function entriesOf(doc) {
  if (Array.isArray(doc)) return doc;
  if (doc && typeof doc === 'object' && Array.isArray(doc.posts)) return doc.posts;
  return [];
}

// Entries in `local` that `base` does not have (multiset difference, order kept).
export function addedEntries(base, local) {
  const left = new Map();
  for (const e of entriesOf(base)) left.set(key(e), (left.get(key(e)) ?? 0) + 1);
  const added = [];
  for (const e of entriesOf(local)) {
    const k = key(e);
    const n = left.get(k) ?? 0;
    if (n > 0) left.set(k, n - 1);
    else added.push(e);
  }
  return added;
}

const later = (a, b) => (!a ? b ?? null : !b ? a : a > b ? a : b);

// The latest remote file plus this run's entries that are not on it yet.
// `local` gives the shape when the remote has no file yet.
export function mergeRecords({ remote, additions, local }) {
  const shapeIsArray = Array.isArray(remote ?? local);
  const remoteEntries = entriesOf(remote);
  const present = new Set(remoteEntries.map(key));
  const missing = additions.filter((e) => !present.has(key(e)));
  const entries = [...remoteEntries, ...missing];
  if (shapeIsArray) return { doc: entries, appended: missing.length };
  const baseDoc = remote && typeof remote === 'object' ? remote : { ...local };
  return {
    doc: { ...baseDoc, updatedAt: later(baseDoc.updatedAt, local?.updatedAt), count: entries.length, posts: entries },
    appended: missing.length,
  };
}

/**
 * files:    repository paths of the JSON records files
 * readAt:   async (ref, path) => parsed JSON at that git ref, or null when absent
 * readLocal / writeLocal: the working-tree file (null when absent)
 * run:      async (args) => stdout of `git ...args`; throws on a non-zero exit
 * Returns { pushed, attempts, appended }. Throws after `attempts` rejected pushes.
 */
export async function pushRecords({ run, branch, files, message, readAt, readLocal, writeLocal, attempts = RECORD_PUSH_ATTEMPTS, sleep, log = () => {} }) {
  const plan = [];
  for (const path of files) {
    const local = await readLocal(path);
    if (local === null) continue;
    const additions = addedEntries(await readAt('HEAD', path), local);
    if (additions.length) plan.push({ path, local, additions });
  }
  if (!plan.length) {
    log('record-push: nothing new to record');
    return { pushed: false, attempts: 0, appended: 0 };
  }
  log(`record-push: ${plan.map((p) => `${p.path} +${p.additions.length}`).join(', ')}`);

  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    await run(['fetch', 'origin', branch]);
    // HEAD -> the remote tip; the working tree (our files) is left as it is.
    await run(['reset', '-q', '--mixed', 'FETCH_HEAD']);
    let appended = 0;
    for (const p of plan) {
      const merged = mergeRecords({ remote: await readAt('FETCH_HEAD', p.path), additions: p.additions, local: p.local });
      appended += merged.appended;
      await writeLocal(p.path, merged.doc);
    }
    if (appended === 0) {
      log('record-push: every entry is already on the remote; nothing to push');
      return { pushed: false, attempts: attempt, appended: 0 };
    }
    await run(['add', '--', ...plan.map((p) => p.path)]);
    await run(['commit', '-q', '-m', message]);
    try {
      await run(['push', 'origin', `HEAD:${branch}`]);
      log(`record-push: pushed (attempt ${attempt}/${attempts}, ${appended} entr${appended === 1 ? 'y' : 'ies'} appended to the latest remote files)`);
      return { pushed: true, attempts: attempt, appended };
    } catch (err) {
      lastError = err;
      log(`record-push: push rejected (attempt ${attempt}/${attempts}): ${err?.message ?? err}; re-reading the remote and appending again`);
      if (attempt < attempts) await sleep(attempt * 5000);
    }
  }
  throw new Error(`record push rejected ${attempts} times (${lastError?.message ?? lastError})`);
}
