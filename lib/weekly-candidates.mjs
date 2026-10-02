// 翌週7投稿の「候補スケルトン」を生成する純粋関数(ネットワーク・ファイルI/O・Secretsは扱わない)。
//
// 重要な設計判断(意図的な制限。README/報告で必ず明示すること):
//   このモジュールは「どのpillar/カテゴリーを選ぶか」という配分・重複回避の判断だけを行い、
//   投稿本文(bodyEn/bodyJa)そのものは生成しない。プレースホルダー文言を入れるだけに留める。
//   理由: 本文を自動生成すると、verified-facts.jsonに無い事実を断定したり、過去投稿の
//   言い換えを量産したりするリスクを完全には防げない。事実確認と自然な文章化は、
//   このセッションでDAY1〜22まで行ってきたのと同じく、常に人間(+人間とのチャット)が行う。
//   ここで自動化するのは「配分・重複回避・ネタの棚卸し」という機械的な部分だけに絞る。
//
// 生成された候補は data/draft-bank-candidates.json に書き込まれるだけで、
// approvedBy/approvedAtは常にnull(lib/approval-gate.mjsのpromoteCandidateが
// 要求する明示的承認が無い限り、data/draft-bank.jsonへは絶対に昇格しない)。

const PILLARS = ["JAPAN", "ENVIRONMENT", "WELFARE", "SOCIAL_CONTRIBUTION", "GOLF"];

function categoryIdFromSlug(slug) {
  return slug.toUpperCase().replace(/-/g, "_");
}

function addDaysToDateString(dateStr, days) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

// 次の7日分(targetDate)を返す。weekStartDateKeyは「翌週火曜日」のYYYY-MM-DD。
export function nextSevenDates(weekStartDateKey) {
  return Array.from({ length: 7 }, (_, i) => addDaysToDateString(weekStartDateKey, i));
}

// todayDateKey(YYYY-MM-DD, JST想定)から見て、直近の「未来の」火曜日を返す。
// 今日が火曜日であっても今日自身は返さず、1週間後の火曜日を返す
// (毎週土曜日に実行する前提: 土曜+3日=火曜日になる)。
export function nextTuesdayDateKey(todayDateKey) {
  const [y, m, d] = todayDateKey.split("-").map(Number);
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=日,1=月,2=火,...,6=土
  let daysUntilTuesday = (2 - weekday + 7) % 7;
  if (daysUntilTuesday === 0) daysUntilTuesday = 7;
  return addDaysToDateString(todayDateKey, daysUntilTuesday);
}

// 既存投稿(bankItems)のpillar分布をもとに、7枠分のpillarを割り当てる。
// 「このpillarが勝ちパターン」等の判断は一切含まない、完全に機械的な配分。
//
// 設計: 使用回数が少ないpillar順に並べたリストを作り、そのリストを単純に
// ラウンドロビン(繰り返し)で7枠に割り当てる(slot[i] = sortedPillars[i % 5])。
// 5 pillars・7枠のため、必ず2つのpillarだけ2回選ばれるが、その2つは
// 「最も使われていない2つ」になる。1週間(7投稿)の中で5軸すべてに必ず触れる
// (brand-profile.jsonのsalesFrequencyPolicy「JAPAN/ENVIRONMENT/WELFARE/
// SOCIAL_CONTRIBUTION/GOLFを分散する」という既存方針に沿う)一方で、
// 歴史的な偏りを少しずつ埋める方向にもなる、という2つの要件を両立する。
// (単純な「最小値を毎回選び直す」貪欲法は、僅差の2つのpillarが交互に選ばれ続けて
// 他の3つのpillarが1週間丸ごと出現しない、という結果になり得るため採用しない)。
export function assignPillarsForNextWeek(bankItems, slotCount = 7) {
  const counts = Object.fromEntries(PILLARS.map((p) => [p, 0]));
  for (const item of bankItems || []) {
    if (item.pillar && counts[item.pillar] !== undefined) counts[item.pillar] += 1;
  }

  const sortedByLeastUsed = [...PILLARS].sort((a, b) => counts[a] - counts[b] || PILLARS.indexOf(a) - PILLARS.indexOf(b));
  return Array.from({ length: slotCount }, (_, i) => sortedByLeastUsed[i % sortedByLeastUsed.length]);
}

// category-profile.jsonのweek2PlusCandidateCategoriesのうち、まだdraft-bank.jsonで
// 使われていなさそうなものだけを、pillarごとのプールに整理する。
function buildCategoryPool(categoryProfile, bankItems) {
  const usedCategories = new Set((bankItems || []).map((i) => i.category));
  const pool = Object.fromEntries(PILLARS.map((p) => [p, []]));
  for (const entry of categoryProfile?.week2PlusCandidateCategories || []) {
    const categoryId = categoryIdFromSlug(entry.id);
    if (usedCategories.has(categoryId)) continue;
    if (!pool[entry.pillar]) continue;
    pool[entry.pillar].push({ source: "category-profile", id: entry.id, categoryId, labelJa: entry.labelJa });
  }
  return pool;
}

// content-ideas.jsonのテーマidからpillarを推測する簡易マップ(このリポジトリの2テーマに限定)。
const CONTENT_IDEA_THEME_PILLAR = {
  "environmental-conservation": "ENVIRONMENT",
  "hitori-janai-yo-project-deep-dive": "SOCIAL_CONTRIBUTION"
};

function buildContentIdeaPool(unusedContentIdeas) {
  const pool = Object.fromEntries(PILLARS.map((p) => [p, []]));
  for (const idea of unusedContentIdeas || []) {
    const pillar = CONTENT_IDEA_THEME_PILLAR[idea.themeId];
    if (!pillar || !pool[pillar]) continue;
    pool[pillar].push({ source: "content-ideas", id: idea.ideaId, categoryId: categoryIdFromSlug(idea.ideaId), labelJa: idea.workingTitle });
  }
  return pool;
}

function pickTopicForPillar(pillar, categoryPool, contentIdeaPool, usedThisBatch) {
  const candidates = [...(categoryPool[pillar] || []), ...(contentIdeaPool[pillar] || [])];
  const unused = candidates.find((c) => !usedThisBatch.has(c.id));
  if (unused) {
    usedThisBatch.add(unused.id);
    return unused;
  }
  return null;
}

function placeholderBody(pillar, topic) {
  const topicLabel = topic ? topic.labelJa : "(未定・新規ネタ検討が必要)";
  const en = `[DRAFT PLACEHOLDER - not written yet. Pillar: ${pillar}. Suggested topic: ${topicLabel}. A human must write and fact-check this post (against data/verified-facts.json) before it can be approved.]`;
  const ja = `[下書き未作成のプレースホルダーです。pillar: ${pillar}。候補テーマ: ${topicLabel}。投稿前に、data/verified-facts.json で裏付けられる範囲で人間が本文を執筆・ファクトチェックしてください。]`;
  return { en, ja };
}

// 翌週7日分の「候補スケルトン」を生成する。
// 戻り値の各要素は data/draft-bank-candidates.json にそのまま追加できる形。
export function generateWeeklyCandidates({ bankItems, categoryProfile, unusedContentIdeas, weekStartDateKey, startDay, generatedAt = new Date().toISOString() }) {
  const dates = nextSevenDates(weekStartDateKey);
  const pillarAssignment = assignPillarsForNextWeek(bankItems, dates.length);
  const categoryPool = buildCategoryPool(categoryProfile, bankItems);
  const contentIdeaPool = buildContentIdeaPool(unusedContentIdeas);
  const usedThisBatch = new Set();

  return dates.map((targetDate, index) => {
    const pillar = pillarAssignment[index];
    const topic = pickTopicForPillar(pillar, categoryPool, contentIdeaPool, usedThisBatch);
    const category = topic ? topic.categoryId : "TOPIC_TBD";
    const { en, ja } = placeholderBody(pillar, topic);

    return {
      id: `lostball-candidate-${targetDate.replace(/-/g, "")}`,
      day: startDay + index,
      pillar,
      category,
      bodyEn: en,
      bodyJa: ja,
      hasCta: false,
      hasShopLink: false,
      requiresVerifiedFact: false,
      verifiedFactIds: [],
      targetDate,
      status: "needs_human_draft",
      suggestedTopic: topic ? { source: topic.source, id: topic.id, labelJa: topic.labelJa } : null,
      note:
        "自動生成されたスケルトンです。本文は未執筆のプレースホルダーのため、このまま承認・昇格しないでください。" +
        "人間が内容を執筆し、必要に応じてrequiresVerifiedFact/verifiedFactIdsを設定したうえで、" +
        "scripts/promote-candidates.mjs による明示的な人間承認を経てdraft-bank.jsonへ昇格させてください。",
      media: { type: "TEXT_ONLY", required: false, aiVisualAllowed: false, description: "テキストのみで投稿可能。", altText: null, aiReferenceNote: null, path: null, approvedBy: null, approvedAt: null },
      approvedBy: null,
      approvedAt: null,
      generatedAt
    };
  });
}
