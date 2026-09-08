#!/usr/bin/env node

// Focused residual probe: run the selected NLU runtime against the 51
// default-AST residual ids and compare parseRequest output to original HTTP
// parser data. This is not a 20,528-case replay.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseRequest } from '../src/requestParser.js';
import { compiledFstRuntimeConfig, defaultParserProfile, getCompiledFstRuntime } from '../src/compiledFstRuntime.js';

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith('--') || index + 1 >= argv.length) {
      throw new Error(`usage: probeCompiledResiduals.mjs --original FILE --families FILE --out FILE`);
    }
    result[value.slice(2)] = argv[++index];
  }
  if (!result.original || !result.families || !result.out) {
    throw new Error(`usage: probeCompiledResiduals.mjs --original FILE --families FILE --out FILE`);
  }
  return result;
}

function sameEntities(actual, expected) {
  const left = actual && typeof actual === 'object' ? actual : {};
  const right = expected && typeof expected === 'object' ? expected : {};
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  const diffs = [];
  for (const key of keys) {
    if (left[key] !== right[key]) diffs.push({ key, actual: left[key] ?? null, expected: right[key] ?? null });
  }
  return diffs;
}

function familyFor(id, families) {
  for (const family of families.families) {
    if (family.ids.includes(id)) return family.id;
  }
  return null;
}

const options = parseArgs(process.argv.slice(2));
const originalBytes = readFileSync(resolve(options.original));
const original = JSON.parse(originalBytes.toString('utf8'));
const familiesBytes = readFileSync(resolve(options.families));
const families = JSON.parse(familiesBytes.toString('utf8'));
const ids = families.families.flatMap(family => family.ids);
const byId = new Map(original.rows.map(row => [row.id, row]));

const runtime = getCompiledFstRuntime();
const profile = defaultParserProfile();
const rows = [];
let matches = 0;
const byFamily = {};
for (const family of families.families) {
  byFamily[family.id] = { count: family.ids.length, matches: 0, mismatches: 0 };
}

for (const id of ids) {
  const row = byId.get(id);
  if (!row) throw new Error(`original capture is missing ${id}`);
  const request = row.input.value.data;
  const expected = row.response.value.data;
  const actual = parseRequest({
    text: request.text,
    rules: request.rules,
    loop: request.loop,
    external: request.external,
  });
  const entityDiffs = sameEntities(actual.entities, expected.entities);
  const equal = actual.intent === expected.intent
    && JSON.stringify(actual.rules) === JSON.stringify(expected.rules)
    && entityDiffs.length === 0;
  if (equal) matches += 1;
  const family = familyFor(id, families);
  if (family) {
    if (equal) byFamily[family].matches += 1;
    else byFamily[family].mismatches += 1;
  }
  rows.push({
    id,
    family,
    text: request.text,
    equal,
    original: { intent: expected.intent, entities: expected.entities, rules: expected.rules },
    phoenix: { intent: actual.intent, entities: actual.entities, rules: actual.rules },
    entityDiffs,
  });
}

const report = {
  kind: 'n08-compiled-residual-probe',
  date: new Date().toISOString().slice(0, 10),
  profile,
  runtimeSelected: Boolean(runtime),
  runtime: compiledFstRuntimeConfig(),
  originalSha256: sha256(originalBytes),
  familiesSha256: sha256(familiesBytes),
  originalSourceRevision: original.sourceRevision,
  cases: ids.length,
  matches,
  differences: ids.length - matches,
  byFamily,
  rows,
};

const outPath = resolve(options.out);
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({
  out: outPath,
  profile,
  cases: report.cases,
  matches: report.matches,
  differences: report.differences,
  byFamily: report.byFamily,
}, null, 2)}\n`);
