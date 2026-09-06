#!/usr/bin/env node
// Execute the pinned Pegasus report clients against a local recording peer.
// Run in the pinned Node 8 image with C03_REPORT_SOURCE set to the frozen source root.

const http = require('http');
const path = require('path');

const sourceRoot = process.env.C03_REPORT_SOURCE;
if (!sourceRoot) {
  console.error('C03_REPORT_SOURCE is required');
  process.exit(2);
}

const { EnvVars } = require(path.join(sourceRoot, 'packages/report-skill/lib/EnvVars'));
const { LassoClient } = require(path.join(sourceRoot, 'packages/report-skill/lib/LassoClient'));
const { SettingsClient } = require(path.join(sourceRoot, 'packages/report-skill/lib/SettingsClient'));

const requests = [];
const server = http.createServer((request, response) => {
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    requests.push({
      method: request.method,
      url: request.url,
      headers: {
        'content-type': request.headers['content-type'],
        'x-amz-credentials': request.headers['x-amz-credentials'],
        'x-amz-target': request.headers['x-amz-target'],
        'x-source-header': request.headers['x-source-header'],
      },
      body,
    });
    response.setHeader('content-type', 'application/json');
    if (request.url.indexOf('/v1/dark_sky') === 0) {
      response.end(JSON.stringify({ relayData: { currently: { temperature: 71 } } }));
    } else if (request.method === 'POST') {
      response.end(JSON.stringify([{ skillId: 'report-skill', data: { weatherEnabled: { value: true } } }]));
    } else {
      response.end(JSON.stringify({ relayData: null }));
    }
  });
});

const log = {
  createChild() { return this; },
  debug() {},
  info() {},
  warn() {},
  error() {},
};

const data = {
  log,
  runtime: {
    location: { lat: 42.36, lng: -71.06 },
    perception: { speaker: 'speaker-1' },
    loop: { loopId: 'loop-1', users: [{ id: 'speaker-1', accountId: 'account-1' }] },
  },
  skill: { id: 'report-skill' },
  req: {
    jibo: {
      transID: 'trans-1',
      toHeader() { return { 'x-source-header': 'source-fixture' }; },
    },
  },
};

function listen() {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
}

function close() {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

(async () => {
  await listen();
  const port = server.address().port;
  process.env.NET_lasso = `127.0.0.1:${port}`;
  process.env.NET_settings = `127.0.0.1:${port}`;
  delete process.env.NET_data;
  EnvVars.clearCache();

  const darkSky = await LassoClient.fetchDarkSky(data);
  const settings = await SettingsClient.getSettings('account-1', 'loop-1', 'trans-1');
  const result = {
    sourceRoot,
    runtime: process.version,
    sourceFiles: {
      lasso: path.join(sourceRoot, 'packages/report-skill/lib/LassoClient.js'),
      settings: path.join(sourceRoot, 'packages/report-skill/lib/SettingsClient.js'),
    },
    darkSky,
    settings,
    requests,
  };
  await close();
  EnvVars.clearCache();
  console.log(JSON.stringify(result));
})().catch(async (error) => {
  try { await close(); } catch (_) { /* preserve original failure */ }
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
