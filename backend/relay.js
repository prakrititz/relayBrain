const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync, execSync } = require('child_process');
const { parseAntigravity } = require('./parsers/antigravity');
const { parseCodex } = require('./parsers/codex');
const { parseClaude } = require('./parsers/claude');
const { parseCopilot } = require('./parsers/copilot');

const HOME = os.homedir();

// ─── KNOWN AGENT STORAGE ROOTS ────────────────────────────────────────────────
const AGENT_ROOTS = {
  Antigravity: path.join(HOME, '.gemini', 'antigravity-ide', 'brain'),
  Codex: path.join(HOME, '.codex', 'sessions'),
  'Claude Code': path.join(HOME, '.claude', 'projects'),
  'GitHub Copilot': path.join(HOME, '.copilot', 'session-state'),
};

// ─── RELAY DIRECTORY HELPERS ──────────────────────────────────────────────────
function getRelayDir(workspacePath) {
  return path.join(workspacePath, '.relay');
}
function getConfigPath(workspacePath) {
  return path.join(getRelayDir(workspacePath), 'config.json');
}
function getMemoryPath(workspacePath) {
  return path.join(getRelayDir(workspacePath), 'memory.json');
}

// ─── REGISTER WORKSPACE ───────────────────────────────────────────────────────
function registerWorkspace(workspacePath) {
  const relayDir = getRelayDir(workspacePath);
  if (!fs.existsSync(relayDir)) fs.mkdirSync(relayDir, { recursive: true });

  const configPath = getConfigPath(workspacePath);
  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, JSON.stringify({
      workspace: workspacePath,
      registeredAt: new Date().toISOString(),
      agents: {},
    }, null, 2));
  }

  const memoryPath = getMemoryPath(workspacePath);
  if (!fs.existsSync(memoryPath)) {
    fs.writeFileSync(memoryPath, JSON.stringify({
      workspace: workspacePath,
      lastSync: null,
      agents: {},
    }, null, 2));
  }

  return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
}

// ─── DETECT CODEX CLI ─────────────────────────────────────────────────────────
// Returns the path to the codex binary, or null if not found (extension-only mode).
function detectCodexCli() {
  // 1. Check if `codex` is available in PATH
  try {
    const result = spawnSync('codex', ['--version'], { shell: true, timeout: 3000, encoding: 'utf-8' });
    if (result.status === 0) return 'codex';
  } catch (_) { }

  // 2. Check common npm global paths
  const npmGlobalBins = [
    path.join(HOME, 'AppData', 'Roaming', 'npm', 'codex.cmd'),
    path.join(HOME, 'AppData', 'Roaming', 'npm', 'codex'),
    '/usr/local/bin/codex',
    '/usr/bin/codex',
  ];
  for (const p of npmGlobalBins) {
    if (fs.existsSync(p)) return p;
  }

  // 3. Try npx as a last resort
  try {
    const r = spawnSync('npx', ['codex', '--version'], { shell: true, timeout: 5000, encoding: 'utf-8' });
    if (r.status === 0) return 'npx codex';
  } catch (_) { }

  return null; // Extension-only mode
}

// ─── GENERATE & SEND HANDSHAKE TOKEN ─────────────────────────────────────────
function sendHandshake(workspacePath, agent) {
  const safeAgent = agent.toUpperCase().replace(/ /g, '_');
  const token = `RELAY_INIT_HANDSHAKE_${safeAgent}_${Math.random().toString(36).substring(2, 8).toUpperCase()}`;

  // Persist pending token to config
  const configPath = getConfigPath(workspacePath);
  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  if (!config.agents[agent]) config.agents[agent] = {};
  config.agents[agent].pendingToken = token;
  config.agents[agent].status = 'handshaking';

  let mode = 'unknown';

  if (agent === 'Antigravity') {
    // Antigravity IS this process. Write token to a beacon file.
    // Discovery will use most-recent-transcript fallback since this process is Antigravity.
    fs.writeFileSync(path.join(getRelayDir(workspacePath), '.handshake_antigravity'), token);
    mode = 'beacon-file';
    console.log(`[Antigravity] Beacon written. Token: ${token}`);

  } else if (agent === 'Codex') {
    const codexBin = detectCodexCli();

    if (codexBin) {
      // ── CLI MODE: spawn codex with token as a one-shot prompt ──
      console.log(`[Codex] CLI found at: ${codexBin}. Sending token via CLI...`);
      const cmd = codexBin.startsWith('npx') ? 'npx' : codexBin;
      const args = codexBin.startsWith('npx') ? ['codex', '-q', token] : ['-q', token];
      const result = spawnSync(cmd, args, {
        cwd: workspacePath,
        timeout: 20000,
        encoding: 'utf-8',
        shell: true,
      });
      mode = 'cli';
      console.log(`[Codex CLI] stdout: ${result.stdout}`);
      console.log(`[Codex CLI] stderr: ${result.stderr}`);
      if (result.error) console.error(`[Codex CLI] spawn error: ${result.error.message}`);
    } else {
      // ── EXTENSION MODE: no CLI, discover by workspace cwd matching ──
      // Write the token to a beacon file for reference.
      fs.writeFileSync(path.join(getRelayDir(workspacePath), '.handshake_codex'), token);
      mode = 'extension-cwd-match';
      console.log(`[Codex] No CLI found. Using extension mode (cwd match). Token: ${token}`);
    }

    config.agents[agent].codexMode = mode;

  } else if (agent === 'Claude Code') {
    // Claude Code has a real CLI
    const result = spawnSync('claude', ['--print', token], {
      cwd: workspacePath,
      timeout: 20000,
      encoding: 'utf-8',
      shell: true,
    });
    mode = 'cli';
    console.log(`[Claude Code] stdout: ${result.stdout}`);
    if (result.error) console.error(`[Claude Code] spawn error: ${result.error.message}`);

  } else if (agent === 'GitHub Copilot') {
    fs.writeFileSync(path.join(getRelayDir(workspacePath), '.handshake_copilot'), token);
    mode = 'workspace-cwd-match';
    console.log(`[GitHub Copilot] Beacon written. Token: ${token}`);
    config.agents[agent].copilotMode = mode;
  }

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  return token;
}

// ─── FILE UTILITIES ───────────────────────────────────────────────────────────
function findJsonlFiles(dir, results = []) {
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) findJsonlFiles(full, results);
    else if (entry.name.endsWith('.jsonl')) results.push(full);
  }
  return results;
}

function mostRecentFile(files) {
  if (!files.length) return null;
  return [...files].sort((a, b) => {
    try { return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs; } catch { return 0; }
  })[0];
}

// ─── DISCOVERY STRATEGIES ─────────────────────────────────────────────────────

// Strategy 1: grep all files for the unique token (works for any agent with CLI)
function discoverByToken(agent, token) {
  const root = AGENT_ROOTS[agent];
  if (!root || !fs.existsSync(root)) return null;
  const files = findJsonlFiles(root);
  for (const file of files) {
    try {
      if (fs.readFileSync(file, 'utf-8').includes(token)) return file;
    } catch (_) { }
  }
  return null;
}

// Strategy 2 (Codex extension): match session_meta.cwd to registered workspace
function discoverCodexByWorkspaceCwd(workspacePath) {
  const root = AGENT_ROOTS['Codex'];
  if (!fs.existsSync(root)) return null;

  const normalize = (p) => p.toLowerCase().replace(/\\/g, '/').replace(/\/$/, '');
  const targetCwd = normalize(workspacePath);

  const files = findJsonlFiles(root);
  const matched = [];

  for (const file of files) {
    try {
      const firstLine = fs.readFileSync(file, 'utf-8').split('\n')[0];
      const meta = JSON.parse(firstLine);
      if (meta.type === 'session_meta' && meta.payload?.cwd) {
        if (normalize(meta.payload.cwd) === targetCwd) {
          matched.push(file);
        }
      }
    } catch (_) { }
  }

  if (matched.length > 0) {
    const best = mostRecentFile(matched);
    console.log(`[Codex] Found ${matched.length} session(s) matching workspace cwd. Using: ${best}`);
    return best;
  }

  // Last resort: just grab the most recent session
  console.warn('[Codex] No cwd match found. Falling back to most recent session file.');
  return mostRecentFile(files);
}

// Strategy 4 (GitHub Copilot): match session.start context cwd to registered workspace
function discoverCopilotByWorkspaceCwd(workspacePath) {
  const root = AGENT_ROOTS['GitHub Copilot'];
  if (!fs.existsSync(root)) return null;

  const normalize = (p) => String(p || '').toLowerCase().replace(/\\/g, '/').replace(/\/$/, '');
  const targetCwd = normalize(workspacePath);

  const files = findJsonlFiles(root);
  const matched = [];

  for (const file of files) {
    try {
      const firstLine = fs.readFileSync(file, 'utf-8').split('\n')[0];
      const meta = JSON.parse(firstLine);
      if (meta.type === 'session.start') {
        const cwd = meta.data?.context?.cwd || meta.data?.context?.workspaceFolder?.folderPath;
        if (normalize(cwd) === targetCwd) {
          matched.push(file);
        }
      }
    } catch (_) { }
  }

  if (matched.length > 0) {
    const best = mostRecentFile(matched);
    console.log(`[GitHub Copilot] Found ${matched.length} session(s) matching workspace cwd. Using: ${best}`);
    return best;
  }

  console.warn('[GitHub Copilot] No cwd match found. Falling back to most recent session file.');
  return mostRecentFile(files);
}

// Strategy 3 (Antigravity): use most-recent transcript from brain directory
function discoverAntigravityMostRecent() {
  const root = AGENT_ROOTS['Antigravity'];
  const files = findJsonlFiles(root);
  // Filter to only actual transcript.jsonl files
  const transcripts = files.filter(f => f.endsWith('transcript.jsonl'));
  return mostRecentFile(transcripts.length > 0 ? transcripts : files);
}

// ─── CONNECT AGENT: DISCOVER + PARSE + WRITE MEMORY ─────────────────────────
function connectAgent(workspacePath, agent) {
  const configPath = getConfigPath(workspacePath);
  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  const agentConfig = config.agents[agent] || {};
  const token = agentConfig.pendingToken;

  if (!token) {
    throw new Error(`No pending handshake for ${agent}. Call /api/handshake first.`);
  }

  let transcriptPath = null;

  if (agent === 'Antigravity') {
    // First try to find the token in our own transcripts
    transcriptPath = discoverByToken('Antigravity', token);
    // Fallback: most recent Antigravity transcript (we ARE Antigravity)
    if (!transcriptPath) transcriptPath = discoverAntigravityMostRecent();

  } else if (agent === 'Codex') {
    const codexMode = agentConfig.codexMode;

    if (codexMode === 'cli') {
      // CLI mode: grep for token (the CLI wrote it to a session file)
      transcriptPath = discoverByToken('Codex', token);
    }

    if (!transcriptPath) {
      // Extension mode OR CLI fallback: match by workspace cwd
      transcriptPath = discoverCodexByWorkspaceCwd(workspacePath);
    }

  } else if (agent === 'Claude Code') {
    // CLI was used — grep for token
    transcriptPath = discoverByToken('Claude Code', token);
  } else if (agent === 'GitHub Copilot') {
    transcriptPath = discoverCopilotByWorkspaceCwd(workspacePath);
  }

  if (!transcriptPath) {
    throw new Error(
      `Could not discover ${agent} transcript. ` +
      (agent === 'Codex'
        ? 'Make sure Codex is open in this workspace in VS Code.'
        : agent === 'GitHub Copilot'
          ? 'Make sure Copilot is open in this workspace in VS Code.'
          : 'The CLI may not have written a session yet.')
    );
  }

  // Parse transcript into unified Relay events
  let events = [];
  try {
    if (agent === 'Antigravity') events = parseAntigravity(transcriptPath);
    else if (agent === 'Codex') events = parseCodex(transcriptPath);
    else if (agent === 'Claude Code') events = parseClaude(transcriptPath);
    else if (agent === 'GitHub Copilot') events = parseCopilot(transcriptPath);
  } catch (err) {
    console.error(`[${agent}] Parse error:`, err.message);
  }

  // Update config
  config.agents[agent] = {
    status: 'connected',
    transcriptPath,
    connectedAt: new Date().toISOString(),
    pendingToken: null,
    codexMode: agentConfig.codexMode || null,
    copilotMode: agentConfig.copilotMode || null,
  };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

  // Write normalized memory
  const memoryPath = getMemoryPath(workspacePath);
  const memory = JSON.parse(fs.readFileSync(memoryPath, 'utf-8'));
  memory.lastSync = new Date().toISOString();
  if (!memory.agents) memory.agents = {};
  memory.agents[agent] = {
    status: 'connected',
    transcriptPath,
    eventCount: events.length,
    events: events.slice(-50),
  };
  fs.writeFileSync(memoryPath, JSON.stringify(memory, null, 2));

  return { transcriptPath, eventCount: events.length, events: events.slice(-20) };
}

// ─── SYNC WORKSPACE: re-read all connected transcripts and rebuild memory ─────
function syncWorkspace(workspacePath) {
  const configPath = getConfigPath(workspacePath);
  const memoryPath = getMemoryPath(workspacePath);
  if (!fs.existsSync(configPath)) throw new Error('Workspace not registered.');

  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  const memory = fs.existsSync(memoryPath)
    ? JSON.parse(fs.readFileSync(memoryPath, 'utf-8'))
    : { workspace: workspacePath, agents: {} };

  let totalEvents = 0;

  for (const [agent, agentConfig] of Object.entries(config.agents)) {
    if (agentConfig.status !== 'connected' || !agentConfig.transcriptPath) continue;
    const transcriptPath = agentConfig.transcriptPath;
    if (!fs.existsSync(transcriptPath)) {
      console.warn(`[Sync] ${agent} transcript not found: ${transcriptPath}`);
      continue;
    }

    try {
      let parsedData = [];
      if (agent === 'Antigravity') parsedData = parseAntigravity(transcriptPath);
      else if (agent === 'Codex') parsedData = parseCodex(transcriptPath);
      else if (agent === 'Claude Code') parsedData = parseClaude(transcriptPath);
      else if (agent === 'GitHub Copilot') parsedData = parseCopilot(transcriptPath);

      // Handle legacy Array return (just events) vs new Object return (events, artifacts, tasks, messages)
      const events = Array.isArray(parsedData) ? parsedData : (parsedData.events || []);
      const artifacts = Array.isArray(parsedData) ? [] : (parsedData.artifacts || []);
      const tasks = Array.isArray(parsedData) ? [] : (parsedData.tasks || []);
      const messages = Array.isArray(parsedData) ? [] : (parsedData.messages || []);

      if (!memory.agents) memory.agents = {};
      memory.agents[agent] = {
        status: 'connected',
        transcriptPath,
        eventCount: events.length,
        events: events.slice(-100), // keep last 100 events
        artifacts: artifacts,
        tasks: tasks.slice(-50), // keep last 50 background tasks
        messages: messages.slice(-50), // keep last 50 internal messages
      };
      totalEvents += events.length;
      console.log(`[Sync] ${agent}: ${events.length} events, ${artifacts.length} artifacts, ${tasks.length} tasks, ${messages.length} msgs`);
    } catch (err) {
      console.error(`[Sync] ${agent} parse error: ${err.message}`);
    }
  }

  memory.lastSync = new Date().toISOString();
  fs.writeFileSync(memoryPath, JSON.stringify(memory, null, 2));
  return { totalEvents, lastSync: memory.lastSync, agents: Object.keys(config.agents) };
}

// ─── FILE WATCHER: auto-sync when any transcript changes on disk ──────────────
const activeWatchers = new Map();

function startWatcher(workspacePath) {
  // Stop any existing watcher for this workspace
  if (activeWatchers.has(workspacePath)) {
    activeWatchers.get(workspacePath).forEach(w => w.close());
  }

  const configPath = getConfigPath(workspacePath);
  if (!fs.existsSync(configPath)) return;

  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  const watchers = [];

  for (const [agent, agentConfig] of Object.entries(config.agents)) {
    if (agentConfig.status !== 'connected' || !agentConfig.transcriptPath) continue;
    const transcriptPath = agentConfig.transcriptPath;
    if (!fs.existsSync(transcriptPath)) continue;

    let debounceTimer = null;
    const watcher = fs.watch(transcriptPath, () => {
      // Debounce: wait 500ms after last change before syncing
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        console.log(`[Watcher] ${agent} transcript changed — auto-syncing...`);
        try { syncWorkspace(workspacePath); } catch (err) {
          console.error(`[Watcher] sync error: ${err.message}`);
        }
      }, 500);
    });

    watchers.push(watcher);
    console.log(`[Watcher] Watching ${agent} transcript: ${transcriptPath}`);
  }

  activeWatchers.set(workspacePath, watchers);
  return watchers.length;
}

// ─── GET MEMORY (always returns fresh data from disk) ────────────────────────
function getMemory(workspacePath) {
  const memoryPath = getMemoryPath(workspacePath);
  if (!fs.existsSync(memoryPath)) {
    throw new Error('Workspace not registered. Call /api/register first.');
  }
  return JSON.parse(fs.readFileSync(memoryPath, 'utf-8'));
}

module.exports = { registerWorkspace, sendHandshake, connectAgent, syncWorkspace, startWatcher, getMemory };
