const path = require('path');
const express = require('express');
const cors = require('cors');
const {
  registerWorkspace,
  sendHandshake,
  connectAgent,
  syncWorkspace,
  startWatcher,
  getMemory,
  getRelayContext,
  getCompileBrief,
} = require('./relay');
const { buildDashboard } = require('./lib/relayDashboard');
const { listRelayFiles, readRelayFile, writeRelayFile } = require('./lib/relayStore');
const { readMissionMeta, writeMissionMeta } = require('./lib/relayMeta');
const { requireApiKey, isAuthEnabled } = require('./lib/relayAuth');
const {
  registerProject,
  listProjects,
  getProject,
  updateProjectName,
  resolveProjectWorkspace,
  syncFromManifest,
} = require('./lib/relayProjects');

const PACKAGE_ROOT = path.join(__dirname, '..');
const UI_ROOT = path.join(PACKAGE_ROOT, 'basic_frontend');

function resolveWorkspaceFromRequest(req) {
  if (req.query.projectId) return resolveProjectWorkspace(req.query.projectId);
  if (req.body?.projectId) return resolveProjectWorkspace(req.body.projectId);
  const wp = req.query.workspacePath || req.body?.workspacePath;
  if (wp) return path.resolve(wp);
  throw new Error('projectId or workspacePath is required');
}

function createApp() {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '2mb' }));

  app.use(express.static(UI_ROOT));

  app.get('/', (_req, res) => {
    res.sendFile(path.join(UI_ROOT, 'index.html'));
  });

  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      authRequired: isAuthEnabled(),
      version: require('../package.json').version,
    });
  });

  app.get('/api/projects', (_req, res) => {
    try {
      const projects = listProjects();
      res.json({ ok: true, projects });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/projects', (req, res) => {
    const { workspacePath, name } = req.body;
    if (!workspacePath) return res.status(400).json({ error: 'workspacePath is required' });
    try {
      registerWorkspace(workspacePath);
      startWatcher(workspacePath);
      getRelayContext(workspacePath);
      const { project } = registerProject(workspacePath, { name });
      res.json({ ok: true, project });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/projects/:id', (req, res) => {
    try {
      const project = getProject(req.params.id, { includeApiKey: true });
      if (!project) return res.status(404).json({ error: 'Project not found' });
      res.json({ ok: true, project });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.patch('/api/projects/:id', (req, res) => {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    try {
      const project = updateProjectName(req.params.id, name);
      res.json({ ok: true, project });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/projects/:id/sync', (req, res) => {
    try {
      const workspacePath = resolveProjectWorkspace(req.params.id);
      const result = syncWorkspace(workspacePath);
      getRelayContext(workspacePath);
      const project = getProject(req.params.id, { includeApiKey: false });
      res.json({ ok: true, ...result, project });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/projects/:id/dashboard', (req, res) => {
    const { limit, offset, kind, source, role } = req.query;
    try {
      const workspacePath = resolveProjectWorkspace(req.params.id);
      const project = getProject(req.params.id, { includeApiKey: true });
      const dashboard = buildDashboard(workspacePath, {
        limit: limit ? Number(limit) : 40,
        offset: offset ? Number(offset) : 0,
        kind,
        source,
        role,
      });
      res.json({ ok: true, project, dashboard });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/register', (req, res) => {
    const { workspacePath, name } = req.body;
    if (!workspacePath) return res.status(400).json({ error: 'workspacePath is required' });
    try {
      registerWorkspace(workspacePath);
      startWatcher(workspacePath);
      getRelayContext(workspacePath);
      const { project } = registerProject(workspacePath, { name });
      res.json({ ok: true, project });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/handshake', (req, res) => {
    const { agent } = req.body;
    if (!agent) return res.status(400).json({ error: 'agent is required' });
    try {
      const workspacePath = resolveWorkspaceFromRequest(req);
      const token = sendHandshake(workspacePath, agent);
      res.json({ ok: true, token, message: `Handshake token sent to ${agent} automatically.` });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/connect', (req, res) => {
    const { agent } = req.body;
    if (!agent) return res.status(400).json({ error: 'agent is required' });
    try {
      const workspacePath = resolveWorkspaceFromRequest(req);
      const result = connectAgent(workspacePath, agent);
      startWatcher(workspacePath);
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/sync', (req, res) => {
    try {
      const workspacePath = resolveWorkspaceFromRequest(req);
      const result = syncWorkspace(workspacePath);
      getRelayContext(workspacePath);
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/memory', (req, res) => {
    try {
      const workspacePath = resolveWorkspaceFromRequest(req);
      const memory = getMemory(workspacePath);
      res.json({ ok: true, memory });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/dashboard', (req, res) => {
    const { limit, offset, kind, source, role, projectId } = req.query;
    try {
      const workspacePath = projectId
        ? resolveProjectWorkspace(projectId)
        : resolveWorkspaceFromRequest(req);
      const dashboard = buildDashboard(workspacePath, {
        limit: limit ? Number(limit) : 40,
        offset: offset ? Number(offset) : 0,
        kind,
        source,
        role,
      });
      res.json({ ok: true, dashboard });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/context', (req, res) => {
    try {
      const workspacePath = resolveWorkspaceFromRequest(req);
      const result = getRelayContext(workspacePath);
      res.json({ ok: true, context: result.context, markdown: result.markdown });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/compile', (req, res) => {
    try {
      const workspacePath = resolveWorkspaceFromRequest(req);
      const result = getCompileBrief(workspacePath);
      res.json({ ok: true, brief: result.brief, markdown: result.markdown });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/mission-meta', (req, res) => {
    try {
      const workspacePath = resolveWorkspaceFromRequest(req);
      const meta = readMissionMeta(workspacePath);
      res.json({ ok: true, meta });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put('/api/mission-meta', (req, res) => {
    try {
      const workspacePath = resolveWorkspaceFromRequest(req);
      const meta = writeMissionMeta(workspacePath, req.body || {});
      res.json({ ok: true, meta });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/relay/files', requireApiKey, (req, res) => {
    const { path: subPath } = req.query;
    try {
      const workspacePath = req.relayProject
        ? req.relayProject.workspacePath
        : resolveWorkspaceFromRequest(req);
      const listing = listRelayFiles(workspacePath, subPath || '');
      res.json({ ok: true, ...listing });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/relay/file', requireApiKey, (req, res) => {
    const { path: filePath } = req.query;
    if (!filePath) return res.status(400).json({ error: 'path is required' });
    try {
      const workspacePath = req.relayProject
        ? req.relayProject.workspacePath
        : resolveWorkspaceFromRequest(req);
      const file = readRelayFile(workspacePath, filePath);
      res.json({ ok: true, file });
    } catch (err) {
      res.status(404).json({ error: err.message });
    }
  });

  app.put('/api/relay/file', requireApiKey, (req, res) => {
    const { path: filePath, content } = req.body;
    if (!filePath || content === undefined) {
      return res.status(400).json({ error: 'path and content are required' });
    }
    try {
      const workspacePath = req.relayProject
        ? req.relayProject.workspacePath
        : resolveWorkspaceFromRequest(req);
      const file = writeRelayFile(workspacePath, filePath, content);
      res.json({ ok: true, file });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return app;
}

function startServer(options = {}) {
  const PORT = options.port || Number(process.env.RELAY_PORT) || 3001;
  const uiPort = Number(process.env.RELAY_UI_PORT) || 6374;
  const app = createApp();

  return app.listen(PORT, () => {
    console.log('');
    console.log(`🔗 Relay API at http://localhost:${PORT}/api/health`);
    console.log(`   Mission Control: http://localhost:${uiPort}/  (started by relay serve)`);
    if (isAuthEnabled()) console.log('   Global API key auth enabled (RELAY_API_KEY)');
    console.log('');
  });
}

if (require.main === module) {
  startServer();
}

module.exports = { createApp, startServer, syncFromManifest, registerProject };
