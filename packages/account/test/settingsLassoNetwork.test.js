import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

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
      res.writeHead(response.status, headers);
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
  return createSettingsProviders({ store: {}, env: { NET_settings_lasso: address } }).lasso;
}

async function withProcessEnv(name, value, callback) {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return await callback();
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
}

const context = {
  loopId: 'loop-1',
  userId: 'account-1',
  transactionId: 'tx-1',
};

test('network Lasso matches source query, headers, POST payload and status handling', async () => {
  const peer = await listenPeer(async (request) => {
    if (request.method === 'GET') return {
      status: 200,
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify({ credentialExists: true }),
    };
    if (request.method === 'POST') return {
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ created: true }),
    };
    // @jibo/server's BaseClient reads the payload and does not reject on HTTP
    // status alone. A JSON delete response without an `error` field therefore
    // resolves even when the provider returns 500.
    return { status: 500, contentType: 'application/json', body: JSON.stringify({ deleted: true }) };
  });
  try {
    const lasso = providers(peer.address);
    const params = {
      skillId: 'skill/1',
      serviceName: 'google maps',
      serviceAccountName: 'personal&calendar',
      scopes: ['scope one', 'scope&two'],
    };
    assert.deepEqual(await lasso.getCredential(context, params), { credentialExists: true });
    const posted = await lasso.createUpdateCredential(context, {
      ...params,
      accountId: 'forged-account',
      authCode: 'auth-code',
      clientId: 'client-id',
      redirectUri: 'https://example.test/callback',
      extra: 'not part of the source payload',
    });
    assert.deepEqual(posted, { created: true });
    await lasso.deleteCredential(context, params);

    assert.equal(peer.requests.length, 3);
    const [get, post, del] = peer.requests;
    assert.equal(get.method, 'GET');
    assert.equal(get.url, '/v1/credential?accountId=account-1&skillId=skill%2F1&serviceName=google+maps&serviceAccountName=personal%26calendar&scopes%5B0%5D=scope+one&scopes%5B1%5D=scope%26two');
    assert.equal(get.body, '');
    assert.equal(get.headers['content-type'], 'application/json');
    assert.equal(get.headers['x-jibo-transid'], 'tx-1');

    assert.equal(post.method, 'POST');
    assert.equal(post.headers['content-type'], 'application/json');
    assert.equal(post.headers['x-jibo-transid'], 'tx-1');
    const expectedBody = JSON.stringify({
      skillId: 'skill/1',
      accountId: 'account-1',
      serviceName: 'google maps',
      serviceAccountName: 'personal&calendar',
      scopes: ['scope one', 'scope&two'],
      authCode: 'auth-code',
      clientId: 'client-id',
      redirectUri: 'https://example.test/callback',
    });
    assert.equal(post.body, expectedBody);
    assert.equal(post.headers['content-length'], String(Buffer.byteLength(expectedBody)));

    assert.equal(del.method, 'DELETE');
    assert.equal(del.url, get.url);
    assert.equal(del.body, '');
    assert.equal(del.headers['content-type'], 'application/json');
    assert.equal(del.headers['x-jibo-transid'], 'tx-1');
  } finally {
    await closePeer(peer);
  }
});

test('network Lasso maps response media and transport failures to source operation errors', async () => {
  const controls = [
    {
      operation: 'getCredential',
      response: { status: 200, contentType: 'text/plain', body: '{"credentialExists":true}' },
      expected: 'Failed to get google calendar credentials',
    },
    {
      operation: 'createUpdateCredential',
      response: { status: 200, contentType: 'application/json', body: '{bad' },
      expected: 'Failed to connect google calendar',
    },
    {
      operation: 'deleteCredential',
      response: { status: 200, contentType: 'text/plain', body: '{"deleted":true}' },
      expected: 'Failed to disconnect google calendar',
    },
    {
      operation: 'createUpdateCredential',
      response: { status: 503, contentType: 'application/json', body: JSON.stringify({ message: 'provider down' }) },
      expected: null,
    },
  ];
  for (const control of controls) {
    const peer = await listenPeer(() => control.response);
    try {
      const lasso = providers(peer.address);
      const params = {
        skillId: 'skill-1', serviceName: 'google', serviceAccountName: 'calendar', scopes: ['read'],
      };
      if (control.expected) {
        await assert.rejects(
          () => control.operation === 'getCredential'
            ? lasso.getCredential(context, params)
            : control.operation === 'createUpdateCredential'
              ? lasso.createUpdateCredential(context, { ...params, authCode: 'auth' })
              : lasso.deleteCredential(context, params),
          (error) => error.message === control.expected,
        );
      } else {
        assert.deepEqual(
          await lasso.createUpdateCredential(context, { ...params, authCode: 'auth' }),
          { message: 'provider down' },
        );
      }
    } finally {
      await closePeer(peer);
    }
  }
});

test('network Lasso validates required source fields before making a request', async () => {
  const peer = await listenPeer(() => ({ status: 200, contentType: 'application/json', body: '{}' }));
  try {
    const lasso = providers(peer.address);
    const base = { skillId: 'skill-1', serviceName: 'google', serviceAccountName: 'calendar', scopes: ['read'] };
    await assert.rejects(
      () => lasso.getCredential(context, { ...base, skillId: undefined }),
      (error) => error.name === 'AssertionError [ERR_ASSERTION]'
        && error.code === 'ERR_ASSERTION'
        && error.message === 'Missing skillId in lasso credentials get request',
    );
    await assert.rejects(
      () => lasso.createUpdateCredential(context, base),
      (error) => error.name === 'AssertionError [ERR_ASSERTION]'
        && error.code === 'ERR_ASSERTION'
        && error.message === 'Missing authCode in lasso value',
    );
    await assert.rejects(
      () => lasso.deleteCredential(context, { ...base, serviceName: undefined }),
      (error) => error.name === 'AssertionError [ERR_ASSERTION]'
        && error.code === 'ERR_ASSERTION'
        && error.message === 'Missing serviceName in lasso credentials delete request',
    );
    await assert.rejects(
      () => lasso.getCredential({ ...context, transactionId: undefined }, base),
      (error) => error.message === 'Failed to get google calendar credentials',
    );
    assert.equal(peer.requests.length, 0);
  } finally {
    await closePeer(peer);
  }
});

test('network Lasso preserves source assertion names and rejects a shadowing hasOwnProperty', async () => {
  const peer = await listenPeer(() => ({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ hasOwnProperty: null, credentialExists: true }),
  }));
  try {
    const lasso = providers(peer.address);
    const base = { skillId: 'skill-1', serviceName: 'google', serviceAccountName: 'calendar', scopes: ['read'] };
    await assert.rejects(
      () => lasso.getCredential(context, { ...base, skillId: undefined }),
      (error) => error.name === 'AssertionError [ERR_ASSERTION]'
        && error.code === 'ERR_ASSERTION'
        && error.message === 'Missing skillId in lasso credentials get request',
    );
    await assert.rejects(
      () => lasso.getCredential(context, base),
      (error) => error.message === 'Failed to get google calendar credentials',
    );
  } finally {
    await closePeer(peer);
  }
});

test('network Lasso accepts string timeout configuration and does not time out the response body', async () => {
  const delayedServer = http.createServer((req, res) => {
    req.resume();
    req.once('end', () => {
      res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
      res.flushHeaders();
      setTimeout(() => res.end(JSON.stringify({ credentialExists: true })), 60);
    });
  });
  await new Promise((resolve) => delayedServer.listen(0, '127.0.0.1', resolve));
  try {
    await withProcessEnv('ETCO_server_http_timeout', '25', async () => {
      const lasso = providers(`127.0.0.1:${delayedServer.address().port}`);
      const value = await lasso.getCredential(context, {
        skillId: 'skill-timeout', serviceName: 'google', serviceAccountName: 'calendar', scopes: [],
      });
      assert.deepEqual(value, { credentialExists: true });
    });
  } finally {
    await new Promise((resolve) => delayedServer.close(resolve));
  }
});

test('network Lasso keeps one request deadline across redirect hops', async () => {
  let requests = 0;
  const server = http.createServer((req, res) => {
    requests += 1;
    req.resume();
    req.once('end', () => {
      const index = requests;
      setTimeout(() => {
        if (res.destroyed) return;
        if (index < 4) {
          res.writeHead(302, { location: `/v1/credential?hop=${index + 1}`, connection: 'close' });
          res.end();
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
        res.end(JSON.stringify({ credentialExists: true }));
      }, index === 1 ? 0 : 15);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await withProcessEnv('ETCO_server_http_timeout', '20', async () => {
      const lasso = providers(`127.0.0.1:${server.address().port}`);
      await assert.rejects(
        () => lasso.getCredential(context, {
          skillId: 'skill-deadline', serviceName: 'google', serviceAccountName: 'calendar', scopes: [],
        }),
        (error) => error.message === 'Failed to get google calendar credentials',
      );
    });
    assert.ok(requests >= 1 && requests < 4);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('network Lasso snapshots transaction headers across redirects', async () => {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, transactionId: req.headers['x-jibo-transid'] });
    req.resume();
    req.once('end', () => {
      if (requests.length === 1) {
        context.transactionId = 'tx-after-redirect';
        res.writeHead(307, { location: '/v1/credential?redirected=1', connection: 'close' });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
      res.end(JSON.stringify({ credentialExists: true }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const originalTransactionId = context.transactionId;
  try {
    context.transactionId = 'tx-before-redirect';
    const lasso = providers(`127.0.0.1:${server.address().port}`);
    const value = await lasso.getCredential(context, {
      skillId: 'skill-redirect', serviceName: 'google', serviceAccountName: 'calendar', scopes: [],
    });
    assert.deepEqual(value, { credentialExists: true });
    assert.deepEqual(requests.map((request) => request.transactionId), ['tx-before-redirect', 'tx-before-redirect']);
  } finally {
    context.transactionId = originalTransactionId;
    await new Promise((resolve) => server.close(resolve));
  }
});

test('network Lasso snapshots the serialized POST body across redirects', async () => {
  const bodies = [];
  let serializations = 0;
  const target = ['first!'];
  const scopes = new Proxy(target, {
    get(object, property, receiver) {
      if (property === 'toJSON') {
        return () => {
          serializations += 1;
          const snapshot = object.slice();
          // Equal-length values keep a stale Content-Length from masking a
          // body-content mismatch by leaving the peer waiting for bytes.
          if (serializations === 1) object[0] = 'after!';
          return snapshot;
        };
      }
      return Reflect.get(object, property, receiver);
    },
  });
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.once('end', () => {
      bodies.push(body);
      if (bodies.length === 1) {
        res.writeHead(307, { location: '/v1/credential', connection: 'close' });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
      res.end(JSON.stringify({ created: true }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const lasso = providers(`127.0.0.1:${server.address().port}`);
    assert.deepEqual(
      await lasso.createUpdateCredential(context, {
        skillId: 'skill-body', serviceName: 'google', serviceAccountName: 'calendar',
        scopes, authCode: 'auth',
      }),
      { created: true },
    );
    const expected = JSON.stringify({
      skillId: 'skill-body', accountId: context.userId, serviceName: 'google',
      serviceAccountName: 'calendar', scopes: ['first!'], authCode: 'auth',
    });
    assert.deepEqual(bodies, [expected, expected]);
    assert.equal(serializations, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('network Lasso preserves Wreck string-zero redirect decrement for a finite chain', async () => {
  let requests = 0;
  const server = http.createServer((req, res) => {
    requests += 1;
    req.resume();
    req.once('end', () => {
      if (requests === 1) {
        res.writeHead(302, { location: '/v1/credential?redirected=1', connection: 'close' });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
      res.end(JSON.stringify({ credentialExists: true }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await withProcessEnv('ETCO_server_http_maxredirects', '0', async () => {
      const lasso = providers(`127.0.0.1:${server.address().port}`);
      assert.deepEqual(
        await lasso.getCredential(context, {
          skillId: 'skill-limit', serviceName: 'google', serviceAccountName: 'calendar', scopes: [],
        }),
        { credentialExists: true },
      );
    });
    assert.equal(requests, 2);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('network Lasso follows Wreck-compatible redirects and rejects a truncated response', async () => {
  let requests = 0;
  const server = http.createServer((req, res) => {
    requests += 1;
    if (requests === 1) {
      res.writeHead(307, { location: '/v1/credential?redirected=1', connection: 'close' });
      res.end();
      return;
    }
    res.writeHead(200, {
      'content-type': 'application/json',
      connection: 'close',
      'content-length': '30',
    });
    res.write('{"credentialExists":true}');
    res.socket.destroy();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const lasso = providers(`127.0.0.1:${server.address().port}`);
    const params = {
      skillId: 'skill-redirect', serviceName: 'google', serviceAccountName: 'calendar', scopes: ['read'],
    };
    await assert.rejects(
      () => lasso.getCredential(context, params),
      (error) => error.message === 'Failed to get google calendar credentials',
    );
    assert.equal(requests, 2);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
