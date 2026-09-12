#!/usr/bin/env node
// Small compose entrypoint guard. The application keeps its test-only
// disableAuth switch, while deployed stacks must opt into that switch.
import { spawn } from 'node:child_process';

const [command, ...args] = process.argv.slice(2);
if (!command) {
  console.error('usage: require-auth.mjs <command> [args...]');
  process.exit(64);
}
const devMode = process.env.PHOENIX_DEV_MODE === '1';
const disableAuth = ['1', 'true', 'yes'].includes(String(process.env.ETCO_hub_disableAuth || '').toLowerCase());
if (disableAuth && !devMode) {
  console.error('ETCO_hub_disableAuth requires explicit PHOENIX_DEV_MODE=1');
  process.exit(78);
}
if (!process.env.ETCO_server_hubTokenSecret) {
  console.error('ETCO_server_hubTokenSecret is required');
  process.exit(78);
}
const child = spawn(command, args, { stdio: 'inherit' });
child.on('error', error => {
  console.error(error.message);
  process.exitCode = 127;
});
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
