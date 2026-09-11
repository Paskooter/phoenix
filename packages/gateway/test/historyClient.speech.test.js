// H-08 — the history HTTP client's speech sink and the outbound trace headers.
//
// Reference: pegasus 5c0a7390539663ba749d360de348a428c088505c
//   packages/history-client/src/base/BaseHistoryServiceClient.ts   (verbs + `${base}/v1${path}`)
//   packages/history-client/src/speech/SpeechHistoryClient.ts      (save / create / update envelopes)
//   packages/utils/src/service/JiboHeaders.ts                      (toHeader defaults)
//
// Probes the REAL HistoryClient against a real HTTP peer, so the method, path, body and
// headers on the wire are observed (this is the "outbound history headers" surface).

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { HistoryClient, SpeechHistoryRecord } from '../src/historyClient.js';

async function startSink(answer) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    requests.push({ method: req.method, url: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : null });
    if (answer && answer.status && answer.status >= 400) { res.statusCode = answer.status; return res.end('{"error":"nope"}'); }
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ id: `id-${requests.length}` }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { requests, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

test('createSpeechRecord posts /v1/speech with a body and the three trace headers', async () => {
  const sink = await startSink();
  try {
    const client = new HistoryClient(sink.url);
    const id = await client.createSpeechRecord(
      { robotID: 'r', accountID: 'a', transID: 't', timestamp: 123, audioFileURL: null },
      { transId: 'tid-1', robotId: 'robot-1', loggingConfig: '{"x":1}' },
    );
    assert.equal(id, 'id-1');
    assert.equal(sink.requests.length, 1);
    const req = sink.requests[0];
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/v1/speech');
    assert.deepEqual(req.body, { robotID: 'r', accountID: 'a', transID: 't', timestamp: 123, audioFileURL: null });
    assert.equal(req.headers['x-jibo-transid'], 'tid-1');
    assert.equal(req.headers['x-jibo-robotid'], 'robot-1');
    assert.equal(req.headers['x-jibo-logging-config'], '{"x":1}');
    assert.equal(req.headers['content-type'], 'application/json');
  } finally { await sink.close(); }
});

test('updateSpeechRecord puts /v1/speech/:id', async () => {
  const sink = await startSink();
  try {
    const client = new HistoryClient(sink.url);
    const id = await client.updateSpeechRecord('abc', { nlu: { intent: 'x' } }, {});
    assert.equal(id, 'id-1');
    assert.equal(sink.requests[0].method, 'PUT');
    assert.equal(sink.requests[0].url, '/v1/speech/abc');
    assert.deepEqual(sink.requests[0].body, { nlu: { intent: 'x' } });
  } finally { await sink.close(); }
});

test('saveSpeechRecord creates while the record has no id, then updates once it does', async () => {
  const sink = await startSink();
  try {
    const client = new HistoryClient(sink.url);
    const record = new SpeechHistoryRecord({ robotID: 'r', accountID: 'a', transID: 't', timestamp: 1, audioFileURL: null });
    await client.saveSpeechRecord(record, { transId: 'tid' });
    assert.equal(record.id, 'id-1', 'the create response id is stored on the record');
    record.update({ asr: { text: 'hi' } });
    await client.saveSpeechRecord(record, { transId: 'tid' });
    assert.deepEqual(sink.requests.map((r) => `${r.method} ${r.url}`), ['POST /v1/speech', 'PUT /v1/speech/id-1']);
    assert.deepEqual(sink.requests[1].body, { robotID: 'r', accountID: 'a', transID: 't', timestamp: 1, audioFileURL: null, asr: { text: 'hi' } });
  } finally { await sink.close(); }
});

test('a save failure carries the reference envelope and clears the stack', async () => {
  await assert.rejects(
    () => new HistoryClient('http://127.0.0.1:1').saveSpeechRecord(
      new SpeechHistoryRecord({ robotID: 'r' }), {}),
    (err) => err.message.startsWith('Failed to save speech history record: ')
      && err.stack === null
      && Object.keys(err).length === 0,
  );
});

test('an update failure carries the update envelope and clears the stack', async () => {
  const record = new SpeechHistoryRecord({ robotID: 'r' });
  record.id = 'existing';
  await assert.rejects(
    () => new HistoryClient('http://127.0.0.1:1').saveSpeechRecord(record, {}),
    (err) => err.message.startsWith('Failed to update speech history record: ') && err.stack === null,
  );
});

test('a non-OK create answer rejects (the caller owns the fire-and-forget catch)', async () => {
  const sink = await startSink({ status: 500 });
  try {
    await assert.rejects(() => new HistoryClient(sink.url).createSpeechRecord({ robotID: 'r' }, {}));
  } finally { await sink.close(); }
});

test('skill launch uses the same trace headers and /v1/skill/launch path', async () => {
  const sink = await startSink();
  try {
    const client = new HistoryClient(sink.url);
    await client.writeSkillLaunch({ robotID: 'r', sessionID: 's', skillID: 'k', intent: 'i', personIDs: ['p'] }, { transId: 'tid-2' });
    const req = sink.requests[0];
    assert.equal(req.url, '/v1/skill/launch');
    assert.equal(req.headers['x-jibo-transid'], 'tid-2');
    // JiboHeaders defaults are materialized at the transaction boundary; an absent value must
    // not silently drop the header (gotcha #12 — the transID must always propagate).
    assert.equal(req.body.robotID, 'r');
  } finally { await sink.close(); }
});
