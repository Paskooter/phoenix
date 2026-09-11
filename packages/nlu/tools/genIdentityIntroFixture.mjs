// genIdentityIntroFixture.mjs — regenerate
// packages/nlu/test/fixtures/identity-intro-greetings.json (N-04).
//
// Runs the real parseRequest for every row so the frozen `expect` values are
// what the runtime actually produces; every row's `anchor` cites the pinned
// rule source, and the test re-derives entity provenance from that source.
// Re-run from the repo root after any intentional behaviour change:
//   node packages/nlu/tools/genIdentityIntroFixture.mjs
import { writeFileSync } from 'node:fs';
import { parseRequest } from '../src/requestParser.js';

const norm = r => ({ entities: r.entities, intent: r.intent, rules: r.rules });
const P = req => norm(parseRequest(req));
const L = ['launch'];

const JETS = [
  { id: 'u-george', firstName: 'George', lastName: 'Jetson' },
  { id: 'u-jane', firstName: 'Jane', lastName: 'Jetson' },
];
const MARY = [{ id: 'u-mary', firstName: 'Mary', lastName: 'Jackson' }];
const TWO_JANE = [
  { id: 'u-jane-first', firstName: 'Jane', lastName: 'Jetson' },
  { id: 'u-jane-second', firstName: 'Jane', lastName: 'Smith' },
];

// ---- named-rule coverage (21 rules) ---------------------------------------
const R = 'packages/parser/robust-parser/rules_src';
const namedRules = [
  { rule: 'greetings/greetings_hello', anchors: [`${R}/greetings/greetings_hello.rule:24-57`],
    positives: ['hello', 'hey there', 'how are you', 'how is your day going', 'greetings', 'good morning', 'good night'],
    negative: 'qzx florp' },
  { rule: 'greetings/day_quality', anchors: [`${R}/greetings/day_quality.rule:8-58`],
    positives: ['yes', 'no', 'another great day', 'it was great', 'could be worse', 'could be better', 'unfortunately', 'it sure was not'],
    negative: 'qzx florp' },
  { rule: 'greetings/sleep_quality', anchors: [`${R}/greetings/sleep_quality.rule:7-57`],
    positives: ['yes', 'like a log', 'slept all night', 'seven hours', 'two hours', 'kept me up all night', 'how about you'],
    negative: 'qzx florp' },
  { rule: 'greetings/you_too', anchors: [`${R}/greetings/you_too.rule:1-14`],
    positives: ['you too', 'thanks jibo you too', 'right back at you', 'you as well'],
    negative: 'thanks' },
  { rule: 'greetings/bedtime_reminder', anchors: [`${R}/greetings/bedtime_reminder.rule:5-56`],
    positives: ['i will', 'sounds good', 'remind me again later', 'stop it', 'be quiet', 'whatever'],
    negative: null, negativeUnavailable: 'the wildcard $D_GREETINGS_INTENT_WILDCARD arm (line 31-36) matches every utterance by design' },
  { rule: 'greetings/proactive_general_question', anchors: [`${R}/greetings/proactive_general_question.rule`],
    positives: ['yes', 'no'], negative: 'qzx florp' },
  { rule: 'greetings/proactive_general_statement', anchors: [`${R}/greetings/proactive_general_statement.rule`],
    positives: ['hey jibo'], negative: null, negativeUnavailable: 'declares a wildcard statement arm that matches every utterance by design' },
  { rule: 'greetings/proactive_morning_question', anchors: [`${R}/greetings/proactive_morning_question.rule`],
    positives: ['yes', 'no'], negative: 'qzx florp' },
  { rule: 'greetings/proactive_morning_statement', anchors: [`${R}/greetings/proactive_morning_statement.rule`],
    positives: ['hey jibo'], negative: null, negativeUnavailable: 'declares a wildcard statement arm that matches every utterance by design' },
  { rule: 'greetings/proactive_playful_question', anchors: [`${R}/greetings/proactive_playful_question.rule`],
    positives: ['yes', 'no'], negative: 'qzx florp' },
  { rule: 'greetings/proactive_playful_statement', anchors: [`${R}/greetings/proactive_playful_statement.rule`],
    positives: ['hey jibo'], negative: null, negativeUnavailable: 'declares a wildcard statement arm that matches every utterance by design' },
  { rule: 'introductions/intro_looper', anchors: [`${R}/introductions/intro_looper.rule:1-32`],
    positives: ['my name is Mary', 'i am bob', 'john smith', 'cancel', 'forget it', 'no one'],
    negative: null, negativeUnavailable: 'the LOOPER wildcard arm (?$PREFIX <1.0>+$w<0.0>) matches any "my name is <x>" / "i am <x>" phrasing' },
  { rule: 'introductions/any_more_intros', anchors: [`${R}/introductions/any_more_intros.rule:1-39`],
    positives: ['yes', 'my friend is here', 'they are ready', 'nobody else', 'not right now'],
    negative: 'qzx florp' },
  { rule: 'introductions/face_capture_ready', anchors: [`${R}/introductions/face_capture_ready.rule:1-41`],
    positives: ['yes', 'i am ready', 'nailed it', 'no thanks', 'wait a minute', 'cancel'],
    negative: 'qzx florp' },
  { rule: 'introductions/is_name_right', anchors: [`${R}/introductions/is_name_right.rule:1-65`],
    positives: ['yes', 'close enough', 'certainly', 'not quite', 'not this time', 'cancel'],
    negative: 'qzx florp' },
  { rule: 'introductions/recognition_any_more', anchors: [`${R}/introductions/recognition_any_more.rule:1-62`],
    positives: ['yes', 'no', 'face', 'voice', 'my name'],
    negative: 'qzx florp' },
  { rule: 'introductions/recognition_type_menu', anchors: [`${R}/introductions/recognition_type_menu.rule:1-57`],
    positives: ['face', 'voice', 'name', 'voice enrollment'],
    negative: 'yes' },
  { rule: 'who-am-i/collect_looper', anchors: [`${R}/who-am-i/collect_looper.rule:1-19`],
    positives: ['my name is Mary', 'i am bob', 'i am not in the loop', 'we are not loopers'],
    negative: null, negativeUnavailable: 'the LOOPMEMBER_INTENT wildcard arm (?$PREFIX <1.0>+$w<0.0>) matches any "my name is <x>" / "i am <x>" phrasing' },
  { rule: 'who-am-i/confirm', anchors: [`${R}/who-am-i/confirm.rule:1-56`],
    positives: ['yes', 'no', 'definitely', 'correct', 'it is', 'wrong again', 'not me'],
    negative: 'qzx florp' },
  { rule: 'who-am-i/name_is_right', anchors: [`${R}/who-am-i/name_is_right.rule:1-61`],
    positives: ['yes', 'no', 'close enough', 'kind of', 'not quite', 'close but no cigar'],
    negative: 'qzx florp' },
  { rule: 'who-am-i/want_to_enroll', anchors: [`${R}/who-am-i/want_to_enroll.rule:1-40`],
    positives: ['yes', 'go for it', 'you can', 'sounds good', 'later', 'not a good idea'],
    negative: 'qzx florp' },
];

const namedRuleRows = namedRules.map(row => {
  const positives = row.positives.map(text => ({ text, expect: P({ text, rules: [row.rule] }) }));
  let negative = null;
  if (row.negative) negative = { text: row.negative, expect: P({ text: row.negative, rules: [row.rule] }) };
  return { rule: row.rule, anchors: row.anchors, positives, negative, negativeUnavailable: row.negativeUnavailable || null };
});

// ---- launch intents (greetings / who-am-i / introductions) -----------------
const launchRows = [
  ['launch:hello', 'hello', `${R}/greetings/launch.rule:84-90`, 'native'],
  ['launch:hi-jibo', 'hi jibo', `${R}/greetings/launch.rule:68-83`, 'native'],
  ['launch:hey-there', 'hey there', `${R}/greetings/launch.rule:84-90`, 'native'],
  ['launch:good-morning', 'good morning', `${R}/greetings/launch.rule:100-105`, 'native'],
  ['launch:good-afternoon', 'good afternoon', `${R}/greetings/launch.rule:107-111`, 'source'],
  ['launch:good-evening', 'good evening', `${R}/greetings/launch.rule:113-117`, 'native'],
  ['launch:good-night', 'good night', `${R}/greetings/launch.rule:119-127`, 'source'],
  ['launch:goodbye', 'goodbye', `${R}/greetings/launch.rule:129-133`, 'source'],
  ['launch:im-home', 'i am home', `${R}/greetings/launch.rule:56-60`, 'source'],
  ['launch:im-back', 'i am back', `${R}/greetings/launch.rule:62-66`, 'source'],
  ['launch:howdy', 'howdy', `${R}/greetings/launch.rule:84-90`, 'native'],
  ['launch:whats-up', 'whats up', `${R}/greetings/launch.rule:91-98`, 'native'],
  ['launch:whats-happening', 'whats happening', `${R}/greetings/launch.rule:91-98`, 'native'],
  ['launch:happy-holiday', 'merry christmas', `${R}/greetings/launch.rule:48-54`, 'source'],
  ['launch:who-am-i', 'who am i', `${R}/who-am-i/launch.rule:1-10`, 'native'],
  ['launch:whats-my-name', 'whats my name', `${R}/who-am-i/launch.rule:1-10`, 'native'],
  ['launch:enroll-known', 'this is my friend Mary', `${R}/introductions/launch.rule:20-29`, 'source'],
  ['launch:enroll-known-2', 'enroll Mary', `${R}/introductions/launch.rule:26-27`, 'source'],
  ['launch:enroll-unknown', 'enroll my friend', `${R}/introductions/launch.rule:54-60`, 'source'],
  ['launch:enroll-voice', 'enroll her voice', `${R}/introductions/launch.rule:62-68`, 'source'],
  ['launch:enroll-type-all', 'do a complete enrollment for my mom', `${R}/introductions/launch.rule:41-50`, 'source'],
];
const launchIntents = launchRows.map(([id, text, anchor, basis]) => ({ id, text, rules: L, basis, anchor, expect: P({ text, rules: L }) }));

// ---- no input / no match ---------------------------------------------------
const noInput = [
  { id: 'noinput:empty-launch', text: '', rules: L },
  { id: 'noinput:whitespace-launch', text: '   ', rules: L },
  { id: 'noinput:empty-followup', text: '', rules: ['who-am-i/confirm'] },
  { id: 'noinput:empty-intro', text: '', rules: ['introductions/is_name_right'] },
].map(row => ({ ...row, expect: P(row) }));

// ---- ambiguous names -------------------------------------------------------
const ambiguous = [
  { id: 'ambiguous:collect-first-name', text: 'my name is Jane', rules: ['who-am-i/collect_looper'], loop: { users: TWO_JANE },
    note: 'Array.find keeps the first member with that firstName (LoopMemberDetector.ts:65-68)' },
  { id: 'ambiguous:collect-full-name', text: 'jane jetson', rules: ['who-am-i/collect_looper'], loop: { users: TWO_JANE },
    note: 'full-name entity lookup resolves the matching member, not the first' },
  { id: 'ambiguous:launch-which-jane', text: 'who is jane', rules: L, loop: { users: TWO_JANE },
    note: 'text search keeps the first member with that firstName (LoopMemberDetector.ts:81-90)' },
].map(row => ({ ...row, expect: P(row) }));

// ---- multi-turn transcripts ------------------------------------------------
const transcript = (id, note, users, turns) => ({
  id, note, loop: users ? { users } : undefined,
  turns: turns.map(([text, rules]) => {
    const req = { text, rules };
    if (users) req.loop = { users };
    return { text, rules, expect: P(req) };
  }),
});

const transcripts = [
  transcript('known-member-identity-enrollment', 'known household member is resolved to a referent across the who-am-i follow-ups', JETS, [
    ['who am i', L],
    ['my name is George', ['who-am-i/collect_looper']],
    ['yes', ['who-am-i/name_is_right']],
  ]),
  transcript('unknown-member-identity-enrollment', 'a name that matches no household member yields no referent', JETS, [
    ['who am i', L],
    ['my name is Alex', ['who-am-i/collect_looper']],
    ['no', ['who-am-i/name_is_right']],
  ]),
  transcript('known-member-introduction', 'introducing a known member resolves the given name and referent', [{ id: 'u-mary', firstName: 'Mary', lastName: 'Jackson' }, ...JETS], [
    ['this is my friend Mary', L],
    ['yes', ['introductions/face_capture_ready']],
    ['face', ['introductions/recognition_type_menu']],
    ['yes', ['introductions/recognition_any_more']],
  ]),
  transcript('unknown-member-introduction', 'introducing an unknown name keeps the parsed name but writes no referent', JETS, [
    ['this is my friend Alex', L],
    ['yes', ['introductions/any_more_intros']],
    ['my name is Alex', ['introductions/intro_looper']],
  ]),
  transcript('greeting-follow-up', 'greeting then its youToo follow-up then a second greeting', JETS, [
    ['hello', L],
    ['you too', ['greetings/you_too']],
    ['good morning', L],
  ]),
  transcript('greeting-identity-selfid-vs-introduction', 'a self-identifying greeting is arbitrated inside the launch union; note this is INFERRED (no native capture)', JETS, [
    ["it's me Mary", L],
    ['yes', ['introductions/is_name_right']],
  ]),
  transcript('no-members', 'with no loop members every referent stays absent', null, [
    ['who am i', L],
    ['my name is George', ['who-am-i/collect_looper']],
  ]),
];

const fixture = {
  schema: 'phoenix.nlu.n04-identity-intro-greetings-fixture',
  referenceRevision: '5c0a7390539663ba749d360de348a428c088505c',
  referenceSourceRoot: R,
  nativeOracle: {
    source: 'packages/nlu/resources/legacy-oracle/golden.jsonl',
    nativeSourceRevision: '91b1bb6dbc702d3072df98a6fa0b76a6bc151d3e',
  },
  // Recorded, NOT asserted: behaviours observed while deriving this fixture that
  // look like matcher-fidelity gaps but have no native capture to fix against.
  // See docs/parity/evidence/2026-09-11/n04-identity-intro-greetings/review.md.
  divergenceCandidates: [
    {
      id: 'N04a-selfid-masked',
      summary: "greetings/launch's D_GREETINGS_WITH_SELFID arm (selfid + inLoop entities, greetings/launch.rule:39-46) is never the launch-union winner: introductions/launch always also matches a self-identifying phrase and scores higher.",
      probe: { text: "it's me Mary", rules: ['launch'], observed: { intent: 'enrollment', union_original_fst_name: 'handle:introductions/launch' } },
      basis: 'UNKNOWN natively (no capture); observed in Phoenix.',
    },
    {
      id: 'N04b-copula-name-dropped',
      summary: 'The same enrolment through introductions/launch drops the parsed name when the self-identification uses the full copula ("it is me <name>") but keeps it for the contracted form ("it\'s me <name>").',
      probe: [
        { text: "it's me Mary", rules: ['launch'], observed: { intent: 'enrollment', GivenName: 'mary' } },
        { text: 'it is me Mary', rules: ['launch'], observed: { intent: 'enrollment', GivenName: '' } },
      ],
      basis: 'UNKNOWN natively; the vendored introductions/launch.rule is byte-identical to the pinned source, so this is AST arm-selection, not a source edit.',
    },
  ],
  namedRules: namedRuleRows,
  launchIntents,
  noInput,
  ambiguous,
  transcripts,
};
writeFileSync(new URL('../test/fixtures/identity-intro-greetings.json', import.meta.url), `${JSON.stringify(fixture, null, 1)}\n`);
console.log('wrote fixture');
console.log('namedRules', namedRuleRows.length, 'launchIntents', launchIntents.length, 'noInput', noInput.length, 'ambiguous', ambiguous.length, 'transcripts', transcripts.length, 'turns', transcripts.reduce((n, t) => n + t.turns.length, 0));
