# 家族通話アプリ（自作・Android・完全無料）

家族がスマホで音声通話とメッセージをやり取りするための自作アプリ。

## 確定要件

- 電話番号不要（SIM無し端末でも使う。ゆえに LINE / Signal / Telegram は不可）
- Wi-Fi でもキャリア回線(4G/5G)でも使える（同一LAN前提にしない＝外出先からも使う）
- 音声通話＋テキストメッセージ
- 完全無料（有料サブスク・従量課金が発生する設計にしない）
- Android のみ（iPhone なし。配布は APK 手渡し）
- 着信を電話のように鳴らしたい（アプリを閉じていても／画面ロック中でも）

## 技術構成

- 音声: WebRTC（P2P, getUserMedia + RTCPeerConnection）
- シグナリング: Firebase Firestore（サーバ常駐不要・無料枠・クロスネットワーク）
- 本人確認: Firebase Anonymous Auth（電話番号なしで ID を持つ）
- 着信通知（予定）: Firebase Cloud Messaging(FCM) ※アプリ終了中に鳴らすには必須
- ネイティブ化（予定）: Capacitor で Android アプリ化し全画面の電話風着信
- STUN: Google 無料 STUN。直結できない回線用に必要なら TURN（無料枠で）
- ビルド: Vite 6 + TypeScript（バニラ、フレームワーク無し）, Node v24

## 進捗フェーズ

- Phase 0 ローカル試作（自前 ws シグナリング）… 完了
- Phase 1a Firestore シグナリング（コード）… 完了
- Phase 1b 設定＋無料 HTTPS 公開＋実機疎通 … ★ここから（下の「セットアップ」が前提）
- Phase 2 FCM＋Capacitor で全画面着信、宛先指定モデル … 未着手
- Phase 3 メッセージ／応答・拒否 UI／仕上げ … 未着手

## セットアップ（初回だけ・すべて無料）

Firebase コンソール（https://console.firebase.google.com/）で以下を実施する。

1. プロジェクトを作成（Google アナリティクスはオフで可）
2. `</>`（ウェブ）でアプリを追加 → 表示される `firebaseConfig` の値を
   `src/firebase-config.ts` の6項目に貼り付ける
3. 「構築」→ Firestore Database を作成（ロケーション asia-northeast1 / 本番モード）
4. 「構築」→ Authentication → ログイン方法で「匿名」を有効化
5. Firestore のルールは本リポジトリの `firestore.rules` と同じ内容にする
   （コンソールに貼るか、後述の CLI で `firebase deploy --only firestore:rules`）

※ Firebase のウェブ設定キー（apiKey 等）は秘密情報ではないので、コードに書いてよい。
※ 設定前にアプリを開くと「Firebase が未設定です」と表示される（仕様）。

## 開発（ローカルで動かす）

```
npm install
npm run dev
```

ブラウザで http://localhost:5173 を2タブ開き、両方に同じ「あいことば」を入れて
「参加する」→ マイク許可。「通話中」になれば成功。
（Firestore 経由になったので `npm run server` は不要）

## 公開（無料 HTTPS: Firebase Hosting）

getUserMedia は https か localhost でしか動かないため、実機テストには HTTPS 配置が必要。

```
npm install -g firebase-tools   # または npx firebase-tools を使う
firebase login
firebase use --add              # 自分のプロジェクトを選んでエイリアスを付ける
npm run build
firebase deploy --only hosting
```

- Hosting と Firestore ルールのデプロイは無料（Spark プラン）。
- `firebase init` は実行しなくてよい（`firebase.json` / `firestore.rules` は用意済み）。
- ルールも CLI で配信するなら `firebase deploy --only firestore:rules`
  （先に手順3で Firestore を作成しておくこと）。
- 【無料の要注意点】FCM 送信に Cloud Functions を使うと現状 Blaze プラン
  （クレジットカード登録・無料枠あり）が必要になる場合がある。Phase 2 では
  Cloudflare Workers 等の無料サーバレスに送信処理を置く等、クレカ不要で無料に
  収まる方式を優先検討する。Blaze 必須になる選択は事前にユーザーへ相談すること。

## ファイル構成

- `index.html` … 画面
- `src/main.ts` … 通話ロジック（WebRTC + Firestore シグナリング）
- `src/firebase.ts` … Firebase 初期化＋匿名ログイン。`isConfigured` で未設定を検知
- `src/firebase-config.ts` … ★ここに設定値を貼る（初期値はプレースホルダ）
- `src/style.css` … スマホ向けスタイル
- `firebase.json` … Hosting＋Firestore ルールのデプロイ設定
- `firestore.rules` … アクセス制御（匿名ログイン済みのみ読み書き）
- `server/signaling.mjs` … Phase 0 の名残。Phase 1 では未使用だが**残す**

## データモデル（Firestore）

- `rooms/{あいことば}` … `{ caller, callee, offer, answer, startedAt }`
- `rooms/{あいことば}/callerCandidates`, `.../calleeCandidates` … ICE candidate
- 役割（発信者/着信者/満員）は `runTransaction` で衝突なく決定
- `startedAt` が2時間以上前の部屋は古いとみなして再利用
- 通話終了・タブを閉じた時に部屋とサブコレクションを削除
- `remoteDescription` 未設定の間は ICE candidate をバッファし、設定後に flush

## 次の担当者（Codex 等）への引き継ぎ

**厳守事項**
- 完全無料 / Android のみ / 電話番号不要 / クロスネットワーク対応は絶対要件。
- 既存ファイルを勝手に大幅変更・削除しない（特に `server/signaling.mjs` は残す）。
- 無料枠を超えそう／クレジットカード登録が要る選択は、実装前に必ずユーザーへ相談。

**次のタスク（優先順）**
1. Phase 1b: ローカル2タブ疎通の確認 → Hosting 公開 → Android 実機2台
   （1台 Wi-Fi / 1台キャリア回線）で双方向の音声疎通。STUN だけで繋がるか確認し、
   繋がらない回線があれば無料枠で TURN を追加。
2. Phase 2: FCM で着信通知（端末トークンを Firestore に保存し相手へ送信）。
   Capacitor で Android アプリ化し full-screen-intent / ConnectionService による
   全画面着信。宛先モデルを「同じあいことば＝同じ部屋」から
   「誰が誰を呼ぶか」を指定して本人を鳴らす方式へ拡張。
3. Phase 3: テキストメッセージ、応答／拒否 UI、通話履歴、再接続、APK 配布手順。

**注意**
- getUserMedia は https か localhost でのみ動作。実機テストは Hosting の URL で行う。
- 実通信・外部 API には素のネットワークアクセスが必要。サンドボックス環境では
  ビルドのプロセス起動や外部通信が制限され、匿名ログインが
  `auth/network-request-failed` になることがある（コードの不具合ではない）。
