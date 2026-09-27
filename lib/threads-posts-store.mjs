// data/threads-posts.json への投稿記録の永続化のみを担当する(テーマ非依存)。
// Threads API呼び出し・git add/commit/pushは一切行わない
// (commit/pushは別責務。live-post-manual workflow側でのみ扱う想定)。
//
// 書き込みは「一時ファイルへ書き込み→rename」のatomic write方式とし、
// 書き込み途中の異常終了・失敗で既存のJSONが破損することを防ぐ。
// renameは同一ディレクトリ内(=同一ファイルシステム内)であればOSレベルで原子的に行われる。
//
// duplicate-guard.mjs(buildPostedBodySet/normalizeBilingualBody)が期待する
// posts[]の形(各要素がbodyEn/bodyJaを持つオブジェクト)を壊さない。
// 既存の _note 等、posts/count/updatedAt以外のトップレベルフィールドも保持する。

import { readFile, writeFile, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

export async function readPostsFile(path) {
  try {
    const content = await readFile(path, "utf8");
    const json = JSON.parse(content);
    return {
      updatedAt: null,
      count: 0,
      ...json,
      posts: Array.isArray(json.posts) ? json.posts : []
    };
  } catch {
    return { updatedAt: null, count: 0, posts: [] };
  }
}

// 一時ファイルへ書き込んでからrenameする。writeFile自体が失敗した場合、
// 対象ファイルにはまだ一切触れていないため元の内容は無傷のまま。
// rename自体が失敗した場合も、一時ファイルを掃除したうえで例外を投げ直す
// (対象ファイルはrenameが成功するまで一切書き換わらない)。
export async function writeJsonAtomic(path, data) {
  const dir = dirname(path);
  const tmpPath = join(dir, `.${randomUUID()}.threads-posts.tmp`);
  const content = `${JSON.stringify(data, null, 2)}\n`;

  await writeFile(tmpPath, content, "utf8");
  try {
    await rename(tmpPath, path);
  } catch (err) {
    await unlink(tmpPath).catch(() => {});
    throw err;
  }
}

// 既存のposts[]・その他のトップレベルフィールドを保持したまま1件追記するだけ。
// Threads API呼び出し・git操作はここでは一切行わない。
// 呼び出す前提: Threadsへの投稿(publish)が既に成功していること
// (呼び出し側 = lib/live-post-runner.mjs が、publish成功後にのみこれを呼ぶ)。
export async function appendPostRecord(path, record) {
  const current = await readPostsFile(path);
  const posts = [...current.posts, record];
  const next = {
    ...current,
    posts,
    count: posts.length,
    updatedAt: new Date().toISOString()
  };
  await writeJsonAtomic(path, next);
  return next;
}
