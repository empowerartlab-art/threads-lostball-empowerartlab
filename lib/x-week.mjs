// 土曜の週次レビュー用: 次の火曜〜月曜の X 予定（2026-10-20〜は1日3本×7日＝21本）と承認状況を Markdown にする。
// 足りない枠には「元にする日本語 Threads（同じ日・同じ枠）」を並べる（そこから X 用に書き直す）。読み取りのみ。
import { X_SLOTS, X_SLOTS_START, X_POSTS_PER_DAY, isXSlotItem } from './x-slots.mjs';
import { addDays, weekdayJa } from './slots.mjs';

const firstLine = (t) => (String(t ?? '').split('\n').find((l) => l.trim()) ?? '').slice(0, 30);

export function xWeekMarkdown(queue, threadsItems, { start, end }) {
  const out = [`## X 来週の予定（${start}〜${end}）`, ''];
  const dates = [];
  for (let d = start; d <= end; d = addDays(d, 1)) dates.push(d);
  const slotDates = dates.filter((d) => d >= X_SLOTS_START);
  const expected = slotDates.length * X_POSTS_PER_DAY;
  const inWeek = queue.filter((p) => p.date >= start && p.date <= end);
  if (expected) {
    const made = inWeek.filter(isXSlotItem).length;
    const approved = inWeek.filter((p) => isXSlotItem(p) && p.approved === true).length;
    out.push(`- 1日3本（朝07:10・昼12:10・夜20:10）: 作成 ${made}/${expected}本・承認 ${approved}/${expected}本`);
    if (made < expected) out.push('  → 足りない分は Claude に「来週のXを作って」と依頼（同じ日・同じ枠の日本語 Threads を X 用に書き直す）');
    out.push('  → 承認: `node scripts/x-bulk-approve.mjs --week ' + slotDates[0] + '`（見るだけ）→ `--by 名前 --yes`');
  }
  for (const d of dates) {
    if (d < X_SLOTS_START) {
      for (const p of inWeek.filter((x) => x.date === d)) out.push(`- ${d}（${weekdayJa(d)}）05:53 ${p.approved ? '✅承認済み' : '⏳未承認'} ${p.id}「${firstLine(p.text)}」`);
      continue;
    }
    for (const s of X_SLOTS) {
      const p = inWeek.find((x) => x.date === d && x.slot === s.slot);
      if (p) {
        out.push(`- ${d}（${weekdayJa(d)}）${s.label}${s.time} ${p.approved ? '✅承認済み' : '⏳未承認'} ${p.id}「${firstLine(p.text)}」`);
        continue;
      }
      const src = (threadsItems || []).find((i) => i.targetDate === d && i.slot === s.slot && i.lang === 'ja');
      out.push(`- ${d}（${weekdayJa(d)}）${s.label}${s.time} ❌まだありません${src ? `（元にする Threads: ${src.id}「${firstLine(src.bodyJa)}」）` : '（同じ枠の日本語 Threads もまだありません）'}`);
    }
  }
  if (!inWeek.length && !expected) out.push('- まだ1本もありません → Claude に「来週のXを作って」と依頼');
  out.push('');
  return out.join('\n');
}
