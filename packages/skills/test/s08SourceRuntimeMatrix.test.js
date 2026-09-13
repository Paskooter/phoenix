// S-08 source-runtime boundary controls. The pinned Pegasus MultiTurnNode reads
// result.nlu/result.asr directly; valid action results use null-valued fields,
// while an omitted result is a malformed continuation and must preserve the
// source field-access failure.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SkillRequestType } from '@phoenix/contracts';
import { createReportSkill, GraphManager } from '../src/index.js';

const runtime = {
  location: { iso: '2018-05-30T12:00:00.000Z' }, perception: {},
  loop: { loopId: 'loop-1', users: [] }, dialog: { referent: null },
};
const log = { debug() {}, info() {}, warn() {}, error() {}, createChild() { return this; } };
const context = { log, req: { jibo: { transID: 'transaction-1', toHeader() { return {}; } } } };
const launch = () => ({ type: SkillRequestType.LISTEN_LAUNCH, msgID: 's08', ts: 1, data: {
  general: { accountID: 'acct-1', robotID: 'robot-1' }, runtime, skill: { id: 'report-skill' },
  result: { nlu: { intent: 'launchPersonalReport', entities: {} }, asr: { text: '' }, memo: 'Reactive' },
} });
const noInput = () => ({ nlu: { intent: null, entities: null }, asr: { text: null } });
const update = (session, result, includeResult = true) => ({ type: SkillRequestType.LISTEN_UPDATE, msgID: 's08', ts: 2, data: {
  general: { accountID: 'acct-1', robotID: 'robot-1' }, runtime, skill: { id: 'report-skill', session },
  ...(includeResult ? { result } : {}),
} });

test('S-08 valid no-input continuation reaches source MaxNI terminal', async () => {
  const skill = createReportSkill({ graphManager: new GraphManager() });
  const first = await skill(launch(), context);
  assert.equal(first.data.final, false);
  const second = await skill(update(first.data.skill.session, noInput()), context);
  assert.equal(second.data.final, false);
  const terminal = await skill(update(second.data.skill.session, noInput()), context);
  assert.equal(terminal.data.action, null);
  assert.equal(terminal.data.final, true);
  assert.equal(terminal.data.fireAndForget, true);
});

test('S-08 malformed omitted result preserves source MultiTurnNode failure', async () => {
  const skill = createReportSkill({ graphManager: new GraphManager() });
  const first = await skill(launch(), context);
  const second = await skill(update(first.data.skill.session, noInput()), context);
  await assert.rejects(
    () => skill(update(second.data.skill.session, undefined, false), context),
    /Cannot read property 'nlu' of undefined/,
  );
});
