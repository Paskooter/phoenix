// N-08 / D-N08b — source routing differential for the legacy parse() wrapper.
//
// The vendored reference manifest has exactly 14 rows in this bucket: four
// whatDoesThingMean utterances and ten whoIsPerson utterances. The source launch
// union returns those chitchat intents. Phoenix's answer-skill continuity remains
// available only through an explicit per-call profile because the answer path is
// a chosen B6 divergence, not the compatibility default.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '../src/index.js';
import { parseRequest } from '../src/requestParser.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(HERE, '../../harness/resources/test-manifest.json'), 'utf8'));
const sourceIntents = new Set(['whatDoesThingMean', 'whoIsPerson']);
const rows = manifest.tests.flatMap(testCase => (testCase.command || [])
  .filter(command => sourceIntents.has(testCase.intent))
  .map(command => ({ command, intent: testCase.intent })));

test('N-08 D-N08b has the source-backed 14-row legacy parse differential', async () => {
  assert.equal(rows.length, 14);
  const counts = rows.reduce((all, row) => {
    all[row.intent] = (all[row.intent] || 0) + 1;
    return all;
  }, {});
  assert.deepEqual(counts, { whatDoesThingMean: 4, whoIsPerson: 10 });

  for (const row of rows) {
    const result = await parse(row.command);
    assert.equal(result.intent, row.intent, row.command);
    assert.equal(Object.hasOwn(result.entities, 'intent'), false, `${row.command}: intent leaked`);
    assert.equal(Object.hasOwn(result.entities, 'priority'), false, `${row.command}: priority leaked`);
  }
});

test('N-08 D-N08b opt-in continuity rewrites only the configured GQA profile', async () => {
  for (const row of rows) {
    const result = await parse(row.command, { gqaContinuity: true });
    const expected = row.intent === 'whoIsPerson' ? 'generalWhoQuestions' : 'generalWhatQuestions';
    assert.equal(result.intent, expected, row.command);
    assert.equal(Object.hasOwn(result.entities, 'intent'), false, `${row.command}: intent leaked`);
    assert.equal(Object.hasOwn(result.entities, 'priority'), false, `${row.command}: priority leaked`);
  }
});

test('N-08 D-N08b keeps the explicit continuity flag closed unless true', async () => {
  const defaultResult = await parse('who is ada lovelace');
  const falseResult = await parse('who is ada lovelace', { gqaContinuity: false });
  assert.equal(defaultResult.intent, 'whoIsPerson');
  assert.equal(falseResult.intent, 'whoIsPerson');
  assert.equal((await parse('will it rain today')).intent, 'requestWeather');
  assert.equal((await parse('will it rain today', { gqaContinuity: false })).intent, 'requestWeather');
});

test('N-08 parser-only entity fields are clean at the source request boundary', () => {
  const result = parseRequest({ text: 'who is ada lovelace', rules: ['launch'] });
  assert.equal(result.intent, 'whoIsPerson');
  assert.equal(Object.hasOwn(result.entities, 'intent'), false);
  assert.equal(Object.hasOwn(result.entities, 'priority'), false);
});

test('N-08 D-N08b weather continuity is separately opt-in', async () => {
  assert.equal((await parse('will it rain today')).intent, 'requestWeather');
  const result = await parse('will it rain today', { gqaContinuity: true });
  assert.equal(result.intent, 'requestWeatherPR');
  assert.equal(Object.hasOwn(result.entities, 'intent'), false);
  assert.equal(Object.hasOwn(result.entities, 'priority'), false);
});
