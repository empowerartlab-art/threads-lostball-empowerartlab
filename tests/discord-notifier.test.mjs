import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDiscordDryRunMessage } from "../lib/discord-notifier.mjs";
import { buildDryRunReport } from "../lib/post-report.mjs";

const facts = [{ id: "fact-a", verified: true }];
const item = {
  id: "item-1",
  day: 1,
  pillar: "JAPAN",
  category: "BRAND_INTRO",
  bodyEn: "Hello.",
  bodyJa: "こんにちは。",
  hasCta: false,
  hasShopLink: false,
  requiresVerifiedFact: false,
  verifiedFactIds: [],
  targetDate: null,
  media: { type: "TEXT_ONLY", required: false }
};

test("buildDiscordDryRunMessage: dry-runであることと未送信であることを明記する", () => {
  const report = buildDryRunReport(item, { postedBodySet: new Set(), facts });
  const message = buildDiscordDryRunMessage(report);
  assert.match(message, /DRY-RUN/);
  assert.match(message, /実際のDiscord送信は行っていません/);
  assert.match(message, new RegExp(item.id));
});
