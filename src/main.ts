import "./style.css";
import {
  doc,
  collection,
  addDoc,
  getDocs,
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
import { Capacitor } from "@capacitor/core";
import { PushNotifications } from "@capacitor/push-notifications";
import { db, authReady, isConfigured } from "./firebase";

// ===== 家族メンバー（固定）=====
type Member = { id: string; name: string };
const MEMBERS: Member[] = [
  { id: "papa", name: "パパ" },
  { id: "mama", name: "ママ" },
  { id: "yuki", name: "ゆうき" },
  { id: "akiho", name: "あきほ" },
];
const nameOf = (id: string) => MEMBERS.find((m) => m.id === id)?.name ?? id;

const STORAGE_KEY = "kazoku-my-member-id";
const STALE_MS = 2 * 60 * 60 * 1000;
const ICE: RTCConfiguration = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

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

function updateMicButton() {
  const track = localStream?.getAudioTracks()[0];
  const on = !!track && track.enabled;
  const btn = $("mic-btn");
  btn.textContent = on ? "マイク ON" : "マイク OFF";
  btn.classList.toggle("off", !on);
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
  return Date.now() - ts.toMillis() > STALE_MS;
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
        break;
      case "disconnected":
        setStatus("切断（再接続待ち）");
        break;
      case "failed":
        setStatus("接続失敗");
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
  peerId = otherId;
  $("peer-name").textContent = nameOf(otherId);
  setStatus("接続中…");
  updateMicButton();
  showPanel("call-panel");
}

// ===== 発信（自分→相手）=====
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
  showPanel("calling-panel");

  createPeer(callRef, "callerCandidates", "calleeCandidates");
  const offer = await pc!.createOffer();
  await pc!.setLocalDescription(offer);
  await updateDoc(callRef, { offer: { type: offer.type, sdp: offer.sdp } });

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
  await updateDoc(callRef, {
    answer: { type: answer.type, sdp: answer.sdp },
    status: "accepted",
  });
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
    if (
      appState === "idle" &&
      d.status === "ringing" &&
      d.offer &&
      d.from &&
      d.from !== myId &&
      !isStale(d)
    ) {
      peerId = d.from;
      latestOffer = d.offer as RTCSessionDescriptionInit;
      currentCallId = (d.callId as string) ?? null;
      $("incoming-name").textContent = nameOf(d.from);
      appState = "incoming";
      callRef = ref; // 拒否時にこの doc を消して発信側へ伝えるため
      showPanel("incoming-panel");
    } else if (appState === "incoming" && d.status === "ended") {
      endLocalOnly("");
    } else if (appState === "incall" && d.status === "ended") {
      endLocalOnly("通話が終了しました");
    }
  });
}

// ===== 終了系 =====
function cleanupPeer() {
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
  $("mic-btn").textContent = "マイク ON";
  $("mic-btn").classList.remove("off");
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
  const ref = callRef;
  const id = currentCallId;
  appState = "idle";
  callRef = null;
  currentCallId = null;
  cleanupPeer();
  if (ref) await deleteCallDoc(ref, id);
  goHome();
}

// 相手が切った場合（自分は doc を消さない）
function endLocalOnly(msg: string) {
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
    const b = document.createElement("button");
    b.type = "button";
    b.className = "primary member-btn";
    b.textContent = m.name;
    b.addEventListener("click", () => {
      myId = m.id;
      localStorage.setItem(STORAGE_KEY, m.id);
      restartIncoming();
      goHome();
    });
    box.appendChild(b);
  }
}

function renderContacts() {
  const box = $("contact-list");
  box.innerHTML = "";
  for (const m of MEMBERS) {
    if (m.id === myId) continue;
    const b = document.createElement("button");
    b.type = "button";
    b.className = "primary member-btn";
    b.textContent = `${m.name} を呼ぶ`;
    b.addEventListener("click", () => void callTo(m.id));
    box.appendChild(b);
  }
}

function goHome() {
  appState = "idle";
  peerId = null;
  latestOffer = null;
  currentCallId = null;
  $("me-name").textContent = nameOf(myId!);
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
$("mic-btn").addEventListener("click", () => {
  const track = localStream?.getAudioTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  updateMicButton();
});
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
