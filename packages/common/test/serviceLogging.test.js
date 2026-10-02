import test from 'node:test';
import assert from 'node:assert/strict';
import { createService, recentLogs } from '../src/index.js';

test('handled 5xx responses are visible and ordinary 404s are not labeled server errors', async t => {
  const service = createService({ name: 'logging-fixture', routes: {
    'POST /': ({ res }) => { res.writeHead(503); res.end('unavailable'); },
  } });
  const server = await service.listen(0, '127.0.0.1');
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const since = recentLogs().cursor;
  assert.equal((await fetch(base + '/missing')).status, 404);
  assert.equal((await fetch(base + '/', { method: 'POST', headers: { 'x-amz-target': 'Robot_20160101.Get' } })).status, 503);
  const events = recentLogs({ since, ns: 'logging-fixture' }).events;
  assert.equal(events.filter(e => e.status === 404).length, 1);
  assert.equal(events.find(e => e.status === 404).level, 'warn');
  assert.deepEqual(events.filter(e => e.level === 'error').map(e => [e.msg, e.status, e.operation]), [['request failed', 503, 'Robot_20160101.Get']]);
});
