// I-02 differential validation oracle: Phoenix's hand-ported validators.js vs the PINNED compiled
// Pegasus validators (which run real joi@13.1.2), input-for-input.
//
// 770 generated inputs (every field x value-type x match-method combination for rule.validate, a
// hand-built query battery and an event battery) must produce the identical outcome: either both
// accept, or both throw with the same error name AND the same byte-for-byte message.
//
// Run: NODE_PATH=/tmp/i01oracle/node_modules node i02-validator-differential.mjs > i02-validator-differential.txt 2>&1
import { createRequire } from 'node:module';
import { validateQuery, validateEvent, validateRule } from '../../../../../packages/history/src/validators.js';

const REF = '/home/shell/work/phoenix/.parity/reference/5c0a7390539663ba749d360de348a428c088505c';
const require = createRequire(REF + '/packages/history/');
const rqv = require(REF + '/packages/history/lib/skilllaunch/validators/query.js');
const rev = require(REF + '/packages/history/lib/skilllaunch/validators/event.js');
const rrv = require(REF + '/packages/history/lib/skilllaunch/validators/rule.js');

const clone = (o) => JSON.parse(JSON.stringify(o));
function run(fn, arg) {
  try { fn(clone(arg)); return { ok: true }; }
  catch (e) { return { ok: false, name: e.name, message: e.message }; }
}
let pass = 0; const fails = [];
function cmp(kind, label, refFn, myFn, arg) {
  const r = run(refFn, arg); const m = run(myFn, arg);
  const same = r.ok === m.ok && (r.ok || (r.name === m.name && r.message === m.message));
  if (same) pass += 1; else fails.push({ kind, label, ref: r, mine: m });
}

// ---------- validated rule battery ----------
const RULE_VALUES = ['x', 5, true, false, null, ['a'], ['a', 'b'], [], {}, { k: 1 }, undefined];
const RULE_FIELDS = ['skillID', 'intent', 'personIDs', 'payload', 'bogus', undefined];
const MATCHES = [undefined, 'EXACT', 'NOT', 'ONE_OF', 'CONTAINS', 'CONTAINS_ANY', 'CONTAINS_ALL', 'NOT_CONTAIN', 'BOGUS', ''];
let ruleCases = 0;
for (const field of RULE_FIELDS) {
  for (const value of RULE_VALUES) {
    for (const match of MATCHES) {
      const rule = { field };
      if (value !== undefined) rule.value = value;
      if (match !== undefined) rule.match = match;
      // payload key variant (every 3rd)
      if (field === 'payload' && (ruleCases % 3) === 0) rule.key = 'k1';
      cmp('rule', JSON.stringify(rule), rrv.validate, validateRule, rule);
      ruleCases += 1;
    }
  }
}
// rules with key
for (const value of ['v', 0, false, ['a'], [], null, {}]) {
  cmp('rule-key', JSON.stringify({ field: 'payload', key: 'a.b', value }), rrv.validate, validateRule, { field: 'payload', key: 'a.b', value });
}

// ---------- validated query battery ----------
const QUERIES = [
  { robotID: 'r-1' }, {}, { robotID: null }, { robotID: '' }, { robotID: 'bad id!' }, { robotID: 'r_1' },
  { robotID: 123 }, { robotID: true }, { robotID: {} }, { robotID: [] }, { robotID: 'bad id', foo: 1 },
  { foo: 'bar' }, { robotID: 'r-1', foo: 'bar' }, { robotID: 'r-1', foo: 1, bar: 2 },
  { robotID: 'r-1', rules: 'x' }, { robotID: 'r-1', rules: null }, { robotID: 'r-1', rules: [] },
  { robotID: 'r-1', rules: ['x'] }, { robotID: 'r-1', rules: [null] }, { robotID: 'r-1', rules: [5] },
  { robotID: 'r-1', skillID: 'has space' }, { robotID: 'r-1', skillID: '@be/x-y_z' }, { robotID: 'r-1', skillID: '' },
  { robotID: 'r-1', skillID: null }, { robotID: 'r-1', intent: 'has space' }, { robotID: 'r-1', intent: '' },
  { robotID: 'r-1', intent: null }, { robotID: 'r-1', personID: 'has space' }, { robotID: 'r-1', personID: null },
  { robotID: 'r-1', notSessionID: 'has space' }, { robotID: 'r-1', notSessionID: '' },
  { robotID: 'r-1', startTime: 0 }, { robotID: 'r-1', startTime: -5 }, { robotID: 'r-1', startTime: 1.5 },
  { robotID: 'r-1', startTime: '1789084000000' }, { robotID: 'r-1', startTime: '123.5' }, { robotID: 'r-1', startTime: '0x10' },
  { robotID: 'r-1', startTime: '1e3' }, { robotID: 'r-1', startTime: '  123  ' }, { robotID: 'r-1', startTime: '' },
  { robotID: 'r-1', startTime: ' ' }, { robotID: 'r-1', startTime: 'nope' }, { robotID: 'r-1', startTime: null },
  { robotID: 'r-1', startTime: true }, { robotID: 'r-1', startTime: {} }, { robotID: 'r-1', startTime: [1] },
  { robotID: 'r-1', startTime: 1e18 }, { robotID: 'r-1', endTime: '2026-01-01T00:00:00Z' },
  { robotID: 'r-1', startTime: 'ISO', skillID: 5 }, // schema order: skillID first
  { robotID: 'r-1', intent: 'i', rules: [{ field: 'intent', value: 'x' }] },
  { robotID: 'r-1', personID: 'p', rules: [{ field: 'personIDs', value: 'x' }] },
  { robotID: 'r-1', skillID: 's', rules: [{ field: 'skillID', value: 'x' }] },
  { robotID: 'r-1', intent: 'i', skillID: 's', rules: [{ field: 'skillID', value: 'x' }, { field: 'intent', value: 'y' }] },
  { robotID: 'r-1', rules: [{ field: 'intent', value: '' }] },
  { robotID: 'r-1', rules: [{ field: 'intent', value: 'a' }, { field: 'bogus', value: 'b' }] },
  { robotID: 'r-1', rules: [{ field: 'payload', value: null }] }, // passes joi
  { robotID: '', rules: [{ field: 'intent', value: '' }] },
];
for (const q of QUERIES) cmp('query', JSON.stringify(q), rqv.validate, validateQuery, q);

// ---------- validated event battery ----------
const EVENTS = [
  { robotID: 'R-1', sessionID: 's', timestamp: Date.now(), skillID: 'SK', intent: 'i', personIDs: ['p1'] },
  { robotID: 'R-1', sessionID: 's', skillID: 'SK' }, {}, { robotID: 'R' }, { sessionID: 's' }, { skillID: 'SK' },
  { robotID: 'bad id', sessionID: 's', skillID: 'SK' }, { robotID: 'R', sessionID: 'bad id', skillID: 'SK' },
  { robotID: 'R', sessionID: 's', skillID: 'bad id' }, { robotID: 'R', sessionID: '', skillID: 'SK' },
  { robotID: 'R', sessionID: 5, skillID: 'SK' }, { robotID: 'R', sessionID: 's', skillID: '' },
  { robotID: 'R', sessionID: 's', skillID: 'SK', intent: '' }, { robotID: 'R', sessionID: 's', skillID: 'SK', intent: 5 },
  { robotID: 'R', sessionID: 's', skillID: 'SK', intent: 'bad id' },
  { robotID: 'R', sessionID: 's', skillID: 'SK', personIDs: 'p1' }, { robotID: 'R', sessionID: 's', skillID: 'SK', personIDs: [] },
  { robotID: 'R', sessionID: 's', skillID: 'SK', personIDs: null }, { robotID: 'R', sessionID: 's', skillID: 'SK', personIDs: {} },
  { robotID: 'R', sessionID: 's', skillID: 'SK', personIDs: ['bad id'] },
  { robotID: 'R', sessionID: 's', skillID: 'SK', personIDs: ['ok-1', 'bad 2', 'bad 3'] },
  { robotID: 'R', sessionID: 's', skillID: 'SK', personIDs: [5] }, { robotID: 'R', sessionID: 's', skillID: 'SK', personIDs: [null] },
  { robotID: 'R', sessionID: 's', skillID: 'SK', personIDs: [''] }, { robotID: 'R', sessionID: 's', skillID: 'SK', personIDs: ['a', ''] },
  { robotID: 'R', sessionID: 's', skillID: 'SK', timestamp: 0 }, { robotID: 'R', sessionID: 's', skillID: 'SK', timestamp: -5 },
  { robotID: 'R', sessionID: 's', skillID: 'SK', timestamp: 1.5 }, { robotID: 'R', sessionID: 's', skillID: 'SK', timestamp: '  12 ' },
  { robotID: 'R', sessionID: 's', skillID: 'SK', timestamp: null }, { robotID: 'R', sessionID: 's', skillID: 'SK', timestamp: true },
  { robotID: 'R', sessionID: 's', skillID: 'SK', timestamp: '' }, { robotID: 'R', sessionID: 's', skillID: 'SK', timestamp: '2026-01-01T00:00:00Z' },
  { robotID: 'R', sessionID: 's', skillID: 'SK', payload: { a: 1 } }, { robotID: 'R', sessionID: 's', skillID: 'SK', payload: null },
  { robotID: 'R', sessionID: 's', skillID: 'SK', payload: 'x' }, { robotID: 'R', sessionID: 's', skillID: 'SK', payload: false },
  { robotID: 'R', sessionID: 's', skillID: 'SK', extra: 1 }, { robotID: 'R', sessionID: 's', skillID: 'SK', foo: 1, bar: 2 },
  { robotID: 'R', sessionID: 's', skillID: 'SK', payload: { a: 1 }, foo: 1 },
  { robotID: 'R', sessionID: 's', skillID: 'SK', personIDs: ['bad id'], payload: { a: 1 } },
  { robotID: 'R', sessionID: 's', skillID: 'SK', personIDs: ['bad id'], payload: { a: 1 }, zz: 1 },
  { robotID: '@be', sessionID: 's', skillID: 'SK' }, { robotID: 'R', sessionID: 's', skillID: '@be/x-y_z' },
];
for (const e of EVENTS) cmp('event', JSON.stringify(e), rev.validate, validateEvent, e);

// future-timestamp cases (time dependent: run both against the same now)
const future = Date.now() + 3600e3;
cmp('event-future', 'timestamp future', rev.validate, validateEvent, { robotID: 'R', sessionID: 's', skillID: 'SK', timestamp: future });
cmp('query-future', 'startTime future', rqv.validate, validateQuery, { robotID: 'r-1', startTime: future });

console.log(`compared ${pass + fails.length} inputs: ${pass} identical, ${fails.length} different`);
for (const f of fails.slice(0, 25)) console.log('DIFF', f.kind, f.label, '\n   ref :', JSON.stringify(f.ref), '\n   mine:', JSON.stringify(f.mine));
if (fails.length > 25) console.log(`... and ${fails.length - 25} more`);
process.exit(fails.length ? 1 : 0);
