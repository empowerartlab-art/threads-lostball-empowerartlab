// プロジェクト名の書き方の検査（2026-10-25 代表者決定）。
// 正式な書き方は「ひとりじゃないよプロジェクト」（BASE のショップ説明と同じ）。漢字の「一人じゃないよ」は使わない。
// 投稿済みの過去記録（data/threads-posts.json・x-posts.json・ig-posts.json・journal 系）と、
// 2026-10-25 以前の draft-bank・queue の項目は対象外（投稿済みの本文を変えると二重投稿の判定が崩れるため）。

export const PROJECT_NAME = "ひとりじゃないよプロジェクト";
export const OLD_PROJECT_NAME_RE = /一人じゃないよ/;
// この日付以降の項目だけを検査する（10/25 以前は投稿済みかどうかに関わらず触らない）。
export const PROJECT_NAME_RULE_START = "2026-10-26";

const TEXT_FIELDS = ["bodyEn", "bodyJa", "text", "caption"];
const MEDIA_FIELDS = ["altText", "description"];

// 文字列に古い書き方があればエラー文を返す（無ければ null）。
export function projectNameProblem(text) {
  if (typeof text !== "string" || !OLD_PROJECT_NAME_RE.test(text)) return null;
  return `「一人じゃないよ」は使わない。正式な書き方は「${PROJECT_NAME}」`;
}

// 投稿の項目（Threads の bodyEn/bodyJa、X の text、IG の caption、画像の説明）を検査する。
export function checkProjectName(item) {
  const errors = [];
  for (const k of TEXT_FIELDS) {
    const p = projectNameProblem(item?.[k]);
    if (p) errors.push(`${k}: ${p}`);
  }
  for (const k of MEDIA_FIELDS) {
    const p = projectNameProblem(item?.media?.[k]);
    if (p) errors.push(`media.${k}: ${p}`);
  }
  return errors;
}

// 検査の対象になる日付か（YYYY-MM-DD で 2026-10-26 以降）。
export const isProjectNameRuleDate = (date) => typeof date === "string" && date >= PROJECT_NAME_RULE_START;
