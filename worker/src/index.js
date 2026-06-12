// 家族通話: 着信プッシュ送信 Worker
// 役割: 発信者(認証済み)からの要求を受け、相手のFCMトークンへ「着信」通知を送る。
// 秘密(env.FCM_SA): Firebaseサービスアカウントの JSON 文字列（wrangler secret put FCM_SA で登録）

const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const JWK_URL =
  "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

function b64ToUint8(b64) {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}
function b64urlToUint8(b64url) {
  let b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4) b64 += "=";
  return b64ToUint8(b64);
}
function uint8ToB64url(arr) {
  let bin = "";
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function strToB64url(str) {
  return uint8ToB64url(new TextEncoder().encode(str));
}

async function importPrivateKey(pem) {
  const body = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  const der = b64ToUint8(body);
  return crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

// 発信者の Firebase ID トークンを検証（署名 + aud/iss/exp）。OKなら payload を返す。
async function verifyIdToken(idToken, projectId) {
  const parts = idToken.split(".");
  if (parts.length !== 3) return null;
  const header = JSON.parse(new TextDecoder().decode(b64urlToUint8(parts[0])));
  const payload = JSON.parse(new TextDecoder().decode(b64urlToUint8(parts[1])));
  if (payload.aud !== projectId) return null;
  if (payload.iss !== "https://securetoken.google.com/" + projectId) return null;
  if (!payload.exp || payload.exp * 1000 < Date.now()) return null;
  const jwks = await (await fetch(JWK_URL)).json();
  const jwk = (jwks.keys || []).find((k) => k.kid === header.kid);
  if (!jwk) return null;
  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const data = new TextEncoder().encode(parts[0] + "." + parts[1]);
  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    b64urlToUint8(parts[2]),
    data,
  );
  return ok ? payload : null;
}

async function getAccessToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  const header = strToB64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = strToB64url(
    JSON.stringify({
      iss: sa.client_email,
      scope: FCM_SCOPE,
      aud: OAUTH_TOKEN_URL,
      iat: now,
      exp: now + 3600,
    }),
  );
  const signingInput = header + "." + claims;
  const key = await importPrivateKey(sa.private_key);
  const sigBuf = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(signingInput),
  );
  const jwt = signingInput + "." + uint8ToB64url(new Uint8Array(sigBuf));
  const res = await fetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body:
      "grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=" + jwt,
  });
  const j = await res.json();
  return j.access_token;
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS")
      return new Response(null, { headers: CORS });
    if (request.method !== "POST")
      return json({ ok: true, note: "kazoku-tsuwa sender" });

    try {
      if (!env.FCM_SA) return json({ error: "server not configured" }, 500);
      const sa = JSON.parse(env.FCM_SA);
      const projectId = sa.project_id;

      const body = await request.json();
      const idToken = body.idToken;
      const toToken = body.toToken;
      const fromName = body.fromName || "家族";
      // type は許可リスト方式: 着信(incoming_call) / 取り消し(cancel_call) のみ
      const type = body.type === "cancel_call" ? "cancel_call" : "incoming_call";
      if (!idToken || !toToken) return json({ error: "missing params" }, 400);

      const caller = await verifyIdToken(idToken, projectId);
      if (!caller) return json({ error: "unauthorized" }, 401);

      const accessToken = await getAccessToken(sa);
      if (!accessToken) return json({ error: "token mint failed" }, 500);

      const message = {
        message: {
          token: toToken,
          // データのみ（通知ペイロードを付けない）→ アプリが閉じていても
          // ネイティブの着信サービス(onMessageReceived)が起動し、全画面着信＋着信音を出せる。
          data: { type: type, fromName: String(fromName) },
          android: { priority: "HIGH" },
        },
      };
      const fcmRes = await fetch(
        "https://fcm.googleapis.com/v1/projects/" +
          projectId +
          "/messages:send",
        {
          method: "POST",
          headers: {
            Authorization: "Bearer " + accessToken,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(message),
        },
      );
      const fcmJson = await fcmRes.json();
      return json({ ok: fcmRes.ok, fcm: fcmJson }, fcmRes.ok ? 200 : 502);
    } catch (e) {
      return json({ error: String(e && e.message ? e.message : e) }, 500);
    }
  },
};
