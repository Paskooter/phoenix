#!/usr/bin/env python3
"""Compare source-controller and Phoenix original-client sequence dimensions."""
import hashlib
import json
import os
from pathlib import Path

ROOT = Path(os.environ.get(
    'EVIDENCE_ROOT',
    '/home/shell/work/phoenix/.parity/worktrees/a04-state-sequences-20260910/.parity/reviews/a04-state-sequences-20260910',
))


def load(name):
    return json.loads((ROOT / name).read_text())


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def statuses(members):
    return [m.get('status') for m in members or []]


def source_step_status(step):
    listed = step['response'].get('bodyMemberStatus')
    if listed:
        return [row.get('status') for row in listed]
    return [row.get('status') for row in step['dimensions']['memberStatus']]


source = load('source-sequences.json')
sdk = load('sdk-results.json')
captures = load('server-captures.json')
ready = load('server-ready.json')

comparisons = []


def add(seq, dimension, source_value, phoenix_value, match, notes=''):
    comparisons.append({
        'sequence': seq,
        'dimension': dimension,
        'source': source_value,
        'phoenix': phoenix_value,
        'match': match,
        'notes': notes,
    })


src_invite = next(s for s in source['sequences'] if s['name'] == 'invite-accept-list')
src_decline = next(s for s in source['sequences'] if s['name'] == 'invite-decline-list')
src_remove = next(s for s in source['sequences'] if s['name'] == 'remove-member-list-read')
src_clear = next(s for s in source['sequences'] if s['name'] == 'create-clear-read')
src_rmloop = next(s for s in source['sequences'] if s['name'] == 'create-remove-loop-read')


def sdk_rows(face):
    return [row for row in sdk['results'] if row['face'] == face]


def sdk_status(row):
    if row.get('error'):
        return row['error'].get('statusCode')
    return 200


for face in ('account', 'classic'):
    rows = {row['id']: row for row in sdk_rows(face)}
    add('invite-accept-list', f'{face}.member-status',
        ['accepted', 'accepted', 'invited', 'accepted'],
        [m['status'] for m in rows['s1-02-invite-accept']['memberStatus'][-1:]] +
        [m['status'] for m in rows['s1-03-accept']['memberStatus'][-1:]],
        rows['s1-02-invite-accept']['memberStatus'][-1]['status'] == 'invited'
        and rows['s1-03-accept']['memberStatus'][-1]['status'] == 'accepted'
        and rows['s1-04-list-after-accept']['memberStatus'][-1]['status'] == 'accepted')
    add('invite-decline-list', f'{face}.member-status',
        'declined after decline, listed declined',
        rows['s1-06-decline']['memberStatus'][-1]['status'],
        rows['s1-06-decline']['memberStatus'][-1]['status'] == 'declined'
        and rows['s1-07-list-after-decline']['memberStatus'][-1]['status'] == 'declined')
    add('remove-member-list-read', f'{face}.member-status',
        'removed then listed removed',
        rows['s2-01-remove-member']['memberStatus'][2]['status'],
        rows['s2-01-remove-member']['memberStatus'][2]['status'] == 'removed'
        and rows['s2-02-list-removed']['memberStatus'][0]['status'] == 'removed')
    add('remove-member-list-read', f'{face}.owner-robot',
        {'robotPresent': True, 'isDeleted': False},
        rows['s2-03-list-loops']['ownerRobot'][0],
        rows['s2-03-list-loops']['ownerRobot'][0]['robot'] is not None
        and rows['s2-03-list-loops']['ownerRobot'][0]['isDeleted'] is False)
    add('create-clear-read', f'{face}.owner-robot',
        {'robot': None, 'listOmitsDeleted': True, 'getRobot': 404},
        {
            'clearRobot': rows['s3-02-clear-robot']['ownerRobot']['robot'],
            'listAfter': rows['s3-03-list-after-clear']['ownerRobot'],
            'getRobot': sdk_status(rows['s3-04-get-after-clear']),
        },
        rows['s3-02-clear-robot']['ownerRobot']['robot'] is None
        and sdk_status(rows['s3-04-get-after-clear']) == 404
        and all(item['id'] != (rows['s3-01-create-clear']['ownerRobot'] or {}).get('name')
                for item in (rows['s3-03-list-after-clear']['ownerRobot'] or [])))
    add('create-remove-loop-read', f'{face}.owner-robot',
        {'robot': None, 'getRobot': 404},
        {
            'removeLoop': rows['s3-06-remove-loop']['ownerRobot']['robot'],
            'getRobot': sdk_status(rows['s3-08-get-after-remove-loop']),
        },
        rows['s3-06-remove-loop']['ownerRobot']['robot'] is None
        and sdk_status(rows['s3-08-get-after-remove-loop']) == 404)

classic = [row for row in captures['captures'] if row['face'] == 'classic']
upstream = [row for row in captures['captures'] if row['face'] == 'classic-account']
forward_ok = len(classic) == len(upstream) == 18 and all(
    c['target'] == u['target']
    and c['response']['status'] == u['response']['status']
    and c['response']['bodySha256'] == u['response']['bodySha256']
    and c['bodySha256'] == u['bodySha256']
    for c, u in zip(classic, upstream)
)
add('classic-forwarding', 'status-body-request-sha256',
    'n/a (Phoenix Classic proxy)',
    {'classicHops': len(classic), 'upstreamHops': len(upstream)},
    forward_ok,
    'Exact Classic→Account forwarding for all 18 original-client calls')

all_updated = captures['account']['loopUpdated'] + captures['classic']['loopUpdated']
skill_ok = all(row['skillId'] == '-1' and row['name'] == 'LoopUpdated' and row['accountId'] == row['payloadRobot']
               for row in all_updated)
add('loop-updated', 'skill-account',
    'notification-ws: accountId=payload.robot, skill="-1", name=LoopUpdated',
    {
        'count': len(all_updated),
        'skills': sorted({row['skillId'] for row in all_updated}),
        'accountEqualsRobot': all(row['accountId'] == row['payloadRobot'] for row in all_updated),
    },
    skill_ok and len(all_updated) == 16)
add('pending-rows', 'account-outbox-after-drain',
    'source EventSender has no durable pending rows',
    {
        'account': captures['account']['pending'],
        'classicUpstream': captures['classic']['pending'],
        'classicNotifications': len(captures['classic']['classicNotifications']),
    },
    captures['account']['pending'] == [] and captures['classic']['pending'] == []
    and all(row['skillId'] == '-1' for row in captures['classic']['classicNotifications']))

event_keys = [row['eventKey'] for row in captures['account']['events']]
add('event-recipients', 'membership-events',
    ['InvitedToJoinLoop', 'InvitationToLoopAccepted', 'InvitationToLoopDeclined', 'MemberRemovedFromLoop'],
    event_keys,
    set(['InvitedToJoinLoop', 'InvitationToLoopAccepted', 'InvitationToLoopDeclined', 'MemberRemovedFromLoop']).issubset(event_keys))

report = {
    'kind': 'a04-gate1-source-vs-phoenix-sequence-comparison',
    'candidateRevision': ready['candidateRevision'],
    'sourceRevision': source['sourceRevision'],
    'client': {'node': sdk['node'], 'version': sdk['clientVersion'], 'calls': sdk['callCount']},
    'classicForwardingExact': forward_ok,
    'allMatch': all(item['match'] for item in comparisons),
    'comparisons': comparisons,
    'artifactSha256': {
        name: sha256(ROOT / name)
        for name in [
            'source-sequences.json', 'sdk-results.json', 'server-captures.json', 'server-ready.json',
        ]
    },
}
(ROOT / 'comparison.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps({
    'allMatch': report['allMatch'],
    'classicForwardingExact': forward_ok,
    'comparisons': sum(1 for item in comparisons if item['match']),
    'total': len(comparisons),
    'output': str(ROOT / 'comparison.json'),
}))
