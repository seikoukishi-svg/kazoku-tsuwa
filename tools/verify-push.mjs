// 手動検証用スクリプト（本番コードではない）。
// 用途: 着信プッシュ(Worker→FCM)が相手端末に届くかを単体で確認する。
// 使い方: node tools/verify-push.mjs [toMember] [fromName]
//   例) node tools/verify-push.mjs papa ママ
// 注意: ここに書いてある Firebase Web 設定は「公開鍵」で秘密ではない。
//       秘密情報（Cloudflare トークン / サービスアカウント JSON）は含めないこと。

import { initializeApp } from "firebase/app";
import { getAuth, signInAnonymously } from "firebase/auth";
import { getFirestore, doc, getDoc } from "firebase/firestore";

const cfg = {
  apiKey: "AIzaSyAOqLfFtB_f08qKRhz6plR8bvHZ5-rOUxw",
  authDomain: "kazoku-tsuwa-1330313604.firebaseapp.com",
  projectId: "kazoku-tsuwa-1330313604",
  storageBucket: "kazoku-tsuwa-1330313604.firebasestorage.app",
  messagingSenderId: "790638405167",
  appId: "1:790638405167:web:9630488ef81307fbe988da",
};
const WORKER = "https://kazoku-tsuwa-sender.kazoku-tsuwa.workers.dev";

const toMember = process.argv[2] || "papa";
const fromName = process.argv[3] || "ママ";

const app = initializeApp(cfg);
const auth = getAuth(app);
const db = getFirestore(app);
try {
  const cred = await signInAnonymously(auth);
  const idToken = await cred.user.getIdToken();
  const snap = await getDoc(doc(db, "tokens", toMember));
  if (!snap.exists()) {
    console.log(`RESULT: tokens/${toMember} が無い → そのスマホでアプリを一度開いて名前選択してください`);
    process.exit(0);
  }
  const d = snap.data();
  const upd = d.updatedAt && d.updatedAt.toDate ? d.updatedAt.toDate().toISOString() : String(d.updatedAt);
  console.log(`${toMember} token updatedAt:`, upd, " len:", d.token ? d.token.length : 0);
  const res = await fetch(WORKER, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // callId はテスト用の固定値。実機では JS が UUID を付与する。
    body: JSON.stringify({ idToken, toToken: d.token, fromName, type: "incoming_call", callId: "verify-test" }),
  });
  console.log("Worker status:", res.status);
  console.log("Worker body:", await res.text());
  process.exit(0);
} catch (e) {
  console.error("ERR", e && e.message ? e.message : e);
  process.exit(1);
}
