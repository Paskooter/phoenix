import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONTRACT_SERVICES,
  offsetPorts,
  percentiles,
  hermeticEnv,
  rebindFailureName,
} from './lib.mjs';

test('R-03 port map shifts every full-stack service without reference ports', () => {
  const ports = offsetPorts(700);
  assert.equal(CONTRACT_SERVICES.length, 13);
  assert.equal(ports.hub, 9700);
  assert.equal(ports.account, 9711);
  assert.equal(ports.classic, 9712);
  assert.equal(ports['example-skill'], 9713);
  assert.deepEqual(Object.keys(ports), CONTRACT_SERVICES);
});

test('R-03 percentile helper preserves raw samples and uses nearest rank', () => {
  const samples = [8, 2, 5, 3];
  assert.deepEqual(percentiles(samples), { n: 4, p50: 3, p95: 8, max: 8 });
  assert.deepEqual(samples, [8, 2, 5, 3]);
  assert.equal(percentiles([]), null);
});

test('R-03 child environment is hermetic and points stores into the run directory', () => {
  const env = hermeticEnv({
    home: '/tmp/r03-home',
    runDir: '/tmp/r03-run',
    offset: 700,
    ports: offsetPorts(700),
    llmUrl: 'http://127.0.0.1:32123/v1',
    tokenSecret: 'r03-test-secret',
  });
  assert.equal(env.PHOENIX_ENV_FILE, '/dev/null');
  assert.equal(env.PHOENIX_PORT_OFFSET, '700');
  assert.equal(env.ETCO_account_dataFile, '/tmp/r03-run/stores/account.json');
  assert.equal(env.ETCO_history_dataFile, '/tmp/r03-run/stores/history.json');
  assert.equal(env.LLM_URL, 'http://127.0.0.1:32123/v1');
  assert.equal(Object.hasOwn(env, 'PARAKEET_URL'), false);
  assert.equal(Object.hasOwn(env, 'ADMIN_PASSWORD'), false);
});

test('R-03 falsification names a bind collision instead of hiding it', () => {
  const error = Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' });
  assert.equal(rebindFailureName(error), 'EADDRINUSE');
  assert.equal(rebindFailureName(new Error('other failure')), 'REBIND_FAILED');
});
