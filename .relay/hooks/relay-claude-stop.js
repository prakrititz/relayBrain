#!/usr/bin/env node
const { runStopHook } = require('./relay-hook-lib');
runStopHook('claude').catch(() => process.exit(0));
