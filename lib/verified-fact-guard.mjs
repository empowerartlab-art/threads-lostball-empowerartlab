// 「事実は verified-facts.json、表現はAI/人」を強制する唯一の関所(テーマ非依存)。
// requiresVerifiedFact:true の候補は、対応する verifiedFactIds が
// すべて data/verified-facts.json 上で verified:true でない限り選出・昇格できない。

export function canUseCandidate(item, facts) {
  if (!item?.requiresVerifiedFact) return { ok: true };

  const ids = Array.isArray(item.verifiedFactIds) ? item.verifiedFactIds : [];
  if (ids.length === 0) {
    return { ok: false, reason: "requires-verified-fact-but-no-fact-id" };
  }

  const factMap = new Map((facts || []).map((fact) => [fact.id, fact]));
  for (const id of ids) {
    const fact = factMap.get(id);
    if (!fact || fact.verified !== true) {
      return { ok: false, reason: `unverified-fact:${id}` };
    }
  }

  return { ok: true };
}
