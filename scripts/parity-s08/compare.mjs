import fs from 'node:fs';
import path from 'node:path';

const dir = path.resolve(process.argv[2]);
const specPath = path.resolve(process.argv[3] || path.join(dir, 'matrix-spec.json'));
const spec = JSON.parse(fs.readFileSync(specPath));
const source = JSON.parse(fs.readFileSync(path.join(dir, 'source-runtime.json')));
const candidate = JSON.parse(fs.readFileSync(path.join(dir, 'candidate-runtime.json')));
const stable = value => JSON.stringify(value);
const withoutPrompt = value => {
  if (Array.isArray(value)) return value.map(withoutPrompt);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, child] of Object.entries(value)) if (key !== 'prompt_id') out[key] = withoutPrompt(child);
  return out;
};
const rows = [];
const coverageErrors = [];

function receiptRows(receipt, group, side) {
  const value = receipt?.[group];
  if (!Array.isArray(value)) {
    coverageErrors.push(`${side}.${group} must be an array`);
    return [];
  }
  return value;
}

function validateRows(group, descriptors, receipt, side) {
  const expectedIds = descriptors.map(descriptor => descriptor.id);
  const expectedSet = new Set(expectedIds);
  if (expectedSet.size !== expectedIds.length) {
    coverageErrors.push(`spec.${group} contains duplicate descriptor IDs`);
  }

  const rowsForGroup = receiptRows(receipt, group, side);
  if (rowsForGroup.length !== descriptors.length) {
    coverageErrors.push(`${side}.${group} cardinality ${rowsForGroup.length} does not equal spec cardinality ${descriptors.length}`);
  }

  const counts = new Map();
  rowsForGroup.forEach((row, index) => {
    const id = row && typeof row === 'object' ? row.id : undefined;
    if (id === undefined || id === null || id === '') {
      coverageErrors.push(`${side}.${group}[${index}] has no descriptor ID`);
      return;
    }
    counts.set(id, (counts.get(id) || 0) + 1);
  });
  for (const [id, count] of counts) {
    if (count > 1) coverageErrors.push(`${side}.${group} contains duplicate row ID ${id}`);
    if (!expectedSet.has(id)) coverageErrors.push(`${side}.${group} contains unexpected row ID ${id}`);
  }
  for (const id of expectedIds) {
    if (!counts.has(id)) coverageErrors.push(`${side}.${group} is missing row ID ${id}`);
  }
  return rowsForGroup;
}

function compareGroup(name, descriptors) {
  const sourceRows = validateRows(name, descriptors, source, 'source');
  const candidateRows = validateRows(name, descriptors, candidate, 'candidate');
  const sMap = new Map(sourceRows.map(row => [row?.id, row]));
  const cMap = new Map(candidateRows.map(row => [row?.id, row]));
  for (const descriptor of descriptors) {
    const s = sMap.get(descriptor.id); const c = cMap.get(descriptor.id);
    const semantic = Boolean(s && c) && stable(withoutPrompt(s)) === stable(withoutPrompt(c));
    const prompt = Boolean(s && c) && stable(s) === stable(c);
    rows.push({ id: descriptor.id, group: name, expectedDifference: descriptor.expectedDifference || null,
      sourcePresent: Boolean(s), candidatePresent: Boolean(c), sourceOK: !!s?.ok, candidateOK: !!c?.ok,
      semanticEqual: semantic, promptEqual: prompt,
      sourceError: s?.error || null, candidateError: c?.error || null });
  }
}
compareGroup('graph', spec.graphCases);
compareGroup('settings', spec.settingsCases);
const unexpected = rows.filter(row => !row.semanticEqual);
const failed = coverageErrors.length > 0 || unexpected.length > 0;
const result = {
  schemaVersion: 1,
  sourceRevision: source.referenceRevision,
  candidateRevision: candidate.candidateRevision,
  graphRows: spec.graphCases.length,
  settingsRows: spec.settingsCases.length,
  totalRows: rows.length,
  semanticMatches: rows.filter(row => row.semanticEqual).length,
  promptMatches: rows.filter(row => row.promptEqual).length,
  expectedDifferences: [],
  coverageErrors,
  unexpectedDifferences: unexpected,
  rows,
  result: failed ? 'fail' : 'pass',
};
fs.writeFileSync(path.join(dir, 'differential-receipt.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ result: result.result, rows: result.totalRows, semanticMatches: result.semanticMatches,
  promptMatches: result.promptMatches, expectedDifferences: 0, coverageErrors: coverageErrors.length,
  unexpectedDifferences: unexpected.length }));
if (failed) process.exitCode = 1;
