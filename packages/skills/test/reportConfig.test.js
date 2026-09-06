import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import { clearReportEnvCache, getReportEnv, reportLassoURL } from '../src/report/env.js';
import { LassoClient } from '../src/report/lassoClient.js';
import { SettingsClient } from '../src/report/settingsClient.js';
import { parseServiceArgs, parseServicePort, runService, serviceHelp, start, RUN_SERVICE_SHUTDOWN_MS } from '../src/index.js';
import { sourceJiboHeaders } from '../src/skillService.js';

const ENV_KEYS = ['NET_lasso', 'NET_data', 'NET_settings', 'prefsFromConfig', 'ETCO_report_prefsFromConfig', 'PORT', 'ETCO_server_port'];

async function withEnv(values, callback) {
  const previous = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  try {
    for (const key of ENV_KEYS) delete process.env[key];
    Object.assign(process.env, values);
    clearReportEnvCache();
    return await callback();
  } finally {
    for (const key of ENV_KEYS) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    clearReportEnvCache();
  }
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function peerServer() {
  const requests = [];
  const today = {
    currently: { temperature: 71, summary: 'Light rain', icon: 'rain' },
    daily: { data: [
      { temperatureHigh: 75, temperatureLow: 58, summary: 'Rain through the evening.', icon: 'rain' },
      { temperatureHigh: 68, temperatureLow: 51, summary: 'Partly cloudy.', icon: 'partly-cloudy-day' },
    ] },
  };
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({ method: request.method, url: request.url, headers: request.headers, body: Buffer.concat(chunks).toString('utf8') });
    response.setHeader('content-type', 'application/json');
    if (request.url.startsWith('/v1/dark_sky')) {
      response.end(JSON.stringify({ relayData: today }));
    } else if (request.method === 'POST') {
      response.end(JSON.stringify([{ skillId: 'report-skill', data: { weatherEnabled: { value: true } } }]));
    } else {
      response.end(JSON.stringify({ relayData: null }));
    }
  });
  return { server, requests };
}

test('skill request decoration matches source JiboHeaders defaults and mutable forwarding', () => {
  const defaults = sourceJiboHeaders({});
  assert.deepEqual(defaults.toHeader(), {
    'x-jibo-transid': 'unknown',
    'x-jibo-robotid': 'unknown',
    'x-jibo-logging-config': '{}',
  });

  const headers = sourceJiboHeaders({
    'x-jibo-transid': 'trans-1',
    'x-jibo-robotid': 'robot-1',
    'x-jibo-logging-config': '{"report":"debug"}',
  });
  assert.deepEqual(headers.toHeader(), {
    'x-jibo-transid': 'trans-1',
    'x-jibo-robotid': 'robot-1',
    'x-jibo-logging-config': '{"report":"debug"}',
  });
  headers.transID = 'trans-2';
  assert.equal(headers.toHeader()['x-jibo-transid'], 'trans-2');
});

test('report environment preserves source defaults, precedence, and string values', async () => {
  await withEnv({}, async () => {
    assert.deepEqual(getReportEnv(), {
      NET_lasso: 'lasso:8080', NET_settings: 'settings.jibo.aws', prefsFromConfig: 'false',
    });
  });

  await withEnv({ NET_data: 'alias-lasso:1', ETCO_report_prefsFromConfig: 'true' }, async () => {
    assert.deepEqual(getReportEnv(), {
      NET_lasso: 'alias-lasso:1', NET_settings: 'settings.jibo.aws', prefsFromConfig: 'true',
    });
  });

  await withEnv({ NET_data: 'http://alias-lasso:1' }, async () => {
    const peer = getReportEnv();
    assert.equal(peer.NET_lasso, 'http://alias-lasso:1');
    assert.equal(reportLassoURL(), 'http://alias-lasso:1');
  });

  await withEnv({ NET_lasso: 'http://source-lasso:2' }, async () => {
    // The source client always prepends http:// to its named NET_lasso value;
    // the full-URL exception belongs only to the Phoenix NET_data alias.
    assert.equal(reportLassoURL(), 'http://http://source-lasso:2');
  });

  await withEnv({
    NET_lasso: 'source-lasso:2', NET_data: 'alias-lasso:1', NET_settings: 'source-settings:3',
    prefsFromConfig: 'TRUE', ETCO_report_prefsFromConfig: 'true',
  }, async () => {
    assert.deepEqual(getReportEnv(), {
      NET_lasso: 'source-lasso:2', NET_settings: 'source-settings:3', prefsFromConfig: 'TRUE',
    });
  });

  await withEnv({ NET_lasso: '', NET_data: 'alias-lasso:1', prefsFromConfig: '', ETCO_report_prefsFromConfig: 'true' }, async () => {
    assert.deepEqual(getReportEnv(), {
      NET_lasso: 'lasso:8080', NET_settings: 'settings.jibo.aws', prefsFromConfig: 'false',
    });
  });
});

test('report environment keeps one mutable object until the explicit source-style clear', async () => {
  await withEnv({ NET_lasso: 'first-lasso:1' }, async () => {
    const first = getReportEnv();
    first.NET_lasso = 'mutated-in-place';
    process.env.NET_lasso = 'second-lasso:2';

    assert.strictEqual(getReportEnv(), first);
    assert.equal(getReportEnv().NET_lasso, 'mutated-in-place');
    assert.equal(reportLassoURL(), 'http://mutated-in-place');

    clearReportEnvCache();
    const refreshed = getReportEnv();
    assert.notStrictEqual(refreshed, first);
    assert.equal(refreshed.NET_lasso, 'second-lasso:2');
    assert.equal(reportLassoURL(), 'http://second-lasso:2');
  });

  await withEnv({ NET_data: 'http://alias-lasso:1' }, async () => {
    const first = getReportEnv();
    process.env.NET_data = 'http://changed-alias:2';
    assert.equal(reportLassoURL(), 'http://alias-lasso:1');
    clearReportEnvCache();
    assert.notStrictEqual(getReportEnv(), first);
    assert.equal(reportLassoURL(), 'http://changed-alias:2');
  });
});

test('source NET_lasso and NET_settings names drive local peer HTTP exchange', async () => {
  await withEnv({ prefsFromConfig: 'false' }, async () => {
    const { server, requests } = peerServer();
    await new Promise((resolve) => server.listen(0, resolve));
    const address = server.address();
    process.env.NET_lasso = `127.0.0.1:${address.port}`;
    process.env.NET_settings = `127.0.0.1:${address.port}`;
    delete process.env.NET_data;

    try {
      const data = {
        runtime: { location: { lat: 42.36, lng: -71.06 } },
        req: { jibo: { toHeader: () => ({
          'x-jibo-transid': 'config-transid', 'x-jibo-robotid': 'config-robot', 'x-jibo-logging-config': '{}',
        }) } },
        log: { debug() {}, info() {}, warn() {}, error() {} },
      };
      const weather = await LassoClient.fetchDarkSky(data);
      assert.equal(weather.currently.temperature, 71);
      const settings = await SettingsClient.getSettings('account-1', 'loop-1', 'trans-1');
      assert.equal(settings[0].skillId, 'report-skill');
      const darkSkyRequest = requests.find((request) => request.url.startsWith('/v1/dark_sky'));
      assert.equal(darkSkyRequest.url, '/v1/dark_sky?lat=42.3600&lon=-71.0600');
      assert.equal(darkSkyRequest.headers['x-amz-target'], undefined);
      const settingsRequest = requests.find((request) => request.method === 'POST');
      assert.equal(settingsRequest.headers['x-amz-target'], 'Settings_20160801.GetSettings');
      assert.deepEqual(JSON.parse(settingsRequest.headers['x-amz-credentials']), { id: 'account-1' });
      assert.equal(settingsRequest.headers.accept, 'application/json, text/plain, */*');
      assert.equal(settingsRequest.headers['user-agent'], 'axios/0.17.1');
      assert.equal(settingsRequest.headers.connection, 'close');
      assert.equal(settingsRequest.headers['accept-encoding'], undefined);
      assert.equal(settingsRequest.headers['accept-language'], undefined);
      assert.equal(settingsRequest.headers['sec-fetch-mode'], undefined);
      assert.deepEqual(JSON.parse(settingsRequest.body), {
        loopId: 'loop-1', transId: 'trans-1', getView: false, skills: 'report-skill',
      });
    } finally {
      await close(server);
    }
  });
});

test('SettingsClient follows source redirects and decodes compressed responses', async () => {
  await withEnv({ prefsFromConfig: 'false' }, async () => {
    const requests = [];
    const settings = [{ skillId: 'report-skill', data: { weatherEnabled: { value: true } } }];
    const server = http.createServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString('utf8');
      requests.push({ method: request.method, url: request.url, body });
      const match = request.url.match(/^\/redirect\/(301|302|303|307)$/);
      if (match) {
        response.writeHead(Number(match[1]), { Location: `/final/${match[1]}` });
        response.end();
        return;
      }
      const code = Number(request.url.split('/').pop());
      const raw = Buffer.from(JSON.stringify(settings));
      const encoded = code === 301 ? zlib.gzipSync(raw) : code === 307 ? zlib.deflateSync(raw) : raw;
      response.writeHead(200, code === 301 ? { 'content-encoding': 'gzip' } : code === 307 ? { 'content-encoding': 'deflate' } : {});
      response.end(encoded);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    process.env.NET_settings = `127.0.0.1:${port}`;
    try {
      const requestBody = { loopId: 'loop-1', transId: 'trans-1', getView: false, skills: 'report-skill' };
      for (const code of [301, 302, 303, 307]) {
        process.env.NET_settings = `127.0.0.1:${port}/redirect/${code}`;
        clearReportEnvCache();
        const result = await SettingsClient.getSettings('account-1', 'loop-1', 'trans-1');
        assert.deepEqual(result, settings);
        const pair = requests.splice(0, 2);
        assert.equal(pair.length, 2);
        assert.equal(pair[0].url, `/redirect/${code}`);
        assert.equal(pair[0].method, 'POST');
        assert.deepEqual(JSON.parse(pair[0].body), requestBody);
        assert.equal(pair[1].url, `/final/${code}`);
        assert.equal(pair[1].method, code === 307 ? 'POST' : 'GET');
        assert.equal(pair[1].body, code === 307 ? pair[0].body : '');
      }
    } finally {
      await close(server);
    }
  });
});

test('SettingsClient keeps Axios response transforms and rejection data', async () => {
  await withEnv({ prefsFromConfig: 'false' }, async () => {
    const server = http.createServer((request, response) => {
      if (request.url === '/invalid') return response.end('{not-json');
      if (request.url === '/empty') return response.end();
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'fixture', status: 400 }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    process.env.NET_settings = `127.0.0.1:${port}`;
    try {
      const run = (path) => {
        process.env.NET_settings = `127.0.0.1:${port}${path}`;
        clearReportEnvCache();
        return SettingsClient.getSettings('account-1', 'loop-1', 'trans-1');
      };
      assert.equal(await run('/invalid'), '{not-json');
      assert.equal(await run('/empty'), '');
      await assert.rejects(run('/status'), (error) => {
        assert.equal(error.message, 'Request failed with status code 400');
        assert.equal(error.response.status, 400);
        assert.deepEqual(error.response.data, { error: 'fixture', status: 400 });
        return true;
      });
    } finally {
      await close(server);
    }
  });
});

test('report service uses source variable names for a real local lasso exchange', async () => {
  await withEnv({ prefsFromConfig: 'true' }, async () => {
    const { server, requests } = peerServer();
    await new Promise((resolve) => server.listen(0, resolve));
    const address = server.address();
    process.env.NET_lasso = `127.0.0.1:${address.port}`;
    delete process.env.NET_data;
    const report = await start(0, { skillId: 'report-skill' });
    try {
      const body = {
        type: 'LISTEN_LAUNCH', msgID: 'report-config', ts: 1,
        data: {
          general: { accountID: 'account-1', robotID: 'robot-1', lang: 'en-US' },
          runtime: {
            dialog: {}, perception: { speaker: 'adult-1' },
            loop: { loopId: 'loop-1', users: [{ id: 'adult-1', accountId: 'account-1', birthdate: '1990-01-01' }] },
            location: { lat: 42.36, lng: -71.06, iso: '2026-06-12T10:00:00-04:00' },
          },
          skill: { id: 'report-skill' },
          result: { nlu: { intent: 'requestWeatherPR', entities: {}, rules: [] }, asr: { text: '' }, memo: 'Reactive' },
        },
      };
      const response = await fetch(`http://127.0.0.1:${report.address().port}/v1/main`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-jibo-transid': 'trans-1',
          'x-jibo-robotid': 'robot-1',
          'x-jibo-logging-config': '{"report":"debug"}',
          authorization: 'Bearer caller-credential-must-not-forward',
        },
        body: JSON.stringify(body),
      });
      const result = await response.json();
      assert.equal(response.status, 200);
      assert.equal(result.type, 'SKILL_ACTION');
      assert.equal(result.data.skill.id, 'report-skill');
      const darkSkyRequests = requests.filter((request) => request.url.startsWith('/v1/dark_sky'));
      assert.equal(darkSkyRequests.length, 2);
      for (const request of darkSkyRequests) {
        assert.equal(request.headers['x-jibo-transid'], 'trans-1');
        assert.equal(request.headers['x-jibo-robotid'], 'robot-1');
        assert.equal(request.headers['x-jibo-logging-config'], '{"report":"debug"}');
        assert.equal(request.headers.authorization, undefined);
      }
    } finally {
      await close(report);
      await close(server);
    }
  });
});

test('ETCO_server_port selects the service port when no explicit port is passed', async () => {
  const previous = { PORT: process.env.PORT, ETCO_server_port: process.env.ETCO_server_port };
  delete process.env.PORT;
  process.env.ETCO_server_port = '0';
  const report = await start(undefined, { skillId: 'report-skill' });
  try {
    // The source run-service passes parseInt(ETCO_server_port) through to SkillService;
    // zero therefore requests an ephemeral port rather than Phoenix's local default.
    assert.ok(report.address().port > 0);
    assert.notEqual(report.address().port, 7014);
  } finally {
    await close(report);
    if (previous.PORT === undefined) delete process.env.PORT;
    else process.env.PORT = previous.PORT;
    if (previous.ETCO_server_port === undefined) delete process.env.ETCO_server_port;
    else process.env.ETCO_server_port = previous.ETCO_server_port;
  }
});

test('service CLI port parsing follows minimist truthiness, precedence, and parseInt', () => {
  assert.equal(parseServicePort([], {}), 8080);
  assert.equal(parseServicePort([], { PORT: '9123' }), 8080, 'PORT is a Phoenix adapter, not the source CLI input');
  assert.equal(parseServicePort([], { ETCO_server_port: '8123', PORT: '9123' }), 8123);
  assert.equal(parseServicePort(['-p', '1234'], { ETCO_server_port: '8123' }), 1234);
  assert.equal(parseServicePort(['--port', '2345'], { ETCO_server_port: '8123' }), 2345);
  assert.equal(parseServicePort(['--port=3456'], {}), 3456);
  assert.equal(parseServicePort(['--p', '3457'], {}), 3457);
  assert.equal(parseServicePort(['--p=3458'], {}), 3458);
  assert.equal(parseServicePort(['-p=4567'], {}), 4567);
  assert.equal(parseServicePort(['-p', '4567', '--port', '5678'], { ETCO_server_port: '6789' }), 4567);
  assert.equal(parseServicePort(['--port', '0'], { ETCO_server_port: '7890' }), 7890, 'minimist converts 0 to a falsy number');
  assert.equal(parseServicePort(['--port=0'], { ETCO_server_port: '7890' }), 7890);
  assert.equal(parseServicePort(['--port', '08tail'], {}), 8);
  assert.equal(parseServicePort(['--port', '0x10'], {}), 16);
  assert.ok(Number.isNaN(parseServicePort([], { ETCO_server_port: 'invalid' })));
});

test('service CLI keeps generic pinned minimist behavior before port selection', () => {
  const cases = [
    ['repeated-long', ['--port', '8123', '--port', '9234'], { _: [], port: [8123, 9234] }, 8123],
    ['repeated-short', ['-p', '8123', '-p', '9234'], { _: [], p: [8123, 9234] }, 8123],
    ['repeated-mixed', ['-p=8123', '--p=9234'], { _: [], p: [8123, 9234] }, 8123],
    ['short-cluster', ['-xp8765'], { _: [], x: 'p8765' }, 8080],
    ['short-cluster-with-value', ['-vp', '8765'], { _: [], v: true, p: 8765 }, 8765],
    ['duplicate-zero', ['--port=0', '--port=9234'], { _: [], port: [0, 9234] }, 0],
    ['object-and-scalar', ['--port.x=8123', '--port=9234'], { _: [], port: [{ x: 8123 }, 9234] }, NaN],
    ['short-exponent-plus', ['-p1e+3'], { _: [], p: 1000 }, 1000],
    ['negation-after-set', ['--p=8123', '--no-p'], { _: [], p: [8123, false] }, 8123],
    ['negation-before-set', ['--no-p', '--port=9234'], { _: [], p: false, port: 9234 }, 9234],
    ['positional-and-end', ['one', '2', '--', '3'], { _: ['one', 2, '3'] }, 8080],
    ['help', ['--help'], { _: [], help: true }, 8080],
    ['short-help', ['-h'], { _: [], h: true }, 8080],
  ];
  for (const [label, args, expectedArgv, expectedPort] of cases) {
    assert.deepEqual(parseServiceArgs(args), expectedArgv, label);
    const actual = parseServicePort(args, {});
    if (Number.isNaN(expectedPort)) assert.ok(Number.isNaN(actual), label);
    else assert.equal(actual, expectedPort, label);
  }

  // The old minimist release used by Pegasus is MIT-licensed, but its dotted
  // setter must not reintroduce prototype pollution into the Phoenix CLI.
  parseServiceArgs(['--__proto__.polluted=yes', '--constructor.prototype.polluted=yes']);
  assert.equal({}.polluted, undefined);
  assert.equal(serviceHelp('/opt/report-skill/run-service.js'),
    'Usage: run-service.js [options]\n  Options:\n  --port, -p: [default: 8080] Port of service');
});

test('executable service wrapper logs and delays a missing Promise without changing programmatic start', () => {
  const errors = [];
  const delays = [];
  const exits = [];
  runService('PersonalReportSkill', () => undefined, {
    reportError: (error) => errors.push(error),
    scheduleExit: (callback, delay) => { delays.push(delay); callback(); },
    exit: (status) => exits.push(status),
  });

  assert.deepEqual(errors, ["Service didn't return promise"]);
  assert.deepEqual(delays, [RUN_SERVICE_SHUTDOWN_MS]);
  assert.deepEqual(exits, [1]);
});

test('executable service wrapper routes synchronous and rejected startup errors through the same shutdown', async () => {
  const seen = [];
  const options = {
    reportError: (error) => seen.push(error),
    scheduleExit: (callback, delay) => { seen.push(delay); callback(); },
    exit: (status) => seen.push(status),
  };
  runService('Skills', () => { throw new Error('sync startup failure'); }, options);
  runService('Skills', () => Promise.reject(new Error('async startup failure')), options);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(seen[0].message, 'sync startup failure');
  assert.equal(seen[1], RUN_SERVICE_SHUTDOWN_MS);
  assert.equal(seen[2], 1);
  assert.equal(seen[3].message, 'async startup failure');
  assert.equal(seen[4], RUN_SERVICE_SHUTDOWN_MS);
  assert.equal(seen[5], 1);
});

test('service runner still schedules shutdown when its error logger fails', (t) => {
  const stderr = [];
  const shutdown = [];
  const originalError = console.error;
  console.error = (...args) => stderr.push(args);
  t.after(() => { console.error = originalError; });
  const loggerError = new Error('logging configuration unavailable');
  const startupError = new Error('startup failed');
  runService('Skills', () => { throw startupError; }, {
    reportError: () => { throw loggerError; },
    scheduleExit: (callback, delay) => { shutdown.push(delay); callback(); },
    exit: (status) => shutdown.push(status),
  });
  assert.deepEqual(stderr, [['Error creating error logger', loggerError], [startupError]]);
  assert.deepEqual(shutdown, [5000, 1]);
});
