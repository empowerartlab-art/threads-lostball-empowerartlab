// scripts/post-to-threads.mjs の「二重ゲート」が実際に機能することを、
// 別プロセスとして起動して確認する(外部依存・ネットワークは使わない。node自身のみ)。

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = fileURLToPath(new URL("../scripts/post-to-threads.mjs", import.meta.url));

function run(args, envOverrides) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...envOverrides },
    encoding: "utf8"
  });
}

test("両ゲート(LIVE_POST=true + --live)が揃っても実投稿コードが無いため中断し、終了コード1になる", () => {
  const result = run(["--live"], { LIVE_POST: "true" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /実装していません/);
  assert.doesNotMatch(result.stdout + result.stderr, /最終結果: DRY_RUN \(実投稿は行っていません\)/);
});

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
