// Strict trace comparison. Every exception has a bounded JSON pointer and an
// independent validity check; sessions and behavioral payloads are never erased.
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

const generatedIDs = [
  '/cases/*/response/body/value/msgID',
  '/cases/*/frames/*/message/msgID',
  '/cases/*/effects/*/body/value/msgID',
];
const endpointPaths = [
  '/cases/*/response/body/value/skills/*/URL',
  '/cases/*/frames/*/message/data/message',
  '/cases/*/effects/*/headers/host',
];
const parts = path => path.split('/').slice(1);
const matches = (pattern, path) => {
  const a = parts(pattern), b = parts(path);
  return a.length === b.length && a.every((p, i) => p === '*' || p === b[i]);
};
const selected = (patterns, path) => patterns.some(p => matches(p, path));
const escape = key => String(key).replace(/~/g, '~0').replace(/\//g, '~1');
const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** All JSON fields, presence, value types and array ordering are significant. */
export function diffValues(expected, actual, { path = '', equivalent } = {}) {
  const differences = [];
  function visit(a, b, pointer) {
    const decision = equivalent?.(a, b, pointer);
    if (decision === true) return;
    if (decision === false) { differences.push({ path: pointer || '/', kind: 'equivalence', expected: a, actual: b }); return; }
    if (Object.is(a, b)) return;
    if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) {
      differences.push({ path: pointer || '/', kind: 'value', expected: a, actual: b }); return;
    }
    if (Array.isArray(a) && a.length !== b.length) differences.push({ path: `${pointer}/length`, kind: 'length', expected: a.length, actual: b.length });
    for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
      const next = `${pointer}/${escape(key)}`;
      if (!has(a, key) || !has(b, key)) {
        differences.push({ path: next, kind: 'presence', expectedPresent: has(a, key), actualPresent: has(b, key), expected: a[key], actual: b[key] });
      } else visit(a[key], b[key], next);
    }
  }
  visit(expected, actual, path); return differences;
}

function decode(raw) {
  if (raw === '') return { kind: 'empty', value: '' };
  try { return { kind: 'json', value: JSON.parse(raw) }; } catch { return { kind: 'text', value: raw }; }
}
function etag(raw, weak) {
  const bytes = Buffer.from(raw);
  const digest = createHash('sha1').update(bytes).digest('base64').slice(0, 27);
  return `${weak ? 'W/' : ''}"${bytes.length.toString(16)}-${digest}"`;
}
function endpoint(value, endpoints) {
  if (typeof value !== 'string') return value;
  for (const [name, url] of Object.entries(endpoints)) {
    if (value === new URL(url).host) return `<endpoint:${name}:authority>`;
    value = value.split(url).join(`<endpoint:${name}>`);
  }
  return value;
}

/** Validate timing, framing, raw-byte decoding, identifiers and continuations. */
export function validateTrace(trace, suite) {
  const failures = [];
  const fail = (path, message) => failures.push({ path, kind: 'invariant', message });
  const bounded = (value, min, max, path) => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) fail(path, `Expected a finite duration in [${min}, ${max}] ms`);
  };
  if (trace.schemaVersion !== 1 || trace.captureComplete !== true) fail('/', 'Capture is incomplete or has an unsupported schema');
  if (!Array.isArray(trace.cases)) return [...failures, { path: '/cases', kind: 'invariant', message: 'Missing case array' }];
  if (!isDeepStrictEqual(trace.cases.map(c => c.id), suite.cases.map(c => c.id))) fail('/cases', 'Fixture cases are missing, duplicated or reordered');
  if (trace.lateEffects?.length) fail('/lateEffects', 'Unattributed side effects occurred after the fixture drain window');
  const byID = new Map(trace.cases.map(c => [c.id, c]));
  for (let index = 0; index < trace.cases.length; index++) {
    const c = trace.cases[index], p = `/cases/${index}`;
    const def = suite.cases.find(d => d.id === c.id);
    if (!def) continue;
    if (c.failure) fail(p, c.failure);
    const limit = def.timeoutMs || suite.defaultTimeoutMs;
    bounded(c.durationMs, def.minDurationMs || 0, limit, `${p}/durationMs`);
    if (!c.input || c.input.path !== def.path || (def.method && c.input.method !== def.method)) fail(`${p}/input`, 'The requested fixture was not executed');
    const verifyResponse = (r, pointer, head) => {
      if (!r || !Number.isInteger(r.status) || r.status < 100 || r.status > 599) { fail(pointer, 'Missing or invalid HTTP response'); return; }
      if (typeof r.rawBody !== 'string' || !isDeepStrictEqual(decode(r.rawBody), r.body)) fail(`${pointer}/body`, 'Decoded body differs from captured bytes');
      if (head && r.rawBody !== '') fail(`${pointer}/rawBody`, 'HEAD returned a response body');
      if (r.headers?.date !== undefined && r.headers.date !== new Date(suite.clock).toUTCString()) fail(`${pointer}/headers/date`, 'HTTP date disagrees with the frozen clock');
      if (r.headers?.['content-length'] !== undefined && !head && Number(r.headers['content-length']) !== Buffer.byteLength(r.rawBody)) fail(`${pointer}/headers/content-length`, 'Content-Length does not match captured bytes');
      if (r.headers?.etag !== undefined) {
        let entity = r.rawBody;
        if (head) entity = trace.cases.find(get => get.input?.method === 'GET' && get.input.path === c.input.path)?.response?.rawBody;
        if (entity === undefined || typeof r.headers.etag !== 'string' || r.headers.etag !== etag(entity, r.headers.etag.startsWith('W/'))) fail(`${pointer}/headers/etag`, 'ETag does not match the transmitted or paired GET entity');
      }
    };
    if (c.transport === 'HTTP') {
      verifyResponse(c.response, `${p}/response`, c.input?.method === 'HEAD');
      if (c.response) bounded(c.response.durationMs, 0, limit, `${p}/response/durationMs`);
    } else if (c.transport === 'WS') {
      if (c.upgrade) verifyResponse(c.upgrade, `${p}/upgrade`, false);
      else if (c.opened !== true) fail(p, 'WebSocket neither opened nor captured an upgrade rejection');
      let previous = -1;
      for (let n = 0; n < (c.frames || []).length; n++) {
        const frame = c.frames[n], pointer = `${p}/frames/${n}`;
        bounded(frame.receivedAtMs, Math.max(0, previous), c.durationMs, `${pointer}/receivedAtMs`); previous = frame.receivedAtMs;
        if (typeof frame.raw !== 'string' || decode(frame.raw).kind !== 'json' || !isDeepStrictEqual(decode(frame.raw).value, frame.message)) fail(pointer, 'WebSocket frame is invalid JSON or differs from captured bytes');
        if (frame.message?.ts !== undefined && frame.message.ts !== Date.parse(suite.clock)) fail(`${pointer}/message/ts`, 'Envelope timestamp disagrees with the frozen clock');
        if (frame.message?.timings) for (const [name, time] of Object.entries(frame.message.timings)) {
          // Original -1 means a phase was not measured. Keep sentinel values and
          // every timing key in the strict comparison as well as these bounds.
          bounded(time, -1, limit, `${pointer}/message/timings/${name}`);
        }
      }
      const terminal = (c.frames || []).filter(f => f.message?.final === true);
      if (c.terminalCount !== terminal.length) fail(`${p}/terminalCount`, 'Terminal counter disagrees with received frames');
      if (def.expectTerminal && !c.upgrade) {
        if (terminal.length !== 1 || c.frames.at(-1) !== terminal[0]) fail(`${p}/frames`, 'Expected exactly one terminal frame with no late frames');
        if (typeof c.openAfterFinal !== 'boolean' || !['client', 'server'].includes(c.closeOrigin)) fail(p, 'Missing close-window observation');
        bounded(c.holdAfterFinalMs, 0, limit, `${p}/holdAfterFinalMs`);
        if (c.closeOrigin === 'client') bounded(c.holdAfterFinalMs, Math.max(0, (def.closeAfterFinalMs || 30) - (suite.timerToleranceMs || 0)), limit, `${p}/holdAfterFinalMs`);
      }
      if (def.sessionFrom) {
        const prior = byID.get(def.sessionFrom)?.frames?.find(f => f.message?.type === 'SKILL_ACTION')?.message?.data?.skill;
        const supplied = c.input?.messages?.find(m => m.type === 'CONTEXT')?.data?.skill;
        if (!prior?.session || !isDeepStrictEqual(prior, supplied)) fail(`${p}/input`, 'Continuation did not send back the previously issued skill/session');
        if (def.forwardSession) {
          const forwarded = c.effects?.find(e => e.path === '/skill')?.body?.value;
          if (forwarded?.type !== 'LISTEN_UPDATE' || !isDeepStrictEqual(forwarded?.data?.skill, supplied)) fail(`${p}/effects`, 'Skill continuation dropped or changed its session');
          const result = c.frames?.find(f => f.message?.type === 'SKILL_ACTION')?.message?.data;
          if (result?.analytics?.skill1?.[0]?.properties?.continued !== true || result?.skill?.session?.data?.turn !== 2) fail(`${p}/frames`, 'Fixture skill did not accept and advance the supplied session');
        }
      }
    } else fail(`${p}/transport`, 'Unknown transport');
    for (let n = 0; n < (c.effects || []).length; n++) {
      const effect = c.effects[n], pointer = `${p}/effects/${n}`;
      if (effect.attribution !== 'trace-header' || effect.headers?.['x-jibo-transid'] !== c.id) fail(pointer, 'Peer request is not attributable to this transaction');
      if (!isDeepStrictEqual(decode(effect.rawBody), effect.body)) fail(`${pointer}/body`, 'Peer request differs from captured bytes');
      if (effect.headers?.['content-length'] !== undefined && Number(effect.headers['content-length']) !== Buffer.byteLength(effect.rawBody)) fail(`${pointer}/headers/content-length`, 'Peer Content-Length does not match captured bytes');
      bounded(effect.durationMs, 0, limit, `${pointer}/durationMs`);
    }
  }
  return failures;
}

function comparisonView(trace) {
  const view = structuredClone({ cases: trace.cases });
  for (const c of view.cases) {
    delete c.durationMs; delete c.holdAfterFinalMs;
    for (const r of [c.response, c.upgrade].filter(Boolean)) {
      delete r.durationMs; delete r.rawBody;
      // Verified above as a derived digest of the full raw body. Preserve
      // presence and weak/strong form without comparing random-ID bytes twice.
      if (typeof r.headers?.etag === 'string') r.headers.etag = r.headers.etag.startsWith('W/') ? 'W/<validated-entity-sha1>' : '<validated-entity-sha1>';
    }
    for (const f of c.frames || []) { delete f.raw; delete f.receivedAtMs; }
    for (const e of c.effects || []) { delete e.rawBody; delete e.durationMs; }
  }
  return view;
}

export function compareTraces(reference, candidate, suite) {
  const failures = [
    ...validateTrace(reference, suite).map(f => ({ ...f, side: 'reference' })),
    ...validateTrace(candidate, suite).map(f => ({ ...f, side: 'candidate' })),
  ];
  const suiteHash = createHash('sha256').update(JSON.stringify(suite)).digest('hex');
  for (const [side, trace] of [['reference', reference], ['candidate', candidate]]) {
    if (trace.suiteSha256 !== suiteHash) failures.push({ path: '/suiteSha256', kind: 'fixture', side, message: 'Capture does not match the supplied fixture definition' });
  }
  for (const field of ['schemaVersion', 'suite', 'suiteSha256', 'driverSha256', 'manifestSha256', 'clock']) {
    if (reference[field] !== candidate[field]) failures.push({ path: `/${field}`, kind: 'fixture', message: 'Captures did not use the same fixture inputs/driver' });
  }
  const bindings = new Map(), reverse = new Map();
  // Inputs and fixture peer messages have literal IDs. They cannot be reused as
  // substitutes for newly generated server IDs or silently renamed.
  for (const c of reference.cases || []) {
    for (const m of c.input?.messages || []) if (m?.msgID) { bindings.set(m.msgID, m.msgID); reverse.set(m.msgID, m.msgID); }
    for (const e of c.effects || []) if (e.response?.body?.msgID) { const id = e.response.body.msgID; bindings.set(id, id); reverse.set(id, id); }
  }
  const a = comparisonView(reference), b = comparisonView(candidate);
  const differences = diffValues(a, b, { equivalent: (left, right, pointer) => {
    if (selected(endpointPaths, pointer)) return isDeepStrictEqual(endpoint(left, reference.endpoints), endpoint(right, candidate.endpoints));
    if (!selected(generatedIDs, pointer)) return undefined;
    if (typeof left !== 'string' || typeof right !== 'string') return false;
    if (!bindings.has(left) && !uuid.test(left)) return left === right;
    if (!bindings.has(left) && !uuid.test(right)) return false;
    if (bindings.has(left)) return bindings.get(left) === right;
    if (reverse.has(right)) return false;
    bindings.set(left, right); reverse.set(right, left); return true;
  } });
  return { pass: failures.length === 0 && differences.length === 0, cases: reference.cases?.length || 0,
    invariants: failures, differences, policy: { generatedIDs, endpointPaths,
      measuredDurations: 'Finite ordered wall times with per-fixture bounds; message timestamps/timing keys/sentinels remain compared',
      etag: 'Exact SHA-1/length relation to raw entity; presence and weak/strong form remain compared',
      sessions: 'Full contents compared, plus issued/supplied/forwarded/advanced continuation checks' } };
}
