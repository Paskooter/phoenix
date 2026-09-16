// The portal must be able to set the commute DEPARTURE TIME.
//
// Found live: the owner set home and work on the map, saved, and Jibo still only
// read the trip time aloud with no traffic or departure display. That is the
// reference's own behaviour — report-skill CommuteMimLogic takes the plain "Now"
// branch and attaches NO views when minsLeft > 120 — but the portal had no
// control for the departure time at all, so there was no way to get inside the
// two-hour window where the displays appear. The API already carried
// commute.time; only the UI was missing it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, createAccountService } from '../src/index.js';
import { createOwnerAccount } from '../src/model.js';
import { createSession, sessionCookie } from '../src/sessions.js';

async function portal() {
  const dir = mkdtempSync(join(tmpdir(), 'commute-settings-'));
  const store = new Store(join(dir, 'account.json'));
  const account = createOwnerAccount(store, { email: 'c@example.com', password: 'password123', firstName: 'C' });
  const svc = createAccountService({ store });
  await new Promise((r) => svc.server.listen(0, '127.0.0.1', r));
  const port = svc.server.address().port;
  const cookie = sessionCookie(createSession(store, { kind: 'user', accountId: account._id })).split(';')[0];
  const call = async (method, path, body) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return { call, close: () => new Promise((r) => svc.server.close(r)) };
}

test('the portal settings API round-trips the commute departure time', async () => {
  const { call, close } = await portal();
  try {
    const before = await call('GET', '/api/settings');
    assert.equal(before.status, 200);
    assert.ok(before.body.settings.commute.time, 'GET must expose commute.time');

    const put = await call('PUT', '/api/settings', {
      commute: {
        active: true,
        mode: 'driving',
        home: { lat: 43.465526, lng: -76.496595 },
        work: { lat: 43.458454, lng: -76.506113 },
        time: { hour: 7, min: 45 },
      },
    });
    assert.equal(put.status, 200);
    assert.deepEqual(put.body.settings.commute.time, { hour: 7, min: 45 });

    const after = await call('GET', '/api/settings');
    assert.deepEqual(after.body.settings.commute.time, { hour: 7, min: 45 }, 'it must survive a reload');
    // The coordinates must not be lost when the time is written.
    assert.equal(after.body.settings.commute.home.lat, 43.465526);
    assert.equal(after.body.settings.commute.work.lng, -76.506113);
  } finally {
    await close();
  }
});

test('an omitted departure time leaves the stored one alone', async () => {
  const { call, close } = await portal();
  try {
    await call('PUT', '/api/settings', { commute: { active: true, mode: 'driving', time: { hour: 6, min: 30 } } });
    // A save that does not mention `time` (an older client, or a partial update)
    // must not silently reset the departure to the default.
    await call('PUT', '/api/settings', { commute: { active: true, mode: 'walking' } });
    const after = await call('GET', '/api/settings');
    assert.deepEqual(after.body.settings.commute.time, { hour: 6, min: 30 });
    assert.equal(after.body.settings.commute.mode, 'walking');
  } finally {
    await close();
  }
});
