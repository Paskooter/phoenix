import test from 'node:test';
import assert from 'node:assert/strict';
import { runProbe } from './run.mjs';

test('R-03 observability lane measures trace, logging, health and config behavior', async () => {
  const report = await runProbe();
  assert.equal(report.tracePropagation.calls.length, 3);
  assert.equal(report.tracePropagation.propagatedVerbatim, true);
  assert.deepEqual(report.logging.alwaysFields, ['t', 'level', 'ns', 'msg']);

  // The false-health check, after the I-01b repair: a broken store must be
  // reported as broken rather than as healthy. The fault here is real -- the
  // committed snapshot is replaced with unparseable bytes -- because a
  // store-level check cannot see a fault injected inside a store method on an
  // otherwise usable store.
  assert.equal(report.healthcheck.baseline.status, 200);
  assert.deepEqual(report.healthcheck.baseline.body, {
    status: 'ok', skillLaunchDB: 'CONNECTED', speechHistoryDB: 'CONNECTED',
  });
  assert.equal(report.healthcheck.afterFault.status, 500);
  assert.equal(report.healthcheck.afterFault.body.status, 'error');
  assert.equal(report.healthcheck.falselyHealthy, false, 'a store failure must not read as healthy');
  assert.equal(report.healthcheck.recoveredWithoutRestart, true, 'recovery must not be latched');

  assert.equal(report.configuration.llm.timeoutMs, 10000);
  assert.ok(report.configuration.ports.malformedEtcoIsNaN);
  assert.equal(report.serviceHealthSourceInventory.length, 8);
  // Exactly one service overrides the shared health response, as in the reference.
  assert.deepEqual(
    report.serviceHealthSourceInventory.filter((row) => row.suppliesHealthcheckOverride).map((row) => row.service),
    ['history'],
  );
});
