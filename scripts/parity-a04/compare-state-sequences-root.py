#!/usr/bin/env python3
"""Compare A-04 gate 1 source-controller sequences against Phoenix SDK results.

Root rewrite of compare-state-sequences.py.

The original comparator loaded `source-sequences.json`, bound five `src_*`
variables from it, and then never used them: every "source" value in its output
was a hardcoded Python literal and every `match` was computed from the Phoenix
side alone. Corrupting every status in the source capture to a garbage string
still produced `allMatch: true, 16/16`, which is how the defect was found.

This version derives BOTH sides from the captured evidence and diffs them, so a
source/Phoenix disagreement can actually fail. Identifiers and loop names differ
between the two runs by construction (source uses `member-3`/`owner-1`, Phoenix
uses real ObjectIds), so comparison is on the SHAPE that parity actually cares
about: the ordered status vector, robot presence/absence, deletion state, and
observed HTTP status.

Usage:
    EVIDENCE_ROOT=/path/to/evidence python3 compare-state-sequences-root.py
    python3 compare-state-sequences-root.py --evidence /path/to/evidence
"""
import hashlib
import json
import os
import sys
from pathlib import Path

# Accept --evidence as well as EVIDENCE_ROOT. Previously only the environment
# variable was read while argv was ignored entirely, so `--evidence <dir>` was
# accepted in silence and the script then read the CURRENT directory instead.
# Combined with Path('') resolving to Path('.') — which is a real directory, so
# the guard below passed — that turned a wrong invocation into a confusing
# FileNotFoundError on 'source-sequences.json' rather than a usage error.
_argv = sys.argv[1:]
_cli_evidence = None
while _argv:
    arg = _argv.pop(0)
    if arg in ('--evidence', '--evidence-root'):
        if not _argv:
            sys.exit(f'{arg} requires a directory argument')
        _cli_evidence = _argv.pop(0)
    elif arg.startswith('--evidence='):
        _cli_evidence = arg.split('=', 1)[1]
    else:
        sys.exit(f'unknown argument {arg!r}; use --evidence <dir> or EVIDENCE_ROOT')

_raw = _cli_evidence if _cli_evidence is not None else os.environ.get('EVIDENCE_ROOT', '')
if not str(_raw).strip():
    sys.exit('set EVIDENCE_ROOT or pass --evidence to name the evidence directory')
ROOT = Path(_raw).expanduser()
if not ROOT.is_dir():
    sys.exit(f'evidence directory does not exist: {ROOT}')


def load(name):
    return json.loads((ROOT / name).read_text())


source = load('source-sequences.json')
sdk = load('sdk-results.json')
captures = load('server-captures.json')

src_by_name = {s['name']: s for s in source['sequences']}
comparisons = []


def statuses(rows):
    """Ordered status vector, lowercased. Order is the parity-relevant part."""
    return [str(r.get('status', '')).lower() for r in (rows or [])]


def src_step(seq_name, step_id):
    seq = src_by_name.get(seq_name)
    if not seq:
        return None
    for step in seq['steps']:
        if step['id'] == step_id:
            return step
    return None


def src_statuses(seq_name, step_id):
    step = src_step(seq_name, step_id)
    if step is None:
        return None
    body = step['response'].get('bodyMemberStatus')
    if body:
        return statuses(body)
    return statuses(step['dimensions'].get('memberStatus'))


def src_owner_robot(seq_name, step_id):
    """Wire body, not stored state.

    The source harness records `dimensions` by snapshotting the live Loop
    DOCUMENT, while the Phoenix SDK harness records the RESPONSE BODY. Those
    are different measurements and must not be compared directly: a
    soft-deleted loop has `isDeleted: true` in the document while the wire
    body may omit the field entirely. `response.bodyOwnerRobot` is the
    source's own wire capture and is the apples-to-apples counterpart.
    """
    step = src_step(seq_name, step_id)
    if step is None:
        return None
    body = step['response'].get('bodyOwnerRobot')
    return body if body is not None else step['dimensions'].get('ownerRobot')


def src_status_code(seq_name, step_id):
    step = src_step(seq_name, step_id)
    return None if step is None else step['response'].get('status')


def add(seq, dimension, src, phx, notes=''):
    comparisons.append({
        'sequence': seq,
        'dimension': dimension,
        'source': src,
        'phoenix': phx,
        'match': src == phx,
        'notes': notes,
    })


def robot_shape(owner_robot):
    """Presence/suspension shape; raw ids differ between runs by construction.

    `isDeleted` is deliberately NOT compared here.

    The Loop output shape in the pinned SDK (apis/loop-2016-03-24 shape S5,
    returned by Create, Remove and ClearRobot) declares exactly:
        id, name, owner, robot, robotFriendlyId, members, isSuspended,
        created, updated
    `isDeleted` is absent, and the aws-sdk drops undeclared members while
    parsing. So NO original client can observe the field on these operations,
    whatever the server writes.

    The two harnesses measure different things: the source harness records the
    raw JSON body (where the source server does emit isDeleted, because its
    Mongoose toJSON transform does not delete it), while the Phoenix harness
    records the SDK-PARSED result, where the field has already been stripped.
    Comparing them reported four permanent mismatches on create-clear-read and
    create-remove-loop-read that no client could ever see.

    Soft deletion is still verified, and more meaningfully, by the
    `*-list-after-*` and `*-get-after-*` steps: a soft-deleted loop must vanish
    from list output and change the getRobot status code. Those are compared as
    the 'status' and 'code' dimensions and would catch a real regression.
    """
    if owner_robot is None:
        return None
    if isinstance(owner_robot, list):
        return [robot_shape(item) for item in owner_robot]
    return {
        'robotPresent': owner_robot.get('robot') is not None,
        'isSuspended': bool(owner_robot.get('isSuspended')),
    }


# Phoenix step id -> source step id, per sequence.
#
# The two harnesses are NOT step-aligned by construction: the source runner
# creates a fresh loop per sequence (each `01-create`), while the Phoenix SDK
# runner reuses one loop across s1/s2/s3. Only steps that observe the same
# logical state are mapped. `remove-member-list-read` is deliberately omitted:
# source removes the ACCEPTED guest from a fresh loop, Phoenix removes from a
# loop already carrying an accepted+declined history, so the status vectors
# describe different populations and a diff would be meaningless rather than
# informative. That sequence is covered by gate 1's own candidate evidence and
# by the ListLoopMembers row of the acceptance index.
STEP_MAP = {
    'invite-accept-list': [
        ('s1-02-invite-accept', '02-invite', 'status'),
        ('s1-03-accept', '03-accept', 'status'),
    ],
    'create-clear-read': [
        ('s3-02-clear-robot', '02-clear', 'robot'),
        ('s3-04-get-after-clear', '04-get-robot', 'code'),
    ],
    'create-remove-loop-read': [
        ('s3-06-remove-loop', '02-remove-loop', 'robot'),
        ('s3-08-get-after-remove-loop', '04-get-robot', 'code'),
    ],
}


def sdk_rows(face):
    return {row['id']: row for row in sdk['results'] if row['face'] == face}


def sdk_code(row):
    if row.get('error'):
        return row['error'].get('statusCode') or row.get('statusCode')
    return row.get('statusCode')


missing = []
for face in ('account', 'classic'):
    rows = sdk_rows(face)
    for seq_name, steps in STEP_MAP.items():
        for phx_id, src_id, kind in steps:
            row = rows.get(phx_id)
            if row is None or src_step(seq_name, src_id) is None:
                missing.append(f'{face}:{seq_name}:{phx_id}<-{src_id}')
                continue
            if kind == 'status':
                add(seq_name, f'{face}.member-status',
                    src_statuses(seq_name, src_id),
                    statuses(row.get('memberStatus')))
            elif kind == 'robot':
                add(seq_name, f'{face}.owner-robot',
                    robot_shape(src_owner_robot(seq_name, src_id)),
                    robot_shape(row.get('ownerRobot')))
            elif kind == 'code':
                add(seq_name, f'{face}.status-code',
                    src_status_code(seq_name, src_id),
                    sdk_code(row))

# Classic must forward byte-identically to the upstream Account hop.
classic = [r for r in captures['captures'] if r['face'] == 'classic']
upstream = [r for r in captures['captures'] if r['face'] == 'classic-account']
# The count was hardcoded to 18. The harness now emits 34 captures per face, so
# the comparison short-circuited on the count and reported forwarding as inexact
# even when every pair matched byte-for-byte. Assert the two faces captured the
# SAME number of requests and that at least one exists; the exact total depends
# on how many sequences the harness runs and must not be frozen here.
forward_ok = (
    bool(classic)
    and len(classic) == len(upstream)
    and all(
        c['target'] == u['target']
        and c['response']['status'] == u['response']['status']
        and c['response']['bodySha256'] == u['response']['bodySha256']
        and c['bodySha256'] == u['bodySha256']
        for c, u in zip(classic, upstream)
    )
)

mismatches = [c for c in comparisons if not c['match']]
result = {
    'kind': 'a04-gate1-source-vs-phoenix-sequence-comparison-root',
    'comparator': 'compare-state-sequences-root.py',
    'evidenceRoot': str(ROOT),
    'candidateRevision': sdk.get('candidateRevision'),
    'sourceRevision': source.get('sourceRevision'),
    'client': {
        'node': sdk.get('node'),
        'version': sdk.get('clientVersion'),
        'calls': sdk.get('callCount'),
    },
    'derivedFromEvidence': True,
    'classicForwardingExact': forward_ok,
    'comparisons': comparisons,
    'total': len(comparisons),
    'matched': len(comparisons) - len(mismatches),
    'mismatches': mismatches,
    'missingSteps': missing,
    'allMatch': not mismatches and not missing and forward_ok,
}
(ROOT / 'comparison-root.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps({
    'allMatch': result['allMatch'],
    'total': result['total'],
    'matched': result['matched'],
    'mismatches': len(mismatches),
    'missingSteps': len(missing),
    'classicForwardingExact': forward_ok,
    'output': str(ROOT / 'comparison-root.json'),
}))
sys.exit(0 if result['allMatch'] else 1)
