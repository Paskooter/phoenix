import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { ParakeetASRSession, ASR_SILENCE_TO_EOS_MS } from '../src/asr/parakeetSession.js';
import { createGateway } from '../src/index.js';
import { recentLogs, recentVoiceTurns } from '@phoenix/common';
import { postParakeetWav } from '../src/asr/parakeetTransport.js';
import { createFailoverTransport } from '../src/asr/failoverTransport.js';
import { RecognizerSocket, parseControl } from '../src/asr/recognizerSocket.js';
const tick = () => new Promise(resolve => setImmediate(resolve));
function speech() { const b = Buffer.alloc(300 * 32); for (let i = 0; i < b.length; i += 2) b.writeInt16LE(8000, i); return b; }

test('provider finalization failure log has attribution but never the upstream message', async t => {
  const records = [];
  const log = Object.fromEntries(['info', 'error', 'warn', 'debug'].map(level => [level, (message, fields) => records.push({ level, message, fields })]));
  const s = new ParakeetASRSession(null, {}, log, { transport: { describe: () => ({ provider: 'google' }),
    probeStreaming: async () => false, recognizeWav: async () => { throw Object.assign(new Error('private-words token=private-value'), { code: 'GOOGLE_STT_ERROR', grpcCode: 14 }); } } });
  t.after(() => s.abort());
  const result = s.start().catch(e => e);
  s.provideAudio(Buffer.concat([speech(), Buffer.alloc(ASR_SILENCE_TO_EOS_MS * 32)]));
  await result;
  const record = records.find(r => r.level === 'error');
  assert.equal(record.fields?.provider, 'google');
  assert.equal(record.fields?.errorCode, 'GOOGLE_STT_ERROR');
  assert.equal(record.fields?.grpcCode, 14);
  assert.ok(!JSON.stringify(records).includes('private-words'));
});

test('Parakeet HTTP rejection carries a structured status instead of parsing a message', async t => {
  const server = http.createServer(async (req, res) => {
    for await (const _ of req) { /* synthetic input */ }
    res.writeHead(503); res.end('private-words token=private-value');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const error = await postParakeetWav(`http://127.0.0.1:${server.address().port}`, ParakeetASRSession.makeWav(speech())).catch(e => e);
  assert.equal(error.httpStatus, 503);
});

for (const actor of ['peer', 'server', 'unknown']) {
  test(`real gateway WebSocket attributes a mid-turn ${actor} close without the reason text`, async t => {
    const gateway = await createGateway({ skills: [], parserURL: 'http://127.0.0.1:1', historyURL: 'http://127.0.0.1:1',
      disableAuth: true, hubTokenSecret: 'synthetic-secret', recordLaunchHistory: false, recordSpeechHistory: false });
    await gateway.service.listen(0);
    t.after(async () => { for (const s of gateway.wss.clients) s.terminate(); await new Promise(resolve => gateway.service.server.close(resolve)); });
    const connected = once(gateway.wss, 'connection');
    const client = new WebSocket(`ws://127.0.0.1:${gateway.service.server.address().port}/v1/listen`);
    await once(client, 'open');
    const [server] = await connected;
    const closed = once(server, 'close');
    if (actor === 'peer') client.close(1001, 'private-words token=private-value');
    else if (actor === 'server') server.close(1001, 'private-words token=private-value');
    else client.terminate();
    await closed; await tick();
    const record = recentLogs({ limit: 100 }).events.filter(r => r.msg === 'voice_turn_socket_close').at(-1);
    assert.equal(record?.closedBy, actor);
    assert.equal(record?.stage, 'wait_listen');
    assert.equal(record?.reason, actor === 'unknown' ? 'abnormal-close' : 'going-away');
    assert.ok(!JSON.stringify(record).includes('private-words'));
    const stored = recentVoiceTurns({ outcome: 'abandoned', limit: 1 }).turns[0];
    assert.equal(stored.socketClose?.closedBy, actor);
  });
}

test('real gateway terminal ASR error log attributes failover without changing the wire error', async t => {
  const gateway = await createGateway({ skills: [], parserURL: 'http://127.0.0.1:1', historyURL: 'http://127.0.0.1:1',
    disableAuth: true, hubTokenSecret: 'synthetic-secret', recordLaunchHistory: false, recordSpeechHistory: false });
  const upstream = Object.assign(new Error('private-words token=private-value'), { code: 'GOOGLE_STT_ERROR', grpcCode: 14 });
  gateway.components.asrProvider = () => ({ onStartOfSpeech() {}, onEndOfSpeech() {}, abort() {},
    start: () => Promise.reject(upstream), describe: () => ({ provider: 'google', failover: 'parakeet-batch-failed' }) });
  await gateway.service.listen(0);
  t.after(async () => { for (const s of gateway.wss.clients) s.terminate(); await new Promise(resolve => gateway.service.server.close(resolve)); });
  const client = new WebSocket(`ws://127.0.0.1:${gateway.service.server.address().port}/v1/listen`);
  await once(client, 'open');
  const message = once(client, 'message');
  client.send(JSON.stringify({ type: 'LISTEN', data: { lang: 'en-US' } }));
  const [frame] = await message;
  const error = JSON.parse(frame.toString());
  assert.equal(error.type, 'ERROR'); assert.equal(error.data.code, 'ASR');
  assert.equal(error.data.message, upstream.message, 'preserve the existing robot-facing error contract');
  const record = recentLogs({ limit: 100 }).events.filter(r => r.msg === 'transaction failed').at(-1);
  assert.equal(record.provider, 'google'); assert.equal(record.errorCode, 'GOOGLE_STT_ERROR');
  assert.equal(record.grpcCode, 14); assert.equal(record.failover, 'parakeet-batch-failed');
  assert.equal(record.error, 'ASR failed');
  assert.ok(!JSON.stringify(record).includes('private-words'));
  client.close();
});

test('ended primary stream failure stays attributed to Parakeet after Google is selected for recovery', async t => {
  const records = [];
  const log = Object.fromEntries(['info','warn','error','debug'].map(level => [level,(message,fields)=>records.push({level,message,fields})]));
  class Primary extends RecognizerSocket {
    constructor() { super(); setImmediate(()=>this._emitOpen()); }
    send(data) { if (parseControl(data)?.type === 'eos') this._emitError(Object.assign(new Error('private-words'),{code:'ECONNRESET'})); }
    terminate() { this._emitClose(); }
    close() { this._emitClose(); }
  }
  const transport = createFailoverTransport({
    primary: { probe: async()=>({reachable:true,streaming:true}),openStream:()=>new Primary() },
    secondary: { available:()=>true,describe:()=>({provider:'google'}),recognizeWav:async()=>({text:'synthetic recovered command',confidence:1}) },
    health: { isDown:()=>false,state:'up',markDown() {} }, log,
  });
  const s = new ParakeetASRSession(null,{},log,{transport});t.after(()=>s.abort());
  const result=s.start();
  for(let i=0;i<10&&!s.streamingReady;i++) await tick();
  assert.equal(s.streamingReady,true);
  s.provideAudio(Buffer.concat([speech(),Buffer.alloc(ASR_SILENCE_TO_EOS_MS*32)]));
  assert.equal((await result).text,'synthetic recovered command');
  const warnings=records.filter(r=>r.level==='warn');assert.ok(warnings.length>0);
  for(const warning of warnings){assert.equal(warning.fields?.provider,'parakeet');assert.equal(warning.fields?.errorCode,'ECONNRESET');}
  assert.equal(transport.describe().provider,'google','the recoverer is not the provider that failed');
  assert.ok(!JSON.stringify(records).includes('private-words'));
});
