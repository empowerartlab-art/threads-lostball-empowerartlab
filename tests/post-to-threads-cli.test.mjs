// scripts/post-to-threads.mjs の「二重ゲート」が実際に機能することを、
// 別プロセスとして起動して確認する(外部依存・ネットワークは使わない。node自身のみ)。
//
// 注意(Stage 2以降): このファイルではLIVE_POST=true かつ --live が両方揃うケース
// (二重ゲートを実際に通過してThreads APIへ接続しようとするケース)は
// 意図的にテストしていない。このプロセスは実際の.env.local(実アクセストークンを含みうる)を
// そのまま読み込んで起動するため、fetchをスタブできず、誤って本物のThreads APIへ
// 到達するリスクがある。その組み合わせの安全性(fetchが正しい回数だけ呼ばれる、
// ガード失敗時にfetchが一切呼ばれない等)は、fetchを安全にスタブできる
// tests/live-post-runner.test.mjs / tests/threads-publish.test.mjs / tests/threads-client.test.mjs
// (いずれも同一プロセス内でglobalThis.fetchを差し替える)で検証済み。
// このファイルでは「二重ゲートが揃わない限りdry-runのまま」という安全側だけを、
// 実プロセス起動レベルでも確認する。

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildHeaderLine } from "../scripts/post-to-threads.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = fileURLToPath(new URL("../scripts/post-to-threads.mjs", import.meta.url));

function run(args, envOverrides) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...envOverrides },
    encoding: "utf8"
  });
}

test("LIVE_POST=trueのみ(--live無し)なら通常通りdry-runで正常終了する", () => {
  const result = run([], { LIVE_POST: "true" });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /最終結果: DRY_RUN/);
});

test("--liveのみ(LIVE_POST未設定)なら通常通りdry-runで正常終了する", () => {
  const result = run(["--live"], { LIVE_POST: "" });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /最終結果: DRY_RUN/);
});

test("デフォルト(何も指定しない)ならdry-runで正常終了し、最終結果にDRY_RUNと出る", () => {
  const result = run([], { LIVE_POST: "", LIVE_DISCORD: "" });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Phase 2: 実投稿は一切行いません/);
  assert.match(result.stdout, /最終結果: DRY_RUN/);
});

// buildHeaderLine自体は純粋関数なので、ネットワーク・二重ゲートに一切触れずに
// 「live実行時はliveであることが明確に分かる表示になる」ことを直接検証できる
// (実プロセスでLIVE_POST=true+--liveを試すと本物のThreads APIへ接続してしまうため、
//  このファイルではそのケースを子プロセスとしては実行しない。上のコメント参照)。
test("buildHeaderLine: liveを試みる場合は「実投稿は一切行いません」ではなくLIVEと明確に分かる見出しになる", () => {
  const line = buildHeaderLine(true);
  assert.match(line, /LIVE/);
  assert.doesNotMatch(line, /実投稿は一切行いません/);
});

test("buildHeaderLine: dry-runの場合はPhase 2から見出しを変更していない", () => {
  assert.equal(buildHeaderLine(false), "=== Threads投稿 dry-run (Phase 2: 実投稿は一切行いません) ===");
});

test("GITHUB_OUTPUTが設定されている場合、dry-run実行後にoutcome=DRY_RUNが書き出される", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lostball-github-output-"));
  const outputFile = join(dir, "github_output");
  try {
    const result = run([], { LIVE_POST: "", LIVE_DISCORD: "", GITHUB_OUTPUT: outputFile });
    assert.equal(result.status, 0);
    const content = await readFile(outputFile, "utf8");
    assert.match(content, /^outcome=DRY_RUN$/m);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("GITHUB_OUTPUTが未設定なら何も書き出さず、エラーにもならない(ローカル実行の互換性)", () => {
  const result = run([], { LIVE_POST: "", LIVE_DISCORD: "", GITHUB_OUTPUT: "" });
  assert.equal(result.status, 0);
});

test("GITHUB_OUTPUT: sourceItemId/bodyが書き出され、改行を含むbodyはheredoc区切り構文で壊れずに書かれる", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lostball-github-output-body-"));
  const outputFile = join(dir, "github_output");
  try {
    const result = run([], { LIVE_POST: "", LIVE_DISCORD: "", GITHUB_OUTPUT: outputFile });
    assert.equal(result.status, 0);
    const content = await readFile(outputFile, "utf8");
    // sourceItemIdは候補が選出されるdry-runでは常に非空(実データにDAY1〜7が存在するため)。
    assert.match(content, /^sourceItemId=\S+/m);
    // bodyは改行を含むため "name=value" 形式ではなく "name<<DELIM ... DELIM" 形式で書かれる。
    assert.match(content, /^body<<ghadelim_[a-z0-9]+$/m);
    assert.doesNotMatch(content, /^body=/m);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
