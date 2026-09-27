// .github/workflows/*.yml のテキストを直接検査する軽量な安全性チェック(YAMLパーサ非依存・外部依存なし)。
// GitHub Actions側の実際の解釈までは検証できないが、
// 「二重ゲート・concurrency groupの一致・schedule有無」といった、
// テキストレベルでの回帰(誰かが誤って設定を変えてしまうこと)を検知するためのテスト。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function readWorkflow(name) {
  return readFileSync(fileURLToPath(new URL(`../.github/workflows/${name}`, import.meta.url)), "utf8");
}

function concurrencyGroup(content) {
  const match = content.match(/concurrency:\s*\n\s*group:\s*(\S+)/);
  return match ? match[1] : null;
}

function topLevelOnBlock(content) {
  // "on:" ブロックから、次に列頭(インデント無し)で始まる行の直前までを取り出す。
  const match = content.match(/^on:\n([\s\S]*?)(?=^\S)/m);
  return match ? match[1] : "";
}

test("live-post-manual.ymlとdaily-live-post.ymlは同じconcurrency groupを共有する(同時実行による二重投稿を防ぐため)", () => {
  const manual = readWorkflow("live-post-manual.yml");
  const daily = readWorkflow("daily-live-post.yml");
  const manualGroup = concurrencyGroup(manual);
  const dailyGroup = concurrencyGroup(daily);
  assert.ok(manualGroup, "live-post-manual.ymlにconcurrency groupが無い");
  assert.ok(dailyGroup, "daily-live-post.ymlにconcurrency groupが無い");
  assert.equal(dailyGroup, manualGroup, "concurrency groupがlive-post-manual.ymlとdaily-live-post.ymlで異なる(同時実行による二重投稿のリスク)");
});

test("daily-live-post.ymlにscheduleのcronトリガーがちょうど1つ設定されている", () => {
  const content = readWorkflow("daily-live-post.yml");
  const cronMatches = [...content.matchAll(/^\s*-\s*cron:\s*"([^"]+)"/gm)];
  assert.equal(cronMatches.length, 1, "cronトリガーが0個または複数ある");
});

test("live-post-manual.ymlにはscheduleトリガーが存在しない(手動実行専用であることを維持)", () => {
  const onBlock = topLevelOnBlock(readWorkflow("live-post-manual.yml"));
  assert.doesNotMatch(onBlock, /\bschedule:/);
  assert.match(onBlock, /workflow_dispatch:/);
});

test("daily-post.yml(Phase 2 dry-run)は ${{ secrets.LIVE_POST }} という式を実際には参照せず、LIVE_POSTを常に\"false\"に固定している", () => {
  const content = readWorkflow("daily-post.yml");
  assert.match(content, /LIVE_POST:\s*"false"/);
  // コメント本文中の「secrets.LIVE_POSTを参照していない」という説明文自体は許容し、
  // 実際のGitHub Actions式 ${{ secrets.LIVE_POST }} が使われていないことだけを厳密にチェックする。
  assert.doesNotMatch(content, /\$\{\{\s*secrets\.LIVE_POST\s*\}\}/);
});

test("daily-live-post.yml / live-post-manual.yml は投稿成功時(POSTED_STATE_SAVED)のみcommit/pushする条件になっている", () => {
  for (const name of ["daily-live-post.yml", "live-post-manual.yml"]) {
    const content = readWorkflow(name);
    assert.match(content, /if:\s*steps\.publish\.outputs\.outcome == 'POSTED_STATE_SAVED'/, `${name}: commit条件が見つからない`);
  }
});

test("daily-live-post.yml / live-post-manual.yml は THREADS_CLIENT_SECRET(App Secret) を一切参照しない", () => {
  for (const name of ["daily-live-post.yml", "live-post-manual.yml"]) {
    const content = readWorkflow(name);
    assert.doesNotMatch(content, /CLIENT_SECRET/i, `${name}: App Secretへの参照が見つかった`);
  }
});

test("3つのworkflowすべてでshellがbashに明示されている(pipefailを効かせるため)", () => {
  for (const name of ["daily-post.yml", "live-post-manual.yml", "daily-live-post.yml"]) {
    const content = readWorkflow(name);
    assert.match(content, /shell:\s*bash/, `${name}: shell: bash の明示が見つからない`);
  }
});
