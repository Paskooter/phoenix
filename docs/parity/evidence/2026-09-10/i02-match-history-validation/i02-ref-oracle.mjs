// I-02 reference HTTP oracle — the I-01 oracle, extended.
//
// Loads the COMPILED pinned Pegasus classes from
//   .parity/reference/5c0a7390539663ba749d360de348a428c088505c/packages/history/lib
// and drives them over real HTTP with the SAME case matrix as the live Phoenix probe
// (i02-matrix.mjs):
//   * utils.service.BaseService            (real Express app + body parsers + 404/error envelope)
//   * SkillLaunchRequestsHandler           (real route table + handler + validation order)
//   * validators/{event,query,rule}        (real joi@13.1.2 schemas — the validation contract)
//   * SkillLaunchCollection                (real documentToJSON / saveSkillPayload / getLatest / getCount)
//   * SkillLaunchQueryBuilder              (real $and document construction)
//
// LIMIT (stated, not hidden — unchanged from I-01): the mongoose `Model` is stubbed because no
// mongod binary exists in this environment. The stub holds records and interprets the query
// document the REAL SkillLaunchQueryBuilder emits. Consequences:
//   - validation, error envelopes, status codes, evaluation order and query-DOCUMENT shape are all
//     real reference code and are claimed as VERIFIED;
//   - record SELECTION/sorting and BSON Date-vs-number casting need a live Mongo and stay INFERRED.
//   - the stub's findOneAndUpdate returns the first matching record (Phoenix picks the last); every
//     case in the matrix targets a sessionID+robotID+skillID triple that matches at most one record,
//     so the difference is not exercised.
//
// Run:  NODE_PATH=/tmp/i01oracle/node_modules node i02-ref-oracle.mjs <out.json>
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { runMatrix } from './i02-matrix.mjs';

const REF = '/home/shell/work/phoenix/.parity/reference/5c0a7390539663ba749d360de348a428c088505c';
const require = createRequire(REF + '/packages/history/');

const utils = require('@jibo/utils');
const { SkillLaunchRequestsHandler } = require(REF + '/packages/history/lib/skilllaunch/SkillLaunchRequestsHandler.js');
const { SpeechHistoryRequestsHandler } = require(REF + '/packages/history/lib/speech/SpeechHistoryRequestsHandler.js');
const { SkillLaunchCollection } = require(REF + '/packages/history/lib/skilllaunch/db/SkillLaunchCollection.js');
const { SpeechHistoryRecordsCollection } = require(REF + '/packages/history/lib/speech/db/SpeechHistoryRecordsCollection.js');
const { SkillLaunchQueryBuilder } = require(REF + '/packages/history/lib/skilllaunch/db/SkillLaunchQueryBuilder.js');

const getPath = (doc, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), doc);

/** Mongo equality as the emitted operators need it: arrays compare element-wise and in order. */
function eq(a, b) {
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => x === b[i]);
  }
  return a === b;
}

/** Evaluate the subset of Mongo query operators the real SkillLaunchQueryBuilder emits. */
function matches(doc, query) {
  if (!query || typeof query !== 'object') return true;
  if (Array.isArray(query.$and)) return query.$and.every((q) => matches(doc, q));
  if (Array.isArray(query.$or)) return query.$or.some((q) => matches(doc, q));
  return Object.entries(query).every(([field, cond]) => {
    const value = getPath(doc, field);
    if (cond === null || typeof cond !== 'object') return eq(value, cond);
    if ('$eq' in cond) return eq(value, cond.$eq);
    if ('$ne' in cond) return !eq(value, cond.$ne);
    if ('$gte' in cond) return value != null && value >= cond.$gte;
    if ('$lte' in cond) return value != null && value <= cond.$lte;
    if ('$in' in cond) {
      return Array.isArray(cond.$in)
        && (Array.isArray(value) ? value.some((v) => cond.$in.some((x) => eq(v, x))) : cond.$in.some((x) => eq(value, x)));
    }
    if ('$all' in cond) return Array.isArray(value) && cond.$all.every((x) => value.some((v) => eq(v, x)));
    if ('$not' in cond) return !matches(doc, { [field]: cond.$not });
    return true;
  });
}

/** Minimal mongoose-Model stand-in bound to one record array (unchanged from I-01). */
function makeModel(db) {
  const calls = { findOneAndUpdate: 0, findOne: 0, count: 0 };
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
  return Model;
}

const skillDb = [];
const speechDb = [];
const skillModel = makeModel(skillDb);
const speechModel = makeModel(speechDb);
const withModel = (Cls, model) => Object.assign(Object.create(Cls.prototype), { model });
const skillCollection = withModel(SkillLaunchCollection, skillModel);
const speechCollection = withModel(SpeechHistoryRecordsCollection, speechModel);

const service = new utils.service.BaseService('History');
service.addHttpHandler('/v1/skill/launch', { handler: new SkillLaunchRequestsHandler({ events: skillCollection }), authenticationRequired: false });
service.addHttpHandler('/v1/speech', { handler: new SpeechHistoryRequestsHandler({ speechRecords: speechCollection }), authenticationRequired: false });

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
  const env = json && json.type === 'ERROR' ? { type: json.type, final: json.final, message: json.data && json.data.message } : undefined;
  return { method, path: path + (query ? `?${query}` : ''), status: res.status, contentType: res.headers.get('content-type'), body: json, envelope: env };
}

const cases = await runMatrix(probe);

// Query-document shape oracle: the REAL builder's output for the semantics rules (no Mongo needed).
const Q = (rule) => SkillLaunchQueryBuilder.buildQuery({ robotID: 'RS', rules: [rule] });

writeFileSync(process.argv[2] || 'i02-ref-oracle.json', JSON.stringify({
  oracle: 'REAL compiled pegasus classes (BaseService + real handlers + real validators/joi + real collections); mongoose Model stubbed',
  express: require('express/package.json').version,
  joi: require('joi/package.json').version,
  bodyParser: require('body-parser/package.json').version,
  modelCalls: skillModel.calls,
  records: skillDb.length,
  builtQueries: {
    'personIDs EXACT': Q({ field: 'personIDs', match: 'EXACT', value: ['p1', 'p2'] }),
    'personIDs NOT': Q({ field: 'personIDs', match: 'NOT', value: ['p1', 'p2'] }),
    'personIDs CONTAINS': Q({ field: 'personIDs', match: 'CONTAINS', value: 'p2' }),
    'personIDs CONTAINS_ALL': Q({ field: 'personIDs', match: 'CONTAINS_ALL', value: ['p1', 'p2'] }),
    'personIDs NOT_CONTAIN': Q({ field: 'personIDs', match: 'NOT_CONTAIN', value: ['p1', 'p2'] }),
    'payload EXACT': Q({ field: 'payload', match: 'EXACT', value: { key1: 'value1' } }),
    'payload CONTAINS_ANY': Q({ field: 'payload', match: 'CONTAINS_ANY', value: { key1: 'value1' } }),
    'payload CONTAINS_ALL': Q({ field: 'payload', match: 'CONTAINS_ALL', value: { key1: 'value1' } }),
    'payload NOT_CONTAIN': Q({ field: 'payload', match: 'NOT_CONTAIN', value: { key1: 'value1' } }),
    'payload key CONTAINS': Q({ field: 'payload', key: 'key1', match: 'CONTAINS', value: 'value1' }),
    'payload key nested': Q({ field: 'payload', key: 'a.b', value: 1 }),
  },
  cases,
}, null, 2));
console.log(JSON.stringify({ cases: cases.length, modelCalls: skillModel.calls, records: skillDb.length }, null, 1));
service.server.close();
process.exit(0);
