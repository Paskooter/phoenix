#!/usr/bin/env node
// Candidate-side twin of c03-report-client-source.cjs. It uses the same logical
// fixture and recording peer so source/candidate request differences remain visible.

import http from 'node:http';
import { clearReportEnvCache } from '../src/report/env.js';
import { LassoClient } from '../src/report/lassoClient.js';
import { SettingsClient } from '../src/report/settingsClient.js';

const requests = [];
const server = http.createServer((request, response) => {
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    requests.push({
      method: request.method,
      url: request.url,
      headers: {
        'content-type': request.headers['content-type'],
        'x-amz-credentials': request.headers['x-amz-credentials'],
        'x-amz-target': request.headers['x-amz-target'],
        'x-jibo-transid': request.headers['x-jibo-transid'],
        'x-jibo-robotid': request.headers['x-jibo-robotid'],
        'x-jibo-logging-config': request.headers['x-jibo-logging-config'],
        'user-agent': request.headers['user-agent'],
      },
      body: Buffer.concat(chunks).toString('utf8'),
    });
    response.setHeader('content-type', 'application/json');
    if (request.url.startsWith('/v1/dark_sky')) {
      response.end(JSON.stringify({ relayData: { currently: { temperature: 71 } } }));
    } else if (request.method === 'POST') {
      response.end(JSON.stringify([{ skillId: 'report-skill', data: { weatherEnabled: { value: true } } }]));
    } else {
      response.end(JSON.stringify({ relayData: null }));
    }
  });
});

const data = {
  runtime: {
    location: { lat: 42.36, lng: -71.06 },
    perception: { speaker: 'speaker-1' },
    loop: { loopId: 'loop-1', users: [{ id: 'speaker-1', accountId: 'account-1' }] },
  },
  skill: { id: 'report-skill' },
  req: {
    jibo: {
      transID: 'trans-1',
      robotID: 'robot-1',
      loggingConfig: '{"report":"debug"}',
      toHeader() {
        return {
          'x-jibo-transid': this.transID,
          'x-jibo-robotid': this.robotID,
          'x-jibo-logging-config': this.loggingConfig,
        };
      },
    },
  },
};

const listen = () => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const close = () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));

await listen();
const port = server.address().port;
process.env.NET_lasso = `127.0.0.1:${port}`;
process.env.NET_settings = `127.0.0.1:${port}`;
delete process.env.NET_data;
clearReportEnvCache();

try {
  const darkSky = await LassoClient.fetchDarkSky(data);
  const settings = await SettingsClient.getSettings('account-1', 'loop-1', 'trans-1');
  console.log(JSON.stringify({
    runtime: process.version,
    darkSky,
    settings,
    requests,
  }));
} finally {
  await close();
  clearReportEnvCache();
}
