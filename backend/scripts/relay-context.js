#!/usr/bin/env node
/** @deprecated Use: npx relay-os context [path] [--print] */
const { spawnSync } = require('child_process');
const path = require('path');

const relayBin = path.join(__dirname, '..', '..', 'bin', 'relay.js');
const args = ['context', ...process.argv.slice(2)];
const result = spawnSync(process.execPath, [relayBin, ...args], { stdio: 'inherit' });
process.exit(result.status ?? 1);
