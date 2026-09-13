#!/usr/bin/env node

// Candidate side of the S-11 differential. Phoenix's real Data HTTP service
// is used with its real defaultOrsGet path. A fetch wrapper rewrites only the
// ORS host to a loopback provider, recording the original URL/body/headers.

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const matrixPath = path.resolve(process.argv[2]);
const outPath = path.resolve(process.argv[3]);
const matrix = JSON.parse(fs.readFileSync(matrixPath, 'utf8'));
const fixture = createRequire(import.meta.url)(path.join(here, 'fixtures.cjs'));
const EXPECTED_CASE_IDS = [
  'get-miss-google-route', 'get-hit-cache', 'head-cold-eventual-warm-hit',
  'empty-reply-not-cached', 'provider-status-error-not-cached', 'zero-results',
  'skip-cache-false-refetch', 'skip-cache-array-refetch',
  'validation-missing-origin', 'validation-missing-destination',
  'validation-invalid-origin', 'validation-invalid-destination',
  'validation-missing-mode', 'validation-invalid-mode',
  'validation-unparseable-origin', 'validation-unparseable-destination',
  'mode-driving-wire', 'mode-transit-wire', 'mode-bicycling-wire', 'mode-walking-wire',
];
const EXPECTED_COUNTS = { namedCases: 20, requestRuns: 28, providerCalls: 17 };
// Filled after matrix.json is fully populated. This hashes the complete
// semantic matrix (byte pins are independently checked below), rather than
// its presentation formatting.
const MATRIX_SEMANTIC_SHA256 = 'f25be355dbf8e11ad5113a3b24fd2e5f34a138dcd6e0a63892538b36b7f565cf';

function sha(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function fileSha(file) { return sha(fs.readFileSync(file)); }
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.keys(value).sort().reduce((out, key) => { out[key] = stable(value[key]); return out; }, {});
  return value;
}
function canonical(value) { return JSON.stringify(stable(value)); }
function semanticMatrix(value) {
  const copy = JSON.parse(JSON.stringify(value));
  if (copy.reference) {
    delete copy.reference.sourceHashes;
    delete copy.reference.compiledHashes;
    delete copy.reference.testSha256;
    delete copy.reference.fixtureSourceSha256;
    delete copy.reference.fixtureCompiledSha256;
  }
  if (copy.candidate) delete copy.candidate.hashes;
  if (copy.harness) delete copy.harness.sourceHashes;
  return copy;
}
function fail(message) { throw new Error(message); }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function mkdirp(dir) { fs.mkdirSync(dir, { recursive: true }); }

function verifyProvenance() {
  if (matrix.schema !== 'phoenix.parity.s11.data-maps-http-matrix.v1') fail('unsupported matrix schema');
  if (matrix.task !== 'S-11' || matrix.base !== '55e23ac') fail('matrix task/base mismatch');
  if (sha(canonical(semanticMatrix(matrix))) !== MATRIX_SEMANTIC_SHA256) fail('matrix semantic digest mismatch');
  if (!matrix.cases || matrix.cases.length !== EXPECTED_CASE_IDS.length || matrix.cases.map(item => item.id).join('\n') !== EXPECTED_CASE_IDS.join('\n')) fail('case inventory/order mismatch');
  if (!matrix.counts || matrix.counts.namedCases !== EXPECTED_COUNTS.namedCases || matrix.counts.requestRuns !== EXPECTED_COUNTS.requestRuns || matrix.counts.providerCalls !== EXPECTED_COUNTS.providerCalls) fail('case count pin mismatch');
  const candidate = matrix.candidate || {};
  const candidateHashes = {};
  for (const relative of candidate.paths || []) {
    const actual = fileSha(path.join(root, relative));
    if (!candidate.hashes || candidate.hashes[relative] !== actual) fail(`candidate source changed: ${relative}`);
    candidateHashes[relative] = actual;
  }
  const harness = matrix.harness || {};
  const harnessHashes = {};
  for (const relative of harness.sourcePaths || []) {
    // The source runner and shared fixture are part of the candidate checkout
    // too; checking their bytes closes a runner-substitution seam.
    const actual = fileSha(path.join(root, relative));
    if (!harness.sourceHashes || harness.sourceHashes[relative] !== actual) fail(`harness changed: ${relative}`);
    harnessHashes[relative] = actual;
  }
  let actualRevision;
  try { actualRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(); }
  catch (error) { fail(`candidate revision unavailable: ${error.message}`); }
  if (process.env.PHOENIX_CANDIDATE_REVISION && process.env.PHOENIX_CANDIDATE_REVISION !== actualRevision) fail('candidate revision does not match run tree');
  return { candidateHashes, harnessHashes, actualRevision };
}

function freezeRuntime() {
  process.env.TZ = matrix.runtime.timezone;
  const RealDate = Date;
  const fixedNow = RealDate.parse(matrix.runtime.clockISO);
  globalThis.Date = class FixtureDate extends RealDate {
    constructor(...args) { super(...(args.length ? args : [fixedNow])); }
    static now() { return fixedNow; }
  };
  let randomState = matrix.runtime.randomSeed >>> 0;
  Math.random = () => {
    randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
    return randomState / 0x100000000;
  };
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve(server.address().port);
    });
  });
}
function closeServer(server) {
  return new Promise(resolve => {
    if (!server || !server.listening) return resolve();
    server.close(() => resolve());
  });
}

function providerPlan(spec) {
  if (spec.kind === 'empty') return [{ status: 200, body: '' }, { status: 200, body: '' }, { status: 200, body: fixture.ORS }];
  if (spec.kind === 'provider-error') return [
    { status: 503, body: { error: 'provider unavailable' } },
    { status: 503, body: { error: 'provider unavailable' } },
  ];
  if (spec.kind === 'zero') return [{ status: 200, body: { routes: [] } }];
  if (spec.kind === 'head') return [{ status: 200, body: fixture.ORS, delayMs: 75 }];
  if (spec.kind === 'hit' || spec.kind === 'skip') return [{ status: 200, body: fixture.ORS }, { status: 200, body: fixture.ORS }];
  return [{ status: 200, body: fixture.ORS }];
}

function createProvider(plan) {
  const state = { plan, index: 0, calls: [], server: null };
  state.server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(Buffer.from(chunk)));
    req.on('end', () => {
      const step = plan[Math.min(state.index, plan.length - 1)] || { status: 200, body: '' };
      state.index += 1;
      const bodyText = Buffer.concat(chunks).toString('utf8');
      const call = { method: req.method, path: new URL(req.url, 'http://provider').pathname, rawPath: req.url, body: bodyText, status: step.status };
      state.calls.push(call);
      let output = step.body;
      if (output && typeof output === 'object') output = JSON.stringify(output);
      if (output === undefined || output === null) output = '';
      const send = () => {
        if (step.networkError) return req.socket.destroy();
        res.statusCode = step.status;
        if (step.status >= 200 && step.status < 300) res.setHeader('content-type', 'application/json');
        res.end(String(output));
      };
      if (step.delayMs) setTimeout(send, step.delayMs); else send();
    });
  });
  return state;
}

function request(port, query, method = 'GET') {
  return new Promise((resolve, reject) => {
    const requestPath = `/v1/google_maps${query ? `?${query}` : ''}`;
    const req = http.request({ hostname: '127.0.0.1', port, path: requestPath, method }, res => {
      const chunks = [];
      res.setEncoding('utf8');
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: chunks.join('') }));
    });
    req.on('error', reject);
    req.end();
  });
}

function headerSubset(headers) {
  return Object.fromEntries(['content-type', 'content-length', 'etag', 'x-powered-by'].map(name => [name, headers[name] ?? null]));
}
function normalizeJSON(value) {
  try {
    const parsed = JSON.parse(value);
    if (parsed && parsed.lassoInsertedIntoRedisAt) parsed.lassoInsertedIntoRedisAt = '<frozen-clock>';
    return parsed;
  } catch { return value; }
}
function responseSummary(value) {
  return { status: value.status, headers: headerSubset(value.headers), body: value.body, bodyNormalized: normalizeJSON(value.body) };
}
function normalizeHeaders(headers) {
  return Object.fromEntries(Object.entries(headers || {}).map(([name, value]) => [name.toLowerCase(), String(value)]));
}

function parseCandidateCall(wire, local, mode) {
  const original = new URL(wire.url);
  const body = typeof wire.body === 'string' && wire.body ? JSON.parse(wire.body) : wire.body;
  const coordinates = body && body.coordinates || [];
  const origin = { lat: Number(coordinates[0] && coordinates[0][1]), lon: Number(coordinates[0] && coordinates[0][0]) };
  const destination = { lat: Number(coordinates[1] && coordinates[1][1]), lon: Number(coordinates[1] && coordinates[1][0]) };
  const profile = original.pathname.split('/').pop();
  return {
    key: `google_maps:${origin.lat};${origin.lon};${destination.lat};${destination.lon};${mode}`,
    origin,
    destination,
    mode,
    wire: {
      method: wire.method,
      path: original.pathname,
      query: Object.fromEntries(original.searchParams.entries()),
      headers: normalizeHeaders(wire.headers),
      body,
      profile,
    },
    status: local.status,
  };
}

function expectedCounts(cases) {
  let requestRuns = 0;
  let providerCalls = 0;
  for (const spec of cases) {
    if (spec.kind === 'head') { requestRuns += 3; providerCalls += 1; }
    else if (spec.kind === 'hit') { requestRuns += 2; providerCalls += 1; }
    else if (spec.kind === 'empty') { requestRuns += 3; providerCalls += 3; }
    else if (spec.kind === 'provider-error') { requestRuns += 2; providerCalls += 2; }
    else if (spec.kind === 'skip') { requestRuns += 2; providerCalls += 2; }
    else { requestRuns += 1; providerCalls += spec.kind === 'validation' ? 0 : 1; }
  }
  return { requestRuns, providerCalls };
}

async function executeCase(spec, createDataService, TTLCache) {
  const effects = [];
  const backing = new TTLCache();
  const cache = {
    m: backing.m,
    get(key) { effects.push({ operation: 'cache.get', key }); return backing.get(key); },
    set(key, value, ttl) { effects.push({ operation: 'cache.set', key, value: structuredClone(value), ttl }); return backing.set(key, value, ttl); },
  };
  const provider = createProvider(providerPlan(spec));
  const providerPort = await listen(provider.server);
  const wire = [];
  const RealFetch = globalThis.fetch;
  process.env.ETCO_data_orsKey = 's11-local-ors-key';
  globalThis.fetch = async (target, options = {}) => {
    const targetText = String(target);
    if (!targetText.startsWith('https://api.openrouteservice.org/')) return RealFetch(target, options);
    const parsed = new URL(targetText);
    const body = options.body === undefined ? null : String(options.body);
    wire.push({ url: targetText, method: options.method || 'GET', headers: { ...(options.headers || {}) }, body });
    effects.push({ operation: 'provider.call', index: wire.length - 1 });
    return RealFetch(`http://127.0.0.1:${providerPort}${parsed.pathname}`, options);
  };
  const service = createDataService({ cache });
  const server = await service.listen(0);
  const port = server.address().port;
  const responses = [];
  const observations = {};
  const mode = spec.mode ?? 'driving';
  try {
    const q = fixture.requestFor(spec);
    if (spec.kind === 'head') {
      const head = await request(port, q, 'HEAD');
      observations.headResponseBeforeProvider = provider.calls.length === 0;
      responses.push({ label: 'HEAD cold', response: responseSummary(head) });
      const key = `google_maps:${fixture.ORIGIN.lat};${fixture.ORIGIN.lon};${fixture.DESTINATION.lat};${fixture.DESTINATION.lon};driving`;
      for (let attempt = 0; attempt < 400 && !backing.m.has(key); attempt += 1) await sleep(5);
      if (!backing.m.has(key)) fail('timeout waiting for HEAD prefetch');
      responses.push({ label: 'GET warmed hit', response: responseSummary(await request(port, q, 'GET')) });
      responses.push({ label: 'HEAD warm hit', response: responseSummary(await request(port, q, 'HEAD')) });
      await sleep(20);
      observations.providerCallsAfterWarmHead = provider.calls.length;
    } else if (spec.kind === 'hit') {
      responses.push({ label: 'GET miss', response: responseSummary(await request(port, q, 'GET')) });
      responses.push({ label: 'GET hit', response: responseSummary(await request(port, q, 'GET')) });
    } else if (spec.kind === 'empty' || spec.kind === 'provider-error') {
      responses.push({ label: 'GET first failure', response: responseSummary(await request(port, q, 'GET')) });
      responses.push({ label: 'GET second failure', response: responseSummary(await request(port, q, 'GET')) });
      if (spec.kind === 'empty') responses.push({ label: 'GET recovery miss', response: responseSummary(await request(port, q, 'GET')) });
    } else if (spec.kind === 'skip') {
      responses.push({ label: 'GET warm', response: responseSummary(await request(port, fixture.standardQuery(spec.mode), 'GET')) });
      responses.push({ label: 'GET skip cache', response: responseSummary(await request(port, q, 'GET')) });
    } else {
      responses.push({ label: 'GET', response: responseSummary(await request(port, q, 'GET')) });
    }
  } finally {
    await sleep(10);
    observations.cacheKeys = [...backing.m.keys()].sort();
    await new Promise(resolve => server.close(resolve));
    await closeServer(provider.server);
    globalThis.fetch = RealFetch;
  }
  const providerCalls = provider.calls.map((local, index) => parseCandidateCall(wire[index], local, mode));
  return {
    id: spec.id,
    kind: spec.kind,
    sourceName: spec.sourceName,
    sourceLine: spec.sourceLine,
    expectedError: spec.expectedError ?? null,
    responses,
    effects,
    providerCalls,
    observations,
  };
}

async function main() {
  const provenance = verifyProvenance();
  freezeRuntime();
  const dataModule = await import(pathToFileURL(path.join(root, 'packages/data/src/index.js')).href);
  const counts = expectedCounts(matrix.cases);
  const cases = [];
  for (const spec of matrix.cases) {
    const row = await executeCase(spec, dataModule.createDataService, dataModule.TTLCache);
    row.sha256 = sha(canonical(row));
    cases.push(row);
  }
  if (cases.length !== EXPECTED_COUNTS.namedCases) fail('case count mismatch');
  if (counts.requestRuns !== EXPECTED_COUNTS.requestRuns) fail(`request run count mismatch: ${counts.requestRuns}`);
  if (counts.providerCalls !== EXPECTED_COUNTS.providerCalls) fail(`provider call count mismatch: ${counts.providerCalls}`);
  const receipt = {
    schema: matrix.harness.runnerSchema,
    result: 'pass',
    task: matrix.task,
    base: matrix.base,
    runtime: { node: process.version, platform: process.platform, timezone: matrix.runtime.timezone, clockISO: matrix.runtime.clockISO, randomSeed: matrix.runtime.randomSeed, network: 'loopback-only' },
    candidate: { revision: provenance.actualRevision, paths: matrix.candidate.paths, hashes: provenance.candidateHashes },
    harness: { sourcePaths: matrix.harness.sourcePaths, sourceHashes: provenance.harnessHashes },
    counts: { namedCases: cases.length, requestRuns: counts.requestRuns, providerCalls: counts.providerCalls },
    retainedGaps: matrix.retainedGaps,
    cases,
  };
  mkdirp(path.dirname(outPath));
  fs.writeFileSync(outPath, `${JSON.stringify(receipt, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ result: receipt.result, cases: cases.length, requestRuns: counts.requestRuns, providerCalls: counts.providerCalls, out: outPath })}\n`);
}

main().catch(error => {
  const receipt = { schema: matrix.harness?.runnerSchema, result: 'fail', runtime: { node: process.version }, error: String(error?.stack || error) };
  try { mkdirp(path.dirname(outPath)); fs.writeFileSync(outPath, `${JSON.stringify(receipt, null, 2)}\n`); } catch {}
  process.stderr.write(`${receipt.error}\n`);
  process.exitCode = 1;
});
