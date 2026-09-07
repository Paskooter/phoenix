import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';

const { createSettingsProviders } = await import('../src/settingsProviders.js');

function listenPeer(responder) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      const request = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        rawHeaders: req.rawHeaders,
        body,
      };
      requests.push(request);
      const response = await responder(request, requests.length - 1);
      const headers = { connection: 'close', ...(response.headers || {}) };
      if (response.contentType !== undefined) headers['content-type'] = response.contentType;
      res.writeHead(response.status === undefined ? 200 : response.status, headers);
      if (response.truncate) {
        res.write(response.body || '');
        res.socket.destroy();
        return;
      }
      if (response.status !== 204 && response.status !== 304) res.end(response.body || '');
      else res.end();
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({
      server,
      requests,
      address: `127.0.0.1:${server.address().port}`,
    }));
  });
}

async function closePeer(peer) {
  await new Promise((resolve) => peer.server.close(resolve));
}

function providers(address) {
  return createSettingsProviders({ store: {}, env: { NET_settings_person: address } });
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

const context = { userId: 'acct-1', loopId: 'loop-1', transactionId: 'tx-1' };

test('network Person matches source AWS JSON targets, body order, identity and headers', async () => {
  const peer = await listenPeer((request) => ({
    status: 200,
    contentType: 'application/json',
    body: request.headers['x-amz-target'].endsWith('GetAccountProperties')
      ? JSON.stringify({ accountFlag: { value: true } })
      : JSON.stringify({ stored: true }),
  }));
  try {
    const person = providers(peer.address).person;
    assert.deepEqual(await person.getAccountProperties(context, ['accountFlag']), {
      accountFlag: { value: true },
    });
    assert.deepEqual(await person.getLoopProperties(context, ['loopFlag']), { stored: true });
    assert.deepEqual(await person.setAccountProperty(context, 'accountFlag', { value: false }), { stored: true });
    assert.deepEqual(await person.setLoopProperty(context, 'loopFlag', { value: true }), { stored: true });

    assert.equal(peer.requests.length, 4);
    const expected = [
      ['Person_20160801.GetAccountProperties', { keys: ['accountFlag'] }],
      ['Person_20160801.GetLoopProperties', { keys: ['loopFlag'], loopId: 'loop-1' }],
      ['Person_20160801.SetAccountProperty', { key: 'accountFlag', value: { value: false } }],
      ['Person_20160801.SetLoopProperty', {
        loopId: 'loop-1', transId: 'tx-1', key: 'loopFlag', value: { value: true },
      }],
    ];
    for (let i = 0; i < expected.length; i += 1) {
      const request = peer.requests[i];
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/');
      assert.equal(request.headers['content-type'], undefined);
      assert.equal(request.headers['x-amz-credentials'], '{"id":"acct-1"}');
      assert.equal(request.headers['x-amz-target'], expected[i][0]);
      assert.equal(request.body, JSON.stringify(expected[i][1]));
      assert.equal(request.headers['content-length'], String(Buffer.byteLength(request.body)));
    }
  } finally {
    await closePeer(peer);
  }
});

test('network Person preserves source status and response MIME behavior', async () => {
  const controls = [
    {
      response: { status: 404, contentType: 'application/json', body: JSON.stringify({ missing: true }) },
      invoke: (person) => person.getAccountProperties(context, ['missing']),
      expected: { missing: true },
    },
    {
      response: { status: 200, contentType: 'text/plain', body: '{"x":true}' },
      invoke: (person) => person.getAccountProperties(context, ['x']),
      expected: Buffer.from('{"x":true}'),
    },
    {
      response: { status: 500, contentType: 'application/json', body: '' },
      invoke: (person) => person.setAccountProperty(context, 'x', { value: true }),
      expected: null,
    },
  ];
  for (const control of controls) {
    const peer = await listenPeer(() => control.response);
    try {
      const result = await control.invoke(providers(peer.address).person);
      if (Buffer.isBuffer(control.expected)) assert.deepEqual(result, control.expected);
      else assert.deepEqual(result, control.expected);
    } finally {
      await closePeer(peer);
    }
  }
});

test('network Person exposes source-shaped malformed and provider errors', async () => {
  const malformed = await listenPeer(() => ({
    status: 200, contentType: 'application/json', body: '{bad',
  }));
  try {
    await assert.rejects(
      () => providers(malformed.address).person.getAccountProperties(context, ['x']),
      (error) => {
        assert.equal(error.name, 'SyntaxError');
        assert.equal(error.isBoom, true);
        assert.equal(error.isServer, true);
        assert.equal(error.isDeveloperError, true);
        assert.equal(error.data, undefined);
        assert.deepEqual(error.output, {
          statusCode: 500,
          payload: {
            statusCode: 500,
            error: 'Internal Server Error',
            message: 'An internal server error occurred',
          },
          headers: {},
        });
        return true;
      },
    );
  } finally {
    await closePeer(malformed);
  }

  const remoteError = await listenPeer(() => ({
    status: 400,
    contentType: 'application/json',
    body: JSON.stringify({ error: 'Denied', code: 'DENIED', message: 'provider denied', statusCode: 403 }),
  }));
  try {
    await assert.rejects(
      () => providers(remoteError.address).person.getLoopProperties(context, ['x']),
      (error) => {
        assert.equal(error.message, 'provider denied');
        assert.equal(error.isBoom, true);
        assert.equal(error.isServer, false);
        assert.deepEqual(error.data, { code: 'DENIED' });
        assert.deepEqual(error.output, {
          statusCode: 403,
          payload: {
            statusCode: 403,
            error: 'Forbidden',
            message: 'provider denied',
            code: 'DENIED',
          },
          headers: {},
        });
        return true;
      },
    );
  } finally {
    await closePeer(remoteError);
  }

  const internalError = await listenPeer(() => ({
    status: 500,
    contentType: 'application/json',
    body: JSON.stringify({ error: 'Denied', code: 'DENIED', message: 'provider failed', statusCode: 500 }),
  }));
  try {
    await assert.rejects(
      () => providers(internalError.address).person.getAccountProperties(context, ['x']),
      (error) => {
        assert.equal(error.message, 'provider failed');
        assert.equal(error.isBoom, true);
        assert.equal(error.isServer, true);
        assert.deepEqual(error.data, { code: 'DENIED' });
        assert.deepEqual(error.output, {
          statusCode: 500,
          payload: {
            statusCode: 500,
            error: 'Internal Server Error',
            message: 'An internal server error occurred',
            code: 'DENIED',
          },
          headers: {},
        });
        return true;
      },
    );
  } finally {
    await closePeer(internalError);
  }
});

test('network Person follows method-preserving 307 redirects', async () => {
  const peer = await listenPeer((request, index) => {
    if (index === 0) return { status: 307, headers: { location: '/redirected' }, body: '' };
    return { status: 200, contentType: 'application/json', body: JSON.stringify({ stored: true }) };
  });
  try {
    const result = await providers(peer.address).person.setLoopProperty(
      context, 'loopFlag', { value: true },
    );
    assert.deepEqual(result, { stored: true });
    assert.equal(peer.requests.length, 2);
    assert.equal(peer.requests[0].method, 'POST');
    assert.equal(peer.requests[1].method, 'POST');
    assert.equal(peer.requests[0].body, peer.requests[1].body);
    assert.equal(peer.requests[1].url, '/redirected');
  } finally {
    await closePeer(peer);
  }
});

test('network Person snapshots source body and headers across redirects', async () => {
  const mutableContext = { ...context };
  const mutableValue = { value: true };
  const peer = await listenPeer((request, index) => {
    if (index === 0) {
      mutableContext.userId = 'changed-after-first-hop';
      mutableValue.value = false;
      return { status: 307, headers: { location: '/redirected' }, body: '' };
    }
    return { status: 200, contentType: 'application/json', body: JSON.stringify({ stored: true }) };
  });
  try {
    const result = await providers(peer.address).person.setAccountProperty(
      mutableContext, 'flag', mutableValue,
    );
    assert.deepEqual(result, { stored: true });
    assert.equal(peer.requests.length, 2);
    assert.equal(peer.requests[1].body, peer.requests[0].body);
    assert.equal(peer.requests[1].headers['x-amz-credentials'], peer.requests[0].headers['x-amz-credentials']);
  } finally {
    await closePeer(peer);
  }
});

test('network Person follows the source strict string-zero redirect branch', async () => {
  const previous = process.env.ETCO_server_http_maxredirects;
  process.env.ETCO_server_http_maxredirects = '0';
  const peer = await listenPeer((request, index) => {
    if (index === 0) return { status: 307, headers: { location: '/redirected' }, body: '' };
    return { status: 200, contentType: 'application/json', body: JSON.stringify({ stored: true }) };
  });
  try {
    const result = await providers(peer.address).person.setAccountProperty(
      context, 'flag', { value: true },
    );
    assert.deepEqual(result, { stored: true });
    assert.equal(peer.requests.length, 2);
  } finally {
    await closePeer(peer);
    if (previous === undefined) delete process.env.ETCO_server_http_maxredirects;
    else process.env.ETCO_server_http_maxredirects = previous;
  }
});

test('network Person preserves the source wall-clock timeout across redirects', async () => {
  const previous = process.env.ETCO_server_http_timeout;
  process.env.ETCO_server_http_timeout = '100';
  const peer = await listenPeer(async (request, index) => {
    if (index === 0) {
      await delay(70);
      return { status: 307, headers: { location: '/redirected' }, body: '' };
    }
    await delay(50);
    return { status: 200, contentType: 'application/json', body: JSON.stringify({ stored: true }) };
  });
  try {
    await assert.rejects(
      () => providers(peer.address).person.setAccountProperty(context, 'flag', { value: true }),
      (error) => {
        assert.equal(error.name, 'Error');
        assert.equal(error.message, 'Client request timeout');
        assert.equal(error.isBoom, true);
        assert.equal(error.isServer, true);
        assert.equal(Object.prototype.hasOwnProperty.call(error, 'data'), true);
        assert.equal(error.data, undefined);
        assert.deepEqual(error.output, {
          statusCode: 504,
          payload: {
            statusCode: 504,
            error: 'Gateway Time-out',
            message: 'Client request timeout',
          },
          headers: {},
        });
        return true;
      },
    );
    assert.equal(peer.requests.length, 2);
  } finally {
    await closePeer(peer);
    if (previous === undefined) delete process.env.ETCO_server_http_timeout;
    else process.env.ETCO_server_http_timeout = previous;
  }
});

test('network Person preserves the complete Boom timeout envelope for socket reset', async () => {
  const previous = process.env.ETCO_server_http_timeout;
  process.env.ETCO_server_http_timeout = '500';
  const peer = await listenPeer(() => ({
    status: 200,
    contentType: 'application/json',
    body: '{"x":',
    truncate: true,
  }));
  const stderrLines = [];
  const originalWrite = process.stderr.write;
  let caught;
  process.stderr.write = (chunk) => {
    stderrLines.push(String(chunk));
    return true;
  };
  try {
    await assert.rejects(
      () => providers(peer.address).person.getAccountProperties(context, ['x']),
      (error) => {
        caught = error;
        assert.match(error.message, /^Gateway Time-out\. Log marker:\d+$/);
        assert.equal(error.isBoom, true);
        assert.equal(error.isServer, true);
        assert.equal(Object.prototype.hasOwnProperty.call(error, 'data'), true);
        assert.equal(error.data, undefined);
        assert.deepEqual(error.output, {
          statusCode: 504,
          payload: {
            statusCode: 504,
            error: 'Gateway Time-out',
            message: error.message,
          },
          headers: {},
        });
        assert.equal(typeof error.reformat, 'function');
        assert.equal(typeof error.typeof, 'function');
        const nested = error.typeof('factory', { marker: true });
        assert.equal(nested.isBoom, true);
        assert.equal(nested.isServer, true);
        assert.deepEqual(nested.data, { marker: true });
        assert.equal(nested.output.statusCode, 504);
        return true;
      },
    );
    const logged = stderrLines.map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).find((line) => line && line.level === 'error' && line.marker !== undefined);
    assert.ok(logged);
    const markerMatch = /Marker:(\d+)/.exec(stderrLines.join(''));
    assert.ok(markerMatch);
    assert.equal(logged.marker, Number(markerMatch[1]));
    assert.equal(caught.message, `Gateway Time-out. Log marker:${markerMatch[1]}`);
  } finally {
    process.stderr.write = originalWrite;
    await closePeer(peer);
    if (previous === undefined) delete process.env.ETCO_server_http_timeout;
    else process.env.ETCO_server_http_timeout = previous;
  }
});

test('network Person clears the redirect timer when final headers arrive before a slow body', async () => {
  const previous = process.env.ETCO_server_http_timeout;
  process.env.ETCO_server_http_timeout = '50';
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      requests.push({ method: req.method, url: req.url, body });
      if (requests.length === 1) {
        res.writeHead(307, { location: '/final', connection: 'close' });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
      res.write('{"slow":');
      await delay(120);
      res.end('true}');
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const address = `127.0.0.1:${server.address().port}`;
    assert.deepEqual(await providers(address).person.getAccountProperties(context, ['slow']), { slow: true });
    assert.equal(requests.length, 2);
    assert.equal(requests[0].body, requests[1].body);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (previous === undefined) delete process.env.ETCO_server_http_timeout;
    else process.env.ETCO_server_http_timeout = previous;
  }
});

test('network Person keeps the request timer through informational 100 headers', async () => {
  const previous = process.env.ETCO_server_http_timeout;
  process.env.ETCO_server_http_timeout = '50';
  const server = http.createServer((req, res) => {
    req.resume();
    req.once('end', async () => {
      res.writeContinue();
      await delay(120);
      res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
      res.end('{"ok":true}');
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    await assert.rejects(
      () => providers(`127.0.0.1:${server.address().port}`).person.getAccountProperties(context, ['ok']),
      (error) => {
        assert.equal(error.message, 'Client request timeout');
        assert.equal(error.isBoom, true);
        assert.equal(error.isServer, true);
        assert.deepEqual(error.output, {
          statusCode: 504,
          payload: {
            statusCode: 504,
            error: 'Gateway Time-out',
            message: 'Client request timeout',
          },
          headers: {},
        });
        return true;
      },
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (previous === undefined) delete process.env.ETCO_server_http_timeout;
    else process.env.ETCO_server_http_timeout = previous;
  }
});

test('network Person preserves the source redirect-limit Bad Gateway envelope and trace', async () => {
  const previous = process.env.ETCO_server_http_maxredirects;
  process.env.ETCO_server_http_maxredirects = '3';
  const peer = await listenPeer((request, index) => {
    if (index < 4) return { status: 307, headers: { location: `/r${index + 1}` }, body: '' };
    return { status: 200, contentType: 'application/json', body: '{}' };
  });
  try {
    await assert.rejects(
      () => providers(peer.address).person.getAccountProperties(context, ['x']),
      (error) => {
        assert.equal(error.name, 'Error');
        assert.equal(error.message, 'Maximum redirections reached');
        assert.equal(error.isBoom, true);
        assert.equal(error.isServer, true);
        assert.deepEqual(error.data, [
          { method: 'POST', url: `http://${peer.address}/` },
          { method: 'POST', url: `http://${peer.address}/r1` },
          { method: 'POST', url: `http://${peer.address}/r2` },
          { method: 'POST', url: `http://${peer.address}/r3` },
        ]);
        assert.deepEqual(error.output, {
          statusCode: 502,
          payload: {
            statusCode: 502,
            error: 'Bad Gateway',
            message: 'Maximum redirections reached',
          },
          headers: {},
        });
        return true;
      },
    );
    assert.equal(peer.requests.length, 4);
  } finally {
    await closePeer(peer);
    if (previous === undefined) delete process.env.ETCO_server_http_maxredirects;
    else process.env.ETCO_server_http_maxredirects = previous;
  }
});

test('network Person rejects malformed redirect locations through the normal error path', async () => {
  const previous = process.env.ETCO_server_http_timeout;
  process.env.ETCO_server_http_timeout = '200';
  for (const location of ['http://[::1', 'http://%zz']) {
    const peer = await listenPeer((request, index) => {
      if (index === 0) return { status: 307, headers: { location }, body: '' };
      return { status: 200, contentType: 'application/json', body: '{}' };
    });
    try {
      await assert.rejects(
        () => providers(peer.address).person.getAccountProperties(context, ['x']),
        (error) => {
          assert.equal(error.isBoom, true);
          assert.equal(error.isServer, true);
          assert.equal(error.output.statusCode, 502);
          assert.match(error.message, /^Client request error: /);
          return true;
        },
      );
      assert.equal(peer.requests.length, 1);
    } finally {
      await closePeer(peer);
    }
  }
  if (previous === undefined) delete process.env.ETCO_server_http_timeout;
  else process.env.ETCO_server_http_timeout = previous;
});

test('network Person preserves pinned Boom factory and reformat behavior', async () => {
  const peer = await listenPeer(() => ({ status: 307, headers: {}, body: '' }));
  try {
    let error;
    await assert.rejects(
      () => providers(peer.address).person.getAccountProperties(context, ['x']),
      (caught) => {
        error = caught;
        return true;
      },
    );
    assert.equal(typeof error.typeof, 'function');
    const nested = error.typeof('nested', { marker: true });
    assert.equal(nested.isBoom, true);
    assert.equal(nested.output.statusCode, 502);
    assert.equal(nested.output.payload.error, 'Bad Gateway');
    assert.deepEqual(nested.data, { marker: true });

    error.output.statusCode = 408;
    error.message = 'changed';
    error.reformat();
    assert.equal(error.output.payload.error, 'Request Time-out');
    assert.equal(error.output.payload.message, 'changed');

    const wrapped = error.typeof('outer', new Error('cause'));
    assert.equal(wrapped.message, 'outer: cause');
    assert.equal(wrapped.data, null);
    assert.equal(Object.prototype.hasOwnProperty.call(wrapped, 'typeof'), false);

    const cause = new RangeError('message cause');
    const fromMessage = error.typeof(cause, { fixture: true });
    assert.equal(fromMessage, cause);
    assert.equal(fromMessage.message, 'message cause');
    assert.deepEqual(fromMessage.data, { fixture: true });
    assert.equal(Object.hasOwn(fromMessage, 'typeof'), false);
  } finally {
    await closePeer(peer);
  }
});

const originalBoom = JSON.parse(readFileSync(new URL('./fixtures/person-boom-original.json', import.meta.url)));

test('network Person provider errors match original status coercion, labels and default messages', async () => {
  for (const control of originalBoom.controls) {
    const peer = await listenPeer(() => ({
      contentType: 'application/json', body: JSON.stringify(control.response),
    }));
    try {
      await assert.rejects(
        () => providers(peer.address).person.getAccountProperties(context, ['x']),
        (error) => {
          const ownKeys = Object.getOwnPropertyNames(error).filter(key => key !== 'stack').sort();
          assert.deepEqual({
            name: error.name, message: error.message, ownKeys,
            data: error.data, isBoom: error.isBoom, isServer: error.isServer, output: error.output,
          }, control.error, control.id);
          assert.equal(error.reformat(), undefined);
          assert.deepEqual(error.output, control.error.output, control.id);
          const nested = error.typeof(425, 'status probe', { fixture: true });
          assert.equal(nested.output.statusCode, 425);
          assert.equal(nested.output.payload.error, 'Unordered Collection');
          assert.deepEqual(nested.data, { fixture: true });
          assert.throws(() => error.typeof('factory probe', { marker: true }), {
            name: 'Error', message: 'First argument must be a number (400+): factory probe',
          });
          return true;
        },
      );
    } finally {
      await closePeer(peer);
    }
  }
});

test('network Person timeout factories wrap existing errors with source identity and data', async () => {
  const peer = await listenPeer(() => ({ contentType: 'application/json', body: '{"x":', truncate: true }));
  try {
    await assert.rejects(
      () => providers(peer.address).person.getAccountProperties(context, ['x']),
      (error) => {
        assert.equal(error.output.statusCode, 504);
        const cause = new RangeError('source cause');
        const wrapped = error.typeof('wrapped probe', cause);
        assert.equal(wrapped, cause);
        assert.equal(wrapped.message, 'wrapped probe: source cause');
        assert.equal(wrapped.data, null);
        assert.equal(Object.hasOwn(wrapped, 'typeof'), false);
        const message = new RangeError('message cause');
        const fromMessage = error.typeof(message, { fixture: true });
        assert.equal(fromMessage, message);
        assert.equal(fromMessage.message, 'message cause');
        assert.deepEqual(fromMessage.data, { fixture: true });
        assert.equal(fromMessage.output.statusCode, 504);
        assert.equal(Object.hasOwn(fromMessage, 'typeof'), false);
        return true;
      },
    );
  } finally {
    await closePeer(peer);
  }
});
