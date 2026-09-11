// N-06 — LoopMemberDetector + contextual entity resolution.
//
// Part 1 ports every fixture from the pinned source test
//   pegasus:packages/parser/tests/utils/LoopMemberDetector.test.ts
//   @ 5c0a7390539663ba749d360de348a428c088505c
// verbatim (same inputs, same .deep.equal expectations, same helper shape as
// that file's `testLoopMemberDetector` at lines 10-32).
//
// Part 2 covers the resolution matrix the source *code* defines but its test
// file does not pin: the GivenName/LastName aliases (LoopMemberDetector.ts:54-55),
// the unescaped text patterns (lines 73,84), duplicate members (Array.find),
// missing/undefined member names, ambiguous text matches, guard clauses
// (line 48) and the two source error boundaries (lines 5-7, 32-35).
//
// Part 3 exercises real HTTP requests through the live NLU service, proving the
// detector runs inside the request pipeline (as ParseRequestHandler.ts:33 does).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { LoopMemberDetector } from '../src/loopMemberDetector.js';
import { parseRequest } from '../src/requestParser.js';
import { start } from '../src/index.js';

let server;
let base;
const selectedRuntime = process.env.PHOENIX_NLU_RUNTIME;

before(async () => {
  delete process.env.PHOENIX_NLU_RUNTIME;
  server = await start(0);
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  if (selectedRuntime !== undefined) process.env.PHOENIX_NLU_RUNTIME = selectedRuntime;
});

// Source harness (LoopMemberDetector.test.ts:10-32): builds the request/result,
// calls detectLoopMembers and deep-equals the returned result.
function detect({ text, loopUsers }, { intent, entities }, expectedEntities) {
  const request = { text, rules: ['launch'], loop: { users: loopUsers } };
  const result = { intent, rules: ['launch'], entities };
  const expectedResult = { intent, rules: ['launch'], entities: expectedEntities };
  assert.deepEqual(LoopMemberDetector.detectLoopMembers(request, result), expectedResult);
}

// ---------------------------------------------------------------------------
// Part 1 — verbatim source fixtures.
// ---------------------------------------------------------------------------

test('source fixture: when no names in text and no given-name entity, entities are unchanged', () => {
  detect(
    { text: 'How are you doing today?', loopUsers: [{ id: 'loop-member-uuid-1', firstName: 'Mary', lastName: 'Jackson' }] },
    { intent: 'JIBO_chitChat', entities: { when: 'today' } },
    { when: 'today' },
  );
});

test('source fixture: non-empty given-name resolves the member', () => {
  detect(
    { text: 'Is Mary your best friend?', loopUsers: [{ id: 'loop-member-uuid-1', firstName: 'Mary', lastName: 'Jackson' }] },
    { intent: 'isJiboBestFriendsWithPerson', entities: { RobotCharacter: '', Competitor: '', OtherPerson: '', 'given-name': 'Mary' } },
    { RobotCharacter: '', Competitor: '', OtherPerson: '', 'given-name': 'Mary', 'last-name': 'Jackson', loopMemberReferent: 'loop-member-uuid-1' },
  );
});

test('source fixture: no member found by given-name leaves entities unchanged', () => {
  detect(
    { text: 'Is Bob your best friend?', loopUsers: [{ id: 'loop-member-uuid-1', firstName: 'Mary', lastName: 'Jackson' }] },
    { intent: 'isJiboBestFriendsWithPerson', entities: { RobotCharacter: '', Competitor: '', OtherPerson: '', 'given-name': 'Bob' } },
    { RobotCharacter: '', Competitor: '', OtherPerson: '', 'given-name': 'Bob' },
  );
});

test('source fixture: a non-matching last-name leaves entities unchanged', () => {
  detect(
    { text: 'Is Mary Smith your best friend?', loopUsers: [{ id: 'loop-member-uuid-1', firstName: 'Mary', lastName: 'Jackson' }] },
    { intent: 'isJiboBestFriendsWithPerson', entities: { RobotCharacter: '', Competitor: '', OtherPerson: '', 'given-name': 'Mary', 'last-name': 'Smith' } },
    { RobotCharacter: '', Competitor: '', OtherPerson: '', 'given-name': 'Mary', 'last-name': 'Smith' },
  );
});

test('source fixture: empty given-name resolves by full name in text', () => {
  detect(
    { text: 'Have you heard of benjamin harrison?', loopUsers: [{ id: 'loop-member-uuid-2', firstName: 'benjamin', lastName: 'harrison' }] },
    { intent: 'doesJiboKnowPerson', entities: { RobotCharacter: '', AmericaPresident: 'BenjaminHarrison', Competitor: '', FantasticPerson: '', OtherPerson: '', 'given-name': '' } },
    { RobotCharacter: '', AmericaPresident: 'BenjaminHarrison', Competitor: '', FantasticPerson: '', OtherPerson: '', 'given-name': 'benjamin', 'last-name': 'harrison', loopMemberReferent: 'loop-member-uuid-2' },
  );
});

test('source fixture: empty given-name resolves by first name in text', () => {
  detect(
    { text: 'Is Alexa or Mary your best friend?', loopUsers: [{ id: 'loop-member-uuid-1', firstName: 'Mary', lastName: 'Jackson' }] },
    { intent: 'isJiboBestFriendsWithPerson', entities: { RobotCharacter: '', Competitor: 'Alexa', OtherPerson: '', 'given-name': '' } },
    { RobotCharacter: '', Competitor: 'Alexa', OtherPerson: '', 'given-name': 'Mary', 'last-name': 'Jackson', loopMemberReferent: 'loop-member-uuid-1' },
  );
});

test('source fixture: empty given-name and no names in text leaves entities unchanged', () => {
  detect(
    { text: 'Is Alexa your best friend?', loopUsers: [{ id: 'loop-member-uuid-1', firstName: 'Mary', lastName: 'Jackson' }] },
    { intent: 'isJiboBestFriendsWithPerson', entities: { RobotCharacter: '', Competitor: 'Alexa', OtherPerson: '', 'given-name': '' } },
    { RobotCharacter: '', Competitor: 'Alexa', OtherPerson: '', 'given-name': '' },
  );
});

test('source fixture: no given-name entity resolves by full name in text', () => {
  detect(
    { text: 'Who is Mary Jackson?', loopUsers: [{ id: 'loop-member-uuid-1', firstName: 'Mary', lastName: 'Jackson' }] },
    { intent: 'generalWhoQuestions', entities: {} },
    { 'given-name': 'Mary', 'last-name': 'Jackson', loopMemberReferent: 'loop-member-uuid-1' },
  );
});

test('source fixture: full-name text match is case-insensitive and writes canonical names', () => {
  detect(
    { text: 'Who is mary jackson?', loopUsers: [{ id: 'loop-member-uuid-1', firstName: 'Mary', lastName: 'Jackson' }] },
    { intent: 'generalWhoQuestions', entities: {} },
    { 'given-name': 'Mary', 'last-name': 'Jackson', loopMemberReferent: 'loop-member-uuid-1' },
  );
});

test('source fixture: first and last name must be adjacent in text', () => {
  detect(
    { text: 'Who is Mary bla bla bla Jackson?', loopUsers: [{ id: 'loop-member-uuid-1', firstName: 'Mary', lastName: 'Jackson' }] },
    { intent: 'generalWhoQuestions', entities: {} },
    {},
  );
});

test('source fixture: an expected but empty given-name falls back to first name in text', () => {
  detect(
    { text: 'Who is Mary bla bla bla Jackson?', loopUsers: [{ id: 'loop-member-uuid-1', firstName: 'Mary', lastName: 'Jackson' }] },
    { intent: 'generalWhoQuestions', entities: { 'given-name': '' } },
    { 'given-name': 'Mary', 'last-name': 'Jackson', loopMemberReferent: 'loop-member-uuid-1' },
  );
});

test('source fixture: no given-name entity and only first name in text is not detected', () => {
  detect(
    { text: 'Have you seen Bob?', loopUsers: [{ id: 'loop-member-uuid-2', firstName: 'Bob', lastName: 'Jackson' }] },
    { intent: 'hasJiboSeenThing', entities: {} },
    {},
  );
});

// ---------------------------------------------------------------------------
// Part 2 — resolution matrix derived from the source code (not its fixtures).
// ---------------------------------------------------------------------------

test('aliases: a GivenName entity resolves the member (LoopMemberDetector.ts:54)', () => {
  detect(
    { text: 'is that so?', loopUsers: [{ id: 'u-jane', firstName: 'Jane', lastName: 'Jetson' }] },
    { intent: 'whoIsPerson', entities: { GivenName: 'jane' } },
    { GivenName: 'jane', 'given-name': 'Jane', 'last-name': 'Jetson', loopMemberReferent: 'u-jane' },
  );
});

test('aliases: GivenName + LastName resolve together (LoopMemberDetector.ts:54-55)', () => {
  detect(
    { text: 'is that so?', loopUsers: [{ id: 'u-jane', firstName: 'Jane', lastName: 'Jetson' }] },
    { intent: 'whoIsPerson', entities: { GivenName: 'jane', LastName: 'jetson' } },
    { GivenName: 'jane', LastName: 'jetson', 'given-name': 'Jane', 'last-name': 'Jetson', loopMemberReferent: 'u-jane' },
  );
});

test('aliases: a non-empty given-name beats the GivenName alias', () => {
  detect(
    { text: 'is that so?', loopUsers: [{ id: 'u-jane', firstName: 'Jane', lastName: 'Jetson' }] },
    { intent: 'whoIsPerson', entities: { 'given-name': 'Jane', GivenName: 'George' } },
    { 'given-name': 'Jane', GivenName: 'George', 'last-name': 'Jetson', loopMemberReferent: 'u-jane' },
  );
});

test('aliases: entity match is case-insensitive (LoopMemberDetector.ts:5-7)', () => {
  detect(
    { text: 'is that so?', loopUsers: [{ id: 'u-jane', firstName: 'Jane', lastName: 'Jetson' }] },
    { intent: 'whoIsPerson', entities: { GivenName: 'JANE' } },
    { GivenName: 'JANE', 'given-name': 'Jane', 'last-name': 'Jetson', loopMemberReferent: 'u-jane' },
  );
});

test('duplicates: Array.find keeps the first matching member', () => {
  detect(
    { text: 'who is jane', loopUsers: [
      { id: 'first-jane', firstName: 'Jane', lastName: 'Jetson' },
      { id: 'second-jane', firstName: 'Jane', lastName: 'Jetson' },
    ] },
    { intent: 'whoIsPerson', entities: { 'given-name': 'Jane' } },
    { 'given-name': 'Jane', 'last-name': 'Jetson', loopMemberReferent: 'first-jane' },
  );
});

test('ambiguity: text with two first names resolves to the first member in array order', () => {
  detect(
    { text: 'Is Mary or Jane your best friend?', loopUsers: [
      { id: 'u-jane', firstName: 'Jane', lastName: 'Jetson' },
      { id: 'u-mary', firstName: 'Mary', lastName: 'Jackson' },
    ] },
    { intent: 'isJiboBestFriendsWithPerson', entities: { 'given-name': '' } },
    { 'given-name': 'Jane', 'last-name': 'Jetson', loopMemberReferent: 'u-jane' },
  );
});

test('missing members: an undefined name produces the literal "undefined" pattern (LoopMemberDetector.ts:73)', () => {
  const request = { text: 'who is undefined undefined', rules: ['launch'], loop: { users: [{ id: 'u-malformed' }] } };
  const result = { intent: 'whoIsPerson', entities: {} };
  LoopMemberDetector.detectLoopMembers(request, result);
  assert.equal(result.entities.loopMemberReferent, 'u-malformed');
  assert.ok(Object.prototype.hasOwnProperty.call(result.entities, 'given-name'));
  assert.equal(result.entities['given-name'], undefined);
  assert.equal(result.entities['last-name'], undefined);
});

test('punctuation: member names are interpolated as a regex, not escaped (LoopMemberDetector.ts:73)', () => {
  // "A.J." -> \bA.J. Smith\b, so the dot matches any character: "AXJY Smith".
  detect(
    { text: 'who is AXJY Smith', loopUsers: [{ id: 'u-dot', firstName: 'A.J.', lastName: 'Smith' }] },
    { intent: 'whoIsPerson', entities: {} },
    { 'given-name': 'A.J.', 'last-name': 'Smith', loopMemberReferent: 'u-dot' },
  );
  // Hyphen/apostrophe names also resolve literally.
  detect(
    { text: "who is mary-jane o'brien", loopUsers: [{ id: 'u-hy', firstName: 'Mary-Jane', lastName: "O'Brien" }] },
    { intent: 'whoIsPerson', entities: {} },
    { 'given-name': 'Mary-Jane', 'last-name': "O'Brien", loopMemberReferent: 'u-hy' },
  );
});

test('guards: no loop, no users, no intent or no result produce no enrichment (LoopMemberDetector.ts:48)', () => {
  const users = [{ id: 'u-jane', firstName: 'Jane', lastName: 'Jetson' }];
  const withIntent = { intent: 'whoIsPerson', entities: {} };
  assert.equal(LoopMemberDetector.findLoopMember({ text: 'who is jane jetson', rules: ['launch'] }, withIntent), null);
  assert.equal(LoopMemberDetector.findLoopMember({ text: 'who is jane jetson', rules: ['launch'], loop: {} }, withIntent), null);
  assert.equal(LoopMemberDetector.findLoopMember({ text: 'who is jane jetson', rules: ['launch'], loop: { users } }, { intent: null, entities: {} }), null);
  assert.equal(LoopMemberDetector.findLoopMember({ text: 'who is jane jetson', rules: ['launch'], loop: { users } }, null), null);

  const noIntent = { intent: null, entities: {} };
  assert.deepEqual(LoopMemberDetector.detectLoopMembers({ text: 'who is jane jetson', loop: { users } }, noIntent), { intent: null, entities: {} });
  assert.equal(LoopMemberDetector.detectLoopMembers({ text: 'who is jane jetson', loop: { users } }, null), null);
});

test('error boundary: a member with a missing firstName alongside a given-name entity throws (LoopMemberDetector.ts:5-7)', () => {
  const request = { text: 'who is mary', rules: ['launch'], loop: { users: [{ id: 'u-malformed' }] } };
  const result = { intent: 'whoIsPerson', entities: { 'given-name': 'Mary' } };
  assert.throws(() => LoopMemberDetector.detectLoopMembers(request, result), TypeError);
});

test('error boundary: a null entities map with a text match throws on write (LoopMemberDetector.ts:32-35)', () => {
  const request = { text: 'who is mary jackson', rules: ['launch'], loop: { users: [{ id: 'u-mary', firstName: 'Mary', lastName: 'Jackson' }] } };
  const result = { intent: 'generalWhoQuestions', entities: null };
  assert.throws(() => LoopMemberDetector.detectLoopMembers(request, result), TypeError);
});

// ---------------------------------------------------------------------------
// Part 3 — real HTTP requests through the live NLU service.
// ---------------------------------------------------------------------------

async function parseOverHttp(data) {
  const response = await fetch(`${base}/v1/parse`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'NLU', data }),
  });
  assert.equal(response.status, 200);
  return (await response.json()).data;
}

test('HTTP: GivenName alias from the launch parse resolves the loop member', async () => {
  assert.deepEqual(await parseOverHttp({
    text: 'who is jane jetson',
    rules: ['launch'],
    loop: { users: [{ id: 'u-jane', firstName: 'Jane', lastName: 'Jetson' }] },
  }), {
    rules: ['launch'],
    intent: 'whoIsPerson',
    entities: {
      GivenName: 'jane',
      union_original_fst_name: 'handle:chitchat/launch',
      loopMemberReferent: 'u-jane',
      'given-name': 'Jane',
      'last-name': 'Jetson',
    },
  });
});

test('HTTP: a failing given-name lookup does not fall through to a text search', async () => {
  const result = await parseOverHttp({
    text: 'who is jane jetson',
    rules: ['launch'],
    loop: { users: [{ id: 'u-george', firstName: 'George', lastName: 'Jetson' }] },
  });
  assert.equal(result.intent, 'whoIsPerson');
  assert.deepEqual(result.entities, {
    GivenName: 'jane',
    union_original_fst_name: 'handle:chitchat/launch',
  });
});

test('HTTP: empty loop users are accepted and leave the result unchanged', async () => {
  const result = await parseOverHttp({ text: 'who is jane jetson', rules: ['launch'], loop: { users: [] } });
  assert.deepEqual(result.entities, { GivenName: 'jane', union_original_fst_name: 'handle:chitchat/launch' });
});

test('HTTP: full-name text match resolves through the named rule', async () => {
  assert.deepEqual(await parseOverHttp({
    text: 'jane jetson',
    rules: ['shared/wrong_id'],
    loop: { users: [
      { id: 'u-george', firstName: 'George', lastName: 'Jetson' },
      { id: 'u-jane', firstName: 'Jane', lastName: 'Jetson' },
    ] },
  }), {
    rules: ['shared/wrong_id'],
    intent: 'loopmember',
    entities: {
      GivenName: 'jane',
      loopMemberReferent: 'u-jane',
      'given-name': 'Jane',
      'last-name': 'Jetson',
    },
  });
});

test('HTTP: parsed launch result survives the direct parse result identity', async () => {
  // The detector mutates the selected result; parseRequest callers see the same
  // enriched object shape as the HTTP response.
  assert.deepEqual(parseRequest({
    text: 'who is jane jetson',
    rules: ['launch'],
    loop: { users: [{ id: 'u-jane', firstName: 'Jane', lastName: 'Jetson' }] },
  }).entities.loopMemberReferent, 'u-jane');
});

// ---------------------------------------------------------------------------
// Part 4 — the speaker/referent interaction.
//
// LoopMemberDetector has NO speaker input: it keys only off
// `request.loop.users` and `result.entities`/`request.text`
// (LoopMemberDetector.ts:48-93). The "speaker" and the "referent" are two
// distinct identities that meet later, in the skill's RuntimeContext:
//   * `perception.speaker` = "ID of the currently active speaker"
//     (pegasus:packages/interfaces/src/jibo/runtime.ts:132-137);
//   * `dialog.referent` = "ID of a loop member that was referred to in utterance"
//     (runtime.ts:139-143);
//   * the hub fills `dialog.referent` by copying the entity this detector writes:
//       const referent = input.nlu.entities.loopMemberReferent
//       input.context.runtime.dialog.referent = resolvedReferent
//     (pegasus:packages/hub/src/skill/SkillRequestHelper.ts:95-99);
//   * the speaker is consumed separately, only for history personIDs
//     (pegasus:packages/hub/src/utils/TransactionHelper.ts:13-16).
//
// The source fixture file pins no speaker case. These cases pin the invariant
// the source code defines: detection is a pure function of loop.users + the
// entities/text, so the member NAMED in the utterance is the referent even
// when the speaker (or array order) is a different member.
// ---------------------------------------------------------------------------

test('speaker/referent: the NAMED member is the referent, not the array-first (speaker-position) member', () => {
  // George is first in loop.users (the "speaker" position); the utterance names
  // Jane. Step 3 (LoopMemberDetector.ts:71-80) resolves the member about whom
  // the turn asks.
  detect(
    { text: 'Who is Jane Jetson?', loopUsers: [
      { id: 'u-george', firstName: 'George', lastName: 'Jetson' },
      { id: 'u-jane', firstName: 'Jane', lastName: 'Jetson' },
    ] },
    { intent: 'whoIsPerson', entities: {} },
    { 'given-name': 'Jane', 'last-name': 'Jetson', loopMemberReferent: 'u-jane' },
  );
  // Symmetrically, naming the array-first member still resolves that member.
  detect(
    { text: 'Who is George Jetson?', loopUsers: [
      { id: 'u-george', firstName: 'George', lastName: 'Jetson' },
      { id: 'u-jane', firstName: 'Jane', lastName: 'Jetson' },
    ] },
    { intent: 'whoIsPerson', entities: {} },
    { 'given-name': 'George', 'last-name': 'Jetson', loopMemberReferent: 'u-george' },
  );
});

test('speaker/referent: a perception/dialog context on the request never influences detection', () => {
  // The NLURequestData schema (pegasus:packages/interfaces/src/nlu.ts:34-46) has
  // no perception/speaker/dialog field. Even if a caller smuggles the robot
  // runtime context onto the parser request, the detector reads only
  // loop.users + entities + text — so the smuggled speaker must not win.
  const users = [
    { id: 'u-george', firstName: 'George', lastName: 'Jetson' },
    { id: 'u-jane', firstName: 'Jane', lastName: 'Jetson' },
  ];
  const smuggled = {
    text: 'Who is Jane Jetson?',
    rules: ['launch'],
    loop: { users },
    perception: { speaker: 'u-george', peoplePresent: [] },
    dialog: { referent: 'u-george' },
  };
  const janeResult = { intent: 'whoIsPerson', entities: {} };
  LoopMemberDetector.detectLoopMembers(smuggled, janeResult);
  assert.equal(janeResult.entities.loopMemberReferent, 'u-jane',
    'the smuggled perception.speaker/dialog.referent did not override the named member');

  // With nobody named, no referent is written even though the smuggled
  // dialog.referent claims George is the referent.
  const nobodyResult = { intent: 'whoIsPerson', entities: {} };
  LoopMemberDetector.detectLoopMembers({ ...smuggled, text: 'sing me a song' }, nobodyResult);
  assert.deepEqual(nobodyResult.entities, {},
    'no member named in the text => no referent written');
});

test('speaker/referent: the referent output is the plain loop-member id injectDialogContext copies', () => {
  // This is the exact value SkillRequestHelper.injectDialogContext assigns to
  // runtime.dialog.referent (SkillRequestHelper.ts:95-99).
  const result = { intent: 'whoIsPerson', entities: {} };
  LoopMemberDetector.detectLoopMembers({
    text: 'Who is Jane Jetson?',
    rules: ['launch'],
    loop: { users: [
      { id: 'u-george', firstName: 'George', lastName: 'Jetson' },
      { id: 'u-jane', firstName: 'Jane', lastName: 'Jetson' },
    ] },
  }, result);
  assert.equal(typeof result.entities.loopMemberReferent, 'string');
  assert.equal(result.entities.loopMemberReferent, 'u-jane');
});
