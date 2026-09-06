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

const ENABLED = 'compiled-fst';
const APPROVED_LAUNCH_SHA256 = '2ba09176e04522d4addbca23074f2bef62b1cbbe9702f03c390abd8b56fdc25a';
const APPROVED_INVENTORY_SHA256 = '4377949617eb3169f1466ddb2844f2f5f9948f43e1942a2e35f38c3664dc4aa5';
const RESOURCE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'resources');
const INVENTORY_PATH = join(RESOURCE_ROOT, 'rule-inventory.json');

// These identities describe the only archived graph profile this adapter is
// allowed to execute. They make a replay self-auditing: a graph byte hash
// alone does not identify the compiler/runtime that produced its tags.
const PROVENANCE = Object.freeze({
  sourceRevision: '91b1bb6dbc702d3072df98a6fa0b76a6bc151d3e',
  referenceRevision: '5c0a7390539663ba749d360de348a428c088505c',
  sourceRuntime: 'jibo-nlu v2.8.3',
  nativeParserSha256: '373b6509036c6ab841023fa541b931f1ccc966dee750058cdbbf560ab467ce9b',
  factoryManifestSha256: '4ea19a27acbfaecdb60de0688cb5f3f75ef31c93c2865d2d6710989f98ffe97e',
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

function pathSeparator() {
  return process.platform === 'win32' ? '\\' : '/';
}

function config() {
  if (process.env.PHOENIX_NLU_RUNTIME !== ENABLED) return null;
  const fstPath = process.env.PHOENIX_NLU_COMPILED_FST;
  const factoryDir = process.env.PHOENIX_NLU_COMPILED_FACTORY_DIR;
  const rulesDir = process.env.PHOENIX_NLU_COMPILED_RULES_DIR;
  const expectedFstSha256 = process.env.PHOENIX_NLU_COMPILED_FST_SHA256;
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

/**
 * Return immutable runtime metadata and executors for the explicitly selected archived
 * public-rule profile, or null for the default AST/profile path.
 */
export function getCompiledFstRuntime() {
  const selected = config();
  if (!selected) return null;
  const key = JSON.stringify(selected);
  if (loaded?.key === key) return loaded;

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
  return {
    runtime: runtime.runtime,
    fstPath: runtime.fstPath,
    factoryDir: runtime.factoryDir,
    rulesDir: runtime.rulesDir,
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
}
