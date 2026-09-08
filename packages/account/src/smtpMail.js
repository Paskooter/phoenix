// Local SMTP counterpart of srv-account-ws MailController.
//
// The original uses Nodemailer for either config.mail.smtp or AWS SES. Phoenix
// deliberately does not carry AWS credentials; this small SMTP client keeps
// the source template/subject/sendMail boundary available for a configured
// local SMTP relay without adding a second mail dependency to the service.

import { createConnection as createTcpConnection } from 'node:net';
import { connect as createTlsConnection } from 'node:tls';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

export const INVITATION_SUBJECT = 'Invitation';

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

    socket.on('data', (chunk) => this._consume(chunk));
    socket.on('error', (error) => this._fail(error));
    socket.on('close', () => this._fail(new Error('SMTP connection closed')));
    socket.setTimeout(timeoutMs, () => this._fail(new Error(`SMTP response timeout after ${timeoutMs}ms`)));
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

async function authenticate(reader, config) {
  if (!config.auth || !config.auth.user) return;
  const user = String(config.auth.user);
  const password = String(config.auth.pass === undefined ? '' : config.auth.pass);
  const plain = Buffer.from(`\u0000${user}\u0000${password}`).toString('base64');
  let response = await reader.write(`AUTH PLAIN ${plain}`);
  if (response.code === 502 || response.code === 504 || response.code === 534) {
    response = await reader.write('AUTH LOGIN');
    accepted(response, 'AUTH LOGIN', [334]);
    response = await reader.write(Buffer.from(user).toString('base64'));
    accepted(response, 'AUTH LOGIN user', [334]);
    response = await reader.write(Buffer.from(password).toString('base64'));
  }
  accepted(response, 'AUTH', [235]);
}

async function smtpSend(config, message) {
  const socket = connectSocket(config);
  const reader = new SmtpReader(socket, config.timeoutMs);
  const deadline = setTimeout(() => {
    const error = new Error(`SMTP operation timeout after ${config.timeoutMs}ms`);
    error.code = 'SMTP_TIMEOUT';
    reader._fail(error);
    closeSocket(socket);
  }, config.timeoutMs);
  deadline.unref?.();
  try {
    await accepted(await reader.wait(), 'greeting', [220]);
    let response = await reader.write(`EHLO ${config.helo}`);
    if (response.code >= 400) response = await reader.write(`HELO ${config.helo}`);
    accepted(response, 'EHLO', [250]);
    await authenticate(reader, config);
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
      timeoutMs: DEFAULT_TIMEOUT_MS,
      helo: 'localhost',
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
  return {
    host,
    port,
    secure,
    auth,
    timeoutMs: numberOption(input.timeoutMs ?? input.connectionTimeout, DEFAULT_TIMEOUT_MS),
    helo: String(input.helo || 'localhost'),
    servername: input.servername,
    rejectUnauthorized: input.rejectUnauthorized === undefined ? true : boolOption(input.rejectUnauthorized, true),
  };
}

/** Read local-deployment SMTP settings without exposing credentials in logs. */
export function smtpConfigFromEnv(env = process.env) {
  const url = env.ETCO_account_mailSmtpUrl || env.ETCO_account_mailSmtp;
  if (url) return normalizeSmtpConfig(url);
  const configured = ['ETCO_account_mailSmtpHost', 'ETCO_account_mailSmtpPort',
    'ETCO_account_mailSmtpSecure', 'ETCO_account_mailSmtpUser',
    'ETCO_account_mailSmtpPassword'].some((key) => own(env, key) && env[key] !== '');
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
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    text,
    `--${boundary}`,
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    html,
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
    if (this.template !== 'invitation' && this.template !== 'invitationExistingUser') {
      throw new Error('Subject not specified for the template');
    }
    const recipient = envelopeAddress(to, 'to');
    const html = renderHtml(this.templateHtmlContent, options);
    const data = multipartMessage({
      from: this.fromAddress,
      to: recipient,
      subject: INVITATION_SUBJECT,
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
  };
}
