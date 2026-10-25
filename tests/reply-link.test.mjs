// 返信でリンク(lib/reply-link.mjs、scripts/run-gate.mjs --media reply-link、
// .github/workflows/reply-link.yml)。メモリ上のファイル・偽の git・偽の Threads API だけを使う
// (ネットワークにもリポジトリにも触れない)。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  CHECKS, CHECK_TIMES, CHECK_CRONS, MIN_VIEWS, SHOP_URL, REPLY_TEXTS_PATH, REPLY_JOURNAL_PATH, REPLY_RECORDS_PATH,
  BANK_PATH, POSTED_PATH, resolveCheck, postDateFor, validateTexts, pickText, selectTarget, runReplyLink, runReplyResolve,
} from "../lib/reply-link.mjs";
import { validateBankSlots, replyLinkErrors, RUNS } from "../lib/slots.mjs";
import { promoteCandidate } from "../lib/approval-gate.mjs";
import { formatBulkList } from "../lib/bulk-approve.mjs";
import { THREADS_JOURNAL_PATH } from "../lib/threads-claim.mjs";
import { planGate } from "../scripts/run-gate.mjs";
import * as J from "../lib/ig-journal.mjs";

const TOKEN = "TOKEN-must-never-appear";
const USER = "USERID-must-never-appear";
const D = "2026-10-28";
const clone = (v) => JSON.parse(JSON.stringify(v));
const at = (date, hhmm, plusMin = 0) => new Date(Date.parse(`${date}T${hhmm}:00+09:00`) + plusMin * 60000);

const JA = {
  morning: "日本のロストボールを、1球ずつ手で確かめて、磨いています。",
  noon: "ボールを1つ買うことが、福祉施設で働く人の磨く仕事につながっていきます。",
  night: "池の多いコースだと、つい多めに入れたくなりますよね。\nみなさんは、いつも何球持っていきますか。",
};
const item = (slot, lang = "ja", extra = {}) => ({
  id: `lb-${D}-${slot}-${lang}`, targetDate: D, slot, lang, pillar: "GOLF", category: "TEST",
  bodyEn: `English ${slot}`, bodyJa: lang === "ja" ? JA[slot] : `英語の${slot}の訳`,
  approvedBy: "KEITA", approvedAt: "2026-10-25T00:00:00.000Z", media: { type: "TEXT_ONLY" }, ...extra,
});
const bankOf = () => ({ items: [item("morning"), item("noon"), item("night", "ja", { replyLink: true }), item("night", "en")] });
const postedOf = () => ({ posts: [
  { sourceItemId: `lb-${D}-night-ja`, threadsPostId: "parent-1", mode: "live", lang: "ja", slot: "night", targetDate: D },
  { sourceItemId: `lb-${D}-night-en`, threadsPostId: "parent-en", mode: "live", lang: "en", slot: "night", targetDate: D },
] });
const approvedFields = (approved) => (approved ? { approved: true, approvedBy: "KEITA", approvedAt: "x" } : { approved: false });
const replyTexts = (approved = true) => [
  { id: "a", text: `1球ずつ手で磨いたロストボールは、ここから。\n${SHOP_URL}`, ...approvedFields(approved) },
  { id: "b", text: `お店は、ここから。\n${SHOP_URL}`, ...approvedFields(approved) },
];

// ---- 時刻 ---------------------------------------------------------------------------

test("5回のチェック: 朝・昼は約2時間後と約6時間後、夜は約2時間後だけ。英語は対象外", () => {
  assert.deepEqual(CHECK_TIMES, {
    morning_2h: "09:35", morning_6h: "13:35", noon_2h: "14:35", noon_6h: "18:35", night_2h: "22:35",
  });
  assert.ok(!("night_6h" in CHECKS));
  for (const c of Object.values(CHECKS)) assert.equal(c.dayOffset, 0);
  // 枠の時刻は lib/slots.mjs の日本語の枠と同じ。
  for (const [name, c] of Object.entries(CHECKS)) {
    const run = RUNS.find((r) => r.slot === c.slot && r.lang === "ja");
    const [h, m] = run.time.split(":").map(Number);
    const t = h * 60 + m + c.after;
    assert.equal(CHECK_TIMES[name], `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`);
  }
  assert.equal(postDateFor("night_2h", D), D);
});

test("resolveCheck: cron・入力・auto で決まる。知らない名前は失敗", () => {
  assert.deepEqual(resolveCheck({ RUN_SCHEDULE: "35 13 * * *" }, at(D, "22:36")), { check: "night_2h", date: D });
  assert.deepEqual(resolveCheck({ RUN_SCHEDULE: "35 0 * * *" }, at(D, "09:40")), { check: "morning_2h", date: D });
  assert.deepEqual(resolveCheck({ SLOT_INPUT: "noon_2h" }, at(D, "14:40")), { check: "noon_2h", date: D });
  assert.deepEqual(resolveCheck({ SLOT_INPUT: "auto" }, at(D, "19:00")), { check: "noon_6h", date: D });
  assert.equal(resolveCheck({ SLOT_INPUT: "auto", TARGET_DATE: "2026-10-29" }, at(D, "10:00")).date, "2026-10-29");
  assert.throws(() => resolveCheck({ SLOT_INPUT: "night_6h" }));
  assert.throws(() => resolveCheck({ RUN_SCHEDULE: "35 11 * * *" })); // ふだんの夜の投稿の cron
});

test("workflow: cron・tick の入力・本番のスイッチ・専用の記録", () => {
  const yml = readFileSync(".github/workflows/reply-link.yml", "utf8");
  const crons = [...yml.matchAll(/^\s*-\s*cron:\s*"([^"]+)"/gm)].map((m) => m[1]).sort();
  assert.deepEqual(crons, Object.values(CHECK_CRONS).sort());
  const opts = yml.match(/options: \[auto, ([^\]]+)\]/)[1].split(",").map((s) => s.trim());
  assert.deepEqual(opts.sort(), Object.keys(CHECKS).sort());
  for (const input of ["mode", "slot", "date", "tick_id"]) assert.match(yml, new RegExp(`\\n      ${input}:\\n`));
  assert.match(yml, /options: \[dry-run, live, tick\]/);
  assert.match(yml, /default: dry-run/);
  assert.match(yml, /^run-name:.*inputs\.tick_id/m);
  assert.match(yml, /LIVE_REPLY: \$\{\{ vars\.REPLY_LINK_ENABLED == 'true' &&/);
  assert.match(yml, /LIVE_POST: \$\{\{ secrets\.LIVE_POST \}\}/);
  assert.match(yml, /run-gate\.mjs --media reply-link/);
  assert.match(yml, /group: lostball-reply-link\s*\n\s*cancel-in-progress: false/);
  assert.doesNotMatch(yml, /threads-journal|threads-posts\.json|post-to-threads|push-records|CLIENT_SECRET/);
  // ふだんの投稿の cron とは重ならない。
  const main = readFileSync(".github/workflows/daily-live-post.yml", "utf8");
  for (const c of crons) assert.ok(!main.includes(`cron: "${c}"`), c);
});

// ---- 返信の文 ---------------------------------------------------------------------------

test("返信の文: お店のリンクがちょうど1つ・ほかのリンクなし・承認には誰がいつが必要", () => {
  assert.deepEqual(validateTexts(replyTexts()), []);
  const bad = validateTexts([
    { id: "a", text: "お店はプロフィールから", approved: false },
    { id: "b", text: `${SHOP_URL}\n${SHOP_URL}`, approved: false },
    { id: "c", text: `${SHOP_URL} https://example.com`, approved: false },
    { id: "d", text: `x ${SHOP_URL}`, approved: true },
    { id: "e", text: `y ${SHOP_URL}`, from: "10/31", approved: false },
    { id: "f", text: `必ず飛ぶ ${SHOP_URL}`, approved: false },
    { id: "g", text: `z ${SHOP_URL}` },
  ]);
  assert.equal(bad.length, 7, bad.join("\n"));
});

test("data/reply-link-texts.json: 正しい形で5本・すべて未承認(承認は代表者が行う)・お店のURLは brand-profile と同じ", () => {
  const texts = JSON.parse(readFileSync(REPLY_TEXTS_PATH, "utf8"));
  assert.deepEqual(validateTexts(texts), []);
  assert.equal(texts.length, 5);
  for (const t of texts) {
    assert.equal(t.approved, false, `${t.id} は未承認のまま入れる`);
    assert.ok(!t.approvedBy && !t.approvedAt);
    assert.ok(t.text.includes(SHOP_URL));
    assert.ok(t.text.length <= 80, `${t.id} は短く`);
  }
  assert.equal(pickText(texts, D), null, "未承認のうちは1本も返信しない");
  const brand = JSON.parse(readFileSync("data/brand-profile.json", "utf8"));
  assert.equal(SHOP_URL, brand.account.shopUrl);
  // 承認したら、5日続けて違う文になる。
  const all = texts.map((t) => ({ ...t, approved: true, approvedBy: "K", approvedAt: "x" }));
  const days = ["2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31"].map((d) => pickText(all, d).id);
  assert.equal(new Set(days).size, 5);
});

test("pickText: 承認済み・期間内だけ、日替わり", () => {
  assert.equal(pickText(replyTexts(false), D), null);
  const t = [...replyTexts(), { id: "c", until: "2026-10-30", text: `c ${SHOP_URL}`, approved: true, approvedBy: "K", approvedAt: "x" }];
  const ids = ["2026-10-27", "2026-10-28", "2026-10-29"].map((d) => pickText(t, d).id);
  assert.equal(new Set(ids).size, 3, ids.join());
  assert.ok(["a", "b"].includes(pickText(t, "2026-11-01").id));
  assert.equal(pickText(t, D).id, pickText(t, D).id);
});

// ---- draft-bank の印 -----------------------------------------------------------------

test("replyLink の印: 日本語の枠だけ・本文にリンクなし・1日1本まで", () => {
  assert.deepEqual(replyLinkErrors(bankOf().items), []);
  assert.deepEqual(validateBankSlots(bankOf().items).errors.filter((e) => /replyLink/.test(e)), []);
  const withLink = bankOf().items.map((p) => (p.replyLink ? { ...p, bodyJa: `${p.bodyJa}\nempower.base.shop` } : p));
  assert.match(replyLinkErrors(withLink).join(), /本文にリンクは入れません/);
  const two = bankOf().items.map((p) => (p.slot === "noon" ? { ...p, replyLink: true } : p));
  assert.match(replyLinkErrors(two).join(), /1日1本まで/);
  assert.match(replyLinkErrors([item("night", "en", { replyLink: true })]).join(), /日本語の朝・昼・夜の枠の投稿だけ/);
  assert.match(replyLinkErrors([{ id: "old", targetDate: "2026-10-11", bodyJa: "q", replyLink: true }]).join(), /日本語の朝・昼・夜/);
  assert.match(replyLinkErrors([item("night", "ja", { replyLink: "yes" })]).join(), /true か false/);
  assert.match(validateBankSlots(two).errors.join(), /1日1本まで/);
});

test("今の data/draft-bank.json は replyLink のルールを満たす", () => {
  const bank = JSON.parse(readFileSync(BANK_PATH, "utf8"));
  assert.deepEqual(replyLinkErrors(bank.items), []);
});

test("承認(promoteCandidate)で replyLink を引き継ぎ、土曜の一覧に印が出る", () => {
  const approval = { approved: true, approvedBy: "KEITA", approvedAt: "t" };
  assert.equal(promoteCandidate(item("night", "ja", { replyLink: true }), approval).replyLink, true);
  assert.ok(!("replyLink" in promoteCandidate(item("noon"), approval)));
  const out = formatBulkList({ dates: [D], rows: [], bankItems: bankOf().items });
  assert.match(out, /↩️ 質問の投稿/);
  assert.equal(out.split("↩️").length - 1, 1);
});

// ---- どの投稿か ------------------------------------------------------------------------

test("selectTarget の理由", () => {
  const base = { bank: bankOf(), posted: postedOf(), postDate: D };
  assert.equal(selectTarget({ ...base, slot: "night" }).threadsId, "parent-1");
  assert.equal(selectTarget({ ...base, slot: "noon" }).reason, "not-reply-link");
  assert.equal(selectTarget({ ...base, slot: "night", posted: { posts: [] } }).reason, "not-posted-yet");
  assert.equal(selectTarget({ ...base, slot: "night", bank: { items: [] } }).reason, "no-post-scheduled");
  const unapproved = { items: bankOf().items.map((p) => (p.replyLink ? { ...p, approvedBy: "" } : p)) };
  assert.equal(selectTarget({ ...base, slot: "night", bank: unapproved }).reason, "not-approved");
  assert.equal(selectTarget({ ...base, slot: "night", records: [{ postId: `lb-${D}-night-ja`, date: D, reply: { replyId: "r" } }] }).reason, "already-replied");
  assert.equal(selectTarget({ ...base, slot: "night", records: [{ postId: "other", date: D, reply: { replyId: "r" } }] }).reason, "already-replied-today");
  const pub = J.event({ postId: `lb-${D}-night-ja`, date: D, stage: J.PUBLISHED, runId: "1", runAttempt: "1", at: "t" });
  assert.equal(selectTarget({ ...base, slot: "night", journal: [pub] }).reason, "already-replied");
  const open = J.event({ postId: "lb-x", date: "2026-10-27", stage: J.UNKNOWN, runId: "1", runAttempt: "1", at: "t" });
  assert.equal(selectTarget({ ...base, slot: "night", journal: [open] }).reason, "open-claim");
});

// ---- 流れ ------------------------------------------------------------------------------

function harness({ views = 450, api = {}, texts = replyTexts(), journal = [], records = [], pushes = [] } = {}) {
  const local = {
    [BANK_PATH]: bankOf(), [POSTED_PATH]: postedOf(), [REPLY_TEXTS_PATH]: clone(texts),
    [REPLY_JOURNAL_PATH]: clone(journal), [REPLY_RECORDS_PATH]: clone(records), [THREADS_JOURNAL_PATH]: [],
  };
  const remote = { [REPLY_JOURNAL_PATH]: clone(journal), [REPLY_RECORDS_PATH]: clone(records), [THREADS_JOURNAL_PATH]: [] };
  let staged = [];
  const out = [];
  const calls = [];
  const io = {
    async readJson(path, fallback) {
      if (!(path in local)) {
        if (fallback !== undefined) return fallback;
        throw new Error(`ENOENT ${path}`);
      }
      return clone(local[path]);
    },
    async writeJson(path, value) { local[path] = clone(value); },
  };
  const git = async (args) => {
    const [cmd] = args;
    if (cmd === "fetch" || cmd === "commit" || cmd === "pull") return "";
    if (cmd === "show") {
      const path = args[1].split(":")[1];
      if (!(path in remote)) throw new Error("no such path");
      return JSON.stringify(remote[path]);
    }
    if (cmd === "add") {
      staged = args.slice(2).filter((p) => JSON.stringify(local[p]) !== JSON.stringify(remote[p] ?? null));
      return "";
    }
    if (cmd === "diff") return staged.join("\n");
    if (cmd === "push") {
      const b = pushes.length ? pushes.shift() : "ok";
      if (b === "fail") throw new Error("fatal: unable to access remote");
      for (const p of staged) remote[p] = clone(local[p]);
      staged = [];
      return "";
    }
    throw new Error(`unexpected git ${args.join(" ")}`);
  };
  const fetchImpl = async (url, opts = {}) => {
    const u = new URL(String(url));
    const step = u.pathname.endsWith("/insights") ? "views" : u.pathname.endsWith("/threads_publish") ? "publish" : "container";
    calls.push({ step, method: opts.method, path: u.pathname, params: Object.fromEntries([...u.searchParams].filter(([k]) => k !== "access_token")) });
    const b = api[step] ?? "ok";
    if (b === "error") return { ok: false, status: 500, text: async () => `no, access_token=${TOKEN} user=${USER}` };
    if (b === "throw") throw new Error(`network reset (${step})`);
    if (step === "views") return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ name: "views", values: [{ value: views }] }] }) };
    return { ok: true, status: 200, text: async () => JSON.stringify({ id: step === "publish" ? "reply-999" : "container-1" }) };
  };
  let n = 0;
  const run = (over = {}) => runReplyLink({
    io, git, branch: "main", check: "night_2h", runDate: D, live: true, token: TOKEN, userId: USER,
    runId: "run-1", runAttempt: "1", now: () => `2026-10-28T13:3${n++ % 10}:00.000Z`, sleep: async () => {}, fetchImpl,
    log: (m) => out.push(String(m)), errLog: (m) => out.push(String(m)), ...over,
  });
  return { run, local, remote, out, calls, io };
}

test("表示300以上: 予約してから、質問の投稿に返信を1回だけ。時刻と表示を記録", async () => {
  const h = harness({ views: 450 });
  const r = await h.run();
  assert.equal(r.code, 0);
  assert.equal(r.stage, J.PUBLISHED);
  assert.deepEqual(h.calls.map((c) => c.step), ["views", "container", "publish"]);
  assert.match(h.calls[0].path, /\/parent-1\/insights$/);
  const c = h.calls[1].params;
  assert.equal(c.reply_to_id, "parent-1");
  assert.equal(c.media_type, "TEXT");
  assert.ok(c.text.includes(SHOP_URL));
  const rec = h.remote[REPLY_RECORDS_PATH][0];
  assert.equal(rec.postId, `lb-${D}-night-ja`);
  assert.equal(rec.reply.replyId, "reply-999");
  assert.equal(rec.reply.views, 450);
  assert.equal(rec.reply.check, "night_2h");
  assert.ok(rec.reply.at);
  assert.deepEqual(J.openEntries(h.remote[REPLY_JOURNAL_PATH]), []);
  assert.deepEqual(h.remote[THREADS_JOURNAL_PATH], [], "ふだんの投稿の記録には触れない");
  assert.deepEqual(h.local[POSTED_PATH], postedOf(), "threads-posts.json も変えない");
  assert.ok(!h.out.join("\n").includes(TOKEN) && !h.out.join("\n").includes(USER));
});

test("同じ日の2回目のチェックは何もしない(1つの投稿に1回・1日1回)", async () => {
  const bank = { items: [item("morning", "ja", { replyLink: true }), item("noon"), item("night"), item("night", "en")] };
  const posted = { posts: [{ sourceItemId: `lb-${D}-morning-ja`, threadsPostId: "parent-m", mode: "live" }] };
  const h = harness({ views: 500 });
  h.local[BANK_PATH] = bank;
  h.local[POSTED_PATH] = posted;
  assert.equal((await h.run({ check: "morning_2h" })).stage, J.PUBLISHED);
  h.local[REPLY_JOURNAL_PATH] = clone(h.remote[REPLY_JOURNAL_PATH]);
  const again = await h.run({ check: "morning_6h" });
  assert.equal(again.code, 0);
  assert.equal(again.reason, "already-replied");
  assert.equal(h.calls.length, 3);
});

test("表示300未満: 返信しない。チェック(時刻・表示)は分析用に残す", async () => {
  const h = harness({ views: 120 });
  const r = await h.run();
  assert.equal(r.reason, "below-threshold");
  assert.equal(r.code, 0);
  assert.deepEqual(h.calls.map((c) => c.step), ["views"]);
  assert.deepEqual(h.remote[REPLY_RECORDS_PATH][0].checks.map((x) => x.views), [120]);
  assert.equal(h.remote[REPLY_RECORDS_PATH][0].reply, null);
  assert.deepEqual(h.remote[REPLY_JOURNAL_PATH], []);
});

test("しきい値は MIN_VIEWS(300)ちょうどを含む", async () => {
  assert.equal(MIN_VIEWS, 300);
  assert.equal((await harness({ views: 299 }).run()).reason, "below-threshold");
  assert.equal((await harness({ views: 300 }).run()).stage, J.PUBLISHED);
});

test("dry-run: 表示は見るが、書かない・返信しない", async () => {
  const h = harness({ views: 999 });
  const r = await h.run({ live: false });
  assert.equal(r.code, 0);
  assert.equal(r.wouldReply, true);
  assert.deepEqual(h.calls.map((c) => c.step), ["views"]);
  assert.deepEqual(h.remote[REPLY_JOURNAL_PATH], []);
  assert.deepEqual(h.local[REPLY_RECORDS_PATH], []);
  const noToken = harness();
  assert.equal((await noToken.run({ live: false, token: undefined })).reason, "dry-run");
  assert.equal(noToken.calls.length, 0);
});

test("承認済みの文が無い: 何も返信せず、緑で終わる(今のデータはこの状態)", async () => {
  const h = harness({ texts: replyTexts(false) });
  const r = await h.run();
  assert.equal(r.code, 0);
  assert.equal(r.reason, "no-approved-text");
  assert.equal(h.calls.length, 0);
});

test("印の無い枠・まだ投稿されていない: 静かに終わり、API を呼ばない", async () => {
  const h = harness();
  assert.equal((await h.run({ check: "noon_2h" })).reason, "not-reply-link");
  h.local[POSTED_PATH] = { posts: [] };
  assert.equal((await h.run()).reason, "not-posted-yet");
  assert.equal(h.calls.length, 0);
});

test("表示が読めない: 返信しない(本番は失敗で終わる。ほかは何も変わらない)", async () => {
  const h = harness({ api: { views: "error" } });
  const r = await h.run();
  assert.equal(r.reason, "views-unavailable");
  assert.equal(r.code, 1);
  assert.deepEqual(h.calls.map((c) => c.step), ["views"]);
  assert.ok(!h.out.join("\n").includes(TOKEN));
});

test("予約を push できない: 返信しない", async () => {
  const h = harness({ pushes: ["fail", "fail", "fail", "fail", "fail"] });
  const r = await h.run();
  assert.equal(r.reason, "claim-not-persisted");
  assert.ok(!h.calls.some((c) => c.step === "container"));
});

test("返信のコンテナ作成に失敗: aborted で閉じる(次のチェックでまた試せる)", async () => {
  const h = harness({ api: { container: "error" } });
  const r = await h.run();
  assert.equal(r.stage, J.ABORTED);
  assert.deepEqual(J.openEntries(h.remote[REPLY_JOURNAL_PATH]), []);
  const all = h.out.join("\n");
  assert.ok(!all.includes(TOKEN) && !all.includes(USER));
});

test("公開の結果が不明: 返信の仕組みだけ止まり、人が閉じるまで待つ。ふだんの投稿の記録は触らない", async () => {
  const h = harness({ api: { publish: "throw" } });
  const r = await h.run();
  assert.equal(r.stage, J.UNKNOWN);
  assert.equal(J.openEntries(h.remote[REPLY_JOURNAL_PATH]).length, 1);
  assert.deepEqual(h.remote[THREADS_JOURNAL_PATH], []);
  h.local[REPLY_JOURNAL_PATH] = clone(h.remote[REPLY_JOURNAL_PATH]);
  const next = await h.run({ check: "morning_2h" });
  assert.equal(next.reason, "not-reply-link"); // 印の無い枠はそもそも見ない
  const blocked = await h.run();
  assert.equal(blocked.reason, "open-claim");
  assert.equal(blocked.code, 1);
  const log = [];
  const res = await runReplyResolve({ io: h.io, id: `lb-${D}-night-ja`, outcome: "published", replyId: "reply-555", by: "KEITA", now: () => "t", log: (m) => log.push(m) });
  assert.equal(res.code, 0);
  assert.deepEqual(J.openEntries(h.local[REPLY_JOURNAL_PATH]), []);
  const rec = h.local[REPLY_RECORDS_PATH].find((x) => x.postId === `lb-${D}-night-ja`);
  assert.equal(rec.reply.replyId, "reply-555");
  assert.equal(rec.reply.views, 450);
  assert.equal(rec.reply.textId, pickText(replyTexts(), D).id);
  assert.equal(rec.slot, "night");
});

test("別の実行がすでに返信していた(GitHub 上): 予約の確認で止まる", async () => {
  const pub = J.event({ postId: `lb-${D}-night-ja`, date: D, stage: J.PUBLISHED, runId: "other", runAttempt: "1", at: "t", threadsId: "reply-1" });
  const h = harness();
  h.remote[REPLY_JOURNAL_PATH] = [pub]; // 手元のチェックアウトは古い
  const r = await h.run();
  assert.equal(r.reason, "already-replied");
  assert.ok(!h.calls.some((c) => c.step === "container"));
});

// ---- run gate ----------------------------------------------------------------------

const memIo = (files) => ({
  async readJson(path, fallback) {
    if (path in files) return clone(files[path]);
    if (fallback !== undefined) return fallback;
    throw new Error(`ENOENT ${path}`);
  },
  async writeJson() { throw new Error("the gate must not write"); },
});
const gateFiles = () => ({ [BANK_PATH]: bankOf(), [POSTED_PATH]: postedOf(), [REPLY_JOURNAL_PATH]: [], [REPLY_RECORDS_PATH]: [] });
const tickEnv = (slot, date = D, over = {}) => ({ GITHUB_EVENT_NAME: "workflow_dispatch", RUN_MODE: "tick", TICK_SLOT: slot, TICK_DATE: date, GITHUB_RUN_ATTEMPT: "1", RUN_SLOT: slot, RUN_DATE: date, ...over });

test("gate: 質問の投稿のチェックの合図は動く。ほかのチェックは緑で飛ばす", async () => {
  const go = await planGate({ media: "reply-link", env: tickEnv("night_2h"), now: at(D, "22:35"), io: memIo(gateFiles()) });
  assert.equal(go.go, true, go.detail);
  const other = await planGate({ media: "reply-link", env: tickEnv("noon_2h"), now: at(D, "14:35"), io: memIo(gateFiles()) });
  assert.equal(other.go, false);
  assert.equal(other.reason, "not-reply-link");
  const late = await planGate({ media: "reply-link", env: tickEnv("night_2h"), now: at(D, "22:35", 61), io: memIo(gateFiles()) });
  assert.equal(late.reason, "too-late");
  const night6 = await planGate({ media: "reply-link", env: tickEnv("night_6h"), now: at(D, "02:35"), io: memIo(gateFiles()) });
  assert.equal(night6.reason, "unknown-slot");
  const rerun = await planGate({ media: "reply-link", env: tickEnv("night_2h", D, { GITHUB_RUN_ATTEMPT: "2" }), now: at(D, "22:35"), io: memIo(gateFiles()) });
  assert.equal(rerun.reason, "not-first-attempt");
});

test("gate: schedule の実行はいつも時刻の範囲を当てる(SCHEDULE_LATE_SKIP が無くても)", async () => {
  const env = { GITHUB_EVENT_NAME: "schedule", RUN_SLOT: "night_2h", RUN_DATE: D };
  assert.equal((await planGate({ media: "reply-link", env, now: at(D, "22:40") })).go, true);
  const late = await planGate({ media: "reply-link", env, now: at(D, "22:35", 90) });
  assert.equal(late.go, false);
  assert.equal(late.reason, "too-late");
  // ふだんの Threads の schedule は今までどおり(SCHEDULE_LATE_SKIP が無ければ範囲を当てない)。
  const main = await planGate({ media: "threads", env: { GITHUB_EVENT_NAME: "schedule", RUN_SLOT: "night", RUN_DATE: D }, now: at(D, "20:35", 90) });
  assert.equal(main.go, true);
});
