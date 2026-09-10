// I-01 case-by-case diff: pinned reference oracle (real compiled pegasus code) vs the LIVE
// Phoenix history service process, plus a before/after restart check.
//
// Run: node w7-diff.mjs
import { readFileSync, writeFileSync } from 'node:fs';

const dir = new URL('.', import.meta.url);
const load = (f) => JSON.parse(readFileSync(new URL(f, dir), 'utf8'));

const ref = load('w7-ref-routes-oracle.json');
const phx = load('w7-runtime-probe.json');
const before = load('w7-runtime-probe-BEFORE.json');

const norm = (b) => {
  if (b === null || b === undefined || typeof b !== 'object') return b;
  if (b.type === 'ERROR') return { ERROR: b.data && b.data.message };
  const o = { ...b };
  delete o.id; delete o.msgID; delete o.ts;
  return o;
};

const row = (c, p) => ({
  label: c.label,
  refStatus: c.status,
  phxStatus: p.status,
  statusMatch: c.status === p.status,
  refBody: norm(c.body),
  phxBody: norm(p.body),
  bodyMatch: JSON.stringify(norm(c.body)) === JSON.stringify(norm(p.body)),
});

const pm1 = Object.fromEntries(phx.pass1.map((c) => [c.label, c]));
const pm2 = Object.fromEntries(phx.pass2.map((c) => [c.label, c]));
const pBefore = Object.fromEntries(before.pass1.map((c) => [c.label, c]));

const cases = ref.cases.map((c) => row(c, pm1[c.label]));
const statusDiffs = cases.filter((c) => !c.statusMatch);
const bodyDiffs = cases.filter((c) => c.statusMatch && !c.bodyMatch);

// Cases the reference oracle cannot exercise (HistoryService subclass needs Mongo) are excluded
// from the body comparison but still listed.
const restart = {
  pass1Cases: phx.pass1.length,
  pass2Cases: phx.pass2.length,
  sameLabels: JSON.stringify(phx.pass1.map((c) => c.label).sort()) === JSON.stringify(phx.pass2.map((c) => c.label).sort()),
  statusesIdentical: phx.pass1.every((c) => pm2[c.label].status === c.status),
  bodiesIdentical: phx.pass1.every((c) => JSON.stringify(norm(c.body)) === JSON.stringify(norm(pm2[c.label].body))),
  startLogs: [phx.startedLog1, phx.startedLog2],
};

// The gap that was open before this worktree: reference 500 vs Phoenix 200 null.
const gapCases = ['PUT /v1/skill/launch/payload NO payload key, no match', 'PUT /v1/skill/launch/payload payload null, no match'];
const gap = gapCases.map((l) => ({
  label: l,
  ref: ref.cases.find((c) => c.label === l)?.status,
  phoenixBefore: pBefore[l]?.status,
  phoenixAfter: pm1[l]?.status,
}));

const out = { restart, gapClosed: gap, statusDiffs, bodyDiffs, allCases: cases };
writeFileSync(new URL('w7-diff.json', dir), JSON.stringify(out, null, 2));
console.log('total cases compared:', cases.length);
console.log('status diffs:', statusDiffs.length, statusDiffs.map((c) => `${c.refStatus}/${c.phxStatus} ${c.label}`));
console.log('body diffs (same status):', bodyDiffs.length, bodyDiffs.map((c) => c.label));
console.log('restart:', JSON.stringify(restart));
console.log('gap closed:', JSON.stringify(gap, null, 1));
