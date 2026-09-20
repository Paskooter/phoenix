/** Errors raised when an object URL cannot be built from a configured public origin. */
export class PublicOriginError extends Error {
  constructor(message, code = 'PUBLIC_ORIGIN_REQUIRED') {
    super(message);
    this.name = code;
    this.code = code;
    this.statusCode = 500;
  }
}

/**
 * Validate and canonicalize a public HTTP(S) origin. Paths, query strings, fragments, and userinfo
 * are rejected so a bearer URL cannot be redirected through an accidental or attacker-controlled
 * URL base.
 */
export function canonicalPublicOrigin(value, { name = 'publicUrl' } = {}) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new PublicOriginError(`${name} is required`);
  }
  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch (error) {
    throw new PublicOriginError(`Invalid ${name}: ${error.message}`, 'PUBLIC_ORIGIN_INVALID');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new PublicOriginError(`Invalid ${name} protocol: ${parsed.protocol}`, 'PUBLIC_ORIGIN_INVALID');
  }
  if (!parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') {
    throw new PublicOriginError(`Invalid ${name}: expected an origin without path, query, or fragment`, 'PUBLIC_ORIGIN_INVALID');
  }
  return parsed.origin;
}

/** Return the first explicitly configured public origin, or null when none was supplied. */
export function configuredPublicOrigin({ publicUrl, publicOrigin, env = process.env } = {}) {
  const explicit = [
    publicOrigin,
    publicUrl,
    env?.ETCO_classic_publicUrl,
    env?.CLASSIC_PUBLIC_URL,
  ].find((value) => typeof value === 'string' && value.trim() !== '');
  return explicit === undefined ? null : canonicalPublicOrigin(explicit);
}

/** Require an already resolved origin at the point an object URL is emitted. */
export function requirePublicOrigin(value, name = 'publicUrl') {
  if (typeof value !== 'string' || value === '') throw new PublicOriginError(`${name} is required`);
  return canonicalPublicOrigin(value, { name });
}
