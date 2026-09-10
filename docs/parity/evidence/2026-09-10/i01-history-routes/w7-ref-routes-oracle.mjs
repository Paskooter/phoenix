// I-01 reference HTTP oracle — REAL pinned Pegasus classes, not a reconstruction.
//
// Loads the COMPILED reference code from the pinned tree
//   .parity/reference/5c0a7390539663ba749d360de348a428c088505c/packages/history/lib
// and drives it over real HTTP:
//   * utils.service.BaseService            (real Express app + body parsers + 404/error envelope)
//   * SkillLaunchRequestsHandler           (real route table + handler code)
//   * SpeechHistoryRequestsHandler         (real route table + handler code)
//   * SkillLaunchCollection                (real documentToJSON / saveSkillPayload / getLatest / getCount)
//   * SpeechHistoryRecordsCollection       (real updateRecord whitelist / null-strip)
//
// LIMIT (stated, not hidden): the mongoose `Model` is stubbed because no mongod binary exists in
// this environment, and `BaseService` is used directly rather than the `HistoryService` subclass
// (whose constructor dials Mongo). The stub IS a record holder only. Two consequences:
//   - the eager argument evaluation in the REAL `findOneAndUpdate(filter, {$set:{...}})` call is
//     real reference code, which is exactly what the payload-update cases need;
//   - `record._id` on a null lookup is real reference code (SpeechHistoryRecordsCollection.js:49).
// Record SELECTION / sorting / BSON casting (ISODate on the wire, ObjectId ids) need a live Mongo
// and stay INFERRED from source; they are not claimed here.
//
// Run:  NODE_PATH=/tmp/i01oracle/node_modules node w7-ref-routes-oracle.mjs <out.json>
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';

const REF = '/home/shell/work/phoenix/.parity/reference/5c0a7390539663ba749d360de348a428c088505c';
const require = createRequire(REF + '/packages/history/');

const utils = require('@jibo/utils');
const { SkillLaunchRequestsHandler } = require(REF + '/packages/history/lib/skilllaunch/SkillLaunchRequestsHandler.js');
const { SpeechHistoryRequestsHandler } = require(REF + '/packages/history/lib/speech/SpeechHistoryRequestsHandler.js');
const { SkillLaunchCollection } = require(REF + '/packages/history/lib/skilllaunch/db/SkillLaunchCollection.js');
const { SpeechHistoryRecordsCollection } = require(REF + '/packages/history/lib/speech/db/SpeechHistoryRecordsCollection.js');

/** Evaluate the subset of Mongo query operators the real SkillLaunchQueryBuilder emits.
 *  buildQuery() is REAL reference code; this only interprets its output document
 *  ({'$and':[{'robotID':{'$eq':…}}, {'timestamp':{'$gte':…}}, …]}) against the stub records. */
function matches(doc, query) {
  if (!query || typeof query !== 'object') return true;
  if (Array.isArray(query.$and)) return query.$and.every((q) => matches(doc, q));
  return Object.entries(query).every(([field, cond]) => {
    const value = field.split('.').reduce((o, k) => (o == null ? undefined : o[k]), doc);
    if (cond === null || typeof cond !== 'object') return value === cond;
    if (cond.$eq !== undefined) return value === cond.$eq;
    if (cond.$ne !== undefined) return value !== cond.$ne;
    if (cond.$gte !== undefined) return value >= cond.$gte;
    if (cond.$lte !== undefined) return value <= cond.$lte;
    if (cond.$in !== undefined) return cond.$in.includes(value);
    return true;
  });
}

/** Minimal mongoose-Model stand-in bound to one record array. */
function makeModel(db) {
  const calls = { findOneAndUpdate: 0, findOne: 0, count: 0, findByIdAndUpdate: 0 };
  const Model = function (data) {
    Object.assign(this, data);
    this._id = String(db.length + 1).padStart(24, '0');
    this.__v = 0;
  };
  Model.prototype.save = async function () { db.push(this); };
  Model.calls = calls;
  Model.findOneAndUpdate = (filter, update) => {
    calls.findOneAndUpdate += 1;
    const hit = db.find((d) => d.sessionID === filter.sessionID && d.robotID === filter.robotID && d.skillID === filter.skillID);
    if (hit) Object.assign(hit, update.$set);
    return { exec: async () => hit || null };
  };
  Model.findOne = (query) => ({
    setOptions: (opts) => ({
      exec: async () => {
        calls.findOne += 1;
        const hits = db.filter((d) => matches(d, query));
        if (opts && opts.sort && opts.sort.timestamp === -1) hits.sort((a, b) => b.timestamp - a.timestamp || (b._id > a._id ? 1 : -1));
        return hits[0] || null;
      },
    }),
  });
  Model.count = (query) => ({
    exec: async () => {
      calls.count += 1;
      return db.filter((d) => matches(d, query)).length;
    },
  });
  Model.findByIdAndUpdate = (id, update) => ({
    exec: async () => {
      calls.findByIdAndUpdate += 1;
      const hit = db.find((d) => d._id === id) || null;
      if (hit) Object.assign(hit, update.$set);
      return hit;
    },
  });
  return Model;
}

/** Shared realistic wall-clock timestamp so retention (14 days) never interferes. */
const TS = 1789084000000;

// The pinned collection layer constructs `new this.model(data)`; wire the stub in. The real
// methods (documentToJSON, saveSkillPayload, getLatest, getCount, updateRecord) stay untouched.
const collectionWithModel = (Cls, model) => Object.assign(Object.create(Cls.prototype), { model });

const skillDb = [];
const speechDb = [];
const skillModel = makeModel(skillDb);
const speechModel = makeModel(speechDb);
const skillCollection = collectionWithModel(SkillLaunchCollection, skillModel);
const speechCollection = collectionWithModel(SpeechHistoryRecordsCollection, speechModel);

// --- real BaseService + real handler routers ---------------------------------
const service = new utils.service.BaseService('History');
service.addHttpHandler('/v1/skill/launch', {
  handler: new SkillLaunchRequestsHandler({ events: skillCollection }),
  authenticationRequired: false,
});
service.addHttpHandler('/v1/speech', {
  handler: new SpeechHistoryRequestsHandler({ speechRecords: speechCollection }),
  authenticationRequired: false,
});

await service.init(0);
const base = `http://127.0.0.1:${service.server.address().port}`;

async function probe(method, path, { body, query, headers, raw } = {}) {
  const url = query ? `${base}${path}?${query}` : `${base}${path}`;
  const h = { ...(headers || {}) };
  let payload;
  if (raw !== undefined) payload = raw;
  else if (body !== undefined) { payload = JSON.stringify(body); h['content-type'] = 'application/json'; }
  const res = await fetch(url, { method, headers: h, body: payload });
  const text = await res.text();
  let json = null; try { json = text === '' ? null : JSON.parse(text); } catch { json = text; }
  const env = json && json.type === 'ERROR'
    ? { type: json.type, final: json.final, message: json.data && json.data.message }
    : undefined;
  return { method, path: path + (query ? `?${query}` : ''), status: res.status, contentType: res.headers.get('content-type'), body: json, envelope: env };
}

const out = [];
const rec = async (label, ...a) => { out.push({ label, ...(await probe(...a)) }); };

// 1. route inventory / method matrix (mirrors w7-runtime-probe.mjs)
await rec('POST /v1/skill/launch full', 'POST', '/v1/skill/launch', { body: { timestamp: TS, sessionID: 'sess-1', robotID: 'R-1', skillID: 'SK-1', intent: 'intent-1', personIDs: ['person-2', 'person-1'] } });
await rec('PUT /v1/skill/launch/payload match', 'PUT', '/v1/skill/launch/payload', { body: { sessionID: 'sess-1', robotID: 'R-1', skillID: 'SK-1', payload: { a: 1, b: 2 } } });
await rec('PUT /v1/skill/launch/payload no match, payload present', 'PUT', '/v1/skill/launch/payload', { body: { sessionID: 'nope', robotID: 'R-x', skillID: 'SK-x', payload: { a: 1 } } });
await rec('PUT /v1/skill/launch/payload NO payload key, no match', 'PUT', '/v1/skill/launch/payload', { body: { sessionID: 'nope', robotID: 'R-y', skillID: 'SK-y' } });
await rec('PUT /v1/skill/launch/payload NO payload key, match', 'PUT', '/v1/skill/launch/payload', { body: { sessionID: 'sess-1', robotID: 'R-1', skillID: 'SK-1' } });
await rec('PUT /v1/skill/launch/payload payload null, no match', 'PUT', '/v1/skill/launch/payload', { body: { sessionID: 'nope', robotID: 'R-z', skillID: 'SK-z', payload: null } });
await rec('POST /v1/skill/launch/latest hit', 'POST', '/v1/skill/launch/latest', { body: { robotID: 'R-1', rules: [] } });
await rec('POST /v1/skill/launch/latest miss', 'POST', '/v1/skill/launch/latest', { body: { robotID: 'R-absent', rules: [] } });
await rec('GET /v1/skill/launch/latest hit', 'GET', '/v1/skill/launch/latest', { query: 'robotID=R-1' });
await rec('GET /v1/skill/launch/latest miss', 'GET', '/v1/skill/launch/latest', { query: 'robotID=R-absent' });
await rec('POST /v1/skill/launch/count', 'POST', '/v1/skill/launch/count', { body: { robotID: 'R-1', rules: [] } });
await rec('GET /v1/skill/launch/count', 'GET', '/v1/skill/launch/count', { query: 'robotID=R-1' });
const speech = await probe('POST', '/v1/speech', { body: { robotID: 'some-robot-id', accountID: 'some-acc-id', transID: 'some-trans-id', audioFileURL: 'http://aws.test.com', timestamp: TS } });
out.push({ label: 'POST /v1/speech create', ...speech });
await rec('PUT /v1/speech/:id update', 'PUT', `/v1/speech/${speech.body.id}`, { body: { audioFileURL: 'http://aws2.test.com', asr: null } });
await rec('PUT /v1/speech/:id unknown id', 'PUT', '/v1/speech/deadbeefdeadbeefdeadbeef', { body: { audioFileURL: 'http://x' } });
await rec('GET /healthcheck', 'GET', '/healthcheck', {});

// 2. error / routing envelope matrix
await rec('GET /v1/skill/launch/does-not-exist', 'GET', '/v1/skill/launch/does-not-exist', {});
await rec('GET /nope', 'GET', '/nope', {});
await rec('DELETE /v1/skill/launch/latest', 'DELETE', '/v1/skill/launch/latest', {});
await rec('PATCH /v1/skill/launch/count', 'PATCH', '/v1/skill/launch/count', {});
await rec('PUT /v1/skill/launch/latest', 'PUT', '/v1/skill/launch/latest', {});
await rec('POST /v1/skill/launch/ trailing slash', 'POST', '/v1/skill/launch/', { body: { timestamp: TS + 1000, sessionID: 's2', robotID: 'R-2', skillID: 'SK-2' } });
await rec('GET /V1/SKILL/LAUNCH/COUNT case-insensitive', 'GET', '/V1/SKILL/LAUNCH/COUNT', { query: 'robotID=R-2' });
await rec('HEAD /v1/skill/launch/count', 'HEAD', '/v1/skill/launch/count', { query: 'robotID=R-2' });
await rec('POST /v1/skill/launch empty body no content-type', 'POST', '/v1/skill/launch', {});
await rec('POST /v1/skill/launch text/plain body', 'POST', '/v1/skill/launch', { raw: 'hello', headers: { 'content-type': 'text/plain' } });
await rec('POST /v1/skill/launch malformed JSON', 'POST', '/v1/skill/launch', { raw: '{"a":', headers: { 'content-type': 'application/json' } });
await rec('GET /v1/skill/launch/latest no query', 'GET', '/v1/skill/launch/latest', {});
await rec('POST /v1/skill/launch/count empty body', 'POST', '/v1/skill/launch/count', {});
await rec('PUT /v1/speech/:id empty body', 'PUT', '/v1/speech/abc', {});
await rec('GET /skill/launch/count BARE alias (expect 404)', 'GET', '/skill/launch/count', { query: 'robotID=R-1' });
await rec('PUT /speech/abc BARE alias (expect 404)', 'PUT', '/speech/abc', { body: {} });

// 3. retention substrate probe (I-03-owned): Phoenix prunes synchronously on read/write; the
// reference delegates to Mongo's TTL index on the `timestamp` field (Schema: expires 14*86400).
await rec('RETENTION: POST old timestamp (40 days ago)', 'POST', '/v1/skill/launch', { body: { timestamp: TS - 40 * 86400 * 1000, sessionID: 's-old', robotID: 'R-old', skillID: 'SK-old' } });
await rec('RETENTION: GET count for the old record', 'GET', '/v1/skill/launch/count', { query: 'robotID=R-old' });

const result = {
  oracle: 'REAL compiled pegasus classes (BaseService + real handlers + real collections); mongoose Model stubbed',
  express: require('express/package.json').version,
  bodyParser: require('body-parser/package.json').version,
  modelCalls: skillModel.calls,
  cases: out,
};
writeFileSync(process.argv[2] || 'w7-ref-routes-oracle.json', JSON.stringify(result, null, 2));
console.log(JSON.stringify({ cases: out.length, modelCalls: skillModel.calls }, null, 1));
service.server.close();
process.exit(0);
