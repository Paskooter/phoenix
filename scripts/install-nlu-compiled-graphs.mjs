#!/usr/bin/env node

// Install the original production 98-rule VectorFST tree as the closed Phoenix
// compiled profile. The original offline step is pegasus
// packages/parser/src/cli/build-rules.ts: grm2fst every rules_src/**/*.rule,
// UNION every */launch handle, SAVE rules_fst/launch.fst, delete per-skill
// launch files. Phoenix does not reimplement grm2fst or OpenFST UNION; this
// installer copies already-built graphs after checking them against the
// tracked inventory hashes.

import { createHash } from 'node:crypto';
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { COMPILED_FST_PROFILE } from '../packages/nlu/src/compiledFstProfile.js';
import {
  COMPILED_FST_INSTALL_KIND,
  COMPILED_FST_INSTALL_SCHEMA,
  COMPILED_FST_INSTALL_VERSION,
} from '../packages/nlu/src/compiledFstHome.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const INVENTORY_PATH = join(REPO_ROOT, 'packages/nlu/resources/rule-inventory.json');
const INSTALLER_VERSION = 1;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function die(message) {
  throw new Error(`NLU compiled-graph install: ${message}`);
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
  console.error('usage: install-nlu-compiled-graphs.mjs --rules-dir DIR --factory-dir DIR --output INSTALL_DIR');
  console.error('       DIR --rules-dir is the original robust-parser directory (contains rules_fst/).');
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
    if (key !== 'rules-dir' && key !== 'factory-dir' && key !== 'output') {
      console.error(`unknown option: ${value}`);
      usage();
      return null;
    }
    result[key] = argv[++index];
  }
  if (!result['rules-dir'] || !result['factory-dir'] || !result.output) {
    usage();
    return null;
  }
  return {
    rulesDir: result['rules-dir'],
    factoryDir: result['factory-dir'],
    output: result.output,
  };
}

function regularDirectory(path, label) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    die(`${label} is unavailable: ${error.message}`);
  }
  if (stat.isSymbolicLink()) die(`${label} cannot be a symbolic link`);
  if (!stat.isDirectory()) die(`${label} must be a directory`);
}

function regularFile(path, label) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    die(`${label} is unavailable: ${error.message}`);
  }
  if (stat.isSymbolicLink()) die(`${label} cannot be a symbolic link`);
  if (!stat.isFile()) die(`${label} must be a regular file`);
}

function inside(root, value, label) {
  const artifactPath = resolve(root, ...String(value).split('/'));
  const rel = relative(root, artifactPath);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    die(`${label} path escapes the install directory`);
  }
  return artifactPath;
}

function approvedInventory() {
  let bytes;
  try {
    bytes = readFileSync(INVENTORY_PATH);
  } catch (error) {
    die(`tracked rule inventory cannot be read: ${error.message}`);
  }
  const digest = sha256(bytes);
  if (digest !== COMPILED_FST_PROFILE.approvedInventorySha256) {
    die('tracked rule inventory does not match the approved profile');
  }
  let value;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    die(`tracked rule inventory is not valid JSON: ${error.message}`);
  }
  if (!value || value.referenceRevision !== COMPILED_FST_PROFILE.referenceRevision
    || !value.publicRules || typeof value.publicRules !== 'object') {
    die('tracked rule inventory provenance is unsupported');
  }
  return { value, digest };
}

function copyCheckedFile(source, destination, expectedSha256, label) {
  regularFile(source, label);
  const bytes = readFileSync(source);
  const actual = sha256(bytes);
  if (actual !== expectedSha256) die(`${label} hash mismatch: ${source}`);
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(source, destination);
  return { bytes: bytes.length, sha256: actual };
}

function validateAndStage({ rulesDir, factoryDir, staging }) {
  const inventory = approvedInventory();
  const publicRules = inventory.value.publicRules;
  const graphs = [];
  for (const [name, entry] of Object.entries(publicRules)) {
    if (!entry || typeof entry.compiledPath !== 'string' || typeof entry.sha256 !== 'string') {
      die(`inventory entry is incomplete: ${name}`);
    }
    const source = join(rulesDir, entry.compiledPath);
    const destination = inside(staging, entry.compiledPath, `graph ${name}`);
    const copied = copyCheckedFile(source, destination, entry.sha256, `graph ${name}`);
    graphs.push({ name, compiledPath: entry.compiledPath, ...copied });
  }
  const launch = publicRules.launch;
  if (!launch || launch.sha256 !== COMPILED_FST_PROFILE.approvedLaunchSha256) {
    die('inventory launch graph is not the approved artifact');
  }
  const factories = [];
  for (const [fileName, expectedSha256] of Object.entries(COMPILED_FST_PROFILE.factoryFiles)) {
    const source = join(factoryDir, fileName);
    const destination = inside(staging, `factories/${fileName}`, `factory ${fileName}`);
    const copied = copyCheckedFile(source, destination, expectedSha256, `factory ${fileName}`);
    factories.push({ name: fileName, ...copied });
  }
  const receipt = {
    schema: COMPILED_FST_INSTALL_SCHEMA,
    version: COMPILED_FST_INSTALL_VERSION,
    kind: COMPILED_FST_INSTALL_KIND,
    runtime: COMPILED_FST_PROFILE.runtime,
    profile: {
      approvedLaunchSha256: COMPILED_FST_PROFILE.approvedLaunchSha256,
      approvedInventorySha256: COMPILED_FST_PROFILE.approvedInventorySha256,
      factoryManifestSha256: COMPILED_FST_PROFILE.factoryManifestSha256,
      sourceRevision: COMPILED_FST_PROFILE.sourceRevision,
      referenceRevision: COMPILED_FST_PROFILE.referenceRevision,
      sourceRuntime: COMPILED_FST_PROFILE.sourceRuntime,
      nativeParserSha256: COMPILED_FST_PROFILE.nativeParserSha256,
    },
    inventory: {
      referenceRevision: inventory.value.referenceRevision,
      sha256: inventory.digest,
      publicRuleCount: Object.keys(publicRules).length,
      factoryFileCount: Object.keys(COMPILED_FST_PROFILE.factoryFiles).length,
    },
    layout: {
      launch: launch.compiledPath,
      rulesDir: '.',
      factoryDir: 'factories',
    },
  };
  writeFileSync(join(staging, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);
  return {
    receipt,
    graphCount: graphs.length,
    factoryFileCount: factories.length,
    payloadBytes: graphs.reduce((total, entry) => total + entry.bytes, 0)
      + factories.reduce((total, entry) => total + entry.bytes, 0),
  };
}

function verifyWithRuntime(home) {
  const runtimeUrl = pathToFileURL(join(REPO_ROOT, 'packages/nlu/src/compiledFstRuntime.js')).href;
  const childEnv = { ...process.env };
  for (const key of Object.keys(childEnv)) {
    if (key.startsWith('PHOENIX_NLU_')) delete childEnv[key];
  }
  childEnv.PHOENIX_NLU_RUNTIME = 'compiled-fst';
  childEnv.PHOENIX_NLU_COMPILED_HOME = home;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import { getCompiledFstRuntime, compiledFstRuntimeConfig } from ${JSON.stringify(runtimeUrl)}; `
      + `const runtime = getCompiledFstRuntime(); `
      + `if (!runtime || runtime.ruleCount !== 98 || runtime.acquisition !== 'approved-binary') process.exit(1); `
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

export function installNluCompiledGraphs({ rulesDir, factoryDir, output }) {
  const rulesRoot = resolve(rulesDir);
  const factoryRoot = resolve(factoryDir);
  const outputRoot = resolve(output);
  regularDirectory(rulesRoot, 'rules-dir');
  regularDirectory(factoryRoot, 'factory-dir');
  if (pathExists(outputRoot)) die(`output already exists; choose a new versioned path: ${outputRoot}`);
  mkdirSync(dirname(outputRoot), { recursive: true });
  const staging = mkdtempSync(join(dirname(outputRoot), `.${basename(outputRoot)}.staging-`));
  try {
    const staged = validateAndStage({ rulesDir: rulesRoot, factoryDir: factoryRoot, staging });
    const metadata = verifyWithRuntime(staging);
    if (pathExists(outputRoot)) die(`output appeared during installation: ${outputRoot}`);
    renameSync(staging, outputRoot);
    if (metadata.compiledHome) metadata.compiledHome = outputRoot;
    if (metadata.fstPath) metadata.fstPath = join(outputRoot, staged.receipt.layout.launch);
    if (metadata.factoryDir) metadata.factoryDir = join(outputRoot, staged.receipt.layout.factoryDir);
    if (metadata.rulesDir) metadata.rulesDir = outputRoot;
    return {
      installer: INSTALLER_VERSION,
      verified: true,
      runtime: 'compiled-fst',
      acquisition: 'approved-binary',
      output: outputRoot,
      receipt: join(outputRoot, 'receipt.json'),
      graphCount: staged.graphCount,
      factoryFileCount: staged.factoryFileCount,
      payloadBytes: staged.payloadBytes,
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
      process.stdout.write(`${JSON.stringify(installNluCompiledGraphs(options))}\n`);
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
