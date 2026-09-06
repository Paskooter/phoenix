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
      (error) => error.message === 'Missing skillId in lasso credentials get request',
    );
    await assert.rejects(
      () => lasso.createUpdateCredential(context, base),
      (error) => error.message === 'Missing authCode in lasso value',
    );
    await assert.rejects(
      () => lasso.deleteCredential(context, { ...base, serviceName: undefined }),
      (error) => error.message === 'Missing serviceName in lasso credentials delete request',
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
