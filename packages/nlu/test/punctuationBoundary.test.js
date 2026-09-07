import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRequest } from '../src/requestParser.js';

const launch = text => parseRequest({ text, rules: ['launch'] });

test('preserves public punctuation bytes before source grammar matching', () => {
  // ParseRequestHandler trims and RobustParserClient lowercases the request;
  // neither source layer removes punctuation. Commas between words therefore
  // prevent the HIGH language rule from matching and leave the LOW GQA result.
  assert.deepEqual(launch('what languages, do, you, speak'), {
    rules: ['launch'],
    intent: 'generalWhatQuestions',
    entities: { union_original_fst_name: 'handle:chitchat/launch' },
  });
  assert.deepEqual(launch('what languages do you speak'), {
    rules: ['launch'],
    intent: 'whichLanguagesCabJiboSpeak',
    entities: { union_original_fst_name: 'handle:chitchat/launch' },
  });
});

test('punctuation changes remain visible to native-like matching', () => {
  assert.deepEqual(launch('what, are, you doing'), {
    rules: [],
    intent: null,
    entities: null,
  });
  assert.deepEqual(launch('are you depressed?'), {
    rules: ['launch'],
    intent: 'idle',
    entities: { union_original_fst_name: 'handle:chitchat/launch' },
  });
  assert.deepEqual(launch('are you depressed'), {
    rules: ['launch'],
    intent: 'isJiboDescriptor',
    entities: {
      GeneralDescriptor: 'Depressed',
      union_original_fst_name: 'handle:chitchat/launch',
    },
  });
});
