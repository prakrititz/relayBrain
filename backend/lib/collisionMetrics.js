/**
 * Collision counters — claims blocked, patches held back, merge flags.
 *
 * Primary store (survives memory resets):
 *   ~/.relay/data/projects/<projectId>/collisions.json
 *
 * Workspace mirror (git-visible, human-readable):
 *   <repo>/.relay/collisions.json
 *
 * memory.json stats.collisions is kept in sync for room snapshot fan-out only.
 */
const fs = require("fs");
const path = require("path");
const { loadMemory, saveMemory, projectDir, loadRegistry, readJson, writeJson } = require("./store");

const RECENT_MAX = 40;
const FILE_NAME = "collisions.json";

function defaultCollisionStats() {
  return {
    claimsBlocked: 0,
    patchesBlocked: 0,
    patchesSkipped: 0,
    patchesDeferred: 0,
    mergesFlagged: 0,
    totalSaved: 0,
    updatedAt: 0,
    recent: [],
  };
}

function totalSaved(c) {
  return (
    (c.claimsBlocked || 0) +
    (c.patchesBlocked || 0) +
    (c.patchesSkipped || 0) +
    (c.mergesFlagged || 0)
  );
}

function collisionsDataPath(projectId) {
  return path.join(projectDir(projectId), FILE_NAME);
}

function workspaceCollisionsPath(projectId) {
  const project = loadRegistry().projects.find((p) => p.id === projectId);
  if (!project?.path) return null;
  return path.join(project.path, ".relay", FILE_NAME);
}

function normalizeStats(raw) {
  const base = { ...defaultCollisionStats(), ...(raw && typeof raw === "object" ? raw : {}) };
  base.recent = Array.isArray(base.recent) ? base.recent.slice(0, RECENT_MAX) : [];
  base.totalSaved = totalSaved(base);
  return base;
}

function readCollisionsFile(file) {
  if (!file) return null;
  const raw = readJson(file, null);
  if (!raw || typeof raw !== "object") return null;
  return normalizeStats(raw);
}

/**
 * Load local counters: dedicated file first, then migrate from memory.json if needed.
 */
function loadLocalCollisions(projectId) {
  if (!projectId) return defaultCollisionStats();

  const fromData = readCollisionsFile(collisionsDataPath(projectId));
  if (fromData && (fromData.updatedAt || fromData.totalSaved)) return fromData;

  const fromWorkspace = readCollisionsFile(workspaceCollisionsPath(projectId));
  if (fromWorkspace && (fromWorkspace.updatedAt || fromWorkspace.totalSaved)) {
    persistLocalCollisions(projectId, fromWorkspace);
    return fromWorkspace;
  }

  const memory = loadMemory(projectId);
  const legacy = memory?.stats?.collisions;
  if (legacy && typeof legacy === "object") {
    const migrated = normalizeStats(legacy);
    persistLocalCollisions(projectId, migrated);
    return migrated;
  }

  return defaultCollisionStats();
}

function persistLocalCollisions(projectId, stats) {
  if (!projectId) return;
  const next = normalizeStats(stats);
  writeJson(collisionsDataPath(projectId), next);
  const workspaceFile = workspaceCollisionsPath(projectId);
  if (workspaceFile) {
    try {
      fs.mkdirSync(path.dirname(workspaceFile), { recursive: true });
      writeJson(workspaceFile, next);
    } catch {
      /* workspace may be missing / read-only */
    }
  }
  // Keep memory.json in sync so room snapshots still carry our counters.
  try {
    const memory = loadMemory(projectId);
    memory.stats = memory.stats || {};
    memory.stats.collisions = next;
    saveMemory(projectId, memory);
  } catch {
    /* non-fatal */
  }
}

function getCollisionStats(memoryOrProjectId) {
  if (typeof memoryOrProjectId === "string") {
    return loadLocalCollisions(memoryOrProjectId);
  }
  // Dashboard / MCP often pass a memory object; prefer dedicated file when project id is known.
  const mem = memoryOrProjectId || {};
  if (mem.__projectId) return loadLocalCollisions(mem.__projectId);
  if (mem.stats?.collisions) return normalizeStats(mem.stats.collisions);
  return defaultCollisionStats();
}

function memberRow(raw, ownerLogin) {
  const base = normalizeStats(raw);
  return {
    ownerLogin,
    claimsBlocked: base.claimsBlocked || 0,
    patchesBlocked: base.patchesBlocked || 0,
    patchesSkipped: base.patchesSkipped || 0,
    patchesDeferred: base.patchesDeferred || 0,
    mergesFlagged: base.mergesFlagged || 0,
    totalSaved: totalSaved(base),
    updatedAt: base.updatedAt || 0,
    recent: base.recent || [],
  };
}

/**
 * Sum this machine + every peer snapshot in roomPeers.
 */
function mergeCollisionStats(memory, opts = {}) {
  // Lazy require — roomSync imports loadLocalCollisions for snapshots.
  const { peerSnapshots } = require("./roomSync");
  const projectId = opts.projectId || memory?.__projectId || null;
  const local = projectId ? loadLocalCollisions(projectId) : getCollisionStats(memory);
  const peers = peerSnapshots(memory, opts);
  const localLogin = opts.localLogin || "local";
  if (!peers.length) {
    return { ...local, scope: "solo", byMember: [memberRow(local, localLogin)] };
  }

  const members = [memberRow(local, localLogin), ...peers.map((p) => memberRow(p.stats?.collisions, p.login || "peer"))];
  const merged = defaultCollisionStats();
  for (const m of members) {
    merged.claimsBlocked += m.claimsBlocked;
    merged.patchesBlocked += m.patchesBlocked;
    merged.patchesSkipped += m.patchesSkipped;
    merged.patchesDeferred += m.patchesDeferred;
    merged.mergesFlagged += m.mergesFlagged;
  }
  merged.totalSaved = totalSaved(merged);
  merged.updatedAt = Math.max(local.updatedAt || 0, ...members.map((m) => m.updatedAt || 0));
  merged.recent = members
    .flatMap((m) => (m.recent || []).map((row) => ({ ...row, ownerLogin: m.ownerLogin })))
    .sort((a, b) => (b.ts || 0) - (a.ts || 0))
    .slice(0, RECENT_MAX);
  merged.scope = "room";
  merged.byMember = members;
  merged.peerLogins = peers.map((p) => p.login).filter(Boolean);
  return merged;
}

/**
 * @param {string} projectId
 * @param {"claim_blocked"|"patch_blocked"|"patch_skipped"|"patch_deferred"|"merge_flagged"} kind
 * @param {object} [detail]
 */
function recordCollision(projectId, kind, detail = {}) {
  if (!projectId || !kind) return defaultCollisionStats();
  const c = loadLocalCollisions(projectId);
  switch (kind) {
    case "claim_blocked":
      c.claimsBlocked = (c.claimsBlocked || 0) + 1;
      break;
    case "patch_blocked":
      c.patchesBlocked = (c.patchesBlocked || 0) + 1;
      break;
    case "patch_skipped":
      c.patchesSkipped = (c.patchesSkipped || 0) + 1;
      break;
    case "patch_deferred":
      c.patchesDeferred = (c.patchesDeferred || 0) + 1;
      break;
    case "merge_flagged":
      c.mergesFlagged = (c.mergesFlagged || 0) + 1;
      break;
    default:
      return c;
  }
  c.totalSaved = totalSaved(c);
  c.updatedAt = Date.now();
  c.recent = [{ kind, ts: c.updatedAt, ...detail }, ...(c.recent || [])].slice(0, RECENT_MAX);
  persistLocalCollisions(projectId, c);
  return normalizeStats(c);
}

/** Attach file-backed counters onto a memory object for dashboard/MCP reads. */
function hydrateMemoryCollisions(projectId, memory) {
  if (!memory) return memory;
  memory.stats = memory.stats || {};
  memory.stats.collisions = loadLocalCollisions(projectId);
  memory.__projectId = projectId;
  return memory;
}

module.exports = {
  defaultCollisionStats,
  getCollisionStats,
  mergeCollisionStats,
  recordCollision,
  totalSaved,
  loadLocalCollisions,
  persistLocalCollisions,
  hydrateMemoryCollisions,
  collisionsDataPath,
  workspaceCollisionsPath,
};
