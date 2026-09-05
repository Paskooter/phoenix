#!/usr/bin/env python3
"""Verify consumer source evidence, optionally restoring missing cached files.

This checks provenance and the explicitly listed byte comparisons. It does not
execute robot/client code or award product parity credit.
"""
import argparse
import hashlib
import json
from pathlib import Path
import tarfile
import urllib.request


def digest(data):
    return hashlib.sha256(data).hexdigest()


def safe_path(root, relative):
    result = (root / relative).resolve()
    if not result.is_relative_to(root.resolve()):
        raise ValueError(f"Path escapes cache: {relative}")
    return result


def check(path, record):
    data = path.read_bytes()
    if digest(data) != record['sha256'] or len(data) != record['bytes']:
        raise ValueError(f"Reference bytes changed: {path}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--evidence', type=Path, default=Path('docs/parity/evidence/2026-09-05/consumers'))
    parser.add_argument('--cache', type=Path, default=Path('.parity/consumers'))
    parser.add_argument('--restore', action='store_true', help='Restore missing Git/JSC files using their recorded sources')
    parser.add_argument('--out', type=Path)
    args = parser.parse_args()
    load = lambda name: json.loads((args.evidence / name).read_text())
    release = load('be-12.0.0-sources.json')
    git = load('git-sources.json')
    clients = load('be-12.0.0-server-clients.json')
    comparison = load('profile-comparison.json')
    archive = args.cache / 'downloads/jibo-be-12.0.0.tar.gz'
    hasher = hashlib.sha256()
    with archive.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            hasher.update(chunk)
    if hasher.hexdigest() != release['archive']['sha256'] or archive.stat().st_size != release['archive']['bytes']:
        raise ValueError('Release archive differs from its pin')
    if clients['archiveSha256'] != release['archive']['sha256']:
        raise ValueError('Server clients refer to a different release')
    if digest(Path(__file__).with_name('recover-be12.py').read_bytes()) != release['toolSha256']:
        raise ValueError('Source recovery tool differs from the reviewed pin')

    checked = 0
    for package in release['packages']:
        for record in package['artifacts'] + package['sources']:
            check(safe_path(args.cache / 'be-12.0.0', record['path']), record)
            checked += 1
    for record in git['files']:
        path = safe_path(args.cache / 'git', f"{record['repo']}/{record['commit']}/{record['path']}")
        if not path.exists() and args.restore:
            expected_url = f"https://pvindex.org/gitea/{record['repo']}/raw/commit/{record['commit']}/{record['path']}"
            if record['url'] != expected_url:
                raise ValueError('Unexpected Git source URL')
            data = urllib.request.urlopen(expected_url, timeout=45).read()
            if digest(data) != record['sha256']:
                raise ValueError(f"Downloaded source differs: {expected_url}")
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
        check(path, record)
        checked += 1

    if args.restore:
        missing = {r['archiveMember']: r for r in clients['files']
                   if not safe_path(args.cache / 'be-12.0.0/server-clients', r['path']).exists()}
        if missing:
            with tarfile.open(archive, 'r:gz') as contents:
                for member in contents:
                    record = missing.pop(member.name.removeprefix('./'), None)
                    if record is None:
                        continue
                    if not member.isfile():
                        raise ValueError('Nonregular release member')
                    data = contents.extractfile(member).read()
                    if digest(data) != record['sha256']:
                        raise ValueError(f"Release member differs: {member.name}")
                    path = safe_path(args.cache / 'be-12.0.0/server-clients', record['path'])
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_bytes(data)
            if missing:
                raise ValueError(f"Missing release members: {list(missing)}")
    for record in clients['files']:
        check(safe_path(args.cache / 'be-12.0.0/server-clients', record['path']), record)
        checked += 1
    for record in comparison['files']:
        old = safe_path(args.cache / 'git/sdk/sdk/793e5ae469ec48d280bf837564035696848629ab', record['hashbrownPath']).read_bytes()
        new = safe_path(args.cache / 'be-12.0.0', record['be12Path']).read_bytes()
        if digest(old) != record['hashbrownSha256'] or digest(new) != record['be12Sha256'] or (old == new) != record['identical']:
            raise ValueError('Profile comparison differs from its recorded result')
    result = {'schemaVersion': 1, 'result': 'pass', 'scope': 'Source provenance only',
              'archiveVerified': True, 'filesVerified': checked,
              'profileComparisonsVerified': len(comparison['files']),
              'identicalComparedFiles': sum(r['identical'] for r in comparison['files']),
              'robotRuntimeVerified': False, 'simulatorRuntimeVerified': False,
              'toolSha256': digest(Path(__file__).read_bytes()),
              'evidenceSha256': {name: digest((args.evidence / name).read_bytes()) for name in
                  ['be-12.0.0-sources.json', 'git-sources.json', 'be-12.0.0-server-clients.json', 'profile-comparison.json']}}
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result))


if __name__ == '__main__':
    main()
