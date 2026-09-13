#!/usr/bin/env node

// Compare the three pinned source/native entity-collision inputs at the
// candidate parser and router boundary.  The full native capture stays
// outside git; only its SHA and the three compact expected rows are retained.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { parseRequest } from '../../packages/nlu/src/requestParser.js';
import { IntentRouter } from '../../packages/gateway/src/intentRouter.js';
import { loadRegistry } from '../../packages/gateway/src/registry.js';

const specPath = path.resolve(process.argv[2]);
const outPath = path.resolve(process.argv[3]);
const capturePath = path.resolve(process.argv[4] || '/home/shell/work/phoenix/.parity/reviews/full-original-parser.json');
if (!specPath || !outPath) throw new Error('usage: run-normalization.mjs NORMALIZATION.json OUT.json [SOURCE_CAPTURE.json]');
const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
let candidateRevision = 'unknown';
try { candidateRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: process.cwd(), encoding: 'utf8' }).trim(); } catch {}
const captureBytes = fs.readFileSync(capturePath);
const captureSha256 = crypto.createHash('sha256').update(captureBytes).digest('hex');
if (spec.sourceCapture?.sha256 && captureSha256 !== spec.sourceCapture.sha256) {
  throw new Error(`source capture sha256 mismatch: expected ${spec.sourceCapture.sha256}, got ${captureSha256}`);
}
const capture = JSON.parse(captureBytes);
const captureRows = new Map((capture.rows || []).map(row => [row.id, row]));
const router = new IntentRouter(await loadRegistry({ indexFile: 'skills-local.json', env: {} }));

function value(row) {
  const data = row?.response?.value?.data || {};
  return { intent: data.intent || null, entities: data.entities || {}, rules: data.rules || [] };
}
function inputContext(row) {
  return row?.input?.value?.data?.loop || { users: [] };
}
function digest(valueToHash) {
  return crypto.createHash('sha256').update(JSON.stringify(valueToHash)).digest('hex');
}

const rows = [];
for (const descriptor of spec.rows || []) {
  const sourceCapture = captureRows.get(descriptor.captureId);
  if (!sourceCapture) throw new Error(`source capture row missing: ${descriptor.captureId}`);
  const source = value(sourceCapture);
  const loop = inputContext(sourceCapture);
  const candidate = parseRequest({ text: descriptor.text, rules: ['launch'], loop });
  const decision = router.getSkillIDFromNLU(candidate) || null;
  rows.push({
    id: descriptor.id,
    captureId: descriptor.captureId,
    text: descriptor.text,
    source: {
      intent: source.intent,
      entities: source.entities,
      rules: source.rules,
      mim: descriptor.sourceMim,
      memoType: 'ScriptedResponse',
    },
    candidate: {
      intent: candidate.intent || null,
      entities: candidate.entities || {},
      rules: candidate.rules || [],
      mim: decision?.memo?.mim || null,
      memoType: decision?.memo?.type || null,
      skillID: decision?.skillID || null,
    },
    contextSha256: digest(loop),
  });
}

const result = {
  schemaVersion: 1,
  mode: 'candidate-normalization',
  sourceRevision: spec.sourceRevision,
  candidateRevision,
  candidateRuntime: process.version,
  sourceCapture: { path: capturePath, sha256: captureSha256, sourceRevision: capture.sourceRevision, runtime: capture.runtime },
  rows,
};
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({ mode: result.mode, rows: rows.length, captureSha256 }));
