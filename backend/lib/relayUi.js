const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');

const PACKAGE_ROOT = path.join(__dirname, '..', '..');
const UI_DIR = path.join(PACKAGE_ROOT, 'mission-control');

function getUiPort() {
  return Number(process.env.RELAY_UI_PORT) || 6374;
}

function getApiPort() {
  return Number(process.env.RELAY_PORT) || 3001;
}

function getDashboardBaseUrl() {
  return `http://localhost:${getUiPort()}`;
}

function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function ensureMissionControlDeps(options = {}) {
  if (!fs.existsSync(UI_DIR)) {
    throw new Error('Mission Control UI not found in relay-os package');
  }

  const nodeModules = path.join(UI_DIR, 'node_modules');
  if (fs.existsSync(nodeModules) && !options.force) return UI_DIR;

  if (options.quiet) {
    execSync(`${npmCommand()} install`, { cwd: UI_DIR, stdio: 'ignore', shell: process.platform === 'win32' });
  } else {
    console.log('[relay] Installing Mission Control UI dependencies (first run)…');
    execSync(`${npmCommand()} install`, { cwd: UI_DIR, stdio: 'inherit', shell: process.platform === 'win32' });
  }

  return UI_DIR;
}

function startMissionControlUi(options = {}) {
  ensureMissionControlDeps(options);
  const uiPort = options.uiPort || getUiPort();
  const apiPort = options.apiPort || getApiPort();

  const env = {
    ...process.env,
    NEXT_PUBLIC_RELAY_URL: `http://localhost:${apiPort}`,
    PORT: String(uiPort),
  };

  return spawn(npmCommand(), ['run', 'dev'], {
    cwd: UI_DIR,
    stdio: 'inherit',
    env,
    shell: process.platform === 'win32',
  });
}

module.exports = {
  UI_DIR,
  getUiPort,
  getApiPort,
  getDashboardBaseUrl,
  ensureMissionControlDeps,
  startMissionControlUi,
};
