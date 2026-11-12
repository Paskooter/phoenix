#!/usr/bin/env node
// sign-ota-release.mjs — sign official OTA manifest rows with the offline Phoenix release key,
// and verify signed rows the way the robot-side gate will.
//
// Runs AFTER scripts/be_ota_integrity.py: a `be` row is only signed when a passing gate receipt
// (that script's JSON output) for the exact same package bytes is supplied. Normally run through
// scripts/ota-release-kit.sh, which runs the gate, signs, then verifies.
//
//   node scripts/sign-ota-release.mjs rows   --manifest M [--ids a,b]
//   node scripts/sign-ota-release.mjs sign   --manifest M --data-dir D --out OUT
//                                            --key private.pem --key-id phoenix-ota-YYYYMMDD
//                                            [--ids a,b] [--gate-receipt be-gate.json ...]
//   node scripts/sign-ota-release.mjs verify --manifest M --data-dir D
//                                            --pubkey phoenix-ota-YYYYMMDD=public.pem ...
//                                            [--ids a,b]
//
// An encrypted private key reads its passphrase from PHOENIX_OTA_KEY_PASSPHRASE. `sign` never
// overwrites: OUT must not exist. Signature format: packages/ota/src/releaseSignature.js and
// docs/OTA-RELEASE-SIGNING.md.

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SIGNATURE_FIELD, loadPrivateKey, loadPublicKey, signRow, verifyRow,
} from '../packages/ota/src/releaseSignature.js';

const OFFICIAL_BE_FILES = 21590; // scripts/be_ota_integrity.py: complete official 11.0.1 archive
const GATE_KEYS = ['addedFiles', 'candidateFiles', 'officialFiles', 'sha256', 'unresolvedMains'];
// The BE skill's subsystem: production manifests use the package name "@be/be"; "be" is the short form.
const BE_SUBSYSTEMS = new Set(['be', '@be/be']);

export function isBeRow(row) {
  return BE_SUBSYSTEMS.has(row && row.subsystem);
}

class UsageError extends Error {}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const opts = { _multi: {} };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg.startsWith('--')) throw new UsageError(`unexpected argument: ${arg}`);
    const name = arg.slice(2);
    const value = rest[i + 1];
    if (value === undefined || value.startsWith('--')) throw new UsageError(`--${name} needs a value`);
    i++;
    if (name === 'gate-receipt' || name === 'pubkey') (opts._multi[name] ||= []).push(value);
    else opts[name] = value;
  }
  return { command, opts };
}

function need(opts, name) {
  if (!opts[name]) throw new UsageError(`--${name} is required`);
  return opts[name];
}

function digestFile(file) {
  return new Promise((resolve, reject) => {
    const h1 = createHash('sha1');
    const h256 = createHash('sha256');
    let length = 0;
    const s = createReadStream(file);
    s.on('data', (c) => { h1.update(c); h256.update(c); length += c.length; });
    s.on('error', reject);
    s.on('end', () => resolve({ length, sha1: h1.digest('hex'), sha256: h256.digest('hex') }));
  });
}

async function loadManifest(file) {
  const manifest = JSON.parse(await readFile(file, 'utf8'));
  if (!manifest || !Array.isArray(manifest.updates)) throw new Error(`${file}: no "updates" array`);
  return manifest;
}

function selectRows(manifest, idsOpt) {
  const rows = manifest.updates;
  if (!idsOpt) return rows;
  const ids = idsOpt.split(',').map((s) => s.trim()).filter(Boolean);
  const picked = ids.map((id) => {
    const row = rows.find((r) => r && r.id === id);
    if (!row) throw new Error(`no manifest row with id ${id}`);
    return row;
  });
  return picked;
}

function packagePath(dataDir, row) {
  if (typeof row.file !== 'string' || !row.file) throw new Error(`${row.id}: row has no file`);
  const root = path.resolve(dataDir);
  const file = path.resolve(root, row.file);
  if (file !== root && !file.startsWith(root + path.sep)) throw new Error(`${row.id}: file escapes the data directory`);
  return file;
}

/** The manifest's own length/sha1/sha256 (when present) must describe the bytes being signed. */
function checkRecordedDigests(row, digests) {
  for (const key of ['length', 'sha1', 'sha256']) {
    if (row[key] !== undefined && row[key] !== digests[key]) {
      throw new Error(`${row.id}: manifest ${key} ${row[key]} differs from the package (${digests[key]})`);
    }
  }
}

async function loadGateReceipts(files = []) {
  const receipts = [];
  for (const file of files) {
    const receipt = JSON.parse(await readFile(file, 'utf8'));
    const keys = Object.keys(receipt || {}).sort();
    if (JSON.stringify(keys) !== JSON.stringify(GATE_KEYS)) throw new Error(`${file}: not a be_ota_integrity.py receipt`);
    receipts.push({ file, receipt });
  }
  return receipts;
}

function requireGate(row, digests, receipts) {
  const match = receipts.find(({ receipt }) => receipt.sha256 === digests.sha256);
  if (!match) {
    throw new Error(`${row.id}: refusing to sign a be package without a passing scripts/be_ota_integrity.py receipt for sha256 ${digests.sha256}`);
  }
  const { receipt, file } = match;
  if (receipt.officialFiles !== OFFICIAL_BE_FILES || receipt.unresolvedMains !== 0
      || !(receipt.candidateFiles >= OFFICIAL_BE_FILES)) {
    throw new Error(`${row.id}: gate receipt ${file} is not a pass`);
  }
}

async function cmdRows(opts) {
  const manifest = await loadManifest(need(opts, 'manifest'));
  for (const row of selectRows(manifest, opts.ids)) {
    process.stdout.write(`${row.id}\t${row.subsystem}\t${row.toVersion}\t${row.file ?? ''}\n`);
  }
}

async function cmdSign(opts) {
  const manifestFile = need(opts, 'manifest');
  const dataDir = need(opts, 'data-dir');
  const out = need(opts, 'out');
  const keyId = need(opts, 'key-id');
  const keyFile = need(opts, 'key');
  try {
    await stat(out);
    throw new Error(`${out} already exists; sign never overwrites`);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const keyStat = await stat(keyFile);
  if (keyStat.mode & 0o077) process.stderr.write(`warning: ${keyFile} is readable by other users\n`);
  const privateKey = loadPrivateKey(await readFile(keyFile, 'utf8'), process.env.PHOENIX_OTA_KEY_PASSPHRASE);
  const receipts = await loadGateReceipts(opts._multi['gate-receipt']);

  const manifest = await loadManifest(manifestFile);
  const rows = selectRows(manifest, opts.ids);
  const signed = [];
  // Check every row before signing any, so a refused row leaves no partial output.
  const work = [];
  for (const row of rows) {
    const digests = await digestFile(packagePath(dataDir, row));
    checkRecordedDigests(row, digests);
    if (isBeRow(row)) requireGate(row, digests, receipts);
    work.push({ row, digests });
  }
  for (const { row, digests } of work) {
    row[SIGNATURE_FIELD] = signRow(row, digests, { privateKey, keyId });
    signed.push({ id: row.id, subsystem: row.subsystem, toVersion: row.toVersion, sha256: digests.sha256, length: digests.length });
  }
  await writeFile(out, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  process.stdout.write(`${JSON.stringify({ out, keyId, signed }, null, 2)}\n`);
}

async function cmdVerify(opts) {
  const manifest = await loadManifest(need(opts, 'manifest'));
  const dataDir = need(opts, 'data-dir');
  const specs = opts._multi.pubkey || [];
  if (!specs.length) throw new UsageError('--pubkey keyId=public.pem is required');
  const keys = {};
  for (const spec of specs) {
    const eq = spec.indexOf('=');
    if (eq < 1) throw new UsageError(`--pubkey must be keyId=path (got ${spec})`);
    keys[spec.slice(0, eq)] = loadPublicKey(await readFile(spec.slice(eq + 1), 'utf8'));
  }
  let failed = 0;
  const results = [];
  for (const row of selectRows(manifest, opts.ids)) {
    let result;
    try {
      const digests = await digestFile(packagePath(dataDir, row));
      result = verifyRow(row[SIGNATURE_FIELD], row, digests, keys);
    } catch (err) {
      result = { ok: false, reason: err.code === 'ENOENT' ? 'package-missing' : err.message };
    }
    if (!result.ok) failed++;
    results.push({ id: row.id, ok: result.ok, ...(result.ok ? { keyId: row[SIGNATURE_FIELD].keyId, toVersion: result.statement.toVersion } : { reason: result.reason }) });
  }
  process.stdout.write(`${JSON.stringify({ verified: results.length - failed, failed, results }, null, 2)}\n`);
  if (failed) process.exitCode = 1;
}

export async function main(argv = process.argv.slice(2)) {
  const { command, opts } = parseArgs(argv);
  if (command === 'rows') return cmdRows(opts);
  if (command === 'sign') return cmdSign(opts);
  if (command === 'verify') return cmdVerify(opts);
  throw new UsageError('usage: sign-ota-release.mjs rows|sign|verify [options] (see the header of this file)');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`sign-ota-release: ${err.message}\n`);
    process.exit(err instanceof UsageError ? 2 : 1);
  });
}
