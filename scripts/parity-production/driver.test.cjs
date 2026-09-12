'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { spawnSync } = require('node:child_process');
const { mkdtempSync, rmSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const driver = require('./driver.cjs');

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

test('late effects carrying a completed trace ID are captured outside cases after the drain', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'parity-driver-late-effect-'));
  const out = path.join(directory, 'capture.json');
  let parser;
  let firstTraceID;
  let parserRequestCount = 0;
  const suite = {
    id: 'late-effect-driver-test',
    profile: 'late-effect-driver-test',
    effectDrainMs: 0,
    requestTimeoutMs: 1_000,
    caseTimeoutMs: 1_000,
    providers: {},
    contexts: { empty: { runtime: {} } },
    cases: [
      { id: 'completed-case', context: 'empty', clock: '2018-05-30T12:00:00Z', seed: 1, parserData: { text: 'first' } },
      { id: 'active-case', context: 'empty', clock: '2018-05-30T12:00:00Z', seed: 2, parserData: { text: 'second' } },
    ],
  };
  const adapter = {
    name: 'late-effect-driver-test',
    moduleFile: __filename,
    async start({ peerURL }) {
      const peer = new URL(peerURL);
      const sendLateEffect = () => new Promise((resolve, reject) => {
        const request = http.request({
          host: peer.hostname,
          port: peer.port,
          method: 'POST',
          path: '/v1/late-effect',
          headers: {
            'content-type': 'text/plain',
            'content-length': 4,
            'x-jibo-transid': firstTraceID,
          },
        }, (response) => {
          response.resume();
          response.once('end', resolve);
        });
        request.once('error', reject);
        request.end('late');
      });
      parser = http.createServer(async (request, response) => {
        parserRequestCount += 1;
        if (parserRequestCount === 1) firstTraceID = request.headers['x-jibo-transid'];
        if (parserRequestCount === 2) await sendLateEffect();
        response.end('{}');
      });
      await new Promise((resolve) => parser.listen(0, '127.0.0.1', resolve));
      return {
        metadata: {},
        parserPort: parser.address().port,
        async close() {
          await new Promise((resolve, reject) => parser.close((error) => error ? reject(error) : resolve()));
        },
      };
    },
  };
  try {
    const report = await driver.run(adapter, suite, out);
    assert.equal(report.captureComplete, true);
    assert.deepEqual(report.cases.map((entry) => entry.effects), [[], []]);
    assert.equal(report.lateEffects.length, 1);
    assert.equal(report.lateEffects[0].headers['x-jibo-transid'], 'completed-case');
    assert.equal(report.lateEffects[0].attribution, 'late-effect');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
