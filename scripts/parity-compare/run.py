#!/usr/bin/env python3
"""Run identical wire fixtures against isolated original and Phoenix servers."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import shlex
import subprocess
import sys
import time
import uuid

ROOT = Path(__file__).resolve().parents[2]
CACHE = ROOT / '.parity'
PINS = json.loads((ROOT / 'docs/parity/evidence/2026-09-05/compatibility-pins.json').read_text())
REVISION = PINS['originalCommit']
ORIGINAL_IMAGE = PINS['nodeDockerImage']['resolved']
PHOENIX_IMAGE = 'node@sha256:dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94'


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def fingerprint():
    names = subprocess.check_output(['git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', 'packages', 'scripts', 'package.json', 'package-lock.json'], cwd=ROOT).decode().split('\0')
    files = {name: sha(ROOT / name) for name in sorted(set(names)) if name and (ROOT / name).is_file()}
    return {'head': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
            'treeSha256': hashlib.sha256(json.dumps(files, sort_keys=True).encode()).hexdigest(), 'files': files}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, default=ROOT.parent / 'pegasus')
    parser.add_argument('--out', type=Path, default=CACHE / 'runs/compare')
    parser.add_argument('--candidate', choices=['phoenix', 'original'], default='phoenix', help='Use original as a positive control')
    parser.add_argument('--docker-host', default='unix:///var/run/docker.sock')
    args = parser.parse_args()
    out = args.out.resolve(); out.mkdir(parents=True, exist_ok=True)
    ref = CACHE / 'reference' / REVISION
    docker = ['docker', '-H', args.docker_host]
    record = {'date': datetime.now(timezone.utc).isoformat(), 'referenceRevision': REVISION, 'candidate': args.candidate,
              'images': {'original': ORIGINAL_IMAGE, 'phoenix': PHOENIX_IMAGE}, 'commands': [], 'result': 'error'}

    def step(name, argv, allowed=(0,), timeout=180):
        command = {'name': name, 'argv': list(map(str, argv)), 'shellDisplay': shlex.join(map(str, argv))}
        record['commands'].append(command)
        print(name, flush=True)
        started = time.monotonic()
        try:
            with (out / (name + '.log')).open('w') as log:
                result = subprocess.run(argv, cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, timeout=timeout)
        except subprocess.TimeoutExpired:
            command['timedOut'] = True
            raise
        finally:
            command['durationMs'] = round((time.monotonic() - started) * 1000, 3)
        command['exitCode'] = result.returncode
        if result.returncode not in allowed: raise RuntimeError(name + ' failed; see ' + str(out / (name + '.log')))
        return result.returncode

    def capture(name, implementation):
        container_name = 'phoenix-parity-' + uuid.uuid4().hex[:12]
        command = docker + ['run', '--rm', '--name', container_name, '--network', 'none',
                           '--mount', 'type=bind,source=' + str(ROOT / 'scripts/parity-compare') + ',target=/harness,readonly',
                           '--mount', 'type=bind,source=' + str(out) + ',target=/evidence']
        if implementation == 'original':
            command += ['--mount', 'type=bind,source=' + str(ref) + ',target=/reference,readonly', ORIGINAL_IMAGE,
                        'node', '/harness/original.cjs', '/reference', '/evidence/' + name + '.json', '/reference/packages/hub/pegasus-skills/report_skill_manifest.json']
        else:
            mounts = [(ROOT / 'packages', '/phoenix/packages'), (ROOT / 'node_modules', '/phoenix/node_modules'),
                      (ROOT / 'package.json', '/phoenix/package.json'), (ref / 'packages/hub/pegasus-skills/report_skill_manifest.json', '/fixtures/report.json')]
            for source, target in mounts:
                command += ['--mount', 'type=bind,source=' + str(source) + ',target=' + target + ',readonly']
            command += [PHOENIX_IMAGE, 'node', '/harness/phoenix.mjs', '/phoenix', '/evidence/' + name + '.json', '/fixtures/report.json']
        # Docker startup/cleanup can be slow independently of the measured
        # transaction windows. Keep the suite's 5 s case bounds unchanged.
        try: step(name, command, timeout=180)
        except subprocess.TimeoutExpired:
            subprocess.run(docker + ['rm', '--force', container_name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15)
            raise

    code = 2
    try:
        for name, image in record['images'].items():
            if name == 'phoenix' and args.candidate == 'original': continue
            inspect = docker + ['image', 'inspect', image, '--format', '{{.Id}}']
            if subprocess.run(inspect, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15).returncode:
                step('pull-' + name, docker + ['pull', image], timeout=300)
            step('image-' + name, inspect)
        if not (ref / 'parity-compiled.json').exists():
            step('reference-setup', [sys.executable, ROOT / 'scripts/parity-reference/run.py', '--source', args.source.resolve(),
                                     '--docker-host', args.docker_host, '--out', CACHE / 'runs/reference-setup'], timeout=600)
        compiled = json.loads((ref / 'parity-compiled.json').read_text())
        if compiled['referenceRevision'] != REVISION or compiled['runtime'] != 'v8.9.4' or compiled['compiler'] != '2.5.3':
            raise RuntimeError('Reference runtime/compiler provenance changed')
        for file, expected in compiled['inputs'].items():
            original = subprocess.check_output(['git', '-C', str(args.source.resolve()), 'show', REVISION + ':' + file])
            if hashlib.sha256(original).hexdigest() != expected or sha(ref / file) != expected: raise RuntimeError('Original input changed: ' + file)
        for file, expected in compiled['outputs'].items():
            if sha(ref / file) != expected: raise RuntimeError('Original emitted module changed: ' + file)
        manifest = 'packages/hub/pegasus-skills/report_skill_manifest.json'
        original = subprocess.check_output(['git', '-C', str(args.source.resolve()), 'show', REVISION + ':' + manifest])
        if hashlib.sha256(original).hexdigest() != sha(ref / manifest): raise RuntimeError('Original fixture manifest changed')
        record['referenceIntegrity'] = {'sourceFiles': len(compiled['inputs']), 'emittedFiles': len(compiled['outputs']), 'manifestSha256': sha(ref / manifest), 'emissionRecordSha256': sha(ref / 'parity-compiled.json')}
        before = fingerprint(); (out / 'phoenix-source.json').write_text(json.dumps(before, indent=2) + '\n')
        capture('reference', 'original')
        capture('candidate', args.candidate)
        if before != fingerprint(): raise RuntimeError('Phoenix/source tools changed during capture; rerun against one stable tree')
        code = step('compare', ['node', ROOT / 'packages/harness/src/index.js', 'compare', '--reference', out / 'reference.json',
                                '--candidate', out / 'candidate.json', '--out', out / 'comparison.json'], allowed=(0, 1))
        comparison = json.loads((out / 'comparison.json').read_text())
        record.update({'result': 'match' if comparison['pass'] else 'mismatch', 'cases': comparison['cases'],
                       'differences': len(comparison['differences']), 'invariantFailures': len(comparison['invariants']), 'phoenixSourceTreeSha256': before['treeSha256']})
    except Exception as error:
        record['failure'] = str(error); code = 2
    record['artifacts'] = {p.name: sha(p) for p in sorted(out.iterdir()) if p.is_file() and p.name != 'run.json'}
    (out / 'run.json').write_text(json.dumps(record, indent=2) + '\n')
    print(json.dumps({k: record[k] for k in ['result', 'cases', 'differences', 'invariantFailures', 'failure'] if k in record}), flush=True)
    return code


if __name__ == '__main__': sys.exit(main())
