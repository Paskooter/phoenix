import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mediateDecision } from '../src/decisionMediator.js';
import { ListenTransaction } from '../src/listenTransaction.js';
import { IntentRouter } from '../src/intentRouter.js';
import { SkillConfigManager } from '../src/skillClient.js';

const original = JSON.parse(readFileSync(new URL('./fixtures/decision-mediator-original.json', import.meta.url)));

test('release mediation matches original Node 8 controls without mutating inputs', () => {
  for (const control of original.cases) {
    const before = structuredClone(control);
    let actual;
    try {
      const decision = mediateDecision(control.decision, control.asr, control.nlu, control.release);
      actual = decision === undefined ? { kind: 'unchanged' } : { kind: 'altered', decision };
    } catch (error) { actual = { kind: 'error', name: error.name }; }
    assert.deepEqual(actual, control.expected, control.id);
    assert.deepEqual(control, before, `${control.id}: input data must survive mediation`);
  }
});

const reportIntents = ['launchPersonalReport', 'requestWeatherPR', 'requestCommute', 'requestCalendar', 'requestNews', 'unlistedReportIntent'];
const registry = [
  { id: 'report-skill', URL: 'http://fixture.invalid/report', intents: reportIntents.map(name => ({ name, memo: 'original-report-memo' })) },
  ...['chitchat-skill', 'answer', 'news'].map(id => ({ id, URL: `http://fixture.invalid/${id}`, intents: [] })),
];

async function turn({ intent = 'requestNews', release = '1.8.0', omitRelease = false, hotphrase = true, activeSkill = null, rules = ['launch'] } = {}) {
  const frames = [], requests = [];
  const manager = new SkillConfigManager(structuredClone(registry));
  const auth = { id: 'fixture-account', friendlyId: 'fixture-robot' };
  const context = { type: 'CONTEXT', data: {
    general: { ...(omitRelease ? {} : { release }) },
    runtime: { loop: { users: [] }, dialog: {} },
    skill: activeSkill || { id: null },
  } };
  const transaction = new ListenTransaction({ _auth: auth, _remoteAddress: 'fixture-address' }, {
    intentRouter: new IntentRouter(manager), skillConfigManager: manager,
    config: { recordLaunchHistory: false },
    skillClient: { async launchOrUpdate(skillID, input, trace, update) {
      requests.push(structuredClone({ skillID, input, update }));
      return { skillID, response: { type: 'SKILL_ACTION', data: { skill: { id: skillID, session: { id: 'fixture-session' } } } } };
    } },
  }, { write: frame => frames.push(structuredClone(frame)) }, { info() {}, warn() {} });
  const completion = transaction.done.then(() => ({ kind: 'success' }), error => ({ kind: 'error', name: error.name }));
  transaction.handleMessage({ json: { type: 'LISTEN', data: { mode: 'CLIENT_NLU', rules, hotphrase } } });
  transaction.handleMessage({ json: { type: 'CLIENT_NLU', data: { intent, rules, entities: { retained: 'entity' } } } });
  transaction.handleMessage({ json: context });
  return { result: await completion, frames, requests, context };
}

test('older report decisions reach the selected launch with the source memo and original NLU', { timeout: 5000 }, async () => {
  for (const intent of reportIntents) {
    const expected = original.cases.find(control => control.release === '1.8.0' && control.nlu.intent === intent).expected.decision;
    const out = await turn({ intent });
    assert.deepEqual(out.result, { kind: 'success' });
    assert.deepEqual(out.frames.map(frame => frame.type), ['SOS', 'EOS', 'LISTEN', 'SKILL_ACTION']);
    assert.deepEqual(out.frames[2].data.match, { skillID: expected.skillID, launch: true, onRobot: false });
    assert.equal(out.frames[2].final, false);
    assert.equal(out.frames[3].final, true);
    assert.equal(out.requests.length, 1);
    const launch = out.requests[0];
    assert.equal(launch.skillID, expected.skillID);
    assert.deepEqual(launch.input.memo, expected.memo ?? null);
    assert.deepEqual(launch.input.nlu, out.frames[2].data.nlu);
    assert.equal(launch.input.nlu.intent, intent);
    assert.deepEqual(launch.input.nlu.entities, { retained: 'entity' });
    assert.equal(launch.input.context.general.release, '1.8.0');
    assert.equal(launch.update, false);
  }
});

test('known-missing and new releases retain report launches; omitted release uses the source 1.8 default', { timeout: 5000 }, async () => {
  for (const release of ['1.9.0', '1.9.0-RC2', '2.0.1', 'RELEASE_NOT_FOUND']) {
    const out = await turn({ release });
    assert.deepEqual(out.result, { kind: 'success' });
    assert.equal(out.requests[0].skillID, 'report-skill');
    assert.equal(out.requests[0].input.memo, 'original-report-memo');
    assert.equal(out.requests[0].input.context.general.release, release);
  }
  const omitted = await turn({ omitRelease: true });
  assert.equal(omitted.requests[0].skillID, 'news');
  assert.equal(omitted.requests[0].input.context.general.release, '1.8.0');
});

test('mediation does not replace a continued report session or a no-match result', { timeout: 5000 }, async () => {
  const skill = { id: 'report-skill', session: { id: 'existing-session', retained: 'state' } };
  const update = await turn({ intent: 'followup', hotphrase: false, activeSkill: skill });
  assert.deepEqual(update.result, { kind: 'success' });
  assert.equal(update.requests[0].skillID, 'report-skill');
  assert.equal(update.requests[0].update, true);
  assert.deepEqual(update.requests[0].input.context.skill, skill);
  const noMatch = await turn({ intent: 'followup', hotphrase: true, activeSkill: skill });
  assert.equal(noMatch.requests.length, 0);
  assert.equal(noMatch.frames.at(-1).type, 'LISTEN');
  assert.equal(noMatch.frames.at(-1).data.match, null);
  assert.equal(noMatch.frames.at(-1).final, true);
});

test('invalid releases reject a matched launch before contacting any skill', { timeout: 5000 }, async () => {
  for (const release of ['invalid', '01.8.0', true, 18, {}]) {
    const out = await turn({ release });
    assert.deepEqual(out.result, { kind: 'error', name: 'TypeError' });
    assert.equal(out.requests.length, 0);
    assert.deepEqual(out.frames.map(frame => frame.type), ['SOS', 'EOS']);
  }
});
