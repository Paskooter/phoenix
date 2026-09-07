// Explicit, opt-in bridge from the archived native public-rule graphs into the HTTP
// request parser. The normal Phoenix path never loads these graphs: the
// request parser remains AST-backed unless PHOENIX_NLU_RUNTIME is exactly
// "compiled-fst" and all pinned artifact settings are present.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConnectedFstExecutor } from './connectedFst.js';
import { VectorStandardFst } from './compiledFst.js';
import { interpretOutputSymbols } from './compiledFstInterpreter.js';
import { FST_SNAPSHOT_SCHEMA, FST_SNAPSHOT_VERSION, parseFstSnapshot } from './compiledFstSnapshot.js';
import { COMPILED_FST_PROFILE, FST_PROFILE_SCHEMA, FST_PROFILE_VERSION } from './compiledFstProfile.js';

const ENABLED = COMPILED_FST_PROFILE.runtime;
const APPROVED_LAUNCH_SHA256 = COMPILED_FST_PROFILE.approvedLaunchSha256;
const APPROVED_INVENTORY_SHA256 = COMPILED_FST_PROFILE.approvedInventorySha256;
const RESOURCE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'resources');
const INVENTORY_PATH = join(RESOURCE_ROOT, 'rule-inventory.json');

// These identities describe the only archived graph profile this adapter is
// allowed to execute. They make a replay self-auditing: a graph byte hash
// alone does not identify the compiler/runtime that produced its tags.
const PROVENANCE = Object.freeze({
  sourceRevision: COMPILED_FST_PROFILE.sourceRevision,
  referenceRevision: COMPILED_FST_PROFILE.referenceRevision,
  sourceRuntime: COMPILED_FST_PROFILE.sourceRuntime,
  nativeParserSha256: COMPILED_FST_PROFILE.nativeParserSha256,
  factoryManifestSha256: COMPILED_FST_PROFILE.factoryManifestSha256,
});

let loaded;

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function readFactorySnapshot(factoryDir) {
  const hash = createHash('sha256');
  const files = new Map();
  for (const name of readdirSync(factoryDir).sort()) {
    const path = `${factoryDir}/${name}`;
    const bytes = readFileSync(path);
    hash.update(name);
    hash.update('\0');
    hash.update(Buffer.from(sha256(bytes), 'hex'));
    files.set(name, bytes);
  }
  return { files, manifestSha256: hash.digest('hex') };
}

function readRuleSnapshot(rulesDir) {
  const inventoryBytes = readFileSync(INVENTORY_PATH);
  const inventorySha256 = sha256(inventoryBytes);
  if (inventorySha256 !== APPROVED_INVENTORY_SHA256) {
    throw new Error(`Compiled NLU rule inventory hash mismatch: ${INVENTORY_PATH}`);
  }
  const inventory = JSON.parse(inventoryBytes.toString('utf8'));
  if (inventory.referenceRevision !== PROVENANCE.referenceRevision) {
    throw new Error(`Compiled NLU rule inventory reference mismatch: ${INVENTORY_PATH}`);
  }
  const root = resolve(rulesDir);
  const files = new Map();
  const manifest = createHash('sha256');
  const publicRules = inventory.publicRules || {};
  for (const [name, entry] of Object.entries(publicRules)) {
    if (!entry || typeof entry.compiledPath !== 'string' || typeof entry.sha256 !== 'string') {
      throw new Error(`Compiled NLU rule inventory entry is incomplete: ${name}`);
    }
    const path = resolve(root, entry.compiledPath);
    const rel = relative(root, path);
    if (rel.startsWith('..') || rel.includes(`..${pathSeparator()}`) || rel.startsWith(pathSeparator())) {
      throw new Error(`Compiled NLU rule path escapes the configured graph directory: ${name}`);
    }
    if (!existsSync(path)) throw new Error(`Compiled NLU rule is unavailable: ${path}`);
    const bytes = readFileSync(path);
    const actual = sha256(bytes);
    if (actual !== entry.sha256) throw new Error(`Compiled NLU rule hash mismatch: ${path}`);
    // The manifest is derived from the pinned inventory and every verified file. It is
    // exposed for evidence and makes the selected graph set auditable at startup.
    manifest.update(name);
    manifest.update('\0');
    manifest.update(entry.compiledPath);
    manifest.update('\0');
    manifest.update(actual);
    files.set(name, { bytes, path, compiledPath: entry.compiledPath, sha256: actual });
  }
  return {
    files,
    manifestSha256: manifest.digest('hex'),
    ruleCount: files.size,
    inventoryRevision: inventory.referenceRevision,
    inventorySha256,
  };
}

function safeSnapshotPath(root, relativePath, label) {
  if (typeof relativePath !== 'string' || relativePath.length === 0 || relativePath.startsWith('/')) {
    throw new Error(`Compiled NLU snapshot ${label} path is not relative`);
  }
  const path = resolve(root, relativePath);
  const rel = relative(root, path);
  if (rel.startsWith('..') || rel.includes(`..${pathSeparator()}`) || rel.startsWith(pathSeparator())) {
    throw new Error(`Compiled NLU snapshot ${label} path escapes its manifest directory`);
  }
  return path;
}

function snapshotJson(path, entry, label) {
  const bytes = readFileSync(path);
  const actual = sha256(bytes);
  if (actual !== entry.snapshotSha256) throw new Error(`Compiled NLU snapshot hash mismatch: ${path}`);
  if (bytes.length !== entry.snapshotBytes) throw new Error(`Compiled NLU snapshot size mismatch: ${path}`);
  let document;
  try { document = JSON.parse(bytes.toString('utf8')); }
  catch (error) { throw new Error(`Compiled NLU snapshot JSON is invalid (${label}): ${error.message}`); }
  const fst = parseFstSnapshot(document, { source: path });
  const artifact = fst.artifact || {};
  if (artifact.sourcePath !== entry.sourcePath
    || artifact.sourceSha256 !== entry.sourceSha256
    || artifact.sourceBytes !== entry.sourceBytes) {
    throw new Error(`Compiled NLU snapshot provenance mismatch: ${path}`);
  }
  return { bytes, document, fst, path };
}

function ruleManifestHash(inventory, graphEntries) {
  const hash = createHash('sha256');
  for (const [name, entry] of Object.entries(inventory.publicRules || {})) {
    const graph = graphEntries.get(name);
    hash.update(name);
    hash.update('\0');
    hash.update(entry.compiledPath);
    hash.update('\0');
    hash.update(Buffer.from(graph.sourceSha256, 'hex'));
  }
  return hash.digest('hex');
}

function factoryManifestHash(factoryEntries) {
  const hash = createHash('sha256');
  for (const name of [...factoryEntries.keys()].sort()) {
    hash.update(name);
    hash.update('\0');
    hash.update(Buffer.from(factoryEntries.get(name).sourceSha256, 'hex'));
  }
  return hash.digest('hex');
}

function verifySnapshotProfileIdentity(manifest) {
  if (!manifest || manifest.schema !== FST_PROFILE_SCHEMA || manifest.version !== FST_PROFILE_VERSION
    || manifest.kind !== 'compiled-fst-profile'
    || !manifest.format || manifest.format.schema !== FST_SNAPSHOT_SCHEMA
    || manifest.format.version !== FST_SNAPSHOT_VERSION) {
    throw new Error('Unsupported compiled NLU snapshot profile schema');
  }
  const profile = manifest.profile;
  if (!profile || profile.runtime !== ENABLED
    || profile.approvedLaunchSha256 !== APPROVED_LAUNCH_SHA256
    || profile.approvedInventorySha256 !== APPROVED_INVENTORY_SHA256
    || profile.factoryManifestSha256 !== PROVENANCE.factoryManifestSha256
    || profile.sourceRevision !== PROVENANCE.sourceRevision
    || profile.referenceRevision !== PROVENANCE.referenceRevision
    || profile.sourceRuntime !== PROVENANCE.sourceRuntime
    || profile.nativeParserSha256 !== PROVENANCE.nativeParserSha256) {
    throw new Error('Unsupported compiled NLU snapshot provenance');
  }
}

function readPortableSnapshotProfile(manifestPath) {
  const root = resolve(dirname(manifestPath));
  let manifest;
  try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); }
  catch (error) { throw new Error(`Compiled NLU snapshot profile is invalid: ${error.message}`); }
  verifySnapshotProfileIdentity(manifest);

  const inventoryBytes = readFileSync(INVENTORY_PATH);
  const inventorySha256 = sha256(inventoryBytes);
  if (inventorySha256 !== APPROVED_INVENTORY_SHA256) {
    throw new Error(`Compiled NLU rule inventory hash mismatch: ${INVENTORY_PATH}`);
  }
  const inventory = JSON.parse(inventoryBytes.toString('utf8'));
  if (inventory.referenceRevision !== PROVENANCE.referenceRevision) {
    throw new Error(`Compiled NLU rule inventory reference mismatch: ${INVENTORY_PATH}`);
  }
  if (!manifest.inventory || manifest.inventory.referenceRevision !== inventory.referenceRevision
    || manifest.inventory.sha256 !== inventorySha256
    || manifest.inventory.publicRuleCount !== inventory.publicRuleCount) {
    throw new Error('Compiled NLU snapshot inventory provenance mismatch');
  }

  const graphNames = Object.keys(manifest.graphs || {}).sort();
  const inventoryNames = Object.keys(inventory.publicRules || {}).sort();
  if (graphNames.length !== inventoryNames.length || graphNames.some((name, index) => name !== inventoryNames[index])) {
    throw new Error('Compiled NLU snapshot graph inventory mismatch');
  }
  const graphs = new Map();
  for (const name of inventoryNames) {
    const expected = inventory.publicRules[name];
    const entry = manifest.graphs[name];
    if (!entry || entry.sourcePath !== expected.compiledPath || entry.sourceSha256 !== expected.sha256) {
      throw new Error(`Compiled NLU snapshot graph provenance mismatch: ${name}`);
    }
    const path = safeSnapshotPath(root, entry.path, `graph ${name}`);
    const loaded = snapshotJson(path, entry, `graph ${name}`);
    // Keep the verified JSON bytes for lazy graph construction. The launch
    // graph is large, and retaining 98 decoded object graphs after the
    // provenance pass would needlessly multiply the portable profile's RSS.
    graphs.set(name, { ...entry, bytes: loaded.bytes, path });
  }
  const computedRuleManifest = ruleManifestHash(inventory, graphs);
  if (computedRuleManifest !== manifest.ruleManifestSha256
    || computedRuleManifest !== manifest.profile.ruleManifestSha256) {
    throw new Error('Compiled NLU snapshot graph manifest mismatch');
  }
  const launch = graphs.get('launch');
  if (!launch || launch.sourceSha256 !== APPROVED_LAUNCH_SHA256) {
    throw new Error('Compiled NLU snapshot launch graph is not the approved artifact');
  }

  // The native runtime's factory manifest covers every file in the factory
  // directory, including the two FSTs that are not referenced by the public
  // rule inventory and the auxiliary factory_list.txt.  Keep that directory
  // identity separate from the decoded FST map used by ConnectedFstExecutor.
  const expectedFactoryFiles = Object.entries(COMPILED_FST_PROFILE.factoryFiles)
    .map(([fileName, sourceSha256]) => {
      const factoryName = fileName.endsWith('.fst') ? fileName.slice(0, -4) : null;
      const inventoryEntry = factoryName ? inventory.factoryDependencies?.[factoryName] : undefined;
      return [fileName, {
        sourcePath: inventoryEntry?.referencePath || `build/data/en-us/factory_rules/${fileName}`,
        sourceSha256,
        kind: fileName.endsWith('.fst') ? 'fst' : 'auxiliary',
      }];
    });
  const expectedFactoryFileNames = expectedFactoryFiles.map(([fileName]) => fileName).sort();
  const manifestFactoryFileNames = Object.keys(manifest.factoryFiles || {}).sort();
  if (expectedFactoryFileNames.length !== manifestFactoryFileNames.length
    || expectedFactoryFileNames.some((name, index) => name !== manifestFactoryFileNames[index])) {
    throw new Error('Compiled NLU snapshot factory file inventory mismatch');
  }
  const factoryFiles = new Map();
  for (const [fileName, expected] of expectedFactoryFiles) {
    const entry = manifest.factoryFiles[fileName];
    if (!entry || entry.kind !== expected.kind
      || entry.sourcePath !== expected.sourcePath
      || entry.sourceSha256 !== expected.sourceSha256
      || !Number.isSafeInteger(entry.sourceBytes) || entry.sourceBytes < 0) {
      throw new Error(`Compiled NLU snapshot factory file provenance mismatch: ${fileName}`);
    }
    factoryFiles.set(fileName, entry);
  }
  const factories = new Map();
  const expectedFactoryNames = expectedFactoryFiles
    .filter(([, expected]) => expected.kind === 'fst')
    .map(([fileName]) => fileName.slice(0, -4)).sort();
  const manifestFactoryNames = Object.keys(manifest.factories || {}).sort();
  if (expectedFactoryNames.length !== manifestFactoryNames.length
    || expectedFactoryNames.some((name, index) => name !== manifestFactoryNames[index])) {
    throw new Error('Compiled NLU snapshot factory inventory mismatch');
  }
  for (const name of expectedFactoryNames) {
    const fileName = `${name}.fst`;
    const expected = factoryFiles.get(fileName);
    const entry = manifest.factories[name];
    if (!entry || entry.kind !== 'fst' || entry.sourcePath !== expected.sourcePath
      || entry.sourceSha256 !== expected.sourceSha256
      || entry.sourceBytes !== expected.sourceBytes) {
      throw new Error(`Compiled NLU snapshot factory provenance mismatch: ${name}`);
    }
    const path = safeSnapshotPath(root, entry.path, `factory ${name}`);
    const loaded = snapshotJson(path, entry, `factory ${name}`);
    factories.set(name, { ...entry, bytes: loaded.bytes, document: loaded.document, fst: loaded.fst, path });
  }
  const computedFactoryManifest = factoryManifestHash(factoryFiles);
  if (computedFactoryManifest !== PROVENANCE.factoryManifestSha256
    || computedFactoryManifest !== manifest.factoryManifestSha256
    || computedFactoryManifest !== manifest.profile.factoryManifestSha256) {
    throw new Error('Compiled NLU snapshot factory manifest mismatch');
  }
  return {
    manifest,
    graphs,
    factories,
    factoryFiles,
    inventoryRevision: inventory.referenceRevision,
    inventorySha256,
    ruleManifestSha256: computedRuleManifest,
    factoryManifestSha256: computedFactoryManifest,
  };
}

function pathSeparator() {
  return process.platform === 'win32' ? '\\' : '/';
}

function config() {
  if (process.env.PHOENIX_NLU_RUNTIME !== ENABLED) return null;
  const snapshotManifest = process.env.PHOENIX_NLU_COMPILED_SNAPSHOT_MANIFEST;
  const fstPath = process.env.PHOENIX_NLU_COMPILED_FST;
  const factoryDir = process.env.PHOENIX_NLU_COMPILED_FACTORY_DIR;
  const rulesDir = process.env.PHOENIX_NLU_COMPILED_RULES_DIR;
  const expectedFstSha256 = process.env.PHOENIX_NLU_COMPILED_FST_SHA256;
  if (snapshotManifest) {
    if (fstPath || factoryDir || rulesDir || expectedFstSha256) {
      throw new Error('compiled-fst runtime cannot combine a JSON snapshot manifest with binary graph settings');
    }
    if (!existsSync(snapshotManifest)) throw new Error(`Compiled NLU snapshot profile is unavailable: ${snapshotManifest}`);
    return { snapshotManifest: resolve(snapshotManifest) };
  }
  if (!fstPath || !factoryDir || !rulesDir || !expectedFstSha256) {
    throw new Error(
      'compiled-fst runtime requires PHOENIX_NLU_COMPILED_FST, '
      + 'PHOENIX_NLU_COMPILED_FACTORY_DIR, PHOENIX_NLU_COMPILED_RULES_DIR, '
      + 'and PHOENIX_NLU_COMPILED_FST_SHA256',
    );
  }
  if (expectedFstSha256 !== APPROVED_LAUNCH_SHA256) {
    throw new Error('Unsupported compiled NLU launch profile: expected hash must identify the approved launch artifact');
  }
  if (!existsSync(fstPath)) throw new Error(`Compiled NLU FST is unavailable: ${fstPath}`);
  if (!existsSync(factoryDir)) throw new Error(`Compiled NLU factory directory is unavailable: ${factoryDir}`);
  if (!existsSync(rulesDir)) throw new Error(`Compiled NLU graph directory is unavailable: ${rulesDir}`);
  return { fstPath, factoryDir, rulesDir, expectedFstSha256 };
}

function createPortableRuntime(selected, key) {
  const profile = readPortableSnapshotProfile(selected.snapshotManifest);
  const launchEntry = profile.graphs.get('launch');
  const launchFst = parseFstSnapshot(launchEntry.bytes, { source: launchEntry.path });
  const factoryFsts = new Map();
  for (const [name, entry] of profile.factories) factoryFsts.set(name, entry.fst);
  const executor = new ConnectedFstExecutor(launchFst, { factoryFsts });
  const executors = new Map([['launch', executor]]);
  const getExecutor = name => {
    const entry = profile.graphs.get(name);
    if (!entry) throw new Error(`Compiled NLU rule is unavailable in the verified snapshot: ${name}`);
    let selectedExecutor = executors.get(name);
    if (!selectedExecutor) {
      selectedExecutor = new ConnectedFstExecutor(parseFstSnapshot(entry.bytes, { source: entry.path }), { factoryFsts });
      executors.set(name, selectedExecutor);
    }
    return selectedExecutor;
  };
  loaded = Object.freeze({
    key,
    executor,
    snapshotManifest: selected.snapshotManifest,
    fstPath: null,
    factoryDir: null,
    rulesDir: null,
    fstSha256: launchEntry.sourceSha256,
    ruleCount: profile.graphs.size,
    ruleManifestSha256: profile.ruleManifestSha256,
    inventoryRevision: profile.inventoryRevision,
    inventorySha256: profile.inventorySha256,
    getExecutor,
    ...PROVENANCE,
    runtime: ENABLED,
  });
  return loaded;
}

/**
 * Return immutable runtime metadata and executors for the explicitly selected archived
 * public-rule profile, or null for the default AST/profile path.
 */
export function getCompiledFstRuntime() {
  const selected = config();
  if (!selected) return null;
  const key = JSON.stringify(selected);
  if (loaded?.key === key) return loaded;

  if (selected.snapshotManifest) return createPortableRuntime(selected, key);

  const bytes = readFileSync(selected.fstPath);
  const fstSha256 = sha256(bytes);
  if (fstSha256 !== selected.expectedFstSha256) {
    throw new Error(`Compiled NLU FST hash mismatch: ${selected.fstPath}`);
  }
  const snapshot = readFactorySnapshot(selected.factoryDir);
  if (snapshot.manifestSha256 !== PROVENANCE.factoryManifestSha256) {
    throw new Error(`Compiled NLU factory manifest hash mismatch: ${selected.factoryDir}`);
  }
  const rules = readRuleSnapshot(selected.rulesDir);
  const launchEntry = rules.files.get('launch');
  if (!launchEntry) throw new Error('Compiled NLU rule inventory has no launch graph');
  if (sha256(bytes) !== launchEntry.sha256) {
    throw new Error(`Compiled NLU launch graph does not match the verified rule snapshot: ${selected.fstPath}`);
  }
  const fst = new VectorStandardFst(bytes, { source: selected.fstPath });
  // Execute the bytes that were just verified. Disk changes after loading must
  // not substitute an unverified factory under the cached profile metadata.
  // The executor owns separate callsite/return state for this shared FST data.
  const factoryFsts = new Map();
  for (const [name, factoryBytes] of snapshot.files) {
    if (name.endsWith('.fst')) {
      factoryFsts.set(name.slice(0, -4), new VectorStandardFst(factoryBytes, {
        source: `${selected.factoryDir}/${name}`,
      }));
    }
  }
  const executor = new ConnectedFstExecutor(fst, { factoryFsts });
  const executors = new Map([['launch', executor]]);
  const getExecutor = name => {
    const entry = rules.files.get(name);
    if (!entry) throw new Error(`Compiled NLU rule is unavailable in the verified snapshot: ${name}`);
    let selectedExecutor = executors.get(name);
    if (!selectedExecutor) {
      selectedExecutor = new ConnectedFstExecutor(new VectorStandardFst(entry.bytes, { source: entry.path }), { factoryFsts });
      executors.set(name, selectedExecutor);
    }
    return selectedExecutor;
  };
  loaded = Object.freeze({
    key,
    executor,
    fstPath: selected.fstPath,
    factoryDir: selected.factoryDir,
    rulesDir: selected.rulesDir,
    fstSha256,
    ruleCount: rules.ruleCount,
    ruleManifestSha256: rules.manifestSha256,
    inventoryRevision: rules.inventoryRevision,
    inventorySha256: rules.inventorySha256,
    getExecutor,
    ...PROVENANCE,
    runtime: ENABLED,
  });
  return loaded;
}

/**
 * Convert the native launch result-FST winner into the request parser's candidate
 * shape. `priority` is parser metadata and is intentionally removed by this legacy
 * launch-only convenience wrapper; the request parser uses matchCompiledRule directly.
 */
export function matchCompiledLaunch(text, runtime = getCompiledFstRuntime()) {
  if (!runtime) return null;
  // The Phoenix request boundary lowercases and trims ASR text before
  // matching; the archived native FST itself contains lowercase arcs. Keep
  // the generic executor byte-faithful and apply the request-path normalizer
  // at this adapter boundary.
  const candidate = matchCompiledRule('launch', text, runtime);
  if (!candidate || !candidate.intent) return null;
  const { priority, ...result } = candidate;
  void priority;
  return result;
}

/**
 * Parse the native winner for one requested public rule. result_fst::process_result
 * interprets only the first sorted final. RobustParserClient then compares the results
 * returned by each rule response, before ParseRequestHandler validates the winner.
 */
export function matchCompiledRule(name, text, runtime = getCompiledFstRuntime()) {
  if (!runtime) return null;
  const executor = name === 'launch' && runtime.executor && !runtime.getExecutor
    ? runtime.executor : runtime.getExecutor(name);
  const parsed = executor.parse(String(text).trim().toLowerCase());
  // result_fst::process_result interprets only the first sorted final. An
  // invalid winner must not promote a lower-ranked path into a new result.
  const result = parsed.results[0];
  if (!result) return null;
  const tags = interpretOutputSymbols(result.outputSymbols);
  if (!tags || typeof tags !== 'object' || Array.isArray(tags)) return null;
  const entities = { ...tags };
  const intent = typeof entities.intent === 'string' && entities.intent.length > 0
    ? entities.intent : null;
  const priority = typeof entities.priority === 'string' && entities.priority.length > 0
    ? entities.priority.toUpperCase() : 'LOW';
  delete entities.intent;
  delete entities.priority;
  return {
    rule: name,
    entities,
    intent,
    priority,
    score: result.score,
    nativeHeuristic: result.heuristic,
  };
}

export function compiledFstRuntimeConfig() {
  const runtime = getCompiledFstRuntime();
  if (!runtime) return null;
  const metadata = {
    runtime: runtime.runtime,
    fstSha256: runtime.fstSha256,
    ruleCount: runtime.ruleCount,
    ruleManifestSha256: runtime.ruleManifestSha256,
    inventoryRevision: runtime.inventoryRevision,
    inventorySha256: runtime.inventorySha256,
    sourceRevision: runtime.sourceRevision,
    referenceRevision: runtime.referenceRevision,
    sourceRuntime: runtime.sourceRuntime,
    nativeParserSha256: runtime.nativeParserSha256,
    factoryManifestSha256: runtime.factoryManifestSha256,
  };
  if (runtime.snapshotManifest) return { ...metadata, snapshotManifest: runtime.snapshotManifest };
  return {
    ...metadata,
    fstPath: runtime.fstPath,
    factoryDir: runtime.factoryDir,
    rulesDir: runtime.rulesDir,
  };
}
