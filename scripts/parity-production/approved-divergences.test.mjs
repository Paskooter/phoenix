import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  APPROVED_MANIFEST_SHA256,
  loadApprovedDivergences,
  validateApprovedDivergences,
} from './approved-divergences.mjs';

const manifestPath = new URL('./approved-divergences.json', import.meta.url);
const golden = new URL('../../packages/harness/resources/goldens/production-smoke/', import.meta.url);
const suiteBytes = readFileSync(new URL('suite.json', golden));
const suite = JSON.parse(suiteBytes);
const manifest = JSON.parse(readFileSync(manifestPath));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function comparisonFromManifest() {
  const indexes = new Map(suite.cases.map((definition, index) => [definition.id, index]));
  const differences = manifest.divergences.map(divergence => {
    const index = indexes.get(divergence.caseId);
    assert.notEqual(index, undefined, divergence.caseId);
    const difference = {
      path: `/cases/${index}${divergence.path}`,
      kind: divergence.kind,
    };
    if (divergence.kind === 'presence') {
      difference.expectedPresent = divergence.reference.present;
      difference.actualPresent = divergence.candidate.present;
      if (divergence.reference.present) difference.expected = divergence.reference.value;
      if (divergence.candidate.present) difference.actual = divergence.candidate.value;
    } else {
      difference.expected = divergence.reference.value;
      difference.actual = divergence.candidate.value;
    }
    return difference;
  });
  return {
    schemaVersion: manifest.comparisonSchemaVersion,
    pass: false,
    measuredAgreement: false,
    cases: suite.cases.length,
    differences,
    invariants: [],
    coverageGaps: [],
  };
}

function runFrom(comparison, comparisonBytes) {
  return {
    referenceRevision: manifest.referenceRevision,
    candidate: 'phoenix',
    result: 'mismatch',
    cases: comparison.cases,
    differences: comparison.differences.length,
    invariants: comparison.invariants.length,
    coverageGaps: comparison.coverageGaps.length,
    commands: [
      { name: 'image-phoenix', exitCode: 0 },
      { name: 'candidate', exitCode: 0 },
      { name: 'compare', exitCode: 1 },
    ],
    artifacts: {
      'suite.json': sha256(suiteBytes),
      'comparison.json': sha256(comparisonBytes),
    },
  };
}

function validFixture() {
  const comparison = comparisonFromManifest();
  const comparisonBytes = Buffer.from(JSON.stringify(comparison));
  return {
    comparison,
    comparisonBytes,
    run: runFrom(comparison, comparisonBytes),
  };
}

function assertRejected(change, pattern) {
  const fixture = { ...validFixture(), suite: structuredClone(suite) };
  change(fixture);
  assert.throws(
    () => validateApprovedDivergences({ ...fixture, suite: fixture.suite, suiteBytes, manifest }),
    pattern,
  );
}

test('the reviewed manifest is hash-pinned and contains the four stable boundary cases', () => {
  assert.deepEqual(loadApprovedDivergences(), manifest);
  assert.match(APPROVED_MANIFEST_SHA256, /^[a-f0-9]{64}$/);
  assert.deepEqual(manifest.expectedCaseIds, [
    'boundary:rules-null',
    'boundary:rules-string',
    'boundary:missing-data',
    'boundary:text-number',
  ]);
  assert.equal(manifest.expectedDivergenceCount, 22);
});

test('the exact reviewed security differences pass without changing strict comparison output', () => {
  const fixture = validFixture();
  assert.deepEqual(
    validateApprovedDivergences({ ...fixture, suite, suiteBytes, manifest }),
    {
      approved: true,
      approvedCount: 22,
      caseIds: manifest.expectedCaseIds,
    },
  );
  assert.equal(fixture.comparison.pass, false);
  assert.equal(fixture.run.result, 'mismatch');
});

test('falsification: mutating one approved candidate field is rejected', () => {
  assertRejected(({ comparison }) => {
    comparison.differences[0].expected = 'mutated-reference-value';
  }, /does not match approved divergence/);
});

test('an added or removed difference is rejected', () => {
  assertRejected(({ comparison }) => {
    comparison.differences.push({
      path: '/cases/16/parser/response/status',
      kind: 'value',
      expected: 200,
      actual: 201,
    });
  }, /count|does not match approved divergence/);
  assertRejected(({ comparison }) => {
    comparison.differences.pop();
  }, /count|missing approved divergence/);
});

test('invariant and coverage failures remain nonzero', () => {
  assertRejected(({ comparison }) => {
    comparison.invariants.push({ path: '/cases/16', kind: 'invariant', message: 'tampered' });
  }, /invariant/);
  assertRejected(({ comparison }) => {
    comparison.coverageGaps.push({ side: 'candidate', id: 'unexpected' });
  }, /coverage/);
});

test('tool and runtime errors remain nonzero', () => {
  assertRejected(({ run }) => {
    run.commands[1].exitCode = 2;
  }, /command|tool|runtime|exit code/);
  assertRejected(({ run }) => {
    run.failure = 'capture failed';
  }, /failure|runtime/);
});

test('unknown case IDs and paths cannot be approved by the boundary layer', () => {
  assertRejected(({ comparison }) => {
    comparison.differences[0].path = '/cases/16/parser/response/unknown';
  }, /approved divergence|unknown/);
  assertRejected(({ suite }) => {
    suite.cases[16].id = 'boundary:renamed';
  }, /case|suite|approved/);
});
