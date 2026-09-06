// Source-compatible Settings provider graph.
//
// The original srv-settings-ws constructs Account, Hub, Person and Lasso clients from
// registry entries. Phoenix has those peers at different maturity levels, so the default
// graph selects a Phoenix HTTP client when its NET_* peer is configured and otherwise uses
// the account store/data store seams explicitly. The Settings controller remains the one
// implementation of validation, view traversal and error projection in both cases.

import { getSettingsData } from './settingsData.js';

const REPORT_SKILL = 'report-skill';

function baseUrl(raw) {
  if (!raw) return null;
  const value = /^https?:\/\//i.test(String(raw)) ? String(raw) : `http://${raw}`;
  return value.endsWith('/') ? value : `${value}/`;
}

function configuredPeer(env, names) {
  for (const name of names) {
    const value = env[name];
    if (value) return baseUrl(value);
  }
  return null;
}

function providerError(message, statusCode = 503, code = 'SETTINGS_PROVIDER_UNAVAILABLE') {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  // BaseClient/Wreck failures are ordinary errors. Only the explicit Account membership
  // rejection below is source Boom.badRequest-shaped; the Server wrapper converts peer
  // transport failures to its generic 500 response.
  error.isBoom = false;
  return error;
}

async function readResponse(response, peer, url) {
  const text = await response.text();
  let value = null;
  if (text) {
    try { value = JSON.parse(text); } catch { value = text; }
  }
  if (!response.ok) {
    const message = value && typeof value === 'object' && value.message
      ? value.message
      : typeof value === 'string' && value ? value : `${peer} responded ${response.status}`;
    const error = providerError(message, response.status, value && value.code);
    error.peer = peer;
    throw error;
  }
  return value;
}

async function requestJson(fetchImpl, peer, base, path, options = {}) {
  if (!base) throw providerError(`${peer} service is not configured (set a NET_* peer)`, 503);
  const url = new URL(path, base);
  const headers = { ...(options.headers || {}) };
  if (options.body !== undefined && !headers['content-type']) headers['content-type'] = 'application/json';
  const response = await fetchImpl(url, {
    method: options.method || 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return readResponse(response, peer, url.toString());
}

function sourceLoopMemberError() {
  const error = providerError('Only loop member can query loop properties', 403, 'LOOP_MEMBER_ONLY');
  error.isBoom = true;
  return error;
}

function transactionHeaders(context) {
  return context.transactionId === undefined ? {} : { 'X-JIBO-transID': context.transactionId };
}

function localAccount(store) {
  return {
    async checkUserBelongsToLoop(context) {
      const loop = context.loopId && store.loops.get(context.loopId);
      const member = loop && context.userId && Array.isArray(loop.members)
        && loop.members.some((item) => item.accountId === context.userId && item.status === 'ACCEPTED');
      if (!member) throw sourceLoopMemberError();
    },
    async getFriendlyId(context) {
      const loop = context.loopId && store.loops.get(context.loopId);
      const robot = loop && store.accounts.get(loop.robot);
      if (!robot || !robot.friendlyId) throw providerError(`Loop ${context.loopId} has no robot`, 404, 'LOOP_NOT_FOUND');
      return robot.friendlyId;
    },
  };
}

function localView(data) {
  const childViews = Object.entries(data || {}).map(([key, value]) => {
    if (value && Object.prototype.hasOwnProperty.call(value, 'credentialExists')) {
      const parts = key.split(':');
      return {
        type: 'oauth',
        valueDefinition: { target: 'lasso', key },
        oauthParams: {
          serviceName: parts[0] || 'unknown',
          serviceAccountName: parts[1] || 'default',
          scopes: parts.slice(2).filter(Boolean),
        },
      };
    }
    return { type: 'switch', valueDefinition: { target: 'person', key } };
  });
  return { type: 'group', childViews };
}

function localHub(store, account) {
  return {
    async getSkillConfigs(context) {
      // Keep the source Hub -> Account friendly-id dependency even when the
      // manifest itself is served by the bounded local storage adapter.
      await account.getFriendlyId(context);
      const data = getSettingsData(store, context.userId);
      return [{ id: REPORT_SKILL, settings: { view: localView(data) } }];
    },
  };
}

function localPerson(store) {
  return {
    async getAccountProperties(context, keys) {
      const data = getSettingsData(store, context.userId);
      return Object.fromEntries(keys.map((key) => [key, data[key]]).filter(([, value]) => value !== undefined));
    },
    async getLoopProperties() {
      // Phoenix's account store has no Person loop-property collection yet. Returning an
      // empty object preserves source default handling; a configured NET_person client is
      // selected whenever the real Person boundary is available.
      return {};
    },
  };
}

function localLasso(store) {
  return {
    async getCredential(context, params) {
      const data = getSettingsData(store, context.userId);
      return data[`${params.serviceName}:${params.serviceAccountName}:${(params.scopes || []).join(':')}`]
        || { credentialExists: false };
    },
  };
}

function networkAccount(fetchImpl, base) {
  return {
    async checkUserBelongsToLoop(context) {
      const url = new URL('isLoopMember', base);
      url.searchParams.set('accountId', context.userId);
      url.searchParams.set('loopId', context.loopId);
      const response = await requestJson(fetchImpl, 'Account', base, `${url.pathname}${url.search}`);
      if (!response || !response.result) throw sourceLoopMemberError();
    },
    async getFriendlyId(context) {
      const url = new URL('loopPopulated', base);
      url.searchParams.set('loopId', context.loopId);
      const response = await requestJson(fetchImpl, 'Account', base, `${url.pathname}${url.search}`);
      if (!response || !response.robotFriendlyId) throw providerError(`Loop ${context.loopId} has no robot`, 404, 'LOOP_NOT_FOUND');
      return response.robotFriendlyId;
    },
  };
}

function networkHub(fetchImpl, base, account) {
  return {
    async getSkillConfigs(context) {
      const robotFriendlyId = await account.getFriendlyId(context);
      const path = `/v1/skills/settings/${encodeURIComponent(robotFriendlyId)}`;
      const response = await requestJson(fetchImpl, 'Hub', base, path, {
        headers: transactionHeaders(context),
      });
      // The source Hub client returns response.skills directly; the Settings
      // controller owns the subsequent `.map` failure for malformed replies.
      return response && response.skills;
    },
  };
}

function networkPerson(fetchImpl, base) {
  return {
    getAccountProperties: (context, keys) => sendPerson(fetchImpl, base, context, 'GetAccountProperties', { keys }),
    getLoopProperties: (context, keys) => sendPerson(fetchImpl, base, context, 'GetLoopProperties', { keys, loopId: context.loopId }),
  };
}

async function sendPerson(fetchImpl, base, context, operation, payload) {
  const response = await requestJson(fetchImpl, 'Person', base, '/', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-amz-json-1.1',
      'x-amz-credentials': JSON.stringify({ id: context.userId }),
      'x-amz-target': `Person_20160801.${operation}`,
    },
    body: payload,
  });
  return response;
}

function networkLasso(fetchImpl, base) {
  return {
    async getCredential(context, params) {
      const url = new URL('/v1/credential', base);
      url.searchParams.set('accountId', context.userId);
      url.searchParams.set('skillId', params.skillId);
      url.searchParams.set('serviceName', params.serviceName);
      url.searchParams.set('serviceAccountName', params.serviceAccountName);
      (params.scopes || []).forEach((scope, index) => url.searchParams.set(`scopes[${index}]`, scope));
      try {
        const response = await requestJson(fetchImpl, 'Lasso', base, `${url.pathname}${url.search}`, {
          headers: { 'Content-Type': 'application/json', ...transactionHeaders(context) },
        });
        // Match Lasso.getCredential: parseLassoResponse, assert non-empty, assert
        // credentialExists, then wrap every failure in its operation-specific error.
        if (!response) throw new Error('Lasso returned an empty response');
        if (typeof response !== 'object' || !Object.prototype.hasOwnProperty.call(response, 'credentialExists')) {
          throw new Error('Lasso returned invalid response: credentialExists is missing');
        }
        return response;
      } catch (_error) {
        throw new Error(`Failed to get ${params.serviceName} ${params.serviceAccountName} credentials`);
      }
    },
  };
}

/**
 * Build the production provider graph. `settingsProviders` remains an explicit injection
 * seam for tests; normal service construction always runs through this graph.
 */
export function createSettingsProviders({ store, fetchImpl = globalThis.fetch, env = process.env } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('Settings providers require a fetch implementation');
  const accountBase = configuredPeer(env, ['NET_settings_account', 'NET_account']);
  const hubBase = configuredPeer(env, ['NET_settings_hub', 'NET_hub']);
  // NET_classic is the Classic front door, not the original Person boundary. Do not
  // silently send Person's AWS-JSON request to it: require an explicit Person peer
  // alias until the Classic registry route is proven equivalent.
  const personBase = configuredPeer(env, ['NET_settings_person', 'NET_person']);
  const dataBase = configuredPeer(env, ['NET_settings_lasso', 'NET_lasso', 'NET_data']);
  const account = accountBase ? networkAccount(fetchImpl, accountBase) : localAccount(store);
  return {
    account,
    hub: hubBase ? networkHub(fetchImpl, hubBase, account) : localHub(store, account),
    person: personBase ? networkPerson(fetchImpl, personBase) : localPerson(store),
    lasso: dataBase ? networkLasso(fetchImpl, dataBase) : localLasso(store),
    configuration: {
      account: accountBase ? 'network' : 'account-store',
      hub: hubBase ? 'network' : 'account-settings-store',
      person: personBase ? 'network' : 'account-settings-store',
      lasso: dataBase ? 'network' : 'account-settings-store',
      missingPeers: [
        ['account', accountBase], ['hub', hubBase], ['person', personBase], ['lasso', dataBase],
      ].filter(([, value]) => !value).map(([name]) => name),
    },
  };
}
