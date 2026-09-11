// N-07: the fallback/external matrix must hold for EVERY supported NLU profile,
// not just the default AST path.
//
// Phoenix supports two observable parser profiles (compiledFstRuntime.js:1-13):
//   - 'ast'                — the default; no binary artifacts required
//   - 'compiled-fst-approved' — the archived production profile, provisioned out
//     of band (Phoenix cannot ship the binary graphs in git). Three acquisition
//     contracts all produce this same runtime: approved home, portable snapshot
//     manifest, source-faithful directory glob.
//
// The fallback arbitration and the external-agent attachment run at the
// ParseRequestHandler layer, AFTER profile selection, so the contract is
// profile-independent. This file pins that claim at runtime under the
// provisioned compiled profile when one is discoverable, and always pins the
// profile-load failure contract that makes a per-rule request-time failure
// unreachable.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

// A compiled profile is provisioned out of band: PHOENIX_NLU_COMPILED_HOME, or
// the default runtime/nlu-compiled when an installer receipt is already present
// (compiledFstHome.js:108-117).
function provisionedCompiledHome() {
  const configured = process.env.PHOENIX_NLU_COMPILED_HOME;
  if (configured && existsSync(join(configured, 'receipt.json'))) return configured;
  const fallback = join(REPO_ROOT, 'runtime', 'nlu-compiled');
  if (existsSync(join(fallback, 'receipt.json'))) return fallback;
  return null;
}

test('a graph the compiled profile cannot load aborts selection instead of dropping a rule', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'n07-compiled-'));
  const savedRuntime = process.env.PHOENIX_NLU_RUNTIME;
  const savedHome = process.env.PHOENIX_NLU_COMPILED_HOME;
  const savedDirs = process.env.PHOENIX_NLU_COMPILED_FST_DIRECTORIES;
  try {
    mkdirSync(join(dir, 'graphs'));
    writeFileSync(join(dir, 'graphs', 'broken.fst'), 'not-an-fst\n');
    delete process.env.PHOENIX_NLU_COMPILED_HOME;
    process.env.PHOENIX_NLU_RUNTIME = 'compiled-fst';
    process.env.PHOENIX_NLU_COMPILED_FST_DIRECTORIES = join(dir, 'graphs');
    const { getCompiledFstRuntime } = await import('../src/compiledFstRuntime.js');
    // RobustParserClient.loadAllFSTs() must not reach RUNNING with a dropped rule
    // (compiledFstRuntime.js:610-634, preloadRuleExecutors); a malformed graph
    // rejects profile construction rather than being skipped on the request that
    // names it.
    assert.throws(() => getCompiledFstRuntime(), /Malformed compiled NLU FST/);
  } finally {
    if (savedRuntime === undefined) delete process.env.PHOENIX_NLU_RUNTIME; else process.env.PHOENIX_NLU_RUNTIME = savedRuntime;
    if (savedHome === undefined) delete process.env.PHOENIX_NLU_COMPILED_HOME; else process.env.PHOENIX_NLU_COMPILED_HOME = savedHome;
    if (savedDirs === undefined) delete process.env.PHOENIX_NLU_COMPILED_FST_DIRECTORIES; else process.env.PHOENIX_NLU_COMPILED_FST_DIRECTORIES = savedDirs;
    rmSync(dir, { recursive: true, force: true });
  }
});

const compiledHome = provisionedCompiledHome();
if (compiledHome) {
  process.env.PHOENIX_NLU_RUNTIME = 'compiled-fst';
  process.env.PHOENIX_NLU_COMPILED_HOME = compiledHome;
}

test(
  'the fallback/external matrix is identical under the provisioned compiled-fst profile',
  { skip: compiledHome ? false : 'no provisioned compiled-fst home: set PHOENIX_NLU_COMPILED_HOME or run scripts/install-nlu-compiled-graphs.mjs' },
  async () => {
    const { defaultParserProfile, compiledFstRuntimeConfig } = await import('../src/compiledFstRuntime.js');
    const { parseRequest } = await import('../src/requestParser.js');
    const { DISABLED_EXTERNAL_ERROR, EXTERNAL_ATTACHMENT_REVISION } = await import('../src/externalAgents.js');
    const { resolveHybridNLU, selectValidResult } = await import('../src/fallbackArbitration.js');

    assert.equal(defaultParserProfile(), 'compiled-fst-approved');
    // Every named rule is materialised before the profile is handed out.
    const config = compiledFstRuntimeConfig();
    assert.equal(config.runtime, 'compiled-fst');
    assert.equal(config.referenceRevision, '5c0a7390539663ba749d360de348a428c088505c');
    assert.equal(config.ruleCount, 98);
    assert.equal(config.allNamedRulesLoaded, true);
    assert.equal(config.loadedRuleCount, config.ruleCount);

    // Stage 1 still selects a real archived rule through the compiled runtime.
    const timer = parseRequest({ text: 'five minutes', rules: ['clock/timer_set_value'] });
    assert.equal(timer.intent, 'timerValue');
    assert.deepEqual(timer.entities, { hours: 'null', minutes: '5', seconds: 'null', domain: 'timer' });

    // The disabled-provider external boundary is unchanged (5c0a739).
    assert.throws(
      () => parseRequest({ text: 'five minutes', rules: ['clock/timer_set_value'], external: {} }),
      error => error.message === DISABLED_EXTERNAL_ERROR,
    );
    // ... and the ratified 715e0dd0 omission is selectable here too.
    const omitted = parseRequest(
      { text: 'five minutes', rules: ['clock/timer_set_value'], external: {} },
      { externalAttachmentRevision: EXTERNAL_ATTACHMENT_REVISION.OMIT },
    );
    assert.equal('external' in omitted, false);
    assert.equal(omitted.intent, 'timerValue');

    // A requested rule the compiled registry does not know is dropped and the
    // remaining requested rule still arbitrates (the same contract as AST).
    const withUnknown = parseRequest({ text: 'five minutes', rules: ['clock/timer_set_value', 'no/such/rule'] });
    assert.equal(withUnknown.intent, 'timerValue');

    // The fallback arbitration matrix is profile-independent: it is the same
    // exported contract, exercised here while compiled-fst is the active profile.
    const parserLow = { nlu: { intent: 'requestTellJiboContent', entities: { JiboContent: 'Joke' }, rules: ['launch'] }, priority: 'LOW' };
    const fallback = { intent: 'tellAJoke', entities: {}, rules: ['launch'] };
    assert.equal((await resolveHybridNLU(parserLow, () => fallback)).intent, 'tellAJoke');
    assert.deepEqual(selectValidResult(parserLow, { intent: 'decoyIntent', entities: {}, rules: [] }), parserLow.nlu);
    assert.deepEqual(await resolveHybridNLU(null, () => { throw new Error('dead provider'); }),
      { intent: null, entities: null, rules: [] });
  },
);
