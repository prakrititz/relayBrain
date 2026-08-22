const { EventEmitter } = require("events");

const POLL_MS = 4000;
// How long a lock may sit past its own expiry before the mirror drops it. Locks
// carry a TTL of a few seconds and are renewed by heartbeat, so this is only
// what keeps a lock from flickering out between two polls.
const EXPIRY_GRACE_MS = 4000;
// Consecutive failed polls before the host counts as unreachable. One dropped
// tunnel request is normal; three in a row (~6s) is not.
const MAX_MISSES = 3;
// How long a push keeps the poller quiet. Long enough that a live socket does
// all the work, short enough that a socket which dies without closing cleanly
// (the normal way a tunnel disappears) is covered within one interval.
const PUSH_TRUST_MS = 8000;

/**
 * A guest's own lock table is empty: its hooks claim against the host's
 * coordinator (see coordinator/client.js), which is the whole point of a shared
 * room. Without a mirror, every local read of the lock table — /api/locks, the
 * SSE stream the Coordinator tab subscribes to, the dashboard — reports "no
 * locks" and overwrites the host snapshot the dashboard just fetched.
 *
 * Two ways in, one authority. The host's lock table is the only writer; every
 * change it makes is pushed down the room WebSocket and lands here via accept().
 * That makes granting a lock and drawing it the SAME event rather than two
 * subsystems that can disagree — which is exactly how a guest ended up with
 * working locks and a permanently empty board. The poll below is no longer the
 * delivery path, only reconciliation for whenever the socket is down.
 *
 * Only runs while a room is joined as a guest. Solo and host installs keep
 * reading their own table exactly as before.
 */
class RoomLockMirror extends EventEmitter {
  constructor({ fetchLocks }) {
    super();
    this.fetchLocks = fetchLocks;
    this.locks = [];
    this.reads = [];
    this.updatedAt = 0;
    this.timer = null;
    this.room = null;
    this.failures = 0;
    this.lastPushAt = 0;
  }

  /**
   * Whether the host is answering. The board is otherwise indistinguishable
   * between "nobody is editing" and "the tunnel is down", which is exactly the
   * confusion a guest hits when their Coordinator screen stays empty.
   */
  get health() {
    if (!this.active) return { joined: false, reachable: true, lastContactAt: null };
    return {
      joined: true,
      reachable: this.updatedAt > 0 && this.failures < MAX_MISSES,
      lastContactAt: this.updatedAt || null,
    };
  }

  get active() {
    return Boolean(this.room?.url && this.room.role === "guest" && this.room.hostProjectId);
  }

  /** Has the host ever answered? Until it has, there is nothing to prefer. */
  get fresh() {
    return this.active && this.updatedAt > 0;
  }

  start(room) {
    const sameRoom =
      this.room?.url === room?.url &&
      this.room?.hostProjectId === room?.hostProjectId &&
      this.room?.memberToken === room?.memberToken;
    // Nothing below may touch this.room while it is still the same room.
    //
    // loadRoom() re-parses room.json and hands back a NEW object every call, and
    // the dashboard calls syncRoomLocks() on every poll — so this used to swap
    // this.room's identity every few seconds. poll() drops any response whose
    // room is no longer current, which meant a poll still in flight at that
    // moment was thrown away. Over loopback a poll finishes in milliseconds and
    // nothing is lost; over an ngrok tunnel it takes long enough that every poll
    // could land inside that window, leaving updatedAt at 0 forever — a guest
    // whose locks worked fine but whose Coordinator board never filled in.
    if (sameRoom && this.timer) return undefined;
    const sameHost =
      this.room?.role === "guest" &&
      room?.role === "guest" &&
      this.room?.hostProjectId &&
      this.room.hostProjectId === room.hostProjectId;
    if (sameHost && this.timer) {
      // Tunnel URL changed (ngrok recycle). Keep the last snapshot so the
      // Coordinator board does not flash empty while we retarget.
      this.room = room;
      this.failures = 0;
      this.poll();
      return undefined;
    }
    this.room = room || null;
    if (!this.active) {
      this.stop({ clear: true });
      return undefined;
    }
    this.stop();
    this.room = room;
    this.timer = setInterval(() => this.poll(), POLL_MS);
    if (this.timer.unref) this.timer.unref();
    this.poll();
    return undefined;
  }

  stop({ clear } = {}) {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.failures = 0;
    this.lastPushAt = 0;
    if (clear && (this.locks.length || this.reads.length)) {
      this.locks = [];
      this.reads = [];
      this.updatedAt = 0;
      this.emit("change", { locks: [], reads: [] });
    }
    return undefined;
  }

  /**
   * A lock change pushed straight from the host's table over the room socket.
   * Same commit path as a successful poll, so both routes leave the mirror in
   * exactly one state.
   */
  accept(locks, extras = {}) {
    if (!this.active || !Array.isArray(locks)) return false;
    this.lastPushAt = Date.now();
    const readsChanged =
      Array.isArray(extras.reads) && JSON.stringify(extras.reads) !== JSON.stringify(this.reads);
    if (Array.isArray(extras.reads)) this.reads = extras.reads;
    return this.commit(locks, readsChanged);
  }

  commit(locks, readsChanged = false) {
    const changed = JSON.stringify(locks) !== JSON.stringify(this.locks) || readsChanged;
    const wasDown = this.failures >= MAX_MISSES;
    this.locks = locks;
    this.updatedAt = Date.now();
    this.failures = 0;
    if (changed || wasDown) this.emit("change", { locks, reads: this.reads || [] });
    return changed;
  }

  async poll() {
    if (!this.active) return;
    // The socket is delivering; a poll would only re-fetch what we already have.
    if (Date.now() - this.lastPushAt < PUSH_TRUST_MS) return;
    const room = this.room;
    try {
      const snap = await this.fetchLocks(room);
      if (!snap || this.room !== room) return;
      if (Array.isArray(snap)) {
        this.commit(snap);
        return;
      }
      if (!Array.isArray(snap.locks)) return;
      const readsChanged =
        Array.isArray(snap.reads) && JSON.stringify(snap.reads) !== JSON.stringify(this.reads);
      if (Array.isArray(snap.reads)) this.reads = snap.reads;
      this.commit(snap.locks, readsChanged);
    } catch {
      // Host unreachable: keep the last snapshot and let each lock age out on
      // its own TTL, rather than flashing "all locks released" on every dropped
      // tunnel request.
      this.failures += 1;
      if (this.failures === MAX_MISSES) this.emit("change", { locks: this.list() || [] });
    }
  }

  /**
   * The host's locks, minus anything that has since run out of TTL.
   *
   * A dropped poll used to blank this after 15s, which took the guest's whole
   * Coordinator board down with it — including locks the host was still
   * heartbeating. Ageing entries out by their own expiry instead means an
   * unreachable host decays the board file by file, exactly as a host that went
   * quiet would, and one slow tunnel request changes nothing.
   */
  list() {
    if (!this.fresh) return null;
    const cutoff = Date.now() - EXPIRY_GRACE_MS;
    return this.locks.filter((l) => !l.expiresAt || l.expiresAt > cutoff);
  }

  /** Host reads, minus anything that has aged out of its own TTL. */
  listReads() {
    if (!this.fresh) return null;
    const now = Date.now();
    return (this.reads || []).filter((r) => {
      const exp = r.expiresAt || (r.at || 0) + 30000;
      return exp > now;
    });
  }
}

module.exports = { RoomLockMirror };
