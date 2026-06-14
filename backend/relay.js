const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const { parseAntigravity, getBrainDir } = require('./parsers/antigravity');
const { parseCodex } = require('./parsers/codex');
const { parseClaude } = require('./parsers/claude');
const { parseCopilot } = require('./parsers/copilot');
const { parseCursor, discoverCursorTranscriptDir } = require('./parsers/cursor');
const { discoverWorkspaceStorageDir } = require('./lib/vscodeWorkspace');
const { readVscdbJson } = require('./lib/vscdb');
const { buildGlobalTimeline } = require('./lib/timeline');
const { scaffoldIrFiles, writeRelayContext, writeCompileBrief } = require('./lib/relayContext');
const { compileIrSync } = require('./lib/relayCompileIr');
const { installRelayWorkspace, isRelayInstalled, writeAgentBootstrap } = require('./lib/relayInstall');

const HOME = os.homedir();

const AGENT_ROOTS = {
  Antigravity: path.join(HOME, '.gemini', 'antigravity-ide', 'brain'),
  Codex: path.join(HOME, '.codex', 'sessions'),
  'Claude Code': path.join(HOME, '.claude', 'projects'),
};

const COPILOT_DISCOVERY_ROOTS = [
  path.join(HOME, '.copilot', 'session-state'),
  path.join(HOME, 'AppData', 'Roaming', 'Code', 'User', 'workspaceStorage'),
  path.join(HOME, 'AppData', 'Roaming', 'Code', 'User', 'globalStorage', 'github.copilot-chat'),
  path.join(HOME, '.config', 'Code', 'User', 'workspaceStorage'),
  path.join(HOME, '.config', 'Code', 'User', 'globalStorage', 'github.copilot-chat'),
];

const ANTIGRAVITY_WS_ROOTS = [
  path.join(HOME, 'AppData', 'Roaming', 'Antigravity IDE', 'User', 'workspaceStorage'),
];

function getRelayDir(workspacePath) {
  return path.join(workspacePath, '.relay');
}
function getConfigPath(workspacePath) {
  return path.join(getRelayDir(workspacePath), 'config.json');
}
function getMemoryPath(workspacePath) {
  return path.join(getRelayDir(workspacePath), 'memory.json');
}

function safeReadJson(filePath, fallback) {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8').trim();
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch (_) {
    return fallback;
  }
}

function registerWorkspace(workspacePath) {
  const relayDir = getRelayDir(workspacePath);
  if (!fs.existsSync(relayDir)) fs.mkdirSync(relayDir, { recursive: true });

  const configPath = getConfigPath(workspacePath);
  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, JSON.stringify({
      workspace: workspacePath,
      registeredAt: new Date().toISOString(),
      autoUpdate: true,
      autoAgentUpdate: true,
      agents: {},
    }, null, 2));
  }

  const memoryPath = getMemoryPath(workspacePath);
  if (!fs.existsSync(memoryPath)) {
    fs.writeFileSync(memoryPath, JSON.stringify({
      workspace: workspacePath,
      lastSync: null,
      agents: {},
      timeline: [],
    }, null, 2));
  }

  installRelayWorkspace(workspacePath, { packageRoot: path.join(__dirname, '..') });
  require('./lib/relayMeta').scaffoldMissionMeta(workspacePath);
  autoConnectAgents(workspacePath);

  return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
}

function detectCodexCli() {
  try {
    const result = spawnSync('codex', ['--version'], { shell: true, timeout: 3000, encoding: 'utf-8' });
    if (result.status === 0) return 'codex';
  } catch (_) { }

  const npmGlobalBins = [
    path.join(HOME, 'AppData', 'Roaming', 'npm', 'codex.cmd'),
    path.join(HOME, 'AppData', 'Roaming', 'npm', 'codex'),
    '/usr/local/bin/codex',
    '/usr/bin/codex',
  ];
  for (const p of npmGlobalBins) {
    if (fs.existsSync(p)) return p;
  }

  try {
    const r = spawnSync('npx', ['codex', '--version'], { shell: true, timeout: 5000, encoding: 'utf-8' });
    if (r.status === 0) return 'npx codex';
  } catch (_) { }

  return null;
}

function detectClaudeCli() {
  try {
    const result = spawnSync('claude', ['--version'], { shell: true, timeout: 3000, encoding: 'utf-8' });
    if (result.status === 0) return true;
  } catch (_) { }

  const npmGlobalBins = [
    path.join(HOME, 'AppData', 'Roaming', 'npm', 'claude.cmd'),
    path.join(HOME, 'AppData', 'Roaming', 'npm', 'claude'),
    '/usr/local/bin/claude',
    '/usr/bin/claude',
  ];
  for (const p of npmGlobalBins) {
    if (fs.existsSync(p)) return true;
  }
  return false;
}

function sendHandshake(workspacePath, agent) {
  const safeAgent = agent.toUpperCase().replace(/ /g, '_');
  const token = `RELAY_INIT_HANDSHAKE_${safeAgent}_${Math.random().toString(36).substring(2, 8).toUpperCase()}`;

  const configPath = getConfigPath(workspacePath);
  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  if (!config.agents[agent]) config.agents[agent] = {};
  config.agents[agent].pendingToken = token;
  config.agents[agent].status = 'handshaking';

  let mode = 'unknown';

  if (agent === 'Antigravity') {
    fs.writeFileSync(path.join(getRelayDir(workspacePath), '.handshake_antigravity'), token);
    mode = 'beacon-file';
    console.log(`[Antigravity] Beacon written. Token: ${token}`);
  } else if (agent === 'Codex') {
    const codexBin = detectCodexCli();
    if (codexBin) {
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
      fs.writeFileSync(path.join(getRelayDir(workspacePath), '.handshake_codex'), token);
      mode = 'extension-cwd-match';
      console.log(`[Codex] No CLI found. Using extension mode (cwd match). Token: ${token}`);
    }
    config.agents[agent].codexMode = mode;
  } else if (agent === 'Claude Code') {
    const hasClaudeCli = detectClaudeCli();
    if (hasClaudeCli) {
      console.log(`[Claude Code] CLI found. Sending token via CLI...`);
      const result = spawnSync('claude', ['--print', token], {
        cwd: workspacePath,
        timeout: 20000,
        encoding: 'utf-8',
        shell: true,
      });
      mode = 'cli';
      console.log(`[Claude Code CLI] stdout: ${result.stdout}`);
      if (result.error) console.error(`[Claude Code CLI] spawn error: ${result.error.message}`);
    } else {
      fs.writeFileSync(path.join(getRelayDir(workspacePath), '.handshake_claude'), token);
      mode = 'extension-cwd-match';
      console.log(`[Claude Code] No CLI found. Using extension mode (cwd match). Token: ${token}`);
    }
    config.agents[agent].claudeMode = mode;
  } else if (agent === 'GitHub Copilot') {
    fs.writeFileSync(path.join(getRelayDir(workspacePath), '.handshake_copilot'), token);
    mode = 'workspace-cwd-match';
    console.log(`[GitHub Copilot] Beacon written. Token: ${token}`);
    config.agents[agent].copilotMode = mode;
  } else if (agent === 'Cursor') {
    fs.writeFileSync(path.join(getRelayDir(workspacePath), '.handshake_cursor'), token);
    mode = 'agent-transcripts';
    console.log(`[Cursor] Beacon written. Token: ${token}`);
    config.agents[agent].cursorMode = mode;
  }

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  return token;
}

function findJsonlFiles(dir, results = []) {
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) findJsonlFiles(full, results);
    else if (entry.name.endsWith('.jsonl')) results.push(full);
  }
  return results;
}

function findJsonlFilesInRoots(roots) {
  const seen = new Set();
  const results = [];
  for (const root of roots) {
    for (const file of findJsonlFiles(root)) {
      const normalized = path.resolve(file);
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      results.push(normalized);
    }
  }
  return results;
}

function mostRecentFile(files) {
  if (!files.length) return null;
  return [...files].sort((a, b) => {
    try { return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs; } catch { return 0; }
  })[0];
}

function discoverByToken(agent, token) {
  const root = AGENT_ROOTS[agent];
  if (!root || !fs.existsSync(root)) return null;
  for (const file of findJsonlFiles(root)) {
    try {
      if (fs.readFileSync(file, 'utf-8').includes(token)) return file;
    } catch (_) { }
  }
  return null;
}

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
        if (normalize(meta.payload.cwd) === targetCwd) matched.push(file);
      }
    } catch (_) { }
  }

  if (matched.length > 0) {
    const best = mostRecentFile(matched);
    console.log(`[Codex] Found ${matched.length} session(s) matching workspace cwd. Using: ${best}`);
    return best;
  }

  console.warn('[Codex] No cwd match found. Falling back to most recent session file.');
  return mostRecentFile(files);
}

function discoverCopilotSessionFiles(workspaceStorageDir) {
  const sessions = [];
  const chatSessionsDir = path.join(workspaceStorageDir, 'chatSessions');
  if (fs.existsSync(chatSessionsDir)) {
    for (const entry of fs.readdirSync(chatSessionsDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        sessions.push(path.join(chatSessionsDir, entry.name));
      }
    }
  }
  if (sessions.length > 0) return sessions;

  const transcriptsDir = path.join(workspaceStorageDir, 'GitHub.copilot-chat', 'transcripts');
  if (fs.existsSync(transcriptsDir)) {
    for (const entry of fs.readdirSync(transcriptsDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        sessions.push(path.join(transcriptsDir, entry.name));
      }
    }
  }
  return sessions;
}

function discoverCopilotByWorkspaceCwd(workspacePath) {
  const normalize = (p) => String(p || '').toLowerCase().replace(/\\/g, '/').replace(/\/$/, '');
  const targetCwd = normalize(workspacePath);

  const workspaceStorageDir = discoverWorkspaceStorageDir(workspacePath, [
    path.join(HOME, 'AppData', 'Roaming', 'Code', 'User', 'workspaceStorage'),
    path.join(HOME, '.config', 'Code', 'User', 'workspaceStorage'),
  ]);

  if (workspaceStorageDir) {
    const sessionFiles = discoverCopilotSessionFiles(workspaceStorageDir);
    if (sessionFiles.length > 0) {
      console.log(`[GitHub Copilot] Workspace storage: ${workspaceStorageDir} (${sessionFiles.length} session file(s))`);
      return workspaceStorageDir;
    }
  }

  const files = findJsonlFilesInRoots(COPILOT_DISCOVERY_ROOTS);
  if (!files.length) return null;

  const matched = [];
  for (const file of files) {
    try {
      const firstLine = fs.readFileSync(file, 'utf-8').split('\n')[0];
      const meta = JSON.parse(firstLine);
      if (meta.type === 'session.start') {
        const cwd = meta.data?.context?.cwd || meta.data?.context?.workspaceFolder?.folderPath;
        if (normalize(cwd) === targetCwd) matched.push(file);
      }
    } catch (_) { }
  }

  if (matched.length > 0) {
    const best = mostRecentFile(matched);
    console.log(`[GitHub Copilot] Found ${matched.length} legacy session(s) matching workspace cwd. Using: ${best}`);
    return best;
  }

  console.warn('[GitHub Copilot] No workspace match found. Falling back to most recent Copilot session file.');
  return mostRecentFile(files);
}

function discoverClaudeByWorkspaceCwd(workspacePath) {
  const root = AGENT_ROOTS['Claude Code'];
  if (!fs.existsSync(root)) return null;

  let slug = workspacePath.replace(/[^a-zA-Z0-9]/g, '-');
  if (slug.charAt(1) === '-') slug = slug.charAt(0).toLowerCase() + slug.slice(1);

  const projectDir = path.join(root, slug);
  if (fs.existsSync(projectDir)) {
    const files = findJsonlFiles(projectDir);
    if (files.length > 0) {
      const best = mostRecentFile(files);
      console.log(`[Claude Code] Found project dir matching workspace slug. Using: ${best}`);
      return best;
    }
  }

  console.warn('[Claude Code] No slug match found. Falling back to most recent session file.');
  return mostRecentFile(findJsonlFiles(root));
}

function extractBrainUuidFromJetskiMemento(workspacePath) {
  const wsDir = discoverWorkspaceStorageDir(workspacePath, ANTIGRAVITY_WS_ROOTS);
  if (!wsDir) return null;

  const mem = readVscdbJson(
    path.join(wsDir, 'state.vscdb'),
    'memento/antigravity.jetskiArtifactsEditor'
  );
  const viewState = mem?.['jetskiArtifactsEditor.viewState'];
  if (!Array.isArray(viewState) || !viewState.length) return null;

  for (const [uri] of viewState) {
    if (typeof uri !== 'string') continue;
    const match = uri.match(/antigravity-ide\/brain\/([0-9a-f-]{36})/i);
    if (match) return match[1];
  }
  return null;
}

function discoverAntigravityByWorkspace(workspacePath) {
  const normalize = (p) => String(p || '').toLowerCase().replace(/\\/g, '/');
  const target = normalize(workspacePath);
  const root = AGENT_ROOTS['Antigravity'];
  const matched = [];

  const brainUuid = extractBrainUuidFromJetskiMemento(workspacePath);
  if (brainUuid) {
    const transcript = path.join(
      root,
      brainUuid,
      '.system_generated',
      'logs',
      'transcript.jsonl'
    );
    if (fs.existsSync(transcript)) {
      console.log(`[Antigravity] Matched brain via jetski memento: ${brainUuid}`);
      return transcript;
    }
  }

  if (fs.existsSync(root)) {
    for (const file of findJsonlFiles(root)) {
      if (!file.endsWith('transcript.jsonl')) continue;
      try {
        if (normalize(fs.readFileSync(file, 'utf-8')).includes(target)) matched.push(file);
      } catch (_) { }
    }
  }

  if (matched.length > 0) {
    const best = mostRecentFile(matched);
    console.log(`[Antigravity] Found ${matched.length} transcript(s) mentioning workspace. Using: ${best}`);
    return best;
  }

  return discoverAntigravityMostRecent();
}

function discoverAntigravityMostRecent() {
  const root = AGENT_ROOTS['Antigravity'];
  const files = findJsonlFiles(root);
  const transcripts = files.filter(f => f.endsWith('transcript.jsonl'));
  return mostRecentFile(transcripts.length > 0 ? transcripts : files);
}

function discoverCursorByWorkspace(workspacePath) {
  const dir = discoverCursorTranscriptDir(workspacePath);
  if (dir) {
    console.log(`[Cursor] Agent transcripts dir: ${dir}`);
    return dir;
  }
  return null;
}

function normalizeParseResult(parsedData) {
  if (Array.isArray(parsedData)) {
    return { events: parsedData, artifacts: [], tasks: [], messages: [] };
  }
  return {
    events: parsedData.events || [],
    artifacts: parsedData.artifacts || [],
    tasks: parsedData.tasks || [],
    messages: parsedData.messages || [],
  };
}

function parseAgentData(agent, transcriptPath, workspacePath) {
  if (agent === 'Antigravity') {
    const brainDir = getBrainDir(transcriptPath);
    return parseAntigravity(transcriptPath, { brainDir });
  }
  if (agent === 'Codex') return { events: parseCodex(transcriptPath), artifacts: [], tasks: [], messages: [] };
  if (agent === 'Claude Code') {
    return {
      events: parseClaude(transcriptPath, { workspacePath }),
      artifacts: [],
      tasks: [],
      messages: [],
    };
  }
  if (agent === 'GitHub Copilot') {
    return {
      events: parseCopilot(transcriptPath, { workspacePath }),
      artifacts: [],
      tasks: [],
      messages: [],
    };
  }
  if (agent === 'Cursor') {
    return parseCursor(transcriptPath, { workspacePath });
  }
  return { events: [], artifacts: [], tasks: [], messages: [] };
}

const AUTO_AGENTS = ['Cursor', 'Claude Code', 'GitHub Copilot', 'Codex', 'Antigravity'];

function discoverAgentTranscript(agent, workspacePath) {
  if (agent === 'Antigravity') return discoverAntigravityByWorkspace(workspacePath);
  if (agent === 'Codex') return discoverCodexByWorkspaceCwd(workspacePath);
  if (agent === 'Claude Code') return discoverClaudeByWorkspaceCwd(workspacePath);
  if (agent === 'GitHub Copilot') return discoverCopilotByWorkspaceCwd(workspacePath);
  if (agent === 'Cursor') return discoverCursorByWorkspace(workspacePath);
  return null;
}

function connectAgentAuto(workspacePath, agent) {
  const transcriptPath = discoverAgentTranscript(agent, workspacePath);
  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    return { agent, connected: false };
  }

  const configPath = getConfigPath(workspacePath);
  const config = safeReadJson(configPath, { agents: {} });
  if (!config.agents) config.agents = {};

  let parsed = { events: [], artifacts: [], tasks: [], messages: [] };
  try {
    parsed = normalizeParseResult(parseAgentData(agent, transcriptPath, workspacePath));
  } catch (err) {
    console.warn(`[AutoConnect] ${agent} parse error: ${err.message}`);
  }

  config.agents[agent] = {
    status: 'connected',
    transcriptPath,
    connectedAt: new Date().toISOString(),
    autoConnected: true,
  };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

  const memoryPath = getMemoryPath(workspacePath);
  const memory = fs.existsSync(memoryPath)
    ? safeReadJson(memoryPath, { workspace: workspacePath, agents: {}, timeline: [] })
    : { workspace: workspacePath, agents: {}, timeline: [] };
  if (!memory.agents) memory.agents = {};
  memory.agents[agent] = {
    status: 'connected',
    transcriptPath,
    eventCount: parsed.events.length,
    events: parsed.events.slice(-100),
    artifacts: parsed.artifacts,
    tasks: parsed.tasks.slice(-50),
    messages: parsed.messages.slice(-50),
  };
  memory.timeline = buildGlobalTimeline(memory.agents);
  fs.writeFileSync(memoryPath, JSON.stringify(memory, null, 2));

  console.log(`[AutoConnect] ${agent} → ${transcriptPath}`);
  return { agent, connected: true, transcriptPath, eventCount: parsed.events.length };
}

function autoConnectAgents(workspacePath) {
  const configPath = getConfigPath(workspacePath);
  if (!fs.existsSync(configPath)) return [];

  let config = safeReadJson(configPath, null);
  if (!config) return [];
  if (config.autoUpdate === undefined) {
    config.autoUpdate = true;
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  }

  return AUTO_AGENTS.map(agent => connectAgentAuto(workspacePath, agent));
}

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
    transcriptPath = discoverByToken('Antigravity', token) || discoverAntigravityByWorkspace(workspacePath);
  } else if (agent === 'Codex') {
    if (agentConfig.codexMode === 'cli') {
      transcriptPath = discoverByToken('Codex', token);
    }
    if (!transcriptPath) transcriptPath = discoverCodexByWorkspaceCwd(workspacePath);
  } else if (agent === 'Claude Code') {
    if (agentConfig.claudeMode === 'cli') {
      transcriptPath = discoverByToken('Claude Code', token);
    }
    if (!transcriptPath) transcriptPath = discoverClaudeByWorkspaceCwd(workspacePath);
  } else if (agent === 'GitHub Copilot') {
    transcriptPath = discoverCopilotByWorkspaceCwd(workspacePath);
  } else if (agent === 'Cursor') {
    transcriptPath = discoverCursorByWorkspace(workspacePath);
  }

  if (!transcriptPath) {
    throw new Error(
      `Could not discover ${agent} transcript. ` +
      (agent === 'Codex'
        ? 'Make sure Codex is open in this workspace in VS Code.'
        : agent === 'GitHub Copilot'
          ? 'Make sure Copilot is open in this workspace in VS Code.'
          : agent === 'Cursor'
            ? 'Make sure Cursor agent chats exist for this workspace.'
            : 'The CLI may not have written a session yet.')
    );
  }

  let parsed = { events: [], artifacts: [], tasks: [], messages: [] };
  try {
    parsed = normalizeParseResult(parseAgentData(agent, transcriptPath, workspacePath));
  } catch (err) {
    console.error(`[${agent}] Parse error:`, err.message);
  }

  config.agents[agent] = {
    status: 'connected',
    transcriptPath,
    connectedAt: new Date().toISOString(),
    pendingToken: null,
    codexMode: agentConfig.codexMode || null,
    claudeMode: agentConfig.claudeMode || null,
    copilotMode: agentConfig.copilotMode || null,
    cursorMode: agentConfig.cursorMode || null,
  };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

  const memoryPath = getMemoryPath(workspacePath);
  const memory = JSON.parse(fs.readFileSync(memoryPath, 'utf-8'));
  memory.lastSync = new Date().toISOString();
  if (!memory.agents) memory.agents = {};
  memory.agents[agent] = {
    status: 'connected',
    transcriptPath,
    eventCount: parsed.events.length,
    events: parsed.events.slice(-100),
    artifacts: parsed.artifacts,
    tasks: parsed.tasks.slice(-50),
    messages: parsed.messages.slice(-50),
  };
  memory.timeline = buildGlobalTimeline(memory.agents);
  writeRelayContext(workspacePath);
  fs.writeFileSync(memoryPath, JSON.stringify(memory, null, 2));

  return {
    transcriptPath,
    eventCount: parsed.events.length,
    events: parsed.events.slice(-20),
  };
}

function syncWorkspace(workspacePath) {
  const configPath = getConfigPath(workspacePath);
  const memoryPath = getMemoryPath(workspacePath);
  if (!fs.existsSync(configPath)) throw new Error('Workspace not registered.');

  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  const memory = fs.existsSync(memoryPath)
    ? JSON.parse(fs.readFileSync(memoryPath, 'utf-8'))
    : { workspace: workspacePath, agents: {}, timeline: [] };

  let totalEvents = 0;

  for (const [agent, agentConfig] of Object.entries(config.agents)) {
    if (agentConfig.status !== 'connected' || !agentConfig.transcriptPath) continue;
    const transcriptPath = agentConfig.transcriptPath;
    if (!fs.existsSync(transcriptPath)) {
      console.warn(`[Sync] ${agent} transcript not found: ${transcriptPath}`);
      continue;
    }

    try {
      const parsed = normalizeParseResult(parseAgentData(agent, transcriptPath, workspacePath));
      if (!memory.agents) memory.agents = {};
      memory.agents[agent] = {
        status: 'connected',
        transcriptPath,
        eventCount: parsed.events.length,
        events: parsed.events.slice(-200),
        artifacts: parsed.artifacts,
        tasks: parsed.tasks.slice(-50),
        messages: parsed.messages.slice(-50),
      };
      totalEvents += parsed.events.length;
      console.log(`[Sync] ${agent}: ${parsed.events.length} events, ${parsed.artifacts.length} artifacts`);
    } catch (err) {
      console.error(`[Sync] ${agent} parse error: ${err.message}`);
    }
  }

  memory.timeline = buildGlobalTimeline(memory.agents);
  memory.lastSync = new Date().toISOString();
  fs.writeFileSync(memoryPath, JSON.stringify(memory, null, 2));
  return {
    totalEvents,
    timelineCount: memory.timeline.length,
    lastSync: memory.lastSync,
    agents: Object.keys(config.agents),
  };
}

async function refreshWorkspace(workspacePath, options = {}) {
  const syncResult = syncWorkspace(workspacePath);
  if (!options.skipBrief) {
    writeCompileBrief(workspacePath, options);
  }
  const contextResult = writeRelayContext(workspacePath, options);
  return { sync: syncResult, context: contextResult };
}

const activeWatchers = new Map();
const refreshInFlight = new Map();

function scheduleAutoSync(workspacePath, label) {
  if (refreshInFlight.has(workspacePath)) return;

  const configPath = getConfigPath(workspacePath);
  if (!fs.existsSync(configPath)) return;

  let config = {};
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch (_) {
    return;
  }
  if (config.autoUpdate === false) return;

  refreshInFlight.set(workspacePath, true);
  console.log(`[Watcher] ${label} changed — syncing...`);

  autoConnectAgents(workspacePath);
  try {
    syncWorkspace(workspacePath);
    writeCompileBrief(workspacePath);
    console.log(`[Watcher] ✓ synced (agent hooks update IR on stop)`);
  } catch (err) {
    console.error(`[Watcher] sync error: ${err.message}`);
  } finally {
    refreshInFlight.delete(workspacePath);
  }
}

function watchPath(watchTarget, label, workspacePath, watchers) {
  if (!watchTarget || !fs.existsSync(watchTarget)) return;

  let debounceTimer = null;
  const watchRecursive = fs.statSync(watchTarget).isDirectory();

  const watcher = fs.watch(watchTarget, { recursive: watchRecursive }, () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      scheduleAutoSync(workspacePath, label);
    }, 2000);
  });

  watchers.push(watcher);
  console.log(`[Watcher] Watching ${label}: ${watchTarget}`);
}

function startWatcher(workspacePath) {
  if (activeWatchers.has(workspacePath)) {
    activeWatchers.get(workspacePath).forEach(w => w.close());
  }

  autoConnectAgents(workspacePath);

  const configPath = getConfigPath(workspacePath);
  if (!fs.existsSync(configPath)) return 0;

  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  const watchers = [];

  for (const [agent, agentConfig] of Object.entries(config.agents)) {
    if (agentConfig.status !== 'connected' || !agentConfig.transcriptPath) continue;
    const transcriptPath = agentConfig.transcriptPath;
    if (!fs.existsSync(transcriptPath)) continue;

    watchPath(transcriptPath, `${agent} transcript`, workspacePath, watchers);

    if (agent === 'Antigravity') {
      watchPath(getBrainDir(transcriptPath), `${agent} brain`, workspacePath, watchers);
    }
  }

  activeWatchers.set(workspacePath, watchers);
  return watchers.length;
}

async function startRelayWatch(workspacePath) {
  const count = startWatcher(workspacePath);
  syncWorkspace(workspacePath);
  writeCompileBrief(workspacePath);
  return { watcherCount: count };
}

function stopWatcher(workspacePath) {
  if (!activeWatchers.has(workspacePath)) return;
  activeWatchers.get(workspacePath).forEach(w => w.close());
  activeWatchers.delete(workspacePath);
}

function getMemory(workspacePath) {
  const memoryPath = getMemoryPath(workspacePath);
  if (!fs.existsSync(memoryPath)) {
    throw new Error('Workspace not registered. Call /api/register first.');
  }
  return JSON.parse(fs.readFileSync(memoryPath, 'utf-8'));
}

function getRelayContext(workspacePath, options = {}) {
  const relayDir = getRelayDir(workspacePath);
  if (!fs.existsSync(relayDir)) {
    throw new Error('Workspace not registered. Call /api/register first.');
  }
  return writeRelayContext(workspacePath, options);
}

function getCompileBrief(workspacePath, options = {}) {
  const relayDir = getRelayDir(workspacePath);
  if (!fs.existsSync(relayDir)) {
    throw new Error('Workspace not registered. Call /api/register first.');
  }
  return writeCompileBrief(workspacePath, options);
}

async function compileIr(workspacePath, options = {}) {
  const relayDir = getRelayDir(workspacePath);
  if (!fs.existsSync(relayDir)) {
    throw new Error('Workspace not registered. Call /api/register first.');
  }
  if (!options.skipBrief) {
    writeCompileBrief(workspacePath, options);
  }
  return compileIrSync(workspacePath, options);
}

module.exports = {
  registerWorkspace,
  sendHandshake,
  connectAgent,
  connectAgentAuto,
  autoConnectAgents,
  syncWorkspace,
  refreshWorkspace,
  startWatcher,
  startRelayWatch,
  stopWatcher,
  getMemory,
  getRelayContext,
  getCompileBrief,
  compileIr,
  isRelayInstalled,
  installRelayWorkspace,
  writeAgentBootstrap,
};
