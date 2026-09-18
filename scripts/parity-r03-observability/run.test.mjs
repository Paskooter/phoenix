import test from 'node:test';
import assert from 'node:assert/strict';
import { runProbe } from './run.mjs';

test('R-03 observability lane measures trace, logging, health and config behavior', async () => {
  const report = await runProbe();
  assert.equal(report.acceptance, 'measured-gap');
  assert.equal(report.tracePropagation.calls.length, 3);
  assert.equal(report.tracePropagation.propagatedVerbatim, true);
  assert.deepEqual(report.logging.alwaysFields, ['t', 'level', 'ns', 'msg']);
  assert.equal(report.healthcheck.baseline.status, 200);
  assert.equal(report.healthcheck.storeOperationAfterFault.status, 500);
  assert.equal(report.healthcheck.afterFault.status, 200);
  assert.equal(report.healthcheck.falselyHealthy, true);
  assert.equal(report.configuration.llm.timeoutMs, 10000);
  assert.ok(report.configuration.ports.malformedEtcoIsNaN);
  assert.equal(report.serviceHealthSourceInventory.length, 8);
  assert.ok(report.serviceHealthSourceInventory.every((row) => !row.suppliesHealthcheckOverride));
});
