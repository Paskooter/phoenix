import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createAccountService } from '../../account/src/index.js';
import { createLoop } from '../../account/src/model.js';
import { createClassicEntrypoint } from '../src/index.js';
import { PersonStore } from '../src/person.js';
import {
  freePort, setEnv, signedAmz, startClassicChild, storeCallerBoundary, syntheticAccount,
  SYNTHETIC_PEER_TOKEN, writeSyntheticAccountStore,
} from './fixtures/signedClassic.js';

const OPERATIONS = ['GetLoopProperties', 'SetLoopProperty', 'ListHolidays', 'EnableHolidays', 'DisableHolidays'];
const NOW = Date.UTC(2018, 8, 10, 12);
const HOLIDAYS = { FixtureDay: { category: 'public', 2018: '2018-10-31', 2019: '2019-10-31' } };

async function close(server) {
  if (!server?.listening) return;
  server.closeAllConnections?.();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function fixture(t, { peer = true, person = {}, authenticated = true, executable = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'phoenix-person-membership-'));
  const restore = setEnv({
    ETCO_account_internalPeerToken: SYNTHETIC_PEER_TOKEN,
    ETCO_classic_notificationFile: join(dir, 'notifications.json'),
    ETCO_classic_pushFile: join(dir, 'push.json'),
    ETCO_classic_keyFile: join(dir, 'keys.json'),
    ETCO_classic_iftttFile: join(dir, 'ifttt.json'),
    ETCO_classic_robotDir: join(dir, 'robots'),
    ETCO_classic_backupDir: join(dir, 'backups'),
    ETCO_classic_logDir: join(dir, 'logs'),
    ETCO_classic_mediaDir: join(dir, 'media'),
    ETCO_classic_mediaFile: join(dir, 'media.json'),
    ETCO_classic_jotFile: join(dir, 'jot.json'),
    ETCO_classic_voiceTrainingFile: join(dir, 'voice.json'),
  });
  const owner = syntheticAccount('person-owner', { friendlyId: null });
  const otherOwner = syntheticAccount('person-other-owner', { friendlyId: null });
  const member = syntheticAccount('person-member', { friendlyId: null });
  const pending = ['invited', 'declined', 'removed'].map((status) => syntheticAccount(`person-${status}`, { friendlyId: null }));
  const store = writeSyntheticAccountStore(join(dir, 'account.json'), { accounts: [owner, otherOwner, member, ...pending] });
  const { loop, robot } = createLoop(store, { owner, robotId: 'person-fixture-robot' });
  const other = createLoop(store, { owner: otherOwner, robotId: 'person-other-robot' });
  loop.members.push({ _id: 'accepted-member', accountId: member._id, status: 'accepted' });
  for (const account of pending) loop.members.push({ accountId: account._id, status: account._id.slice('person-'.length) });
  store.flush();
  let accountServer;
  let classicServer;
  let child;
  t.after(async () => {
    await child?.stop();
    await close(classicServer);
    await close(accountServer);
    restore();
    rmSync(dir, { recursive: true, force: true });
  });
  const accountRequests = [];
  if (peer === true) accountServer = await createAccountService({ store }).listen(0, '127.0.0.1');
  else if (peer) {
    accountServer = createServer((req, res) => {
      if (peer === 'stall') return;
      res.writeHead(peer.status, { 'content-type': 'application/json' });
      res.end(peer.body);
    });
    await new Promise((resolve) => accountServer.listen(0, '127.0.0.1', resolve));
  }
  accountServer?.on('request', (req) => accountRequests.push({ url: new URL(req.url, 'http://fixture.invalid'), token: req.headers['x-phoenix-internal-token'] }));
  const restoreAccount = setEnv({ NET_account: `127.0.0.1:${accountServer?.address().port || await freePort()}` });
  t.after(restoreAccount);
  const personStore = new PersonStore({ file: join(dir, 'person.json') });
  personStore.saveLoopProperty({ loopId: loop._id, key: 'customHolidays', value: { dates: ['2018-10-31'] }, updatedAccountId: owner._id });
  const holiday = personStore.createHoliday({ name: 'FixtureDay', loopId: loop._id, isEnabled: false });
  let base;
  if (executable) {
    child = await startClassicChild({
      accountDataFile: store.file,
      env: { ETCO_classic_personFile: personStore.file },
      ready: async (origin) => (await signedAmz(origin, 'Person_20160801.ListAccountPropertyKeys', {}, owner)).status === 200,
    });
    base = child.base;
  } else {
    const classic = createClassicEntrypoint({
      ...(authenticated ? { callerBoundary: storeCallerBoundary(store), publicUrl: 'https://classic.fixture.invalid' } : {}),
      person: { store: personStore, holidays: HOLIDAYS, now: () => NOW, ...person },
      gqa: { attributionFile: join(dir, 'attribution.json') },
    });
    classicServer = await classic.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${classicServer.address().port}`;
  }
  const call = (op, credentials = owner, loopId = loop._id) => signedAmz(base, `Person_20160801.${op}`, {
    loopId,
    ...(op === 'SetLoopProperty' ? { key: 'customHolidays', value: { dates: ['2018-11-01'] } } : {}),
    ...(op === 'GetLoopProperties' ? { keys: ['customHolidays'] } : {}),
    ...(/^(Enable|Disable)Holidays$/.test(op) ? { ids: [holiday.id] } : {}),
  }, credentials);
  return { call, owner, otherOwner, member, pending, robot, other, loop, store, personStore, accountServer, accountRequests, base };
}

for (const op of OPERATIONS) {
  test(`Person ${op} requires an available Account adapter`, async (t) => {
    const f = await fixture(t, { peer: false, person: { account: null } });
    const before = readFileSync(f.personStore.file);
    const result = await f.call(op);
    assert.equal(result.status, 503);
    assert.equal(result.errType, 'ACCOUNT_SERVICE_UNAVAILABLE');
    assert.deepEqual(readFileSync(f.personStore.file), before);
  });

  test(`Person ${op} uses Account household authorization by default`, async (t) => {
    const f = await fixture(t);
    const before = readFileSync(f.personStore.file);
    for (const credentials of [f.otherOwner, f.other.robot, ...f.pending]) {
      const result = await f.call(op, credentials);
      assert.equal(result.status, 403);
      assert.equal(result.errType, op.includes('LoopPropert') ? 'LOOP_MEMBER_ONLY' : 'HOLIDAY_MUST_BE_OWNER_OR_ROBOT');
      assert.deepEqual(readFileSync(f.personStore.file), before);
    }
  });

  test(`Person ${op} requires a live loop`, async (t) => {
    const f = await fixture(t);
    f.loop.isDeleted = true;
    f.store.flush();
    const before = readFileSync(f.personStore.file);
    for (const loopId of [f.loop._id, 'missing-loop']) {
      const result = await f.call(op, f.owner, loopId);
      assert.equal(result.status, 403);
      assert.equal(result.errType, op.includes('LoopPropert') ? 'LOOP_MEMBER_ONLY' : 'HOLIDAY_MUST_BE_OWNER_OR_ROBOT');
      assert.deepEqual(readFileSync(f.personStore.file), before);
    }
  });

  test(`Person ${op} keeps owner and robot access`, async (t) => {
    const f = await fixture(t);
    for (const credentials of [f.owner, f.robot]) {
      const result = await f.call(op, credentials);
      assert.equal(result.status, 200);
      if (op === 'GetLoopProperties') assert.deepEqual(result.body, { customHolidays: { dates: ['2018-10-31'] } });
      if (op === 'SetLoopProperty') assert.equal(f.personStore.findLoopProperty(f.loop._id, 'customHolidays').updatedAccountId, credentials._id);
      if (op === 'ListHolidays') assert.ok(result.body.some((h) => h.name === 'FixtureDay'));
      if (op === 'EnableHolidays') assert.ok(f.personStore.findHolidays(f.loop._id).every((h) => h.isEnabled));
      if (op === 'DisableHolidays') assert.ok(f.personStore.findHolidays(f.loop._id).every((h) => !h.isEnabled));
    }
  });

  test(`Person ${op} fails closed when the Account peer is down`, async (t) => {
    const f = await fixture(t, { peer: false });
    const before = readFileSync(f.personStore.file);
    const result = await f.call(op);
    assert.equal(result.status, 503);
    assert.equal(result.errType, 'ACCOUNT_SERVICE_UNAVAILABLE');
    assert.deepEqual(readFileSync(f.personStore.file), before);
  });

  test(`Person ${op} closes the Account timeout without writing`, { timeout: 10_000 }, async (t) => {
    const f = await fixture(t, { peer: 'stall' });
    const before = readFileSync(f.personStore.file);
    const result = await f.call(op);
    assert.equal(result.status, 503);
    assert.equal(result.errType, 'ACCOUNT_SERVICE_UNAVAILABLE');
    assert.equal(f.accountRequests.length, 1);
    assert.deepEqual(readFileSync(f.personStore.file), before);
  });

  test(`Person ${op} requires both Account methods in authenticated mode`, async (t) => {
    const f = await fixture(t, { person: { account: {}, allowTrustedLan: true } });
    const before = readFileSync(f.personStore.file);
    const result = await f.call(op);
    assert.equal(result.status, 503);
    assert.equal(result.errType, 'ACCOUNT_SERVICE_UNAVAILABLE');
    assert.deepEqual(readFileSync(f.personStore.file), before);
  });

  test(`Person ${op} permits explicit standalone LAN trust`, async (t) => {
    const f = await fixture(t, { peer: false, authenticated: false, person: { account: null, allowTrustedLan: true } });
    const result = await f.call(op);
    assert.equal(result.status, 200);
  });
}

test('Person accepted members can round-trip loop properties but holidays require owner or robot', async (t) => {
  const f = await fixture(t);
  const set = await f.call('SetLoopProperty', f.member);
  assert.equal(set.status, 200);
  const get = await f.call('GetLoopProperties', f.member);
  assert.equal(get.status, 200);
  assert.deepEqual(get.body, { customHolidays: { dates: ['2018-11-01'] } });
  const before = readFileSync(f.personStore.file);
  for (const op of OPERATIONS.filter((name) => name.endsWith('Holidays'))) {
    const result = await f.call(op, f.member);
    assert.equal(result.status, 403);
    assert.equal(result.errType, 'HOLIDAY_MUST_BE_OWNER_OR_ROBOT');
    assert.deepEqual(readFileSync(f.personStore.file), before);
  }
});

test('Person executable defaults authorize every household operation through Account', async (t) => {
  const f = await fixture(t, { executable: true });
  const before = readFileSync(f.personStore.file);
  for (const op of OPERATIONS) {
    const result = await f.call(op, f.otherOwner);
    assert.equal(result.status, 403);
    assert.equal(result.errType, op.includes('LoopPropert') ? 'LOOP_MEMBER_ONLY' : 'HOLIDAY_MUST_BE_OWNER_OR_ROBOT');
    assert.deepEqual(readFileSync(f.personStore.file), before);
  }
  assert.equal((await f.call('GetLoopProperties', f.owner)).status, 200);
  assert.equal((await f.call('SetLoopProperty', f.robot)).status, 200);
  assert.deepEqual(JSON.parse(readFileSync(f.personStore.file)).loopProperties[0].value, { dates: ['2018-11-01'] });
  assert.equal(f.accountRequests.length, OPERATIONS.length + 2);
  for (const request of f.accountRequests) {
    assert.equal(request.token, SYNTHETIC_PEER_TOKEN);
    assert.equal(request.url.searchParams.get('loopId'), f.loop._id);
    assert.ok(['/isLoopMember', '/isAccountOwnerOrRobot'].includes(request.url.pathname));
  }
});

for (const peer of [
  { label: 'HTTP failure', status: 401, body: '{"result":true}' },
  { label: 'invalid JSON', status: 200, body: '{' },
  { label: 'nonboolean result', status: 200, body: '{"result":"true"}' },
  { label: 'missing result', status: 200, body: '{}' },
]) {
  test(`Person requires a valid Account answer after ${peer.label}`, async (t) => {
    const f = await fixture(t, { peer });
    const before = readFileSync(f.personStore.file);
    for (const op of OPERATIONS) {
      const result = await f.call(op);
      assert.equal(result.status, 503);
      assert.equal(result.errType, 'ACCOUNT_SERVICE_UNAVAILABLE');
      assert.deepEqual(readFileSync(f.personStore.file), before);
    }
    assert.equal(f.accountRequests.length, OPERATIONS.length);
  });
}

test('Person standalone mode requires an explicit LAN trust opt-in', async (t) => {
  const f = await fixture(t, { peer: false, authenticated: false, person: { account: null } });
  const before = readFileSync(f.personStore.file);
  for (const op of OPERATIONS) {
    assert.equal((await f.call(op)).status, 503);
    assert.deepEqual(readFileSync(f.personStore.file), before);
  }
});
