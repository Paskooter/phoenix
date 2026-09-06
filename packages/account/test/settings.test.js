// H.2 — the settings service: AWS-JSON GetSettings/UpdateSettings round-trip, the friendly
// portal editor, and the end-to-end payoff — the report-skill reading real prefs from a LIVE
// settings service instead of degrading to SettingsFailed.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SkillRequestType } from '@phoenix/contracts';

const dir = mkdtempSync(join(tmpdir(), 'phx-settings-'));
process.env.ETCO_account_dataFile = join(dir, 'store.json');

const { createAccountService, getStore } = await import('../src/index.js');
const { createOwnerAccount, createLoop } = await import('../src/model.js');
const { Store } = await import('../src/store.js');

let server; let base; let store; let owner; let loop; const jar = new Map();
async function call(method, path, body, jarName = 'c') {
  const res = await fetch(`${base}${path}`, {
    method, headers: { 'content-type': 'application/json', ...(jar.get(jarName) ? { cookie: jar.get(jarName) } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const sc = res.headers.get('set-cookie'); if (sc) jar.set(jarName, sc.split(';')[0]);
  return { status: res.status, body: await res.json().catch(() => null), headers: res.headers };
}
async function amzSettings(op, body, accountId, prefix = 'Settings_20171219') {
  const res = await fetch(`${base}/`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-amz-json-1.1',
      'x-amz-target': `${prefix}.${op}`,
      ...(accountId ? { 'x-amz-credentials': JSON.stringify({ id: accountId }) } : {}),
    },
    body: JSON.stringify(body || {}),
  });
  return { status: res.status, body: await res.json().catch(() => null), headers: res.headers };
}

before(async () => {
  store = getStore();
  owner = createOwnerAccount(store, { email: 'settings-owner@jetson.test', password: 'settings-pass' });
  ({ loop } = createLoop(store, { owner, robotId: 'settings-robot' }));
  server = await createAccountService({ store }).listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });

test('AWS-JSON GetSettings: default report-skill data shape the report-skill expects', async () => {
  const r = await amzSettings('GetSettings', { loopId: loop._id, skills: 'report-skill' }, owner._id);
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body));
  assert.equal(r.headers.get('x-powered-by'), null, 'Hapi-compatible Settings response omits Express identity header');
  const entry = r.body.find((s) => s.skillId === 'report-skill');
  assert.ok(entry, 'report-skill entry present');
  assert.equal(entry.data.weatherEnabled.value, 1, 'weather on by default');
  assert.equal(entry.data.newsEnabled.value, 1, 'news on by default');
  assert.equal(entry.data.commuteEnabled.value, 0, 'commute off by default');
});

test('Account peer routes expose the source Account client response fields', async () => {
  const member = await fetch(`${base}/isLoopMember?accountId=${encodeURIComponent(owner._id)}&loopId=${encodeURIComponent(loop._id)}`);
  assert.equal(member.status, 200);
  assert.deepEqual(await member.json(), { result: true });
  const populated = await fetch(`${base}/loopPopulated?loopId=${encodeURIComponent(loop._id)}`);
  assert.equal(populated.status, 200);
  assert.deepEqual(await populated.json(), { id: loop._id, robotFriendlyId: 'settings-robot' });
});

test('internal Settings credentials preserve null failure and falsy primitive provider context', async () => {
  const contexts = [];
  const providerServer = await createAccountService({
    store: new Store(join(dir, 'credential-edge-store.json')),
    settingsProviders: {
      account: { checkUserBelongsToLoop: async (context) => {
        contexts.push(context);
        throw Object.assign(new Error('Only loop member can query loop properties'), {
          isBoom: true, statusCode: 403, code: 'LOOP_MEMBER_ONLY',
        });
      } },
      hub: { getSkillConfigs: async () => assert.fail('membership failure must stop the provider graph') },
    },
  }).listen(0);
  const endpoint = `http://127.0.0.1:${providerServer.address().port}/`;
  async function request(credentials, body = { loopId: 'loop-1' }) {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-amz-target': 'Settings_20171219.GetSettings',
        'x-amz-credentials': credentials },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.text() };
  }
  try {
    // Exact Node 8 TCP observations from the source handler, including key order.
    assert.deepEqual(await request('null'), {
      status: 500,
      body: '{"message":"An internal server error occurred","statusCode":500,"error":"Internal Server Error"}',
    });
    assert.equal(contexts.length, 0);
    assert.deepEqual(await request('null', {}), {
      status: 422,
      body: JSON.stringify({ statusCode: 422, error: 'Unprocessable Entity',
        message: 'child "loopId" fails because ["loopId" is required]' }),
    });
    assert.equal(contexts.length, 0, 'validation precedes credentials.id access');
    for (const credentials of ['false', '0', '""']) {
      assert.deepEqual(await request(credentials), {
        status: 403,
        body: '{"statusCode":403,"error":"Forbidden","message":"Only loop member can query loop properties","code":"LOOP_MEMBER_ONLY"}',
      });
      assert.equal(contexts.at(-1).userId, undefined);
      assert.equal(contexts.at(-1).loopId, 'loop-1');
    }
    assert.equal(contexts.length, 3);
  } finally {
    await new Promise(resolve => providerServer.close(resolve));
  }
});

test('legacy Settings_20160801.GetSettings accepts the report client string selector and strips view', async () => {
  const r = await amzSettings(
    'GetSettings',
    { loopId: loop._id, transId: 'legacy-trans', skills: 'report-skill', getView: false },
    owner._id,
    'Settings_20160801',
  );
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.map(({ skillId, data, ...rest }) => ({ skillId, data, ...rest })), [
    { skillId: 'report-skill', data: r.body[0].data },
  ]);
  assert.equal(Object.prototype.hasOwnProperty.call(r.body[0], 'view'), false);
  assert.equal(r.body[0].data.weatherEnabled.value, 1);
});

test('Settings_20171219 GetDataForSettings preserves source view/filter semantics for local report data', async () => {
  const view = {
    type: 'group',
    childViews: [
      { type: 'switch', valueDefinition: { target: 'person', key: 'weatherEnabled' } },
      { type: 'switch', valueDefinition: { target: 'person', key: 'missingSetting', default: false } },
    ],
  };
  const body = {
    loopId: loop._id,
    settings: [{ skillId: 'report-skill', view }],
    skills: ['report-skill'],
  };
  const withView = await amzSettings('GetDataForSettings', body, owner._id);
  assert.equal(withView.status, 200);
  assert.deepEqual(withView.body, [{
    skillId: 'report-skill',
    view,
    data: { weatherEnabled: { value: 1 }, missingSetting: { value: false } },
  }]);

  const withoutView = await amzSettings(
    'GetDataForSettings', { ...body, getView: false }, owner._id, 'Settings_20171219',
  );
  assert.equal(withoutView.status, 200);
  assert.deepEqual(withoutView.body, [{
    skillId: 'report-skill',
    data: { weatherEnabled: { value: 1 }, missingSetting: { value: false } },
  }]);

  const otherSkill = await amzSettings(
    'GetSettings', { loopId: loop._id, skills: ['other-skill'] }, owner._id, 'Settings_20171219',
  );
  assert.deepEqual(otherSkill.body, []);
});

test('Settings Get validation follows source credentials/loop/settings requirements', async () => {
  const noCreds = await amzSettings('GetSettings', { loopId: 'l' });
  assert.equal(noCreds.status, 403);
  assert.deepEqual(noCreds.body, {
    statusCode: 403,
    error: 'Forbidden',
    message: 'Only loop member can query loop properties',
    code: 'LOOP_MEMBER_ONLY',
  });

  const noLoop = await amzSettings('GetSettings', {}, owner._id);
  assert.equal(noLoop.status, 422);
  assert.deepEqual(noLoop.body, {
    statusCode: 422,
    error: 'Unprocessable Entity',
    message: 'child "loopId" fails because ["loopId" is required]',
  });

  const noSettings = await amzSettings('GetDataForSettings', { loopId: loop._id }, owner._id);
  assert.equal(noSettings.status, 422);
  assert.deepEqual(noSettings.body, {
    statusCode: 422,
    error: 'Unprocessable Entity',
    message: 'child "settings" fails because ["settings" is required]',
  });

  const emptySettings = await amzSettings('GetDataForSettings', { loopId: loop._id, settings: [] }, owner._id);
  assert.equal(emptySettings.status, 422);
  assert.equal(emptySettings.body.message, 'child "settings" fails because ["settings" must contain at least 1 items]');
});

test('source-shaped Settings provider seams preserve view, provider order, and per-node data', async () => {
  const calls = [];
  const view = {
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
  const providers = {
    account: { checkUserBelongsToLoop: async (context) => calls.push(['account', context]) },
    hub: { getSkillConfigs: async (context) => { calls.push(['hub', context]); return [{ id: 'report-skill', settings: { view } }]; } },
    person: {
      getAccountProperties: async (context, keys) => { calls.push(['account-properties', context, keys]); return { accountFlag: { value: true } }; },
      getLoopProperties: async (context, keys) => { calls.push(['loop-properties', context, keys]); return {}; },
    },
    lasso: {
      getCredential: async (context, params) => { calls.push(['credential', context, params]); return { credentialExists: true }; },
    },
  };
  const providerStore = new Store(join(dir, 'provider-store.json'));
  const providerServer = await createAccountService({ store: providerStore, settingsProviders: providers }).listen(0);
  const providerBase = `http://localhost:${providerServer.address().port}`;
  try {
    const response = await fetch(`${providerBase}/`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-amz-target': 'Settings_20171219.GetSettings',
        'x-amz-credentials': JSON.stringify({ id: 'provider-user' }),
      },
      body: JSON.stringify({ loopId: 'provider-loop', transId: 'provider-trans' }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), [{
      skillId: 'report-skill',
      view,
      data: {
        accountFlag: { value: true },
        loopFlag: { value: true },
        'google:calendar:readonly': { credentialExists: true },
      },
    }]);
    assert.deepEqual(calls, [
      ['account', { loopId: 'provider-loop', transactionId: 'provider-trans', userId: 'provider-user' }],
      ['hub', { loopId: 'provider-loop', transactionId: 'provider-trans', userId: 'provider-user' }],
      ['account-properties', { loopId: 'provider-loop', transactionId: 'provider-trans', userId: 'provider-user' }, ['accountFlag']],
      ['loop-properties', { loopId: 'provider-loop', transactionId: 'provider-trans', userId: 'provider-user' }, ['loopFlag']],
      ['credential', { loopId: 'provider-loop', transactionId: 'provider-trans', userId: 'provider-user' }, {
        scopes: ['read'], serviceAccountName: 'calendar', serviceName: 'google', skillId: 'report-skill',
      }],
    ]);
  } finally {
    await new Promise((resolve) => providerServer.close(resolve));
  }
});

test('source Settings graph runs service groups concurrently and updates connectable OAuth parents', async () => {
  const calls = [];
  const view = {
    type: 'group',
    childViews: [{
      type: 'connectable',
      valueDefinition: { target: 'person', key: 'calendarConnected' },
      childViews: [{
        type: 'oauth',
        valueDefinition: { target: 'lasso', key: 'google:calendar:readonly' },
        oauthParams: { serviceName: 'google', serviceAccountName: 'calendar', scopes: ['read'] },
      }],
    }],
  };
  const providers = {
    account: { checkUserBelongsToLoop: async () => {} },
    hub: { getSkillConfigs: async () => [{ id: 'report-skill', settings: { view } }] },
    person: {
      getAccountProperties: async () => {
        calls.push('person-start');
        await new Promise((resolve) => setTimeout(resolve, 20));
        calls.push('person-end');
        return { calendarConnected: { value: false } };
      },
      getLoopProperties: async () => ({}),
    },
    lasso: {
      getCredential: async () => {
        calls.push('lasso-start');
        await new Promise((resolve) => setTimeout(resolve, 1));
        calls.push('lasso-end');
        return { credentialExists: true };
      },
    },
  };
  const providerStore = new Store(join(dir, 'concurrent-provider-store.json'));
  const providerServer = await createAccountService({ store: providerStore, settingsProviders: providers }).listen(0);
  try {
    const response = await fetch(`http://localhost:${providerServer.address().port}/`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-amz-target': 'Settings_20171219.GetSettings',
        'x-amz-credentials': JSON.stringify({ id: 'provider-user' }),
      },
      body: JSON.stringify({ loopId: 'provider-loop' }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), [{
      skillId: 'report-skill',
      view,
      data: {
        calendarConnected: { value: true },
        'google:calendar:readonly': { credentialExists: true },
      },
    }]);
    assert.deepEqual(calls, ['person-start', 'lasso-start', 'lasso-end', 'person-end']);
  } finally {
    await new Promise((resolve) => providerServer.close(resolve));
  }
});

test('source Settings graph preserves null credentials and source null-map diagnostics', async () => {
  const providers = {
    account: { checkUserBelongsToLoop: async () => {} },
    hub: { getSkillConfigs: async () => [] },
    person: { getAccountProperties: async () => ({}), getLoopProperties: async () => ({}) },
    lasso: { getCredential: async () => null },
  };
  const providerStore = new Store(join(dir, 'null-provider-store.json'));
  const providerServer = await createAccountService({ store: providerStore, settingsProviders: providers }).listen(0);
  async function request(body) {
    const response = await fetch(`http://localhost:${providerServer.address().port}/`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-amz-target': 'Settings_20171219.GetDataForSettings',
        'x-amz-credentials': JSON.stringify({ id: 'provider-user' }),
      },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  }
  try {
    const nullCredential = await request({
      loopId: 'provider-loop',
      settings: [{ skillId: 'report-skill', view: {
        type: 'oauth', valueDefinition: { target: 'lasso', key: 'calendar' },
        oauthParams: { serviceName: 'google', serviceAccountName: 'calendar', scopes: ['read'] },
      } }],
    });
    assert.equal(nullCredential.status, 200);
    assert.equal(nullCredential.body[0].data.calendar, null);
    const malformed = await request({
      loopId: 'provider-loop',
      settings: [{ skillId: 'report-skill', view: { type: 'group', childViews: null } }],
    });
    assert.deepEqual(malformed, {
      status: 500,
      body: { message: 'An internal server error occurred', statusCode: 500, error: 'Internal Server Error' },
    });
    providers.person.getAccountProperties = async () => null;
    const nullPerson = await request({
      loopId: 'provider-loop',
      settings: [{ skillId: 'report-skill', view: {
        type: 'switch', valueDefinition: { target: 'person', key: 'accountFlag' },
      } }],
    });
    assert.deepEqual(nullPerson, {
      status: 200,
      body: [{
        skillId: 'report-skill',
        view: { type: 'switch', valueDefinition: { target: 'person', key: 'accountFlag' } },
        data: {},
        errors: { accountFlag: { message: "person request error: Cannot read property 'accountFlag' of null" } },
      }],
    });
  } finally {
    await new Promise((resolve) => providerServer.close(resolve));
  }
});

test('Settings route accepts source JSON values before Joi and does not invent item schemas', async () => {
  const providerStore = new Store(join(dir, 'validation-provider-store.json'));
  const providerServer = await createAccountService({
    store: providerStore,
    settingsProviders: {
      account: { checkUserBelongsToLoop: async () => {} },
      hub: { getSkillConfigs: async () => [] },
      person: { getAccountProperties: async () => ({}), getLoopProperties: async () => ({}) },
      lasso: { getCredential: async () => ({ credentialExists: false }) },
    },
  }).listen(0);
  const providerBase = `http://localhost:${providerServer.address().port}`;
  async function raw(body, op = 'GetSettings') {
    const response = await fetch(`${providerBase}/`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-amz-target': `Settings_20171219.${op}`,
        'x-amz-credentials': JSON.stringify({ id: 'provider-user' }),
      },
      body,
    });
    return { status: response.status, body: await response.json() };
  }
  try {
    assert.deepEqual(await raw('7'), {
      status: 422,
      body: { statusCode: 422, error: 'Unprocessable Entity', message: '"value" must be an object' },
    });
    assert.deepEqual(await raw(JSON.stringify({ loopId: 7 })), {
      status: 422,
      body: { statusCode: 422, error: 'Unprocessable Entity', message: 'child "loopId" fails because ["loopId" must be a string]' },
    });
    assert.deepEqual(await raw(JSON.stringify({ loopId: 'l', settings: [7] }), 'GetDataForSettings'), {
      status: 500,
      body: { message: 'An internal server error occurred', statusCode: 500, error: 'Internal Server Error' },
    });
  } finally {
    await new Promise((resolve) => providerServer.close(resolve));
  }
});

test('portal settings editor: GET defaults, PUT toggles, GET reflects', async () => {
  await call('POST', '/api/signup', { email: 'jane@jetson.test', password: 'orbit-city-4ever', firstName: 'Jane' });
  const me = await call('GET', '/api/me');
  const accountId = me.body.account.id;
  const portalOwner = store.accounts.get(accountId);
  const portalLoop = createLoop(store, { owner: portalOwner, robotId: 'portal-settings-robot' }).loop;

  const g = await call('GET', '/api/settings');
  assert.equal(g.body.settings.weather.active, true);
  assert.equal(g.body.settings.news.active, true);

  // Turn news OFF and commute ON with locations.
  const put = await call('PUT', '/api/settings', {
    news: { active: false },
    commute: { active: true, home: { lat: 42.36, lng: -71.06 }, work: { lat: 42.37, lng: -71.12 }, mode: 'driving' },
  });
  assert.equal(put.body.settings.news.active, false);
  assert.equal(put.body.settings.commute.active, true);
  assert.equal(put.body.settings.commute.mode, 'driving');

  // The AWS-JSON face (keyed by the same accountId) reflects it for the report-skill.
  const wire = await amzSettings('GetSettings', { loopId: portalLoop._id, skills: 'report-skill' }, accountId);
  const data = wire.body.find((s) => s.skillId === 'report-skill').data;
  assert.equal(data.newsEnabled.value, 0);
  assert.equal(data.commuteEnabled.value, 1);
  assert.equal(data.homeLocation.lat, 42.36);
});

test('END-TO-END: report-skill reads real prefs from the live settings service (no SettingsFailed)', async () => {
  const store = getStore();
  // an account whose settings say: weather ON, everything else OFF
  const acct = createOwnerAccount(store, { email: 'george@jetson.test', password: 'spacely-sprockets' });
  const georgeLoop = createLoop(store, { owner: acct, robotId: 'george-settings-robot' }).loop;
  await amzSettings('UpdateSettings', {
    data: { weatherEnabled: { value: 1 }, newsEnabled: { value: 0 }, commuteEnabled: { value: 0 }, calendarEnabled: { value: 0 } },
  }, acct._id);

  // point the report-skill at THIS settings service and drive a full report
  process.env.NET_settings = base.replace('http://', '');
  delete process.env.ETCO_report_prefsFromConfig;
  const { reportSkill } = await import('../../skills/src/reportSkill.js');

  const r = await reportSkill({
    type: SkillRequestType.LISTEN_LAUNCH, msgID: 'm', ts: 1,
    data: {
      general: { accountID: 'a', robotID: 'r', lang: 'en-US' },
      runtime: {
        dialog: {}, perception: { speaker: 'u1' },
        loop: { loopId: georgeLoop._id, users: [{ id: 'u1', accountId: acct._id, birthdate: '1990-01-01', firstName: 'George' }] },
        location: { lat: 42.36, lng: -71.06, iso: '2026-06-13T10:00:00-04:00' },
      },
      skill: { id: 'report-skill' },
      result: { nlu: { intent: 'launchPersonalReport', entities: {}, rules: [] }, asr: { text: '' }, memo: 'Reactive' },
    },
  });
  delete process.env.NET_settings;

  const jcp = r.data.action.config.jcp;
  const mims = (jcp.type === 'SLIM' ? [jcp] : jcp.children.filter((c) => c.type === 'SLIM')).map((s) => s.config.play.meta.mim_id);
  // The settings service SUCCEEDED (no SettingsFailed degradation) and its prefs were honored:
  // the "configured" KickOff played (settings returned active prefs), and with only weather
  // active + lasso unreachable here, all-active-services-down routes to AllServicesDown — NOT
  // SettingsFailed, and news (disabled) is never attempted (no NewsServiceDown).
  assert.ok(!mims.includes('PersonalReportSettingsFailed'), `no SettingsFailed: ${JSON.stringify(mims)}`);
  assert.ok(mims.includes('PersonalReportKickOff'), `configured kickoff played: ${JSON.stringify(mims)}`);
  assert.ok(mims.includes('PersonalReportAllServicesDown'), `only-active weather down -> AllServicesDown: ${JSON.stringify(mims)}`);
  assert.ok(!mims.includes('NewsServiceDown'), 'news disabled in settings -> not attempted');
});
