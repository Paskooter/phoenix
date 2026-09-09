// C-01 root verification, PHOENIX side.
//
// Drives the same 47 boundary cases as original-boundary.cjs against
// packages/common/src/service.js, so the two captures can be compared field by
// field. Routes mirror the reference router in original-boundary.cjs.
//
// Usage: node phoenix-boundary.mjs <repo-root> <out.json>

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import http from 'node:http';

const repoRoot = process.argv[2] || '/home/shell/work/phoenix';
const outPath = process.argv[3] || new URL('./phoenix-boundary.json', import.meta.url).pathname;
const here = new URL('.', import.meta.url).pathname;

const { createService } = await import(resolve(repoRoot, 'packages/common/src/service.js'));

const service = createService({
  name: 'c01-boundary-root',
  routes: {
    'GET /echo': ({ query }) => ({ value: query ?? {} }),
    'POST /echo': ({ body }) => ({ value: body }),
    'PUT /echo': ({ body }) => ({ value: body }),
    'DELETE /echo': ({ body }) => ({ value: body }),
    'POST /throws': () => { throw new Error('handler exploded'); },
    'POST /throws-coded': () => {
      const error = new Error('teapot');
      error.statusCode = 418;
      throw error;
    },
  },
});

const server = await service.listen(0);
const port = server.address().port;
const cases = JSON.parse(readFileSync(resolve(here, 'boundary-cases.json')));

function once(testCase) {
  return new Promise((resolvePromise, reject) => {
    const headers = {};
    if (testCase.contentType) headers['content-type'] = testCase.contentType;
    const payload = testCase.body === undefined || testCase.body === null
      ? null : Buffer.from(testCase.body);
    if (payload) headers['content-length'] = payload.length;
    const request = http.request(
      { port, path: testCase.path, method: testCase.method, headers },
      (res) => {
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => resolvePromise({
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

const results = [];
try {
  for (const testCase of cases) results.push(await once(testCase));
  writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(JSON.stringify({ cases: results.length, runtime: process.version }));
} finally {
  await new Promise((done) => server.close(done));
}
