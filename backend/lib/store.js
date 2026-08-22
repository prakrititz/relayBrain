const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { dataDir, registryPath, sessionPath } = require("./paths");

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function id(prefix = "id") {
  return `${prefix}_${crypto.randomBytes(6).toString("hex")}`;
}

function loadRegistry() {
  return readJson(registryPath(), { projects: [], users: [] });
}

function saveRegistry(reg) {
  writeJson(registryPath(), reg);
}

function loadSession() {
  return readJson(sessionPath(), { userId: null });
}

function saveSession(session) {
  writeJson(sessionPath(), session);
}

function projectDir(projectId) {
  const dir = path.join(dataDir(), "projects", projectId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function memoryPath(projectId) {
  return path.join(projectDir(projectId), "memory.json");
}

function loadMemory(projectId) {
  return readJson(memoryPath(projectId), {
    history: [],
    timeline: [],
    chats: [],
    edits: [],
    ir: {},
    agents: [],
    collaborators: [],
    activity: [],
  });
}

function saveMemory(projectId, memory) {
  writeJson(memoryPath(projectId), memory);
}

module.exports = {
  readJson,
  writeJson,
  id,
  loadRegistry,
  saveRegistry,
  loadSession,
  saveSession,
  projectDir,
  memoryPath,
  loadMemory,
  saveMemory,
  dataDir,
};
