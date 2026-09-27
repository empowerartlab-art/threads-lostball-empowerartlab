// 実データのdata/threads-posts.jsonには一切触れず、一時ディレクトリ・一時ファイルのみを使う。
// Threads API・ネットワークは一切扱わないモジュールなのでfetchのスタブは不要。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendPostRecord, readPostsFile } from "../lib/threads-posts-store.mjs";
import { buildPostedBodySet, isDuplicateBody } from "../lib/duplicate-guard.mjs";

async function makeTmpDir() {
  return mkdtemp(join(tmpdir(), "lostball-threads-posts-store-"));
}

function sampleRecord(overrides = {}) {
  return {
    sourceItemId: "lostball-day1-brand-intro",
    threadsPostId: "post-1",
    bodyEn: "Hello.",
    bodyJa: "こんにちは。",
    pillar: null,
    category: "BRAND_INTRO",
    postedAt: "2026-09-28T00:00:00.000Z",
    mode: "live",
    workflowRunUrl: null,
    ...overrides
  };
}

test("appendPostRecord: 既存の_note等のトップレベルフィールドを保持したまま1件追加する", async () => {
  const dir = await makeTmpDir();
  const filePath = join(dir, "threads-posts.json");
  const initial = { _note: "投稿記録", updatedAt: null, count: 0, posts: [] };
  await writeFile(filePath, `${JSON.stringify(initial, null, 2)}\n`, "utf8");

  try {
    const record = sampleRecord();
    const result = await appendPostRecord(filePath, record);

    assert.equal(result._note, "投稿記録");
    assert.equal(result.count, 1);
    assert.ok(result.updatedAt);
    assert.equal(result.posts.length, 1);
    assert.deepEqual(result.posts[0], record);

    const onDisk = JSON.parse(await readFile(filePath, "utf8"));
    assert.deepEqual(onDisk, result);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("appendPostRecord: 2回呼ぶと既存1件目を保持したまま2件になる(保存されたJSONの形式も正しい)", async () => {
  const dir = await makeTmpDir();
  const filePath = join(dir, "threads-posts.json");
  await writeFile(filePath, `${JSON.stringify({ updatedAt: null, count: 0, posts: [] }, null, 2)}\n`, "utf8");

  try {
    const recordA = sampleRecord({ sourceItemId: "a", threadsPostId: "post-a" });
    const recordB = sampleRecord({ sourceItemId: "b", threadsPostId: "post-b" });

    await appendPostRecord(filePath, recordA);
    const result = await appendPostRecord(filePath, recordB);

    assert.equal(result.posts.length, 2);
    assert.equal(result.posts[0].sourceItemId, "a");
    assert.equal(result.posts[1].sourceItemId, "b");
    assert.equal(result.count, 2);
    assert.equal(typeof result.updatedAt, "string");
    assert.ok(Array.isArray(result.posts));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("appendPostRecord後、duplicate-guardが新しい投稿を重複として認識できる", async () => {
  const dir = await makeTmpDir();
  const filePath = join(dir, "threads-posts.json");
  await writeFile(filePath, `${JSON.stringify({ updatedAt: null, count: 0, posts: [] }, null, 2)}\n`, "utf8");

  try {
    const record = sampleRecord({ bodyEn: "Same body.", bodyJa: "同じ本文。" });
    const saved = await appendPostRecord(filePath, record);

    const postedBodySet = buildPostedBodySet(saved.posts);
    const candidate = { bodyEn: "Same body.", bodyJa: "同じ本文。" };
    assert.equal(isDuplicateBody(candidate, postedBodySet), true);
    assert.equal(isDuplicateBody({ bodyEn: "Different.", bodyJa: "違う。" }, postedBodySet), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("threadsPostIdが正しく保存される", async () => {
  const dir = await makeTmpDir();
  const filePath = join(dir, "threads-posts.json");
  await writeFile(filePath, `${JSON.stringify({ updatedAt: null, count: 0, posts: [] }, null, 2)}\n`, "utf8");

  try {
    const record = sampleRecord({ threadsPostId: "unique-post-id-xyz" });
    const result = await appendPostRecord(filePath, record);
    assert.equal(result.posts[0].threadsPostId, "unique-post-id-xyz");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("atomic write失敗時、元のJSONファイルは破損せず内容も変わらない", async () => {
  const dir = await makeTmpDir();
  const filePath = join(dir, "threads-posts.json");
  const original = { updatedAt: null, count: 1, posts: [sampleRecord({ sourceItemId: "existing", threadsPostId: "post-existing" })] };
  const originalContent = `${JSON.stringify(original, null, 2)}\n`;
  await writeFile(filePath, originalContent, "utf8");

  try {
    // ディレクトリを読み取り専用にし、一時ファイルの作成自体を失敗させる
    // (renameより前の段階で失敗するため、対象ファイルには一切触れられない)。
    await chmod(dir, 0o555);
    await assert.rejects(() => appendPostRecord(filePath, sampleRecord({ sourceItemId: "new", threadsPostId: "post-new" })));
  } finally {
    await chmod(dir, 0o755);
  }

  try {
    const stillOnDisk = await readFile(filePath, "utf8");
    assert.equal(stillOnDisk, originalContent);
    assert.deepEqual(JSON.parse(stillOnDisk), original);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readPostsFile: ファイルが存在しない場合は空のposts配列を返す(例外にしない)", async () => {
  const dir = await makeTmpDir();
  const filePath = join(dir, "does-not-exist.json");
  try {
    const result = await readPostsFile(filePath);
    assert.deepEqual(result.posts, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("保存されたレコードにSecrets相当のキー(accessToken等)が含まれない", async () => {
  const dir = await makeTmpDir();
  const filePath = join(dir, "threads-posts.json");
  await writeFile(filePath, `${JSON.stringify({ updatedAt: null, count: 0, posts: [] }, null, 2)}\n`, "utf8");

  try {
    const result = await appendPostRecord(filePath, sampleRecord());
    const keys = Object.keys(result.posts[0]).sort();
    assert.deepEqual(
      keys,
      ["bodyEn", "bodyJa", "category", "mode", "pillar", "postedAt", "sourceItemId", "threadsPostId", "workflowRunUrl"].sort()
    );
    assert.ok(!("accessToken" in result.posts[0]));
    assert.ok(!("clientSecret" in result.posts[0]));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
