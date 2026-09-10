// A-15 runtime probe: start the Classic entrypoint and drive EVERY Person_20160801 operation and
// Collision_20161126.Match over the exact AWS-JSON wire the robot/app uses. Responses are then
// projected through the operation's DECLARED output shape from the pinned api models — the same
// field-stripping the generated aws-sdk client applies — so the printed object is what a client
// can actually observe (undeclared fields are unobservable, not a defect).
//
// Output shapes copied verbatim from the pinned files read through the Jibo archive MCP:
//   apis/person-2016-08-01.normal.json     jiborobot/srv-jibo-server-client
//   apis/collision-2016-11-26.normal.json  jiborobot/srv-jibo-server-client

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClassicEntrypoint } from '../../../../../packages/classic/src/index.js';
import { PersonStore } from '../../../../../packages/classic/src/person.js';

const OWNER = 'acct-owner';
const OTHER = 'acct-other';

// --- declared output shapes (pinned) ------------------------------------------------------------
const STRING = { type: 'string' };
const BOOLEAN = { type: 'boolean' };
const INTEGER = { type: 'integer' };
const NAME = STRING;
const KEY = STRING;
const QUESTION = STRING;
const ANSWER = STRING;
const OPTION_KEY = STRING;
const IMAGE = STRING;
const PROPERTY_KEY = STRING;
const HOLIDAY_ID = STRING;
const CATEGORY = STRING;
const TIMESTAMP = { type: 'long' };
const ENABLE_DISABLE = { type: 'structure', members: { result: STRING } };
const OPTION_OBJECT = { type: 'structure', members: { key: OPTION_KEY, answer: ANSWER, image: IMAGE } };
const OPTIONS_LIST = { type: 'list', member: OPTION_OBJECT };
const QUESTION_OBJECT = { type: 'structure', members: { key: KEY, question: QUESTION, options: OPTIONS_LIST } };
const LIST_RESPONSE = { type: 'list', member: QUESTION_OBJECT };
const ANSWER_OBJECT = { type: 'structure', members: { key: KEY, answer: ANSWER } };
const PROPERTY_MAP = { type: 'map', value: { type: 'object' } };
const PROPERTY_KEY_LIST = { type: 'list', member: PROPERTY_KEY };
const LIST_ACCOUNT_PROPERTY_KEYS_RESULT = { type: 'structure', members: { keys: PROPERTY_KEY_LIST } };
const HOLIDAY = {
  type: 'structure',
  members: {
    id: HOLIDAY_ID, eventId: STRING, name: STRING, category: CATEGORY, subcategory: CATEGORY,
    loopId: STRING, memberId: STRING, isEnabled: BOOLEAN, date: STRING, endDate: STRING, created: TIMESTAMP,
  },
};
const HOLIDAYS = { type: 'list', member: HOLIDAY };
const COLLISION_MATCH_OUTPUT = {
  type: 'structure',
  members: { success: BOOLEAN, collision: BOOLEAN, closest_pair: NAME, distance: INTEGER },
};

/** Minimal aws-json output-shape projector: keep only declared members (the SDK's visible view). */
function project(shape, value) {
  if (value === null || value === undefined) return value;
  if (shape.type === 'list') return value.map((item) => project(shape.member, item));
  if (shape.type === 'map') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = project(shape.value, v);
    return out;
  }
  if (shape.type === 'structure') {
    const out = {};
    for (const [k, member] of Object.entries(shape.members)) {
      if (Object.prototype.hasOwnProperty.call(value, k)) out[k] = project(member, value[k]);
    }
    return out;
  }
  return value;
}

const PERSON_OPS = {
  List: { body: { category: 'app' }, shape: LIST_RESPONSE },
  Answer: { body: { key: 'APP_CAKE_PREFERENCE', answer: 'PINEAPPLE' }, shape: ANSWER_OBJECT },
  EnableHolidays: { body: { ids: [], loopId: 'loop-1' }, shape: ENABLE_DISABLE },
  ListHolidays: { body: { loopId: 'loop-1' }, shape: HOLIDAYS },
  DisableHolidays: { body: { ids: [], loopId: 'loop-1' }, shape: ENABLE_DISABLE },
  SetLoopProperty: { body: { loopId: 'loop-1', key: 'k', value: { a: 1 } }, shape: null },
  GetLoopProperties: { body: { loopId: 'loop-1', keys: ['k'] }, shape: PROPERTY_MAP },
  SetAccountProperty: { body: { key: 'sz', value: { a: 2 } }, shape: null },
  GetAccountProperties: { body: { keys: ['sz'] }, shape: PROPERTY_MAP },
  ListAccountPropertyKeys: { body: {}, shape: LIST_ACCOUNT_PROPERTY_KEYS_RESULT },
};

async function call(port, target, body, { accessKeyId = OWNER, credentials } = {}) {
  const headers = { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': target };
  if (credentials) headers['x-amz-credentials'] = credentials;
  else if (accessKeyId) headers.authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/20180910/us-east-1/x/aws4_request, SignedHeaders=host, Signature=ff`;
  const res = await fetch(`http://localhost:${port}/`, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, errType: res.headers.get('x-amzn-errortype'), body: parsed };
}

const dir = await mkdtemp(join(tmpdir(), 'a15-probe-'));
const NOV_2018 = Date.UTC(2018, 8, 10, 12, 0, 0);
const account = {
  isLoopMember: async ({ loopId, accountId }) => loopId === 'loop-1',
  isAccountOwnerOrRobot: async ({ loopId, accountId }) => loopId === 'loop-1' && accountId === OWNER,
  listBirthdays: async () => [{ memberId: 'm1', date: '2018-06-01' }],
};
const server = await createClassicEntrypoint({
  person: { store: new PersonStore({ file: join(dir, 'p.json') }), account, now: () => NOV_2018 },
}).listen(0);
const port = server.address().port;
const report = {};

try {
  for (const [op, spec] of Object.entries(PERSON_OPS)) {
    const res = await call(port, `Person_20160801.${op}`, spec.body);
    report[`Person_20160801.${op}`] = {
      status: res.status,
      served: res.status >= 200 && res.status < 300,
      visible: spec.shape ? project(spec.shape, res.body) : res.body,
    };
  }

  const collision = await call(port, 'Collision_20161126.Match', { name: 'amir', existingNames: ['emir', 'alex'] });
  report['Collision_20161126.Match'] = { status: collision.status, served: collision.status === 200, visible: project(COLLISION_MATCH_OUTPUT, collision.body) };

  // Identity seam: the Account Settings client sends `x-amz-credentials: {"id":…}` (no SigV4).
  const creds = await call(port, 'Person_20160801.SetAccountProperty', { key: 'via-creds', value: { ok: true } }, { credentials: JSON.stringify({ id: OTHER }) });
  const credsRead = await call(port, 'Person_20160801.GetAccountProperties', { keys: ['via-creds'] }, { credentials: JSON.stringify({ id: OTHER }) });
  report.identity = {
    'x-amz-credentials write status': creds.status,
    'x-amz-credentials read (same id) visible': project(PROPERTY_MAP, credsRead.body),
  };

  // Gateway requirement: an unsigned Person/Collision call is rejected.
  const unsigned = await call(port, 'Person_20160801.List', { category: 'app' }, { accessKeyId: null });
  const unsignedCollision = await call(port, 'Collision_20161126.Match', { name: 'a', existingNames: [] }, { accessKeyId: null });
  report.unsigned = { person: { status: unsigned.status, errType: unsigned.errType }, collision: { status: unsignedCollision.status, errType: unsignedCollision.errType } };
} finally {
  await server.close();
  await rm(dir, { recursive: true, force: true });
}

const outFile = new URL('./live-probe.json', import.meta.url);
await writeFile(outFile, `${JSON.stringify(report, null, 2)}\n`);
const ops = Object.entries(report).filter(([k]) => k.includes('_2016'));
console.log(`SERVED ${ops.length} operations; all 2xx = ${ops.every(([, v]) => v.served)}`);
console.log(`wrote ${outFile.pathname}`);
