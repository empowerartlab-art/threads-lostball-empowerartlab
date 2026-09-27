// targetDate方式の選出順ロジック(テーマ非依存)。

export function jstDateKey(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  return new Date(date.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// 複数の'YYYY-MM-DD'日付キーの中から最大値を返す。有効な値が無ければnull。
export function maxDateKey(keys) {
  const valid = (Array.isArray(keys) ? keys : []).filter(Boolean);
  if (valid.length === 0) return null;
  return valid.reduce((max, key) => (key > max ? key : max));
}

// targetDateが今日(JST)以前に来ているアイテムを早い順に並べ、
// その後ろにtargetDate未指定のアイテムを配列順(FIFO)で続ける。
// targetDateがまだ来ていないアイテムはこの結果に一切含まれない。
export function selectDueItems(items, todayKey = jstDateKey()) {
  const list = Array.isArray(items) ? items : [];
  const dueDated = list
    .filter((item) => item.targetDate && item.targetDate <= todayKey)
    .sort((a, b) => a.targetDate.localeCompare(b.targetDate));
  const undated = list.filter((item) => !item.targetDate);
  return [...dueDated, ...undated];
}
