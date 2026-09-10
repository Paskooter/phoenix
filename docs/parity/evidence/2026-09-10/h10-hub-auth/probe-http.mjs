import net from 'node:net';
import { jwt } from '@phoenix/common';
const { createGateway } = await import('@phoenix/gateway');

const SECRET = 'h10-runtime-secret2';

function rawUpgrade(port, path, authorization) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let settled = false;
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const timer = setTimeout(() => { socket.destroy(); if (!settled) { settled = true; reject(new Error('timeout')); } }, 2000);
    const finish = () => {
      if (settled) return; settled = true; clearTimeout(timer);
      const bytes = Buffer.concat(chunks); const sep = bytes.indexOf('\r\n\r\n');
      const head = bytes.subarray(0, sep).toString('latin1').split('\r\n');
      const status = head.shift().match(/^HTTP\/1\.1 (\d+) (.*)$/);
      resolve({ status: Number(status[1]), reason: status[2], body: bytes.subarray(sep + 4).toString('utf8') });
    };
    socket.on('connect', () => {
      const lines = ['GET ' + path + ' HTTP/1.1', 'Host: 127.0.0.1', 'Upgrade: websocket', 'Connection: Upgrade',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version: 13'];
      if (authorization !== undefined) lines.push('Authorization: ' + authorization);
      socket.write(lines.join('\r\n') + '\r\n\r\n');
    });
    socket.on('data', (c) => chunks.push(c));
    socket.on('end', finish); socket.on('close', finish);
    socket.on('error', (e) => { if (!settled && chunks.length === 0) { settled = true; clearTimeout(timer); reject(e); } });
  });
}

const base = { disableAuth: false, accountUrl: '', parserURL: 'http://127.0.0.1:9', historyURL: 'http://127.0.0.1:9', skills: [] };

// no secret configured
{
  const gw = await createGateway({ ...base, hubTokenSecret: '' });
  await gw.service.listen(0);
  const port = gw.service.server.address().port;
  console.log('NO-SECRET upgrade:', JSON.stringify(await rawUpgrade(port, '/listen', 'Bearer ' + jwt.sign({ id: 'r' }, SECRET))));
  console.log('NO-SECRET /skills:', JSON.stringify(await fetch(`http://127.0.0.1:${port}/skills/robot-A`).then(async r => ({ status: r.status, body: await r.text() }))));
  await new Promise(r => gw.wss.close(r)); await new Promise(r => gw.service.server.close(r));
}

// RS256 header token (alg confusion attempt) verified with HS secret
{
  const gw = await createGateway({ ...base, hubTokenSecret: SECRET, skills: [{ id: 'sk', URL: 'http://127.0.0.1:9/v1/main', intents: [] }] });
  await gw.service.listen(0);
  const port = gw.service.server.address().port;
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const rsToken = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ id: 'r' })}.AAAA`;
  console.log('RS256 upgrade:', JSON.stringify(await rawUpgrade(port, '/listen', 'Bearer ' + rsToken)));
  const noneToken = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ id: 'r' })}.`;
  console.log('NONE-empty-sig upgrade:', JSON.stringify(await rawUpgrade(port, '/listen', 'Bearer ' + noneToken)));
  console.log('HEALTHCHECK:', JSON.stringify(await fetch(`http://127.0.0.1:${port}/healthcheck`).then(async r => ({ status: r.status, body: await r.text() }))));
  console.log('GET /skills/robot-A (no auth):', JSON.stringify(await fetch(`http://127.0.0.1:${port}/skills/robot-A`).then(async r => ({ status: r.status, body: await r.text() }))));
  console.log('GET /v1/skills/settings/robot-A (no auth):', JSON.stringify(await fetch(`http://127.0.0.1:${port}/v1/skills/settings/robot-A`).then(async r => ({ status: r.status, body: await r.text() }))));
  await new Promise(r => gw.wss.close(r)); await new Promise(r => gw.service.server.close(r));
}
