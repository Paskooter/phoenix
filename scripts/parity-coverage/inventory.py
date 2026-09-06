#!/usr/bin/env python3
"""Inventory original Git objects, test declarations, corpora and resources."""
import argparse
from collections import Counter, defaultdict
import gzip
import hashlib
import json
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[2]
PINS = json.loads((ROOT / 'docs/parity/evidence/2026-09-05/compatibility-pins.json').read_text())
REVISION = PINS['originalCommit']
CORPORA = {
    'chitchat': 'packages/chitchat-skill/resources/test-manifest.json',
    'hub-client': 'packages/hub-client-cli/resources/test-manifest.json',
    'report': 'packages/report-skill/resources/test-manifest.json',
}
VENDORED_CORPORA = {
    'chitchat': 'packages/harness/resources/test-manifest.json',
    'hub-client': 'packages/harness/resources/corpora/hub-client.json',
    'report': 'packages/harness/resources/corpora/report.json',
}
CORPUS_GATES = ROOT / 'scripts/parity-coverage/corpus-gates.json'
REQUIRED_CAPTURE_TOOLS = (
    'scripts/parity-production/driver.cjs',
    'scripts/parity-production/capture-writer.cjs',
    'scripts/parity-production/original.cjs',
    'scripts/parity-production/fixtures.mjs',
)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def file_sha(path):
    return sha(path.read_bytes())


def json_sha(value):
    """Match the production driver's SHA of ``JSON.stringify(value)``."""
    return sha(json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode())


def read_json(path):
    return json.loads(path.read_text())


def validate_candidate_capture(candidate, suite, source, suite_sha256):
    """Validate the candidate identity and complete case sequence.

    ``captureComplete`` is the capture writer's success marker.  Case count
    alone is insufficient: a truncated/restarted writer can still contain the
    expected number of records while silently changing, duplicating or
    reordering cases.
    """
    if candidate.get('schemaVersion') != suite.get('schemaVersion'):
        raise ValueError('Candidate schema does not match the production suite')
    if candidate.get('suite') != suite.get('id'):
        raise ValueError('Candidate suite identity does not match the production suite')
    if candidate.get('suiteSha256') != suite_sha256:
        raise ValueError('Candidate suite hash does not match the retained suite')
    if candidate.get('driverSha256') != source.get('driverSha256'):
        raise ValueError('Candidate driver identity does not match the golden source')
    if candidate.get('implementation') != 'phoenix':
        raise ValueError('Candidate implementation identity is not Phoenix')
    if candidate.get('profile') != suite.get('profile'):
        raise ValueError('Candidate runtime profile does not match the production suite')
    if not isinstance(candidate.get('runtime'), str) or not candidate['runtime']:
        raise ValueError('Candidate runtime identity is missing')
    if not re.fullmatch(r'[0-9a-f]{64}', candidate.get('adapterSha256', '')):
        raise ValueError('Candidate adapter identity is malformed')
    if candidate.get('captureComplete') is not True:
        raise ValueError('Candidate capture is incomplete')
    if candidate.get('lateEffects') != []:
        raise ValueError('Candidate capture retained late effects')
    if candidate.get('failure'):
        raise ValueError('Candidate capture contains a top-level failure')

    suite_cases = suite.get('cases')
    candidate_cases = candidate.get('cases')
    if not isinstance(suite_cases, list) or not isinstance(candidate_cases, list):
        raise ValueError('Production suite and candidate cases must be arrays')
    suite_ids = [case.get('id') if isinstance(case, dict) else None for case in suite_cases]
    candidate_ids = [case.get('id') if isinstance(case, dict) else None for case in candidate_cases]
    if any(not isinstance(case_id, str) or not case_id for case_id in suite_ids):
        raise ValueError('Production suite contains a malformed case ID')
    if len(set(suite_ids)) != len(suite_ids):
        raise ValueError('Production suite case IDs are not unique')
    if any(not isinstance(case_id, str) or not case_id for case_id in candidate_ids):
        raise ValueError('Candidate contains a malformed case ID')
    if len(set(candidate_ids)) != len(candidate_ids):
        raise ValueError('Candidate case IDs are not unique')
    if candidate_ids != suite_ids:
        raise ValueError('Candidate case IDs or order do not match the production suite')
    for case in candidate_cases:
        if case.get('failure'):
            raise ValueError('Candidate capture contains a case failure: ' + case['id'])


def validate_golden_source(source, root, suite_path, reference_path):
    """Validate the source manifest and every required capture tool pin."""
    if source.get('schemaVersion') != 2 or source.get('referenceRevision') != REVISION:
        raise ValueError('Production golden source reference pin changed')
    source_files = source.get('files', {})
    if source_files.get('suite.json') != file_sha(suite_path) or source_files.get('reference.json.gz') != file_sha(reference_path):
        raise ValueError('Production golden source does not hash its retained files')
    capture_tools = source.get('originalCaptureTools')
    if not isinstance(capture_tools, dict) or set(capture_tools) != set(REQUIRED_CAPTURE_TOOLS):
        raise ValueError('Production golden source capture-tool set is incomplete')
    for path in REQUIRED_CAPTURE_TOOLS:
        expected = capture_tools.get(path)
        if not isinstance(expected, str) or not re.fullmatch(r'[0-9a-f]{64}', expected):
            raise ValueError('Production golden source capture-tool hash is malformed: ' + path)
        if file_sha(root / path) != expected:
            raise ValueError('Production golden capture tool changed: ' + path)
    if source.get('driverSha256') != capture_tools['scripts/parity-production/driver.cjs']:
        raise ValueError('Production golden source driver identity is inconsistent')
    source_review = source.get('review')
    if not isinstance(source_review, dict) or source_review.get('result') != 'pass':
        raise ValueError('Production golden source review is not passing')
    control = source.get('originalControlArtifact')
    if not control or not (root / control).is_file() or file_sha(root / control) != source.get('originalControlArtifactSha256'):
        raise ValueError('Production golden original-control provenance changed')
    return capture_tools


def validate_corpus_gate(catalog, contents, records, root=ROOT):
    """Validate a retained full-pipeline gate before attaching it to corpora.

    The coverage label is deliberately separate from the comparison result.  A
    mismatching run still proves that the named fixtures traversed the pipeline;
    it cannot be promoted to a passing parity gate without a separate review.
    """
    if catalog.get('schemaVersion') != 1 or catalog.get('referenceRevision') != REVISION:
        raise ValueError('Corpus gate catalog is not pinned to the frozen reference')
    gates = catalog.get('gates', [])
    if len(gates) != 1:
        raise ValueError('Expected exactly one source-pinned corpus gate')
    gate = gates[0]
    if gate.get('id') != 'production-v2-full' or gate.get('coverage') != 'partial':
        raise ValueError('The full corpus gate must remain explicitly partial')
    paths = ['suiteFile', 'sourceFile', 'referenceFile', 'evidenceFile', 'runFile',
             'phoenixSourceFile', 'comparisonFile', 'candidateFile']
    for field in paths:
        path = gate.get(field)
        if not isinstance(path, str) or not path or not (root / path).is_file():
            raise ValueError('Corpus gate artifact is missing: ' + field)
    hashes = gate.get('artifactSha256', {})
    if not {gate[field] for field in paths}.issubset(hashes):
        raise ValueError('Corpus gate artifact hash list is incomplete')
    for path, expected in hashes.items():
        if file_sha(root / path) != expected:
            raise ValueError('Corpus gate artifact bytes changed: ' + path)

    suite = read_json(root / gate['suiteFile'])
    source = read_json(root / gate['sourceFile'])
    review = read_json(root / gate['evidenceFile'])
    run = read_json(root / gate['runFile'])
    phoenix_source = read_json(root / gate['phoenixSourceFile'])
    comparison = json.loads(gzip.decompress((root / gate['comparisonFile']).read_bytes()))
    candidate = json.loads(gzip.decompress((root / gate['candidateFile']).read_bytes()))

    if suite.get('id') != gate['suite'] or suite.get('referenceRevision') != REVISION:
        raise ValueError('Corpus gate suite identity or reference pin changed')
    if suite.get('selection') != {'name': 'all', 'corpus': None, 'offset': 0, 'limit': 0}:
        raise ValueError('Corpus gate is not the complete all-corpus selection')
    resource_sources = suite.get('resourceSources', {})
    if resource_sources.get('referenceRevision') != REVISION:
        raise ValueError('Production suite resource-source reference pin changed')
    for entry in resource_sources.get('sources', []):
        if not isinstance(entry.get('path'), str) or not re.fullmatch(r'[0-9a-f]{64}', entry.get('sha256', '')):
            raise ValueError('Production suite source fixture pin is malformed')
    for name, expected in resource_sources.get('files', {}).items():
        path = root / 'scripts/parity-production/resources' / name
        if not path.is_file() or file_sha(path) != expected:
            raise ValueError('Production suite resource fixture changed: ' + name)
    capture_tools = validate_golden_source(source, root, root / gate['suiteFile'], root / gate['referenceFile'])

    validate_candidate_capture(candidate, suite, source, json_sha(suite))
    if run.get('candidate') != candidate.get('implementation'):
        raise ValueError('Full baseline run candidate identity does not match its candidate artifact')
    if run.get('selection') != suite.get('selection'):
        raise ValueError('Full baseline run selection does not match the production suite')
    if run.get('originalCaptureTools') != capture_tools or run.get('goldenSource') != source:
        raise ValueError('Full baseline run golden-source identity is inconsistent')

    if review.get('referenceRevision') != REVISION or review.get('result') != 'mismatch':
        raise ValueError('Full baseline review must retain the reviewed Phoenix mismatch')
    if review.get('completeCases') != gate['denominator']['totalCases']:
        raise ValueError('Full baseline case denominator changed')
    if run.get('referenceRevision') != REVISION or run.get('cases') != review.get('completeCases'):
        raise ValueError('Full baseline run provenance or case count changed')
    if run.get('phoenixSourceTreeSha256') != review.get('phoenixSourceTreeSha256') or phoenix_source.get('treeSha256') != review.get('phoenixSourceTreeSha256'):
        raise ValueError('Phoenix source fingerprint is not shared by run, review and source artifact')
    for name, expected in review.get('artifacts', {}).items():
        path = str(Path(gate['evidenceFile']).parent / name)
        if path not in hashes or hashes[path] != expected:
            raise ValueError('Review artifact is not pinned by the corpus gate: ' + name)
    for name, expected in run.get('artifacts', {}).items():
        path = str(Path(gate['runFile']).parent / name)
        # The archived review retains the candidate/comparison logs and source
        # fingerprint.  The runner's temporary suite/reference files are
        # intentionally not copied into docs/parity/evidence; do not claim
        # those unarchived paths are part of this gate.
        if (root / path).is_file() and (path not in hashes or hashes[path] != expected):
            raise ValueError('Run artifact is not pinned by the corpus gate: ' + name)

    expected = gate['denominator']
    if len(suite.get('cases', [])) != expected['totalCases'] or comparison.get('cases') != expected['totalCases'] or len(candidate.get('cases', [])) != expected['totalCases']:
        raise ValueError('Full pipeline artifacts disagree on total cases')
    groups = Counter(case.get('group') for case in suite['cases'])
    if groups['corpus'] != expected['corpusOccurrences'] or groups['parser-boundary'] != expected['boundaryCases'] or groups['direct-skill'] != expected['directSkillCases']:
        raise ValueError('Full suite boundary/corpus denominator changed')
    if expected['corpusOccurrences'] + expected['boundaryAndDirectCases'] != expected['totalCases']:
        raise ValueError('Corpus and boundary/direct denominators do not add up')
    if comparison.get('pass') is not False or len(comparison.get('differences', [])) != review.get('differences') or len(comparison.get('invariants', [])) != review.get('invariants') or len(comparison.get('coverageGaps', [])) != review.get('coverageGaps'):
        raise ValueError('Full comparison summary no longer matches its reviewed summary')

    suite_denominators = {d['corpus']: d for d in suite.get('denominators', [])}
    for record in records:
        name = record['id']
        expected_record = gate.get('corpora', {}).get(name)
        denominator = suite_denominators.get(name)
        if not expected_record or not denominator:
            raise ValueError('Missing full gate denominator for corpus: ' + name)
        if record['sha256'] != denominator.get('sha256') or record['entries'] != denominator.get('entries'):
            raise ValueError('Corpus source pin disagrees with production suite: ' + name)
        if record['utterances'] != denominator.get('baseOccurrences') or record['utteranceConditionPairs'] != denominator.get('conditionalOccurrences'):
            # fixtures.mjs calls each command/condition pair one conditional
            # occurrence; the inventory retains the same expanded denominator.
            raise ValueError('Corpus occurrence denominator changed: ' + name)
        cases = denominator['baseOccurrences'] + denominator['conditionalOccurrences']
        if expected_record != {'baseOccurrences': denominator['baseOccurrences'], 'conditionalOccurrences': denominator['conditionalOccurrences'], 'cases': cases}:
            raise ValueError('Corpus gate metadata disagrees with the suite: ' + name)
        actual_cases = [case for case in suite['cases'] if case.get('group') == 'corpus' and case.get('corpus') == name]
        if len(actual_cases) != cases or len([case for case in actual_cases if case.get('variant') == 'base']) != denominator['baseOccurrences'] or len([case for case in actual_cases if case.get('variant') == 'conditional']) != denominator['conditionalOccurrences']:
            raise ValueError('Corpus case expansion disagrees with its denominator: ' + name)
        if sha(contents[record['source']]) != record['sha256']:
            raise ValueError('Corpus source bytes changed: ' + name)

    if sum(d['baseOccurrences'] + d['conditionalOccurrences'] for d in suite_denominators.values()) != expected['corpusOccurrences']:
        raise ValueError('Production suite corpus denominators do not sum to the full corpus')
    return gate


def owner(path):
    """Responsibility mapping; this is not a claim that a scenario is covered."""
    if not path.startswith('packages/'):
        return ['R-02']
    package = path.split('/')[1]
    if package == 'hub':
        if '/asr/' in path or 'FastEOS' in path: return ['H-07', 'H-02']
        if '/config/' in path: return ['C-03']
        if '/intent/' in path: return ['H-03']
        if '/skill-list/' in path: return ['H-01']
        if '/skill/' in path or 'Redirect' in path or 'redirect' in path: return ['H-04']
        if 'SpeechHistory' in path or 'TransactionHelper' in path: return ['H-08']
        if '/proactive/' in path:
            return ['H-05'] if 'setting' in path.lower() else ['H-06']
        if 'SettingsClient' in path: return ['A-06', 'H-05']
        if 'ManifestSetting' in path: return ['C-03', 'A-06']
        return ['H-02', 'H-10']
    if package == 'parser':
        if 'LoopMemberDetector' in path: return ['N-06']
        if 'dialogflow' in path.lower(): return ['N-07']
        if '/rules_src/' in path or '/rules_fst/' in path:
            name = path.split('/rules_src/' if '/rules_src/' in path else '/rules_fst/')[1]
            family = name.split('/')[0]
            if family in ['clock', 'main-menu', 'settings']: return ['N-01', 'N-03']
            if family in ['introductions', 'greetings', 'who-am-i']: return ['N-01', 'N-04']
            if family in ['launch.rule', 'launch.fst', 'chitchat', 'report-skill', 'shared']: return ['N-01', 'N-02', 'N-08']
            return ['N-01', 'N-05']
        if 'RobustParserClient' in path or 'ConcurrentQueue' in path: return ['N-01', 'N-02']
        return ['N-01', 'N-08']
    if package in ['history', 'history-client']:
        if '/mongo/' in path or '/Mongo' in path: return ['I-03']
        if 'Request' in path or 'Service' in path or package == 'history-client': return ['I-01']
        return ['I-02', 'I-03']
    if package == 'lasso':
        if 'Calendar' in path: return ['D-04']
        if 'DarkSky' in path: return ['D-05']
        if 'APNews' in path: return ['D-06']
        if 'GoogleMaps' in path: return ['D-07']
        if '/oauth2/' in path: return ['D-03']
        if '/credential/' in path or '/mongo/' in path: return ['D-02']
        return ['D-01']
    if package == 'report-skill':
        if 'Views' in path: return ['S-13']
        for family, task in [('weather', 'S-09'), ('news', 'S-10'), ('commute', 'S-11'), ('calendar', 'S-12')]:
            if '/' + family + '/' in path: return [task]
        return ['S-08']
    if package == 'baseskill':
        if 'PromptData' in path or 'DateTime' in path: return ['S-05']
        if 'mim' in path.lower(): return ['S-03', 'S-04']
        if 'Global' in path or 'Speaker' in path: return ['S-02']
        return ['S-01', 'S-02']
    if package == 'chitchat-skill': return ['S-07']
    if package in ['example-skill', 'template-skill']: return ['S-14']
    if package == 'interfaces': return ['C-02']
    if package in ['hub-client', 'hub-client-cli', 'integration-tests-int', 'integration-tests-ext']: return ['R-01']
    if package == 'test-utils': return ['V-03', 'S-01']
    if package in ['utils', 'utils-common']:
        if '/config/' in path: return ['C-03']
        if '/service/' in path or '/http/' in path: return ['C-01', 'H-10']
        if '/socket/' in path or '/stream/' in path: return ['H-02', 'R-03']
        return ['C-02', 'R-03']
    raise ValueError('Unassigned package: ' + package)


def role(path):
    if re.search(r'(?:^|/)(?:tests?|res_test)/|\.(?:test|spec)\.[jt]s$', path): return 'test-code' if path.endswith(('.js', '.ts')) else 'test-resource'
    if path.endswith(('.js', '.ts')): return 'source-or-tooling'
    if path.endswith('.rule'): return 'grammar-source'
    if path.endswith('.fst'): return 'compiled-grammar'
    if path.endswith('.mim'): return 'dialog-resource'
    if path.endswith('.raw'): return 'audio-fixture'
    if '/factory/' in path or '/factory_' in path: return 'factory-resource'
    if 'manifest' in path.lower(): return 'manifest'
    if path.endswith(('.zip', '.so', '.a', '.bin')) or '/robust-parser/lib/' in path: return 'binary-or-library'
    if path.endswith(('.md', '.txt')): return 'documentation-or-data'
    return 'configuration-or-resource'


def git_blobs(repo, entries):
    """Batch object reads: no checkout mutation, credentials or service startup."""
    oids = [entry['blob'] for entry in entries]
    data = subprocess.check_output(['git', '-C', str(repo), 'cat-file', '--batch'], input=('\n'.join(oids) + '\n').encode())
    offset = 0
    for entry in entries:
        end = data.index(b'\n', offset)
        oid, kind, length = data[offset:end].decode().split()
        if oid != entry['blob'] or kind != 'blob': raise ValueError('Unexpected Git object response')
        start = end + 1; offset = start + int(length) + 1
        yield entry, data[start:offset-1]


def resource_copies():
    """Locate byte-identical Phoenix resource copies without reading archive secrets."""
    names = subprocess.check_output(['git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', 'packages'], cwd=ROOT).decode().split('\0')
    copies = defaultdict(list)
    for name in sorted(set(names)):
        if '/resources/' not in name or not (ROOT / name).is_file(): continue
        data = (ROOT / name).read_bytes()
        oid = hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest()
        copies[oid].append(name)
    return copies


def corpus_inventory(contents, gate_catalog):
    records, exact = [], defaultdict(list)
    for name, path in CORPORA.items():
        data = json.loads(contents[path]); tests = data['tests']; utterances = []
        conditional_entries = conditional_branches = conditional_pairs = absent_intent = 0
        for n, test in enumerate(tests):
            if not isinstance(test.get('command'), list) or any(not isinstance(t, str) for t in test['command']): raise ValueError('Malformed commands: ' + path)
            absent_intent += 'intent' not in test
            conditions = test.get('conditionalTests', [])
            conditional_entries += bool(conditions); conditional_branches += len(conditions)
            conditional_pairs += len(conditions) * len(test['command'])
            for j, text in enumerate(test['command']):
                utterances.append(text); exact[text].append({'corpus': name, 'entry': n, 'command': j})
        records.append({'id': name, 'source': path, 'sha256': sha(contents[path]), 'entries': len(tests), 'utterances': len(utterances),
                        'uniqueExactUtterances': len(set(utterances)), 'duplicateOccurrencesWithinCorpus': len(utterances)-len(set(utterances)),
                        'conditionalEntries': conditional_entries, 'conditionalBranches': conditional_branches, 'utteranceConditionPairs': conditional_pairs,
                        'entriesWithoutIntentField': absent_intent, 'entriesWithExplicitNullIntent': sum(t.get('intent', 'absent') is None for t in tests),
                        'fieldPresence': dict(sorted(Counter(k for t in tests for k in t).items())), 'tasks': ['N-08', 'S-07' if name != 'report' else 'S-08'],
                        'coverage': 'partial'})
    overlaps = []
    for i, a in enumerate(records):
        for b in records[i+1:]:
            shared = [text for text, uses in exact.items() if {a['id'], b['id']} <= {u['corpus'] for u in uses}]
            overlaps.append({'corpora': [a['id'], b['id']], 'uniqueExactUtterances': len(shared)})
    gate = validate_corpus_gate(gate_catalog, contents, records)
    for record in records:
        selected = gate['corpora'][record['id']]
        record['coverageGateId'] = gate['id']
        record['productionCases'] = selected['cases']
        record['productionDenominator'] = {'baseOccurrences': selected['baseOccurrences'], 'conditionalOccurrences': selected['conditionalOccurrences']}
        record['coverageGate'] = {'id': gate['id'], 'coverage': gate['coverage'], 'suite': gate['suite'],
                                  'suiteFile': gate['suiteFile'], 'sourceFile': gate['sourceFile'],
                                  'evidenceFile': gate['evidenceFile'], 'scope': gate['scope']}
    return {'schemaVersion': 2, 'referenceRevision': REVISION, 'corpora': records,
            'coverageGates': [gate], 'totalOccurrences': sum(r['utterances'] for r in records), 'uniqueExactUtterances': len(exact), 'overlaps': overlaps,
            'duplicateUtterances': {text: uses for text, uses in sorted(exact.items()) if len(uses)>1},
            'notes': ['Counts retain every entry/command occurrence and each corpus denominator; exact string duplicates are reported, not discarded.',
                      'Missing intent/entity fields mean missing manifest expectations, not a no-match requirement.',
                      'Conditional prompt branches are counted separately from base commands; no historical execution is inferred.',
                      'Partial coverage means the source-pinned production-v2 pipeline executed the named occurrences and retained a reviewed differential. It does not mean Phoenix passed the comparison or that provider, HubService and original-test gaps are closed.']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, default=ROOT.parent / 'pegasus')
    parser.add_argument('--out', type=Path, default=ROOT / '.parity/runs/coverage-inventory')
    parser.add_argument('--typescript', type=Path, default=ROOT / 'node_modules/typescript')
    parser.add_argument('--vendor-corpora', action='store_true', help='Add missing frozen manifests; reject changes to an existing vendored copy')
    args = parser.parse_args(); out = args.out.resolve(); out.mkdir(parents=True, exist_ok=True)
    raw = subprocess.check_output(['git', '-C', str(args.source.resolve()), 'ls-tree', '-rlz', REVISION])
    files = []
    copies = resource_copies()
    for line in raw.split(b'\0'):
        if not line: continue
        meta, name = line.split(b'\t', 1); mode, kind, oid, size = meta.decode().split(); name = name.decode()
        if kind != 'blob': raise ValueError('Unexpected non-blob source entry: ' + name)
        files.append({'path': name, 'blob': oid, 'bytes': int(size), 'mode': mode, 'role': role(name), 'tasks': owner(name)})
        if files[-1]['role'] not in ['source-or-tooling', 'test-code']:
            files[-1]['phoenixExactResourceCopies'] = copies.get(oid, [])
    required = [f for f in files if f['path'].endswith(('.js', '.ts', '.rule', '.mim', '.json'))]
    contents = {entry['path']: body for entry, body in git_blobs(args.source.resolve(), required)}
    sources = [{'path': f['path'], 'text': contents[f['path']].decode()} for f in required if f['path'].endswith(('.js', '.ts'))]
    scan = subprocess.run(['node', ROOT / 'scripts/parity-coverage/scan.cjs', args.typescript.resolve()], input=json.dumps(sources).encode(), stdout=subprocess.PIPE)
    if not scan.stdout:
        raise RuntimeError('Source scanner failed; check the TypeScript dependency and preceding error')
    facts = json.loads(scan.stdout)
    (out / 'syntax-facts.json').write_text(json.dumps(facts, indent=2) + '\n')
    expected = json.loads((ROOT / 'scripts/parity-coverage/source-exceptions.json').read_text())['syntaxDiagnostics']
    actual = defaultdict(list)
    for diagnostic in facts['diagnostics']: actual[diagnostic['path']].append(diagnostic['code'])
    allowed = {entry['path']: entry['codes'] for entry in expected}
    blobs = {entry['path']: entry['blob'] for entry in files}
    if dict(actual) != allowed or any(blobs.get(e['path']) != e['blob'] for e in expected):
        raise ValueError('Source syntax diagnostics or pinned exception changed: ' + json.dumps(facts['diagnostics']))
    for group, kind in [('tests', 'test'), ('registrations', 'registration'), ('contracts', 'contract'), ('manualRequests', 'manual-request')]:
        for entry in facts[group]:
            entry['id'] = kind + ':' + entry['path'] + ':' + str(entry['line']) + ':' + str(entry['column'])
            entry['tasks'] = owner(entry['path']); entry['coverage'] = 'missing'
    expansion = json.loads((ROOT / 'scripts/parity-coverage/test-expansions.json').read_text())
    if any(blobs.get(p) != oid for p, oid in expansion['sources'].items()): raise ValueError('A source used for test expansion changed')
    expanded = {(e['path'], e['line']): e for e in expansion['expansions']}
    used = set(); cases = []
    for declaration in facts['tests']:
        key = (declaration['path'], declaration['line'])
        if declaration['multiplicity'] == 'dynamic-or-factory':
            if key not in expanded: raise ValueError('Unexpanded test declaration: ' + declaration['id'])
            used.add(key); instances = expanded[key]['instances']; basis = expanded[key]['basis']
        else:
            instances = [{'title': declaration['title']}]; basis = 'Single literal registration in frozen source'
        for n, instance in enumerate(instances):
            cases.append({'id': declaration['id'] + ':instance:' + str(n), 'declaration': declaration['id'], 'path': declaration['path'],
                          'line': declaration['line'], 'suites': declaration['suites'], **instance, 'expansionBasis': basis,
                          'originalSkipped': declaration['originalSkipped'], 'originalOnly': declaration['originalOnly'],
                          'tasks': declaration['tasks'], 'coverage': 'missing'})
    if used != set(expanded): raise ValueError('An expansion is stale or no longer describes a dynamic declaration')
    public = json.loads((ROOT / 'scripts/parity-coverage/public-operations.json').read_text())
    if public['referenceRevision'] != REVISION or any(blobs.get(p) != oid for p, oid in public['sources'].items()): raise ValueError('Public operation source pins changed')
    registration_ids = {r['id'] for r in facts['registrations']}
    accounted = {r for o in public['operations'] for r in o['registrations']} | {b['registration'] for b in public['sharedBoundaries']}
    if accounted != registration_ids: raise ValueError('Unclassified or stale route registration: ' + str(accounted ^ registration_ids))
    operation_ids = {o['id'] for o in public['operations']}
    if len(operation_ids) != len(public['operations']): raise ValueError('Duplicate public operation')
    for operation in public['operations']:
        if not set(operation.get('derivedFrom', [])) <= operation_ids: raise ValueError('Missing parent operation: ' + operation['id'])
    suites = {}
    for item in public['operations'] + public['sharedBoundaries']:
        if item['coverage'] not in ['missing', 'partial', 'covered']: raise ValueError('Invalid coverage status')
        gates = item.get('gates', [])
        if (item['coverage'] == 'missing') == bool(gates): raise ValueError('Coverage must be supported by explicit gates: ' + str(item))
        for gate in gates:
            if gate['suiteFile'] not in suites: suites[gate['suiteFile']] = json.loads((ROOT / gate['suiteFile']).read_text())
            suite = suites[gate['suiteFile']]
            if suite['id'] != gate['suite'] or not set(gate['cases']) <= {c['id'] for c in suite['cases']}: raise ValueError('Stale suite/case mapping')
            if not gate['scope'] or not (ROOT / gate['evidence']).is_file(): raise ValueError('Coverage requires scope and retained evidence')
    grammars = []
    for f in files:
        if not f['path'].endswith('.rule'): continue
        relative = f['path'].split('/rules_src/')[-1] if '/rules_src/' in f['path'] else None
        target = ('packages/nlu/resources/grammar/' + (relative if relative.startswith(('globals/', 'shared/')) else 'skills/' + relative)) if relative else None
        copies = [path for path in f.get('phoenixExactResourceCopies', []) if path.startswith('packages/nlu/resources/')]
        grammars.append({**f, 'id': 'grammar:' + f['path'], 'sha256': sha(contents[f['path']]), 'sourceRulePath': relative,
                         'phoenixFile': target,
                         # Byte identity answers the preservation question at
                         # the source-resource level.  The mapped runtime
                         # location is recorded separately because neither
                         # identity proves that Phoenix loads or interprets a
                         # rule equivalently.
                         'phoenixBytesIdentical': bool(copies),
                         'phoenixMappedGrammarBytesIdentical': bool(target and (ROOT / target).is_file() and (ROOT / target).read_bytes() == contents[f['path']]),
                         'phoenixByteIdenticalResourceCopies': copies,
                         'phoenixByteIdenticalResourceCopyCount': len(copies),
                         'coverage': 'missing'})
    compiled_rules = [{**f, 'id': 'compiled-rule:' + f['path'], 'ruleName': f['path'].split('/rules_fst/')[1][:-4], 'coverage': 'missing'}
                      for f in files if f['path'].endswith('.fst') and '/rules_fst/' in f['path']]
    asset_sets = defaultdict(list)
    for f in files:
        if f['role'] not in ['source-or-tooling', 'test-code']:
            package = f['path'].split('/')[1] if f['path'].startswith('packages/') else 'repository'
            asset_sets[package + ':' + f['role']].append(f['path'])
    corpus = corpus_inventory(contents, read_json(CORPUS_GATES))
    if args.vendor_corpora:
        manifests = []
        for name, source in CORPORA.items():
            target = ROOT / VENDORED_CORPORA[name]
            target.parent.mkdir(parents=True, exist_ok=True)
            if target.exists() and target.read_bytes() != contents[source]: raise ValueError('Vendored corpus changed: ' + str(target))
            if not target.exists(): target.write_bytes(contents[source])
            manifests.append({'id': name, 'source': source, 'blob': blobs[source], 'path': VENDORED_CORPORA[name], 'sha256': sha(contents[source])})
        record = {'schemaVersion': 1, 'referenceRevision': REVISION, 'manifests': manifests,
                  'notes': ['Unmodified original data, including absent fields and conditional expectations.', 'No deduplication or intent inference was applied.']}
        (ROOT / 'packages/harness/resources/corpora/sources.json').write_text(json.dumps(record, indent=2) + '\n')
    inventory = {'schemaVersion': 1, 'referenceRevision': REVISION, 'method': 'Frozen Git object inventory and TypeScript 2.5.3 syntax-tree discovery; no original tests executed by this scanner.',
                 'sourceFiles': files, 'testDeclarations': facts['tests'], 'sourceTestCases': cases, 'routeRegistrations': facts['registrations'],
                 'publicOperations': public['operations'], 'sharedHttpBoundaries': public['sharedBoundaries'], 'wireContracts': facts['contracts'],
                 'grammars': grammars, 'compiledRules': compiled_rules, 'manualRequests': facts['manualRequests'], 'sourceSyntaxExceptions': expected,
                 'corpusCoverageGates': corpus['coverageGates'],
                 'assetSets': [{'id': k, 'files': v, 'tasks': sorted(set(t for p in v for t in owner(p))), 'coverage': 'missing',
                                'byteIdenticalCopies': sum(bool(f.get('phoenixExactResourceCopies')) for f in files if f['path'] in v),
                                'preservationMeaning': 'Identical Git blob in a Phoenix packages/*/resources path; functional behavior is separately unverified.'}
                               for k,v in sorted(asset_sets.items())],
                 'counts': {'sourceFiles': len(files), 'testDeclarations': len(facts['tests']), 'expandedSourceCases': len(cases), 'singleTestDeclarations': sum(t['multiplicity']=='single-declaration' for t in facts['tests']),
                            'dynamicTestDeclarations': sum(t['multiplicity']=='dynamic-or-factory' for t in facts['tests']), 'originalSkippedDeclarations': sum(t['originalSkipped'] for t in facts['tests']),
                            'originalPendingDeclarations': sum(t['originalPending'] for t in facts['tests']), 'routeRegistrations': len(facts['registrations']),
                            'publicOperations': len(public['operations']), 'explicitPublicOperations': sum(o['origin']=='explicit-or-inherited-registration' for o in public['operations']), 'wireContracts': len(facts['contracts']),
                            'grammarFiles': len(grammars), 'runtimeGrammarSources': sum(g['sourceRulePath'] is not None for g in grammars),
                            # Keep mapped runtime locations distinct from the
                            # 117 byte-identical rules-src copies. Neither is
                            # functional coverage; each grammar remains
                            # coverage=missing until an executable rule gate
                            # proves it is loaded and interpreted.
                            'identicalPhoenixGrammarSources': sum(g['phoenixBytesIdentical'] for g in grammars),
                            # One count is by named runtime source (117 of
                            # 117 have at least one exact Phoenix resource
                            # copy); the path count also retains duplicate
                            # resource placements for auditability.
                            'byteIdenticalPhoenixGrammarCopies': sum(bool(g['sourceRulePath'] is not None and g['phoenixByteIdenticalResourceCopyCount']) for g in grammars),
                            'byteIdenticalPhoenixGrammarResourceFiles': sum(g['phoenixByteIdenticalResourceCopyCount'] for g in grammars),
                            'identicalMappedRuntimeGrammarSources': sum(g['phoenixMappedGrammarBytesIdentical'] for g in grammars),
                            'compiledRuntimeRules': len(compiled_rules),
                            'manualRequests': len(facts['manualRequests']), 'assetSets': len(asset_sets),
                            'corpusCoverageGates': len(corpus['coverageGates']),
                            'partialCorpusOccurrences': sum(r['productionCases'] for r in corpus['corpora']),
                            'productionBoundaryAndDirectCases': corpus['coverageGates'][0]['denominator']['boundaryAndDirectCases'],
                            'productionCases': corpus['coverageGates'][0]['denominator']['totalCases'],
                            'operationsWithPartialGates': sum(o['coverage']=='partial' for o in public['operations']),
                            'operationsWithCompleteGates': sum(o['coverage']=='covered' for o in public['operations'])},
                 'coverageDefinitions': {'missing': 'No reviewed strict executable parity gate mapped yet; existing implementation or unit tests may exist.',
                                         'partial': 'The listed gate covers its stated cases but leaves other source branches/inputs unverified; observed differences may remain.',
                                         'covered': 'All inventoried behavior for this item has a reviewed executable gate. This describes coverage, not a passing result.'},
                 'limitations': ['Source cases include reviewed loop/title expansion and skips; they do not claim that the original runner imported or executed every file.',
                                 'Public operations include every reviewed mount/alias and derived HEAD/OPTIONS route. Bodies/errors/configuration branches still need per-operation parity gates.',
                                 'Path-based task ownership assigns responsibility; coverage requires a reviewed executable mapping.',
                                 'Corpora, scenarios, grammars, contracts and assets overlap and must not be summed into a feature percentage.',
                                 'Corpus partial status records full-pipeline execution evidence with source and artifact pins; it does not certify Phoenix parity, provider behavior, full HubService orchestration or original-test completion.',
                                 'Grammar byte identity is reported separately from functional interpretation: 117 runtime sources have exact Phoenix rules-src copies, while 29 also match the mapped runtime grammar locations.']}
    valid_tasks = {task['id'] for task in json.loads((ROOT / 'docs/parity/tasks.json').read_text())['tasks']}
    for group in ['sourceFiles', 'sourceTestCases', 'routeRegistrations', 'publicOperations', 'sharedHttpBoundaries', 'wireContracts', 'grammars', 'compiledRules', 'manualRequests', 'assetSets']:
        for item in inventory[group]:
            if not item['tasks'] or not set(item['tasks']) <= valid_tasks: raise ValueError('Unassigned or invalid task in ' + group)
    for name, obj in [('source-inventory.json', inventory), ('corpora.json', corpus), ('syntax-facts.json', facts)]:
        (out / name).write_text(json.dumps(obj, indent=2) + '\n')
    print(json.dumps({'counts': inventory['counts'], 'corpora': corpus['corpora'], 'overlaps': corpus['overlaps'], 'uniqueExactUtterances': corpus['uniqueExactUtterances']}, indent=2))


if __name__ == '__main__': main()
