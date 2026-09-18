import test from 'node:test';
import assert from 'node:assert/strict';
import { makeParser, makeSkill, percentiles } from './peers.mjs';

 test('parser measures pending and settled work and preserves trace', async () => {
  const parser = makeParser({ delayMs: 5 });
  const trace = { transId: 'synthetic-turn' };
  const promise = parser.handleNLU({ text: 'hello' }, trace);
  assert.equal(parser.calls[0].settledAt, null);
  assert.deepEqual(parser.calls[0].trace, trace);
  await promise;
  assert.ok(parser.calls[0].settledAt >= parser.calls[0].startedAt);
  assert.equal(Object.hasOwn(parser.calls[0], 'aborted'), false, 'do not invent cancellation telemetry');
});

test('skill implements the actual launchOrUpdate interface and output envelope', async () => {
  const skill = makeSkill({ delayMs: 5 });
  const input = { context: { general: { robotID: 'synthetic-robot' } } };
  const trace = { transId: 'synthetic-turn' };
  const output = await skill.launchOrUpdate('fixture-skill', input, trace, false);
  assert.equal(output.response.type, 'SKILL_ACTION');
  assert.equal(output.response.data.skill.id, 'fixture-skill');
  assert.equal(skill.calls[0].input.context.general.robotID, 'synthetic-robot');
  assert.deepEqual(skill.calls[0].trace, trace);
  assert.ok(skill.calls[0].settledAt >= skill.calls[0].startedAt);
});

test('peer failures settle observably', async () => {
  const parser = makeParser({ fail: { message: 'unavailable' } });
  await assert.rejects(parser.handleNLU({}), /unavailable/);
  assert.ok(parser.calls[0].settledAt !== null);
});

test('percentiles use nearest rank and preserve input', () => {
  const samples = [4, 1, 3, 2];
  assert.deepEqual(percentiles(samples), { n: 4, p50: 2, p95: 4, max: 4 });
  assert.deepEqual(samples, [4, 1, 3, 2]);
  assert.equal(percentiles([]), null);
});
