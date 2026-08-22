const { spawn } = require("child_process");
const { parseGithubRepo } = require("./githubRepo");
const { inviteState, invitesOf, normLogin } = require("./roomAuth");

const SIGNAL_PREFIX = "relay-room:";
const SIGNAL_FILE = "relay-signal.json";
const PROOF_FILE = "relay-proof.json";

function repoKeyFromRemote(remoteUrl) {
  const parsed = parseGithubRepo(remoteUrl);
  return parsed ? `${parsed.owner}/${parsed.repo}` : null;
}

function signalDescription(repoKey) {
  return `${SIGNAL_PREFIX}${repoKey}`;
}

function invitedLogins(room) {
  return invitesOf(room)
    .filter((i) => {
      const state = inviteState(i);
      return state === "pending" || state === "accepted";
    })
    .map((i) => normLogin(i.login))
    .filter(Boolean);
}

function ghApi(pathname, { method = "GET", body } = {}) {
  const args = ["api", pathname, "-H", "Accept: application/vnd.github+json"];
  if (method && method !== "GET") args.push("-X", method);
  if (body !== undefined) args.push("--input", "-");
  return new Promise((resolve, reject) => {
    const child = spawn("gh", args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, shell: false });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.on("error", () => reject(new Error("gh_not_installed")));
    child.on("exit", (code) => {
      if (code !== 0) return reject(new Error(err.trim() || `gh exited ${code}`));
      const text = out.trim();
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        resolve(text);
      }
    });
    if (body !== undefined) child.stdin.write(JSON.stringify(body));
    child.stdin.end();
  });
}

async function readGist(id) {
  if (!id) return null;
  try {
    return await ghApi(`gists/${id}`);
  } catch {
    try {
      const res = await fetch(`https://api.github.com/gists/${id}`, {
        headers: { "User-Agent": "relay-it", Accept: "application/vnd.github+json" },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return null;
      return res.json();
    } catch {
      return null;
    }
  }
}

function parseSignal(gist) {
  if (!gist?.id) return null;
  const desc = String(gist.description || "");
  if (!desc.startsWith(SIGNAL_PREFIX)) return null;
  const raw = gist.files?.[SIGNAL_FILE]?.content;
  let body = {};
  if (raw) {
    try {
      body = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return {
    v: body.v || 1,
    live: body.live !== false,
    roomId: body.roomId || null,
    url: body.url || null,
    hostLogin: body.hostLogin || gist.owner?.login || null,
    repoKey: body.repo || desc.slice(SIGNAL_PREFIX.length),
    projectName: body.projectName || null,
    nonce: body.nonce || null,
    invited: Array.isArray(body.invited) ? body.invited.map(normLogin) : [],
    updatedAt: body.updatedAt || null,
    gistId: gist.id,
  };
}

function signalPayload(room, { repoKey, hostLogin }) {
  return {
    v: 1,
    live: room.live !== false,
    roomId: room.roomId,
    url: room.url || null,
    hostLogin,
    repo: repoKey,
    projectName: room.hostProjectName || null,
    nonce: room.nonce,
    invited: invitedLogins(room),
    updatedAt: new Date().toISOString(),
  };
}

async function findOwnSignalGist(repoKey) {
  try {
    const mine = await ghApi("gists");
    const description = signalDescription(repoKey);
    return (Array.isArray(mine) ? mine : []).find((g) => g.description === description) || null;
  } catch {
    return null;
  }
}

/**
 * Publishes the current tunnel URL under a well-known public gist so a guest
 * can find the host again after ngrok recycles the URL. Membership credentials
 * stay in room.json — the gist is only a pointer.
 */
async function publishSignal(room, { repoKey, hostLogin }) {
  if (!room?.roomId || !repoKey || !hostLogin) {
    return { ok: false, error: "signal_incomplete" };
  }
  const description = signalDescription(repoKey);
  const files = { [SIGNAL_FILE]: { content: JSON.stringify(signalPayload(room, { repoKey, hostLogin }), null, 2) } };
  const patch = async (id) => {
    await ghApi(`gists/${id}`, { method: "PATCH", body: { description, files } });
    return { ok: true, gistId: id };
  };
  if (room.signalGistId) {
    try {
      return await patch(room.signalGistId);
    } catch {
      /* gist was deleted — fall through and recreate */
    }
  }
  const existing = await findOwnSignalGist(repoKey);
  if (existing?.id) return patch(existing.id);
  const created = await ghApi("gists", {
    method: "POST",
    body: { description, public: true, files },
  });
  if (!created?.id) return { ok: false, error: "gist_create_failed" };
  return { ok: true, gistId: created.id };
}

async function findSignal({ gistId, hostLogin, repoKey, roomId } = {}) {
  if (gistId) {
    const signal = parseSignal(await readGist(gistId));
    if (signal && (!roomId || signal.roomId === roomId) && (!repoKey || signal.repoKey === repoKey)) return signal;
  }
  if (!hostLogin || !repoKey) return null;
  let gists = [];
  try {
    gists = await ghApi(`users/${encodeURIComponent(hostLogin)}/gists`);
  } catch {
    try {
      const res = await fetch(`https://api.github.com/users/${encodeURIComponent(hostLogin)}/gists`, {
        headers: { "User-Agent": "relay-it", Accept: "application/vnd.github+json" },
        signal: AbortSignal.timeout(6000),
      });
      if (res.ok) gists = await res.json();
    } catch {
      gists = [];
    }
  }
  const description = signalDescription(repoKey);
  const match = (Array.isArray(gists) ? gists : []).find((g) => g.description === description);
  if (!match?.id) return null;
  const signal = parseSignal(await readGist(match.id));
  if (!signal) return null;
  if (roomId && signal.roomId !== roomId) return null;
  return signal;
}

async function discoverRooms({ repoKey, logins, myLogin }) {
  const me = normLogin(myLogin);
  const hosts = [...new Set((logins || []).map(normLogin).filter((l) => l && l !== me))];
  const rooms = [];
  for (const hostLogin of hosts) {
    try {
      const signal = await findSignal({ hostLogin, repoKey });
      if (!signal?.live || !signal.url) continue;
      if (!signal.invited.includes(me)) continue;
      rooms.push({
        hostLogin: signal.hostLogin,
        url: signal.url,
        roomId: signal.roomId,
        projectName: signal.projectName,
        invited: true,
        updatedAt: signal.updatedAt,
        gistId: signal.gistId,
      });
    } catch {
      /* one collaborator failing must not hide the others */
    }
  }
  return rooms;
}

async function createProof({ roomId, nonce, login }) {
  const gist = await ghApi("gists", {
    method: "POST",
    body: {
      description: `relay-proof:${roomId}`,
      public: false,
      files: {
        [PROOF_FILE]: {
          content: JSON.stringify({ v: 1, roomId, nonce, login: normLogin(login), ts: Date.now() }),
        },
      },
    },
  });
  if (!gist?.id) throw new Error("proof_create_failed");
  return gist.id;
}

async function deleteGist(id) {
  if (!id) return;
  try {
    await ghApi(`gists/${id}`, { method: "DELETE" });
  } catch {
    /* leftover proof gists are secret and expire from usefulness with the nonce */
  }
}

async function verifyProof({ gistId, roomId, nonce, login }) {
  const gist = await readGist(gistId);
  if (!gist?.id) return { ok: false, reason: "proof_missing" };
  if (normLogin(gist.owner?.login) !== normLogin(login)) return { ok: false, reason: "proof_wrong_user" };
  const raw = gist.files?.[PROOF_FILE]?.content;
  let body;
  try {
    body = JSON.parse(raw || "");
  } catch {
    return { ok: false, reason: "proof_invalid" };
  }
  if (!body || body.roomId !== roomId || body.nonce !== nonce) return { ok: false, reason: "proof_mismatch" };
  return { ok: true };
}

const GIST_SCOPE_HINT =
  "Sharing is up, but teammates cannot auto-find you yet. Run `gh auth refresh -s gist` once so Relay can publish a join signal. Until then, send them the invite link.";

module.exports = {
  repoKeyFromRemote,
  invitedLogins,
  publishSignal,
  findSignal,
  discoverRooms,
  createProof,
  deleteGist,
  verifyProof,
  GIST_SCOPE_HINT,
};
