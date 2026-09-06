import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSettingsInternalService, createSettingsProviders } from '../src/index.js';
import { Store } from '../src/store.js';
import { getSettingsData, setSettingsData } from '../src/settingsData.js';

const reportView = {
  type: 'group',
  childViews: [
    { type: 'switch', valueDefinition: { target: 'person', key: 'accountFlag', default: false } },
    { type: 'switch', valueDefinition: { target: 'loop', key: 'loopFlag', default: true } },
    {
      type: 'oauth',
      valueDefinition: { target: 'lasso', key: 'google:calendar:readonly' },
      oauthParams: { serviceName: 'google', serviceAccountName: 'calendar', scopes: ['read'] },
    },
  ],
};

function providers({ accountProperties = {}, loopProperties = {}, credential = { credentialExists: false }, calls = [], fail = {} } = {}) {
  return {
    account: {
      checkUserBelongsToLoop: async (context) => {
        calls.push(['account', context]);
        if (fail.membership) throw Object.assign(new Error(fail.membership), {
          isBoom: true,
          statusCode: 403,
          output: { payload: { statusCode: 403, error: 'Forbidden', message: fail.membership, code: 'LOOP_NOT_MEMBER' } },
        });
      },
    },
    hub: {
      getSkillConfigs: async () => [{ id: 'report-skill', settings: { view: structuredClone(reportView) } }],
    },
    person: {
      setAccountProperty: async (context, key, value) => {
        calls.push(['set-account', context, key, value]);
        if (fail.account) throw new Error(fail.account);
        accountProperties[key] = value;
      },
      getAccountProperties: async (context, keys) => {
        calls.push(['get-account', context, keys]);
        return Object.fromEntries(keys.map((key) => [key, accountProperties[key]]).filter(([, value]) => value !== undefined));
      },
      setLoopProperty: async (context, key, value) => {
        calls.push(['set-loop', context, key, value]);
        if (fail.loop) throw new Error(fail.loop);
        loopProperties[key] = value;
      },
      getLoopProperties: async (context, keys) => {
        calls.push(['get-loop', context, keys]);
        return Object.fromEntries(keys.map((key) => [key, loopProperties[key]]).filter(([, value]) => value !== undefined));
      },
    },
    lasso: {
      createUpdateCredential: async (context, value) => {
        calls.push(['create-credential', context, value]);
        if (fail.create) throw new Error(fail.create);
      },
      getCredential: async (context, params) => {
        calls.push(['get-credential', context, params]);
        if (fail.get) throw new Error(fail.get);
        return credential;
      },
      deleteCredential: async (context, params) => {
        calls.push(['delete-credential', context, params]);
        if (fail.delete) throw new Error(fail.delete);
      },
    },
  };
}

async function start(providersArg) {
  const dir = mkdtempSync(join(tmpdir(), 'phx-settings-update-delete-'));
  const server = await createSettingsInternalService({
    store: new Store(join(dir, 'store.json')),
    settingsProviders: providersArg,
  }).listen(0);
  return { dir, server, base: `http://127.0.0.1:${server.address().port}` };
}

async function request(base, operation, body, credentials = { id: 'user-1' }) {
  const response = await fetch(`${base}/`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-amz-target': `Settings_20171219.${operation}`,
      'x-amz-credentials': JSON.stringify(credentials),
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json(), headers: response.headers };
}

test('UpdateSettings follows source partial Person/loop/Lasso routing and result shapes', async () => {
  const calls = [];
  const person = { accountFlag: { value: false } };
  const loop = { loopFlag: { value: true } };
  const running = await start(providers({ accountProperties: person, loopProperties: loop, credential: { credentialExists: true }, calls }));
  try {
    const update = await request(running.base, 'UpdateSettings', {
      loopId: 'loop-1',
      transId: 'tx-1',
      data: {
        accountFlag: { skillId: 'report-skill', dataService: 'person', value: { value: 1 } },
        loopFlag: { skillId: 'report-skill', dataService: 'loop', value: { value: 0 } },
        'google:calendar:readonly': {
          skillId: 'report-skill', dataService: 'lasso',
          value: { serviceName: 'google', serviceAccountName: 'calendar', scopes: ['read'], authCode: 'auth' },
        },
      }});
    assert.equal(update.status, 200);
    assert.deepEqual(update.body, {
      data: {
        accountFlag: { skillId: 'report-skill', dataService: 'person', value: { value: true } },
        loopFlag: { skillId: 'report-skill', dataService: 'loop', value: { value: false } },
        'google:calendar:readonly': { skillId: 'report-skill', dataService: 'lasso', value: { credentialExists: true } },
      },
    });
    assert.deepEqual(calls.map((item) => item[0]).slice(0, 2), ['account', 'set-account']);
    assert.deepEqual(new Set(calls.map((item) => item[0])), new Set([
      'account', 'set-account', 'get-account', 'set-loop', 'get-loop', 'create-credential', 'get-credential',
    ]));
  } finally {
    await new Promise((resolve) => running.server.close(resolve));
    rmSync(running.dir, { recursive: true, force: true });
  }
});

test('UpdateSettings and DeleteSettings preserve source unknown/error behavior', async () => {
  const unknown = await start(providers());
  try {
    const result = await request(unknown.base, 'UpdateSettings', {
      loopId: 'loop-1',
      data: { missing: { skillId: 'report-skill', dataService: 'person', value: { value: true } } },
    });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { data: { missing: {
      skillId: 'report-skill', dataService: 'person',
      error: { message: 'Property missing is not found in report-skill manifest' },
    } } });
    const unsupported = await request(unknown.base, 'DeleteSettings', {
      loopId: 'loop-1',
      data: { accountFlag: { skillId: 'report-skill', dataService: 'person' } },
    });
    assert.equal(unsupported.status, 422);
    assert.deepEqual(unsupported.body, {
      statusCode: 422, error: 'Unprocessable Entity',
      message: 'Remove operation for person is not supported', code: 'REMOVE_FOR_TARGET_NOT_SUPPORTED',
    });
  } finally {
    await new Promise((resolve) => unknown.server.close(resolve));
    rmSync(unknown.dir, { recursive: true, force: true });
  }

  const failedCalls = [];
  const failed = await start(providers({ calls: failedCalls, fail: { create: 'write failed' }, credential: { credentialExists: false } }));
  try {
    const result = await request(failed.base, 'UpdateSettings', {
      loopId: 'loop-1',
      data: {
        'google:calendar:readonly': {
          skillId: 'report-skill', dataService: 'lasso',
          value: { serviceName: 'google', serviceAccountName: 'calendar', scopes: ['read'], authCode: 'auth' },
        },
      },
    });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.data['google:calendar:readonly'], {
      skillId: 'report-skill', dataService: 'lasso', value: { credentialExists: false },
      error: { message: 'write failed' },
    });
  } finally {
    await new Promise((resolve) => failed.server.close(resolve));
    rmSync(failed.dir, { recursive: true, force: true });
  }
});

test('DeleteSettings handles explicit OAuth parameters, wildcard and provider failure', async () => {
  const calls = [];
  const running = await start(providers({ calls, fail: { delete: 'delete failed' } }));
  try {
    const result = await request(running.base, 'DeleteSettings', {
      loopId: 'loop-1',
      data: {
        outside: {
          skillId: 'report-skill', dataService: 'lasso',
          oauthParams: { serviceName: 'google', serviceAccountName: 'calendar', scopes: ['read'] },
        },
      },
    });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { data: { outside: {
      skillId: 'report-skill', dataService: 'lasso', deleted: false,
      error: { message: 'delete failed' },
    } } });
    assert.deepEqual(calls.at(-1)[2], {
      skillId: 'report-skill', serviceAccountName: 'calendar', serviceName: 'google', scopes: ['read'],
    });
  } finally {
    await new Promise((resolve) => running.server.close(resolve));
    rmSync(running.dir, { recursive: true, force: true });
  }
});

test('Update/Delete payload validation precedes provider access', async () => {
  const calls = [];
  const running = await start(providers({ calls }));
  try {
    const update = await request(running.base, 'UpdateSettings', {});
    assert.equal(update.status, 422);
    assert.deepEqual(update.body, {
      statusCode: 422, error: 'Unprocessable Entity',
      message: 'child "data" fails because ["data" is required]',
    });
    const deleteResult = await request(running.base, 'DeleteSettings', { loopId: 'loop-1', data: [] });
    assert.equal(deleteResult.status, 422);
    assert.deepEqual(deleteResult.body, {
      statusCode: 422, error: 'Unprocessable Entity',
      message: 'child "data" fails because ["data" must be an object]',
    });
    assert.equal(calls.length, 0);
  } finally {
    await new Promise((resolve) => running.server.close(resolve));
    rmSync(running.dir, { recursive: true, force: true });
  }
});

test('default local providers persist account/loop settings and credential markers', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'phx-settings-local-'));
  const store = new Store(join(dir, 'store.json'));
  const owner = { _id: 'owner-local' };
  const robot = { _id: 'robot-local', friendlyId: 'robot-local' };
  store.accounts.set(owner._id, owner);
  store.accounts.set(robot._id, robot);
  store.loops.set('loop-local', { _id: 'loop-local', owner: owner._id, robot: robot._id, members: [{ accountId: owner._id, status: 'ACCEPTED' }] });
  const providers = createSettingsProviders({ store, env: {} });
  await providers.person.setAccountProperty({ userId: owner._id, loopId: 'loop-local' }, 'accountFlag', { value: true });
  await providers.person.setLoopProperty({ userId: owner._id, loopId: 'loop-local' }, 'loopFlag', { value: false });
  await providers.lasso.createUpdateCredential({ userId: owner._id }, {
    skillId: 'report-skill', serviceName: 'google', serviceAccountName: 'calendar', scopes: ['read'],
  });
  assert.deepEqual(await providers.person.getAccountProperties({ userId: owner._id }, ['accountFlag']), { accountFlag: { value: true } });
  assert.deepEqual(await providers.person.getLoopProperties({ userId: owner._id, loopId: 'loop-local' }, ['loopFlag']), { loopFlag: { value: false } });
  assert.deepEqual(await providers.lasso.getCredential({ userId: owner._id }, {
    skillId: 'report-skill', serviceName: 'google', serviceAccountName: 'calendar', scopes: ['read'],
  }), { credentialExists: true });
  await providers.lasso.deleteCredential({ userId: owner._id }, {
    skillId: 'report-skill', serviceName: 'google', serviceAccountName: 'calendar', scopes: ['read'],
  });
  assert.deepEqual(await providers.lasso.getCredential({ userId: owner._id }, {
    skillId: 'report-skill', serviceName: 'google', serviceAccountName: 'calendar', scopes: ['read'],
  }), { credentialExists: false });
  const reloaded = new Store(join(dir, 'store.json'));
  assert.deepEqual(reloaded.settings.get(owner._id).data.accountFlag, { value: true });
  assert.deepEqual(reloaded.settings.get('loop:loop-local').data.loopFlag, { value: false });
  assert.deepEqual(reloaded.settings.get(`lasso:${owner._id}`).data['["report-skill","google","calendar",["read"]]'], { credentialExists: false });
  rmSync(dir, { recursive: true, force: true });
});

test('local persistence follows source loop and Lasso identity dimensions', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'phx-settings-persistence-'));
  const store = new Store(join(dir, 'store.json'));
  const providers = createSettingsProviders({ store, env: {} });
  const memberA = { userId: 'member-a', loopId: 'loop-shared' };
  const memberB = { userId: 'member-b', loopId: 'loop-shared' };
  const otherLoop = { userId: 'member-b', loopId: 'loop-other' };
  const credential = {
    serviceName: 'google', serviceAccountName: 'calendar',
    scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
  };
  try {
    // srv-person's LoopProperty.findOne/find filters use { loopId, key };
    // updatedAccountId records the writer but does not partition the value.
    await providers.person.setLoopProperty(memberA, 'loopFlag', { value: 'from-a' });
    assert.deepEqual(await providers.person.getLoopProperties(memberB, ['loopFlag']), {
      loopFlag: { value: 'from-a' },
    });
    assert.deepEqual(await providers.person.getLoopProperties(otherLoop, ['loopFlag']), {});
    await providers.person.setLoopProperty(memberB, 'loopFlag', { value: 'from-b' });
    assert.deepEqual(await providers.person.getLoopProperties(memberA, ['loopFlag']), {
      loopFlag: { value: 'from-b' },
    });

    // Lasso's unique index includes skillId as well as account/service/scopes.
    await providers.lasso.createUpdateCredential(
      { userId: 'account-1' }, { ...credential, skillId: 'skill-a' },
    );
    assert.deepEqual(await providers.lasso.getCredential(
      { userId: 'account-1' }, { ...credential, skillId: 'skill-a' },
    ), { credentialExists: true });
    assert.deepEqual(await providers.lasso.getCredential(
      { userId: 'account-1' }, { ...credential, skillId: 'skill-b' },
    ), { credentialExists: false });
    assert.deepEqual(await providers.lasso.getCredential(
      { userId: 'account-2' }, { ...credential, skillId: 'skill-a' },
    ), { credentialExists: false });
    await providers.lasso.createUpdateCredential(
      { userId: 'account-1' }, { ...credential, skillId: 'skill-b' },
    );
    await providers.lasso.deleteCredential(
      { userId: 'account-1' }, { ...credential, skillId: 'skill-a' },
    );
    assert.deepEqual(await providers.lasso.getCredential(
      { userId: 'account-1' }, { ...credential, skillId: 'skill-a' },
    ), { credentialExists: false });
    assert.deepEqual(await providers.lasso.getCredential(
      { userId: 'account-1' }, { ...credential, skillId: 'skill-b' },
    ), { credentialExists: true });

    const reloaded = new Store(join(dir, 'store.json'));
    assert.deepEqual(reloaded.settings.get('loop:loop-shared').data.loopFlag, { value: 'from-b' });
    const lassoRecord = reloaded.settings.get('lasso:account-1').data;
    assert.deepEqual(lassoRecord['["skill-a","google","calendar",["https://www.googleapis.com/auth/calendar.readonly"]]'], { credentialExists: false });
    assert.deepEqual(lassoRecord['["skill-b","google","calendar",["https://www.googleapis.com/auth/calendar.readonly"]]'], { credentialExists: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('local Lasso follows source scope subset identity and safe legacy markers', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'phx-settings-lasso-identity-'));
  const store = new Store(join(dir, 'store.json'));
  const providers = createSettingsProviders({ store, env: {} });
  const context = { userId: 'identity-account' };
  const base = {
    skillId: 'skill-alpha', serviceName: 'google', serviceAccountName: 'calendar',
    scopes: ['scope:a', 'scope:b'],
  };
  try {
    await providers.lasso.createUpdateCredential(context, base);
    assert.deepEqual(await providers.lasso.getCredential(context, { ...base }), { credentialExists: true });
    assert.deepEqual(await providers.lasso.getCredential(context, { ...base, scopes: ['scope:b', 'scope:a'] }), { credentialExists: true });
    assert.deepEqual(await providers.lasso.getCredential(context, { ...base, scopes: ['scope:a', 'scope:a'] }), { credentialExists: true });
    assert.deepEqual(await providers.lasso.getCredential(context, { ...base, scopes: ['scope:a'] }), { credentialExists: true });
    assert.deepEqual(await providers.lasso.getCredential(context, { ...base, scopes: ['scope:a', 'scope:b', 'scope:c'] }), { credentialExists: false });
    assert.deepEqual(await providers.lasso.getCredential(context, { ...base, scopes: ['scope:c'] }), { credentialExists: false });
    assert.deepEqual(await providers.lasso.getCredential(context, { ...base, skillId: 'skill-beta' }), { credentialExists: false });
    await assert.rejects(
      providers.lasso.getCredential(context, { ...base, scopes: [] }),
      /Scopes should be not empty array/,
    );

    // A source query that matches two active credentials is treated as no
    // credential by checkCredentialExists; it must not select an arbitrary one.
    await providers.lasso.createUpdateCredential(context, {
      ...base, skillId: 'skill-many', scopes: ['scope:a', 'scope:b'],
    });
    await providers.lasso.createUpdateCredential(context, {
      ...base, skillId: 'skill-many', scopes: ['scope:a', 'scope:c'],
    });
    assert.deepEqual(await providers.lasso.getCredential(context, {
      ...base, skillId: 'skill-many', scopes: ['scope:a'],
    }), { credentialExists: false });
    assert.deepEqual(await providers.lasso.getCredential(context, {
      ...base, skillId: 'skill-many', scopes: ['scope:a', 'scope:b'],
    }), { credentialExists: true });

    // Save with a reordered subset updates the existing source identity rather
    // than creating a second local record.
    await providers.lasso.createUpdateCredential(context, { ...base, scopes: ['scope:b'] });
    assert.deepEqual(await providers.lasso.getCredential(context, { ...base }), { credentialExists: true });

    const delimiterCredential = {
      skillId: 'skill-delimiter', serviceName: 'service:with-colon', serviceAccountName: 'account',
      scopes: ['scope:with:colon', 'scope,with,comma'],
    };
    await providers.lasso.createUpdateCredential(context, delimiterCredential);
    assert.deepEqual(await providers.lasso.getCredential(context, delimiterCredential), { credentialExists: true });

    // A safe legacy marker remains readable, but the same colon-joined key is
    // not trusted for an unsafe alternate scope value.
    const settings = getSettingsData(store, context.userId);
    setSettingsData(store, context.userId, { ...settings, 'svc:acct:a:b': { credentialExists: true } });
    const legacy = { skillId: 'report-skill', serviceName: 'svc', serviceAccountName: 'acct', scopes: ['a', 'b'] };
    assert.deepEqual(await providers.lasso.getCredential(context, legacy), { credentialExists: true });
    assert.deepEqual(await providers.lasso.getCredential(context, { ...legacy, scopes: ['a:b'] }), { credentialExists: false });
    assert.deepEqual(await providers.lasso.getCredential(context, { ...legacy, skillId: 'skill-beta' }), { credentialExists: false });

    await providers.lasso.deleteCredential(context, { ...base, scopes: ['scope:a'] });
    assert.deepEqual(await providers.lasso.getCredential(context, { ...base }), { credentialExists: false });
    assert.deepEqual(await providers.lasso.getCredential(context, delimiterCredential), { credentialExists: true });

    await providers.lasso.createUpdateCredential(context, {
      ...base, skillId: 'skill-delete-omitted', scopes: ['scope:one'],
    });
    await providers.lasso.deleteCredential(context, {
      ...base, skillId: 'skill-delete-omitted', scopes: undefined,
    });
    assert.deepEqual(await providers.lasso.getCredential(context, {
      ...base, skillId: 'skill-delete-omitted', scopes: ['scope:one'],
    }), { credentialExists: false });

    await providers.lasso.createUpdateCredential(context, {
      ...base, skillId: 'skill-delete-wildcard', scopes: ['scope:one'],
    });
    await providers.lasso.createUpdateCredential(context, {
      ...base, skillId: 'skill-delete-wildcard', scopes: ['scope:two'],
    });
    await providers.lasso.deleteCredential(context, {
      ...base, skillId: 'skill-delete-wildcard', scopes: ['*'],
    });
    assert.deepEqual(await providers.lasso.getCredential(context, {
      ...base, skillId: 'skill-delete-wildcard', scopes: ['scope:one'],
    }), { credentialExists: false });
    assert.deepEqual(await providers.lasso.getCredential(context, {
      ...base, skillId: 'skill-delete-wildcard', scopes: ['scope:two'],
    }), { credentialExists: false });

    await providers.lasso.createUpdateCredential(context, {
      ...base, skillId: 'skill-delete-scalar-a', serviceName: 'service-delete', serviceAccountName: 'account-a', scopes: ['scope:one'],
    });
    await providers.lasso.createUpdateCredential(context, {
      ...base, skillId: 'skill-delete-scalar-b', serviceName: 'service-delete', serviceAccountName: 'account-b', scopes: ['scope:two'],
    });
    await providers.lasso.deleteCredential(context, {
      skillId: '*', serviceName: 'service-delete', serviceAccountName: '*', scopes: ['*'],
    });
    assert.deepEqual(await providers.lasso.getCredential(context, {
      ...base, skillId: 'skill-delete-scalar-a', serviceName: 'service-delete', serviceAccountName: 'account-a', scopes: ['scope:one'],
    }), { credentialExists: false });
    assert.deepEqual(await providers.lasso.getCredential(context, {
      ...base, skillId: 'skill-delete-scalar-b', serviceName: 'service-delete', serviceAccountName: 'account-b', scopes: ['scope:two'],
    }), { credentialExists: false });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('local Lasso does not reactivate deleted supersets and replaces report calendar providers', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'phx-settings-lasso-replacement-'));
  const store = new Store(join(dir, 'store.json'));
  const providers = createSettingsProviders({ store, env: {} });
  const context = { userId: 'replacement-account' };
  try {
    const original = {
      skillId: 'report-skill', serviceName: 'google', serviceAccountName: 'personalCalendar',
      scopes: ['scope:a', 'scope:b'],
    };
    await providers.lasso.createUpdateCredential(context, original);
    await providers.lasso.deleteCredential(context, { ...original, scopes: ['scope:a'] });
    await providers.lasso.createUpdateCredential(context, { ...original, scopes: ['scope:a'] });
    assert.deepEqual(await providers.lasso.getCredential(context, { ...original, scopes: ['scope:b'] }), {
      credentialExists: false,
    });
    assert.deepEqual(await providers.lasso.getCredential(context, { ...original, scopes: ['scope:a'] }), {
      credentialExists: true,
    });

    await providers.lasso.createUpdateCredential(context, {
      ...original, serviceName: 'outlook', scopes: ['scope:a'],
    });
    assert.deepEqual(await providers.lasso.getCredential(context, original), { credentialExists: false });
    assert.deepEqual(await providers.lasso.getCredential(context, {
      ...original, serviceName: 'outlook', scopes: ['scope:a'],
    }), { credentialExists: true });

    // The pinned source assigns newCredential.skillId = 'report-skill' in
    // deleteOtherCredentials. A non-report incoming skill therefore still
    // removes the old report slot, while its own saved tuple remains separate.
    await providers.lasso.createUpdateCredential(context, {
      ...original, skillId: 'other-skill', serviceName: 'google', scopes: ['scope:a'],
    });
    assert.deepEqual(await providers.lasso.getCredential(context, {
      ...original, serviceName: 'outlook', scopes: ['scope:a'],
    }), { credentialExists: false });
    assert.deepEqual(await providers.lasso.getCredential(context, {
      ...original, skillId: 'other-skill', serviceName: 'google', scopes: ['scope:a'],
    }), { credentialExists: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('configured Person/Lasso providers use the source update/delete peer boundaries', async () => {
  const requests = [];
  const peer = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let raw = '';
    for await (const chunk of req) raw += chunk;
    requests.push({ method: req.method, path: url.pathname, query: [...url.searchParams], target: req.headers['x-amz-target'], body: raw ? JSON.parse(raw) : undefined });
    const body = JSON.stringify({ created: true, deleted: true, credentialExists: true });
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    res.end(body);
  });
  const dir = mkdtempSync(join(tmpdir(), 'phx-settings-network-update-'));
  try {
    await new Promise((resolve) => peer.listen(0, resolve));
    const address = `127.0.0.1:${peer.address().port}`;
    const graph = createSettingsProviders({
      store: new Store(join(dir, 'store.json')),
      env: { NET_settings_person: address, NET_settings_lasso: address },
    });
    const context = { userId: 'user-1', loopId: 'loop-1', transactionId: 'tx-1' };
    await graph.person.setAccountProperty(context, 'accountFlag', { value: true });
    await graph.person.setLoopProperty(context, 'loopFlag', { value: false });
    await graph.lasso.createUpdateCredential(context, {
      skillId: 'report-skill', serviceName: 'google', serviceAccountName: 'calendar', scopes: ['read'], authCode: 'auth', clientId: 'client',
    });
    await graph.lasso.deleteCredential(context, {
      skillId: 'report-skill', serviceName: 'google', serviceAccountName: 'calendar', scopes: ['read'],
    });
    assert.deepEqual(requests.map((request) => [request.method, request.path, request.target]), [
      ['POST', '/', 'Person_20160801.SetAccountProperty'],
      ['POST', '/', 'Person_20160801.SetLoopProperty'],
      ['POST', '/v1/credential', undefined],
      ['DELETE', '/v1/credential', undefined],
    ]);
    assert.deepEqual(requests[0].body, { key: 'accountFlag', value: { value: true } });
    assert.deepEqual(requests[1].body, { key: 'loopFlag', value: { value: false }, loopId: 'loop-1' });
    assert.deepEqual(requests[2].body, {
      skillId: 'report-skill', serviceName: 'google', serviceAccountName: 'calendar', scopes: ['read'], authCode: 'auth', clientId: 'client', accountId: 'user-1',
    });
    assert.deepEqual(requests[3].query, [
      ['accountId', 'user-1'], ['skillId', 'report-skill'], ['serviceName', 'google'],
      ['serviceAccountName', 'calendar'], ['scopes[0]', 'read'],
    ]);
  } finally {
    await new Promise((resolve) => peer.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});
