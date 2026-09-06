import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { SkillRequestType } from '@phoenix/contracts';
import { buildResultsAnalytics } from '../src/report/analytics.js';
import { reportSkill } from '../src/reportSkill.js';
import { clearReportEnvCache } from '../src/report/env.js';

function data({ configured, active, result }) {
  return {
    skill: { session: { data: { _personalReport: { userPrefsConfigured: configured } } } },
    local: {
      userPrefs: {
        weather: { active: !!active.weather },
        calendar: { active: !!active.calendar },
        commute: { active: !!active.commute },
        news: { active: !!active.news },
      },
    },
    result,
  };
}

test('results analytics uses source category order and selected-service status', () => {
  assert.deepEqual(buildResultsAnalytics(data({
    configured: false,
    active: { weather: true, calendar: false, commute: false, news: true },
    result: { weather: { relayData: {} }, news: { relayData: {} } },
  })), {
    details: 'weather,news',
    service_details: 'weather=up,news=up',
    config_state: 'not configured',
  });

  assert.deepEqual(buildResultsAnalytics(data({
    configured: null,
    active: { weather: true, calendar: false, commute: false, news: true },
    result: { news: { relayData: {} } },
  })), {
    details: 'weather,news',
    service_details: 'weather=down,news=up',
    config_state: 'not configured',
  });
});

test('results analytics reports a single selected category without adding inactive fields', () => {
  assert.deepEqual(buildResultsAnalytics(data({
    configured: true,
    active: { weather: false, calendar: true, commute: false, news: false },
    result: { calendar: [] },
  })), {
    details: 'calendar',
    service_details: 'calendar=up',
    config_state: 'configured',
  });
});

test('results analytics keeps an empty selection source-shaped', () => {
  assert.deepEqual(buildResultsAnalytics(data({
    configured: false,
    active: { weather: false, calendar: false, commute: false, news: false },
    result: {},
  })), {
    details: '',
    service_details: '',
    config_state: 'not configured',
  });
});

test('report graph emits source results analytics on its real response path', async () => {
  const previous = {
    NET_data: process.env.NET_data,
    NET_lasso: process.env.NET_lasso,
    prefsFromConfig: process.env.prefsFromConfig,
    ETCO_report_prefsFromConfig: process.env.ETCO_report_prefsFromConfig,
  };
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      response.setHeader('content-type', 'application/json');
      if (request.url.startsWith('/v1/dark_sky')) {
        response.end(JSON.stringify({ relayData: {
          currently: { temperature: 70, summary: 'Clear', icon: 'clear-day' },
          daily: { data: [
            { temperatureHigh: 70, temperatureLow: 50, summary: 'Clear', icon: 'clear-day' },
            { temperatureHigh: 70, temperatureLow: 50, summary: 'Clear', icon: 'clear-day' },
          ] },
        } }));
      } else if (request.url.startsWith('/v1/ap_news')) {
        response.end(JSON.stringify({ relayData: '<feed></feed>' }));
      } else {
        response.end(JSON.stringify({ relayData: null }));
      }
    });
  });

  try {
    await new Promise((resolve) => server.listen(0, resolve));
    process.env.NET_data = `127.0.0.1:${server.address().port}`;
    delete process.env.NET_lasso;
    process.env.ETCO_report_prefsFromConfig = 'true';
    delete process.env.prefsFromConfig;
    clearReportEnvCache();

    const response = await reportSkill({
      type: SkillRequestType.LISTEN_LAUNCH,
      msgID: 'analytics-test',
      ts: 1,
      data: {
        general: { accountID: 'account', robotID: 'robot', lang: 'en-US' },
        runtime: {
          dialog: {},
          perception: { speaker: 'speaker' },
          loop: { loopId: 'loop', users: [{ id: 'speaker', accountId: 'account', birthdate: '1990-01-01' }] },
          location: { lat: 42.36, lng: -71.06, iso: '2026-06-12T10:00:00-04:00' },
        },
        skill: { id: 'report-skill' },
        result: { nlu: { intent: 'launchPersonalReport', entities: {}, rules: [] }, asr: { text: '' }, memo: 'Reactive' },
      },
    });

    assert.deepEqual(response.data.analytics['report-skill'][1], {
      event: 'Personal Report Results',
      properties: {
        details: 'weather,calendar,commute,news',
        service_details: 'weather=up,calendar=down,commute=down,news=up',
        config_state: 'not configured',
      },
    });
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    clearReportEnvCache();
  }
});
