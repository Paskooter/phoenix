import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { SkillRequestType } from '@phoenix/contracts';
import { reportSkill } from '../src/reportSkill.js';
import { SettingsClient } from '../src/report/settingsClient.js';
import { clearReportEnvCache } from '../src/report/env.js';
import { parseICalendar } from '../../common/src/ical.js';

const previousPrefs = process.env.prefsFromConfig;
before(() => { process.env.prefsFromConfig = 'false'; clearReportEnvCache(); });
after(() => {
  if (previousPrefs === undefined) delete process.env.prefsFromConfig;
  else process.env.prefsFromConfig = previousPrefs;
  clearReportEnvCache();
});

function request(iso, intent = 'requestCalendar') {
  return {
    type: SkillRequestType.LISTEN_LAUNCH, msgID: 'calendar-test', ts: 1,
    data: {
      general: { accountID: 'test-account', robotID: 'test-robot', lang: 'en-US' },
      runtime: {
        dialog: {}, perception: { speaker: 'test-user' },
        loop: { loopId: 'test-loop', users: [{ id: 'test-user', name: 'Test User', accountId: 'test-account', birthdate: '1990-01-01' }] },
        location: { lat: 40, lng: -74, iso },
      },
      skill: { id: 'report-skill' },
      result: { nlu: { intent, entities: {}, rules: [] }, asr: { text: '' }, memo: 'Reactive' },
    },
  };
}

function settings(t, iso, start) {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(iso) });
  const feed = `BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nUID:report-test\nDTSTART:${start}\nSUMMARY:Appointment\nEND:VEVENT\nEND:VCALENDAR`;
  const events = parseICalendar(feed, {
    timeZone: 'America/New_York', windowStart: Date.now(), windowEnd: Date.now() + 3 * 86400000,
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].start.dateTime.endsWith('Z'), true);
  t.mock.method(SettingsClient, 'getSettings', async () => [{ skillId: 'report-skill', data: {
    calendarEnabled: { value: 1 }, calendarTimeZone: { value: 'America/New_York' },
    commuteTime: { hour: 9, min: 0 },
    icalSubscriptions: { subscriptions: [{ enabled: true, verification: { status: 'ok' }, events }] },
  } }]);
}

const sourceRequest = { req: { jibo: {
  transID: 'calendar-test',
  toHeader: () => ({ 'x-jibo-transid': 'calendar-test', 'x-jibo-robotid': 'test-robot', 'x-jibo-logging-config': '{}' }),
} } };

function slims(response) {
  const jcp = response.data.action.config.jcp;
  return jcp.type === 'SLIM' ? [jcp] : jcp.children.filter((child) => child.type === 'SLIM');
}

function speech(response) { return slims(response).map((slim) => slim.config.play.esml).join(' '); }
function mimIds(response) { return slims(response).map((slim) => slim.config.play.meta.mim_id); }

function eventViews(value, found = []) {
  if (!value || typeof value !== 'object') return found;
  if (value.viewConfig?.id === 'eventView') found.push(value);
  else for (const child of Object.values(value)) eventViews(child, found);
  return found;
}

test('calendar request renders stored UTC iCal events as local speech and native card labels', async (t) => {
  const iso = '2026-10-14T08:00:00-04:00';
  settings(t, iso, '20261014T170000Z');
  const response = await reportSkill(request(iso), sourceRequest);
  assert.equal(response.data.final, true);
  assert.match(speech(response), /at 1:00 PM/);
  assert.doesNotMatch(speech(response), /5:00 PM/);
  assert.deepEqual(mimIds(response), ['CalendarEventCountToday', 'CalendarSummaryAndTime', 'CalendarOutro']);
  const views = eventViews(response.data.action.config.jcp);
  assert.equal(views.length, 1);
  assert.deepEqual(views[0].componentConfigs.slice(2, 4).map((component) => component.text), ['1', 'PM']);
  assert.match(views[0].componentConfigs[0].assets[0].src, /eventAfternoon_v01\.crn$/);
});

test('full Personal Report speaks a late UTC event as today in the robot zone', async (t) => {
  const iso = '2026-10-14T08:00:00-04:00';
  settings(t, iso, '20261015T013000Z');
  const response = await reportSkill(request(iso, 'launchPersonalReport'), sourceRequest);
  assert.equal(response.data.final, true);
  assert.ok(mimIds(response).includes('CalendarEventToday'));
  assert.match(speech(response), /9:30 PM/);
  assert.doesNotMatch(speech(response), /tomorrow|1:30 AM/);
});

test('full Personal Report uses DST-correct speech and early-event summary', async (t) => {
  const iso = '2026-10-31T18:00:00-04:00';
  settings(t, iso, '20261101T133000Z');
  const response = await reportSkill(request(iso, 'launchPersonalReport'), sourceRequest);
  assert.equal(response.data.final, true);
  assert.ok(mimIds(response).includes('CalendarEventTomorrow'));
  assert.ok(mimIds(response).includes('CalendarEarlyEvent'));
  assert.match(speech(response), /8:30 AM/);
});

test('accepted proactive Personal Report shares the local calendar speech and day classification', async (t) => {
  const iso = '2026-10-14T08:00:00-04:00';
  settings(t, iso, '20261015T013000Z');
  const launch = request(iso);
  launch.type = SkillRequestType.PROACTIVE_LAUNCH;
  launch.data.result = { nlu: null, memo: 'Proactive' };
  const proposal = await reportSkill(launch, sourceRequest);
  assert.equal(proposal.data.final, false);
  const accept = request(iso, 'yes');
  accept.type = SkillRequestType.LISTEN_UPDATE;
  accept.data.skill.session = proposal.data.skill.session;
  const response = await reportSkill(accept, sourceRequest);
  assert.equal(response.data.final, true);
  assert.ok(mimIds(response).includes('CalendarEventToday'));
  assert.match(speech(response), /9:30 PM/);
  assert.doesNotMatch(speech(response), /tomorrow|1:30 AM/);
});
