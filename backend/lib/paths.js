const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

function homeRelayDir() {
  const dir = path.join(os.homedir(), ".relay");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function tryMkdir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    return true;
  } catch {
    // Missing drive (D:\ on a machine that only has C:), unplugged disk, or a
    // host path from another OS. Callers fall back to ~/.relay instead of
    // taking down relay serve.
    return false;
  }
}

function dataDir() {
  const dir = path.join(homeRelayDir(), "data");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function registryPath() {
  return path.join(dataDir(), "registry.json");
}

function sessionPath() {
  return path.join(dataDir(), "session.json");
}

function nativeWorkspaceRoot(workspacePath) {
  if (!workspacePath) return workspacePath;
  let trimmed = String(workspacePath).trim().replace(/^file:\/+/i, "/");
  const drive = trimmed.match(/^\/?([a-zA-Z]):([\\/].*)$/);
  if (drive) trimmed = `${drive[1]}:${drive[2]}`;
  const doubled = trimmed.match(/^([a-zA-Z]):[\\/]+\1:[\\/]+(.*)$/i);
  if (doubled) trimmed = `${doubled[1]}:\\${doubled[2]}`;
  return path.resolve(trimmed);
}

function coordinatorStatePath(workspacePath) {
  if (workspacePath) {
    const dir = path.join(nativeWorkspaceRoot(workspacePath), ".relay");
    if (tryMkdir(dir)) return path.join(dir, "coordinator-state.json");
  }
  return path.join(homeRelayDir(), "coordinator-state.json");
}

function normKey(value) {
  return String(value || "")
    .replace(/\\/g, "/")
    .replace(/\/+$/, "")
    .toLowerCase();
}

function locksDirFor(workspacePath) {
  const homeLocks = path.join(homeRelayDir(), "locks");
  if (!workspacePath) {
    tryMkdir(homeLocks);
    return homeLocks;
  }
  const root = nativeWorkspaceRoot(workspacePath);
  const dir = path.join(root, ".relay", "locks");
  if (tryMkdir(dir)) return dir;
  const slug = crypto.createHash("sha256").update(normKey(root)).digest("hex").slice(0, 16);
  const fallback = path.join(homeLocks, slug);
  tryMkdir(fallback);
  return fallback;
}

module.exports = {
  homeRelayDir,
  dataDir,
  registryPath,
  sessionPath,
  coordinatorStatePath,
  locksDirFor,
};
