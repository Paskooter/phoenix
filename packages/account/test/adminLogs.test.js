// The admin log console API.
//
// Two things are worth pinning here and neither is the HTTP plumbing:
//   1. the ring buffer is bounded and its cursor is monotonic, because the
//      console polls with that cursor and a non-monotonic or unbounded buffer
//      either replays old lines forever or grows without limit;
//   2. the level filter hides less-severe lines and shows more-severe ones —
//      backwards, it would hide exactly the errors someone opened the console
//      to find.
//
// LOG_LEVEL must be set before @phoenix/common is imported: GLOBAL_LEVEL is read
// once at module load, so a later assignment would not affect what is buffered.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.LOG_LEVEL = 'debug';
const dir = mkdtempSync(join(tmpdir(), 'phx-logs-'));
process.env.ETCO_account_dataFile = join(dir, 'store.json');

const { logger, recentLogs } = await import('@phoenix/common');
const { Store } = await import('../src/store.js');
const { createAccountService } = await import('../src/index.js');

let server; let base; let store;
const jars = new Map();

async function call(method, path, body, jar = 'default') {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(jars.get(jar) ? { cookie: jars.get(jar) } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) jars.set(jar, setCookie.split(';')[0]);
  return { status: res.status, body: await res.json().catch(() => null) };
}

before(async () => {
  store = new Store(process.env.ETCO_account_dataFile);
  server = await createAccountService({ store }).listen(0);
  base = `http://localhost:${server.address().port}`;
  const signup = await call('POST', '/api/signup', { email: 'logs@admin.test', password: 'logs-admin-pass' });
  assert.equal(signup.status, 200);
});

after(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });

test('the buffer records what the logger emits, with a monotonic cursor', () => {
  const log = logger('test.cursor');
  const before1 = recentLogs({ limit: 1 }).cursor;
  log.info('first line', { marker: 'cursor-test' });
  log.error('second line', { marker: 'cursor-test' });

  const page = recentLogs({ since: before1, limit: 50 });
  const mine = page.events.filter((e) => e.marker === 'cursor-test');
  assert.equal(mine.length, 2, 'both lines are readable from the cursor');
  assert.equal(mine[0].msg, 'first line');
  assert.equal(mine[1].level, 'error');
  assert.ok(mine[1].seq > mine[0].seq, 'sequence increases');
  assert.ok(page.cursor >= mine[1].seq, 'cursor is at or past the last line');

  // Polling again from the returned cursor yields nothing new.
  const again = recentLogs({ since: page.cursor, limit: 50 });
  assert.equal(again.events.filter((e) => e.marker === 'cursor-test').length, 0);
});

test('the level filter hides less-severe lines and keeps more-severe ones', () => {
  const log = logger('test.level');
  log.info('info line', { marker: 'level-test' });
  log.warn('warn line', { marker: 'level-test' });
  log.error('error line', { marker: 'level-test' });

  const atWarn = recentLogs({ limit: 500, level: 'warn' }).events
    .filter((e) => e.marker === 'level-test').map((e) => e.level);
  assert.deepEqual(atWarn, ['warn', 'error'],
    'asking for warn shows warn AND error, and not info');

  const atError = recentLogs({ limit: 500, level: 'error' }).events
    .filter((e) => e.marker === 'level-test').map((e) => e.level);
  assert.deepEqual(atError, ['error'], 'asking for error shows only error');

  const atInfo = recentLogs({ limit: 500, level: 'info' }).events
    .filter((e) => e.marker === 'level-test').map((e) => e.level);
  assert.deepEqual(atInfo, ['info', 'warn', 'error'], 'asking for info shows all three');
});

test('the namespace filter is a prefix match', () => {
  const log = logger('gateway.listen');
  log.info('ns line', { marker: 'ns-test' });
  const hit = recentLogs({ limit: 500, ns: 'gateway' }).events
    .filter((e) => e.marker === 'ns-test');
  const miss = recentLogs({ limit: 500, ns: 'skills' }).events
    .filter((e) => e.marker === 'ns-test');
  assert.equal(hit.length, 1);
  assert.equal(hit[0].ns, 'gateway.listen');
  assert.equal(miss.length, 0);
});

test('the buffer is bounded: it drops the oldest lines rather than growing', () => {
  const log = logger('test.bound');
  const startBuffered = recentLogs({ limit: 1 }).buffered;
  for (let i = 0; i < 4000; i += 1) log.info(`flood ${i}`, { marker: 'bound-test' });

  const page = recentLogs({ limit: 5000 });
  assert.ok(page.buffered <= 1000, `buffer stays bounded (saw ${page.buffered})`);
  assert.ok(page.buffered >= startBuffered, 'it did keep lines');
  assert.ok(page.dropped > 0, 'dropping is counted, not silent');
  assert.ok(page.events.length <= 1000, 'a limit larger than the buffer is clamped');
  // The most recent line survives a flood; the oldest does not.
  const msgs = page.events.map((e) => e.msg);
  assert.ok(msgs.includes('flood 3999'), 'newest line retained');
  assert.ok(!msgs.includes('flood 0'), 'oldest line evicted');
});

test('the log route is administrator-only', async () => {
  const anon = await call('GET', '/api/admin/logs', null, 'anon');
  assert.equal(anon.status, 401);

  const plain = await call('POST', '/api/signup', { email: 'plain@logs.test', password: 'plain-user-pass' }, 'plain');
  assert.equal(plain.status, 200);
  const asUser = await call('GET', '/api/admin/logs', null, 'plain');
  assert.equal(asUser.status, 403);
  assert.match(asUser.body.error, /not an administrator/);
});

test('an administrator reads the server\'s own log lines through the route', async () => {
  store.accountByEmail('logs@admin.test').isAdmin = true;
  store.flush();

  // Something the server logs on its own, through the real service logger.
  const { logger: svcLogger } = await import('@phoenix/common');
  svcLogger('account').warn('route test marker', { marker: 'route-test' });

  const res = await call('GET', '/api/admin/logs?since=0&limit=200', null, 'default');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.events));
  assert.ok(res.body.events.some((e) => e.marker === 'route-test'),
    'the line the service logged is readable through the route');
  assert.ok(typeof res.body.cursor === 'number');
  assert.ok(res.body.levels.includes('error') && res.body.levels.includes('debug'));
  assert.equal(res.body.scope, 'process');
  assert.equal(res.body.levelIsFilterOnly, true, 'it says the level is a filter, not a verbosity switch');
});

test('the route filters by level and rejects an unknown one', async () => {
  const warnOnly = await call('GET', '/api/admin/logs?since=0&limit=500&level=warn', null, 'default');
  assert.equal(warnOnly.status, 200);
  assert.ok(warnOnly.body.events.length > 0);
  assert.ok(warnOnly.body.events.every((e) => e.level === 'warn' || e.level === 'error'),
    'level=warn returns warn and error, never info or debug');

  const bogus = await call('GET', '/api/admin/logs?level=verbose', null, 'default');
  assert.equal(bogus.status, 400, 'an unknown level is refused, not silently ignored');
  assert.match(bogus.body.error, /level must be one of/);
});

test('polling with the cursor advances and does not replay', async () => {
  const first = await call('GET', '/api/admin/logs?since=0&limit=50', null, 'default');
  assert.equal(first.status, 200);
  const cursor = first.body.cursor;

  const idle = await call('GET', `/api/admin/logs?since=${cursor}&limit=50`, null, 'default');
  assert.equal(idle.status, 200);
  assert.equal(idle.body.events.length, 0, 'nothing new since the cursor means an empty page');

  const { logger: svcLogger } = await import('@phoenix/common');
  svcLogger('account').error('after the cursor', { marker: 'advance-test' });
  const next = await call('GET', `/api/admin/logs?since=${cursor}&limit=50`, null, 'default');
  assert.equal(next.status, 200);
  assert.ok(next.body.events.some((e) => e.marker === 'advance-test'), 'the new line arrives');
  assert.ok(next.body.cursor > cursor, 'and the cursor moved');
});
