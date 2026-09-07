#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { VectorStandardFst } from '../src/compiledFst.js';
import {
  FST_SNAPSHOT_SCHEMA,
  FST_SNAPSHOT_VERSION,
  serializeFstSnapshot,
  stringifyFstSnapshot,
} from '../src/compiledFstSnapshot.js';
import { COMPILED_FST_PROFILE, FST_PROFILE_SCHEMA, FST_PROFILE_VERSION } from '../src/compiledFstProfile.js';

function usage() {
  console.error('usage: exportCompiledFstSnapshots.mjs --inventory FILE --rules-dir DIR --factory-dir DIR --output DIR');
  process.exitCode = 2;
}

function args(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--help') usage();
    if (!value.startsWith('--') || index + 1 >= argv.length) usage();
    result[value.slice(2)] = argv[++index];
  }
  if (!result.inventory || !result['rules-dir'] || !result['factory-dir'] || !result.output) usage();
  return result;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function manifestHash(entries, names, sourceField = 'sourceSha256', pathField = 'sourcePath') {
  const hash = createHash('sha256');
  for (const name of names) {
    const entry = entries[name];
    hash.update(name);
    hash.update('\0');
    if (pathField) {
      hash.update(entry[pathField]);
      hash.update('\0');
    }
    hash.update(Buffer.from(entry[sourceField], 'hex'));
  }
  return hash.digest('hex');
}

function writeJson(path, value) {
  const bytes = Buffer.from(JSON.stringify(value) + '\n');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  return { path, sha256: sha256(bytes), bytes: bytes.length };
}

const options = args(process.argv.slice(2));
const inventoryPath = resolve(options.inventory);
const rulesDir = resolve(options['rules-dir']);
const factoryDir = resolve(options['factory-dir']);
const outputDir = resolve(options.output);
const inventoryBytes = readFileSync(inventoryPath);
const inventorySha256 = sha256(inventoryBytes);
const inventory = JSON.parse(inventoryBytes.toString('utf8'));
if (inventory.referenceRevision !== COMPILED_FST_PROFILE.referenceRevision) {
  throw new Error(`inventory reference revision mismatch: ${inventory.referenceRevision}`);
}
if (inventorySha256 !== COMPILED_FST_PROFILE.approvedInventorySha256) {
  throw new Error(`inventory hash mismatch: ${inventorySha256}`);
}

const graphs = {};
for (const [name, entry] of Object.entries(inventory.publicRules || {})) {
  const sourcePath = entry.compiledPath;
  const sourceFile = join(rulesDir, sourcePath);
  const sourceBytes = readFileSync(sourceFile);
  const sourceSha256 = sha256(sourceBytes);
  if (sourceSha256 !== entry.sha256) throw new Error(`graph source hash mismatch: ${name}`);
  const fst = VectorStandardFst.fromFile(sourceFile);
  const snapshot = serializeFstSnapshot(fst, {
    sourcePath,
    sourceSha256,
    sourceBytes: sourceBytes.length,
  });
  const outputPath = `graphs/${sourcePath.replace(/\.fst$/, '.json')}`;
  const written = writeJson(join(outputDir, outputPath), JSON.parse(stringifyFstSnapshot(snapshot)));
  graphs[name] = {
    path: outputPath,
    sourcePath,
    sourceSha256,
    sourceBytes: sourceBytes.length,
    snapshotSha256: written.sha256,
    snapshotBytes: written.bytes,
  };
  process.stdout.write(`graph ${name} ${sourceBytes.length} -> ${written.bytes}\n`);
}

const factories = {};
const factoryFiles = {};
for (const [fileName, expectedSourceSha256] of Object.entries(COMPILED_FST_PROFILE.factoryFiles).sort(([left], [right]) => left.localeCompare(right))) {
  const name = fileName.replace(/\.fst$/, '');
  const inventoryEntry = inventory.factoryDependencies?.[name];
  const sourcePath = inventoryEntry?.referencePath || `build/data/en-us/factory_rules/${fileName}`;
  // The caller's factory directory is the directory containing the basename
  // files. Keep the source label from the pinned inventory while resolving the
  // actual input from that directory.
  const factoryFile = join(factoryDir, fileName);
  const sourceBytes = readFileSync(factoryFile);
  const sourceSha256 = sha256(sourceBytes);
  if (sourceSha256 !== expectedSourceSha256) throw new Error(`factory source hash mismatch: ${name}`);
  const fileEntry = {
    sourcePath,
    sourceSha256,
    sourceBytes: sourceBytes.length,
    kind: fileName.endsWith('.fst') ? 'fst' : 'auxiliary',
  };
  factoryFiles[fileName] = fileEntry;
  if (fileName.endsWith('.fst')) {
    const fst = VectorStandardFst.fromFile(factoryFile);
    const snapshot = serializeFstSnapshot(fst, {
      sourcePath,
      sourceSha256,
      sourceBytes: sourceBytes.length,
    });
    const outputPath = `factories/${name}.json`;
    const written = writeJson(join(outputDir, outputPath), JSON.parse(stringifyFstSnapshot(snapshot)));
    factories[name] = {
      kind: 'fst',
      path: outputPath,
      sourcePath,
      sourceSha256,
      sourceBytes: sourceBytes.length,
      snapshotSha256: written.sha256,
      snapshotBytes: written.bytes,
    };
    process.stdout.write(`factory ${name} ${sourceBytes.length} -> ${written.bytes}\n`);
  } else {
    process.stdout.write(`factory auxiliary ${fileName} ${sourceBytes.length}\n`);
  }
}

const graphNames = Object.keys(graphs);
const factoryNames = Object.keys(factories).sort();
const ruleManifestSha256 = manifestHash(graphs, graphNames, 'sourceSha256', 'sourcePath');
const factoryManifestSha256 = (() => {
  const hash = createHash('sha256');
  for (const name of Object.keys(factoryFiles).sort()) {
    hash.update(name);
    hash.update('\0');
    hash.update(Buffer.from(factoryFiles[name].sourceSha256, 'hex'));
  }
  return hash.digest('hex');
})();
if (factoryManifestSha256 !== COMPILED_FST_PROFILE.factoryManifestSha256) {
  throw new Error(`factory manifest hash mismatch: ${factoryManifestSha256}`);
}
if (graphs.launch?.sourceSha256 !== COMPILED_FST_PROFILE.approvedLaunchSha256) {
  throw new Error('launch graph is not the approved profile artifact');
}

const manifest = {
  schema: FST_PROFILE_SCHEMA,
  version: FST_PROFILE_VERSION,
  kind: 'compiled-fst-profile',
  format: { schema: FST_SNAPSHOT_SCHEMA, version: FST_SNAPSHOT_VERSION },
  profile: {
    runtime: COMPILED_FST_PROFILE.runtime,
    approvedLaunchSha256: COMPILED_FST_PROFILE.approvedLaunchSha256,
    approvedInventorySha256: COMPILED_FST_PROFILE.approvedInventorySha256,
    sourceRevision: COMPILED_FST_PROFILE.sourceRevision,
    referenceRevision: COMPILED_FST_PROFILE.referenceRevision,
    sourceRuntime: COMPILED_FST_PROFILE.sourceRuntime,
    nativeParserSha256: COMPILED_FST_PROFILE.nativeParserSha256,
    factoryManifestSha256,
    ruleManifestSha256,
  },
  inventory: {
    referenceRevision: inventory.referenceRevision,
    sha256: inventorySha256,
    publicRuleCount: graphNames.length,
    factoryCount: factoryNames.length,
  },
  ruleManifestSha256,
  factoryManifestSha256,
  graphs,
  factories,
  factoryFiles,
};
const manifestPath = join(outputDir, 'profile.json');
const manifestWritten = writeJson(manifestPath, manifest);
process.stdout.write(JSON.stringify({
  manifest: manifestPath,
  manifestSha256: manifestWritten.sha256,
  graphCount: graphNames.length,
  factoryCount: factoryNames.length,
  ruleManifestSha256,
  factoryManifestSha256,
}) + '\n');
