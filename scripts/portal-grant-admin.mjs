#!/usr/bin/env node
/**
 * Grant or revoke portal administrator access.
 *
 * Administrator access is the `isAdmin` flag on an account. Every /api/admin/*
 * route re-checks it server-side, so the console cannot grant itself anything by
 * editing its own copy. There is no shared admin password any more, which is why
 * this script exists: it is the supported way to make an account an
 * administrator.
 *
 *   node scripts/portal-grant-admin.mjs --list
 *   node scripts/portal-grant-admin.mjs --email you@example.com
 *   node scripts/portal-grant-admin.mjs --email you@example.com --revoke
 *
 * The store file defaults to PHOENIX_ROBOT_STORE_FILE and then to the moth
 * deployment's account.json. Pass --store to point somewhere else.
 *
 * A running service may hold the store in memory, so restart it if the console
 * does not pick the change up:  systemctl --user restart phoenix-robot@moth
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { Store } from '../packages/account/src/index.js';

function parseArgs(argv) {
  const out = { email: null, revoke: false, list: false, store: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--email') out.email = argv[++i];
    else if (arg === '--revoke') out.revoke = true;
    else if (arg === '--list') out.list = true;
    else if (arg === '--store') out.store = argv[++i];
    else if (arg === '--help' || arg === '-h') out.help = true;
    else if (!arg.startsWith('--') && !out.email) out.email = arg;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(`usage:
  node scripts/portal-grant-admin.mjs --list
  node scripts/portal-grant-admin.mjs --email <address> [--revoke] [--store <file>]`);
  process.exit(0);
}

const storeFile = args.store
  || process.env.PHOENIX_ROBOT_STORE_FILE
  || join(homedir(), '.local/share/phoenix/moth/account.json');

if (!existsSync(storeFile)) {
  console.error(`no account store at ${storeFile}`);
  console.error('pass --store <file> or set PHOENIX_ROBOT_STORE_FILE');
  process.exit(2);
}

const store = new Store(storeFile);
const accounts = [...store.accounts.values()];

if (args.list || !args.email) {
  if (!accounts.length) {
    console.log(`no accounts in ${storeFile}`);
    process.exit(0);
  }
  console.log(`${accounts.length} account(s) in ${storeFile}:`);
  for (const account of accounts) {
    // Identity only: never print password material, secrets or access keys.
    const who = account.email || `(no email) ${account._id}`;
    const name = [account.firstName, account.lastName].filter(Boolean).join(' ');
    console.log(`  ${account.isAdmin ? 'admin  ' : '       '} ${who}${name ? `  — ${name}` : ''}`);
  }
  if (!args.email) {
    console.log('\nGrant admin with --email <address>.');
    process.exit(0);
  }
}

const target = store.accountByEmail(args.email);
if (!target) {
  console.error(`no account with email ${args.email}`);
  const known = accounts.map((a) => a.email).filter(Boolean);
  if (known.length) console.error(`known: ${known.join(', ')}`);
  process.exit(1);
}

const wanted = !args.revoke;
if (!!target.isAdmin === wanted) {
  console.log(`${target.email} is already ${wanted ? 'an administrator' : 'not an administrator'} — nothing to do.`);
  process.exit(0);
}

target.isAdmin = wanted;
store.flush();
console.log(`${wanted ? 'granted' : 'revoked'} administrator access for ${target.email}`);
console.log(`store: ${storeFile}`);
if (wanted) {
  console.log('Sign in to the console and open /admin. Restart the service if it does not take effect:');
  console.log('  systemctl --user restart phoenix-robot@moth');
}
