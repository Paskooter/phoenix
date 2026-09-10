// N-02 acceptance 1: differential coverage of grammar execution — semantic
// actions, recursion, optional/repeated rules, wildcards, equivalents,
// locale/token normalization, weights and designated-loser ties.
//
// Expected behaviour is re-derived from the pinned native compiler/parser:
//   ConvTech/jibo-nlu@91b1bb6 compiler/compiler.ypp      (rule grammar)
//   ConvTech/jibo-nlu@91b1bb6 compiler/compiler.l        (word/special classes)
//   ConvTech/jibo-nlu@91b1bb6 compiler/list_manip.cpp    (add_optional/kleene/plus)
//   ConvTech/jibo-nlu@91b1bb6 parser/interpreter.cpp     (`_parsed`, nl operator)
//   jiboV2/pegasus@5c0a739 robustparser/RobustParserClient.ts (tie + designated losers)
import test from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/grammar/parser.js';
import { matchRule, tokenize } from '../src/grammar/matcher.js';
import { loadEqWords } from '../src/grammar/eqWords.js';
import { selectBestNative } from '../src/arbitration.js';

function run(grammar, input, ctx = {}) {
  const ast = parse(grammar);
  return matchRule(ast.rules.TopRule, tokenize(input), { rules: ast.rules, ...ctx });
}
function accepts(grammar, input, ctx) {
  const m = run(grammar, input, ctx);
  return m ? (m.entities.intent || true) : null;
}

// ---- 1. semantic actions -------------------------------------------------

test('semantic action: FST tag block assigns a literal entity', () => {
  assert.equal(accepts("TopRule = (hello){intent='greet'};", 'hello'), 'greet');
});

test('semantic action: {% %} block is treated as the same tag spec', () => {
  assert.equal(accepts("TopRule = (hello){% intent='greet' %};", 'hello'), 'greet');
});

test('semantic action: {key=_parsed} assigns the text this node matched', () => {
  // interpreter.cpp:33 seeds the reserved `_parsed` variable; nl_right accepts a
  // bare VARIABLE_OR_RULENAME (compiler.ypp), so `{k=_parsed}` is the matched
  // text and not the literal string "_parsed".
  const m = run("SUB @= (+$w){_slotAction=_parsed}; TopRule = ($w $SUB){out=SUB._slotAction}{intent='x'};", 'do the thing');
  assert.equal(m.entities.out, 'the thing');
});

test('semantic action: += appends onto the same key, = overwrites', () => {
  const m = run("TopRule = (a{_k='1'}{_k+='2'}{intent='x'});", 'a');
  assert.equal(m.subFields._k, '12');
});

// ---- 2. recursion --------------------------------------------------------

test('recursion: a rule may reference itself and still match', () => {
  const grammar = "A = (a ?$A) | (b); TopRule = $A{intent='rec'};";
  assert.equal(accepts(grammar, 'a a a b'), 'rec');
  assert.equal(accepts(grammar, 'b'), 'rec');
  assert.equal(accepts(grammar, 'b a'), null);
});

test('recursion: runaway self-reference is bounded by maxDepth instead of hanging', () => {
  const ast = parse("A = ($A); TopRule = $A{intent='loop'};");
  const started = Date.now();
  const m = matchRule(ast.rules.TopRule, tokenize('x'), { rules: ast.rules, maxDepth: 40 });
  assert.equal(m, null);
  assert.ok(Date.now() - started < 2000, 'depth cap stops the walk');
});

// ---- 3. optional rules ---------------------------------------------------

test('optional: ?X admits zero and one occurrence', () => {
  const grammar = "TopRule = (set ?a timer){intent='opt'};";
  assert.equal(accepts(grammar, 'set timer'), 'opt');
  assert.equal(accepts(grammar, 'set a timer'), 'opt');
  assert.equal(accepts(grammar, 'set a a timer'), null);
});

test('optional: ?X at the head of a group keeps the group optional', () => {
  const grammar = "TopRule = ((?please) go){intent='p'};";
  assert.equal(accepts(grammar, 'go'), 'p');
  assert.equal(accepts(grammar, 'please go'), 'p');
});

// ---- 4. repeated rules ---------------------------------------------------

test('repeated: *X reproduces zero or more times (native add_kleene)', () => {
  // compiler.ypp `'*' rulecontent {lm::add_kleene($2);}`, list_manip.cpp:205.
  const grammar = "Y = (y); TopRule = (x *$Y z){intent='star'};";
  assert.equal(accepts(grammar, 'x z'), 'star');
  assert.equal(accepts(grammar, 'x y z'), 'star');
  assert.equal(accepts(grammar, 'x y y y z'), 'star');
});

test('repeated: +X requires at least one occurrence (native add_plus_kleene)', () => {
  const grammar = "Y = (y); TopRule = (x +$Y z){intent='plus'};";
  assert.equal(accepts(grammar, 'x z'), null);
  assert.equal(accepts(grammar, 'x y z'), 'plus');
  assert.equal(accepts(grammar, 'x y y z'), 'plus');
});

test('repeated: $wNN caps the repetition count (native bounded word factory)', () => {
  const grammar = "TopRule = (a $w02 c){intent='bounded'};";
  assert.equal(accepts(grammar, 'a one two c'), 'bounded');
  assert.equal(accepts(grammar, 'a one two three c'), null);
});

// ---- 5. wildcards --------------------------------------------------------

test('wildcard: $* spans any number of words inside a literal frame', () => {
  const grammar = "TopRule = (play $* song){intent='w'};";
  assert.equal(accepts(grammar, 'play song'), 'w');
  assert.equal(accepts(grammar, 'play me a song'), 'w');
});

test('wildcard: $w is exactly one word', () => {
  const grammar = "TopRule = ($w end){intent='one'};";
  assert.equal(accepts(grammar, 'one end'), 'one');
  assert.equal(accepts(grammar, 'one two end'), null);
});

// ---- 6. equivalents ------------------------------------------------------

test('equivalents: !use_equivalent_words makes homophones match (via the eq map)', () => {
  const eq = loadEqWords();
  const grammar = "TopRule = (set a timer for two minutes){intent='eq'};";
  assert.equal(accepts(grammar, 'set a timer for two minutes', { eq }), 'eq');
  assert.equal(accepts(grammar, 'set a timer for too minutes', { eq }), 'eq');
  // Without the directive the equivalence map is not consulted.
  assert.equal(accepts(grammar, 'set a timer for too minutes'), null);
});

// ---- 7. locale / token normalization -------------------------------------

test('normalization: input is lowercased and non-ASCII words are ordinary tokens', () => {
  // compiler.l nospecialchars admits every non-special byte, including accents.
  assert.equal(accepts("TopRule = (québec){intent='qc'};", 'québec'), 'qc');
  assert.equal(accepts("TopRule = (québec){intent='qc'};", 'Québec'), 'qc');
  assert.equal(accepts("TopRule = (hello){intent='hi'};", 'HELLO'), 'hi');
});

test('normalization: a bare & is a word character, not an operator', () => {
  // The native scanner's specialchars set excludes &, so it is an ordinary word
  // token. factory_rules/timer.grm relies on this with `?(and|&)`.
  const grammar = "TopRule = (rock ?(and|&) roll){intent='rnr'};";
  assert.equal(accepts(grammar, 'rock & roll'), 'rnr');
  assert.equal(accepts(grammar, 'rock and roll'), 'rnr');
  assert.equal(accepts(grammar, 'rock roll'), 'rnr');
  // `&` inside a word stays part of that word (radio-station rule spelling).
  assert.equal(accepts("TopRule = (r&b){intent='rnb'};", 'R&B'), 'rnb');
});

// ---- 8. weights ----------------------------------------------------------

test('weights: a <N> heuristic charges source bytes and loses to an unweighted arm', () => {
  // compiler.ypp HEURISTIC_PER_CHAR; result_fst.cpp scores length - heuristic.
  const grammar = "TopRule = ((<1.0>alpha beta<0.0>){intent='weighted'}|(alpha beta){intent='plain'});";
  assert.equal(accepts(grammar, 'alpha beta'), 'plain');
});

test('weights: an explicit ~N arc cost demotes its alternative', () => {
  const grammar = "TopRule = ((a b)~1{intent='costly'}|(a b){intent='cheap'});";
  assert.equal(accepts(grammar, 'a b'), 'cheap');
});

// ---- 9. designated-loser ties --------------------------------------------

test('designated losers: a tie drops launch/globals only when a non-loser tied', () => {
  // RobustParserClient.ts:19,281-283 — the loser filter runs only on a tie and
  // only when a non-loser is present.
  const winner = selectBestNative([
    { rule: 'launch', score: 8, intent: 'launch-arm' },
    { rule: 'clock/launch', score: 8, intent: 'clock-arm' },
  ]);
  assert.equal(winner.intent, 'clock-arm');
  const sole = selectBestNative([{ rule: 'launch', score: 8, intent: 'launch-arm' }]);
  assert.equal(sole.intent, 'launch-arm');
});

test('designated losers: a strictly higher score wins before the tie rule applies', () => {
  const winner = selectBestNative([
    { rule: 'launch', score: 9, intent: 'launch-arm' },
    { rule: 'clock/launch', score: 8, intent: 'clock-arm' },
  ]);
  assert.equal(winner.intent, 'launch-arm');
});
