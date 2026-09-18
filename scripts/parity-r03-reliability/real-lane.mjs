import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import http from 'node:http';
import { once } from 'node:events';
import { createGateway } from '../../packages/gateway/src/index.js';
import { jwt } from '@phoenix/common';
import { ParakeetASRSession } from '../../packages/gateway/src/asr/parakeetSession.js';
import { StreamingAudioDecoder, AUDIO_ENCODINGS } from '../../packages/gateway/src/asr/audioDecoder.js';
import { listenResultState } from '../../packages/contracts/src/envelope.js';
import { Timeouts } from '../../packages/contracts/src/constants.js';
import { OGG_OPUS } from '../../packages/gateway/test/fixtures/asrEncoded.js';
import WebSocket from 'ws';
import {
  sleep,
  startJsonPeer,
  parserResponse,
  skillResponse,
  waitFor,
} from './httpPeers.mjs';

const ROOT_CONTEXT = {
  general: { accountID: 'r03-account', robotID: 'r03-robot', lang: 'en', release: '1.9.0' },
  runtime: { perception: { speaker: 'r03-person', peoplePresent: [] }, dialog: {}, loop: { users: [] } },
  skill: {},
};

const LOCAL_SIGNING_KEY = 'r03-local-test-key';
const localToken = () => jwt.sign({ id: ROOT_CONTEXT.general.accountID, friendlyId: ROOT_CONTEXT.general.robotID }, LOCAL_SIGNING_KEY);

const quiet = { debug() {}, info() {}, warn() {}, error() {} };

function frameMessage(type, data) {
  return JSON.stringify({ type, msgID: `r03-${type}-${Date.now()}`, ts: 1700000000000, data });
}

function openSocket(port, id = 'r03') {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/listen`, {
    headers: { authorization: `Bearer ${localToken()}` },
  });
  const frames = [];
  const events = [];
  ws.on('message', (data) => {
    const frame = JSON.parse(data.toString());
    frames.push(frame);
    events.push({ frame, at: Date.now() });
  });
  // A deliberate close is part of the measurement, not a test failure.
  ws.on('error', () => {});
  const opened = once(ws, 'open');
  return {
    ws,
    id,
    frames,
    events,
    opened,
    send(type, data) { ws.send(frameMessage(type, data)); },
  };
}

async function closeSocket(ws) {
  if (!ws || ws.readyState === WebSocket.CLOSED) return;
  const closed = once(ws, 'close').catch(() => undefined);
  ws.terminate();
  await Promise.race([closed, sleep(1000)]);
}

async function closeGateway(gateway) {
  if (!gateway) return;
  for (const client of gateway.wss.clients) client.terminate();
  await new Promise((resolve) => gateway.wss.close(() => resolve()));
  if (gateway.service.server.listening) {
    await new Promise((resolve) => gateway.service.server.close(() => resolve()));
  }
}

async function startGateway({ parserURL, skillURL, asrProvider = null } = {}) {
  const gateway = await createGateway({
    skills: [{ id: 'fixture-skill', URL: skillURL || 'http://127.0.0.1:1/v1/main', intents: [{ name: 'launchTest' }] }],
    parserURL: parserURL || 'http://127.0.0.1:1',
    historyURL: 'http://127.0.0.1:1',
    settingsURL: 'http://127.0.0.1:1',
    disableAuth: false,
    hubTokenSecret: LOCAL_SIGNING_KEY,
    recordLaunchHistory: false,
    recordSpeechHistory: false,
    asrProvider: 'none',
    accountUrl: '',
  });
  if (asrProvider) gateway.components.asrProvider = asrProvider;
  await gateway.service.listen(0);
  return gateway;
}

async function sendClientTurn(client, { text = 'fixture words' } = {}) {
  client.send('LISTEN', { lang: 'en-US', mode: 'CLIENT_ASR', hotphrase: false, rules: ['launch'] });
  await waitFor(() => client.frames.some((frame) => frame.type === 'SOS'), { label: 'CLIENT_ASR SOS' });
  client.send('CONTEXT', { ...structuredClone(ROOT_CONTEXT), general: { ...ROOT_CONTEXT.general } });
  const sentAt = Date.now();
  client.send('CLIENT_ASR', { text });
  return sentAt;
}

async function terminalEvent(client, predicate, label) {
  return waitFor(() => client.events.find(({ frame }) => predicate(frame)), { timeoutMs: 15_000, label });
}

function snapshotPeer(record) {
  return {
    method: record.method,
    url: record.url,
    requestBodyType: record.body && record.body.type,
    startedAt: record.startedAt,
    requestEndedAt: record.requestEndedAt,
    responseSentAt: record.responseSentAt,
    responseFinishedAt: record.responseFinishedAt,
    responseClosedAt: record.responseClosedAt,
    requestAbortedAt: record.requestAbortedAt,
    socketClosedAt: record.socketClosedAt,
    socketOpenAtSnapshot: !!record.socket && !record.socket.destroyed,
  };
}

/** Measure a real ParserClient/SkillClient request across the production timeout. */
export async function measureHttpTimeout(kind) {
  assert.ok(kind === 'parser' || kind === 'skill');
  const parser = await startJsonPeer({
    name: 'parser',
    response: parserResponse(),
    hold: kind === 'parser',
    path: '/',
  });
  const skill = await startJsonPeer({
    name: 'skill',
    response: (record) => skillResponse(record.body?.data?.skill?.id),
    hold: kind === 'skill',
    path: '/v1/main',
  });
  let gateway;
  let client;
  try {
    gateway = await startGateway({ parserURL: parser.url, skillURL: skill.url });
    client = openSocket(gateway.service.server.address().port, `timeout-${kind}`);
    await client.opened;
    const sentAt = await sendClientTurn(client, { text: `timeout ${kind}` });
    const peer = kind === 'parser' ? parser : skill;
    await waitFor(() => peer.requests.length === 1, { label: `${kind} HTTP request` });
    const request = peer.requests[0];
    const expectedCode = kind === 'parser' ? 'PARSER' : 'TIMEOUT_SKILL';
    const errorEvent = await terminalEvent(
      client,
      (frame) => frame.type === 'ERROR' && frame.final === true,
      `${kind} final ERROR frame`,
    );
    assert.equal(errorEvent.frame.data.code, expectedCode);
    assert.match(errorEvent.frame.data.message, /Timeout/);
    await sleep(40);
    const peerOpenAtTimeout = !request.socket.destroyed && request.responseClosedAt === null;
    assert.equal(peerOpenAtTimeout, true, `${kind} HTTP request was not cancelled by timeout`);
    const frameCountAtTimeout = client.frames.length;

    // Release the real HTTP response after Phoenix has already sent its final ERROR.
    peer.release();
    await waitFor(() => request.responseFinishedAt !== null, { label: `${kind} late HTTP response` });
    await sleep(80);
    assert.equal(client.frames.length, frameCountAtTimeout, `${kind} late settlement emitted a frame`);
    const responseAt = request.responseSentAt;
    const outcome = {
      kind,
      budgetMs: Timeouts[kind],
      errorCode: errorEvent.frame.data.code,
      errorMessage: errorEvent.frame.data.message,
      timeoutElapsedMs: errorEvent.at - sentAt,
      requestToErrorMs: errorEvent.at - request.startedAt,
      lateResponseDelayMs: responseAt - errorEvent.at,
      frameTypesAtTimeout: client.frames.slice(0, frameCountAtTimeout).map((frame) => frame.type),
      lateFrames: client.frames.length - frameCountAtTimeout,
      peerOpenAtTimeout,
      http: snapshotPeer(request),
      cancellation: {
        cancelledByGateway: request.requestAbortedAt !== null || (request.socketClosedAt !== null && request.socketClosedAt < errorEvent.at),
        observedRequestAbortedAt: request.requestAbortedAt,
        observedSocketClosedAt: request.socketClosedAt,
      },
    };
    assert.equal(outcome.cancellation.cancelledByGateway, false);
    return outcome;
  } finally {
    await closeSocket(client?.ws);
    await closeGateway(gateway);
    await parser.close();
    await skill.close();
  }
}

/** Measure the real CONTEXT wait budget and its HubError code. */
export async function measureContextTimeout() {
  let gateway;
  let client;
  try {
    gateway = await startGateway({ parserURL: 'http://127.0.0.1:1', skillURL: 'http://127.0.0.1:1/v1/main' });
    client = openSocket(gateway.service.server.address().port, 'timeout-context');
    await client.opened;
    client.send('LISTEN', { lang: 'en-US', mode: 'CLIENT_ASR', hotphrase: false, rules: ['launch'] });
    await waitFor(() => client.frames.some((frame) => frame.type === 'SOS'), { label: 'CONTEXT timeout SOS' });
    const sentAt = Date.now();
    client.send('CLIENT_ASR', { text: 'context deliberately absent' });
    const errorEvent = await terminalEvent(client, (frame) => frame.type === 'ERROR' && frame.final === true, 'CONTEXT final ERROR frame');
    assert.equal(errorEvent.frame.data.code, 'TIMEOUT_CONTEXT');
    assert.ok(errorEvent.at - sentAt >= Timeouts.context - 100);
    assert.ok(errorEvent.at - sentAt < Timeouts.context + 1500);
    return {
      budgetMs: Timeouts.context,
      errorCode: errorEvent.frame.data.code,
      errorMessage: errorEvent.frame.data.message,
      timeoutElapsedMs: errorEvent.at - sentAt,
      frameTypes: client.frames.map((frame) => frame.type),
      externalPeerRequests: 0,
    };
  } finally {
    await closeSocket(client?.ws);
    await closeGateway(gateway);
  }
}

/** A real WebSocket close while a real cloud skill HTTP response is held. */
export async function measureHttpDisconnect() {
  const parser = await startJsonPeer({ name: 'parser', response: parserResponse(), path: '/' });
  const skill = await startJsonPeer({ name: 'skill', response: (record) => skillResponse(record.body?.data?.skill?.id), hold: true, path: '/v1/main' });
  let gateway;
  let client;
  try {
    gateway = await startGateway({ parserURL: parser.url, skillURL: skill.url });
    client = openSocket(gateway.service.server.address().port, 'disconnect-skill');
    await client.opened;
    await sendClientTurn(client, { text: 'disconnect after skill request' });
    await waitFor(() => skill.requests.length === 1, { label: 'held skill HTTP request' });
    const request = skill.requests[0];
    const frameCountBeforeClose = client.frames.length;
    const disconnectAt = Date.now();
    await closeSocket(client.ws);
    await sleep(50);
    const peerOpenAfterDisconnect = !request.socket.destroyed && request.responseClosedAt === null;
    assert.equal(peerOpenAfterDisconnect, true, 'WS disconnect unexpectedly cancelled the skill HTTP request');
    skill.release();
    await waitFor(() => request.responseFinishedAt !== null, { label: 'skill response after WS disconnect' });
    await sleep(100);
    assert.equal(client.frames.length, frameCountBeforeClose, 'a late skill result escaped after WS disconnect');
    return {
      kind: 'skill-after-ws-disconnect',
      disconnectAt,
      peerResponseAt: request.responseSentAt,
      peerResponseDelayMs: request.responseSentAt - disconnectAt,
      peerOpenAfterDisconnect,
      lateSettlementObserved: request.responseFinishedAt !== null,
      lateFrames: client.frames.length - frameCountBeforeClose,
      frameTypesBeforeDisconnect: client.frames.map((frame) => frame.type),
      http: snapshotPeer(request),
      cancellation: {
        cancelledByGateway: request.requestAbortedAt !== null || (request.socketClosedAt !== null && request.socketClosedAt < disconnectAt),
        observedRequestAbortedAt: request.requestAbortedAt,
        observedSocketClosedAt: request.socketClosedAt,
      },
    };
  } finally {
    await closeSocket(client?.ws);
    await closeGateway(gateway);
    await parser.close();
    await skill.close();
  }
}

async function startRecognizerPeer() {
  const requests = [];
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    const record = { method: req.method, url: req.url, startedAt: Date.now(), bodyBytes: 0, responseSentAt: null };
    requests.push(record);
    req.socket.__r03Record = record;
    req.on('data', (chunk) => { record.bodyBytes += chunk.length; });
    req.on('end', () => {
      if (req.url === '/healthz') {
        res.writeHead(404, { connection: 'close' });
        res.end();
        return;
      }
      if (req.url !== '/transcribe') {
        res.writeHead(404, { connection: 'close' });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
      record.responseSentAt = Date.now();
      res.end(JSON.stringify({ transcript: 'unexpected ASR post' }));
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    get transcribes() { return requests.filter((request) => request.url === '/transcribe'); },
    async close() {
      for (const socket of sockets) socket.destroy();
      if (server.listening) await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

function pcm(amplitude, ms) {
  const out = Buffer.alloc(Math.floor(16000 * ms / 1000) * 2);
  for (let i = 0; i < out.length / 2; i += 1) out.writeInt16LE(i % 2 ? amplitude : -amplitude, i * 2);
  return out;
}

/** Real CLIENT_ASR cancellation of a real ParakeetASRSession through a gateway WS. */
export async function measureRealASRCancellation() {
  const parser = await startJsonPeer({ name: 'parser', response: parserResponse(null), path: '/' });
  const recognizer = await startRecognizerPeer();
  const sessionLogs = [];
  const session = new ParakeetASRSession(recognizer.url, { lang: 'en-US', encoding: AUDIO_ENCODINGS.LINEAR16 }, {
    debug: (message, fields) => sessionLogs.push({ level: 'debug', message, fields }),
    info: (message, fields) => sessionLogs.push({ level: 'info', message, fields }),
    warn: (message, fields) => sessionLogs.push({ level: 'warn', message, fields }),
    error: (message, fields) => sessionLogs.push({ level: 'error', message, fields }),
  });
  let gateway;
  let client;
  try {
    gateway = await startGateway({ parserURL: parser.url, asrProvider: () => session });
    client = openSocket(gateway.service.server.address().port, 'cancel-asr');
    await client.opened;
    client.send('LISTEN', { lang: 'en-US', hotphrase: false, asr: { encoding: 'LINEAR16', sampleRate: 16000 }, rules: ['launch'] });
    await waitFor(() => session.started === true, { label: 'real Parakeet session start' });
    // Accepted audio proves this is not merely a pre-start cancellation.
    client.ws.send(Buffer.alloc(3200));
    client.send('CONTEXT', structuredClone(ROOT_CONTEXT));
    const cancelAt = Date.now();
    client.send('CLIENT_ASR', { text: 'client cancellation wins' });
    const final = await terminalEvent(client, (frame) => frame.final === true, 'CLIENT_ASR cancellation final frame');
    await waitFor(() => session.stopped === true && session.state === 'DONE', { label: 'Parakeet stop after CLIENT_ASR' });
    assert.equal(session.aborted, false, 'CLIENT_ASR uses cooperative stop, not abandon');
    assert.equal(recognizer.transcribes.length, 0, 'ASR cancellation posted a recognition request');
    assert.equal(final.frame.type, 'LISTEN');
    assert.equal(final.frame.data.asr.text, 'client cancellation wins');
    return {
      kind: 'client-asr-cancellation',
      cancelAt,
      finalAt: final.at,
      elapsedMs: final.at - cancelAt,
      frameTypes: client.frames.map((frame) => frame.type),
      finalAsrText: final.frame.data.asr.text,
      session: { stopped: session.stopped, aborted: session.aborted, state: session.state, totalBytes: session.totalBytes },
      recognizerRequests: recognizer.requests.map(({ method, url, bodyBytes }) => ({ method, url, bodyBytes })),
      transcribeRequests: recognizer.transcribes.length,
      logCount: sessionLogs.length,
    };
  } finally {
    await closeSocket(client?.ws);
    session.abort();
    await closeGateway(gateway);
    await parser.close();
    await recognizer.close();
  }
}

/** A real WS disconnect invokes ListenTransaction.abandon on a real ASR session. */
export async function measureRealASRAbandonment() {
  const recognizer = await startRecognizerPeer();
  const sessionLogs = [];
  const session = new ParakeetASRSession(recognizer.url, { lang: 'en-US', encoding: AUDIO_ENCODINGS.LINEAR16 }, {
    debug: (message, fields) => sessionLogs.push({ level: 'debug', message, fields }),
    info: (message, fields) => sessionLogs.push({ level: 'info', message, fields }),
    warn: (message, fields) => sessionLogs.push({ level: 'warn', message, fields }),
    error: (message, fields) => sessionLogs.push({ level: 'error', message, fields }),
  });
  let gateway;
  let client;
  try {
    gateway = await startGateway({ asrProvider: () => session });
    client = openSocket(gateway.service.server.address().port, 'abandon-asr');
    await client.opened;
    client.send('LISTEN', { lang: 'en-US', hotphrase: false, asr: { encoding: 'LINEAR16', sampleRate: 16000 }, rules: ['launch'] });
    await waitFor(() => session.started === true, { label: 'real Parakeet abandonment session start' });
    client.ws.send(pcm(8000, 200));
    await waitFor(() => session.sosFired === true, { label: 'real Parakeet SOS before disconnect' });
    const frameCountBeforeClose = client.frames.length;
    const disconnectAt = Date.now();
    await closeSocket(client.ws);
    await waitFor(() => session.aborted === true && session.state === 'DONE', { label: 'real Parakeet abort after WS close' });
    await sleep(100);
    assert.equal(session.stopped, true);
    assert.equal(session.totalBytes, 0, 'abandon did not drop buffered ASR audio');
    assert.equal(recognizer.transcribes.length, 0, 'abandon posted a recognition request');
    assert.equal(client.frames.length, frameCountBeforeClose, 'abandon produced a late robot frame');
    return {
      kind: 'ws-disconnect-asr-abandonment',
      disconnectAt,
      frameTypesBeforeDisconnect: client.frames.map((frame) => frame.type),
      framesAfterDisconnect: client.frames.length - frameCountBeforeClose,
      session: { stopped: session.stopped, aborted: session.aborted, state: session.state, totalBytes: session.totalBytes, sosFired: session.sosFired },
      recognizerRequests: recognizer.requests.map(({ method, url, bodyBytes }) => ({ method, url, bodyBytes })),
      transcribeRequests: recognizer.transcribes.length,
      logCount: sessionLogs.length,
    };
  } finally {
    await closeSocket(client?.ws);
    session.abort();
    await closeGateway(gateway);
    await recognizer.close();
  }
}

function completeOggPages(buffer) {
  const pages = [];
  let offset = 0;
  while (offset + 27 <= buffer.length) {
    if (buffer.toString('ascii', offset, offset + 4) !== 'OggS') break;
    const segments = buffer[offset + 26];
    const tableEnd = offset + 27 + segments;
    if (tableEnd > buffer.length) break;
    let body = 0;
    for (let i = 0; i < segments; i += 1) body += buffer[offset + 27 + i];
    const end = tableEnd + body;
    if (end > buffer.length) break;
    pages.push({ start: offset, end, flags: buffer[offset + 5], body });
    offset = end;
  }
  return { pages, pendingBytes: buffer.length - offset, offset };
}

async function runDecoder(bytes, allowTruncated) {
  const decoded = [];
  const decoder = new StreamingAudioDecoder({
    encoding: AUDIO_ENCODINGS.OGG_OPUS,
    onPcm: (chunk) => decoded.push(chunk),
    log: quiet,
  });
  decoder.start();
  let outcome;
  try {
    decoder.write(bytes);
    await sleep(50);
    await decoder.finish({ allowTruncated });
    outcome = { ok: true };
  } catch (error) {
    outcome = { ok: false, code: error.code, name: error.name, message: error.message };
  } finally {
    decoder.abort();
  }
  return {
    allowTruncated,
    outcome,
    decodedBytes: decoder.decodedBytes,
    decoderPages: decoder.oggPages,
    decoderSawEos: decoder.oggSawEos,
    decoderPendingBytes: decoder.oggBuffer.length,
    pcmBytes: Buffer.concat(decoded).length,
  };
}

async function runUnexpectedDecoderEof(bytes) {
  const errors = [];
  const decoder = new StreamingAudioDecoder({ encoding: AUDIO_ENCODINGS.OGG_OPUS, onError: (error) => errors.push(error), log: quiet });
  decoder.start();
  try {
    decoder.write(bytes);
    await sleep(50);
    assert.ok(decoder.child, 'ffmpeg child exists for unexpected EOF probe');
    decoder.child.stdin.end();
    await waitFor(() => decoder.failed === true, { timeoutMs: 3000, label: 'unexpected decoder EOF' });
    return {
      error: errors[0] ? { code: errors[0].code, name: errors[0].name, message: errors[0].message } : null,
      decoderPages: decoder.oggPages,
      decoderSawEos: decoder.oggSawEos,
      decoderPendingBytes: decoder.oggBuffer.length,
      decodedBytes: decoder.decodedBytes,
    };
  } finally {
    decoder.abort();
  }
}

/** Evidence for the OGG truncation decision; no production source is changed. */
export async function measureOggPolicy() {
  const full = completeOggPages(OGG_OPUS);
  assert.ok(full.pages.length >= 3, `fixture has ${full.pages.length} complete Ogg pages`);
  const metadataAndHeader = Buffer.concat([
    OGG_OPUS.subarray(0, full.pages[1].end),
    OGG_OPUS.subarray(full.pages[2].start, full.pages[2].start + 47),
  ]);
  const partialAudio = OGG_OPUS.subarray(0, -28);
  const audioWithoutEos = OGG_OPUS.subarray(0, full.pages[2].end);
  const independentMetadata = completeOggPages(metadataAndHeader);
  const independentPartial = completeOggPages(partialAudio);
  const independentAudioWithoutEos = completeOggPages(audioWithoutEos);
  const strictPartial = await runDecoder(partialAudio, false);
  const allowedPartial = await runDecoder(partialAudio, true);
  const strictMetadata = await runDecoder(metadataAndHeader, false);
  const allowedMetadata = await runDecoder(metadataAndHeader, true);
  const unexpectedEof = await runUnexpectedDecoderEof(audioWithoutEos);
  const noInput = listenResultState({ text: '', confidence: 0 }, { intent: null, rules: [], entities: {} });
  assert.equal(strictPartial.outcome.ok, false);
  assert.equal(allowedPartial.outcome.ok, true, 'allowTruncated must preserve decodable audio before a missing EOS page');
  assert.ok(allowedPartial.pcmBytes > 0);
  assert.equal(noInput, 'noInput');
  return {
    fixtureBytes: OGG_OPUS.length,
    metadataAndHeaderBytes: metadataAndHeader.length,
    partialAudioBytes: partialAudio.length,
    audioWithoutEosBytes: audioWithoutEos.length,
    independentMetadata: { completePages: independentMetadata.pages.length, pendingBytes: independentMetadata.pendingBytes },
    independentPartial: { completePages: independentPartial.pages.length, pendingBytes: independentPartial.pendingBytes },
    independentAudioWithoutEos: { completePages: independentAudioWithoutEos.pages.length, pendingBytes: independentAudioWithoutEos.pendingBytes },
    strictPartial,
    allowedPartial,
    strictMetadata,
    allowedMetadata,
    unexpectedEof,
    consumerContract: { emptyAsrState: noInput, errorCodeForDecoderFailure: 'ASR' },
    decision: {
      decodableAudioBeforeTruncation: 'allowTruncated',
      metadataOnlyOrZeroDecodedAudio: 'noInput',
      malformedOrNoCompletePage: 'retain_ASR_error',
      proposedPatch: 'Treat peer EOF as explicit end-of-input, call finish({allowTruncated:true}); if decodedBytes is zero, resolve {text:"",confidence:0} so the turn reaches noInput. Keep ERR_AUDIO_DECODE/ASR for malformed input or no complete page.',
    },
  };
}

export function validateEvidence(report) {
  const parser = report.httpTimeouts.find((row) => row.kind === 'parser');
  const skill = report.httpTimeouts.find((row) => row.kind === 'skill');
  assert.equal(parser.errorCode, 'PARSER');
  assert.equal(skill.errorCode, 'TIMEOUT_SKILL');
  for (const row of [parser, skill]) {
    assert.ok(row.timeoutElapsedMs >= row.budgetMs - 100, `${row.kind} timeout fired early`);
    assert.ok(row.timeoutElapsedMs < row.budgetMs + 2500, `${row.kind} timeout fired too late`);
    assert.equal(row.peerOpenAtTimeout, true);
    assert.equal(row.lateFrames, 0);
    assert.equal(row.cancellation.cancelledByGateway, false);
  }
  assert.equal(report.contextTimeout.errorCode, 'TIMEOUT_CONTEXT');
  assert.ok(report.contextTimeout.timeoutElapsedMs >= report.contextTimeout.budgetMs - 100);
  assert.ok(report.contextTimeout.timeoutElapsedMs < report.contextTimeout.budgetMs + 1500);
  assert.equal(report.disconnect.peerOpenAfterDisconnect, true);
  assert.equal(report.disconnect.lateSettlementObserved, true);
  assert.equal(report.disconnect.lateFrames, 0);
  assert.equal(report.disconnect.cancellation.cancelledByGateway, false);
  assert.equal(report.asrCancellation.session.stopped, true);
  assert.equal(report.asrCancellation.session.aborted, false);
  assert.equal(report.asrCancellation.transcribeRequests, 0);
  assert.equal(report.asrAbandonment.session.aborted, true);
  assert.equal(report.asrAbandonment.session.totalBytes, 0);
  assert.equal(report.asrAbandonment.transcribeRequests, 0);
  assert.equal(report.asrAbandonment.framesAfterDisconnect, 0);
  assert.equal(report.oggPolicy.strictPartial.outcome.ok, false);
  assert.equal(report.oggPolicy.allowedPartial.outcome.ok, true);
  assert.ok(report.oggPolicy.allowedPartial.pcmBytes > 0);
  assert.equal(report.oggPolicy.allowedMetadata.pcmBytes, 0);
  assert.equal(report.oggPolicy.allowedMetadata.outcome.ok, false);
  assert.match(report.oggPolicy.unexpectedEof.error.message, /ended before ASR end-of-speech/);
  assert.equal(report.oggPolicy.consumerContract.emptyAsrState, 'noInput');
  return true;
}

export function falsifyEvidence(report) {
  const bad = structuredClone(report);
  bad.httpTimeouts.find((row) => row.kind === 'parser').errorCode = 'TIMEOUT_PARSER';
  try {
    validateEvidence(bad);
    return { caught: false, message: 'validator accepted a falsified parser code' };
  } catch (error) {
    return { caught: true, name: error.name, message: error.message };
  }
}

export async function runLane() {
  const started = performance.now();
  const report = {
    schemaVersion: 2,
    task: 'R-03',
    referenceRevision: '5c0a7390539663ba749d360de348a428c088505c',
    sourceCitations: [
      {
        url: 'https://pvindex.org/gitea/jiboV2/pegasus/raw/commit/5c0a7390539663ba749d360de348a428c088505c/packages/hub/src/utils/PromiseUtils.ts',
        lines: '17-29',
        quote: "timeout2 returns the string 'TIMEOUT'; the original promise is still only chained with then/catch and is not cancelled.",
      },
      {
        url: 'https://pvindex.org/gitea/jiboV2/pegasus/raw/commit/5c0a7390539663ba749d360de348a428c088505c/packages/hub/src/listen/ListenTransactionHandler.ts',
        lines: '304-321',
        quote: 'Parser timeout2 is converted to HubErrorCode.TIMEOUT_PARSER, then the catch rethrows HubErrorCode.PARSER.',
      },
      {
        url: 'https://pvindex.org/gitea/jiboV2/pegasus/raw/commit/5c0a7390539663ba749d360de348a428c088505c/packages/hub/src/listen/ListenTransactionHandler.ts',
        lines: '439-450',
        quote: 'stopASR stops the ASR session, ends the audio stream, and clears both ASR timers.',
      },
      {
        url: 'https://pvindex.org/gitea/jiboV2/pegasus/raw/commit/5c0a7390539663ba749d360de348a428c088505c/packages/hub/src/listen/ListenHandler.ts',
        lines: '46-60',
        quote: 'A transaction error becomes a final ERROR envelope with code only when it is a HubError.',
      },
    ],
    measurement: 'real loopback HTTP peers, real Phoenix gateway WebSocket, real ParakeetASRSession, wall-clock deadlines',
    httpTimeouts: [],
  };
  report.httpTimeouts.push(await measureHttpTimeout('parser'));
  report.httpTimeouts.push(await measureHttpTimeout('skill'));
  report.contextTimeout = await measureContextTimeout();
  report.disconnect = await measureHttpDisconnect();
  report.asrCancellation = await measureRealASRCancellation();
  report.asrAbandonment = await measureRealASRAbandonment();
  report.oggPolicy = await measureOggPolicy();
  report.falsification = falsifyEvidence(report);
  validateEvidence(report);
  report.elapsedMs = performance.now() - started;
  report.acceptance = 'bounded-evidence';
  report.unknowns = [
    'No pinned-reference runtime was executed; source citations are static oracle evidence only.',
    'No real robot, Moth, live service, TLS deployment, process restart, sustained-memory, or production ASR provider was used.',
    'ASR 40s, whole-transaction 60s, WebSocket 180s, and close-after-final 2s budgets were not driven in this lane.',
    'The OGG decision is measured on the checked-in encoded fixture plus an independently shaped metadata/header prefix, not the private household capture.',
    'The disconnect path intentionally leaves the transaction lifecycle unresolved until its own work settles; this lane measures resource abandonment and wire silence, not a new lifecycle policy.',
  ];
  return report;
}
