#!/usr/bin/env node

// Fail-closed comparator for the compact S-07 follow-up receipt.  It checks
// the fields that define a launch/update transaction before comparing source
// and candidate values, so equal omissions cannot pass.

import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';

const dir = path.resolve(process.argv[2] || '.');
const read = (name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
const spec = read('matrix-spec.json');
const source = read('source-runtime.json');
const candidate = read('candidate-runtime.json');
const inventory = read('inventory.json');
const errors = [];
const stable = (value) => JSON.stringify(value);
const scriptDir = path.dirname(new URL(import.meta.url).pathname);
const fileSha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const expectedIds = ['scripted-announcement', 'emotion-query-announcement', 'semispecific-announcement', 'fallback-deflection'];
const sourceTreeDigest = '928b8c1a714a54ea0df46af02cef989ce0a4706c4d486bc6d849a9bd3bd25190';
const sourceIdDigest = '81a89fe41266295232e4bfdd0abd287b3d4a5efd1c1fcfff373a4a3251c5eb9b';

function required(object, keys, label) {
  if (!object || typeof object !== 'object') { errors.push(`${label} must be an object`); return; }
  for (const key of keys) if (!Object.prototype.hasOwnProperty.call(object, key)) errors.push(`${label} missing ${key}`);
}

function validateInventory() {
  if (inventory.schemaVersion !== 1) errors.push('inventory schemaVersion');
  if (inventory.runnerSha256 !== fileSha256(path.join(scriptDir, 'inventory.mjs'))) errors.push('inventory runnerSha256');
  if (inventory.sourceRevision !== spec.referenceRevision || inventory.sourceRevision !== '5c0a7390539663ba749d360de348a428c088505c') errors.push('inventory sourceRevision');
  if (inventory.allAnnouncement !== true) errors.push('inventory allAnnouncement is not true');
  if (inventory.sameTree !== true) errors.push('inventory sameTree is not true');
  for (const side of ['source', 'candidate']) {
    const value = inventory[side];
    if (!value) { errors.push(`inventory.${side} missing`); continue; }
    if (value.files !== 4424) errors.push(`inventory.${side}.files ${value.files} != 4424`);
    if (value.malformed !== 0) errors.push(`inventory.${side}.malformed ${value.malformed} != 0`);
    if (value.prompts !== 11883) errors.push(`inventory.${side}.prompts ${value.prompts} != 11883`);
    if (value.treeDigest !== sourceTreeDigest || value.idDigest !== sourceIdDigest) errors.push(`inventory.${side}.digest mismatch`);
    if (stable(value.byDirectory) !== stable({ 'core-responses': 1, 'emotion-responses': 54, 'scripted-responses': 4369 })) errors.push(`inventory.${side}.byDirectory mismatch`);
    if (stable(value.types) !== stable({ announcement: 4424 })) errors.push(`inventory.${side}.types mismatch`);
  }
}

function validateAction(response, label, expectAction) {
  const action = response.action;
  if (expectAction) {
    if (!action || action.type !== 'JCP') errors.push(`${label}.action must be JCP`);
    required(action && action.config, ['version', 'jcp'], `${label}.action.config`);
    if (action && action.config && action.config.version !== '2.0') errors.push(`${label}.action.config.version`);
    const jcp = action && action.config && action.config.jcp;
    required(jcp, ['id', 'type', 'config'], `${label}.action.config.jcp`);
    const play = jcp && jcp.config && jcp.config.play;
    required(jcp && jcp.config, ['play'], `${label}.action.config.jcp.config`);
    required(play, ['esml', 'meta'], `${label}.action.config.jcp.config.play`);
    required(play && play.meta, ['mim_id', 'mim_type', 'prompt_id', 'prompt_sub_category'], `${label}.play.meta`);
    if (response.actionDetails.present !== true) errors.push(`${label}.actionDetails.present`);
    if (response.actionDetails.jcp === null) errors.push(`${label}.actionDetails.jcp`);
    if (response.actionDetails.slims.length !== 1) errors.push(`${label}.actionDetails.slims cardinality`);
    const slim = response.actionDetails.slims[0];
    if (slim && (slim.play !== true || slim.listen !== false || slim.display !== false)) errors.push(`${label}.actionDetails effect keys`);
    if (response.effects.length !== 1 || response.effects[0].listen !== false || response.effects[0].display !== false || response.effects[0].play !== true) errors.push(`${label}.effects`);
    if (response.mim.length !== 1 || response.mim[0].mimType !== 'announcement') errors.push(`${label}.mim`);
  } else {
    if (action !== null) errors.push(`${label}.action must be null`);
    if (response.actionDetails.present !== false || response.actionDetails.jcp !== null || response.actionDetails.slims.length !== 0) errors.push(`${label}.actionDetails terminal shape`);
    if (response.mim.length !== 0 || response.effects.length !== 0) errors.push(`${label}.terminal effects`);
  }
}

function validateResponse(row, turn, descriptor) {
  const label = `${row.id}.${turn}`;
  const response = row[turn];
  required(response, ['turn', 'responseType', 'final', 'fireAndForget', 'session', 'trace', 'transitions', 'action', 'actionDetails', 'mim', 'jcp', 'analytics', 'effects'], label);
  if (!response || response.turn !== turn) { errors.push(`${label}.turn`); return; }
  if (response.responseType !== 'SKILL_ACTION') errors.push(`${label}.responseType`);
  if (response.final !== true) errors.push(`${label}.final`);
  if (response.fireAndForget !== (turn === 'update')) errors.push(`${label}.fireAndForget`);
  if (!response.session || response.session.id !== '<generated-id>' || typeof response.session.nodeID !== 'number') errors.push(`${label}.session identity`);
  if (!Array.isArray(response.trace) || !Array.isArray(response.transitions) || response.trace.length !== response.transitions.length) errors.push(`${label}.trace`);
  if (!response.session || stable(response.session.trace) !== stable(response.trace)) errors.push(`${label}.session.trace mismatch`);
  if (!response.session || !response.session.data || !response.session.data._mim) errors.push(`${label}.session.data._mim`);
  if (!response.analytics || typeof response.analytics !== 'object') errors.push(`${label}.analytics`);
  if (turn === 'launch' && (!response.analytics['chitchat-skill'] || !Array.isArray(response.analytics['chitchat-skill']))) errors.push(`${label}.analytics.chitchat-skill`);
  if (turn === 'update' && Object.keys(response.analytics || {}).length !== 0) errors.push(`${label}.update analytics should be empty`);
  if (turn === 'launch') {
    if (response.transitions[1] !== descriptor.expectedTransition) errors.push(`${label}.expected transition`);
    if (response.mim[0] && response.mim[0].mim !== descriptor.expectedMim) errors.push(`${label}.expected MIM`);
    const events = response.analytics['chitchat-skill'] || [];
    const query = events.find((event) => event.event === 'Chitchat Query');
    if (descriptor.expectedQueryType === null && query) errors.push(`${label}.unexpected query analytics`);
    if (descriptor.expectedQueryType !== null && (!query || query.properties.type !== descriptor.expectedQueryType)) errors.push(`${label}.expected query analytics`);
    if (descriptor.class === 'fallback/deflection' && query && query.properties.success !== false) errors.push(`${label}.fallback analytics success`);
  }
  validateAction(response, label, turn === 'launch');
}

function validateReceipt(receipt, mode) {
  if (receipt.schemaVersion !== 1 || receipt.mode !== mode) errors.push(`${mode} envelope`);
  if (mode === 'source') {
    if (receipt.sourceRevision !== spec.referenceRevision) errors.push('source revision');
    if (receipt.runtime !== 'v8.9.4') errors.push(`source runtime ${receipt.runtime}`);
    if (receipt.image !== 'node@sha256:8233daae003ba0ecba4e6d70cab8525c30a3f085935afc624a275892ebe23f7c') errors.push('source image');
    if (stable(receipt.sourceTables) !== stable({ scripted: 4369, emotion: 54, fallback: 1, categories: 66 })) errors.push('source tables');
  } else {
    if (!/^[0-9a-f]{40}$/.test(receipt.candidateRevision || '')) errors.push('candidate revision');
    if (!/^v2[0-9]\./.test(receipt.runtime || '')) errors.push(`candidate runtime ${receipt.runtime}`);
  }
  const runnerName = mode === 'source' ? 'run-source.cjs' : 'run-candidate.mjs';
  const expectedRunnerSha256 = fileSha256(path.join(scriptDir, runnerName));
  if (receipt.runnerSha256 !== expectedRunnerSha256) errors.push(`${mode} runnerSha256`);
  if (!Array.isArray(receipt.rows) || receipt.rows.length !== spec.cases.length) { errors.push(`${mode}.rows cardinality`); return new Map(); }
  const expected = new Set(expectedIds);
  const map = new Map();
  for (const row of receipt.rows) {
    if (!row || !expected.has(row.id) || map.has(row.id)) errors.push(`${mode} row identity ${row && row.id}`);
    else map.set(row.id, row);
    const descriptor = spec.cases.find((item) => item.id === (row && row.id));
    if (row && (!descriptor || row.class !== descriptor.class)) errors.push(`${mode}.${row && row.id} class`);
    if (row) {
      required(row, ['launch', 'launchError', 'update', 'updateError', 'randomCalls', 'randomState'], `${mode}.${row.id}`);
      if (row.launchError !== null || row.updateError !== null) errors.push(`${mode}.${row.id} unexpected error`);
      validateResponse(row, 'launch', descriptor);
      validateResponse(row, 'update', descriptor);
    }
  }
  for (const id of expected) if (!map.has(id)) errors.push(`${mode} missing ${id}`);
  return map;
}

validateInventory();
if (spec.schemaVersion !== 1 || spec.referenceRevision !== '5c0a7390539663ba749d360de348a428c088505c') errors.push('spec envelope');
if (spec.cases.length !== expectedIds.length || stable(spec.cases.map((item) => item.id)) !== stable(expectedIds)) errors.push('spec IDs');
const sourceRows = validateReceipt(source, 'source');
const candidateRows = validateReceipt(candidate, 'candidate');
const differences = [];
for (const descriptor of spec.cases) {
  const s = sourceRows.get(descriptor.id);
  const c = candidateRows.get(descriptor.id);
  if (!s || !c) continue;
  const sourceValue = { launch: s.launch, launchError: s.launchError, update: s.update, updateError: s.updateError, randomCalls: s.randomCalls, randomState: s.randomState };
  const candidateValue = { launch: c.launch, launchError: c.launchError, update: c.update, updateError: c.updateError, randomCalls: c.randomCalls, randomState: c.randomState };
  if (stable(sourceValue) !== stable(candidateValue)) differences.push({ id: descriptor.id, source: sourceValue, candidate: candidateValue });
}
const result = { schemaVersion: 1, sourceRevision: source.sourceRevision, candidateRevision: candidate.candidateRevision, rows: spec.cases.length, differences, errors, result: errors.length || differences.length ? 'fail' : 'pass' };
fs.writeFileSync(path.join(dir, 'differential-receipt.json'), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({ result: result.result, rows: result.rows, differences: differences.length, errors: errors.length }));
if (result.result !== 'pass') process.exitCode = 1;
