import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SettingsClient } from '../src/report/settingsClient.js';
import { getData } from '../src/report/calendar.js';

const event = {
  uid: 'ical-1',
  summary: 'Dentist',
  fullDay: false,
  start: { timestamp: Date.parse('2026-06-12T13:00:00Z'), dateTime: '2026-06-12T09:00:00-04:00' },
  end: { timestamp: Date.parse('2026-06-12T14:00:00Z'), dateTime: '2026-06-12T10:00:00-04:00' },
};

function reportData() {
  return {
    runtime: {
      location: { iso: '2026-06-12T08:00:00-04:00' },
      loop: { loopId: 'loop-1', users: [{ id: 'speaker-1', accountId: 'account-1' }] },
      perception: { speaker: 'speaker-1' },
    },
    skill: { id: 'report-skill' },
    log: { error() {} },
  };
}

test('settings wire conversion carries enabled verified iCal events and timezone to report prefs', () => {
  const prefs = SettingsClient.convertSettingsToPrefs({
    calendarEnabled: { value: 1 },
    calendarTimeZone: { value: 'America/New_York' },
    icalSubscriptions: {
      subscriptions: [{
        id: 'sub-1', label: 'Personal', enabled: true,
        verification: { status: 'ok' }, events: [event],
      }],
    },
  });
  assert.equal(prefs.calendar.active, true);
  assert.equal(prefs.calendar.timeZone, 'America/New_York');
  assert.deepEqual(prefs.calendar.icalSubscriptions[0].events, [event]);
});

test('report calendar getData reads stored iCal events without replacing the legacy Lasso path', async () => {
  const prefs = {
    calendar: {
      active: true,
      googlePersonalCreds: false,
      googleWorkCreds: false,
      outlookPersonalCreds: false,
      outlookWorkCreds: false,
      icalSubscriptions: [{
        id: 'sub-1', enabled: true, verification: { status: 'ok' }, events: [event],
      }],
    },
  };
  const [name, events] = await getData(prefs, reportData());
  assert.equal(name, 'calendar');
  assert.deepEqual(events, [event]);
});
