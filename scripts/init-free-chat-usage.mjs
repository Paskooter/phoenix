#!/usr/bin/env node
// Explicit, overwrite-refusing initialization. Never called by service startup.
import { initializeInferenceLedger } from '../packages/account/src/agentInference/ledger.js';
if (process.argv.length !== 3 || !process.argv[2]) {
  console.error('Usage: node scripts/init-free-chat-usage.mjs /private/path/chat-usage.json'); process.exitCode = 2;
} else {
  try { initializeInferenceLedger(process.argv[2]); console.log('Chat usage ledger initialized.'); }
  catch { console.error('Chat usage ledger was not initialized. Existing or unavailable state must not be overwritten.'); process.exitCode = 1; }
}
