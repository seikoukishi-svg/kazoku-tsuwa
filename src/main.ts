import "./style.css";
import {
  doc,
  collection,
  addDoc,
  getDocs,
  getDoc,
  deleteDoc,
  updateDoc,
  onSnapshot,
  runTransaction,
  serverTimestamp,
  setDoc,
  type DocumentData,
  type DocumentReference,
  type Unsubscribe,
} from "firebase/firestore";
import { Capacitor, registerPlugin } from "@capacitor/core";
import { PushNotifications } from "@capacitor/push-notifications";
import { db, auth, authReady, isConfigured } from "./firebase";

// ===== 家族メンバー（固定）=====
type Member = { id: string; name: string; initial: string; color: string };
const MEMBERS: Member[] = [
  { id: "papa", name: "パパ", initial: "パ", color: "#2e9e8f" },
  { id: "mama", name: "ママ", initial: "マ", color: "#e0795f" },
  { id: "yuki", name: "ゆうき", initial: "ゆ", color: "#4a90d9" },
  { id: "akiho", name: "あきほ", initial: "あ", color: "#9b7ed0" },
];
const nameOf = (id: string) => MEMBERS.find((m) => m.id === id)?.name ?? id;

const STORAGE_KEY = "kazoku-my-member-id";
const STALE_MS = 2 * 60 * 60 * 1000; // 通話中(accepted)の残骸とみなす時間
const RING_STALE_MS = 90 * 1000; // 呼び出し中(ringing)はこれを過ぎたら無効（幽霊着信防止）
const CALL_TIMEOUT_MS = 60 * 1000; // 発信側: 応答が無ければ自動で取り消す
// STUN: まず直接接続を試す / TURN: モバイル回線等で直接つながれない時に音声を中継する。
// TURN は無料公開の Open Relay Project（登録不要）。声のみなので帯域は小さい。
const ICE: RTCConfiguration = {
  iceServers: [
    {
      urls: [
        "stun:stun.l.google.com:19302",
        "stun:stun1.l.google.com:19302",
      ],
    },
    {
      urls: [
        "turn:openrelay.metered.ca:80",
        "turn:openrelay.metered.ca:443",
        "turns:openrelay.metered.ca:443?transport=tcp",
      ],
      username: "openrelayproject",
      credential: "openrelayproject",
    },
  ],
  iceCandidatePoolSize: 4,
};

const PUSH_WORKER_URL = "https://kazoku-tsuwa-sender.kazoku-tsuwa.workers.dev";

const $ = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;

const PANELS = [
  "setup-panel",
  "home-panel",
  "calling-panel",
  "incoming-panel",
  "call-panel",
];
function showPanel(id: string) {
  for (const p of PANELS) $(p).classList.toggle("hidden", p !== id);
}
function showError(msg: string) {
  const e = $("error");
  e.textContent = msg;
  e.classList.remove("hidden");
}
function clearError() {
  $("error").classList.add("hidden");
}

// ===== 自分が誰か =====
// URL に ?me=papa 等があればそれを優先（テスト用・保存しない）。無ければ保存値。
function resolveMyId(): string | null {
  const fromUrl = new URLSearchParams(location.search).get("me");
  if (fromUrl && MEMBERS.some((m) => m.id === fromUrl)) return fromUrl;
  return localStorage.getItem(STORAGE_KEY);
}
let myId: string | null = resolveMyId();

// ===== 状態 =====
let pc: RTCPeerConnection | null = null;
let localStream: MediaStream | null = null;
let callRef: DocumentReference | null = null; // 進行中の通話ドキュメント
let callUnsub: Unsubscribe | null = null; // 発信側: 通話docの監視（answer/終了）
let candUnsub: Unsubscribe | null = null; // 相手のICE候補の監視
let incomingUnsub: Unsubscribe | null = null; // 自分宛て calls/{myId} の監視
let pendingCandidates: RTCIceCandidateInit[] = [];
let appState: "idle" | "calling" | "incoming" | "incall" = "idle";
let peerId: string | null = null;
let latestOffer: RTCSessionDescriptionInit | null = null;
let currentCallId: string | null = null;

function setStatus(s: string) {
  $("status").textContent = s;
}

// 実際に通話がつながっている／つなぎ中か。固まり状態の自己判定に使う。
function isLiveCall(): boolean {
  if (!pc) return false;
  const s = pc.connectionState;
  return s === "connected" || s === "connecting";
}

function setAvatar(elId: string, memberId: string) {
  const m = MEMBERS.find((x) => x.id === memberId);
  const el = $(elId);
  el.textContent = m ? m.initial : "";
  el.style.background = m ? m.color : "#9aa7b4";
}

function memberCard(m: Member, onClick: () => void): HTMLElement {
  const card = document.createElement("button");
  card.type = "button";
  card.className = "member-card";
  const av = document.createElement("span");
  av.className = "avatar";
  av.textContent = m.initial;
  av.style.background = m.color;
  const nm = document.createElement("span");
  nm.className = "card-name";
  nm.textContent = m.name;
  const arrow = document.createElement("span");
  arrow.className = "card-arrow";
  arrow.textContent = "›";
  card.append(av, nm, arrow);
  card.addEventListener("click", onClick);
  return card;
}

let callTimeout: ReturnType<typeof setTimeout> | null = null;
function clearCallTimeout() {
  if (callTimeout) {
    clearTimeout(callTimeout);
    callTimeout = null;
  }
}

let timerInterval: ReturnType<typeof setInterval> | null = null;
let callStartMs = 0;
function startTimer() {
  callStartMs = Date.now();
  $("call-timer").textContent = "00:00";
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    const s = Math.floor((Date.now() - callStartMs) / 1000);
    const mm = String(Math.floor(s / 60)).padStart(2, "0");
    const ss = String(s % 60).padStart(2, "0");
    $("call-timer").textContent = `${mm}:${ss}`;
  }, 1000);
}
function stopTimer() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
}

// ===== 音声出力（受話口/スピーカー）ネイティブ制御 =====
const AudioRoute = registerPlugin<{
  earpiece: () => Promise<void>;
  speaker: () => Promise<void>;
  reset: () => Promise<void>;
  stopRingtone: () => Promise<void>;
  startRingback: () => Promise<void>;
  stopRingback: () => Promise<void>;
}>("AudioRoute");
let speakerOn = false;

async function applyAudioRoute() {
  if (!Capacitor.isNativePlatform()) return;
  try {
    if (speakerOn) await AudioRoute.speaker();
    else await AudioRoute.earpiece();
  } catch (e) {
    console.warn("audio route failed", e);
  }
}
async function resetAudioRoute() {
  speakerOn = false;
  if (!Capacitor.isNativePlatform()) return;
  try {
    await AudioRoute.reset();
  } catch {
    /* ignore */
  }
}
function updateSpeakerButton() {
  $("speaker-toggle").classList.toggle("on", speakerOn);
}

// 着信音を止める（応答/拒否/終了時）。ネイティブ着信サービスの鳴動を停止。
function stopRingtone() {
  if (!Capacitor.isNativePlatform()) return;
  AudioRoute.stopRingtone().catch((e) => console.warn("stopRingtone failed", e));
}

// ===== 呼び出し音（発信側の「トゥルルル」）=====
// スマホでは通話ストリーム（受話口）で鳴らす。PC(Web)テスト用にWeb Audioで代替。
let rbCtx: AudioContext | null = null;
let rbTimer: ReturnType<typeof setInterval> | null = null;

function startRingback() {
  stopRingbackWeb();
  if (Capacitor.isNativePlatform()) {
    AudioRoute.startRingback().catch(() => {});
    return;
  }
  try {
    rbCtx = new AudioContext();
    const osc = rbCtx.createOscillator();
    const gain = rbCtx.createGain();
    osc.frequency.value = 400;
    gain.gain.value = 0;
    osc.connect(gain).connect(rbCtx.destination);
    osc.start();
    const beep = () => {
      if (!rbCtx) return;
      const t = rbCtx.currentTime;
      gain.gain.setValueAtTime(0.08, t);
      gain.gain.setValueAtTime(0, t + 1); // 1秒鳴って2秒休む
    };
    beep();
    rbTimer = setInterval(beep, 3000);
  } catch {
    /* ignore */
  }
}

function stopRingbackWeb() {
  if (rbTimer) {
    clearInterval(rbTimer);
    rbTimer = null;
  }
  if (rbCtx) {
    void rbCtx.close().catch(() => {});
    rbCtx = null;
  }
}

function stopRingback() {
  stopRingbackWeb();
  if (Capacitor.isNativePlatform()) {
    AudioRoute.stopRingback().catch(() => {});
  }
}

async function ensureMedia(): Promise<MediaStream> {
  if (localStream) return localStream;
  localStream = await navigator.mediaDevices.getUserMedia({
    audio: true,
    video: false,
  });
  return localStream;
}

function isStale(data: DocumentData): boolean {
  const ts = data.startedAt;
  if (!ts || typeof ts.toMillis !== "function") return false;
  // 呼び出し中のまま放置された残骸は短時間で無効化（幽霊着信・発信ブロックの防止）
  const limit = data.status === "ringing" ? RING_STALE_MS : STALE_MS;
  return Date.now() - ts.toMillis() > limit;
}

async function addOrBufferCandidate(cand: RTCIceCandidateInit) {
  if (pc && pc.remoteDescription) {
    try {
      await pc.addIceCandidate(cand);
    } catch (err) {
      console.warn("addIceCandidate failed", err);
    }
  } else {
    pendingCandidates.push(cand);
  }
}

async function flushCandidates() {
  if (!pc || !pc.remoteDescription) return;
  const buffered = pendingCandidates;
  pendingCandidates = [];
  for (const c of buffered) {
    try {
      await pc.addIceCandidate(c);
    } catch (err) {
      console.warn("addIceCandidate failed", err);
    }
  }
}

async function clearCandidates(ref: DocumentReference) {
  for (const name of ["callerCandidates", "calleeCandidates"]) {
    const docs = await getDocs(collection(ref, name));
    await Promise.all(docs.docs.map((d) => deleteDoc(d.ref)));
  }
}

function createPeer(
  ref: DocumentReference,
  localName: string,
  remoteName: string,
) {
  pc = new RTCPeerConnection(ICE);
  const localCol = collection(ref, localName);

  pc.onicecandidate = (e) => {
    if (!e.candidate) return;
    const c = e.candidate.toJSON();
    addDoc(localCol, {
      candidate: c.candidate ?? "",
      sdpMid: c.sdpMid ?? null,
      sdpMLineIndex: c.sdpMLineIndex ?? null,
      usernameFragment: c.usernameFragment ?? null,
    }).catch((err) => console.warn("candidate 送信に失敗", err));
  };

  pc.ontrack = (e) => {
    $<HTMLAudioElement>("remote-audio").srcObject = e.streams[0];
  };

  pc.onconnectionstatechange = () => {
    switch (pc?.connectionState) {
      case "connecting":
        setStatus("接続中…");
        break;
      case "connected":
        setStatus("通話中");
        void applyAudioRoute();
        break;
      case "disconnected":
        setStatus("切断（再接続待ち）");
        break;
      case "failed":
        // 音声がつながらないまま無音で放置しない。終了して理由を表示する。
        setStatus("接続失敗");
        void hangUp().then(() =>
          showError(
            "音声がつながりませんでした。電波状況を確認して、もう一度おかけください。",
          ),
        );
        break;
    }
  };

  localStream?.getTracks().forEach((t) => pc!.addTrack(t, localStream!));

  candUnsub = onSnapshot(collection(ref, remoteName), (snap) => {
    snap.docChanges().forEach((ch) => {
      if (ch.type === "added") {
        void addOrBufferCandidate(ch.doc.data() as RTCIceCandidateInit);
      }
    });
  });
}

function enterCallUI(otherId: string) {
  stopRingback();
  clearCallTimeout();
  peerId = otherId;
  $("peer-name").textContent = nameOf(otherId);
  setAvatar("call-avatar", otherId);
  setStatus("接続中…");
  speakerOn = false;
  updateSpeakerButton();
  void applyAudioRoute();
  startTimer();
  showPanel("call-panel");
}

// ===== 発信（自分→相手）=====
// type: "incoming_call"=着信を鳴らす / "cancel_call"=取り消し（相手の鳴動を止める）
async function sendIncomingPush(
  targetId: string,
  type: "incoming_call" | "cancel_call" = "incoming_call",
) {
  if (!myId) return;
  try {
    const tokenSnap = await getDoc(doc(db, "tokens", targetId));
    const toToken = tokenSnap.data()?.token;
    if (typeof toToken !== "string" || !toToken) {
      console.warn("push token not found", targetId);
      return;
    }

    const idToken = await auth.currentUser?.getIdToken();
    if (!idToken) {
      console.warn("Firebase ID token is not ready");
      return;
    }

    const res = await fetch(PUSH_WORKER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        idToken,
        toToken,
        fromName: nameOf(myId),
        type,
      }),
    });

    if (!res.ok) {
      console.warn("incoming push failed", await res.text());
    }
  } catch (e) {
    console.warn("incoming push failed", e);
  }
}
async function callTo(targetId: string) {
  clearError();
  if (!myId) return;
  try {
    await ensureMedia();
  } catch {
    showError("マイクの使用を許可してください。");
    return;
  }

  callRef = doc(db, "calls", targetId);
  const callId = crypto.randomUUID();
  currentCallId = callId;
  let claimed = false;
  try {
    claimed = await runTransaction(db, async (tx) => {
      const snap = await tx.get(callRef!);
      const d = snap.data();
      const active = !!d && d.status !== "ended" && !isStale(d);
      if (active && d && d.from !== myId) return false; // 相手は通話中/呼び出し中
      tx.set(callRef!, {
        callId,
        from: myId,
        to: targetId,
        status: "ringing",
        offer: null,
        answer: null,
        startedAt: serverTimestamp(),
      });
      return true;
    });
  } catch (e) {
    console.error(e);
    showError("発信に失敗しました。通信環境を確認してください。");
    callRef = null;
    return;
  }
  if (!claimed) {
    showError(`${nameOf(targetId)}は今、ほかの通話中か呼び出し中です。`);
    callRef = null;
    return;
  }

  await clearCandidates(callRef);
  appState = "calling";
  peerId = targetId;
  $("calling-name").textContent = nameOf(targetId);
  setAvatar("calling-avatar", targetId);
  showPanel("calling-panel");

  // 受話口に切り替えて呼び出し音（トゥルルル）を鳴らす（耳に当てて待てる）
  speakerOn = false;
  void applyAudioRoute();
  startRingback();

  // 応答が無ければ自動で取り消す（呼び出しっぱなし防止）
  callTimeout = setTimeout(() => {
    if (appState === "calling" && currentCallId === callId) {
      void hangUp().then(() =>
        showError(`${nameOf(targetId)}は応答しませんでした。`),
      );
    }
  }, CALL_TIMEOUT_MS);

  createPeer(callRef, "callerCandidates", "calleeCandidates");
  const offer = await pc!.createOffer();
  await pc!.setLocalDescription(offer);
  await updateDoc(callRef, { offer: { type: offer.type, sdp: offer.sdp } });
  void sendIncomingPush(targetId);

  callUnsub = onSnapshot(callRef, (snap) => {
    if (!snap.exists()) {
      remoteEnded();
      return;
    }
    const d = snap.data();
    if (d.status === "ended") {
      remoteEnded();
      return;
    }
    if (d.answer && pc && !pc.currentRemoteDescription) {
      void (async () => {
        await pc!.setRemoteDescription(d.answer);
        await flushCandidates();
        appState = "incall";
        enterCallUI(targetId);
      })();
    }
  });
}

// ===== 着信に応答（相手→自分）=====
async function acceptCall() {
  // 応答ボタンを押したら、状態に関わらず即座に鳴動を止める
  stopRingtone();
  stopRingback();
  if (appState !== "incoming" || !myId || !peerId || !latestOffer) return;
  clearError();
  try {
    await ensureMedia();
  } catch {
    showError("マイクの使用を許可してください。");
    return;
  }
  callRef = doc(db, "calls", myId);
  appState = "incall";
  enterCallUI(peerId);

  createPeer(callRef, "calleeCandidates", "callerCandidates");
  await pc!.setRemoteDescription(latestOffer);
  await flushCandidates();
  const answer = await pc!.createAnswer();
  await pc!.setLocalDescription(answer);
  try {
    await updateDoc(callRef, {
      answer: { type: answer.type, sdp: answer.sdp },
      status: "accepted",
    });
  } catch {
    // 応答した瞬間に相手が取り消した（docが消えた）すれ違い
    endLocalOnly("通話が終了しました");
  }
}

// ===== 自分宛て着信の監視（常時）=====
function startIncomingListener() {
  if (!myId) return;
  const ref = doc(db, "calls", myId);
  incomingUnsub = onSnapshot(ref, (snap) => {
    if (!snap.exists()) {
      if (appState === "incoming" || appState === "incall") {
        endLocalOnly("通話が終了しました");
      }
      return;
    }
    const d = snap.data();
    const fresh =
      d.status === "ringing" &&
      d.offer &&
      d.from &&
      d.from !== myId &&
      !isStale(d);
    // 新しい着信は、たとえ前の通話状態が固まっていても受け付ける
    // （実際につながっている通話中だけは邪魔しない）。
    if (
      fresh &&
      d.callId !== currentCallId &&
      (appState === "idle" || !isLiveCall())
    ) {
      if (appState !== "idle") cleanupPeer(); // 固まった残骸を掃除（docは消さない）
      peerId = d.from;
      latestOffer = d.offer as RTCSessionDescriptionInit;
      currentCallId = (d.callId as string) ?? null;
      $("incoming-name").textContent = nameOf(d.from);
      setAvatar("incoming-avatar", d.from);
      appState = "incoming";
      callRef = ref; // 拒否時にこの doc を消して発信側へ伝えるため
      showPanel("incoming-panel");
    } else if (appState === "incoming" && d.status === "ended") {
      endLocalOnly("");
    } else if (appState === "incall" && d.status === "ended") {
      endLocalOnly("通話が終了しました");
    } else if (
      (appState === "calling" || appState === "incall") &&
      d.status === "ringing" &&
      d.from !== myId
    ) {
      // 発信中・通話中に別の家族から着信が来た: 今は出られないので鳴動だけ止める
      stopRingtone();
    }
  });
}

// ===== 終了系 =====
function cleanupPeer() {
  stopRingback();
  clearCallTimeout();
  if (callUnsub) {
    callUnsub();
    callUnsub = null;
  }
  if (candUnsub) {
    candUnsub();
    candUnsub = null;
  }
  if (pc) {
    pc.onicecandidate = null;
    pc.ontrack = null;
    pc.onconnectionstatechange = null;
    pc.close();
    pc = null;
  }
  $<HTMLAudioElement>("remote-audio").srcObject = null;
  pendingCandidates = [];
  localStream?.getTracks().forEach((t) => t.stop());
  localStream = null;
  stopTimer();
  void resetAudioRoute();
}

async function deleteCallDoc(ref: DocumentReference, expectedCallId: string | null) {
  try {
    const deleted = await runTransaction(db, async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists()) return false;
      const d = snap.data();
      // 別の新しい通話で上書きされていたら消さない（再発信の取り違え防止）
      if (expectedCallId && d.callId && d.callId !== expectedCallId) return false;
      tx.delete(ref);
      return true;
    });
    if (deleted) await clearCandidates(ref);
  } catch (e) {
    console.warn("deleteCallDoc failed", e);
  }
}

// 自分から切る（発信取消・拒否・通話終了）。相手にも伝わるよう doc を削除。
// 削除を待ってからホームへ戻す（待たずに掛け直すと前の削除が新通話を消す競合が起きるため）。
async function hangUp() {
  stopRingtone();
  const ref = callRef;
  const id = currentCallId;
  // 呼び出し中に取り消した場合は、相手の鳴動を止める合図を送る
  // （相手のアプリが閉じていても、ネイティブ側が cancel_call で止める）
  const cancelTarget = appState === "calling" ? peerId : null;
  appState = "idle";
  callRef = null;
  currentCallId = null;
  cleanupPeer();
  if (cancelTarget) void sendIncomingPush(cancelTarget, "cancel_call");
  if (ref) await deleteCallDoc(ref, id);
  goHome();
}

// 相手が切った場合（自分は doc を消さない）
function endLocalOnly(msg: string) {
  stopRingtone();
  appState = "idle";
  callRef = null;
  currentCallId = null;
  cleanupPeer();
  if (msg) showError(msg);
  goHome();
}

// 発信側で相手が応答せず終了/拒否
function remoteEnded() {
  endLocalOnly("通話が終了しました");
}

// ===== 画面 =====
function renderSetup() {
  const box = $("member-choices");
  box.innerHTML = "";
  for (const m of MEMBERS) {
    box.appendChild(
      memberCard(m, () => {
        myId = m.id;
        localStorage.setItem(STORAGE_KEY, m.id);
        restartIncoming();
        goHome();
      }),
    );
  }
}

function renderContacts() {
  const box = $("contact-list");
  box.innerHTML = "";
  for (const m of MEMBERS) {
    if (m.id === myId) continue;
    box.appendChild(memberCard(m, () => void callTo(m.id)));
  }
}

function goHome() {
  appState = "idle";
  peerId = null;
  latestOffer = null;
  currentCallId = null;
  renderContacts();
  showPanel("home-panel");
  if (!incomingUnsub) startIncomingListener();
  void setupPush();
  saveToken();
}

// ===== プッシュ通知（FCM）：受信用トークンを取得して Firestore に保存 =====
let pushReady = false;
let lastPushToken: string | null = null;

function saveToken() {
  if (!lastPushToken || !myId) return;
  void setDoc(doc(db, "tokens", myId), {
    token: lastPushToken,
    platform: "android",
    updatedAt: serverTimestamp(),
  });
}

async function setupPush() {
  if (!Capacitor.isNativePlatform() || pushReady) return;
  pushReady = true;
  try {
    await PushNotifications.addListener("registration", (t) => {
      lastPushToken = t.value;
      saveToken();
    });
    await PushNotifications.addListener("registrationError", (e) => {
      console.warn("push registration error", e);
    });
    let perm = await PushNotifications.checkPermissions();
    if (perm.receive === "prompt") {
      perm = await PushNotifications.requestPermissions();
    }
    if (perm.receive === "granted") {
      await PushNotifications.register();
    }
  } catch (e) {
    console.warn("setupPush failed", e);
  }
}

function restartIncoming() {
  if (incomingUnsub) {
    incomingUnsub();
    incomingUnsub = null;
  }
  startIncomingListener();
}

// ===== ボタン =====
$("speaker-btn").addEventListener("click", () => {
  speakerOn = !speakerOn;
  updateSpeakerButton();
  void applyAudioRoute();
});
const notReady = () => showError("メッセージ機能は準備中です。");
$("msg-home-btn").addEventListener("click", notReady);
$("msg-call-btn").addEventListener("click", notReady);
$("end-btn").addEventListener("click", () => void hangUp());
$("cancel-btn").addEventListener("click", () => void hangUp());
$("decline-btn").addEventListener("click", () => void hangUp());
$("accept-btn").addEventListener("click", () => void acceptCall());
$("change-me").addEventListener("click", () => {
  if (incomingUnsub) {
    incomingUnsub();
    incomingUnsub = null;
  }
  myId = null;
  localStorage.removeItem(STORAGE_KEY);
  renderSetup();
  showPanel("setup-panel");
});

window.addEventListener("beforeunload", () => {
  if (callRef) void deleteCallDoc(callRef, currentCallId);
});

// 画面復帰時の自己修復: 通話状態なのに接続実体(pc)が無い＝固まり。
// 着信中(incoming)は pc が無いのが正常なので除外する。
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  if (appState !== "idle" && appState !== "incoming" && !pc) {
    endLocalOnly("");
  }
});

// ===== 起動 =====
async function init() {
  if (!isConfigured) {
    showError(
      "Firebase が未設定です。README の手順に従って src/firebase-config.ts に設定値を貼り付けてください。",
    );
    return;
  }
  const uid = await authReady;
  if (!uid) {
    showError(
      "Firebase に接続できませんでした。設定値・匿名ログインの有効化・通信環境を確認してください。",
    );
    return;
  }
  if (!myId) {
    renderSetup();
    showPanel("setup-panel");
  } else {
    goHome();
  }
}

void init();
