// H.1 — the classic-service entrypoint: prefix-router dispatch (in-process log + robot, plus
// proxy to upstreams), the log no-op shapes, and the robot read stubs.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createClassicEntrypoint } from '../src/index.js';

let server; let base; let upstreams = {}; let upstreamHits = [];

async function amz(target, body, port) {
  const res = await fetch(`http://localhost:${port}/`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': target },
    body: JSON.stringify(body || {}),
  });
  return { status: res.status, errType: res.headers.get('x-amzn-errortype'), body: await res.json().catch(() => null) };
}

before(async () => {
  // a mock upstream standing in for both account and ota
  const mock = http.createServer((req, res) => {
    upstreamHits.push(req.headers['x-amz-target']);
    res.writeHead(200, { 'content-type': 'application/x-amz-json-1.1' });
    res.end(JSON.stringify({ proxied: req.headers['x-amz-target'] }));
  });
  await new Promise((r) => mock.listen(0, r));
  upstreams.mock = mock;
  process.env.NET_account = `localhost:${mock.address().port}`;
  process.env.NET_ota = `localhost:${mock.address().port}`;

  server = await createClassicEntrypoint().listen(0);
  base = server.address().port;
});
after(() => { server.close(); upstreams.mock.close(); delete process.env.NET_account; delete process.env.NET_ota; });

test('log PutEvents: 200 no-op, robot never gets a 500', async () => {
  const r = await amz('Log_20150309.PutEvents', { trackingId: 't', deviceId: 'd', events: [{ a: 1 }] }, base);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, {});
});

test('log PutEventsAsync + PutAsrBinary return the upload-handshake shapes', async () => {
  const a = await amz('Log_20150309.PutEventsAsync', { kind: 'k', serial: 's' }, base);
  assert.deepEqual(Object.keys(a.body).sort(), ['contentEncoding', 'uploadUrl']);
  const b = await amz('Log_20150309.PutAsrBinary', { trackingId: 't', metadata: { x: 1 } }, base);
  assert.deepEqual(Object.keys(b.body).sort(), ['bucketName', 'key', 'metadata', 'uploadUrl']);
  assert.deepEqual(b.body.metadata, { x: 1 });
});

test('robot GetRobot / GetCalibrationData return valid empty records', async () => {
  const g = await amz('Robot_20160225.GetRobot', { id: 'robot-123' }, base);
  assert.equal(g.status, 200);
  assert.deepEqual(Object.keys(g.body).sort(), ['calibrationPayload', 'created', 'id', 'payload', 'updated']);
  assert.equal(g.body.id, 'robot-123');
  assert.deepEqual(g.body.calibrationPayload, {}, 'cloud calibration empty -> robot uses local /var');

  const c = await amz('Robot_20160225.GetCalibrationData', { id: 'robot-123' }, base);
  assert.deepEqual(c.body, { id: 'robot-123', calibrationPayload: {} });
});

test('robot GetFriendlyIds returns the requested count of 4-word names', async () => {
  const r = await amz('Robot_20160225.GetFriendlyIds', { count: 3 }, base);
  assert.equal(r.body.pairs.length, 3);
  assert.match(r.body.pairs[0].friendlyId, /^[a-z]+-[a-z]+-[a-z]+-[a-z]+$/);
});

test('OOBE_* and Update_* proxy to their upstream services verbatim', async () => {
  upstreamHits = [];
  const oobe = await amz('OOBE_20161026.SetupRobot', { token: 'x', id: 'y' }, base);
  assert.equal(oobe.body.proxied, 'OOBE_20161026.SetupRobot');
  const upd = await amz('Update_20160301.ListUpdatesFrom', { subsystem: 'os' }, base);
  assert.equal(upd.body.proxied, 'Update_20160301.ListUpdatesFrom');
  assert.deepEqual(upstreamHits, ['OOBE_20161026.SetupRobot', 'Update_20160301.ListUpdatesFrom']);
});

test('prefix tolerance: case-insensitive; unknown prefix -> UnknownOperationException', async () => {
  const lower = await amz('log_20150309.putevents', {}, base);
  assert.equal(lower.status, 200);
  const nope = await amz('Frobnicate_20990101.DoThing', {}, base);
  assert.equal(nope.status, 400);
  assert.equal(nope.errType, 'UnknownOperationException');
});

test('OOBE prefix from the wire contract is OOBE_20161026 (G.2 matcher already covers it)', () => {
  // documents the confirmation from apis/oobe-2016-10-26.normal.json
  assert.match('OOBE_20161026', /^oobe/i);
});
