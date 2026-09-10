import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAccountService } from '../src/index.js';
import { createOwnerAccount, createLoop } from '../src/model.js';
import { Store } from '../src/store.js';

const REPORT = 'report-skill';
const OTHER = 'answer-skill';

async function amz(base, op, body, accountId, prefix = 'Settings_20171219') {
  const res = await fetch(`${base}/`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-amz-json-1.1',
      'x-amz-target': `${prefix}.${op}`,
      ...(accountId ? { 'x-amz-credentials': JSON.stringify({ id: accountId }) } : {}),
    },
    body: JSON.stringify(body || {}),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

// Controller-derived non-report fixture: a second skill whose view carries
// person/loop/lasso nodes, plus a defaulted key absent from stored data.
const otherView = {
  type: 'group',
  childViews: [
    { type: 'switch', valueDefinition: { target: 'person', key: 'answerVoice', default: true } },
    { type: 'switch', valueDefinition: { target: 'loop', key: 'answerLoopFlag' } },
    {
      type: 'oauth',
      valueDefinition: { target: 'lasso', key: 'answer:calendar:readonly' },
      oauthParams: { serviceName: 'answer', serviceAccountName: 'calendar', scopes: ['read'] },
    },
  ],
};

function seed(store) {
  const owner = createOwnerAccount(store, { email: 'a06-owner@x.test', password: 'pw-owner' });
  const member = createOwnerAccount(store, { email: 'a06-member@x.test', password: 'pw-member' });
  const outsider = createOwnerAccount(store, { email: 'a06-outsider@x.test', password: 'pw-out' });
  const { loop } = createLoop(store, { owner, robotId: 'a06-robot' });
  store.loops.get(loop._id).members.push({ accountId: member._id, status: 'ACCEPTED' });
  store.flush();
  return { owner, member, outsider, loop };
}

test('A-06 runtime: all four Settings operations are served with the report and proactive variants', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'phx-a06-compat-'));
  try {
    const store = new Store(join(dir, 'store.json'));
    const { owner, loop } = seed(store);
    const server = await createAccountService({ store }).listen(0);
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      // GetSettings — report-skill variant: string selector, getView:false.
      const report = await amz(base, 'GetSettings',
        { loopId: loop._id, transId: 't-report', skills: REPORT, getView: false }, owner._id,
        'Settings_20160801');
      assert.equal(report.status, 200);
      assert.deepEqual(report.body.map((s) => s.skillId), [REPORT]);
      assert.equal(Object.prototype.hasOwnProperty.call(report.body[0], 'view'), false);
      assert.equal(report.body[0].data.weatherEnabled.value, 1);
      assert.equal(report.body[0].data.newsEnabled.value, 1);
      assert.equal(report.body[0].data.commuteEnabled.value, 0);

      // GetSettings — proactive/hub variant: array selector, getView:false, default view on when omitted.
      const hub = await amz(base, 'GetSettings',
        { loopId: loop._id, transId: 't-hub', skills: [REPORT, OTHER], getView: false }, owner._id);
      assert.equal(hub.status, 200);
      assert.deepEqual(hub.body.map((s) => s.skillId), [REPORT]);
      const defaultView = await amz(base, 'GetSettings', { loopId: loop._id, transId: 't-view' }, owner._id);
      assert.equal(defaultView.status, 200);
      assert.equal(defaultView.body[0].view.type, 'group');
      assert.ok(Array.isArray(defaultView.body[0].view.childViews), 'getView defaults to true');

      // GetDataForSettings — controller-derived non-report skill, default key + view schema.
      const explicitView = await amz(base, 'GetDataForSettings',
        { loopId: loop._id, transId: 't-data', settings: [{ skillId: OTHER, view: otherView }] }, owner._id);
      assert.equal(explicitView.status, 200);
      assert.deepEqual(explicitView.body, [{
        skillId: OTHER,
        view: otherView,
        data: { answerVoice: { value: true }, 'answer:calendar:readonly': { credentialExists: false } },
      }]);
      const explicitNoView = await amz(base, 'GetDataForSettings',
        { loopId: loop._id, transId: 't-data2', settings: [{ skillId: OTHER, view: otherView }], getView: false }, owner._id);
      assert.deepEqual(explicitNoView.body, [{
        skillId: OTHER,
        data: { answerVoice: { value: true }, 'answer:calendar:readonly': { credentialExists: false } },
      }]);

      // UpdateSettings — partial write through the deployed robot face.
      const update = await amz(base, 'UpdateSettings',
        { loopId: loop._id, data: { weatherEnabled: { value: 0 }, newsEnabled: { value: 1 } } }, owner._id);
      assert.equal(update.status, 200);
      const afterUpdate = await amz(base, 'GetSettings',
        { loopId: loop._id, skills: REPORT, getView: false }, owner._id);
      assert.equal(afterUpdate.body[0].data.weatherEnabled.value, 0);
      assert.equal(afterUpdate.body[0].data.newsEnabled.value, 1);

      // DeleteSettings — removes the stored record; reads fall back to defaults.
      const del = await amz(base, 'DeleteSettings', { loopId: loop._id, data: {} }, owner._id);
      assert.equal(del.status, 200);
      const afterDelete = await amz(base, 'GetSettings',
        { loopId: loop._id, skills: REPORT, getView: false }, owner._id);
      assert.equal(afterDelete.body[0].data.weatherEnabled.value, 1, 'delete resets to default');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('A-06 runtime: per-account/loop ownership and malformed/unknown settings', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'phx-a06-owner-'));
  try {
    const store = new Store(join(dir, 'store.json'));
    const { owner, member, outsider, loop } = seed(store);
    const server = await createAccountService({ store }).listen(0);
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      await amz(base, 'UpdateSettings', { loopId: loop._id, data: { weatherEnabled: { value: 0 }, newsEnabled: { value: 1 } } }, owner._id);
      await amz(base, 'UpdateSettings', { loopId: loop._id, data: { weatherEnabled: { value: 0 }, newsEnabled: { value: 0 } } }, member._id);
      const readOwner = await amz(base, 'GetSettings', { loopId: loop._id, skills: REPORT, getView: false }, owner._id);
      const readMember = await amz(base, 'GetSettings', { loopId: loop._id, skills: REPORT, getView: false }, member._id);
      assert.deepEqual(readOwner.body[0].data.newsEnabled, { value: 1 }, 'owner keeps own settings');
      assert.deepEqual(readMember.body[0].data.newsEnabled, { value: 0 }, 'member keeps own settings');

      const denied = await amz(base, 'GetSettings', { loopId: loop._id }, outsider._id);
      assert.equal(denied.status, 403);
      assert.deepEqual(denied.body, {
        statusCode: 403, error: 'Forbidden',
        message: 'Only loop member can query loop properties', code: 'LOOP_MEMBER_ONLY',
      });

      const unknownSkill = await amz(base, 'GetSettings', { loopId: loop._id, skills: ['nope'] }, owner._id);
      assert.deepEqual(unknownSkill.body, []);

      const unknownService = await amz(base, 'GetDataForSettings', {
        loopId: loop._id,
        settings: [{ skillId: REPORT, view: { type: 'switch', valueDefinition: { target: 'robot', key: 'x' } } }],
      }, owner._id);
      assert.equal(unknownService.status, 422);
      assert.equal(unknownService.body.code, 'UNKNOWN_DATA_SERVICE');
      assert.equal(unknownService.body.message, 'Unknown data service: robot');

      const malformedView = await amz(base, 'GetDataForSettings', {
        loopId: loop._id,
        settings: [{ skillId: REPORT, view: { type: 'group', childViews: null } }],
      }, owner._id);
      assert.deepEqual(malformedView, {
        status: 500,
        body: { message: 'An internal server error occurred', statusCode: 500, error: 'Internal Server Error' },
      });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('A-06 durability: persisted settings survive a real service restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'phx-a06-restart-'));
  try {
    const file = join(dir, 'store.json');
    const first = new Store(file);
    const { owner, loop } = seed(first);
    let server = await createAccountService({ store: first }).listen(0);
    let base = `http://127.0.0.1:${server.address().port}`;
    await amz(base, 'UpdateSettings', { loopId: loop._id, data: { weatherEnabled: { value: 0 }, newsEnabled: { value: 1 }, homeLocation: { lat: 42.36, lng: -71.06 } } }, owner._id);
    await new Promise((resolve) => server.close(resolve));

    // A fresh process-equivalent: new Store reads the same file, new service instance.
    const reopened = new Store(file);
    assert.deepEqual(reopened.settings.get(owner._id).data.weatherEnabled, { value: 0 });
    server = await createAccountService({ store: reopened }).listen(0);
    base = `http://127.0.0.1:${server.address().port}`;
    try {
      const after = await amz(base, 'GetSettings', { loopId: loop._id, skills: REPORT, getView: false }, owner._id);
      assert.equal(after.status, 200);
      assert.deepEqual(after.body[0].data.weatherEnabled, { value: 0 });
      assert.deepEqual(after.body[0].data.newsEnabled, { value: 1 });
      assert.deepEqual(after.body[0].data.homeLocation, { lat: 42.36, lng: -71.06 });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
