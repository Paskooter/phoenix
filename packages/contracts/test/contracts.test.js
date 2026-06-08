import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validate,
  assertValid,
  message,
  response,
  errorResponse,
  schemas,
  RequestType,
  ResponseType,
  Timeouts,
} from '../src/index.js';

// Sample messages copied from docs/atlas/message-protocol.md (the reference shapes).

test('LISTEN request from the atlas validates', () => {
  const listen = {
    type: 'LISTEN',
    msgID: 'a1',
    ts: 1770000000000,
    data: {
      lang: 'en-US',
      hotphrase: true,
      rules: ['launch', 'global'],
      asr: { encoding: 'LINEAR16', sampleRate: 16000, sosTimeout: 8000, hints: ['ada lovelace'] },
      agents: { myAgent: { accessToken: '...', rules: ['r1'] } },
    },
  };
  const { valid, errors } = validate(schemas.listenRequest, listen);
  assert.ok(valid, errors.join('; '));
});

test('CONTEXT requires general.accountID/robotID/lang', () => {
  const ctx = {
    type: 'CONTEXT',
    msgID: 'b2',
    ts: 1,
    data: { general: { accountID: 'acct-1', robotID: 'rob', lang: 'en-US' }, skill: { id: null } },
  };
  assert.ok(validate(schemas.context, ctx).valid);

  const bad = { type: 'CONTEXT', msgID: 'b2', ts: 1, data: { general: { accountID: 'a' } } };
  const r = validate(schemas.context, bad);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('robotID')));
});

test('NLU response from the parser validates (intent may be null)', () => {
  const ok = { type: 'NLU', msgID: 'c', ts: 1, data: { intent: 'generalWhoQuestions', rules: ['launch'], entities: { person: 'ada lovelace' } } };
  assert.ok(validate(schemas.nluResponse, ok).valid);

  const garbage = { type: 'NLU', msgID: 'c', ts: 1, data: { intent: null, rules: [], entities: {} } };
  assert.ok(validate(schemas.nluResponse, garbage).valid, 'garbage ASR -> null intent is legal (gotcha #7)');
});

test('SKILL_ACTION skill response validates', () => {
  const skillResp = {
    type: 'SKILL_ACTION',
    msgID: 'd',
    ts: 1,
    data: {
      skill: { id: 'answer-skill', session: { id: 's-uuid', nodeID: 1, data: {}, trace: [] } },
      action: { type: 'JCP', config: {} },
      final: true,
      fireAndForget: false,
    },
  };
  assert.ok(validate(schemas.skillResponse, skillResp).valid);
});

test('wrong discriminator is rejected', () => {
  const r = validate(schemas.listenRequest, { type: 'CONTEXT', data: { lang: 'en', rules: [] } });
  assert.equal(r.valid, false);
});

test('envelope builders produce well-formed messages', () => {
  const m = message(RequestType.LISTEN, { lang: 'en-US', rules: ['launch'] });
  assert.equal(m.type, 'LISTEN');
  assert.equal(typeof m.msgID, 'string');
  assert.equal(typeof m.ts, 'number');

  const err = errorResponse('boom', 'TIMEOUT_PARSER');
  assert.equal(err.type, ResponseType.ERROR);
  assert.equal(err.final, true);
  assert.ok(validate(schemas.error, err).valid);

  const r = response(ResponseType.LISTEN, { match: null }, { final: false, timings: { total: 10 } });
  assert.equal(r.final, false);
  assert.equal(r.timings.total, 10);
});

test('assertValid throws with readable errors', () => {
  assert.throws(() => assertValid(schemas.context, { type: 'CONTEXT', data: {} }, 'CONTEXT'), /Invalid CONTEXT/);
});

test('timeouts match the reference state machine', () => {
  assert.equal(Timeouts.transaction, 60000);
  assert.equal(Timeouts.parser, 10000);
  assert.equal(Timeouts.context, 5000);
});
