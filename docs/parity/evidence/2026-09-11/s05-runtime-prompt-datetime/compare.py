#!/usr/bin/env python3
"""S-05 differential driver.

Runs the pinned original probes and the Phoenix probes over the frozen S-05
matrices under several host timezones, then reports, per section:

  * original-under-UTC  vs  Phoenix-under-each-TZ   (parity target)
  * original-under-TZ   vs  original-under-UTC      (how much the source itself
                                                     leaks the host timezone)
  * Phoenix-under-TZ    vs  Phoenix-under-UTC       (must be zero)

usage:
  PHOENIX_ROOT=... REFERENCE_ROOT=... python3 compare.py [outdir]
"""
import collections
import hashlib
import json
import os
import subprocess
import sys

PHOENIX = os.environ['PHOENIX_ROOT']
REFERENCE = os.environ['REFERENCE_ROOT']
OUT = sys.argv[1] if len(sys.argv) > 1 else '/tmp/s05-driver'
TZS = ['UTC', 'America/New_York', 'Asia/Tokyo', 'Australia/Lord_Howe', 'Pacific/Chatham']
MATRIX = os.path.join(PHOENIX, 'packages/skills/test/fixtures/s05-datetime-matrix.json')
CONTEXTS = os.path.join(PHOENIX, 'packages/skills/test/fixtures/s05-prompt-contexts.json')
SEASON = os.path.join(PHOENIX, 'packages/skills/test/fixtures/s05-isinrange-pairs.json')

os.makedirs(OUT, exist_ok=True)


def run(cmd, env):
    env = dict(os.environ, **env)
    proc = subprocess.run(cmd, env=env, capture_output=True, text=True)
    if proc.returncode != 0:
        raise SystemExit(f'probe failed: {cmd}\n{proc.stderr[-2000:]}')


def probes():
    for tz in TZS:
        tag = tz.replace('/', '_')
        dt_o = os.path.join(OUT, f'datetime-original-{tag}.json')
        dt_c = os.path.join(OUT, f'datetime-phoenix-{tag}.json')
        cx_o = os.path.join(OUT, f'context-original-{tag}.json')
        cx_c = os.path.join(OUT, f'context-phoenix-{tag}.json')
        run(['node', f'{PHOENIX}/packages/skills/tools/s05-datetime-matrix-source.cjs', MATRIX, dt_o],
            {'TZ': tz, 'S05_SOURCE_ROOT': REFERENCE})
        run(['node', f'{PHOENIX}/packages/skills/tools/s05-datetime-matrix-candidate.mjs', MATRIX, dt_c],
            {'TZ': tz, 'S05_CANDIDATE_ROOT': PHOENIX})
        run(['node', f'{PHOENIX}/packages/skills/tools/s05-context-matrix-source.cjs', CONTEXTS, cx_o],
            {'TZ': tz, 'S05_SOURCE_ROOT': REFERENCE})
        run(['node', f'{PHOENIX}/packages/skills/tools/s05-context-matrix-candidate.mjs', CONTEXTS, cx_c],
            {'TZ': tz, 'S05_CANDIDATE_ROOT': PHOENIX})


def flatten(prefix, value, out):
    if isinstance(value, dict):
        for key, sub in value.items():
            flatten(f'{prefix}/{key}', sub, out)
    elif isinstance(value, list):
        for i, sub in enumerate(value):
            flatten(f'{prefix}/{i}', sub, out)
    else:
        out[prefix] = value
    return out


def load(path):
    with open(path) as handle:
        return json.load(handle)


def diff(a, b):
    # `/tz` is the probe's own host-timezone stamp, not implementation output.
    fa, fb = flatten('', a, {}), flatten('', b, {})
    return [k for k in set(fa) | set(fb) if k != '/tz' and fa.get(k) != fb.get(k)]


def main():
    probes()
    report = {'timezones': TZS, 'sections': {}}
    for name, keys in (('datetime-matrix', ('datetime-original', 'datetime-phoenix')),
                       ('context-matrix', ('context-original', 'context-phoenix'))):
        base = load(os.path.join(OUT, f'{keys[0]}-UTC.json'))
        section = {'parity': {}, 'source_host_tz_sensitivity': {}, 'phoenix_host_tz_stability': {}}
        for tz in TZS:
            tag = tz.replace('/', '_')
            section['parity'][tz] = len(diff(base, load(os.path.join(OUT, f'{keys[1]}-{tag}.json'))))
            section['source_host_tz_sensitivity'][tz] = len(diff(base, load(os.path.join(OUT, f'{keys[0]}-{tag}.json'))))
            first = load(os.path.join(OUT, f'{keys[1]}-UTC.json'))
            section['phoenix_host_tz_stability'][tz] = len(diff(first, load(os.path.join(OUT, f'{keys[1]}-{tag}.json'))))
        report['sections'][name] = section
    # corpus sizes
    matrix = load(MATRIX)
    report['corpus'] = {
        'season_pairs_from_mim_resources': len(matrix['seasonPairs']),
        'season_dates': len(matrix['seasonDates']),
        'isInRange_comparisons_per_run': len(matrix['seasonPairs']) * len(matrix['seasonDates']),
        'datetime_option_matrix_records': len(matrix['nows']) * (len(matrix['dtIsos']) + 3),
        'phrasing_records': len(matrix['nows']) * len(matrix['seasonDates']),
        'contexts': len(load(CONTEXTS)),
        'isinrange_pairs_fixture': len(load(SEASON)['pairs']),
    }
    report['outputs'] = {}
    for name in sorted(os.listdir(OUT)):
        if name.endswith('.json') and name != 'report.json':
            with open(os.path.join(OUT, name), 'rb') as handle:
                report['outputs'][name] = {'sha256': hashlib.sha256(handle.read()).hexdigest(),
                                           'bytes': os.path.getsize(os.path.join(OUT, name))}
    path = os.path.join(OUT, 'report.json')
    with open(path, 'w') as handle:
        json.dump(report, handle, indent=1)
    print(json.dumps(report, indent=1))


if __name__ == '__main__':
    main()
