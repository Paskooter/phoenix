// N-08 / N-03 — conditional `{% if %}` semantic actions.
//
// The pinned rule sources carry five conditional action blocks, in five files:
//   clock/alarm_timer_change.rule:11-14        yes -> delete,   no -> keep
//   clock/alarm_timer_other_set.rule:11-14     yes -> replace,  no -> keep
//   greetings/proactive_general_question:22-25 yes -> good,     no -> bad
//   greetings/proactive_playful_question:22-25 yes -> good,     no -> bad
//   word-of-the-day/right_word.rule:17-20      yes -> agreement,no -> disagreement
//
// The native cloud executes these through the interpreter's V8 action scope at
// rule exit (ConvTech/jibo-nlu@91b1bb6 parser/interpreter.cpp), after the plain
// assignments of the same block. An earlier N-03 investigation found the Phoenix
// rule loader dropped them entirely; this test pins that they are now executed,
// for every one of the five source sites, through the HTTP request entry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRequest } from '../src/requestParser.js';

const intentOf = (rule, text) => parseRequest({ text, rules: [rule] }).intent;

test('N-08 conditional actions: clock/alarm_timer_change yes/no rename the intent', () => {
  // ALARMTIMERCHANGE's own $YES/$NO arms already carry delete/keep, so the
  // conditional must be a no-op for them and only remap the factory's yes/no.
  assert.equal(intentOf('clock/alarm_timer_change', 'yes'), 'delete');
  assert.equal(intentOf('clock/alarm_timer_change', 'no'), 'keep');
  assert.equal(intentOf('clock/alarm_timer_change', 'trash it'), 'delete');
  assert.equal(intentOf('clock/alarm_timer_change', 'keep it'), 'keep');
  assert.equal(intentOf('clock/alarm_timer_change', 'sure'), 'delete');
});

test('N-08 conditional actions: clock/alarm_timer_other_set yes/no rename the intent', () => {
  assert.equal(intentOf('clock/alarm_timer_other_set', 'yes'), 'replace');
  assert.equal(intentOf('clock/alarm_timer_other_set', 'no'), 'keep');
  assert.equal(intentOf('clock/alarm_timer_other_set', 'cancel it'), 'replace');
});

test('N-08 conditional actions: the greetings proactive questions remap yes/no', () => {
  for (const rule of ['greetings/proactive_general_question', 'greetings/proactive_playful_question']) {
    assert.equal(intentOf(rule, 'yes'), 'good', rule);
    assert.equal(intentOf(rule, 'no'), 'bad', rule);
    // A non-yes/no arm is untouched by the conditional.
    assert.equal(intentOf(rule, 'awesome'), 'good', rule);
    assert.equal(intentOf(rule, 'not today'), 'bad', rule);
    assert.equal(intentOf(rule, 'so so'), 'soSo', rule);
  }
});

test('N-08 conditional actions: word-of-the-day/right_word remaps yes/no', () => {
  assert.equal(intentOf('word-of-the-day/right_word', 'yes'), 'agreement');
  assert.equal(intentOf('word-of-the-day/right_word', 'no'), 'disagreement');
  assert.equal(intentOf('word-of-the-day/right_word', 'that sounds right'), 'agreement');
  assert.equal(intentOf('word-of-the-day/right_word', 'you are wrong'), 'disagreement');
  assert.equal(intentOf('word-of-the-day/right_word', 'yay'), 'celebration');
});
