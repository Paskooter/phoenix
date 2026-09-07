import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/grammar/parser.js';
import { matchRule, tokenize } from '../src/grammar/matcher.js';
import { parseRequest } from '../src/requestParser.js';

test('ordinary rule words retain source punctuation', () => {
  const grammar = parse("TopRule = (c.e.s.) {% Event='CES' %};");
  const context = { rules: grammar.rules };

  assert.deepEqual(
    matchRule(grammar.rules.TopRule, tokenize('c.e.s.'), context).entities,
    { Event: 'CES' },
  );
  assert.equal(matchRule(grammar.rules.TopRule, tokenize('ces'), context), null);
  assert.equal(matchRule(grammar.rules.TopRule, tokenize('c.e.s'), context), null);
});

test('source CES literal reaches public launch entities and intents', () => {
  const cases = [
    [
      'do you like c.e.s.',
      'doesJiboLikeThing',
      { Event: 'CES', union_original_fst_name: 'handle:chitchat/launch' },
    ],
    [
      'explain your experience at c.e.s.',
      'describeEvent',
      { Event: 'CES', union_original_fst_name: 'handle:chitchat/launch' },
    ],
    [
      "what's the number of people who attended c.e.s. back in winter of 2017",
      'howManyPeopleAttendEvent',
      { Event: 'CES', Year: '2017', union_original_fst_name: 'handle:chitchat/launch' },
    ],
  ];
  for (const [text, intent, entities] of cases) {
    assert.deepEqual(parseRequest({ text, rules: ['launch'] }), {
      rules: ['launch'], intent, entities,
    }, text);
  }
});

test('character-class optional punctuation remains a separate source construct', () => {
  const grammar = parse("TopRule = [u?.s?.] {% Event='US' %};");
  const context = { rules: grammar.rules };

  for (const text of ['us', 'u.s.', 'u.s']) {
    assert.equal(matchRule(grammar.rules.TopRule, tokenize(text), context).entities.Event, 'US', text);
  }
  assert.equal(matchRule(grammar.rules.TopRule, tokenize('u s'), context), null);
});
