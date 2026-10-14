// 例外：ヘタ郎のキャラクター画像(CHARACTER_HETARO)の検査。ネットワーク・git は使わない。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CHARACTER_HETARO, HETARO_MEDIA_BASE, hetaroImageUrl, checkHetaroCharacterPost, checkMedia, MEDIA_TYPES
} from "../lib/media-guard.mjs";
import {
  validateIgQueue, igImageUrls, runIgClaim, runIgPublish, IG_QUEUE_PATH, IG_POSTED_PATH, IG_JOURNAL_PATH
} from "../lib/ig-flow.mjs";
import { validateXQueue } from "../lib/x-flow.mjs";

const PAGES = "https://empowerartlab-art.github.io/hetaro-media/ig/";
const okCaption = "Lost Ball の見習いアンバサダー、ヘタ郎です。今日も練習。 #ヘタ郎 #ロストボール";
const hetaro = (over = {}) => ({
  id: "ig-h", date: "2026-10-16", mediaType: CHARACTER_HETARO,
  images: [`${PAGES}2026-10-16-ig-1.jpg`], caption: okCaption, verifiedFactIds: [],
  approved: true, approvedBy: "K", approvedAt: "2026-10-14T00:00:00Z", ...over
});

test("ヘタ郎の置き場: GitHub Pages の URL と hetaro-media/ig/ のパスだけを公開URLにする", () => {
  assert.equal(HETARO_MEDIA_BASE, PAGES);
  assert.equal(hetaroImageUrl(`${PAGES}2026-10-16-ig-1.jpg`), `${PAGES}2026-10-16-ig-1.jpg`);
  assert.equal(hetaroImageUrl("hetaro-media/ig/2026-10-16-ig-2.jpeg"), `${PAGES}2026-10-16-ig-2.jpeg`);
  for (const bad of [
    "a.jpg",
    "assets/instagram/a.jpg",
    "http://empowerartlab-art.github.io/hetaro-media/ig/a.jpg",
    "https://empowerartlab-art.github.io/hetaro-media/a.jpg",
    "https://empowerartlab-art.github.io/hetaro-media/ig/../x/a.jpg",
    "https://empowerartlab-art.github.io/hetaro-media/ig/sub/a.jpg",
    "https://empowerartlab-art.github.io/hetaro-media/ig/a.jpg?x=1",
    "https://empowerartlab-art.github.io/hetaro-media/ig/a.png",
    "https://evil.example/hetaro-media/ig/a.jpg",
    "https://empowerartlab-art.github.io/hetaro-media/ig/",
    "https://raw.githubusercontent.com/empowerartlab-art/threads-lostball-empowerartlab/main/assets/instagram/a.jpg",
    null
  ]) assert.equal(hetaroImageUrl(bad), null, String(bad));
});

test("許可: ヘタ郎の画像だけ＋説明文に「見習いアンバサダー」(#ヘタ郎 の併記も可)", () => {
  assert.deepEqual(checkHetaroCharacterPost({ images: [`${PAGES}a.jpg`, "hetaro-media/ig/b.jpg"], caption: okCaption }), { ok: true, errors: [] });
});

test("目印: 見習いアンバサダーのみ → 可", () => {
  assert.deepEqual(checkHetaroCharacterPost({ images: [`${PAGES}a.jpg`], caption: "見習いアンバサダーの練習日記" }), { ok: true, errors: [] });
});

test("目印: 見習いアンバサダー＋#ヘタ郎 → 可", () => {
  assert.deepEqual(checkHetaroCharacterPost({ images: [`${PAGES}a.jpg`], caption: "見習いアンバサダーの今日の一打 #ヘタ郎" }), { ok: true, errors: [] });
});

test("目印: #ヘタ郎 のみ → エラー(見習いアンバサダーは毎回必須)", () => {
  const r = checkHetaroCharacterPost({ images: [`${PAGES}a.jpg`], caption: "今日の一打 #ヘタ郎" });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.startsWith("hetaro-caption-missing-marker")), String(r.errors));
});

test("不可: ヘタ郎以外の画像が1枚でも混ざる", () => {
  const r = checkHetaroCharacterPost({ images: [`${PAGES}a.jpg`, "real-ball.jpg"], caption: okCaption });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.startsWith("hetaro-image-not-from-hetaro-media:real-ball.jpg")));
  assert.equal(checkHetaroCharacterPost({ images: [], caption: okCaption }).ok, false);
});

test("不可: 説明文にキャラクターの目印が無い(「ヘタ郎」だけ・タグ無しも不可)", () => {
  const r = checkHetaroCharacterPost({ images: [`${PAGES}a.jpg`], caption: "ヘタ郎、今日もがんばる" });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.startsWith("hetaro-caption-missing-marker")));
});

test("不可: 商品写真・実在の人物・お客様の結果・実際の出来事のように書く", () => {
  const cases = {
    "product-photo-claim": ["これが実際の商品です", "商品写真です", "この球を販売中", "実写でお届け"],
    "real-person-claim": ["お客様にもらいました", "購入者のヘタ郎さん"],
    "customer-result-claim": ["使ってみた結果、飛距離が10ヤード伸びた", "ビフォー"],
    "real-event-claim": ["イベント当日の様子", "昨日開催しました"]
  };
  for (const [family, texts] of Object.entries(cases)) {
    for (const t of texts) {
      const r = checkHetaroCharacterPost({ images: [`${PAGES}a.jpg`], caption: `${okCaption}\n${t}` });
      assert.equal(r.ok, false, t);
      assert.ok(r.errors.some((e) => e.startsWith(`hetaro-caption-${family}`)), `${t}: ${r.errors}`);
    }
  }
});

test("Instagram の検査: CHARACTER_HETARO はヘタ郎の画像と目印があれば通る", () => {
  const { errors } = validateIgQueue([hetaro(), hetaro({ id: "ig-h2", date: "2026-10-17", images: ["hetaro-media/ig/2026-10-17-ig-1.jpg"] })]);
  assert.deepEqual(errors, []);
});

test("Instagram の検査: CHARACTER_HETARO に自前の画像・他サイト・目印なし・商品写真の主張はエラー", () => {
  const bad = [
    hetaro({ id: "a", date: "2026-10-16", images: ["a.jpg"] }),
    hetaro({ id: "b", date: "2026-10-17", images: [`${PAGES}x.jpg`, "https://example.com/x.jpg"] }),
    hetaro({ id: "c", date: "2026-10-18", caption: "今日の練習 #ロストボール" }),
    hetaro({ id: "d", date: "2026-10-19", caption: `${okCaption}\nこれが実際の商品です` })
  ];
  const { errors } = validateIgQueue(bad);
  for (const id of ["a", "b", "c", "d"]) assert.ok(errors.some((e) => e.startsWith(`${id}: hetaro-`)), `${id}: ${errors}`);
});

test("Instagram の検査: 他の AI 画像は引き続き不可。ヘタ郎の画像を他の mediaType で使うのも不可", () => {
  const { errors, warnings } = validateIgQueue([
    hetaro({ id: "ai", date: "2026-10-16", mediaType: "AI_ASSISTED_VISUAL", images: ["a.jpg"] }),
    hetaro({ id: "bg-url", date: "2026-10-17", mediaType: "BRAND_GRAPHIC" }),
    hetaro({ id: "bg-file", date: "2026-10-18", mediaType: "BRAND_GRAPHIC", images: ["2026-10-18-hetaro.jpg"] }),
    hetaro({ id: "pp", date: "2026-10-19", mediaType: "PRODUCT_PHOTO", images: ["ball.jpg"] })
  ]);
  assert.ok(errors.some((e) => e.startsWith("ai: mediaType must be one of")));
  assert.ok(errors.some((e) => e === "bg-url: images must be .jpg file names"));
  assert.ok(errors.some((e) => e.startsWith("bg-file: ヘタ郎の画像は")));
  assert.ok(!errors.some((e) => e.startsWith("pp:")), String(errors));
  assert.ok(warnings.some((w) => w.startsWith("pp: 説明文にヘタ郎")));
});

test("投稿時の URL: CHARACTER_HETARO は GitHub Pages、他はこのリポジトリの assets/instagram/", () => {
  assert.deepEqual(igImageUrls(hetaro({ images: ["hetaro-media/ig/a.jpg"] })), [`${PAGES}a.jpg`]);
  assert.deepEqual(igImageUrls({ mediaType: "BRAND_GRAPHIC", images: ["a.jpg"] }, "https://base/"), ["https://base/a.jpg"]);
  assert.throws(() => igImageUrls(hetaro({ images: ["a.jpg"] })));
});

test("CHARACTER_HETARO の投稿は GitHub Pages の画像 URL を Instagram に渡す", async () => {
  const local = { [IG_QUEUE_PATH]: [hetaro({ date: "2026-10-16" })], [IG_JOURNAL_PATH]: [], [IG_POSTED_PATH]: [] };
  const remote = { [IG_JOURNAL_PATH]: "[]" };
  const io = { async readJson(p, fb) { return p in local ? structuredClone(local[p]) : fb; }, async writeJson(p, v) { local[p] = structuredClone(v); } };
  const git = async (args) => {
    if (args[0] === "show") return remote[args[1].replace("FETCH_HEAD:", "")] ?? "";
    if (args[0] === "diff") return IG_JOURNAL_PATH;
    if (args[0] === "push") { for (const p of Object.keys(local)) remote[p] = JSON.stringify(local[p]); }
    return "";
  };
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push(`${opts.method} ${String(url)}`);
    const json = (b) => ({ ok: true, status: 200, headers: { get: () => "image/jpeg" }, text: async () => JSON.stringify(b) });
    if (opts.method === "HEAD") return json({});
    if (String(url).includes("media_publish")) return json({ id: "M1" });
    if (String(url).includes("/media")) return json({ id: "C1" });
    return json({ status_code: "FINISHED" });
  };
  const base = { branch: "main", today: "2026-10-16", runId: "r1", runAttempt: "1", now: () => "2026-10-16T00:00:00Z", log: () => {}, errLog: () => {}, sleep: async () => {} };
  assert.equal((await runIgClaim({ ...base, io, git })).code, 0);
  const r = await runIgPublish({ ...base, io, git, live: true, token: "T", userId: "U", fetchImpl });
  assert.equal(r.stage, "published");
  assert.ok(calls.includes(`HEAD ${PAGES}2026-10-16-ig-1.jpg`), calls.join("\n"));
  const url = `${PAGES}2026-10-16-ig-1.jpg`;
  assert.ok(calls.some((c) => c.startsWith("POST") && (c.includes(encodeURIComponent(url)) || c.includes(url))), calls.join("\n"));
});

test("Threads(draft-bank)と X には画像の例外を広げない", () => {
  assert.ok(!MEDIA_TYPES.includes(CHARACTER_HETARO));
  assert.equal(checkMedia({ media: { type: CHARACTER_HETARO, required: false } }).ok, false);
  const errors = validateXQueue([{
    id: "x-h", date: "2026-10-16", text: "見習いアンバサダーのヘタ郎です", images: [`${PAGES}a.jpg`],
    approved: false
  }]);
  assert.ok(errors.some((e) => e.includes('"images" is not supported')), String(errors));
});
