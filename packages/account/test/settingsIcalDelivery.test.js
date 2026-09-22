import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSettingsInternalService, createSettingsProviders } from '../src/index.js';
import { Store } from '../src/store.js';
import { createOwnerAccount, createLoop } from '../src/model.js';
import { defaultSettingsData, setSettingsData } from '../src/settingsData.js';

test('GetSettings delivers private cached iCal events even when the Hub manifest has no iCal row', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'phx-settings-ical-'));
  const previousToken = process.env.ETCO_account_internalPeerToken;
  process.env.ETCO_account_internalPeerToken = 'calendar-settings-peer-test';
  let server;
  try {
    const store = new Store(join(dir, 'store.json'));
    const owner = createOwnerAccount(store, { email: 'calendar-owner@example.test', password: 'test-password' });
    const stranger = createOwnerAccount(store, { email: 'calendar-stranger@example.test', password: 'test-password' });
    const { loop } = createLoop(store, { owner, robotId: 'calendar-robot' });
    const data = defaultSettingsData();
    data.calendarEnabled = { value: 1 };
    data.icalSubscriptions = { subscriptions: [{
      id: 'sub-1', label: 'Personal', url: 'https://private.example.test/calendar.ics?token=secret',
      enabled: true, verification: { status: 'ok', eventCount: 1 },
      events: [{ summary: 'Appointment', start: { dateTime: '2026-09-23T12:00:00Z', timestamp: 1790164800000 } }],
    }] };
    setSettingsData(store, owner._id, data);

    const providers = createSettingsProviders({ store });
    providers.hub = { getSkillConfigs: async () => [{
      id: 'report-skill', settings: { view: { type: 'group', childViews: [
        { type: 'switch', valueDefinition: { target: 'person', key: 'calendarEnabled' } },
      ] } },
    }] };
    server = await createSettingsInternalService({ store, settingsProviders: providers }).listen(0);
    const url = `http://127.0.0.1:${server.address().port}/`;
    const request = (accountId) => fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json;charset=utf-8',
        'x-amz-target': 'Settings_20160801.GetSettings',
        'x-amz-credentials': JSON.stringify({ id: accountId }),
        'x-phoenix-internal-token': process.env.ETCO_account_internalPeerToken,
      },
      body: JSON.stringify({ loopId: loop._id, transId: 'tid:calendar-test', getView: false, skills: 'report-skill' }),
    });

    const ownResponse = await request(owner._id);
    assert.equal(ownResponse.status, 200);
    const own = await ownResponse.json();
    assert.equal(own[0].data.calendarEnabled.value, 1);
    assert.equal(own[0].data.icalSubscriptions.subscriptions[0].events[0].summary, 'Appointment');
    assert.equal(own[0].data.icalSubscriptions.subscriptions[0].url, undefined);

    const otherResponse = await request(stranger._id);
    assert.equal(otherResponse.status, 403, 'a non-member cannot read another account calendar');
    assert.doesNotMatch(await otherResponse.text(), /Appointment|calendar\.ics|secret/);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (previousToken === undefined) delete process.env.ETCO_account_internalPeerToken;
    else process.env.ETCO_account_internalPeerToken = previousToken;
    rmSync(dir, { recursive: true, force: true });
  }
});
