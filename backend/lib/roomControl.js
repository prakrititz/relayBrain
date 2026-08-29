const { WebSocket } = require("ws");

// A guest that releases a lock while the tunnel is down must still be able to
// tell the host about it, or the file stays locked room-wide until the TTL runs
// out (up to MAX_TTL_MS, five minutes). The queue is bounded because an outage
// has no upper bound: past this many pending mutations the oldest are dropped,
// since a release that stale has been overtaken by TTL expiry anyway.
const MAX_QUEUED = 200;

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
    // Mutations issued while `open` was false, replayed in order on reconnect.
    this.queue = [];
    this.queueSeq = 0;
    this.onReplay = null;
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

  /**
   * Park a mutation that could not be sent, for replay on reconnect.
   *
   * Deliberately not used for `claim`: a claim is a question ("may I?"), and
   * replaying it minutes later would answer a question nobody is still asking —
   * the agent has long since been told no and moved on. Only the mutations that
   * are statements of fact ("I am done with this file") are worth replaying.
   *
   * Deliberately not used for `heartbeat` either: a heartbeat is a liveness
   * claim about *now*. Replaying a stale one would resurrect a lock the host has
   * already expired, which is the opposite of what the sender meant.
   */
  enqueue(op, body) {
    if (op !== "release" && op !== "release-all") return false;
    const key = dedupeKey(op, body);
    const existing = this.queue.findIndex((item) => item.key === key);
    if (existing !== -1) this.queue.splice(existing, 1);
    this.queue.push({ key, op, body, seq: ++this.queueSeq, at: Date.now() });
    while (this.queue.length > MAX_QUEUED) this.queue.shift();
    return true;
  }

  get queued() {
    return this.queue.length;
  }

  /**
   * Replay the parked mutations, oldest first, and hand back what the host made
   * of them. The queue is drained before the first send so a replay that throws
   * midway cannot be retried forever against a host that keeps rejecting it.
   */
  async flush() {
    if (!this.queue.length) return { replayed: [], rejected: [] };
    const batch = this.queue.slice().sort((a, b) => a.seq - b.seq);
    this.queue = [];
    const replayed = [];
    const rejected = [];
    for (const item of batch) {
      if (!this.open) {
        rejected.push({ ...item, error: "control_offline" });
        continue;
      }
      try {
        const result = await this.rpc(item.op, item.body);
        replayed.push({ ...item, result });
      } catch (err) {
        rejected.push({ ...item, error: err?.message || String(err) });
      }
    }
    const outcome = { replayed, rejected };
    if (this.onReplay) {
      try {
        this.onReplay(outcome);
      } catch {
        /* a reporting failure must not break reconnection */
      }
    }
    return outcome;
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

// release-all is per agent, not per file, so it collapses to one entry per
// agent+workspace; a per-file release collapses to one entry per file.
function dedupeKey(op, body = {}) {
  const ws = String(body.workspaceId || "");
  if (op === "release-all") return `release-all::${ws}::${String(body.agentId || "")}`;
  return `${op}::${ws}::${String(body.file || "")}::${String(body.agentId || "")}`;
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
