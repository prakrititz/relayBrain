#!/usr/bin/env node

if (process.env.RELAY_SKIP_UI_INSTALL === '1') process.exit(0);

const path = require('path');
const fs = require('fs');

const root = path.join(__dirname, '..');
const uiDir = path.join(root, 'mission-control');

if (!fs.existsSync(uiDir)) process.exit(0);

try {
  const { ensureMissionControlDeps } = require(path.join(root, 'backend', 'lib', 'relayUi'));
  ensureMissionControlDeps({ quiet: true });
} catch (err) {
  console.warn('[relay-os] Mission Control install skipped:', err.message || err);
  console.warn('[relay-os] Run `relay serve` — it will retry on first launch.');
}
