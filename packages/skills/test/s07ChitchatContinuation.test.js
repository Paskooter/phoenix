// S-07 Chitchat continuation boundary. The receipt is deliberately checked as
// a complete four-row launch/update boundary: equal omissions must fail in the
// comparator and in this durable focused test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const evidence = path.join(repo, 'docs/parity/evidence/2026-09-13/s07-followup');
const read = (name) => JSON.parse(fs.readFileSync(path.join(evidence, name), 'utf8'));

const expectedIds = [
  'scripted-announcement',
  'emotion-query-announcement',
  'semispecific-announcement',
  'fallback-deflection',
];

function checkReceipt(receipt, spec, mode) {
  assert.equal(receipt.schemaVersion, 1);
  assert.equal(receipt.mode, mode);
  assert.equal(receipt.rows.length, expectedIds.length);
  const rows = new Map(receipt.rows.map((row) => [row.id, row]));
  assert.deepEqual([...rows.keys()], expectedIds);

  for (const descriptor of spec.cases) {
    const row = rows.get(descriptor.id);
    assert.ok(row, `${mode} row ${descriptor.id}`);
    assert.equal(row.class, descriptor.class);
    assert.equal(row.launchError, null);
    assert.equal(row.updateError, null);

    const launch = row.launch;
    assert.equal(launch.responseType, 'SKILL_ACTION');
    assert.equal(launch.final, true);
    assert.equal(launch.fireAndForget, false);
    assert.equal(launch.session.id, '<generated-id>');
    assert.deepEqual(launch.session.trace, launch.trace);
    assert.equal(launch.transitions[1], descriptor.expectedTransition);
    assert.equal(launch.mim.length, 1);
    assert.equal(launch.mim[0].mim, descriptor.expectedMim);
    assert.equal(launch.mim[0].mimType, 'announcement');
    assert.equal(launch.action.type, 'JCP');
    assert.equal(launch.action.config.version, '2.0');
    assert.equal(launch.action.config.jcp.type, 'SLIM');
    assert.deepEqual(launch.actionDetails.effectKeys, ['play']);
    assert.equal(launch.actionDetails.slims.length, 1);
    assert.equal(launch.actionDetails.slims[0].play, true);
    assert.equal(launch.actionDetails.slims[0].listen, false);
    assert.equal(launch.actionDetails.slims[0].display, false);
    assert.deepEqual(launch.effects, [{ listen: false, display: false, play: true }]);
    const query = (launch.analytics['chitchat-skill'] || []).find((event) => event.event === 'Chitchat Query');
    if (descriptor.expectedQueryType === null) assert.equal(query, undefined);
    else assert.equal(query.properties.type, descriptor.expectedQueryType);
    if (descriptor.class === 'fallback/deflection') assert.equal(query.properties.success, false);

    const update = row.update;
    assert.equal(update.responseType, 'SKILL_ACTION');
    assert.equal(update.final, true);
    assert.equal(update.fireAndForget, true);
    assert.equal(update.action, null);
    assert.deepEqual(update.actionDetails, { present: false, jcp: null, slims: [], effectKeys: [] });
    assert.deepEqual(update.mim, []);
    assert.deepEqual(update.effects, []);
    assert.deepEqual(update.analytics, {});
    assert.deepEqual(update.transitions.slice(-2), ['Success', 'Done']);
  }
}

test('S-07 Chitchat launch/update receipts preserve the no-follow-up boundary', () => {
  const spec = read('matrix-spec.json');
  const inventory = read('inventory.json');
  const differential = read('differential-receipt.json');
  const source = read('source-runtime.json');
  const candidate = read('candidate-runtime.json');

  assert.equal(spec.schemaVersion, 1);
  assert.equal(spec.referenceRevision, '5c0a7390539663ba749d360de348a428c088505c');
  assert.deepEqual(spec.cases.map((item) => item.id), expectedIds);
  assert.equal(inventory.allAnnouncement, true);
  assert.equal(inventory.sameTree, true);
  assert.equal(inventory.source.files, 4424);
  assert.equal(inventory.candidate.files, 4424);
  assert.equal(inventory.source.prompts, 11883);
  assert.equal(inventory.candidate.prompts, 11883);
  assert.equal(differential.result, 'pass');
  assert.deepEqual(differential.differences, []);
  assert.deepEqual(differential.errors, []);

  checkReceipt(source, spec, 'source');
  checkReceipt(candidate, spec, 'candidate');
  for (const id of expectedIds) {
    const sourceRow = source.rows.find((row) => row.id === id);
    const candidateRow = candidate.rows.find((row) => row.id === id);
    assert.deepEqual({ launch: sourceRow.launch, update: sourceRow.update }, { launch: candidateRow.launch, update: candidateRow.update });
  }
});
