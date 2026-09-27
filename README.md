# threads-lostball-empowerartlab

`@lost_ball_empowerartlab`（Japan Lost Golf Balls）のThreads運用基盤。

**現在はPhase 2着手中（Meta認証・接続確認・長期アクセストークン取得は完了済み。GitHub Actionsによるdry-run運用の準備を実装中。Threadsへの実投稿・Discordへの実送信はまだ一切行っていない）。**

## 中心思想

- 単なる中古ゴルフボールの安売りアカウントにはしない
- ブランドの5軸：JAPAN / ENVIRONMENT / WELFARE / SOCIAL_CONTRIBUTION / GOLF
- 「事実は verified-facts.json、表現はAI/人」：`data/verified-facts.json` に無い事実は投稿本文で使用できない
- 投稿は必ず「英語 → 日本語」の順で併記し、合計500文字以内、本文に生URLを含めない（ショップ誘導は常にプロフィールリンク経由）
- 福祉の同情訴求・過度な美談化、根拠のない環境効果の数値化、未確認の断定表現（all/every/すべて/必ず 等）を避ける
- AIによる自動承認・自動昇格は禁止（`draft-bank.json`への追加は人間の明示的承認が必須）
- 画像も「画像が無いから、とりあえずAI画像を作る」運用は禁止。詳細は [`MEDIA_POLICY.md`](./MEDIA_POLICY.md) を参照

## ディレクトリ構成

```
data/
  brand-profile.json          # 5軸・ポジショニング・投稿ルール・NGリスト
  verified-facts.json         # 捏造防止の唯一の関所。ここに無い事実は使用不可
  category-profile.json       # 5軸、初期7投稿のカテゴリー割当、週2以降の候補カテゴリー
  media-policy.json           # メディア運用方針の構造化データ(詳細はMEDIA_POLICY.md)
  draft-bank.json             # 承認済み投稿キュー(初期7投稿+メディア情報を登録済み)
  draft-bank-candidates.json  # 未承認候補の置き場(現時点では空)
  threads-posts.json          # 投稿記録(Phase 1以降の実投稿開始後にのみ追記。現時点では空)

lib/                          # テーマ非依存の汎用ロジック。Threads API・秘密情報は一切扱わない
  target-date.mjs             # targetDate方式の選出順ロジック
  duplicate-guard.mjs         # 投稿済み本文との重複防止(英語+日本語の併記本文を正規化して比較)
  bilingual-guard.mjs         # 「英語→日本語」構造・合計500文字・生URL禁止のチェック
  verified-fact-guard.mjs     # verified-facts.jsonにある事実以外は使用不可にする関所
  claim-guard.mjs             # 未確認の断定表現・環境効果の数値断定・福祉の同情訴求を検知(警告のみ)
  media-guard.mjs             # メディア運用ガード。画像必須の投稿は人間承認済み素材が無いと選出不可にする関所
  approval-gate.mjs           # 人間の明示的承認が無いと候補を昇格させない(mediaはそのまま引き継ぎ、自動承認はしない)
  redact.mjs                  # 秘密値をログ・エラーメッセージから除去する共通ユーティリティ
  load-local-env.mjs          # .env.localの読み込みのみ。値は一切ログに出さない
  threads-client.mjs          # Threads Graph APIの低レベル呼び出し(現時点はGET /meのみ。投稿(POST)は未実装)
  post-report.mjs             # 選出済み候補から dry-run レポート(文字数/pillar/CTA/画像/各ガード結果)を組み立てる純粋関数
  discord-notifier.mjs        # Discord通知のdry-run用メッセージを組み立てるだけ(実送信コードは未実装)

scripts/                      # ローカル実行専用。Threads/Meta APIへは一切接続しない(post-to-threads.mjsもdry-run専用でAPIに書き込まない)
  select-daily-candidate.mjs  # 本日投稿してよい候補をdraft-bank.jsonから選出し表示するだけ(メディア状態も表示)
  promote-candidates.mjs      # candidate→draft-bank.json への唯一の昇格経路(--approvedBy, --yes必須)
  validate-data.mjs           # data/*.json の構造整合性・併記フォーマット・事実整合性・メディア整合性チェック
  threads-auth-url.mjs        # 認可URLを生成して表示するだけ(接続・書き込みなし)
  exchange-threads-token.mjs  # 認可コード→短期→長期トークン交換・GET /me確認・.env.localへの安全な保存
  check-threads-connection.mjs # GET /me による接続確認のみ(書き込みなし)
  post-to-threads.mjs         # Phase 2: 投稿処理のdry-run専用。実際にThreads/DiscordへPOSTするコードは実装していない

tests/                        # node標準テストランナーのみ使用(外部依存なし・ネットワーク不要。post-to-threads-cli.test.mjsのみnode自身を子プロセスとして起動する)

.github/workflows/
  daily-post.yml               # Phase 2: 候補選出→ガードチェック→投稿dry-run→結果ログ確認 を自動実行(実投稿・実送信は行わない)
```

## メディア(画像)運用方針

詳細は [`MEDIA_POLICY.md`](./MEDIA_POLICY.md) を参照。要点：

- 投稿ごとに `TEXT_ONLY` / `REAL_PHOTO` / `PRODUCT_PHOTO` / `REAL_WORK` / `AI_ASSISTED_VISUAL` / `BRAND_GRAPHIC` のいずれかの`media.type`を持つ
- `media.required: true` の投稿は、人間が承認した実際の素材(`path`/`approvedBy`/`approvedAt`)が揃うまで本番選出されない。システムが自動でAI画像を生成・添付することは一切無い
- 承認済みの実写系(`REAL_PHOTO`/`REAL_WORK`/`PRODUCT_PHOTO`)は`aiVisualAllowed:true`にできない(AI画像を実写と偽ることを防ぐ)
- 承認済みの`AI_ASSISTED_VISUAL`は、何を参考にしたかの記録(`aiReferenceNote`)が無いと無効(「とりあえずAI画像」を防ぐ)

## 実行方法（すべてローカル・オフライン）

```bash
npm test                        # 全テスト実行
npm run check                   # 構文チェック
npm run lostball:validate-data  # data/*.json の整合性チェック
npm run lostball:select-daily   # 本日の投稿候補をローカル選出(投稿はしない)
npm run lostball:post-dry-run   # 投稿処理のdry-run(実投稿はしない。文字数/ガード結果/Discordプレビュー等を表示)
```

## Phase構成

1. **Phase 0（完了）**：ディレクトリ構成、brand-profile/verified-facts/category-profile/draft-bank、ローカル選出・検証ロジック、初期テスト、メディア運用方針・メディアガード
2. **Phase 1（完了）**：Meta認証・Threads API接続確認。長期アクセストークン取得・`GET /me`接続確認まで完了済み
3. **Phase 2（着手中）**：GitHub Actions dry-run運用(`.github/workflows/daily-post.yml`)、投稿処理dry-run(`scripts/post-to-threads.mjs`)、Discordもdry-run構造のみ。実投稿・実送信は未実装
4. **Phase 3**：人間の明示確認のもとで初回のみ手動live投稿テスト(ライブ投稿コードの実装はこのフェーズで行う)
5. **Phase 4**：GitHub Secrets `LIVE_POST=true` 設定、スケジュール本番投稿開始

## Phase 2: GitHub Actions dry-run運用

`.github/workflows/daily-post.yml` が `checkout → Node.jsセットアップ → 依存関係インストール →
構文チェック → テスト → データ検証 → 当日の投稿候補選出 → 投稿処理のdry-run → 結果ログ確認`
を自動実行する(`workflow_dispatch` で手動実行、または毎日09:00 JSTのスケジュール実行)。

- **実投稿しないための二重ゲート**：`scripts/post-to-threads.mjs` は、環境変数 `LIVE_POST` が文字列
  `"true"` と一致し、かつCLI引数 `--live` が明示的に渡された場合にのみライブ投稿の分岐に進もうとする。
  しかしこのPhase 2の時点では、Threads/DiscordへPOSTする処理そのものを一切実装していないため、
  両方の条件が揃った場合でも明示的にエラーで中断する(誤ってSecretsに`LIVE_POST=true`を設定しても実投稿されない)。
- **Secretsは要求しない**：dry-runはdata配下のローカルファイルのみで完結するため、このワークフローは
  `THREADS_ACCESS_TOKEN` 等のSecretsを一切必要とせず、未登録の状態でも実行できる。
- 想定しているSecrets名(**この段階ではまだGitHub Secretsへ登録していない**。Phase 3/4で必要になった時点で登録する):
  `THREADS_ACCESS_TOKEN` / `THREADS_USER_ID` / `THREADS_USERNAME` / `LIVE_POST` / `DISCORD_WEBHOOK_URL` / `LIVE_DISCORD`
- 画像の扱い：`data/draft-bank.json` の `media` 構造(`type`/`required`/承認情報)はPhase 2でも維持し、
  dry-runレポート上で「画像あり/画像なし/画像未承認」を判定できるようにしている。画像生成・画像投稿・
  外部画像取得はPhase 2の範囲外(実装していない)。

## Phase 1: Meta側で人間が行う手動セットアップ

1. [Meta for Developers](https://developers.facebook.com/apps) で新規アプリを作成し、「Threads」プロダクトを追加する
2. アプリの権限設定で `threads_basic` / `threads_content_publish` / `threads_manage_insights` を有効化する
3. リダイレクトURIを1つ登録する（後述の認可フローで使用。HTTPS必須。例: `https://www.facebook.com/connect/login_success.html` のような、コピー&ペーストで`code`を取得しやすい静的ページ、または自分が管理するHTTPSページ）
4. アプリダッシュボードから **App ID** と **App Secret** を控える
5. プロジェクト直下に `.env.local` を作成し(`.env.example`を参考に)、以下を設定する:
   ```
   THREADS_CLIENT_ID=<App ID>
   THREADS_CLIENT_SECRET=<App Secret>
   THREADS_REDIRECT_URI=<手順3で登録したリダイレクトURI>
   ```
6. `npm run lostball:auth-url` を実行し、表示されたURLを **@lost_ball_empowerartlab としてログインした状態のブラウザ** で開いて認可する
7. リダイレクト先URLの `code` クエリパラメータの値をコピーする
8. `node scripts/exchange-threads-token.mjs --code="<コピーした値>"` を実行する（トークン交換に成功すると`.env.local`へ自動保存される。値はログに出力されない）
9. `npm run lostball:check-connection` を実行し、`接続確認(GET /me): OK` と自分のusername/user_idが表示されることを確認する

この手順は人間が行う必要があり、Claudeが代行することはできない（Meta開発者アカウントへのログイン・ブラウザでのOAuth同意が必要なため）。

## 参考プロジェクトについて

`~/threads-harley-solo` および `~/Downloads/threads-automation-claude-shared` は同じ設計思想の先行プロジェクト。参考にする場合も読み取りのみとし、変更は行わない。
