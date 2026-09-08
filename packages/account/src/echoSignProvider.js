// srv-account-ws@6cea434, EchoSignController. Transport is injectable for local tests.
import http from 'node:http';
import https from 'node:https';

function requestJson(url, { method, headers, body }) {
  return new Promise((resolve, reject) => {
    const transport = url.startsWith('https:') ? https : http;
    const request = transport.request(url, { method, headers: { ...headers, 'content-length': Buffer.byteLength(body) } }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => {
        try { resolve({ ok: response.statusCode < 400, json: async () => JSON.parse(Buffer.concat(chunks).toString()) }); }
        catch (error) { reject(error); }
      });
    });
    request.on('error', reject);
    request.end(body);
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
      body: form ? new URLSearchParams(payload).toString() : JSON.stringify(payload),
    });
    const result = await response.json();
    if (!response.ok || (result && (result.error || result.code))) {
      throw Object.assign(new Error('EchoSign request failed'), { code: 'Service Unavailable', statusCode: 503 });
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
