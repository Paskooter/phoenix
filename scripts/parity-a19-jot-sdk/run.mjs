#!/usr/bin/env node
// A-19 Jot conformance runner.
//
// Starts Phoenix's classic face over TLS with an injected loop-membership seam
// and a recording push provider, drives it with the genuine original client
// (@jibo/jibo-server-client@3.0.42 on node:8.9.4), and asserts the result.
//
// It reads and writes only the run directory, fetches the client from the
// pvindex archive once and caches it, and never contacts a robot.

import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, rmSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');

// The newest archived client that still ships a Jot model. 3.0.43 and later,
// including the final 3.0.110, carry none. See README.md.
const CLIENT_VERSION = '3.0.42';
const CLIENT_PKG = '@jibo%2fjibo-server-client';
const NODE8 = 'node:8.9.4-slim';

const MEMBER = 'AKIAA19MEMBERKEY';
const ROBOT = 'AKIAA19ROBOTKEY';
const OUTSIDER = 'AKIAA19OUTSIDERKEY';
const LOOP = 'loop-a19-main';
const OTHER_LOOP = 'loop-a19-other';

function parseArgs(argv) {
  const args = { out: join(repo, '.parity/runs/a19-jot-sdk'), tls: true };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out') args.out = resolve(argv[++i]);
    else if (argv[i] === '--no-tls') args.tls = false;
    else if (argv[i] === '--help') return { help: true };
    else throw new Error(`unknown option ${argv[i]}`);
  }
  return args;
}

function sh(cmd, cmdArgs, opts = {}) {
  const res = spawnSync(cmd, cmdArgs, { encoding: 'utf8', ...opts });
  if (res.status !== 0) {
    throw new Error(`${cmd} ${cmdArgs.join(' ')} failed (${res.status}): ${(res.stderr || res.stdout || '').slice(0, 400)}`);
  }
  return res.stdout;
}

async function fetchClient(runDir) {
  const sdkDir = join(runDir, `sdk-${CLIENT_VERSION}`);
  if (existsSync(join(sdkDir, 'apis/jot-2016-05-12.min.json'))) return sdkDir;

  const meta = await (await fetch(`https://pvindex.org/npm/${CLIENT_PKG}`)).json();
  const version = meta.versions?.[CLIENT_VERSION];
  if (!version) throw new Error(`archive has no ${CLIENT_PKG}@${CLIENT_VERSION}`);
  const tarball = version.dist?.tarball;
  if (!tarball) throw new Error('no tarball url for the pinned client');

  const bytes = Buffer.from(await (await fetch(tarball)).arrayBuffer());
  mkdirSync(sdkDir, { recursive: true });
  const tgz = join(runDir, 'client.tgz');
  writeFileSync(tgz, bytes);
  sh('tar', ['xzf', tgz, '-C', sdkDir, '--strip-components=1']);
  rmSync(tgz, { force: true });

  // The client needs its own runtime dependencies; install them on its own era.
  sh('docker', ['run', '--rm', '-v', `${sdkDir}:/sdk`, '-w', '/sdk', NODE8,
    'npm', 'install', '--production', '--no-audit', '--no-fund', '--loglevel=error']);

  const model = JSON.parse(readFileSync(join(sdkDir, 'apis/jot-2016-05-12.min.json'), 'utf8'));
  const meta2 = model.metadata || {};
  if (meta2.targetPrefix !== 'Jot_20160126' || meta2.signatureVersion !== 'v4') {
    throw new Error(`unexpected model: prefix=${meta2.targetPrefix} sig=${meta2.signatureVersion}`);
  }
  return sdkDir;
}

/** The loop fixture. Shape per jot.js getImpersonatedAccount: members[] with an
 *  accepted status and the id under memberId or accountId. Supplying
 *  `accounts[]` instead makes every request 403, which looks like a working gate
 *  and is not. */
function loopFixture() {
  const member = (id) => ({ memberId: id, accountId: id, status: 'accepted' });
  return {
    [LOOP]: { id: LOOP, robot: ROBOT, members: [member(MEMBER), member(ROBOT)] },
    [OTHER_LOOP]: { id: OTHER_LOOP, robot: ROBOT, members: [member(OUTSIDER)] },
  };
}

/**
 * A serving certificate for the name the client actually dials.
 *
 * This matters more than it looks: the node-8 aws-sdk fork HANGS rather than
 * erroring when the certificate does not cover the host, producing no output at
 * all. An earlier version of this harness used a certificate for api.jibo.com
 * and 127.0.0.1 while the client dialled the container hostname, and the
 * resulting silence was misread as "TLS does not work with this client".
 */
function ensureHarnessCert(runDir) {
  const dir = join(runDir, 'tls');
  const key = join(dir, 'key.pem');
  const cert = join(dir, 'cert.pem');
  if (existsSync(key) && existsSync(cert)) return { dir, key, cert };
  mkdirSync(dir, { recursive: true });
  sh('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', key, '-out', cert, '-days', '30',
    '-subj', `/CN=${SERVER_NAME}`,
    '-addext', `subjectAltName=DNS:${SERVER_NAME},DNS:localhost,IP:127.0.0.1`,
  ]);
  return { dir, key, cert };
}

const NET = 'a19net';
const SERVER_NAME = 'a19-classic';
const PHOENIX_IMAGE = process.env.A19_PHOENIX_IMAGE || 'phoenix-runtime:local';

/** Start the classic face in its own container on a bridge network.
 *  Host networking was tried first: the node-8 client hung against it with no
 *  output at all. Container-to-container over a bridge is what works. */
function startServerContainer(runDir, certs) {
  spawnSync('docker', ['network', 'create', NET], { encoding: 'utf8' });
  spawnSync('docker', ['rm', '-f', SERVER_NAME], { encoding: 'utf8' });
  sh('docker', [
    'run', '-d', '--name', SERVER_NAME, '--network', NET, '-e', 'PORT=8080',
    '-e', `A19_MEMBER=${MEMBER}`, '-e', `A19_ROBOT=${ROBOT}`, '-e', `A19_OUTSIDER=${OUTSIDER}`,
    '-e', `A19_LOOP=${LOOP}`, '-e', `A19_OTHER_LOOP=${OTHER_LOOP}`, '-e', 'A19_OUT=/out',
    ...(certs ? ['-e', 'A19_TLS_KEY=/tls/key.pem', '-e', 'A19_TLS_CERT=/tls/cert.pem', '-v', `${certs.dir}:/tls:ro`] : []),
    '-v', `${repo}:/phoenix:ro`, '-v', `${runDir}:/out`, '-w', '/phoenix',
    PHOENIX_IMAGE, 'node', '/phoenix/scripts/parity-a19-jot-sdk/server.mjs',
  ]);
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const probe = spawnSync('docker', [
      'run', '--rm', '--network', NET,
      ...(certs ? ['-v', `${certs.dir}:/tls:ro`] : []), 'curlimages/curl:latest',
      '-s', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '3',
      ...(certs ? ['--cacert', '/tls/cert.pem'] : []),
      `${certs ? 'https' : 'http'}://${SERVER_NAME}:8080/healthcheck`,
    ], { encoding: 'utf8' });
    if ((probe.stdout || '').trim() === '200') return;
    spawnSync('sleep', ['2']);
  }
  const logs = spawnSync('docker', ['logs', SERVER_NAME], { encoding: 'utf8' });
  throw new Error(`classic face never became healthy: ${(logs.stdout || '') + (logs.stderr || '')}`.slice(0, 500));
}

function stopServerContainer() {
  spawnSync('docker', ['rm', '-f', SERVER_NAME], { encoding: 'utf8' });
  spawnSync('docker', ['network', 'rm', NET], { encoding: 'utf8' });
}

function runClient({ sdkDir, endpoint, runDir, caFile, caDir }) {
  const outFile = join(runDir, 'client-result.json');
  rmSync(outFile, { force: true });
  const args = [
    'run', '--rm', '--network', NET,
    '-v', `${sdkDir}:/sdk:ro`,
    '-v', `${here}:/harness:ro`,
    '-v', `${runDir}:/out`,
    '-e', `A19_MEMBER=${MEMBER}`, '-e', `A19_ROBOT=${ROBOT}`, '-e', `A19_OUTSIDER=${OUTSIDER}`,
    '-e', `A19_LOOP=${LOOP}`, '-e', `A19_OTHER_LOOP=${OTHER_LOOP}`,
  ];
  if (caDir) args.push('-v', `${caDir}:/tls:ro`, '-e', 'A19_CA_FILE=/tls/cert.pem');
  args.push(NODE8, 'node', '/harness/client.cjs', '/sdk', endpoint, '/out/client-result.json');
  sh('docker', args);
  return JSON.parse(readFileSync(outFile, 'utf8'));
}

const EXPECTED = [
  ['list-empty', 'ok'],
  ['create', 'ok'],
  ['list-after-create', 'ok'],
  ['unread-own-loop', 'ok'],
  ['mark-read-by-id', 'ok'],
  ['mark-loop-read', 'ok'],
  ['unread-after-mark', 'ok'],
  ['outsider-list-refused', 'JOT_MUST_BE_LOOP_MEMBER'],
  ['outsider-create-refused', 'JOT_MUST_BE_LOOP_MEMBER'],
  ['non-robot-impersonation-refused', 'JOT_ROBOT_CAN_IMPERSONATE'],
  ['robot-impersonation-allowed', 'ok'],
  ['cross-loop-isolation', 'ok'],
];

function assertResult(result, pushes) {
  const errors = [];
  const byName = new Map(result.steps.map((step) => [step.name, step]));
  for (const [name, want] of EXPECTED) {
    const step = byName.get(name);
    if (!step) { errors.push(`${name}: missing`); continue; }
    if (want === 'ok') {
      if (!step.ok) errors.push(`${name}: expected success, got ${step.errCode} (${step.status})`);
    } else if (step.errCode !== want) {
      errors.push(`${name}: expected ${want}, got ${step.ok ? 'success' : `${step.errCode} (${step.status})`}`);
    }
  }

  const listAfter = byName.get('list-after-create');
  if (listAfter?.ok && !(Array.isArray(listAfter.data) && listAfter.data.length === 1)) {
    errors.push('list-after-create: expected exactly one message');
  }
  const unread = byName.get('unread-after-mark');
  if (unread?.ok && unread.data?.count !== 0) errors.push(`unread-after-mark: expected 0, got ${unread.data?.count}`);
  const isolation = byName.get('cross-loop-isolation');
  if (isolation?.ok && Array.isArray(isolation.data) && isolation.data.length !== 0) {
    errors.push('cross-loop-isolation: another loop must not see this loop\'s messages');
  }
  // The recovered push fan-out must have fired for the member's registered device.
  if (!pushes.length) errors.push('push fan-out: no notification was delivered');
  const tagged = pushes.find((row) => row.type === 'jot-created-tagged');
  if (!tagged) errors.push('push fan-out: the tagged member did not receive a non-silent push');
  return errors;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: node scripts/parity-a19-jot-sdk/run.mjs [--out DIR]');
    return;
  }
  const runDir = args.out;
  mkdirSync(runDir, { recursive: true });

  const sdkDir = await fetchClient(runDir);

  const certs = args.tls ? ensureHarnessCert(runDir) : null;
  startServerContainer(runDir, certs);
  let result;
  try {
    result = runClient({
      sdkDir,
      endpoint: `${certs ? 'https' : 'http'}://${SERVER_NAME}:8080`,
      runDir,
      caFile: certs ? certs.cert : undefined,
      caDir: certs ? certs.dir : undefined,
    });
  } finally {
    stopServerContainer();
  }
  const pushes = JSON.parse(readFileSync(join(runDir, 'pushes.json'), 'utf8'));

  // Durability: the message and the event ledger survive a fresh store on the
  // same file, which is what a service restart looks like from disk.
  const { JotStore } = await import(join(repo, 'packages/classic/src/index.js'));
  const reopened = new JotStore(join(runDir, 'jot-store.json'));
  const survived = reopened.messages.length;
  const events = reopened.events.length;

  const errors = assertResult(result, pushes);
  if (survived < 1) errors.push('durability: no message survived reopening the store');
  if (events < 1) errors.push('durability: no JotMessageCreated event survived in the ledger');

  const receipt = {
    schema: 'phoenix.a19.jot-sdk-conformance.v1',
    task: 'A-19',
    client: { package: '@jibo/jibo-server-client', version: CLIENT_VERSION, runtime: NODE8 },
    model: { file: 'apis/jot-2016-05-12.min.json', targetPrefix: 'Jot_20160126', signatureVersion: 'v4' },
    transport: { tls: result.tls, endpoint: result.endpoint },
    steps: result.steps.map(({ name, ok, errCode, status }) => ({ name, ok, errCode, status })),
    pushFanOut: pushes,
    durability: { messages: survived, events },
    result: errors.length === 0 ? 'pass' : 'fail',
    errors,
  };
  const receiptPath = join(runDir, 'receipt.json');
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  receipt.receiptSha256 = createHash('sha256').update(readFileSync(receiptPath)).digest('hex');

  console.log(JSON.stringify({
    result: receipt.result,
    steps: receipt.steps.length,
    pushes: receipt.pushFanOut.length,
    durability: receipt.durability,
    errors,
    receipt: receiptPath,
  }, null, 2));
  if (errors.length) process.exitCode = 1;
}

main().catch((error) => { console.error(error.message); process.exit(1); });
