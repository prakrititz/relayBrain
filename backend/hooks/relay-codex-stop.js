#!/usr/bin/env node
const { runStopHook } = require('./relay-hook-lib');
runStopHook('codex').catch(() => process.exit(0));
