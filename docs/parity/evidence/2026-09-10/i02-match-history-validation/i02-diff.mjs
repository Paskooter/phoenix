// I-02 case-by-case diff: pinned reference oracle (real compiled pegasus code) vs the LIVE Phoenix
// history service process, plus the BEFORE (pre-fix) run and the restart determinism check.
//
// Run: node i02-diff.mjs
import { readFileSync, writeFileSync } from 'node:fs';

const dir = new URL('.', import.meta.url);
const load = (f) => JSON.parse(readFileSync(new URL(f, dir), 'utf8'));

const ref = load('i02-ref-oracle.json');
const phx = load('i02-runtime-probe.json');
let before = null;
try { before = load('i02-runtime-probe-BEFORE.json'); } catch { /* optional */ }

// joi's date().max('now') message embeds the wall clock; normalise it so the comparison is stable.
const NOW = /\w{3} \w{3} \d{2} \d{4} [\d:]{8} GMT[+-]\d{4} \([^)]*\)/g;
const norm = (b) => {
  if (b === null || b === undefined || typeof b !== 'object') return b;
  if (b.type === 'ERROR') return { ERROR: String(b.data && b.data.message).replace(NOW, '<NOW>') };
  const canon = (v) => {
    if (Array.isArray(v)) return v.map(canon);
    if (v && typeof v === 'object') {
      const o = {};
      for (const k of Object.keys(v).sort()) o[k] = canon(v[k]);
      return o;
    }
    return v;
  };
  const o = canon(b);
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
  refMessage: c.envelope && c.envelope.message ? c.envelope.message.replace(NOW, '<NOW>') : undefined,
  phxMessage: p.envelope && p.envelope.message ? p.envelope.message.replace(NOW, '<NOW>') : undefined,
});

const pm1 = Object.fromEntries(phx.pass1.map((c) => [c.label, c]));
const pm2 = Object.fromEntries(phx.pass2.map((c) => [c.label, c]));
const pBefore = before ? Object.fromEntries(before.pass1.map((c) => [c.label, c])) : {};

const missing = ref.cases.filter((c) => !pm1[c.label]).map((c) => c.label);
// Labels starting with 'X' are the known-unverifiable section (needs a live mongod); they are
// reported separately and never counted in the parity verdict.
const isX = (label) => label.startsWith('X');
const parityCases = ref.cases.filter((c) => !isX(c.label));
const xCases = ref.cases.filter((c) => isX(c.label));
const cases = parityCases.map((c) => row(c, pm1[c.label]));
const statusDiffs = cases.filter((c) => !c.statusMatch);
const bodyDiffs = cases.filter((c) => c.statusMatch && !c.bodyMatch);
const unverifiable = xCases.map((c) => row(c, pm1[c.label])).filter((c) => !c.statusMatch || !c.bodyMatch);

// I-02's before/after: cases where Phoenix previously answered 200 with no validation at all.
const closed = before
  ? cases.filter((c) => pBefore[c.label] && pBefore[c.label].status !== c.refStatus && c.statusMatch)
    .map((c) => ({ label: c.label, referenceStatus: c.refStatus, phoenixBefore: pBefore[c.label].status, phoenixAfter: c.phxStatus }))
  : [];

const restart = {
  pass1Cases: phx.pass1.length,
  pass2Cases: phx.pass2.length,
  sameLabels: JSON.stringify(phx.pass1.map((c) => c.label).sort()) === JSON.stringify(phx.pass2.map((c) => c.label).sort()),
  statusesIdentical: phx.pass1.every((c) => pm2[c.label].status === c.status),
  bodiesIdentical: phx.pass1.every((c) => JSON.stringify(norm(c.body)) === JSON.stringify(norm(pm2[c.label].body))),
  startedLogs: [phx.startedLog1, phx.startedLog2],
};

const out = {
  oracle: ref.oracle,
  versions: { express: ref.express, joi: ref.joi, bodyParser: ref.bodyParser },
  modelCalls: ref.modelCalls,
  recordsAtEnd: ref.records,
  counts: {
    compared: cases.length, statusDiffs: statusDiffs.length, bodyDiffs: bodyDiffs.length,
    missingInPhoenix: missing.length, unverifiableDiffs: unverifiable.length,
  },
  restart,
  newlyClosedInI02: closed,
  statusDiffs,
  bodyDiffs,
  missingInPhoenix: missing,
  unverifiable,
  allCases: cases,
};
writeFileSync(new URL('i02-diff.json', dir), JSON.stringify(out, null, 2));
console.log('compared:', cases.length, '(reference cases:', ref.cases.length, ')');
console.log('status diffs:', statusDiffs.length, statusDiffs.map((c) => `${c.refStatus}/${c.phxStatus} ${c.label}`));
console.log('body diffs (same status):', bodyDiffs.length, bodyDiffs.map((c) => c.label));
console.log('missing in phoenix:', missing);
console.log('unverifiable (X-) diffs:', unverifiable.length, unverifiable.map((c) => `${c.refStatus}/${c.phxStatus} ${c.label}`));
console.log('newly closed in I-02:', closed.length, closed.map((c) => c.label));
console.log('restart:', JSON.stringify(restart));
