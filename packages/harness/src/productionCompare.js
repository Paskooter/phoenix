// Complete production-parser, routing and skill traces. Only generated IDs,
// bound fixture hosts and independently validated derived bytes are equivalent.
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { diffValues } from './parityCompare.js';
import driver from '../../../scripts/parity-production/driver.cjs';

const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const jcpID = /^[0-9a-f]{32}$/i;
const escape = key => String(key).replace(/~/g, '~0').replace(/\//g, '~1');
const etag = raw => {
  const bytes = Buffer.from(raw), hash = createHash('sha1').update(bytes).digest('base64').slice(0, 27);
  return `"${bytes.length.toString(16)}-${hash}"`;
};

/** Only traverse JCP command containers; display/view/domain IDs remain literal. */
function commandIDs(node, pointer, paths) {
  if (!node || typeof node !== 'object') return;
  if (has(node, 'id') && jcpID.test(node.id)) paths.set(pointer + '/id', 'jcp');
  if (['SEQUENCE', 'PARALLEL'].includes(node.type) && Array.isArray(node.children)) node.children.forEach((child, i) => commandIDs(child, `${pointer}/children/${i}`, paths));
  if (node.type === 'SLIM') for (const key of ['play', 'listen', 'display']) commandIDs(node.config?.[key], `${pointer}/config/${key}`, paths);
  for (const key of ['onCancel', 'onComplete']) if (Array.isArray(node[key])) node[key].forEach((child, i) => commandIDs(child, `${pointer}/${key}/${i}`, paths));
}

export function validateProductionTrace(trace, suite) {
  const failures = [];
  const fail = (path, message) => failures.push({ path, kind: 'invariant', message });
  const bounded = (duration, max, path) => { if (!Number.isFinite(duration) || duration < 0 || duration > max) fail(path, `Duration must be finite and within 0..${max} ms`); };
  if (suite.schemaVersion !== 2 || trace.schemaVersion !== 2 || trace.captureComplete !== true || trace.failure || trace.cleanupFailure) fail('/', 'Production capture/cleanup is incomplete or uses a superseded fixture schema');
  if (!Array.isArray(trace.cases)) return [...failures, { path: '/cases', kind: 'invariant', message: 'Missing cases' }];
  if (!isDeepStrictEqual(trace.cases.map(c => c.id), suite.cases.map(c => c.id))) fail('/cases', 'Cases are missing, duplicated or reordered');
  if (!Array.isArray(trace.lateEffects) || trace.lateEffects.length) fail('/lateEffects', 'Unexpected effects outside active fixture cases');
  if (trace.implementation === 'original') {
    const native = trace.setup?.nativeDiagnostics;
    if (native?.loads?.length !== 98 || native.loads.some(r => r.status !== 200 || r.body?.Status !== 'OK') || native.errors?.length) fail('/setup/nativeDiagnostics', 'Original native parser did not successfully load all 98 grammars or had transport errors');
    if (native?.performance?.unexpected?.length !== 0 || native.performance.counts.COMPILE_RECEIVED !== 98 || native.performance.counts.COMPILE_COMPLETE !== 98) fail('/setup/nativeDiagnostics/performance', 'Original native performance dependency is absent, incomplete or has unexpected requests');
    if (trace.runtime !== 'v8.9.4' || trace.setup?.referenceRevision !== suite.referenceRevision) fail('/setup', 'Unexpected original runtime/revision');
  }
  function validateWire(wire, path, at, response = false, generatedEnvelope = response) {
    if (!wire || typeof wire.rawBody !== 'string' || !isDeepStrictEqual(driver.decode(wire.rawBody), wire.body)) { fail(path, 'Captured bytes and decoded body disagree or are missing'); return; }
    if (wire.headers?.['content-length'] !== undefined && Number(wire.headers['content-length']) !== Buffer.byteLength(wire.rawBody)) fail(path + '/headers/content-length', 'Content-Length differs from captured bytes');
    if (response) {
      if (!Number.isInteger(wire.status) || wire.status < 100 || wire.status > 599) fail(path + '/status', 'Invalid HTTP status');
      bounded(wire.durationMs, suite.requestTimeoutMs, path + '/durationMs');
      if (wire.headers?.date !== undefined && wire.headers.date !== new Date(at).toUTCString()) fail(path + '/headers/date', 'Response Date differs from the case clock');
      if (wire.headers?.etag !== undefined && ![etag(wire.rawBody), 'W/' + etag(wire.rawBody)].includes(wire.headers.etag)) fail(path + '/headers/etag', 'ETag differs from the captured entity');
    }
    if (generatedEnvelope) {
      const body = wire.body.kind === 'json' ? wire.body.value : null;
      if (body && has(body, 'ts') && body.ts !== Date.parse(at)) fail(path + '/body/value/ts', 'Message timestamp differs from the case clock');
      if (body && has(body, 'msgID') && !uuid.test(body.msgID)) fail(path + '/body/value/msgID', 'Production envelope ID must be a generated v4 UUID');
    }
  }
  for (const [index, actual] of trace.cases.entries()) {
    const def = suite.cases[index], p = `/cases/${index}`;
    if (!def) continue;
    const context = suite.contexts[def.context];
    if (actual.failure) fail(p + '/failure', actual.failure.message || 'Case failed');
    bounded(actual.durationMs, suite.caseTimeoutMs, p + '/durationMs');
    if (has(def, 'parserData') || has(def, 'parserRequest')) {
      const expected = driver.parserInput(def, context);
      if (!isDeepStrictEqual(actual.parser?.input, expected)) fail(p + '/parser/input', 'Full parser fixture request was changed or not sent');
      validateWire(actual.parser?.response, p + '/parser/response', def.clock, true);
      if (def.route && !['no-route', 'match', 'parser-error'].includes(actual.routing?.kind)) fail(p + '/routing', 'Routing result is missing');
    } else if (actual.parser) fail(p + '/parser', 'Unexpected parser stage');
    if (!Array.isArray(actual.turns)) { fail(p + '/turns', 'Missing skill turn array'); continue; }
    let result, skillID;
    if (def.directSkill) { result = def.directSkill.result; skillID = def.directSkill.id; }
    else if (actual.routing?.kind === 'match') {
      skillID = actual.routing.decision?.skillID;
      result = { nlu: actual.parser?.response?.body?.value?.data, asr: { text: actual.parser?.input?.body?.value?.data?.text, confidence: 1 } };
      if (has(actual.routing.decision, 'memo')) result.memo = actual.routing.decision.memo;
    }
    if (def.actions && !['cloud-skill', 'no-route', 'on-robot', 'unhosted-cloud-skill'].includes(actual.actionOutcome)) fail(p + '/actionOutcome', 'Missing action-stage outcome');
    const count = actual.actionOutcome === 'cloud-skill' ? 1 + (def.updates || []).length : 0;
    if (actual.turns.length !== count) fail(p + '/turns', 'Skill turns were dropped or added');
    for (const [step, turn] of actual.turns.entries()) {
      const t = `${p}/turns/${step}`;
      const prior = step ? actual.turns[step - 1].response?.body?.value : undefined;
      try {
        const expected = driver.skillPreparation(def, context, skillID, step ? def.updates[step - 1] : result, step, prior);
        if (!isDeepStrictEqual(turn.preparation, expected)) fail(t + '/preparation', 'Production builder input dropped or changed context, parser output, memo or issued continuation session');
        const emitted = turn.input?.body?.value;
        if (!emitted || !isDeepStrictEqual(turn.input, driver.input(def, 'skill:' + step, emitted, '/v1/main'))) fail(t + '/input', 'Emitted skill request was not sent with the fixture HTTP transport');
        if (step && !isDeepStrictEqual(emitted?.data?.skill?.session, prior?.data?.skill?.session)) fail(t + '/input', 'Issued continuation session changed after request construction');
      } catch { fail(t + '/preparation', 'Unable to construct required builder input or continuation'); }
      validateWire(turn.input, t + '/input', def.clock, false, true);
      validateWire(turn.response, t + '/response', def.clock, true);
    }
    if (!Array.isArray(actual.effects)) fail(p + '/effects', 'Missing provider effect array');
    for (const [i, effect] of (actual.effects || []).entries()) {
      const e = `${p}/effects/${i}`;
      validateWire(effect, e, def.clock);
      bounded(effect.durationMs, suite.requestTimeoutMs, e + '/durationMs');
      if (effect.unexpected) fail(e, 'Provider request has no declared fixture response');
      if (!['trace-header', 'active-case'].includes(effect.attribution)) fail(e + '/attribution', 'Unattributed provider request');
      if (effect.attribution === 'trace-header' && effect.headers?.['x-jibo-transid'] !== actual.id) fail(e + '/headers', 'Incorrect provider transaction attribution');
    }
  }
  return failures;
}

function viewCase(capture, index) {
  const c = structuredClone(capture), paths = new Map();
  {
    const p = `/cases/${index}`;
    delete c.durationMs;
    const wireView = (wire, pointer, response, generatedEnvelope = response) => {
      if (!wire) return;
      delete wire.rawBody; delete wire.durationMs;
      if (response) {
        if (typeof wire.headers?.etag === 'string') wire.headers.etag = wire.headers.etag.startsWith('W/') ? 'W/<validated-entity>' : '<validated-entity>';
      }
      if (generatedEnvelope) {
        const base = pointer + '/body/value';
        if (wire.body?.kind === 'json' && wire.body.value) {
          if (has(wire.body.value, 'msgID')) paths.set(base + '/msgID', 'uuid');
          if (wire.body.value.data?.skill?.session?.id) paths.set(base + '/data/skill/session/id', 'uuid');
          if (wire.body.value.data?.action?.type === 'JCP') commandIDs(wire.body.value.data.action.config?.jcp, base + '/data/action/config/jcp', paths);
        }
      }
    };
    if (c.parser) { wireView(c.parser.input, p + '/parser/input', false); wireView(c.parser.response, p + '/parser/response', true); }
    for (const [step, turn] of (c.turns || []).entries()) {
      wireView(turn.input, `${p}/turns/${step}/input`, false, true); wireView(turn.response, `${p}/turns/${step}/response`, true);
      if (step) paths.set(`${p}/turns/${step}/preparation/input/context/skill/session/id`, 'uuid');
    }
    for (const effect of c.effects || []) { delete effect.rawBody; delete effect.durationMs; }
  }
  return { value: { cases: { [index]: c } }, paths };
}

export function compareProduction(reference, candidate, suite) {
  const invariants = [...validateProductionTrace(reference, suite).map(f => ({ ...f, side: 'reference' })),
    ...validateProductionTrace(candidate, suite).map(f => ({ ...f, side: 'candidate' }))];
  const hash = createHash('sha256').update(JSON.stringify(suite)).digest('hex');
  for (const [side, trace] of [['reference', reference], ['candidate', candidate]]) {
    if (trace.suite !== suite.id || trace.suiteSha256 !== hash || trace.profile !== suite.profile) invariants.push({ side, path: '/', kind: 'fixture', message: 'Capture does not match the full fixture definition/profile' });
  }
  if (reference.driverSha256 !== candidate.driverSha256) invariants.push({ path: '/driverSha256', kind: 'fixture', message: 'Different shared drivers captured the two implementations' });
  const binding = new Map(), reverse = new Map(), differences = [];
  const endpoint = (value, trace) => typeof value === 'string' ? value.replaceAll(new URL(trace.endpoints.peer).host, '<fixture-peer>') : value;
  if (reference.cases.length !== candidate.cases.length) differences.push({ path: '/cases/length', kind: 'length', expected: reference.cases.length, actual: candidate.cases.length });
  // Limit cloning to one case at a time so complete corpora do not require two
  // additional in-memory copies of all HTTP and skill payloads.
  for (let index = 0; index < Math.max(reference.cases.length, candidate.cases.length); index++) {
    if (!reference.cases[index] || !candidate.cases[index]) {
      differences.push({ path: `/cases/${index}`, kind: 'presence', expectedPresent: !!reference.cases[index], actualPresent: !!candidate.cases[index] }); continue;
    }
    const a = viewCase(reference.cases[index], index), b = viewCase(candidate.cases[index], index);
    differences.push(...diffValues(a.value, b.value, { equivalent(left, right, pointer) {
    if (/^\/cases\/\d+\/effects\/\d+\/headers\/host$/.test(pointer)) return isDeepStrictEqual(endpoint(left, reference), endpoint(right, candidate));
    const type = a.paths.get(pointer);
    if (!type) return undefined;
    const pattern = type === 'uuid' ? uuid : jcpID;
    if (!pattern.test(left) || !pattern.test(right)) return false;
    if (binding.has(left)) return binding.get(left) === right;
    if (reverse.has(right)) return false;
    binding.set(left, right); reverse.set(right, left); return true;
    } }));
  }
  const failing = new Set([...invariants, ...differences].map(d => Number(d.path.match(/^\/cases\/(\d+)/)?.[1])).filter(Number.isFinite));
  const invalidAll = invariants.some(d => !/^\/cases\/\d+(?:\/|$)/.test(d.path));
  const invalidCases = new Set(invariants.map(d => Number(d.path.match(/^\/cases\/(\d+)/)?.[1])).filter(Number.isFinite));
  const byCase = new Map();
  for (const difference of differences) {
    const index = Number(difference.path.match(/^\/cases\/(\d+)/)?.[1]);
    if (Number.isFinite(index)) { if (!byCase.has(index)) byCase.set(index, []); byCase.get(index).push(difference); }
  }
  const coverageGaps = [];
  for (const [side, trace] of [['reference', reference], ['candidate', candidate]]) for (const c of trace.cases || []) if (c.coverageGap) coverageGaps.push({ side, id: c.id, ...c.coverageGap });
  const gapIDs = new Set(coverageGaps.map(g => g.id));
  const groups = {}, dimensions = {};
  for (const [index, def] of suite.cases.entries()) {
    const group = def.corpus ? `${def.corpus}:${def.variant}` : def.group;
    const score = groups[group] ||= { selected: 0, agreement: 0, differencesOrInvalid: 0, actionCoverageGaps: 0, dimensions: {} };
    score.selected++; score[invalidAll || failing.has(index) ? 'differencesOrInvalid' : 'agreement']++;
    if (gapIDs.has(def.id)) score.actionCoverageGaps++;
    const prefix = `/cases/${index}`, expected = reference.cases[index];
    const invalid = invalidAll || invalidCases.has(index);
    const differsAt = path => (byCase.get(index) || []).some(d => d.path === path || d.path.startsWith(path + '/') || path.startsWith(d.path + '/'));
    function dimension(name, paths) {
      const state = invalid ? 'invalid' : paths.some(differsAt) ? 'differences' : 'agreement';
      for (const container of [dimensions, score.dimensions]) {
        const entry = container[name] ||= { compared: 0, agreement: 0, differences: 0, invalid: 0 };
        entry.compared++; entry[state]++;
      }
    }
    if (expected?.parser) {
      dimension('parserHttp', [prefix + '/parser/response']);
      const parsed = expected.parser.response?.body;
      if (parsed?.kind === 'json' && parsed.value?.type === 'NLU') {
        for (const field of ['intent', 'entities', 'rules']) dimension(field, [`${prefix}/parser/response/body/value/data/${field}`]);
        if (parsed.value.data?.intent === null) dimension('noMatch', [prefix + '/parser/response/body/value/data']);
      }
    }
    if (expected?.routing) {
      dimension('selectedSkill', [prefix + '/routing/kind', prefix + '/routing/decision/skillID']);
      if (expected.routing.kind === 'match') dimension('memo', [prefix + '/routing/decision/memo']);
    }
    for (const [step, turn] of (expected?.turns || []).entries()) {
      dimension('skillRequest', [`${prefix}/turns/${step}/input`]);
      const p = `${prefix}/turns/${step}/response/body/value/data`;
      if (has(turn.response?.body?.value?.data || {}, 'action')) dimension('action', [p + '/action']);
      if (turn.response?.body?.value?.data?.skill?.session) dimension('session', [p + '/skill/session']);
      if (turn.response?.body?.value?.data?.analytics) dimension('analytics', [p + '/analytics']);
    }
    if (expected?.effects?.length) dimension('providerRequests', [prefix + '/effects']);
  }
  return { schemaVersion: 1, pass: invariants.length === 0 && differences.length === 0 && coverageGaps.length === 0,
    measuredAgreement: invariants.length === 0 && differences.length === 0, cases: suite.cases.length, groups,
    denominators: suite.denominators, selection: suite.selection, dimensions, invariants, differences, coverageGaps,
    policy: { fields: 'All status/headers, JSON field presence/types/order, parser inputs/results, winning rules, decisions/memos, production request-builder inputs and emitted requests, JCP/ESML/analytics and complete session contents.',
      generatedIDs: 'Bijective v4 envelope/session IDs and 32-hex JCP command IDs at command-container paths only; view/domain IDs stay literal.',
      derivedBytes: 'Raw JSON, Content-Length and ETag are independently validated. Only validated duplicate raw bytes and ETag digest values are removed.',
      timing: 'Per-request and per-case measured times are bounded; message timestamps and application timing fields remain compared.',
      endpoints: 'Only the fixture peer authority in outbound Host headers is rebound.',
      gaps: 'Unhosted cloud action targets are explicit coverage gaps and prevent a full gate pass.' } };
}
