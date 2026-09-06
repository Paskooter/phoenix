import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import { clearReportEnvCache } from '../src/report/env.js';
import { LassoClient } from '../src/report/lassoClient.js';

const previousLasso = () => process.env.NET_lasso;

function makeData() {
  const log = { createChild: () => log, debug() {}, info() {}, warn() {}, error() {} };
  return {
    runtime: {
      location: { lat: 42.313352, lng: -71.1273681 },
      loop: { loopId: 'loop-1', users: [{ id: 'speaker-1', accountId: 'account-1' }] },
      perception: { speaker: 'speaker-1' },
    },
    skill: { id: 'report-skill' },
    req: { jibo: { toHeader: () => ({ 'x-jibo-transid': 'wire-test', 'x-jibo-robotid': 'robot-1', 'x-jibo-logging-config': '{}' }) } },
    log,
  };
}

function relay(pathname) {
  const value = pathname === '/v1/ap_news'
    ? '<rss><channel><item><title>Wire</title></item></channel></rss>'
    : { ok: true, endpoint: pathname };
  return JSON.stringify({ relayData: value });
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function withPeer(handler, callback) {
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push({ method: request.method, url: request.url, headers: request.headers });
    handler(request, response);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const old = previousLasso();
  process.env.NET_lasso = `127.0.0.1:${server.address().port}`;
  delete process.env.NET_data;
  clearReportEnvCache();
  try { return await callback(requests); }
  finally {
    await close(server);
    if (old === undefined) delete process.env.NET_lasso;
    else process.env.NET_lasso = old;
    clearReportEnvCache();
  }
}

test('LassoClient uses the source Axios query and header wire', async () => {
  await withPeer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(relay(new URL(request.url, 'http://peer').pathname));
  }, async (requests) => {
    const data = makeData();
    assert.deepEqual(await LassoClient.fetchDarkSky(data), { ok: true, endpoint: '/v1/dark_sky' });
    assert.deepEqual(await LassoClient.fetchGoogleMaps(data, {
      origin: { lat: 1.2, lng: -3.4 }, destination: { lat: 5.6, lng: 7.8 }, mode: 'driving',
    }), { ok: true, endpoint: '/v1/google_maps' });
    assert.deepEqual(await LassoClient.fetchCalendarEvents(data, 'google', 'personalCalendar', '2018-06-01T12:00:00.000Z'), {
      ok: true, endpoint: '/v1/google_calendar',
    });
    const news = await LassoClient.fetchAPNews(data, { activeNewsCategories: { technology: true, unknown: true } });
    assert.equal(news[0].data.rss.channel[0].item[0].title[0], 'Wire');
    assert.equal(news[1].category.sourceID, undefined);

    assert.deepEqual(requests.map(({ method, url }) => [method, url]), [
      ['GET', '/v1/dark_sky?lat=42.3134&lon=-71.1274'],
      ['GET', '/v1/google_maps?origin=%7B%22lat%22:1.2,%22lon%22:-3.4%7D&destination=%7B%22lat%22:5.6,%22lon%22:7.8%7D&mode=driving'],
      ['GET', '/v1/google_calendar?skillId=report-skill&accountId=account-1&calendar=personalCalendar&endDate=2018-06-01T12:00:00.000Z'],
      ['GET', '/v1/ap_news?sourceID=42208'],
      ['GET', '/v1/ap_news'],
    ]);
    for (const request of requests) {
      assert.equal(request.headers.accept, 'application/json, text/plain, */*');
      assert.equal(request.headers['user-agent'], 'axios/0.17.1');
      assert.equal(request.headers.connection, 'close');
      assert.equal(request.headers['accept-encoding'], undefined);
      assert.equal(request.headers['x-jibo-transid'], 'wire-test');
      assert.equal(request.headers['x-jibo-robotid'], 'robot-1');
      assert.equal(request.headers['x-jibo-logging-config'], '{}');
    }
  });
});

test('LassoClient matches source errors, decompression, redirects, and fire-and-forget HEAD', async () => {
  let mode = 'status';
  await withPeer((request, response) => {
    const pathname = new URL(request.url, 'http://peer').pathname;
    if (mode === 'redirect' && pathname === '/v1/dark_sky') {
      response.writeHead(302, { Location: '/final' }); response.end(); return;
    }
    if (mode === 'redirect' && pathname === '/final') {
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(relay('/v1/dark_sky')); return;
    }
    if (mode === 'status') {
      response.writeHead(503, { 'content-type': 'application/json' }); response.end(relay(pathname)); return;
    }
    if (mode === 'empty') {
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(); return;
    }
    if (mode === 'invalid') {
      response.writeHead(200, { 'content-type': 'application/json' }); response.end('not-json'); return;
    }
    if (mode === 'gzip') {
      response.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
      response.end(zlib.gzipSync(Buffer.from(relay(pathname)))); return;
    }
    response.writeHead(302, { 'content-type': 'application/json' }); response.end(relay(pathname));
  }, async (requests) => {
    const data = makeData();
    await assert.rejects(LassoClient.fetchDarkSky(data), (error) => {
      assert.equal(error.message, 'Request failed with status code 503');
      assert.equal(error.response.status, 503);
      return true;
    });
    mode = 'empty';
    await assert.rejects(LassoClient.fetchDarkSky(data), { message: 'Incomplete Lasso data from: DarkSky' });
    mode = 'invalid';
    await assert.rejects(LassoClient.fetchDarkSky(data), { message: 'Incomplete Lasso data from: DarkSky' });
    mode = 'gzip';
    assert.deepEqual(await LassoClient.fetchDarkSky(data), { ok: true, endpoint: '/v1/dark_sky' });
    mode = 'redirect';
    assert.deepEqual(await LassoClient.fetchDarkSky(data), { ok: true, endpoint: '/v1/dark_sky' });
    requests.length = 0;
    await LassoClient.fetchDarkSky(data, null, true);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(requests.map(({ method, url }) => [method, url]), [
      ['HEAD', '/v1/dark_sky?lat=42.3134&lon=-71.1274'],
      ['GET', '/final'],
    ]);
  });
});
