// Source-backed API-AI client boundary for the archived GQA profile.
//
// Source: jiborobot/srv-gqa-ws@ebe1a7d38f511570060c1fbf61bec89d58419b26,
// gqa/api_ai.py.  The source calls requests.get with query/lang/sessionId
// parameters and returns an empty object for any request or JSON exception.
// Phoenix keeps the request function injectable so this boundary never makes
// a live vendor call by default.

export const GQA_API_AI_SOURCE_REVISION = 'ebe1a7d38f511570060c1fbf61bec89d58419b26';
export const GQA_API_AI_SOURCE_MODULE = 'gqa/api_ai.py';
export const GQA_API_AI_ENDPOINT = 'https://api.api.ai/v1/query?v=20150910';

function noOpLogger() {}

function logError(logger, message, error) {
  if (logger && typeof logger.error === 'function') {
    try {
      logger.error(message, error);
    } catch (_loggerError) {
      // Logging must not change the source fallback result.
    }
  }
}

/**
 * Build the archived API-AI request boundary.
 *
 * `request` is intentionally required.  It receives the source URL and the
 * `{ params, headers }` object that requests.get would receive, and returns a
 * response object with a `json()` method.  Tests and deployments can inject a
 * pinned response or a real transport explicitly; importing this module alone
 * cannot contact api.ai.
 */
export function createGqaApiAiClient({
  request,
  endpoint = GQA_API_AI_ENDPOINT,
  apiKey = '',
  logger = { error: noOpLogger },
} = {}) {
  if (typeof request !== 'function') {
    throw new TypeError('GQA API-AI request implementation must be a function');
  }
  if (typeof endpoint !== 'string' || endpoint.length === 0) {
    throw new TypeError('GQA API-AI endpoint must be configured');
  }

  return Object.freeze({
    async call(query, robotName) {
      const params = {
        query,
        lang: 'en',
        sessionId: robotName,
      };
      const headers = {
        'Content-Type': 'application/json; charset=utf-8',
        Authorization: apiKey,
      };

      try {
        // Keep the source requests.get shape: the transport chooses GET and
        // receives params/headers separately rather than a JSON request body.
        const response = await request(endpoint, { params, headers });
        if (!response || typeof response.json !== 'function') {
          throw new TypeError('GQA API-AI response has no json() method');
        }
        return await response.json();
      } catch (error) {
        logError(logger, 'Api.ai call got unexpected exception', error);
        return {};
      }
    },
  });
}

// Keep a concise generic alias for callers that do not use the GQA prefix.
export const createApiAiClient = createGqaApiAiClient;
