#!/usr/bin/env python3
"""Normalize and diff the pinned-original and Phoenix H-09 /v1/main receipts.

Both receipts were produced by driving the *same* eight probes against an
independently deployed skill process:

  * source-skill-main-url.json  — pinned Pegasus SkillService/BaseSkill
                                  (5c0a7390539663ba749d360de348a428c088505c)
                                  under node:8.9.4-slim, controlled EchoSkill.
  * phoenix-skill-main-url.json — Phoenix packages/skills createSkillService,
                                  same controlled handler.

`postNamespacedAlias` is the only structural difference and it is intentional:
Phoenix keeps the POST /v1/<id>/main alias that the caller registry uses
(gateway/src/registry.js:41) while the reference registers only /v1/main
(baseskill/src/SkillService.ts:12-18). The receipt records it so the divergence
is visible, not hidden.

Usage: python3 compare.py   (exit 0 when DIFFS (0))
"""
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
source = json.load(open(os.path.join(HERE, 'source-skill-main-url.json')))
phoenix = json.load(open(os.path.join(HERE, 'phoenix-skill-main-url.json')))

# Intentional Phoenix superset: the reference serves only /v1/main, Phoenix also keeps
# the namespaced alias its own registry addresses.
INTENTIONAL = {'postNamespacedAlias'}

MUTABLE_KEYS = {'msgID', 'ts'}


def normalize_body(value):
    if isinstance(value, list):
        return [normalize_body(v) for v in value]
    if isinstance(value, dict):
        out = {}
        for k, v in value.items():
            if k in MUTABLE_KEYS:
                out[k] = f'<{k}>'
            elif k == 'timings' and isinstance(v, dict):
                out[k] = {tk: '<timing-number>' for tk in v}
            else:
                out[k] = normalize_body(v)
        return out
    return value


def signature(probe):
    if probe.get('json') is not None:
        return {'status': probe['status'], 'body': normalize_body(probe['json'])}
    return {'status': probe['status'], 'raw': probe['raw']}


diffs = []
for name in sorted(set(source['probes']) | set(phoenix['probes'])):
    s = signature(source['probes'][name])
    p = signature(phoenix['probes'][name])
    if s != p and name not in INTENTIONAL:
        if s['status'] != p['status']:
            diffs.append((name, 'status', s['status'], p['status']))
        if s.get('body') != p.get('body'):
            keys = sorted(set((s.get('body') or {})) | set((p.get('body') or {})))
            for k in keys:
                if (s.get('body') or {}).get(k) != (p.get('body') or {}).get(k):
                    diffs.append((name, k, (s.get('body') or {}).get(k), (p.get('body') or {}).get(k)))
        if s.get('raw') != p.get('raw'):
            diffs.append((name, 'raw', s.get('raw'), p.get('raw')))

# Runtime identity: every independently deployed process must answer its own skill at
# /v1/main and at its namespaced alias.
identity_diffs = []
for skill_id, row in phoenix.get('runtime', {}).items():
    for surface in ('main', 'alias'):
        got = row[surface]
        if got['status'] != 200 or got['skill'] != skill_id:
            identity_diffs.append((skill_id, surface, got))

alias = signature(phoenix['probes']['postNamespacedAlias'])
source_alias = signature(source['probes']['postNamespacedAlias'])

print('surface                          source            phoenix')
for name in sorted(source['probes']):
    s = signature(source['probes'][name])
    p = signature(phoenix['probes'][name])
    tag = ' (intentional alias superset)' if name in INTENTIONAL else ''
    flag = 'OK' if (s == p or name in INTENTIONAL) else 'DIFF'
    print(f'{name:32s} {str(s["status"]):>4s} {flag:5s} {str(p["status"]):>4s}{tag}')
print()
print(f'intentional alias: source={source_alias["status"]} phoenix={alias["status"]}')
print(f'runtime identity rows: {len(phoenix.get("runtime", {})) * 2}, mismatches: {len(identity_diffs)}')
for row in identity_diffs:
    print('  IDENTITY DIFF', row)
print()
print(f'DIFFS ({len(diffs)})')
for d in diffs:
    print(' ', d)

sys.exit(1 if (diffs or identity_diffs) else 0)
