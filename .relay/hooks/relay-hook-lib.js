#!/usr/bin/env node
/** Shared sync+compile + session-agent IR follow-up for all agent stop hooks. */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const AGENT_FOLLOWUP = `Relay IR update (required — do not ask the user):

1. Read \`.relay/compile_brief.md\`
2. Update these files under \`.relay/\`:
   - \`project.md\` — overview, stack, goals
   - \`current_task.md\` — in progress / next tasks
   - \`decisions.md\` — open + resolved decisions
   - \`failures.md\` — what failed or not to repeat
   - \`architecture.md\` — only if the timeline changed architecture
3. Run \`relay context .\` (or \`npx relay-os context .\`)
4. Reply only: Relay memory updated.`;

const CONTINUATION_MARKER = '.relay-hook-continuing';

function readStdin() {
  return new Promise(resolve => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
  });
}

function getRelayInvocation(workspacePath) {
  try {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(workspacePath, '.relay', 'install.json'), 'utf-8')
    );
    if (manifest.relayCommand) return { cmd: manifest.relayCommand, argsPrefix: [] };
  } catch (_) {
    /* fallback */
  }
  return { cmd: 'npx', argsPrefix: ['relay-os'] };
}

function loadConfig(workspacePath) {
  try {
    return JSON.parse(fs.readFileSync(path.join(workspacePath, '.relay', 'config.json'), 'utf-8'));
  } catch (_) {
    return {};
  }
}

function markerPath(workspacePath) {
  return path.join(workspacePath, '.relay', CONTINUATION_MARKER);
}

function clearContinuationMarker(workspacePath) {
  try {
    fs.unlinkSync(markerPath(workspacePath));
  } catch (_) {
    /* ignore */
  }
}

function setContinuationMarker(workspacePath) {
  fs.writeFileSync(markerPath(workspacePath), new Date().toISOString(), 'utf-8');
}

function hasContinuationMarker(workspacePath) {
  return fs.existsSync(markerPath(workspacePath));
}

function runRelay(workspacePath, subcommand) {
  const { cmd, argsPrefix } = getRelayInvocation(workspacePath);
  spawnSync(cmd, [...argsPrefix, subcommand, '.'], {
    cwd: workspacePath,
    shell: true,
    encoding: 'utf-8',
    timeout: 120000,
    stdio: 'ignore',
  });
}

function shouldSkip(workspacePath, input, mode) {
  if (!fs.existsSync(path.join(workspacePath, '.relay', 'config.json'))) {
    return true;
  }

  const config = loadConfig(workspacePath);
  if (config.autoAgentUpdate === false || config.autoUpdate === false) {
    return true;
  }

  if (hasContinuationMarker(workspacePath)) {
    clearContinuationMarker(workspacePath);
    return true;
  }

  if (mode === 'cursor' && Number(input.loop_count || 0) > 0) {
    return true;
  }

  if ((mode === 'claude' || mode === 'codex') && input.stop_hook_active === true) {
    return true;
  }

  if (mode === 'antigravity' && input.fullyIdle === false) {
    return true;
  }

  return false;
}

async function prepareAgentIrUpdate(workspacePath, input, mode) {
  if (shouldSkip(workspacePath, input, mode)) {
    return { skip: true };
  }

  runRelay(workspacePath, 'sync');
  runRelay(workspacePath, 'compile');
  setContinuationMarker(workspacePath);
  return { skip: false, message: AGENT_FOLLOWUP };
}

function emitContinuation(mode, message) {
  switch (mode) {
    case 'cursor':
      process.stdout.write(JSON.stringify({ followup_message: message }));
      break;
    case 'claude':
      process.stderr.write(message);
      process.exit(2);
      return;
    case 'codex':
    case 'copilot':
      process.stdout.write(JSON.stringify({ decision: 'block', reason: message }));
      break;
    case 'antigravity':
      process.stdout.write(JSON.stringify({ decision: 'continue', reason: message }));
      break;
    default:
      process.stdout.write(JSON.stringify({ followup_message: message }));
  }
}

async function runStopHook(mode) {
  const raw = await readStdin();
  let input = {};
  try {
    input = raw ? JSON.parse(raw) : {};
  } catch (_) {
    input = {};
  }

  const workspacePath = process.cwd();
  const result = await prepareAgentIrUpdate(workspacePath, input, mode);
  if (result.skip) {
    process.exit(0);
  }

  emitContinuation(mode, result.message);
  process.exit(0);
}

module.exports = {
  AGENT_FOLLOWUP,
  readStdin,
  prepareAgentIrUpdate,
  emitContinuation,
  runStopHook,
};
