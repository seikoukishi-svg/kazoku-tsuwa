# 引き継ぎ（家族通話アプリ / レベル2b途中）

このリポジトリは、家族4人が「名前で呼び出して通話」できる Android アプリ（Capacitor）。
**いま「アプリを閉じていても着信音が鳴る」(レベル2b)を実装中で、着信送信サーバのデプロイ直前で止まっている。**
完全無料・クレジットカード登録なし・Androidのみ・電話番号不要、が絶対要件。

---

## 1. 現在地（要約）

- 動く: ネイティブAndroidアプリ。**名前で発信→相手に着信→応答→受話口で通話**（両方がアプリを開いていれば成立）。マイク通常ON、受話口出力はネイティブ実装済み。FCM受信トークンの取得・保存も動作確認済み。
- 未完: **閉じた/ロック中でも鳴らす**。そのための FCM送信サーバ(Cloudflare Worker)の**デプロイが未完**（このAI環境では「ユーザーの認証情報で本番デプロイ」が安全機構でブロックされ未実行）。

## 2. 場所・リポジトリ

- **ソースの正本（ビルド元・gitリポジトリ）: `C:\Users\USR03\kazoku-build`**
- GitHub: **github.com/seikoukishi-svg/kazoku-tsuwa**（PUBLIC）/ account: `seikoukishi-svg`
- 旧作業フォルダ（参考のみ・使わない）: `C:\Users\USR03\Desktop\精巧社AI運用\01_窓口AI\家族通話アプリ`
  - ※OneDrive同期＋日本語パスのため**ローカルAndroidビルド不可**だった。だからクラウドビルドにした。
- 着信送信サーバのコード: このリポジトリの **`worker/`**（`worker/src/index.js`, `worker/wrangler.toml`）。未デプロイ。

## 3. ビルド & 配布（重要）

- **ローカルWindowsでのAndroidビルドは不可**。理由: 会社PCのセキュリティ/AVがフォルダ走査時に一時 `.docx`（例 `ZSTU8AI.DOCX`）を生成し、Gradleの入出力ハッシュを壊す。回避困難。→ **GitHub Actionsでビルド**する。
- CI: `.github/workflows/android.yml`（ubuntu / **Node 22**(Capacitor CLIは≥22) / **Java 21**(Capacitor7必須) / `npm ci`→`npm run build`(vite)→`npx cap sync android`→`gradlew assembleDebug`→APKをartifact化）。
- 配布: **GitHub Release `v1.0.0`** の asset `kazoku-tsuwa.apk`。
  - スマホ用DL: https://github.com/seikoukishi-svg/kazoku-tsuwa/releases/download/v1.0.0/kazoku-tsuwa.apk
- 新APKの出し方:
  1. `kazoku-build` でコード変更 → `git push`
  2. Actions完了後 `gh run download <runId> -R seikoukishi-svg/kazoku-tsuwa -n kazoku-tsuwa-apk -D _apk`
  3. `cp _apk/app-debug.apk _apk/kazoku-tsuwa.apk`
  4. `gh release upload v1.0.0 _apk/kazoku-tsuwa.apk --clobber -R seikoukishi-svg/kazoku-tsuwa`
- **未対応の宿題: APK署名が毎ビルド変わる**（CIのdebug keystoreが都度生成）。そのためAPK更新のたびに端末で一度アンインストールが必要。→ 固定keystoreを GitHub Secrets に入れて署名する設定を入れると、以後は上書き更新できる（要実装）。

## 4. Firebase

- project: **`kazoku-tsuwa-1330313604`**（Googleアカウント `seikoukishi@gmail.com`。firebase CLI ログイン済み）
- Firestore: asia-northeast1 / Native。Authentication: 匿名=有効。
- 設定（いずれも非秘密・コミット済）: `src/firebase-config.ts`（Web）、`android/app/google-services.json`（Android）。
- ルール `firestore.rules`: `calls/{calleeId}/**` と `tokens/{memberId}` を `request.auth != null` で読み書き可。
  - 反映: `kazoku-build` で `firebase deploy --only firestore:rules --project kazoku-tsuwa-1330313604`

## 5. アプリ設計（`src/main.ts`）

- メンバー固定4人: `papa`=パパ / `mama`=ママ / `yuki`=ゆうき / `akiho`=あきほ。初回に自分を選択→`localStorage("kazoku-my-member-id")`。テスト用にURL `?me=papa` で上書き可。
- 通話シグナリング: `calls/{着信側ID}` doc = `{from,to,status(ringing/accepted/ended),offer,answer,startedAt,callId}` ＋ サブコレクション `callerCandidates`/`calleeCandidates`。
  - 発信は `runTransaction` で相手が通話中なら弾く。`deleteCallDoc` は `callId` 一致時のみ削除（再発信の競合対策）。
  - 着信受信箱 = `calls/{自分}` を常時 `onSnapshot`。
- FCMトークン: 起動時に `@capacitor/push-notifications` で取得→ `tokens/{自分}` に保存（`setupPush`/`saveToken`）。動作確認済（`tokens/papa` に保存を確認）。
- 受話口: `android/app/src/main/java/com/kazoku/tsuwa/MainActivity.java` が onResume で `AudioManager` を `MODE_IN_COMMUNICATION` + `setSpeakerphoneOn(false)`、onPauseで戻す。manifestに `RECORD_AUDIO`/`MODIFY_AUDIO_SETTINGS`、起動時に `RECORD_AUDIO` を要求。appId=`com.kazoku.tsuwa`、表示名=家族通話。

## 6. レベル2b（閉じても鳴る）= ここから

### 2b-2 着信送信サーバ（Cloudflare Worker）★いま止まっている所
- コード: `worker/src/index.js`（完成）。動作: POST `{idToken, toToken, fromName}` → 発信者のFirebase IDトークンを検証 → サービスアカウントでOAuth → **FCM HTTP v1** で相手トークンへ送信。CORS対応済。
- 必要な秘密（リポジトリには入れない）:
  1. **Cloudflare APIトークン**（テンプレート "Edit Cloudflare Workers"）。
     - ⚠️ 以前作った `cfut_...` はスクリーンショットで露出したため、**削除して作り直すこと**。
  2. **Firebaseサービスアカウント鍵JSON**（ユーザーがダウンロード済み＝Downloadsフォルダ。秘密）。
- デプロイ手順（`worker/` で。ユーザー本人が実行）:
  ```
  cd C:\Users\USR03\kazoku-build\worker   (または kazoku-worker)
  npm install
  $env:CLOUDFLARE_API_TOKEN="（新しいトークン）"
  npx wrangler deploy            # 初回 workers.dev サブドメイン登録が要る場合あり
  Get-Content "（鍵JSONのパス）" -Raw | npx wrangler secret put FCM_SA
  ```
  → 表示される **Worker URL**（https://kazoku-tsuwa-sender.<sub>.workers.dev）を控える。
- ※元の作業フォルダ `C:\Users\USR03\kazoku-worker` にも同じworkerと`node_modules`がある（`npm install`済み）。どちらで実行してもよい。

### 2b-3 全画面着信（ネイティブ・未着手）
- いまの送信は `notification` メッセージ（普通の通知）。閉じた端末で**全画面・着信音・ロック中表示**にするには、**data message** + ネイティブの `FirebaseMessagingService` で `full-screen-intent` 通知（着信音channel・応答/拒否アクション・画面ウェイク）を実装する。`@capacitor/push-notifications` の既定では全画面着信にならない。
- 権限: `POST_NOTIFICATIONS`(API33+)、`USE_FULL_SCREEN_INTENT`(API34+)。各端末で電池最適化の除外も案内。

### 2b-4 結合＋実機テスト
- `src/main.ts` の発信(`callTo`)に追記: 「`tokens/{相手}` を読む → `auth.currentUser.getIdToken()` → Worker URL に POST `{idToken, toToken, fromName}`」。
- 閉じた/ロック中の端末で鳴る→応答→通話、を実機で確認。

## 7. 厳守事項

- **完全無料・クレカ登録なし**（Firebase Cloud Functions=Blaze は使わない。送信は無料のCloudflare Worker）。
- Androidのみ / 電話番号不要 / 家族4人。
- 既存ファイルを勝手に大幅変更・削除しない。
- Web版(Firebase Hosting `https://kazoku-tsuwa-1330313604.web.app`)は旧仕様（通話開始ミュート）のまま＝APK版と乖離。今後の本体はAPK。必要なら `kazoku-build` から `firebase deploy --only hosting` で同期。

## 8. ローカル導入済みツール（再利用可）

- JDK17: `C:\Users\USR03\android-build\jdk\jdk-17.0.19+10`
- Android SDK: `C:\Users\USR03\android-build\android-sdk`（ANDROID_HOME）
- GitHub CLI: `C:\Users\USR03\android-build\gh\bin\gh.exe`（認証済 seikoukishi-svg）
- wrangler: `kazoku-worker` / `kazoku-build/worker` の node_modules（`npx wrangler`）
- firebase CLI: グローバル（ログイン済 seikoukishi@gmail.com）

## 9. 次の一手（順番）

1. 露出した Cloudflare トークンを削除→新規作成。
2. `worker/` をデプロイ＋ `FCM_SA` secret登録 → Worker URL 取得。
3. `src/main.ts` の発信処理に Worker 呼び出しを追加（上記2b-4）。まずは通知メッセージで「閉じた端末に通知が出る」ことを確認。
4. ネイティブ全画面着信（2b-3）を実装。
5. 署名固定（GitHub Secrets）でAPK更新を上書き可能に。
6. CIでAPK再ビルド→Release更新→実機テスト。
