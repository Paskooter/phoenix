// srv-account-ws@6cea434, EchoSignController. Transport is injectable for local tests.
import http from 'node:http';
import https from 'node:https';
import querystring from 'node:querystring';

const JSON_CONTENT_TYPE = /^application\/([a-z0-9.]*[+-]json|json)$/;

function headerValue(headers, name) {
  if (!headers) return undefined;
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : headers[key];
}

function hasHeader(headers, name) {
  return headerValue(headers, name) !== undefined;
}

function payloadSupported(method, body) {
  return method !== 'GET' && method !== 'HEAD' && body !== undefined && body !== null;
}

function withStatus(error, statusCode) {
  if (error && error.statusCode !== undefined) return error;
  const result = error instanceof Error ? error : new Error(String(error));
  result.statusCode = statusCode;
  return result;
}

function decodeWreckJson(buffer, headers) {
  // Wreck returns null for an empty body before examining content type.
  if (buffer.length === 0) return null;
  const contentType = String(headerValue(headers, 'content-type') || '');
  const mime = contentType.split(';', 1)[0].trim().toLowerCase();
  // json:true is smart parsing: non-JSON MIME responses remain Buffers.
  if (!JSON_CONTENT_TYPE.test(mime)) return buffer;
  try {
    return JSON.parse(buffer.toString());
  } catch (error) {
    // Wreck's tryParseBuffer returns the Buffer alongside this error; the
    // controller rejects the error, so retain the payload for diagnostics.
    error.payload = buffer;
    throw error;
  }
}

function requestJson(url, { method, headers, body }) {
  return new Promise((resolve, reject) => {
    const transport = url.startsWith('https:') ? https : http;
    const upperMethod = String(method).toUpperCase();
    const requestHeaders = { ...headers };
    // Node 8's Wreck agent used a close connection by default. Keep that
    // source-visible behavior while respecting an explicit caller header.
    if (!hasHeader(requestHeaders, 'connection')) requestHeaders.connection = 'close';
    if (payloadSupported(upperMethod, body) && !hasHeader(requestHeaders, 'content-length')) {
      requestHeaders['content-length'] = Buffer.byteLength(body);
    }
    const request = transport.request(url, { method: upperMethod, headers: requestHeaders }, (response) => {
      const chunks = [];
      let ended = false;
      let settled = false;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('aborted', () => fail(withStatus(new Error('Payload stream closed prematurely'), 500)));
      response.on('error', (error) => fail(withStatus(error, 500)));
      response.on('close', () => {
        if (!ended) fail(withStatus(new Error('Payload stream closed prematurely'), 500));
      });
      response.on('end', () => {
        ended = true;
        if (settled) return;
        try {
          const decoded = decodeWreckJson(Buffer.concat(chunks), response.headers);
          settled = true;
          resolve({
            ok: response.statusCode < 400,
            statusCode: response.statusCode,
            statusMessage: response.statusMessage,
            headers: response.headers,
            json: async () => decoded,
          });
        } catch (error) {
          fail(error);
        }
      });
    });
    request.on('error', (error) => reject(withStatus(error, 502)));
    if (payloadSupported(upperMethod, body)) request.end(body);
    else request.end();
  });
}
export class EchoSignProvider {
  constructor({ adobe = {}, server = {}, baseUrl = 'https://api.na1.echosign.com', requestImpl = requestJson } = {}) {
    this.config = adobe;
    this.portalUrl = server.portalUrl;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.transport = requestImpl;
    this.accessToken = undefined;
  }

  async request(method, path, payload, form = false) {
    const headers = form ? { 'content-type': 'application/x-www-form-urlencoded' }
      : { 'content-type': 'application/json', 'access-token': this.accessToken };
    const response = await this.transport(`${this.baseUrl}${path}`, {
      method, headers,
      body: form ? querystring.stringify(payload) : JSON.stringify(payload),
    });
    const result = await response.json();
    if (!response.ok) {
      const statusCode = Number(response.statusCode) || 500;
      const statusMessage = response.statusMessage ? ` ${response.statusMessage}` : '';
      throw Object.assign(new Error(`Response Error: ${statusCode}${statusMessage}`), {
        statusCode,
        isResponseError: true,
      });
    }
    if (result && (result.error || result.code)) {
      throw Object.assign(new Error(result.error_description || result.error || result.message), {
        code: 'Service Unavailable',
        statusCode: 503,
      });
    }
    return result;
  }

  async refreshToken() {
    // Avoid an external request when a deployment has not configured a provider.
    if (!this.config.appId || !this.config.appSecret || !this.config.appRefreshToken) {
      throw Object.assign(new Error('EchoSign is unavailable'), { code: 'ECHO_SIGN_UNAVAILABLE', statusCode: 503 });
    }
    const result = await this.request('POST', '/oauth/refresh', {
      client_id: this.config.appId, client_secret: this.config.appSecret,
      grant_type: 'refresh_token', refresh_token: this.config.appRefreshToken,
    }, true);
    this.accessToken = result.access_token;
    if (!this.accessToken) throw Object.assign(new Error('EchoSign is unavailable'), { code: 'ECHO_SIGN_UNAVAILABLE', statusCode: 503 });
    return this.accessToken;
  }

  async isSigned(agreementId) {
    const result = await this.request('GET', `/api/rest/v5/agreements/${agreementId}`, null);
    return result.status === 'SIGNED';
  }

  async send(email, firstName, lastName, childName) {
    try { await this.request('POST', '/api/rest/v5/users', { email, firstName, lastName }); }
    catch { /* Source logs user-creation failure and still sends the agreement. */ }
    const result = await this.request('POST', '/api/rest/v5/agreements', {
      documentCreationInfo: {
        callbackInfo: `${this.portalUrl}/callback`, daysUntilSigningDeadline: 10,
        fileInfos: [{ documentURL: { mimeType: 'application/pdf', name: 'Jibo', url: this.config.agreementUrl } }],
        mergeFieldInfo: [
          { defaultValue: email, fieldName: 'Email' },
          { defaultValue: `${firstName} ${lastName}`, fieldName: 'Name' },
          { defaultValue: childName, fieldName: 'ChildName' },
        ],
        name: 'a parental permission agreement',
        postSignOptions: { redirectUrl: `${this.portalUrl}/signed` },
        recipientSetInfos: [{ recipientSetMemberInfos: [{ email }], recipientSetRole: 'SIGNER' }],
        reminderFrequency: 'DAILY_UNTIL_SIGNED', signatureFlow: 'SENDER_SIGNATURE_NOT_REQUIRED', signatureType: 'ESIGN',
      },
      options: { autoLoginUser: true },
    });
    return result.agreementId;
  }
}
