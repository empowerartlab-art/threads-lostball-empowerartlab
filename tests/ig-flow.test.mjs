// Instagram 自動投稿(lib/ig-flow.mjs)のテスト。ネットワーク・git・実ファイルは使わない。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  validateIgQueue, selectIgToday, runIgClaim, runIgPublish, runIgResolve,
  nextReviewWeek, igWeekMarkdown, IG_QUEUE_PATH, IG_POSTED_PATH, IG_JOURNAL_PATH
} from "../lib/ig-flow.mjs";

const post = (over = {}) => ({
  id: "ig-a", date: "2026-10-15", mediaType: "BRAND_GRAPHIC", images: ["a.jpg"],
  caption: "本文 #ロストボール", verifiedFactIds: [], approved: true, approvedBy: "K", approvedAt: "2026-10-10T00:00:00Z",
  ...over
});

// メモリ上のファイルと「リモート(GitHub)」を模した git。
function fakeRepo(files = {}) {
  const local = { [IG_JOURNAL_PATH]: [], [IG_POSTED_PATH]: [], ...files };
  const remote = { [IG_JOURNAL_PATH]: JSON.stringify(local[IG_JOURNAL_PATH]) };
  const io = {
    async readJson(p, fb) { return p in local ? structuredClone(local[p]) : fb; },
    async writeJson(p, v) { local[p] = structuredClone(v); }
  };
  const git = async (args) => {
    if (args[0] === "show") return remote[args[1].replace("FETCH_HEAD:", "")] ?? "";
    if (args[0] === "diff") return IG_JOURNAL_PATH;
    if (args[0] === "push") { for (const p of Object.keys(local)) remote[p] = JSON.stringify(local[p]); }
    return "";
  };
  return { io, git, local, remote };
}

const fakeFetch = (calls) => async (url, opts = {}) => {
  const u = String(url);
  calls.push(`${opts.method} ${u.replace(/access_token=[^&]+/, "access_token=X")}`);
  const json = (b) => ({ ok: true, status: 200, headers: { get: () => "image/jpeg" }, text: async () => JSON.stringify(b) });
  if (opts.method === "HEAD") return json({});
  if (u.includes("media_publish")) return json({ id: "MEDIA1" });
  if (u.includes("/media")) return json({ id: "C1" });
  return json({ status_code: "FINISHED" });
};

const base = { branch: "main", today: "2026-10-15", runId: "r1", runAttempt: "1", now: () => "2026-10-15T00:00:00Z", log: () => {}, errLog: () => {}, sleep: async () => {} };

test("AI画像の mediaType・生URL・タグ過多・未知の事実IDはエラーになる", () => {
  const { errors } = validateIgQueue([
    post({ id: "x1", date: "2026-10-01", mediaType: "AI_ASSISTED_VISUAL" }),
    post({ id: "x2", date: "2026-10-02", caption: "詳しくは https://example.com" }),
    post({ id: "x3", date: "2026-10-03", caption: "#a #b #c #d #e #f #g #h #i" }),
    post({ id: "x4", date: "2026-10-04", verifiedFactIds: ["nope"] })
  ], { factIds: ["ok"] });
  assert.equal(errors.length, 4);
});

test("断定表現は警告として出る(人が承認時に判断)", () => {
  const { errors, warnings } = validateIgQueue([post({ caption: "必ず飛びます" })]);
  assert.equal(errors.length, 0);
  assert.ok(warnings.some((w) => w.includes("必ず")));
});

test("未承認・投稿済みの日は選ばれない", () => {
  assert.equal(selectIgToday([post({ approved: false })], [], "2026-10-15").reason, "not-approved");
  assert.equal(selectIgToday([post()], [{ date: "2026-10-15" }], "2026-10-15").reason, "already-posted-today");
  assert.equal(selectIgToday([post()], [], "2026-10-16").reason, "no-post-scheduled");
  assert.equal(selectIgToday([post()], [], "2026-10-15").post.id, "ig-a");
});

test("dry-run では API を一切呼ばない", async () => {
  const { io, git } = fakeRepo({ [IG_QUEUE_PATH]: [post()] });
  const calls = [];
  const r = await runIgPublish({ ...base, io, git, live: false, fetchImpl: fakeFetch(calls) });
  assert.equal(r.stage, "dry-run");
  assert.equal(calls.length, 0);
});

test("claim → publish で1回だけ投稿し、記録が残る。2回目は投稿しない", async () => {
  const { io, git, local } = fakeRepo({ [IG_QUEUE_PATH]: [post()] });
  const calls = [];
  assert.equal((await runIgClaim({ ...base, io, git })).code, 0);
  const r = await runIgPublish({ ...base, io, git, live: true, token: "T", userId: "U", fetchImpl: fakeFetch(calls) });
  assert.equal(r.stage, "published");
  assert.equal(calls.filter((c) => c.includes("media_publish")).length, 1);
  assert.equal(local[IG_POSTED_PATH].length, 1);
  const again = await runIgClaim({ ...base, io, git, runId: "r2" });
  assert.equal(again.reason, "already-posted-today");
});

test("claim が無い run は投稿しない", async () => {
  const { io, git } = fakeRepo({ [IG_QUEUE_PATH]: [post()] });
  const calls = [];
  const r = await runIgPublish({ ...base, io, git, live: true, token: "T", userId: "U", fetchImpl: fakeFetch(calls) });
  assert.equal(r.reason, "no-claim");
  assert.equal(calls.length, 0);
});

test("投稿結果が不明なら止まり、人が resolve するまで次の投稿もしない", async () => {
  const { io, git } = fakeRepo({ [IG_QUEUE_PATH]: [post(), post({ id: "ig-b", date: "2026-10-16" })] });
  const failing = async (url, opts) => (String(url).includes("media_publish") ? { ok: false, status: 500, text: async () => "boom" } : fakeFetch([])(url, opts));
  await runIgClaim({ ...base, io, git });
  const r = await runIgPublish({ ...base, io, git, live: true, token: "T", userId: "U", fetchImpl: failing });
  assert.equal(r.stage, "unknown");
  const next = await runIgClaim({ ...base, io, git, today: "2026-10-16", runId: "r2" });
  assert.equal(next.halted, true);
  await runIgResolve({ io, id: "ig-a", outcome: "not-published", by: "K", now: base.now, log: () => {} });
});

test("土曜から見た「来週」は火曜〜月曜", () => {
  assert.deepEqual(nextReviewWeek("2026-10-17"), { start: "2026-10-20", end: "2026-10-26" });
  assert.match(igWeekMarkdown([post({ date: "2026-10-21", approved: false })], nextReviewWeek("2026-10-17")), /未承認/);
});

test("data/ig-queue.json は検査を通る(エラー0件)", () => {
  const queue = JSON.parse(readFileSync(new URL("../data/ig-queue.json", import.meta.url), "utf8"));
  const facts = JSON.parse(readFileSync(new URL("../data/verified-facts.json", import.meta.url), "utf8"));
  const list = Array.isArray(facts) ? facts : facts.facts;
  assert.deepEqual(validateIgQueue(queue, { factIds: list.map((f) => f.id) }).errors, []);
});
