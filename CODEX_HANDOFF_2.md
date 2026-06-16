# Codex 引き継ぎ資料 #2 — 前回レビュー以降の実装と次の依頼

日付: 2026-06-16
作業フォルダ: C:\Users\USR03\kazoku-build
GitHub: seikoukishi-svg/kazoku-tsuwa (public)

このファイルは「Codexの前回レビュー(CODEX_FINDINGS.md)以降に何を直したか」と
「次に見てほしいこと」をまとめたもの。まず以下の順で読むこと:

1. CODEX_BRIEF.md … アプリの基礎ブリーフ（制約・構成・データモデル）
2. CODEX_FINDINGS.md … 前回の敵対的レビュー結果（F1〜F10）
3. このファイル(CODEX_HANDOFF_2.md) … 上記レビューへの対応状況と残課題
4. TESTING.md … 使用パターン網羅表（L章まで更新済み）

---

## 0. 絶対制約（不変・厳守）

- 完全無料・クレジットカード登録なし（Firebase Blaze/Cloud Functions は使わない）
- 着信プッシュ送信は Cloudflare Worker 方式を維持
- 秘密情報（Cloudflare APIトークン / Firebase サービスアカウントJSON）は表示・コミット禁止
  - これらは Cloudflare Worker secret `FCM_SA` と、ユーザー手元にのみ存在
  - google-services.json と Firebase Web 設定キーは非秘密でリポジトリに有り
- Android のみ / 電話番号不要 / 家族4人固定（papa/mama/yuki/akiho）
- コミット/デプロイ/本番反映は勝手にやらず、必ずユーザー確認を取る
- 高リスク変更（ICE再交渉、データモデル移行等）は実機2台テスト前提と明記する

---

## 1. 前回レビュー(F1〜F10)への対応状況

| ID | 指摘 | 状況 | 実装概要 |
|---|---|---|---|
| F1 | 同一発信者によるactive doc上書き / callTo再入 | ✅ 対応 | callTo冒頭で `appState!=="idle"` なら中止。トランザクションは active なら from が自分でも上書き拒否 |
| F2 | ICE候補がcallIdスコープでない（掃除が新通話の候補を消す） | ✅ 対応 | 候補docに `callId` 付与。受信側は自分のcallId一致のみ取り込み。`clearOldCandidates()` は発信時に「自分のcallId以外」だけ削除。終了時の一括削除は廃止 |
| F3 | cancel_call に callId が無い（古いキャンセルが別着信を止める） | ✅ 対応 | JS→Worker→native まで callId を伝搬。native は `activeCallId` を保持し、一致するcancelのみ鳴動停止（空/不一致は無視） |
| F4 | acceptCall がdoc同一性を検証せずanswer書き込み | ✅ 対応 | 応答前に getDoc で callId/from/status を確認。answer書き込みも runTransaction で同一性再確認 |
| F5 | busy判定が狭く、接続前のincallを新着信が壊す | ✅ 対応 | `busy = appState!=="idle"` に保守化。固まり回復は「接続40秒ウォッチドッグ」+「visibility復帰時の自己修復(pc==null)」に移譲 |
| F6 | POST_NOTIFICATIONS未宣言(targetSdk36) | ✅ 対応 | Manifestに追加 + MainActivityでAPI33+に起動時要求 |
| F7 | Android14+ full-screen intent未チェック | ✅ 対応 | `checkFullScreenIntent()`/`openFullScreenSettings()` を追加。ホームの設定ボタンから許可状態を確認し設定へ誘導 |
| F8 | 無効FCMトークンがログのみ | ✅ 対応 | Workerが UNREGISTERED/INVALID_ARGUMENT で `invalidToken:true` を返す。発信側は再設定を案内表示 |
| F9 | Firestoreルールが匿名なりすまし可能 | ❌ 未対応 | 家族限定の閉じた利用前提で保留。最低限のメンバーID許可リスト＋フィールド検証は今後 |
| F10 | beforeunloadベストエフォート / ハートビート無し | ❌ 未対応 | 強制終了の残骸は stale(ringing 90秒 / accepted 2時間)救済のみ。ハートビート未実装 |

### F1〜F8以外に入れた改善（Codex指摘外だが関連）
- TURN追加（無料 openrelay、複数ポート/TCP/TLS）。STUNも3つに。※強力化は未（下記参照）
- 発信側の呼び出し音（受話口でトゥルルル、ToneGenerator）
- 受話口ルーティングをBluetooth/有線イヤホン優先に
- オフライン発信ガード、disconnected 25秒で自動終了、接続40秒ウォッチドッグ
- 電池最適化除外の依頼ボタン（ホーム「🔔 着信が鳴らない時の設定」）
- verify-push.mjs を tools/ へ移設

---

## 2. 現在のデプロイ状態

- APK: GitHub Release `v1.0.0` の `kazoku-tsuwa.apk`（最新 SHA256 d8fd3e4c…）。固定署名で上書き更新可。
- Web(テスト用): Firebase Hosting https://kazoku-tsuwa-1330313604.web.app （`?me=mama` で本人指定可）
- Worker: https://kazoku-tsuwa-sender.kazoku-tsuwa.workers.dev （callId中継 + invalidToken 対応版をデプロイ済み）
- Worker secret `FCM_SA` 登録済み。
- Firebase project: kazoku-tsuwa-1330313604（匿名認証有効、Firestore asia-northeast1）

---

## 3. テスト状況（重要：最新修正は未検証）

実機で確認済み（過去）:
- 名前で発信→着信→応答→受話口通話
- アプリ終了/ロック中の全画面着信＋着信音（権限が揃っていれば）
- モバイルWi-Fi(TURN)での通話（ゆうきで1回目成功）

未検証 / 直近の課題:
- **【最重要・未検証】同じ相手への連続発信で2回目以降に音声が繋がらない問題**
  → F2(候補callIdスコープ化)で根治したつもりだが、まだ実機検証していない。
  → ユーザーがパパ⇔ママ(モバイルWi-Fi)で「連続発信して毎回声が通るか」を検証予定。
- バッチ1の各修正（取り消し即停止 / 二重発信 / 通話中busy / 固まり回復）も実機未検証。
- 注意: 今回の候補修正は**両端末が新APKでないと効かない**（候補にcallIdを付ける処理が双方必要）。

---

## 4. まだ残っている弱点（次に深掘りしてほしい領域）

| ID | 課題 | 状況 |
|---|---|---|
| F9 | Firestoreルールのなりすまし対策 | 未対応。メンバーID許可リスト/フィールド検証/簡易ペアリングなど無料範囲で |
| F10 | 強制終了時の残骸（ハートビート/リース） | 未対応。stale救済のみ |
| E3 | 相互同時発信の先着優先 | 未実装（現状は双方busyで両方失敗）|
| D5 | 通話中のWi-Fi↔モバイル切替（ICE再交渉/restart）| 未実装・高リスク。実機2台必須 |
| #6 | 全画面通知に応答/拒否アクション | 未実装。応答はWebRTC起動が絡む |
| D3+ | TURN強化（Cloudflare無料TURN月1TB）| 未導入。openrelayが不安定なら切替候補。ユーザーのCloudflareアカウント設定が要る |
| N1/N2 | 強制停止後/再起動後アプリ未起動での着信 | FCM仕様上の制約。要切り分け・文言整理 |

---

## 5. ビルド・デプロイ環境（重要な制約）

- **ローカルWindowsでのAndroidビルドは不可**（社内AVが一時 .DOCX を生成し Gradle のハッシュを壊す）。
  → APKは **GitHub Actions**（`.github/workflows/android.yml`、Node22/Java21）でビルド。
  → 配布は GitHub Release `v1.0.0` の asset 差し替え（gh CLI 認証済み seikoukishi-svg）。
- Hosting更新: `npx firebase deploy --only hosting --project kazoku-tsuwa-1330313604`（firebase CLIログイン済み seikoukishi@gmail.com）
- Worker更新: ユーザーが `C:\Users\USR03\kazoku-worker\deploy.ps1` を実行（中身はローカルwrangler4.98.0直叩き、テレメトリOFF、ASCIIのみ）。
  - 注意: `npx wrangler` は新版を取得し Windowsの "Application Data" 接合点で権限エラーになる。必ずローカル4.98.0を使う。
  - .ps1 に日本語を入れるとPowerShell5.1で文字化けし構文崩壊。**英語のみ**にすること。
- ローカルツール: JDK17 / Android SDK / gh / firebase CLI / wrangler は導入済み（HANDOFF.md §8 参照）。

---

## 6. 主要ファイル（現行）

- src/main.ts … 状態機械・WebRTC・Firestore・FCMトークン・音声制御呼び出し（今回の修正の中心）
- src/firebase.ts … 初期化・匿名ログイン
- index.html / src/style.css … 画面
- android/.../KazokuMessagingService.java … data-only FCM→全画面着信+着信音。stopRequested/activeCallId でレース対策
- android/.../AudioRoutePlugin.java … 受話口/スピーカー/呼出音/着信停止/電池最適化/全画面intent確認
- android/.../MainActivity.java … プラグイン登録・ロック画面表示・RECORD_AUDIO/POST_NOTIFICATIONS要求
- android/app/src/main/AndroidManifest.xml … 権限・サービス登録
- worker/src/index.js … FCM送信(callId中継/invalidToken判定)。kazoku-worker/src/index.js にも同期
- firestore.rules … 匿名認証で calls/** と tokens/** 読み書き可（F9で要強化）
- tools/verify-push.mjs … 手動検証用（本番外）

---

## 7. Codex への次の依頼（このファイルの本題）

最優先で見てほしい:
1. **F2(候補callIdスコープ化)の実装レビュー** … src/main.ts の clearOldCandidates / createPeer の
   callId付与・フィルタに穴がないか。発信側と着信側で myCallId が確実に一致するか、
   古い候補が混ざる経路が残っていないか。累積した候補のコストや掃除漏れも確認。
2. **連続発信・TURN経路での残存リスク** … 「2回目以降の音声不通」が本当に解消するか、
   別の競合（offer/answer の取り違え、remoteDescription前の候補バッファ flush 順序など）が無いか。
3. **F5(busy保守化 + ウォッチドッグ)の副作用** … 固まり回復(J1/J2)が壊れていないか。
   接続40秒ウォッチドッグやvisibility自己修復が、正常な通話確立を誤って切る恐れはないか。
4. **F9/F10 の現実的な無料設計** … なりすまし対策とハートビートを、Blaze無しで実装する案。

依頼の作法:
- 既存実装と設計判断を鵜呑みにせず敵対的に。状態遷移と競合シナリオを列挙して反証する。
- 修正は差分(パッチ)で提示。リスクの高いものは実機2台テスト前提と明記。
- 秘密情報は出さない。コミット/デプロイはユーザー確認後。
- 新しい所見は CODEX_FINDINGS_2.md に書き出す（前回の CODEX_FINDINGS.md は残す）。
