import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DateTime } from '../src/report/dateTime.js';
import { hiLoTempView } from '../src/report/weatherViews.js';
import { newsViews } from '../src/report/newsViews.js';
import { trafficView, departView } from '../src/report/commuteViews.js';
import { calEventViews } from '../src/report/calendarViews.js';

// Primitive outputs were compared against the frozen Pegasus Node8 compiled
// helpers at packages/report-skill/lib/subskills/{weather,news,commute,calendar}
// /{Weather,News,Commute,Calendar}Views.js. The source hashes and resource
// hashes are recorded in docs/parity/candidates/S-13.md.

test('S-13 source weather vector preserves the Nimbus view contract', async () => {
  const view = await hiLoTempView({ highTemp: 86, lowTemp: 6, icon: 'rain' }, false);
  const [bg, icon, hi, hiUnit, lo, loUnit] = view.componentConfigs;
  assert.deepEqual({
    id: view.viewConfig.id,
    background: bg.assets[0].src,
    icon: icon.assets[0].src,
    high: hi.text,
    highUnit: hiUnit.text,
    low: lo.text,
    lowUnit: loUnit.text,
    highX: hi.position.x,
    lowX: lo.position.x,
  }, {
    id: 'weatherTempView',
    background: 'assets/personal-report-skill/weather/bg/tempHot_v01.crn',
    icon: 'assets/personal-report-skill/weather/icons/rain_v01.crn',
    high: '86°',
    highUnit: 'F',
    low: '6°',
    lowUnit: 'F',
    highX: 370,
    lowX: 1040,
  });
});

test('S-13 source news vector preserves image geometry and final close behavior', async () => {
  const view = (await newsViews([{ category: 'strange', image: { source: 'preview', width: '300', height: '512' } }]))[0];
  const image = view.componentConfigs[0];
  assert.deepEqual({
    id: view.viewConfig.id,
    image: image.assets[0].src,
    scale: image.transform.scaleX,
    x: image.position.x,
    y: image.position.y,
    category: view.componentConfigs[2].text,
    removeAll: view.defaultSelect.removeAll,
    leaveEmpty: view.defaultSelect.leaveEmpty,
  }, {
    id: 'headlineView_0', image: 'preview', scale: 720 / 512, x: 429, y: 0,
    category: 'Strange News', removeAll: true, leaveEmpty: false,
  });
});

test('S-13 source commute vectors preserve traffic and departure labels', async () => {
  assert.equal((await trafficView(5)).componentConfigs[0].assets[0].src,
    'assets/personal-report-skill/commute/trafficBad_v01.crn');
  const view = await departView({ departDT: new DateTime('2026-06-12T08:30:00-04:00') });
  assert.deepEqual(view.componentConfigs.slice(1).map((component) => component.text), ['8:30', 'AM']);
});

test('S-13 source calendar vector preserves icon, labels, and text placement', async () => {
  const event = {
    dateTime: new DateTime('2026-06-12T09:30:00-04:00'),
    summary: 'Take the dog for a walk',
    fullDay: false,
  };
  const view = (await calEventViews([event], {
    skill: { session: { data: { _personalReport: { singleSkill: 'calendar' } } } },
  }))[0];
  const [, icon, time, ampm, summary] = view.componentConfigs;
  assert.deepEqual({
    card: view.componentConfigs[0].assets[0].src,
    icon: icon.assets[0].src,
    time: time.text,
    ampm: ampm.text,
    timeX: time.position.x,
    ampmX: ampm.position.x,
    summary: summary.text,
    leaveEmpty: view.defaultSelect.leaveEmpty,
  }, {
    card: 'assets/personal-report-skill/calendar/cards/eventMorning_v01.crn',
    icon: 'assets/personal-report-skill/calendar/icons/dog_v01.crn',
    time: '9:30',
    ampm: 'AM',
    timeX: 743,
    ampmX: 745,
    summary: 'Take the dog for a walk',
    leaveEmpty: false,
  });
});
