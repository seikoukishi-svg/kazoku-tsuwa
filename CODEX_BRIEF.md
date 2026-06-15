# Codex 引き継ぎ資料 — 家族通話アプリ 網羅デバッグ依頼

このファイルは、別のAI（Codex）に「別視点での網羅的デバッグ」を依頼するための自己完結ブリーフです。
この会話の履歴がなくても、これだけ読めば全体を把握できるように書いています。

---

## 0. あなた（Codex）への依頼

このリポジトリは、家族4人で使う **Android 音声通話アプリ**（WebRTC + Firebase + FCM + Capacitor）です。
すでに別のAIが実装と一次デバッグを終えていますが、**別の視点で網羅的に粗探し**してほしい。

特にお願いしたいこと:
1. **状態機械（発信/着信/通話/終了）の競合・抜け道**を敵対的にレビューする
2. **WebRTCシグナリングのデータモデル**（1着信先=1ドキュメント方式）の構造的な弱点を指摘する
3. **ネイティブ(Java)とJS(TypeScript)の連携**で、片方だけ直っていて辻褄が合わない箇所を探す
4. **FCM/通知/全画面着信**のAndroidバージョン依存・プロセス状態依存の落とし穴
5. 既存のテスト表 `TESTING.md` に**載っていない**未知のパターンを足す

**前任AIの実装を鵜呑みにせず、設計判断そのものを疑ってよい。** より良い構造があれば提案してほしい。

---

## 1. 絶対制約（厳守）

- **完全無料・クレジットカード登録なし**（Firebase の有料 Blaze プラン/Cloud Functions は使わない）
- **秘密情報をリポジトリやログに出さない**:
  - Cloudflare API トークン、Firebase サービスアカウント JSON は **絶対にコミット/表示しない**
  - これらは Cloudflare Worker の secret（`FCM_SA`）と GitHub Secrets にのみ存在
  - 一方 `google-services.json` と Firebase Web 設定キーは秘密ではなく、リポジトリに入っていて良い
- 対象は **Android のみ**。利用者は高齢者・子供を含む（UIは極力単純に）
- 家族4人固定: `papa / mama / yuki / akiho`（パパ/ママ/ゆうき/あきほ）

---

## 2. アーキテクチャ全体像

```
[発信者スマホ]                    [Firebase]                  [着信者スマホ]
 main.ts (WebRTC) --- offer/answer/ICE ---> Firestore <--- onSnapshot --- main.ts
        |                                                                    ^
        | 着信プッシュ要求(認証付き)                                          | data-only FCM
        v                                                                    |
 [Cloudflare Worker] --- FCM HTTP v1 (service accountでJWT自己署名) --------> KazokuMessagingService
                                                                          (全画面着信＋着信音)
```

- **シグナリング**: Firestore（WebSocketサーバは使わない）
- **本人確認**: Firebase 匿名認証（電話番号不要）
- **着信合図**: FCM データのみメッセージ → ネイティブが全画面通知＋着信音
- **プッシュ送信**: Cloudflare Worker（無料・カード不要。Cloud Functions の代替）
- **アプリ化**: Capacitor（WebView + ネイティブプラグイン）

---

## 3. データモデル（Firestore）

### `calls/{calleeId}` — 着信先メンバーIDがドキュメントID（1人につき1スロット）
```
{
  callId: string (UUID),       // この通話の識別子
  from: string,                // 発信者メンバーID
  to: string,                  // 着信者メンバーID (= ドキュメントID)
  status: "ringing" | "accepted" | "ended",
  offer: { type, sdp } | null,
  answer: { type, sdp } | null,
  startedAt: serverTimestamp,
  rejectReason?: "busy"        // 通話中拒否のとき
}
```
- サブコレクション: `callerCandidates`, `calleeCandidates`（ICE候補）

### `tokens/{memberId}`
```
{ token: string (FCM登録トークン), platform: "android", updatedAt: serverTimestamp }
```

### Firestoreルール（`firestore.rules`）
匿名認証済みなら `calls/**` と `tokens/**` を読み書き可（家族内の閉じた利用前提の最小ルール）。
**→ Codexへ: このルールの緩さ（他人の通話doc改ざん等）も指摘対象。ただし無料・家族限定が大前提。**

---

## 4. 通話フロー（正常系）

1. 発信者: `callTo()` → トランザクションで `calls/{相手}` を `ringing` で確保 → `RTCPeerConnection` 作成 → `createOffer` → `offer` を書き込み → Worker 経由で着信プッシュ送信 → 受話口で呼び出し音(ToneGenerator)
2. 着信者: `startIncomingListener()` が `calls/{自分}` を監視 → `ringing`+`offer` を検知 → 着信画面表示 + ネイティブ着信音
3. 着信者が応答: `acceptCall()` → `setRemoteDescription(offer)` → `createAnswer` → `answer`+`status:accepted` を書き込み
4. 発信者: `callUnsub` が `answer` を検知 → `setRemoteDescription(answer)` → 通話確立
5. ICE候補は双方が自分のサブコレクションに書き、相手のサブコレクションを監視
6. 終了: `hangUp()` が doc 削除（相手は doc消滅 or status:ended で検知）

---

## 5. 主要ファイル

| ファイル | 役割 |
|---|---|
| `src/main.ts` | 通話ロジック全体（状態機械・WebRTC・Firestore・FCMトークン・音声制御呼び出し）|
| `src/firebase.ts` | Firebase 初期化・匿名ログイン |
| `index.html` / `src/style.css` | 画面（自分選択/ホーム/発信中/着信/通話中）|
| `android/.../KazokuMessagingService.java` | data-only FCM受信→全画面着信＋着信音(Ringtone)。`stopRequested`でレース対策 |
| `android/.../AudioRoutePlugin.java` | 受話口/スピーカー切替、呼び出し音(ToneGenerator)、着信音停止、電池最適化要求。イヤホン優先ルーティング |
| `android/.../MainActivity.java` | プラグイン登録、ロック画面表示、マイク権限要求 |
| `android/app/src/main/AndroidManifest.xml` | サービス登録、権限 |
| `worker/src/index.js` | Cloudflare Worker（FCM送信。発信者のIDトークン検証→サービスアカウントでアクセストークン発行→FCM v1）|
| `firestore.rules` | Firestoreセキュリティルール |
| `TESTING.md` | **使用パターン網羅表（約50項目、ここに追記/反証してほしい）** |

---

## 6. ビルド・配布（重要な制約）

- **ローカルAndroidビルドは不可**: 社内PCのアンチウイルスが全フォルダに一時的な `.DOCX` ファイルを作り、Gradle のハッシュ計算を壊す。→ **GitHub Actions のクラウドビルドを使う**（`.github/workflows/android.yml`、Node 22 / Java 21）
- APK は GitHub Release `v1.0.0` の資産 `kazoku-tsuwa.apk` として配布（固定署名キーで上書き更新可）
- Web版（発信テスト用）は Firebase Hosting: `https://kazoku-tsuwa-1330313604.web.app`（`?me=mama` 等で本人指定可）
- リポジトリ: GitHub `seikoukishi-svg/kazoku-tsuwa`（public）
- **Codexはコード修正の提案・パッチ作成はしてよいが、コミット/デプロイ/秘密の操作は勝手に行わず、利用者の確認を取ること。**

---

## 7. これまでに直した不具合（再発の有無も確認してほしい）

- 受話口ではなくスピーカーから音が出る → `setCommunicationDevice` で受話口固定
- 通話中も着信音が鳴り続ける → `Ringtone`化 + `stopRequested`フラグでレース対策
- 状態が「通話中」のまま固まり以後の着信が出ない → 新着信で固まりを自己修復（`isLiveCall()`判定）
- 同じ相手に連続発信で鳴らない → 同上の自己修復 + stale判定の短縮（ringingは90秒）
- モバイル回線で音声が双方無音 → STUN のみ → TURN(無料 openrelay)追加
- 発信側に呼び出し音が無い → ToneGenerator で受話口に「トゥルルル」
- 通話中/発信中の被着信 → 相手に `rejectReason:"busy"` を返す
- 圏外発信・通話中の長い切断・イヤホン・電池最適化 → 各種ガード/ボタン追加

---

## 8. 既知の弱点・未対応（あなたに深掘りしてほしい優先領域）

| ID | 課題 | 現状 |
|---|---|---|
| D3 | 厳しいNATでTURNをすり抜けられず不通（ママの端末で発生疑い） | 無料openrelay頼みで不安定。Cloudflare無料TURN未導入 |
| D5 | 通話中のWi-Fi↔モバイル切替で切断 | ICE再交渉（restart）未実装 |
| E3 | 二人がほぼ同時に相互発信 | 双方busyで両方失敗（先着優先ルールなし） |
| G1/G2 | 通話中/発信中にアプリを強制終了 | docが残り、stale(90秒/2時間)で救済するのみ。相手の検知が遅い |
| 構造 | `calls/{calleeId}` 1スロット方式 | 1人あたり同時1着信。上書き/競合の取りこぼしリスク |
| H3/K2 | Android14の全画面通知権限、メーカー別の過激な電池管理 | 端末依存。手動設定頼み |

---

## 9. あなた（Codex）の進め方の提案

1. まず `src/main.ts` の状態機械を、状態遷移図に起こして**到達不能・抜け穴・二重実行**を洗う
2. `calls/{calleeId}` 単一docモデルの競合シナリオ（同時書き込み・上書き・削除レース）を列挙
3. ネイティブ↔JSの停止/開始の対（着信音・呼び出し音・通知）が**全終了経路で確実に対になるか**を検査
4. FCMの配送条件（アプリのstopped状態、優先度、データのみ、トークン失効）の前提が正しいか検証
5. `TESTING.md` に反証・追加（特に異常系・並行系）。**前任の「✅」が本当に✅か疑う**
6. 修正案はパッチ（差分）で提示し、リスクの高いもの（再交渉等）は実機テスト前提と明記

レビュー結果は `CODEX_FINDINGS.md` に書き出す形が望ましい。
