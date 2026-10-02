// data/draft-bank-candidates.json への永続化のみを担当する(テーマ非依存)。
// data/draft-bank.jsonへは一切書き込まない(昇格はscripts/promote-candidates.mjs経由の
// 人間の明示操作でのみ行う。このファイルの関数はその経路を一切迂回しない)。

import { readFile, writeFile, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

export async function readCandidatesFile(path) {
  try {
    const content = await readFile(path, "utf8");
    const json = JSON.parse(content);
    return { ...json, items: Array.isArray(json.items) ? json.items : [] };
  } catch {
    return { items: [] };
  }
}

async function writeJsonAtomic(path, data) {
  const dir = dirname(path);
  const tmpPath = join(dir, `.${randomUUID()}.draft-bank-candidates.tmp`);
  const content = `${JSON.stringify(data, null, 2)}\n`;

  await writeFile(tmpPath, content, "utf8");
  try {
    await rename(tmpPath, path);
  } catch (err) {
    await unlink(tmpPath).catch(() => {});
    throw err;
  }
}

// 同じidの既存candidateがあれば置き換え(再実行時に重複を積み上げない)、無ければ追加する。
// approvedBy/approvedAtがcandidateに含まれていても、ここでは一切検証・付与しない
// (このストアは保存するだけで、承認可否の判断はlib/approval-gate.mjs側の責務のまま)。
export async function upsertCandidates(path, candidates) {
  const current = await readCandidatesFile(path);
  const byId = new Map(current.items.map((item) => [item.id, item]));
  for (const candidate of candidates) {
    byId.set(candidate.id, candidate);
  }
  const next = { ...current, items: [...byId.values()] };
  await writeJsonAtomic(path, next);
  return next;
}
