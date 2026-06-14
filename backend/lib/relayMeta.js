const fs = require('fs');
const path = require('path');
const { getRelayDir } = require('./relayStore');

const META_FILE = 'mission_control.json';

function defaultMeta() {
  return {
    version: 1,
    collaborators: [],
    chat: [],
    updatedAt: new Date().toISOString(),
  };
}

function readMissionMeta(workspacePath) {
  const filePath = path.join(getRelayDir(workspacePath), META_FILE);
  if (!fs.existsSync(filePath)) return defaultMeta();
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    return {
      ...defaultMeta(),
      ...parsed,
      collaborators: Array.isArray(parsed.collaborators) ? parsed.collaborators : [],
      chat: Array.isArray(parsed.chat) ? parsed.chat : [],
    };
  } catch (_) {
    return defaultMeta();
  }
}

function writeMissionMeta(workspacePath, meta) {
  const relayDir = getRelayDir(workspacePath);
  if (!fs.existsSync(relayDir)) fs.mkdirSync(relayDir, { recursive: true });

  const payload = {
    version: 1,
    collaborators: Array.isArray(meta.collaborators) ? meta.collaborators : [],
    chat: Array.isArray(meta.chat) ? meta.chat : [],
    updatedAt: new Date().toISOString(),
  };

  fs.writeFileSync(path.join(relayDir, META_FILE), JSON.stringify(payload, null, 2), 'utf-8');
  return payload;
}

function scaffoldMissionMeta(workspacePath) {
  const relayDir = getRelayDir(workspacePath);
  const filePath = path.join(relayDir, META_FILE);
  if (!fs.existsSync(filePath)) {
    writeMissionMeta(workspacePath, defaultMeta());
  }
}

module.exports = {
  META_FILE,
  readMissionMeta,
  writeMissionMeta,
  scaffoldMissionMeta,
};
