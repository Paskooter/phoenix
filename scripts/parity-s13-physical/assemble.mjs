#!/usr/bin/env node

/**
 * Assemble a receipt from a capture manifest without allowing a producer to
 * choose row order or silently omit a matrix row.  The manifest contains the
 * runtime/provenance/preflight data and one captured row per matrix ID; the
 * validator remains the authority for artifact bytes and semantic bindings.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DEFAULT_MATRIX_PATH, canonicalSha256, matrixInventory, matrixSha256 } from './validate.mjs';

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function assembleReceipt(matrix, manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('capture manifest must be an object');
  if (!Array.isArray(manifest.cases)) throw new Error('capture manifest must contain cases');
  const byId = new Map();
  for (const row of manifest.cases) {
    if (!row || typeof row.id !== 'string') throw new Error('capture manifest row must have an id');
    if (byId.has(row.id)) throw new Error(`capture manifest duplicates case ${row.id}`);
    byId.set(row.id, row);
  }
  const ordered = matrix.cases.map((descriptor) => {
    const row = byId.get(descriptor.id);
    if (!row) throw new Error(`capture manifest is missing case ${descriptor.id}`);
    return { ...row, ordinal: descriptor.ordinal, id: descriptor.id };
  });
  if (byId.size !== matrix.cases.length) {
    const extras = [...byId.keys()].filter((id) => !matrix.cases.some((descriptor) => descriptor.id === id));
    if (extras.length) throw new Error(`capture manifest contains unknown cases: ${extras.join(', ')}`);
  }
  return {
    ...manifest,
    schema: 'phoenix.parity.s13.physical-capture-receipt',
    schemaVersion: 1,
    task: 'S-13',
    claim: 'physical-display-only',
    matrix: {
      path: 'scripts/parity-s13-physical/matrix.json',
      sha256: matrix.integrity?.matrixSha256 || matrixSha256(matrix),
      inventorySha256: matrix.integrity?.caseInventorySha256 || canonicalSha256(matrixInventory(matrix)),
      baseRevision: matrix.baseRevision,
      caseCount: matrix.cases.length,
      orderedCaseIds: matrix.cases.map((descriptor) => descriptor.id)
    },
    cases: ordered
  };
}

function main(argv = process.argv.slice(2)) {
  const args = { matrix: DEFAULT_MATRIX_PATH, input: null, out: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--matrix') args.matrix = path.resolve(argv[++i]);
    else if (argv[i] === '--out') args.out = path.resolve(argv[++i]);
    else if (!args.input) args.input = path.resolve(argv[i]);
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  if (!args.input || !args.out) throw new Error('usage: assemble.mjs [--matrix PATH] --out RECEIPT.json CAPTURE-MANIFEST.json');
  const receipt = assembleReceipt(readJson(args.matrix), readJson(args.input));
  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, `${JSON.stringify(receipt, null, 2)}\n`);
  return 0;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === pathToFileURL(path.join(here, 'assemble.mjs')).href) {
  try { process.exitCode = main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
