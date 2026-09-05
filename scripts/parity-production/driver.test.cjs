'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

test('fixture RNG controls separate MIM VM contexts without replacing Math or consuming the service stream', () => {
  const program = `
    const driver = require(${JSON.stringify(path.join(__dirname, 'driver.cjs'))});
    const vm = require('vm');
    driver.installClock();
    const definition = { clock: '2018-05-30T12:00:00Z', seed: 1381830126 };
    function sample() {
      driver.selectCase(definition);
      const main = Math.random();
      const one = vm.createContext({}), two = vm.createContext({});
      const values = [vm.runInContext('Math.random()', one), vm.runInContext('Math.random()', two)];
      const next = Math.random();
      return { main, values, next, sqrt: vm.runInContext('Math.sqrt(81)', one), pi: vm.runInContext('Math.PI', one) };
    }
    const first = sample(), second = sample();
    driver.selectCase(definition);
    const unconsumed = [Math.random(), Math.random()];
    const custom = vm.runInContext('Math.random()', vm.createContext({ Math: { random: () => 0.125 } }));
    console.log(JSON.stringify({ first, second, unconsumed, custom }));
  `;
  const child = spawnSync(process.execPath, ['-e', program], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.deepEqual(result.first, result.second);
  assert.notEqual(result.first.values[0], result.first.values[1]);
  assert.deepEqual([result.first.main, result.first.next], result.unconsumed);
  assert.equal(result.first.sqrt, 9);
  assert.equal(result.first.pi, Math.PI);
  assert.equal(result.custom, 0.125);
});
