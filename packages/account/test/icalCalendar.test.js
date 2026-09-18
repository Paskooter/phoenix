import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createAccountService } from '../src/index.js';
import { Store } from '../src/store.js';
import { createSession, sessionCookie } from '../src/sessions.js';

const ICS = readFileSync(new URL('../../common/test/fixtures/ical-basic.ics', import.meta.url), 'utf8');

async function startAccount() {
  const dir = mkdtempSync(join(tmpdir(), 'phoenix-ical-account-'));
  const storeFile = join(dir, 'account.json');
  const store = new Store(storeFile);
  const service = await createAccountService({ store, calendarFetchTimeoutMs: 250 }).listen(0);
  return { dir, store, storeFile, service, base: `http://127.0.0.1:${service.address().port}` };
}

async function request(base, method, path, body, cookie) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return {
    status: response.status,
    body: await response.json().catch(() => ({})),
    cookie: response.headers.get('set-cookie')?.split(';', 1)[0],
  };
}

async function signup(running, email) {
  const response = await request(running.base, 'POST', '/api/signup', {
    email, password: 'orbit-city-ical', firstName: 'Calendar',
  });
  assert.equal(response.status, 200);
  return response.cookie;
}

test('iCal subscriptions verify, persist, expose events, and keep invalid links saved', async () => {
  const source = http.createServer((req, res) => {
    if (req.url === '/calendar.ics') {
      res.writeHead(200, { 'content-type': 'text/calendar; charset=utf-8' });
      res.end(ICS);
      return;
    }
    res.writeHead(404);
    res.end('missing');
  });
  await new Promise((resolve) => source.listen(0, '127.0.0.1', resolve));
  const sourceUrl = `http://127.0.0.1:${source.address().port}/calendar.ics`;
  const running = await startAccount();
  try {
    const ownerCookie = await signup(running, 'owner@calendar.test');
    const otherCookie = await signup(running, 'other@calendar.test');

    const added = await request(running.base, 'POST', '/api/calendar/subscriptions', {
      label: 'Home calendar', url: sourceUrl, enabled: true,
    }, ownerCookie);
    assert.equal(added.status, 201);
    assert.equal(added.body.subscription.label, 'Home calendar');
    assert.equal(added.body.subscription.verification.status, 'ok');
    assert.equal(added.body.subscription.verification.eventCount, 3);
    const id = added.body.subscription.id;

    const updated = await request(running.base, 'PUT', `/api/calendar/subscriptions/${id}`, {
      label: 'Home calendar updated', enabled: true,
    }, ownerCookie);
    assert.equal(updated.status, 200);
    assert.equal(updated.body.subscription.label, 'Home calendar updated');
    const reverified = await request(
      running.base, 'POST', `/api/calendar/subscriptions/${id}/verify`, null, ownerCookie,
    );
    assert.equal(reverified.status, 200);
    assert.equal(reverified.body.subscription.verification.status, 'ok');

    const events = await request(
      running.base,
      'GET',
      '/api/calendar/events?start=2027-01-01T00:00:00Z&end=2027-02-01T00:00:00Z',
      null,
      ownerCookie,
    );
    assert.equal(events.status, 200);
    assert.equal(events.body.events.length, 3);
    assert.equal(events.body.events[0].summary, 'Planning, Q1; kickoff with a very long project name');

    const otherList = await request(running.base, 'GET', '/api/calendar/subscriptions', null, otherCookie);
    assert.equal(otherList.status, 200);
    assert.deepEqual(otherList.body.subscriptions, []);
    const otherDelete = await request(
      running.base, 'DELETE', `/api/calendar/subscriptions/${id}`, null, otherCookie,
    );
    assert.equal(otherDelete.status, 404);

    const unreachable = await request(running.base, 'POST', '/api/calendar/subscriptions', {
      label: 'Offline calendar', url: 'http://127.0.0.1:1/unreachable.ics', enabled: true,
    }, ownerCookie);
    assert.equal(unreachable.status, 201, 'bad links must never block saving');
    assert.equal(unreachable.body.subscription.verification.status, 'invalid');
    assert.match(unreachable.body.subscription.verification.lastError, /fetch|connect|request|refused|network/i);

    const invalidScheme = await request(running.base, 'POST', '/api/calendar/subscriptions', {
      label: 'Unsupported calendar', url: 'ftp://calendar.test/feed.ics', enabled: true,
    }, ownerCookie);
    assert.equal(invalidScheme.status, 201);
    assert.equal(invalidScheme.body.subscription.verification.status, 'invalid');
    assert.match(invalidScheme.body.subscription.verification.lastError, /scheme|protocol/i);

    const admin = createSession(running.store, { kind: 'admin' });
    const adminList = await request(
      running.base, 'GET', '/api/calendar/subscriptions', null, sessionCookie(admin),
    );
    assert.equal(adminList.status, 401, 'admin sessions must not read account calendar contents');

    const persisted = new Store(running.storeFile);
    const accountSettings = [...persisted.settings.values()]
      .find((record) => record.data?.icalSubscriptions?.subscriptions?.some((item) => item.id === id));
    assert.ok(accountSettings, 'subscription persisted in the account settings record');
  } finally {
    await new Promise((resolve) => running.service.close(resolve));
    await new Promise((resolve) => source.close(resolve));
    rmSync(running.dir, { recursive: true, force: true });
  }
});
