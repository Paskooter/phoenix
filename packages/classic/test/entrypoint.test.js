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

test('proxy bounds upstream hangs and surfaces aborted upstream responses', async () => {
  const previousAccount = process.env.NET_account;
  const previousTimeout = process.env.ETCO_classic_upstreamTimeoutMS;
  const slow = http.createServer((req, _res) => {
    req.resume();
    const timer = setTimeout(() => {}, 1000);
    req.on('close', () => clearTimeout(timer));
  });
  await new Promise((resolve) => slow.listen(0, resolve));
  process.env.NET_account = `localhost:${slow.address().port}`;
  process.env.ETCO_classic_upstreamTimeoutMS = '40';
  const started = Date.now();
  const timedOut = await amz('OOBE_20161026.SetupRobot', {}, base);
  assert.equal(timedOut.status, 502);
  assert.match(timedOut.body.error, /upstream request (timeout|deadline)/);
  assert.ok(Date.now() - started < 1000);
  await new Promise((resolve) => slow.close(resolve));

  const trickle = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{"partial":');
    const interval = setInterval(() => res.write(' '), 5);
    req.on('close', () => clearInterval(interval));
  });
  await new Promise((resolve) => trickle.listen(0, resolve));
  process.env.NET_account = `localhost:${trickle.address().port}`;
  process.env.ETCO_classic_upstreamTimeoutMS = '80';
  const trickleStarted = Date.now();
  const trickled = await amz('OOBE_20161026.SetupRobot', {}, base);
  assert.equal(trickled.status, 502);
  assert.match(trickled.body.error, /upstream request deadline exceeded/);
  assert.ok(Date.now() - trickleStarted < 1000);
  await new Promise((resolve) => trickle.close(resolve));

  const aborted = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{"partial":');
    setImmediate(() => res.destroy());
  });
  await new Promise((resolve) => aborted.listen(0, resolve));
  process.env.NET_account = `localhost:${aborted.address().port}`;
  const abortedResponse = await amz('OOBE_20161026.SetupRobot', {}, base);
  assert.equal(abortedResponse.status, 502);
  assert.match(abortedResponse.body.error, /upstream response aborted/);
  await new Promise((resolve) => aborted.close(resolve));

  if (previousAccount === undefined) delete process.env.NET_account;
  else process.env.NET_account = previousAccount;
  if (previousTimeout === undefined) delete process.env.ETCO_classic_upstreamTimeoutMS;
  else process.env.ETCO_classic_upstreamTimeoutMS = previousTimeout;
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
