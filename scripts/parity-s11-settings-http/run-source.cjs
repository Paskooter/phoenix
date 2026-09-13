'use strict';

// Run the pinned Pegasus SettingsClient under the digest-pinned Node 8 image.
// The only reachable service is the loopback HTTP peer created in this file.

const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');

const referenceRoot = path.resolve(process.argv[2]);
const matrixPath = path.resolve(process.argv[3]);
const outputPath = path.resolve(process.argv[4]);
if (!referenceRoot || !matrixPath || !outputPath) {
  throw new Error('usage: run-source.cjs <reference-root> <matrix.json> <output.json>');
}

const matrix = JSON.parse(fs.readFileSync(matrixPath, 'utf8'));
const SOURCE_REVISION = 'jiboV2/pegasus@5c0a7390539663ba749d360de348a428c088505c';
const SOURCE_IMAGE_DIGEST = 'sha256:8233daae003ba0ecba4e6d70cab8525c30a3f085935afc624a275892ebe23f7c';
const PROVENANCE_MANIFEST_SHA256 = '0dce7437bd5d1df7415b77a0bdd7c2fc034d7d11f831584d0ce60171b1654225';
const PROVENANCE_PATH = path.join(__dirname, 'provenance.json');
const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
if (matrix.schema !== 's11-settings-http-v1') throw new Error('unsupported S-11 settings matrix schema');
if (matrix.referenceRevision !== SOURCE_REVISION) throw new Error('unexpected Pegasus reference revision');
if (matrix.sourceImage !== 'node' || matrix.sourceImageDigest !== SOURCE_IMAGE_DIGEST) throw new Error('unexpected source image pin');
if (process.version !== 'v8.9.4') throw new Error(`source runner requires Node v8.9.4, got ${process.version}`);

function verifyProvenance(root, side) {
  let raw;
  try { raw = fs.readFileSync(PROVENANCE_PATH); }
  catch (error) { throw new Error(`cannot read provenance manifest: ${error.message}`); }
  if (sha(raw) !== PROVENANCE_MANIFEST_SHA256) throw new Error('provenance manifest hash mismatch');
  let manifest;
  try { manifest = JSON.parse(raw.toString('utf8')); }
  catch (error) { throw new Error(`malformed provenance manifest: ${error.message}`); }
  if (manifest.schema !== 's11-settings-provenance-v1') throw new Error('unsupported provenance manifest schema');
  if (manifest.sourceRevision !== SOURCE_REVISION) throw new Error('provenance source revision mismatch');
  const entries = manifest[side] && manifest[side].files;
  if (!Array.isArray(entries) || !entries.length) throw new Error(`provenance ${side} file list missing`);
  const rootPath = path.resolve(root);
  entries.forEach((entry) => {
    if (!entry || typeof entry.path !== 'string' || !entry.path || path.isAbsolute(entry.path)
      || entry.path.split('/').indexOf('..') >= 0 || !/^[0-9a-f]{64}$/.test(entry.sha256 || '')) {
      throw new Error(`invalid provenance ${side} entry`);
    }
    const filePath = path.resolve(rootPath, entry.path);
    if (filePath !== rootPath && filePath.indexOf(`${rootPath}${path.sep}`) !== 0) {
      throw new Error(`provenance ${side} path escapes root: ${entry.path}`);
    }
    let actual;
    try { actual = sha(fs.readFileSync(filePath)); }
    catch (error) { throw new Error(`cannot read provenance ${side} file ${entry.path}: ${error.message}`); }
    if (actual !== entry.sha256) throw new Error(`provenance ${side} hash mismatch: ${entry.path}`);
  });
  return entries.length;
}

const provenanceFileCount = verifyProvenance(referenceRoot, 'source');

const RealDate = Date;
const FIXED_NOW = RealDate.parse(matrix.fixedNowISO);
global.Date = class FixtureDate extends RealDate {
  constructor() {
    const args = Array.prototype.slice.call(arguments);
    if (args.length) super(...args);
    else super(FIXED_NOW);
  }
  static now() { return FIXED_NOW; }
};

process.env.TZ = 'UTC';
process.env.prefsFromConfig = 'false';

const main = require(path.join(referenceRoot, 'packages/report-skill/lib/index.js'));
const envVars = require(path.join(referenceRoot, 'packages/report-skill/lib/EnvVars.js')).EnvVars;
const { SettingsClient } = main;

const expectedInventory = 'caac62ef04775f8cc02496adc7aaf626a7d33fba0e9cb8d53fd034be6b5e261a';
const expectedMatrixSemantic = '32739ae87fae1c0928d0acaa6db3ffe2230ac09187df1acacc2655beca39ae80';
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  Object.keys(value).sort().forEach((key) => { out[key] = stable(value[key]); });
  return out;
}
if (matrix.caseCount !== 43 || matrix.caseInventorySha256 !== expectedInventory
  || sha(JSON.stringify(matrix.cases.map((item) => item && item.id))) !== expectedInventory
  || sha(JSON.stringify(stable(matrix))) !== expectedMatrixSemantic) {
  throw new Error('unexpected S-11 settings case inventory pin');
}

function encode(value, seen) {
  if (value === undefined) return { $type: 'undefined' };
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return { $type: 'number', value: 'NaN' };
    if (value === Infinity) return { $type: 'number', value: 'Infinity' };
    if (value === -Infinity) return { $type: 'number', value: '-Infinity' };
    return value;
  }
  if (typeof value === 'bigint') return { $type: 'bigint', value: String(value) };
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof RealDate) return { $type: 'date', value: value.toISOString() };
  const stack = seen || [];
  if (stack.indexOf(value) >= 0) return { $type: 'cycle' };
  const next = stack.concat([value]);
  if (Array.isArray(value)) return value.map((entry) => encode(entry, next));
  const out = {};
  Object.keys(value).forEach((key) => { out[key] = encode(value[key], next); });
  return out;
}

function stableHeaders(headers) {
  const out = {};
  Object.keys(headers || {}).sort().forEach((key) => {
    const lower = key.toLowerCase();
    // These are generated by the HTTP stack and have no Settings contract.
    if (lower === 'date' || lower === 'connection' || lower === 'keep-alive' || lower === 'transfer-encoding') return;
    out[lower] = headers[key];
  });
  return out;
}

function requestRecord(req, sequence, rawBody) {
  const headers = {};
  Object.keys(req.headers || {}).sort().forEach((key) => {
    const lower = key.toLowerCase();
    headers[lower] = lower === 'host' ? '<peer>' : req.headers[key];
  });
  let parsedBody;
  try { parsedBody = rawBody === '' ? { $type: 'empty' } : encode(JSON.parse(rawBody)); }
  catch (error) { parsedBody = { $type: 'malformed', value: rawBody }; }
  return {
    sequence,
    method: req.method,
    path: req.url,
    headers,
    bodyRaw: rawBody,
    body: parsedBody,
  };
}

function settingsFixture() {
  return {
    weatherEnabled: { value: true },
    weather: { value: 0 },
    calendarEnabled: { value: true },
    commuteEnabled: { value: true },
    commuteType: { value: 0 },
    commuteTime: { hour: 9, min: 30 },
    homeLocation: { lat: 42.3134, lng: -71.1274 },
    workLocation: { lat: 42.3601, lng: -71.0589 },
    newsEnabled: { value: true },
    newsTechnology: { value: true },
    newsSports: { value: true },
    newsBusiness: { value: true },
    newsScience: { value: false },
    newsEntertainment: { value: false },
    newsStrange: { value: false },
    newsHealth: { value: false },
    newsInternational: { value: false },
    newsNational: { value: true },
    newsPolitics: { value: false },
    'google:personalCalendar:readonly': { credentialExists: true },
    'google:workCalendar:readonly': { credentialExists: false },
    'outlook:personalCalendar:readonly': { credentialExists: false },
    'outlook:workCalendar:readonly': { credentialExists: false },
  };
}

function deletePath(value, dotted) {
  const parts = dotted.split('.');
  let cursor = value;
  for (let i = 0; i < parts.length - 1; i += 1) cursor = cursor[parts[i]];
  delete cursor[parts[parts.length - 1]];
}

function numberValue(value) {
  if (!value || typeof value !== 'object') return value;
  if (value.number === 'NaN') return NaN;
  if (value.number === 'Infinity') return Infinity;
  if (value.number === '-Infinity') return -Infinity;
  return value;
}

function settingsForCase(item) {
  if (item.malformed === 'undefined') return undefined;
  if (item.malformed === 'null') return null;
  if (item.malformed === 'zero') return 0;
  if (item.malformed === 'partial') return { something: 'bad' };
  const settings = settingsFixture();
  if (item.mode && item.mode.missing) delete settings.commuteType;
  else if (Object.prototype.hasOwnProperty.call(item, 'mode')) settings.commuteType.value = numberValue(item.mode);
  if (item.missing) deletePath(settings, item.missing);
  if (item.boundary) {
    settings.commuteEnabled.value = 0;
    settings.commuteType.value = 0;
    settings.commuteTime.hour = item.boundary === 'out-of-range-time' ? 99 : 0;
    settings.commuteTime.min = item.boundary === 'out-of-range-time' ? -1 : 0;
    settings.homeLocation.lat = 0;
    settings.homeLocation.lng = 0;
    settings.workLocation.lat = 999;
    settings.workLocation.lng = -999;
  }
  return settings;
}

function responseBody(item) {
  const response = item.response || {};
  const body = Object.prototype.hasOwnProperty.call(response, 'body') ? response.body : 'fixture';
  if (body === 'fixture') return JSON.stringify([{ skillId: 'report-skill', data: settingsFixture() }]);
  if (body === 'missing-report') return JSON.stringify([{ skillId: 'other-skill', data: settingsFixture() }]);
  if (body === 'missing-data') return JSON.stringify([{ skillId: 'report-skill' }]);
  if (body === 'malformed-array') return '[';
  if (typeof body === 'string') return body;
  return JSON.stringify(body);
}

function errorSummary(error) {
  const response = error && error.response;
  return {
    name: error && error.name,
    message: error && error.message,
    code: encode(error && error.code),
    response: response ? {
      status: response.status,
      headers: stableHeaders(response.headers),
      data: encode(response.data),
    } : encode(undefined),
  };
}

function adultData(transId, speaker) {
  const isChild = speaker === 'child';
  const req = { jibo: {} };
  if (transId !== undefined) req.jibo.transID = transId;
  return {
    runtime: {
      perception: { speaker: 'speaker-1' },
      loop: {
        loopId: 'loop-1',
        users: [{
          id: 'speaker-1',
          accountId: 'account-1',
          birthdate: isChild ? RealDate.parse('2018-01-01T00:00:00.000Z') : RealDate.parse('1990-01-01T00:00:00.000Z'),
        }],
      },
      location: { iso: matrix.fixedNowISO },
    },
    req,
    log: makeLog(),
  };
}

function makeLog() {
  const log = {
    debug() {},
    info() {},
    warn() {},
    error() {},
    createChild() { return this; },
  };
  return log;
}

function createSettingsPeer(calls, getCase) {
  return http.createServer((req, res) => {
    let rawBody = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { rawBody += chunk; });
    req.on('end', () => {
      const record = requestRecord(req, calls.length, rawBody);
      const item = getCase();
      const response = item.response || {};
      const status = response.status === undefined ? 200 : response.status;
      const body = responseBody(item);
      record.responseStatus = status;
      record.responseHeaders = {
        'content-length': String(Buffer.byteLength(body)),
        'content-type': response.contentType || 'application/json',
        'x-s11-settings-case': item.id,
      };
      record.responseBodyRaw = body;
      calls.push(record);
      res.writeHead(status, {
        'content-type': response.contentType || 'application/json',
        'content-length': Buffer.byteLength(body),
        'x-s11-settings-case': item.id,
      });
      res.end(body);
    });
  });
}

async function runCase(item, calls) {
  let transId;
  if (item.transId && item.transId.missing) transId = undefined;
  else if (Object.prototype.hasOwnProperty.call(item, 'transId')) transId = item.transId;
  const kind = item.kind;
  try {
    let value;
    if (kind === 'convert') {
      value = await SettingsClient.convertSettingsToPrefs(settingsForCase(item));
    } else if (kind === 'prefs') {
      if (item.speaker === 'none') value = await SettingsClient.getUserPrefs({ log: makeLog() });
      else if (item.speaker === 'notInLoop') value = await SettingsClient.getUserPrefs(adultData('trans-default', 'adult'), 'notInLoop');
      else value = await SettingsClient.getUserPrefs(adultData('trans-child', 'child'), 'speaker-1');
    } else if (kind === 'http-prefs') {
      value = await SettingsClient.getUserPrefs(adultData(transId, 'adult'), 'speaker-1');
    } else if (kind === 'get-settings') {
      value = await SettingsClient.getSettings(item.accountId, item.loopId, item.transId);
    } else {
      throw new Error(`unknown case kind ${kind}`);
    }
    return { id: item.id, kind, ok: true, value: encode(value), error: encode(undefined), requests: encode(calls) };
  } catch (error) {
    return { id: item.id, kind, ok: false, value: encode(undefined), error: errorSummary(error), requests: encode(calls) };
  }
}

async function mainRunner() {
  const calls = [];
  let currentCase = null;
  const peer = createSettingsPeer(calls, () => currentCase);
  await new Promise((resolve, reject) => {
    peer.once('error', reject);
    peer.listen(0, '127.0.0.1', resolve);
  });
  const peerBase = `127.0.0.1:${peer.address().port}`;
  process.env.NET_settings = peerBase;
  envVars.clearCache();
  const rows = [];
  try {
    for (let i = 0; i < matrix.cases.length; i += 1) {
      currentCase = matrix.cases[i];
      calls.length = 0;
      rows.push(await runCase(currentCase, calls));
    }
  } finally {
    await new Promise((resolve) => peer.close(resolve));
  }
  const result = {
    schema: 's11-settings-http-receipt-v1',
    mode: 'source',
    sourceRevision: SOURCE_REVISION,
    sourceImage: matrix.sourceImage,
    sourceImageDigest: matrix.sourceImageDigest,
    network: 'none',
    runtime: process.version,
    fixedNowISO: matrix.fixedNowISO,
    matrixSha256: sha(fs.readFileSync(matrixPath)),
    provenanceManifestSha256: PROVENANCE_MANIFEST_SHA256,
    provenanceSide: 'source',
    provenanceFileCount,
    caseCount: matrix.cases.length,
    caseInventorySha256: expectedInventory,
    matrixSemanticSha256: expectedMatrixSemantic,
    runnerSha256: sha(fs.readFileSync(__filename)),
    rows,
  };
  const outputDir = path.dirname(outputPath);
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(JSON.stringify({ mode: result.mode, rows: rows.length, requests: rows.reduce((sum, row) => sum + row.requests.length, 0) }) + '\n');
}

mainRunner().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
