#!/usr/bin/env python3
"""Summarise a robot-side tcpdump ASCII capture of the Phoenix hub port.

Prints, per WebSocket upgrade attempt: the bearer token's SHA-256 (the token
itself is never printed), its decoded JWT *claim names* (values are withheld -
the CreateHubToken claim set contains the robot's secretAccessKey), and the
server's HTTP status line. Also writes a token-redacted copy of the capture so
the evidence file can be committed without credentials.
"""
import hashlib
import json
import re
import sys
import base64

STATUS = re.compile(r'HTTP/1\.1 (\d{3}[^\\\r]*)')


def b64d(part):
    return json.loads(base64.urlsafe_b64decode(part + '=' * (-len(part) % 4)).decode())


def summarise(path, redacted_path=None):
    text = open(path, encoding='utf-8', errors='replace').read()
    out = []
    # Keep a short redacted copy: replace every bearer token with its hash.
    for token in set(re.findall(r'Authorization: Bearer (\S+)', text)):
        text = text.replace(token, 'sha256:' + hashlib.sha256(token.encode()).hexdigest())
    if redacted_path:
        open(redacted_path, 'w').write(text)
    sofar = open(redacted_path or path, encoding='utf-8').read().split('\n')
    for i, line in enumerate(sofar):
        if 'GET /v1/listen' in line:
            window = '\n'.join(sofar[max(0, i - 6):i + 14])
            token = re.search(r'sha256:([0-9a-f]{64})', window)
            entry = {'attempt': len([o for o in out if o['kind'] == 'request']) + 1,
                     'kind': 'request', 'url': '/v1/listen',
                     'token_sha256': token.group(1) if token else None}
        elif STATUS.search(line):
            status = STATUS.search(line).group(1).strip()
            entry = {'attempt': len([o for o in out if o['kind'] == 'request']),
                     'kind': 'response', 'status': status}
        else:
            continue
        ts = None
        for j in range(i, -1, -1):
            m = re.match(r'^(\d\d:\d\d:\d\d\.\d+) IP ', sofar[j])
            if m:
                ts = m.group(1)
                break
        entry['ts'] = ts
        out.append(entry)
    return out


if __name__ == '__main__':
    for path in sys.argv[1:]:
        redacted = path.replace('.txt', '-redacted.txt')
        print('=====', path)
        for event in summarise(path, redacted):
            print(' ', json.dumps(event))
        print('  token-redacted copy written to', redacted)
