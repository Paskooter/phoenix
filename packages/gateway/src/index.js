// Gateway service (Pegasus hub equivalent). Milestone M6.
//
// Robot-facing contract (docs/atlas/packages/hub.md, message-protocol.md; ported from
// hub/HubService.ts, BaseService.ts, listen/*):
//   WS  /listen, /v1/listen      one socket == one listen transaction
//   GET /healthcheck, /v1/skills
// Auth rides the WS upgrade: Authorization: Bearer <HS256 JWT> verified vs
// ETCO_server_hubTokenSecret; ETCO_hub_disableAuth=true skips it (anonymous identity).
//
// Server-side ASR (audio streaming) is M8; CLIENT_ASR/CLIENT_NLU robots are fully supported.

import { WebSocketServer } from 'ws';
import { createService, logger, jwt } from '@phoenix/common';
import { newMsgId, now, ResponseType, DefaultPort } from '@phoenix/contracts';
import { loadConfig } from './config.js';
import { ParserClient } from './parserClient.js';
import { IntentRouter } from './intentRouter.js';
import { SkillConfigManager, SkillClient } from './skillClient.js';
import { ResponseWrapper } from './responseWrapper.js';
import { ListenTransaction } from './listenTransaction.js';
import { HistoryClient } from './historyClient.js';
import { ProactiveTransaction } from './proactive/proactiveTransaction.js';

const LISTEN_PATHS = new Set(['/listen', '/v1/listen']);
const PROACTIVE_PATHS = new Set(['/proactive', '/v1/proactive']);

export function buildComponents(config) {
  const skillConfigManager = new SkillConfigManager(config.skills);
  return {
    config,
    skills: config.skills, // raw registry (carries proactives/IHQueries)
    parser: new ParserClient(config.parserURL),
    intentRouter: new IntentRouter(config.skills),
    skillConfigManager,
    skillClient: new SkillClient(skillConfigManager),
    historyClient: new HistoryClient(config.historyURL),
    asr: null, // M8: Parakeet provider
  };
}

/** Verify the WS upgrade auth (BaseService.checkAuthentication). */
export function checkAuthentication(headers, secret) {
  if (!headers.authorization) return { error: 'Authorization is required' };
  const parts = headers.authorization.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') return { error: 'Only bearer scheme is supported' };
  if (!secret) return { error: 'No JWT secret set' };
  try {
    return { auth: jwt.verify(parts[1], secret) };
  } catch (e) {
    return { error: e.message };
  }
}

/**
 * Per-robot account check (G.5): the token signature is already valid; confirm its accessKeyId
 * claim still maps to a live account and the friendlyId matches. Fail-closed on a bad/absent
 * answer. A token carrying no accessKeyId claim (e.g. the sim's hand-signed creds) is allowed
 * through — accountUrl only constrains tokens that present one.
 * @returns {Promise<{ok:true}|{error:string}>}
 */
export async function verifyAgainstAccount(auth, accountUrl, log) {
  if (!auth || !auth.accessKeyId) return { ok: true };
  try {
    const res = await fetch(`${accountUrl}/api/verify?accessKeyId=${encodeURIComponent(auth.accessKeyId)}`);
    if (!res.ok) return { error: `account verify ${res.status}` };
    const v = await res.json();
    if (!v.valid) return { error: 'account not found or inactive' };
    if (auth.friendlyId && v.friendlyId && auth.friendlyId !== v.friendlyId) return { error: 'friendlyId mismatch' };
    return { ok: true };
  } catch (e) {
    log?.warn?.('account verify unreachable (fail-closed)', { error: e.message, accountUrl });
    return { error: `account verify unreachable: ${e.message}` };
  }
}

/** Create (but do not start) the gateway. Returns { service, wss, components }. */
export function createGateway(config = loadConfig()) {
  const log = logger('gateway');
  const components = buildComponents(config);

  const service = createService({
    name: 'gateway',
    routes: {
      'GET /v1/skills': () => ({ skills: config.skills.map((s) => ({ id: s.id, intents: s.intents })) }),
      'GET /skills': () => ({ skills: config.skills.map((s) => ({ id: s.id, intents: s.intents })) }),
    },
  });

  const wss = new WebSocketServer({
    server: service.server,
    verifyClient: (info, cb) => {
      const url = (info.req.url || '').split('?')[0];
      const pathOk = LISTEN_PATHS.has(url) || PROACTIVE_PATHS.has(url);
      if (config.disableAuth) {
        if (!pathOk) return cb(false, 404, `no handler for ${info.req.url}`);
        return cb(true, 200, '');
      }
      const { error, auth } = checkAuthentication(info.req.headers, config.hubTokenSecret);
      if (error) { log.warn('ws auth failed', { error }); return cb(false, 401, error); }
      info.req._auth = auth;
      if (!pathOk) return cb(false, 404, `no handler for ${info.req.url}`);
      if (!config.accountUrl) return cb(true, 200, ''); // shared-secret-only mode
      // Per-robot account validation (async — ws supports a deferred cb).
      verifyAgainstAccount(auth, config.accountUrl, log).then((r) => {
        if (r.error) { log.warn('ws account check failed', { error: r.error }); return cb(false, 401, r.error); }
        cb(true, 200, '');
      });
    },
  });

  wss.on('connection', (ws, req) => {
    ws._auth = req._auth || null;
    ws._jiboHeaders = req.headers;
    ws._remoteAddress = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString();
    const path = (req.url || '').split('?')[0];
    const isProactive = PROACTIVE_PATHS.has(path);
    const reqLog = logger(isProactive ? 'gateway.proactive' : 'gateway.listen', { transId: req.headers['x-jibo-transid'] });

    const response = new ResponseWrapper(ws, reqLog);
    const tx = isProactive
      ? new ProactiveTransaction(ws, components, response, reqLog)
      : new ListenTransaction(ws, components, response, reqLog);

    ws.on('message', (data, isBinary) => {
      if (isBinary) return tx.handleMessage({ audio: data });
      let json;
      try { json = JSON.parse(data.toString('utf8')); }
      catch { return tx.reject(new Error(`Invalid JSON arrived into socket: ${data}`)); }
      tx.handleMessage({ json });
    });
    ws.on('close', () => tx.resolve());

    tx.done.catch((err) => {
      reqLog.error('transaction failed', { error: err.message, code: err.code });
      response.write({ type: ResponseType.ERROR, msgID: newMsgId(), ts: now(), final: true, data: { code: err.code, message: err.message }, timings: { total: now() - tx.startTime } });
    });
  });

  return { service, wss, components };
}

export async function start(port = Number(process.env.PORT) || DefaultPort.gateway, config = loadConfig()) {
  const gw = createGateway(config);
  await gw.service.listen(port);
  return gw;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  start().catch((e) => { console.error(e); process.exit(1); });
}
