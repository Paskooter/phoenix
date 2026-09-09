'use strict';
// C-01 root verification, ORIGINAL side.
//
// Reproduces the pinned source shared HTTP boundary from
// jiboV2/pegasus@5c0a739 packages/utils/src/service/BaseService.ts, then
// records raw wire results for the C-01 acceptance dimensions the earlier
// bounded review did NOT cover: handler errors, unknown routes, trailing
// slashes, HTTP methods, content types and response headers.
//
// The JSON-body dimension is already covered by the accepted 317-case review
// and is deliberately not repeated here.
//
// Source contract being mirrored (BaseService.setupExpress / start):
//   app.use(bodyParser.urlencoded({ extended: true }))
//   app.get('/healthcheck', ...)          -> registered BEFORE bodyParser.json()
//   app.use(bodyParser.json())
//   ... routers ...
//   app.use((req,res,next) => next(new HttpError(`URL not found: ${req.path}`, 404)))
//   app.use((err,req,res,next) => res.status(err.statusCode || 500).json(buildErrorMessage(err)))
//
// buildErrorMessage returns:
//   { type: 'ERROR', msgID: <uuid>, ts: <now>, final: true, data: { message } }
// msgID and ts are nondeterministic and are normalised out by the comparator.

const fs = require('fs');
const http = require('http');
const express = require('/reference/node_modules/express');
const bodyParser = require('/reference/node_modules/body-parser');

// Mirrors utils/src/http HttpError: an Error carrying a statusCode.
function HttpError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function buildErrorMessage(error) {
  return {
    type: 'ERROR',
    msgID: '00000000-0000-0000-0000-000000000000', // normalised
    ts: 0,                                          // normalised
    final: true,
    data: { message: error && error.message ? error.message : String(error) },
  };
}

const app = express();
app.use(bodyParser.urlencoded({ extended: true }));
// Source BaseService.getHealthcheckResponse returns { statusCode: 200, body: 'ok' }
// — lowercase. Verified at jiboV2/pegasus@5c0a739
// packages/utils/src/service/BaseService.ts. An earlier draft of this harness
// used 'OK' and produced two false differences against Phoenix; Phoenix was
// right and the harness was wrong.
app.get('/healthcheck', (req, res) => res.status(200).send('ok'));
app.use(bodyParser.json());

// A representative router, matching BaseHttpHandler's add*Handler surface.
const router = express.Router();
router.get('/echo', (req, res) => res.json({ value: req.query }));
router.post('/echo', (req, res) => res.json({ value: req.body }));
router.put('/echo', (req, res) => res.json({ value: req.body }));
router.delete('/echo', (req, res) => res.json({ value: req.body }));
// A handler that throws, to exercise the error path with no statusCode.
router.post('/throws', () => { throw new Error('handler exploded'); });
// A handler that rejects with an explicit statusCode.
router.post('/throws-coded', (req, res, next) => next(HttpError('teapot', 418)));
app.use('/', router);

app.use((req, res, next) => next(HttpError('URL not found: ' + req.path, 404)));
app.use((err, req, res, next) => res.status(err.statusCode || 500).json(buildErrorMessage(err)));

const CASES = JSON.parse(fs.readFileSync('/review/boundary-cases.json'));

function once(port, testCase) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (testCase.contentType) headers['content-type'] = testCase.contentType;
    const payload = testCase.body === undefined || testCase.body === null
      ? null : Buffer.from(testCase.body);
    if (payload) headers['content-length'] = payload.length;
    const request = http.request(
      { port: port, path: testCase.path, method: testCase.method, headers: headers },
      (res) => {
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => resolve({
          id: testCase.id,
          method: testCase.method,
          path: testCase.path,
          contentType: testCase.contentType || null,
          body: testCase.body === undefined ? null : testCase.body,
          status: res.statusCode,
          headers: {
            'content-type': res.headers['content-type'] || null,
            'content-length': res.headers['content-length'] || null,
            allow: res.headers.allow || null,
            'x-powered-by': res.headers['x-powered-by'] || null,
          },
          raw: Buffer.concat(chunks).toString('utf8'),
        }));
      });
    request.on('error', reject);
    if (payload) request.end(payload); else request.end();
  });
}

const server = app.listen(0, async () => {
  const port = server.address().port;
  const results = [];
  try {
    for (const testCase of CASES) results.push(await once(port, testCase));
    fs.writeFileSync('/review/original-boundary.json', JSON.stringify(results, null, 2));
    console.log(JSON.stringify({ cases: results.length, runtime: process.version }));
  } catch (error) {
    console.error(error && error.stack || error);
    process.exitCode = 1;
  } finally {
    server.close();
  }
});
