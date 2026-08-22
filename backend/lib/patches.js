const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const { tick } = require("./lamport");
const { loadMemory, saveMemory, id } = require("./store");
const { recordCollision } = require("./collisionMetrics");
const { transformPair, insertOrdered, drain } = require("./ot");

function isBinary(buf) {
  return buf.includes(0);
}

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function gitDiff(workspacePath, file) {
  try {
    return execFileSync("git", ["-C", workspacePath, "diff", "--", file], {
      encoding: "utf8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
  } catch {
    return "";
  }
}

function computePatch({ workspacePath, file, agent, ownerLogin, workspaceId }) {
  const abs = path.join(workspacePath, file);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return null;
  const buf = fs.readFileSync(abs);
  const binary = isBinary(buf);
  const lamport = tick(workspaceId || workspacePath);
  const patch = {
    id: id("patch"),
    file: file.replace(/\\/g, "/"),
    agent,
    ownerLogin,
    lamport,
    ts: Date.now(),
    binary,
    sha256: sha256(buf),
    diff: binary ? "" : gitDiff(workspacePath, file) || buf.toString("utf8").slice(0, 4000),
    content: binary ? null : undefined,
  };
  if (binary) patch.replace = true;
  else if (buf.length < 1_000_000) patch.content = buf.toString("utf8");
  return patch;
}

/** True when the file already holds exactly this content. */
function matchesDisk(abs, patch) {
  try {
    return sha256(fs.readFileSync(abs)) === patch.sha256;
  } catch {
    return false;
  }
}

function applyPatchToDisk(workspacePath, patch) {
  if (!workspacePath || !patch?.file) return { applied: false };
  const abs = path.join(workspacePath, patch.file);
  if (patch.binary) {
    return { applied: false, reason: "binary_sha_replace", sha256: patch.sha256 };
  }
  if (typeof patch.content === "string") {
    // Rewriting identical content still fires the filesystem watcher, which
    // publishes a fresh patch (new id, so no dedupe catches it) straight back to
    // the peer it came from — two machines in a room then trade the same file
    // forever at full CPU. Content equality is the only thing that terminates
    // that loop, because every hop legitimately looks like a new edit.
    if (patch.sha256 && matchesDisk(abs, patch)) return { applied: false, reason: "identical" };
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, patch.content);
    return { applied: true };
  }
  return { applied: false, reason: "no_content" };
}

function seenPatch(memory, patch) {
  const id = patch?.id;
  if (!id) return false;
  return (memory.patches || []).some((p) => p.id === id) || (memory.patchBuffer || []).some((p) => p.id === id);
}

/** Peer fan-out: write this file on MY tree. Host is not the source of truth. */
function applyPeerFile(projectId, patch, workspacePath) {
  const memory = loadMemory(projectId);
  if (seenPatch(memory, patch)) return { applied: false, duplicate: true };
  memory.patches = insertOrdered(memory.patches || [], patch);
  memory.edits = memory.edits || [];
  memory.edits.unshift({
    id: patch.id,
    agent: patch.agent,
    ownerLogin: patch.ownerLogin,
    mine: false,
    file: patch.file,
    ts: patch.ts,
    diff: patch.diff || `sha256:${patch.sha256}`,
    lamport: patch.lamport,
    binary: patch.binary,
  });
  let disk = { applied: false };
  if (workspacePath) disk = applyPatchToDisk(workspacePath, patch);
  saveMemory(projectId, memory);
  return { ...disk, recorded: true };
}

function recordPatch(projectId, patch) {
  const memory = loadMemory(projectId);
  memory.patches = insertOrdered(memory.patches || [], patch);
  memory.edits = memory.edits || [];
  memory.edits.unshift({
    id: patch.id,
    agent: patch.agent,
    ownerLogin: patch.ownerLogin,
    mine: true,
    file: patch.file,
    ts: patch.ts,
    diff: patch.diff || `sha256:${patch.sha256}`,
    lamport: patch.lamport,
    binary: patch.binary,
  });
  saveMemory(projectId, memory);
  return memory;
}

function applyIncoming(projectId, patch, lastApplied, workspacePath) {
  const memory = loadMemory(projectId);
  memory.patchBuffer = insertOrdered(memory.patchBuffer || [], patch);
  const { ready, held, lastApplied: next } = drain(
    memory.patchBuffer,
    lastApplied ?? memory.lastAppliedLamport ?? 0
  );
  memory.patchBuffer = held;
  memory.lastAppliedLamport = next;
  const conflicts = [];
  for (let i = 1; i < ready.length; i++) {
    const t = transformPair(ready[i - 1], ready[i]);
    if (!t.ok) {
      conflicts.push(t);
      if (t.manual) {
        recordCollision(projectId, "merge_flagged", {
          file: ready[i].file,
          reason: t.reason,
          lamport: ready[i].lamport,
        });
      }
    }
  }
  memory.patches = ready.reduce((acc, p) => insertOrdered(acc, p), memory.patches || []);
  const applied = [];
  if (workspacePath) {
    for (const p of ready) {
      if (conflicts.some((c) => c.manual && (c.reason || "").includes(p.file))) continue;
      applied.push({ file: p.file, ...applyPatchToDisk(workspacePath, p) });
    }
  }
  saveMemory(projectId, memory);
  return { ready, conflicts, lastApplied: next, applied };
}

function replayUntil(projectId, lamport) {
  const memory = loadMemory(projectId);
  return (memory.patches || []).filter((p) => p.lamport <= lamport);
}

function rewindTo(projectId, workspacePath, lamport) {
  const patches = replayUntil(projectId, lamport);
  const latest = new Map();
  for (const p of patches) latest.set(p.file, p);
  const applied = [];
  for (const p of latest.values()) applied.push({ file: p.file, ...applyPatchToDisk(workspacePath, p) });
  return { lamport, files: [...latest.keys()], applied, patches };
}

module.exports = {
  computePatch,
  recordPatch,
  applyIncoming,
  applyPeerFile,
  applyPatchToDisk,
  replayUntil,
  rewindTo,
  isBinary,
  sha256,
};
