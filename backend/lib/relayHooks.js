const fs = require('fs');
const path = require('path');

const HOOK_FILES = [
  'relay-hook-lib.js',
  'relay-cursor-stop.js',
  'relay-claude-stop.js',
  'relay-codex-stop.js',
  'relay-copilot-stop.js',
  'relay-antigravity-stop.js',
];

const HOOK_CMD = {
  cursor: 'node ".relay/hooks/relay-cursor-stop.js"',
  claude: 'node ".relay/hooks/relay-claude-stop.js"',
  codex: 'node ".relay/hooks/relay-codex-stop.js"',
  copilot: 'node ".relay/hooks/relay-copilot-stop.js"',
  antigravity: 'node ".relay/hooks/relay-antigravity-stop.js"',
};

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function buildRelayCommand(packageRoot) {
  const relayBin = path.join(packageRoot, 'bin', 'relay.js');
  return `node "${relayBin.replace(/\\/g, '/')}"`;
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (_) {
    return null;
  }
}

function writeJson(filePath, data) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

function installHookScripts(workspacePath, packageRoot) {
  const hooksDir = path.join(workspacePath, '.relay', 'hooks');
  ensureDir(hooksDir);

  for (const file of HOOK_FILES) {
    const src = path.join(packageRoot, 'backend', 'hooks', file);
    const dest = path.join(hooksDir, file);
    if (!fs.existsSync(src)) {
      return { installed: false, reason: `missing ${file}` };
    }
    fs.copyFileSync(src, dest);
  }

  for (const legacy of ['relay-refresh.js', 'relay-stop.js', 'relay-agent-ir.js']) {
    const legacyPath = path.join(hooksDir, legacy);
    if (fs.existsSync(legacyPath)) fs.unlinkSync(legacyPath);
  }

  return { installed: true, hooksDir };
}

function installCursorHooks(workspacePath) {
  const hooksJsonPath = path.join(workspacePath, '.cursor', 'hooks.json');
  const base = readJson(hooksJsonPath) || { version: 1, hooks: {} };
  if (!base.hooks) base.hooks = {};
  if (!Array.isArray(base.hooks.stop)) base.hooks.stop = [];

  base.hooks.stop = base.hooks.stop.filter(
    entry => !String(entry.command || '').includes('relay-')
  );
  base.hooks.stop.push({
    command: '.relay/hooks/relay-cursor-stop.js',
    loop_limit: 1,
  });
  base.version = base.version || 1;

  writeJson(hooksJsonPath, base);
  return { hooksJson: hooksJsonPath };
}

function installClaudeHooks(workspacePath) {
  const settingsPath = path.join(workspacePath, '.claude', 'settings.json');
  const base = readJson(settingsPath) || {};
  if (!base.hooks) base.hooks = {};
  if (!Array.isArray(base.hooks.Stop)) base.hooks.Stop = [];

  base.hooks.Stop = base.hooks.Stop.filter(entry => {
    const cmds = entry.hooks || [];
    return !cmds.some(h => String(h.command || '').includes('relay-'));
  });
  base.hooks.Stop.push({
    matcher: '*',
    hooks: [{ type: 'command', command: HOOK_CMD.claude }],
  });

  writeJson(settingsPath, base);
  return { settingsPath };
}

function installCodexHooks(workspacePath) {
  const hooksPath = path.join(workspacePath, '.codex', 'hooks.json');
  const base = readJson(hooksPath) || { hooks: {} };
  if (!base.hooks) base.hooks = {};

  base.hooks.Stop = [
    {
      hooks: [
        {
          type: 'command',
          command: HOOK_CMD.codex,
          timeout: 120,
        },
      ],
    },
  ];

  writeJson(hooksPath, base);
  return { hooksPath };
}

function installCopilotHooks(workspacePath) {
  const hooksDir = path.join(workspacePath, '.github', 'hooks');
  ensureDir(hooksDir);
  const hooksPath = path.join(hooksDir, 'relay-os.json');

  const config = {
    version: 1,
    hooks: {
      agentStop: [
        {
          type: 'command',
          bash: HOOK_CMD.copilot,
          powershell: HOOK_CMD.copilot,
          cwd: '.',
          timeoutSec: 120,
        },
      ],
    },
  };

  writeJson(hooksPath, config);
  return { hooksPath };
}

function installAntigravityHooks(workspacePath) {
  const agentsDir = path.join(workspacePath, '.agents');
  ensureDir(agentsDir);
  const hooksPath = path.join(agentsDir, 'hooks.json');

  const existing = readJson(hooksPath) || {};
  const merged = { ...existing };

  merged['relay-os'] = {
    Stop: [
      {
        type: 'command',
        command: HOOK_CMD.antigravity,
        timeout: 120,
      },
    ],
  };

  writeJson(hooksPath, merged);
  return { hooksPath };
}

function installAgentHooks(workspacePath, packageRoot) {
  const hooks = installHookScripts(workspacePath, packageRoot);
  if (!hooks.installed) return hooks;

  return {
    installed: true,
    hooksDir: hooks.hooksDir,
    cursor: installCursorHooks(workspacePath),
    claude: installClaudeHooks(workspacePath),
    codex: installCodexHooks(workspacePath),
    copilot: installCopilotHooks(workspacePath),
    antigravity: installAntigravityHooks(workspacePath),
    relayCommand: buildRelayCommand(packageRoot),
  };
}

module.exports = {
  HOOK_FILES,
  HOOK_CMD,
  buildRelayCommand,
  installAgentHooks,
};
