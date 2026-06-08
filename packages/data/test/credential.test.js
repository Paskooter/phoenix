import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { CredentialStore } from '../src/credentials.js';
import { normalizeEvent } from '../src/calendar.js';
import { createDataService } from '../src/index.js';

const PORT = 7796;
const base = { accountId: 'acct1', skillId: 'report-skill', serviceName: 'google', serviceAccountName: 'personalCalendar', scopes: ['read'], clientId: 'c1' };

test('save requires fields + authCode/tokens', () => {
  const s = new CredentialStore();
  assert.throws(() => s.save({ accountId: 'a' }), /Missing skillId/);
  assert.throws(() => s.save({ ...base }), /Missing authCode or tokens/);
});

test('testAuthCode bypass stores fake tokens; dup authCode -> DUPLICATE_KEY', () => {
  const s = new CredentialStore();
  const c = s.save({ ...base, authCode: 'testAuthCode' });
  assert.equal(c.oauth2.accessToken, 'testAccessToken');
  assert.deepEqual(s.checkExists(base), { credentialExists: true });
  assert.throws(() => s.save({ ...base, authCode: 'testAuthCode' }), (e) => e.code === 'DUPLICATE_KEY');
});

test('direct tokens path saves without OAuth exchange', () => {
  const s = new CredentialStore();
  const c = s.save({ ...base, serviceAccountName: 'workCalendar', accessToken: 'at', refreshToken: 'rt', expiresAt: 1 });
  assert.equal(c.oauth2.accessToken, 'at');
});

test('deleteOther: a new report-skill calendar cred for the other service is removed (B3 fix)', () => {
  const s = new CredentialStore();
  s.save({ ...base, serviceName: 'google', serviceAccountName: 'personalCalendar', authCode: 'testAuthCode' });
  s.save({ ...base, serviceName: 'outlook', serviceAccountName: 'personalCalendar', authCode: 'testAuthCode' });
  // only the outlook one should remain for personalCalendar
  assert.deepEqual(s.checkExists({ ...base, serviceName: 'google', serviceAccountName: 'personalCalendar' }), { credentialExists: false });
  assert.deepEqual(s.checkExists({ ...base, serviceName: 'outlook', serviceAccountName: 'personalCalendar' }), { credentialExists: true });
});

test('delete with wildcards removes matching creds', () => {
  const s = new CredentialStore();
  s.save({ ...base, authCode: 'testAuthCode' });
  s.delete({ accountId: 'acct1', skillId: '*', serviceName: '*', serviceAccountName: '*' });
  assert.deepEqual(s.checkExists(base), { credentialExists: false });
});

test('normalizeEvent: timed + all-day CalendarEvent shape', () => {
  const timed = normalizeEvent({ summary: 'Standup', start: { dateTime: '2026-06-08T09:00:00Z' }, end: { dateTime: '2026-06-08T09:15:00Z' } });
  assert.equal(timed.fullDay, false);
  assert.equal(timed.summary, 'Standup');
  assert.equal(timed.start.dateTime, '2026-06-08T09:00:00Z');
  assert.equal(typeof timed.start.timestamp, 'number');
  const allDay = normalizeEvent({ summary: 'Holiday', start: { date: '2026-07-04' } });
  assert.equal(allDay.fullDay, true);
});

// --- HTTP: credential CRUD + calendar with stub provider -------------------
let server;
before(async () => {
  const svc = createDataService({
    googleCalendarProvider: async () => [{ summary: 'Standup', start: { dateTime: '2026-06-08T09:00:00Z' } }],
  });
  server = await svc.listen(PORT);
});
after(() => server?.close?.());

const j = (path, opts) => fetch(`http://localhost:${PORT}${path}`, opts);

test('POST/GET/DELETE /v1/credential', async () => {
  const post = await (await j('/v1/credential', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...base, authCode: 'testAuthCode' }) })).json();
  assert.deepEqual(post, { created: true });

  const dup = await (await j('/v1/credential', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...base, authCode: 'testAuthCode' }) })).json();
  assert.deepEqual(dup, { credentialExists: true });

  const get = await (await j('/v1/credential?accountId=acct1&skillId=report-skill&serviceName=google&serviceAccountName=personalCalendar&scopes=read')).json();
  assert.deepEqual(get, { credentialExists: true });

  const del = await (await j('/v1/credential?accountId=acct1&skillId=*&serviceName=*&serviceAccountName=*', { method: 'DELETE' })).json();
  assert.deepEqual(del, { deleted: true });
});

test('GET /v1/google_calendar -> {events:[CalendarEvent]} via stub provider', async () => {
  const r = await (await j('/v1/google_calendar?skillId=report-skill&accountId=acct1&calendar=personalCalendar')).json();
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0].summary, 'Standup');
  assert.equal(r.events[0].fullDay, false);
});

test('calendar missing skillId -> 400', async () => {
  assert.equal((await j('/v1/google_calendar?accountId=acct1&calendar=x')).status, 400);
});
