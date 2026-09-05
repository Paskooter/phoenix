// Dedicated real-robot diagnostic stack. Run with PHOENIX_ENV_FILE=/dev/null.
// This launcher hosts the production services and observes their wire traffic;
// it does not replace parser/skill responses with a robot simulator.
import { mkdirSync, appendFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

if (process.env.PHOENIX_ENV_FILE !== '/dev/null') {
  throw new Error('Set PHOENIX_ENV_FILE=/dev/null to isolate this run from checkout .env files');
}
const runDir = resolve(process.env.PHOENIX_ROBOT_RUN || '.parity/robots/moth/20260905');
mkdirSync(runDir, { recursive: true, mode: 0o700 });
const base = Number(process.env.PHOENIX_ROBOT_PORT || 19000);
Object.assign(process.env, {
  NET_parser: `127.0.0.1:${base + 5}`,
  NET_history: `127.0.0.1:${base + 6}`,
  NET_data: `127.0.0.1:${base + 7}`,
  NET_skills: `127.0.0.1:${base + 3}`,
});
let traceBytes = 0;
let capturedAudioBytes = 0;
const captureAudio = process.env.PHOENIX_ROBOT_CAPTURE_AUDIO === 'true';
const maxCapturedAudioBytes = 8 * 1024 * 1024;
const tracePath = resolve(runDir, `wire-${Date.now()}.jsonl`);
function record(event) {
  const line = JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n';
  traceBytes += Buffer.byteLength(line);
  if (traceBytes > 64 * 1024 * 1024) throw new Error('Robot wire capture exceeded 64 MiB; start a reviewed new run');
  appendFileSync(tracePath, line, { mode: 0o600 });
}
const services = [];
try {
  if (process.env.PHOENIX_ROBOT_AUDIO_METRICS === 'true') {
    const { ParakeetASRSession } = await import('../../packages/gateway/src/asr/parakeetSession.js');
    const sessions = new WeakMap();
    let sessionID = 0;
    const metrics = session => {
      if (!sessions.has(session)) sessions.set(session, {
        session: ++sessionID, started: performance.now(), encoding: session.audio.encoding,
        pcmBytes: 0, pcmChunks: 0, maxChunkRms: 0, chunksAbove400: 0,
      });
      return sessions.get(session);
    };
    const start = ParakeetASRSession.prototype.start;
    ParakeetASRSession.prototype.start = function (...args) {
      metrics(this);
      return start.apply(this, args);
    };
    const consume = ParakeetASRSession.prototype._consumePcm;
    ParakeetASRSession.prototype._consumePcm = function (pcm) {
      const metric = metrics(this);
      const rms = ParakeetASRSession.computeRMS(pcm);
      if (!metric.pcmChunks) record({ kind: 'asr-first-pcm', session: metric.session,
        encoding: metric.encoding, elapsedMs: performance.now() - metric.started, bytes: pcm.length, rms });
      metric.pcmBytes += pcm.length;
      metric.pcmChunks++;
      metric.maxChunkRms = Math.max(metric.maxChunkRms, rms);
      if (rms > 400) metric.chunksAbove400++;
      return consume.call(this, pcm);
    };
    const close = ParakeetASRSession.prototype._closeDecoder;
    ParakeetASRSession.prototype._closeDecoder = function (...args) {
      const metric = metrics(this);
      if (!metric.closed) {
        metric.closed = true;
        record({ kind: 'asr-pcm-summary', ...metric, elapsedMs: performance.now() - metric.started,
          sosFired: this.sosFired, state: this.state });
      }
      return close.apply(this, args);
    };
  }
  const nlu = await import('../../packages/nlu/src/index.js');
  const history = await import('../../packages/history/src/index.js');
  const data = await import('../../packages/data/src/index.js');
  const skills = await import('../../packages/skills/src/index.js');
  const gateway = await import('../../packages/gateway/src/index.js');
  const { loadConfig } = await import('../../packages/gateway/src/config.js');
  services.push(await nlu.start(base + 5));
  services.push(await history.start(base + 6));
  services.push(await data.start(base + 7));
  services.push(await skills.start(base + 3));
  const config = loadConfig();
  // Initial transport-only profile, explicitly not authentication acceptance.
  config.disableAuth = process.env.PHOENIX_ROBOT_AUTH !== 'true';
  const gw = await gateway.start(base, config);
  services.push(gw.service);
  let connection = 0;
  gw.service.server.on('clientError', (error) => record({ kind: 'http-client-error', code: error.code, message: error.message }));
  gw.wss.on('connection', (ws, req) => {
    const id = ++connection;
    const audioFile = `audio-${id}.bin`;
    let audioOffset = 0;
    let audioLimitReported = false;
    record({ kind: 'connection', id, url: req.url, transID: req.headers['x-jibo-transid'], robotID: req.headers['x-jibo-robotid'], remote: req.socket.remoteAddress });
    const originalSend = ws.send;
    ws.send = function (value, ...args) {
      let json;
      try { json = JSON.parse(value.toString()); } catch { json = value.toString(); }
      record({ kind: 'server-message', id, json });
      return originalSend.call(this, value, ...args);
    };
    ws.on('message', (value, binary) => {
      if (binary) {
        const frame = { kind: 'client-audio', id, bytes: value.length, sha256: createHash('sha256').update(value).digest('hex') };
        if (captureAudio && capturedAudioBytes + value.length <= maxCapturedAudioBytes && audioOffset + value.length <= 2 * 1024 * 1024) {
          appendFileSync(resolve(runDir, audioFile), value, { mode: 0o600 });
          frame.capture = { file: audioFile, offset: audioOffset };
          audioOffset += value.length;
          capturedAudioBytes += value.length;
        } else if (captureAudio && !audioLimitReported) {
          audioLimitReported = true;
          record({ kind: 'audio-capture-limit', id, capturedAudioBytes, connectionBytes: audioOffset });
        }
        record(frame);
        return;
      }
      let json;
      try { json = JSON.parse(value.toString()); } catch { json = value.toString(); }
      record({ kind: 'client-message', id, json });
    });
    ws.on('close', (code, reason) => record({ kind: 'close', id, code, reason: reason.toString() }));
    ws.on('error', (error) => record({ kind: 'socket-error', id, error: error.message }));
  });
  const receipt = {
    started: new Date().toISOString(), pid: process.pid, cwd: process.cwd(), node: process.version,
    revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    base, services: { hub: base, skills: base + 3, parser: base + 5, history: base + 6, data: base + 7 },
    profile: { authentication: config.disableAuth ? 'disabled: transport-only trial' : 'enabled', nluLlm: false, answerLlm: false,
      asr: 'parakeet', asrUrl: process.env.ETCO_server_parakeetUrl || process.env.PARAKEET_URL || 'http://192.168.1.252:6972' },
    tracePath,
    audioCapture: { enabled: captureAudio, maxTotalBytes: maxCapturedAudioBytes, maxConnectionBytes: 2 * 1024 * 1024 },
    audioMetrics: process.env.PHOENIX_ROBOT_AUDIO_METRICS === 'true',
  };
  writeFileSync(resolve(runDir, 'stack.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ ready: true, ...receipt }));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
    record({ kind: 'shutdown', signal });
    for (const ws of gw.wss.clients) ws.close();
    for (const service of services) (service?.server || service)?.close?.();
    setTimeout(() => process.exit(0), 1000).unref();
  });
} catch (error) {
  console.error(error);
  for (const service of services) (service?.server || service)?.close?.();
  process.exit(1);
}
