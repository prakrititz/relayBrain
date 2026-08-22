const crypto = require("crypto");
const os = require("os");
const path = require("path");
const { readJson, writeJson } = require("./store");

function hashKey(raw) {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

function adminKey() {
  return process.env.RELAY_CENTRAL_ADMIN_KEY || "relay-dev-admin";
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
  if (token === adminKey()) return { ok: true, admin: true };
  const hashed = hashKey(token);
  const project = loadProjects().find((p) => p.apiKeyHash === hashed);
  if (!project) return { ok: false };
  return { ok: true, admin: false, project };
}

module.exports = { hashKey, adminKey, loadProjects, createProject, resolveAuth, registryPath };
