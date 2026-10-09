// Shared helpers for Classic tests that talk to an AUTHENTICATED Classic face.
//
// Since 07178e2 ("security: harden public service boundaries") the executable Classic
// entrypoint (`packages/classic/src/index.js` start()) always installs the SigV4 caller
// boundary, resolves robot signing keys from an Account store snapshot named by
// `ETCO_classic_accountDataFile` / `ETCO_account_dataFile`, and refuses to start without a
// configured public origin (`ETCO_classic_publicUrl`). Private Classic -> Account peer
// calls carry `x-phoenix-internal-token` = `ETCO_account_internalPeerToken`.
//
// Everything here is SYNTHETIC test data: invented account ids, access keys, secrets and
// peer tokens that are only ever used inside a test process. Nothing resembles a real
// household, person or credential.
//
// This module has no top-level side effects (the default `node --test` glob loads every
// file under test/), so importing it never mutates process.env or the filesystem.

import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { signSigV4 } from '@phoenix/common';
import { Store as AccountStore } from '../../../account/src/store.js';
import { createVerifiedClassicCaller } from '../../src/caller.js';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
export const CLASSIC_ENTRY = join(ROOT, 'packages', 'classic', 'src', 'index.js');

/** An invented, test-only shared secret for the private Account peer hop. */
export const SYNTHETIC_PEER_TOKEN = 'synthetic-classic-test-internal-peer-token';
/** Header name Account's internal peer routes check. */
export const INTERNAL_PEER_HEADER = 'x-phoenix-internal-token';
/** Test-only signing region; the verifier accepts any region named in the credential scope. */
export const SYNTHETIC_REGION = 'synthetic-test-region';

/**
 * A synthetic Account-store record that can sign Classic requests.
 * `id` is the Account `_id` (the identity Classic handlers see after verification);
 * `accessKeyId` defaults to a value distinct from the id, like a real Account.
 */
export function syntheticAccount(id, { accessKeyId = `AKSYNTH-${id}`, secretAccessKey, friendlyId, ...extra } = {}) {
  return {
    _id: id,
    email: null,
    friendlyId: friendlyId === undefined ? `synthetic-${id}` : friendlyId,
    accessKeyId,
    secretAccessKey: secretAccessKey || `synthetic-secret-for-${id}`,
    isActive: true,
    isDeleted: false,
    ...extra,
  };
}

/**
 * Write a synthetic Account store snapshot (the same file format and class Account uses) and
 * return the open Store. `loops` are full loop records (`_id`, `robot`, `owner`, `members`).
 */
export function writeSyntheticAccountStore(file, { accounts = [], loops = [] } = {}) {
  const store = new AccountStore(file);
  for (const account of accounts) store.accounts.set(account._id, { ...account });
  for (const loop of loops) store.loops.set(loop._id, { ...loop });
  store.flush();
  return store;
}

/**
 * The production credential resolver shape (`index.js` productionCredentialResolver): an
 * Account Store lookup by access key. Used to give an in-process entrypoint the same
 * verified caller boundary the executable entrypoint installs.
 */
export function storeCallerBoundary(store) {
  return createVerifiedClassicCaller({
    resolveCredentials: (accessKeyId) => store.accountByAccessKeyId(accessKeyId),
    allowNativeClientPayloadHash: true,
  });
}

/**
 * Sign one request exactly as a client would (archived JS signer wire format). A random,
 * signed nonce header keeps two otherwise-identical requests within the same second from
 * sharing a signature, which Classic's replay guard (caller.js ReplayGuard) would reject.
 */
export function signRequest({ url, method = 'POST', headers = {}, body = '', credentials, date = new Date() }) {
  const parsed = new URL(url);
  const signed = signSigV4({
    method,
    path: `${parsed.pathname}${parsed.search}`,
    headers: {
      Host: parsed.host,
      'X-Phoenix-Test-Nonce': randomUUID(),
      ...headers,
    },
    body,
    accessKeyId: credentials.accessKeyId,
    secretAccessKey: credentials.secretAccessKey,
    region: SYNTHETIC_REGION,
    service: 'jibo',
    date,
  });
  return signed.headers;
}

/** fetch() a SigV4-signed request. `body` may be a string or Buffer (signed as sent). */
export function signedFetch(url, { method = 'POST', headers = {}, body, credentials } = {}) {
  const wire = body === undefined ? '' : body;
  const signedHeaders = signRequest({ url, method, headers, body: wire, credentials });
  return fetch(url, {
    method,
    headers: signedHeaders,
    ...(method === 'GET' || method === 'HEAD' ? {} : { body: wire }),
  });
}

async function readReply(res) {
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text || null; }
  return { status: res.status, errType: res.headers.get('x-amzn-errortype'), headers: res.headers, body };
}

/** One signed AWS-JSON call to Classic's POST / face. */
export async function signedAmz(base, target, body, credentials, { headers = {} } = {}) {
  const res = await signedFetch(`${base}/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-amz-json-1.1', 'X-Amz-Target': target, ...headers },
    body: JSON.stringify(body || {}),
    credentials,
  });
  return readReply(res);
}

/** A currently free TCP port (listen on 0, read it back, close). */
export async function freePort() {
  const srv = http.createServer();
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const { port } = srv.address();
  await new Promise((resolve) => srv.close(resolve));
  return port;
}

/**
 * Start the REAL executable Classic entrypoint as a child process. The child resolves signing
 * keys from `accountDataFile` (ETCO_classic_accountDataFile, the production resolver) and
 * emits object URLs on its own configured public origin. `ready(base)` must resolve true once
 * the child serves an authenticated request.
 */
export async function startClassicChild({ accountDataFile, env = {}, ready, port }) {
  const childPort = port || await freePort();
  const base = `http://127.0.0.1:${childPort}`;
  const child = spawn(process.execPath, [CLASSIC_ENTRY], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(childPort),
      PHOENIX_BIND_HOST: '127.0.0.1',
      ETCO_classic_accountDataFile: accountDataFile,
      ETCO_classic_publicUrl: base,
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stdout.resume();
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const stop = () => new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once('close', resolve);
    child.kill('SIGKILL');
  });
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try {
      if (await ready(base)) return { base, port: childPort, child, stop };
    } catch { /* not listening yet */ }
    if (child.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await stop();
  throw new Error(`classic entrypoint child did not start: ${stderr}`);
}

/** Set environment variables now; returns a function that restores the previous values. */
export function setEnv(values) {
  const previous = Object.entries(values).map(([key]) => [
    key,
    Object.prototype.hasOwnProperty.call(process.env, key),
    process.env[key],
  ]);
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return () => {
    for (const [key, had, value] of previous) {
      if (had) process.env[key] = value;
      else delete process.env[key];
    }
  };
}
