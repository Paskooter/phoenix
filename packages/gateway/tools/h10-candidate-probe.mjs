/* Review-only H-10 candidate side of the pinned Node 8 differential. */

import fs from 'node:fs';
import net from 'node:net';
import { createHmac } from 'node:crypto';
import { checkAuthentication, createGateway } from '../src/index.js';
import { verify } from '../../common/src/jwt.js';

const fixturePath = process.argv[2];
const sourceOutputPath = process.argv[3];
const outputPath = process.argv[4];
const cases = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

const base64url = (value) => Buffer.from(value).toString('base64url');
const digestFor = (algorithm) => algorithm === 'HS256' ? 'sha256' : algorithm === 'HS384' ? 'sha384' : 'sha512';

function buildToken(spec) {
  const header = spec.headerJson !== undefined ? spec.headerJson : JSON.stringify(spec.header);
  const input = `${base64url(header)}.${base64url(spec.payloadJson)}`;
  let signature;
  if (spec.signature === 'hmac' || spec.signature === 'hmac-alt') {
    signature = createHmac(digestFor(spec.header.alg), cases.secret).update(input).digest('base64url');
    if (spec.signature === 'hmac-alt') {
      const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
      const index = alphabet.indexOf(signature.at(-1));
      signature = `${signature.slice(0, -1)}${alphabet[index + 1]}`;
    }
  } else if (spec.signature === 'empty') {
    signature = '';
  } else {
    signature = spec.signature;
  }
  return `${input}.${signature}`;
}

const tokens = Object.fromEntries(cases.tokens.map((spec) => [spec.id, buildToken(spec)]));
tokens.malformed = 'not-a-jwt';

function resolve(value) {
  if (typeof value !== 'string') return value;
  return value.replace(/\$\{([^}]+)\}/g, (_match, id) => tokens[id] === undefined ? _match : tokens[id]);
}

function normalized(value) {
  if (value === undefined) return { type: 'undefined' };
  if (value === null) return null;
  if (value instanceof Date) return { type: 'Date', value: value.toISOString() };
  return value;
}

function outcome(fn) {
  try {
    return { ok: true, value: normalized(fn()) };
  } catch (error) {
    return {
      ok: false,
      error: {
        name: error?.name,
        message: error?.message,
        constructor: error?.constructor?.name,
      },
    };
  }
}

function directResults() {
  const output = {};
  for (const spec of cases.tokens) {
    output[spec.id] = outcome(() => verify(tokens[spec.id], cases.secret, { clockTimestamp: cases.clockTimestamp }));
  }
  for (const spec of cases.direct) {
    let token;
    if (spec.kind === 'missing') token = undefined;
    else token = spec.value;
    output[spec.id] = outcome(() => verify(token, cases.secret, { clockTimestamp: cases.clockTimestamp }));
  }
  return output;
}

function authResults() {
  const output = {};
  for (const spec of cases.auth) {
    const headers = {};
    if (spec.authorization !== null) headers.authorization = resolve(spec.authorization);
    const secret = spec.secret === 'missing' ? '' : cases.secret;
    output[spec.id] = outcome(() => checkAuthentication(headers, secret));
  }
  return output;
}

function parseResponse(buffer) {
  const text = buffer.toString('latin1');
  const separator = text.indexOf('\r\n\r\n');
  if (separator < 0) throw new Error('incomplete upgrade response');
  const head = text.slice(0, separator).split('\r\n');
  const status = head.shift().match(/^HTTP\/1\.1 (\d+) (.*)$/);
  const headers = {};
  for (const line of head) {
    const colon = line.indexOf(':');
    if (colon > 0) headers[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
  }
  return { status: Number(status[1]), reason: status[2], headers, body: text.slice(separator + 4) };
}

function rawUpgrade(port, path, authorization) {
  return new Promise((done, reject) => {
    const chunks = [];
    let settled = false;
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const timer = setTimeout(() => {
      socket.destroy();
      if (!settled) { settled = true; reject(new Error('upgrade response timeout')); }
    }, 2_000);
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) return reject(error);
      try {
        const response = parseResponse(Buffer.concat(chunks));
        socket.destroy();
        done(response);
      }
      catch (parseError) { reject(parseError); }
    };
    socket.on('connect', () => {
      const lines = [
        `GET ${path} HTTP/1.1`,
        'Host: 127.0.0.1',
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version: 13',
      ];
      if (authorization !== null) lines.push(`Authorization: ${resolve(authorization)}`);
      socket.write(`${lines.join('\r\n')}\r\n\r\n`);
    });
    socket.on('data', (chunk) => {
      chunks.push(chunk);
      const bytes = Buffer.concat(chunks);
      const text = bytes.toString('latin1');
      const separator = text.indexOf('\r\n\r\n');
      const length = text.match(/\r\ncontent-length:\s*(\d+)/i);
      if (separator >= 0 && length && bytes.length >= separator + 4 + Number(length[1])) finish();
    });
    socket.on('end', () => finish());
    socket.on('close', () => finish());
    socket.on('error', (error) => { if (!settled && chunks.length === 0) finish(error); });
  });
}

async function upgradeResults() {
  const gateway = createGateway({
    hubTokenSecret: cases.secret,
    disableAuth: false,
    accountUrl: '',
    parserURL: 'http://127.0.0.1:9',
    historyURL: 'http://127.0.0.1:9',
    skills: [],
  });
  await gateway.service.listen(0);
  const port = gateway.service.server.address().port;
  const output = {};
  try {
    for (const spec of cases.upgrades) output[spec.id] = await rawUpgrade(port, spec.path, spec.authorization);
  } finally {
    await new Promise((resolve) => gateway.wss.close(() => resolve()));
    await new Promise((resolve, reject) => gateway.service.server.close((error) => error ? reject(error) : resolve()));
  }
  return output;
}

const output = {
  runtime: { node: process.version, candidate: 'phoenix', sourceOutput: sourceOutputPath },
  direct: directResults(),
  auth: authResults(),
  upgrades: await upgradeResults(),
};
fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);
