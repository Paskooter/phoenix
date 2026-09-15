#!/usr/bin/env node
// Diff the WS message streams captured from two substitution runs.
//
// The suite's assertions check a handful of named fields. This compares the
// whole message stream the robot client actually received, message for message,
// so a difference the suite happens not to assert on still shows up.
//
// Only genuinely per-run values are normalised: identifiers minted fresh each
// run and elapsed times. Everything else -- types, ordering, message counts,
// every payload field -- is compared verbatim. Normalising more than this would
// quietly hide the differences the lane exists to find, so the set is small,
// explicit, and reported alongside the result.
//
// Usage:
//   node compare-traces.mjs <control-dir> <candidate-dir> [--show N]

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Minted per run, or wall-clock: equal values here would mean the two runs were
// the same run. Compared for PRESENCE and TYPE, never for value.
const VOLATILE = new Set(['msgID', 'ts', 'transID', 'transId', 'sessionId', 'session', 'timings', 'id']);

function normalise(value) {
  if (Array.isArray(value)) return value.map(normalise);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      // Keep the key and its type so a vanished or retyped field still fails.
      out[key] = VOLATILE.has(key) ? `<${Array.isArray(value[key]) ? 'array' : typeof value[key]}>` : normalise(value[key]);
    }
    return out;
  }
  return value;
}

function load(dir) {
  const out = new Map();
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
    out.set(file, JSON.parse(readFileSync(join(dir, file), 'utf8')));
  }
  return out;
}

function main() {
  const [controlDir, candidateDir] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (!controlDir || !candidateDir) {
    console.error('usage: compare-traces.mjs <control-dir> <candidate-dir> [--show N]');
    process.exit(2);
  }
  const showIdx = process.argv.indexOf('--show');
  const show = showIdx >= 0 ? Number(process.argv[showIdx + 1]) : 3;

  const control = load(controlDir);
  const candidate = load(candidateDir);

  console.log(`control:   ${control.size} transactions`);
  console.log(`candidate: ${candidate.size} transactions`);
  // An empty capture would otherwise report a perfect score for comparing
  // nothing at all.
  if (!control.size || !candidate.size) { console.error('a capture is empty; nothing was compared'); process.exit(2); }

  // Matched by NAME, not by position. A driver can throw before it returns, so
  // one run legitimately writes fewer traces than the other -- zipping by index
  // would then compare two unrelated transactions and call them a difference,
  // or worse, call them identical.
  const differences = [];
  const names = new Set([...control.keys(), ...candidate.keys()]);
  for (const name of [...names].sort()) {
    const a = control.get(name);
    const b = candidate.get(name);
    if (!a) { differences.push({ file: name, why: 'present only in the candidate run' }); continue; }
    if (!b) { differences.push({ file: name, why: 'present only in the control run' }); continue; }
    const left = JSON.stringify(normalise(a), null, 1);
    const right = JSON.stringify(normalise(b), null, 1);
    if (left !== right) differences.push({ file: name, why: 'message stream differs', left, right });
  }
  const n = names.size;

  console.log(`normalised fields: ${[...VOLATILE].join(', ')}`);
  console.log(`\nidentical: ${n - differences.length}/${n}`);
  for (const d of differences.slice(0, show)) {
    console.log(`\n  ✗ ${d.file}: ${d.why}`);
    if (d.left) {
      const l = d.left.split('\n');
      const r = d.right.split('\n');
      for (let k = 0; k < Math.max(l.length, r.length); k += 1) {
        if (l[k] !== r[k]) {
          console.log(`      control  : ${l[k] ?? '(absent)'}`);
          console.log(`      candidate: ${r[k] ?? '(absent)'}`);
        }
      }
    }
  }
  if (differences.length > show) console.log(`\n  … ${differences.length - show} more`);
  process.exitCode = differences.length ? 1 : 0;
}

main();
