import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { RobotReadClient } from '../src/loopCreation.js';

function listen(server) {
  return new Promise((resolve, reject) => server.listen(0, '127.0.0.1', err => err ? reject(err) : resolve()));
}

function close(server) {
  return new Promise(resolve => server.close(resolve));
}

function bodyOf(req) {
  return new Promise((resolve, reject) => {
    let text = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { text += chunk; });
    req.on('end', () => resolve(text));
    req.on('error', reject);
  });
}

test('RobotReadClient follows the source BaseClient request and smart JSON boundary', async () => {
  let mode = 'json';
  const requests = [];
  const peer = http.createServer(async (req, res) => {
    const body = await bodyOf(req);
    requests.push({ mode, method: req.method, url: req.url, headers: { ...req.headers }, body });
    if (mode === 'redirect-one' && req.url === '/') {
      res.writeHead(302, { location: '/target' });
      return res.end();
    }
    if ((mode === 'redirect-one' || mode === 'redirect-target') && req.url === '/target') {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ payload: { suspended: true } }));
    }
    if (mode === 'empty-json') {
      res.setHeader('content-type', 'application/json');
      return res.end();
    }
    if (mode === 'aws-json') {
      res.setHeader('content-type', 'application/x-amz-json-1.1; charset=utf-8');
      return res.end(JSON.stringify({ payload: { suspended: true } }));
    }
    if (mode === 'text') {
      res.setHeader('content-type', 'text/plain');
      return res.end(JSON.stringify({ payload: { suspended: true } }));
    }
    res.setHeader('content-type', 'application/json; charset=utf-8');
    return res.end(JSON.stringify({ payload: { suspended: false } }));
  });
  await listen(peer);
  try {
    const client = new RobotReadClient(`http://127.0.0.1:${peer.address().port}`);
    const normal = await client.getRobot('normal');
    assert.deepEqual(normal, { payload: { suspended: false } });
    mode = 'aws-json';
    const aws = await client.getRobot('aws');
    assert(Buffer.isBuffer(aws));
    mode = 'text';
    const text = await client.getRobot('text');
    assert(Buffer.isBuffer(text));
    mode = 'empty-json';
    assert.equal(await client.getRobot('empty'), null);
    mode = 'redirect-one';
    const redirected = await client.getRobot('redirected');
    assert.deepEqual(redirected, { payload: { suspended: true } });

    const first = requests[0];
    assert.equal(first.method, 'POST');
    assert.equal(first.url, '/');
    assert.equal(first.headers['content-type'], undefined);
    assert.equal(first.headers['x-amz-target'], 'Robot_20160225.GetRobot');
    assert.deepEqual(JSON.parse(first.headers['x-amz-credentials']), { isAdmin: true });
    assert.deepEqual(JSON.parse(first.body), { id: 'normal' });
    const redirectRequests = requests.filter(row => row.mode === 'redirect-one' || row.mode === 'redirect-target');
    assert.deepEqual(redirectRequests.map(row => row.method), ['POST', 'POST']);
    assert.deepEqual(JSON.parse(redirectRequests[1].body), { id: 'redirected' });
  } finally {
    peer.closeAllConnections?.();
    await close(peer);
  }
});

test('RobotReadClient applies the source header deadline and clears it before body reading', async () => {
  const oldTimeout = process.env.ETCO_server_http_timeout;
  process.env.ETCO_server_http_timeout = '25';
  let mode = 'slow-headers';
  const peer = http.createServer((req, res) => {
    if (mode === 'slow-headers') {
      return setTimeout(() => res.end(JSON.stringify({ payload: { suspended: false } })), 80);
    }
    res.setHeader('content-type', 'application/json');
    res.write('{"payload":{"suspended":false}}');
    return setTimeout(() => res.end(), 80);
  });
  await listen(peer);
  try {
    const client = new RobotReadClient(`http://127.0.0.1:${peer.address().port}`);
    await assert.rejects(() => client.getRobot('slow-headers'), error => error.statusCode === 504 && error.code === 'ETIMEDOUT');
    mode = 'slow-body';
    assert.deepEqual(await client.getRobot('slow-body'), { payload: { suspended: false } });
  } finally {
    if (oldTimeout === undefined) delete process.env.ETCO_server_http_timeout;
    else process.env.ETCO_server_http_timeout = oldTimeout;
    peer.closeAllConnections?.();
    await close(peer);
  }
});

test('RobotReadClient enforces the source three-redirect default and preserves POST', async () => {
  const requests = [];
  const peer = http.createServer(async (req, res) => {
    const body = await bodyOf(req);
    requests.push({ method: req.method, url: req.url, body });
    const match = /^\/hop(\d+)$/.exec(req.url);
    const n = match ? Number(match[1]) : 0;
    if (n < 4) {
      res.writeHead(302, { location: `/hop${n + 1}` });
      return res.end();
    }
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ payload: { suspended: false } }));
  });
  await listen(peer);
  try {
    const client = new RobotReadClient(`http://127.0.0.1:${peer.address().port}`);
    await assert.rejects(() => client.getRobot('redirect-limit'), error => error.statusCode === 502 && error.message === 'Maximum redirections reached');
    assert.deepEqual(requests.map(row => row.method), ['POST', 'POST', 'POST', 'POST']);
    assert.deepEqual(requests.map(row => JSON.parse(row.body).id), ['redirect-limit', 'redirect-limit', 'redirect-limit', 'redirect-limit']);
  } finally {
    peer.closeAllConnections?.();
    await close(peer);
  }
});

test('RobotReadClient keeps one header deadline across redirects', async () => {
  const oldTimeout = process.env.ETCO_server_http_timeout;
  process.env.ETCO_server_http_timeout = '35';
  const requests = [];
  const peer = http.createServer(async (req, res) => {
    const body = await bodyOf(req);
    requests.push({ method: req.method, url: req.url, body });
    if (req.url === '/') {
      res.writeHead(302, { location: '/slow-final' });
      return res.end();
    }
    return setTimeout(() => res.end(JSON.stringify({ payload: { suspended: false } })), 80);
  });
  await listen(peer);
  try {
    const client = new RobotReadClient(`http://127.0.0.1:${peer.address().port}`);
    await assert.rejects(() => client.getRobot('redirect-deadline'), error => error.statusCode === 504);
    assert.deepEqual(requests.map(row => row.method), ['POST', 'POST']);
    assert.deepEqual(requests.map(row => JSON.parse(row.body).id), ['redirect-deadline', 'redirect-deadline']);
  } finally {
    if (oldTimeout === undefined) delete process.env.ETCO_server_http_timeout;
    else process.env.ETCO_server_http_timeout = oldTimeout;
    peer.closeAllConnections?.();
    await close(peer);
  }
});
