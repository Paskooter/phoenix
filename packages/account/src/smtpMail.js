// Local SMTP counterpart of srv-account-ws MailController.
//
// The original uses Nodemailer for either config.mail.smtp or AWS SES. Phoenix
// deliberately does not carry AWS credentials; this small SMTP client keeps
// the source template/subject/sendMail boundary available for a configured
// local SMTP relay without adding a second mail dependency to the service.

import { createConnection as createTcpConnection } from 'node:net';
import { connect as createTlsConnection } from 'node:tls';
import { readFileSync } from 'node:fs';
import { createHmac, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

export const MAIL_SUBJECTS = Object.freeze({
  activation: 'Account Activation',
  emailReset: 'Your new email',
  emailResetComplete: 'Your email has changed',
  invitation: 'Invitation',
  invitationExistingUser: 'Invitation',
  passwordReset: 'Password Reset',
  robotNotFound: 'Your robot is not found',
});

export const INVITATION_SUBJECT = MAIL_SUBJECTS.invitation;

const DEFAULT_FROM = 'no-reply@jibo.com';
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_TEMPLATE_DIR = fileURLToPath(new URL('../resources/templates/', import.meta.url));

function own(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function numberOption(value, fallback, minimum = 1) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(minimum, number) : fallback;
}

function boolOption(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(value));
}

function rejectHeaderInjection(value, name) {
  if (/[\r\n]/.test(String(value))) throw new TypeError(`${name} contains a newline`);
  return String(value);
}

function envelopeAddress(value, name) {
  const text = rejectHeaderInjection(value, name).trim();
  const match = text.match(/<([^<>]+)>/);
  const address = (match ? match[1] : text).trim();
  if (!address || /[\s<>]/.test(address)) throw new TypeError(`${name} is not an SMTP address`);
  return address;
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function renderHtml(template, options) {
  let html = template;
  // This intentionally follows MailController's `for ... in` plus
  // `options.hasOwnProperty` replacement boundary. In particular, text.txt is
  // sent unchanged by the source while only HTML receives option expansion.
  for (const option in options) {
    if (own(options, option)) {
      html = html.replace(new RegExp(`{${escapeRegex(option)}}`, 'g'), options[option]);
    }
  }
  return html;
}

function normalizeCrlf(value) {
  return String(value).replace(/\r?\n/g, '\r\n');
}

function dotStuff(value) {
  return normalizeCrlf(value).replace(/^\./gm, '..');
}

function isPlainText(value) {
  // This is libmime.isPlainText's exact character boundary. DEL (0x7f) is
  // intentionally omitted from the source expression and remains 7bit.
  return typeof value === 'string' && !/[\x00-\x08\x0b\x0c\x0e-\x1f\u0080-\uFFFF]/.test(value);
}

function hasLongerLines(value, lineLength = 76) {
  return new RegExp(`^.{${lineLength + 1},}`, 'm').test(value);
}

function quotedPrintableEncode(value) {
  const bytes = Buffer.from(normalizeCrlf(value), 'utf8');
  let encoded = '';
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index];
    const lineEnd = index === bytes.length - 1 || bytes[index + 1] === 0x0a || bytes[index + 1] === 0x0d;
    const safe = byte === 0x09 || byte === 0x0a || byte === 0x0d
      || (byte >= 0x20 && byte <= 0x3c) || (byte >= 0x3e && byte <= 0x7e);
    if (safe && !((byte === 0x20 || byte === 0x09) && lineEnd)) {
      encoded += String.fromCharCode(byte);
    } else {
      encoded += `=${byte.toString(16).toUpperCase().padStart(2, '0')}`;
    }
  }

  // Keep each physical QP line within the RFC 2045 76-character limit. Only
  // split between encoded tokens, never inside an =XX byte sequence.
  let output = '';
  let column = 0;
  for (let index = 0; index < encoded.length;) {
    if (encoded[index] === '\r' && encoded[index + 1] === '\n') {
      output += '\r\n';
      column = 0;
      index += 2;
      continue;
    }
    if (encoded[index] === '\n') {
      output += '\n';
      column = 0;
      index += 1;
      continue;
    }
    const token = encoded[index] === '=' ? encoded.slice(index, index + 3) : encoded[index];
    if (column + token.length > 75) {
      output += '=\r\n';
      column = 0;
    }
    output += token;
    column += token.length;
    index += token.length;
  }
  return output;
}

function foldFlowedLine(value, lineLength = 76) {
  let position = 0;
  let result = '';
  while (position < value.length) {
    let line = value.substr(position, lineLength);
    if (line.length < lineLength) {
      result += line;
      break;
    }
    let match = line.match(/^[^\n\r]*(\r?\n|\r)/);
    if (match) {
      line = match[0];
      result += line;
      position += line.length;
      continue;
    }
    match = line.match(/(\s+)[^\s]*$/);
    if (match && match[0].length - match[1].length < line.length) {
      line = line.substr(0, line.length - (match[0].length - match[1].length));
    } else {
      match = value.substr(position + line.length).match(/^[^\s]+(\s*)/);
      if (match) line += match[0];
    }
    result += line;
    position += line.length;
    if (position < value.length) result += '\r\n';
  }
  return result;
}

function encodeFlowed(value) {
  return String(value).split(/\r?\n/).map((line) => foldFlowedLine(
    line.replace(/^( |From|>)/igm, ' $1'), 76,
  )).join('\r\n');
}

function encodeMimePart(value, type) {
  const text = String(value);
  const plain = isPlainText(text);
  const flowed = plain && hasLongerLines(text);
  const quoted = !plain || (type === 'html' && flowed);
  const encoded = quoted
    ? quotedPrintableEncode(text)
    : (type === 'text' && flowed ? encodeFlowed(text) : normalizeCrlf(text));
  return {
    encoding: quoted ? 'quoted-printable' : '7bit',
    value: encoded,
    contentType: `${type === 'text' ? 'text/plain' : 'text/html'}${plain ? '' : '; charset=utf-8'}${type === 'text' && flowed ? '; format=flowed' : ''}`,
  };
}

function responseError(response, command) {
  const error = new Error(`SMTP ${command} failed (${response.code}): ${response.lines.join(' ')}`);
  error.code = `SMTP_${response.code}`;
  error.statusCode = response.code;
  return error;
}

function accepted(response, command, codes) {
  if (!codes.includes(response.code)) throw responseError(response, command);
  return response;
}

function accepted2xx(response, command) {
  if (response.code < 200 || response.code >= 300) throw responseError(response, command);
  return response;
}

/** A line-oriented SMTP response reader supporting multiline 220/250 replies. */
class SmtpReader {
  constructor(socket, timeoutMs) {
    this.socket = socket;
    this.timeoutMs = timeoutMs;
    this.buffer = '';
    this.responses = [];
    this.waiters = [];
    this.pendingCode = null;
    this.pendingLines = [];
    this.closed = null;
    this.timer = null;

    this.onData = (chunk) => this._consume(chunk);
    this.onError = (error) => this._fail(error);
    this.onClose = () => this._fail(new Error('SMTP connection closed'));
    socket.on('data', this.onData);
    socket.on('error', this.onError);
    socket.on('close', this.onClose);
    socket.setTimeout(timeoutMs, () => this._fail(new Error(`SMTP response timeout after ${timeoutMs}ms`)));
  }

  /** Detach the reader before wrapping its socket in a TLS stream. */
  dispose() {
    this.socket.removeListener('data', this.onData);
    this.socket.removeListener('error', this.onError);
    this.socket.removeListener('close', this.onClose);
    this.socket.setTimeout(0);
  }

  _consume(chunk) {
    this.buffer += chunk.toString('utf8');
    let end;
    while ((end = this.buffer.indexOf('\r\n')) >= 0) {
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 2);
      const match = line.match(/^(\d{3})([ -])(.*)$/);
      if (!match) continue;
      const code = Number(match[1]);
      const separator = match[2];
      if (this.pendingCode === null) {
        this.pendingCode = code;
        this.pendingLines = [match[3]];
      } else if (this.pendingCode === code) {
        this.pendingLines.push(match[3]);
      } else {
        // A malformed peer started a different response. Preserve the first
        // completed response and begin the new one rather than hanging.
        this._finishResponse({ code: this.pendingCode, lines: this.pendingLines });
        this.pendingCode = code;
        this.pendingLines = [match[3]];
      }
      if (separator === ' ') {
        this._finishResponse({ code: this.pendingCode, lines: this.pendingLines });
        this.pendingCode = null;
        this.pendingLines = [];
      }
    }
  }

  _finishResponse(response) {
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve(response);
    else this.responses.push(response);
  }

  _fail(error) {
    if (this.closed) return;
    this.closed = error instanceof Error ? error : new Error(String(error));
    for (const waiter of this.waiters.splice(0)) waiter.reject(this.closed);
  }

  wait() {
    if (this.responses.length) return Promise.resolve(this.responses.shift());
    if (this.closed) return Promise.reject(this.closed);
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  write(command) {
    try {
      this.socket.write(`${command}\r\n`);
    } catch (error) {
      this._fail(error);
      throw error;
    }
    return this.wait();
  }

  writeRaw(data) {
    try {
      this.socket.write(data);
    } catch (error) {
      this._fail(error);
      throw error;
    }
    return this.wait();
  }
}

function connectSocket(config) {
  return config.secure
    ? createTlsConnection({
      ...(config.tls && typeof config.tls === 'object' ? config.tls : {}),
      host: config.host,
      port: config.port,
      servername: config.servername || config.host,
      rejectUnauthorized: config.rejectUnauthorized,
    })
    : createTcpConnection({ host: config.host, port: config.port });
}

function closeSocket(socket) {
  try { socket.end(); } catch (_) { /* peer may already be closed */ }
  try { socket.destroy(); } catch (_) { /* cleanup is best effort */ }
}

function authCapabilities(response) {
  const supported = [];
  const lines = response?.lines || [];
  for (const mechanism of ['PLAIN', 'LOGIN', 'CRAM-MD5', 'XOAUTH2']) {
    const pattern = new RegExp(`^AUTH(?:\\s+|=).*\\b${escapeRegex(mechanism)}\\b`, 'i');
    if (lines.some((line) => pattern.test(String(line).trim()))) supported.push(mechanism);
  }
  return supported;
}

function chooseAuthMethod(response, config) {
  if (config.authMethod) return String(config.authMethod).toUpperCase().trim();
  // smtp-connection@1.2.0 records mechanisms in this fixed order after
  // parsing EHLO, then chooses the first one. XOAUTH2 is selected only when
  // its token provider is present.
  const supported = authCapabilities(response);
  if (config.auth.xoauth2 && supported.includes('XOAUTH2')) return 'XOAUTH2';
  return supported[0] || 'PLAIN';
}

function loginPrompt(response, expected, command) {
  if (response.code !== 334 || response.lines.join('\n') !== expected) {
    throw responseError(response, command);
  }
  return response;
}

async function authenticate(reader, config, ehloResponse) {
  if (!config.auth || !config.auth.user) return;
  const user = String(config.auth.user);
  const password = String(config.auth.pass === undefined ? '' : config.auth.pass);
  const method = chooseAuthMethod(ehloResponse, config);
  let response;
  if (method === 'PLAIN') {
    const plain = Buffer.from(`\u0000${user}\u0000${password}`).toString('base64');
    response = await reader.write(`AUTH PLAIN ${plain}`);
    // smtp-connection responds to a challenge with an empty continuation.
    while (response.code === 334) response = await reader.write('');
  } else if (method === 'LOGIN') {
    response = await reader.write('AUTH LOGIN');
    loginPrompt(response, 'VXNlcm5hbWU6', 'AUTH LOGIN user');
    response = await reader.write(Buffer.from(user).toString('base64'));
    loginPrompt(response, 'UGFzc3dvcmQ6', 'AUTH LOGIN password');
    response = await reader.write(Buffer.from(password).toString('base64'));
  } else if (method === 'CRAM-MD5') {
    response = await reader.write('AUTH CRAM-MD5');
    accepted(response, 'AUTH CRAM-MD5', [334]);
    const challenge = Buffer.from(response.lines.join(' ').trim(), 'base64');
    const digest = createHmac('md5', password).update(challenge).digest('hex');
    response = await reader.write(Buffer.from(`${user} ${digest}`).toString('base64'));
  } else if (method === 'XOAUTH2') {
    const token = config.auth.accessToken;
    if (!token) throw new Error('SMTP XOAUTH2 requires auth.accessToken');
    const value = Buffer.from(`user=${user}\u0001auth=Bearer ${token}\u0001\u0001`).toString('base64');
    response = await reader.write(`AUTH XOAUTH2 ${value}`);
    while (response.code === 334) response = await reader.write('');
  } else {
    throw new Error(`Unknown SMTP authentication method "${method}"`);
  }
  accepted(response, 'AUTH', [235]);
}

function ehloSupportsStartTls(response) {
  return (response?.lines || []).some((line) => /^STARTTLS(?:\s|$)/i.test(String(line).trim()));
}

async function sayHello(reader, config) {
  let response = await reader.write(`EHLO ${config.helo}`);
  if (response.code >= 400) {
    if (config.requireTLS) throw responseError(response, 'EHLO');
    response = await reader.write(`HELO ${config.helo}`);
  }
  return accepted(response, 'EHLO', [250]);
}

function upgradeToTls(socket, config) {
  return new Promise((resolve, reject) => {
    const options = {
      ...(config.tls && typeof config.tls === 'object' ? config.tls : {}),
      socket,
      servername: config.servername || config.host,
      rejectUnauthorized: config.rejectUnauthorized,
    };
    const secured = createTlsConnection(options);
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      secured.removeListener('secureConnect', onSecureConnect);
      secured.removeListener('error', onError);
      secured.removeListener('close', onClose);
      if (error) reject(error);
      else resolve(secured);
    };
    const onSecureConnect = () => finish();
    const onError = (error) => finish(error);
    const onClose = () => finish(new Error('SMTP TLS connection closed'));
    secured.once('secureConnect', onSecureConnect);
    secured.once('error', onError);
    secured.once('close', onClose);
  });
}

async function smtpSend(config, message) {
  let socket = connectSocket(config);
  let reader = new SmtpReader(socket, config.timeoutMs);
  const deadline = setTimeout(() => {
    const error = new Error(`SMTP operation timeout after ${config.timeoutMs}ms`);
    error.code = 'SMTP_TIMEOUT';
    reader._fail(error);
    closeSocket(socket);
  }, config.timeoutMs);
  deadline.unref?.();
  try {
    await accepted(await reader.wait(), 'greeting', [220]);
    let response = await sayHello(reader, config);
    // smtp-connection@1.2.0 upgrades whenever STARTTLS is advertised, and
    // also sends STARTTLS when requireTLS is set so the server can reject it
    // explicitly. The EHLO capability response is repeated after the TLS
    // handshake because authentication capabilities may change.
    if (!config.secure && !config.ignoreTLS && (ehloSupportsStartTls(response) || config.requireTLS)) {
      accepted2xx(await reader.write('STARTTLS'), 'STARTTLS');
      reader.dispose();
      socket = await upgradeToTls(socket, config);
      reader = new SmtpReader(socket, config.timeoutMs);
      response = await sayHello(reader, config);
    }
    await authenticate(reader, config, response);
    accepted(await reader.write(`MAIL FROM:<${envelopeAddress(message.from, 'from')}>`), 'MAIL FROM', [250]);
    accepted(await reader.write(`RCPT TO:<${envelopeAddress(message.to, 'to')}>`), 'RCPT TO', [250, 251]);
    accepted(await reader.write('DATA'), 'DATA', [354]);
    const body = `${dotStuff(message.data).replace(/\r\n$/, '')}\r\n.\r\n`;
    accepted(await reader.writeRaw(body), 'message body', [250]);
    try { await reader.write('QUIT'); } catch (_) { /* successful delivery does not depend on QUIT */ }
    return {
      accepted: [message.to],
      rejected: [],
      response: '250 Message accepted',
      envelope: { from: message.from, to: [message.to] },
    };
  } finally {
    clearTimeout(deadline);
    closeSocket(socket);
  }
}

/** Normalize either a Nodemailer-like object or an SMTP URL for local delivery. */
export function normalizeSmtpConfig(input) {
  if (typeof input === 'string') {
    const url = new URL(input);
    if (!['smtp:', 'smtps:'].includes(url.protocol)) {
      throw new TypeError('SMTP URL must use smtp: or smtps:');
    }
    const result = {
      host: url.hostname,
      port: numberOption(url.port, url.protocol === 'smtps:' ? 465 : 25),
      secure: url.protocol === 'smtps:',
      ignoreTLS: false,
      requireTLS: false,
      authMethod: undefined,
      tls: undefined,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      helo: 'localhost',
      servername: url.hostname,
      rejectUnauthorized: true,
    };
    if (url.username || url.password) {
      result.auth = {
        user: decodeURIComponent(url.username),
        pass: decodeURIComponent(url.password),
      };
    }
    return result;
  }
  if (!input || typeof input !== 'object') throw new TypeError('SMTP configuration is required');
  if (input.url !== undefined) {
    const base = normalizeSmtpConfig(input.url);
    const { url: _url, ...overrides } = input;
    const merged = { ...base, ...overrides };
    if (input.auth === undefined) merged.auth = base.auth;
    return normalizeSmtpConfig(merged);
  }
  const secure = boolOption(input.secure, false);
  const port = numberOption(input.port, secure ? 465 : 25);
  const auth = input.auth || (input.user !== undefined || input.password !== undefined
    ? { user: input.user, pass: input.password }
    : undefined);
  const host = String(input.host || input.hostname || '');
  if (!host) throw new TypeError('SMTP host is required');
  const tlsOptions = input.tls && typeof input.tls === 'object' ? { ...input.tls } : undefined;
  return {
    host,
    port,
    secure,
    auth,
    ignoreTLS: boolOption(input.ignoreTLS, false),
    requireTLS: boolOption(input.requireTLS, false),
    authMethod: input.authMethod,
    tls: tlsOptions,
    timeoutMs: numberOption(input.timeoutMs ?? input.connectionTimeout, DEFAULT_TIMEOUT_MS),
    helo: String(input.helo || 'localhost'),
    servername: input.servername || tlsOptions?.servername,
    rejectUnauthorized: input.rejectUnauthorized === undefined
      ? (tlsOptions?.rejectUnauthorized === undefined ? true : boolOption(tlsOptions.rejectUnauthorized, true))
      : boolOption(input.rejectUnauthorized, true),
  };
}

/** Read local-deployment SMTP settings without exposing credentials in logs. */
export function smtpConfigFromEnv(env = process.env) {
  const url = env.ETCO_account_mailSmtpUrl || env.ETCO_account_mailSmtp;
  if (url) return normalizeSmtpConfig(url);
  const configured = ['ETCO_account_mailSmtpHost', 'ETCO_account_mailSmtpPort',
    'ETCO_account_mailSmtpSecure', 'ETCO_account_mailSmtpUser',
    'ETCO_account_mailSmtpPassword', 'ETCO_account_mailSmtpIgnoreTLS',
    'ETCO_account_mailSmtpRequireTLS', 'ETCO_account_mailSmtpAuthMethod']
    .some((key) => own(env, key) && env[key] !== '');
  if (!configured) return null;
  if (!env.ETCO_account_mailSmtpHost) {
    throw new Error('ETCO_account_mailSmtpHost is required when SMTP environment is configured');
  }
  return normalizeSmtpConfig({
    host: env.ETCO_account_mailSmtpHost,
    port: env.ETCO_account_mailSmtpPort,
    secure: env.ETCO_account_mailSmtpSecure,
    user: env.ETCO_account_mailSmtpUser,
    password: env.ETCO_account_mailSmtpPassword,
    ignoreTLS: env.ETCO_account_mailSmtpIgnoreTLS,
    requireTLS: env.ETCO_account_mailSmtpRequireTLS,
    authMethod: env.ETCO_account_mailSmtpAuthMethod,
    timeoutMs: env.ETCO_account_mailSmtpTimeoutMs,
    servername: env.ETCO_account_mailSmtpServername,
    rejectUnauthorized: env.ETCO_account_mailSmtpRejectUnauthorized,
  });
}

function templatePath(templateDir, template, extension) {
  return join(templateDir, `${template}.${extension}`);
}

function readTemplate(templateDir, template, extension) {
  return readFileSync(templatePath(templateDir, template, extension), { encoding: 'utf8' });
}

function multipartMessage({ from, to, subject, text, html }) {
  const boundary = `=_phoenix_invitation_${randomBytes(12).toString('hex')}`;
  const messageId = `<${randomBytes(12).toString('hex')}@phoenix.local>`;
  const textPart = encodeMimePart(text, 'text');
  const htmlPart = encodeMimePart(html, 'html');
  const headers = [
    `From: ${rejectHeaderInjection(from, 'from')}`,
    `To: ${rejectHeaderInjection(to, 'to')}`,
    `Subject: ${rejectHeaderInjection(subject, 'subject')}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: ${messageId}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];
  return [
    ...headers,
    '',
    `--${boundary}`,
    `Content-Type: ${textPart.contentType}`,
    `Content-Transfer-Encoding: ${textPart.encoding}`,
    '',
    textPart.value,
    `--${boundary}`,
    `Content-Type: ${htmlPart.contentType}`,
    `Content-Transfer-Encoding: ${htmlPart.encoding}`,
    '',
    htmlPart.value,
    `--${boundary}--`,
    '',
  ].join('\r\n');
}

/** A source-shaped MailController backed by a configured local SMTP relay. */
export class SmtpMailProvider {
  constructor({ template, smtp, fromAddress = DEFAULT_FROM, templateDir = DEFAULT_TEMPLATE_DIR } = {}) {
    this.template = template;
    this.smtp = normalizeSmtpConfig(smtp);
    this.fromAddress = fromAddress || DEFAULT_FROM;
    this.templateDir = templateDir;
    // Match source startup behavior: templates are read when the controller is
    // constructed, so a bad deployment path fails explicitly before requests.
    this.templateHtmlContent = readTemplate(templateDir, template, 'html');
    this.templateTextContent = readTemplate(templateDir, template, 'txt');
  }

  async send(to, options = {}) {
    if (!this.template) throw new Error('Template not set');
    if (!MAIL_SUBJECTS[this.template]) {
      throw new Error('Subject not specified for the template');
    }
    const recipient = envelopeAddress(to, 'to');
    const html = renderHtml(this.templateHtmlContent, options);
    const data = multipartMessage({
      from: this.fromAddress,
      to: recipient,
      subject: MAIL_SUBJECTS[this.template],
      text: this.templateTextContent,
      html,
    });
    return smtpSend(this.smtp, {
      from: this.fromAddress,
      to: recipient,
      data,
    });
  }
}

export function createSmtpMailProviders({ smtp, fromAddress, templateDir } = {}) {
  const config = normalizeSmtpConfig(smtp);
  return {
    invitation: new SmtpMailProvider({ template: 'invitation', smtp: config, fromAddress, templateDir }),
    invitationExistingUser: new SmtpMailProvider({ template: 'invitationExistingUser', smtp: config, fromAddress, templateDir }),
    activation: new SmtpMailProvider({ template: 'activation', smtp: config, fromAddress, templateDir }),
    passwordReset: new SmtpMailProvider({ template: 'passwordReset', smtp: config, fromAddress, templateDir }),
  };
}
