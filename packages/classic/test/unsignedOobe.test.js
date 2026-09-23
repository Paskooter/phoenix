import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createClassicEntrypoint, createVerifiedClassicCaller } from '../src/index.js';

test('only the archived unsigned OOBE setup and status targets bypass Classic SigV4', async () => {
  const seen = [];
  const account = createServer((req, res) => {
    seen.push(req.headers['x-amz-target']);
    req.resume();
    res.writeHead(200, { 'content-type': 'application/x-amz-json-1.1' });
    res.end('{}');
  });
  await new Promise((resolve) => account.listen(0, '127.0.0.1', resolve));
  const oldAccount = process.env.NET_account;
  process.env.NET_account = `127.0.0.1:${account.address().port}`;
  const classic = await createClassicEntrypoint({
    publicUrl: 'https://classic.fixture.test',
    callerBoundary: createVerifiedClassicCaller({ resolveCredentials: () => null }),
  }).listen(0);
  const request = async (target, headers = {}) => {
    const response = await fetch(`http://127.0.0.1:${classic.address().port}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': target, ...headers },
      body: JSON.stringify({ token: 'fixture-token', id: 'fixture-robot' }),
    });
    return { status: response.status, body: await response.json() };
  };
  try {
    assert.equal((await request('OOBE_20161026.SetupRobot')).status, 200);
    assert.equal((await request('OOBE_20161026.GetStatus')).status, 200);
    for (const target of ['OOBE_20161026.PrepareRobot', 'OOBE_20161026.GetServiceToken',
      'OOBE_20161026.SetupRobotExtra', 'OOBE_20170101.SetupRobot']) {
      const denied = await request(target);
      assert.equal(denied.status, 401, target);
      assert.equal(denied.body.__type, 'MISSING_AUTH_HEADER', target);
    }
    const badSignature = await request('OOBE_20161026.SetupRobot', { authorization: 'not-a-signature' });
    assert.equal(badSignature.status, 401);
    assert.deepEqual(seen, ['OOBE_20161026.SetupRobot', 'OOBE_20161026.GetStatus']);
  } finally {
    await Promise.all([
      new Promise((resolve) => classic.close(resolve)),
      new Promise((resolve) => account.close(resolve)),
    ]);
    if (oldAccount === undefined) delete process.env.NET_account;
    else process.env.NET_account = oldAccount;
  }
});
