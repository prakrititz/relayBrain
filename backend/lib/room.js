const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { homeRelayDir } = require("./paths");
const { normalizeWorkspaceRoot } = require("./transcripts/util");

function roomPath(workspacePath) {
  if (workspacePath) {
    const root = normalizeWorkspaceRoot(workspacePath) || workspacePath;
    return path.join(root, ".relay", "room.json");
  }
  return path.join(homeRelayDir(), "room.json");
}

function loadRoom(workspacePath) {
  const files = [roomPath(workspacePath), roomPath(null)];
  if (process.env.RELAY_ROOM_URL) {
    return { role: process.env.RELAY_ROOM_ROLE || "guest", url: process.env.RELAY_ROOM_URL, hostProjectId: process.env.RELAY_ROOM_PROJECT || null };
  }
  for (const file of files) {
    try {
      const room = JSON.parse(fs.readFileSync(file, "utf8"));
      if (room?.url || room?.roomId) return room;
    } catch {
      /* next */
    }
  }
  return null;
}

function saveRoom(room, workspacePath) {
  const targets = [roomPath(null)];
  if (workspacePath) targets.push(roomPath(workspacePath));
  for (const file of targets) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(room, null, 2));
    } catch {
      /* skip a target that cannot be created (e.g. stale registry path) */
    }
  }
  return room;
}

function clearRoom(workspacePath) {
  for (const file of [roomPath(workspacePath), roomPath(null)]) {
    try {
      fs.unlinkSync(file);
    } catch {
      /* ignore */
    }
  }
}

function publicUrl() {
  return loadRoom()?.url || null;
}

function upsertMember(room, user, role) {
  if (!room || !user?.login) return room;
  const members = Array.isArray(room.members) ? room.members : [];
  const row = {
    id: user.id || `user_${user.login}`,
    login: user.login,
    name: user.name || user.login,
    avatarUrl: user.avatarUrl || "",
    role: role || user.role || "guest",
    online: true,
    lastSeen: Date.now(),
    agentActive: Boolean(user.agentActive),
    agentLabel: user.agentLabel || null,
  };
  const i = members.findIndex((m) => m.login === row.login || m.id === row.id);
  if (i >= 0) members[i] = { ...members[i], ...row };
  else members.push(row);
  room.members = members;
  return room;
}

function markLeft(room, login) {
  if (!room?.members || !login) return room;
  const target = String(login).toLowerCase();
  room.members = room.members.map((m) =>
    String(m.login || "").toLowerCase() === target ? { ...m, online: false, lastSeen: Date.now() - 60_000 } : m
  );
  return room;
}

function dropMember(room, login) {
  if (!room?.members || !login) return room;
  const target = String(login).toLowerCase();
  room.members = room.members.filter((m) => String(m.login || "").toLowerCase() !== target);
  return room;
}

function membersView(room) {
  const now = Date.now();
  return (room?.members || []).map((m) => ({
    id: m.id,
    login: m.login,
    name: m.name,
    avatarUrl: m.avatarUrl,
    role: m.role,
    online: now - (m.lastSeen || 0) < 45_000,
    agentActive: Boolean(m.agentActive),
    agentLabel: m.agentLabel || null,
  }));
}

async function fetchTunnels() {
  const res = await fetch("http://127.0.0.1:4040/api/tunnels");
  if (!res.ok) return [];
  const body = await res.json();
  return body.tunnels || [];
}

function pickHttps(tunnels) {
  const httpTunnels = tunnels.filter((t) => String(t.public_url || "").startsWith("https://"));
  return (httpTunnels[0] || tunnels[0] || {}).public_url || null;
}

async function probeTunnel(url, timeoutMs = 4000) {
  if (!url) return false;
  try {
    const res = await fetch(`${String(url).replace(/\/$/, "")}/api/health`, {
      headers: { "ngrok-skip-browser-warning": "relay" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function pickLiveHttps(tunnels) {
  const https = tunnels.filter((t) => String(t.public_url || "").startsWith("https://"));
  for (const t of https) {
    if (await probeTunnel(t.public_url)) return t.public_url;
  }
  return null;
}

async function waitForNgrok(timeoutMs = 20000) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    try {
      last = pickHttps(await fetchTunnels());
      // Trust the local inspector. Probing the public URL from here used to
      // hammer ngrok-free every 400ms until the session was killed.
      if (last) return last;
    } catch {
      /* ngrok inspector not up yet */
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return last;
}

let ngrokChild = null;
let ensureInFlight = null;
let lastSpawnAt = 0;
let inspectorMisses = 0;

function ngrokAlive() {
  if (!ngrokChild?.pid) return false;
  try {
    process.kill(ngrokChild.pid, 0);
    return true;
  } catch {
    ngrokChild = null;
    return false;
  }
}

function killNgrok() {
  const child = ngrokChild;
  ngrokChild = null;
  if (!child?.pid) return;
  try {
    if (process.platform === "win32") {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
        stdio: "ignore",
        windowsHide: true,
        shell: false,
      });
      killer.unref();
    } else {
      child.kill("SIGTERM");
    }
  } catch {
    /* already gone */
  }
}

function spawnNgrok(port) {
  if (ngrokAlive()) return ngrokChild;
  if (lastSpawnAt && Date.now() - lastSpawnAt < 20_000) return ngrokChild;
  try {
    // Never shell:true on Windows — that opens a visible cmd even with
    // windowsHide. Spawn ngrok.exe directly, hide the console, detach so it
    // outlives accidental parent death, and unref so the API can exit.
    const child = spawn("ngrok", ["http", String(port), "--log=stdout"], {
      stdio: "ignore",
      windowsHide: true,
      detached: true,
      shell: false,
    });
    child.on("error", () => {
      if (ngrokChild === child) ngrokChild = null;
    });
    child.on("exit", () => {
      if (ngrokChild === child) ngrokChild = null;
    });
    if (child.pid) {
      child.unref();
      ngrokChild = child;
      lastSpawnAt = Date.now();
      return child;
    }
  } catch {
    /* caller surfaces install hint */
  }
  return null;
}

const NGROK_HINT =
  "ngrok is installed but has no authtoken yet. Sign up at https://dashboard.ngrok.com/signup, copy the token from https://dashboard.ngrok.com/get-started/your-authtoken, run `ngrok config add-authtoken <token>`, keep `relay serve` running, then click Share again. Or in another terminal: `ngrok http 3001` and paste the https Forwarding URL.";

async function listedTunnels() {
  try {
    return await fetchTunnels();
  } catch {
    return [];
  }
}

/**
 * Returns a reachable public URL for this API, restarting ngrok when the
 * previous tunnel has died (VPN change, laptop sleep, token recycle).
 *
 * Never stacks processes: if 4040 already lists a tunnel, or we already
 * spawned one, reuse it. A failed public-URL probe is not a reason to spawn.
 */
async function ensureTunnel(port) {
  if (ensureInFlight) return ensureInFlight;
  ensureInFlight = ensureTunnelOnce(port).finally(() => {
    ensureInFlight = null;
  });
  return ensureInFlight;
}

async function ensureTunnelOnce(port) {
  let tunnels = await listedTunnels();
  let listed = pickHttps(tunnels);
  if (!listed) {
    // 4040 blips under load; one retry avoids stacking a second ngrok on a
    // tunnel we did not spawn (and therefore have no pid for).
    await new Promise((r) => setTimeout(r, 400));
    tunnels = await listedTunnels();
    listed = pickHttps(tunnels);
  }
  if (listed) {
    inspectorMisses = 0;
    return listed;
  }
  if (ngrokAlive()) {
    const waited = await waitForNgrok(8000);
    if (waited) {
      inspectorMisses = 0;
      return waited;
    }
    listed = pickHttps(await listedTunnels());
    if (listed) {
      inspectorMisses = 0;
      return listed;
    }
    // Inspector flap after sleep is normal. Do not kill the only tunnel
    // because a public probe was slow — that is what kept ngrok dying.
    inspectorMisses += 1;
    if (inspectorMisses < 3) return null;
    inspectorMisses = 0;
    killNgrok();
  }
  spawnNgrok(port);
  return (await waitForNgrok()) || pickHttps(await listedTunnels()) || null;
}

function mintRoomId() {
  return `rlr_${crypto.randomBytes(8).toString("hex")}`;
}

function mintNonce() {
  return crypto.randomBytes(16).toString("hex");
}

function newHostRoom(url, extra, existing) {
  const keep = existing?.role === "host" ? existing : {};
  return {
    ...keep,
    role: "host",
    live: true,
    url,
    roomId: keep.roomId || mintRoomId(),
    nonce: keep.nonce || mintNonce(),
    hostProjectId: extra.hostProjectId || keep.hostProjectId || null,
    // Guests rewrite their claims into this path so both sides share one
    // lock namespace, and name their local clone after it.
    hostWorkspacePath: extra.workspacePath || keep.hostWorkspacePath || null,
    hostProjectName: extra.projectName || keep.hostProjectName || null,
    hostLogin: extra.hostLogin || keep.hostLogin || extra.hostUser?.login || null,
    repoKey: extra.repoKey || keep.repoKey || null,
    projectId: extra.hostProjectId || keep.projectId || null,
    projectPath: extra.workspacePath || keep.projectPath || null,
    startedAt: keep.startedAt || new Date().toISOString(),
    members: Array.isArray(keep.members) ? keep.members : extra.members || [],
    invites: Array.isArray(keep.invites) ? keep.invites : [],
    memberTokens: Array.isArray(keep.memberTokens) ? keep.memberTokens : [],
  };
}

async function share(port, extra = {}) {
  const url = await ensureTunnel(port);
  if (!url) {
    return {
      ok: false,
      error: "ngrok_unavailable",
      hint: NGROK_HINT,
    };
  }
  const existing = loadRoom(extra.workspacePath);
  const room = saveRoom(
    upsertMember(newHostRoom(url, extra, existing), extra.hostUser, "host"),
    extra.workspacePath
  );
  return { ok: true, room };
}

module.exports = {
  loadRoom,
  saveRoom,
  clearRoom,
  publicUrl,
  share,
  ensureTunnel,
  probeTunnel,
  roomPath,
  upsertMember,
  markLeft,
  dropMember,
  membersView,
  mintRoomId,
  NGROK_HINT,
};
