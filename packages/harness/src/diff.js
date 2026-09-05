import { diffValues } from './parityCompare.js';

// D1 is diagnostic only. Default D2 compares every field and value.
export function diffStreams(expected, actual, { level = 'D2' } = {}) {
  if (!['D1', 'D2'].includes(level)) throw new Error(`Unknown comparison level: ${level}`);
  if (level === 'D1') {
    const a = expected.map(m => m?.type), b = actual.map(m => m?.type);
    return JSON.stringify(a) === JSON.stringify(b) ? [] : [`D1 type-sequence: expected [${a.join(', ')}] got [${b.join(', ')}]`];
  }
  return diffValues(expected, actual).map(d => `D2 ${d.path}: ${d.kind} — expected ${JSON.stringify(d.expected)}; got ${JSON.stringify(d.actual)}`);
}
