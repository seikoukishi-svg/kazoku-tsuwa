import { WebSocketServer } from "ws";

const PORT = Number(process.env.SIGNALING_PORT) || 3001;
const wss = new WebSocketServer({ port: PORT });

// room name -> Set<WebSocket>
const rooms = new Map();
const RELAY_TYPES = new Set(["offer", "answer", "candidate", "bye"]);

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function peersIn(room, except) {
  const set = rooms.get(room);
  if (!set) return [];
  return [...set].filter((p) => p !== except);
}

wss.on("connection", (ws) => {
  ws.room = null;

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.type === "join") {
      const room = String(msg.room || "").trim();
      if (!room) return;
      const set = rooms.get(room) || new Set();
      if (set.size >= 2) {
        send(ws, { type: "full" });
        return;
      }
      ws.room = room;
      set.add(ws);
      rooms.set(room, set);

      const others = peersIn(room, ws);
      if (others.length > 0) {
        // someone is already waiting -> this client starts the call
        send(ws, { type: "peer-present" });
        others.forEach((p) => send(p, { type: "peer-joined" }));
      } else {
        send(ws, { type: "waiting" });
      }
      return;
    }

    if (RELAY_TYPES.has(msg.type) && ws.room) {
      peersIn(ws.room, ws).forEach((p) => send(p, msg));
    }
  });

  ws.on("close", () => {
    const room = ws.room;
    if (!room) return;
    const set = rooms.get(room);
    if (!set) return;
    set.delete(ws);
    peersIn(room, ws).forEach((p) => send(p, { type: "peer-left" }));
    if (set.size === 0) rooms.delete(room);
  });
});

console.log(`[signaling] listening on ws://localhost:${PORT}`);
