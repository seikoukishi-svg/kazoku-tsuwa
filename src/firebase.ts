import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import { getAuth, signInAnonymously } from "firebase/auth";
import { firebaseConfig } from "./firebase-config";

// firebase-config.ts がまだプレースホルダのままかを判定する。
// 未設定のうちは通信を試みず、画面側で「未設定」と案内する（謎のネットワークエラーを出さない）。
export const isConfigured =
  !!firebaseConfig.apiKey && !firebaseConfig.apiKey.includes("ここに貼り付け");

const app = initializeApp(firebaseConfig);

export const db = getFirestore(app);
export const auth = getAuth(app);

// 設定済みのときだけ起動時に匿名ログイン。成功で uid、失敗（設定ミス/通信不可）で null。
export const authReady: Promise<string | null> = isConfigured
  ? signInAnonymously(auth)
      .then((cred) => cred.user.uid)
      .catch((err) => {
        console.error("匿名ログインに失敗しました", err);
        return null;
      })
  : Promise.resolve(null);
