#!/usr/bin/env python3
"""Inventory original Git objects, test declarations, corpora and resources."""
import argparse
from collections import Counter, defaultdict
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


def sha(data):
    return hashlib.sha256(data).hexdigest()


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


def corpus_inventory(contents):
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
                        'coverage': 'missing-strict-production-grade'})
    overlaps = []
    for i, a in enumerate(records):
        for b in records[i+1:]:
            shared = [text for text, uses in exact.items() if {a['id'], b['id']} <= {u['corpus'] for u in uses}]
            overlaps.append({'corpora': [a['id'], b['id']], 'uniqueExactUtterances': len(shared)})
    return {'corpora': records, 'totalOccurrences': sum(r['utterances'] for r in records), 'uniqueExactUtterances': len(exact), 'overlaps': overlaps,
            'duplicateUtterances': {text: uses for text, uses in sorted(exact.items()) if len(uses)>1},
            'notes': ['Counts retain every entry/command occurrence and each corpus denominator; exact string duplicates are reported, not discarded.',
                      'Missing intent/entity fields mean missing manifest expectations, not a no-match requirement.',
                      'Conditional prompt branches are counted separately from base commands; no historical execution is inferred.']}


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
        grammars.append({**f, 'id': 'grammar:' + f['path'], 'sha256': sha(contents[f['path']]), 'sourceRulePath': relative,
                         'phoenixFile': target, 'phoenixBytesIdentical': bool(target and (ROOT / target).is_file() and (ROOT / target).read_bytes() == contents[f['path']]), 'coverage': 'missing'})
    compiled_rules = [{**f, 'id': 'compiled-rule:' + f['path'], 'ruleName': f['path'].split('/rules_fst/')[1][:-4], 'coverage': 'missing'}
                      for f in files if f['path'].endswith('.fst') and '/rules_fst/' in f['path']]
    asset_sets = defaultdict(list)
    for f in files:
        if f['role'] not in ['source-or-tooling', 'test-code']:
            package = f['path'].split('/')[1] if f['path'].startswith('packages/') else 'repository'
            asset_sets[package + ':' + f['role']].append(f['path'])
    corpus = corpus_inventory(contents)
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
                 'assetSets': [{'id': k, 'files': v, 'tasks': sorted(set(t for p in v for t in owner(p))), 'coverage': 'missing',
                                'byteIdenticalCopies': sum(bool(f.get('phoenixExactResourceCopies')) for f in files if f['path'] in v),
                                'preservationMeaning': 'Identical Git blob in a Phoenix packages/*/resources path; functional behavior is separately unverified.'}
                               for k,v in sorted(asset_sets.items())],
                 'counts': {'sourceFiles': len(files), 'testDeclarations': len(facts['tests']), 'expandedSourceCases': len(cases), 'singleTestDeclarations': sum(t['multiplicity']=='single-declaration' for t in facts['tests']),
                            'dynamicTestDeclarations': sum(t['multiplicity']=='dynamic-or-factory' for t in facts['tests']), 'originalSkippedDeclarations': sum(t['originalSkipped'] for t in facts['tests']),
                            'originalPendingDeclarations': sum(t['originalPending'] for t in facts['tests']), 'routeRegistrations': len(facts['registrations']),
                            'publicOperations': len(public['operations']), 'explicitPublicOperations': sum(o['origin']=='explicit-or-inherited-registration' for o in public['operations']), 'wireContracts': len(facts['contracts']),
                            'grammarFiles': len(grammars), 'runtimeGrammarSources': sum(g['sourceRulePath'] is not None for g in grammars),
                            'identicalPhoenixGrammarSources': sum(g['phoenixBytesIdentical'] for g in grammars), 'compiledRuntimeRules': len(compiled_rules),
                            'manualRequests': len(facts['manualRequests']), 'assetSets': len(asset_sets),
                            'operationsWithPartialGates': sum(o['coverage']=='partial' for o in public['operations']),
                            'operationsWithCompleteGates': sum(o['coverage']=='covered' for o in public['operations'])},
                 'coverageDefinitions': {'missing': 'No reviewed strict executable parity gate mapped yet; existing implementation or unit tests may exist.',
                                         'partial': 'The listed gate covers its stated cases but leaves other source branches/inputs unverified; observed differences may remain.',
                                         'covered': 'All inventoried behavior for this item has a reviewed executable gate. This describes coverage, not a passing result.'},
                 'limitations': ['Source cases include reviewed loop/title expansion and skips; they do not claim that the original runner imported or executed every file.',
                                 'Public operations include every reviewed mount/alias and derived HEAD/OPTIONS route. Bodies/errors/configuration branches still need per-operation parity gates.',
                                 'Path-based task ownership assigns responsibility; coverage requires a reviewed executable mapping.',
                                 'Corpora, scenarios, grammars, contracts and assets overlap and must not be summed into a feature percentage.']}
    valid_tasks = {task['id'] for task in json.loads((ROOT / 'docs/parity/tasks.json').read_text())['tasks']}
    for group in ['sourceFiles', 'sourceTestCases', 'routeRegistrations', 'publicOperations', 'sharedHttpBoundaries', 'wireContracts', 'grammars', 'compiledRules', 'manualRequests', 'assetSets']:
        for item in inventory[group]:
            if not item['tasks'] or not set(item['tasks']) <= valid_tasks: raise ValueError('Unassigned or invalid task in ' + group)
    for name, obj in [('source-inventory.json', inventory), ('corpora.json', corpus), ('syntax-facts.json', facts)]:
        (out / name).write_text(json.dumps(obj, indent=2) + '\n')
    print(json.dumps({'counts': inventory['counts'], 'corpora': corpus['corpora'], 'overlaps': corpus['overlaps'], 'uniqueExactUtterances': corpus['uniqueExactUtterances']}, indent=2))


if __name__ == '__main__': main()
