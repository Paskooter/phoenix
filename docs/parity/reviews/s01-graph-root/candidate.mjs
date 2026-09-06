import http from 'node:http';
import { pathToFileURL, fileURLToPath } from 'node:url';
const candidateRoot = process.env.PHOENIX_ROOT || fileURLToPath(new URL('../../../../', import.meta.url));
const { createSkillsService } = await import(pathToFileURL(`${candidateRoot}/packages/skills/src/skillService.js`));
const { SKILLS } = await import(pathToFileURL(`${candidateRoot}/packages/skills/src/index.js`));

const GENERAL = { accountID: 'fixture-account', robotID: 'fixture-robot' };
function casesForSkill(name) {
  const invalid = (data) => ({ type: 'NOT_A_REQUEST', data });
  const withGeneral = (extra = {}) => ({ general: GENERAL, ...extra });
  return [
    ['data-null', invalid(null)],
    ['data-array', invalid([])],
    ['general-missing', invalid({})],
    ['general-null', invalid({ general: null })],
    ['general-number', invalid({ general: 7 })],
    ['general-string', invalid({ general: 'fixture' })],
    ['general-array', invalid({ general: [] })],
    ['account-missing', invalid({ general: { robotID: 'fixture-robot' } })],
    ['account-empty', invalid({ general: { accountID: '', robotID: 'fixture-robot' } })],
    ['robot-missing', invalid({ general: { accountID: 'fixture-account' } })],
    ['robot-empty', invalid({ general: { accountID: 'fixture-account', robotID: '' } })],
    ['skill-missing', invalid(withGeneral())],
    ['skill-null', invalid(withGeneral({ skill: null }))],
    ['skill-false', invalid(withGeneral({ skill: false }))],
    ['skill-empty-object', invalid(withGeneral({ skill: {} }))],
    ['skill-empty-id', invalid(withGeneral({ skill: { id: '' } }))],
    ['skill-zero-id', invalid(withGeneral({ skill: { id: 0 } }))],
    ['skill-array', invalid(withGeneral({ skill: [] }))],
    ['skill-string', invalid(withGeneral({ skill: 'existing' }))],
    ['skill-number', invalid(withGeneral({ skill: 7 }))],
    ['skill-mismatch', invalid(withGeneral({ skill: { id: 'other-skill' } }))],
    ['type-missing', { data: withGeneral({ skill: { id: name } }) }],
    ['type-null', { type: null, data: withGeneral({ skill: { id: name } }) }],
    ['type-number', { type: 0, data: withGeneral({ skill: { id: name } }) }],
    ['type-invalid', invalid(withGeneral({ skill: { id: name } }))],
    ['update-no-session', { type: 'LISTEN_UPDATE', data: withGeneral({ skill: { id: name } }) }],
    ['update-null-session', { type: 'LISTEN_UPDATE', data: withGeneral({ skill: { id: name, session: null } }) }],
    ['update-empty-session', { type: 'LISTEN_UPDATE', data: withGeneral({ skill: { id: name, session: {} } }) }],
    ['update-number-session', { type: 'LISTEN_UPDATE', data: withGeneral({ skill: { id: name, session: 7 } }) }],
  ];
}
function req(port, path, body) {
  return new Promise((resolve, reject) => {
    const raw = JSON.stringify(body);
    const q = http.request({ hostname: '127.0.0.1', port, path, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) } }, (res) => {
      let s = '';
      res.on('data', (x) => { s += x; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(s) }));
      res.on('error', reject);
    });
    q.on('error', reject);
    q.end(raw);
  });
}
function norm(value, key) {
  if (key === 'msgID') return '<msgID>';
  if (key === 'ts') return '<ts>';
  if (key === 'total') return '<timing-number>';
  if (Array.isArray(value)) return value.map((item) => norm(item));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, norm(item, name)]));
  return value;
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
  const exampleHandler = SKILLS.find(({ id }) => id === 'example-skill').handler;
  const log = { debug() {}, warn() {}, error() {}, info() {} };
  for (const type of ['LISTEN_LAUNCH', 'PROACTIVE_LAUNCH']) {
    for (const [label, session] of [
      ['missing', undefined],
      ['null', null],
      ['false', false],
      ['zero', 0],
      ['empty-string', ''],
      ['truthy-object', { id: 'old-session', nodeID: 99, data: {}, trace: [] }],
    ]) {
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
        const response = await exampleHandler(body, { log });
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
const service = createSkillsService({ name: 'skills', skills: SKILLS, defaultId: 'answer-skill' });
await service.listen(0);
const port = service.server.address().port;
const result = {};
try {
  for (const id of ['example-skill', 'chitchat-skill', 'report-skill']) {
    result[id] = {};
    for (const [label, body] of casesForSkill(id)) {
      const response = await req(port, `/v1/${id}/main`, body);
      result[id][label] = { status: response.status, body: norm(response.body) };
    }
  }
} finally {
  await new Promise((resolve, reject) => service.server.close((error) => error ? reject(error) : resolve()));
}
const directMutation = {};
for (const name of ['example-skill', 'chitchat-skill', 'report-skill']) {
  directMutation[name] = {};
  const handler = SKILLS.find(({id}) => id === name).handler;
  for (const [label, skillValue] of [['missing', undefined], ['null', null], ['false', false], ['empty-object', {}], ['empty-id', {id:''}], ['array', []]]) {
    const body = {type:'NOT_A_REQUEST', data:{general:GENERAL, skill:skillValue}};
    try { await handler(body); } catch (error) {
      directMutation[name][label] = {message:error.message, skill:body.data.skill, skillId:body.data.skill && body.data.skill.id};
    }
  }
}
const launchSession = await probeLaunchSessions();
console.log(JSON.stringify({ runtime: process.version, result, directMutation, launchSession }, null, 2));
