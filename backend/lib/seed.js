const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { loadRegistry, saveRegistry, saveMemory, loadMemory, id } = require("./store");

function avatar(seed, size = 80) {
  const hash = crypto.createHash("md5").update(seed).digest("hex");
  return `https://www.gravatar.com/avatar/${hash}?d=identicon&s=${size}`;
}

function initials(name) {
  const parts = String(name).replace(/[./]/g, " ").trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

function agent(label, status, extra = {}) {
  return {
    id: label.toLowerCase().replace(/\s+/g, "-"),
    label,
    status,
    lastActiveAt: Date.now() - (extra.agoMs || 0),
    sessionId: extra.sessionId,
    ownerId: extra.ownerId,
    ownerLogin: extra.ownerLogin,
    ...extra,
  };
}

function emptyMemory() {
  return {
    stats: { events: 0, agents: 0, patches: 0 },
    agents: [
      agent("Claude Code", "idle"),
      agent("Cursor", "idle"),
      agent("Codex", "idle"),
      agent("Copilot", "idle"),
      agent("Antigravity", "idle"),
    ],
    collaborators: [],
    activity: [],
    history: [],
    timeline: [],
    chats: [],
    edits: [],
  };
}

function looksLikeDemo(mem) {
  if (!mem) return false;
  if (mem.stats?.events === 186 || mem.stats?.events === 64) return true;
  const ids = (mem.activity || []).map((a) => a.id);
  return ids.includes("a1") || ids.includes("u1");
}

// Demo accounts used to be seeded here with `user_<login>` ids. Real accounts
// come from GitHub and are `gh_<id>`, so anything still carrying the old id
// scheme is a placeholder — drop it, unless it is the signed-in session.
function dropDemoUsers() {
  const reg = loadRegistry();
  const users = reg.users || [];
  let activeId = null;
  try {
    activeId = require("./store").loadSession?.().userId || null;
  } catch {
    /* no session helper: keep every account */
  }
  const kept = users.filter((u) => !String(u.id || "").startsWith("user_") || u.id === activeId);
  if (kept.length !== users.length) {
    reg.users = kept;
    saveRegistry(reg);
  }
}

function seedIfEmpty() {
  dropDemoUsers();
  const current = loadRegistry();
  if (current.projects?.length) {
    for (const p of current.projects) {
      const mem = loadMemory(p.id);
      if (looksLikeDemo(mem) || mem.ir) saveMemory(p.id, emptyMemory());
    }
    return loadRegistry();
  }
  const cwd = process.cwd();
  const project = {
    id: "proj_relay",
    name: path.basename(cwd),
    initials: initials(cwd),
    color: "#f59e0b",
    path: cwd,
    remoteUrl: null,
    apiKey: "rl_" + crypto.randomBytes(12).toString("hex"),
    createdAt: Date.now(),
    lastSyncAt: Date.now(),
  };
  try {
    fs.mkdirSync(path.join(cwd, ".relay"), { recursive: true });
  } catch {
    /* ignore */
  }
  saveMemory(project.id, emptyMemory());
  saveRegistry({ users: loadRegistry().users, projects: [project] });
  return loadRegistry();
}

module.exports = { seedIfEmpty, avatar, initials, emptyMemory, id };
