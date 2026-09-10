// Reference HTTP-boundary oracle for I-01.
//
// Rebuilds the EXACT middleware/routing stack of the pinned Pegasus BaseService using the
// pinned tree's OWN express@4.16.2 + body-parser@1.18.2, then drives it over real HTTP.
// This answers "what does the reference do at the HTTP layer" without needing Mongo.
//
// Source lines reproduced (pinned 5c0a739...):
//   packages/utils/src/service/BaseService.ts:121  app.use(bodyParser.urlencoded({extended:true}))
//   packages/utils/src/service/BaseService.ts:123  app.get('/healthcheck', ...)
//   packages/utils/src/service/BaseService.ts:128  app.use(bodyParser.json())
//   packages/utils/src/service/BaseService.ts:142  addHttpHandler(path, handler) -> app.use(path, router)
//   packages/utils/src/service/BaseService.ts:315  404: next(new HttpError(`URL not found: ${req.path}`, 404))
//   packages/utils/src/service/BaseService.ts:319  error: res.status(err.statusCode||500).json(error)
//   packages/utils/src/service/handlers/BaseHttpHandler.ts:48-80  router.get/post/put -> 200
//
// LIMIT: this is a reconstruction of the middleware chain, not the original compiled service
// (HistoryService requires a live Mongo). Handler bodies that dereference req.body mimic the
// reference handler's first property access, so the thrown TypeError is the same one.
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const REF = '/home/shell/work/phoenix/.parity/reference/5c0a7390539663ba749d360de348a428c088505c';
const require = createRequire(REF + '/');
const express = require('express');
const bodyParser = require('body-parser');

const expressVersion = require('express/package.json').version;
const bodyParserVersion = require('body-parser/package.json').version;

const app = express();
app.use(bodyParser.urlencoded({ extended: true }));
app.get('/healthcheck', (_req, res) => res.status(200).send('ok'));
app.use(bodyParser.json());

const launch = express.Router();
// saveSkillLaunch: data.timestamp = data.timestamp || Date.now()  (first deref of req.body)
launch.post('/', (req, res, next) => {
  Promise.resolve().then(() => { req.body.timestamp = req.body.timestamp || Date.now(); return { echo: req.body }; })
    .then((r) => res.status(200).json(r)).catch(next);
});
launch.put('/payload', (req, res, next) => {
  Promise.resolve().then(() => { req.body.timestamp = req.body.timestamp || Date.now(); return { echo: req.body }; })
    .then((r) => res.status(200).json(r)).catch(next);
});
launch.get('/latest', (req, res, next) => {
  Promise.resolve().then(() => { if (!req.query.robotID) throw new Error('child "robotID" fails because ["robotID" is required]'); return { q: req.query }; })
    .then((r) => res.status(200).json(r)).catch(next);
});
launch.post('/latest', (req, res, next) => {
  Promise.resolve().then(() => { if (!req.body.robotID) throw new Error('child "robotID" fails because ["robotID" is required]'); return { q: req.body }; })
    .then((r) => res.status(200).json(r)).catch(next);
});
launch.get('/count', (req, res, next) => {
  Promise.resolve().then(() => { if (!req.query.robotID) throw new Error('child "robotID" fails because ["robotID" is required]'); return { count: 0 }; })
    .then((r) => res.status(200).json(r)).catch(next);
});
launch.post('/count', (req, res, next) => {
  Promise.resolve().then(() => { if (!req.body.robotID) throw new Error('child "robotID" fails because ["robotID" is required]'); return { count: 0 }; })
    .then((r) => res.status(200).json(r)).catch(next);
});
app.use('/v1/skill/launch', launch);

const speech = express.Router();
speech.post('/', (req, res, next) => {
  Promise.resolve().then(() => { req.body.timestamp = req.body.timestamp || Date.now(); return { id: 'id-1' }; })
    .then((r) => res.status(200).json(r)).catch(next);
});
speech.put('/:id', (req, res, next) => {
  // SpeechHistoryRecordsCollection.updateRecord: first deref is data.audioFileURL
  Promise.resolve().then(() => { const update = { audioFileURL: undefined }; update.audioFileURL = req.body.audioFileURL; return { id: req.params.id }; })
    .then((r) => res.status(200).json(r)).catch(next);
});
app.use('/v1/speech', speech);

app.use((req, _res, next) => {
  const e = new Error(`URL not found: ${req.path}`);
  e.statusCode = 404;
  next(e);
});
app.use((err, _req, res, _next) => {
  res.status(err.statusCode || 500).json({ type: 'ERROR', msgID: 'x', ts: 0, final: true, data: { message: err.message } });
});

const server = app.listen(0);
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;

async function probe(method, path, { body, query, headers, raw } = {}) {
  const url = query ? `${base}${path}?${query}` : `${base}${path}`;
  const h = { ...(headers || {}) };
  let payload;
  if (raw !== undefined) payload = raw;
  else if (body !== undefined) { payload = JSON.stringify(body); h['content-type'] = 'application/json'; }
  const res = await fetch(url, { method, headers: h, body: payload });
  const text = await res.text();
  let json = null; try { json = text === '' ? null : JSON.parse(text); } catch { json = text; }
  return { method, path: path + (query ? `?${query}` : ''), status: res.status, contentType: res.headers.get('content-type'), body: json };
}

const out = [];
const rec = async (label, ...a) => out.push({ label, ...(await probe(...a)) });

await rec('POST /v1/skill/launch empty body, no content-type', 'POST', '/v1/skill/launch', {});
await rec('POST /v1/skill/launch empty body, application/json', 'POST', '/v1/skill/launch', { raw: '', headers: { 'content-type': 'application/json' } });
await rec('POST /v1/skill/launch text/plain body', 'POST', '/v1/skill/launch', { raw: 'hello', headers: { 'content-type': 'text/plain' } });
await rec('POST /v1/skill/launch JSON {}', 'POST', '/v1/skill/launch', { body: {} });
await rec('PUT /v1/skill/launch/payload empty body', 'PUT', '/v1/skill/launch/payload', {});
await rec('POST /v1/skill/launch/latest empty body', 'POST', '/v1/skill/launch/latest', {});
await rec('POST /v1/skill/launch/latest JSON {}', 'POST', '/v1/skill/launch/latest', { body: {} });
await rec('GET /v1/skill/launch/latest no query', 'GET', '/v1/skill/launch/latest', {});
await rec('POST /v1/skill/launch/count empty body', 'POST', '/v1/skill/launch/count', {});
await rec('POST /v1/speech empty body', 'POST', '/v1/speech', {});
await rec('PUT /v1/speech/:id empty body no content-type', 'PUT', '/v1/speech/abc', {});
await rec('PUT /v1/speech/:id empty body text/plain', 'PUT', '/v1/speech/abc', { raw: '', headers: { 'content-type': 'text/plain' } });
await rec('PUT /v1/speech/:id JSON {}', 'PUT', '/v1/speech/abc', { body: {} });
await rec('GET /healthcheck', 'GET', '/healthcheck', {});
await rec('GET unknown route', 'GET', '/v1/skill/launch/does-not-exist', {});
await rec('DELETE on known path', 'DELETE', '/v1/skill/launch/latest', {});
await rec('POST trailing slash', 'POST', '/v1/skill/launch/', { body: {} });
await rec('GET case-insensitive', 'GET', '/V1/SKILL/LAUNCH/count', { query: 'robotID=r' });
await rec('HEAD /v1/skill/launch/count with robotID', 'HEAD', '/v1/skill/launch/count', { query: 'robotID=r' });
await rec('GET /v1/skill/launch/count with robotID', 'GET', '/v1/skill/launch/count', { query: 'robotID=r' });
await rec('GET /skill/launch/count bare (reference 404?)', 'GET', '/skill/launch/count', { query: 'robotID=r' });

server.close();
const result = { express: expressVersion, bodyParser: bodyParserVersion, cases: out };
console.log(JSON.stringify(result, null, 2));
writeFileSync(process.argv[2] || 'reference-http-oracle.json', JSON.stringify(result, null, 2));
