// Preserve original corpus occurrences and field presence before any grading.
import { readFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const resources = resolve(root, 'packages/harness/resources');
const sourcesFile = resolve(resources, 'corpora/sources.json');

export function decodeCorpus(bytes, expectedSha256) {
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== expectedSha256) throw new Error('Corpus bytes do not match their frozen source hash');
  const corpus = JSON.parse(bytes);
  if (!Array.isArray(corpus.tests)) throw new Error('Corpus has no test array');
  for (const [index, entry] of corpus.tests.entries()) {
    if (!Array.isArray(entry.command) || entry.command.some(command => typeof command !== 'string')) throw new Error(`Invalid command array at entry ${index}`);
    if (entry.conditionalTests !== undefined && !Array.isArray(entry.conditionalTests)) throw new Error(`Invalid conditional tests at entry ${index}`);
  }
  return corpus;
}

export function loadCorpora() {
  const sources = JSON.parse(readFileSync(sourcesFile, 'utf8'));
  if (sources.schemaVersion !== 1 || typeof sources.referenceRevision !== 'string') throw new Error('Invalid corpus source manifest');
  if (new Set(sources.manifests.map(m => m.id)).size !== sources.manifests.length) throw new Error('Duplicate corpus identifiers');
  return sources.manifests.map(manifest => {
    const path = resolve(root, manifest.path);
    if (!path.startsWith(resources + sep)) throw new Error('Corpus is outside the harness resources');
    return { ...manifest, referenceRevision: sources.referenceRevision, ...decodeCorpus(readFileSync(path), manifest.sha256) };
  });
}

/**
 * Each occurrence and conditional branch gets its own stable identity. Missing
 * intent/entities remain missing; a default no-match expectation is never added.
 * These are fixture definitions, not executed tests or inferred golden outputs.
 */
export function expandCorpus(corpus, { includeConditional = true } = {}) {
  const cases = [];
  for (const [entryIndex, entry] of corpus.tests.entries()) {
    for (const [commandIndex, command] of entry.command.entries()) {
      const base = { corpus: corpus.id, entryIndex, commandIndex, command, manifestEntry: structuredClone(entry) };
      cases.push({ ...base, id: `${corpus.id}:${entryIndex}:${commandIndex}:base`, variant: 'base' });
      if (includeConditional) for (const [conditionIndex, conditional] of (entry.conditionalTests || []).entries()) {
        cases.push({ ...base, manifestEntry: structuredClone(entry), id: `${corpus.id}:${entryIndex}:${commandIndex}:condition:${conditionIndex}`,
          variant: 'conditional', conditionIndex, conditional: structuredClone(conditional) });
      }
    }
  }
  return cases;
}
