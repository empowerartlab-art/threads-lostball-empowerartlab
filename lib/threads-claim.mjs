// Threads の「先に記録」(claim-before-post)。X・Instagram(lib/x-flow.mjs / lib/ig-flow.mjs)と
// ZERO RIDERS(~/projects/threads-zero-riders lib/publish-flow.mjs)と同じ設計:
//
//   1. 予約(claim): その枠で出す1件を data/threads-journal.json に {stage:"claimed"} として追記し、
//      GitHub に push して読み戻す(pushAndVerify。pull --rebase で最大5回)。push できなければ投稿しない。
//   2. 投稿: lib/live-post-runner.mjs の runLivePost(既存の選出・ガード・二重ゲート・state保存を
//      そのまま使う)に、API を呼ぶ直前の確認(beforePublish)を差し込む。GitHub 上にこの実行の
//      予約が無い・別の未解決の記録がある → Threads API は一切呼ばない。
//   3. 結果: 成功 → "published"(data/threads-posts.json の記録と一緒に workflow の commit/push step が push)。
//      コンテナ作成の失敗など公開前の失敗 → "aborted"(予約を閉じる)。公開の呼び出しのエラー・不明 →
//      "unknown"(開いたまま。自動で出し直さない)。結果を push できなければ予約は開いたまま。
//   4. 開いた記録(claimed / unknown)が1つでもあると、以後の Threads の本番の実行(全部の枠。英語の
//      night_en も)は止まる。人が Threads を見て scripts/threads-resolve.mjs で閉じるまで。
//
// ファイル・git・時計はすべて引数で受け取る(テストはモックで動かす。ネットワークに出ない)。

import * as J from './ig-journal.mjs';
import { remoteJournal, pushAndVerify } from './ig-persist.mjs';
import { runLivePost, selectForRun, OUTCOME } from './live-post-runner.mjs';
import { publishPost } from './threads-publish.mjs';

export const THREADS_JOURNAL_PATH = 'data/threads-journal.json';
export const THREADS_BANK_PATH = 'data/draft-bank.json';
export const THREADS_POSTED_PATH = 'data/threads-posts.json';
export const THREADS_FACTS_PATH = 'data/verified-facts.json';
// 記録の push が他の workflow とぶつかったときの最大回数(X・既存の commit/push step と同じ5回)。
export const THREADS_PUSH_ATTEMPTS = 5;

export const THREADS_HALT =
  'ACTION REQUIRED: a human must check the Threads profile (@lost_ball_empowerartlab) and close the entry with ' +
  'node scripts/threads-resolve.mjs --id <postId> --outcome published|not-published [--threads-id <id>] --by <name> --yes. ' +
  'Threads posting stays halted for every slot (morning / noon / night / night_en) until then.';

// journal の1行。どの枠(run)・言語の投稿かも残す(人が追えるように・resolve で記録を作れるように)。
export function threadsEvent({ postId, date, stage, runId, runAttempt, at, threadsId = null, note = null, run = null, lang = null, slot = null }) {
  return { ...J.event({ postId, date, stage, runId, runAttempt, at, threadsId, note }), run, lang, slot };
}

const alreadyPublished = (journal, postId) => journal.some((e) => e.postId === postId && e.stage === J.PUBLISHED);

function reportBlockers(log, blocked) {
  log(`halted: ${blocked.length} unresolved entr${blocked.length === 1 ? 'y' : 'ies'} in ${THREADS_JOURNAL_PATH}`);
  for (const e of blocked) log(`  ${J.describe(e)}`);
  log(THREADS_HALT);
}

async function readRemote({ git, branch, log, step }) {
  try {
    return await remoteJournal({ run: git, branch, path: THREADS_JOURNAL_PATH });
  } catch (err) {
    log(`cannot read ${THREADS_JOURNAL_PATH} on the remote (${err.message}); not publishing (step=${step})`);
    return null;
  }
}

// draft-bank / threads-posts / verified-facts を読み、runLivePost と同じ選び方で1件選ぶ。
export async function selectThreadsForRun({ io, todayKey, run }) {
  const bank = await io.readJson(THREADS_BANK_PATH, { items: [] });
  const posts = await io.readJson(THREADS_POSTED_PATH, { posts: [] });
  const facts = await io.readJson(THREADS_FACTS_PATH, { facts: [] });
  return selectForRun({ bankItems: bank.items, postedPosts: posts.posts, facts: facts.facts, todayKey, run });
}

/**
 * 予約(claim)。何も投稿しない。失敗したら投稿もしない。
 * 戻り値: { code, skip?, reason?, halted?, claim?, postId? }
 *   code 0 + skip     … この枠に出す1件が無い(従来どおり静かに終わる)
 *   code 0 + claim    … 予約が GitHub 上にある(この後の投稿 step が出してよい)
 *   code 1            … 未解決の記録で停止中・予約を push できない・読み戻しが曖昧 → 投稿しない
 */
export async function runThreadsClaim({ io, git, branch, todayKey, run, runId, runAttempt, now, log, sleep }) {
  const { selected, skipped, plan, lang, slot } = await selectThreadsForRun({ io, todayKey, run });
  log(`date=${todayKey} run=${run ?? '-'} step=threads-claim`);
  if (!selected) {
    const why = plan?.kind === 'none' ? plan.reason : skipped?.[0]?.reason ?? 'no-post-scheduled';
    log(`nothing to claim: ${why}`);
    return { code: 0, skip: true, reason: why };
  }

  const before = await readRemote({ git, branch, log, step: 'claim' });
  if (before === null) return { code: 1, reason: 'remote-unreadable' };
  const blocked = J.blockers(before);
  if (blocked.length) {
    reportBlockers(log, blocked);
    return { code: 1, halted: true, reason: 'open-claim' };
  }
  if (alreadyPublished(before, selected.id)) {
    log(`${selected.id} is already recorded as published in ${THREADS_JOURNAL_PATH} but not in ${THREADS_POSTED_PATH}; not posting it again. A human must check.`);
    return { code: 1, reason: 'already-published-in-journal' };
  }

  const claim = threadsEvent({ postId: selected.id, date: todayKey, stage: J.CLAIMED, runId, runAttempt, at: now(), run, lang, slot });
  await io.writeJson(THREADS_JOURNAL_PATH, [...before, claim]);
  let landed;
  try {
    landed = await pushAndVerify({
      run: git,
      branch,
      files: [THREADS_JOURNAL_PATH],
      path: THREADS_JOURNAL_PATH,
      message: `chore(lostball): claim Threads ${selected.id} (${todayKey} ${run ?? ''})`.trim(),
      // push 競争に負けたら、先に入ったものを見てから rebase する。別の実行の予約があれば重ねない。
      guard: (remote) => {
        if (J.blockers(remote).length) throw new Error('another run holds an open claim');
        if (alreadyPublished(remote, selected.id)) throw new Error('another run already published this post');
      },
      attempts: THREADS_PUSH_ATTEMPTS,
      sleep,
    });
  } catch (err) {
    log(`claim NOT persisted: ${err.message}; not publishing`);
    return { code: 1, reason: 'claim-not-persisted' };
  }
  const open = J.openClaimsFor(landed, selected.id);
  if (open.length !== 1 || !J.sameRun(open[0], claim)) {
    log(`claim ambiguous on the remote (open claims=${open.length}); not publishing`);
    return { code: 1, reason: 'claim-ambiguous' };
  }
  log(`claimed: ${J.describe(claim)}`);
  return { code: 0, claim, postId: selected.id };
}

// API を呼ぶ直前の確認(純粋関数)。remote = GitHub 上の journal。
export function claimStatus(remote, postId, runId, runAttempt) {
  const open = J.openClaimsFor(remote, postId);
  const mine = open.length === 1 && open[0].runId === runId && open[0].runAttempt === runAttempt ? open[0] : null;
  const blocked = J.blockers(remote, mine);
  if (blocked.length) return { ok: false, reason: 'open-claim', blocked };
  if (!mine) return { ok: false, reason: 'no-claim', detail: `no durable claim for this run on the remote (open claims=${open.length})` };
  return { ok: true, mine };
}

// 投稿の結果から journal に書く stage を決める(純粋関数)。
//   published      … 投稿・記録とも成功(journal はローカルに書いた。workflow の commit/push step が push)
//   left-open      … 投稿は成功したが記録(state保存)に失敗 / 予約を確認できなかった → 何も書かない
//   aborted        … API を呼ぶ前、またはコンテナ作成の段階で失敗(Threads に出ていないと確実に言える)
//   unknown        … 公開(threads_publish)の呼び出しが失敗(出たか不明。開いたまま)
//   none           … 予約していない(対象なし)
export function journalStageFor(result, { apiCalled = false, claimed = false } = {}) {
  switch (result?.outcome) {
    case OUTCOME.POSTED_STATE_SAVED:
      return J.PUBLISHED;
    case OUTCOME.POSTED_STATE_SAVE_FAILED:
      return 'left-open';
    case OUTCOME.PRE_POST_FAILURE:
      if (result.reason === 'claim-check-failed') return 'left-open';
      if (result.reason === 'guard-check-failed') return J.ABORTED;
      if (!apiCalled || result.error?.containerCreationFailure === true) return J.ABORTED;
      return J.UNKNOWN;
    case OUTCOME.NO_CANDIDATE:
    case OUTCOME.DRY_RUN:
      return claimed ? J.ABORTED : 'none';
    default:
      return 'left-open';
  }
}

const NOTES = {
  [J.ABORTED]: 'failed before anything could reach Threads (no publish call / container creation failed); nothing was published',
  [J.UNKNOWN]: 'publish (threads_publish) call failed; the post may or may not be on Threads',
};

// この実行の開いた予約に stage を追記して push する(ベストエフォート。失敗したら予約は開いたまま=停止)。
export async function closeMyClaims({ io, git, branch, todayKey, runId, runAttempt, stage, note, now, log, errLog, sleep }) {
  let journal;
  try {
    journal = await remoteJournal({ run: git, branch, path: THREADS_JOURNAL_PATH });
  } catch (err) {
    errLog(`journal NOT updated (cannot read the remote: ${err.message}); the open claim keeps Threads posting halted`);
    return { persisted: false, closed: [] };
  }
  const mine = J.openEntries(journal).filter((e) => e.stage === J.CLAIMED && e.runId === runId && e.runAttempt === runAttempt);
  if (!mine.length) {
    log('journal: this run holds no open claim; nothing to close');
    return { persisted: true, closed: [] };
  }
  const entries = mine.map((c) => threadsEvent({ postId: c.postId, date: c.date ?? todayKey, stage, runId, runAttempt, at: now(), note: note ?? NOTES[stage] ?? null, run: c.run ?? null, lang: c.lang ?? null, slot: c.slot ?? null }));
  try {
    await io.writeJson(THREADS_JOURNAL_PATH, [...journal, ...entries]);
    await pushAndVerify({
      run: git,
      branch,
      files: [THREADS_JOURNAL_PATH],
      path: THREADS_JOURNAL_PATH,
      message: `chore(lostball): Threads ${stage} ${entries.map((e) => e.postId).join(',')} (${todayKey})`,
      attempts: THREADS_PUSH_ATTEMPTS,
      sleep,
    });
  } catch (err) {
    errLog(`journal NOT updated (${err.message}); the open claim keeps Threads posting halted: ${entries.map(J.describe).join(' | ')}`);
    return { persisted: false, closed: entries };
  }
  for (const e of entries) log(`journal: ${J.describe(e)}`);
  return { persisted: true, closed: entries };
}

/**
 * 予約つきの本番投稿(daily-live-post.yml の「投稿実行」step。scripts/post-to-threads.mjs --claim)。
 * runnerArgs は runLivePost にそのまま渡す引数(live / env / saveState / publish など)。
 * 戻り値: { result, journalStage, persisted }
 */
export async function runThreadsPostWithClaim({
  runnerArgs, runner = runLivePost, io, git, branch, todayKey, run, runId, runAttempt, claimed = false,
  now, log, errLog, sleep,
}) {
  const ctx = { apiCalled: false, verified: false };
  const basePublish = runnerArgs.publish ?? publishPost;
  const baseSave = runnerArgs.saveState ?? (async () => {});

  let result;
  try {
    result = await runner({
      ...runnerArgs,
      beforePublish: async (selected) => {
        const remote = await remoteJournal({ run: git, branch, path: THREADS_JOURNAL_PATH });
        const s = claimStatus(remote, selected.id, runId, runAttempt);
        if (!s.ok) {
          if (s.blocked) reportBlockers(log, s.blocked);
          const err = new Error(s.reason === 'open-claim' ? 'unresolved entries in the Threads journal' : s.detail);
          err.claimCheck = s.reason;
          throw err;
        }
        ctx.verified = true;
      },
      publish: async (args) => {
        // live のときは、予約を確かめた後でなければ API に進まない(二重の守り)。
        if (args?.live === true && args?.env?.LIVE_POST === 'true' && !ctx.verified) {
          throw new Error('internal: publish reached without a verified claim; not calling Threads');
        }
        if (args?.live === true && args?.env?.LIVE_POST === 'true') ctx.apiCalled = true;
        return basePublish(args);
      },
      saveState: async (record) => {
        await baseSave(record);
        // data/threads-posts.json の記録と一緒に push される "published"(ローカルに書くだけ)。
        const journal = await io.readJson(THREADS_JOURNAL_PATH, []);
        const entry = threadsEvent({
          postId: record.sourceItemId, date: todayKey, stage: J.PUBLISHED, runId, runAttempt, at: now(),
          threadsId: record.threadsPostId ?? null, note: 'threads post id stored in threadsId',
          run, lang: record.lang ?? null, slot: record.slot ?? null,
        });
        await io.writeJson(THREADS_JOURNAL_PATH, [...journal, entry]);
      },
    });
  } catch (err) {
    // 想定外の例外: 出たか分からないので、予約は開いたまま(人が確認するまで止まる)。
    errLog(`unexpected error (${err.message}); the claim (if any) stays open`);
    errLog(THREADS_HALT);
    return { result: null, journalStage: 'left-open', persisted: false, error: err };
  }

  const stage = journalStageFor(result, { apiCalled: ctx.apiCalled, claimed });
  if (stage === J.ABORTED || stage === J.UNKNOWN) {
    const { persisted } = await closeMyClaims({ io, git, branch, todayKey, runId, runAttempt, stage, now, log, errLog, sleep });
    if (stage === J.UNKNOWN) errLog(THREADS_HALT);
    return { result, journalStage: stage, persisted };
  }
  // 投稿は成功したが記録に失敗: 予約は開いたまま(人が threads-resolve.mjs --outcome published で閉じる)。
  if (stage === 'left-open' && result.outcome === OUTCOME.POSTED_STATE_SAVE_FAILED) errLog(THREADS_HALT);
  return { result, journalStage: stage, persisted: stage === J.PUBLISHED ? null : true };
}

// 人が Threads を目で確認したあとに、開いた記録を閉じる(scripts/threads-resolve.mjs)。
// published なら data/threads-posts.json に記録が無いとき追記する(以後その投稿は選ばれない)。
export async function runThreadsResolve({ io, id, outcome, threadsId, by, now, log }) {
  const journal = await io.readJson(THREADS_JOURNAL_PATH, []);
  const target = J.openEntries(journal).find((e) => e.postId === id);
  if (!target) {
    log(`nothing open for ${id}`);
    return { code: 1, reason: 'not-open' };
  }
  const published = outcome === 'published';
  const entry = threadsEvent({
    postId: id, date: target.date, stage: published ? J.PUBLISHED : J.RESOLVED,
    runId: `resolved-by:${by}`, runAttempt: '1', at: now(),
    threadsId: published ? (threadsId ?? null) : null,
    note: published ? 'confirmed live on Threads by a human' : 'confirmed not published by a human',
    run: target.run ?? null, lang: target.lang ?? null, slot: target.slot ?? null,
  });
  await io.writeJson(THREADS_JOURNAL_PATH, [...journal, entry]);
  if (published) {
    const postsFile = await io.readJson(THREADS_POSTED_PATH, { posts: [] });
    const posts = Array.isArray(postsFile.posts) ? postsFile.posts : [];
    if (!posts.some((p) => p.sourceItemId === id)) {
      const bank = await io.readJson(THREADS_BANK_PATH, { items: [] });
      const item = (bank.items || []).find((i) => i.id === id) ?? {};
      const record = {
        sourceItemId: id, threadsPostId: threadsId ?? null, bodyEn: item.bodyEn ?? '', bodyJa: item.bodyJa ?? '',
        pillar: item.pillar ?? null, category: item.category ?? null, postedAt: now(), mode: 'live', workflowRunUrl: null,
        ...(target.lang ? { lang: target.lang } : {}),
        ...(target.slot ? { slot: target.slot, targetDate: item.targetDate ?? target.date } : {}),
        recoveredBy: by,
      };
      const nextPosts = [...posts, record];
      await io.writeJson(THREADS_POSTED_PATH, { ...postsFile, posts: nextPosts, count: nextPosts.length, updatedAt: now() });
      log(`recorded as published in ${THREADS_POSTED_PATH}`);
    }
  }
  log(`resolved: ${J.describe(entry)}`);
  log(`commit and push ${THREADS_JOURNAL_PATH}${published ? ` and ${THREADS_POSTED_PATH}` : ''}, or the next live Threads run will halt again.`);
  return { code: 0, entry };
}
