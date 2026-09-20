import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createClassicEntrypoint } from '../src/index.js';

test('Classic replaces client-supplied OTA peer headers with its verified caller assertion', async () => {
  let upstreamHeaders;
  const upstream = createServer((req, res) => {
    upstreamHeaders = req.headers;
    req.resume();
    res.writeHead(200, { 'content-type': 'application/x-amz-json-1.1' });
    res.end('[]');
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const oldOta = process.env.NET_ota;
  const oldToken = process.env.ETCO_ota_internalPeerToken;
  process.env.NET_ota = `127.0.0.1:${upstream.address().port}`;
  process.env.ETCO_ota_internalPeerToken = 'fixture-classic-ota-token';
  const classic = await createClassicEntrypoint({
    publicUrl: 'https://classic.fixture.test',
    callerBoundary: async () => ({
      accountId: 'verified-account', email: 'verified@fixture.test', friendlyId: null, isAdmin: false,
    }),
  }).listen(0);
  try {
    const response = await fetch(`http://127.0.0.1:${classic.address().port}/`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-amz-json-1.1',
        'x-amz-target': 'Update_20160301.ListUpdates',
        'x-phoenix-ota-peer-token': 'attacker-value',
        'x-phoenix-verified-account': JSON.stringify({ id: 'attacker-account', isAdmin: true }),
      },
      body: JSON.stringify({ subsystem: 'main' }),
    });
    assert.equal(response.status, 200);
    assert.equal(upstreamHeaders['x-phoenix-ota-peer-token'], 'fixture-classic-ota-token');
    assert.deepEqual(JSON.parse(upstreamHeaders['x-phoenix-verified-account']), {
      id: 'verified-account', email: 'verified@fixture.test', friendlyId: null, isAdmin: false,
    });
  } finally {
    await Promise.all([
      new Promise((resolve) => classic.close(resolve)),
      new Promise((resolve) => upstream.close(resolve)),
    ]);
    if (oldOta === undefined) delete process.env.NET_ota;
    else process.env.NET_ota = oldOta;
    if (oldToken === undefined) delete process.env.ETCO_ota_internalPeerToken;
    else process.env.ETCO_ota_internalPeerToken = oldToken;
  }
});
