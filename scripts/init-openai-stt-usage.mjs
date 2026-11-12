#!/usr/bin/env node
// First-install only: creates the usage ledger for OpenRouter (or a capped
// custom endpoint) speech recognition. Refuses to overwrite existing state and
// never contacts a provider.
import { initializeTranscriptionUsageFile } from '../packages/gateway/src/asr/transcriptionUsage.js';

const file = process.argv[2];
if (!file || process.argv.length !== 3) {
  console.error('Usage: node scripts/init-openai-stt-usage.mjs <absolute-usage-file>');
  console.error('  e.g. $PHOENIX_DATA_DIR/asr/openrouter-stt-usage.json or .../custom-stt-usage.json');
  process.exitCode = 1;
} else {
  try {
    if (!file.startsWith('/')) throw new Error('The usage file must be an absolute path');
    initializeTranscriptionUsageFile(file);
    console.log('Initialized a private speech recognition usage ledger.');
  } catch (err) {
    console.error(`Speech recognition usage initialization failed (${err.code || 'invalid-path'}). Existing state was preserved.`);
    process.exitCode = 1;
  }
}
