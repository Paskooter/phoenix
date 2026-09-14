#!/usr/bin/env node

// Emit the Phoenix source manifest that `finalize.mjs` binds into a terminal
// S-13 receipt.
//
// The finalizer re-derives every value here from the source root itself
// (schema, revision, sorted unique rows, per-file bytes and digests, the tree
// digest over the ordered rows, a clean `git status`, and an exact match
// against `git ls-files`).  This tool therefore adds no authority: it only
// spares an operator from hand-writing 7,000 rows, and a manifest it produced
// from the wrong tree is rejected exactly like any other.
//
// The source root must be a clean checkout of the capture revision.  When the
// toolkit worktree has moved on, add a detached worktree at that revision and
// point --source-root at it.
//
// Reads bytes only.  It does not start Phoenix, contact a robot, or push.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const SCHEMA = 'phoenix-s13-source-manifest-v1';

function fail(message) {
  console.error(`S13 source manifest: ${message}`);
  process.exit(1);
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], { maxBuffer: 1024 * 1024 * 256 });
}

function parseArgs(argv) {
  const args = { sourceRoot: null, out: null, revision: null };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--help' || token === '-h') return { help: true };
    if (token === '--source-root') args.sourceRoot = argv[++index];
    else if (token === '--out') args.out = argv[++index];
    else if (token === '--revision') args.revision = argv[++index];
    else fail(`unknown option ${token}`);
  }
  if (!args.sourceRoot || !args.out) fail('both --source-root and --out are required');
  return args;
}

function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log('Usage: node scripts/parity-s13-physical/source-manifest.mjs --source-root DIR --out FILE [--revision SHA]');
    return;
  }

  const root = path.resolve(args.sourceRoot);
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(root) !== root) fail('source root must be a real directory');

  const revision = git(root, ['rev-parse', 'HEAD']).toString('utf8').trim();
  if (!/^[a-f0-9]{40}$/.test(revision)) fail('source root HEAD is not a full revision');
  if (args.revision && args.revision !== revision) fail(`source root HEAD ${revision} does not match --revision ${args.revision}`);
  if (git(root, ['status', '--porcelain=v1']).length !== 0) fail('source root has uncommitted changes');

  // `git ls-files -z` is already sorted by path, and the finalizer requires the
  // manifest rows to enumerate it in exactly that order.
  const tracked = git(root, ['ls-files', '-z']).toString('utf8').split('\0').filter(Boolean);
  if (!tracked.length) fail('source root has no tracked files');

  const files = tracked.map((relative) => {
    const file = path.resolve(root, relative);
    const fileStat = fs.lstatSync(file);
    if (!fileStat.isFile() || fileStat.isSymbolicLink()) fail(`tracked path is not a regular file: ${relative}`);
    const bytes = fs.readFileSync(file);
    return { path: relative, bytes: bytes.length, sha256: sha256(bytes) };
  });

  const manifest = {
    schema: SCHEMA,
    revision,
    files,
    treeSha256: sha256(Buffer.from(JSON.stringify(files), 'utf8'))
  };

  const out = path.resolve(args.out);
  fs.mkdirSync(path.dirname(out), { recursive: true, mode: 0o700 });
  fs.writeFileSync(out, `${JSON.stringify(manifest)}\n`);
  console.log(JSON.stringify({
    out,
    revision,
    fileCount: files.length,
    treeSha256: manifest.treeSha256,
    sourceManifestSha256: sha256(fs.readFileSync(out))
  }));
}

main(process.argv.slice(2));
