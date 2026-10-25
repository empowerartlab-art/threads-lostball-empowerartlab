// Instagram リール(2026-10-25 代表者決定)のテスト。ネットワーク・git・実ファイルは使わない。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateIgQueue, runIgClaim, runIgPublish, runIgResolve, igWeekMarkdown, isReel,
  IG_QUEUE_PATH, IG_POSTED_PATH, IG_JOURNAL_PATH, IG_VIDEO_BASE, IG_MEDIA_BASE, AI_VIDEO
} from "../lib/ig-flow.mjs";

const TOKEN = "TOKEN-SECRET-123";
const USER = "USER-SECRET-456";

const post = (over = {}) => ({
  id: "ig-a", date: "2026-10-27", mediaType: "BRAND_GRAPHIC", images: ["a.jpg"],
  caption: "本文 #ロストボール", verifiedFactIds: [], approved: true, approvedBy: "K", approvedAt: "2026-10-25T00:00:00Z",
  ...over
});
const reel = (over = {}) => {
  const { images, ...rest } = post({ video: "2026-10-27-reel.mp4", ...over });
  return rest;
};

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

// calls: head / container / status / publish の順番を残す。requests: 呼んだ URL(トークンは伏せる)。
function fakeFetch({ videoType = "video/mp4", status = "FINISHED", publishFails = false, containerFails = false } = {}) {
  const calls = [];
  const requests = [];
  const sleeps = [];
  const ok = (b) => ({ ok: true, status: 200, headers: { get: () => "application/json" }, text: async () => JSON.stringify(b) });
  const fetchImpl = async (url, opts = {}) => {
    const u = String(url);
    requests.push(u.replace(/access_token=[^&]+/, "access_token=X"));
    if (opts.method === "HEAD") {
      calls.push("head");
      return { ok: true, status: 200, headers: { get: () => (/\.mp4$/.test(u) ? videoType : "image/jpeg") } };
    }
    if (u.includes("media_publish")) {
      calls.push("publish");
      return publishFails ? { ok: false, status: 500, text: async () => `boom ${TOKEN}` } : ok({ id: "MEDIA1" });
    }
    if (u.includes("/media")) {
      calls.push("container");
      return containerFails ? { ok: false, status: 400, text: async () => `bad ${TOKEN} ${USER}` } : ok({ id: "C1" });
    }
    calls.push("status");
    return ok({ status_code: status });
  };
  return { fetchImpl, calls, requests, sleeps, sleep: async (ms) => { sleeps.push(ms); } };
}

const base = { branch: "main", today: "2026-10-27", runId: "r1", runAttempt: "1", now: () => "2026-10-27T00:00:00Z" };

function setup(queue, fetchOpts) {
  const repo = fakeRepo({ [IG_QUEUE_PATH]: queue });
  const f = fakeFetch(fetchOpts);
  const out = [];
  const deps = {
    ...base, io: repo.io, git: repo.git, live: true, token: TOKEN, userId: USER,
    fetchImpl: f.fetchImpl, sleep: f.sleep, log: (m) => out.push(m), errLog: (m) => out.push(m)
  };
  return { ...repo, ...f, out, deps };
}
const createUrl = (requests) => new URL(requests.find((u) => u.includes("/media?")));

test("検査: リールは .mp4 の video があり images が無いこと", () => {
  assert.deepEqual(validateIgQueue([reel()]).errors, []);
  assert.deepEqual(validateIgQueue([reel({ cover: "2026-10-27-reel-cover.jpg", shareToFeed: false })]).errors, []);
  assert.equal(validateIgQueue([reel({ video: "r.mov" })]).errors.length, 1);
  assert.equal(validateIgQueue([reel({ video: "" })]).errors.length, 1);
  assert.equal(validateIgQueue([reel({ video: "../r.mp4" })]).errors.length, 1, "フォルダ指定は不可");
  assert.equal(validateIgQueue([post({ video: "r.mp4" })]).errors.length, 1, "video と images の両方は不可");
  assert.deepEqual(validateIgQueue([post({ video: "r.mp4", images: [] })]).errors, []);
  assert.equal(validateIgQueue([reel({ cover: "r.png" })]).errors.length, 1);
  assert.equal(validateIgQueue([reel({ shareToFeed: "yes" })]).errors.length, 1);
  assert.equal(validateIgQueue([post({ cover: "c.jpg" })]).errors.length, 1, "cover はリールだけ");
  assert.equal(validateIgQueue([post({ shareToFeed: false })]).errors.length, 1, "shareToFeed はリールだけ");
  assert.equal(validateIgQueue([reel({ caption: "" })]).errors.length, 1);
  assert.equal(validateIgQueue([reel({ caption: "詳しくは https://example.com" })]).errors.length, 1);
  assert.equal(isReel(reel()), true);
  assert.equal(isReel(post()), false);
});

test("検査: AI の映像は AI_VIDEO(リールだけ)。AI の静止画・ヘタ郎のリールは不可", () => {
  const ai = validateIgQueue([reel({ mediaType: AI_VIDEO })]);
  assert.deepEqual(ai.errors, []);
  assert.ok(ai.warnings.some((w) => w.includes("AI の映像")), "承認時に目で確かめる注意が出る");
  assert.equal(validateIgQueue([post({ mediaType: AI_VIDEO })]).errors.length, 1, "AI の静止画は使わない");
  assert.equal(validateIgQueue([reel({ mediaType: "AI_ASSISTED_VISUAL" })]).errors.length, 1);
  assert.equal(validateIgQueue([reel({ mediaType: "CHARACTER_HETARO", caption: "見習いアンバサダーのヘタ郎 #ヘタ郎" })]).errors.length, 1);
  for (const t of ["BRAND_GRAPHIC", "PRODUCT_PHOTO", "REAL_PHOTO", "REAL_WORK"]) {
    assert.deepEqual(validateIgQueue([reel({ mediaType: t })]).errors, [], t);
  }
});

test("リール: 動画は GitHub Pages、表紙は画像と同じ置き場。HEAD → REELS の入れ物1つ → 待つ → 公開 → 記録", async () => {
  const h = setup([reel({ cover: "2026-10-27-reel-cover.jpg" })]);
  assert.equal((await runIgClaim(h.deps)).code, 0);
  const r = await runIgPublish(h.deps);
  assert.equal(r.stage, "published");
  assert.deepEqual(h.calls, ["head", "head", "container", "status", "publish"]);
  assert.equal(h.requests[0], `${IG_VIDEO_BASE}2026-10-27-reel.mp4`);
  assert.equal(h.requests[0], "https://empowerartlab-art.github.io/threads-lostball-empowerartlab/assets/instagram/2026-10-27-reel.mp4");
  assert.equal(h.requests[1], `${IG_MEDIA_BASE}2026-10-27-reel-cover.jpg`);
  const create = createUrl(h.requests);
  assert.equal(create.searchParams.get("media_type"), "REELS");
  assert.equal(create.searchParams.get("video_url"), `${IG_VIDEO_BASE}2026-10-27-reel.mp4`);
  assert.equal(create.searchParams.get("cover_url"), `${IG_MEDIA_BASE}2026-10-27-reel-cover.jpg`);
  assert.equal(create.searchParams.get("share_to_feed"), "true");
  assert.equal(create.searchParams.get("image_url"), null);
  const rec = h.local[IG_POSTED_PATH][0];
  assert.equal(rec.type, "REELS");
  assert.equal(rec.video, "2026-10-27-reel.mp4");
  assert.equal(rec.cover, "2026-10-27-reel-cover.jpg");
  assert.equal(rec.images, undefined);
  assert.equal((await runIgClaim({ ...h.deps, runId: "r2" })).reason, "already-posted-today", "2回目は出さない");
});

test("リール: shareToFeed=false・表紙なし", async () => {
  const h = setup([reel({ shareToFeed: false })]);
  await runIgClaim(h.deps);
  assert.equal((await runIgPublish(h.deps)).code, 0);
  const create = createUrl(h.requests);
  assert.equal(create.searchParams.get("share_to_feed"), "false");
  assert.equal(create.searchParams.get("cover_url"), null);
  assert.deepEqual(h.calls, ["head", "container", "status", "publish"]);
});

test("リール: 動画が video/mp4 で見られない(raw の octet-stream など)なら入れ物を作る前に止まる", async () => {
  const h = setup([reel()], { videoType: "application/octet-stream" });
  await runIgClaim(h.deps);
  const r = await runIgPublish(h.deps);
  assert.equal(r.stage, "aborted");
  assert.deepEqual(h.calls, ["head"]);
});

test("リール: 処理待ちは10秒ごと最長30回(5分)。終わらなければ公開せずに止まる", async () => {
  const h = setup([reel()], { status: "IN_PROGRESS" });
  await runIgClaim(h.deps);
  const r = await runIgPublish(h.deps);
  assert.equal(r.stage, "aborted");
  assert.equal(h.calls.filter((c) => c === "status").length, 30);
  assert.ok(h.sleeps.length > 0 && h.sleeps.every((ms) => ms === 10_000));
  assert.ok(!h.calls.includes("publish"));
});

test("画像の投稿の処理待ちは今までどおり(5秒ごと)", async () => {
  const h = setup([post()], { status: "IN_PROGRESS" });
  await runIgClaim(h.deps);
  const r = await runIgPublish(h.deps);
  assert.equal(r.stage, "aborted");
  assert.equal(h.calls.filter((c) => c === "status").length, 20);
  assert.ok(h.sleeps.every((ms) => ms === 5_000));
});

test("リール: 入れ物が ERROR なら公開しない", async () => {
  const h = setup([reel()], { status: "ERROR" });
  await runIgClaim(h.deps);
  assert.equal((await runIgPublish(h.deps)).stage, "aborted");
  assert.ok(!h.calls.includes("publish"));
});

test("リール: dry run は API を呼ばず、type=REELS と動画の URL を出す", async () => {
  const h = setup([reel()]);
  const r = await runIgPublish({ ...h.deps, live: false });
  assert.equal(r.stage, "dry-run");
  assert.deepEqual(h.calls, []);
  const all = h.out.join("\n");
  assert.ok(all.includes("type=REELS"));
  assert.ok(all.includes(`${IG_VIDEO_BASE}2026-10-27-reel.mp4`));
});

test("リール: 公開の結果が分からなければ止まり、自動でやり直さない。人が確かめると動画が記録に残る", async () => {
  const h = setup([reel(), reel({ id: "ig-b", date: "2026-10-28" })], { publishFails: true });
  await runIgClaim(h.deps);
  assert.equal((await runIgPublish(h.deps)).stage, "unknown");
  assert.equal((await runIgClaim({ ...h.deps, today: "2026-10-28", runId: "r2" })).halted, true);
  const r = await runIgResolve({ io: h.io, id: "ig-a", outcome: "published", mediaId: "m1", by: "KEITA", now: () => "x", log: () => {} });
  assert.equal(r.code, 0);
  const rec = h.local[IG_POSTED_PATH][0];
  assert.equal(rec.type, "REELS");
  assert.equal(rec.video, "2026-10-27-reel.mp4");
});

test("リール: 鍵の値はログに出ない", async () => {
  const h = setup([reel()], { containerFails: true });
  await runIgClaim(h.deps);
  await runIgPublish(h.deps);
  const all = h.out.join("\n");
  assert.ok(!all.includes(TOKEN));
  assert.ok(!all.includes(USER));
});

test("来週の予定の一覧にリールと出る", () => {
  const md = igWeekMarkdown([reel({ date: "2026-10-28", approved: false, cover: "c.jpg" }), post({ date: "2026-10-29" })], { start: "2026-10-27", end: "2026-11-02" });
  assert.match(md, /リール（動画・表紙あり）/);
  assert.match(md, /画像1枚/);
});
