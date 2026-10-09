// Offline checks for the authenticated robot launcher. Every stack here binds
// loopback ephemeral ports with a synthetic secret, synthetic account store and
// a one-day self-signed certificate; nothing contacts a robot or a server.
// Each run is a child process because service modules read process.env at
// import time.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(new URL('../..', import.meta.url).pathname);

const DRIVER = `
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startAuthenticatedRobotStack } from './scripts/parity-robot/authenticated-stack.mjs';

const directory = mkdtempSync(join(tmpdir(), 'phoenix-authenticated-stack-test-'));
const runDir = join(directory, 'run');
mkdirSync(runDir, { mode: 0o700 });
const secretFile = join(directory, 'secret');
const storeFile = join(directory, 'account.json');
const keyFile = join(directory, 'key.pem');
const certFile = join(directory, 'cert.pem');
writeFileSync(secretFile, 'synthetic-launcher-test-secret\\n', { mode: 0o600 });
const account = { _id: 'synthetic-robot', email: 'synthetic@fixture.test', friendlyId: 'synthetic',
  accessKeyId: 'SYNTHETIC-LAUNCHER-KEY', secretAccessKey: 'synthetic-launcher-secret', isActive: true, isDeleted: false };
writeFileSync(storeFile, JSON.stringify({ accounts: [account], loops: [], tokens: [], sessions: [], settings: [], notificationOutbox: [] }), { mode: 0o600 });
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-keyout', keyFile, '-out', certFile, '-days', '1', '-nodes',
  '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' });
chmodSync(keyFile, 0o600);

const result = {};
let stack;
try {
  stack = await startAuthenticatedRobotStack({
    runDir, secretFile, storeFile, keyFile, certFile,
    basePort: 0, entrypointPort: 0, entrypointHost: '127.0.0.1', accountHost: '127.0.0.1',
    publicUrl: process.env.TEST_PUBLIC_URL,
  });
  const port = stack.receipt.endpoints.entrypointTls;
  // A forged SigV4 header: a real access key id with a signature nobody computed.
  const forged = 'AWS4-HMAC-SHA256 Credential=SYNTHETIC-LAUNCHER-KEY/20260101/global/jibo/aws4_request, SignedHeaders=host, Signature=' + '0'.repeat(64);
  result.forged = await new Promise((resolve, reject) => {
    const request = https.request({ host: '127.0.0.1', port, path: '/push/devices', method: 'GET',
      headers: { host: 'localhost', authorization: forged }, ca: readFileSync(certFile), servername: 'localhost' }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('error', reject);
    request.setTimeout(5000, () => request.destroy(new Error('deadline')));
    request.end();
  });
} catch (error) {
  result.error = error.message;
} finally {
  await stack?.stop();
  rmSync(directory, { recursive: true, force: true });
}
process.stdout.write(JSON.stringify(result));
process.exit(0);
`;

function runDriver(env) {
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', DRIVER], {
    cwd: root,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, PHOENIX_ENV_FILE: '/dev/null', ...env },
    encoding: 'utf8',
    timeout: 90_000,
  });
  assert.equal(child.status, 0, child.stderr);
  const lines = child.stdout.trim().split('\n');
  return JSON.parse(lines[lines.length - 1]);
}

test('the authenticated stack installs the verified Classic caller boundary', () => {
  const result = runDriver({ TEST_PUBLIC_URL: 'https://localhost' });
  assert.equal(result.error, undefined);
  // Without the boundary the push sidecar trusted the unverified Credential
  // scope and answered 200 with that account's devices.
  assert.notEqual(result.forged.status, 200, result.forged.body);
  assert.ok([401, 403].includes(result.forged.status), `${result.forged.status} ${result.forged.body}`);
});

test('the authenticated stack rejects a public URL that is not a bare origin before listening', () => {
  const result = runDriver({ TEST_PUBLIC_URL: 'https://localhost/bearer-prefix?x=1' });
  assert.match(result.error || '', /publicUrl/);
  assert.equal(result.forged, undefined);
});
