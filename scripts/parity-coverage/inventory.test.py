#!/usr/bin/env python3
"""Focused checks for the source-pinned corpus coverage gate metadata."""
import copy
from contextlib import contextmanager
import gzip
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('coverage_inventory', ROOT / 'scripts/parity-coverage/inventory.py')
INVENTORY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(INVENTORY)


def corpus_records():
    records = []
    for name, path in INVENTORY.CORPORA.items():
        raw = (ROOT / INVENTORY.VENDORED_CORPORA[name]).read_bytes()
        data = json.loads(raw)
        tests = data['tests']
        records.append({
            'id': name,
            'source': path,
            'sha256': INVENTORY.sha(raw),
            'entries': len(tests),
            'utterances': sum(len(test['command']) for test in tests),
            'conditionalBranches': sum(len(test.get('conditionalTests', [])) for test in tests),
            'utteranceConditionPairs': sum(len(test.get('conditionalTests', [])) * len(test['command']) for test in tests),
        })
    return records


class CorpusGateInventoryTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.catalog = json.loads((ROOT / 'scripts/parity-coverage/corpus-gates.json').read_text())
        # These preserved bytes are checked against the reviewed source pins
        # by validate_corpus_gate. The focused gate tests also run in a clean
        # CI checkout without a sibling Pegasus source repository.
        cls.contents = {path: (ROOT / INVENTORY.VENDORED_CORPORA[name]).read_bytes() for name, path in INVENTORY.CORPORA.items()}
        (ROOT / '.parity').mkdir(exist_ok=True)
        cls.records = corpus_records()
        full_candidate = json.loads(gzip.decompress((ROOT / cls.catalog['gates'][0]['candidateFile']).read_bytes()))
        # Candidate semantic validation only consumes these schema fields and
        # case IDs.  Keep the mutation fixtures compact while deriving IDs
        # from the retained 20,534-case candidate.
        cls.candidate = {key: full_candidate[key] for key in (
            'schemaVersion', 'suite', 'suiteSha256', 'driverSha256',
            'adapterSha256', 'implementation', 'runtime', 'profile',
            'captureComplete', 'lateEffects')}
        cls.candidate['cases'] = [{'id': case['id']} for case in full_candidate['cases']]

    def test_pinned_full_gate_accepts_all_three_manifest_denominators(self):
        gate = INVENTORY.validate_corpus_gate(self.catalog, self.contents, self.records)
        self.assertEqual(gate['coverage'], 'partial')
        self.assertEqual(gate['denominator']['corpusOccurrences'], 20507)
        self.assertEqual(gate['denominator']['boundaryAndDirectCases'], 27)
        self.assertEqual(gate['denominator']['totalCases'], 20534)

    def test_artifact_hash_drift_is_rejected(self):
        catalog = copy.deepcopy(self.catalog)
        path = catalog['gates'][0]['suiteFile']
        catalog['gates'][0]['artifactSha256'][path] = '0' * 64
        with self.assertRaisesRegex(ValueError, 'artifact bytes changed'):
            INVENTORY.validate_corpus_gate(catalog, self.contents, self.records)

    def test_partial_status_cannot_be_promoted_by_metadata_only(self):
        catalog = copy.deepcopy(self.catalog)
        catalog['gates'][0]['coverage'] = 'covered'
        with self.assertRaisesRegex(ValueError, 'must remain explicitly partial'):
            INVENTORY.validate_corpus_gate(catalog, self.contents, self.records)

    @contextmanager
    def candidate_fixture(self, mutate):
        """Write a temporary candidate and pin its replacement hash.

        The production artifacts stay immutable.  Updating the temporary
        catalog hash first ensures the assertions below exercise candidate
        semantics rather than the artifact-byte guard.
        """
        candidate = copy.deepcopy(self.candidate)
        mutate(candidate)
        with tempfile.TemporaryDirectory(prefix='v03-candidate-', dir=ROOT / '.parity') as directory:
            path = Path(directory) / 'candidate.json.gz'
            path.write_bytes(gzip.compress(json.dumps(candidate, ensure_ascii=False, separators=(',', ':')).encode()))
            relative = path.relative_to(ROOT).as_posix()
            catalog = copy.deepcopy(self.catalog)
            catalog['gates'][0]['candidateFile'] = relative
            catalog['gates'][0]['artifactSha256'][relative] = INVENTORY.file_sha(path)
            self.assertEqual(catalog['gates'][0]['artifactSha256'][relative], INVENTORY.file_sha(path))
            yield catalog

    def test_candidate_capture_marker_is_checked_after_hash_update(self):
        for message, mutate in [
            ('Candidate capture is incomplete', lambda candidate: candidate.update(captureComplete=False)),
            ('Candidate capture retained late effects', lambda candidate: candidate.update(lateEffects=[{'case': 'late'}])),
            ('Candidate capture contains a case failure', lambda candidate: candidate['cases'][0].update(failure={'message': 'synthetic capture failure'})),
        ]:
            with self.subTest(message=message):
                with self.candidate_fixture(mutate) as catalog:
                    with self.assertRaisesRegex(ValueError, message):
                        INVENTORY.validate_corpus_gate(catalog, self.contents, self.records)

    def test_candidate_ids_must_be_unique_and_in_suite_order_after_hash_update(self):
        mutations = [
            ('Candidate case IDs are not unique', lambda candidate: candidate['cases'][1].update(id=candidate['cases'][0]['id'])),
            ('Candidate case IDs or order do not match', lambda candidate: candidate['cases'].__setitem__(slice(0, 2), candidate['cases'][0:2][::-1])),
        ]
        for message, mutate in mutations:
            with self.subTest(message=message):
                with self.candidate_fixture(mutate) as catalog:
                    with self.assertRaisesRegex(ValueError, message):
                        INVENTORY.validate_corpus_gate(catalog, self.contents, self.records)

    def test_source_review_and_capture_tool_set_are_required(self):
        source = json.loads((ROOT / self.catalog['gates'][0]['sourceFile']).read_text())
        candidate = self.candidate
        source['review']['result'] = 'mismatch'
        with self.assertRaisesRegex(ValueError, 'Production golden source review is not passing'):
            INVENTORY.validate_golden_source(source, ROOT, ROOT / self.catalog['gates'][0]['suiteFile'], ROOT / self.catalog['gates'][0]['referenceFile'])
        # The helper is intentionally pure; test the same semantic condition
        # against a copied source fixture without changing the pinned files.
        source['review']['result'] = 'pass'
        del source['originalCaptureTools']['scripts/parity-production/fixtures.mjs']
        with self.assertRaisesRegex(ValueError, 'capture-tool set is incomplete'):
            INVENTORY.validate_golden_source(source, ROOT, ROOT / self.catalog['gates'][0]['suiteFile'], ROOT / self.catalog['gates'][0]['referenceFile'])
        self.assertEqual(candidate['driverSha256'], source['driverSha256'])


if __name__ == '__main__':
    unittest.main()
