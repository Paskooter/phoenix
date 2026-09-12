// Provider URLs can be returned to the skill response and persisted as attribution.
// Keep credentials out of both surfaces even when an upstream response contains a
// URL copied from an authenticated API request.

const CREDENTIAL_WORDS = new Set([
  'appid', 'auth', 'authorization', 'bearer', 'credential', 'credentials', 'key',
  'password', 'passwd', 'secret', 'sig', 'signature', 'token',
]);
const COMPACT_CREDENTIAL_NAMES = [
  'accesskey', 'accesstoken', 'apikey', 'authkey', 'authtoken', 'clientkey',
  'clientsecret', 'ocpapimsubscriptionkey', 'privatekey', 'refreshtoken',
  'secretkey', 'subscriptionkey',
];

function isSensitiveParameter(name) {
  const words = String(name).replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase()
    .split(/[^a-z0-9]+/).filter(Boolean);
  if (words.some((word) => CREDENTIAL_WORDS.has(word))) return true;
  const compact = words.join('');
  return COMPACT_CREDENTIAL_NAMES.some((term) => compact.includes(term));
}

export function redactProviderUrl(value) {
  if (value === null || value === undefined || typeof value !== 'string') return value;
  let url;
  try {
    url = new URL(value);
  } catch {
    // A malformed provider URL is not safe to return: there is no reliable way
    // to identify a credential embedded in it.
    return undefined;
  }

  for (const key of [...url.searchParams.keys()]) {
    if (isSensitiveParameter(key)) url.searchParams.delete(key);
  }
  // Userinfo and fragments are not needed for attribution and can carry
  // credentials when an upstream URL is copied verbatim.
  url.username = '';
  url.password = '';
  url.hash = '';
  return url.toString();
}

export function redactProviderText(value, secrets = []) {
  if (typeof value !== 'string') return value;
  let redacted = value;
  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret === '') continue;
    redacted = redacted.split(secret).join('[REDACTED]');
    const encoded = encodeURIComponent(secret);
    if (encoded !== secret) redacted = redacted.split(encoded).join('[REDACTED]');
  }
  return redacted.replace(/https?:\/\/[^\s"'<>]+/gu, (url) => redactProviderUrl(url) ?? '[REDACTED_URL]');
}

export function redactProviderUrls(record) {
  if (!record || typeof record !== 'object') return record;
  const sanitized = { ...record };
  for (const field of ['url', 'image_url']) {
    if (Object.prototype.hasOwnProperty.call(sanitized, field)) {
      const value = redactProviderUrl(sanitized[field]);
      if (value === undefined) delete sanitized[field];
      else sanitized[field] = value;
    }
  }
  return sanitized;
}
