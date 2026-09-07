import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { jwt } from '@phoenix/common';
import { createGateway } from '../src/index.js';
import { accountVerifyTimeout, loadConfig } from '../src/config.js';

const SECRET = 'synthetic-account-deadline-secret';
const authorization = `Bearer ${jwt.sign({id:'fixture',accessKeyId:'fixture-key'}, SECRET)}`;

function upgrade(port, path, auth = authorization) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({host:'127.0.0.1',port});
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error('Upgrade did not settle within the test deadline'));
    }, 2000);
    let data = '';
    socket.on('connect', () => socket.write([
      `GET ${path} HTTP/1.1`, `Host: 127.0.0.1:${port}`,
      'Connection: Upgrade', 'Upgrade: websocket',
      'Sec-WebSocket-Version: 13', 'Sec-WebSocket-Key: AAECAwQFBgcICQoLDA0ODw==',
      `Authorization: ${auth}`, '', '',
    ].join('\r\n')));
    socket.on('data', chunk => {
      data += chunk.toString('latin1');
      if (!data.includes('\r\n\r\n')) return;
      clearTimeout(timeout); socket.destroy();
      resolve(Number(data.match(/^HTTP\/1\.1 (\d+)/)[1]));
    });
    socket.on('error', error => { clearTimeout(timeout); reject(error); });
  });
}

test('optional account timeout validates milliseconds and environment configuration', async () => {
  assert.equal(accountVerifyTimeout(), 5000);
  assert.equal(accountVerifyTimeout(''), 5000);
  assert.equal((await loadConfig({ETCO_hub_accountVerifyTimeoutMs:'150'})).accountVerifyTimeoutMs,150);
  for (const value of [0,-1,0.5,Infinity,NaN,'invalid',2147483648]) {
    assert.throws(() => accountVerifyTimeout(value),TypeError);
  }
});

test('stalled account headers/body reject both Hub paths, then the same peer recovers', async () => {
  let mode = 'headers';
  let requests = 0;
  const account = http.createServer((_req,res) => {
    requests++;
    if (mode === 'headers') return;
    res.writeHead(200,{'content-type':'application/json'});
    if (mode === 'body') { res.flushHeaders(); res.write('{'); return; }
    res.end(JSON.stringify({valid:mode==='valid',id:'fixture'}));
  });
  await new Promise(resolve => account.listen(0,'127.0.0.1',resolve));
  const gw = await createGateway({
    hubTokenSecret:SECRET,disableAuth:false,skills:[],
    accountUrl:`http://127.0.0.1:${account.address().port}`,accountVerifyTimeoutMs:150,
    parserURL:'http://127.0.0.1:9',historyURL:'http://127.0.0.1:9',
  });
  await gw.service.listen(0);
  const port = gw.service.server.address().port;
  try {
    for (const path of ['/v1/listen','/v1/proactive']) {
      for (const stalled of ['headers','body']) {
        mode=stalled;
        assert.equal(await upgrade(port,path),401);
        mode='valid';
        assert.equal(await upgrade(port,path),101);
      }
      mode='revoked';
      assert.equal(await upgrade(port,path),401);
    }
    assert.equal(requests,10);
  } finally {
    for (const socket of gw.wss.clients) socket.terminate();
    await new Promise(resolve => gw.wss.close(resolve));
    await new Promise(resolve => gw.service.server.close(resolve));
    account.closeAllConnections();
    await new Promise(resolve => account.close(resolve));
  }
});
