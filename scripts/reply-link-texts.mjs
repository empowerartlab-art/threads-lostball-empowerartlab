// 返信の文(data/reply-link-texts.json): 一覧を見る、または代表者が承認する。
//   node scripts/reply-link-texts.mjs                                        -> 一覧とチェック(何も書き換えない)
//   node scripts/reply-link-texts.mjs --approve --by KEITA --yes             -> 全部承認
//   node scripts/reply-link-texts.mjs --approve --only a,b --by KEITA --yes  -> 選んだ id だけ承認
// 承認は人だけが行う(AI による自動承認は禁止)。一覧にエラーがあれば何も書き換えない。
import { validateTexts, pickText, REPLY_TEXTS_PATH, MIN_VIEWS, CHECK_TIMES, jstDate } from '../lib/reply-link.mjs';
import { addDays } from '../lib/slots.mjs';
import { fileIo } from '../lib/json-io.mjs';

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
};
const texts = await fileIo.readJson(REPLY_TEXTS_PATH, []);
const errors = validateTexts(texts);

if (!process.argv.includes('--approve')) {
  console.log(`返信の文（質問の投稿の表示が${MIN_VIEWS}以上になったら、自分の返信として1回だけ付ける）`);
  console.log(`チェックの時刻：${Object.values(CHECK_TIMES).join('・')}（夜は2時間後の1回だけ）\n`);
  for (const t of texts) {
    const when = t.from || t.until ? `  使う期間：${t.from ?? '最初'}〜${t.until ?? 'ずっと'}` : '  使う期間：いつでも';
    console.log(`[${t.id}] ${t.approved ? '✅ 承認済み' : '⏳ 未承認'}${when}`);
    for (const l of String(t.text).split('\n')) console.log(`    ${l}`);
    console.log('');
  }
  const today = jstDate();
  console.log('これからの7日に使う文（承認済みの中から日替わり）：');
  for (let i = 0; i < 7; i++) {
    const d = addDays(today, i);
    console.log(`  ${d}: ${pickText(texts, d)?.id ?? '（承認済みの文なし → 返信しない）'}`);
  }
  if (errors.length) {
    console.error(`\nエラー：\n${errors.join('\n')}`);
    process.exit(1);
  }
  process.exit(0);
}

const by = arg('by');
if (!by || !process.argv.includes('--yes')) {
  console.error('usage: reply-link-texts.mjs --approve [--only id,id] --by NAME --yes');
  process.exit(1);
}
const only = arg('only') ? new Set(arg('only').split(',').map((s) => s.trim())) : null;
const unknown = only ? [...only].filter((id) => !texts.some((t) => t.id === id)) : [];
if (unknown.length) errors.push(...unknown.map((id) => `--only ${id}: no such text`));
if (errors.length) {
  console.error(`何も書き換えません：\n${errors.join('\n')}`);
  process.exit(1);
}
const now = new Date().toISOString();
const next = texts.map((t) => ((!only || only.has(t.id)) && t.approved !== true ? { ...t, approved: true, approvedBy: by, approvedAt: now } : t));
await fileIo.writeJson(REPLY_TEXTS_PATH, next);
console.log(`承認しました：${next.filter((t, i) => t.approved && !texts[i].approved).map((t) => t.id).join(', ') || '（新しく承認したものなし）'}`);
console.log(`${REPLY_TEXTS_PATH} を commit・push してください。`);
