// Corpus runner — drives the vendored reference test-manifest (4,705 entries, the
// chitchat/hub regression corpus: command[] -> {intent, entities, memo, mimId}) through
// the in-process Phoenix NLU + IntentRouter and grades parity at two diff levels:
//   D3 (routing): parsed intent == expected intent (null-normalized; the manifest has
//       intent-less entries that must produce NO launch)
//   D4 (mim):     the matched manifest entry's memo.mim == expected mimId
// This is the verification-strategy corpus runner (atlas verification-strategy.md §1.4),
// minus audio: utterances are injected at the CLIENT_ASR text level, exactly like the
// reference hub-client-cli harness.
//
// Usage: node packages/harness/src/corpusRunner.js [--limit N] [--offset N] [--out FILE]
//        [--misses-only]  (writes a JSON mismatch report; prints a summary table)

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '@phoenix/nlu';
import { loadRegistry } from '../../gateway/src/registry.js';
import { IntentRouter } from '../../gateway/src/intentRouter.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MANIFEST = join(HERE, '..', 'resources', 'test-manifest.json');

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
}
const LIMIT = Number(arg('limit', 0)) || 0;
const OFFSET = Number(arg('offset', 0)) || 0;
const OUT = arg('out', '/tmp/phx-corpus-report.json');

export async function runCorpus({ limit = LIMIT, offset = OFFSET, log = console.error } = {}) {
  const tests = JSON.parse(readFileSync(MANIFEST, 'utf8')).tests;
  const slice = tests.slice(offset, limit ? offset + limit : undefined);
  const registry = loadRegistry({});       // returns the skill-config array directly
  const router = new IntentRouter(registry);

  const stats = { entries: 0, utterances: 0, d3Intent: 0, d4Mim: 0, noMatchOk: 0, noMatchTotal: 0 };
  const misses = [];
  let done = 0;

  for (const t of slice) {
    stats.entries += 1;
    const wantIntent = t.intent || null;
    const wantMim = t.mimId || (t.memo && t.memo.mim) || null;
    for (const cmd of t.command || []) {
      stats.utterances += 1;
      const nlu = await parse(cmd);
      const gotIntent = nlu.intent || null;

      if (!wantIntent) {
        // intent-less manifest entries: correct behavior is NO launch routing
        stats.noMatchTotal += 1;
        const decision = router.getSkillIDFromNLU({ ...nlu, rules: ['launch'] });
        if (!gotIntent && !decision) { stats.noMatchOk += 1; }
        else misses.push({ cmd, want: null, got: gotIntent, skill: decision && decision.skillID, kind: 'expected-no-match' });
        continue;
      }

      const intentOk = gotIntent === wantIntent;
      if (intentOk) stats.d3Intent += 1;

      // D4: route and compare the matched entry's memo.mim
      let mimOk = false; let gotMim = null; let gotSkill = null;
      const decision = router.getSkillIDFromNLU({ intent: gotIntent, rules: ['launch'], entities: nlu.entities || {} });
      if (decision) { gotSkill = decision.skillID; gotMim = decision.memo && decision.memo.mim; }
      if (wantMim && gotMim === wantMim) { mimOk = true; stats.d4Mim += 1; }
      else if (!wantMim) { mimOk = intentOk; if (mimOk) stats.d4Mim += 1; }

      if (!intentOk || !mimOk) {
        misses.push({ cmd, want: wantIntent, got: gotIntent, wantMim, gotMim, skill: gotSkill, group: t.testGroup });
      }
    }
    done += 1;
    if (done % 250 === 0) log(`  ...${done}/${slice.length} entries (D3 ${pct(stats.d3Intent, stats.utterances - stats.noMatchTotal)}%)`);
  }
  return { stats, misses };
}

function pct(n, d) { return d ? Math.round((1000 * n) / d) / 10 : 0; }

if (import.meta.url === `file://${process.argv[1]}`) {
  const t0 = Date.now();
  runCorpus({}).then(({ stats, misses }) => {
    const graded = stats.utterances - stats.noMatchTotal;
    console.log(`\n==== corpus parity (${((Date.now() - t0) / 1000).toFixed(0)}s) ====`);
    console.log(`entries:    ${stats.entries}   utterances: ${stats.utterances}`);
    console.log(`D3 intent:  ${stats.d3Intent}/${graded} (${pct(stats.d3Intent, graded)}%)`);
    console.log(`D4 mim:     ${stats.d4Mim}/${graded} (${pct(stats.d4Mim, graded)}%)`);
    console.log(`no-match:   ${stats.noMatchOk}/${stats.noMatchTotal} correct`);
    writeFileSync(OUT, JSON.stringify({ stats, misses }, null, 1));
    console.log(`misses: ${misses.length} -> ${OUT}`);
  }).catch((e) => { console.error(e); process.exit(1); });
}
