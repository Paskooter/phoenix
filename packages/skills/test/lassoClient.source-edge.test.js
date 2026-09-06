import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import zlib from 'node:zlib';
import { clearReportEnvCache } from '../src/report/env.js';
import { LassoClient } from '../src/report/lassoClient.js';

function makeData() {
  const log = { createChild: () => log, debug() {}, info() {}, warn() {}, error() {} };
  return {
    runtime: { location: { lat: 42.313352, lng: -71.1273681 } },
    req: { jibo: { toHeader: () => ({ 'x-jibo-transid': 'edge-test' }) } },
    log,
  };
}

function relay(value) { return JSON.stringify({ relayData: value }); }

async function withRawPeer(body, headers, callback) {
  const server = net.createServer((socket) => {
    let request = '';
    socket.on('data', (chunk) => {
      request += chunk.toString('latin1');
      if (!request.includes('\r\n\r\n')) return;
      const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
      const headerLines = Object.entries({ Connection: 'close', ...headers, 'Content-Length': headers['Content-Length'] ?? bytes.length })
        .map(([key, value]) => `${key}: ${value}`);
      socket.write(`HTTP/1.1 200 OK\r\n${headerLines.join('\r\n')}\r\n\r\n`);
      socket.write(bytes);
      socket.destroy();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const previous = process.env.NET_lasso;
  process.env.NET_lasso = `127.0.0.1:${server.address().port}`;
  delete process.env.NET_data;
  clearReportEnvCache();
  try { return await callback(); }
  finally {
    await new Promise((resolve) => server.close(resolve));
    if (previous === undefined) delete process.env.NET_lasso;
    else process.env.NET_lasso = previous;
    clearReportEnvCache();
  }
}

test('LassoClient finishes aborted plain responses like source Axios', async () => {
  const full = relay({ ok: true });
  await withRawPeer(full.slice(0, 12), { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(full) }, async () => {
    await assert.rejects(LassoClient.fetchDarkSky(makeData()), { message: 'Incomplete Lasso data from: DarkSky' });
  });
});

test('LassoClient reports source decompressor errors for aborted gzip and deflate', async () => {
  const full = Buffer.from(relay({ ok: true }));
  for (const [encoding, compressed] of [['gzip', zlib.gzipSync(full)], ['deflate', zlib.deflateSync(full)]]) {
    await withRawPeer(compressed.slice(0, Math.max(1, Math.floor(compressed.length / 2))), {
      'Content-Type': 'application/json', 'Content-Encoding': encoding, 'Content-Length': compressed.length,
    }, async () => {
      await assert.rejects(LassoClient.fetchDarkSky(makeData()), (error) => {
        assert.equal(error.code, 'Z_BUF_ERROR');
        assert.equal(error.message, 'unexpected end of file');
        return true;
      });
    });
  }
});

test('LassoClient preserves complete source response data and headers on status errors', async () => {
  const server = http.createServer((request, response) => {
    response.writeHead(503, { 'content-type': 'application/json', 'x-source-edge': 'status' });
    response.end(relay({ failed: true }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const previous = process.env.NET_lasso;
  process.env.NET_lasso = `127.0.0.1:${server.address().port}`;
  delete process.env.NET_data;
  clearReportEnvCache();
  try {
    await assert.rejects(LassoClient.fetchDarkSky(makeData()), (error) => {
      assert.equal(error.response.status, 503);
      assert.deepEqual(error.response.data, { relayData: { failed: true } });
      assert.equal(error.response.headers['x-source-edge'], 'status');
      assert.equal(error.response.headers['content-type'], 'application/json');
      return true;
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (previous === undefined) delete process.env.NET_lasso;
    else process.env.NET_lasso = previous;
    clearReportEnvCache();
  }
});

test('LassoClient keeps source method boundaries for missing request/location data', async () => {
  const cases = [
    [(data) => { delete data.req; }, "Cannot read property 'jibo' of undefined"],
    [(data) => { data.req = {}; }, "Cannot read property 'toHeader' of undefined"],
    [(data) => { data.req = { jibo: {} }; }, 'data.req.jibo.toHeader is not a function'],
    [(data) => { delete data.log; }, "Cannot read property 'createChild' of undefined"],
    [(data) => { delete data.runtime.location; }, "Cannot read property 'lat' of undefined"],
    [(data) => { data.runtime.location = null; }, "Cannot read property 'lat' of null"],
    [(data) => { data.runtime.location.lat = '42.313352'; }, 'data.runtime.location.lat.toFixed is not a function'],
  ];
  for (const [mutate, message] of cases) {
    const data = makeData();
    mutate(data);
    await assert.rejects(LassoClient.fetchDarkSky(data), (error) => {
      assert.equal(error.name, 'TypeError');
      assert.equal(error.message, message);
      return true;
    });
  }
});

test('LassoClient snapshots Jibo headers once across redirects', async () => {
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push({ url: request.url, snapshot: request.headers['x-jibo-snapshot'] });
    if (request.url.startsWith('/v1/dark_sky')) {
      response.writeHead(302, { Location: '/final' });
      response.end();
      return;
    }
    response.end(JSON.stringify({ relayData: { ok: true } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const previous = process.env.NET_lasso;
  process.env.NET_lasso = `127.0.0.1:${server.address().port}`;
  delete process.env.NET_data;
  clearReportEnvCache();
  let calls = 0;
  const data = makeData();
  data.req.jibo.toHeader = () => ({ 'x-jibo-snapshot': String(++calls) });
  try {
    await assert.deepEqual(await LassoClient.fetchDarkSky(data), { ok: true });
    assert.equal(calls, 1);
    assert.deepEqual(requests.map(({ url, snapshot }) => ({ url, snapshot })), [
      { url: '/v1/dark_sky?lat=42.3134&lon=-71.1274', snapshot: '1' },
      { url: '/final', snapshot: '1' },
    ]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (previous === undefined) delete process.env.NET_lasso;
    else process.env.NET_lasso = previous;
    clearReportEnvCache();
  }
});

test('LassoClient copies the returned header map before a redirect can mutate it', async () => {
  const requests = [];
  const headerObject = { 'x-jibo-mutable': 'before' };
  const server = http.createServer((request, response) => {
    requests.push({ url: request.url, mutable: request.headers['x-jibo-mutable'], added: request.headers['x-jibo-added'] });
    if (request.url.startsWith('/v1/dark_sky')) {
      headerObject['x-jibo-mutable'] = 'after';
      headerObject['x-jibo-added'] = 'after';
      response.writeHead(302, { Location: '/final' });
      response.end();
      return;
    }
    response.end(JSON.stringify({ relayData: { ok: true } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const previous = process.env.NET_lasso;
  process.env.NET_lasso = `127.0.0.1:${server.address().port}`;
  delete process.env.NET_data;
  clearReportEnvCache();
  const data = makeData();
  data.req.jibo.toHeader = () => headerObject;
  try {
    await assert.deepEqual(await LassoClient.fetchDarkSky(data), { ok: true });
    assert.deepEqual(requests, [
      { url: '/v1/dark_sky?lat=42.3134&lon=-71.1274', mutable: 'before', added: undefined },
      { url: '/final', mutable: 'before', added: undefined },
    ]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (previous === undefined) delete process.env.NET_lasso;
    else process.env.NET_lasso = previous;
    clearReportEnvCache();
  }
});

test('LassoClient evaluates request header properties once', async () => {
  const server = http.createServer((request, response) => {
    response.end(JSON.stringify({ relayData: { ok: true } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const previous = process.env.NET_lasso;
  process.env.NET_lasso = `127.0.0.1:${server.address().port}`;
  delete process.env.NET_data;
  clearReportEnvCache();
  let reqReads = 0;
  let jiboReads = 0;
  let toHeaderReads = 0;
  let toHeaderCalls = 0;
  const jibo = {};
  Object.defineProperty(jibo, 'toHeader', {
    get() {
      toHeaderReads += 1;
      return () => {
        toHeaderCalls += 1;
        return { 'x-jibo-once': 'yes' };
      };
    },
  });
  const data = makeData();
  Object.defineProperty(data, 'req', {
    get() {
      reqReads += 1;
      return {
        get jibo() {
          jiboReads += 1;
          return jibo;
        },
      };
    },
  });
  try {
    await assert.deepEqual(await LassoClient.fetchDarkSky(data), { ok: true });
    assert.equal(reqReads, 1);
    assert.equal(jiboReads, 1);
    assert.equal(toHeaderReads, 1);
    assert.equal(toHeaderCalls, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (previous === undefined) delete process.env.NET_lasso;
    else process.env.NET_lasso = previous;
    clearReportEnvCache();
  }
});

test('LassoClient keeps malformed source log objects at the source call boundary', async () => {
  const data = makeData();
  data.log = {};
  await assert.rejects(LassoClient.fetchDarkSky(data), (error) => {
    assert.equal(error.name, 'TypeError');
    assert.equal(error.message, 'data.log.createChild is not a function');
    return true;
  });
});

test('LassoClient stops at the pinned 21 redirect limit', async () => {
  let count = 0;
  const server = http.createServer((request, response) => {
    count += 1;
    response.writeHead(302, { Location: `/loop/${count}` });
    response.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const previous = process.env.NET_lasso;
  process.env.NET_lasso = `127.0.0.1:${server.address().port}`;
  delete process.env.NET_data;
  clearReportEnvCache();
  try {
    await assert.rejects(LassoClient.fetchDarkSky(makeData()), { message: 'Max redirects exceeded.' });
    assert.equal(count, 22);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (previous === undefined) delete process.env.NET_lasso;
    else process.env.NET_lasso = previous;
    clearReportEnvCache();
  }
});
