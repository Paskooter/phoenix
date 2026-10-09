// Synthetic peer fixtures; no external requests are made.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SettingsClient } from '../src/settingsClient.js';
import { HistoryClient } from '../src/historyClient.js';
import { ParserClient } from '../src/parserClient.js';
import { SkillClient } from '../src/skillClient.js';

const log = { warn() {} };
const input = { context: { general: {}, runtime: {}, skill: { id: 'synthetic', session: {} } }, nlu: {}, asr: {} };
const manager = { get: () => ({ URL: 'http://synthetic.invalid/v1/main' }) };
const operations = [
  ['settings', (options, signal) => new SettingsClient('http://synthetic.invalid', options).getSettings('synthetic-account', 'synthetic-loop', 'synthetic-turn', ['synthetic'], log, { signal })],
  ['parser', (options, signal) => new ParserClient('http://synthetic.invalid', options).handleNLU({ text: 'synthetic', rules: [] }, {}, { signal })],
  ['skill launch', (options, signal) => new SkillClient(manager, options).launch('synthetic', input, {}, { signal })],
  ['skill update', (options, signal) => new SkillClient(manager, options).launchOrUpdate('synthetic', input, {}, true, { signal })],
  ['proactive skill', (options, signal) => new SkillClient(manager, options).proactiveLaunch('synthetic', input, {}, { signal })],
  ['history count', (options, signal) => new HistoryClient('http://synthetic.invalid', options).getSkillLaunchCount({}, {}, { signal })],
  ['history latest', (options, signal) => new HistoryClient('http://synthetic.invalid', options).getLatestSkillLaunch({}, {}, { signal })],
  ['history launch', (options, signal) => new HistoryClient('http://synthetic.invalid', options).writeSkillLaunch({}, {}, { signal })],
  ['history speech create', (options, signal) => new HistoryClient('http://synthetic.invalid', options).saveSpeechRecord({ data: {} }, {}, { signal })],
  ['history speech update', (options, signal) => new HistoryClient('http://synthetic.invalid', options).saveSpeechRecord({ id: 'synthetic', data: {} }, {}, { signal })],
];

for (const [name, run] of operations) {
  test(`${name} peer request installs a finite deadline and honors parent cancellation`, async (t) => {
    const original = globalThis.fetch;
    t.after(() => { globalThis.fetch = original; });
    const keepAlive = setTimeout(() => {}, 1000);
    t.after(() => clearTimeout(keepAlive));
    const signals = [];
    globalThis.fetch = (_url, options) => {
      signals.push(options.signal);
      if (!options.signal) return Promise.reject(new Error('missing bounded signal'));
      return new Promise((_resolve, reject) => {
        if (options.signal.aborted) reject(options.signal.reason);
        else options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      });
    };
    await run({ timeoutMs: 10 }).catch(() => {});
    assert.ok(signals[0] instanceof AbortSignal, 'deadline must be installed even without a parent');
    assert.equal(signals[0].aborted, true, 'deadline actually expires');
    const controller = new AbortController();
    const operation = run({ timeoutMs: 500 }, controller.signal).catch(() => {});
    controller.abort(new Error('synthetic cancellation'));
    await operation;
    assert.equal(signals[1].aborted, true);
    assert.equal(signals[1].reason, controller.signal.reason);
  });
}
