// Derive the private output-field semantics of the finite word-list factories
// from their version-matched source grammars.
//
// The `$factory:` word lists under resources/factory-words were extracted as
// plain text from the reference FSTs, so each entry kept only its spelling and
// lost the private field name and value the reference grammar declares. The
// reference grammar sources are recovered under resources/factory-sources
// (manifest.json records their origin and hashes). This module re-derives, from
// those sources, the field each factory publishes and — when the source arms
// carry literal values — the exact value per entry.
//
// Output of the CLI: resources/factory-sources/word-list-semantics.json
//   { "<factory>": { "field": "_nl", "values": { "<phrase>": "<value>" } }, ... }
// `values` is omitted when every arm publishes the matched text (`_parsed`).
//
// Usage: node packages/nlu/tools/extractFactoryWordSemantics.mjs
import { parse } from '../src/grammar/parser.js';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'resources', 'factory-sources');
const WORD_LIST_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'resources', 'factory-words');

// Walk every tag spec reachable in the AST.
function* tags(node) {
  if (!node || typeof node !== 'object') return;
  for (const t of node.tags || []) yield t;
  if (node.item) yield* tags(node.item);
  for (const k of ['items', 'alts']) for (const c of node[k] || []) yield* tags(c);
}

// Phrase a node consumes when it is built purely from literals.
function phrase(node) {
  if (!node) return null;
  if (node.type === 'lit') return node.word;
  if (node.type === 'class') return null;              // class bodies are not plain phrases
  if (node.type === 'seq') {
    const parts = node.items.map(phrase);
    return parts.every(p => p !== null) ? parts.join(' ') : null;
  }
  return null;
}

// Collect (phrase, value) pairs from every tagged group in the file.
function collect(node, field, out) {
  if (!node || typeof node !== 'object') return;
  for (const t of node.tags || []) {
    if (t.key !== field || t.kind !== 'lit') continue;
    const p = phrase(node);
    if (p !== null) out.set(p, t.value);
  }
  if (node.item) collect(node.item, field, out);
  for (const k of ['items', 'alts']) for (const c of node[k] || []) collect(c, field, out);
}

/**
 * @param {string} [dir] factory-source directory
 * @param {string} [wordListDir] bundled word-list directory (defines the target set)
 * @returns {Record<string, {field: string, values?: Record<string,string>}>}
 */
export function deriveFactoryWordSemantics(dir = DIR, wordListDir = WORD_LIST_DIR) {
  const factories = {};
  // Only the factories that actually have a bundled word-list projection; a
  // composite factory (canada_city_province) publishes several fields and is not
  // projected as a word list.
  const projected = new Set(readdirSync(wordListDir).filter(f => f.endsWith('.txt')).map(f => f.slice(0, -4)));
  for (const file of readdirSync(dir).filter(f => f.endsWith('.grm')).sort()) {
    if (!projected.has(file.replace(/\.grm$/, ''))) continue;
    const ast = parse(readFileSync(join(dir, file), 'utf8'));
    // The published field is the one the factory hands to its caller: a
    // `subfield` tag that reads an inner rule defined in the same file
    // (`{_first_name = first_name._nl}`). A family whose TopRule carries the
    // arms directly (state) has no such tag, so it publishes its single private
    // key.
    const exposed = new Set();
    for (const node of Object.values(ast.rules)) {
      for (const t of tags(node)) {
        if (t.kind === 'subfield' && t.key.startsWith('_') && ast.rules[t.subRule]) exposed.add(t.key);
      }
    }
    const keys = new Set();
    for (const node of Object.values(ast.rules)) for (const t of tags(node)) {
      if (t.key.startsWith('_')) keys.add(t.key);
    }
    const field = exposed.size === 1 ? [...exposed][0] : (keys.size === 1 ? [...keys][0] : null);
    if (!field) {
      throw new Error(`${file}: could not determine the published output field (exposed=${[...exposed].join(', ') || 'none'}, all=${[...keys].join(', ') || 'none'})`);
    }
    const values = new Map();
    for (const node of Object.values(ast.rules)) collect(node, field, values);
    const entry = { field };
    if (values.size) entry.values = Object.fromEntries([...values.entries()].sort());
    factories[file.replace(/\.grm$/, '')] = entry;
  }
  return factories;
}

export function semanticsDocument(dir = DIR, wordListDir = WORD_LIST_DIR) {
  return {
    schema: 'phoenix.nlu.factory-word-list-semantics',
    derivedFrom: 'resources/factory-sources/*.grm (see manifest.json for origin and hashes)',
    factories: deriveFactoryWordSemantics(dir, wordListDir),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const doc = semanticsDocument();
  writeFileSync(join(DIR, 'word-list-semantics.json'), JSON.stringify(doc, null, 2) + '\n');
  console.log(`wrote word-list-semantics.json for ${Object.keys(doc.factories).length} factories`);
}
