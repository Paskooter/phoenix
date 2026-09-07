#!/usr/bin/env python3
"""Capture isolated original/Phoenix production traces and fail on differences."""
import argparse
from datetime import datetime, timezone
import gzip
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import time
import uuid

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('foundation_runner', ROOT / 'scripts/parity-compare/run.py')
foundation = importlib.util.module_from_spec(spec)
spec.loader.exec_module(foundation)
REVISION = foundation.REVISION
sha = foundation.sha
APPROVED_RULE_INVENTORY_SHA256 = '4377949617eb3169f1466ddb2844f2f5f9948f43e1942a2e35f38c3664dc4aa5'
APPROVED_REFERENCE_REVISION = '5c0a7390539663ba749d360de348a428c088505c'
APPROVED_PUBLIC_RULE_COUNT = 98


def sha_bytes(value):
    return hashlib.sha256(value).hexdigest()


def compiled_rule_snapshot(rules_dir):
    """Verify every public graph selected by the pinned NLU inventory."""
    inventory_path = ROOT / 'packages/nlu/resources/rule-inventory.json'
    inventory_hash = sha(inventory_path)
    if inventory_hash != APPROVED_RULE_INVENTORY_SHA256:
        raise ValueError('Compiled rule inventory hash does not match the approved profile')
    inventory = json.loads(inventory_path.read_text())
    if inventory.get('referenceRevision') != APPROVED_REFERENCE_REVISION:
        raise ValueError('Compiled rule inventory reference revision is not approved')
    public_rules = inventory.get('publicRules', {})
    if len(public_rules) != APPROVED_PUBLIC_RULE_COUNT:
        raise ValueError('Compiled rule inventory public-rule count is not approved')
    root = rules_dir.resolve()
    files = {}
    manifest = hashlib.sha256()
    for name, entry in public_rules.items():
        compiled_path = entry.get('compiledPath')
        expected = entry.get('sha256')
        if not isinstance(compiled_path, str) or not isinstance(expected, str):
            raise ValueError('Compiled rule inventory entry is incomplete: ' + name)
        path = (root / compiled_path).resolve()
        try:
            inside = os.path.commonpath([str(root), str(path)]) == str(root)
        except ValueError:
            inside = False
        if not inside: raise ValueError('Compiled rule path escapes graph directory: ' + name)
        if not path.is_file(): raise ValueError('Compiled rule is unavailable: ' + str(path))
        actual = sha(path)
        if actual != expected: raise ValueError('Compiled rule hash mismatch: ' + str(path))
        files[name] = actual
        manifest.update(name.encode())
        manifest.update(b'\0')
        manifest.update(compiled_path.encode())
        manifest.update(b'\0')
        manifest.update(actual.encode())
    return {
        'ruleFiles': files,
        'ruleCount': len(files),
        'ruleManifestSha256': manifest.hexdigest(),
        'inventorySha256': inventory_hash,
    }


def compiled_snapshot_profile(manifest_path):
    """Validate a provisioned JSON/gzip snapshot tree before it is mounted."""
    manifest_path = manifest_path.resolve()
    if not manifest_path.is_file(): raise ValueError('Compiled snapshot profile is unavailable: ' + str(manifest_path))
    try:
        manifest = json.loads(manifest_path.read_text())
    except Exception as error:
        raise ValueError('Compiled snapshot profile is invalid: ' + str(error))
    if not isinstance(manifest, dict) or manifest.get('kind') != 'compiled-fst-profile' or not isinstance(manifest.get('format'), dict):
        raise ValueError('Compiled snapshot profile schema is unsupported')
    storage = manifest['format'].get('storage', 'json')
    if storage not in ('json', 'gzip'):
        raise ValueError('Compiled snapshot storage is unsupported: ' + str(storage))
    profile = manifest.get('profile')
    if not isinstance(profile, dict):
        raise ValueError('Compiled snapshot profile provenance is malformed')
    graphs = manifest.get('graphs', {})
    factories = manifest.get('factories', {})
    if not isinstance(graphs, dict) or len(graphs) != APPROVED_PUBLIC_RULE_COUNT:
        raise ValueError('Compiled snapshot profile must contain all 98 public graphs')
    if not isinstance(factories, dict) or len(factories) != 15:
        raise ValueError('Compiled snapshot profile must contain all 15 factory FSTs')
    root = manifest_path.parent
    files = {}

    def provisioned_path(relative_path, label):
        if not isinstance(relative_path, str) or not relative_path or os.path.isabs(relative_path):
            raise ValueError('Compiled snapshot path is not relative: ' + label)
        path = (root / relative_path).resolve()
        try:
            inside = os.path.commonpath([str(root), str(path)]) == str(root)
        except ValueError:
            inside = False
        if not inside or not path.is_file():
            raise ValueError('Compiled snapshot artifact is unavailable: ' + label)
        return path

    def verify_snapshot(entry, label):
        if not isinstance(entry, dict): raise ValueError('Compiled snapshot entry is malformed: ' + label)
        if entry.get('compression', 'json') != storage:
            raise ValueError('Compiled snapshot entry storage does not match the profile: ' + label)
        path = provisioned_path(entry.get('path'), label)
        stored = path.read_bytes()
        if storage == 'gzip':
            expected_hash = entry.get('storedSha256')
            expected_bytes = entry.get('storedBytes')
            if not isinstance(expected_hash, str) or not isinstance(expected_bytes, int):
                raise ValueError('Compressed snapshot metadata is incomplete: ' + label)
            if sha(path) != expected_hash or len(stored) != expected_bytes:
                raise ValueError('Compressed snapshot hash/size mismatch: ' + label)
            try:
                decoded = gzip.decompress(stored)
            except Exception as error:
                raise ValueError('Compressed snapshot cannot be decoded: ' + label + ': ' + str(error))
        else:
            decoded = stored
        if sha_bytes(decoded) != entry.get('snapshotSha256') or len(decoded) != entry.get('snapshotBytes'):
            raise ValueError('Snapshot decoded hash/size mismatch: ' + label)
        relative_path = str(path.relative_to(root))
        if relative_path in files:
            raise ValueError('Compiled snapshot artifacts reuse one path: ' + relative_path)
        files[relative_path] = sha(path)

    for name, entry in graphs.items(): verify_snapshot(entry, 'graph ' + name)
    for name, entry in factories.items(): verify_snapshot(entry, 'factory ' + name)
    factory_files = manifest.get('factoryFiles', {})
    if not isinstance(factory_files, dict) or len(factory_files) != 16:
        raise ValueError('Compiled snapshot profile must retain all 16 factory-file provenance entries')
    return {
        'manifest': str(manifest_path),
        'manifestSha256': sha(manifest_path),
        'root': str(root),
        'storage': storage,
        'graphCount': len(graphs),
        'factoryCount': len(factories),
        'factoryFileCount': len(factory_files),
        'files': files,
        'decodedHashAnchorSha256': profile.get('decodedHashAnchorSha256'),
    }


def reference_integrity(source, ref):
    prepared = json.loads((ref / 'parity-prepared.json').read_text())
    compiled = json.loads((ref / 'parity-compiled.json').read_text())
    if prepared['referenceRevision'] != REVISION or compiled['referenceRevision'] != REVISION or compiled['runtime'] != 'v8.9.4' or compiled['compiler'] != '2.5.3':
        raise ValueError('Original source/compiler/runtime provenance changed')
    if sha(ref / 'package.json') != prepared['rootManifestSha256'] or sha(ref / 'yarn.lock') != prepared['relocatedLockSha256']:
        raise ValueError('Reference dependency bootstrap changed')
    # Reconcile directly with Git, including grammars, manifests, MIMs and CSVs.
    tree = subprocess.check_output(['git', '-C', source, 'ls-tree', '-rz', REVISION])
    count = 0
    for entry in tree.split(b'\0'):
        if not entry: continue
        meta, filename = entry.split(b'\t', 1)
        mode, kind, oid = meta.decode().split(); filename = filename.decode()
        if kind != 'blob': raise ValueError('Unexpected original object kind')
        if filename in ['package.json', 'yarn.lock']: continue  # Explicit, validated relocations above.
        file = ref / filename
        if mode == '120000':
            if not file.is_symlink(): raise ValueError('Original symbolic link was replaced: ' + filename)
            data = os.readlink(file).encode()
        else:
            if file.is_symlink(): raise ValueError('Original regular file was replaced by a symbolic link: ' + filename)
            data = file.read_bytes()
        actual = hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest()
        if actual != oid: raise ValueError('Original source/resource changed: ' + filename)
        count += 1
    for filename, expected in compiled['outputs'].items():
        if sha(ref / filename) != expected: raise ValueError('Original emitted module changed: ' + filename)
    fixture_sources = json.loads((ROOT / 'scripts/parity-production/resources/sources.json').read_text())
    for entry in fixture_sources['sources']:
        if sha(ref / entry['path']) != entry['sha256']: raise ValueError('Exported original fixture source changed')
    binary = ref / 'packages/parser/robust-parser/build/bin/jibo-nlu-service'
    if sha(binary) != 'c89487321aeea14dba3e6408e61050f007a9a052b5e2c27283cf58f0e8a1fd54': raise ValueError('Native NLU 2.8.3 executable changed')
    return {'originalGitFiles': count, 'intentionalBootstrapRelocations': 2, 'emittedFiles': len(compiled['outputs']),
            'emissionRecordSha256': sha(ref / 'parity-compiled.json'), 'binarySha256': sha(binary), 'fixtureSourcesSha256': sha(ROOT / 'scripts/parity-production/resources/sources.json')}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, default=ROOT.parent / 'pegasus')
    parser.add_argument('--out', type=Path, default=ROOT / '.parity/runs/production')
    parser.add_argument('--candidate', choices=['original', 'phoenix'], default='phoenix')
    parser.add_argument('--selection', choices=['smoke', 'all', 'corpus'], default='smoke')
    parser.add_argument('--corpus', choices=['chitchat', 'hub-client', 'report'])
    parser.add_argument('--offset', type=int, default=0)
    parser.add_argument('--limit', type=int, default=0)
    parser.add_argument('--golden', type=Path, help='Use a reviewed, hash-pinned golden directory; no original installation required')
    parser.add_argument('--docker-host', default='unix:///var/run/docker.sock')
    parser.add_argument('--compiled-fst', type=Path, help='Explicit Phoenix compiled launch graph; requires the verified graph and factory directories')
    parser.add_argument('--compiled-factory-dir', type=Path)
    parser.add_argument('--compiled-rules-dir', type=Path, help='Pinned parent directory containing the inventory compiledPath graph files')
    parser.add_argument('--compiled-fst-sha256')
    parser.add_argument('--compiled-snapshot-manifest', type=Path, help='Explicit Phoenix decoded JSON/gzip snapshot profile; mounts its complete artifact directory')
    args = parser.parse_args()
    compiled_options = [args.compiled_fst, args.compiled_factory_dir, args.compiled_rules_dir, args.compiled_fst_sha256]
    if any(compiled_options) and not all(compiled_options):
        parser.error('The compiled profile requires --compiled-fst, --compiled-factory-dir, --compiled-rules-dir and --compiled-fst-sha256')
    if any(compiled_options) and args.candidate != 'phoenix':
        parser.error('The compiled profile selects a Phoenix implementation only')
    if args.compiled_snapshot_manifest and any(compiled_options):
        parser.error('The JSON snapshot profile cannot be combined with binary compiled artifact settings')
    if args.compiled_snapshot_manifest and args.candidate != 'phoenix':
        parser.error('The JSON snapshot profile selects a Phoenix implementation only')
    compiled = None
    if all(compiled_options):
        fst = args.compiled_fst.resolve(); factories = args.compiled_factory_dir.resolve(); rules = args.compiled_rules_dir.resolve()
        if not fst.is_file() or not factories.is_dir() or not rules.is_dir(): parser.error('Compiled artifacts are unavailable')
        if sha(fst) != args.compiled_fst_sha256: parser.error('Compiled launch graph hash does not match --compiled-fst-sha256')
        rule_snapshot = compiled_rule_snapshot(rules)
        if rule_snapshot['ruleFiles'].get('launch') != args.compiled_fst_sha256:
            parser.error('Compiled launch graph does not match the pinned public-rule inventory')
        compiled = {'fst': str(fst), 'factoryDir': str(factories), 'rulesDir': str(rules),
                    'fstSha256': args.compiled_fst_sha256,
                    'factoryFiles': {p.name: sha(p) for p in sorted(factories.iterdir())}, **rule_snapshot}
    compiled_snapshot = None
    if args.compiled_snapshot_manifest:
        try:
            compiled_snapshot = compiled_snapshot_profile(args.compiled_snapshot_manifest)
        except ValueError as error:
            parser.error(str(error))
    if args.golden and args.candidate != 'phoenix': parser.error('--golden is for Phoenix grading')
    if args.golden and (args.selection != 'smoke' or args.corpus or args.offset or args.limit): parser.error('A golden fixes its own complete selection; selection filters are not allowed')
    if not args.golden and args.selection != 'corpus' and (args.corpus or args.offset or args.limit): parser.error('Corpus/offset/limit options require --selection corpus')
    if args.selection == 'corpus' and not args.corpus: parser.error('--selection corpus requires --corpus')
    if args.offset < 0 or args.limit < 0: parser.error('Offsets/limits must be nonnegative')
    out = args.out.resolve(); out.mkdir(parents=True, exist_ok=True)
    if any(out.iterdir()): parser.error('Output directory must be empty; retain earlier evidence in its own directory')
    ref = ROOT / '.parity/reference' / REVISION
    docker = ['docker', '-H', args.docker_host]
    record = {'date': datetime.now(timezone.utc).isoformat(), 'referenceRevision': REVISION, 'candidate': args.candidate,
              'images': {'original': foundation.ORIGINAL_IMAGE, 'phoenix': foundation.PHOENIX_IMAGE}, 'commands': [], 'result': 'error'}
    if compiled:
        record['candidateNluProfile'] = {'runtime': 'compiled-fst', **compiled}
    elif compiled_snapshot:
        record['candidateNluProfile'] = {'runtime': 'compiled-fst-snapshot', **compiled_snapshot}
    else:
        record['candidateNluProfile'] = {'runtime': 'default'}
    capture_tools = {name: sha(ROOT / name) for name in ['scripts/parity-production/driver.cjs', 'scripts/parity-production/capture-writer.cjs', 'scripts/parity-production/original.cjs', 'scripts/parity-production/fixtures.mjs']}
    record['originalCaptureTools'] = capture_tools
    containers = []

    def step(name, argv, timeout=240, allowed=(0,)):
        command = {'name': name, 'argv': list(map(str, argv)), 'shellDisplay': shlex.join(map(str, argv))}
        record['commands'].append(command); print(name, flush=True); started = time.monotonic()
        try:
            with (out / (name + '.log')).open('w') as log:
                result = subprocess.run(argv, cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, timeout=timeout)
            command['exitCode'] = result.returncode
        except subprocess.TimeoutExpired:
            command['timedOut'] = True; raise
        finally: command['durationMs'] = round((time.monotonic() - started) * 1000, 3)
        if result.returncode not in allowed: raise RuntimeError(name + ' failed; see ' + str(out / (name + '.log')))
        return result.returncode

    def capture(name, implementation, count):
        container = 'phoenix-parity-production-' + uuid.uuid4().hex[:12]; containers.append(container)
        argv = docker + ['run', '--rm', '--name', container, '--network', 'none',
                         '--mount', 'type=bind,source=' + str(ROOT / 'scripts/parity-production') + ',target=/harness,readonly',
                         '--mount', 'type=bind,source=' + str(out) + ',target=/evidence']
        if implementation == 'original':
            argv += ['--mount', 'type=bind,source=' + str(ref) + ',target=/reference,readonly', foundation.ORIGINAL_IMAGE,
                     'node', '/harness/original.cjs', '/reference', '/evidence/suite.json', '/evidence/' + name + '.json.gz']
        else:
            for source, target in [(ROOT / 'packages', '/phoenix/packages'), (ROOT / 'node_modules', '/phoenix/node_modules'), (ROOT / 'package.json', '/phoenix/package.json')]:
                argv += ['--mount', 'type=bind,source=' + str(source) + ',target=' + target + ',readonly']
            if compiled:
                argv += ['--mount', 'type=bind,source=' + compiled['fst'] + ',target=/nlu/launch.fst,readonly',
                         '--mount', 'type=bind,source=' + compiled['factoryDir'] + ',target=/nlu/factories,readonly',
                         '--mount', 'type=bind,source=' + compiled['rulesDir'] + ',target=/nlu/rules,readonly',
                         '--env', 'PHOENIX_ENV_FILE=/dev/null', '--env', 'PHOENIX_NLU_RUNTIME=compiled-fst',
                         '--env', 'PHOENIX_NLU_COMPILED_FST=/nlu/launch.fst',
                         '--env', 'PHOENIX_NLU_COMPILED_FACTORY_DIR=/nlu/factories',
                         '--env', 'PHOENIX_NLU_COMPILED_RULES_DIR=/nlu/rules',
                         '--env', 'PHOENIX_NLU_COMPILED_FST_SHA256=' + compiled['fstSha256']]
            elif compiled_snapshot:
                manifest_name = Path(compiled_snapshot['manifest']).name
                argv += ['--mount', 'type=bind,source=' + compiled_snapshot['root'] + ',target=/nlu/snapshot,readonly',
                         '--env', 'PHOENIX_ENV_FILE=/dev/null', '--env', 'PHOENIX_NLU_RUNTIME=compiled-fst',
                         '--env', 'PHOENIX_NLU_COMPILED_SNAPSHOT_MANIFEST=/nlu/snapshot/' + manifest_name]
            argv += [foundation.PHOENIX_IMAGE, 'node', '/harness/phoenix.mjs', '/phoenix', '/evidence/suite.json', '/evidence/' + name + '.json.gz']
        # Outer process bound includes container startup, every bounded case, and cleanup.
        step(name, argv, timeout=240 + count * 35, allowed=(0,) if implementation == 'original' else (0, 2))
        containers.remove(container)

    code = 2
    try:
        before = foundation.fingerprint(); (out / 'phoenix-source.json').write_text(json.dumps(before, indent=2) + '\n')
        required_images = {'phoenix'} if args.golden else {'original', args.candidate}
        for name in sorted(required_images):
            image = record['images'][name]
            if subprocess.run(docker + ['image', 'inspect', image], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15).returncode:
                step('pull-' + name, docker + ['pull', image], timeout=600)
            step('image-' + name, docker + ['image', 'inspect', image, '--format', '{{.Id}}'])
        if args.golden:
            golden = args.golden.resolve(); manifest = json.loads((golden / 'source.json').read_text())
            if manifest['referenceRevision'] != REVISION or manifest['review']['result'] != 'pass' or manifest['driverSha256'] != sha(ROOT / 'scripts/parity-production/driver.cjs'):
                raise ValueError('Golden provenance/driver is stale or unreviewed')
            if manifest.get('originalCaptureTools') != capture_tools:
                raise ValueError('Golden original adapter/fixture tools are stale or incompletely pinned')
            for filename, expected in manifest['files'].items():
                if filename not in ['suite.json', 'reference.json.gz']: raise ValueError('Unexpected golden path')
                if sha(golden / filename) != expected: raise ValueError('Golden bytes changed: ' + filename)
            if set(manifest['files']) != {'suite.json', 'reference.json.gz'}: raise ValueError('Golden files are incomplete')
            for filename in manifest['files']: (out / filename).write_bytes((golden / filename).read_bytes())
            record['goldenSource'] = manifest
        else:
            if not (ref / 'parity-compiled.json').is_file():
                step('reference-setup', [sys.executable, ROOT / 'scripts/parity-reference/run.py', '--source', args.source.resolve(), '--docker-host', args.docker_host,
                                         '--out', ROOT / '.parity/runs/reference-setup'], timeout=900)
            record['referenceIntegrity'] = reference_integrity(str(args.source.resolve()), ref)
            argv = ['node', ROOT / 'scripts/parity-production/fixtures.mjs', '--out', out / 'suite.json', '--selection', args.selection,
                    '--offset', str(args.offset), '--limit', str(args.limit)]
            if args.corpus: argv += ['--corpus', args.corpus]
            step('fixtures', argv, timeout=180)
        suite = json.loads((out / 'suite.json').read_text()); record['selection'] = suite['selection']; record['cases'] = len(suite['cases'])
        if not args.golden: capture('reference', 'original', record['cases'])
        capture('candidate', args.candidate, record['cases'])
        if compiled:
            if sha(Path(compiled['fst'])) != compiled['fstSha256'] or {
                p.name: sha(p) for p in sorted(Path(compiled['factoryDir']).iterdir())
            } != compiled['factoryFiles']:
                raise RuntimeError('Compiled artifacts changed during capture; retain this run and repeat with stable inputs')
            current_rules = compiled_rule_snapshot(Path(compiled['rulesDir']))
            if current_rules['ruleFiles'] != compiled['ruleFiles'] or current_rules['ruleManifestSha256'] != compiled['ruleManifestSha256']:
                raise RuntimeError('Compiled rule graph snapshot changed during capture; retain this run and repeat with stable inputs')
        if compiled_snapshot:
            current_snapshot = compiled_snapshot_profile(Path(compiled_snapshot['manifest']))
            if (current_snapshot['manifestSha256'] != compiled_snapshot['manifestSha256']
                    or current_snapshot['files'] != compiled_snapshot['files']):
                raise RuntimeError('Compiled JSON snapshot profile changed during capture; retain this run and repeat with stable inputs')
        if before != foundation.fingerprint(): raise RuntimeError('Source or tools changed during capture; retain this development run and rerun against one stable tree')
        code = step('compare', ['node', ROOT / 'scripts/parity-production/compare.mjs', '--reference', out / 'reference.json.gz', '--candidate', out / 'candidate.json.gz',
                                '--suite', out / 'suite.json', '--out', out / 'comparison.json'], allowed=(0, 1), timeout=600)
        comparison = json.loads((out / 'comparison.json').read_text())
        record.update(result='match' if comparison['pass'] else 'mismatch', differences=len(comparison['differences']), invariants=len(comparison['invariants']),
                      coverageGaps=len(comparison['coverageGaps']), phoenixSourceTreeSha256=before['treeSha256'])
    except Exception as error:
        record['failure'] = str(error); code = 2
    finally:
        for container in containers:
            try: subprocess.run(docker + ['rm', '--force', container], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30)
            except Exception as error: record.setdefault('cleanupFailures', []).append(str(error))
    record['artifacts'] = {p.name: sha(p) for p in out.iterdir() if p.is_file() and p.name != 'run.json'}
    (out / 'run.json').write_text(json.dumps(record, indent=2) + '\n')
    print(json.dumps({k: record[k] for k in ['result', 'cases', 'differences', 'invariants', 'coverageGaps', 'failure'] if k in record}), flush=True)
    return code


if __name__ == '__main__': sys.exit(main())
