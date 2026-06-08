// Environment / service discovery.
//
// Mirrors the reference conventions (docs/atlas/runtime-topology.md, HubConfigProvider.ts:39-56):
//   NET_<svc>          host:port of a peer service; `http://` is prefixed if absent
//   ETCO_<scope>_<key> configuration value
//
// Critical semantic preserved from the reference: a missing value with NO default is a
// configuration error and throws at startup ("null-default = required-throws"). This is what
// makes substitution testing safe — a misconfigured peer fails loudly instead of silently
// pointing at nothing.

/**
 * Resolve a peer service base URL from NET_<name>.
 * @param {string} name e.g. 'parser' -> NET_parser
 * @param {{ required?: boolean, default?: string }} [opts]
 * @returns {string|null} base URL (http:// prefixed) or null when optional and unset
 */
export function net(name, opts = {}) {
  const raw = process.env[`NET_${name}`];
  if (raw == null || raw === '') {
    if (opts.default !== undefined) return normalizeUrl(opts.default);
    if (opts.required === false) return null;
    throw new Error(`NET_${name} is required (service discovery for "${name}")`);
  }
  return normalizeUrl(raw);
}

/**
 * Read a config value from ETCO_<scope>_<key>. Throws if unset and no default given.
 * @param {string} scope e.g. 'hub', 'server', 'parser'
 * @param {string} key
 * @param {string} [def] default; omit to make the value required
 * @returns {string}
 */
export function etco(scope, key, def) {
  const raw = process.env[`ETCO_${scope}_${key}`];
  if (raw == null || raw === '') {
    if (def === undefined) throw new Error(`ETCO_${scope}_${key} is required`);
    return def;
  }
  return raw;
}

/** Boolean coercion for ETCO flags ('true' / 'false'). */
export function boolEnv(value, def = false) {
  if (value == null || value === '') return def;
  return String(value).toLowerCase() === 'true';
}

function normalizeUrl(v) {
  return /^https?:\/\//.test(v) ? v : `http://${v}`;
}
