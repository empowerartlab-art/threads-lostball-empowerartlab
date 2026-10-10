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

// コメント行(# で始まる行。説明文中に語彙として出てくるのは許容する)を除いた
// 実際のYAML本体だけを対象にしたい検査で使う。
function stripComments(content) {
  return content
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n");
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

// 2026-10-10〜: 朝(日本語)と夜(英語)の2スロット。cronごとに言語が1対1で決まり、
// 未知のcronでは投稿せずに止まることを確認する(言語の取り違え・同じ言語の二重投稿を防ぐ)。
test("daily-live-post.ymlのcronは朝(日本語)と夜(英語)の2つで、それぞれ言語が1対1で決まる", () => {
  const content = readWorkflow("daily-live-post.yml");
  const crons = [...content.matchAll(/^\s*-\s*cron:\s*"([^"]+)"/gm)].map((m) => m[1]).sort();
  assert.deepEqual(crons, ["0 12 * * *", "0 20 * * *"]);
  assert.match(content, /"0 20 \* \* \*"\) LANG_ARG=ja ;;/);
  assert.match(content, /"0 12 \* \* \*"\) LANG_ARG=en ;;/);
  assert.match(content, /\*\) echo "未知のscheduleです[^\n]*exit 1 ;;/);
  assert.match(content, /post-to-threads\.mjs \$\{\{ steps\.mode\.outputs\.live_flag \}\} --lang=\$\{\{ steps\.lang\.outputs\.lang \}\}/);
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

test("daily-live-post.yml / live-post-manual.yml は、POSTED_STATE_SAVE_FAILED/PRE_POST_FAILUREの" +
  "stepにfailure()を明示している(前のstepの失敗でスキップされるGitHub Actionsの既知の挙動への対策)", () => {
  for (const name of ["daily-live-post.yml", "live-post-manual.yml"]) {
    const content = readWorkflow(name);
    assert.match(
      content,
      /if:\s*failure\(\)\s*&&\s*steps\.publish\.outputs\.outcome == 'POSTED_STATE_SAVE_FAILED'/,
      `${name}: POSTED_STATE_SAVE_FAILED分岐にfailure()が無い(前stepの失敗でスキップされる可能性がある)`
    );
    assert.match(
      content,
      /if:\s*failure\(\)\s*&&\s*steps\.publish\.outputs\.outcome == 'PRE_POST_FAILURE'/,
      `${name}: PRE_POST_FAILURE分岐にfailure()が無い(前stepの失敗でスキップされる可能性がある)`
    );
  }
});

test("daily-live-post.ymlのDiscord通知stepはすべてcontinue-on-error: trueで、Discord送信失敗がjob全体を失敗させない", () => {
  const content = readWorkflow("daily-live-post.yml");
  const discordStepBlocks = content
    .split(/^\s{6}- name:/m)
    .filter((block) => /Discord通知/.test(block.split("\n")[0]));
  assert.ok(discordStepBlocks.length >= 4, "Discord通知stepが想定数(4)未満しか見つからない");
  for (const block of discordStepBlocks) {
    assert.match(block, /continue-on-error:\s*true/, "Discord通知stepにcontinue-on-error: trueが無い");
  }
});

test("daily-live-post.ymlのDiscord通知stepは DISCORD_WEBHOOK_URL/LIVE_DISCORD を secrets. 経由でのみ参照し、直書きしていない", () => {
  const content = readWorkflow("daily-live-post.yml");
  assert.match(content, /DISCORD_WEBHOOK_URL:\s*\$\{\{\s*secrets\.DISCORD_WEBHOOK_URL\s*\}\}/);
  assert.match(content, /LIVE_DISCORD:\s*\$\{\{\s*secrets\.LIVE_DISCORD\s*\}\}/);
  // discord.com/api/webhooks/ のような実際のWebhook URLらしき文字列がハードコードされていないこと。
  assert.doesNotMatch(content, /https:\/\/discord(?:app)?\.com\/api\/webhooks\/\d+/);
});

test("daily-live-post.ymlのDiscord通知stepは、NO_CANDIDATE/DRY_RUNの分岐を持たない(通知しない方針)", () => {
  const content = readWorkflow("daily-live-post.yml");
  const discordIfLines = [...content.matchAll(/Discord通知[^\n]*\n\s*if:\s*([^\n]+)/g)].map((m) => m[1]);
  assert.ok(discordIfLines.length >= 4);
  for (const line of discordIfLines) {
    assert.doesNotMatch(line, /NO_CANDIDATE|DRY_RUN/, `NO_CANDIDATE/DRY_RUNでもDiscord通知される条件が見つかった: ${line}`);
  }
});

test("scripts/send-discord-notification.mjs はHarleyの scripts/send-discord-notification.mjs と同じ二重ゲート設計(--live + LIVE_DISCORD)を持つ", () => {
  const content = readFileSync(fileURLToPath(new URL("../scripts/send-discord-notification.mjs", import.meta.url)), "utf8");
  assert.match(content, /--live/);
  assert.doesNotMatch(content, /CLIENT_SECRET/i);
});

test("discord-notification-test.ymlにはscheduleトリガーが存在しない(手動実行専用)", () => {
  const onBlock = topLevelOnBlock(readWorkflow("discord-notification-test.yml"));
  assert.doesNotMatch(onBlock, /\bschedule:/);
  assert.match(onBlock, /workflow_dispatch:/);
});

test("discord-notification-test.ymlはTHREADS_ACCESS_TOKEN/THREADS_USER_ID/LIVE_POSTを実際には参照しない(Threads APIを呼ばない)", () => {
  // コメント本文中で「これらは参照しない」と説明している語彙自体は許容し、
  // 実際のYAMLキー・値・shellコマンドとしての参照が無いことだけを厳密にチェックする。
  const content = stripComments(readWorkflow("discord-notification-test.yml"));
  assert.doesNotMatch(content, /THREADS_ACCESS_TOKEN/);
  assert.doesNotMatch(content, /THREADS_USER_ID/);
  assert.doesNotMatch(content, /secrets\.LIVE_POST\b/);
  assert.doesNotMatch(content, /CLIENT_SECRET/i);
});

test("discord-notification-test.ymlはgit commit/pushやdata/threads-posts.jsonへの操作を実際には含まない", () => {
  const content = stripComments(readWorkflow("discord-notification-test.yml"));
  assert.doesNotMatch(content, /git (commit|push|add)/);
  assert.doesNotMatch(content, /threads-posts\.json/);
});

test("discord-notification-test.ymlは DISCORD_WEBHOOK_URL/LIVE_DISCORD を secrets. 経由でのみ参照し、直書きしていない", () => {
  const content = readWorkflow("discord-notification-test.yml");
  assert.match(content, /DISCORD_WEBHOOK_URL:\s*\$\{\{\s*secrets\.DISCORD_WEBHOOK_URL\s*\}\}/);
  assert.match(content, /LIVE_DISCORD:\s*\$\{\{\s*secrets\.LIVE_DISCORD\s*\}\}/);
  assert.doesNotMatch(content, /https:\/\/discord(?:app)?\.com\/api\/webhooks\/\d+/);
});

test("discord-notification-test.ymlはpermissions: contents: readのみで、書き込み権限を持たない", () => {
  const content = readWorkflow("discord-notification-test.yml");
  assert.match(content, /permissions:\s*\n\s*contents:\s*read/);
  assert.doesNotMatch(content, /contents:\s*write/);
});

test("discord-notification-test.ymlはshellがbashに明示され、既存のscripts/send-discord-notification.mjsをそのまま呼び出す", () => {
  const content = readWorkflow("discord-notification-test.yml");
  assert.match(content, /shell:\s*bash/);
  assert.match(content, /node scripts\/send-discord-notification\.mjs --live --content=/);
});

test("weekly-review.ymlは毎週土曜日9:00 JST(UTC 0:00土曜日)のcronがちょうど1つ設定されている", () => {
  const content = readWorkflow("weekly-review.yml");
  const cronMatches = [...content.matchAll(/^\s*-\s*cron:\s*"([^"]+)"/gm)];
  assert.equal(cronMatches.length, 1, "cronトリガーが0個または複数ある");
  assert.equal(cronMatches[0][1], "0 0 * * 6");
});

test("weekly-review.ymlはdata/draft-bank.json・data/verified-facts.json・data/threads-posts.jsonへ一切書き込まない(git add対象に含めない)", () => {
  const content = stripComments(readWorkflow("weekly-review.yml"));
  const gitAddLines = [...content.matchAll(/git add ([^\n]+)/g)].map((m) => m[1]);
  assert.ok(gitAddLines.length > 0, "git addの行が見つからない");
  for (const line of gitAddLines) {
    assert.doesNotMatch(line, /data\/draft-bank\.json(?!-candidates)/, `git addにdraft-bank.jsonが含まれている: ${line}`);
    assert.doesNotMatch(line, /data\/verified-facts\.json/, `git addにverified-facts.jsonが含まれている: ${line}`);
    assert.doesNotMatch(line, /data\/threads-posts\.json/, `git addにthreads-posts.jsonが含まれている: ${line}`);
  }
});

test("weekly-review.ymlは新しいSecretsを要求しない(既存のTHREADS_ACCESS_TOKEN/THREADS_USER_ID/DISCORD_WEBHOOK_URL/LIVE_DISCORDのみ参照)", () => {
  const content = stripComments(readWorkflow("weekly-review.yml"));
  const secretRefs = [...content.matchAll(/secrets\.([A-Z_]+)/g)].map((m) => m[1]);
  const allowed = new Set(["THREADS_ACCESS_TOKEN", "THREADS_USER_ID", "DISCORD_WEBHOOK_URL", "LIVE_DISCORD"]);
  for (const name of secretRefs) {
    assert.ok(allowed.has(name), `未許可の新しいSecretsが参照されている: ${name}`);
  }
});

test("weekly-review.ymlは THREADS_CLIENT_SECRET(App Secret) を一切参照しない", () => {
  const content = readWorkflow("weekly-review.yml");
  assert.doesNotMatch(content, /CLIENT_SECRET/i);
});

test("weekly-review.ymlのDiscord通知は「候補」「確認・承認してください」という文言を含み、投稿・予約が完了したかのような表現を含まない", () => {
  const content = readWorkflow("weekly-review.yml");
  const discordStepMatch = content.match(/Discord通知[\s\S]*?run:\s*\|([\s\S]*?)(?=\n {6}- name:|\n?$)/);
  assert.ok(discordStepMatch, "Discord通知stepが見つからない");
  const body = discordStepMatch[1];
  assert.match(body, /候補/);
  assert.match(body, /確認|承認/);
  assert.doesNotMatch(body, /投稿予約完了|予約が完了|投稿が完了/);
});

test("weekly-review.ymlはThreads投稿・削除・編集を行う関数(createTextContainer/createImageContainer/publishContainer)を呼ぶコードを一切含まない", () => {
  const content = stripComments(readWorkflow("weekly-review.yml"));
  assert.doesNotMatch(content, /createTextContainer|createImageContainer|publishContainer|post-to-threads\.mjs/);
});
