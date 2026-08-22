const { EventEmitter } = require("events");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { locksDirFor } = require("../lib/paths");
const { normalizeWorkspaceRoot } = require("../lib/transcripts/util");

const DEFAULT_TTL_MS = 15_000;
const MIN_TTL_MS = 5_000;
const MAX_TTL_MS = 300_000;
const CLEANUP_MS = 5_000;

function clampTtl(ttlMs) {
  const n = Number(ttlMs);
  if (!Number.isFinite(n)) return DEFAULT_TTL_MS;
  return Math.min(MAX_TTL_MS, Math.max(MIN_TTL_MS, n));
}

function normalizeFile(filePath) {
  return String(filePath || "")
    .replace(/\\/g, "/")
    .replace(/^\.?\//, "")
    .trim();
}

function normWorkspace(value) {
  return String(value || "")
    .replace(/\\/g, "/")
    .replace(/\/+$/, "")
    .toLowerCase();
}

function workspaceRoot(value) {
  if (!value || typeof value !== "string") return null;
  if (!/[\\/]/.test(value)) return null;
  return normalizeWorkspaceRoot(value) || path.resolve(value);
}

function lockKey(workspaceId, filePath) {
  return `${normWorkspace(workspaceId)}::${normalizeFile(filePath)}`;
}

function lockHash(filePath, workspaceId) {
  const material = workspaceId ? `${normWorkspace(workspaceId)}::${normalizeFile(filePath)}` : normalizeFile(filePath);
  return crypto.createHash("sha256").update(material).digest("hex").slice(0, 16);
}

// agentId is `label:host:session`.
function sameOwner(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const pa = String(a).split(":");
  const pb = String(b).split(":");
  const sameHost = (pa[1] || "").toLowerCase() === (pb[1] || "").toLowerCase();
  if (!sameHost) return false;

  const sa = (pa[2] || "").toLowerCase();
  const sb = (pb[2] || "").toLowerCase();
  const known = (s) => s !== "" && s !== "local";

  // When both sides name a real session, the session decides and the label is
  // irrelevant. That cuts both ways:
  //  - one editor firing two hook configs claims as `Cursor:host:sid` and again
  //    as `Claude Code:host:sid`; matching on session stops it deadlocking
  //    against itself
  //  - two concurrent turns of the SAME product are `Antigravity:host:A` and
  //    `Antigravity:host:B`; matching on label alone used to call those one
  //    owner, so they silently shared the file and neither was ever blocked
  if (known(sa) && known(sb)) return sa === sb;

  // At least one side never told us its session. Nothing distinguishes them,
  // so fall back to the label and err towards letting an agent re-take its own
  // lock rather than stranding it behind a lock it cannot identify.
  return pa[0] === pb[0];
}

function sameWorkspace(a, b) {
  if (!a || !b) return false;
  return normWorkspace(a) === normWorkspace(b);
}

function filterKeys(filter) {
  const keys = new Set();
  const add = (value) => {
    if (!value) return;
    keys.add(String(value));
    keys.add(normWorkspace(value));
    const root = workspaceRoot(value);
    if (root) keys.add(normWorkspace(root));
  };
  if (filter && typeof filter === "object") {
    add(filter.id);
    add(filter.path);
    add(filter.workspaceId);
    for (const extra of filter.aliases || []) add(extra);
  } else {
    add(filter);
  }
  return keys;
}

function belongsTo(entry, keys) {
  if (!keys.size) return false;
  const wid = entry.workspaceId;
  if (!wid) return false;
  return keys.has(String(wid)) || keys.has(normWorkspace(wid));
}

function alive(entry, now = Date.now()) {
  const beat = entry.lastHeartbeat || entry.claimedAt;
  return now < beat + entry.ttlMs;
}

// How long a released lock stays on the board, and how many to keep around.
const RECENT_TTL_MS = 45000;
const RECENT_MAX = 200;

// Reads are presence, not claims: they decay on their own and are capped so a
// repo-wide grep cannot flood the board.
const READ_TTL_MS = 30000;
const READ_MAX = 300;
// How long an agent that was refused a file stays interested in its next patch.
const WAITER_TTL_MS = 5 * 60 * 1000;

class LockTable extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.locks = new Map();
    this.locksDir = opts.locksDir || null;
    this.defaultWorkspace = opts.workspacePath || null;
    this._timer = null;
    this._loaded = new Map();
  }

  startCleanup() {
    if (this._timer) return;
    this._timer = setInterval(() => this.sweepExpired(), CLEANUP_MS);
    if (this._timer.unref) this._timer.unref();
  }

  stopCleanup() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  dirFor(workspaceId) {
    try {
      const root = workspaceRoot(workspaceId) || this.defaultWorkspace;
      return root ? locksDirFor(root) : this.locksDir;
    } catch {
      return this.locksDir;
    }
  }

  persist(entry) {
    try {
      const dir = this.dirFor(entry.workspaceId);
      if (!dir) return;
      const serial = { ...entry, readers: [...(entry.readers || [])] };
      fs.writeFileSync(path.join(dir, `${lockHash(entry.filePath, entry.workspaceId)}.lock`), JSON.stringify(serial, null, 2));
    } catch {
      /* in-memory lock still counts; a missing drive must not drop the claim */
    }
  }

  unpersist(filePath, workspaceId) {
    const dir = this.dirFor(workspaceId);
    if (!dir) return;
    for (const name of [lockHash(filePath, workspaceId), lockHash(filePath)]) {
      try {
        fs.unlinkSync(path.join(dir, `${name}.lock`));
      } catch {
        /* ignore */
      }
    }
  }

  ingestEntry(entry, fallbackWorkspace) {
    if (!entry?.filePath || !alive(entry)) return;
    entry.workspaceId = workspaceRoot(entry.workspaceId) || entry.workspaceId || fallbackWorkspace || this.defaultWorkspace;
    if (!entry.workspaceId) return;
    entry.readers = new Set(entry.readers || []);
    this.locks.set(lockKey(entry.workspaceId, entry.filePath), entry);
  }

  /**
   * Fold this workspace's on-disk lock files into the table.
   *
   * This used to run exactly once per workspace per process. But this process is
   * not the only writer: every hook that cannot reach the coordinator falls back
   * to `filesystemClaim`, and each of those runs in its own short-lived node
   * process. Those locks are real — they arbitrate correctly between agents —
   * but a one-shot load meant the long-running server never saw a single one of
   * them, so the Coordinator board showed nothing while agents were in fact
   * locking files against each other.
   *
   * Re-scan instead, gated on the directory's own mtime so a quiet workspace
   * costs one stat.
   */
  loadWorkspace(workspacePath) {
    const root = workspaceRoot(workspacePath) || workspacePath;
    if (!root) return;
    const mark = normWorkspace(root);
    let dir;
    try {
      dir = locksDirFor(root);
    } catch {
      return;
    }
    if (!dir || !fs.existsSync(dir)) return;
    let stamp = 0;
    try {
      stamp = fs.statSync(dir).mtimeMs;
    } catch {
      return;
    }
    const seen = this._loaded.get(mark);
    // Poll the directory at most this often even when its mtime looks unchanged:
    // some filesystems do not bump a directory's mtime when a file inside it is
    // rewritten in place, which is exactly what a heartbeat does.
    if (seen && seen.stamp === stamp && Date.now() - seen.at < 1000) return;
    this._loaded.set(mark, { stamp, at: Date.now() });
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return;
    }
    let added = false;
    for (const name of names) {
      if (!name.endsWith(".lock")) continue;
      try {
        const entry = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
        // An entry this table already owns is authoritative in memory: rereading
        // it would clobber a live heartbeat with whatever last hit the disk.
        const key = lockKey(workspaceRoot(entry.workspaceId) || entry.workspaceId || root, entry.filePath);
        if (this.locks.has(key)) continue;
        const before = this.locks.size;
        this.ingestEntry(entry, root);
        if (this.locks.size !== before) added = true;
      } catch {
        /* a partially written lock file is retried on the next scan */
      }
    }
    // Deferred: loadWorkspace runs inside list()/status(), and a synchronous
    // emit would re-enter whichever read is already in progress.
    if (added) setImmediate(() => this.emit("change", { type: "adopted", workspaceId: root }));
  }

  loadFromDisk() {
    if (this.defaultWorkspace) this.loadWorkspace(this.defaultWorkspace);
    else if (this.locksDir && fs.existsSync(this.locksDir)) {
      const root = path.resolve(this.locksDir, "..", "..");
      this.loadWorkspace(root);
    }
  }

  getLock(file, workspaceId) {
    const ws = workspaceRoot(workspaceId) || workspaceId;
    if (!ws) return null;
    this.loadWorkspace(ws);
    return this.locks.get(lockKey(ws, file)) || null;
  }

  publicEntry(entry) {
    return {
      filePath: entry.filePath,
      agentId: entry.agentId,
      mode: entry.mode || "write",
      claimedAt: entry.claimedAt,
      lastHeartbeat: entry.lastHeartbeat,
      ttlMs: entry.ttlMs,
      expiresAt: (entry.lastHeartbeat || entry.claimedAt) + entry.ttlMs,
      workspaceId: entry.workspaceId || null,
      source: entry.source || "coordinator",
      holder: entry.holder || null,
      readers: [...(entry.readers || [])],
      escalated: Boolean(entry.escalated),
    };
  }

  status(filter) {
    const keys = filter ? filterKeys(filter) : null;
    const locks = {};
    for (const entry of this.locks.values()) {
      if (keys && !belongsTo(entry, keys)) continue;
      locks[`${normWorkspace(entry.workspaceId)}::${entry.filePath}`] = this.publicEntry(entry);
    }
    return { locks, uptime: process.uptime() };
  }

  list(workspaceId) {
    const keys = filterKeys(workspaceId);
    const root =
      workspaceRoot(typeof workspaceId === "object" ? workspaceId?.path || workspaceId?.workspaceId : workspaceId) ||
      (typeof workspaceId === "object" ? workspaceRoot(workspaceId?.path) : null);
    if (root) this.loadWorkspace(root);
    const out = [];
    for (const entry of this.locks.values()) {
      if (!belongsTo(entry, keys)) continue;
      out.push(this.publicEntry(entry));
    }
    out.push(...this.recentFor(keys));
    return out.sort((a, b) => (b.releasedAt || b.claimedAt) - (a.releasedAt || a.claimedAt));
  }

  heartbeat({ agentId, file, workspaceId }) {
    const now = Date.now();
    const ws = workspaceRoot(workspaceId);
    let n = 0;
    for (const entry of this.locks.values()) {
      if (ws && !sameWorkspace(entry.workspaceId, ws)) continue;
      if (!ws) continue;
      const matchFile = !file || normalizeFile(file) === entry.filePath;
      const matchAgent =
        sameOwner(entry.agentId, agentId) ||
        (entry.readers && [...entry.readers].some((r) => sameOwner(r, agentId)));
      if (matchFile && matchAgent) {
        entry.lastHeartbeat = now;
        this.persist(entry);
        n += 1;
      }
    }
    if (n) this.emit("change", { type: "heartbeat", agentId, workspaceId: ws });
    return { ok: true, renewed: n };
  }

  escalateRegister(entry) {
    const filePath = normalizeFile(entry.filePath);
    const ws = workspaceRoot(entry.workspaceId) || entry.workspaceId;
    if (!ws) return { ok: false, reason: "workspace_required" };
    const key = lockKey(ws, filePath);
    const existing = this.locks.get(key);
    if (existing && alive(existing) && !sameOwner(existing.agentId, entry.agentId)) {
      return { ok: false, winner: existing.agentId };
    }
    const now = Date.now();
    const next = {
      ...entry,
      filePath,
      workspaceId: ws,
      readers: new Set(entry.readers || []),
      claimedAt: entry.claimedAt || now,
      lastHeartbeat: now,
      ttlMs: clampTtl(entry.ttlMs),
      escalated: true,
      source: "escalated",
    };
    this.locks.set(key, next);
    this.persist(next);
    this.emit("change", { type: "escalate", entry: next });
    return { ok: true, lock: this.publicEntry(next) };
  }

  claim({ agentId, file, ttl, workspaceId, holder, source, dependsOn, files, mode }) {
    const ws = workspaceRoot(workspaceId) || workspaceId;
    if (!ws || !/[\\/]/.test(String(ws))) {
      return { allowed: false, reason: "workspace path is required so locks stay per repository" };
    }
    this.loadWorkspace(ws);

    const batch = Array.isArray(files) && files.length ? files.map(normalizeFile).filter(Boolean) : null;
    if (batch) {
      const sorted = [...new Set(batch)].sort();
      const held = [];
      for (const f of sorted) {
        const result = this.claim({ agentId, file: f, ttl, workspaceId: ws, holder, source, dependsOn, mode });
        if (!result.allowed) {
          for (const h of held) this.release({ agentId, file: h, workspaceId: ws });
          return result;
        }
        held.push(f);
      }
      return { allowed: true, batch: sorted };
    }

    const filePath = normalizeFile(file);
    if (!filePath || !agentId) return { allowed: false, reason: "agentId and file are required" };
    const ttlMs = clampTtl(ttl);
    const now = Date.now();
    const lockMode = mode === "read" ? "read" : "write";
    const key = lockKey(ws, filePath);

    const deps = Array.isArray(dependsOn) ? dependsOn.map(normalizeFile) : [];
    let warning = null;
    for (const dep of deps) {
      const held = this.locks.get(lockKey(ws, dep));
      if (held && held.mode !== "read" && !sameOwner(held.agentId, agentId) && alive(held, now)) {
        warning = `\`${filePath}\` depends on \`${dep}\`, which ${held.holder?.label || held.agentId} is editing`;
        break;
      }
    }

    // A read is never a lock. It is recorded so the dashboard can show who is
    // looking at what, and it is always allowed — including while someone else
    // holds the write lock, since observing a file cannot corrupt it.
    if (lockMode === "read") {
      this.noteRead({ agentId, filePath, workspaceId: ws, holder });
      return { allowed: true, reading: true };
    }

    let existing = this.locks.get(key);
    if (existing && !alive(existing, now)) {
      this.unpersist(existing.filePath, existing.workspaceId);
      this.locks.delete(key);
      existing = null;
    }

    if (existing) {
      if (sameOwner(existing.agentId, agentId) && existing.mode === "write") {
        existing.claimedAt = now;
        existing.lastHeartbeat = now;
        existing.ttlMs = ttlMs;
        existing.workspaceId = ws;
        this.persist(existing);
        this.emit("change", { type: "renew", entry: existing });
        return { allowed: true, renewed: true, warning, lock: this.publicEntry(existing) };
      }
      // Readers never block a writer. Reading a file is not a claim on it: an
      // agent that merely looked at a file has nothing to lose if someone else
      // edits it, and denying the edit meant one agent browsing the repo could
      // stall everyone else. Only a live write lock arbitrates.
      if (existing.mode === "read") {
        this.locks.delete(key);
        this.unpersist(filePath, ws);
        existing = null;
      }
      if (existing && existing.mode === "write") {
        // This agent wanted the file and could not have it, so it is the one
        // that most needs the resulting patch the moment the holder is done.
        this.noteWaiter({ agentId, filePath, workspaceId: ws, holder });
        return {
          allowed: false,
          holder: existing.agentId,
          reason: `File \`${filePath}\` is locked by ${existing.holder?.label || existing.agentId}. Pick a different task.`,
        };
      }
    }

    const entry = {
      filePath,
      agentId,
      mode: lockMode,
      claimedAt: now,
      lastHeartbeat: now,
      ttlMs,
      workspaceId: ws,
      holder: holder || null,
      source: source || "coordinator",
      readers: lockMode === "read" ? new Set([agentId]) : new Set(),
      escalated: false,
    };
    this.locks.set(key, entry);
    this.persist(entry);
    this.emit("change", { type: "claim", entry });
    return { allowed: true, warning, lock: this.publicEntry(entry) };
  }

  release({ agentId, file, workspaceId }) {
    const ws = workspaceRoot(workspaceId) || workspaceId;
    if (!ws) return { ok: false, reason: "workspace_required" };
    const filePath = normalizeFile(file);
    const key = lockKey(ws, filePath);
    const existing = this.locks.get(key);
    if (!existing) return { ok: true, released: false };
    if (existing.mode === "read") {
      existing.readers = existing.readers || new Set();
      existing.readers.delete(agentId);
      if (existing.readers.size === 0) {
        this.locks.delete(key);
        this.unpersist(filePath, ws);
      } else {
        this.persist(existing);
      }
      this.emit("change", { type: "release", entry: existing });
      return { ok: true, released: true };
    }
    if (!sameOwner(existing.agentId, agentId)) {
      return { ok: false, reason: "not_holder", holder: existing.agentId };
    }
    this.locks.delete(key);
    this.unpersist(filePath, ws);
    this.remember(existing);
    this.emit("change", { type: "release", entry: existing });
    return { ok: true, released: true };
  }

  /**
   * Keep a released lock visible for a short while after it is gone.
   *
   * A pre-tool claim and its post-tool release can be ~100ms apart — the fast
   * models turn an edit around faster than any UI samples state. The lock did
   * its job, but the Coordinator board only ever renders locks that are held
   * right now, so those edits looked like nothing happened at all. These rows
   * are display-only: `getLock` (and so every arbitration path) never sees them.
   */
  remember(entry) {
    if (!entry?.filePath) return;
    if (!this.recent) this.recent = new Map();
    this.recent.set(lockKey(entry.workspaceId, entry.filePath), {
      ...entry,
      readers: [...(entry.readers || [])],
      releasedAt: entry.releasedAt || Date.now(),
    });
    if (this.recent.size > RECENT_MAX) this.recent.delete(this.recent.keys().next().value);
  }

  /**
   * Record that an agent looked at a file.
   *
   * Purely observational: nothing here is consulted when arbitrating a claim.
   * It exists so the dashboard can show the whole room's attention — who is
   * reading what — instead of only the handful of files being written.
   */
  noteRead({ agentId, filePath, workspaceId, holder }) {
    const file = normalizeFile(filePath);
    const ws = workspaceRoot(workspaceId) || workspaceId;
    if (!file || !agentId || !ws) return null;
    if (!this.reads) this.reads = new Map();
    const key = `${normWorkspace(ws)}::${file}::${agentId}`;
    const entry = { filePath: file, agentId, workspaceId: ws, holder: holder || null, at: Date.now() };
    this.reads.delete(key);
    this.reads.set(key, entry);
    if (this.reads.size > READ_MAX) this.reads.delete(this.reads.keys().next().value);
    this.emit("change", { type: "read", entry });
    return entry;
  }

  readsFor(keys, now = Date.now()) {
    const out = [];
    for (const [key, entry] of this.reads || []) {
      if (now - entry.at > READ_TTL_MS) {
        this.reads.delete(key);
        continue;
      }
      if (keys && !belongsTo(entry, keys)) continue;
      out.push({
        ...entry,
        mode: "read",
        reading: true,
        ttlMs: READ_TTL_MS,
        expiresAt: entry.at + READ_TTL_MS,
      });
    }
    return out.sort((a, b) => b.at - a.at);
  }

  /**
   * Remember that an agent was turned away from a file, so that when the holder
   * finishes we know exactly who is still waiting for that file's new content.
   */
  noteWaiter({ agentId, filePath, workspaceId, holder }) {
    const file = normalizeFile(filePath);
    const ws = workspaceRoot(workspaceId) || workspaceId;
    if (!file || !agentId || !ws) return;
    if (!this.waiters) this.waiters = new Map();
    const key = lockKey(ws, file);
    const list = this.waiters.get(key) || new Map();
    list.set(agentId, { agentId, holder: holder || null, at: Date.now() });
    this.waiters.set(key, list);
  }

  /** Waiters for a file, newest first; expired entries are dropped. */
  takeWaiters(filePath, workspaceId) {
    const file = normalizeFile(filePath);
    const ws = workspaceRoot(workspaceId) || workspaceId;
    if (!file || !ws || !this.waiters) return [];
    const key = lockKey(ws, file);
    const list = this.waiters.get(key);
    if (!list) return [];
    const now = Date.now();
    const out = [];
    for (const [agentId, row] of list) {
      if (now - row.at > WAITER_TTL_MS) list.delete(agentId);
      else out.push(row);
    }
    if (!list.size) this.waiters.delete(key);
    return out;
  }

  recentFor(keys, now = Date.now()) {
    const out = [];
    for (const [key, entry] of this.recent || []) {
      if (now - entry.releasedAt > RECENT_TTL_MS) {
        this.recent.delete(key);
        continue;
      }
      if (this.locks.has(key)) continue;
      if (keys && !belongsTo(entry, keys)) continue;
      out.push({ ...this.publicEntry(entry), released: true, releasedAt: entry.releasedAt });
    }
    return out;
  }

  releaseAll(agentId, workspaceId) {
    const ws = workspaceRoot(workspaceId) || workspaceId;
    const released = [];
    for (const [key, entry] of [...this.locks]) {
      if (ws && !sameWorkspace(entry.workspaceId, ws)) continue;
      if (!ws) continue;
      if (sameOwner(entry.agentId, agentId) || (entry.readers && [...entry.readers].some((r) => sameOwner(r, agentId)))) {
        this.release({ agentId, file: entry.filePath, workspaceId: entry.workspaceId });
        released.push(entry.filePath);
      }
    }
    return { released };
  }

  /** Workspaces to re-scan on the cleanup tick, so fail-open locks surface. */
  track(workspacePath) {
    const root = workspaceRoot(workspacePath) || workspacePath;
    if (!root) return;
    if (!this._tracked) this._tracked = new Set();
    this._tracked.add(root);
  }

  sweepExpired() {
    for (const root of this._tracked || []) {
      try {
        this.loadWorkspace(root);
      } catch {
        /* keep sweeping */
      }
    }
    const now = Date.now();
    let changed = false;
    for (const [key, entry] of [...this.locks]) {
      if (!alive(entry, now)) {
        this.locks.delete(key);
        this.unpersist(entry.filePath, entry.workspaceId);
        this.remember(entry);
        changed = true;
      }
    }
    if (changed) this.emit("change");
    return changed;
  }
}

module.exports = {
  LockTable,
  DEFAULT_TTL_MS,
  normalizeFile,
  lockHash,
  sameOwner,
  normWorkspace,
  workspaceRoot,
  filterKeys,
};
