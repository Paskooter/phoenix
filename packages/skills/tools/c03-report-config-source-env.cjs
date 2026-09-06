#!/usr/bin/env node
// Execute the pinned Pegasus report-skill EnvVars implementation in a separate
// process. Set C03_REPORT_SOURCE to the checked-out 5c reference root.

// Keep this probe runnable in the pinned Node 8.9.4 image as well as modern Node.
const path = require('path');

const sourceRoot = process.env.C03_REPORT_SOURCE;
if (!sourceRoot) {
  console.error('C03_REPORT_SOURCE is required');
  process.exit(2);
}

const { EnvVars } = require(path.join(sourceRoot, 'packages/report-skill/lib/EnvVars'));
console.log(JSON.stringify({
  sourceRoot,
  runtime: process.version,
  vars: EnvVars.get(),
}));
