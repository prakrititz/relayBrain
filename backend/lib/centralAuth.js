const crypto = require("crypto");
const os = require("os");
const path = require("path");
const { readJson, writeJson } = require("./store");

function hashKey(raw) {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

function adminKey() {
  // No insecure fallback: Central admin access is disabled entirely unless the
  // operator explicitly sets RELAY_CENTRAL_ADMIN_KEY. A hardcoded default here
  // would be a publicly known admin credential for every install.
  return process.env.RELAY_CENTRAL_ADMIN_KEY || null;
}

function sameSecret(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function registryPath() {
  return path.join(os.homedir(), ".relay-os", "central", "central-projects.json");
}

function loadProjects() {
  return readJson(registryPath(), []);
}

function saveProjects(list) {
  writeJson(registryPath(), list);
}

function createProject(name) {
  const raw = `central_${crypto.randomBytes(24).toString("hex")}`;
  const project = {
    id: `p_${crypto.randomBytes(8).toString("hex")}`,
    name: name || "relay-project",
    apiKeyHash: hashKey(raw),
    keyPrefix: raw.slice(0, 12),
    createdAt: new Date().toISOString(),
  };
  const list = loadProjects();
  list.push(project);
  saveProjects(list);
  return { project, apiKey: raw };
}

function resolveAuth(header) {
  const token = String(header || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return { ok: false };
  const key = adminKey();
  if (key && sameSecret(token, key)) return { ok: true, admin: true };
  const hashed = hashKey(token);
  const project = loadProjects().find((p) => p.apiKeyHash === hashed);
  if (!project) return { ok: false };
  return { ok: true, admin: false, project };
}

module.exports = { hashKey, adminKey, loadProjects, createProject, resolveAuth, registryPath };
