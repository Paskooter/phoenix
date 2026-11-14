import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
// Reviewed test-only workflows: read token, hosted runners, no deployment,
// secrets, environments, privileged events or reusable-workflow delegation.
// Deliberately pin whole files, not a partial YAML/regex security parser.
// Workflow changes require owner review AND an explicit digest update.
const reviewed = {
  'home-assistant.yml': '8dfd323839bf7920094669368fa1f2d49008c7181d15cfd32f57226f9a8b9902',
  'parity.yml': '8fc66754e371847d8026095cc48874d2287715fc856f6df479b6eb2b95c36876',
  'robot-repoint.yml': '6a3961f910ed675ea325b8a96207707a48cb53b9e3fe9f1528dd8d489bada146',
};
const read = path => readFileSync(resolve(root, path), 'utf8');

test('CI contains exactly the reviewed test-only workflows', async t => {
  // Include every directory entry: hidden files, new extensions and directories
  // cannot silently expand the reviewed workflow surface.
  const names = readdirSync(resolve(root, '.github/workflows')).sort();
  assert.deepEqual(names, Object.keys(reviewed).sort(), 'new workflow needs owner review');
  for (const name of names) await t.test(name, () => {
    const digest = createHash('sha256').update(read(`.github/workflows/${name}`)).digest('hex');
    assert.equal(digest, reviewed[name], `${name}: workflow changed; review authority before updating its digest`);
  });
});

test('every checkout explicitly leaves no persisted GitHub credential', async t => {
  for (const name of Object.keys(reviewed)) await t.test(name, () => {
    const steps = read(`.github/workflows/${name}`).split(/(?=^      - )/m);
    const checkouts = steps.filter(step => /uses: actions\/checkout@/.test(step));
    assert.ok(checkouts.length, `${name}: expected checkout`);
    for (const step of checkouts) {
      assert.match(step, /persist-credentials: false/, `${name}: credential persists into contributor tests`);
    }
  });
});

test('contributors have a fork/PR route and an explicit owner-only release boundary', () => {
  assert.ok(existsSync(resolve(root, 'CONTRIBUTING.md')), 'missing contributor instructions');
  assert.ok(existsSync(resolve(root, '.github/pull_request_template.md')), 'missing PR checklist');
  const guide = read('CONTRIBUTING.md');
  for (const phrase of ['No collaborator role is needed', 'owner reviews and merges', 'CI is not deployment approval', 'Do not run an unreviewed PR on a release machine']) {
    assert.ok(guide.includes(phrase), `missing boundary: ${phrase}`);
  }
  for (const match of guide.matchAll(/\]\(([^)#]+)(?:#[^)]*)?\)/g)) {
    if (!/^https?:/.test(match[1])) assert.ok(existsSync(resolve(root, match[1])), `broken local link: ${match[1]}`);
  }
  const template = read('.github/pull_request_template.md');
  assert.match(template, /exact commit/i);
  assert.match(template, /No robot deployment/);
  assert.match(template, /source and permission/);
});
