const { WebSocket } = require("ws");

/**
 * Guest-side RPC over the dedicated control socket.
 * Locks are game inputs: tiny, ordered, never queued behind chat snapshots.
 */
class RoomControl {
  constructor() {
    this.socket = null;
    this.pending = new Map();
    this.seq = 0;
    this.onLocks = null;
  }

  attach(socket) {
    this.socket = socket;
  }

  get open() {
    return Boolean(this.socket && this.socket.readyState === WebSocket.OPEN);
  }

  handle(msg) {
    if (!msg || typeof msg !== "object") return false;
    if (msg.type === "locks" && this.onLocks) {
      this.onLocks(msg);
      return true;
    }
    if ((msg.type === "rpc-ok" || msg.type === "rpc-err") && this.pending.has(msg.id)) {
      const done = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      done(msg.type === "rpc-err" ? new Error(msg.error || "rpc_failed") : null, msg.result);
      return true;
    }
    return false;
  }

  rpc(op, body, timeoutMs = 700) {
    return new Promise((resolve, reject) => {
      if (!this.open) {
        reject(new Error("control_offline"));
        return;
      }
      const id = String(++this.seq);
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("control_timeout"));
      }, timeoutMs);
      this.pending.set(id, (err, result) => {
        clearTimeout(timer);
        if (err) reject(err);
        else resolve(result);
      });
      try {
        this.socket.send(JSON.stringify({ type: "rpc", op, id, body }));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  send(obj) {
    if (!this.open) return false;
    try {
      this.socket.send(JSON.stringify(obj));
      return true;
    } catch {
      return false;
    }
  }
}

function sendSocket(socket, obj) {
  if (!socket || socket.readyState !== 1) return false;
  try {
    socket.send(typeof obj === "string" ? obj : JSON.stringify(obj));
    return true;
  } catch {
    return false;
  }
}

function broadcast(wss, obj) {
  if (!wss) return;
  const msg = JSON.stringify(obj);
  for (const client of wss.clients) sendSocket(client, msg);
}

module.exports = { RoomControl, sendSocket, broadcast };
