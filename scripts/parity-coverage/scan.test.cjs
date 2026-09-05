'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const scanner = path.join(__dirname, 'scan.cjs');
const compiler = path.resolve(__dirname, '../../node_modules/typescript');
function scan(files) {
  const result = spawnSync(process.execPath, [scanner, compiler], { input: JSON.stringify(files), encoding: 'utf8' });
  assert.ok(result.stdout, result.stderr);
  return { code: result.status, ...JSON.parse(result.stdout) };
}

test('coverage discovery ignores comments and strings while retaining nested suites, skips and pending tests', () => {
  const result = scan([{ path: 'packages/hub/tests/example.test.ts', text: `
    // it('comment', () => {});
    const example = "it('string', () => {})";
    describe.skip('outer', () => {
      context('inner', () => {
        it('real', () => {});
        it('pending');
      });
    });
  ` }]);
  assert.equal(result.code, 0);
  assert.deepEqual(result.tests.map(t => t.title), ['real', 'pending']);
  assert.deepEqual(result.tests[0].suites, ['outer', 'inner']);
  assert.equal(result.tests[0].originalSkipped, true);
  assert.equal(result.tests[1].originalPending, true);
  assert.equal(result.tests[0].line, 6);
});

test('coverage discovery distinguishes loop/factory declarations from fixed registrations', () => {
  const result = scan([{ path: 'packages/hub/tests/example.test.ts', text: `
    describe('suite', () => {
      ['a', 'b'].forEach(name => { it(name, () => {}); });
      for (const name of ['c', 'd']) { it('loop', () => {}); }
      function register() { it('factory', () => {}); }
      it.only('fixed', () => {});
    });
  ` }]);
  assert.deepEqual(result.tests.map(t => t.multiplicity), ['dynamic-or-factory', 'dynamic-or-factory', 'dynamic-or-factory', 'single-declaration']);
  assert.equal(result.tests[3].originalOnly, true);
});

test('source registrations and wire contracts retain their source locations without counting production calls as tests', () => {
  const result = scan([
    { path: 'packages/hub/src/Service.ts', text: `it('ordinary function'); this.addGetHandler('/items', handle); this.router.head('/', handle);` },
    { path: 'packages/interfaces/src/messages.ts', text: `export namespace hub { export type MessageType = 'A' | 'B'; export interface Message { type: MessageType; } }` },
  ]);
  assert.equal(result.code, 0);
  assert.equal(result.tests.length, 0);
  assert.deepEqual(result.registrations.map(r => r.literalPath.text), ['/items', '/']);
  assert.deepEqual(result.contracts.map(c => c.name), ['hub.MessageType', 'hub.Message']);
});

test('unparseable source returns diagnostics and fails instead of silently disappearing from the denominator', () => {
  const result = scan([{ path: 'packages/hub/tests/broken.test.ts', text: `describe('broken', () => { it('case', ); }})` }]);
  assert.equal(result.code, 1);
  assert.ok(result.diagnostics.length > 0);
  assert.equal(result.diagnostics[0].path, 'packages/hub/tests/broken.test.ts');
});
