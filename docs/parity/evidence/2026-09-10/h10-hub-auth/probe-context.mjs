import { WebSocket } from 'ws';
import { jwt } from '@phoenix/common';
const { createGateway } = await import('@phoenix/gateway');

const SECRET = 'h10-runtime-secret';
const gw = await createGateway({ hubTokenSecret: SECRET, disableAuth: false, accountUrl: '', parserURL: 'http://127.0.0.1:9', historyURL: 'http://127.0.0.1:9', skills: [] });
await gw.service.listen(0);
const port = gw.service.server.address().port;

const token = (claims) => jwt.sign({ id: 'acct-A', friendlyId: 'robot-A', ...claims }, SECRET);

function drive(path, frames, { auth } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers: { Authorization: `Bearer ${auth === undefined ? token() : auth}` } });
    const out = [];
    ws.on('open', () => frames.forEach((f) => ws.send(JSON.stringify(f))));
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      out.push(m);
      if (m.final) { setTimeout(() => { ws.close(); resolve(out); }, 20); }
    });
    ws.on('unexpected-response', (_r, res) => { res.on('data', (c) => { out.push({ upgrade: res.statusCode, body: c.toString() }); resolve(out); }); });
    ws.on('error', reject);
    setTimeout(() => { try { ws.close(); } catch {} resolve(out); }, 1500);
  });
}

const ctxBadAccount = { type: 'CONTEXT', data: { general: { accountID: 'acct-B', robotID: 'robot-A', release: '1.8.0' }, runtime: { loop: {} } } };
const ctxBadRobot = { type: 'CONTEXT', data: { general: { accountID: 'acct-A', robotID: 'robot-B', release: '1.8.0' }, runtime: { loop: {} } } };
const ctxOk = { type: 'CONTEXT', data: { general: { accountID: 'acct-A', robotID: 'robot-A', release: '1.8.0' }, runtime: { loop: {} } } };
const listenNlu = { type: 'LISTEN', data: { lang: 'en-US', mode: 'CLIENT_NLU', hotphrase: false, rules: ['launch'] } };
const nluNoMatch = { type: 'CLIENT_NLU', data: { intent: 'zzz-nope', rules: ['launch'], entities: {} } };

console.log('REJECT account:', JSON.stringify(await drive('/listen', [ctxBadAccount])));
console.log('REJECT robot  :', JSON.stringify(await drive('/listen', [ctxBadRobot])));
console.log('ACCEPT turn   :', JSON.stringify(await drive('/listen', [listenNlu, ctxOk, nluNoMatch])));
console.log('PROACTIVE bad :', JSON.stringify(await drive('/proactive', [ctxBadAccount])));
await new Promise((r) => gw.wss.close(r));
await new Promise((r) => gw.service.server.close(r));
