'use strict';

// Execute the pinned Pegasus Lasso GoogleMapsHandler/AbstractRelayRequestHandler
// in Node 8.9.4. The only provider reachable from this process is a loopback
// HTTP server; the handler's signed URL method is wrapped only to rewrite the
// host, leaving the source request serialization and signature code intact.

var fs = require('fs');
var path = require('path');
var http = require('http');
var url = require('url');
var querystring = require('querystring');
var crypto = require('crypto');

var ref = path.resolve(process.argv[2]);
var matrixPath = path.resolve(process.argv[3]);
var outPath = path.resolve(process.argv[4]);
var matrix = JSON.parse(fs.readFileSync(matrixPath, 'utf8'));
var fixture = require(path.join(__dirname, 'fixtures.cjs'));

// These are duplicated outside matrix.json so a changed matrix cannot change
// the inventory that this runner is willing to execute.
var EXPECTED_CASE_IDS = [
  'get-miss-google-route', 'get-hit-cache', 'head-cold-eventual-warm-hit',
  'empty-reply-not-cached', 'provider-status-error-not-cached', 'zero-results',
  'skip-cache-false-refetch', 'skip-cache-array-refetch',
  'validation-missing-origin', 'validation-missing-destination',
  'validation-invalid-origin', 'validation-invalid-destination',
  'validation-missing-mode', 'validation-invalid-mode',
  'validation-unparseable-origin', 'validation-unparseable-destination',
  'mode-driving-wire', 'mode-transit-wire', 'mode-bicycling-wire', 'mode-walking-wire',
];
var EXPECTED_COUNTS = { namedCases: 20, requestRuns: 28, providerCalls: 17 };
// Filled after matrix.json is fully populated. This hashes the complete
// semantic matrix (byte pins are independently checked below), rather than
// its presentation formatting.
var MATRIX_SEMANTIC_SHA256 = 'f25be355dbf8e11ad5113a3b24fd2e5f34a138dcd6e0a63892538b36b7f565cf';

function sha(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function fileSha(file) { return sha(fs.readFileSync(file)); }
function canonical(value) { return JSON.stringify(stable(value)); }
function semanticMatrix(value) {
  var copy = JSON.parse(JSON.stringify(value));
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
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce(function (out, key) {
      out[key] = stable(value[key]);
      return out;
    }, {});
  }
  return value;
}
function fail(message) { throw new Error(message); }
function mkdirp(dir) {
  if (fs.existsSync(dir)) return;
  var parent = path.dirname(dir);
  if (parent !== dir) mkdirp(parent);
  try { fs.mkdirSync(dir); } catch (error) { if (!fs.existsSync(dir)) throw error; }
}
function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }

function requiredFile(relative, expected, label) {
  if (!expected) fail('matrix omits ' + label + ' hash: ' + relative);
  var absolute = path.join(ref, relative);
  if (!fs.existsSync(absolute)) fail('missing pinned ' + label + ': ' + absolute);
  var actual = fileSha(absolute);
  if (actual !== expected) fail('pinned ' + label + ' changed: ' + relative);
  return actual;
}

function verifyProvenance() {
  if (matrix.schema !== 'phoenix.parity.s11.data-maps-http-matrix.v1') fail('unsupported matrix schema');
  if (matrix.task !== 'S-11' || matrix.base !== '55e23ac') fail('matrix task/base mismatch');
  if (sha(canonical(semanticMatrix(matrix))) !== MATRIX_SEMANTIC_SHA256) fail('matrix semantic digest mismatch');
  if (!matrix.cases || matrix.cases.length !== EXPECTED_CASE_IDS.length || matrix.cases.map(function (item) { return item.id; }).join('\n') !== EXPECTED_CASE_IDS.join('\n')) fail('case inventory/order mismatch');
  if (!matrix.counts || matrix.counts.namedCases !== EXPECTED_COUNTS.namedCases || matrix.counts.requestRuns !== EXPECTED_COUNTS.requestRuns || matrix.counts.providerCalls !== EXPECTED_COUNTS.providerCalls) fail('case count pin mismatch');
  var reference = matrix.reference || {};
  if (reference.revision !== '5c0a7390539663ba749d360de348a428c088505c') fail('unexpected Pegasus revision');
  if (process.version !== reference.sourceRuntime) fail('source runtime is ' + process.version + ', expected ' + reference.sourceRuntime);
  var compiledPath = path.join(ref, reference.compiledRecordPath);
  if (fileSha(compiledPath) !== reference.compiledRecordSha256) fail('parity-compiled.json hash mismatch');
  var compiled = JSON.parse(fs.readFileSync(compiledPath, 'utf8'));
  if (compiled.referenceRevision !== reference.revision || compiled.runtime !== reference.sourceRuntime) fail('compiled provenance mismatch');

  var sourceHashes = {};
  (reference.sourcePaths || []).forEach(function (relative) {
    var actual = requiredFile(relative, reference.sourceHashes && reference.sourceHashes[relative], 'source file');
    sourceHashes[relative] = actual;
    if (!compiled.inputs || compiled.inputs[relative] !== actual) fail('compiled input mismatch: ' + relative);
  });
  var compiledHashes = {};
  (reference.compiledPaths || []).forEach(function (relative) {
    var actual = requiredFile(relative, reference.compiledHashes && reference.compiledHashes[relative], 'compiled file');
    compiledHashes[relative] = actual;
    if (!compiled.outputs || compiled.outputs[relative] !== actual) fail('compiled output mismatch: ' + relative);
  });
  requiredFile(reference.testPath, reference.testSha256, 'archived test');
  requiredFile(reference.fixtureSourcePath, reference.fixtureSourceSha256, 'source fixture');
  requiredFile(reference.fixtureCompiledPath, reference.fixtureCompiledSha256, 'compiled fixture');
  var harnessHashes = {};
  (matrix.harness && matrix.harness.sourcePaths || []).forEach(function (relative) {
    var actual = fileSha(path.join(__dirname, path.basename(relative)));
    if (!matrix.harness.sourceHashes || matrix.harness.sourceHashes[relative] !== actual) fail('source harness changed: ' + relative);
    harnessHashes[relative] = actual;
  });
  return { sourceHashes: sourceHashes, compiledHashes: compiledHashes, harnessHashes: harnessHashes };
}

function freezeRuntime() {
  process.env.TZ = matrix.runtime.timezone;
  var RealDate = Date;
  var fixedNow = RealDate.parse(matrix.runtime.clockISO);
  global.Date = class FixtureDate extends RealDate {
    constructor() {
      var args = Array.prototype.slice.call(arguments);
      super(...(args.length ? args : [fixedNow]));
    }
    static now() { return fixedNow; }
  };
  var randomState = matrix.runtime.randomSeed >>> 0;
  Math.random = function seededRandom() {
    randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
    return randomState / 0x100000000;
  };
}

function listen(server) {
  return new Promise(function (resolve, reject) {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', function () {
      server.removeListener('error', reject);
      resolve(server.address().port);
    });
  });
}
function closeServer(server) {
  return new Promise(function (resolve) {
    if (!server || !server.listening) return resolve();
    server.close(function () { resolve(); });
  });
}

function providerPlan(spec, sourceFixture) {
  var route = fixture.googleParityPayload(sourceFixture);
  if (spec.kind === 'empty') return [{ status: 200, body: '' }, { status: 200, body: '' }, { status: 200, body: route }];
  if (spec.kind === 'provider-error') return [
    { status: 503, body: { error: 'provider unavailable' } },
    { status: 503, body: { error: 'provider unavailable' } },
  ];
  if (spec.kind === 'zero') return [{ status: 200, body: { status: 'ZERO_RESULTS', geocoded_waypoints: [], routes: [] } }];
  if (spec.kind === 'head') return [{ status: 200, body: route, delayMs: 75 }];
  if (spec.kind === 'hit' || spec.kind === 'skip') return [{ status: 200, body: route }, { status: 200, body: route }];
  return [{ status: 200, body: route }];
}

function createProvider(protocol, plan, effects) {
  var state = { protocol: protocol, plan: plan, index: 0, calls: [], effects: effects || [] };
  var server = http.createServer(function (req, res) {
    var body = '';
    req.setEncoding('utf8');
    req.on('data', function (chunk) { body += chunk; });
    req.on('end', function () {
      var step = state.plan[Math.min(state.index, state.plan.length - 1)] || { status: 200, body: '' };
      state.index += 1;
      var parsed = url.parse(req.url, true);
      var call = {
        protocol: state.protocol,
        method: req.method,
        path: parsed.pathname,
        rawPath: req.url,
        query: parsed.query,
        body: body,
        status: step.status,
      };
      state.calls.push(call);
      state.effects.push({ operation: 'provider.call', index: state.calls.length - 1 });
      var output = step.body;
      if (output && typeof output === 'object') output = JSON.stringify(output);
      if (output === undefined || output === null) output = '';
      var send = function () {
        if (step.networkError) return req.socket.destroy();
        res.statusCode = step.status;
        if (step.status >= 200 && step.status < 300) res.setHeader('content-type', 'application/json');
        res.end(String(output));
      };
      if (step.delayMs) setTimeout(send, step.delayMs); else send();
    });
  });
  state.server = server;
  return state;
}

function instrumentRedis(client, effects) {
  var get = client.get;
  client.get = function (key, cb) {
    effects.push({ operation: 'cache.get', key: key });
    return get.call(client, key, cb);
  };
  var set = client.set;
  client.set = function () {
    var args = Array.prototype.slice.call(arguments);
    var key = args[0];
    var value = args[1];
    var ttl = null;
    for (var i = 2; i < args.length - 1; i += 1) if (String(args[i]).toUpperCase() === 'EX') ttl = Number(args[i + 1]);
    var parsed;
    try { parsed = JSON.parse(value); } catch (_) { parsed = value; }
    effects.push({ operation: 'cache.set', key: key, value: parsed, ttl: ttl });
    return set.apply(client, args);
  };
}

function redisKeys(client) {
  return new Promise(function (resolve, reject) {
    client.keys('*', function (error, keys) { if (error) reject(error); else resolve(keys || []); });
  });
}

// The archived Pegasus lockfile names fakeredis, but the reference checkout
// intentionally contains no install of that optional package. This tiny
// callback-compatible Redis seam exercises the handler's real get/set/EX
// calls and keeps the source container network-free and self-contained.
function createLocalRedis() {
  var values = new Map();
  return {
    get: function (key, cb) { setImmediate(function () { cb(null, values.has(key) ? values.get(key) : null); }); },
    set: function (key, value) {
      var args = Array.prototype.slice.call(arguments, 2);
      var cb = typeof args[args.length - 1] === 'function' ? args.pop() : null;
      values.set(key, value);
      if (cb) setImmediate(function () { cb(null, 'OK'); });
      return 'OK';
    },
    keys: function (pattern, cb) { setImmediate(function () { cb(null, Array.from(values.keys())); }); },
    quit: function () { values.clear(); },
  };
}

function request(port, query, method) {
  return new Promise(function (resolve, reject) {
    var requestPath = '/v1/google_maps' + (query ? '?' + query : '');
    var req = http.request({ hostname: '127.0.0.1', port: port, path: requestPath, method: method || 'GET' }, function (res) {
      var chunks = [];
      res.setEncoding('utf8');
      res.on('data', function (chunk) { chunks.push(chunk); });
      res.on('end', function () {
        resolve({ status: res.statusCode, headers: res.headers, body: chunks.join('') });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function headerSubset(headers) {
  var names = ['content-type', 'content-length', 'etag', 'x-powered-by'];
  return names.reduce(function (out, name) { out[name] = headers[name] === undefined ? null : headers[name]; return out; }, {});
}
function normalizeJSON(value) {
  try {
    var parsed = JSON.parse(value);
    if (parsed && parsed.lassoInsertedIntoRedisAt) parsed.lassoInsertedIntoRedisAt = '<frozen-clock>';
    return parsed;
  } catch (_) { return value; }
}
function responseSummary(value) {
  return {
    status: value.status,
    headers: headerSubset(value.headers),
    body: value.body,
    bodyNormalized: normalizeJSON(value.body),
  };
}

function parseGoogleSemantic(call, signedUrl) {
  var parsed = url.parse(signedUrl, true);
  var q = parsed.query || {};
  var originParts = String(q.origin || '').split(',');
  var destinationParts = String(q.destination || '').split(',');
  var origin = { lat: Number(originParts[0]), lon: Number(originParts[1]) };
  var destination = { lat: Number(destinationParts[0]), lon: Number(destinationParts[1]) };
  return {
    key: 'google_maps:' + origin.lat + ';' + origin.lon + ';' + destination.lat + ';' + destination.lon + ';' + q.mode,
    origin: origin,
    destination: destination,
    mode: q.mode,
    wire: {
      method: call.method,
      path: parsed.pathname,
      rawQuery: parsed.search ? parsed.search.slice(1) : '',
      query: q,
    },
    status: call.status,
  };
}

function makeProviderCalls(provider, signedUrls) {
  return provider.calls.map(function (call, index) {
    return parseGoogleSemantic(call, signedUrls[index]);
  });
}

function makeService(provider, effects, redisClient) {
  var GoogleMapsHandler = require(path.join(ref, 'packages/lasso/lib/relay/GoogleMapsHandler.js')).GoogleMapsHandler;
  var BaseService = require(path.join(ref, 'packages/utils/lib/service/BaseService.js')).BaseService;
  var handler = new GoogleMapsHandler('c2VjcmV0', redisClient);
  var signedUrls = [];
  var signed = handler.signedUrlFromParams.bind(handler);
  handler.signedUrlFromParams = function (params, auth) {
    var original = signed(params, auth);
    signedUrls.push(original);
    var parsed = url.parse(original);
    return 'http://127.0.0.1:' + provider.port + parsed.path;
  };
  var service = new BaseService('LassoHarness');
  service.disableAuth = true;
  service.addHttpHandler('/v1/google_maps', { handler: handler, authenticationRequired: false });
  return { service: service, signedUrls: signedUrls };
}

function waitFor(check, timeoutMs) {
  var started = 0;
  return new Promise(function (resolve, reject) {
    (function poll() {
      Promise.resolve().then(check).then(function (ok) {
        if (ok) return resolve();
        started += 5;
        if (started >= timeoutMs) return reject(new Error('timeout waiting for HEAD prefetch'));
        setTimeout(poll, 5);
      }).catch(reject);
    }());
  });
}

async function executeCase(spec, sourceFixture) {
  var effects = [];
  var provider = createProvider('google', providerPlan(spec, sourceFixture), effects);
  provider.port = await listen(provider.server);
  var redisClient = createLocalRedis();
  instrumentRedis(redisClient, effects);
  var built = makeService(provider, effects, redisClient);
  await built.service.init(0);
  var port = built.service.server.address().port;
  var responses = [];
  var observations = {};
  try {
    var q = fixture.requestFor(spec);
    if (spec.kind === 'head') {
      var head = await request(port, q, 'HEAD');
      observations.headResponseBeforeProvider = provider.calls.length === 0;
      responses.push({ label: 'HEAD cold', response: responseSummary(head) });
      await waitFor(function () { return redisKeys(redisClient).then(function (keys) { return keys.indexOf('google_maps:' + fixture.ORIGIN.lat + ';' + fixture.ORIGIN.lon + ';' + fixture.DESTINATION.lat + ';' + fixture.DESTINATION.lon + ';driving') >= 0; }); }, 2000);
      var hit = await request(port, q, 'GET');
      responses.push({ label: 'GET warmed hit', response: responseSummary(hit) });
      var warmHead = await request(port, q, 'HEAD');
      responses.push({ label: 'HEAD warm hit', response: responseSummary(warmHead) });
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
    observations.cacheKeys = (await redisKeys(redisClient)).slice().sort();
    await built.service.close();
    if (redisClient.quit) redisClient.quit();
    await closeServer(provider.server);
  }
  var calls = makeProviderCalls(provider, built.signedUrls);
  return {
    id: spec.id,
    kind: spec.kind,
    sourceName: spec.sourceName,
    sourceLine: spec.sourceLine,
    expectedError: spec.expectedError || null,
    responses: responses,
    effects: effects,
    providerCalls: calls,
    observations: observations,
    fixtureShape: {
      sourceTopLevelKeys: Object.keys(sourceFixture).sort(),
      sourceRouteKeys: Object.keys(sourceFixture.routes[0]).sort(),
      sourceLegKeys: Object.keys(sourceFixture.routes[0].legs[0]).sort(),
    },
  };
}

function expectedCounts(cases) {
  var requestRuns = 0;
  var providerCalls = 0;
  cases.forEach(function (spec) {
    if (spec.kind === 'head') { requestRuns += 3; providerCalls += 1; }
    else if (spec.kind === 'hit') { requestRuns += 2; providerCalls += 1; }
    else if (spec.kind === 'empty') { requestRuns += 3; providerCalls += 3; }
    else if (spec.kind === 'provider-error') { requestRuns += 2; providerCalls += 2; }
    else if (spec.kind === 'skip') { requestRuns += 2; providerCalls += 2; }
    else { requestRuns += 1; providerCalls += (spec.kind === 'validation' ? 0 : 1); }
  });
  return { requestRuns: requestRuns, providerCalls: providerCalls };
}

async function main() {
  var provenance = verifyProvenance();
  freezeRuntime();
  var sourceFixture = require(path.join(ref, matrix.reference.fixtureCompiledPath)).googleMapsMontrealData;
  if (!sourceFixture || !sourceFixture.routes || !sourceFixture.routes[0]) fail('source fixture route missing');
  var cases = [];
  for (var i = 0; i < matrix.cases.length; i += 1) {
    var row = await executeCase(matrix.cases[i], sourceFixture);
    row.sha256 = sha(canonical(row));
    cases.push(row);
  }
  var counts = expectedCounts(matrix.cases);
  if (cases.length !== EXPECTED_COUNTS.namedCases) fail('case count mismatch');
  if (counts.requestRuns !== EXPECTED_COUNTS.requestRuns) fail('request run count mismatch: ' + counts.requestRuns);
  if (counts.providerCalls !== EXPECTED_COUNTS.providerCalls) fail('provider call count mismatch: ' + counts.providerCalls);
  var reference = matrix.reference;
  var receipt = {
    schema: matrix.harness.runnerSchema,
    result: 'pass',
    task: matrix.task,
    base: matrix.base,
    runtime: {
      node: process.version,
      platform: process.platform,
      timezone: matrix.runtime.timezone,
      clockISO: matrix.runtime.clockISO,
      randomSeed: matrix.runtime.randomSeed,
      network: 'none',
      sourceImage: reference.sourceImage,
      sourceImageDigest: reference.sourceImageDigest,
    },
    reference: {
      repo: reference.repo,
      revision: reference.revision,
      compiledRecordPath: reference.compiledRecordPath,
      compiledRecordSha256: reference.compiledRecordSha256,
      sourcePaths: reference.sourcePaths,
      sourceHashes: provenance.sourceHashes,
      compiledPaths: reference.compiledPaths,
      compiledHashes: provenance.compiledHashes,
      testPath: reference.testPath,
      testSha256: reference.testSha256,
      fixtureSourcePath: reference.fixtureSourcePath,
      fixtureSourceSha256: reference.fixtureSourceSha256,
      fixtureCompiledPath: reference.fixtureCompiledPath,
      fixtureCompiledSha256: reference.fixtureCompiledSha256,
    },
    harness: { sourcePaths: matrix.harness.sourcePaths, sourceHashes: provenance.harnessHashes },
    counts: { namedCases: cases.length, requestRuns: counts.requestRuns, providerCalls: counts.providerCalls },
    retainedGaps: matrix.retainedGaps,
    cases: cases,
  };
  mkdirp(path.dirname(outPath));
  fs.writeFileSync(outPath, JSON.stringify(receipt, null, 2) + '\n');
  process.stdout.write(JSON.stringify({ result: receipt.result, cases: cases.length, requestRuns: counts.requestRuns, providerCalls: counts.providerCalls, out: outPath }) + '\n');
}

main().then(function () { process.exit(0); }).catch(function (error) {
  var receipt = { schema: matrix.harness && matrix.harness.runnerSchema, result: 'fail', runtime: { node: process.version }, error: String(error && error.stack || error) };
  try { mkdirp(path.dirname(outPath)); fs.writeFileSync(outPath, JSON.stringify(receipt, null, 2) + '\n'); } catch (_) {}
  process.stderr.write(receipt.error + '\n');
  process.exit(1);
});
