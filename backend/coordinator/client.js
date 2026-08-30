const fs = require("fs");
const http = require("http");
const path = require("path");
const { coordinatorStatePath } = require("../lib/paths");
const { loadRoom } = require("../lib/room");

const TOTAL_BUDGET_MS = 3000;
const HTTP_TIMEOUT_MS = 2000;

function readState(workspacePath) {
  const files = [coordinatorStatePath(workspacePath), coordinatorStatePath(null)];
  for (const file of files) {
    try {
      const state = JSON.parse(fs.readFileSync(file, "utf8"));
      if (state.port || state.apiPort) return state;
    } catch {
      /* next */
    }
  }
  return null;
}

function readPort(workspacePath) {
  const state = readState(workspacePath);
  return state?.port ? Number(state.port) : null;
}

// The API server owns the same in-memory lock table the dashboard renders, and
// its port is fixed, so it is the one target that cannot go stale. The
// coordinator's port is ephemeral and its state file is trusted blindly by
// readPort — a `relay serve` that dies after binding the coordinator but before
// binding the API leaves a pointer to a dead port behind.
function apiPort(workspacePath) {
  if (process.env.RELAY_PORT) return Number(process.env.RELAY_PORT);
  const state = readState(workspacePath);
  return Number(state?.apiPort) || 3001;
}

// A room whose host has gone away (closed laptop, expired tunnel) otherwise
// costs every hook a full HTTP timeout on each of claim/heartbeat/release, which
// reads to the user as "the agent froze".
const ROOM_COOLDOWN_MS = 30_000;
const roomFailedAt = new Map();

// Only a guest talks to the room. The host *is* the coordinator: routing its own
// hooks out through its ngrok tunnel and back adds a full internet round trip to
// every claim, and stalls the agent whenever the tunnel hiccups.
function roomUsable(room) {
  if (!room?.url || room.role !== "guest") return false;
  const failed = roomFailedAt.get(room.url);
  return !failed || Date.now() - failed > ROOM_COOLDOWN_MS;
}

function markRoomDown(room) {
  if (room?.url) roomFailedAt.set(room.url, Date.now());
}

// The lock table namespaces every lock by absolute workspace path, so a guest
// claiming `src/auth.ts` under `D:\work\repo` and a host holding it under
// `/home/ana/repo` land in two different namespaces and never collide — the
// coordinator looks shared while arbitrating nothing. Rewriting the workspace to
// the host's path is what puts both users on one mutex.
// `path.resolve` alone is not enough on Windows: the same folder reaches us as
// both `C:\Users\PRAKRI~1\...` and `C:\Users\Prakrititz Borah\...` depending on
// who spawned the agent, and a mismatch here silently sends the claim to the
// guest's own namespace instead of the shared one.
function canonicalPath(value) {
  if (!value) return "";
  try {
    return fs.realpathSync.native(value).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  } catch {
    return path.resolve(String(value)).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  }
}

function roomPayload(room, workspacePath, payload) {
  if (room?.role !== "guest" || !room.hostWorkspacePath) return payload;
  const local = canonicalPath(room.projectPath);
  const here = canonicalPath(workspacePath);
  // Antigravity (and some other agents) report a cwd that is the same repo on
  // a different drive letter than the clone Relay joined. Still rewrite onto
  // the host path so both machines share one lock namespace. Skip only when
  // this is clearly a different folder with no room of its own.
  if (local && here && local !== here && !here.startsWith(`${local}/`)) {
    const hereRoom = loadRoom(workspacePath);
    if (!hereRoom?.url || hereRoom.url !== room.url) return payload;
  }
  return { ...payload, workspaceId: room.hostWorkspacePath, peerWorkspacePath: workspacePath };
}

function postJson(port, pathname, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body || {});
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
        },
        timeout: timeoutMs,
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(raw || "{}") });
          } catch (err) {
            reject(err);
          }
        });
      }
    );
    req.on("timeout", () => {
      req.destroy(new Error("timeout"));
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

function getJson(port, pathname, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: pathname,
        method: "GET",
        timeout: timeoutMs,
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(raw || "{}"));
          } catch (err) {
            reject(err);
          }
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end();
  });
}

function lockfilePath(workspacePath, file) {
  const crypto = require("crypto");
  const { locksDirFor } = require("../lib/paths");
  const hash = crypto.createHash("sha256").update(file).digest("hex").slice(0, 16);
  return path.join(locksDirFor(workspacePath), `${hash}.lock`);
}

function filesystemClaim(workspacePath, agentId, file, ttlMs) {
  const lockPath = lockfilePath(workspacePath, file);
  const now = Date.now();
  try {
    fs.writeFileSync(
      lockPath,
      JSON.stringify({ filePath: file, agentId, claimedAt: now, ttlMs, source: "filesystem", workspaceId: workspacePath }),
      { flag: "wx" }
    );
    return { allowed: true, source: "filesystem" };
  } catch {
    try {
      const existing = JSON.parse(fs.readFileSync(lockPath, "utf8"));
      const { sameOwner } = require("./lockTable");
      if (sameOwner(existing.agentId, agentId) || now >= existing.claimedAt + (existing.ttlMs || 15000)) {
        fs.writeFileSync(
          lockPath,
          JSON.stringify({ filePath: file, agentId, claimedAt: now, ttlMs, source: "filesystem", workspaceId: workspacePath })
        );
        return { allowed: true, source: "filesystem" };
      }
      return { allowed: false, holder: existing.agentId, source: "filesystem" };
    } catch {
      return { allowed: true, source: "fail-open" };
    }
  }
}

async function postRemote(url, pathname, body, timeoutMs, token) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${url.replace(/\/$/, "")}${pathname}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "ngrok-skip-browser-warning": "relay",
        // An invite-only host rejects unauthenticated lock traffic; without the
        // token every claim would silently fall back to local-only locking.
        ...(token ? { "x-relay-room-token": token } : {}),
      },
      body: JSON.stringify(body || {}),
      signal: ctrl.signal,
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  } finally {
    clearTimeout(timer);
  }
}

async function claimFile(workspacePath, agentId, file, ttlMs = 15000, opts = {}) {
  const started = Date.now();
  const room = loadRoom(workspacePath);
  const payload = {
    agentId,
    file,
    ttl: ttlMs,
    workspaceId: workspacePath,
    dependsOn: opts.dependsOn,
    files: opts.files,
    mode: opts.mode,
    holder: opts.holder || null,
  };
  // Local API owns the control-plane socket. Guests must not wait on ngrok HTTP
  // while chat snapshots are in flight — claims hop loopback, then a tiny WS.
  // A `degraded` answer means the daemon could not reach the host, so it is not
  // an answer at all — it must not short-circuit the ladder the way a real
  // verdict does. Before this, the daemon's local-table grant came back as a
  // plain `allowed: true` and stopped the search here, shadowing the room HTTP
  // rung below: a dead control socket with a perfectly healthy tunnel never
  // fell through to the wire that was still up.
  let degraded = null;
  try {
    const remaining = Math.max(80, 800 - (Date.now() - started));
    const { body } = await postJson(apiPort(workspacePath), "/api/coord/claim", roomPayload(room, workspacePath, payload), remaining);
    if (body?.degraded) degraded = { ...body, source: body.source || "local_fallback" };
    else if (body && typeof body.allowed === "boolean") return { ...body, source: body.source || "control" };
  } catch {
    /* coordinator / remote fallback */
  }
  if (roomUsable(room)) {
    try {
      const { body } = await postRemote(room.url, "/api/coord/claim", roomPayload(room, workspacePath, payload), HTTP_TIMEOUT_MS, room.memberToken);
      return { ...body, source: body.source || "room" };
    } catch {
      markRoomDown(room);
    }
  }
  // Every rung below this point is local to *this* machine: the coordinator
  // process, the lock directory on this disk, and finally fail-open. None of
  // them can adjudicate a lock that belongs to the room, so once we know we are
  // a guest whose host is unreachable, consulting them would only launder an
  // unanswered question into a confident yes. Refuse with the reason instead.
  if (degraded) {
    console.warn("[relay] HOST_UNREACHABLE — claim refused rather than granted locally");
    return degraded;
  }
  const port = readPort(workspacePath);
  if (port) {
    try {
      const remaining = Math.max(50, HTTP_TIMEOUT_MS - (Date.now() - started));
      const { body } = await postJson(port, "/claim", payload, remaining);
      return { ...body, source: body.source || "coordinator" };
    } catch {
      /* fall through */
    }
  }
  const remaining = TOTAL_BUDGET_MS - (Date.now() - started);
  if (remaining > 0) {
    try {
      return filesystemClaim(workspacePath, agentId, file, ttlMs);
    } catch {
      /* fail open */
    }
  }
  console.warn("[relay] COORDINATOR_UNAVAILABLE — fail-open");
  return { allowed: true, source: "fail-open" };
}

async function releaseFile(workspacePath, agentId, file) {
  const room = loadRoom(workspacePath);
  const payload = { agentId, file, workspaceId: workspacePath };
  try {
    const { body } = await postJson(apiPort(workspacePath), "/api/coord/release", roomPayload(room, workspacePath, payload), 600);
    // A degraded release is already queued for replay by the daemon, but the
    // tunnel may still be up even when the control socket is not — try it, and
    // let the replay be a harmless no-op if this succeeds.
    if (body && !body.degraded) return body;
  } catch {
    /* fallback */
  }
  if (roomUsable(room)) {
    try {
      const { body } = await postRemote(room.url, "/api/coord/release", roomPayload(room, workspacePath, payload), HTTP_TIMEOUT_MS, room.memberToken);
      return body;
    } catch {
      markRoomDown(room);
    }
  }
  return { ok: true };
}

async function status(workspacePath) {
  const port = readPort(workspacePath);
  if (!port) return { locks: {} };
  try {
    return await getJson(port, "/status", HTTP_TIMEOUT_MS);
  } catch {
    return { locks: {} };
  }
}

async function releaseAll(workspacePath, agentId) {
  const room = loadRoom(workspacePath);
  const payload = { agentId, workspaceId: workspacePath };
  if (roomUsable(room)) {
    try {
      const { body } = await postRemote(room.url, "/api/coord/release-all", roomPayload(room, workspacePath, payload), HTTP_TIMEOUT_MS, room.memberToken);
      return body;
    } catch {
      markRoomDown(room);
      /* local fallback */
    }
  }
  const port = readPort(workspacePath);
  if (port) {
    try {
      const { body } = await postJson(port, "/release-all", payload, HTTP_TIMEOUT_MS);
      return body;
    } catch {
      /* ignore */
    }
  }
  try {
    const { body } = await postJson(apiPort(workspacePath), "/api/coord/release-all", payload, HTTP_TIMEOUT_MS);
    return body;
  } catch {
    /* ignore */
  }
  return { released: [] };
}

async function heartbeat(workspacePath, agentId, file) {
  const room = loadRoom(workspacePath);
  const payload = { agentId, file, workspaceId: workspacePath };
  try {
    const { body } = await postJson(apiPort(workspacePath), "/api/coord/heartbeat", roomPayload(room, workspacePath, payload), 400);
    if (body) return body;
  } catch {
    /* fallback */
  }
  if (roomUsable(room)) {
    try {
      const { body } = await postRemote(room.url, "/api/coord/heartbeat", roomPayload(room, workspacePath, payload), HTTP_TIMEOUT_MS, room.memberToken);
      return body;
    } catch {
      markRoomDown(room);
    }
  }
  return { ok: false };
}

module.exports = { claimFile, releaseFile, releaseAll, status, readPort, heartbeat };
