#!/usr/bin/env node
const { runStopHook } = require('./relay-hook-lib');
runStopHook('antigravity').catch(() => process.exit(0));
