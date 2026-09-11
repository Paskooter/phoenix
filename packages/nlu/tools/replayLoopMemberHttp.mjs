// N-06 runtime replay: LoopMemberDetector over the live NLU HTTP service plus
// direct parser calls.
//
// Three phases, all exercised against the real code paths:
//   phase 1  source fixtures (from pegasus:packages/parser/tests/utils/
//            LoopMemberDetector.test.ts@5c0a739) driven through
//            LoopMemberDetector.detectLoopMembers and deep-equalled.
//   phase 2  real HTTP POST /v1/parse requests with a `loop` context against a
//            live service bound to an ephemeral port.
//   phase 3  speaker/referent separation — the detector takes no speaker input,
//            so a smuggled runtime context (perception.speaker / dialog.referent)
//            must not change which member the utterance resolves. Pinned source
//            for the downstream meeting point:
//              interfaces/src/jibo/runtime.ts:132-143  (perception.speaker, dialog.referent)
//              hub/src/skill/SkillRequestHelper.ts:95-99 (referent <- loopMemberReferent)
//              hub/src/utils/TransactionHelper.ts:13-16 (speaker -> history personIDs)
//
// Usage: node packages/nlu/tools/replayLoopMemberHttp.mjs [--out <path>]
import { createHash } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { LoopMemberDetector } from '../src/loopMemberDetector.js';
import { start } from '../src/index.js';

// --- phase 1: the 12 pinned source fixtures ---------------------------------
const MARY = [{ id: 'loop-member-uuid-1', firstName: 'Mary', lastName: 'Jackson' }];
const BEN = [{ id: 'loop-member-uuid-2', firstName: 'benjamin', lastName: 'harrison' }];
const BOB = [{ id: 'loop-member-uuid-2', firstName: 'Bob', lastName: 'Jackson' }];

const sourceFixtures = [
  ['source:01', 'How are you doing today?', MARY, { intent: 'JIBO_chitChat', entities: { when: 'today' } }, { when: 'today' }],
  ['source:02', 'Is Mary your best friend?', MARY, { intent: 'isJiboBestFriendsWithPerson', entities: { RobotCharacter: '', Competitor: '', OtherPerson: '', 'given-name': 'Mary' } }, { RobotCharacter: '', Competitor: '', OtherPerson: '', 'given-name': 'Mary', 'last-name': 'Jackson', loopMemberReferent: 'loop-member-uuid-1' }],
  ['source:03', 'Is Bob your best friend?', MARY, { intent: 'isJiboBestFriendsWithPerson', entities: { RobotCharacter: '', Competitor: '', OtherPerson: '', 'given-name': 'Bob' } }, { RobotCharacter: '', Competitor: '', OtherPerson: '', 'given-name': 'Bob' }],
  ['source:04', 'Is Mary Smith your best friend?', MARY, { intent: 'isJiboBestFriendsWithPerson', entities: { RobotCharacter: '', Competitor: '', OtherPerson: '', 'given-name': 'Mary', 'last-name': 'Smith' } }, { RobotCharacter: '', Competitor: '', OtherPerson: '', 'given-name': 'Mary', 'last-name': 'Smith' }],
  ['source:05', 'Have you heard of benjamin harrison?', BEN, { intent: 'doesJiboKnowPerson', entities: { RobotCharacter: '', AmericaPresident: 'BenjaminHarrison', Competitor: '', FantasticPerson: '', OtherPerson: '', 'given-name': '' } }, { RobotCharacter: '', AmericaPresident: 'BenjaminHarrison', Competitor: '', FantasticPerson: '', OtherPerson: '', 'given-name': 'benjamin', 'last-name': 'harrison', loopMemberReferent: 'loop-member-uuid-2' }],
  ['source:06', 'Is Alexa or Mary your best friend?', MARY, { intent: 'isJiboBestFriendsWithPerson', entities: { RobotCharacter: '', Competitor: 'Alexa', OtherPerson: '', 'given-name': '' } }, { RobotCharacter: '', Competitor: 'Alexa', OtherPerson: '', 'given-name': 'Mary', 'last-name': 'Jackson', loopMemberReferent: 'loop-member-uuid-1' }],
  ['source:07', 'Is Alexa your best friend?', MARY, { intent: 'isJiboBestFriendsWithPerson', entities: { RobotCharacter: '', Competitor: 'Alexa', OtherPerson: '', 'given-name': '' } }, { RobotCharacter: '', Competitor: 'Alexa', OtherPerson: '', 'given-name': '' }],
  ['source:08', 'Who is Mary Jackson?', MARY, { intent: 'generalWhoQuestions', entities: {} }, { 'given-name': 'Mary', 'last-name': 'Jackson', loopMemberReferent: 'loop-member-uuid-1' }],
  ['source:09', 'Who is mary jackson?', MARY, { intent: 'generalWhoQuestions', entities: {} }, { 'given-name': 'Mary', 'last-name': 'Jackson', loopMemberReferent: 'loop-member-uuid-1' }],
  ['source:10', 'Who is Mary bla bla bla Jackson?', MARY, { intent: 'generalWhoQuestions', entities: {} }, {}],
  ['source:11', 'Who is Mary bla bla bla Jackson?', MARY, { intent: 'generalWhoQuestions', entities: { 'given-name': '' } }, { 'given-name': 'Mary', 'last-name': 'Jackson', loopMemberReferent: 'loop-member-uuid-1' }],
  ['source:12', 'Have you seen Bob?', BOB, { intent: 'hasJiboSeenThing', entities: {} }, {}],
];

function stable(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
}

const sourceRows = sourceFixtures.map(([id, text, loopUsers, nluResult, expected]) => {
  const request = { text, rules: ['launch'], loop: { users: loopUsers } };
  const result = { intent: nluResult.intent, rules: ['launch'], entities: { ...nluResult.entities } };
  LoopMemberDetector.detectLoopMembers(request, result);
  const got = result.entities;
  return { id, phase: 'source-fixture', text, got, expected, matches: stable(got) === stable(expected) };
});

// --- phase 3: speaker/referent separation -----------------------------------
// The speaker and the referent are distinct identities that meet in the skill's
// RuntimeContext (runtime.ts:132-143); the detector itself has no speaker input.
const SEPARATION_USERS = [
  { id: 'u-george', firstName: 'George', lastName: 'Jetson' },
  { id: 'u-jane', firstName: 'Jane', lastName: 'Jetson' },
];
const speakerReferentCases = [
  ['separation:names-other-member', 'Who is Jane Jetson?', { speaker: 'u-george', referent: 'u-george' }, 'whoIsPerson',
    { 'given-name': 'Jane', 'last-name': 'Jetson', loopMemberReferent: 'u-jane' }],
  ['separation:names-first-member', 'Who is George Jetson?', { speaker: 'u-jane', referent: 'u-jane' }, 'whoIsPerson',
    { 'given-name': 'George', 'last-name': 'Jetson', loopMemberReferent: 'u-george' }],
  ['separation:nobody-named', 'sing me a song', { speaker: 'u-george', referent: 'u-george' }, 'whoIsPerson', {}],
];

const separationRows = speakerReferentCases.map(([id, text, context, intent, expected]) => {
  const request = {
    text, rules: ['launch'], loop: { users: SEPARATION_USERS },
    perception: { speaker: context.speaker, peoplePresent: [] },
    dialog: { referent: context.referent },
  };
  const result = { intent, rules: ['launch'], entities: {} };
  LoopMemberDetector.detectLoopMembers(request, result);
  return {
    id, phase: 'speaker-referent', text, speaker: context.speaker, dialogReferent: context.referent,
    got: result.entities, expected, matches: stable(result.entities) === stable(expected),
  };
});

// --- phase 2: live HTTP requests --------------------------------------------
const httpCases = [
  ['http:alias-givenname', { text: 'who is jane jetson', rules: ['launch'], loop: { users: [{ id: 'u-jane', firstName: 'Jane', lastName: 'Jetson' }] } },
    { rules: ['launch'], intent: 'whoIsPerson', entities: { GivenName: 'jane', union_original_fst_name: 'handle:chitchat/launch', loopMemberReferent: 'u-jane', 'given-name': 'Jane', 'last-name': 'Jetson' } }],
  ['http:no-fallthrough', { text: 'who is jane jetson', rules: ['launch'], loop: { users: [{ id: 'u-george', firstName: 'George', lastName: 'Jetson' }] } },
    { rules: ['launch'], intent: 'whoIsPerson', entities: { GivenName: 'jane', union_original_fst_name: 'handle:chitchat/launch' } }],
  ['http:empty-users', { text: 'who is jane jetson', rules: ['launch'], loop: { users: [] } },
    { rules: ['launch'], intent: 'whoIsPerson', entities: { GivenName: 'jane', union_original_fst_name: 'handle:chitchat/launch' } }],
  ['http:named-rule-fullname', { text: 'jane jetson', rules: ['shared/wrong_id'], loop: { users: [{ id: 'u-george', firstName: 'George', lastName: 'Jetson' }, { id: 'u-jane', firstName: 'Jane', lastName: 'Jetson' }] } },
    { rules: ['shared/wrong_id'], intent: 'loopmember', entities: { GivenName: 'jane', loopMemberReferent: 'u-jane', 'given-name': 'Jane', 'last-name': 'Jetson' } }],
];

const server = await start(0);
const base = `http://127.0.0.1:${server.address().port}`;
const httpRows = [];
try {
  for (const [id, data, expected] of httpCases) {
    const response = await fetch(`${base}/v1/parse`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'NLU', data }),
    });
    const body = await response.json();
    const got = body.data;
    httpRows.push({ id, phase: 'http', status: response.status, request: data, got, expected, matches: response.status === 200 && stable(got) === stable(expected) });
  }
} finally {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

const rows = [...sourceRows, ...separationRows, ...httpRows];
const differences = rows.filter(r => !r.matches).map(r => r.id);
const out = {
  schema: 'phoenix.nlu.n06-loop-member-replay',
  reference: {
    repo: 'jiboV2/pegasus',
    ref: '5c0a7390539663ba749d360de348a428c088505c',
    detector: 'packages/parser/src/utils/LoopMemberDetector.ts',
    fixtures: 'packages/parser/tests/utils/LoopMemberDetector.test.ts',
    interfaces: 'packages/interfaces/src/nlu.ts',
    speakerReferent: [
      'packages/interfaces/src/jibo/runtime.ts:132-143',
      'packages/hub/src/skill/SkillRequestHelper.ts:95-99',
      'packages/hub/src/utils/TransactionHelper.ts:13-16',
      'packages/hub/src/listen/ListenTransactionHandler.ts:311-312,421-429',
    ],
  },
  sourceFixtureCases: sourceRows.length,
  speakerReferentCases: separationRows.length,
  httpCases: httpRows.length,
  matches: rows.filter(r => r.matches).length,
  differences,
  rows,
};
out.sha256 = createHash('sha256').update(`${JSON.stringify(out)}\n`).digest('hex');

const outIndex = process.argv.indexOf('--out');
if (outIndex !== -1 && process.argv[outIndex + 1]) {
  const target = process.argv[outIndex + 1];
  if (existsSync(target)) throw new Error(`refusing to overwrite existing ${target}`);
  writeFileSync(target, `${JSON.stringify(out, null, 1)}\n`);
}

console.log(`reference              : ${out.reference.repo}@${out.reference.ref}`);
console.log(`source-fixture cases   : ${out.sourceFixtureCases}`);
console.log(`speaker/referent cases : ${out.speakerReferentCases}`);
console.log(`http cases             : ${out.httpCases}`);
console.log(`matches                : ${out.matches}/${rows.length}`);
console.log(`differences            : ${differences.length ? differences.join(', ') : 'none'}`);
for (const r of rows.filter(x => !x.matches)) {
  console.log(`  ${r.id}\n    expected ${JSON.stringify(r.expected)}\n    got      ${JSON.stringify(r.got)}`);
}
process.exitCode = differences.length ? 1 : 0;
