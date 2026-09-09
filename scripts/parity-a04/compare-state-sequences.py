#!/usr/bin/env python3
"""Compare source-controller and Phoenix original-client sequence dimensions."""
import hashlib
import json
import os
from pathlib import Path

ROOT = Path(os.environ.get(
    'EVIDENCE_ROOT',
    '/home/shell/work/phoenix/.parity/worktrees/a04-auth-deployment-20260911/.parity/reviews/a04-auth-deployment-20260911',
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
pre_restart = load('pre-restart.json') if (ROOT / 'pre-restart.json').exists() else None
post_sdk = load('sdk-post-restart.json') if (ROOT / 'sdk-post-restart.json').exists() else None
post_restart = load('post-restart.json') if (ROOT / 'post-restart.json').exists() else None
restart_ready = load('restart-ready.json') if (ROOT / 'restart-ready.json').exists() else None

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

pre_captures = pre_restart['captures'] if pre_restart and pre_restart.get('captures') else captures['captures']
classic = [row for row in pre_captures if row['face'] == 'classic']
upstream = [row for row in pre_captures if row['face'] == 'classic-account']
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

pre_updated_account = (pre_restart or captures)['account']['loopUpdated']
pre_updated_classic = (pre_restart or captures)['classic']['loopUpdated']
all_updated = pre_updated_account + pre_updated_classic
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
pending_source = pre_restart or captures
add('pending-rows', 'account-outbox-after-drain',
    'source EventSender has no durable pending rows',
    {
        'account': pending_source['account']['pending'],
        'classicUpstream': pending_source['classic']['pending'],
        'classicNotifications': len(pending_source['classic'].get('classicNotifications') or []),
    },
    pending_source['account']['pending'] == [] and pending_source['classic']['pending'] == []
    and all(row['skillId'] == '-1' for row in pending_source['classic'].get('classicNotifications') or []))

event_keys = [row['eventKey'] for row in pending_source['account']['events']]
add('event-recipients', 'membership-events',
    ['InvitedToJoinLoop', 'InvitationToLoopAccepted', 'InvitationToLoopDeclined', 'MemberRemovedFromLoop'],
    event_keys,
    set(['InvitedToJoinLoop', 'InvitationToLoopAccepted', 'InvitationToLoopDeclined', 'MemberRemovedFromLoop']).issubset(event_keys))

if post_sdk:
    def post_rows(face):
        return {row['id']: row for row in post_sdk['results'] if row['face'] == face}

    def status_code(row):
        if not row:
            return None
        if row.get('error') and row['error'].get('statusCode'):
            return row['error']['statusCode']
        return row.get('statusCode')

    def type_of(row):
        body = row.get('body') if row else None
        if isinstance(body, dict):
            return body.get('__type')
        error = (row or {}).get('error') or {}
        body = error.get('body') if isinstance(error, dict) else None
        if isinstance(body, dict):
            return body.get('__type')
        return None

    for face in ('account', 'classic'):
        rows = post_rows(face)
        listed = rows.get('post-01-list-members') or {}
        statuses = [member.get('status') for member in (listed.get('memberStatus') or [])]
        add('post-restart', f'{face}.sequence-state',
            'accept removed, decline declined, owner/robot accepted',
            statuses,
            'removed' in statuses and 'declined' in statuses and statuses.count('accepted') >= 2)
        add('post-restart', f'{face}.cleared-get-robot',
            404,
            status_code(rows.get('post-03-get-after-clear')),
            status_code(rows.get('post-03-get-after-clear')) == 404
            and status_code(rows.get('post-04-get-after-remove-loop')) == 404)
        next_invite = rows.get('post-05-next-invite') or {}
        next_statuses = [member.get('status') for member in (next_invite.get('memberStatus') or [])]
        add('post-restart', f'{face}.next-valid-invite',
            'invited',
            next_statuses,
            status_code(next_invite) == 200 and 'invited' in next_statuses)
        add('post-restart', f'{face}.unsigned-update-agreement',
            'unauthorizedMethods includes Loop_20160324.UpdateAgreementStatus',
            status_code(rows.get('post-10-unsigned-update-agreement-forged-header')),
            status_code(rows.get('post-10-unsigned-update-agreement-forged-header')) == 200)
        add('post-restart', f'{face}.unsigned-ordinary-loop',
            'MISSING_AUTH_HEADER for ListLoops/Invite/SetLegalGuardian',
            {
                'list': status_code(rows.get('post-12-unsigned-list-loops')),
                'invite': status_code(rows.get('post-13-unsigned-invite')),
                'guardian': status_code(rows.get('post-14-unsigned-set-legal-guardian')),
                'types': [
                    type_of(rows.get('post-12-unsigned-list-loops')),
                    type_of(rows.get('post-13-unsigned-invite')),
                    type_of(rows.get('post-14-unsigned-set-legal-guardian')),
                ],
            },
            status_code(rows.get('post-12-unsigned-list-loops')) == 401
            and status_code(rows.get('post-13-unsigned-invite')) == 401
            and status_code(rows.get('post-14-unsigned-set-legal-guardian')) == 401
            and type_of(rows.get('post-12-unsigned-list-loops')) == 'MISSING_AUTH_HEADER'
            and type_of(rows.get('post-13-unsigned-invite')) == 'MISSING_AUTH_HEADER'
            and type_of(rows.get('post-14-unsigned-set-legal-guardian')) == 'MISSING_AUTH_HEADER')
        add('post-restart', f'{face}.forged-x-amz-credentials',
            'public x-amz-credentials is not a caller identity',
            {'status': status_code(rows.get('post-15-forged-x-amz-credentials-list')),
             'type': type_of(rows.get('post-15-forged-x-amz-credentials-list'))},
            status_code(rows.get('post-15-forged-x-amz-credentials-list')) == 401
            and type_of(rows.get('post-15-forged-x-amz-credentials-list')) == 'MISSING_AUTH_HEADER')
        add('post-restart', f'{face}.signed-set-legal-guardian',
            'SetLegalGuardian remains a signed owner call',
            status_code(rows.get('post-08-set-legal-guardian')),
            status_code(rows.get('post-08-set-legal-guardian')) == 200)

    pre_smtp = (pre_restart or {}).get('transport', {}).get('smtpMessages', 0)
    pre_http = (pre_restart or {}).get('transport', {}).get('httpEvents', 0)
    post_smtp = (post_restart or captures).get('transport', {}).get('smtpMessages', 0)
    post_http = (post_restart or captures).get('transport', {}).get('httpEvents', 0)
    add('post-restart', 'configured-local-transports',
        'SMTP and HTTP invitation providers configured, not defaults, survive restart',
        {
            'preSmtp': pre_smtp,
            'postSmtp': post_smtp,
            'preHttp': pre_http,
            'postHttp': post_http,
            'smtpHost': (ready.get('transports') or {}).get('smtpHost'),
            'eventUrl': (ready.get('transports') or {}).get('eventUrl'),
        },
        pre_smtp >= 4 and post_smtp > pre_smtp and pre_http >= 4 and post_http > pre_http
        and (ready.get('transports') or {}).get('smtpHost') == '127.0.0.1'
        and bool((ready.get('transports') or {}).get('eventUrl')))
    add('post-restart', 'restart-count',
        1,
        (restart_ready or {}).get('restartCount'),
        (restart_ready or {}).get('restartCount') == 1)
    if post_restart:
        add('post-restart', 'pending-after-restart',
            'outbox drained after the next valid post-restart mutation',
            {
                'account': post_restart['account']['pending'],
                'classic': post_restart['classic']['pending'],
            },
            post_restart['account']['pending'] == [] and post_restart['classic']['pending'] == [])

report = {
    'kind': 'a04-gate6-source-vs-phoenix-restart-comparison',
    'candidateRevision': ready['candidateRevision'],
    'sourceRevision': source['sourceRevision'],
    'client': {'node': sdk['node'], 'version': sdk['clientVersion'], 'calls': sdk['callCount']},
    'postClient': None if not post_sdk else {
        'node': post_sdk['node'],
        'version': post_sdk['clientVersion'],
        'calls': post_sdk['callCount'],
    },
    'classicForwardingExact': forward_ok,
    'restartCount': (restart_ready or {}).get('restartCount'),
    'allMatch': all(item['match'] for item in comparisons),
    'comparisons': comparisons,
    'artifactSha256': {
        name: sha256(ROOT / name)
        for name in [
            'source-sequences.json', 'sdk-results.json', 'server-captures.json', 'server-ready.json',
        ]
        if (ROOT / name).exists()
    },
}
for extra in ('sdk-post-restart.json', 'pre-restart.json', 'post-restart.json', 'restart-ready.json'):
    if (ROOT / extra).exists():
        report['artifactSha256'][extra] = sha256(ROOT / extra)
(ROOT / 'comparison.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps({
    'allMatch': report['allMatch'],
    'classicForwardingExact': forward_ok,
    'comparisons': sum(1 for item in comparisons if item['match']),
    'total': len(comparisons),
    'output': str(ROOT / 'comparison.json'),
}))
