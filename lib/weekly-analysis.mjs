// 週次分析ロジック(テーマ非依存の純粋関数のみ。ネットワーク・Secrets・ファイルI/Oは一切扱わない)。
//
// 方針(ユーザー指示に基づく):
//   - 「このテーマが勝ちパターン」等の断定はしない。投稿数・フォロワー数が少ない前提を常に保つ。
//   - viewsだけで良し悪しを判断しない(likes/replies/reposts/quotes/shares も並べて提示するだけ)。
//   - 結果は facts(客観的事実) / tentativeTrends(暫定的な傾向・弱い根拠付き) /
//     openQuestions(サンプル不足等でまだ判断できないこと) の3種類に分けて返す。
//     どれに分類するかの閾値はMIN_SAMPLE_FOR_TRENDで一元管理する。

import { latestSnapshotsByPostId } from "./threads-insights-store.mjs";

// この件数未満のグループ(pillar等)については「傾向」とすら呼ばず、常にopenQuestions側へ回す。
const MIN_SAMPLE_FOR_TREND = 3;
// 全体の投稿数がこれ未満の場合、傾向分析そのものに強い留保を付ける。
const MIN_TOTAL_FOR_ANY_TREND = 10;

const WEEKDAYS_JA = ["日", "月", "火", "水", "木", "金", "土"];

function weekdayJaFromIso(iso) {
  const d = new Date(iso);
  // JSTでの曜日・時刻を見るため+9hしてからUTC扱いで読む(既存lib/target-date.mjsのjstDateKeyと同じ考え方)。
  const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  return { weekday: WEEKDAYS_JA[jst.getUTCDay()], hour: jst.getUTCHours() };
}

function average(numbers) {
  const valid = numbers.filter((n) => typeof n === "number" && Number.isFinite(n));
  if (valid.length === 0) return null;
  return valid.reduce((a, b) => a + b, 0) / valid.length;
}

// data/threads-posts.json の posts[] と data/draft-bank.json の items[] (sourceItemIdで紐付け)、
// data/threads-insights-history.json の最新スナップショットを1つの配列にまとめる。
export function buildPerPostView({ posts, bankItems, insightsHistory }) {
  const bankById = new Map((bankItems || []).map((item) => [item.id, item]));
  const latestInsights = latestSnapshotsByPostId(insightsHistory);

  return (posts || []).map((post) => {
    const bankItem = bankById.get(post.sourceItemId);
    const insight = latestInsights.get(post.threadsPostId) ?? null;
    const { weekday, hour } = weekdayJaFromIso(post.postedAt);

    return {
      sourceItemId: post.sourceItemId,
      threadsPostId: post.threadsPostId,
      day: bankItem?.day ?? null,
      pillar: post.pillar ?? bankItem?.pillar ?? null,
      category: post.category ?? bankItem?.category ?? null,
      postedAt: post.postedAt,
      postedWeekdayJa: weekday,
      postedHourJst: hour,
      hasImage: Boolean(bankItem?.media?.path),
      hasCta: bankItem?.hasCta === true,
      hasShopLink: bankItem?.hasShopLink === true,
      insights: insight
        ? { views: insight.views, likes: insight.likes, replies: insight.replies, reposts: insight.reposts, quotes: insight.quotes, shares: insight.shares, fetchedAt: insight.fetchedAt }
        : null
    };
  });
}

function groupBy(perPost, keyFn) {
  const groups = new Map();
  for (const p of perPost) {
    const key = keyFn(p) ?? "(不明)";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }
  return groups;
}

function summarizeGroup(items) {
  const withInsights = items.filter((i) => i.insights);
  return {
    postCount: items.length,
    insightsAvailableCount: withInsights.length,
    avgViews: average(withInsights.map((i) => i.insights.views)),
    avgLikes: average(withInsights.map((i) => i.insights.likes)),
    avgReplies: average(withInsights.map((i) => i.insights.replies)),
    avgReposts: average(withInsights.map((i) => i.insights.reposts)),
    avgQuotes: average(withInsights.map((i) => i.insights.quotes))
  };
}

// content-ideas.json のテーマ・postIdeasのうち、draft-bank.jsonでまだ使われていなさそうな
// ものを一覧化する(厳密な自動判定ではなく、参考情報としての粗い一覧)。
export function findUnusedContentIdeas({ contentIdeas, bankItems }) {
  const usedCategories = new Set((bankItems || []).map((i) => i.category));
  const usedText = (bankItems || []).map((i) => `${i.bodyJa}`).join("\n");

  const result = [];
  for (const theme of contentIdeas?.themes || []) {
    for (const idea of theme.postIdeas || []) {
      // ワーキングタイトルの主要な語が既存本文に現れていれば「使用済みの可能性が高い」とみなし、
      // 一覧から除外する(厳密一致ではなく簡易ヒューリスティック。最終判断は人間が行う)。
      const likelyUsed = usedText.includes(idea.workingTitle) || usedCategories.has(idea.id.toUpperCase().replace(/-/g, "_"));
      if (!likelyUsed) {
        result.push({ themeId: theme.id, themeTitle: theme.title, ideaId: idea.id, workingTitle: idea.workingTitle });
      }
    }
  }
  return result;
}

export function analyzeWeekly({ posts, bankItems, insightsHistory, contentIdeas, pillars }) {
  const perPost = buildPerPostView({ posts, bankItems, insightsHistory });
  const postedCount = perPost.length;

  const facts = [];
  const tentativeTrends = [];
  const openQuestions = [];

  facts.push(`現在Threadsへ投稿済みの件数: ${postedCount}件。`);
  const withInsightsCount = perPost.filter((p) => p.insights).length;
  facts.push(`Insightsを取得できた投稿: ${withInsightsCount}/${postedCount}件。`);

  if (postedCount < MIN_TOTAL_FOR_ANY_TREND) {
    openQuestions.push(
      `投稿数が${postedCount}件(閾値${MIN_TOTAL_FOR_ANY_TREND}件未満)のため、どのpillar・カテゴリー・時間帯が良いかは現時点では判断できません。`
    );
  }

  // pillar別の素朴な集計(verdictは出さない。数値を並べるだけ)。
  const byPillar = groupBy(perPost, (p) => p.pillar);
  const perPillarSummary = {};
  for (const [pillar, items] of byPillar) {
    const summary = summarizeGroup(items);
    perPillarSummary[pillar] = summary;
    if (summary.insightsAvailableCount >= MIN_SAMPLE_FOR_TREND && postedCount >= MIN_TOTAL_FOR_ANY_TREND) {
      tentativeTrends.push(
        `pillar=${pillar}: ${summary.insightsAvailableCount}件の平均viewsは${summary.avgViews?.toFixed(1) ?? "不明"}(暫定値。因果関係は不明、断定不可)。`
      );
    } else {
      openQuestions.push(`pillar=${pillar}: サンプル${summary.insightsAvailableCount}件(Insights取得済み)では傾向を論じられません。`);
    }
  }

  // カテゴリー別も同様に集計のみ(傾向化はpillarより閾値を満たしにくいため、ほぼopenQuestions行き)。
  const byCategory = groupBy(perPost, (p) => p.category);
  const perCategorySummary = {};
  for (const [category, items] of byCategory) {
    perCategorySummary[category] = summarizeGroup(items);
  }

  // 曜日・時間帯・画像有無・CTA有無・ショップ誘導有無は、件数が少なすぎるため
  // 常にopenQuestions側(個別の断定トレンドは生成しない)。
  const recentPillarSequence = perPost
    .slice()
    .sort((a, b) => String(a.postedAt).localeCompare(String(b.postedAt)))
    .map((p) => p.pillar);
  facts.push(`直近の投稿pillar順: ${recentPillarSequence.filter(Boolean).join(" → ") || "(まだ投稿なし)"}。`);

  const shopLinkCount = perPost.filter((p) => p.hasShopLink).length;
  facts.push(`ショップ誘導(hasShopLink)付きの投稿: ${shopLinkCount}/${postedCount}件。`);

  const unusedContentIdeas = findUnusedContentIdeas({ contentIdeas, bankItems });
  facts.push(`content-ideas.jsonに残っている(使用済みと判定されなかった)アイデア: ${unusedContentIdeas.length}件。`);

  openQuestions.push("この投稿数・フォロワー数の段階では、「この投稿形式が正解」「この時間帯が最適」とは言えません。");

  return {
    generatedAt: new Date().toISOString(),
    postedCount,
    perPost,
    perPillarSummary,
    perCategorySummary,
    recentPillarSequence,
    unusedContentIdeas,
    facts,
    tentativeTrends,
    openQuestions
  };
}
