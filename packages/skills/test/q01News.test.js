import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NEWS_SOURCE_PATHS,
  createApNewsProvider,
  buildNewsSequence,
  buildNewsSlimFromMim,
  createNewsAnswerSkill,
  createNewsHttpRoute,
  isNewsChild,
  newsMimPromptIds,
  start,
} from '../src/index.js';
import { loadConfig } from '../../gateway/src/config.js';
import { IntentRouter } from '../../gateway/src/intentRouter.js';

const NOW = Date.parse('2026-09-13T00:00:00.000Z');

function request({ speaker = null, users = [] } = {}) {
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

function ids() {
  let next = 0;
  return () => `news-id-${++next}`;
}

function responseText(response) {
  const jcp = response.data.action.config.jcp;
  return jcp.type === 'SEQUENCE'
    ? jcp.children.map((child) => child.config.play.esml)
    : [jcp.config.play.esml];
}

test('Q-01 source fixture: NEWS MIMs retain source prompts and SLIM shapes', () => {
  assert.deepEqual(newsMimPromptIds('NEWS_preamble'), [
    'NEWS_preamble_01', 'NEWS_preamble_02', 'NEWS_preamble_03',
  ]);
  assert.deepEqual(newsMimPromptIds('NEWS_content'), ['NEWS_content_01']);
  assert.deepEqual(newsMimPromptIds('NEWS_postamble'), ['NEWS_postamble_01']);

  const idFactory = ids();
  const slim = buildNewsSlimFromMim('NEWS_preamble', { rng: () => 0, idFactory });
  assert.equal(slim.type, 'SLIM');
  assert.equal(slim.config.play.esml, 'Here are the headlines from the Associated Press.');
  assert.equal(slim.config.play.meta.prompt_id, 'NEWS_preamble_01');
  assert.equal(slim.config.display, null);
  assert.deepEqual(buildNewsSequence([slim], idFactory).type, 'SEQUENCE');
});

test('Q-01 source fixture: speaker age selects child AP data only under thirteen', () => {
  const child = { id: 'child', birthdate: Date.parse('2017-09-14T00:00:00Z') };
  const adult = { id: 'adult', birthdate: Date.parse('2000-09-14T00:00:00Z') };
  assert.equal(isNewsChild(request({ speaker: 'child', users: [child, adult] }), () => NOW), true);
  assert.equal(isNewsChild(request({ speaker: 'adult', users: [child, adult] }), () => NOW), false);
  assert.equal(isNewsChild(request({ speaker: null, users: [child] }), () => NOW), false);
  assert.equal(isNewsChild(request({ speaker: 'missing', users: [child] }), () => NOW), false);
  assert.equal(isNewsChild(request({ speaker: 'child', users: null }), () => NOW), false);
  assert.equal(isNewsChild(request({ speaker: 'child', users: [{ id: 'child' }] }), () => NOW), false);
});

test('Q-01 source fixture: leap-day relativedelta clamps the thirteen-year cutoff', () => {
  const leapNow = Date.parse('2024-02-29T00:00:00Z');
  const boundary = { id: 'boundary', birthdate: Date.parse('2011-02-28T00:00:00Z') };
  const younger = { id: 'younger', birthdate: Date.parse('2011-03-01T00:00:00Z') };
  assert.equal(isNewsChild(request({ speaker: 'boundary', users: [boundary] }), () => leapNow), false);
  assert.equal(isNewsChild(request({ speaker: 'younger', users: [younger] }), () => leapNow), true);
  assert.throws(
    () => isNewsChild(request({ speaker: 'boundary', users: [{ id: 'boundary', birthdate: '1.2' }] }), () => NOW),
    /birthdate must be numeric/,
  );
});

test('Q-01 archived PegasusNewsTestCase matrix: all speaker/loop cases select the source feed', async () => {
  const adult = { id: 'adult', birthdate: Date.parse('2000-09-14T00:00:00Z') };
  const child = { id: 'child', birthdate: Date.parse('2017-09-14T00:00:00Z') };
  const cases = [
    ['adult default', { speaker: null, users: [adult, child] }, false],
    ['adult identified', { speaker: 'adult', users: [adult, child] }, false],
    ['child', { speaker: 'child', users: [adult, child] }, true],
    ['unknown speaker', { speaker: null, users: [adult, child] }, false],
    ['unknown loop', { speaker: 'child', users: null }, false],
    ['speaker outside loop', { speaker: 'adult', users: [{ id: 'other', birthdate: adult.birthdate }] }, false],
    ['speaker without birthdate', { speaker: 'child', users: [{ id: 'child' }] }, false],
  ];
  for (const [name, fields, expectedKid] of cases) {
    let observed;
    const handler = createNewsAnswerSkill({
      rng: () => 0,
      clock: () => NOW,
      newsProvider: async ({ isKid }) => {
        observed = isKid;
        return [isKid ? 'kid_headline' : 'adult_headline'];
      },
    });
    const result = await handler(request(fields));
    assert.equal(observed, expectedKid, name);
    assert.equal(result.data.action.config.jcp.children[1].config.play.esml,
      `<style set="NEWS">${expectedKid ? 'kid' : 'adult'}_headline</style>`, name);
  }
});

test('Q-01 source fixture: AP sequence, analytics, and five-item bound', async () => {
  const seen = [];
  const handler = createNewsAnswerSkill({
    rng: () => 0,
    clock: () => NOW,
    idFactory: ids(),
    newsProvider: async ({ isKid }) => {
      seen.push(isKid);
      return ['one', 'two', 'three', 'four', 'five'];
    },
  });
  const result = await handler(request({
    speaker: 'child',
    users: [{ id: 'child', birthdate: Date.parse('2017-09-14T00:00:00Z') }],
  }));
  const children = result.data.action.config.jcp.children;
  assert.equal(result.type, 'SKILL_ACTION');
  assert.equal(result.data.skill.id, 'news');
  assert.equal(result.data.skill.version, '5.2.15');
  assert.match(result.msgID, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.equal(children.length, 7);
  assert.equal(children[0].config.play.meta.prompt_id, 'NEWS_preamble_01');
  assert.equal(children[1].config.play.esml, '<style set="NEWS">one</style>');
  assert.equal(children[5].config.play.esml, '<style set="NEWS">five</style>');
  assert.equal(children[6].config.play.meta.prompt_id, 'NEWS_postamble_01');
  assert.deepEqual(seen, [true]);
  assert.deepEqual(result.data.analytics.news[1], {
    event: 'News Query',
    properties: { type: 'AP', success: true },
  });
  assert.equal(result.data.final, true);
  assert.equal(result.data.fireAndForget, true);
  assert.equal(typeof result.timings.total, 'string');
});

test('Q-01 source falsifier: AP headline replacement tokens are inserted literally', async () => {
  const headline = "$&-$`-$'";
  const result = await createNewsAnswerSkill({
    rng: () => 0,
    clock: () => NOW,
    newsProvider: async () => [headline],
  })(request());
  assert.equal(result.data.action.config.jcp.children[1].config.play.esml,
    `<style set="NEWS">${headline}</style>`);
});

test('Q-01 source gqa/ap.py: AP provider preserves 24h/feed/adult/order/limit/bytes semantics', async () => {
  const calls = [];
  const recent = NOW - 1000;
  const storeRows = [
    { feedID: '42210', storedTime: recent, adult: true, summary: 'adult-first' },
    { feedID: '41664', storedTime: recent - 1, adult: false, summary: Buffer.from('kid-one') },
    { feedID: '41664', storedTime: recent - 2, adult: false, summary: 'kid-two' },
    { feedID: '41664', storedTime: recent - 3, adult: false, summary: 'kid-three' },
    { feedID: '41664', storedTime: recent - 4, adult: false, summary: 'kid-four' },
    { feedID: '41664', storedTime: recent - 5, adult: false, summary: 'kid-five' },
    { feedID: '41664', storedTime: recent - 6, adult: false, summary: 'kid-six' },
    { feedID: '41664', storedTime: NOW - 24 * 60 * 60 * 1000, adult: false, summary: 'old' },
  ];
  const store = {
    find(query, options) {
      calls.push({ query, options });
      return storeRows.filter((row) => row.feedID === query.feedID
        && row.storedTime > query.storedTime.$gt
        && (query.adult === undefined || row.adult === query.adult));
    },
  };
  const provider = createApNewsProvider({ store, clock: () => NOW });
  assert.deepEqual(await provider({ isKid: true }), [
    'kid-one', 'kid-two', 'kid-three', 'kid-four', 'kid-five',
  ]);
  assert.deepEqual(calls.map(({ query }) => query), [
    { storedTime: { $gt: NOW - 24 * 60 * 60 * 1000 }, feedID: '42210', adult: false },
    { storedTime: { $gt: NOW - 24 * 60 * 60 * 1000 }, feedID: '41664', adult: false },
  ]);
  assert.deepEqual(calls[1].options, {
    projection: { _id: 0 },
    sort: { storedTime: -1 },
    limit: 5,
  });
  assert.deepEqual(await provider({ isKid: false }), ['adult-first']);
  assert.equal(calls[2].query.adult, undefined);

  const invalid = createApNewsProvider({
    store: { find: () => [{ feedID: '42210', storedTime: recent, summary: Buffer.from([0xc3, 0x28]) }] },
    clock: () => NOW,
  });
  await assert.rejects(() => invalid({ isKid: false }), /encoded data/);
});

test('Q-01 source falsifier: empty AP data is a 200 GQA_error SLIM with failure analytics', async () => {
  const result = await createNewsAnswerSkill({ rng: () => 0, clock: () => NOW })(request());
  const jcp = result.data.action.config.jcp;
  assert.equal(jcp.type, 'SLIM');
  assert.equal(jcp.config.play.meta.prompt_id, 'GQA_error_01');
  assert.equal(result.data.analytics.news[1].properties.success, false);
});

test('Q-01 source falsifier: provider rejection stays an HTTP 500 source error', async () => {
  const route = createNewsHttpRoute({
    handler: createNewsAnswerSkill({
      newsProvider: async () => { throw new Error('AP store unavailable'); },
      clock: () => NOW,
    }),
  });
  const response = await new Promise((resolve) => {
    const body = request();
    const res = {
      statusCode: 200,
      headers: {},
      status(code) { this.statusCode = code; return this; },
      type() { return this; },
      send(value) { resolve({ status: this.statusCode, body: JSON.parse(value) }); },
      setHeader(name, value) { this.headers[name] = value; },
      end(value) { resolve({ status: this.statusCode, body: value }); },
    };
    route({ req: { headers: { 'x-jibo-transid': 'news-test' } }, res, body });
  });
  assert.equal(response.status, 500);
  assert.equal(response.body.version, '5.2.15');
  assert.match(response.body.message, /AP store unavailable/);

  await assert.rejects(
    () => createNewsAnswerSkill({ newsProvider: async () => ['1', '2', '3', '4', '5', '6'] })(request()),
    /more than five AP headlines/,
  );
});

test('Q-01 source falsifiers: malformed perception, loop, and looper entries remain HTTP 500', async () => {
  const route = createNewsHttpRoute({
    handler: createNewsAnswerSkill({ clock: () => NOW, newsProvider: async () => ['headline'] }),
  });
  const invoke = async (body) => {
    const result = await new Promise((resolve) => {
      const res = {
        statusCode: 200,
        headers: {},
        status(code) { this.statusCode = code; return this; },
        type() { return this; },
        send(value) { resolve({ status: this.statusCode, body: JSON.parse(value) }); },
        setHeader(name, value) { this.headers[name] = value; },
        end(value) { resolve({ status: this.statusCode, body: value }); },
      };
      route({ req: { headers: { 'x-jibo-transid': 'news-test' } }, res, body });
    });
    return result;
  };

  for (const [label, malformed] of [
    ['perception array', { data: { runtime: { perception: [], loop: { users: [] } } } }],
    ['loop array', { data: { runtime: { perception: { speaker: 'u1' }, loop: [] } } }],
    ['looper missing id', { data: { runtime: { perception: { speaker: 'u1' }, loop: { users: [{ birthdate: 1 }] } } } }],
    ['looper primitive', { data: { runtime: { perception: { speaker: 'u1' }, loop: { users: ['u1'] } } } }],
  ]) {
    const result = await invoke({ ...request(), ...malformed });
    assert.equal(result.status, 500, label);
    assert.equal(result.body.version, '5.2.15', label);
  }
});

test('Q-01 source aliases: selected news host serves all legacy and registry paths', async () => {
  const server = await start(0, {
    skillId: 'news',
    newsConfig: { rng: () => 0, clock: () => NOW, newsProvider: async () => ['headline'] },
  });
  try {
    for (const path of NEWS_SOURCE_PATHS) {
      const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-jibo-transid': 'news-test' },
        body: JSON.stringify(request()),
      });
      assert.equal(response.status, 200, path);
      const result = await response.json();
      assert.deepEqual(responseText(result), [
        'Here are the headlines from the Associated Press.',
        '<style set="NEWS">headline</style>',
        "And that's all the news for now.",
      ]);
    }
    const missingHeader = await fetch(`http://127.0.0.1:${server.address().port}/news_skill/v1/main`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request()),
    });
    assert.equal(missingHeader.status, 400);
    assert.match(await missingHeader.text(), /Missing X-JIBO-transID header/);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('Q-01 source falsifiers: duplicate transID uses the first scalar and media errors fail closed', async () => {
  let seenTransId;
  let seenLoggingConfig;
  const route = createNewsHttpRoute({
    handler: async (body) => {
      seenTransId = body.transID;
      seenLoggingConfig = body['logging-config'];
      return createNewsAnswerSkill({ rng: () => 0, clock: () => NOW, newsProvider: async () => [] })(body);
    },
  });
  await new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      type() { return this; },
      send() { resolve(); },
      setHeader() {},
      end() { resolve(); },
    };
    route({
      req: {
        headers: { 'x-jibo-transid': 'first', 'x-jibo-logging-config': 'first-log' },
        rawHeaders: [
          'x-jibo-transid', 'first', 'X-JIBO-transID', 'second',
          'x-jibo-logging-config', 'first-log', 'X-JIBO-logging-config', 'second-log',
        ],
      },
      body: request(),
      res,
    });
  });
  assert.equal(seenTransId, 'first');
  assert.equal(seenLoggingConfig, 'first-log');
  await assert.rejects(
    () => route({ req: { headers: {} }, body: request() }),
    (error) => error.statusCode === 400 && /Missing X-JIBO-transID/.test(error.message),
  );

  const server = await start(0, { skillId: 'news' });
  try {
    const malformedVendor = await fetch(`http://127.0.0.1:${server.address().port}/news_skill/v1/main`, {
      method: 'POST',
      headers: { 'content-type': 'application/vnd.fixture+json', 'x-jibo-transid': 'news-test' },
      body: '{',
    });
    assert.equal(malformedVendor.status, 400);
    assert.match(await malformedVendor.text(), /Bad Request/);

    const malformedAws = await fetch(`http://127.0.0.1:${server.address().port}/news_skill/v1/main`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-amz-json-1.1', 'x-jibo-transid': 'news-test' },
      body: '{',
    });
    assert.equal(malformedAws.status, 500);
    const error = await malformedAws.json();
    assert.equal(error.version, '5.2.15');
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('Q-01 registry wiring: explicit GQA default profile carries source news manifest', async () => {
  const config = await loadConfig({
    ETCO_hub_skillsConfig: 'skills-gqa-default.json',
    NET_skills: 'news-host:8080',
  });
  assert.equal(config.skills[0].id, 'answer-skill');
  const news = config.skills.find((skill) => skill.id === 'news');
  assert.ok(news);
  assert.equal(news.URL, 'http://answer-skill:8080/news_skill/v1/main');
  assert.deepEqual(news.intents, [{ name: 'requestNews' }]);
  assert.ok(config.skills.findIndex((skill) => skill.id === 'news')
    < config.skills.findIndex((skill) => skill.id === 'report-skill'));
  const route = new IntentRouter(config.skills).getSkillIDFromNLU({
    intent: 'requestNews',
    rules: ['launch'],
    entities: {},
  });
  assert.deepEqual(route, { skillID: 'news', weight: 0 });
});

test('Q-01 registry-to-host proof: selected answer-skill co-hosts news and keeps answer /v1/main default', async () => {
  const config = await loadConfig({
    ETCO_hub_skillsConfig: 'skills-gqa-default.json',
  });
  const news = config.skills.find((skill) => skill.id === 'news');
  const server = await start(0, {
    skillId: 'answer-skill',
    newsConfig: { rng: () => 0, clock: () => NOW, newsProvider: async () => ['headline'] },
  });
  try {
    const port = server.address().port;
    assert.equal(new URL(news.URL).pathname, '/news_skill/v1/main');
    const registryNews = await fetch(`http://127.0.0.1:${port}/news_skill/v1/main`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-jibo-transid': 'news-test' },
      body: JSON.stringify(request()),
    });
    assert.equal(registryNews.status, 200);
    assert.equal((await registryNews.json()).data.skill.id, 'news');

    const answer = await fetch(`http://127.0.0.1:${port}/v1/main`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'LISTEN_LAUNCH',
        data: { result: { asr: { text: 'hello' }, nlu: { entities: {} } } },
      }),
    });
    assert.equal(answer.status, 200);
    assert.equal((await answer.json()).data.skill.id, 'answer-skill');
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
