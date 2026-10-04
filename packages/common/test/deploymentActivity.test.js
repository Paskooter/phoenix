import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDeploymentActivity } from '../src/deploymentActivity.js';
import { readActivity } from '../../../scripts/deployment-quiescence.mjs';

test('activity spans completion, acknowledges a drain and resumes after lease expiry', t => {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'deployment-activity-'));
  t.after(() => rmSync(runtimeDir, { recursive: true, force: true }));
  let now = 10000;
  const hub = createDeploymentActivity('hub', { runtimeDir, now: () => now });
  const ota = createDeploymentActivity('ota', { runtimeDir, now: () => now });
  t.after(() => { hub.stop(); ota.stop(); });
  writeFileSync(join(runtimeDir, 'services.json'), JSON.stringify({ services: {
    hub: { pid: process.pid, state: 'running' }, ota: { pid: process.pid, state: 'running' },
  } }));
  const read = () => readActivity(runtimeDir, { now });
  const endVoice = hub.begin('voice');
  const endOta = ota.begin('ota-download');
  assert.equal(read().active, 2);
  now += 100;
  endVoice(); endVoice();
  assert.equal(read().active, 1, 'completion is idempotent');
  writeFileSync(join(runtimeDir, 'deployment', 'drain.json'), JSON.stringify({ version: 1, id: 'fixture', expiresAt: now + 15000 }));
  assert.equal(hub.begin('voice'), null);
  assert.equal(ota.begin('ota-upload'), null);
  endOta();
  assert.equal(read().active, 0);
  assert.equal(read().lastActivityAt, now);
  assert.equal(read().acknowledged[1], 'fixture');
  now += 15001;
  const resumed = hub.begin('voice');
  assert.equal(typeof resumed, 'function', 'a crashed deployer cannot leave admission blocked forever');
  resumed();
  assert.throws(read, /stale ota/, 'old idle snapshots cannot authorize deployment');
  const state = JSON.parse(readFileSync(join(runtimeDir, 'deployment', 'hub.json')));
  state.pid++;
  writeFileSync(join(runtimeDir, 'deployment', 'hub.json'), JSON.stringify(state));
  assert.throws(read, /stale hub/, 'a previous process snapshot cannot stand in for the running process');
});

test('unconfigured standalone services retain ordinary admission behavior', () => {
  const activity = createDeploymentActivity('hub', { runtimeDir: '' });
  activity.begin('voice')();
  activity.trackExisting('robot-action')();
  activity.stop();
});

test('observed existing execution remains counted during drain without admitting new work', t => {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'deployment-recovered-'));
  t.after(() => rmSync(runtimeDir, { recursive: true, force: true }));
  let now = 10000;
  const activity = createDeploymentActivity('hub', { runtimeDir, now: () => now });
  t.after(() => activity.stop());
  const state = () => JSON.parse(readFileSync(join(runtimeDir, 'deployment', 'hub.json')));
  writeFileSync(join(runtimeDir, 'deployment', 'drain.json'), JSON.stringify({ version: 1, id: 'recovered', expiresAt: now + 15000 }));
  assert.equal(activity.begin('voice'), null);
  const end = activity.trackExisting('robot-action');
  assert.equal(typeof end, 'function');
  assert.equal(state().active['robot-action'], 1);
  assert.equal(state().drainId, 'recovered');
  assert.equal(activity.begin('voice'), null, 'observing existing work does not weaken admission');
  now += 100;
  end(); end();
  assert.equal(state().active['robot-action'], 0);
  assert.equal(state().lastActivityAt, now);
  activity.stop();
  assert.equal(activity.trackExisting('robot-action'), null);
});

test('startup recovery counts existing work before this process publishes its first heartbeat', t => {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'deployment-startup-'));
  t.after(() => rmSync(runtimeDir, { recursive: true, force: true }));
  const file = join(runtimeDir, 'deployment', 'hub.json');
  let end;
  const activity = createDeploymentActivity('hub', { runtimeDir, onStartup: recovering => {
    assert.equal(existsSync(file), false);
    end = recovering.trackExisting('robot-action');
    assert.equal(existsSync(file), false, 'recovery cannot expose an intermediate fresh zero');
  } });
  t.after(() => activity.stop());
  assert.equal(JSON.parse(readFileSync(file)).active['robot-action'], 1);
  end();
  assert.equal(JSON.parse(readFileSync(file)).active['robot-action'], 0);
});
