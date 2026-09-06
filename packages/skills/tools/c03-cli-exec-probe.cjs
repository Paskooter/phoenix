#!/usr/bin/env node
// Execute a CLI child and report process-local timing. This stays CommonJS so
// the same probe runs under the pinned Node 8 source image and Node 22 Phoenix.

const { spawn } = require('child_process');

const [target, ...args] = process.argv.slice(2);
if (!target) {
  console.error('usage: c03-cli-exec-probe.cjs TARGET [ARGS...]');
  process.exit(2);
}

const start = process.hrtime();
const child = spawn(process.execPath, [target, ...args], {
  cwd: process.env.C03_PROBE_CWD || process.cwd(),
  env: process.env,
  stdio: ['ignore', 'pipe', 'pipe'],
});
const stdout = [];
const stderr = [];
child.stdout.on('data', (chunk) => stdout.push(chunk));
child.stderr.on('data', (chunk) => stderr.push(chunk));

const timeoutMs = Number(process.env.C03_CHILD_TIMEOUT_MS || 15000);
const timeout = setTimeout(() => child.kill('SIGTERM'), timeoutMs);

child.on('error', (error) => {
  clearTimeout(timeout);
  const [seconds, nanoseconds] = process.hrtime(start);
  process.stdout.write(JSON.stringify({
    target,
    args,
    runtime: process.version,
    elapsedNs: (seconds * 1e9) + nanoseconds,
    error: { name: error.name, message: error.message },
    stdout: Buffer.concat(stdout).toString('utf8'),
    stderr: Buffer.concat(stderr).toString('utf8'),
  }) + '\n');
  process.exitCode = 1;
});

child.on('close', (code, signal) => {
  clearTimeout(timeout);
  const [seconds, nanoseconds] = process.hrtime(start);
  process.stdout.write(JSON.stringify({
    target,
    args,
    runtime: process.version,
    elapsedNs: (seconds * 1e9) + nanoseconds,
    status: code,
    signal,
    stdout: Buffer.concat(stdout).toString('utf8'),
    stderr: Buffer.concat(stderr).toString('utf8'),
    timedOut: signal === 'SIGTERM',
  }) + '\n');
});
