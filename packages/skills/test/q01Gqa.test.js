import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { readFileSync } from 'node:fs';
import { createService } from '@phoenix/common';
import { gqaBannedWordPresent } from '../src/gqaBannedWords.js';
import {
  buildGqaSlimFromMim,
  buildGqaSlimFromText,
  cleanGqaInput,
  createGqaProviderPipeline,
  createGqaAnswerSkill,
  createGqaHttpRoute,
  GQA_MISSING_TRANSID_HTML,
  GQA_BAD_REQUEST_HTML,
  gqaPiiFilter,
  getGqaQuestionType,
  gqaMimPromptIds,
} from '../src/gqaAnswerSkill.js';

function sourceRequest({ text = 'what is a fixture fact', intent = 'generalWhatQuestions', mimId } = {}) {
  return {
    type: 'LISTEN_LAUNCH',
    msgID: 'fixture-request',
    ts: 1700000000000,
    data: {
      general: {
        accountID: 'fixture-account',
        robotID: 'fixture-robot',
        lang: 'en',
        remoteAddress: '127.0.0.1',
      },
      runtime: {
        location: { lat: 42.1, lng: -71.2, countryCode: 'US' },
      },
      skill: null,
      result: {
        nlu: { intent, entities: mimId ? { mimId } : {} },
        asr: { text, confidence: 1 },
      },
    },
  };
}

function idFactory() {
  let next = 1;
  return () => String(next++).padStart(32, '0');
}

function clockFactory(values) {
  const remaining = [...values];
  return () => remaining.shift();
}

test('Q-01 blocked-term matching agrees with 473 original Python 3.6 results', () => {
  // Captured by executing banned_words.py from srv-gqa-ws@ebe1a7d in the
  // pinned Python 3.6.15 runtime, independently of the JavaScript matcher.
  const reference = JSON.parse(readFileSync(new URL('./fixtures/gqa-banned-source-python36.json', import.meta.url), 'utf8'));
  assert.equal(reference.rows.length, 473);
  for (const row of reference.rows) {
    assert.equal(gqaBannedWordPresent(row.input), row.expected, JSON.stringify(row.input));
  }
});

test('Q-01 blocked-term response follows IP and PII checks and suppresses provider calls', async () => {
  let calls = 0;
  const handler = createGqaAnswerSkill({
    rng: () => 0,
    provider: async () => { calls += 1; return {}; },
  });
  const blocked = sourceRequest({ text: 'what is fuck' });
  const missingIp = sourceRequest({ text: 'what is fuck' });
  missingIp.data.general.remoteAddress = '';
  const pii = sourceRequest({ text: 'fuck fixture@example.com' });
  for (const [request, prompt] of [
    [blocked, 'GQA_banned_word_01'],
    [missingIp, 'GQA_error_01'],
    [pii, 'GQA_pii_filter_AN_01'],
  ]) {
    const response = await handler(request);
    assert.equal(response.data.action.config.jcp.config.play.meta.prompt_id, prompt);
    assert.equal(response.data.final, true);
    assert.equal(response.data.fireAndForget, true);
    assert.deepEqual(response.data.analytics.answer[1].properties, { success: false });
  }
  assert.equal(calls, 0);
});

test('Q-01 provider result shapes retain original HTTP status and action selection', async () => {
  // These eight result objects were passed through the original Flask 0.12.2
  // gqa_pegasus/choose_slim/500-handler boundary in Python 3.6.15. The odd
  // array payload is source behavior; this test does not claim it is playable.
  const cases = [
    { output: { source: 'Wikipedia', response: { payload: 'Control answer' } }, status: 200, esml: 'Control answer.', prompt: 'Wikipedia' },
    { output: {}, status: 200, prompt: 'GQA_no_answer_what_01' },
    { output: { message: 'fixture service error' }, status: 200, prompt: 'GQA_error_01' },
    { output: { source: 'Wikipedia', response: { payload: 42 } }, status: 500 },
    { output: { source: 'Wikipedia', response: { payload: { value: 'control' } } }, status: 500 },
    { output: { source: 'Wikipedia', response: { payload: ['control'] } }, status: 200, esml: ['control', '.'], prompt: 'Wikipedia' },
    { output: { response: { payload: 'Control answer.' } }, status: 500 },
    { output: { response: null }, status: 500 },
  ];
  const handler = createGqaAnswerSkill({
    rng: () => 0,
    provider: async ({ request }) => structuredClone(cases[request.msgID].output),
  });
  const service = createService({
    name: 'q01-gqa-provider-result-boundary',
    routes: { 'POST /answer_skill/v1/main': createGqaHttpRoute({ handler }) },
  });
  const server = await service.listen(0);
  try {
    for (const [index, control] of cases.entries()) {
      const request = sourceRequest();
      request.msgID = String(index);
      const response = await fetch(`http://127.0.0.1:${server.address().port}/answer_skill/v1/main`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-jibo-transid': 'fixture-trans' },
        body: JSON.stringify(request),
      });
      assert.equal(response.status, control.status, `provider result ${index}`);
      const body = JSON.parse(await response.text());
      if (control.status === 500) {
        assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8');
        assert.deepEqual(Object.keys(body).sort(), ['message', 'stacktrace', 'version']);
        assert.equal(body.version, '5.2.15');
        assert.equal(typeof body.message, 'string');
        assert.equal(typeof body.stacktrace, 'string');
        continue;
      }
      assert.equal(body.type, 'SKILL_ACTION');
      assert.deepEqual(body.data.skill, { id: 'answer', version: '5.2.15' });
      assert.equal(body.data.final, true);
      assert.equal(body.data.fireAndForget, true);
      const play = body.data.action.config.jcp.config.play;
      assert.equal(play.meta.prompt_id, control.prompt);
      if (Object.hasOwn(control, 'esml')) assert.deepEqual(play.esml, control.esml);
      assert.equal(typeof body.timings.total, 'number');
      assert.equal(typeof body.timings.initialization_part, 'number');
      assert.equal(typeof body.timings.finalization_part, 'number');
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('Q-01 success follows source SLIM, analytics and provider context contract', async () => {
  const seen = [];
  const handler = createGqaAnswerSkill({
    skillId: 'answer',
    idFactory: idFactory(),
    messageId: () => '00000000-0000-0000-0000-000000000001',
    clock: clockFactory([1000, 1007]),
    provider: async (context) => {
      seen.push(context);
      return {
        source: 'Bing',
        type: 'entities',
        url: 'https://fixture.invalid/result',
        response: { type: 'string', payload: 'A fixture answer' },
        timings: { bing: 0.006 },
      };
    },
  });

  const response = await handler(sourceRequest());
  assert.equal(response.type, 'SKILL_ACTION');
  assert.equal(response.msgID, '00000000-0000-0000-0000-000000000001');
  assert.deepEqual(response.data.skill, { id: 'answer', version: '5.2.15' });
  assert.equal(response.data.action.type, 'JCP');
  assert.equal(response.data.action.config.version, '2.0');
  assert.equal(response.data.action.config.jcp.type, 'SLIM');
  assert.equal(response.data.action.config.jcp.config.play.esml, 'A fixture answer.');
  assert.deepEqual(response.data.action.config.jcp.config.play.meta, { prompt_id: 'Bing' });
  assert.equal(response.data.action.config.jcp.config.display, undefined);
  assert.equal(response.data.final, true);
  assert.equal(response.data.fireAndForget, true);
  assert.equal(response.data.analytics.answer[0].event, 'Skill Entry');
  assert.deepEqual(response.data.analytics.answer[1], {
    event: 'Answer Query',
    properties: { success: true, type: 'bing', category: 'entities' },
  });
  assert.equal(response.timings.bing, 0.006);
  assert.equal(response.timings.total, 7);
  assert.deepEqual(seen[0], {
    request: sourceRequest(),
    queryText: 'what is a fixture fact',
    questionType: 'what',
    latitude: '42.1',
    longitude: '-71.2',
    countryCode: 'US',
    ipAddress: '127.0.0.1',
    accountId: 'fixture-account',
  });
});

test('Q-01 empty provider result selects a source no-answer MIM and display', async () => {
  const handler = createGqaAnswerSkill({
    idFactory: idFactory(),
    messageId: () => 'response-id',
    clock: clockFactory([10, 14]),
    // First draw selects the question-specific branch, second selects the
    // first source prompt. This keeps the test deterministic without replacing
    // the production weighted selection.
    rng: (() => {
      const draws = [0.1, 0];
      return () => draws.shift();
    })(),
    provider: async () => ({}),
  });

  const response = await handler(sourceRequest({ text: 'what is a fixture fact' }));
  const slim = response.data.action.config.jcp;
  assert.equal(slim.type, 'SLIM');
  assert.equal(slim.config.play.meta.prompt_id, 'GQA_no_answer_what_01');
  assert.equal(slim.config.play.esml, "I can't seem to find what this is. Sorry.");
  assert.equal(slim.config.display.type, 'DISPLAY');
  assert.equal(slim.config.display.name, 'GQA_NO_ANSWER_VIEW');
  assert.equal(slim.config.display.view.name, 'MIM_VIEW');
  assert.equal(slim.config.display.view.context.type, 'Javascript');
  assert.equal(slim.config.display.view.context.data, '{"componentConfigs": [{"id": "bottom", "type": "Label", "text": "\\"what is a fixture fact\\"", "style": {"fontSize": "120", "fontFamily": "Proxima Nova Soft", "fontStyle": "bold", "fill": "#b6b6c2", "wordWrap": true, "wordWrapWidth": 1240, "align": "center"}, "position": {"x": 640.0, "y": 360.0}, "targetAnchor": {"x": 0.5, "y": 0.5}}], "viewConfig": {"type": "View", "id": "helpful_gqa_text"}, "open": {"transitionOpen": "trans_in", "removeAll": true}}');
  assert.deepEqual(response.data.analytics.answer[1], {
    event: 'Answer Query',
    properties: { success: false },
  });
});

test('Q-01 thrown provider failure follows source no-answer fallback', async () => {
  const handler = createGqaAnswerSkill({
    idFactory: idFactory(),
    messageId: () => 'response-id',
    clock: clockFactory([20, 21]),
    rng: () => 0,
    provider: async () => { throw new Error('fixture provider unavailable'); },
  });

  const response = await handler(sourceRequest({ text: 'who is a fixture person', intent: 'generalWhoQuestions' }));
  const slim = response.data.action.config.jcp;
  assert.equal(slim.config.play.meta.prompt_id, 'GQA_no_answer_who_01');
  assert.equal(slim.config.display.type, 'DISPLAY');
  assert.deepEqual(response.data.analytics.answer[1], {
    event: 'Answer Query',
    properties: { success: false },
  });
  assert.equal(JSON.stringify(response).includes('fixture provider unavailable'), false);
});

test('Q-01 explicit provider message remains the source GQA_error contract', async () => {
  const handler = createGqaAnswerSkill({
    idFactory: idFactory(),
    messageId: () => 'response-id',
    rng: () => 0,
    provider: async () => ({ message: 'fixture provider unavailable' }),
  });

  const response = await handler(sourceRequest({ text: 'who is a fixture person', intent: 'generalWhoQuestions' }));
  const slim = response.data.action.config.jcp;
  assert.equal(slim.config.play.meta.prompt_id, 'GQA_error_01');
  assert.match(slim.config.play.esml, /sources/);
  assert.equal(slim.config.display, null);
  assert.equal(JSON.stringify(response).includes('fixture provider unavailable'), false);
});

test('Q-01 provider pipeline preserves source fallback order and private failures', async () => {
  const calls = [];
  const pipeline = createGqaProviderPipeline({
    providers: {
      Bing: async () => {
        calls.push('Bing');
        throw new Error('Bing unavailable');
      },
      Wikipedia: async () => {
        calls.push('Wikipedia');
        return {};
      },
      'Wolfram Alpha': async () => {
        calls.push('Wolfram Alpha');
        return {
          source: 'Wolfram Alpha',
          response: { type: 'string', payload: 'A computed fixture answer.' },
        };
      },
    },
  });
  const output = await pipeline({ queryText: 'fixture' });
  assert.deepEqual(calls, ['Bing', 'Wikipedia', 'Wolfram Alpha']);
  assert.equal(output.source, 'Wolfram Alpha');
});

test('Q-01 provider pipeline rejects an incomplete adapter inventory', () => {
  assert.throws(
    () => createGqaProviderPipeline({ providers: { Bing: async () => ({}) } }),
    /Missing GQA provider adapter: Wikipedia/,
  );
});

test('Q-01 provider pipeline advances at the source group deadline and keeps late priority', async () => {
  const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  const calls = [];
  const pipeline = createGqaProviderPipeline({
    providers: {
      Bing: async () => {
        calls.push('Bing:start');
        await sleep(45);
        calls.push('Bing:done');
        return { source: 'Bing', response: { payload: 'late priority answer' } };
      },
      Wikipedia: async () => {
        calls.push('Wikipedia:start');
        return {};
      },
      'Wolfram Alpha': async () => {
        calls.push('Wolfram Alpha:start');
        await sleep(80);
        return { source: 'Wolfram Alpha', response: { payload: 'fallback answer' } };
      },
    },
    // The source values are 3s/4s. Short values keep this regression bounded;
    // the production defaults remain unchanged and are exercised separately.
    timeouts: [25, 100],
  });
  const started = Date.now();
  const output = await pipeline({ queryText: 'fixture' });
  const elapsed = Date.now() - started;
  assert.equal(output.source, 'Bing');
  assert.ok(elapsed >= 35 && elapsed < 90, `unexpected elapsed ${elapsed}ms`);
  assert.deepEqual(calls, [
    'Bing:start', 'Wikipedia:start', 'Wolfram Alpha:start', 'Bing:done',
  ]);
});

test('Q-01 provider pipeline uses the next group after both first-group workers time out', async () => {
  const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  const calls = [];
  const pipeline = createGqaProviderPipeline({
    providers: {
      Bing: async () => { calls.push('Bing'); await sleep(70); return {}; },
      Wikipedia: async () => { calls.push('Wikipedia'); await sleep(80); return {}; },
      'Wolfram Alpha': async () => { calls.push('Wolfram Alpha'); return { source: 'Wolfram Alpha', response: { payload: 'fallback' } }; },
    },
    timeouts: [20, 100],
  });
  const started = Date.now();
  const output = await pipeline({ queryText: 'fixture' });
  const elapsed = Date.now() - started;
  assert.equal(output.source, 'Wolfram Alpha');
  assert.ok(elapsed >= 15 && elapsed < 60, `unexpected elapsed ${elapsed}ms`);
  assert.deepEqual(calls, ['Bing', 'Wikipedia', 'Wolfram Alpha']);
});

test('Q-01 request blocks match source IP and PII ordering before providers', async () => {
  const calls = [];
  const provider = async () => {
    calls.push('provider');
    return { source: 'Bing', response: { type: 'string', payload: 'unexpected' } };
  };
  const missingIp = sourceRequest();
  missingIp.data.general.remoteAddress = '';
  const ipHandler = createGqaAnswerSkill({ provider, rng: () => 0, idFactory: idFactory(), messageId: () => 'response-id' });
  const ipResponse = await ipHandler(missingIp);
  assert.equal(ipResponse.data.action.config.jcp.config.play.meta.prompt_id, 'GQA_error_01');

  const pii = sourceRequest({ text: 'email fixture@example.com' });
  const piiHandler = createGqaAnswerSkill({ provider, rng: () => 0, idFactory: idFactory(), messageId: () => 'response-id' });
  const piiResponse = await piiHandler(pii);
  assert.equal(piiResponse.data.action.config.jcp.config.play.meta.prompt_id, 'GQA_pii_filter_AN_01');
  assert.equal(calls.length, 0);
  assert.equal(gqaPiiFilter('fixture@example.com'), true);
  assert.equal(gqaPiiFilter('ordinary fixture text'), false);
});

test('Q-01 exposes the source scripted question mapping and full MIM inventories', () => {
  assert.equal(getGqaQuestionType(sourceRequest({ intent: 'scripted', mimId: 'KU_WhereIsMy' })), 'where');
  assert.equal(getGqaQuestionType(sourceRequest({ intent: 'scripted', mimId: 'unknown' })), 'generic');
  assert.equal(cleanGqaInput('Hey Jibo, what is a fixture?'), 'what is a fixture');
  assert.equal(gqaMimPromptIds('GQA_error').length, 9);
  assert.equal(gqaMimPromptIds('GQA_banned_word').length, 4);
  assert.equal(gqaMimPromptIds('GQA_no_answer_generic').length, 24);
  assert.equal(gqaMimPromptIds('GQA_no_answer_how').length, 4);
  assert.equal(gqaMimPromptIds('GQA_no_answer_what').length, 3);
  assert.equal(gqaMimPromptIds('GQA_no_answer_when').length, 5);
  assert.equal(gqaMimPromptIds('GQA_no_answer_where').length, 4);
  assert.equal(gqaMimPromptIds('GQA_no_answer_which').length, 4);
  assert.equal(gqaMimPromptIds('GQA_no_answer_who').length, 12);
  assert.equal(gqaMimPromptIds('GQA_no_answer_why').length, 5);
});

test('Q-01 source provider failures remain a normal SKILL_ACTION through the HTTP skill route', async () => {
  const route = createGqaHttpRoute({ handler: createGqaAnswerSkill({ rng: () => 0, idFactory: idFactory(), messageId: () => 'response-id' }) });
  const response = await route({ body: sourceRequest(), req: { headers: { 'x-jibo-transid': 'fixture-trans' } }, trace: {}, log: { error() {} } });
  assert.equal(response.type, 'SKILL_ACTION');
  assert.equal(response.data.skill.id, 'answer');
  assert.equal(response.data.action.config.jcp.config.play.meta.prompt_id, 'GQA_no_answer_what_01');
  assert.equal(typeof response.timings.total, 'number');
});

test('Q-01 low-level builders keep source id order and source metadata', () => {
  const ids = idFactory();
  const slim = buildGqaSlimFromText('A fixture answer.', 'Bing', ids);
  assert.equal(slim.id, '00000000000000000000000000000002');
  assert.equal(slim.config.play.id, '00000000000000000000000000000001');
  assert.deepEqual(slim.config.play.meta, { prompt_id: 'Bing' });

  const mim = buildGqaSlimFromMim('GQA_error', undefined, { rng: () => 0, idFactory: idFactory() });
  assert.equal(mim.config.display, null);
  assert.equal(mim.config.play.meta.prompt_id, 'GQA_error_01');
});

test('Q-01 GQA HTTP adapter rejects missing transID before the handler with source status/body', async () => {
  let calls = 0;
  const route = createGqaHttpRoute({
    handler: async () => {
      calls += 1;
      return { type: 'SKILL_ACTION' };
    },
  });
  const state = { statusCode: null, contentType: null, body: null };
  const response = {
    status(status) {
      state.statusCode = status;
      return this;
    },
    type(contentType) {
      state.contentType = contentType;
      return this;
    },
    send(body) {
      state.body = body;
      return this;
    },
  };

  const result = await route({
    body: sourceRequest(),
    req: { headers: {} },
    res: response,
  });
  assert.equal(result, undefined);
  assert.equal(calls, 0);
  assert.equal(state.statusCode, 400);
  assert.equal(state.contentType, 'html');
  assert.equal(state.body, GQA_MISSING_TRANSID_HTML);
});

test('Q-01 GQA HTTP adapter preserves the first duplicate/empty transID and handler timings', async () => {
  let seen;
  const route = createGqaHttpRoute({
    handler: async (body) => {
      seen = body;
      return { type: 'SKILL_ACTION', data: {}, timings: { total: 12, bing: 0.007, initialization_part: 0.001, finalization_part: 0.004 } };
    },
  });
  const body = sourceRequest();
  const response = await route({
    body,
    req: { headers: { 'X-JIBO-transID': ['first-transID', 'second-transID'] } },
    trace: {},
    log: { error() {} },
  });
  assert.equal(seen, body);
  assert.deepEqual(seen.transID, ['first-transID']);
  assert.equal(response.type, 'SKILL_ACTION');
  assert.deepEqual(response.timings, { total: 12, bing: 0.007, initialization_part: 0.001, finalization_part: 0.004 });

  const emptyHeaderBody = sourceRequest();
  const emptyResponse = await route({
    body: emptyHeaderBody,
    req: { headers: { 'x-jibo-transid': '' } },
    trace: {},
    log: { error() {} },
  });
  assert.deepEqual(emptyHeaderBody.transID, ['']);
  assert.equal(emptyResponse.type, 'SKILL_ACTION');
});

test('Q-01 GQA HTTP adapter reads duplicate transID fields like Flask getlist', async () => {
  const service = createService({
    name: 'q01-gqa-duplicate-transid',
    routes: {
      'POST /v1/answer/main': createGqaHttpRoute({
        handler: async (body) => ({ observedTransID: body.transID }),
      }),
    },
  });
  const server = await service.listen(0);
  try {
    const port = server.address().port;
    const response = await new Promise((resolve, reject) => {
      const request = httpRequest({
        host: '127.0.0.1', port, path: '/v1/answer/main', method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-jibo-transid': ['first-transID', 'second-transID'],
        },
      }, (incoming) => {
        const chunks = [];
        incoming.on('data', (chunk) => chunks.push(chunk));
        incoming.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
      });
      request.on('error', reject);
      request.end(JSON.stringify(sourceRequest()));
    });
    assert.deepEqual(response.observedTransID, ['first-transID']);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('Q-01 GQA HTTP adapter exposes a status-coded error for direct callers without a response', async () => {
  const route = createGqaHttpRoute({ handler: async () => ({ type: 'SKILL_ACTION' }) });
  await assert.rejects(
    route({ body: sourceRequest(), req: { headers: {} } }),
    (error) => error instanceof Error
      && error.statusCode === 400
      && error.message === 'Missing X-JIBO-transID header',
  );
});

test('Q-01 GQA HTTP adapter preserves source analytics-before-header failure order', async () => {
  const route = createGqaHttpRoute({ handler: async () => ({ type: 'SKILL_ACTION' }) });
  const state = { statusCode: null, contentType: null, body: null };
  const response = {
    status(status) { state.statusCode = status; return this; },
    type(type) { state.contentType = type; return this; },
    send(body) { state.body = body; return this; },
  };

  // Source analytics indexes request["type"] before getlist(transID), so an
  // empty object with no header is a 500 rather than the missing-header 400.
  await route({ body: {}, req: { headers: {} }, res: response });
  assert.equal(state.statusCode, 500);
  assert.equal(state.contentType, 'html');
  assert.match(state.body, /Missing GQA request field type/);

  // Once type exists, a malformed data tree reaches the header branch first.
  state.statusCode = null;
  state.body = null;
  await route({ body: { type: 'LISTEN_LAUNCH', data: null }, req: { headers: {} }, res: response });
  assert.equal(state.statusCode, 400);
  assert.equal(state.body, GQA_MISSING_TRANSID_HTML);
});

test('Q-01 GQA HTTP adapter accepts source primitive JSON then exposes its 500 body branch', async () => {
  const service = createService({
    name: 'q01-gqa-source-json-shapes',
    routes: {
      'POST /v1/answer/main': createGqaHttpRoute({ handler: async () => ({ type: 'SKILL_ACTION' }) }),
    },
  });
  const server = await service.listen(0);
  try {
    const port = server.address().port;
    for (const [label, body] of [['null', 'null'], ['array', '[]'], ['number', '1']]) {
      const response = await fetch(`http://127.0.0.1:${port}/v1/answer/main`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-jibo-transid': 'fixture-trans' },
        body,
      });
      assert.equal(response.status, 500, label);
      const payload = await response.text();
      assert.match(payload, /GQA request JSON must be an object/);
    }

    const empty = await fetch(`http://127.0.0.1:${port}/v1/answer/main`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-jibo-transid': 'fixture-trans' },
      body: '',
    });
    assert.equal(empty.status, 400);
    assert.equal(empty.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(await empty.text(), GQA_BAD_REQUEST_HTML);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('Q-01 GQA HTTP adapter preserves 400 framing through the common service transport', async () => {
  let handlerCalls = 0;
  const service = createService({
    name: 'q01-gqa-http-boundary',
    routes: {
      'POST /v1/answer/main': createGqaHttpRoute({
        handler: async () => {
          handlerCalls += 1;
          return { type: 'SKILL_ACTION' };
        },
      }),
    },
  });
  const server = await service.listen(0);
  try {
    const port = server.address().port;
    const response = await fetch(`http://127.0.0.1:${port}/v1/answer/main`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(sourceRequest()),
    });
    assert.equal(response.status, 400);
    assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(await response.text(), GQA_MISSING_TRANSID_HTML);
    assert.equal(handlerCalls, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// Generated once by executing the recovered Python functions, rather than
// deriving expected values from this implementation. Includes questions that
// change provider input and digit forms that change provider suppression.
test('Q-01 query cleaning and PII filtering follow executable original NLP controls', () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/gqa-nlp-source.json', import.meta.url), 'utf8'));
  for (const row of fixture.cases) {
    const actual = row.kind === 'clean' ? cleanGqaInput(row.text) : gqaPiiFilter(row.text);
    assert.equal(actual, row.expected, row.id);
  }
});
