#!/usr/bin/env node
// Ensure a CA and a serving certificate exist for robot-facing TLS.
//
// The server owns these. It creates them on first start and reuses them
// afterwards, so an operator never has to run openssl by hand and the repoint
// script can simply read what the server already made.
//
// The names matter more than usual here: a robot's native client builds its own
// hostnames as <region>.jibo.com and <region>-socket.jibo.com and verifies them
// against the certificate, so those names must be present or the robot rejects
// the server no matter what it trusts. The region list is configuration because
// the server cannot ask the robot at startup; the repoint script checks the
// robot's real region against this certificate and says so if it is missing.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, networkInterfaces } from 'node:os';

export function defaultTlsHome() {
  if (process.env.PHOENIX_TLS_HOME) return process.env.PHOENIX_TLS_HOME;
  const base = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
  return join(base, 'phoenix', 'tls');
}

export function regionsFrom(env = process.env) {
  const raw = env.PHOENIX_TLS_REGIONS || 'api';
  return [...new Set(raw.split(',').map(value => value.trim()).filter(Boolean))];
}

function localAddresses() {
  const found = new Set(['127.0.0.1']);
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal) found.add(entry.address);
    }
  }
  return [...found];
}

export function requiredNames(env = process.env) {
  const dns = ['localhost'];
  for (const region of regionsFrom(env)) {
    dns.push(`${region}.jibo.com`, `${region}-socket.jibo.com`);
  }
  for (const extra of (env.PHOENIX_TLS_EXTRA_NAMES || '').split(',')) {
    const name = extra.trim();
    if (name) dns.push(name);
  }
  return { dns: [...new Set(dns)], ip: localAddresses() };
}

function san({ dns, ip }) {
  return [...dns.map(name => `DNS:${name}`), ...ip.map(address => `IP:${address}`)].join(',');
}

function openssl(args, options = {}) {
  return execFileSync('openssl', args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
}

function certCovers(certPath, { dns }) {
  try {
    const text = openssl(['x509', '-in', certPath, '-noout', '-ext', 'subjectAltName']).toString();
    return dns.every(name => new RegExp(`DNS:${name.replace(/\./g, '\\.')}(,|\\s|$)`).test(text));
  } catch { return false; }
}

function expiringSoon(certPath, seconds = 7 * 24 * 3600) {
  try { openssl(['x509', '-in', certPath, '-noout', '-checkend', String(seconds)]); return false; }
  catch { return true; }
}

/**
 * Create the CA and serving certificate if they are missing, or reissue the
 * serving certificate when it no longer covers every required name. Returns the
 * paths plus whether anything changed. Safe to call on every start.
 */
export function ensureTlsCertificates({ dir = defaultTlsHome(), env = process.env, log = () => {} } = {}) {
  const paths = {
    dir,
    caCert: join(dir, 'ca.crt'),
    caKey: join(dir, 'ca.key'),
    cert: join(dir, 'server.crt'),
    key: join(dir, 'server.key'),
  };
  const names = requiredNames(env);

  try { openssl(['version']); }
  catch {
    throw new Error('openssl is required to generate robot TLS certificates. '
      + 'Install it, or set PHOENIX_ROBOT_TLS_CERT and PHOENIX_ROBOT_TLS_KEY to your own files.');
  }

  mkdirSync(dir, { recursive: true, mode: 0o700 });

  let created = false;
  if (!existsSync(paths.caCert) || !existsSync(paths.caKey)) {
    log(`creating a CA at ${paths.caCert}`);
    openssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '3650',
      '-keyout', paths.caKey, '-out', paths.caCert, '-subj', '/CN=Phoenix development CA']);
    chmodSync(paths.caKey, 0o600); chmodSync(paths.caCert, 0o600);
    created = true;
  }

  const needsCert = !existsSync(paths.cert) || !existsSync(paths.key)
    || !certCovers(paths.cert, names) || expiringSoon(paths.cert);

  if (needsCert) {
    log(`issuing a serving certificate for ${san(names)}`);
    if (!existsSync(paths.key)) {
      openssl(['genrsa', '-out', paths.key, '2048']);
      chmodSync(paths.key, 0o600);
    }
    const csr = join(dir, 'server.csr');
    const ext = join(dir, 'server.ext');
    openssl(['req', '-new', '-key', paths.key, '-out', csr, '-subj', '/CN=localhost']);
    writeFileSync(ext, `subjectAltName=${san(names)}\nbasicConstraints=CA:FALSE\n`
      + 'keyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n');
    openssl(['x509', '-req', '-in', csr, '-CA', paths.caCert, '-CAkey', paths.caKey,
      '-CAcreateserial', '-days', '825', '-sha256', '-extfile', ext, '-out', paths.cert]);
    chmodSync(paths.cert, 0o600);
    created = true;
  }

  writeFileSync(join(dir, 'receipt.json'), `${JSON.stringify({
    updatedAt: new Date().toISOString(),
    regions: regionsFrom(env),
    dns: names.dns,
    ip: names.ip,
    caSha256: openssl(['x509', '-in', paths.caCert, '-noout', '-fingerprint', '-sha256'])
      .toString().trim().split('=')[1],
  }, null, 2)}\n`);

  return { ...paths, created, names };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = ensureTlsCertificates({ log: message => process.stderr.write(`[tls] ${message}\n`) });
  process.stdout.write(`${JSON.stringify({
    dir: result.dir, cert: result.cert, key: result.key, caCert: result.caCert,
    created: result.created, names: result.names,
  }, null, 2)}\n`);
}
