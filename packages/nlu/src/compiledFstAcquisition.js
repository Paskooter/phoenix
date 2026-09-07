// Source-backed compiled-graph acquisition and the in-process equivalent of
// the native nlu_interface handle protocol used by RobustParserClient.
//
// Original production (pegasus 5c0a739 ParserService + RobustParserClient):
//   1. ParserConfigProvider reads resources/default.json.
//   2. robustParser.config.fstDirectories is ["robust-parser/rules_fst"].
//   3. loadFSTs is true; RobustParserClient.init() calls RulesRegistry.findRules
//      then loadAllFSTs.
//   4. RulesRegistry globs **/*.fst in each configured directory. The rule name
//      is the lowercased relative path without ".fst". The stored fstPath is
//      path.join(dir, name) + ".fst" (the source reconstructs the path from
//      the lowered name, not the original glob spelling).
//   5. loadFSTIntoMemory sends COMPILE { BINARYFST_PATH, URI: "handle:"+name }.
//   6. handleNLU filters request.rules to names present in the registry, then
//      PARSE_FROM_URI { TXT_STRING, URI: handle } for each known rule.
//
// Native service (ConvTech/jibo-nlu-service nlu_request_executor):
//   COMPILE BINARYFST_PATH opens the file and stores the graph under URI.
//   A missing path throws "Could not open binary_fst_path".
//   PARSE_FROM_URI looks the handle up in fst_cache; a missing handle throws.
//   RESET_MEMORY clears the cache then re-preloads factory graphs.
//   REMOVE_FROM_MEM erases one URI.
//   UNION is offline build-rules work, not a public parse operation.
//
// This module does not compile text grammars and does not implement OpenFST
// union. It only discovers existing .fst files and loads them as VectorFST
// handles so Phoenix can serve graphs outside the closed 98-rule inventory.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ConnectedFstExecutor } from './connectedFst.js';
import { VectorStandardFst } from './compiledFst.js';

export const HANDLE_PREFIX = 'handle:';
export const FST_SUFFIX = '.fst';

export function ruleHandle(ruleName) {
  if (typeof ruleName !== 'string' || ruleName.length === 0) {
    throw new Error('Compiled NLU rule handle requires a non-empty rule name');
  }
  return `${HANDLE_PREFIX}${ruleName}`;
}

export function splitFstDirectories(value) {
  if (value == null) return [];
  if (Array.isArray(value)) {
    return value.map(entry => String(entry).trim()).filter(Boolean);
  }
  return String(value).split(':').map(entry => entry.trim()).filter(Boolean);
}

function listFstRelativePaths(directory) {
  const found = [];
  const walk = (current, rel) => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch (error) {
      if (error && error.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      const childPath = join(current, entry.name);
      if (entry.isDirectory()) walk(childPath, childRel);
      else if (entry.isFile() && childRel.endsWith(FST_SUFFIX)) found.push(childRel);
    }
  };
  walk(directory, '');
  found.sort();
  return found;
}

/**
 * Discover compiled graphs the way RulesRegistry.findDirectoryRules does.
 * Directories are applied in array order; a later directory overwrites the
 * same lowered name. The original Promise.all across directories is a race
 * on collisions; production default.json has a single directory, so this
 * sequential order is the stable reading of the configured array.
 */
export function discoverCompiledGraphs(directories) {
  const rules = new Map();
  for (const configured of directories || []) {
    if (typeof configured !== 'string' || configured.length === 0) {
      throw new Error('Compiled NLU FST directory is empty');
    }
    const dir = resolve(configured);
    if (existsSync(dir) && !statSync(dir).isDirectory()) {
      throw new Error(`Compiled NLU FST directory is not a directory: ${dir}`);
    }
    for (const fileName of listFstRelativePaths(dir)) {
      const name = fileName.toLowerCase().slice(0, fileName.length - FST_SUFFIX.length);
      rules.set(name, {
        name,
        fstPath: join(dir, name) + FST_SUFFIX,
        discoveredPath: join(dir, fileName),
        directory: dir,
      });
    }
  }
  return [...rules.values()];
}

export function loadFactoryFsts(factoryDir) {
  if (!factoryDir) return new Map();
  const dir = resolve(factoryDir);
  if (!existsSync(dir)) throw new Error(`Compiled NLU factory directory is unavailable: ${dir}`);
  if (!statSync(dir).isDirectory()) throw new Error(`Compiled NLU factory directory is not a directory: ${dir}`);
  const factoryFsts = new Map();
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !entry.name.endsWith(FST_SUFFIX) || entry.name.startsWith('.')) continue;
    const name = entry.name.slice(0, -FST_SUFFIX.length);
    const path = join(dir, entry.name);
    factoryFsts.set(name, new VectorStandardFst(readFileSync(path), { source: path }));
  }
  return factoryFsts;
}

/**
 * In-process nlu_interface subset that Phoenix actually uses at runtime:
 * COMPILE BINARYFST_PATH, PARSE_FROM_URI, REMOVE_FROM_MEM, RESET_MEMORY.
 */
export class CompiledGraphStore {
  constructor({ factoryFsts } = {}) {
    this.handles = new Map();
    this.executors = new Map();
    this.factoryFsts = factoryFsts === undefined ? new Map() : factoryFsts;
    if (!(this.factoryFsts instanceof Map)) {
      throw new TypeError('factoryFsts must be a Map keyed by factory basename');
    }
  }

  compileBinaryFstPath(fstPath, uri) {
    if (typeof uri !== 'string' || !uri.startsWith(HANDLE_PREFIX)) {
      throw new Error(`Compiled NLU COMPILE URI must be a handle: ${uri}`);
    }
    if (typeof fstPath !== 'string' || fstPath.length === 0) {
      throw new Error('Compiled NLU COMPILE BINARYFST_PATH is missing');
    }
    let bytes;
    try {
      bytes = readFileSync(fstPath);
    } catch (error) {
      throw new Error(`Could not open binary_fst_path: ${fstPath}`);
    }
    let fst;
    try {
      fst = new VectorStandardFst(bytes, { source: fstPath });
    } catch (error) {
      throw new Error(`Malformed compiled NLU FST at ${fstPath}: ${error.message}`);
    }
    this.handles.set(uri, { fst, source: fstPath, bytes });
    this.executors.delete(uri);
    return uri;
  }

  hasHandle(uri) {
    return this.handles.has(uri);
  }

  getExecutor(uri) {
    const entry = this.handles.get(uri);
    if (!entry) throw new Error(`Attempting to read handle, but it does not exist: ${uri}`);
    let executor = this.executors.get(uri);
    if (!executor) {
      executor = new ConnectedFstExecutor(entry.fst, { factoryFsts: this.factoryFsts });
      this.executors.set(uri, executor);
    }
    return executor;
  }

  parseFromUri(text, uri) {
    return this.getExecutor(uri).parse(String(text));
  }

  removeFromMemory(uri) {
    const existed = this.handles.delete(uri);
    this.executors.delete(uri);
    return existed;
  }

  resetMemory() {
    this.handles.clear();
    this.executors.clear();
  }
}

export function compileDiscoveredGraphs(graphs, { factoryFsts, loadFSTs = true } = {}) {
  const store = new CompiledGraphStore({ factoryFsts });
  const byName = new Map();
  if (loadFSTs) {
    for (const graph of graphs) {
      const uri = ruleHandle(graph.name);
      store.compileBinaryFstPath(graph.fstPath, uri);
      byName.set(graph.name, { ...graph, handle: uri });
    }
  } else {
    for (const graph of graphs) byName.set(graph.name, { ...graph, handle: ruleHandle(graph.name) });
  }
  return { store, byName };
}
