#!/usr/bin/env node
/*
 * Q-01 archived fixture closure lane.
 *
 * The source inventory and fixture values in fixtures.json were read from
 * jiborobot/srv-gqa-ws through the Jibo MCP Gitea reader. This runner is
 * deliberately independent of the broad production corpus runner: it owns
 * its case IDs, expected counts, exact MIM values, source fake-provider
 * payloads, and omission/value-corruption controls.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createGqaAnswerSkill, createGqaHttpRoute, createGqaProviderPipeline, cleanGqaInput } from '../../packages/skills/src/gqaAnswerSkill.js';
import { createBingProvider, extractBingSpokenAnswer } from '../../packages/skills/src/gqaBingProvider.js';
import { createWikipediaProvider } from '../../packages/skills/src/gqaWikipediaProvider.js';
import { createWolframProvider, extractWolframSpokenAnswer, cleanWolframAnswer } from '../../packages/skills/src/gqaWolframProvider.js';
import { createGqaMemoryAttributionStore, createGqaAccountLookup } from '../../packages/skills/src/gqaAccountAttribution.js';
import { createGqaDefaultSkill, validateGqaDefaultProfile } from '../../packages/skills/src/gqaDefaultService.js';
import { createBuiltinSkills } from '../../packages/skills/src/index.js';
import { createNewsAnswerSkill, NEWS_SOURCE_PATHS } from '../../packages/skills/src/newsAnswerSkill.js';

const manifest = JSON.parse(readFileSync(new URL('./fixtures.json', import.meta.url), 'utf8'));
const NEWS_MANIFEST = JSON.parse(readFileSync(new URL('../../packages/gateway/resources/skills/external-skills/news_manifest.json', import.meta.url), 'utf8'));
const ARCHIVED_NEWS_SOURCE_PATHS = Object.freeze(['/news_skill', '/news_skill/v1/main']);

function idFactory() {
  let next = 1;
  return () => String(next++).padStart(32, '0');
}

function sourceRequest({ text = 'what is a fixture fact', intent = 'generalWhatQuestions', mimId } = {}) {
  return {
    type: 'LISTEN_LAUNCH',
    msgID: 'archived-fixture-request',
    ts: 1700000000000,
    data: {
      general: {
        accountID: 'fixture-account',
        robotID: 'fixture-robot',
        lang: 'en',
        remoteAddress: '192.0.2.4',
      },
      runtime: { location: { lat: 42.1, lng: -71.2, countryCode: 'US' }, dialog: {} },
      skill: null,
      result: {
        nlu: { intent, entities: mimId ? { mimId } : {} },
        asr: { text, confidence: 1 },
      },
    },
  };
}

function newsRequest({ speaker = null, users = [] } = {}) {
  return {
    type: 'LISTEN_LAUNCH',
    data: {
      runtime: {
        perception: { speaker },
        loop: { users },
      },
    },
  };
}

function sourceTypeFor(row) {
  const text = row.source || '';
  if (text === 'Bing') return 'bing';
  if (text === 'Wikipedia') return 'wiki';
  if (text === 'Wolfram Alpha') return 'wolfram';
  return undefined;
}

function assertManifestShape(value) {
  assert.equal(value.inventory.unit.namedTestCount, 136, 'archived named unit-test count');
  assert.equal(value.inventory.unit.assertionCalls, 385, 'archived unit assertion count');
  assert.equal(value.inventory.integration.knownRowCount, 340, 'known complete integration rows');
  assert.equal(value.inventory.integration.liveInputOnly, true, 'integration fixtures are inputs without output goldens');
  assert.equal(value.inventory.fakeProvider.routes.length, 3, 'archived fake-provider routes');
  assert.equal(value.inventory.gqaMims.fileCount, 11, 'archived GQA MIM files');
  assert.equal(value.inventory.gqaMims.promptCount, 77, 'archived GQA prompt count');
  assert.equal(Object.values(value.mimMetadata).reduce((total, rows) => total + rows.length, 0), 77, 'archived MIM media/weight rows');
  assert.deepEqual(value.inventory.news.frozenManifest.intents, [], 'frozen news manifest intents');
  assert.deepEqual(NEWS_MANIFEST.intents, value.inventory.news.frozenManifest.intents, 'current frozen news manifest intents');
  assert.deepEqual(value.inventory.news.sourceRoutes, ARCHIVED_NEWS_SOURCE_PATHS, 'archived news source routes');
  assert.equal(value.inventory.news.sourceRouteCount, 2, 'archived news source route count');
  assert.deepEqual(value.inventory.news.adapterRoutes, ['/v1/news/main'], 'Phoenix news adapter route');
  assert.equal(value.inventory.news.totalRouteCount, 3, 'total Phoenix news route count');
  assert.equal(value.inventory.news.sourceUnitCaseCount, 10, 'archived news unit case count');
  assert.equal(value.inventory.news.localSuite.testCount, 14, 'local news test count');
  assert.equal(value.inventory.news.localSuite.sourceShapedCases, 10, 'local source-shaped news cases');
  assert.equal(value.inventory.news.localSuite.additionalBoundaryTests, 4, 'local news boundary coverage area count');
  assert.equal(value.inventory.news.localSuite.additionalBoundaryCoverageAreas.length, 4, 'local news boundary coverage areas');
  assert.match(value.inventory.news.localSuite.testBlockAccounting, /not a one-to-one test-block mapping/);
  assert.equal(value.inventory.news.attributionSourceCase.sourceShapedNewsCase, false, 'news attribution case classification');
  assert.equal(value.inventory.news.localMimFileCount, 3, 'local NEWS MIM file count');
  assert.equal(value.inventory.news.localMimPromptCount, 5, 'local NEWS MIM prompt count');
  assert.equal(value.inventory.news.localRouteAliasCount, 3, 'local news route alias count');
  assert.equal(value.inventory.news.adapterRouteCount, 1, 'local news adapter route count');
  assert.equal(value.inventory.news.totalRouteCount, value.inventory.news.sourceRouteCount + value.inventory.news.adapterRouteCount, 'source plus adapter total news route count');
  assert.equal(value.inventory.news.localRouteAliasCount, value.inventory.news.sourceRouteCount + value.inventory.news.adapterRouteCount, 'source plus adapter news route count');
  assert.equal(value.inventory.news.liveProviderIntegrationCases, 1, 'live news integration case count');
  assert.equal(value.inventory.news.locallyReplayedLiveProviderIntegrationCases, 0, 'live news provider integration remains unexecuted');
  assert.equal(value.inventory.liveSuite.answer.caseCount, 11, 'moved live answer case count');
  assert.equal(value.inventory.liveSuite.news.caseCount, 1, 'moved live news case count');
  assert.equal(value.inventory.liveSuite.totalCaseCount, 12, 'moved live suite case count');
  assert.equal(value.inventory.liveSuite.locallyReplayed, 0, 'live suite remains provider-dependent');
  assert.equal(value.replay.archivedPegasusAnswerRows.length, 28, 'archived answer replay rows');
  assert.equal(value.replay.archivedAsyncRows.length, 12, 'archived async replay rows');
}

function replayMims(value = manifest) {
  let promptCount = 0;
  for (const [name, expected] of Object.entries(value.mims)) {
    const current = JSON.parse(readFileSync(new URL('../../packages/skills/resources/mims/gqa/' + name + '.mim', import.meta.url), 'utf8'));
    const metadata = value.mimMetadata[name];
    assert.equal(metadata.length, expected.prompts.length, 'archived MIM metadata length ' + name);
    const actualPrompts = current.prompts.map((item) => ({
      prompt_id: item.prompt_id,
      prompt: item.prompt,
      media: item.media,
      ...(Object.hasOwn(item, 'weight') ? { weight: item.weight } : {}),
    }));
    const expectedPrompts = expected.prompts.map((prompt, index) => ({
      ...prompt,
      media: metadata[index].media,
      ...(metadata[index].weight === null ? {} : { weight: metadata[index].weight }),
    }));
    assert.deepEqual(actualPrompts, expectedPrompts, 'exact archived MIM ' + name + ' prompt/media/weight');
    promptCount += actualPrompts.length;
  }
  return { files: Object.keys(value.mims).length, prompts: promptCount };
}

function replayNewsMims(value = manifest) {
  let promptCount = 0;
  for (const [name, expected] of Object.entries(value.newsMims)) {
    const current = JSON.parse(readFileSync(new URL('../../packages/skills/resources/mims/news/' + name + '.mim', import.meta.url), 'utf8'));
    assert.equal(current.mim_type, expected.mimType, 'current NEWS MIM type ' + name);
    const actualPrompts = current.prompts.map(({ prompt_id, prompt, media, weight }) => ({ prompt_id, prompt, media, weight }));
    assert.deepEqual(actualPrompts, expected.prompts, 'exact archived NEWS MIM ' + name);
    promptCount += actualPrompts.length;
  }
  assert.deepEqual(NEWS_SOURCE_PATHS, [...value.inventory.news.sourceRoutes, ...value.inventory.news.adapterRoutes], 'source and adapter news route coverage');
  return {
    files: Object.keys(value.newsMims).length,
    prompts: promptCount,
    sourceRoutes: value.inventory.news.sourceRouteCount,
    adapterRoutes: value.inventory.news.adapterRouteCount,
    totalRoutes: value.inventory.news.totalRouteCount,
    routeAliases: NEWS_SOURCE_PATHS.length,
  };
}

async function replayNewsCoverage() {
  const mims = replayNewsMims();
  const now = Date.parse('2026-09-13T00:00:00.000Z');
  const seen = [];
  const skill = createNewsAnswerSkill({
    newsProvider: async ({ isKid }) => {
      seen.push(isKid);
      return ['one', 'two', 'three', 'four', 'five'];
    },
    rng: () => 0,
    clock: () => now,
    idFactory: idFactory(),
    messageId: () => '00000000000000000000000000000001',
  });
  const child = await skill(newsRequest({
    speaker: 'child',
    users: [{ id: 'child', birthdate: Date.parse('2017-09-14T00:00:00.000Z') }],
  }));
  const children = child.data.action.config.jcp.children;
  assert.equal(children.length, 7, 'news five-item sequence bound');
  assert.equal(children[0].config.play.meta.prompt_id, 'NEWS_preamble_01', 'news preamble prompt');
  assert.equal(children[1].config.play.meta.prompt_id, 'NEWS_content_01', 'news content prompt');
  assert.equal(children[1].config.play.esml, '<style set="NEWS">one</style>', 'news content shape');
  assert.equal(children[5].config.play.esml, '<style set="NEWS">five</style>', 'news final headline');
  assert.equal(children[6].config.play.meta.prompt_id, 'NEWS_postamble_01', 'news postamble prompt');
  assert.deepEqual(seen, [true], 'news child AP selection');
  assert.deepEqual(child.data.skill, { id: 'news', version: '5.2.15' }, 'news skill metadata');
  assert.deepEqual(child.data.analytics.news[1], {
    event: 'News Query',
    properties: { type: 'AP', success: true },
  }, 'news analytics');
  assert.equal(child.data.final, true, 'news final');
  assert.equal(child.data.fireAndForget, true, 'news fireAndForget');

  const adult = await skill(newsRequest({
    speaker: 'adult',
    users: [{ id: 'adult', birthdate: Date.parse('2000-09-14T00:00:00.000Z') }],
  }));
  assert.equal(adult.data.action.config.jcp.children[1].config.play.esml, '<style set="NEWS">one</style>', 'news adult AP selection');
  assert.deepEqual(seen, [true, false], 'news adult/child provider observations');

  const empty = await createNewsAnswerSkill({ rng: () => 0, clock: () => now, idFactory: idFactory(), messageId: () => '00000000000000000000000000000002' })(newsRequest());
  assert.equal(empty.data.action.config.jcp.type, 'SLIM', 'empty news GQA_error SLIM');
  assert.equal(empty.data.action.config.jcp.config.play.meta.prompt_id, 'GQA_error_01', 'empty news error prompt');
  assert.deepEqual(empty.data.analytics.news[1], {
    event: 'News Query',
    properties: { type: 'AP', success: false },
  }, 'empty news analytics');
  return {
    mims,
    sourceUnitCases: manifest.inventory.news.sourceUnitCaseCount,
    localSourceShapedCases: manifest.inventory.news.localSuite.sourceShapedCases,
    localTestBlocks: manifest.inventory.news.localSuite.testCount,
    additionalBoundaryCoverageAreas: manifest.inventory.news.localSuite.additionalBoundaryCoverageAreas,
    frozenNewsIntents: manifest.inventory.news.frozenManifest.intents,
    attributionUnitCases: manifest.inventory.news.attributionSourceCase ? 1 : 0,
    attributionCoveredByExistingQ01: Boolean(manifest.inventory.news.attributionSourceCase?.coveredBy),
    sequenceRows: 1,
    liveProviderIntegrationCases: manifest.inventory.news.liveProviderIntegrationCases,
    locallyReplayedLiveProviderIntegrationCases: manifest.inventory.news.locallyReplayedLiveProviderIntegrationCases,
  };
}

async function replayAnswerRows() {
  let success = 0;
  let noAnswer = 0;
  let blocked = 0;
  let providerObserved = 0;
  for (const row of manifest.replay.archivedPegasusAnswerRows) {
    let calls = 0;
    let observedContext;
    const output = row.kind === 'success'
      ? { source: row.source, response: { type: 'string', payload: row.payload }, ...(row.source === 'Bing' || row.source === 'Wolfram Alpha' ? { url: 'https://fixture.invalid/' + row.source.toLowerCase().replaceAll(' ', '-') } : {}) }
      : {};
    const skill = createGqaAnswerSkill({
      provider: async (context) => { calls += 1; observedContext = { queryText: context.queryText, questionType: context.questionType }; return output; },
      rng: () => 0,
      clock: (() => { const values = [1000, 1007]; return () => values.shift() ?? 1007; })(),
      idFactory: idFactory(),
      messageId: () => '00000000-0000-0000-0000-000000000001',
    });
    const response = await skill(sourceRequest({ text: row.text, intent: row.intent, mimId: row.mimId }));
    const jcp = response.data.action.config.jcp;
    const play = jcp.config.play;
    assert.equal(response.type, 'SKILL_ACTION', row.sourceTest + ' envelope');
    assert.deepEqual(response.data.skill, { id: 'answer', version: '5.2.15' }, row.sourceTest + ' metadata');
    assert.equal(response.data.final, true, row.sourceTest + ' final');
    assert.equal(response.data.fireAndForget, true, row.sourceTest + ' fireAndForget');
    assert.equal(response.data.action.type, 'JCP', row.sourceTest + ' JCP');
    assert.equal(response.data.action.config.version, '2.0', row.sourceTest + ' JCP version');
    const expectedQuery = manifest.replay.expectedProviderQueries[row.sourceTest];
    assert.equal(cleanGqaInput(row.text), expectedQuery, row.sourceTest + ' source query cleaning');
    if (row.kind === 'success' || row.kind === 'no-answer') {
      assert.equal(observedContext?.queryText, expectedQuery, row.sourceTest + ' provider-observed query');
      providerObserved += 1;
    } else {
      assert.equal(observedContext, undefined, row.sourceTest + ' provider suppression');
    }
    if (row.kind === 'success') {
      assert.equal(play.meta.prompt_id, row.source, row.sourceTest + ' source MIM');
      const escaped = row.payload.replace(/[.*+?^$()|[\]\\]/g, '\\$&');
      assert.match(String(play.esml), new RegExp(escaped), row.sourceTest + ' spoken payload');
      assert.equal(response.data.analytics.answer[1].properties.success, true, row.sourceTest + ' analytics');
      assert.equal(response.data.analytics.answer[1].properties.type, sourceTypeFor(row), row.sourceTest + ' analytics type');
      success += 1;
    } else if (row.kind === 'no-answer') {
      assert.equal(play.meta.prompt_id, 'GQA_no_answer_' + row.questionType + '_01', row.sourceTest + ' no-answer MIM');
      assert.equal(jcp.config.display.type, 'DISPLAY', row.sourceTest + ' display');
      assert.equal(jcp.config.display.name, 'GQA_NO_ANSWER_VIEW', row.sourceTest + ' display name');
      assert.equal(response.data.analytics.answer[1].properties.success, false, row.sourceTest + ' analytics');
      noAnswer += 1;
    } else {
      assert.match(play.meta.prompt_id, new RegExp('^' + row.promptPrefix), row.sourceTest + ' block MIM');
      assert.equal(calls, 0, row.sourceTest + ' provider suppression');
      blocked += 1;
    }
  }
  return { rows: manifest.replay.archivedPegasusAnswerRows.length, success, noAnswer, blocked, providerObserved, providerOutput: 'synthetic; response shaping only' };
}

async function replayQueryBoundary() {
  const input = 'what is a fixture?';
  const expectedQuery = 'what is a fixture';
  let observedQuery;
  const skill = createGqaAnswerSkill({
    provider: async (context) => {
      observedQuery = context.queryText;
      return {};
    },
    rng: () => 0,
    clock: (() => { const values = [1000, 1001]; return () => values.shift() ?? 1001; })(),
    idFactory: idFactory(),
    messageId: () => '00000000-0000-0000-0000-000000000001',
  });
  const response = await skill(sourceRequest({ text: input, intent: 'generalWhatQuestions' }));
  assert.equal(cleanGqaInput(input), expectedQuery, 'source query boundary removes question mark');
  assert.equal(observedQuery, expectedQuery, 'provider observes question-mark-free query');
  assert.equal(response.data.action.config.jcp.config.display.type, 'DISPLAY', 'query boundary no-answer display');
  return { input, providerObservedQuery: observedQuery };
}

function workerFor(mode, service) {
  const delays = { fast: 0, slow: 10, timeout: 35, 'timeout-long': 90, empty: 0, 'slow-empty': 10 };
  const delay = delays[mode];
  return async () => {
    if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
    if (mode === 'empty' || mode === 'slow-empty') return {};
    const source = service === 'Bing' ? 'Bing' : service === 'Wikipedia' ? 'Wikipedia' : 'Wolfram Alpha';
    const label = service === 'Wolfram Alpha' ? 'Wolfram' : service;
    return { source, response: { type: 'string', payload: label + ' ' + mode + ' reply' } };
  };
}

async function replayAsyncRows() {
  let matched = 0;
  for (const row of manifest.replay.archivedAsyncRows) {
    const pipeline = createGqaProviderPipeline({
      providers: {
        Bing: workerFor(row.bing, 'Bing'),
        Wikipedia: workerFor(row.wiki, 'Wikipedia'),
        'Wolfram Alpha': workerFor(row.wolfram, 'Wolfram Alpha'),
      },
      timeouts: [30, 40],
    });
    const output = await pipeline({ queryText: 'Dummy query input', questionType: 'generic' });
    if (row.expectedPayload === null) {
      assert.equal(output.response, undefined, row.sourceTest + ' no response');
    } else {
      assert.equal(output.response.payload, row.expectedPayload, row.sourceTest + ' winner');
    }
    matched += 1;
  }
  return { rows: matched, matched };
}

async function replayFakeProviders() {
  const bing = manifest.fakeFixtures.bing;
  const bingOutput = extractBingSpokenAnswer(bing.body, 'en-US');
  assert.deepEqual(bingOutput, bing.expected, 'archived fake Bing decoder');
  const bingProvider = createBingProvider({
    endpoint: 'http://fixture.invalid/bing',
    apiKey: 'fixture-key',
    clock: (() => { const values = [100, 101]; return () => values.shift(); })(),
    fetchImpl: async () => ({ status: 200, url: 'http://fixture.invalid/bing?q=What+is+the+GDP+of+China', headers: { get: () => 'en-us' }, json: async () => bing.body }),
  });
  const bingResult = await bingProvider({ queryText: 'What is the GDP of China', countryCode: 'US' });
  assert.deepEqual(bingResult.response, bing.expected.response, 'archived fake Bing provider payload');
  assert.equal(bingResult.type, 'facts', 'archived fake Bing type');

  const wiki = manifest.fakeFixtures.wikipedia;
  const wikiProvider = createWikipediaProvider({
    endpoint: 'http://fixture.invalid/wiki',
    clock: (() => { let value = 100; return () => value++; })(),
    random: () => 0,
    fetchImpl: async () => ({
      status: 200,
      url: 'http://fixture.invalid/wiki',
      headers: { get: () => 'application/json' },
      text: async () => JSON.stringify(wiki.body),
    }),
  });
  const wikiResult = await wikiProvider({ queryText: 'John Henry Brooke', questionType: 'who' });
  assert.equal(wikiResult.source, wiki.expected.source, 'archived fake Wikipedia source');
  assert.deepEqual(wikiResult.response, wiki.expected.response, 'archived fake Wikipedia payload');
  assert.equal(wikiResult.url, undefined, 'archived Wikipedia omits attribution URL');

  const wolfram = manifest.fakeFixtures.wolfram;
  assert.equal(extractWolframSpokenAnswer(wolfram.body), wolfram.expectedSpoken, 'archived fake Wolfram spoken extraction');
  assert.equal(cleanWolframAnswer(extractWolframSpokenAnswer(wolfram.body)), wolfram.expectedClean, 'archived fake Wolfram cleanup');
  const wolframProvider = createWolframProvider({
    endpoint: 'http://fixture.invalid/wolfram',
    apiKey: 'fixture-key',
    clock: (() => { const values = [100, 101]; return () => values.shift(); })(),
    fetchImpl: async () => ({ status: 200, url: 'http://fixture.invalid/wolfram?input=what+is+scotland', json: async () => wolfram.body }),
  });
  const wolframResult = await wolframProvider({ queryText: 'what is scotland' });
  assert.equal(wolframResult.response.payload, wolfram.expectedClean, 'archived fake Wolfram provider payload');
  assert.match(wolframResult.url, /what\+is\+scotland/u, 'archived fake Wolfram URL');
  return { routes: 3, bing: 2, wikipedia: 1, wolfram: 2 };
}

async function replayAttribution() {
  const accountCalls = [];
  const account = createGqaAccountLookup({
    endpoint: 'http://fixture.invalid/account',
    fetchImpl: async (url, options) => {
      accountCalls.push({ url, options });
      return { json: async () => ({ 'fixture-account': ['fixture-loop'] }) };
    },
  });
  assert.equal(await account('fixture-account'), 'fixture-loop');
  assert.equal(accountCalls[0].options.method, 'POST');
  assert.equal(accountCalls[0].options.body, '{"accountsIds": ["fixture-account"]}');

  const now = 1700000000000;
  const attribution = createGqaMemoryAttributionStore({ clock: () => now });
  const skill = createGqaAnswerSkill({
    accountLookup: account,
    attribution,
    provider: async () => ({
      source: 'Bing',
      response: { type: 'string', payload: 'Fixture answer' },
      url: 'https://fixture.invalid/search?q=fixture',
      image_url: 'https://fixture.invalid/image.jpg',
    }),
    rng: () => 0,
    clock: () => now,
    idFactory: idFactory(),
    messageId: () => '00000000-0000-0000-0000-000000000002',
  });
  const response = await skill(sourceRequest());
  assert.equal(response.data.action.config.jcp.config.play.esml, 'Fixture answer.');
  const snapshot = attribution.snapshot();
  assert.equal(snapshot.length, 1);
  assert.deepEqual(snapshot[0], {
    service: 'Bing',
    query: 'Fixture answer.',
    url: 'https://fixture.invalid/search?q=fixture',
    image_url: 'https://fixture.invalid/image.jpg',
    loop_id: 'fixture-loop',
    timestamp: now,
  });
  const rows = await attribution.search('fixture-loop', 'Bing', now + 1, now - 1);
  assert.equal(rows.length, 1);
  assert.equal(await attribution.wipe('fixture-loop'), 1);
  assert.equal(attribution.snapshot().length, 0);
  return { accountCalls: accountCalls.length, inserted: 1, retrieved: 1, wiped: 1 };
}

async function replayErrorEnvelope() {
  const route = createGqaHttpRoute({
    handler: createGqaAnswerSkill({
      provider: async () => ({ response: { payload: 42 }, source: 'Wikipedia' }),
      rng: () => 0,
      idFactory: idFactory(),
      messageId: () => '00000000-0000-0000-0000-000000000003',
    }),
  });
  const state = { status: null, type: null, body: null };
  await route({
    body: sourceRequest(),
    req: { headers: { 'x-jibo-transid': 'fixture-trans' } },
    res: {
      status(value) { state.status = value; return this; },
      type(value) { state.type = value; return this; },
      send(value) { state.body = value; return this; },
    },
  });
  assert.equal(state.status, 500, 'source malformed provider status');
  assert.equal(state.type, 'html', 'source malformed provider media');
  const envelope = JSON.parse(state.body);
  assert.deepEqual(Object.keys(envelope).sort(), ['message', 'stacktrace', 'version']);
  assert.equal(envelope.version, '5.2.15');
  assert.match(envelope.message, /payload/u);
  return { status: state.status, envelopeKeys: Object.keys(envelope).sort() };
}

async function replayDefaultRouting() {
  const builtins = createBuiltinSkills();
  const defaultResponse = await builtins[0].handler(sourceRequest({ text: 'who is ada lovelace', intent: 'generalWhoQuestions' }));
  assert.equal(defaultResponse.data.skill.id, 'answer-skill');
  assert.notEqual(
    defaultResponse.data.action.config.jcp.children[0].config.play.meta.mim_id,
    'GQA_no_answer_who_01',
    'default host remains Phoenix answer skill',
  );

  assert.equal(validateGqaDefaultProfile(undefined), undefined);
  assert.equal(validateGqaDefaultProfile('multi-provider'), 'multi-provider');
  assert.throws(() => validateGqaDefaultProfile('wikipedia'), /Unknown/u);
  const explicit = createGqaDefaultSkill({
    env: {
      ETCO_gqa_bingApi: 'http://fixture.invalid/bing',
      ETCO_gqa_wikiApi: 'http://fixture.invalid/wiki',
      ETCO_gqa_wolframApi: 'http://fixture.invalid/wolfram',
    },
  });
  assert.equal(explicit.id, 'answer-skill');
  assert.equal(explicit.sourceSkillId, 'answer');
  assert.equal(explicit.sourceBasePath, '/answer_skill');
  assert.equal(typeof explicit.route, 'function');
  assert.equal(explicit.profile.profile, 'multi-provider');
  const registry = JSON.parse(readFileSync(new URL('../../packages/gateway/resources/skills/skills-phoenix.json', import.meta.url), 'utf8'));
  assert.equal(registry.skills[0].baseURL, 'http://answer-skill:8080');
  assert.equal(registry.skills.some(item => String(item.configPath).includes('gqa')), false);
  return { defaultSkillId: defaultResponse.data.skill.id, explicitProfile: explicit.profile.profile, registeredImplicitly: false };
}

function runFalsifierControls() {
  const omitted = structuredClone(manifest);
  omitted.replay.archivedAsyncRows.pop();
  assert.throws(() => assertManifestShape(omitted), /archived async replay rows/u);
  const corrupted = structuredClone(manifest);
  corrupted.mims.GQA_error.prompts[0].prompt += ' CORRUPTED';
  assert.throws(() => replayMims(corrupted), /exact archived MIM GQA_error/u);
  const bingByteCorrupted = structuredClone(manifest);
  bingByteCorrupted.fakeFixtures.bing.body.facts.screenshot.thumbnailUrl = bingByteCorrupted.fakeFixtures.bing.body.facts.screenshot.thumbnailUrl.replace(
    'New+York%252C%2520New+York',
    'New+York%2520New+York',
  );
  assert.throws(
    () => assert.deepEqual(
      extractBingSpokenAnswer(bingByteCorrupted.fakeFixtures.bing.body, 'en-US'),
      manifest.fakeFixtures.bing.expected,
    ),
    /image_url/u,
    'Bing URL byte mutation must be observable',
  );
  return { omissionRejected: true, valueCorruptionRejected: true, providerByteCorruptionRejected: true };
}

async function main() {
  assertManifestShape(manifest);
  const mims = replayMims();
  const news = await replayNewsCoverage();
  const answers = await replayAnswerRows();
  const queryBoundary = await replayQueryBoundary();
  const asyncRows = await replayAsyncRows();
  const providers = await replayFakeProviders();
  const attribution = await replayAttribution();
  const errors = await replayErrorEnvelope();
  const routing = await replayDefaultRouting();
  const falsifiers = runFalsifierControls();
  const report = {
    source: manifest.source,
    inventory: manifest.inventory,
    replay: {
      mims,
      news,
      answers,
      queryBoundary,
      asyncRows,
      fakeProviders: providers,
      attribution,
      errors,
      routing,
      falsifiers,
    },
    coverage: {
      archivedUnitTests: manifest.inventory.unit.namedTestCount,
      archivedUnitAssertions: manifest.inventory.unit.assertionCalls,
      newsSourceUnitCases: manifest.inventory.news.sourceUnitCaseCount,
      newsLocalSourceShapedCases: manifest.inventory.news.localSuite.sourceShapedCases,
      newsLocalTestBlocks: manifest.inventory.news.localSuite.testCount,
      newsAdditionalBoundaryCoverageAreas: manifest.inventory.news.localSuite.additionalBoundaryCoverageAreas.length,
      frozenNewsIntents: manifest.inventory.news.frozenManifest.intents,
      newsAttributionUnitCases: manifest.inventory.news.attributionSourceCase ? 1 : 0,
      newsAttributionCoveredByExistingQ01: Boolean(manifest.inventory.news.attributionSourceCase?.coveredBy),
      newsMimFiles: news.mims.files,
      newsMimPrompts: news.mims.prompts,
      newsSourceRoutes: news.mims.sourceRoutes,
      newsAdapterRoutes: news.mims.adapterRoutes,
      newsTotalRoutes: news.mims.totalRoutes,
      newsRouteAliases: news.mims.routeAliases,
      liveNewsIntegrationCases: manifest.inventory.news.liveProviderIntegrationCases,
      locallyReplayedLiveNewsIntegrationCases: manifest.inventory.news.locallyReplayedLiveProviderIntegrationCases,
      knownCompleteIntegrationRows: manifest.inventory.integration.knownRowCount,
      locallyReplayedIntegrationRows: 0,
      archivedAnswerRows: manifest.replay.archivedPegasusAnswerRows.length,
      archivedAsyncRows: manifest.replay.archivedAsyncRows.length,
      liveSuiteAnswerCases: manifest.inventory.liveSuite.answer.caseCount,
      liveSuiteNewsCases: manifest.inventory.liveSuite.news.caseCount,
      locallyReplayedLiveSuiteCases: manifest.inventory.liveSuite.locallyReplayed,
      exactMimPrompts: mims.prompts,
      exactMimMetadataRows: mims.prompts,
      providerRoutes: providers.routes,
      gaps: [
        { area: 'news_skill', sourceCases: manifest.gaps.news.sourceTests.length, locallyReplayed: manifest.inventory.news.localSuite.sourceShapedCases, reason: manifest.gaps.news.reason },
        { area: 'integration_beta3_4902', sourceCases: null, locallyReplayed: 0, reason: manifest.gaps.integration.reason },
        { area: 'live_answer_integration', sourceCases: manifest.inventory.liveSuite.answer.caseCount, locallyReplayed: manifest.inventory.liveSuite.locallyReplayed, reason: manifest.inventory.liveSuite.answer.status },
        { area: 'live_news_integration', sourceCases: manifest.inventory.liveSuite.news.caseCount, locallyReplayed: manifest.inventory.news.locallyReplayedLiveProviderIntegrationCases, reason: manifest.inventory.liveSuite.news.status },
        { area: 'remaining_archived_unit_tests', sourceCases: manifest.inventory.unit.namedTestCount, assertionCalls: manifest.inventory.unit.assertionCalls, locallyReplayed: manifest.replay.archivedPegasusAnswerRows.length + manifest.replay.archivedAsyncRows.length, reason: 'The 40 replay rows cover source answer/async shaping controls; the remaining named tests and assertion calls require Mongo/AP/API-AI/live provider behavior or are already represented by separate bounded Q-01 evidence.' },
      ],
    },
  };
  console.log(JSON.stringify(report, null, 2));
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
