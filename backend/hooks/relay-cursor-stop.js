#!/usr/bin/env node
const { runStopHook } = require('./relay-hook-lib');
runStopHook('cursor').catch(() => process.exit(0));
