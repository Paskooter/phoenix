import test from 'node:test';
import assert from 'node:assert/strict';
import { createHistoryService, HistoryStore } from '../src/index.js';

// Pegasus@5c0a739: validators/event.ts:12-24 defines alternatives, not a
// requirement for both intent and payload. validateAndThrow throws the Joi
// error unchanged and utils/BaseService.ts:321 uses err.statusCode || 500.
test('History preserves the archived invalid-intent 500 but accepts omitted intent and payload', async (t) => {
  const store = new HistoryStore();
  const server = await createHistoryService(store).listen(0);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (path, body) => {
    const response = await fetch(`${base}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  const valid = { robotID: 'intent-robot', sessionID: 'intent-session', skillID: 'intent-skill' };
  for (const intent of [null, false, 0, {}, []]) {
    const invalid = await request('/v1/skill/launch', { ...valid, intent });
    assert.equal(invalid.status, 500, 'original History does not translate Joi failures to 400/422');
    assert.equal(invalid.body.type, 'ERROR');
    assert.equal(invalid.body.data.message,
      'child "intent" fails because ["intent" must be a string], child "payload" fails because ["payload" is required]');
  }
  const empty = await request('/v1/skill/launch/count', { robotID: valid.robotID });
  assert.deepEqual(empty, { status: 200, body: { count: 0 } }, 'invalid events never reach storage');
  const good = await request('/v1/skill/launch', valid);
  assert.equal(good.status, 200);
  assert.equal(Object.hasOwn(good.body, 'intent'), false);
  assert.equal(Object.hasOwn(good.body, 'payload'), false);
  const latest = await request('/v1/skill/launch/latest', { robotID: valid.robotID });
  assert.deepEqual(latest, good, 'the valid launch is read back unchanged');
});
