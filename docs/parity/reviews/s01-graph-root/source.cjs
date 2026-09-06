'use strict';

// Source-only GraphSkill request matrix. Run against the frozen Pegasus tree
// with the pinned Node 8 image. The cases deliberately bypass any SkillRequest
// schema and exercise GraphSkill's field ordering, fallback mutation, and
// GraphManager session preconditions through real graph/chitchat/report
// handlers.
const http = require('http');
const path = require('path');

const sourceRoot = process.env.S01_SOURCE_ROOT || process.argv[2] || '/ref';
const { SkillService } = require(path.join(sourceRoot, 'packages/baseskill/lib/SkillService'));
const { GraphManager } = require(path.join(sourceRoot, 'packages/baseskill/lib/graph/GraphManager'));
const { ExampleSkill } = require(path.join(sourceRoot, 'packages/example-skill/lib/ExampleSkill'));
const { Chitchat } = require(path.join(sourceRoot, 'packages/chitchat-skill/lib/Chitchat'));
const { PersonalReport } = require(path.join(sourceRoot, 'packages/report-skill/lib/PersonalReport'));

const GENERAL = { accountID: 'fixture-account', robotID: 'fixture-robot' };

function casesForSkill(name) {
  const invalid = (data) => ({ type: 'NOT_A_REQUEST', data });
  const withGeneral = (extra = {}) => ({ general: GENERAL, ...extra });
  return [
    { name: 'data-null', body: invalid(null) },
    { name: 'data-array', body: invalid([]) },
    { name: 'general-missing', body: invalid({}) },
    { name: 'general-null', body: invalid({ general: null }) },
    { name: 'general-number', body: invalid({ general: 7 }) },
    { name: 'general-string', body: invalid({ general: 'fixture' }) },
    { name: 'general-array', body: invalid({ general: [] }) },
    { name: 'account-missing', body: invalid({ general: { robotID: 'fixture-robot' } }) },
    { name: 'account-empty', body: invalid({ general: { accountID: '', robotID: 'fixture-robot' } }) },
    { name: 'robot-missing', body: invalid({ general: { accountID: 'fixture-account' } }) },
    { name: 'robot-empty', body: invalid({ general: { accountID: 'fixture-account', robotID: '' } }) },
    { name: 'skill-missing', body: invalid(withGeneral()) },
    { name: 'skill-null', body: invalid(withGeneral({ skill: null })) },
    { name: 'skill-false', body: invalid(withGeneral({ skill: false })) },
    { name: 'skill-empty-object', body: invalid(withGeneral({ skill: {} })) },
    { name: 'skill-empty-id', body: invalid(withGeneral({ skill: { id: '' } })) },
    { name: 'skill-zero-id', body: invalid(withGeneral({ skill: { id: 0 } })) },
    { name: 'skill-array', body: invalid(withGeneral({ skill: [] })) },
    { name: 'skill-string', body: invalid(withGeneral({ skill: 'existing' })) },
    { name: 'skill-number', body: invalid(withGeneral({ skill: 7 })) },
    { name: 'skill-mismatch', body: invalid(withGeneral({ skill: { id: 'other-skill' } })) },
    { name: 'type-missing', body: { data: withGeneral({ skill: { id: name } }) } },
    { name: 'type-null', body: { type: null, data: withGeneral({ skill: { id: name } }) } },
    { name: 'type-number', body: { type: 0, data: withGeneral({ skill: { id: name } }) } },
    { name: 'type-invalid', body: invalid(withGeneral({ skill: { id: name } })) },
    { name: 'update-no-session', body: { type: 'LISTEN_UPDATE', data: withGeneral({ skill: { id: name } }) } },
    { name: 'update-null-session', body: { type: 'LISTEN_UPDATE', data: withGeneral({ skill: { id: name, session: null } }) } },
    { name: 'update-empty-session', body: { type: 'LISTEN_UPDATE', data: withGeneral({ skill: { id: name, session: {} } }) } },
    { name: 'update-number-session', body: { type: 'LISTEN_UPDATE', data: withGeneral({ skill: { id: name, session: 7 } }) } },
  ];
}

function request(port, item) {
  return new Promise((resolve, reject) => {
    const raw = JSON.stringify(item.body);
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/v1/main',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(raw),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => resolve({
        status: res.statusCode,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      }));
    });
    req.on('error', reject);
    req.end(raw);
  });
}

function normalize(value, key) {
  if (key === 'msgID') return '<msgID>';
  if (key === 'ts') return '<ts>';
  if (key === 'total') return '<timing-number>';
  if (Array.isArray(value)) return value.map(item => normalize(item));
  if (value && typeof value === 'object') {
    return Object.keys(value).reduce((output, name) => {
      output[name] = normalize(value[name], name);
      return output;
    }, {});
  }
  return value;
}

function sourceLog() {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
    createChild() { return this; },
  };
}

function sessionWitness(session) {
  if (session === undefined) return { kind: 'missing' };
  if (!session) return { kind: 'falsy', type: typeof session, value: session };
  if (typeof session !== 'object') return { kind: 'truthy', type: typeof session, value: session };
  return {
    kind: 'truthy-object',
    id: session.id === 'old-session' ? 'old-session' : '<generated>',
    nodeID: session.nodeID,
    traceLength: Array.isArray(session.trace) ? session.trace.length : null,
  };
}

async function probeLaunchSessions() {
  const rows = {};
  for (const type of ['LISTEN_LAUNCH', 'PROACTIVE_LAUNCH']) {
    for (const [label, session] of [
      ['missing', undefined],
      ['null', null],
      ['false', false],
      ['zero', 0],
      ['empty-string', ''],
      ['truthy-object', { id: 'old-session', nodeID: 99, data: {}, trace: [] }],
    ]) {
      GraphManager._resetInstance();
      const skill = new ExampleSkill();
      const skillData = {
        general: GENERAL,
        skill: { id: 'example-skill' },
        result: type === 'PROACTIVE_LAUNCH'
          ? { memo: 'Proactive entry 1' }
          : { nlu: { intent: 'intent2' } },
      };
      if (session !== undefined) skillData.skill.session = session;
      const body = { type, data: skillData };
      const before = sessionWitness(body.data.skill.session);
      try {
        const response = await skill.handle({ body, log: sourceLog() });
        rows[`${type}:${label}`] = {
          outcome: 'success',
          before,
          after: sessionWitness(body.data.skill.session),
          responseType: response.type,
        };
      } catch (error) {
        rows[`${type}:${label}`] = {
          outcome: 'error',
          before,
          after: sessionWitness(body.data.skill.session),
          message: error && error.message,
        };
      }
    }
  }
  return rows;
}

async function probeSkill(name, SkillClass) {
  GraphManager._resetInstance();
  const skill = new SkillClass();
  const service = new SkillService(skill);
  await service.init(0);
  const port = service.server.address().port;
  const cases = casesForSkill(name);
  const httpResults = {};
  try {
    for (const item of cases) {
      const response = await request(port, item);
      httpResults[item.name] = { status: response.status, body: normalize(response.body) };
    }
  } finally {
    await service.close();
  }

  // HTTP error envelopes cannot show whether fallback mutation occurred. The
  // same source GraphSkill method is called directly for the source-shaped
  // falsy/empty skill values and its post-call request body is recorded.
  const directMutation = {};
  for (const [label, skillValue] of [
    ['missing', undefined],
    ['null', null],
    ['false', false],
    ['empty-object', {}],
    ['empty-id', { id: '' }],
    ['array', []],
  ]) {
    GraphManager._resetInstance();
    const directSkill = new SkillClass();
    const body = { type: 'NOT_A_REQUEST', data: { general: GENERAL, skill: skillValue } };
    try {
      await directSkill.handle({ body, log: sourceLog() });
    } catch (error) {
      directMutation[label] = {
        message: error && error.message,
        skill: body.data.skill,
        skillId: body.data.skill && body.data.skill.id,
      };
    }
  }
  return { http: httpResults, directMutation };
}

(async () => {
  const skills = {
    'example-skill': ExampleSkill,
    'chitchat-skill': Chitchat,
    'report-skill': PersonalReport,
  };
  const results = {};
  for (const [name, SkillClass] of Object.entries(skills)) {
    results[name] = await probeSkill(name, SkillClass);
  }
  const launchSession = await probeLaunchSessions();
  console.log(JSON.stringify({ runtime: process.version, results, launchSession }, null, 2));
})().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
