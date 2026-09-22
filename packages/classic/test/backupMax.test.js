import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createClassicEntrypoint } from '../src/index.js';

const entrypoint = createClassicEntrypoint({
  // This is an explicitly private loopback fixture. Public deployments use
  // the verified Classic caller boundary instead of this compatibility opt-in.
  backup: { allowLoopbackWithoutIdentity: true },
});
const server = await entrypoint.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;

after(() => server.close());

async function list(body) {
  const response = await fetch(`${base}/`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-amz-json-1.1',
      'x-amz-target': 'Backup_20170222.List',
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

test('Backup.List accepts omitted, numeric, and numeric-string max values', async () => {
  for (const max of [undefined, 1, 1000, '2']) {
    const body = max === undefined ? { loopId: 'max-valid' } : { loopId: 'max-valid', max };
    const result = await list(body);
    assert.equal(result.status, 200, `max=${String(max)} should be accepted`);
    assert.deepEqual(result.body, []);
  }
});

test('Backup.List rejects max values outside the source Joi range instead of clamping', async () => {
  const cases = [
    [null, 'child "max" fails because ["max" must be a number]'],
    ['', 'child "max" fails because ["max" must be a number]'],
    ['not-a-number', 'child "max" fails because ["max" must be a number]'],
    [true, 'child "max" fails because ["max" must be a number]'],
    [{}, 'child "max" fails because ["max" must be a number]'],
    [1.5, 'child "max" fails because ["max" must be an integer]'],
    [0, 'child "max" fails because ["max" must be larger than or equal to 1]'],
    [-1, 'child "max" fails because ["max" must be larger than or equal to 1]'],
    [1001, 'child "max" fails because ["max" must be less than or equal to 1000]'],
  ];
  for (const [max, message] of cases) {
    const result = await list({ loopId: 'max-invalid', max });
    assert.equal(result.status, 422, `max=${String(max)} must be rejected`);
    assert.equal(result.body.statusCode, 422);
    assert.equal(result.body.error, 'Unprocessable Entity');
    assert.equal(result.body.message, message);
  }
});
