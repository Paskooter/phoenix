import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { loadCorpora, expandCorpus, decodeCorpus } from '../src/corpusManifest.js';

test('all three frozen corpora retain their original occurrence and conditional denominators', () => {
  const corpora = loadCorpora();
  assert.deepEqual(corpora.map(c => c.id), ['chitchat', 'hub-client', 'report']);
  assert.deepEqual(corpora.map(c => c.tests.length), [4705, 2573, 6]);
  const fixtures = corpora.map(c => expandCorpus(c));
  assert.deepEqual(fixtures.map(cases => cases.filter(c => c.variant === 'base').length), [10035, 7029, 73]);
  assert.deepEqual(fixtures.map(cases => cases.filter(c => c.variant === 'conditional').length), [1397, 1973, 0]);
  assert.equal(new Set(fixtures.flat().map(c => c.id)).size, 20507);
  assert.equal(new Set(fixtures.flat().map(c => c.command)).size, 10360);
});

test('missing intent is an absent expectation, including the archived hub-client MIM cases', () => {
  const hub = loadCorpora().find(c => c.id === 'hub-client');
  assert.equal(hub.tests.filter(c => !Object.hasOwn(c, 'intent')).length, 138);
  const fixture = expandCorpus(hub).find(c => c.command === 'do you have gloves');
  assert.equal(Object.hasOwn(fixture.manifestEntry, 'intent'), false);
  assert.equal(fixture.manifestEntry.mimId, 'RI_JBO_HasClothesWinterArms');
});

test('duplicate commands and conditional values remain independent fixture instances', () => {
  const entry = { command: ['same', 'same'], intent: null, entities: [], memo: false,
    conditionalTests: [{ condition: { date: '2018-01-01', loopMemberId: 'uid0001' }, promptID: ['p1', 'p2'], smoke: false }] };
  const cases = expandCorpus({ id: 'example', tests: [entry] });
  assert.equal(cases.length, 4);
  assert.equal(new Set(cases.map(c => c.id)).size, 4);
  assert.deepEqual(cases[1].conditional, entry.conditionalTests[0]);
  assert.equal(cases[0].manifestEntry.intent, null);
  assert.equal(cases[0].manifestEntry.memo, false);
  cases[1].manifestEntry.command.push('changed');
  assert.deepEqual(entry.command, ['same', 'same']);
  assert.deepEqual(cases[0].manifestEntry.command, ['same', 'same']);
});

test('changed corpus bytes and invalid input shapes cannot enter a grade silently', () => {
  const bytes = Buffer.from('{"tests":[{"command":["original"]}]}');
  const hash = data => createHash('sha256').update(data).digest('hex');
  assert.equal(decodeCorpus(bytes, hash(bytes)).tests.length, 1);
  assert.throws(() => decodeCorpus(Buffer.from('{"tests":[]}'), hash(bytes)), /frozen source hash/);
  const invalid = Buffer.from('{"tests":[{"command":false}]}');
  assert.throws(() => decodeCorpus(invalid, hash(invalid)), /Invalid command array/);
});
