// 実データのdata/draft-bank-candidates.jsonには一切触れず、一時ディレクトリのみを使う。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { upsertCandidates, readCandidatesFile } from "../lib/draft-bank-candidates-store.mjs";
import { ApprovalError, promoteCandidate } from "../lib/approval-gate.mjs";

async function makeTmpDir() {
  return mkdtemp(join(tmpdir(), "lostball-candidates-store-"));
}

test("readCandidatesFile: ファイルが存在しない場合は空のitems配列を返す", async () => {
  const result = await readCandidatesFile("/nonexistent/draft-bank-candidates.json");
  assert.deepEqual(result.items, []);
});

test("upsertCandidates: 既存の_note等を保持したまま新規candidateを追加する", async () => {
  const dir = await makeTmpDir();
  const filePath = join(dir, "draft-bank-candidates.json");
  await writeFile(filePath, `${JSON.stringify({ _note: "週2以降の未承認提案の置き場。", items: [] }, null, 2)}\n`, "utf8");

  try {
    const result = await upsertCandidates(filePath, [{ id: "c1", bodyEn: "a", bodyJa: "あ" }]);
    assert.equal(result._note, "週2以降の未承認提案の置き場。");
    assert.equal(result.items.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("upsertCandidates: 同じidのcandidateを渡すと、重複追加ではなく置き換えになる(再実行時の重複防止)", async () => {
  const dir = await makeTmpDir();
  const filePath = join(dir, "draft-bank-candidates.json");
  await writeFile(filePath, `${JSON.stringify({ items: [] }, null, 2)}\n`, "utf8");

  try {
    await upsertCandidates(filePath, [{ id: "c1", bodyEn: "a", bodyJa: "あ", version: 1 }]);
    const result = await upsertCandidates(filePath, [{ id: "c1", bodyEn: "a2", bodyJa: "あ2", version: 2 }]);
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].version, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("upsertCandidates: 既存の他candidateはそのまま残り、同じidのものだけが置き換わる", async () => {
  const dir = await makeTmpDir();
  const filePath = join(dir, "draft-bank-candidates.json");
  await writeFile(filePath, `${JSON.stringify({ items: [{ id: "other", bodyEn: "x", bodyJa: "x" }] }, null, 2)}\n`, "utf8");

  try {
    const result = await upsertCandidates(filePath, [{ id: "c1", bodyEn: "a", bodyJa: "あ" }]);
    assert.equal(result.items.length, 2);
    assert.ok(result.items.some((i) => i.id === "other"));
    assert.ok(result.items.some((i) => i.id === "c1"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("統合: upsertCandidatesで保存した候補をapprovedBy/approvedAt無しでpromoteCandidateへ渡すとApprovalErrorになる(自動昇格できない)", async () => {
  const dir = await makeTmpDir();
  const filePath = join(dir, "draft-bank-candidates.json");
  await writeFile(filePath, `${JSON.stringify({ items: [] }, null, 2)}\n`, "utf8");

  try {
    await upsertCandidates(filePath, [{ id: "c1", bodyEn: "a", bodyJa: "あ", approvedBy: null, approvedAt: null }]);
    const saved = await readCandidatesFile(filePath);
    const candidate = saved.items[0];
    assert.throws(() => promoteCandidate(candidate, { approved: false }), ApprovalError);
    assert.throws(() => promoteCandidate(candidate, { approved: true, approvedBy: "", approvedAt: "2026-10-04T00:00:00.000Z" }), ApprovalError);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
