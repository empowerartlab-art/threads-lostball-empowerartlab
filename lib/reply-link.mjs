// 「返信でリンク」(reply link): 質問の投稿(draft-bank.json の item に "replyLink": true)が
// 伸びたら、その投稿に自分の返信を1回だけ付けて、BASE のお店のリンクを貼る。
// 代表者の決定(2026-10-25): 本文にはリンクを入れない(今までどおりプロフィールのリンク)。
// 伸びた質問の投稿にだけ、自分の返信でお店のリンクを付ける。
// ZERO RIDERS(~/projects/threads-zero-riders lib/reply-link.mjs)と同じ設計を、
// ロストボールの日本語 Threads(朝7:35・昼12:35・夜20:35)に合わせたもの。英語(21:00)は対象外。
//
// いつ:   質問の投稿の約2時間後と約6時間後(CHECKS)。夜(20:35)の2回目は深夜になるので、
//         夜は約2時間後(22:35)の1回だけ。1日5回。
// 2026-10-25 変更: 候補は1日2本まで ＝ その日の質問の投稿と、ふつうの投稿1本("replyLinkKind": "plain")。
//         返信は2本を合わせて1日1回まで。先に条件を満たした(先にチェックした)ほうに付け、
//         その日のもう1本には付けない。チェックは枠ごとにあるので、ふつうの投稿が朝・昼・夜の
//         どれにあっても見られる(夜は約2時間後の1回だけ)。
//         文の for(使える投稿の種類)。今の5本は代表者OKで両方に使える。
// 決まり: そのときの表示(views)が MIN_VIEWS 以上なら、承認済みの文で1回だけ返信する。
// 守り:   1つの投稿に1回・1日1回まで。Threads API を呼ぶ前に GitHub 上に予約(claim)を置く
//         (この仕組み専用の記録 data/reply-link-journal.json)。既定は dry-run。
//         ふだんの投稿の記録(data/threads-journal.json / threads-posts.json)には一切書かないので、
//         ここが失敗しても、ふだんの投稿が止まったり変わったりすることはない。
// 記録:   data/reply-links.json に、チェックごとの時刻と表示の数、返信の時刻・表示・文の id・返信の id。
//         公開リポジトリなので、人の名前や鍵は入れない(Threads の投稿 id と数字だけ)。
//
// ファイル・git・Threads API・時計・待ち時間はすべて引数で受け取る(テストはネットワークに出ない)。

import * as J from './ig-journal.mjs';
import { remoteJournal, pushAndVerify } from './ig-persist.mjs';
import { createSecretRedactor } from './redact.mjs';
import { RUNS, addDays, REPLY_LINK_KINDS, replyLinkKindOf } from './slots.mjs';

const GRAPH = 'https://graph.threads.net/v1.0';

// BASE のお店(data/brand-profile.json の account.shopUrl と同じ。テストで一致を確かめる)。
export const SHOP_URL = 'https://empower.base.shop/';
export const MIN_VIEWS = 300;
export const REPLY_TEXTS_PATH = 'data/reply-link-texts.json';
export const REPLY_JOURNAL_PATH = 'data/reply-link-journal.json';
export const REPLY_RECORDS_PATH = 'data/reply-links.json';
export const BANK_PATH = 'data/draft-bank.json';
export const POSTED_PATH = 'data/threads-posts.json';
export const MAX_REPLY_TEXT = 500;
export const PUSH_ATTEMPTS = 5;
// 返信の文を日替わりにするときの起点(1日4本が始まった日)。
export const ROTATION_ANCHOR = '2026-10-20';

// 枠ごとに、投稿の何分後に見るか。夜は2時間後だけ(6時間後は深夜 02:35 になるため)。
export const CHECK_AFTER = Object.freeze({
  morning: Object.freeze({ '2h': 120, '6h': 360 }),
  noon: Object.freeze({ '2h': 120, '6h': 360 }),
  night: Object.freeze({ '2h': 120 }),
});

const toMin = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};
const toHhmm = (min) => `${String(Math.floor(min / 60) % 24).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
// JST "HH:MM" -> GitHub の cron(UTC)。
export const cronFor = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return `${m} ${(h + 24 - 9) % 24} * * *`;
};

// 日本語の枠の時刻(lib/slots.mjs の RUNS から。英語 night_en と従来の legacy_ja は含めない)。
export const SLOT_TIMES = Object.freeze(Object.fromEntries(RUNS.filter((r) => r.slot && r.lang === 'ja').map((r) => [r.slot, r.time])));

// { morning_2h: { slot, after, time, dayOffset }, ... } 1日5回。
export const CHECKS = Object.freeze(
  Object.fromEntries(
    Object.entries(CHECK_AFTER).flatMap(([slot, afters]) =>
      Object.entries(afters).map(([label, after]) => {
        const total = toMin(SLOT_TIMES[slot]) + after;
        return [`${slot}_${label}`, Object.freeze({ slot, after, time: toHhmm(total), dayOffset: Math.floor(total / 1440) })];
      }),
    ),
  ),
);
export const CHECK_TIMES = Object.freeze(Object.fromEntries(Object.entries(CHECKS).map(([k, c]) => [k, c.time])));
export const CHECK_CRONS = Object.freeze(Object.fromEntries(Object.entries(CHECKS).map(([k, c]) => [k, cronFor(c.time)])));

export const isCheck = (name) => Object.prototype.hasOwnProperty.call(CHECKS, name);

// このチェックが見る質問の投稿の日付(JST)。今は全部 dayOffset 0(同じ日)。
export function postDateFor(check, runDate) {
  if (!isCheck(check)) throw new Error(`unknown check "${check}"`);
  return addDays(runDate, -CHECKS[check].dayOffset);
}

const jstParts = (now) => {
  const iso = new Date(now.getTime() + 9 * 3600 * 1000).toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 16) };
};
export const jstDate = (now = new Date()) => jstParts(now).date;

// この実行がどのチェック・どの日(JST)のものか。
//   SLOT_INPUT   手動実行・合図(tick)の slot 入力(auto | <check>)
//   RUN_SCHEDULE github.event.schedule(起動した cron)
//   TARGET_DATE  dry-run だけの日付の上書き
export function resolveCheck(env = {}, now = new Date()) {
  const input = String(env.SLOT_INPUT ?? '').trim();
  let check;
  if (input && input !== 'auto') {
    if (!isCheck(input)) throw new Error(`unknown check "${input}" (${Object.keys(CHECKS).join('|')})`);
    check = input;
  } else if (env.RUN_SCHEDULE) {
    const hit = Object.entries(CHECK_CRONS).find(([, c]) => c === String(env.RUN_SCHEDULE).trim().replace(/\s+/g, ' '));
    if (!hit) throw new Error(`schedule "${env.RUN_SCHEDULE}" is not a reply-link check`);
    check = hit[0];
  } else {
    // 手動の auto: 今日(JST)のうち、時刻が過ぎた最後のチェック。まだ無ければ最後のチェック。
    const { time } = jstParts(now);
    const sorted = Object.entries(CHECK_TIMES).sort((a, b) => a[1].localeCompare(b[1]));
    const passed = sorted.filter(([, t]) => t <= time);
    check = (passed.at(-1) ?? sorted.at(-1))[0];
  }
  const date = env.TARGET_DATE || jstParts(now).date;
  return { check, date };
}

// ---- 返信の文(代表者が一覧を見て承認する) -------------------------------------------

const URL_RE = /https?:\/\/[^\s]+/g;
const normalize = (s) => String(s ?? '').replace(/\s+/g, '').toLowerCase();
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// 決まり(data/brand-profile.json): 未確認の断定・寄付の割合や金額・同情訴求は入れない。
const BANNED_IN_TEXT = [/すべて|全て|必ず|絶対/, /\d+\s*(%|パーセント|円)/, /障害者だから|かわいそう|支援してあげ/, /#/];

export function validateTexts(texts) {
  const errors = [];
  if (!Array.isArray(texts)) return [`${REPLY_TEXTS_PATH}: must be a list`];
  const ids = new Set();
  const bodies = new Set();
  for (const t of texts) {
    const id = t?.id ?? '(no id)';
    if (!t?.id || typeof t.id !== 'string') errors.push(`${id}: id missing`);
    else if (ids.has(t.id)) errors.push(`${id}: duplicate id`);
    ids.add(t?.id);
    if (typeof t?.text !== 'string' || !t.text.trim()) {
      errors.push(`${id}: empty text`);
      continue;
    }
    if (t.text.length > MAX_REPLY_TEXT) errors.push(`${id}: ${t.text.length} chars (max ${MAX_REPLY_TEXT})`);
    const urls = t.text.match(URL_RE) ?? [];
    if (urls.length !== 1 || urls[0] !== SHOP_URL) errors.push(`${id}: must contain the shop link ${SHOP_URL} exactly once and no other link`);
    for (const re of BANNED_IN_TEXT) if (re.test(t.text)) errors.push(`${id}: not allowed in a reply text (${re})`);
    if (bodies.has(normalize(t.text))) errors.push(`${id}: duplicate text`);
    bodies.add(normalize(t.text));
    for (const k of ['from', 'until']) if (t[k] != null && !DATE_RE.test(t[k])) errors.push(`${id}: ${k} must be YYYY-MM-DD`);
    if (t.for != null && (!Array.isArray(t.for) || !t.for.length || t.for.some((k) => !REPLY_LINK_KINDS.includes(k)))) {
      errors.push(`${id}: for must be a non-empty list of ${REPLY_LINK_KINDS.join('|')}`);
    }
    if (typeof t.approved !== 'boolean') errors.push(`${id}: approved must be true or false`);
    if (t.approved === true && (!t.approvedBy || !t.approvedAt)) errors.push(`${id}: approved without approvedBy/approvedAt`);
  }
  return errors;
}

// 文がどちらの投稿に使えるか(for)。for が無い文は質問の投稿だけ。
export const textKinds = (t) => (Array.isArray(t?.for) ? t.for : ['question']);
const usableOn = (t, date, kind) =>
  t.approved === true && (!t.from || t.from <= date) && (!t.until || date <= t.until) && textKinds(t).includes(kind);

// その日に使う文: その日・その種類(question | plain)に使える承認済みの文から、日替わりで1つ。
export function pickText(texts, date, kind = 'question') {
  const usable = (Array.isArray(texts) ? texts : []).filter((t) => usableOn(t, date, kind));
  if (!usable.length) return null;
  const n = Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${ROTATION_ANCHOR}T00:00:00Z`)) / 86400000);
  return usable[((n % usable.length) + usable.length) % usable.length];
}

// ---- どの投稿か -------------------------------------------------------------------------

// 「やることなし」で緑で終わる理由(exit 0)。それ以外は exit 1。
export const QUIET = new Set([
  'no-post-scheduled', 'not-reply-link', 'not-approved', 'not-posted-yet', 'already-replied', 'already-replied-today',
  'below-threshold', 'no-approved-text', 'dry-run',
]);

const hasApproval = (item) => Boolean(item?.approvedBy && String(item.approvedBy).trim() && item?.approvedAt);
const repliedIn = (records, pred) => (Array.isArray(records) ? records : []).some((r) => r?.reply && pred(r));
const publishedIn = (journal, pred) => J.latest(journal).some((e) => e.stage === J.PUBLISHED && pred(e));
const itemsOf = (bank) => (Array.isArray(bank) ? bank : Array.isArray(bank?.items) ? bank.items : []);
const postsOf = (posted) => (Array.isArray(posted) ? posted : Array.isArray(posted?.posts) ? posted.posts : []);

// チェックが見る質問の投稿(日本語の枠だけ)。無ければその理由。
export function selectTarget({ bank, posted, records = [], journal = [], postDate, slot }) {
  const item = itemsOf(bank).find((p) => p.targetDate === postDate && p.slot === slot && p.lang === 'ja');
  if (!item) return { post: null, reason: 'no-post-scheduled' };
  if (item.replyLink !== true) return { post: null, reason: 'not-reply-link' };
  if (!hasApproval(item)) return { post: null, reason: 'not-approved' };
  const rec = postsOf(posted).find((p) => p.sourceItemId === item.id && p.mode !== 'dry-run');
  if (!rec?.threadsPostId) return { post: null, reason: 'not-posted-yet' };
  if (repliedIn(records, (r) => r.postId === item.id) || publishedIn(journal, (e) => e.postId === item.id)) return { post: null, reason: 'already-replied' };
  if (repliedIn(records, (r) => r.date === postDate) || publishedIn(journal, (e) => e.date === postDate)) return { post: null, reason: 'already-replied-today' };
  const open = J.openEntries(journal);
  if (open.length) return { post: null, reason: 'open-claim', detail: open.map(J.describe).join(' | ') };
  return { post: item, threadsId: rec.threadsPostId, reason: null };
}

// ---- Threads API ------------------------------------------------------------------------

export async function fetchViews({ fetchImpl, token, threadsId }) {
  const url = new URL(`${GRAPH}/${threadsId}/insights`);
  url.searchParams.set('metric', 'views');
  url.searchParams.set('access_token', token);
  const res = await fetchImpl(url, { method: 'GET' });
  const body = await res.text();
  if (!res.ok) throw new Error(`insights failed (${res.status}): ${body.slice(0, 300)}`);
  const d = (JSON.parse(body).data ?? []).find((x) => x.name === 'views');
  const v = d?.total_value?.value ?? d?.values?.[0]?.value;
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error('views not in the insights answer');
  return v;
}

// 記録ファイル: 質問の投稿ごとに1件。新しい配列を返す。
export function addCheck(records, { post, threadsId, postDate, check, at, views }) {
  const list = Array.isArray(records) ? records.map((r) => ({ ...r, checks: [...(r.checks ?? [])] })) : [];
  let r = list.find((x) => x.postId === post.id);
  if (!r) {
    r = { postId: post.id, date: postDate, slot: post.slot, kind: replyLinkKindOf(post), threadsId, checks: [], reply: null };
    list.push(r);
  }
  r.checks.push({ check, at, views });
  return { list, entry: r };
}

export const HALT =
  'ACTION REQUIRED: check the post on Threads (@lost_ball_empowerartlab) for our reply, then close it with ' +
  'node scripts/reply-link-resolve.mjs --id <postId> --outcome published|not-published [--reply-id ID] --by <name> --yes. ' +
  'Reply links stay halted until then (the main posts are not affected).';

/**
 * 1回のチェック。
 *   check, runDate  resolveCheck() の結果
 *   live            本番のときだけ true(workflow と scripts/reply-link.mjs が決める)
 * 戻り値: { code, stage|reason, ... }
 */
export async function runReplyLink({
  io, git, branch, check, runDate, live, token, userId, runId, runAttempt, now, sleep, fetchImpl, log, errLog,
  minViews = MIN_VIEWS,
}) {
  const { slot } = CHECKS[check] ?? {};
  if (!slot) {
    errLog(`unknown check "${check}"`);
    return { code: 1, reason: 'unknown-check' };
  }
  const postDate = postDateFor(check, runDate);
  log(`reply-link check=${check} postDate=${postDate} slot=${slot} mode=${live ? 'LIVE' : 'dry-run'} threshold=${minViews}`);

  const bank = await io.readJson(BANK_PATH, { items: [] });
  const posted = await io.readJson(POSTED_PATH, { posts: [] });
  const records = await io.readJson(REPLY_RECORDS_PATH, []);
  const journal = await io.readJson(REPLY_JOURNAL_PATH, []);
  const texts = await io.readJson(REPLY_TEXTS_PATH, []);

  const target = selectTarget({ bank, posted, records, journal, postDate, slot });
  if (!target.post) {
    log(`nothing to do: ${target.reason}${target.detail ? ` (${target.detail})` : ''}`);
    if (target.reason === 'open-claim') errLog(HALT);
    return { code: QUIET.has(target.reason) ? 0 : 1, reason: target.reason };
  }
  const { post, threadsId } = target;

  const textErrors = validateTexts(texts);
  if (textErrors.length) {
    errLog(`${REPLY_TEXTS_PATH} has errors, not replying:\n${textErrors.join('\n')}`);
    return { code: 1, reason: 'bad-texts' };
  }
  const kind = replyLinkKindOf(post);
  const chosen = pickText(texts, postDate, kind);
  if (!chosen) {
    log(`::warning title=Reply link::no approved reply text for ${postDate} (${kind} post); nothing is posted (approve the list in ${REPLY_TEXTS_PATH})`);
    return { code: 0, reason: 'no-approved-text' };
  }
  log(`post=${post.id} (${kind}) threadsId=${threadsId}\nreply text=${chosen.id}\n---\n${chosen.text}\n---`);

  if (!token || !userId) {
    if (live) {
      errLog('THREADS_ACCESS_TOKEN / THREADS_USER_ID are not set');
      return { code: 1, reason: 'missing-credentials' };
    }
    log('dry-run: no token, views not checked; nothing written or posted');
    return { code: 0, reason: 'dry-run' };
  }
  const redact = createSecretRedactor([token, userId]);

  let views;
  try {
    views = await fetchViews({ fetchImpl, token, threadsId });
  } catch (err) {
    errLog(`cannot read views for ${post.id}: ${redact(err.message)}; not replying`);
    return { code: live ? 1 : 0, reason: 'views-unavailable' };
  }
  const at = now();
  const reach = views >= minViews;
  log(`views=${views} at ${at} -> ${reach ? `>= ${minViews}: reply` : `< ${minViews}: no reply this time`}`);

  if (!live) {
    log('dry-run: nothing written or posted');
    return { code: 0, reason: 'dry-run', views, wouldReply: reach };
  }

  const push = (files, message, extra = {}) =>
    pushAndVerify({ run: git, branch, files, path: REPLY_JOURNAL_PATH, message, attempts: PUSH_ATTEMPTS, sleep, ...extra });

  // チェック(時刻・表示)を分析用に残す。ベストエフォート: 残せなくても他は何も変わらない。
  const saveCheck = async () => {
    try {
      const { list } = addCheck(await io.readJson(REPLY_RECORDS_PATH, []), { post, threadsId, postDate, check, at, views });
      await io.writeJson(REPLY_RECORDS_PATH, list);
      await push([REPLY_RECORDS_PATH], `chore(lostball): reply-link check ${post.id} ${check} views=${views}`);
      return true;
    } catch (err) {
      errLog(`check record not saved (${err.message}); continuing`);
      return false;
    }
  };

  if (!reach) {
    await saveCheck();
    return { code: 0, reason: 'below-threshold', views };
  }

  // 先に GitHub 上に予約。GitHub の状態が少しでも怪しければ返信しない。
  let before;
  try {
    before = await remoteJournal({ run: git, branch, path: REPLY_JOURNAL_PATH });
  } catch (err) {
    errLog(`cannot read ${REPLY_JOURNAL_PATH} on the remote (${err.message}); not replying`);
    return { code: 1, reason: 'remote-unreadable' };
  }
  const again = selectTarget({ bank, posted, records, journal: before, postDate, slot });
  if (!again.post) {
    log(`remote says nothing to do: ${again.reason}`);
    if (again.reason === 'open-claim') errLog(HALT);
    return { code: QUIET.has(again.reason) ? 0 : 1, reason: again.reason };
  }
  const note = `check=${check} views=${views} text=${chosen.id}`;
  const claim = J.event({ postId: post.id, date: postDate, stage: J.CLAIMED, runId, runAttempt, at, threadsId, note });
  await io.writeJson(REPLY_JOURNAL_PATH, [...before, claim]);
  let landed;
  try {
    landed = await push([REPLY_JOURNAL_PATH], `chore(lostball): claim reply-link ${post.id} (${check} views=${views})`, {
      guard: (remote) => {
        if (J.blockers(remote).length) throw new Error('another run holds an open reply-link claim');
        if (J.latest(remote).some((e) => e.stage === J.PUBLISHED && (e.postId === post.id || e.date === postDate))) throw new Error('a reply link was already posted');
      },
    });
  } catch (err) {
    errLog(`claim NOT persisted (${err.message}); not replying`);
    return { code: 1, reason: 'claim-not-persisted' };
  }
  const open = J.openClaimsFor(landed, post.id);
  if (open.length !== 1 || !J.sameRun(open[0], claim)) {
    errLog(`claim ambiguous on the remote (open claims=${open.length}); not replying`);
    return { code: 1, reason: 'claim-ambiguous' };
  }

  const call = async (path, params, method = 'POST') => {
    const url = new URL(`${GRAPH}/${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    url.searchParams.set('access_token', token);
    const res = await fetchImpl(url, { method });
    const body = await res.text();
    if (!res.ok) throw new Error(`${path.replace(userId, '<user>')} failed (${res.status}): ${redact(body)}`);
    return JSON.parse(body);
  };
  const close = async (stage, extra = {}) => {
    const entry = J.event({ postId: post.id, date: postDate, stage, runId, runAttempt, at: now(), ...extra });
    try {
      const j = await remoteJournal({ run: git, branch, path: REPLY_JOURNAL_PATH });
      await io.writeJson(REPLY_JOURNAL_PATH, [...j, entry]);
      await push([REPLY_JOURNAL_PATH], `chore(lostball): reply-link ${stage} ${post.id}`);
      return true;
    } catch (err) {
      errLog(`reply journal NOT updated (${err.message}); the open claim keeps reply links halted: ${J.describe(entry)}`);
      return false;
    }
  };

  let container;
  try {
    container = await call(`${userId}/threads`, { media_type: 'TEXT', text: chosen.text, reply_to_id: threadsId });
  } catch (err) {
    errLog(`step=container-failed postId=${post.id}: ${redact(err.message)}`);
    await close(J.ABORTED, { note: `reply container failed; nothing was posted (${note})` });
    return { code: 1, stage: J.ABORTED };
  }
  await sleep(30_000);

  let published;
  try {
    published = await call(`${userId}/threads_publish`, { creation_id: container.id });
  } catch (err) {
    errLog(`step=publish-unknown postId=${post.id} containerId=${container.id}: ${redact(err.message)}`);
    await close(J.UNKNOWN, { note: `reply publish result unknown (containerId=${container.id}; ${note})` });
    errLog(HALT);
    return { code: 1, stage: J.UNKNOWN };
  }

  const repliedAt = now();
  log(`replied: postId=${post.id} replyId=${published.id} views=${views} check=${check}`);
  const entry = J.event({ postId: post.id, date: postDate, stage: J.PUBLISHED, runId, runAttempt, at: repliedAt, threadsId: published.id, note });
  try {
    const j = await remoteJournal({ run: git, branch, path: REPLY_JOURNAL_PATH });
    const { list, entry: rec } = addCheck(await io.readJson(REPLY_RECORDS_PATH, []), { post, threadsId, postDate, check, at, views });
    rec.reply = { replyId: published.id, at: repliedAt, check, views, textId: chosen.id, text: chosen.text };
    await io.writeJson(REPLY_RECORDS_PATH, list);
    await io.writeJson(REPLY_JOURNAL_PATH, [...j, entry]);
    await push([REPLY_JOURNAL_PATH, REPLY_RECORDS_PATH], `chore(lostball): record reply-link ${post.id} (${check} views=${views})`);
  } catch (err) {
    errLog(`RECORD NOT PERSISTED (${err.message})`);
    errLog(`recover: node scripts/reply-link-resolve.mjs --id ${post.id} --outcome published --reply-id ${published.id} --by <name> --yes`);
    errLog(HALT);
    return { code: 1, stage: 'record-not-persisted', replyId: published.id };
  }
  return { code: 0, stage: J.PUBLISHED, replyId: published.id, views };
}

// 人が Threads を見たあとに、開いた記録を閉じる(scripts/reply-link-resolve.mjs)。
export async function runReplyResolve({ io, id, outcome, replyId, by, now, log }) {
  const journal = await io.readJson(REPLY_JOURNAL_PATH, []);
  const target = J.openEntries(journal).find((e) => e.postId === id);
  if (!target) {
    log(`nothing open for ${id}`);
    return { code: 1, reason: 'not-open' };
  }
  const published = outcome === 'published';
  const entry = J.event({
    postId: id, date: target.date, stage: published ? J.PUBLISHED : J.RESOLVED,
    runId: `resolved-by:${by}`, runAttempt: '1', at: now(), threadsId: published ? (replyId ?? null) : null,
    note: published ? 'reply confirmed on Threads by a human' : 'reply confirmed not posted by a human',
  });
  await io.writeJson(REPLY_JOURNAL_PATH, [...journal, entry]);
  if (published) {
    const records = await io.readJson(REPLY_RECORDS_PATH, []);
    const views = Number(/views=(\d+)/.exec(target.note ?? '')?.[1] ?? NaN);
    const check = /check=(\S+)/.exec(target.note ?? '')?.[1] ?? null;
    const textId = /text=([^\s);]+)/.exec(target.note ?? '')?.[1] ?? null;
    let r = records.find((x) => x.postId === id);
    if (!r) {
      r = { postId: id, date: target.date, slot: CHECKS[check]?.slot ?? null, threadsId: target.threadsId ?? null, checks: [], reply: null };
      records.push(r);
    }
    if (!r.reply) r.reply = { replyId: replyId ?? null, at: target.at, check, views: Number.isFinite(views) ? views : null, textId, recoveredBy: by };
    await io.writeJson(REPLY_RECORDS_PATH, records);
  }
  log(`resolved: ${J.describe(entry)}`);
  log(`commit and push ${REPLY_JOURNAL_PATH} and ${REPLY_RECORDS_PATH}, or reply links stay halted.`);
  return { code: 0, entry };
}
