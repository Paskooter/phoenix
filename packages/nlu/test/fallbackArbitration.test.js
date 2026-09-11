// N-07: fallback arbitration must match the pinned restored Pegasus source
// jiboV2/pegasus@715e0dd0719ecca5164959d713862a1402430623:
//   packages/parser/src/handlers/ParseRequestHandler.ts (getNLUResult / selectValidResult)
//
// The matrix is driven by recorded provider outputs
// (fixtures/fallback-provider-recordings.json) plus the pinned 5c0a739
// ParseRequestHandler EMPTY_NLU shape.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  selectValidResult, isParserResultValid, isFallbackResultValid, isHighPriority, resolveHybridNLU, EMPTY_NLU,
} from '../src/fallbackArbitration.js';
import { DECOY_INTENT } from '../src/externalAgents.js';
import { LLM_INTENT_TOOLS } from '../src/llmFallback.js';

const recordings = JSON.parse(readFileSync(new URL('./fixtures/fallback-provider-recordings.json', import.meta.url)));
const fb = recordings.fallbackResults;

const parserHigh = { nlu: { intent: 'timerValue', entities: { minutes: '5' }, rules: ['clock/timer_set_value'] }, priority: 'HIGH' };
const parserLow = { nlu: { intent: 'requestTellJiboContent', entities: { JiboContent: 'Joke' }, rules: ['launch'] }, priority: 'LOW' };
const parserSkip = { nlu: { intent: 'right', entities: { domain: 'gui_command' }, rules: ['globals/gui_nav'] }, priority: 'SKIP' };
const parserNoIntent = { nlu: { intent: null, entities: { skill: '@be/clock' }, rules: ['launch'] }, priority: 'LOW' };

test('parser validity is intent-present and not SKIP', () => {
  assert.equal(isParserResultValid(parserHigh), true);
  assert.equal(isParserResultValid(parserLow), true);
  assert.equal(isParserResultValid(parserSkip), false);
  assert.equal(isParserResultValid(parserNoIntent), false);
  assert.equal(isParserResultValid(null), false);
  assert.equal(isHighPriority(parserHigh), true);
  assert.equal(isHighPriority(parserLow), false);
  assert.equal(isHighPriority(parserSkip), false);
});

test('fallback validity rejects absent, intentless and decoy results', () => {
  assert.equal(isFallbackResultValid(null), false);                    // absent
  assert.equal(isFallbackResultValid(fb.invalidNoIntent), false);      // invalid
  assert.equal(isFallbackResultValid(fb.decoy), false);                // decoy
  assert.equal(isFallbackResultValid(fb.validLow), true);
  assert.equal(DECOY_INTENT, 'decoyIntent');
});

test('HIGH short-circuits; the fallback is only consulted on miss or LOW', async () => {
  // ParseRequestHandler.ts:67-70 — a valid HIGH result is returned as-is and the
  // fallback is NEVER evaluated.
  let fallbackCalls = 0;
  const high = await resolveHybridNLU(parserHigh, () => { fallbackCalls += 1; return fb.validLow; });
  assert.equal(high.intent, 'timerValue');
  assert.equal(fallbackCalls, 0);

  // LOW + valid fallback -> fallback wins (ParseRequestHandler.ts:93-96)
  assert.equal((await resolveHybridNLU(parserLow, () => fb.validLow)).intent, 'tellAJoke');
  // LOW + absent fallback -> parser survives
  assert.equal((await resolveHybridNLU(parserLow, () => null)).intent, 'requestTellJiboContent');
  // miss + fallback -> fallback
  assert.equal((await resolveHybridNLU(null, () => fb.validLow)).intent, 'tellAJoke');
  // miss + a throwing fallback -> EMPTY (the handler's .catch -> null)
  assert.deepEqual(await resolveHybridNLU(null, () => { throw new Error('dead'); }), EMPTY_NLU);
});

test('selectValidResult matrix over recorded parser/fallback outputs', () => {
  // both valid (parser LOW) -> the FALLBACK wins (ParseRequestHandler.ts:93-96)
  assert.equal(selectValidResult(parserLow, fb.validLow), fb.validLow);
  // parser valid only -> parser.nlu (:97-100)
  assert.deepEqual(selectValidResult(parserLow, null), parserLow.nlu);
  // fallback valid only -> fallback (:101-104)
  assert.equal(selectValidResult(null, fb.validLow), fb.validLow);
  // neither -> EMPTY_NLU (:105)
  assert.deepEqual(selectValidResult(null, null), EMPTY_NLU);
  assert.deepEqual(selectValidResult(null, null), { intent: null, entities: null, rules: [] });
  // an invalid parser (SKIP) with a valid fallback -> fallback
  assert.equal(selectValidResult(parserSkip, fb.validLow), fb.validLow);
  // an invalid/decoy fallback never wins: the LOW parser survives
  assert.deepEqual(selectValidResult(parserLow, fb.decoy), parserLow.nlu);
  assert.deepEqual(selectValidResult(parserLow, fb.invalidNoIntent), parserLow.nlu);
  // an invalid parser and an invalid fallback -> EMPTY
  assert.deepEqual(selectValidResult(parserSkip, fb.decoy), EMPTY_NLU);
});

test('archived Dialogflow intent/entity catalog is pinned and the fallback catalog is not derived from it', () => {
  const catalog = JSON.parse(readFileSync(new URL('./fixtures/dialogflow-agent-catalog.json', import.meta.url)));
  assert.equal(catalog.provenance.ref, '5c0a7390539663ba749d360de348a428c088505c');
  assert.equal(catalog.provenance.path, 'packages/parser/dialogflow/main_agent');
  assert.equal(catalog.intentCount, 99);
  assert.equal(catalog.entityCount, 89);
  assert.equal(catalog.intents.length, 99);
  assert.equal(catalog.entities.length, 89);
  // decoyIntent is a real archived intent (DialogflowClient.ts:13 DECOY_INTENT).
  const decoy = catalog.intents.find(i => i.intent === 'decoyIntent');
  assert.ok(decoy, 'decoyIntent present in the archived catalog');
  assert.match(decoy.sha256, /^[0-9a-f]{64}$/);

  // The restored LLM catalog is its own list; only yes/no collide with the
  // archived Dialogflow intents. Recorded as divergence candidate N-07-D1.
  const archived = new Set(catalog.intents.map(i => i.intent));
  const overlap = LLM_INTENT_TOOLS.map(t => t.name).filter(n => archived.has(n)).sort();
  assert.deepEqual(overlap, ['no', 'yes']);
  assert.deepEqual(overlap, recordings.catalogCoverage.archivedDialogflowIntentsPresentInBoth.slice().sort());
});
