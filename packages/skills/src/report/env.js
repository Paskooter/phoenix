// Report-skill environment contract from Pegasus 5c0a739:
//   NET_lasso       -> lasso:8080
//   NET_settings    -> settings.jibo.aws
//   prefsFromConfig -> false
//
// The original readEnvVars helper uses process.env[name] || default and keeps
// all values as strings. Phoenix's legacy names are deployment aliases only;
// an explicitly supplied source name wins, including its empty-value fallback.

const DEFAULTS = Object.freeze({
  NET_lasso: 'lasso:8080',
  NET_settings: 'settings.jibo.aws',
  prefsFromConfig: 'false',
});

const hasOwn = (name) => Object.prototype.hasOwnProperty.call(process.env, name);

// Pegasus EnvVars keeps the resolved object for the lifetime of the process.
// It is deliberately mutable: callers receive the same object until the
// source clearCache() operation is invoked. Phoenix aliases are resolved while
// creating this object, so changing process.env later has no effect until the
// explicit reset either.
let cachedReportEnv;
let cachedLassoIsLegacyAlias = false;

function readSourceVar(name, alias) {
  if (process.env[name]) return process.env[name];
  // Match readEnvVars: an explicitly empty source variable resolves to its
  // source default rather than allowing a Phoenix alias to take precedence.
  if (hasOwn(name)) return DEFAULTS[name];
  if (alias && process.env[alias]) return process.env[alias];
  return DEFAULTS[name];
}

/** Return the report process configuration as source-shaped strings. */
export function getReportEnv() {
  if (!cachedReportEnv) {
    const sourceLassoIsPresent = Boolean(process.env.NET_lasso) || hasOwn('NET_lasso');
    cachedLassoIsLegacyAlias = !sourceLassoIsPresent && Boolean(process.env.NET_data);
    cachedReportEnv = {
      NET_lasso: readSourceVar('NET_lasso', 'NET_data'),
      NET_settings: readSourceVar('NET_settings'),
      prefsFromConfig: readSourceVar('prefsFromConfig', 'ETCO_report_prefsFromConfig'),
    };
  }
  return cachedReportEnv;
}

/** Clear the report configuration cache, matching the source EnvVars API. */
export function clearReportEnvCache() {
  cachedReportEnv = undefined;
  cachedLassoIsLegacyAlias = false;
}

// Keep the source operation name available to report-owned callers as well as
// the descriptive Phoenix name used by tests and launchers.
export const clearCache = clearReportEnvCache;

/** Build the HTTP URL used by the source clients (`http://${value}`). */
export function reportPeerURL(value) {
  return `http://${value}`;
}

/**
 * Resolve the lasso peer while preserving the old Phoenix alias's full-URL
 * convenience. A configured NET_lasso always follows the source concatenation
 * above; NET_data is only consulted when that source name is absent.
 */
export function reportLassoURL() {
  const value = getReportEnv().NET_lasso;
  if (cachedLassoIsLegacyAlias && /^https?:\/\//.test(value)) return value;
  return reportPeerURL(value);
}

export { DEFAULTS as REPORT_ENV_DEFAULTS };
