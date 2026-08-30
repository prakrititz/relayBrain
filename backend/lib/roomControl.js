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
    this.flushing = null;
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
      let error = null;
      if (msg.type === "rpc-err") {
        error = new Error(msg.error || "rpc_failed");
        // The host answered, and said no. Everything else that can reject an
        // rpc — a dead socket, a timeout, a send that throws — is the tunnel
        // failing rather than a verdict, and replay treats the two oppositely.
        error.fromHost = true;
      }
      done(error, msg.result);
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
   * of them.
   *
   * A host *verdict* (an `rpc-err`, tagged `fromHost`) is final and the entry is
   * dropped, so a release the host keeps refusing is not retried forever. Any
   * other rejection — dead socket, timeout, a send that throws — is the tunnel
   * failing rather than an answer, so those entries go back on the queue for the
   * next reconnect rather than being silently lost.
   */
  flush() {
    // Concurrent callers share one pass: a second flush would race the first for
    // the same entries and could replay one twice. This is checked before the
    // empty-queue guard because #flush drains the queue up front — by the time a
    // second caller arrives the queue is already empty, and returning a fresh
    // resolved promise there would report "done" while the replay is still in
    // flight, which is exactly what settled() must not do.
    if (this.flushing) return this.flushing;
    if (!this.queue.length) return Promise.resolve({ replayed: [], rejected: [], requeued: [] });
    this.flushing = this.#flush().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  /**
   * Resolves once any in-flight replay has finished.
   *
   * Anything that claims a lock must wait on this. A queued release and a fresh
   * claim for the same file both travel this socket, and `release` on the host
   * only checks `sameOwner` — so if a re-claim lands first, the replayed release
   * that follows deletes the lock the agent has just been granted and still
   * believes it holds.
   */
  settled() {
    return this.flushing || Promise.resolve(null);
  }

  async #flush() {
    const batch = this.queue.slice().sort((a, b) => a.seq - b.seq);
    this.queue = [];
    const replayed = [];
    const rejected = [];
    const requeued = [];
    for (const item of batch) {
      if (!this.open) {
        this.#requeue(item);
        requeued.push({ ...item, error: "control_offline" });
        continue;
      }
      try {
        const result = await this.rpc(item.op, item.body);
        replayed.push({ ...item, result });
      } catch (err) {
        const error = err?.message || String(err);
        if (err?.fromHost) rejected.push({ ...item, error });
        else {
          this.#requeue(item);
          requeued.push({ ...item, error });
        }
      }
    }
    const outcome = { replayed, rejected, requeued };
    if (this.onReplay) {
      try {
        this.onReplay(outcome);
      } catch {
        /* a reporting failure must not break reconnection */
      }
    }
    return outcome;
  }

  // Keeps the original seq, so a re-queued entry still replays ahead of
  // mutations issued after it.
  #requeue(item) {
    if (this.queue.some((q) => q.key === item.key)) return;
    this.queue.push(item);
    while (this.queue.length > MAX_QUEUED) this.queue.shift();
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
