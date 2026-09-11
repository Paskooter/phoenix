// I-02 shared probe matrix — "match history validation and query semantics".
//
// This is the I-01 harness extended, not rebuilt: the case-list shape, the probe() signature and
// the reference/runtime/diff split are exactly w7-ref-routes-oracle.mjs / w7-runtime-probe.mjs /
// w7-diff.mjs. The single change is that the matrix now lives in one module so the reference
// oracle and the live Phoenix process are driven by the *identical* sequence of requests (I-01
// duplicated the list in both files; I-02 hoists it).
//
// probe(method, path, { body, query, raw, headers }) -> { status, body, contentType, ... }
//
// Stateful by design: the case list runs top to bottom against ONE store, so the "invalid write is
// not persisted" assertions are observable rather than asserted. Both drivers start from an empty
// store.

export const TS = 1789084000000; // shared wall-clock ms; retention (14d) never interferes
const FUTURE = Date.now() + 3600e3; // for Joi date().max('now')

export async function runMatrix(probe) {
  const out = [];
  const rec = async (label, ...args) => { out.push({ label, ...(await probe(...args)) }); };
  const put = (robotID, sessionID, skillID, payload) => ['PUT', '/v1/skill/launch/payload', { body: { robotID, sessionID, skillID, payload } }];
  const countGet = (robotID, extra = '') => ['GET', '/v1/skill/launch/count', { query: `robotID=${robotID}${extra}` }];
  const countPost = (body) => ['POST', '/v1/skill/launch/count', { body }];

  // ===========================================================================
  // A. event (write) validation — SkillLaunchRequestsHandler.saveSkillLaunch
  // ===========================================================================
  await rec('A01 write bad robotID pattern', 'POST', '/v1/skill/launch', { body: { sessionID: 'v1', robotID: 'bad id', skillID: 'SK-V' } });
  await rec('A02 write missing robotID', 'POST', '/v1/skill/launch', { body: { sessionID: 'v1', skillID: 'SK-V' } });
  await rec('A03 write missing sessionID', 'POST', '/v1/skill/launch', { body: { robotID: 'RV', skillID: 'SK-V' } });
  await rec('A04 write missing skillID', 'POST', '/v1/skill/launch', { body: { robotID: 'RV', sessionID: 'v1' } });
  await rec('A05 write bad skillID', 'POST', '/v1/skill/launch', { body: { robotID: 'RV', sessionID: 'v1', skillID: 'bad id' } });
  await rec('A06 write bad intent', 'POST', '/v1/skill/launch', { body: { robotID: 'RV', sessionID: 'v1', skillID: 'SK-V', intent: 'bad id' } });
  await rec('A07 write bad personIDs item', 'POST', '/v1/skill/launch', { body: { robotID: 'RV', sessionID: 'v1', skillID: 'SK-V', personIDs: ['bad id'] } });
  await rec('A08 write unknown key', 'POST', '/v1/skill/launch', { body: { robotID: 'RV', sessionID: 'v1', skillID: 'SK-V', extra: 1 } });
  await rec('A09 write future timestamp', 'POST', '/v1/skill/launch', { body: { robotID: 'RV', sessionID: 'v1', skillID: 'SK-V', timestamp: FUTURE } });
  await rec('A10 write personIDs not array', 'POST', '/v1/skill/launch', { body: { robotID: 'RV', sessionID: 'v1', skillID: 'SK-V', personIDs: 'p1' } });
  await rec('A11 write empty sessionID', 'POST', '/v1/skill/launch', { body: { robotID: 'RV', sessionID: '', skillID: 'SK-V' } });
  await rec('A12 write non-string sessionID', 'POST', '/v1/skill/launch', { body: { robotID: 'RV', sessionID: 5, skillID: 'SK-V' } });
  await rec('A13 write two unknown keys', 'POST', '/v1/skill/launch', { body: { robotID: 'RV', sessionID: 'v1', skillID: 'SK-V', foo: 1, bar: 2 } });
  await rec('A14 write skillID @be/ form', 'POST', '/v1/skill/launch', { body: { timestamp: TS, sessionID: 'v1', robotID: 'RV', skillID: '@be/x-y_z', intent: 'iv' } });
  await rec('A15 count RV (nothing malformed persisted)', ...countGet('RV'));
  await rec('A16 write valid sorted personIDs', 'POST', '/v1/skill/launch', { body: { timestamp: TS, sessionID: 'v1', robotID: 'RV', skillID: 'SK-V', intent: 'iv', personIDs: ['pv-2', 'pv-1'] } });
  await rec('A17 write payload null (branch B allows)', 'POST', '/v1/skill/launch', { body: { timestamp: TS, sessionID: 'v2', robotID: 'RV', skillID: 'SK-V', payload: null } });
  await rec('A18 write payload object', 'POST', '/v1/skill/launch', { body: { timestamp: TS, sessionID: 'v3', robotID: 'RV', skillID: 'SK-V', payload: { a: 1 } } });
  await rec('A19 count RV after valid writes', ...countGet('RV'));

  // ===========================================================================
  // B. payload-update validation — saveSkillPayload (event validation, then $set)
  // ===========================================================================
  await rec('B01 payload update bad robotID', ...put('bad id', 'v1', 'SK-V', { a: 1 }));
  await rec('B02 payload update missing robotID', 'PUT', '/v1/skill/launch/payload', { body: { sessionID: 'v1', skillID: 'SK-V', payload: { a: 1 } } });
  await rec('B03 payload update no payload key (I-01 case)', 'PUT', '/v1/skill/launch/payload', { body: { robotID: 'RV', sessionID: 'v1', skillID: 'SK-V' } });
  await rec('B04 payload update payload null (I-01 case)', ...put('RV', 'v1', 'SK-V', null));
  await rec('B05 payload update no match', ...put('RV', 'nope', 'SK-none', { a: 1 }));
  await rec('B06 payload update match', ...put('RV', 'v1', 'SK-V', { k: 1 }));

  // ===========================================================================
  // C. query validation — SkillLaunchRequestsHandler.getLatest/getEventsCount
  // ===========================================================================
  await rec('C01 latest {} robotID required', 'POST', '/v1/skill/launch/latest', { body: {} });
  await rec('C02 count {} robotID required', ...countPost({}));
  await rec('C03 GET count no query', 'GET', '/v1/skill/launch/count', {});
  await rec('C04 latest bad robotID pattern', 'POST', '/v1/skill/launch/latest', { body: { robotID: 'bad id!' } });
  await rec('C05 latest one unknown key', 'POST', '/v1/skill/launch/latest', { body: { robotID: 'RQ', foo: 1 } });
  await rec('C06 latest two unknown keys', 'POST', '/v1/skill/launch/latest', { body: { robotID: 'RQ', foo: 1, bar: 2 } });
  await rec('C07 latest rules not array (string)', 'POST', '/v1/skill/launch/latest', { body: { robotID: 'RQ', rules: 'x' } });
  await rec('C08 latest rules null', 'POST', '/v1/skill/launch/latest', { body: { robotID: 'RQ', rules: null } });
  await rec('C09 latest rule unknown field', 'POST', '/v1/skill/launch/latest', { body: { robotID: 'RQ', rules: [{ field: 'bogus', value: 'x' }] } });
  await rec('C10 latest rule disallowed method', 'POST', '/v1/skill/launch/latest', { body: { robotID: 'RQ', rules: [{ field: 'skillID', value: 'x', match: 'ONE_OF' }] } });
  await rec('C11 latest rule empty string value', 'POST', '/v1/skill/launch/latest', { body: { robotID: 'RQ', rules: [{ field: 'skillID', value: '' }] } });
  await rec('C12 latest empty rules array (valid, no match)', 'POST', '/v1/skill/launch/latest', { body: { robotID: 'RQ', rules: [] } });
  await rec('C13 latest conflict intent', 'POST', '/v1/skill/launch/latest', { body: { robotID: 'RQ', intent: 'i', rules: [{ field: 'intent', value: 'x' }] } });
  await rec('C14 latest conflict skillID', 'POST', '/v1/skill/launch/latest', { body: { robotID: 'RQ', skillID: 's', rules: [{ field: 'skillID', value: 'x' }] } });
  await rec('C15 latest conflict personID', 'POST', '/v1/skill/launch/latest', { body: { robotID: 'RQ', personID: 'p', rules: [{ field: 'personIDs', value: ['a'] }] } });
  await rec('C16 latest startTime future', 'POST', '/v1/skill/launch/latest', { body: { robotID: 'RQ', startTime: FUTURE } });
  await rec('C17 latest endTime ISO string', 'POST', '/v1/skill/launch/latest', { body: { robotID: 'RQ', endTime: '2026-01-01T00:00:00Z' } });
  await rec('C18 latest startTime numeric string', 'POST', '/v1/skill/launch/latest', { body: { robotID: 'RQ', startTime: String(TS) } });
  await rec('C19 latest bad skillID pattern', 'POST', '/v1/skill/launch/latest', { body: { robotID: 'RQ', skillID: 'has space' } });
  await rec('C20 GET count rule unknown field', 'GET', '/v1/skill/launch/count', { query: 'robotID=RQ&rules[0][field]=bogus&rules[0][value]=x' });
  await rec('C21 GET count rules not array', 'GET', '/v1/skill/launch/count', { query: 'robotID=RQ&rules=foo' });
  await rec('C22 latest rules [null]', 'POST', '/v1/skill/launch/latest', { body: { robotID: 'RQ', rules: [null] } });
  await rec('C23 latest rules [string]', 'POST', '/v1/skill/launch/latest', { body: { robotID: 'RQ', rules: ['x'] } });
  await rec('C24 latest rule payload value null (joi ok, builder throws)', 'POST', '/v1/skill/launch/latest', { body: { robotID: 'RQ', rules: [{ field: 'payload', value: null }] } });
  await rec('C25 latest joi robotID beats rule error', 'POST', '/v1/skill/launch/latest', { body: { robotID: 'bad id', rules: [{ field: 'bogus', value: 'x' }] } });
  await rec('C26 latest joi startTime beats rule error', 'POST', '/v1/skill/launch/latest', { body: { robotID: 'RQ', startTime: FUTURE, rules: [{ field: 'bogus', value: 'x' }] } });
  await rec('C27 latest rule empty array value', 'POST', '/v1/skill/launch/latest', { body: { robotID: 'RQ', rules: [{ field: 'personIDs', value: [], match: 'CONTAINS_ANY' }] } });
  await rec('C28 GET latest valid empty store', 'GET', '/v1/skill/launch/latest', { query: 'robotID=RQ' });
  await rec('C29 GET count valid empty store', ...countGet('RQ'));
  await rec('C30 latest second rule invalid', 'POST', '/v1/skill/launch/latest', { body: { robotID: 'RQ', rules: [{ field: 'intent', value: 'a' }, { field: 'bogus', value: 'b' }] } });

  // ===========================================================================
  // D. query semantics — seeded store, robot RS
  // ===========================================================================
  const L = (body) => ['POST', '/v1/skill/launch', { body: { timestamp: TS, robotID: 'RS', ...body } }];
  await rec('D01 seed s1', ...L({ sessionID: 's1', skillID: 'SK-A', intent: 'intent-a', personIDs: ['p1', 'p2'] }));
  await rec('D02 seed s2', ...L({ timestamp: TS + 1000, sessionID: 's2', skillID: 'SK-B', intent: 'intent-b', personIDs: ['p2', 'p3'] }));
  await rec('D03 seed s3 (distinct skillID keeps PUT targets unique)', ...L({ timestamp: TS + 2000, sessionID: 's3b', skillID: 'SK-A2', intent: 'intent-a', personIDs: ['p1'] }));
  await rec('D04 seed s4 empty personIDs', ...L({ timestamp: TS + 3000, sessionID: 's3', skillID: 'SK-C', personIDs: [] }));
  await rec('D05 seed s5 earlier timestamp', ...L({ timestamp: TS + 500, sessionID: 's5', skillID: 'SK-A', intent: 'intent-a', personIDs: ['p1', 'p2'] }));
  await rec('D06 seed s6 no payload ever', ...L({ timestamp: TS + 4000, sessionID: 's6', skillID: 'SK-D', personIDs: ['p9'] }));
  await rec('D07 seed s7 literal-dot payload', ...L({ timestamp: TS + 2500, sessionID: 's7', skillID: 'SK-E', personIDs: ['p1', 'p2'] }));
  await rec('D08 payload s1 full', ...put('RS', 's1', 'SK-A', { key1: 'value1', key2: 'value2', key3: ['value3', 'value4'], key4: 0, key5: false }));
  await rec('D09 payload s2 nested object', ...put('RS', 's2', 'SK-B', { a: { b: 1 } }));
  await rec('D10 payload s3 empty object', ...put('RS', 's3', 'SK-C', {}));
  await rec('D11 payload s7 literal "a.b" key', ...put('RS', 's7', 'SK-E', { 'a.b': 'flat' }));

  const q = async (label, body) => rec(label, 'POST', '/v1/skill/launch/count', { body: { robotID: 'RS', ...body } });
  const qLatest = async (label, body) => rec(label, 'POST', '/v1/skill/launch/latest', { body: { robotID: 'RS', ...body } });
  const P = (field, match, value) => ({ field, match, value });

  // sorted array EXACT / NOT
  await q('D12 personIDs EXACT reversed value (Preformatter sorts)', { rules: [P('personIDs', 'EXACT', ['p2', 'p1'])] });
  await q('D13 personIDs EXACT sorted value', { rules: [P('personIDs', 'EXACT', ['p1', 'p2'])] });
  await q('D14 personIDs EXACT empty-backed record only', { rules: [P('personIDs', 'EXACT', [])] }); // validation rejects -> 500
  await q('D15 personIDs NOT', { rules: [P('personIDs', 'NOT', ['p1', 'p2'])] });
  await q('D16 personIDs CONTAINS scalar', { rules: [P('personIDs', 'CONTAINS', 'p2')] });
  await q('D17 personIDs ONE_OF rejected by validation (array:array allows no ONE_OF)', { rules: [P('personIDs', 'ONE_OF', ['p3'])] });
  await q('D18 personIDs CONTAINS_ALL', { rules: [P('personIDs', 'CONTAINS_ALL', ['p1', 'p2'])] });
  await q('D19 personIDs NOT_CONTAIN', { rules: [P('personIDs', 'NOT_CONTAIN', ['p1', 'p2'])] });
  await q('D20 personIDs default method (CONTAINS)', { rules: [{ field: 'personIDs', value: 'p1' }] });
  // skillID / intent rules
  await q('D21 skillID rule NOT', { rules: [P('skillID', 'NOT', 'SK-A')] });
  await q('D22 skillID rule ONE_OF', { rules: [{ field: 'skillID', match: 'ONE_OF', value: ['SK-A', 'SK-D'] }] });
  await q('D23 intent rule EXACT', { rules: [{ field: 'intent', value: 'intent-a' }] });
  await q('D24 intent exact-match param', { intent: 'intent-a' });
  await q('D25 skillID exact-match param', { skillID: 'SK-B' });
  await q('D26 personID param', { personID: 'p1' });
  await q('D27 personID param unknown', { personID: 'pz' });
  await q('D28 notSessionID excludes s1', { notSessionID: 's1' });
  await q('D29 notSessionID unknown', { notSessionID: 'nope' });
  // time boundaries
  await q('D30 startTime boundary (gte TS+1000)', { startTime: TS + 1000 });
  await q('D31 endTime boundary (lte TS+1000)', { endTime: TS + 1000 });
  await q('D32 startTime=endTime exact', { startTime: TS + 2000, endTime: TS + 2000 });
  await q('D33 window excludes both ends', { startTime: TS + 1200, endTime: TS + 1800 });
  await q('D34 startTime 0 (falsy, ignored like reference)', { startTime: 0 });
  // payload operators
  await q('D35 payload EXACT full', { rules: [P('payload', 'EXACT', { key1: 'value1', key2: 'value2', key3: ['value3', 'value4'], key4: 0, key5: false })] });
  await q('D36 payload EXACT subset (size mismatch)', { rules: [P('payload', 'EXACT', { key1: 'value1' })] });
  await q('D37 payload EXACT empty {} (payloadSize 0)', { rules: [{ field: 'payload', value: {} }] });
  await q('D38 payload CONTAINS_ALL subset incl. array', { rules: [P('payload', 'CONTAINS_ALL', { key1: 'value1', key3: ['value3', 'value4'] })] });
  await q('D39 payload CONTAINS_ALL reversed array value', { rules: [P('payload', 'CONTAINS_ALL', { key3: ['value4', 'value3'] })] });
  await q('D40 payload CONTAINS_ALL empty {}', { rules: [P('payload', 'CONTAINS_ALL', {})] });
  await q('D41 payload CONTAINS_ANY one key hit', { rules: [P('payload', 'CONTAINS_ANY', { key1: 'value1', key8: 'value8' })] });
  await q('D42 payload CONTAINS_ANY miss', { rules: [P('payload', 'CONTAINS_ANY', { key1: 'value11' })] });
  await q('D43 payload CONTAINS_ANY empty {}', { rules: [P('payload', 'CONTAINS_ANY', {})] });
  await q('D44 payload NOT_CONTAIN unknown key', { rules: [P('payload', 'NOT_CONTAIN', { key7: 'v' })] });
  await q('D45 payload NOT_CONTAIN empty {}', { rules: [P('payload', 'NOT_CONTAIN', {})] });
  await q('D46 payload NOT array-order-differs', { rules: [P('payload', 'NOT', { key1: 'value1', key2: 'value2', key3: ['value4', 'value3'] })] });
  await q('D47 payload NOT exact copy', { rules: [P('payload', 'NOT', { key1: 'value1', key2: 'value2', key3: ['value3', 'value4'], key4: 0, key5: false })] });
  // payload key rules / nested keys
  await q('D48 payload key nested a.b', { rules: [{ field: 'payload', key: 'a.b', value: 1 }] });
  await q('D49 payload key a.b on literal-dot record', { rules: [{ field: 'payload', key: 'a.b', value: 'flat' }] });
  await q('D50 payload CONTAINS_ALL nested path', { rules: [P('payload', 'CONTAINS_ALL', { 'a.b': 1 })] });
  await q('D51 payload key number 0', { rules: [{ field: 'payload', key: 'key4', value: 0 }] });
  await q('D52 payload key boolean false', { rules: [{ field: 'payload', key: 'key5', value: false }] });
  await q('D53 payload key NOT', { rules: [{ field: 'payload', key: 'key1', value: 'value1', match: 'NOT' }] });
  await q('D54 payload key CONTAINS ($in [v])', { rules: [{ field: 'payload', key: 'key1', value: 'value1', match: 'CONTAINS' }] });
  await q('D55 payload key NOT_CONTAIN (array value)', { rules: [{ field: 'payload', key: 'key1', value: ['value1'], match: 'NOT_CONTAIN' }] });
  await q('X05 payload key NOT_CONTAIN scalar value ($in scalar; real Mongo behaviour needs mongod)', { rules: [{ field: 'payload', key: 'key1', value: 'value1', match: 'NOT_CONTAIN' }] });
  await q('D55c payload key CONTAINS (scalar wraps in $in [v])', { rules: [{ field: 'payload', key: 'key1', value: 'value1', match: 'CONTAINS' }] });
  // payload value coercions (Object.keys on a primitive) + payload value null (builder throws)
  await q('D55d payload value number 5', { rules: [{ field: 'payload', value: 5 }] });
  await q('D55e payload value boolean true', { rules: [{ field: 'payload', value: true }] });
  await q('D55f payload value string x', { rules: [{ field: 'payload', value: 'x' }] });
  await q('D55g payload NOT empty object', { rules: [{ field: 'payload', match: 'NOT', value: {} }] });
  await q('D56 payload key ONE_OF', { rules: [{ field: 'payload', key: 'key1', value: ['value1', 'zz'], match: 'ONE_OF' }] });
  // missing payload field
  await q('D57 payload key on record with no payload', { rules: [{ field: 'payload', key: 'key1', value: 'value1' }] });
  // latest selection
  await qLatest('D58 latest R1-style newest wins', {});
  await qLatest('D59 latest with skillID rule', { rules: [{ field: 'skillID', value: 'SK-C' }] });
  // GET variant of a semantics query (qs array parsing)
  await rec('D60 GET count personIDs EXACT array', 'GET', '/v1/skill/launch/count', { query: 'robotID=RS&rules[0][field]=personIDs&rules[0][match]=EXACT&rules[0][value][]=p1&rules[0][value][]=p2' });
  await rec('D61 GET count personIDs scalar (default CONTAINS)', 'GET', '/v1/skill/launch/count', { query: 'robotID=RS&rules[0][field]=personIDs&rules[0][value]=p1' });
  await rec('D62 GET latest payload key numeric string (qs)', 'GET', '/v1/skill/launch/latest', { query: 'robotID=RS&rules[0][field]=payload&rules[0][key]=key4&rules[0][value]=0' });
  await rec('D63 GET count notSessionID', 'GET', '/v1/skill/launch/count', { query: 'robotID=RS&notSessionID=s1' });
  await rec('D64 GET count time window', 'GET', '/v1/skill/launch/count', { query: `robotID=RS&startTime=${TS + 1000}&endTime=${TS + 2000}` });
  await rec('D65 POST count robotID RS total', ...countPost({ robotID: 'RS' }));

  // ===========================================================================
  // X. known-unverifiable: findOneAndUpdate with MULTIPLE matches.
  // The reference passes no sort, so real Mongo returns the first document in natural (insertion)
  // order; the stub does the same. Phoenix picks the most recent. Selecting between "oldest" and
  // "newest" needs a live mongod, so these cases are reported separately by i02-diff.mjs and are
  // NOT counted as a pass/fail parity claim.
  // ===========================================================================
  await rec('X01 dup triple first', 'POST', '/v1/skill/launch', { body: { timestamp: TS, sessionID: 'x1', robotID: 'RX', skillID: 'SK-X' } });
  await rec('X02 dup triple second', 'POST', '/v1/skill/launch', { body: { timestamp: TS + 1000, sessionID: 'x1', robotID: 'RX', skillID: 'SK-X' } });
  await rec('X03 PUT payload on ambiguous triple', ...put('RX', 'x1', 'SK-X', { marker: 'm1' }));
  await rec('X04 which record received the payload (marker count)', 'POST', '/v1/skill/launch/count', { body: { robotID: 'RX', rules: [{ field: 'payload', key: 'marker', value: 'm1' }] } });

  return out;
}
