import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const { createSettingsProviders } = await import('../src/settingsProviders.js');

function startPeer(handler) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      calls.push({ method: req.method, url: req.url, headers: req.headers, body });
      await handler(req, res, body);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({
      server,
      calls,
      authority: `127.0.0.1:${server.address().port}`,
    }));
  });
}

function reply(res, status, value) {
  const body = value === undefined ? '' : JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(body);
}

function closePeer(peer) {
  return new Promise((resolve) => peer.server.close(resolve));
}

async function makeProviders(accountHandler, hubHandler) {
  const account = await startPeer(accountHandler);
  const hub = await startPeer(hubHandler);
  const providers = createSettingsProviders({
    store: {},
    env: {
      NET_settings_account: account.authority,
      NET_settings_hub: hub.authority,
    },
  });
  return { account, hub, providers };
}

test('Hub uses the source Account prerequisite and source URL/header contract', async () => {
  const peers = await makeProviders(
    (_req, res) => reply(res, 200, { robotFriendlyId: 'robot/one' }),
    (_req, res) => reply(res, 200, { skills: [{ id: 'report-skill' }] }),
  );
  try {
    const context = { loopId: 'loop 1', userId: 'account-1', transactionId: 'tx-1' };
    assert.deepEqual(await peers.providers.hub.getSkillConfigs(context), [{ id: 'report-skill' }]);
    assert.equal(peers.account.calls[0].method, 'GET');
    assert.equal(peers.account.calls[0].url, '/loopPopulated?loopId=loop+1');
    assert.equal(peers.account.calls[0].body, '');
    assert.equal(peers.hub.calls[0].method, 'GET');
    assert.equal(peers.hub.calls[0].url, '/v1/skills/settings/robot/one');
    assert.equal(peers.hub.calls[0].headers['x-jibo-transid'], 'tx-1');
    assert.equal(peers.hub.calls[0].body, '');
  } finally {
    await closePeer(peers.hub);
    await closePeer(peers.account);
  }
});

test('Hub accepts ordinary non-2xx JSON because BaseClient checks payload.error', async () => {
  const peers = await makeProviders(
    (_req, res) => reply(res, 404, { robotFriendlyId: 'robot-404' }),
    (_req, res) => reply(res, 404, { skills: [{ id: 'still-valid' }] }),
  );
  try {
    assert.deepEqual(await peers.providers.hub.getSkillConfigs({
      loopId: 'loop-404', userId: 'account-1', transactionId: 'tx-404',
    }), [{ id: 'still-valid' }]);
  } finally {
    await closePeer(peers.hub);
    await closePeer(peers.account);
  }
});

test('Hub error envelopes expose source Boom fields, including 2xx payload errors', async () => {
  const peers = await makeProviders(
    (_req, res) => reply(res, 200, { robotFriendlyId: 'robot-error' }),
    (_req, res) => reply(res, 200, {
      error: true, code: 'HUB_PAYLOAD_ERROR', message: 'bad hub payload', statusCode: 422,
    }),
  );
  try {
    await assert.rejects(
      peers.providers.hub.getSkillConfigs({ loopId: 'loop-error', userId: 'account-1', transactionId: 'tx-error' }),
      (error) => {
        assert.equal(error.name, 'Error');
        assert.equal(error.message, 'bad hub payload');
        assert.equal(error.isBoom, true);
        assert.equal(error.output.statusCode, 422);
        assert.equal(error.output.payload.code, 'HUB_PAYLOAD_ERROR');
        assert.deepEqual(error.data, { code: 'HUB_PAYLOAD_ERROR' });
        return true;
      },
    );
  } finally {
    await closePeer(peers.hub);
    await closePeer(peers.account);
  }
});

test('Hub preserves source malformed JSON and null-property boundaries', async () => {
  const malformed = await makeProviders(
    (_req, res) => reply(res, 200, { robotFriendlyId: 'robot-malformed' }),
    (_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('not-json'); },
  );
  try {
    await assert.rejects(
      malformed.providers.hub.getSkillConfigs({ loopId: 'loop-malformed', userId: 'account-1', transactionId: 'tx-malformed' }),
      (error) => error.name === 'SyntaxError' && error.isBoom === true && error.output.statusCode === 500,
    );
  } finally {
    await closePeer(malformed.hub);
    await closePeer(malformed.account);
  }

  const nullResponse = await makeProviders(
    (_req, res) => reply(res, 200, { robotFriendlyId: 'robot-null' }),
    (_req, res) => reply(res, 200, null),
  );
  try {
    await assert.rejects(
      nullResponse.providers.hub.getSkillConfigs({ loopId: 'loop-null', userId: 'account-1', transactionId: 'tx-null' }),
      (error) => error.name === 'TypeError' && error.message === "Cannot read property 'skills' of null",
    );
  } finally {
    await closePeer(nullResponse.hub);
    await closePeer(nullResponse.account);
  }
});
