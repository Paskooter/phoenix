// H-05 — proactive user-settings enforcement, observed at runtime.
//
// Every gate assertion below comes from real network traffic: a proactive WebSocket against
// a live gateway whose settings client talks to a live account/Settings service, plus the
// focused rule matrix. The pinned contract is:
//
//   pegasus@5c0a7390539663ba749d360de348a428c088505c
//     packages/hub/src/proactive/tools/SettingsRulesChecker.ts:22-87  (domain list, per-rule gates)
//     packages/hub/src/utils/SettingsClient.ts:18-47                  (one GetSettings, {skillId,data} map)
//     packages/hub/src/utils/TransactionHelper.ts:20-26               (focused person -> loop account)
//     packages/hub/src/proactive/ProactiveTransactionHandler.ts:196-241 (single pre-fetch, fail-closed catch)
//   docs/parity/evidence/2026-09-05/reference/transactions.json:4228-4262 (captured reference request/response)
//   https://pvindex.org/confluence/display/SDK/Mobile-Settings-Lasso+support+for+Personal+Report+credentials
//     (GetSettings response data example: {offerProactively ... {value:true}})

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { WebSocket } from 'ws';
import { jwt } from '@phoenix/common';

const { createGateway } = await import('@phoenix/gateway');
const { createAccountService } = await import('@phoenix/account');
const { Store } = await import('@phoenix/account/src/store.js');
const { createOwnerAccount, createLoop } = await import('@phoenix/account/src/model.js');
const { checkSettingsRules, checkSettingsRegistrations, getDomainList, getSkillSettingsMap } = await import('../src/proactive/settingsRules.js');
const { SettingsClient } = await import('../src/settingsClient.js');

const SECRET = 'h05-runtime-secret';
const manifestPath = new URL('../resources/skills/pegasus-skills/report_skill_manifest.json', import.meta.url);
const REPORT_MANIFEST = JSON.parse(await readFile(manifestPath, 'utf8'));

// ---------------------------------------------------------------------------
// Rule matrix (SettingsRulesChecker.checkSettingsRules)
// ---------------------------------------------------------------------------

const PR = { skillID: 'report-skill', settingsRules: [{ skill: 'report-skill', key: 'offerProactively', matchRule: 'EXACT', value: { value: true } }] };
const mapOf = (data) => new Map([['report-skill', data]]);

test('a registration with no settingsRules is eligible even without any settings map', () => {
  assert.equal(checkSettingsRules({ skillID: 'x' }, null), true);
  assert.equal(checkSettingsRules({ skillID: 'x', settingsRules: [] }, null), true);
});

test('a registration with settingsRules is ineligible without a settings map (unknown person)', () => {
  assert.equal(checkSettingsRules(PR, null), false);
  assert.equal(checkSettingsRules(PR, new Map()), false);
});

test('a registration is ineligible when the rule skill has no settings entry', () => {
  assert.equal(checkSettingsRules(PR, new Map([['other-skill', { offerProactively: { value: true } }]])), false);
});

test('a registration is ineligible when the rule key is missing from the skill settings', () => {
  assert.equal(checkSettingsRules(PR, mapOf({ weatherEnabled: { value: true } })), false);
});

test('a disabled preference fails EXACT and an enabled preference passes it', () => {
  assert.equal(checkSettingsRules(PR, mapOf({ offerProactively: { value: false } })), false);
  assert.equal(checkSettingsRules(PR, mapOf({ offerProactively: { value: true } })), true);
});

test('a NOT rule inverts the same comparison', () => {
  const notRule = { skillID: 'report-skill', settingsRules: [{ skill: 'report-skill', key: 'offerProactively', matchRule: 'NOT', value: { value: true } }] };
  assert.equal(checkSettingsRules(notRule, mapOf({ offerProactively: { value: false } })), true);
  assert.equal(checkSettingsRules(notRule, mapOf({ offerProactively: { value: true } })), false);
});

test('every rule must pass and only settings-ruled registrations are filtered', () => {
  const both = { skillID: 's', settingsRules: [
    { skill: 'a', key: 'on', matchRule: 'EXACT', value: { value: true } },
    { skill: 'b', key: 'on', matchRule: 'EXACT', value: { value: true } },
  ] };
  const map = new Map([['a', { on: { value: true } }], ['b', { on: { value: false } }]]);
  assert.equal(checkSettingsRules(both, map), false);
  const kept = checkSettingsRegistrations([{ skillID: 'plain' }, PR], mapOf({ offerProactively: { value: true } }));
  assert.deepEqual(kept.map((p) => p.skillID), ['plain', 'report-skill']);
  assert.deepEqual(checkSettingsRegistrations([{ skillID: 'plain' }, PR], mapOf({ offerProactively: { value: false } })), [{ skillID: 'plain' }]);
});

test('getDomainList collects every rule.skill across proactive configs', () => {
  assert.deepEqual(getDomainList([
    { proactives: [{ settingsRules: [{ skill: 'report-skill' }, { skill: 'news-skill' }] }] },
    { proactives: [{ contextRules: [] }, { settingsRules: [{ skill: 'report-skill' }] }] },
  ]), ['report-skill', 'news-skill']);
  assert.deepEqual(getDomainList([{ proactives: [{ contextRules: [] }] }]), []);
});

test('getSkillSettingsMap short-circuits without a request when no domain is implicated', async () => {
  const client = { getSettings() { throw new Error('must not be called'); } };
  const map = await getSkillSettingsMap([{ proactives: [{ contextRules: [] }] }], 'acct', 'loop', 'trans', client);
  assert.equal(map.size, 0);
});

// ---------------------------------------------------------------------------
// SettingsClient (hub/utils/SettingsClient.ts)
// ---------------------------------------------------------------------------

test('SettingsClient rejects missing creds and warns on a missing transId', async () => {
  const client = new SettingsClient('http://127.0.0.1:9');
  await assert.rejects(() => client.getSettings('', 'loop', 'trans', ['report-skill']), /Missing creds/);
  await assert.rejects(() => client.getSettings('acct', '', 'trans', ['report-skill']), /Missing creds/);
  const warned = [];
  const log = { warn: (message) => warned.push(message) };
  assert.equal((await client.getSettings('acct', 'loop', '', [])).size, 0);
  assert.deepEqual(warned, [], 'the empty-skills short circuit does not warn');
  await assert.rejects(() => client.getSettings('acct', 'loop', '', ['report-skill'], log));
  assert.deepEqual(warned, ['Missing transId']);
});

test('SettingsClient sends the pinned request and maps [{skillId,data}] to a Map', async () => {
  const seen = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      seen.push({ headers: req.headers, body: JSON.parse(raw) });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify([{ skillId: 'report-skill', data: { offerProactively: { value: true } } }]));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const client = new SettingsClient(`http://127.0.0.1:${server.address().port}`);
    const map = await client.getSettings('acct-1', 'loop-1', 'trans-1', ['report-skill'], null);
    assert.deepEqual(map.get('report-skill'), { offerProactively: { value: true } });
    assert.equal(seen[0].headers['x-amz-target'], 'Settings_20160801.GetSettings');
    assert.deepEqual(JSON.parse(seen[0].headers['x-amz-credentials']), { id: 'acct-1' });
    assert.deepEqual(seen[0].body, { loopId: 'loop-1', transId: 'trans-1', skills: ['report-skill'], getView: false });
  } finally { await new Promise((r) => server.close(r)); }
});

test('SettingsClient rejects on a non-2xx settings answer', async () => {
  const server = createServer((_req, res) => { res.writeHead(403, { 'content-type': 'application/json' }); res.end(JSON.stringify({ code: 'LOOP_MEMBER_ONLY' })); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const client = new SettingsClient(`http://127.0.0.1:${server.address().port}`);
    await assert.rejects(() => client.getSettings('acct', 'loop', 'trans', ['report-skill'], null), /settings GetSettings 403/);
  } finally { await new Promise((r) => server.close(r)); }
});

// ---------------------------------------------------------------------------
// End-to-end: a live gateway gates the real report-skill proactive registration
// ---------------------------------------------------------------------------

function stubServer(handler) {
  const server = createServer(handler);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` })));
}
const close = (server) => new Promise((r) => server.close(r));

async function withRuntime({ settingsURL }, run) {
  const dir = mkdtempSync(join(tmpdir(), 'phx-h05-'));
  const store = new Store(join(dir, 'store.json'));
  const owner = createOwnerAccount(store, { email: 'h05-owner@jetson.test', password: 'h05-pass' });
  const { loop } = createLoop(store, { owner, robotId: 'h05-robot' });
  const account = await createAccountService({ store }).listen(0);
  const accountURL = settingsURL === undefined ? `http://127.0.0.1:${account.address().port}` : settingsURL;

  // real report-skill manifest, pointed at a stub skill endpoint
  const skillCalls = [];
  const skill = await stubServer((req, res) => {
    let raw = ''; req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      skillCalls.push(JSON.parse(raw));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'SKILL_RESPONSE', msgID: 's1', ts: 1, data: {} }));
    });
  });
  // history stub: no recorded launches, so the IHRule (count < 1) passes
  const history = await stubServer((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ count: 0 })); });

  const gateway = await createGateway({
    hubTokenSecret: SECRET, disableAuth: false, accountUrl: '',
    parserURL: 'http://127.0.0.1:9', historyURL: history.url,
    settingsURL: accountURL, recordLaunchHistory: false,
    skills: [{ ...REPORT_MANIFEST, URL: skill.url }],
  });
  await gateway.service.listen(0);
  const port = gateway.service.server.address().port;

  const amz = (op, body, accountId) => fetch(`http://127.0.0.1:${account.address().port}/`, {
    method: 'POST',
    headers: { 'content-type': 'application/json;charset=utf-8', 'x-amz-target': `Settings_20160801.${op}`, 'x-amz-credentials': JSON.stringify({ id: accountId }) },
    body: JSON.stringify(body),
  }).then(async (res) => ({ status: res.status, body: await res.json().catch(() => null) }));

  try {
    return await run({ owner, loop, port, accountURL, amz, skillCalls });
  } finally {
    for (const socket of gateway.wss.clients) socket.terminate();
    await new Promise((r) => gateway.wss.close(r));
    await new Promise((r) => gateway.service.server.close(r));
    await close(skill.server);
    await close(history.server);
    await new Promise((r) => account.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
}

function token(ownerId) { return jwt.sign({ id: ownerId, friendlyId: 'h05-robot' }, SECRET); }

/** Open a proactive socket, send every frame, collect responses until one is final. */
function driveProactive(port, frames, ownerId) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/proactive`, { headers: { Authorization: `Bearer ${token(ownerId)}`, 'x-jibo-transid': 'h05-trans' } });
    const messages = [];
    let settled = false;
    const finish = () => { if (settled) return; settled = true; try { ws.close(); } catch {} resolve(messages); };
    const timer = setTimeout(finish, 4000);
    ws.on('open', () => frames.forEach((frame) => ws.send(JSON.stringify(frame))));
    ws.on('message', (data) => { const m = JSON.parse(data.toString()); messages.push(m); if (m.final) { clearTimeout(timer); setTimeout(finish, 10); } });
    ws.on('error', reject);
  });
}

function framesFor(loopId, ownerId, looperID = 'person-1') {
  return [
    { type: 'CONTEXT', msgID: 'c1', ts: Date.now(), data: {
      general: { accountID: ownerId, robotID: 'h05-robot', lang: 'en-US', release: '2.0.1' },
      runtime: {
        loop: { loopId, users: [{ id: 'person-1', accountId: ownerId, firstName: 'Ada' }] },
        perception: { peoplePresent: [{ id: 'person-1' }], speaker: 'person-1' },
        location: { iso: '2026-06-13T10:00:00-04:00' }, dialog: {},
      },
      skill: { id: null },
    } },
    { type: 'TRIGGER', msgID: 't1', ts: Date.now(), data: { triggerSource: 'SURPRISE', triggerData: { looperID } } },
  ];
}
const matched = (messages) => messages.some((m) => m.type === 'PROACTIVE' && m.data && m.data.match && m.data.match.skillID === 'report-skill');

test('runtime: an enabled proactive preference routes the report-skill proactive over a real socket', async () => {
  await withRuntime({}, async ({ owner, loop, port, skillCalls }) => {
    const messages = await driveProactive(port, framesFor(loop._id, owner._id), owner._id);
    assert.equal(matched(messages), true, 'PROACTIVE match for report-skill must be emitted');
    assert.equal(messages[0].data.match.isProactive, true);
    assert.equal(messages[0].data.match.onRobot, false);
    assert.equal(skillCalls.length, 1, 'the skill must be launched after the match');
  });
});

test('runtime: opting out stops real proactive routing (no match frame, no skill launch)', async () => {
  await withRuntime({}, async ({ owner, loop, port, amz, skillCalls }) => {
    const before = await driveProactive(port, framesFor(loop._id, owner._id), owner._id);
    assert.equal(matched(before), true);
    assert.equal((await amz('UpdateSettings', { data: { offerProactively: { value: false } } }, owner._id)).status, 200);
    const after = await driveProactive(port, framesFor(loop._id, owner._id), owner._id);
    assert.equal(matched(after), false, 'a disabled preference must suppress the proactive');
    assert.deepEqual(after.map((m) => m.type), ['PROACTIVE']);
    assert.deepEqual(after[0].data, {}, 'the no-action response carries empty data');
    assert.equal(after[0].final, true);
    assert.equal(skillCalls.length, 1, 'no extra skill launch once opted out');
  });
});

test('runtime: opting back in restores proactive routing', async () => {
  await withRuntime({}, async ({ owner, loop, port, amz }) => {
    await amz('UpdateSettings', { data: { offerProactively: { value: false } } }, owner._id);
    assert.equal(matched(await driveProactive(port, framesFor(loop._id, owner._id), owner._id)), false);
    await amz('UpdateSettings', { data: { offerProactively: { value: true } } }, owner._id);
    assert.equal(matched(await driveProactive(port, framesFor(loop._id, owner._id), owner._id)), true);
  });
});

test('runtime: an unknown (non-loop) person has no settings, so the proactive is suppressed', async () => {
  await withRuntime({}, async ({ owner, loop, port }) => {
    const messages = await driveProactive(port, framesFor(loop._id, owner._id, 'stranger'), owner._id);
    assert.equal(matched(messages), false, 'a focused person with no account must fail closed');
    assert.deepEqual(messages[0].data, {});
  });
});

test('runtime: an unreachable settings service fails closed instead of accepting every rule', async () => {
  await withRuntime({ settingsURL: 'http://127.0.0.1:9' }, async ({ owner, loop, port }) => {
    const messages = await driveProactive(port, framesFor(loop._id, owner._id), owner._id);
    assert.equal(matched(messages), false, 'settings-service failure must not accept the registration');
    assert.deepEqual(messages[0].data, {});
  });
});
