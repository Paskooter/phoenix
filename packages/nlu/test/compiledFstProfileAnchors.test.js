// The compiled-FST profile pins the rule inventory three times: the approval
// file, the snapshot hash anchor, and the anchor's own byte hash in
// compiledFstProfile.js. A change to rule-inventory.json (for example a word
// list repair) must move all of them together, or the snapshot profile rejects
// its own trusted anchor at selection time. These checks need no provisioned
// graphs, so they run in every checkout.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { COMPILED_FST_PROFILE } from '../src/compiledFstProfile.js';

const resource = name => readFileSync(new URL(`../resources/${name}`, import.meta.url));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

test('the approval, snapshot anchor and profile pin the current rule inventory', () => {
  const inventorySha256 = sha256(resource('rule-inventory.json'));
  const approval = JSON.parse(resource('compiled-fst-approval.json'));
  const anchor = JSON.parse(resource('compiled-fst-snapshot-hashes.json'));
  assert.equal(approval.inventorySha256, inventorySha256, 'compiled-fst-approval.json');
  assert.equal(COMPILED_FST_PROFILE.approvedInventorySha256, inventorySha256, 'profile approval');
  assert.equal(anchor.profile.approvedInventorySha256, inventorySha256, 'anchor profile');
  assert.equal(anchor.inventory.sha256, inventorySha256, 'anchor inventory');
});

test('the profile pins the exact snapshot anchor bytes', () => {
  assert.equal(COMPILED_FST_PROFILE.decodedHashAnchorSha256, sha256(resource('compiled-fst-snapshot-hashes.json')));
});
