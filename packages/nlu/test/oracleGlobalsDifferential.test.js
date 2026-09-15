// Differential against Jibo's own parser.
//
// The recovered 2.8.3 package ships the original `parse` executable and the
// reference tree ships the compiled FSTs it reads, so the pair answers what
// Jibo actually did rather than what a reimplementation believes it did. Both
// are large private artifacts kept out of Git; this replays the small captured
// golden, so the differential keeps running without them.
//
// Re-capture with:
//   node scripts/parity-nlu-oracle/capture.mjs --write

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseRequest } from '../src/requestParser.js';

const golden = JSON.parse(readFileSync(
  new URL('../resources/legacy-oracle/globals-golden.json', import.meta.url),
  'utf8',
));

test('the capture is real ground truth, not an empty file', () => {
  const rows = Object.entries(golden.results);
  assert.ok(rows.length >= 45, `expected a substantial capture, got ${rows.length}`);
  // It must actually exercise the global-command surface, or agreeing with it
  // would prove nothing about the gap this covers.
  const globalCommands = rows.filter(([, r]) => r.domain === 'global_commands');
  assert.ok(globalCommands.length >= 10, `only ${globalCommands.length} global-command rows`);
  const guiCommands = rows.filter(([, r]) => r.domain === 'gui_command');
  assert.ok(guiCommands.length >= 5, `only ${guiCommands.length} gui_command rows`);
  // And it must contain real no-matches, so "always answer something" fails.
  assert.ok(rows.some(([, r]) => r.intent === null), 'no negative cases captured');
});

test('Phoenix agrees with jibo-nlu 2.8.3 on every captured utterance', () => {
  const disagreements = [];
  for (const [text, want] of Object.entries(golden.results)) {
    const got = parseRequest({ text, rules: [...golden.rules] });
    const intent = got.intent ?? null;
    if (intent !== want.intent) disagreements.push(`${text}: oracle=${want.intent} phoenix=${intent}`);
  }
  assert.deepEqual(disagreements, [], `disagreements with the original parser:\n${disagreements.join('\n')}`);
});

test('the captured rule list is the one the gateway sends on a global turn', async () => {
  const { GLOBAL_TURN_RULES } = await import('../../gateway/src/listenTransaction.js');
  assert.deepEqual([...golden.rules], [...GLOBAL_TURN_RULES]);
});
