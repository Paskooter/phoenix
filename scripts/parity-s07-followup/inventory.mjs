#!/usr/bin/env node

// S-07 follow-up inventory.  It is intentionally independent of Phoenix's
// loader: every pinned-source and candidate Chitchat MIM is parsed, counted,
// and hashed before the continuation comparison is considered.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const value = (name, fallback) => {
  const index = args.indexOf(name);
  return index < 0 ? fallback : args[index + 1];
};
const sourceRoot = path.resolve(value('--source-root', '/home/shell/work/phoenix/.parity/reference/5c0a7390539663ba749d360de348a428c088505c'));
const candidateRoot = path.resolve(value('--candidate-root', path.resolve('.')));
const outPath = path.resolve(value('--out', '/tmp/s07-followup-inventory.json'));
const source = path.join(sourceRoot, 'packages/chitchat-skill/mims');
const candidate = path.join(candidateRoot, 'packages/skills/resources/mims/chitchat');

function files(root) {
  const rows = [];
  function walk(current) {
    for (const name of fs.readdirSync(current).sort()) {
      const absolute = path.join(current, name);
      if (fs.statSync(absolute).isDirectory()) walk(absolute);
      else if (name.endsWith('.mim')) rows.push({ relative: path.relative(root, absolute).replaceAll(path.sep, '/'), absolute });
    }
  }
  walk(root);
  return rows;
}

function digest(rows) {
  return crypto.createHash('sha256').update(rows.map((row) => {
    const hash = crypto.createHash('sha256').update(fs.readFileSync(row.absolute)).digest('hex');
    return `${row.relative} ${hash}\n`;
  }).join('')).digest('hex');
}

function summarize(root) {
  const rows = files(root);
  const byDirectory = {};
  const types = {};
  let prompts = 0;
  let malformed = 0;
  const ids = new Set();
  for (const row of rows) {
    const directory = row.relative.split('/')[0];
    byDirectory[directory] = (byDirectory[directory] || 0) + 1;
    try {
      const mim = JSON.parse(fs.readFileSync(row.absolute, 'utf8'));
      types[mim.mim_type] = (types[mim.mim_type] || 0) + 1;
      prompts += Array.isArray(mim.prompts) ? mim.prompts.length : 0;
      if (mim.mim_id) ids.add(mim.mim_id);
    } catch {
      malformed += 1;
    }
  }
  const sourceIds = rows.map((row) => row.relative.replace(/^[^/]+\//, '').replace(/\.mim$/, '')).sort();
  return {
    root,
    files: rows.length,
    byDirectory,
    types,
    prompts,
    malformed,
    embeddedMimIds: ids.size,
    idDigest: crypto.createHash('sha256').update(JSON.stringify(sourceIds)).digest('hex'),
    treeDigest: digest(rows),
  };
}

const sourceSummary = summarize(source);
const candidateSummary = summarize(candidate);
const result = {
  schemaVersion: 1,
  runnerSha256: crypto.createHash('sha256').update(fs.readFileSync(new URL(import.meta.url))).digest('hex'),
  sourceRevision: '5c0a7390539663ba749d360de348a428c088505c',
  source: sourceSummary,
  candidate: candidateSummary,
  allAnnouncement: [sourceSummary, candidateSummary].every((item) => item.files === 4424 && item.malformed === 0 && item.types.announcement === 4424 && Object.keys(item.types).length === 1),
  sameTree: sourceSummary.files === candidateSummary.files && sourceSummary.treeDigest === candidateSummary.treeDigest,
};
fs.writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({
  source: { files: sourceSummary.files, byDirectory: sourceSummary.byDirectory, types: sourceSummary.types, prompts: sourceSummary.prompts, treeDigest: sourceSummary.treeDigest },
  candidate: { files: candidateSummary.files, byDirectory: candidateSummary.byDirectory, types: candidateSummary.types, prompts: candidateSummary.prompts, treeDigest: candidateSummary.treeDigest },
  allAnnouncement: result.allAnnouncement,
  sameTree: result.sameTree,
}));
if (!result.allAnnouncement || !result.sameTree) process.exitCode = 1;
