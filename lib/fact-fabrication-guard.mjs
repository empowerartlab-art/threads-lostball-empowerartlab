// 「事実はdata/verified-facts.json、表現は人間+AI」の原則(lib/verified-fact-guard.mjs)には、
// 1つ構造的な抜け道がある: requiresVerifiedFact:false の候補は検証自体をスキップするため、
// 本文に具体的な未確認事実(特定ゴルフ場での回収・回収数/販売数/寄付数の数字・架空の取引先・
// 利用者の架空エピソード・障害/症状の創作・架空の環境効果・架空の寄付実績)を書いてしまっても、
// 既存のverified-fact-guardは一切検知できない(lib/claim-guard.mjsは一部を警告として検出するが、
// ハード制約ではなく、昇格・選出をブロックしない)。
//
// このガードは、そのすり抜けを塞ぐためのもの: requiresVerifiedFact!==true の本文(bodyEn/bodyJa)に、
// 「具体的な未確認事実を断定している」強い言語パターンが含まれていたら検出する。
// lib/claim-guard.mjsと違い、こちらはscripts/promote-candidates.mjs・scripts/select-daily-candidate.mjs
// でハードドロップ(警告ではなく、候補を採用しない)に使う前提で設計している。
// requiresVerifiedFact:true の候補(=verified-fact-guardで実在id確認済み)には適用しない。

const FACT_FABRICATION_PATTERNS = [
  {
    family: "unverified-collection-claim",
    description: "特定のゴルフ場・場所での回収活動は、実際に確認された事実でなければ断定しない",
    pattern:
      /((ゴルフ場|golf course)[^。！？\n]{0,20}(で回収|から回収|collected (it |them )?from)|今(週|月)[^。！？\n]{0,10}(回収しました|回収した)|(this (week|month))[^。！？\n]{0,10}(we )?collected)/i
  },
  {
    family: "fabricated-count-claim",
    description: "回収数・販売数・寄付数・廃棄数等の具体的な数字は、実際に確認された事実でなければ創作しない",
    pattern:
      /(\d[\d,]*\s*(球|個|玉)(を)?(回収|集め|販売|売れ|寄付|廃棄)|(\d[\d,]*\s*(balls?))\s*(were\s*)?(collected|sold|donated|discarded)|(collected|sold|donated|discarded)\s*(\d[\d,]*\s*(balls?)))/i
  },
  {
    family: "unverified-partner-claim",
    description: "存在確認できない取引先・協力企業・ゴルフ場等の関係は断定しない",
    pattern:
      /((ゴルフ場|企業|会社)[^。！？\n]{0,15}(と提携|と協力|から提供|と契約)|(partnered with|in partnership with|teamed up with)[^。！？\n]{0,20})/i
  },
  {
    family: "fabricated-user-episode",
    description: "利用者・スタッフ等の架空の発言・エピソードは、実際に確認された事実でなければ創作しない",
    pattern: /(利用者(が|の)[^。！？\n]{0,20}(と言った|と話した|と話してくれた)|(a user|our (staff|member))[^。！？\n]{0,20}(said|told us))/i
  },
  {
    family: "fabricated-health-info",
    description: "利用者の障害・症状等の個人情報・健康情報は創作しない",
    pattern: /(利用者の(障害|症状|病名|診断)|(a user'?s?|our member'?s?) (disability|diagnosis|condition))/i
  },
  {
    family: "unverified-environmental-impact",
    description: "CO2削減量・環境効果の具体的な数値断定は、実際に確認された事実でなければ創作しない",
    pattern: /(CO2[^。！？\n]{0,10}(削減|減らし)|(\d+\s*(%|パーセント|トン|tons?|kg))[^。！？\n]{0,15}(削減|reduc))/i
  },
  {
    family: "fabricated-donation-achievement",
    description: "寄付実績・社会貢献実績の具体的な金額・達成断定は、実際に確認された事実でなければ創作しない",
    pattern: /((\d[\d,]*\s*(円|万円))(を)?(寄付しました|寄付した)|donated\s*[$￥][\d,]+)/i
  }
];

export function checkFactFabricationSignals({ bodyEn, bodyJa }) {
  const warnings = [];
  const texts = [
    { lang: "ja", text: String(bodyJa || "") },
    { lang: "en", text: String(bodyEn || "") }
  ];
  for (const { family, description, pattern } of FACT_FABRICATION_PATTERNS) {
    for (const { lang, text } of texts) {
      const match = text.match(pattern);
      if (match) {
        warnings.push({ family, lang, excerpt: match[0], description });
        break; // 同じfamilyは1件報告すれば十分(en/ja両方に出ても重複報告しない)。
      }
    }
  }
  return { ok: warnings.length === 0, warnings };
}

export const FACT_FABRICATION_FAMILIES = FACT_FABRICATION_PATTERNS.map(({ family, description }) => ({
  family,
  description
}));
