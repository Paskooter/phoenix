import test from 'node:test';
import assert from 'node:assert/strict';
import { startJsonPeer, waitFor, sleep, parserResponse } from './httpPeers.mjs';
import { falsifyEvidence, measureOggPolicy } from './real-lane.mjs';

 test('real HTTP peer records an outstanding response and then its late settlement', async () => {
  const peer = await startJsonPeer({ name: 'held-test-peer', response: parserResponse(), hold: true, path: '/v1/parse' });
  try {
    const responsePromise = fetch(peer.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'NLU', data: { text: 'probe' } }),
    });
    await waitFor(() => peer.requests.length === 1, { label: 'held test peer request' });
    const request = peer.requests[0];
    await sleep(20);
    assert.equal(request.responseClosedAt, null);
    assert.equal(request.socket.destroyed, false);
    peer.release();
    const response = await responsePromise;
    assert.equal(response.status, 200);
    await waitFor(() => request.responseFinishedAt !== null, { label: 'held test peer release' });
    assert.equal(request.requestAbortedAt, null);
  } finally {
    await peer.close();
  }
});

test('OGG policy probe distinguishes decodable truncation from no-input contract', async () => {
  const result = await measureOggPolicy();
  assert.equal(result.strictPartial.outcome.ok, false);
  assert.equal(result.allowedPartial.outcome.ok, true);
  assert.ok(result.allowedPartial.pcmBytes > 0);
  assert.equal(result.consumerContract.emptyAsrState, 'noInput');
});

test('falsification: validator rejects a fabricated TIMEOUT_PARSER code', () => {
  const report = {
    httpTimeouts: [
      { kind: 'parser', errorCode: 'PARSER', budgetMs: 10000, timeoutElapsedMs: 10000, peerOpenAtTimeout: true, lateFrames: 0, cancellation: { cancelledByGateway: false } },
      { kind: 'skill', errorCode: 'TIMEOUT_SKILL', budgetMs: 10000, timeoutElapsedMs: 10000, peerOpenAtTimeout: true, lateFrames: 0, cancellation: { cancelledByGateway: false } },
    ],
  };
  const result = falsifyEvidence(report);
  assert.equal(result.caught, true);
  assert.match(result.message, /TIMEOUT_PARSER|PARSER/);
});
