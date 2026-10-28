import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createService } from '@phoenix/common';
import { Store } from '../../account/src/store.js';
import { createOwnerAccount, createLoop } from '../../account/src/model.js';
import { createSettingsInternalService, settingsPeerRoutes } from '../../account/src/settingsFace.js';
import { createSettingsProviders } from '../../account/src/settingsProviders.js';
import { ProactiveTransaction } from '../src/proactive/proactiveTransaction.js';
import { SettingsClient } from '../src/settingsClient.js';
import { SkillConfigManager } from '../src/skillClient.js';

const PEER_TOKEN = 'proactive-settings-fixture-peer';
const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const gatedSkill = {
  id: 'report-skill', URL: '', onRobot: true, intents: [],
  proactives: [{ topics: [], contextRules: [], settingsRules: [{
    skill: 'report-skill', key: 'offerProactively', matchRule: 'EXACT', value: { value: true },
  }] }],
};
const plainSkill = {
  id: 'plain-skill', URL: '', onRobot: true, intents: [],
  proactives: [{ topics: [], contextRules: [] }],
};

// Exercise the actual Settings -> Account HTTP membership provider path,
// not a stub that returns success for any forwarded credentials.
async function runtime(t) {
  const previous = process.env.ETCO_account_internalPeerToken;
  process.env.ETCO_account_internalPeerToken = PEER_TOKEN;
  t.after(() => {
    if (previous === undefined) delete process.env.ETCO_account_internalPeerToken;
    else process.env.ETCO_account_internalPeerToken = previous;
  });
  const dir = mkdtempSync(join(tmpdir(), 'phx-proactive-auth-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new Store(join(dir, 'account.json'));
  const owner = createOwnerAccount(store, { email: 'owner@proactive.test', password: 'synthetic-password' });
  const member = createOwnerAccount(store, { email: 'member@proactive.test', password: 'synthetic-password' });
  const { loop, robot } = createLoop(store, { owner, robotId: 'proactive-auth-robot' });
  loop.members.push({ accountId: member._id, status: 'accepted' });
  const memberRow = loop.members.at(-1);
  // Owner opts out while the focused member opts in. An owner fallback or robot
  // principal would give a different result from the required member identity.
  store.settings.set(owner._id, { data: { offerProactively: { value: false } } });
  store.settings.set(member._id, { data: { offerProactively: { value: true } } });
  const membershipRequests = [];
  const routes = settingsPeerRoutes(store);
  const original = routes['GET /isLoopMember'];
  routes['GET /isLoopMember'] = (ctx) => {
    membershipRequests.push(Object.fromEntries(ctx.url.searchParams));
    return original(ctx);
  };
  const account = await createService({ name: 'proactive-account-fixture', routes }).listen(0);
  t.after(() => new Promise((resolve) => account.close(resolve)));
  const providers = createSettingsProviders({ store, env: {
    NET_settings_account: `http://127.0.0.1:${account.address().port}`,
    ETCO_account_internalPeerToken: PEER_TOKEN,
  } });
  const settings = await createSettingsInternalService({ store, settingsProviders: providers }).listen(0);
  t.after(() => new Promise((resolve) => settings.close(resolve)));
  const client = new SettingsClient(`http://127.0.0.1:${settings.address().port}`);
  async function trigger({ accountId = member._id, loopId = loop._id, skills = [gatedSkill], focused = 'focused-person' } = {}) {
    const frames = [];
    const errors = [];
    const tx = new ProactiveTransaction({
      _auth: { id: robot._id, friendlyId: robot.friendlyId },
      _jiboHeaders: { 'x-jibo-transid': 'proactive-settings-test' },
    }, {
      config: { recordLaunchHistory: false }, skills,
      skillConfigManager: new SkillConfigManager(skills), settingsClient: client,
    }, { write: (frame) => frames.push(frame) }, {
      ...quiet, error: (message, fields) => errors.push({ message, ...fields }),
    });
    try {
      tx.handleMessage({ json: { type: 'CONTEXT', data: {
        general: {}, skill: {}, runtime: {
          loop: { loopId, users: [{ id: 'focused-person', accountId }] },
          perception: {},
        },
      } } });
      tx.handleMessage({ json: { type: 'TRIGGER', data: {
        triggerSource: 'SURPRISE', triggerData: { looperID: focused },
      } } });
      await tx.done;
      return { frames, errors };
    } finally { tx.abandon(); }
  }
  return { client, trigger, member, memberRow, owner, loop, robot, membershipRequests,
    settingsURL: `http://127.0.0.1:${settings.address().port}` };
}

test('proactive Settings denial retains its machine cause while preserving source fail-closed selection', async (t) => {
  const { trigger, memberRow, membershipRequests } = await runtime(t);
  memberRow.status = 'removed';
  const result = await trigger({ skills: [gatedSkill, plainSkill] });
  assert.equal(result.frames.length, 1);
  assert.equal(result.frames[0].final, true);
  assert.equal(result.frames[0].data.match.skillID, 'plain-skill');
  assert.equal(membershipRequests.length, 1, 'never retry the request as the owner or robot');
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].error, 'settings GetSettings 403');
  assert.equal(result.errors[0].settingsStatus, 403, 'retain the peer status for correlation');
  assert.equal(result.errors[0].settingsCode, 'LOOP_MEMBER_ONLY', 'distinguish missing membership from bad peer credentials');
});

test('proactive Settings uses the focused human account, not the authenticated robot or owner', async (t) => {
  const { trigger, member, owner, robot, loop, membershipRequests } = await runtime(t);
  assert.notEqual(member._id, owner._id);
  assert.notEqual(member._id, robot._id);
  const result = await trigger();
  assert.equal(result.frames[0].data.match.skillID, 'report-skill');
  assert.deepEqual(result.errors, []);
  assert.deepEqual(membershipRequests, [{ accountId: member._id, loopId: loop._id }]);
});

test('inactive membership and stale loop/account identities deny settings without failing the transaction', async (t) => {
  const { trigger, memberRow, loop, membershipRequests } = await runtime(t);
  // Phoenix intentionally hardens the old Account isLoopMember check by
  // requiring accepted membership; do not relax it to suppress a 403.
  for (const status of ['invited', 'declined', 'removed']) {
    memberRow.status = status;
    const result = await trigger();
    assert.deepEqual(result.frames.map(({ type, final, data }) => ({ type, final, data })), [
      { type: 'PROACTIVE', final: true, data: {} },
    ]);
    assert.equal(result.errors[0].settingsCode, 'LOOP_MEMBER_ONLY');
  }
  memberRow.status = 'ACCEPTED';
  assert.equal((await trigger()).frames[0].data.match.skillID, 'report-skill');
  for (const options of [{ loopId: 'missing-loop' }, { accountId: 'stale-account' }]) {
    const result = await trigger(options);
    assert.deepEqual(result.frames[0].data, {});
    assert.equal(result.errors[0].settingsStatus, 403);
    assert.equal(result.errors[0].settingsCode, 'LOOP_MEMBER_ONLY');
  }
  loop.isDeleted = true;
  const deleted = await trigger();
  assert.deepEqual(deleted.frames[0].data, {});
  assert.equal(deleted.errors[0].settingsCode, 'LOOP_MEMBER_ONLY');
  assert.equal(membershipRequests.length, 7, 'one membership request per trigger, with no principal fallback');
});

test('unknown focused person skips Settings; missing peer authentication is not a membership 403', async (t) => {
  const { trigger, membershipRequests, settingsURL, member, loop } = await runtime(t);
  const result = await trigger({ focused: 'UNKNOWN' });
  assert.deepEqual(result.frames[0].data, {});
  assert.deepEqual(result.errors, []);
  assert.deepEqual(membershipRequests, []);
  const response = await fetch(settingsURL, {
    method: 'POST', headers: {
      'content-type': 'application/json', 'x-amz-target': 'Settings_20160801.GetSettings',
      'x-amz-credentials': JSON.stringify({ id: member._id }),
    },
    body: JSON.stringify({ loopId: loop._id, getView: false, skills: ['report-skill'] }),
  });
  assert.equal(response.status, 401);
  assert.equal((await response.json()).message, 'internal peer authentication failed');
  assert.deepEqual(membershipRequests, []);
});

test('Settings error diagnostics keep only known codes and never a provider message or body', async (t) => {
  let body;
  const server = createServer((req, res) => {
    req.resume();
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const client = new SettingsClient(`http://127.0.0.1:${server.address().port}`);
  const privateMarker = 'SYNTHETIC_PRIVATE_PROVIDER_DETAIL';
  for (const [responseBody, code] of [
    [JSON.stringify({ code: 'LOOP_MEMBER_ONLY', message: privateMarker, credentials: privateMarker }), 'LOOP_MEMBER_ONLY'],
    [JSON.stringify({ code: privateMarker, message: privateMarker }), undefined],
    [`<html>${privateMarker}</html>`, undefined],
    ['null', undefined],
  ]) {
    body = responseBody;
    await assert.rejects(client.getSettings('member', 'loop', 'trans', ['report-skill']), (error) => {
      assert.equal(error.message, 'settings GetSettings 403');
      assert.equal(error.statusCode, 403);
      assert.equal(error.code, code);
      assert.equal(JSON.stringify(error).includes(privateMarker), false);
      assert.equal(error.stack.includes(privateMarker), false);
      return true;
    });
  }
});
