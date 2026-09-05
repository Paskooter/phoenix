#!/usr/bin/env python3
"""Bounded Chrome 53 evaluation on an explicitly selected robot skill page.

Requires Python websockets. Use an owned SSH tunnel; promises must store their
result on window and be polled (Chrome 53 has no awaitPromise support).
"""
import argparse
import asyncio
import base64
import json
from pathlib import Path
import urllib.request
import urllib.parse
import websockets


async def command(port, slot, method, params, timeout=15):
    with urllib.request.urlopen('http://127.0.0.1:%d/json' % port, timeout=5) as response:
        pages = json.load(response)
    matches = [p for p in pages if p.get('type') == 'page' and
               p.get('url', '').endswith('/' + slot + '/index.html')]
    if len(matches) != 1:
        raise RuntimeError('Expected exactly one %s page; found %d' % (slot, len(matches)))
    target = matches[0]
    if 'webSocketDebuggerUrl' not in target:
        raise RuntimeError('Robot CDP page is already attached; finish the other owned probe first')
    url = urllib.parse.urlsplit(target['webSocketDebuggerUrl'])
    ws_url = urllib.parse.urlunsplit((url.scheme, '127.0.0.1:%d' % port, url.path, url.query, url.fragment))
    async with websockets.connect(ws_url, max_size=4 * 1024 * 1024, ping_interval=None) as ws:
        await ws.send(json.dumps({'id': 1, 'method': method, 'params': params}))
        while True:
            message = json.loads(await asyncio.wait_for(ws.recv(), timeout=timeout))
            if message.get('id') == 1:
                result = message.get('result', {})
                if message.get('error') or result.get('wasThrown') or result.get('exceptionDetails'):
                    raise RuntimeError(json.dumps(message))
                return {'page': target['url'], 'result': result}


async def evaluate(port, slot, expression, timeout=15):
    result = await command(port, slot, 'Runtime.evaluate',
                           {'expression': expression, 'returnByValue': True}, timeout)
    return {'page': result['page'], 'result': result['result'].get('result')}


async def screenshot(port, slot, out):
    result = await command(port, slot, 'Page.captureScreenshot', {'format': 'png'})
    out.write_bytes(base64.b64decode(result['result']['data']))
    return {'page': result['page'], 'screenshot': str(out)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=19223)
    parser.add_argument('--slot', default='phoenix-be12-parity')
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument('--expression')
    source.add_argument('--file', type=Path)
    source.add_argument('--screenshot', type=Path)
    parser.add_argument('--out', type=Path)
    args = parser.parse_args()
    if args.screenshot:
        result = asyncio.run(screenshot(args.port, args.slot, args.screenshot))
    else:
        expression = args.file.read_text() if args.file else args.expression
        result = asyncio.run(evaluate(args.port, args.slot, expression))
    rendered = json.dumps(result, indent=2) + '\n'
    if args.out:
        args.out.write_text(rendered)
    print(rendered, end='')


if __name__ == '__main__':
    main()
