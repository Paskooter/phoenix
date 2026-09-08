import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store, createAccountService } from '../src/index.js';
import { createOwnerAccount, createLoop, mintSetupToken } from '../src/model.js';

async function fixture(run) {
  const dir = mkdtempSync(join(tmpdir(), 'phoenix-synthetic-unbound-'));
  const store = new Store(join(dir, 'store.json'));
  const events = [], reads = [];
  let mode = 'active';
  const server = await createAccountService({ store,
    robotReadClient: { async getRobot(id) {
      reads.push(id);
      if (mode === 'unavailable') throw new Error('synthetic unavailable');
      return { payload: { suspended: mode === 'disabled' } };
    } },
    invitationProviders: { eventSender: { async send(event) { events.push(event); } } },
  }).listen(0);
  const setup = async (token, id) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/`, {
      method: 'POST', headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': 'OOBE_20161026.SetupRobot', connection: 'close' },
      body: JSON.stringify({ token: token._id, id }),
    });
    return { status: response.status, body: await response.json() };
  };
  try { await run({ store, events, reads, setup, mode(value) { mode = value; } }); }
  finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
}

test('unbound setup creates an owned loop and relocates the robot instead of reusing another owner loop', async () => fixture(async ({ store, setup, events, reads }) => {
  const previous = createOwnerAccount(store, { email: 'previous@synthetic.invalid', password: 'synthetic-password', firstName: 'Alex' });
  const owner = createOwnerAccount(store, { email: 'next@synthetic.invalid', password: 'synthetic-password', firstName: 'Alex' });
  const old = createLoop(store, { owner: previous, robotId: 'synthetic-transfer-robot' });
  const deleted = createLoop(store, { owner, robotId: 'synthetic-deleted-robot' });
  deleted.loop.name = "Alex's Jibo"; deleted.loop.isDeleted = true; store.flush();
  const token = mintSetupToken(store, owner._id);
  const result = await setup(token, old.robot.friendlyId);
  assert.equal(result.status, 200);
  const transferred = [...store.loops.values()].find(loop => loop.owner === owner._id && !loop.isDeleted && loop.robot === old.robot._id);
  assert(transferred, 'source creates a new loop owned by the token account');
  assert.notEqual(transferred._id, old.loop._id);
  assert.equal(transferred.name, "Alex's Jibo", 'other owners and deleted loops do not reserve names');
  assert.equal(store.loops.get(old.loop._id).isSuspended, true);
  assert.equal(store.loops.get(old.loop._id).robot, undefined);
  assert.equal(store.loops.get(old.loop._id).members.some(member => member.accountId === old.robot._id), false);
  assert.equal(result.body.accessKeyId, old.robot.accessKeyId);
  assert.equal(result.body.secretAccessKey, old.robot.secretAccessKey);
  assert.deepEqual(reads, [old.robot.friendlyId]);
  assert.equal(events.filter(event => event.payload.eventKey === 'LoopCreated').length, 1);
  assert.equal(store.tokens.has(token._id), false);
  const nextToken = mintSetupToken(store, owner._id);
  assert.equal((await setup(nextToken, old.robot.friendlyId)).status, 200);
  const reopened = new Store(store.file);
  const latest = [...reopened.loops.values()].find(loop => loop.robot === old.robot._id);
  assert.equal(latest.name, "Alex's 2 Jibo", 'existing owned names reserve the next suffix');
  assert.equal(reopened.loops.get(transferred._id).isSuspended, true);
}));

test('unbound setup rejects disabled robots before mutation and tolerates robot-read failure', async () => fixture(async ({ store, setup, events, mode }) => {
  const owner = createOwnerAccount(store, { email: 'disabled-check@synthetic.invalid', password: 'synthetic-password' });
  const token = mintSetupToken(store, owner._id);
  const before = JSON.stringify({ accounts: [...store.accounts], loops: [...store.loops], tokens: [...store.tokens] });
  mode('disabled');
  const denied = await setup(token, 'synthetic-disabled-robot');
  assert.equal(denied.status, 409);
  assert.equal(denied.body.__type, 'ROBOT_DISABLED');
  assert.equal(JSON.stringify({ accounts: [...store.accounts], loops: [...store.loops], tokens: [...store.tokens] }), before);
  assert.equal(events.length, 0);
  mode('unavailable');
  assert.equal((await setup(token, 'synthetic-disabled-robot')).status, 200);
  assert.equal(new Store(store.file).tokens.has(token._id), false);
}));
