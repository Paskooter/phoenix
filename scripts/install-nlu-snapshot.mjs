#!/usr/bin/env node

// Install a prebuilt, portable compiled-FST bundle. The source side may use the
// archived native compiler/parser when exporting the bundle; this target-side
// installer only copies JSON/gzip data and verifies it with Phoenix's portable
// loader. The destination contains no private source paths or native binaries.

import { createHash } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { dirname, basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  COMPILED_FST_PROFILE,
  FST_PROFILE_SCHEMA,
  FST_PROFILE_VERSION,
} from '../packages/nlu/src/compiledFstProfile.js';
import {
  FST_SNAPSHOT_SCHEMA,
  FST_SNAPSHOT_VERSION,
} from '../packages/nlu/src/compiledFstSnapshot.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const INVENTORY_PATH = join(REPO_ROOT, 'packages/nlu/resources/rule-inventory.json');
const INSTALLER_VERSION = 1;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function die(message) {
  throw new Error(`NLU snapshot install: ${message}`);
}

function pathExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function usage() {
  console.error('usage: install-nlu-snapshot.mjs --input BUNDLE_DIR --output INSTALL_DIR');
  console.error('       BUNDLE_DIR contains profile.json and its declared JSON/JSON.GZ files.');
  process.exitCode = 2;
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--help' || value === '-h') {
      usage();
      return null;
    }
    if (!value.startsWith('--') || index + 1 >= argv.length) {
      usage();
      return null;
    }
    const key = value.slice(2);
    if (key !== 'input' && key !== 'output') {
      console.error(`unknown option: ${value}`);
      usage();
      return null;
    }
    result[key] = argv[++index];
  }
  if (!result.input || !result.output) {
    usage();
    return null;
  }
  return result;
}

function readJson(path, label) {
  let bytes;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    die(`${label} cannot be read: ${error.message}`);
  }
  try {
    return { bytes, value: JSON.parse(bytes.toString('utf8')) };
  } catch (error) {
    die(`${label} is not valid JSON: ${error.message}`);
  }
}

function regularFile(path, label) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    die(`${label} is unavailable: ${error.message}`);
  }
  if (!stat.isFile()) die(`${label} must be a regular file`);
}

function rejectSymlinkPath(root, relativePath, label) {
  let current = root;
  for (const part of relativePath.split('/')) {
    current = join(current, part);
    let stat;
    try { stat = lstatSync(current); }
    catch (error) { die(`${label} is unavailable: ${error.message}`); }
    if (stat.isSymbolicLink()) die(`${label} cannot use symbolic links`);
  }
}

function relativeBundlePath(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')
    || value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value)
    || value.includes('\\')) {
    die(`${label} path must use a relative POSIX path`);
  }
  const parts = value.split('/');
  if (parts.some(part => part.length === 0 || part === '.' || part === '..')) {
    die(`${label} path contains an unsafe segment`);
  }
  return value;
}

function inside(root, value, label) {
  const artifactPath = resolve(root, ...value.split('/'));
  const rel = relative(root, artifactPath);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    die(`${label} path escapes the bundle directory`);
  }
  return artifactPath;
}

function sameKeys(actual, expected, label) {
  if (!actual || typeof actual !== 'object' || Array.isArray(actual)) {
    die(`${label} is malformed`);
  }
  const left = Object.keys(actual || {}).sort();
  const right = [...expected].sort();
  if (left.length !== right.length || left.some((key, index) => key !== right[index])) {
    die(`${label} does not contain the approved complete set`);
  }
}

function approvedInventory() {
  const { bytes, value } = readJson(INVENTORY_PATH, 'tracked rule inventory');
  const digest = sha256(bytes);
  if (digest !== COMPILED_FST_PROFILE.approvedInventorySha256) {
    die('tracked rule inventory does not match the approved profile');
  }
  if (!value || value.referenceRevision !== COMPILED_FST_PROFILE.referenceRevision
    || !value.publicRules || typeof value.publicRules !== 'object') {
    die('tracked rule inventory provenance is unsupported');
  }
  return { value, digest };
}

function validHash(value, label) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) die(`${label} hash is invalid`);
}

function validBytes(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) die(`${label} byte count is invalid`);
}

function verifyStoredPayload(root, entry, label, storage) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) die(`${label} entry is malformed`);
  const pathValue = relativeBundlePath(entry.path, `${label} artifact`);
  const path = inside(root, pathValue, label);
  rejectSymlinkPath(root, pathValue, `${label} artifact`);
  regularFile(path, `${label} artifact`);
  const stored = readFileSync(path);
  const compression = entry.compression || 'json';
  if (compression !== storage) die(`${label} storage does not match the profile`);
  let decoded = stored;
  if (storage === 'gzip') {
    validHash(entry.storedSha256, `${label} stored`);
    validBytes(entry.storedBytes, `${label} stored`);
    if (sha256(stored) !== entry.storedSha256 || stored.length !== entry.storedBytes) {
      die(`${label} stored hash or size does not match`);
    }
    try {
      decoded = gunzipSync(stored);
    } catch (error) {
      die(`${label} gzip cannot be decoded: ${error.message}`);
    }
  }
  validHash(entry.snapshotSha256, `${label} decoded`);
  validBytes(entry.snapshotBytes, `${label} decoded`);
  if (sha256(decoded) !== entry.snapshotSha256 || decoded.length !== entry.snapshotBytes) {
    die(`${label} decoded hash or size does not match`);
  }
  return { pathValue, path, storedBytes: stored.length, decodedBytes: decoded.length };
}

function profileIdentity(manifest, inventory) {
  if (!manifest || manifest.schema !== FST_PROFILE_SCHEMA
    || manifest.version !== FST_PROFILE_VERSION
    || manifest.kind !== 'compiled-fst-profile') {
    die('profile schema or version is unsupported');
  }
  const format = manifest.format;
  if (!format || format.schema !== FST_SNAPSHOT_SCHEMA || format.version !== FST_SNAPSHOT_VERSION
    || !['json', 'gzip'].includes(format.storage)) {
    die('profile storage format is unsupported');
  }
  const profile = manifest.profile;
  if (!profile || profile.runtime !== COMPILED_FST_PROFILE.runtime
    || profile.approvedLaunchSha256 !== COMPILED_FST_PROFILE.approvedLaunchSha256
    || profile.approvedInventorySha256 !== COMPILED_FST_PROFILE.approvedInventorySha256
    || profile.sourceRevision !== COMPILED_FST_PROFILE.sourceRevision
    || profile.referenceRevision !== COMPILED_FST_PROFILE.referenceRevision
    || profile.sourceRuntime !== COMPILED_FST_PROFILE.sourceRuntime
    || profile.nativeParserSha256 !== COMPILED_FST_PROFILE.nativeParserSha256
    || profile.factoryManifestSha256 !== COMPILED_FST_PROFILE.factoryManifestSha256
    || profile.decodedHashAnchorSha256 !== COMPILED_FST_PROFILE.decodedHashAnchorSha256) {
    die('profile provenance is not the approved portable profile');
  }
  if (!manifest.inventory || manifest.inventory.referenceRevision !== inventory.value.referenceRevision
    || manifest.inventory.sha256 !== inventory.digest
    || manifest.inventory.publicRuleCount !== Object.keys(inventory.value.publicRules).length
    || manifest.inventory.factoryCount !== Object.keys(COMPILED_FST_PROFILE.factoryFiles)
      .filter(name => name.endsWith('.fst')).length) {
    die('profile inventory metadata is incomplete or changed');
  }
  return format.storage;
}

function validateBundle(inputRoot) {
  if (!pathExists(inputRoot)) die(`input bundle is unavailable: ${inputRoot}`);
  if (!lstatSync(inputRoot).isDirectory()) die(`input bundle is not a directory: ${inputRoot}`);
  const profilePath = join(inputRoot, 'profile.json');
  rejectSymlinkPath(inputRoot, 'profile.json', 'profile.json');
  regularFile(profilePath, 'profile.json');
  const { bytes: profileBytes, value: manifest } = readJson(profilePath, 'profile.json');
  const inventory = approvedInventory();
  const storage = profileIdentity(manifest, inventory);
  const graphNames = Object.keys(inventory.value.publicRules);
  const factoryNames = Object.keys(COMPILED_FST_PROFILE.factoryFiles)
    .filter(name => name.endsWith('.fst')).map(name => name.slice(0, -4));
  const factoryFileNames = Object.keys(COMPILED_FST_PROFILE.factoryFiles);
  sameKeys(manifest.graphs, graphNames, 'profile graphs');
  sameKeys(manifest.factories, factoryNames, 'profile factories');
  sameKeys(manifest.factoryFiles, factoryFileNames, 'profile factory files');

  const entries = [];
  const usedPaths = new Set(['profile.json']);
  for (const name of graphNames) {
    const entry = manifest.graphs[name];
    const checked = verifyStoredPayload(inputRoot, entry, `graph ${name}`, storage);
    if (usedPaths.has(checked.pathValue)) die(`graph ${name} reuses a declared artifact path`);
    usedPaths.add(checked.pathValue);
    if (typeof entry.sourcePath !== 'string' || entry.sourcePath.length === 0) {
      die(`graph ${name} source provenance is incomplete`);
    }
    validHash(entry.sourceSha256, `graph ${name} source`);
    validBytes(entry.sourceBytes, `graph ${name} source`);
    entries.push({ kind: 'graph', name, ...checked });
  }
  for (const name of factoryNames) {
    const entry = manifest.factories[name];
    if (entry.kind !== 'fst') die(`factory ${name} is not an FST entry`);
    const checked = verifyStoredPayload(inputRoot, entry, `factory ${name}`, storage);
    if (usedPaths.has(checked.pathValue)) die(`factory ${name} reuses a declared artifact path`);
    usedPaths.add(checked.pathValue);
    if (typeof entry.sourcePath !== 'string' || entry.sourcePath.length === 0) {
      die(`factory ${name} source provenance is incomplete`);
    }
    validHash(entry.sourceSha256, `factory ${name} source`);
    validBytes(entry.sourceBytes, `factory ${name} source`);
    entries.push({ kind: 'factory', name, ...checked });
  }
  return {
    manifest,
    profileBytes,
    profilePath,
    storage,
    entries,
    graphCount: graphNames.length,
    factoryCount: factoryNames.length,
    factoryFileCount: factoryFileNames.length,
  };
}

function copyBundle(bundle, outputRoot) {
  mkdirSync(outputRoot, { recursive: true });
  writeFileSync(join(outputRoot, 'profile.json'), bundle.profileBytes);
  for (const entry of bundle.entries) {
    const destination = inside(outputRoot, entry.pathValue, `${entry.kind} ${entry.name}`);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, readFileSync(entry.path));
  }
}

function verifyWithRuntime(manifestPath) {
  const runtimeUrl = pathToFileURL(join(REPO_ROOT, 'packages/nlu/src/compiledFstRuntime.js')).href;
  const childEnv = { ...process.env };
  for (const key of Object.keys(childEnv)) {
    if (key.startsWith('PHOENIX_NLU_')) delete childEnv[key];
  }
  childEnv.PHOENIX_NLU_RUNTIME = 'compiled-fst';
  childEnv.PHOENIX_NLU_COMPILED_SNAPSHOT_MANIFEST = manifestPath;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import { getCompiledFstRuntime, compiledFstRuntimeConfig } from ${JSON.stringify(runtimeUrl)}; `
      + `const runtime = getCompiledFstRuntime(); `
      + `if (!runtime || runtime.ruleCount !== 98 || runtime.executor.factoryFsts.size !== 15) process.exit(1); `
      + `process.stdout.write(JSON.stringify(compiledFstRuntimeConfig()));`],
  { cwd: REPO_ROOT, env: childEnv, encoding: 'utf8', timeout: 120000 });
  if (result.error) die(`runtime verification failed to start: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim().slice(-1000);
    die(`runtime verification failed${detail ? `: ${detail}` : ''}`);
  }
  let metadata;
  try { metadata = JSON.parse(result.stdout); }
  catch (error) { die(`runtime verification returned invalid metadata: ${error.message}`); }
  return metadata;
}

export function installNluSnapshot({ input, output }) {
  const inputRoot = resolve(input);
  const outputRoot = resolve(output);
  if (pathExists(outputRoot)) die(`output already exists; choose a new versioned path: ${outputRoot}`);
  const bundle = validateBundle(inputRoot);
  mkdirSync(dirname(outputRoot), { recursive: true });
  const staging = mkdtempSync(join(dirname(outputRoot), `.${basename(outputRoot)}.staging-`));
  try {
    copyBundle(bundle, staging);
    const metadata = verifyWithRuntime(join(staging, 'profile.json'));
    if (pathExists(outputRoot)) die(`output appeared during installation: ${outputRoot}`);
    renameSync(staging, outputRoot);
    // The loader validates the staging tree before the atomic rename. Expose
    // the stable installed path in the receipt rather than the temporary path
    // that was used for that validation.
    metadata.snapshotManifest = join(outputRoot, 'profile.json');
    return {
      installer: INSTALLER_VERSION,
      verified: true,
      runtime: 'compiled-fst',
      storage: bundle.storage,
      input: inputRoot,
      output: outputRoot,
      manifest: join(outputRoot, 'profile.json'),
      manifestSha256: sha256(bundle.profileBytes),
      graphCount: bundle.graphCount,
      factoryCount: bundle.factoryCount,
      factoryFileCount: bundle.factoryFileCount,
      payloadBytes: bundle.entries.reduce((total, entry) => total + entry.storedBytes, 0),
      decodedBytes: bundle.entries.reduce((total, entry) => total + entry.decodedBytes, 0),
      runtimeMetadata: metadata,
    };
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

const entrypoint = pathToFileURL(process.argv[1] || '').href;
if (import.meta.url === entrypoint) {
  const options = parseArgs(process.argv.slice(2));
  if (options) {
    try {
      process.stdout.write(`${JSON.stringify(installNluSnapshot(options))}\n`);
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
