// 代表が OK した返信を、指定のコメントに出す（手動実行だけ）。
// 入力 REPLIES_JSON = [{"id": "コメントID", "text": "返信文"}, ...]
// すでに自分の返信があるコメントには出さない。ログには結果だけ（本文は出さない）。
import { alreadyReplied, postReply, checkReply } from '../lib/comment-autoreply.mjs';

const token = (process.env.THREADS_ACCESS_TOKEN ?? '').trim();
const userId = (process.env.THREADS_USER_ID ?? '').trim();
const list = JSON.parse(process.env.REPLIES_JSON ?? '[]');
let failed = 0;
for (const [i, r] of list.entries()) {
  const id = String(r.id ?? '').replace(/^threads:/, '');
  const bad = checkReply(r.text);
  if (!/^\d+$/.test(id) || bad) { console.log(`${i + 1}: 出さない（${bad || 'IDが不正'}）`); failed++; continue; }
  if (await alreadyReplied({ token, commentId: id })) { console.log(`${i + 1}: もう返信済み`); continue; }
  const p = await postReply({ token, userId, commentId: id, text: String(r.text).trim() });
  console.log(`${i + 1}: ${p.ok ? '返信した' : p.maybePosted ? '出たか不明（Threadsで確認）' : '失敗'}`);
  if (!p.ok) failed++;
}
process.exit(failed ? 1 : 0);
