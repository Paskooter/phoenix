// The OpenRouter (or capped custom) speech usage file, as the log reports it.
// A server that never set it up gets one note, not an error at every start;
// a file that was read and then disappears is still an error.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TranscriptionUsageMeter, initializeTranscriptionUsageFile } from '../src/asr/transcriptionUsage.js';

function recorder() {
  const lines = [];
  const at = (level) => (message) => lines.push(`${level}: ${message}`);
  return { lines, log: { info: at('info'), warn: at('warn'), error: at('error') } };
}

test('a usage file never created is noted once, not logged as an error', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'phx-stt-usage-log-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { lines, log } = recorder();
  const meter = new TranscriptionUsageMeter({ file: join(dir, 'asr', 'openrouter-stt-usage.json'), monthlyLimitMicroUsd: 2e6, label: 'OpenRouter', log });
  assert.equal(meter.status().problem, 'usage-file-missing', 'it stays off');
  assert.equal(meter.refusal({ microUsd: 1 }), 'usage-file-missing');
  meter.status();
  assert.deepEqual(lines, ['info: OpenRouter speech usage file has not been created; it stays off until it is']);
});

test('a usage file that disappears after it was read is an error', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'phx-stt-usage-log-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'openrouter-stt-usage.json');
  initializeTranscriptionUsageFile(file);
  const { lines, log } = recorder();
  const meter = new TranscriptionUsageMeter({ file, monthlyLimitMicroUsd: 2e6, label: 'OpenRouter', log });
  assert.equal(meter.status().problem, null);
  unlinkSync(file);
  assert.equal(meter.reserve({ microUsd: 100, seconds: 1 }), null, 'nothing is sent without the file');
  assert.equal(meter.status().problem, 'usage-file-missing');
  assert.deepEqual(lines, ['error: OpenRouter speech usage file cannot be read; it stays off']);
});
