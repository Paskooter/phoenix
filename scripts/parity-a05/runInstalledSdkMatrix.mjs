#!/usr/bin/env node

// Run the original installed Node 8 SDK against both Phoenix faces, restart
// both service processes orderly, and replay persistence checks with the same
// credentials/tokens.  All credentials live in the temporary run directory;
// the committed report contains hashes, counts, names, and wire outcomes only.

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const serverScript = path.join(here, 'sdkFixtureServer.mjs');
const initialClient = path.join(here, 'sdkMatrixClient.cjs');
const restartClient = path.join(here, 'sdkRestartClient.cjs');
const sdkRoot = process.env.A05_CLIENT_ROOT
  || '/home/shell/work/phoenix/.parity/yarn-cache/v1/npm-@jibo/jibo-server-client-3.0.110-dc0962bd91de9392ecf2ef6f96c6d9f7642d23e8';
const node8 = process.env.A05_NODE8
  || '/home/shell/work/phoenix/.parity/reviews/n08-original-multirule-20260906/perf-diagnosis/node-v8.9.4-extracted';
const nodePath = process.env.A05_NODE_PATH
  || '/home/shell/work/phoenix/.parity/reference/5c0a7390539663ba749d360de348a428c088505c/node_modules';
const reviewFile = process.env.A05_REVIEW_FILE
  || path.join(repo, 'docs/parity/evidence/2026-09-13/a05-installed-sdk-restart-6e817e3/review.json');

const candidateRevision = execFile('git', ['rev-parse', 'HEAD'], repo).trim();
if (candidateRevision !== '6e817e31985dfc578dc4dc8bbf745955eee657d7' && !process.env.A05_ALLOW_OTHER_REVISION) {
  throw new Error(`expected exact A-05 base 6e817e3, got ${candidateRevision}`);
}
if (!fs.existsSync(sdkRoot) || !fs.existsSync(node8)) throw new Error('original SDK or Node 8 runtime is unavailable');

const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phoenix-a05-sdk-restart-'));
const storeFile = path.join(runDir, 'store.json');
const metadataFile = path.join(runDir, 'metadata.json');
const initialResultFile = path.join(runDir, 'initial-result.json');
const restartResultFile = path.join(runDir, 'restart-result.json');
const serverLogs = [];
let serverProcess;

try {
  const initialMetadata = await startServer('initial');
  const initialRun = await runSdk(initialClient, initialResultFile, initialMetadata, null);
  const beforeRestart = await control(initialMetadata, '/snapshot');
  await orderlyShutdown(initialMetadata, 'initial');

  const restartMetadata = await startServer('restart');
  const restartRun = await runSdk(restartClient, restartResultFile, restartMetadata, initialResultFile);
  const afterRestart = await control(restartMetadata, '/snapshot');
  await orderlyShutdown(restartMetadata, 'restart');

  const report = buildReport({
    initialMetadata,
    restartMetadata,
    initialRun,
    restartRun,
    beforeRestart,
    afterRestart,
  });
  writePrivate(reviewFile, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ passed: report.passed, candidateRevision, runDir, initialChecks: report.initial.checks, restartChecks: report.restart.checks, report: reviewFile })}\n`);
} catch (error) {
  if (serverProcess && serverProcess.exitCode === null) {
    try { serverProcess.kill('SIGTERM'); } catch {}
    await waitForExit(serverProcess, 2000).catch(() => {});
  }
  process.stderr.write(`${error.stack || error}\nrun directory: ${runDir}\n`);
  process.exitCode = 1;
}

function execFile(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  return result.stdout;
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function writePrivate(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, text, { mode: 0o600 });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function startServer(label) {
  const stdout = [];
  const stderr = [];
  serverProcess = spawn(process.execPath, [serverScript, storeFile, metadataFile], {
    cwd: repo,
    env: { ...process.env, A05_CANDIDATE_REVISION: candidateRevision },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverLogs.push({ label, stdout, stderr, process: serverProcess });
  serverProcess.stdout.on('data', (chunk) => stdout.push(String(chunk)));
  serverProcess.stderr.on('data', (chunk) => stderr.push(String(chunk)));
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (fs.existsSync(metadataFile)) {
      try {
        const metadata = JSON.parse(fs.readFileSync(metadataFile, 'utf8'));
        if (metadata.phase === label) {
          metadata.readySnapshot = await control(metadata, '/snapshot');
          return metadata;
        }
      } catch {}
    }
    if (serverProcess.exitCode !== null) {
      throw new Error(`${label} fixture server exited ${serverProcess.exitCode}: ${stderr.join('')}`);
    }
    await wait(40);
  }
  throw new Error(`${label} fixture server did not publish metadata: ${stderr.join('')}`);
}

async function runSdk(clientScript, resultFile, metadata, initialFile) {
  const env = {
    ...process.env,
    A05_METADATA: metadataFile,
    A05_RESULT: resultFile,
    A05_INITIAL_RESULT: initialFile || '',
    A05_CLIENT_ROOT: sdkRoot,
    NODE_PATH: nodePath,
  };
  const child = spawn(node8, [clientScript], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', (chunk) => stdout.push(String(chunk)));
  child.stderr.on('data', (chunk) => stderr.push(String(chunk)));
  const result = await waitForExit(child, 30000);
  if (result.code !== 0) {
    throw new Error(`SDK ${path.basename(clientScript)} exited ${result.code}: ${stderr.join('')}stdout=${stdout.join('')}`);
  }
  if (!fs.existsSync(resultFile)) throw new Error(`SDK did not write ${resultFile}`);
  const parsed = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
  if (!parsed.passed) throw new Error(`SDK result marked failed: ${JSON.stringify(parsed.error)}`);
  return { result: parsed, stdout: stdout.join(''), stderr: stderr.join('') };
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null) return resolve({ code: child.exitCode, signal: child.signalCode });
    const timer = setTimeout(() => reject(new Error(`child ${child.pid} did not exit within ${timeoutMs}ms`)), timeoutMs);
    child.once('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
  });
}

function control(metadata, route) {
  const url = new URL(route, metadata.controlEndpoint);
  return new Promise((resolve, reject) => {
    const request = http.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port,
      method: 'GET',
      path: `${url.pathname}${url.search}`,
      headers: { connection: 'close' },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (response.statusCode !== 200) return reject(new Error(`control ${route} returned ${response.statusCode}: ${text}`));
        try { resolve(JSON.parse(text)); } catch (error) { reject(new Error(`control ${route} returned invalid JSON: ${error.message}`)); }
      });
    });
    request.on('error', reject);
    request.end();
  });
}

async function orderlyShutdown(metadata, label) {
  await control(metadata, '/shutdown');
  const result = await waitForExit(serverProcess, 15000);
  const log = serverLogs.find((entry) => entry.label === label);
  log.exit = result;
  if (result.code !== 0) throw new Error(`${label} orderly shutdown exited ${result.code} (${result.signal}): ${log.stderr.join('')}`);
  serverProcess = null;
}

function requiredRows(rows, names, face) {
  const actual = new Set(rows.filter((row) => row.face === face).map((row) => row.name));
  return names.map((name) => ({ name, present: actual.has(name) }));
}

function buildReport({ initialMetadata, restartMetadata, initialRun, restartRun, beforeRestart, afterRestart }) {
  const initial = initialRun.result;
  const restart = restartRun.result;
  const matrixNames = [
    'GetStatus pending setup token',
    'SetupRobot ordinary',
    'GetStatus used setup token',
    'FALSIFY used SetupRobot replay',
    'GetStatus expired token',
    'FALSIFY expired SetupRobot',
    'FALSIFY expired token remains expired',
    'FALSIFY live loop replacement refusal',
    'GetStatus live-loop refusal preserves token',
    'SetupRobot suspended-loop replacement',
    'GetStatus used replacement token',
    'PrepareRobot signed',
    'ReconnectRobot signed',
    'FALSIFY used ReconnectRobot replay',
    'GetStatus used reconnect token',
    'FALSIFY non-admin GetServiceToken',
    'GetServiceToken admin',
    'SetupRobot service mode',
    'GetStatus used service token',
  ];
  const restartNames = [
    'RESTART Account.Get ordinary',
    'RESTART Loop.List ordinary',
    'RESTART Account.Get replacement',
    'RESTART Loop.List replacement',
    'RESTART Account.Get service-mode',
    'RESTART Loop.List service-mode',
    'RESTART GetStatus consumed setup token',
    'RESTART FALSIFY consumed setup token replay',
    'RESTART GetStatus consumed replacement token',
    'RESTART GetStatus consumed reconnect token',
    'RESTART FALSIFY consumed reconnect token replay',
    'RESTART GetStatus consumed service token',
    'RESTART GetStatus expired token',
    'RESTART FALSIFY expired token remains expired',
    'RESTART GetStatus newly issued token remains pending',
    'RESTART ReconnectRobot newly issued token',
    'RESTART FALSIFY newly issued token replay',
  ];
  const faces = ['account', 'classic'];
  const matrixCoverage = Object.fromEntries(faces.map((face) => [face, requiredRows(initial.rows, matrixNames, face)]));
  const restartCoverage = Object.fromEntries(faces.map((face) => [face, requiredRows(restart.rows, restartNames, face)]));
  const coveragePass = (coverage) => Object.values(coverage).every((rows) => rows.every((row) => row.present));
  const serverExit = serverLogs.map(({ label, exit }) => ({ label, ...exit }));
  const passed = initial.passed === true
    && restart.passed === true
    && coveragePass(matrixCoverage)
    && coveragePass(restartCoverage)
    && beforeRestart.allCollectionsMatchDisk === true
    && afterRestart.allCollectionsMatchDisk === true
    && serverExit.every((entry) => entry.code === 0);
  return {
    schema: 1,
    generatedAt: new Date().toISOString(),
    passed,
    candidateRevision,
    worktree: repo,
    processRestart: {
      server: path.relative(repo, serverScript),
      initial: { phase: initialMetadata.phase, node: initialMetadata.node, readySnapshot: initialMetadata.readySnapshot, orderlyExit: serverExit.find((entry) => entry.label === 'initial') },
      restart: { phase: restartMetadata.phase, node: restartMetadata.node, readySnapshot: restartMetadata.readySnapshot, orderlyExit: serverExit.find((entry) => entry.label === 'restart') },
      beforeRestart,
      afterRestart,
    },
    installedSdk: {
      package: '@jibo/jibo-server-client',
      version: JSON.parse(fs.readFileSync(path.join(sdkRoot, 'package.json'), 'utf8')).version,
      root: sdkRoot,
      // The yarn-cache copy carries the tarball it was unpacked from; a client
      // tree lifted off the robot does not. Its absence is recorded, not fatal:
      // the per-file digests below are what identify the client either way.
      packageTarballSha256: fs.existsSync(path.join(sdkRoot, '.yarn-tarball.tgz'))
        ? sha256(path.join(sdkRoot, '.yarn-tarball.tgz'))
        : null,
      files: {
        oobe: sha256(path.join(sdkRoot, 'clients/oobe.js')),
        oobeadmin: sha256(path.join(sdkRoot, 'clients/oobeadmin.js')),
        account: sha256(path.join(sdkRoot, 'clients/account.js')),
        loop: sha256(path.join(sdkRoot, 'clients/loop.js')),
        oobeModel: sha256(path.join(sdkRoot, 'apis/oobe-2016-10-26.min.json')),
        oobeAdminModel: sha256(path.join(sdkRoot, 'apis/oobeadmin-2016-10-26.min.json')),
      },
      node8: { executable: node8, version: spawnSync(node8, ['--version'], { encoding: 'utf8' }).stdout.trim(), sha256: sha256(node8) },
    },
    commands: [
      `git rev-parse HEAD  # ${candidateRevision}`,
      `node ${path.relative(repo, serverScript)} <temporary store> <temporary metadata>`,
      `${node8} ${path.relative(repo, initialClient)}`,
      `${node8} ${path.relative(repo, restartClient)}`,
      'orderly control GET /shutdown; wait for child exit code 0; repeat after restart',
    ],
    initial: {
      phase: initial.phase,
      runtime: initial.runtime,
      clientVersion: initial.clientVersion,
      checks: initial.checks,
      faces: initial.faces.map((face) => ({ face: face.face, operations: face.operations })),
      rows: initial.rows,
      coverage: matrixCoverage,
    },
    restart: {
      phase: restart.phase,
      runtime: restart.runtime,
      clientVersion: restart.clientVersion,
      checks: restart.checks,
      faces: restart.faces,
      rows: restart.rows,
      coverage: restartCoverage,
    },
    qualification: 'Original installed Node 8 SDK exercised both local Account and Classic HTTP faces and replayed issued credentials plus consumed/pending token state after orderly process restart. Synthetic Store only; no Moth, robot, firmware, native pairing, TLS ingress, or household mutation.',
    a03A04Dependencies: {
      A03: 'tasks.json remains verified but partial: root acceptance, public/internal boundary coverage, complete operation/SNS/Mongo/bootstrap lifecycle remain open.',
      A04: 'tasks.json remains verified but partial: source-backed duplicate/reinvite, conditional adoption/revival, uncovered failure/persistence states, deployment and live effects remain open.',
      classification: 'This matrix validates A-05 OOBE/Account/Loop SDK composition against the current synthetic Store. It provides dependency evidence for A-03/A-04 flows but does not close either task or their fresh deployment/hardware requirements.',
    },
    freshHardwareGap: 'Root-only acceptance remains: fresh robot identity, firmware/date, native pairing and TLS ingress, camera/mic/screen/notification behavior, household preservation/migration, and deployment evidence. This worker did not access Moth or hardware.',
  };
}
