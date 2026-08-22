const os = require("os");
const { sameOwner } = require("../coordinator/lockTable");

function localHost() {
  return String(os.hostname() || "").toLowerCase();
}

function holderHost(held) {
  if (!held) return "";
  if (held.holder?.host) return String(held.holder.host).toLowerCase();
  const parts = String(held.agentId || "").split(":");
  return (parts[1] || "").toLowerCase();
}

function holderIsLocal(held) {
  const host = holderHost(held);
  return Boolean(host) && host === localHost();
}

function aliveLock(lockTable, file, workspacePath) {
  if (!lockTable || typeof lockTable.getLock !== "function") return null;
  const held = lockTable.getLock(file, workspacePath);
  if (!held) return null;
  if (held.mode && held.mode !== "write") return null;
  const ttl = held.ttlMs || 15_000;
  if (Date.now() >= (held.lastHeartbeat || held.claimedAt) + ttl) return null;
  return held;
}

/**
 * skip — remote holder (their apply landed here).
 * defer — local agent still writing; wait for PostToolUse.
 * publish — no live write lock.
 */
function skipPublish(lockTable, workspacePath, file) {
  const held = aliveLock(lockTable, file, workspacePath);
  if (!held) return { skip: false, defer: false, held: null };
  if (!holderIsLocal(held)) {
    return {
      skip: true,
      defer: false,
      held,
      reason: `${file} is locked by ${held.holder?.label || held.agentId}`,
    };
  }
  return { skip: false, defer: true, held };
}

/**
 * Do not write a peer file onto a tree where a local agent is mid-edit,
 * or where a different remote agent holds the lock.
 */
function applyClash(lockTable, workspacePath, file, patch) {
  const held = aliveLock(lockTable, file, workspacePath);
  if (!held) return null;
  const label = held.holder?.label || held.agentId;
  if (holderIsLocal(held)) {
    return { clash: true, holder: held.agentId, reason: `${file} is locked locally by ${label}` };
  }
  if (patch?.originAgentId && sameOwner(held.agentId, patch.originAgentId)) return null;
  return { clash: true, holder: held.agentId, reason: `${file} is locked by ${label}` };
}

module.exports = { skipPublish, applyClash, holderIsLocal, aliveLock };
