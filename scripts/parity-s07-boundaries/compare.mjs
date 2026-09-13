import fs from 'node:fs';
import path from 'node:path';

const dir = path.resolve(process.argv[2]);
const spec = JSON.parse(fs.readFileSync(path.join(dir, 'matrix-spec.json'), 'utf8'));
const source = JSON.parse(fs.readFileSync(path.join(dir, 'source-runtime.json'), 'utf8'));
const candidate = JSON.parse(fs.readFileSync(path.join(dir, 'candidate-runtime.json'), 'utf8'));
const stable = value => JSON.stringify(value);

function withoutPromptIds(value) {
  if (Array.isArray(value)) return value.map(withoutPromptIds);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (key !== 'prompt_id') out[key] = withoutPromptIds(child);
  }
  return out;
}

function promptIds(value) {
  if (Array.isArray(value)) return value.flatMap(promptIds);
  if (!value || typeof value !== 'object') return [];
  const own = value.prompt_id === undefined ? [] : [value.prompt_id];
  return own.concat(Object.entries(value).filter(([key]) => key !== 'prompt_id').flatMap(([, child]) => promptIds(child)));
}

const errors = [];
function validate(receipt, side) {
  if (!Array.isArray(receipt.rows)) {
    errors.push(`${side}.rows must be an array`);
    return [];
  }
  if (receipt.rows.length !== spec.cases.length) errors.push(`${side}.rows cardinality ${receipt.rows.length} != spec ${spec.cases.length}`);
  const expected = new Set(spec.cases.map(item => item.id));
  const counts = new Map();
  receipt.rows.forEach((row, index) => {
    const id = row && row.id;
    if (!id) { errors.push(`${side}.rows[${index}] has no id`); return; }
    counts.set(id, (counts.get(id) || 0) + 1);
    if (!expected.has(id)) errors.push(`${side} has unexpected row ${id}`);
  });
  for (const [id, count] of counts) if (count > 1) errors.push(`${side} has duplicate row ${id}`);
  for (const id of expected) if (!counts.has(id)) errors.push(`${side} is missing row ${id}`);
  return receipt.rows;
}

const sourceRows = validate(source, 'source');
const candidateRows = validate(candidate, 'candidate');
const sourceMap = new Map(sourceRows.map(row => [row && row.id, row]));
const candidateMap = new Map(candidateRows.map(row => [row && row.id, row]));
const rows = [];
for (const descriptor of spec.cases) {
  const s = sourceMap.get(descriptor.id);
  const c = candidateMap.get(descriptor.id);
  const semanticEqual = Boolean(s && c) && stable(withoutPromptIds(s)) === stable(withoutPromptIds(c));
  const promptEqual = Boolean(s && c) && stable(s) === stable(c);
  rows.push({
    id: descriptor.id,
    class: descriptor.class,
    expectedDifference: descriptor.expectedDifference || null,
    sourcePresent: Boolean(s),
    candidatePresent: Boolean(c),
    semanticEqual,
    promptEqual,
    sourcePromptIds: promptIds(s),
    candidatePromptIds: promptIds(c),
    sourceError: s?.error || null,
    candidateError: c?.error || null,
  });
}
const semanticDifferences = rows.filter(row => !row.semanticEqual);
const expectedDifferenceIds = new Set(spec.cases.filter(item => item.expectedDifference).map(item => item.id));
const unexpectedSemanticDifferences = semanticDifferences.filter(row => !expectedDifferenceIds.has(row.id));
const promptDifferences = rows.filter(row => !row.promptEqual).map(row => ({
  id: row.id,
  class: row.class,
  expectedDifference: row.expectedDifference,
  sourcePromptIds: row.sourcePromptIds,
  candidatePromptIds: row.candidatePromptIds,
}));
const unexpectedPromptDifferences = promptDifferences.filter(row => !expectedDifferenceIds.has(row.id));
const result = {
  schemaVersion: 1,
  sourceRevision: source.referenceRevision,
  candidateRevision: candidate.candidateRevision,
  rows: rows.length,
  semanticMatches: rows.filter(row => row.semanticEqual).length,
  promptMatches: rows.filter(row => row.promptEqual).length,
  coverageErrors: errors,
  semanticDifferences,
  expectedSemanticDifferences: semanticDifferences.filter(row => expectedDifferenceIds.has(row.id)),
  unexpectedSemanticDifferences,
  promptDifferences,
  unexpectedPromptDifferences,
  result: errors.length || unexpectedSemanticDifferences.length || unexpectedPromptDifferences.length ? 'fail' : 'pass',
};
fs.writeFileSync(path.join(dir, 'differential-receipt.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ result: result.result, rows: result.rows, semanticMatches: result.semanticMatches,
  promptMatches: result.promptMatches, coverageErrors: result.coverageErrors.length,
  semanticDifferences: result.semanticDifferences.length,
  expectedSemanticDifferences: result.expectedSemanticDifferences.length,
  unexpectedSemanticDifferences: result.unexpectedSemanticDifferences.length,
  promptDifferences: result.promptDifferences.length,
  unexpectedPromptDifferences: result.unexpectedPromptDifferences.length }));
if (result.result !== 'pass') process.exitCode = 1;
