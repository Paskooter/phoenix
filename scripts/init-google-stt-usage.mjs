#!/usr/bin/env node
// First-install only: refuses to overwrite existing accounting state.
import { initializeGoogleUsageFile } from '../packages/gateway/src/asr/googleUsage.js';

const file = process.argv[2];
if (!file || process.argv.length !== 3) {
  console.error('Usage: node scripts/init-google-stt-usage.mjs <absolute-usage-file>');
  process.exitCode = 1;
} else {
  try {
    if (!file.startsWith('/')) throw new Error('The usage file must be an absolute path');
    initializeGoogleUsageFile(file);
    console.log('Initialized a private Google speech usage ledger.');
  } catch (err) {
    console.error(`Google speech usage initialization failed (${err.code || 'invalid-path'}). Existing state was preserved.`);
    process.exitCode = 1;
  }
}
