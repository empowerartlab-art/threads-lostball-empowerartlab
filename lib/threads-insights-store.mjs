// data/threads-insights-history.json への永続化のみを担当する(テーマ非依存)。
// Threads API呼び出し・git add/commit/pushは一切行わない。
//
// Insightsは時間経過で変化する値のため、「最新値への上書き」ではなく
// 「取得日時付きスナップショットの追記」として蓄積する(lib/threads-posts-store.mjsと
// 同じatomic write方式を踏襲するが、役割は完全に別: threads-posts.jsonの
// 「投稿が成功したという記録」とは異なり、こちらは「ある時点でのInsights測定値」の履歴)。
// 同じ値を複数回取得しても、呼び出した回数分だけスナップショットが積み上がる
// (重複排除・最新値への統合は行わない。分析側が必要なら最新スナップショットだけを使えばよい)。

import { readFile, writeFile, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

export async function readInsightsHistoryFile(path) {
  try {
    const content = await readFile(path, "utf8");
    const json = JSON.parse(content);
    return {
      updatedAt: null,
      count: 0,
      ...json,
      snapshots: Array.isArray(json.snapshots) ? json.snapshots : []
    };
  } catch {
    return { updatedAt: null, count: 0, snapshots: [] };
  }
}

async function writeJsonAtomic(path, data) {
  const dir = dirname(path);
  const tmpPath = join(dir, `.${randomUUID()}.threads-insights.tmp`);
  const content = `${JSON.stringify(data, null, 2)}\n`;

  await writeFile(tmpPath, content, "utf8");
  try {
    await rename(tmpPath, path);
  } catch (err) {
    await unlink(tmpPath).catch(() => {});
    throw err;
  }
}

// snapshotの最低限の形(呼び出し側がこれ以上の余計なフィールド、例えばSecrets等を
// 混入させていないかの構造チェック。値そのものの正しさまでは検証しない)。
const REQUIRED_SNAPSHOT_FIELDS = ["threadsPostId", "fetchedAt", "views", "likes", "replies", "reposts", "quotes", "shares"];

export function validateSnapshotShape(snapshot) {
  const missing = REQUIRED_SNAPSHOT_FIELDS.filter((key) => !(key in (snapshot || {})));
  if (missing.length > 0) {
    throw new Error(`insights snapshot に必須フィールドが不足しています: ${missing.join(", ")}`);
  }
}

// 複数のsnapshotを1回のatomic writeでまとめて追記する
// (投稿1件ごとに毎回ファイルを書き直すとI/O回数が増えるため、
// scripts/fetch-threads-insights.mjs側で全件取得してからまとめて呼ぶ想定)。
export async function appendInsightsSnapshots(path, snapshots) {
  const list = Array.isArray(snapshots) ? snapshots : [snapshots];
  for (const snapshot of list) validateSnapshotShape(snapshot);

  const current = await readInsightsHistoryFile(path);
  const next = {
    ...current,
    snapshots: [...current.snapshots, ...list],
    count: current.snapshots.length + list.length,
    updatedAt: new Date().toISOString()
  };
  await writeJsonAtomic(path, next);
  return next;
}

// 分析用の便利関数: threadsPostIdごとに最新(fetchedAtが最大)のsnapshotだけを返す。
// 履歴全体はhistory.snapshotsにそのまま残り続ける(これは参照用の集約にすぎない)。
export function latestSnapshotsByPostId(history) {
  const byId = new Map();
  for (const snap of history?.snapshots || []) {
    const existing = byId.get(snap.threadsPostId);
    if (!existing || snap.fetchedAt > existing.fetchedAt) {
      byId.set(snap.threadsPostId, snap);
    }
  }
  return byId;
}
