import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DateTime } from '../src/report/dateTime.js';
import { hiLoTempView } from '../src/report/weatherViews.js';
import { newsViews } from '../src/report/newsViews.js';
import { trafficView, departView } from '../src/report/commuteViews.js';
import { calEventViews } from '../src/report/calendarViews.js';

const sourceReportData = (singleSkill = null) => ({
  skill: { session: { data: { _personalReport: { singleSkill } } } },
});

test('S-13 weather view uses source temperature bands, assets, units, and offsets', async () => {
  const hot = await hiLoTempView({ highTemp: 86, lowTemp: 6, icon: 'rain' }, false);
  const [hotBg, icon, hi, hiUnit, lo, loUnit] = hot.componentConfigs;
  assert.match(hotBg.assets[0].src, /tempHot_v01\.crn$/);
  assert.match(icon.assets[0].src, /icons\/rain_v01\.crn$/);
  assert.equal(hi.text, '86°');
  assert.equal(lo.text, '6°');
  assert.equal(hiUnit.text, 'F');
  assert.equal(loUnit.text, 'F');
  assert.equal(hi.position.x, 370);
  assert.equal(lo.position.x, 1040);

  const celsius = await hiLoTempView({ highTemp: 66, lowTemp: 57, icon: 'cloudy' }, true);
  const [, , cHi, cHiUnit, cLo, cLoUnit] = celsius.componentConfigs;
  assert.equal(cHi.text, '66°');
  assert.equal(cLo.text, '57°');
  assert.equal(cHiUnit.text, 'C');
  assert.equal(cLoUnit.text, 'C');
});

test('S-13 weather view keeps exact hot/cold threshold boundaries', async () => {
  const bg = async (highTemp) => (await hiLoTempView({ highTemp, lowTemp: 40, icon: 'clear-day' }, false)).componentConfigs[0].assets[0].src;
  assert.match(await bg(39), /tempCold_v01\.crn$/);
  assert.match(await bg(40), /tempNormal_v01\.crn$/);
  assert.match(await bg(85), /tempNormal_v01\.crn$/);
  assert.match(await bg(86), /tempHot_v01\.crn$/);
});

test('S-13 news view scales images, labels strange news, and closes the last view', async () => {
  const views = await newsViews([
    { category: 'technology', image: { source: 'wide', width: 512, height: 300 } },
    { category: 'strange', image: { source: 'portrait', width: 300, height: 512 } },
  ]);
  assert.equal(views.length, 2);
  assert.equal(views[0].viewConfig.id, 'headlineView_0');
  assert.equal(views[1].viewConfig.id, 'headlineView_1');
  assert.equal(views[0].componentConfigs.find((c) => c.id === 'categoryText').text, 'Technology');
  assert.equal(views[1].componentConfigs.find((c) => c.id === 'categoryText').text, 'Strange News');
  assert.equal(views[0].componentConfigs[0].assets[0].src, 'wide');
  assert.equal(views[0].componentConfigs[0].transform.scaleX, 1280 / 512);
  assert.equal(views[1].componentConfigs[0].transform.scaleX, 720 / 512);
  assert.equal(views[0].defaultSelect.leaveEmpty, true);
  assert.equal(views[1].defaultSelect.removeAll, true);
  assert.equal(views[1].defaultSelect.leaveEmpty, false);
});

test('S-13 news view preserves source errors for empty or incomplete items', async () => {
  await assert.rejects(() => newsViews([{ category: 'science', headline: 'No image' }]), TypeError);
  await assert.rejects(() => newsViews([]), TypeError);
  const [invalidDimensions] = await newsViews([{
    category: 'science', image: { source: 'fixture', width: 'invalid', height: '512' },
  }]);
  assert.equal(Number.isNaN(invalidDimensions.componentConfigs[0].transform.scaleX), true);
});

test('S-13 commute view uses source traffic bands and departure labels', async () => {
  assert.match((await trafficView(4)).componentConfigs[0].assets[0].src, /trafficNormal_v01\.crn$/);
  assert.match((await trafficView(5)).componentConfigs[0].assets[0].src, /trafficBad_v01\.crn$/);
  assert.match((await trafficView(15)).componentConfigs[0].assets[0].src, /trafficTerrible_v01\.crn$/);

  const view = await departView({ departDT: new DateTime('2026-06-12T08:30:00-04:00') });
  const [, time, ampm] = view.componentConfigs;
  assert.equal(time.text, '8:30');
  assert.equal(ampm.text, 'AM');
});

test('S-13 calendar view selects source card/icon/time fields and single-skill leaveEmpty', async () => {
  const event = {
    dateTime: new DateTime('2026-06-12T09:30:00-04:00'),
    summary: 'Take the dog for a walk',
    fullDay: false,
  };
  const view = (await calEventViews([event], sourceReportData('calendar')))[0];
  const [card, icon, time, ampm, summary] = view.componentConfigs;
  assert.match(card.assets[0].src, /cards\/eventMorning_v01\.crn$/);
  assert.match(icon.assets[0].src, /icons\/dog_v01\.crn$/);
  assert.equal(time.text, '9:30');
  assert.equal(ampm.text, 'AM');
  assert.equal(time.position.x, 743);
  assert.equal(ampm.position.x, 745);
  assert.equal(summary.text, 'Take the dog for a walk');
  assert.equal(view.defaultSelect.leaveEmpty, false);
});

test('S-13 calendar view handles full-day, night, default icon, and summary truncation', async () => {
  const fullDay = (await calEventViews([{
    dateTime: new DateTime('2026-06-12T00:00:00-04:00'),
    summary: 'A very long event title that should be shortened because it exceeds fifty characters',
    fullDay: true,
  }], sourceReportData()))[0];
  const [card, icon, time, ampm, summary] = fullDay.componentConfigs;
  assert.match(card.assets[0].src, /cards\/eventMorning_v01\.crn$/);
  assert.match(icon.assets[0].src, /icons\/calendar_v01\.crn$/);
  assert.equal(time.text, '');
  assert.equal(ampm.text, '');
  assert.equal(summary.text.length, 50);
  assert.match(summary.text, /\.\.\.$/);

  const night = (await calEventViews([{
    dateTime: new DateTime('2026-06-12T20:00:00-04:00'), summary: 'Meeting', fullDay: false,
  }], sourceReportData()))[0];
  assert.match(night.componentConfigs[0].assets[0].src, /cards\/eventNight_v01\.crn$/);
  assert.match(night.componentConfigs[1].assets[0].src, /icons\/calendar_v01\.crn$/);
});
