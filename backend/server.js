const express = require('express');
const cors = require('cors');
const { registerWorkspace, sendHandshake, connectAgent, syncWorkspace, startWatcher, getMemory } = require('./relay');

const app = express();
app.use(cors());
app.use(express.json());

// ─── REGISTER WORKSPACE ───────────────────────────────────────────────────────
app.post('/api/register', (req, res) => {
  const { workspacePath } = req.body;
  if (!workspacePath) return res.status(400).json({ error: 'workspacePath is required' });
  try {
    const config = registerWorkspace(workspacePath);
    res.json({ ok: true, config });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── SEND HANDSHAKE ───────────────────────────────────────────────────────────
app.post('/api/handshake', (req, res) => {
  const { workspacePath, agent } = req.body;
  if (!workspacePath || !agent) return res.status(400).json({ error: 'workspacePath and agent are required' });
  try {
    const token = sendHandshake(workspacePath, agent);
    res.json({ ok: true, token, message: `Handshake token sent to ${agent} automatically.` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── CONNECT AGENT ────────────────────────────────────────────────────────────
// Discovers transcript, parses it, writes memory, then starts a file watcher.
app.post('/api/connect', (req, res) => {
  const { workspacePath, agent } = req.body;
  if (!workspacePath || !agent) return res.status(400).json({ error: 'workspacePath and agent are required' });
  try {
    const result = connectAgent(workspacePath, agent);
    // Start file watcher so any new events auto-sync
    startWatcher(workspacePath);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── MANUAL SYNC ─────────────────────────────────────────────────────────────
// Re-reads ALL connected transcripts and rebuilds memory.json from scratch.
app.post('/api/sync', (req, res) => {
  const { workspacePath } = req.body;
  if (!workspacePath) return res.status(400).json({ error: 'workspacePath is required' });
  try {
    const result = syncWorkspace(workspacePath);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET MEMORY ───────────────────────────────────────────────────────────────
// Returns the current memory.json — always fresh since file watchers keep it updated.
app.get('/api/memory', (req, res) => {
  const { workspacePath } = req.query;
  if (!workspacePath) return res.status(400).json({ error: 'workspacePath is required' });
  try {
    const memory = getMemory(workspacePath);
    res.json({ ok: true, memory });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── START ────────────────────────────────────────────────────────────────────
const PORT = 3001;
app.listen(PORT, () => {
  console.log(`\n🔗 Relay Backend running at http://localhost:${PORT}\n`);
});
