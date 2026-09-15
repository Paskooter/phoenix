// The answer skill must answer inside the gateway's skill budget.
//
// A skill that waits longer than its caller cannot produce a late answer: the
// gateway has already failed the transaction with TIMEOUT_SKILL, so the
// graceful "I'm not sure about that one." never reaches the robot and the user
// hears an error instead of speech. answerSkill previously waited 12 s against
// a 10 s budget.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Timeouts } from '@phoenix/contracts';
import { answerSkill, ANSWER_LLM_TIMEOUT_MS } from '../src/answerSkill.js';

test('the answer LLM budget fits inside the gateway skill budget', () => {
  assert.ok(
    ANSWER_LLM_TIMEOUT_MS < Timeouts.skill,
    `answer budget ${ANSWER_LLM_TIMEOUT_MS} must be under the skill budget ${Timeouts.skill}`,
  );
});

test('a hanging LLM still yields spoken output before the caller gives up', async (t) => {
  // A backend that accepts the request and never answers — the shape of the
  // failure that matters, since a refused connection fails fast on its own.
  const hanging = createServer(() => { /* never respond */ });
  hanging.listen(0, '127.0.0.1');
  await once(hanging, 'listening');
  const { port } = hanging.address();
  t.after(() => new Promise((resolve) => hanging.close(resolve)));

  const previous = { url: process.env.PHOENIX_LLM_URL, key: process.env.PHOENIX_LLM_API_KEY };
  process.env.PHOENIX_LLM_URL = `http://127.0.0.1:${port}`;
  process.env.PHOENIX_LLM_API_KEY = 'test-key';
  t.after(() => {
    if (previous.url === undefined) delete process.env.PHOENIX_LLM_URL;
    else process.env.PHOENIX_LLM_URL = previous.url;
    if (previous.key === undefined) delete process.env.PHOENIX_LLM_API_KEY;
    else process.env.PHOENIX_LLM_API_KEY = previous.key;
  });

  const started = Date.now();
  const action = await answerSkill({
    data: { result: { asr: { text: 'who is the owner of spacex' } } },
  });
  const elapsed = Date.now() - started;

  assert.ok(elapsed < Timeouts.skill, `took ${elapsed}ms, over the ${Timeouts.skill}ms skill budget`);
  const spoken = JSON.stringify(action);
  assert.match(spoken, /I'm not sure about that one\./);
});
