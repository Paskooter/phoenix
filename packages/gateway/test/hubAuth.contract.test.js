// H-10 source contract: BaseService bearer verification and ws@3 upgrade rejection.
// These tests use the active ws transport only for the network envelope; token and
// message expectations come from the pinned BaseService/jsonwebtoken sources.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { WebSocket } from 'ws';
import { jwt } from '@phoenix/common';

const { checkAuthentication, createGateway } = await import('@phoenix/gateway');

const SECRET = 'h-10-synthetic-secret';
const NOW = 1_700_000_000;

function gatewayConfig(overrides = {}) {
  return {
    hubTokenSecret: SECRET,
    disableAuth: false,
    accountUrl: '',
    parserURL: 'http://127.0.0.1:9',
    historyURL: 'http://127.0.0.1:9',
    skills: [],
    ...overrides,
  };
}

async function withGateway(config, callback) {
  const gateway = await createGateway(config);
  await gateway.service.listen(0);
  const port = gateway.service.server.address().port;
  try {
    return await callback(port, gateway);
  } finally {
    await new Promise((resolve) => gateway.wss.close(() => resolve()));
    await new Promise((resolve, reject) => gateway.service.server.close((error) => error ? reject(error) : resolve()));
  }
}

function rawUpgrade(port, path, authorization) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let settled = false;
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const timer = setTimeout(() => {
      socket.destroy();
      if (!settled) {
        settled = true;
        reject(new Error(`timed out waiting for upgrade response ${path}`));
      }
    }, 2_000);

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const bytes = Buffer.concat(chunks);
      const separator = bytes.indexOf('\r\n\r\n');
      if (separator < 0) return reject(new Error(`incomplete upgrade response: ${bytes.toString('latin1')}`));
      const head = bytes.subarray(0, separator).toString('latin1');
      const body = bytes.subarray(separator + 4).toString('utf8');
      const lines = head.split('\r\n');
      const statusMatch = lines.shift().match(/^HTTP\/1\.1 (\d+) (.*)$/);
      const headers = Object.create(null);
      for (const line of lines) {
        const colon = line.indexOf(':');
        if (colon > 0) headers[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
      }
      resolve({
        status: Number(statusMatch?.[1]),
        reason: statusMatch?.[2] || '',
        headers,
        body,
        raw: bytes,
      });
    };

    socket.on('connect', () => {
      const lines = [
        `GET ${path} HTTP/1.1`,
        'Host: 127.0.0.1',
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version: 13',
      ];
      if (authorization !== undefined) lines.push(`Authorization: ${authorization}`);
      socket.write(`${lines.join('\r\n')}\r\n\r\n`);
    });
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.on('end', finish);
    socket.on('close', finish);
    socket.on('error', (error) => {
      if (!settled && chunks.length === 0) {
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    });
  });
}

function assertRejected(response, status, body) {
  assert.equal(response.status, status);
  assert.equal(response.body, body);
  assert.equal(response.headers.connection, 'close');
  assert.equal(response.headers['content-type'], 'text/html');
  assert.equal(response.headers['content-length'], String(Buffer.byteLength(body)));
}

async function assertAccepted(port, path, token) {
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error(`timed out opening ${path}`));
    }, 2_000);
    ws.once('open', () => {
      clearTimeout(timer);
      ws.close();
    });
    ws.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
    ws.once('unexpected-response', (_request, response) => {
      clearTimeout(timer);
      reject(new Error(`unexpected ${response.statusCode} response for ${path}`));
    });
    ws.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

test('checkAuthentication matches the source bearer and jsonwebtoken matrix', () => {
  assert.deepEqual(checkAuthentication({}, SECRET), { error: 'Authorization is required' });
  assert.deepEqual(checkAuthentication({ authorization: 'Basic abc' }, SECRET), { error: 'Only bearer scheme is supported' });
  assert.deepEqual(checkAuthentication({ authorization: 'bearer abc' }, SECRET), { error: 'Only bearer scheme is supported' });
  assert.deepEqual(checkAuthentication({ authorization: 'Bearer  abc' }, SECRET), { error: 'Only bearer scheme is supported' });
  assert.deepEqual(checkAuthentication({ authorization: 'Bearer ' }, SECRET), { error: 'JsonWebTokenError: jwt must be provided' });
  assert.deepEqual(checkAuthentication({ authorization: 'Bearer abc' }, ''), { error: 'No JWT secret set' });
  assert.deepEqual(checkAuthentication({ authorization: 'Bearer abc' }, SECRET), { error: 'JsonWebTokenError: jwt malformed' });

  const valid = jwt.sign({ id: 'robot' }, SECRET, { iat: NOW });
  assert.equal(checkAuthentication({ authorization: `Bearer ${valid}` }, SECRET).auth.id, 'robot');

  const expired = jwt.sign({ id: 'robot', exp: NOW - 1 }, SECRET, { iat: NOW });
  assert.deepEqual(checkAuthentication({ authorization: `Bearer ${expired}` }, SECRET), { error: 'TokenExpiredError: jwt expired' });
  const notYet = jwt.sign({ id: 'robot', nbf: Math.floor(Date.now() / 1000) + 60 }, SECRET);
  assert.match(checkAuthentication({ authorization: `Bearer ${notYet}` }, SECRET).error, /^NotBeforeError: jwt not active$/);
});

test('upgrade rejection preserves status, source text, headers, and auth-before-path ordering', async () => {
  await withGateway(gatewayConfig(), async (port) => {
    const valid = jwt.sign({ id: 'robot' }, SECRET);
    const wrongSecret = jwt.sign({ id: 'robot' }, 'other-secret');
    const expired = jwt.sign({ id: 'robot', exp: Math.floor(Date.now() / 1000) - 10 }, SECRET);
    const notYet = jwt.sign({ id: 'robot', nbf: Math.floor(Date.now() / 1000) + 60 }, SECRET);

    const cases = [
      ['missing authorization', '/listen', undefined, 401, 'Authorization is required'],
      ['wrong scheme', '/listen', 'Basic abc', 401, 'Only bearer scheme is supported'],
      ['malformed token', '/listen', 'Bearer garbage', 401, 'JsonWebTokenError: jwt malformed'],
      ['bad signature', '/listen', `Bearer ${wrongSecret}`, 401, 'JsonWebTokenError: invalid signature'],
      ['expired token', '/listen', `Bearer ${expired}`, 401, 'TokenExpiredError: jwt expired'],
      ['not-yet-active token', '/listen', `Bearer ${notYet}`, 401, 'NotBeforeError: jwt not active'],
      ['valid unknown path', '/unknown', `Bearer ${valid}`, 404, "WebSocket url '/unknown' has no handler"],
      ['bad auth wins over unknown path', '/unknown', 'Bearer garbage', 401, 'JsonWebTokenError: jwt malformed'],
      ['query is part of exact source path lookup', '/listen?query=1', `Bearer ${valid}`, 404, "WebSocket url '/listen?query=1' has no handler"],
    ];

    for (const [name, path, authorization, status, body] of cases) {
      const response = await rawUpgrade(port, path, authorization);
      assertRejected(response, status, body);
      assert.equal(response.reason, status === 401 ? 'Unauthorized' : 'Not Found', name);
    }
  });
});

test('valid bearer upgrades known exact paths and disableAuth still checks path first', async () => {
  const valid = jwt.sign({ id: 'robot' }, SECRET);
  await withGateway(gatewayConfig(), async (port) => {
    await assertAccepted(port, '/listen', valid);
    await assertAccepted(port, '/v1/listen', valid);
    await assertAccepted(port, '/proactive', valid);
    await assertAccepted(port, '/v1/proactive', valid);
  });

  await withGateway(gatewayConfig({ disableAuth: true }), async (port) => {
    const response = await rawUpgrade(port, '/unknown');
    assertRejected(response, 404, "WebSocket url '/unknown' has no handler");
  });
});
