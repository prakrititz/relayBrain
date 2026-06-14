const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const REGISTRY_DIR = path.join(os.homedir(), '.relay-os');
const REGISTRY_PATH = path.join(REGISTRY_DIR, 'projects.json');

function ensureRegistryDir() {
  if (!fs.existsSync(REGISTRY_DIR)) fs.mkdirSync(REGISTRY_DIR, { recursive: true });
}

function loadRegistry() {
  ensureRegistryDir();
  if (!fs.existsSync(REGISTRY_PATH)) {
    return { version: 1, projects: [] };
  }
  try {
    return JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf-8'));
  } catch (_) {
    return { version: 1, projects: [] };
  }
}

function saveRegistry(registry) {
  ensureRegistryDir();
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2), 'utf-8');
}

function generateId() {
  return crypto.randomBytes(8).toString('hex');
}

function generateApiKey() {
  return `relay_${crypto.randomBytes(24).toString('hex')}`;
}

function defaultProjectName(workspacePath) {
  return path.basename(path.resolve(workspacePath)) || 'Untitled project';
}

function writeProjectManifest(workspacePath, project) {
  const relayDir = path.join(path.resolve(workspacePath), '.relay');
  if (!fs.existsSync(relayDir)) fs.mkdirSync(relayDir, { recursive: true });

  const uiPort = Number(process.env.RELAY_UI_PORT) || 6374;
  const manifest = {
    id: project.id,
    name: project.name,
    apiKey: project.apiKey,
    workspacePath: path.resolve(workspacePath),
    dashboardUrl: `http://localhost:${uiPort}/?project=${project.id}`,
    setupUrl: `http://localhost:${uiPort}/?setup=${project.id}`,
    updatedAt: new Date().toISOString(),
  };

  fs.writeFileSync(
    path.join(relayDir, 'project.json'),
    JSON.stringify(manifest, null, 2),
    'utf-8'
  );
  return manifest;
}

function readProjectManifest(workspacePath) {
  const manifestPath = path.join(path.resolve(workspacePath), '.relay', 'project.json');
  if (!fs.existsSync(manifestPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  } catch (_) {
    return null;
  }
}

function getProjectStats(workspacePath) {
  const memoryPath = path.join(path.resolve(workspacePath), '.relay', 'memory.json');
  if (!fs.existsSync(memoryPath)) {
    return { totalEvents: 0, lastSync: null, connectedAgents: 0 };
  }
  try {
    const memory = JSON.parse(fs.readFileSync(memoryPath, 'utf-8'));
    const timeline = Array.isArray(memory.timeline) ? memory.timeline : [];
    const connectedAgents = Object.values(memory.agents || {}).filter(
      (a) => a.status === 'connected'
    ).length;
    return {
      totalEvents: timeline.length,
      lastSync: memory.lastSync || null,
      connectedAgents,
    };
  } catch (_) {
    return { totalEvents: 0, lastSync: null, connectedAgents: 0 };
  }
}

function enrichProject(project, { includeApiKey = false } = {}) {
  const stats = getProjectStats(project.workspacePath);
  const base = {
    id: project.id,
    name: project.name,
    workspacePath: project.workspacePath,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    stats,
  };
  if (includeApiKey) base.apiKey = project.apiKey;
  return base;
}

function registerProject(workspacePath, options = {}) {
  const resolved = path.resolve(workspacePath);
  const registry = loadRegistry();
  let project = registry.projects.find((p) => p.workspacePath === resolved);

  if (project) {
    if (options.name && options.name !== project.name) {
      project.name = options.name.trim();
      project.updatedAt = new Date().toISOString();
    }
  } else {
    project = {
      id: generateId(),
      name: (options.name || defaultProjectName(resolved)).trim(),
      workspacePath: resolved,
      apiKey: generateApiKey(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    registry.projects.push(project);
  }

  saveRegistry(registry);
  const manifest = writeProjectManifest(resolved, project);
  return { project: enrichProject(project, { includeApiKey: true }), manifest };
}

function listProjects(options = {}) {
  const registry = loadRegistry();
  return registry.projects
    .map((p) => enrichProject(p, { includeApiKey: options.includeApiKey }))
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
}

function getProject(projectId, options = {}) {
  const registry = loadRegistry();
  const project = registry.projects.find((p) => p.id === projectId);
  if (!project) return null;
  return enrichProject(project, { includeApiKey: options.includeApiKey });
}

function getProjectByWorkspace(workspacePath, options = {}) {
  const resolved = path.resolve(workspacePath);
  const registry = loadRegistry();
  const project = registry.projects.find((p) => p.workspacePath === resolved);
  if (!project) return null;
  return enrichProject(project, { includeApiKey: options.includeApiKey });
}

function getProjectByApiKey(apiKey) {
  if (!apiKey) return null;
  const registry = loadRegistry();
  const project = registry.projects.find((p) => p.apiKey === apiKey);
  if (!project) return null;
  return enrichProject(project, { includeApiKey: true });
}

function updateProjectName(projectId, name) {
  const registry = loadRegistry();
  const project = registry.projects.find((p) => p.id === projectId);
  if (!project) throw new Error('Project not found');
  project.name = String(name || '').trim() || defaultProjectName(project.workspacePath);
  project.updatedAt = new Date().toISOString();
  saveRegistry(registry);
  writeProjectManifest(project.workspacePath, project);
  return enrichProject(project, { includeApiKey: true });
}

function resolveProjectWorkspace(projectId) {
  const project = getProject(projectId);
  if (!project) throw new Error('Project not found');
  return project.workspacePath;
}

function syncFromManifest(workspacePath) {
  const manifest = readProjectManifest(workspacePath);
  if (!manifest || !manifest.id || !manifest.apiKey) return null;

  const registry = loadRegistry();
  let project = registry.projects.find((p) => p.id === manifest.id);

  if (!project) {
    project = {
      id: manifest.id,
      name: manifest.name || defaultProjectName(workspacePath),
      workspacePath: path.resolve(workspacePath),
      apiKey: manifest.apiKey,
      createdAt: manifest.updatedAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    registry.projects.push(project);
  } else {
    project.name = manifest.name || project.name;
    project.apiKey = manifest.apiKey;
    project.workspacePath = path.resolve(workspacePath);
    project.updatedAt = new Date().toISOString();
  }

  saveRegistry(registry);
  return enrichProject(project, { includeApiKey: true });
}

module.exports = {
  REGISTRY_PATH,
  registerProject,
  listProjects,
  getProject,
  getProjectByWorkspace,
  getProjectByApiKey,
  updateProjectName,
  resolveProjectWorkspace,
  syncFromManifest,
  writeProjectManifest,
  readProjectManifest,
  getProjectStats,
};
