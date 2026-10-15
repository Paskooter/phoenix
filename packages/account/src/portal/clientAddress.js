// The client address behind the public edge.
//
// The account service listens on loopback and nginx fronts it (deploy/nginx/phoenix.conf), which
// overwrites X-Forwarded-For and X-Real-IP with the direct client address; a CDN placed before
// nginx is configured there as a trusted real-IP source (docs/DEPLOYMENT.md), so those headers
// carry the original visitor. Forwarding headers are used only when the immediate peer is a
// configured trusted proxy; other peers use their socket address.
//
// Resolution for a request whose peer is trusted:
//   1. CF-Connecting-IP, only when the deployment opts in (PHOENIX_TRUST_CF_CONNECTING_IP) —
//      Cloudflare sets it to the original visitor and it is not a client-controlled chain.
//   2. the right-most untrusted entry of X-Forwarded-For: entries to its right were appended by
//      trusted hops, so the first entry that is not itself a trusted proxy is the client.
//   3. X-Real-IP, when it is an address (the shipped nginx config sets it to $remote_addr).
//   4. the peer itself.
//
// PHOENIX_TRUSTED_PROXIES is a comma-separated address list (loopback by default).

import { isIP } from 'node:net';

const LOOPBACK_PROXIES = ['127.0.0.1', '::1'];
const CF_OPT_IN = new Set(['1', 'true']);

/** IPv4-mapped IPv6 (`::ffff:127.0.0.1`) and bracketed forms are the same address. */
export function normalizeClientAddress(value) {
  let address = String(value ?? '').trim();
  if (address.startsWith('[') && address.endsWith(']')) address = address.slice(1, -1);
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  if (mapped) address = mapped[1];
  return address;
}

/** Addresses allowed to supply forwarding headers; loopback unless configured otherwise. */
export function trustedProxyAddresses(env = process.env) {
  const configured = String(env.PHOENIX_TRUSTED_PROXIES || '')
    .split(',')
    .map((entry) => normalizeClientAddress(entry))
    .filter(Boolean);
  return configured.length > 0 ? configured : [...LOOPBACK_PROXIES];
}

function trustsCloudflareHeader(env = process.env) {
  return CF_OPT_IN.has(String(env.PHOENIX_TRUST_CF_CONNECTING_IP || '').trim().toLowerCase());
}

const isTrustedProxy = (address, trusted) => trusted.includes(normalizeClientAddress(address));

/** The address a throttle or audit key should use for this request. */
export function clientAddress(req, env = process.env) {
  const peer = normalizeClientAddress(req?.socket?.remoteAddress || req?.connection?.remoteAddress);
  if (!peer) return 'unknown';
  const trusted = trustedProxyAddresses(env);
  if (!isTrustedProxy(peer, trusted)) return peer;
  const headers = req?.headers || {};
  if (trustsCloudflareHeader(env)) {
    const connecting = normalizeClientAddress(headers['cf-connecting-ip']);
    if (isIP(connecting) && !isTrustedProxy(connecting, trusted)) return connecting;
  }
  const chain = String(headers['x-forwarded-for'] || '').split(',');
  for (let i = chain.length - 1; i >= 0; i--) {
    const candidate = normalizeClientAddress(chain[i]);
    if (!isIP(candidate) || isTrustedProxy(candidate, trusted)) continue;
    return candidate;
  }
  const realIp = normalizeClientAddress(headers['x-real-ip']);
  if (isIP(realIp) && !isTrustedProxy(realIp, trusted)) return realIp;
  return peer;
}
