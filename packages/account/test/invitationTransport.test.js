// Focused A-04 transport controls.  The relay and certificate are synthetic
// loopback fixtures; no external mail service or credential is contacted.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import net from 'node:net';
import tls from 'node:tls';
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { SmtpMailProvider, normalizeSmtpConfig } from '../src/smtpMail.js';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve(server.address().port);
    });
  });
}

function close(server) {
  if (!server?.listening) return Promise.resolve();
  return new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}

function makeCertificate(directory) {
  const key = join(directory, 'key.pem');
  const cert = join(directory, 'cert.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost',
  ], { stdio: 'ignore' });
  return { key: readFileSync(key), cert: readFileSync(cert) };
}

/**
 * Upgrade one SMTP connection in place after STARTTLS.  `secure` on each
 * command records whether credentials were sent through the TLS stream.
 */
function startTlsFixture(material) {
  const commands = [];
  const messages = [];
  const server = net.createServer((rawSocket) => {
    let socket = rawSocket;
    let buffer = '';
    let state = 'commands';
    let user = null;
    const reply = (value, callback = undefined) => socket.write(`${value}\r\n`, callback);
    const record = (line) => commands.push({ line, secure: socket !== rawSocket });

    const consumeCommands = () => {
      while (state !== 'data') {
        const end = buffer.indexOf('\r\n');
        if (end < 0) return;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        record(line);
        const upper = line.toUpperCase();
        if (upper.startsWith('EHLO')) {
          if (socket === rawSocket) reply('250-fixture.smtp\r\n250-STARTTLS\r\n250 AUTH LOGIN');
          else reply('250-fixture.smtp\r\n250 AUTH LOGIN');
        } else if (upper === 'STARTTLS' && socket === rawSocket) {
          reply('220 2.0.0 Ready to start TLS', () => {
            rawSocket.removeListener('data', onData);
            socket = new tls.TLSSocket(rawSocket, {
              isServer: true,
              secureContext: tls.createSecureContext(material),
            });
            socket.on('data', onData);
            socket.on('error', () => {});
          });
          return;
        } else if (upper === 'AUTH LOGIN') {
          reply('334 VXNlcm5hbWU6');
          state = 'auth-user';
        } else if (state === 'auth-user') {
          user = Buffer.from(line, 'base64').toString('utf8');
          reply('334 UGFzc3dvcmQ6');
          state = 'auth-pass';
        } else if (state === 'auth-pass') {
          const password = Buffer.from(line, 'base64').toString('utf8');
          if (user === 'fixture-user' && password === 'fixture-pass') reply('235 2.7.0 Authenticated');
          else reply('535 5.7.8 Authentication credentials invalid');
          state = 'commands';
        } else if (upper.startsWith('MAIL FROM') || upper.startsWith('RCPT TO')) {
          reply('250 OK');
        } else if (upper === 'DATA') {
          reply('354 End data with <CR><LF>.<CR><LF>');
          state = 'data';
          return;
        } else if (upper === 'QUIT') {
          reply('221 2.0.0 Bye');
        } else {
          reply('250 OK');
        }
      }
    };

    const onData = (chunk) => {
      buffer += chunk.toString('utf8');
      if (state === 'data') {
        const end = buffer.indexOf('\r\n.\r\n');
        if (end < 0) return;
        messages.push(buffer.slice(0, end));
        buffer = buffer.slice(end + 5);
        state = 'commands';
        reply('250 2.0.0 queued');
      }
      consumeCommands();
    };

    rawSocket.on('data', onData);
    rawSocket.on('error', () => {});
    reply('220 fixture.smtp ESMTP');
  });
  return { server, commands, messages };
}

function noStartTlsFixture() {
  const commands = [];
  const server = net.createServer((socket) => {
    let buffer = '';
    const reply = (value) => socket.write(`${value}\r\n`);
    const onData = (chunk) => {
      buffer += chunk.toString('utf8');
      let end;
      while ((end = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        commands.push(line);
        if (line.toUpperCase().startsWith('EHLO')) reply('250 fixture.smtp');
        else if (line.toUpperCase() === 'STARTTLS') reply('502 5.5.1 STARTTLS unavailable');
        else reply('250 OK');
      }
    };
    socket.on('data', onData);
    socket.on('error', () => {});
    reply('220 fixture.smtp ESMTP');
  });
  return { server, commands };
}

function noEightBitFixture() {
  const messages = [];
  const commands = [];
  const server = net.createServer((socket) => {
    let commandBuffer = Buffer.alloc(0);
    let dataBuffer = Buffer.alloc(0);
    let inData = false;
    const reply = (value) => socket.write(`${value}\r\n`);
    socket.on('data', (chunk) => {
      if (inData) {
        dataBuffer = Buffer.concat([dataBuffer, chunk]);
        const marker = Buffer.from('\r\n.\r\n');
        const end = dataBuffer.indexOf(marker);
        if (end < 0) return;
        const body = dataBuffer.subarray(0, end);
        dataBuffer = dataBuffer.subarray(end + marker.length);
        inData = false;
        if (body.some((byte) => byte > 0x7f)) {
          reply('550 5.6.7 8BITMIME is not supported');
        } else {
          messages.push(body);
          reply('250 2.0.0 queued');
        }
        commandBuffer = Buffer.concat([commandBuffer, dataBuffer]);
        dataBuffer = Buffer.alloc(0);
      } else {
        commandBuffer = Buffer.concat([commandBuffer, chunk]);
      }
      while (!inData) {
        const end = commandBuffer.indexOf(Buffer.from('\r\n'));
        if (end < 0) return;
        const line = commandBuffer.subarray(0, end).toString('utf8');
        commandBuffer = commandBuffer.subarray(end + 2);
        commands.push(line);
        const upper = line.toUpperCase();
        if (upper.startsWith('EHLO') || upper.startsWith('HELO')) reply('250 fixture.smtp');
        else if (upper.startsWith('MAIL FROM') || upper.startsWith('RCPT TO')) reply('250 OK');
        else if (upper === 'DATA') {
          inData = true;
          reply('354 End data with <CR><LF>.<CR><LF>');
          return;
        } else if (upper === 'QUIT') reply('221 Bye');
        else reply('250 OK');
      }
    });
    socket.on('error', () => {});
    reply('220 fixture.smtp ESMTP');
  });
  return { server, commands, messages };
}

function decodeQuotedPrintable(value) {
  const text = String(value).replace(/=\r?\n/g, '');
  const bytes = [];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '=' && /^[0-9a-f]{2}$/i.test(text.slice(index + 1, index + 3))) {
      bytes.push(Number.parseInt(text.slice(index + 1, index + 3), 16));
      index += 2;
    } else {
      bytes.push(text.charCodeAt(index));
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

test('SMTP transport negotiates STARTTLS and the advertised LOGIN mechanism', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'phx-a04-smtp-starttls-'));
  const material = makeCertificate(directory);
  const relay = startTlsFixture(material);
  try {
    const port = await listen(relay.server);
    const provider = new SmtpMailProvider({
      template: 'invitation',
      smtp: {
        host: '127.0.0.1',
        port,
        timeoutMs: 3000,
        servername: 'localhost',
        rejectUnauthorized: false,
        auth: { user: 'fixture-user', pass: 'fixture-pass' },
      },
    });
    const result = await provider.send('recipient@fixture.test', { name: 'Fixture' });
    assert.deepEqual(result.accepted, ['recipient@fixture.test']);
    assert.equal(relay.messages.length, 1);

    const lines = relay.commands.map((entry) => entry.line);
    assert.equal(lines.filter((line) => line.toUpperCase().startsWith('EHLO')).length, 2);
    assert.ok(lines.indexOf('STARTTLS') > 0);
    assert.ok(lines.indexOf('AUTH LOGIN') > lines.indexOf('STARTTLS'));
    assert.equal(lines.includes('AUTH PLAIN'), false);
    const authIndex = lines.indexOf('AUTH LOGIN');
    assert.equal(relay.commands[authIndex].secure, true);
    assert.equal(relay.commands[authIndex + 1].line, Buffer.from('fixture-user').toString('base64'));
    assert.equal(relay.commands[authIndex + 1].secure, true);
    assert.equal(relay.commands[authIndex + 2].line, Buffer.from('fixture-pass').toString('base64'));
    assert.equal(relay.commands[authIndex + 2].secure, true);
    assert.match(relay.messages[0], /^From: no-reply@jibo\.com\r?\n/m);
  } finally {
    await close(relay.server);
    rmSync(directory, { recursive: true, force: true });
  }
});

test('SMTP configuration exposes source STARTTLS/auth options', () => {
  const config = normalizeSmtpConfig({
    host: 'fixture.smtp',
    ignoreTLS: 'true',
    requireTLS: 'false',
    authMethod: 'LOGIN',
  });
  assert.equal(config.ignoreTLS, true);
  assert.equal(config.requireTLS, false);
  assert.equal(config.authMethod, 'LOGIN');
});

test('SMTP requireTLS fails when the relay cannot upgrade', async () => {
  const relay = noStartTlsFixture();
  try {
    const port = await listen(relay.server);
    const provider = new SmtpMailProvider({
      template: 'invitation',
      smtp: { host: '127.0.0.1', port, timeoutMs: 1000, requireTLS: true },
    });
    await assert.rejects(provider.send('recipient@fixture.test'), /SMTP STARTTLS failed/);
    assert.deepEqual(relay.commands, ['EHLO localhost', 'STARTTLS']);
  } finally {
    await close(relay.server);
  }
});

test('SMTP encodes Unicode parts for a relay without 8BITMIME', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'phx-a04-smtp-qp-'));
  const text = 'Plain café 😀 — literal {name}\r\n';
  const html = '<p>Owner café 😀 — {name}</p>\r\n';
  writeFileSync(join(directory, 'invitation.txt'), text);
  writeFileSync(join(directory, 'invitation.html'), html);
  const relay = noEightBitFixture();
  try {
    const port = await listen(relay.server);
    const provider = new SmtpMailProvider({
      template: 'invitation',
      smtp: { host: '127.0.0.1', port, timeoutMs: 1000 },
      templateDir: directory,
    });
    const result = await provider.send('recipient@fixture.test', { name: 'Äda' });
    assert.deepEqual(result.accepted, ['recipient@fixture.test']);
    assert.equal(relay.messages.length, 1);
    const raw = relay.messages[0];
    assert.equal(raw.some((byte) => byte > 0x7f), false);
    const decoded = decodeQuotedPrintable(raw.toString('ascii'));
    assert.match(decoded, /Plain café 😀 — literal \{name\}/);
    assert.match(decoded, /<p>Owner café 😀 — Äda<\/p>/);
    assert.equal((raw.toString('ascii').match(/Content-Transfer-Encoding: quoted-printable/g) || []).length, 2);
    assert.deepEqual(relay.commands, [
      'EHLO localhost',
      'MAIL FROM:<no-reply@jibo.com>',
      'RCPT TO:<recipient@fixture.test>',
      'DATA',
      'QUIT',
    ]);
  } finally {
    await close(relay.server);
    rmSync(directory, { recursive: true, force: true });
  }
});
