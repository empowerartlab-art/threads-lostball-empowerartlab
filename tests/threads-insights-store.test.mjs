// 実データのdata/threads-insights-history.jsonには一切触れず、一時ディレクトリのみを使う。
// ネットワーク・Secretsは扱わないモジュールなのでfetchのスタブは不要。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendInsightsSnapshots, readInsightsHistoryFile, latestSnapshotsByPostId, validateSnapshotShape } from "../lib/threads-insights-store.mjs";

async function makeTmpDir() {
  return mkdtemp(join(tmpdir(), "lostball-insights-store-"));
}

function sampleSnapshot(overrides = {}) {
  return {
    threadsPostId: "post-1",
    sourceItemId: "lostball-day1-brand-intro",
    fetchedAt: "2026-10-04T00:00:00.000Z",
    views: 10,
    likes: 1,
    replies: 0,
    reposts: 0,
    quotes: 0,
    shares: 0,
    ...overrides
  };
}

test("readInsightsHistoryFile: ファイルが存在しない場合は空のsnapshots配列を返す(例外にしない)", async () => {
  const result = await readInsightsHistoryFile("/nonexistent/path/does-not-exist.json");
  assert.deepEqual(result.snapshots, []);
  assert.equal(result.count, 0);
});

test("appendInsightsSnapshots: 既存の_note等のトップレベルフィールドを保持したまま追記する", async () => {
  const dir = await makeTmpDir();
  const filePath = join(dir, "threads-insights-history.json");
  const initial = { _note: "Insights履歴", updatedAt: null, count: 0, snapshots: [] };
  await writeFile(filePath, `${JSON.stringify(initial, null, 2)}\n`, "utf8");

  try {
    const result = await appendInsightsSnapshots(filePath, [sampleSnapshot()]);
    assert.equal(result._note, "Insights履歴");
    assert.equal(result.count, 1);
    assert.equal(result.snapshots.length, 1);
    assert.equal(result.snapshots[0].threadsPostId, "post-1");
    assert.ok(result.updatedAt);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("appendInsightsSnapshots: 同一threadsPostId・同一数値でも、再度呼ぶと上書きせず追記される(履歴として蓄積)", async () => {
  const dir = await makeTmpDir();
  const filePath = join(dir, "threads-insights-history.json");
  await writeFile(filePath, `${JSON.stringify({ snapshots: [] }, null, 2)}\n`, "utf8");

  try {
    await appendInsightsSnapshots(filePath, [sampleSnapshot({ fetchedAt: "2026-10-04T00:00:00.000Z" })]);
    const result = await appendInsightsSnapshots(filePath, [sampleSnapshot({ fetchedAt: "2026-10-11T00:00:00.000Z" })]);
    assert.equal(result.snapshots.length, 2);
    assert.equal(result.snapshots[0].fetchedAt, "2026-10-04T00:00:00.000Z");
    assert.equal(result.snapshots[1].fetchedAt, "2026-10-11T00:00:00.000Z");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("appendInsightsSnapshots: 複数件を1回のatomic writeでまとめて追記できる", async () => {
  const dir = await makeTmpDir();
  const filePath = join(dir, "threads-insights-history.json");
  await writeFile(filePath, `${JSON.stringify({ snapshots: [] }, null, 2)}\n`, "utf8");

  try {
    const result = await appendInsightsSnapshots(filePath, [
      sampleSnapshot({ threadsPostId: "post-1" }),
      sampleSnapshot({ threadsPostId: "post-2" })
    ]);
    assert.equal(result.snapshots.length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("appendInsightsSnapshots: 必須フィールドが欠けたsnapshotを渡すと例外を投げ、ファイルを書き換えない", async () => {
  const dir = await makeTmpDir();
  const filePath = join(dir, "threads-insights-history.json");
  const initial = { snapshots: [] };
  await writeFile(filePath, `${JSON.stringify(initial, null, 2)}\n`, "utf8");

  try {
    await assert.rejects(() => appendInsightsSnapshots(filePath, [{ threadsPostId: "post-1" }]));
    const after = await readInsightsHistoryFile(filePath);
    assert.equal(after.snapshots.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("validateSnapshotShape: 必須フィールドがすべて揃っていればエラーを投げない", () => {
  assert.doesNotThrow(() => validateSnapshotShape(sampleSnapshot()));
});

test("latestSnapshotsByPostId: 同じthreadsPostIdの複数snapshotから、fetchedAtが最大のものだけを返す", () => {
  const history = {
    snapshots: [
      sampleSnapshot({ threadsPostId: "post-1", fetchedAt: "2026-10-04T00:00:00.000Z", views: 10 }),
      sampleSnapshot({ threadsPostId: "post-1", fetchedAt: "2026-10-11T00:00:00.000Z", views: 25 }),
      sampleSnapshot({ threadsPostId: "post-2", fetchedAt: "2026-10-04T00:00:00.000Z", views: 5 })
    ]
  };
  const latest = latestSnapshotsByPostId(history);
  assert.equal(latest.get("post-1").views, 25);
  assert.equal(latest.get("post-2").views, 5);
  assert.equal(latest.size, 2);
});
