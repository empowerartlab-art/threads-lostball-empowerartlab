# threads-lostball-empowerartlab

`@lost_ball_empowerartlab`（Japan Lost Golf Balls）のThreads運用基盤。

**現在はPhase 3着手中（Phase 2完了。Threads実投稿のコード・専用GitHub Actions workflow・投稿記録の永続化まで実装済み。ただしGitHub Secrets未登録のため、実際にThreadsへ投稿できる状態にはまだなっていない。Threadsへの実投稿・Discordへの実送信はまだ一切行っていない）。**

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
  threads-client.mjs          # Threads Graph APIの低レベル呼び出し(GET /me、投稿の2段階API: コンテナ作成→publish)
  post-report.mjs             # 選出済み候補から dry-run レポート(文字数/pillar/CTA/画像/各ガード結果)を組み立てる純粋関数
  discord-notifier.mjs        # Discord通知のdry-run用メッセージを組み立てるだけ(実送信コードは未実装)
  threads-publish.mjs         # live投稿の二重ゲート(env.LIVE_POST==="true" かつ live===true)＋API呼び出し＋投稿レコード生成
  live-post-runner.mjs        # 候補選出→既存ガード→二重ゲート→publishPost→state保存 のオーケストレーション(選出/ガード/API呼び出しは再実装せず既存モジュールを呼ぶだけ)
  threads-posts-store.mjs     # data/threads-posts.jsonへの投稿記録の永続化専用(atomic write。git操作は一切行わない)

scripts/                      # ローカル実行専用。Threads/Meta APIへは、二重ゲートが揃わない限り一切接続しない
  select-daily-candidate.mjs  # 本日投稿してよい候補をdraft-bank.jsonから選出し表示するだけ(メディア状態も表示)
  promote-candidates.mjs      # candidate→draft-bank.json への唯一の昇格経路(--approvedBy, --yes必須)
  validate-data.mjs           # data/*.json の構造整合性・併記フォーマット・事実整合性・メディア整合性チェック
  threads-auth-url.mjs        # 認可URLを生成して表示するだけ(接続・書き込みなし)
  exchange-threads-token.mjs  # 認可コード→短期→長期トークン交換・GET /me確認・.env.localへの安全な保存
  check-threads-connection.mjs # GET /me による接続確認のみ(書き込みなし)
  post-to-threads.mjs         # 候補選出→ガード→(二重ゲート)→投稿→(成功時のみ)state保存 のCLI。ロジックはlib/live-post-runner.mjs等に委譲する薄いシェル

tests/                        # node標準テストランナーのみ使用(外部依存なし・ネットワーク不要。fetchは全テストでスタブ。post-to-threads-cli.test.mjsのみnode自身を子プロセスとして起動する)

.github/workflows/
  daily-post.yml               # 候補選出→ガードチェック→投稿dry-run→結果ログ確認 を自動実行(schedule付き。LIVE_POSTは常に"false"固定・--liveも渡さないため実投稿・実送信は発生しない)
  live-post-manual.yml         # Phase 3 Stage 4: 実際にThreadsへ投稿できる可能性がある唯一のworkflow。workflow_dispatch専用(schedule無し)、確認文字列必須、二重ゲート、投稿成功時のみdata/threads-posts.jsonをcommit/push
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
3. **Phase 2（完了）**：GitHub Actions dry-run運用(`.github/workflows/daily-post.yml`)、投稿処理dry-run(`scripts/post-to-threads.mjs`)、Discordもdry-run構造のみ
4. **Phase 3（コード実装まで完了・実行は未着手）**：人間の明示確認のもとで初回のみ手動live投稿テストを行うためのコード・workflowを実装済み。詳細は下記「Phase 3」節。**GitHub SecretsとGitHub画面での実行はまだ行っていない**
5. **Phase 4**：Phase 3の初回手動live投稿テストが人間の確認により成功したのち、`daily-post.yml`側にもlive投稿を組み込みスケジュール本番投稿を開始するかどうかを検討する(現時点では未着手・未設計)

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

## Phase 3: live投稿の準備(コード実装済み・実行はまだ未着手)

Threadsへ実際に投稿するコード自体は実装済みだが、**GitHub Secretsを登録していないため、
現時点でThreadsへ実投稿することはできない**。実際に投稿できる状態にするには、人間が
GitHub画面でSecretsを登録したうえで、専用workflowを手動実行する必要がある(下記参照)。

### 実装内容

- `lib/threads-client.mjs`：Threads投稿の2段階API(コンテナ作成 `POST /{userId}/threads` →
  公開 `POST /{userId}/threads_publish`)
- `lib/threads-publish.mjs`：**二重ゲート**(`env.LIVE_POST==="true"` かつ CLI引数 `--live` の
  両方が揃わない限り、上記APIを一切呼ばずdry-runを返す)＋投稿レコード生成
- `lib/live-post-runner.mjs`：候補選出→既存ガード再検証→二重ゲート→投稿→(成功時のみ)state保存、
  の一連の流れをオーケストレーション。`OUTCOME`(`NO_CANDIDATE`/`DRY_RUN`/`PRE_POST_FAILURE`/
  `POSTED_STATE_SAVED`/`POSTED_STATE_SAVE_FAILED`)で結果を明確に区別する
- `lib/threads-posts-store.mjs`：`data/threads-posts.json`への**atomic write**(一時ファイル→rename)。
  投稿が実際に成功した場合にのみ呼ばれる。git操作は一切行わない
- `scripts/post-to-threads.mjs`：上記を呼び出す薄いCLI。`LIVE_POST=false`の場合の出力は
  Phase 2から一切変更していない(既存の自動化・GitHub Actionsへの影響なし)
- `.github/workflows/live-post-manual.yml`：**実際にThreadsへ投稿できる可能性がある唯一のworkflow**
  (詳細は次項)

### `live-post-manual.yml` の安全設計

- トリガーは `workflow_dispatch` のみ。**`schedule` は設定していない**(自動発火する経路が無い)
- 実行時、確認用入力欄に正確に `POST LIVE` と入力しない限り、最初のstepで中断する
- 二重ゲート：GitHub Secretsに `LIVE_POST=true` が登録されていない限り、実行しても常にdry-run結果になる
  (`daily-post.yml` は `secrets.LIVE_POST` を一切参照しないため、この設定はそちらには影響しない)
- `concurrency` グループにより同時実行(≒二重投稿)を防止
- `data/threads-posts.json` へのcommit/pushは、**投稿成功かつstate保存成功
  (`outcome=POSTED_STATE_SAVED`) の場合にのみ**実行する
- 投稿は成功したがstate保存やcommit/pushに失敗した場合(`POSTED_STATE_SAVE_FAILED`)は、
  jobを失敗させ「再実行禁止・人間による実アカウント確認が必要」なことをログに明示する。
  **このworkflowに自動リトライの仕組みは一切無い**
- Discordへの実通知はこのworkflowでも一切行わない

### GitHub側で必要なSecrets(現時点では未登録)

| Secret名 | 必要性 | 用途 |
|---|---|---|
| `THREADS_ACCESS_TOKEN` | 必須 | Threads API呼び出しの`access_token` |
| `THREADS_USER_ID` | 必須 | 投稿先ユーザーのuser_id(URLパスに使用) |
| `LIVE_POST` | 必須(値は文字列`true`) | 二重ゲートの片方。未登録または`true`以外なら常にdry-run |
| `THREADS_USERNAME` | 不要 | API呼び出しには使わない(ログ表示専用。Secretsに登録しなくてよい) |
| `THREADS_CLIENT_SECRET`(App Secret) | 不要 | トークン交換(ローカル専用作業)にのみ使用。GitHub Actionsでは一切使わないため登録しない |
| `DISCORD_WEBHOOK_URL` / `LIVE_DISCORD` | 不要(現時点) | Discord実送信コード自体が未実装のため、今は登録不要 |

### 初回手動live投稿テストの実施手順(人間が行う。Claudeは代行できない)

1. GitHubリポジトリ `empowerartlab-art/threads-lostball-empowerartlab` の
   **Settings → Secrets and variables → Actions** を開く
2. **New repository secret** で以下を1件ずつ登録する
   - `THREADS_ACCESS_TOKEN`：`.env.local` の値(ローカルの`npm run lostball:check-connection`が
     成功している値と同じもの)
   - `THREADS_USER_ID`：同上
   - `LIVE_POST`：値は文字列 `true`
3. リポジトリの **Actions** タブ → 左メニューから
   **Lost Ball Threads - LIVE Post (Manual, Phase 3 Stage 4)** を選択
4. 右側の **Run workflow** ボタンを押し、`confirm` 欄に正確に `POST LIVE` と入力して実行
5. 実行結果(job のログ、および artifact `lostball-live-post-log`)を確認する
   - `POSTED_STATE_SAVED` になっていれば、Threadsアカウント(@lost_ball_empowerartlab)を直接開いて
     投稿が実際に反映されていることを目視確認し、`data/threads-posts.json` がcommitされたことを
     `git log` / GitHub上のファイル履歴で確認する
   - `POSTED_STATE_SAVE_FAILED` になった場合は、**このworkflowを再実行しない**こと。
     Threadsアカウントを直接確認したうえで、人間が手動で`data/threads-posts.json`へ記録を追記する

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
