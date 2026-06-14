const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const PACKAGE_ROOT = path.join(__dirname, '..', '..');
const BACKEND = path.join(PACKAGE_ROOT, 'backend');

function getApiPort() {
  return Number(process.env.RELAY_PORT) || 3001;
}

function getUiPort() {
  return Number(process.env.RELAY_UI_PORT) || 6374;
}

function pingHealth(port) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/api/health`, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(1500, () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function isRelayApiRunning(port = getApiPort()) {
  return pingHealth(port);
}

function spawnDetached(args, env, cwd) {
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: 'ignore',
    env,
    cwd,
    windowsHide: true,
  });
  child.unref();
  return child;
}

function startRelayServeForeground(options = {}) {
  const port = options.port || getApiPort();
  const uiPort = options.uiPort || getUiPort();
  const apiOnly = Boolean(options.apiOnly);
  const { startMissionControlUi } = require('./relayUi');
  const serverPath = path.join(BACKEND, 'server.js');
  const env = { ...process.env, RELAY_PORT: String(port), RELAY_UI_PORT: String(uiPort) };

  let uiChild = null;
  if (!apiOnly) {
    try {
      uiChild = startMissionControlUi({ apiPort: port, uiPort });
    } catch (err) {
      console.warn(`Mission Control UI failed to start: ${err.message || err}`);
      console.warn('Continuing with API only.');
    }
  }

  const apiChild = spawn(process.execPath, [serverPath], {
    stdio: 'inherit',
    env,
    cwd: BACKEND,
  });

  function shutdown() {
    if (uiChild && !uiChild.killed) uiChild.kill();
    if (apiChild && !apiChild.killed) apiChild.kill();
    process.exit(0);
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  if (uiChild) {
    uiChild.on('exit', (code) => {
      if (code && code !== 0) console.warn(`Mission Control exited (${code})`);
    });
  }

  return { apiChild, uiChild, port, uiPort };
}

async function startRelayServeBackground(options = {}) {
  const port = options.port || getApiPort();
  const uiPort = options.uiPort || getUiPort();

  if (await isRelayApiRunning(port)) {
    return { started: false, alreadyRunning: true, port, uiPort };
  }

  const relayBin = path.join(PACKAGE_ROOT, 'bin', 'relay.js');
  const args = [relayBin, 'serve', '--port', String(port), '--ui-port', String(uiPort)];
  if (options.apiOnly) args.push('--api-only');

  const env = { ...process.env, RELAY_PORT: String(port), RELAY_UI_PORT: String(uiPort) };
  spawnDetached(args, env, PACKAGE_ROOT);

  for (let i = 0; i < 20; i += 1) {
    await new Promise((r) => setTimeout(r, 500));
    if (await isRelayApiRunning(port)) {
      return { started: true, alreadyRunning: false, port, uiPort };
    }
  }

  return { started: true, alreadyRunning: false, port, uiPort, warming: true };
}

module.exports = {
  PACKAGE_ROOT,
  getApiPort,
  getUiPort,
  isRelayApiRunning,
  startRelayServeForeground,
  startRelayServeBackground,
};
