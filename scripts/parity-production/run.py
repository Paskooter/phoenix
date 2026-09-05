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
    args = parser.parse_args()
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
