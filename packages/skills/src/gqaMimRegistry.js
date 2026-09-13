// Source-backed API-AI intent/entity pattern and MIM registry boundary.
//
// Source: jiborobot/srv-gqa-ws@ebe1a7d38f511570060c1fbf61bec89d58419b26,
// gqa/mim_registry.py.  Registry and payload data are constructor inputs so
// Phoenix can use a pinned fixture (or an explicitly configured deployment)
// without reading the archived filesystem or contacting a vendor.

export const GQA_MIM_REGISTRY_SOURCE_REVISION = 'ebe1a7d38f511570060c1fbf61bec89d58419b26';
export const GQA_MIM_REGISTRY_SOURCE_MODULE = 'gqa/mim_registry.py';

function noOpLogger() {}

function log(logger, method, ...args) {
  if (logger && typeof logger[method] === 'function') {
    try {
      logger[method](...args);
    } catch (_loggerError) {
      // Source logging is observational; preserve the lookup result.
    }
  }
}

function sourceTruthy(value) {
  // Python truthiness differs from JavaScript for empty arrays/objects.
  if (value === null || value === undefined || value === false || value === 0 || value === '') return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

function sourceMapping(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be a mapping`);
  }
  return value;
}

function sourceList(value, label) {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be a list`);
  return value;
}

function sourceString(value) {
  if (value === null) return 'None';
  if (value === undefined) return 'None';
  if (value === true) return 'True';
  if (value === false) return 'False';
  return String(value);
}

function isSourceDict(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sourceMissingPayloadError(mimId) {
  // Python's MIM_ID_TO_PAYLOAD[mim_id] raises KeyError when the registry has
  // a known id but the injected payload table does not contain it.
  const error = new Error(String(mimId));
  error.name = 'KeyError';
  return error;
}

/** Build the exact semicolon key used by load_lookup_table(). */
function buildLookupPattern(intentPattern, label) {
  const pattern = sourceMapping(intentPattern, label);
  const names = sourceList(pattern.entity_name, `${label}.entity_name`);
  const values = sourceList(pattern.entity_val, `${label}.entity_val`);
  // The source indexes both lists and raises when their lengths differ.
  if (names.length !== values.length) {
    throw new Error('Different length for entity type and entity value, shouldn\'t happen');
  }

  const combined = names.map((name, index) => `${name}:${values[index]}`);
  combined.sort();
  return `${pattern.intent};${combined.join(';')}`;
}

function readIntentPattern(apiAiOutput, logger) {
  // Python treats an empty dict as false, unlike JavaScript.
  if (!sourceTruthy(apiAiOutput)) {
    log(logger, 'error', 'No api_ai output');
    return null;
  }
  const output = sourceMapping(apiAiOutput, 'api_ai output');
  const status = sourceMapping(output.status, 'api_ai output.status');
  if (status.code !== 200) {
    log(logger, 'error', 'Non-200 HTTP status code from api.ai');
    return null;
  }

  const result = sourceMapping(output.result, 'api_ai output.result');
  const metadata = sourceMapping(result.metadata, 'api_ai output.result.metadata');
  const parameters = sourceMapping(result.parameters, 'api_ai output.result.parameters');
  let intent = '';
  const entities = [];
  if (Object.prototype.hasOwnProperty.call(metadata, 'intentName')) {
    intent = metadata.intentName;
    for (const [key, value] of Object.entries(parameters)) {
      if (sourceTruthy(value) && typeof value === 'string') {
        entities.push(`${key}:${value}`);
      } else if (sourceTruthy(value) && isSourceDict(value) && key === 'age') {
        // gqa/mim_registry.py intentionally formats Dialogflow's age object
        // as amount followed immediately by unit. Only amount is passed to
        // str(); Python string concatenation raises for a non-string unit.
        if (typeof value.unit !== 'string') {
          throw new TypeError('age entity unit must be a string');
        }
        entities.push(`${key}:${sourceString(value.amount)}${value.unit}`);
      }
    }
  }
  entities.sort();
  return `${intent};${entities.join(';')}`;
}

/**
 * Create an injected MIM registry.
 *
 * `lookup` has the archived mimid_lookup.json shape, while `payloads` maps
 * each referenced MIM id to its parsed JSON payload. Unknown non-empty
 * patterns return `undefined`, matching the source's defaultdict miss. A
 * known pattern whose MIM id is absent from payloads raises a source-shaped
 * `KeyError` when the source indexes MIM_ID_TO_PAYLOAD. An empty string
 * returns `null`; other falsey values reach the source warning concatenation
 * and raise a TypeError because Python cannot concatenate them to a string.
 */
export function createGqaMimRegistry({ lookup, payloads, logger = { error: noOpLogger, warning: noOpLogger } } = {}) {
  if (lookup === undefined) throw new TypeError('MIM lookup data must be injected');
  if (payloads === undefined) throw new TypeError('MIM payload data must be injected');
  const lookupTable = sourceMapping(lookup, 'MIM lookup');
  const payloadTable = sourceMapping(payloads, 'MIM payloads');
  const mimRegistry = new Map();

  for (const [mimId, intentPattern] of Object.entries(lookupTable)) {
    const intentPatternString = buildLookupPattern(intentPattern, `MIM lookup '${mimId}'`);
    if (mimRegistry.has(intentPatternString)) {
      log(logger, 'error', 'Different MIMs sharing same intent pattern!');
      log(logger, 'error', `intent_pattern_string:${intentPatternString}`);
      throw new Error('Different MIMs sharing same intent pattern!');
    }
    mimRegistry.set(intentPatternString, mimId);
  }

  return Object.freeze({
    getIntentPattern(apiAiOutput) {
      return readIntentPattern(apiAiOutput, logger);
    },

    getMimPayload(intentPatternString) {
      if (!sourceTruthy(intentPatternString)) {
        // The archived warning uses "prefix" + intent_pattern_string before
        // returning. Empty strings work; None/false/0/list values raise the
        // Python concatenation TypeError and must stay observable here.
        if (typeof intentPatternString !== 'string') {
          throw new TypeError('can only concatenate str (not a non-string value) to str');
        }
        log(logger, 'warning', `intent_pattern_string:${intentPatternString}`);
        log(logger, 'warning', 'Input to the get_mim_payload shouldn\'t have empty value');
        return null;
      }
      const mimId = mimRegistry.get(intentPatternString);
      if (!mimId) return undefined;
      if (!Object.prototype.hasOwnProperty.call(payloadTable, mimId)) {
        throw sourceMissingPayloadError(mimId);
      }
      return payloadTable[mimId];
    },
  });
}

export { buildLookupPattern };
