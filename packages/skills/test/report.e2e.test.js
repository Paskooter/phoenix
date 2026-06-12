// PersonalReport happy path against a mock lasso: real weather-change condition tables,
// real news parse/dedupe, and the closing mega-MAN sequence with templates resolved.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { SkillRequestType } from '@phoenix/contracts';
import { reportSkill } from '../src/reportSkill.js';

// Yesterday cloudy / high 60 -> today rain / high 75: ChangeCloudyWet (suppresses the Comment
// MIM) + TodayWarmer (+15°F, suppresses TodayHighLow).
const YESTERDAY = { daily: { data: [{ temperatureHigh: 60, temperatureLow: 45, summary: 'Cloudy all day.', icon: 'cloudy' }] } };
const TODAY = {
  currently: { temperature: 71, summary: 'Light rain', icon: 'rain' },
  daily: {
    data: [
      { temperatureHigh: 75, temperatureLow: 58, summary: 'Rain through the evening.', icon: 'rain' },
      { temperatureHigh: 68, temperatureLow: 51, summary: 'Partly cloudy.', icon: 'partly-cloudy-day' },
    ],
  },
};
const NEWS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:apcm="http://ap.org/schemas/03/2010/contentmetadata">
  <entry>
    <summary>A friendly robot returns to shelves this year.</summary>
    <apcm:ContentMetadata>
      <apcm:ExtendedHeadLine>Jibo robot makes a comeback</apcm:ExtendedHeadLine>
    </apcm:ContentMetadata>
  </entry>
  <entry>
    <summary>Local weather stations report record rainfall.</summary>
    <apcm:ContentMetadata>
      <apcm:ExtendedHeadLine>Record rainfall in New England</apcm:ExtendedHeadLine>
    </apcm:ContentMetadata>
  </entry>
</feed>`;

let server;
before(async () => {
  server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    res.writeHead(200, { 'content-type': 'application/json' });
    if (u.pathname === '/v1/dark_sky') {
      const isYesterday = u.searchParams.has('secondsSinceEpoch');
      res.end(JSON.stringify({ relayData: isYesterday ? YESTERDAY : TODAY }));
    } else if (u.pathname === '/v1/ap_news') {
      res.end(JSON.stringify({ relayData: NEWS_XML }));
    } else {
      res.end(JSON.stringify({ relayData: null }));
    }
  });
  await new Promise((r) => server.listen(0, r));
  process.env.NET_data = `localhost:${server.address().port}`;
});
after(() => { server.close(); delete process.env.NET_data; });

const launch = () => ({
  type: SkillRequestType.LISTEN_LAUNCH, msgID: 'm', ts: 1,
  data: {
    general: { accountID: 'a', robotID: 'r', lang: 'en-US' },
    runtime: {
      dialog: {},
      perception: { speaker: 'u1' },
      loop: { loopId: 'loop-1', users: [{ id: 'u1', name: 'Alice Smith', accountId: 'acct-1', birthdate: '1990-01-01' }] },
      location: { lat: 42.36, lng: -71.06, iso: '2026-06-12T10:00:00-04:00' }, // 10am: daytime -> today
    },
    skill: { id: 'report-skill' },
    result: { nlu: { intent: 'launchPersonalReport', entities: {}, rules: [] }, asr: { text: '' }, memo: 'Reactive' },
  },
});

const slims = (r) => r.data.action.config.jcp.children.filter((c) => c.type === 'SLIM');

test('full report: weather change tables + news headlines assemble the mega-MAN', async () => {
  const r = await reportSkill(launch());
  assert.equal(r.data.final, true);
  const mims = slims(r).map((s) => s.config.play.meta.mim_id);
  assert.deepEqual(mims, [
    'PersonalReportSettingsFailed', // settings service still dead -> defaults
    'WeatherIntro',
    'WeatherChangeCloudyWet',       // cloudy yesterday -> rain today
    'WeatherTodayWarmer',           // +15°F, below the hot threshold
    'NewsIntro',
    // 4 default categories -> 1 item per category; the dedupe leaves only the first
    // category with stories, so exactly one headline survives.
    'NewsHeadline',
    'PersonalReportOutroConfigured',
  ]);

  const esml = slims(r).map((s) => s.config.play.esml);
  const headlineEsml = esml.slice(mims.indexOf('NewsHeadline')).join(' ');
  assert.match(headlineEsml, /Jibo robot makes a comeback/);
  const weatherEsml = esml.join(' ');
  assert.match(weatherEsml, /75/, 'today high resolved into a prompt');
});

test('single-skill weather request speaks real conditions (Intro + change + temp MIMs)', async () => {
  const req = launch();
  req.data.result.nlu.intent = 'requestWeatherPR';
  const r = await reportSkill(req);
  const mims = slims(r).map((s) => s.config.play.meta.mim_id);
  assert.deepEqual(mims, ['WeatherIntro', 'WeatherChangeCloudyWet', 'WeatherTodayWarmer'],
    'no kickoff/settings/outro mims on single-skill launch');
});
