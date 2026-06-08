// Diff two normalized message streams at the levels defined in
// docs/atlas/verification-strategy.md:
//   D1  message-type sequence
//   D2+ structural deep-equal of the normalized payloads (positional)
//
// Returns a list of human-readable differences; empty array == streams agree at the requested
// level. The full reference-vs-new runner (M0) feeds captured "expected" streams and live
// "actual" streams through this.

import { normalizeStream } from './normalize.js';

/**
 * @param {unknown[]} expected reference stream
 * @param {unknown[]} actual new-impl stream
 * @param {{ level?: 'D1'|'D2', prenormalized?: boolean }} [opts]
 * @returns {string[]} differences (empty = match)
 */
export function diffStreams(expected, actual, opts = {}) {
  const level = opts.level || 'D2';
  const exp = opts.prenormalized ? expected : normalizeStream(expected);
  const act = opts.prenormalized ? actual : normalizeStream(actual);
  const diffs = [];

  // D1: message-type sequence
  const expTypes = exp.map((m) => m?.type);
  const actTypes = act.map((m) => m?.type);
  if (expTypes.join(',') !== actTypes.join(',')) {
    diffs.push(`D1 type-sequence: expected [${expTypes.join(', ')}] got [${actTypes.join(', ')}]`);
    if (level === 'D1' || expTypes.length !== actTypes.length) return diffs;
  }
  if (level === 'D1') return diffs;

  // D2: positional deep-equal of normalized payloads
  for (let i = 0; i < Math.max(exp.length, act.length); i++) {
    const a = JSON.stringify(exp[i]);
    const b = JSON.stringify(act[i]);
    if (a !== b) diffs.push(`D2 message[${i}] (${exp[i]?.type ?? '∅'}): \n  expected ${a}\n  actual   ${b}`);
  }
  return diffs;
}
