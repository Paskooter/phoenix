'use strict';

// Source-only request-boundary probe. Run against the frozen Pegasus tree in
// the pinned Node 8 image. It intentionally sends object bodies that violate
// SkillRequest's Phoenix schema: BaseSkill forwards those bodies to the real
// graph skill, while the shared JSON parser still owns primitive and malformed
// transport entities.
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
  return [
    { name: 'missing-body-fields', body: {} },
    { name: 'missing-type', body: { data: { general: GENERAL, skill: { id: name } } } },
    { name: 'missing-data', body: { type: 'LISTEN_LAUNCH' } },
    { name: 'missing-general', body: { type: 'LISTEN_LAUNCH', data: {} } },
    { name: 'missing-skill', body: { type: 'NOT_A_REQUEST', data: { general: GENERAL } } },
    { name: 'missing-session', body: { type: 'LISTEN_UPDATE', data: { general: GENERAL, skill: { id: name } } } },
    { name: 'invalid-request-type', body: { type: 'NOT_A_REQUEST', data: { general: GENERAL, skill: { id: name } } } },
    { name: 'primitive-null', raw: 'null' },
    { name: 'primitive-string', raw: JSON.stringify('fixture') },
    { name: 'primitive-number', raw: '7' },
    { name: 'invalid-json', raw: '{"type":' },
  ];
}

function request(port, item) {
  return new Promise((resolve, reject) => {
    const raw = item.raw === undefined ? JSON.stringify(item.body) : item.raw;
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
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let body;
        try {
          body = JSON.parse(text);
        } catch (error) {
          body = { parseError: error.message, raw: text };
        }
        resolve({ status: res.statusCode, body });
      });
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

async function probeSkill(name, SkillClass) {
  GraphManager._resetInstance();
  const service = new SkillService(new SkillClass());
  await service.init(0);
  const port = service.server.address().port;
  const cases = casesForSkill(name);
  try {
    const results = {};
    for (const item of cases) {
      const response = await request(port, item);
      results[item.name] = { status: response.status, body: normalize(response.body) };
    }
    return results;
  } finally {
    await service.close();
  }
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
  console.log(JSON.stringify({ runtime: process.version, results }, null, 2));
})().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
