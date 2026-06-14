#!/usr/bin/env node
const { runStopHook } = require('./relay-hook-lib');
runStopHook('copilot').catch(() => process.exit(0));
