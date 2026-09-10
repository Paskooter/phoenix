// Environment / service discovery.
//
// Mirrors the reference conventions (docs/atlas/runtime-topology.md, HubConfigProvider.ts:39-56):
//   NET_<svc>          host:port of a peer service; `http://` is prefixed if absent
//   ETCO_<scope>_<key> configuration value
//
// The reference helper is `readEnvVars(defaults)` in packages/utils/src/config/EnvVars.ts:11-19:
// it walks the defaults object, throws when a value whose default is `null` is unset, and
// otherwise resolves `process.env[key] || defaults[key]` - so an empty string takes the
// default too, and every result stays a string. `net`/`etco`/`boolEnv` below are Phoenix
// conveniences with their own reachable semantics; the reference contract is `readEnvVars`.

/**
 * Reference `readEnvVars` (packages/utils/src/config/EnvVars.ts:11-19).
 *
 * Walks `defaults` in key order and resolves each `process.env[key] || defaults[key]`.
 * A `null` default makes the variable required: if it is unset (or empty) this throws
 * `Required env variable '<key>' does not exist`, matching the source message exactly.
 *
 * @param {Record<string, string|null>} defaults
 * @param {NodeJS.ProcessEnv} [env] defaults to process.env; an explicit env is a Phoenix
 *   test/deployment extension and does not change reference behaviour.
 * @returns {Record<string, string>}
 */
export function readEnvVars(defaults, env = process.env) {
  return Object.keys(defaults).reduce((acc, key) => {
    if (!env[key] && defaults[key] === null) {
      throw new Error(`Required env variable '${key}' does not exist`);
    }
    acc[key] = env[key] || defaults[key];
    return acc;
  }, {});
}

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
