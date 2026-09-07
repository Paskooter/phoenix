import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createService } from '@phoenix/common';
import { skillRoute } from '../src/skillService.js';
import {
  buildGqaSlimFromMim,
  buildGqaSlimFromText,
  cleanGqaInput,
  createGqaProviderPipeline,
  createGqaAnswerSkill,
  createGqaHttpRoute,
  GQA_MISSING_TRANSID_HTML,
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
  const route = skillRoute('answer', createGqaAnswerSkill({ rng: () => 0, idFactory: idFactory(), messageId: () => 'response-id' }));
  const response = await route({ body: sourceRequest(), trace: {}, log: { error() {} } });
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

test('Q-01 GQA HTTP adapter preserves the first duplicate/empty transID and uses common timing wrapper', async () => {
  let seen;
  const route = createGqaHttpRoute({
    handler: async (body) => {
      seen = body;
      return { type: 'SKILL_ACTION', data: {} };
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
  assert.equal(typeof response.timings.total, 'number');

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

test('Q-01 GQA HTTP adapter exposes a status-coded error for direct callers without a response', async () => {
  const route = createGqaHttpRoute({ handler: async () => ({ type: 'SKILL_ACTION' }) });
  await assert.rejects(
    route({ body: sourceRequest(), req: { headers: {} } }),
    (error) => error instanceof Error
      && error.statusCode === 400
      && error.message === 'Missing X-JIBO-transID header',
  );
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
