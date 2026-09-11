// S-04 runtime differential: Phoenix's MIM/JCP protocol builders vs the pinned requester.
//
// Executes the actual pinned dependencies from the prepared reference tree and compares them with
// Phoenix's in-memory output, id-masked. This is the executable half of the S-04 evidence; the
// committed unit test packages/skills/test/s04MimContracts.test.js pins the same shapes without
// depending on the reference tree.
//
//   node scripts/parity-s04/mim-contract-diff.mjs
//   PARITY_REFERENCE_TREE=/path/to/prepared/reference node scripts/parity-s04/mim-contract-diff.mjs
//
// Pinned source (approved reference revision 5c0a7390539663ba749d360de348a428c088505c):
//   node_modules/jibo-command-requester/lib/jibo-command-requester.js  (4.0.6-home)
//   node_modules/jibo-cai-utils/lib/jibo-cai-utils.js:1183-1201

import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import assert from 'node:assert/strict';
import {
  playProtocol, listenProtocol, displayProtocol, slimProtocol, sequenceProtocol, parallelProtocol,
} from '../../packages/skills/src/graph/mims/protocol.js';
import { weightedSample } from '../../packages/skills/src/graph/mims/slimmer.js';

const DEFAULT_TREE = '/home/shell/work/phoenix/.parity/reference/5c0a7390539663ba749d360de348a428c088505c';
const tree = process.env.PARITY_REFERENCE_TREE || DEFAULT_TREE;
if (!existsSync(tree)) {
  console.error(`prepared reference tree not found: ${tree}`);
  process.exitCode = 2;
  process.exit();
}
const require = createRequire(import.meta.url);
const req = require(`${tree}/node_modules/jibo-command-requester/lib/jibo-command-requester.js`);
const cai = require(`${tree}/node_modules/jibo-cai-utils/lib/jibo-cai-utils.js`);
const v2 = req.v2;

const mask = (value) => {
  if (Array.isArray(value)) return value.map(mask);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = k === 'id' ? '<id>' : mask(v);
    return out;
  }
  return value;
};
const wire = (value) => mask(JSON.parse(JSON.stringify(value)));

const failures = [];
const checks = [];
function check(name, fn) {
  try { fn(); checks.push({ name, result: 'match' }); }
  catch (error) { failures.push({ name, error: error.message }); checks.push({ name, result: 'differs' }); }
}

check('PLAY shape matches the pinned requester', () => {
  const theirs = v2.play.Play.generateProtocol('hi', true);
  const ours = playProtocol('hi', true);
  assert.deepEqual(Reflect.ownKeys(ours), Reflect.ownKeys(theirs));
  assert.deepEqual(wire(ours), wire(theirs));
  assert.deepEqual(Object.keys(ours), ['id', 'type', 'autoRuleConfig', 'speakOptions', 'esml']);
});

check('LISTEN shape matches the pinned requester', () => {
  const single = v2.listen.Listen.generateProtocol('rules/en-us/global.fst');
  assert.deepEqual(Reflect.ownKeys(listenProtocol('rules/en-us/global.fst')), Reflect.ownKeys(single));
  assert.deepEqual(wire(listenProtocol('rules/en-us/global.fst')), wire(single));
  const many = v2.listen.Listen.generateProtocol(['a', 'b']);
  assert.deepEqual(wire(listenProtocol(['a', 'b'])), wire(many));
});

check('DISPLAY shape matches the pinned requester (Slimmer call signature)', () => {
  const view = { type: 'SKILL', name: 'MIM_VIEW', context: null };
  const cancel = [{ type: 'HIDE_DISPLAY', name: 'HIDE_MIM_VIEW' }];
  const theirs = v2.display.Display.generateProtocol('PEGASUS_VIEW', view, 0, true, false, cancel);
  const ours = displayProtocol('PEGASUS_VIEW', view, 0, true, false, cancel);
  assert.deepEqual(Reflect.ownKeys(ours), Reflect.ownKeys(theirs));
  assert.deepEqual(wire(ours), wire(theirs));
  assert.deepEqual(Object.keys(ours), ['id', 'type', 'name', 'view', 'layer', 'overlay', 'visible', 'keepDisplay', 'onCancel']);
});

check('SLIM / SEQUENCE / PARALLEL shapes match the pinned requester', () => {
  const play = v2.play.Play.generateProtocol('hi', true);
  const theirs = v2.slim.SLIM.generateProtocol({ play });
  const ours = slimProtocol({ play });
  assert.deepEqual(Reflect.ownKeys(ours), Reflect.ownKeys(theirs));
  assert.deepEqual(wire(ours), wire(theirs));

  const seq = v2.structural.Sequence.generateProtocol([theirs]);
  const ourSeq = sequenceProtocol([ours]);
  assert.deepEqual(Reflect.ownKeys(ourSeq), Reflect.ownKeys(seq));
  assert.deepEqual(wire(ourSeq), wire(seq));

  const par = v2.structural.Parallel.generateProtocol([theirs]);
  const ourPar = parallelProtocol([ours]);
  assert.deepEqual(Reflect.ownKeys(ourPar), Reflect.ownKeys(par));
  assert.deepEqual(wire(ourPar), wire(par));
  assert.equal(ourPar.succeedOnFirst, false);
});

check('command IDs match the requester transaction-ID format', () => {
  const theirs = v2.play.Play.generateProtocol('hi', true).id;
  assert.match(theirs, /^[0-9a-f]{32}$/, 'requester emits 32 lowercase hex under Node');
  const seen = new Set();
  for (let i = 0; i < 64; i++) seen.add(playProtocol('hi', true).id);
  assert.equal(seen.size, 64, 'ids are not reused');
});

check('weightedSample matches RandomUtils.weightedRandomSample with Math.random pinned', () => {
  const source = cai.RandomUtils.weightedRandomSample;
  const vectors = [
    [1, 3], [3, 1], [0, 0], [-1, -1], [0, 1], [1, 0], [-2, 3], [1, 1, 1], [2, 0, 3, -1, 4],
    [0.5, 0.5], [1, 1], [5], [0.25, 0.25, 0.5],
  ];
  const randoms = [];
  for (let step = 0; step <= 100; step++) randoms.push(step / 100); // includes the exact bounds
  const original = Math.random;
  let compared = 0;
  let differsAtSource = 0;
  try {
    for (const weights of vectors) {
      const items = weights.map((w, i) => ({ data: `d${i}`, weight: w }));
      for (const r of randoms) {
        Math.random = () => r;
        const theirs = source(items);
        const ours = weightedSample(items, () => r);
        compared++;
        try { assert.deepEqual(ours, theirs); }
        catch { differsAtSource++; failures.push({ name: `weightedSample weights=${JSON.stringify(weights)} r=${r}`, error: `ours=${JSON.stringify(ours)} theirs=${JSON.stringify(theirs)}` }); }
      }
    }
  } finally { Math.random = original; }
  assert.equal(differsAtSource, 0, `${differsAtSource}/${compared} sampled points differ`);
  assert.ok(compared >= 1300, `compared ${compared} sampled points`);
  checks.push({ name: `weightedSample sampled points compared: ${compared}`, result: 'match' });
});

for (const c of checks) console.log(`${c.result === 'match' ? 'ok  ' : 'FAIL'} ${c.name}`);
if (failures.length) {
  console.error(`\n${failures.length} differential failure(s):`);
  for (const f of failures.slice(0, 20)) console.error(`  - ${f.name}: ${f.error}`);
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({ result: 'match', checks: checks.length, referenceTree: tree }));
}
