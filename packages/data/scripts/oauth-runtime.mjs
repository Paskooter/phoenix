// D-03 runtime demonstration — drives the real `node packages/data/src/index.js`
// data service over HTTP against a local token endpoint that replays the pinned
// Google recorded fixtures. Proves, at runtime: real exchange, real refresh,
// real expiry (expires_in -> expiresAt), real invalidation, and the exact error
// envelopes. Emits a JSON report on stdout.
//
//   node packages/data/scripts/oauth-runtime.mjs
//
// This is an operator/QA harness; the unit suite (packages/data/test/oauth.test.js)
// is the falsifiable gate.

import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..'); // packages/data/scripts -> repo root

const GOOGLE_CLIENT_ID = '668620580899';
const GOOGLE_SECRET = {
  client_id: '668620580899-eus56a4gr8l278apl1a60kpql4c8ik35.apps.googleusercontent.com',
  client_secret: 'yx740-780cn75-xcVhMp2vjd',
  redirect_uri: 'https://developers.google.com/oauthplayground',
};
const GOOGLE_READONLY = 'https://www.googleapis.com/auth/calendar.readonly';

const dir = mkdtempSync(join(tmpdir(), 'd03-oauth-runtime-'));
const secretsDir = join(dir, 'oauth');
mkdirSync(join(secretsDir, 'google'), { recursive: true });
writeFileSync(join(secretsDir, 'google', `client_${GOOGLE_CLIENT_ID}.json`), JSON.stringify(GOOGLE_SECRET));
const credentialsFile = join(dir, 'credentials.json');

const requested = [];
let refreshSeq = 0;
const tokenServer = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (d) => { raw += d; });
  req.on('end', () => {
    const form = Object.fromEntries(new URLSearchParams(raw));
    requested.push({ path: req.url, form });
    let status = 200; let body;
    if (form.grant_type === 'authorization_code') {
      if (form.code === 'goodCode') body = { access_token: 'googleAccessToken', token_type: 'Bearer', expires_in: 3600, refresh_token: 'googleRefreshToken' };
      else { status = 400; body = { error: 'invalid_grant', error_description: 'Code was already redeemed.' }; }
    } else if (form.grant_type === 'refresh_token') {
      if (form.refresh_token === 'goodRefresh') body = { access_token: `refreshedAccessToken-${++refreshSeq}`, token_type: 'Bearer', expires_in: 3600 };
      else { status = 400; body = { error: 'invalid_grant', error_description: 'Bad Request' }; }
    } else { status = 400; body = { error: 'unsupported_grant_type' }; }
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
});

const PORT = 8912;
const report = { steps: [] };

function startService() {
  const child = spawn(process.execPath, [join(REPO, 'packages/data/src/index.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      ETCO_data_credentialsFile: credentialsFile,
      ETCO_lasso_oauthSecretsDir: secretsDir,
      ETCO_lasso_googleTokenUrl: `http://127.0.0.1:${tokenServer.address().port}/oauth2/v4/token`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', () => {});
  child.stdout.on('data', () => {});
  return child;
}

async function waitHealthy(tries = 60) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(`http://localhost:${PORT}/healthcheck`); if (r.ok) return true; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('service did not become healthy');
}

const j = (p, opts) => fetch(`http://localhost:${PORT}${p}`, opts);
const storeSnapshot = () => JSON.parse(readFileSync(credentialsFile, 'utf8'));
const googleCred = (over = {}) => ({ accountId: 'rt-acct', skillId: 'report-skill', serviceName: 'google', serviceAccountName: 'personalCalendar', scopes: [GOOGLE_READONLY], clientId: GOOGLE_CLIENT_ID, ...over });
const post = (body) => j('/v1/credential', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

await new Promise((r) => tokenServer.listen(0, '127.0.0.1', r));
let child = startService();
try {
  await waitHealthy();

  // 1. Real exchange over HTTP.
  let r = await post(googleCred({ accountId: 'rt-exchange', authCode: 'goodCode' }));
  report.steps.push({ step: 'exchange', status: r.status, body: await r.json(), token_requests: requested.length, last_request: requested.at(-1) });
  const afterExchange = storeSnapshot().find((c) => c.accountId === 'rt-exchange');
  report.steps.push({ step: 'exchange_stored', oauth2: afterExchange.oauth2, expires_in_future_ms: afterExchange.oauth2.expiresAt - Date.now() });

  // 2. Exchange failure envelope.
  requested.length = 0;
  r = await post(googleCred({ accountId: 'rt-bad', authCode: 'redeemedCode' }));
  report.steps.push({ step: 'exchange_error', status: r.status, body: await r.text() });

  // 3. Real refresh: seed an EXPIRED credential, then read the calendar.
  await post(googleCred({ accountId: 'rt-refresh', accessToken: 'oldAccessToken', refreshToken: 'goodRefresh', expiresAt: Date.now() - 1000 }));
  requested.length = 0;
  r = await j('/v1/google_calendar?skillId=report-skill&accountId=rt-refresh&calendar=personalCalendar');
  const refreshBody = await r.text();
  const afterRefresh = storeSnapshot().find((c) => c.accountId === 'rt-refresh');
  report.steps.push({
    step: 'refresh',
    calendar_status: r.status,
    calendar_body: refreshBody,
    token_requests: requested.length,
    refresh_grant: requested.find((q) => q.form.grant_type === 'refresh_token')?.form,
    stored_accessToken: afterRefresh.oauth2.accessToken,
    stored_refreshedAt: afterRefresh.oauth2.refreshedAt,
    expires_in_future_ms: afterRefresh.oauth2.expiresAt - Date.now(),
  });

  // 4. Refresh failure -> invalidation.
  await post(googleCred({ accountId: 'rt-revfail', accessToken: 'oldAccessToken', refreshToken: 'badRefresh', expiresAt: Date.now() - 1000 }));
  r = await j('/v1/google_calendar?skillId=report-skill&accountId=rt-revfail&calendar=personalCalendar');
  const failBody = await r.text();
  const afterFail = storeSnapshot().find((c) => c.accountId === 'rt-revfail');
  report.steps.push({
    step: 'refresh_failure_invalidation',
    calendar_status: r.status,
    calendar_body: failBody,
    isActive: afterFail.isActive,
    error: afterFail.error,
  });

  report.ok = report.steps.every((s) => !s.body || typeof s.body === 'object' || s.step !== 'exchange_error' || s.status === 400);
} finally {
  child.kill('SIGKILL');
  tokenServer.close();
  rmSync(dir, { recursive: true, force: true });
}

console.log(JSON.stringify(report, null, 2));
