// Gateway service (Pegasus hub equivalent). Milestone M6.
//
// Robot-facing contract (docs/atlas/packages/hub.md, message-protocol.md; ported from
// hub/HubService.ts, BaseService.ts, listen/*):
//   WS  /listen, /v1/listen      one socket == one listen transaction
//   WS  /v1/robot-actions       authenticated native BE announcement receiver
//   GET /healthcheck, /v1/skills
// Auth rides the WS upgrade: Authorization: Bearer <HS256 JWT> verified vs
// ETCO_server_hubTokenSecret; ETCO_hub_disableAuth=true skips it (anonymous identity).
//
// Server-side ASR (audio streaming) is M8; CLIENT_ASR/CLIENT_NLU robots are fully supported.

import { WebSocketServer } from 'ws';
import {
  createService,
  createDeploymentActivity,
  logger,
  jwt,
  parseServiceArgs,
  parseVoiceTurnQuery,
  recentVoiceTurns,
  initializeVoiceTurnStorage,
  sendJson,
  serviceCliPort,
  serviceHelp,
  verifyVoiceTurnTelemetryProof,
  runService,
} from '@phoenix/common';
import { newMsgId, now, ResponseType, DefaultPort } from '@phoenix/contracts';
import { loadConfig, accountVerifyTimeout, hubSetupConfig } from './config.js';
import { ParserClient } from './parserClient.js';
import { IntentRouter } from './intentRouter.js';
import { SkillConfigManager, SkillClient } from './skillClient.js';
import { ResponseWrapper } from './responseWrapper.js';
import { ListenTransaction } from './listenTransaction.js';
import { HistoryClient } from './historyClient.js';
import { SettingsClient } from './settingsClient.js';
import { ProactiveTransaction } from './proactive/proactiveTransaction.js';
import { ANONYMOUS_AUTH } from './preprocessor.js';
import { HomeAssistantClient } from './homeAssistantClient.js';
import { RobotActionBridge } from './robotActionBridge.js';
import { robotActionRoutes } from './robotActionRoutes.js';
import { ROBOT_ACTION_PATH, robotIdentity } from './robotActionProtocol.js';
import { asrStatus, setAsrRouter } from './asr/asrRouter.js';

const LISTEN_PATHS = new Set(['/listen', '/v1/listen']);
const PROACTIVE_PATHS = new Set(['/proactive', '/v1/proactive']);
const VOICE_TURN_PROOF_MAX_AGE_MS = 30_000;
const VOICE_TURN_PROOF_NONCES_MAX = 2_000;

function verifyVoiceTurnTelemetryRequest(req, url, secret, usedNonces, now = Date.now()) {
  const timestamp = req.headers['x-phoenix-voice-turn-timestamp'];
  const nonce = req.headers['x-phoenix-voice-turn-nonce'];
  const proof = req.headers['x-phoenix-voice-turn-proof'];
  const sentAt = typeof timestamp === 'string' ? Number(timestamp) : NaN;
  if (!Number.isSafeInteger(sentAt) || Math.abs(now - sentAt) > VOICE_TURN_PROOF_MAX_AGE_MS) return false;
  if (typeof nonce !== 'string' || usedNonces.has(nonce)) return false;
  const valid = verifyVoiceTurnTelemetryProof(proof, secret, {
    method: req.method,
    target: `${url.pathname}${url.search}`,
    timestamp,
    nonce,
  });
  if (!valid) return false;
  for (const [seenNonce, seenAt] of usedNonces) {
    if (now - seenAt > VOICE_TURN_PROOF_MAX_AGE_MS) usedNonces.delete(seenNonce);
  }
  usedNonces.set(nonce, now);
  while (usedNonces.size > VOICE_TURN_PROOF_NONCES_MAX) usedNonces.delete(usedNonces.keys().next().value);
  return true;
}

export function buildComponents(config) {
  const skillConfigManager = new SkillConfigManager(config.skills);
  return {
    config,
    skills: skillConfigManager.getSkillConfigs(),
    parser: new ParserClient(config.parserURL),
    intentRouter: new IntentRouter(skillConfigManager.getSkillConfigs()),
    skillConfigManager,
    skillClient: new SkillClient(skillConfigManager),
    historyClient: new HistoryClient(config.historyURL),
    settingsClient: new SettingsClient(config.settingsURL),
    homeAssistant: config.homeAssistant ? new HomeAssistantClient(config.homeAssistant) : null,
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
    return { error: e.name ? `${e.name}: ${e.message}` : e.message };
  }
}

/**
 * Per-robot account check (G.5): the token signature is already valid; confirm its accessKeyId
 * claim still maps to a live account and the friendlyId matches. Fail-closed on a bad/absent
 * answer. A token carrying no accessKeyId claim (e.g. the sim's hand-signed creds) is allowed
 * through — accountUrl only constrains tokens that present one.
 * @returns {Promise<{ok:true}|{error:string}>}
 */
export async function verifyAgainstAccount(auth, accountUrl, log, { timeoutMs, onVerified } = {}) {
  if (!auth || !auth.accessKeyId) return { ok: true };
  try {
    const res = await fetch(`${accountUrl}/api/verify?accessKeyId=${encodeURIComponent(auth.accessKeyId)}`, {
      signal: AbortSignal.timeout(accountVerifyTimeout(timeoutMs)),
    });
    if (!res.ok) return { error: `account verify ${res.status}` };
    const v = await res.json();
    if (!v.valid) return { error: 'account not found or inactive' };
    if (auth.friendlyId && v.friendlyId && auth.friendlyId !== v.friendlyId) return { error: 'friendlyId mismatch' };
    // Keep legacy accept/reject semantics, but expose a strict server identity
    // separately for native action coordination and current presence telemetry.
    if (auth.id === v.id && auth.friendlyId === v.friendlyId) {
      const identity = robotIdentity({ id: v.id, accessKeyId: auth.accessKeyId, friendlyId: v.friendlyId });
      if (identity) onVerified?.(identity);
    }
    return { ok: true };
  } catch (e) {
    log?.warn?.('account verify unreachable (fail-closed)', { error: e.message, accountUrl });
    return { error: `account verify unreachable: ${e.message}` };
  }
}

/** Create (but do not start) the gateway. Returns { service, wss, components }. */
export async function createGateway(config = loadConfig()) {
  config = await config;
  initializeVoiceTurnStorage();
  const log = logger('gateway');
  const components = buildComponents(config);
  const robotActionPeerToken = config.robotActions?.peerToken || config.homeAssistant?.token || process.env.ETCO_account_internalPeerToken;
  let robotActions;
  const deploymentActivity = createDeploymentActivity('hub', { log, onStartup: activity => {
    robotActions = new RobotActionBridge({ ...(config.robotActions || {}), config,
      authenticate: checkAuthentication, activity, log, peerToken: robotActionPeerToken });
  } });
  const settingsSkills = config.skills.filter(skill => !!skill.settings);
  const listSkills = () => ({ skills: config.skills });
  const listSettingsSkills = () => ({ skills: settingsSkills });
  const usedVoiceTurnProofNonces = new Map();

  const service = createService({
    name: 'gateway',
    routes: {
      ...robotActionRoutes(robotActions, { peerToken: robotActionPeerToken }),
      'GET /skills/:robotId': listSkills,
      'GET /skills/settings/:robotId': listSettingsSkills,
      'GET /v1/skills/:robotId': listSkills,
      'GET /v1/skills/settings/:robotId': listSettingsSkills,
      // Phoenix's no-ID discovery aliases are deployment extensions.
      'GET /v1/skills': () => ({ skills: config.skills.map((s) => ({ id: s.id, intents: s.intents })) }),
      'GET /skills': () => ({ skills: config.skills.map((s) => ({ id: s.id, intents: s.intents })) }),
      // Browser-facing administration is served by Account, which re-checks
      // its session's isAdmin flag and proves this private hop with an HMAC.
      // This endpoint deliberately returns only the bounded structured turn
      // projection, never the general log ring or request content.
      'GET /v1/admin/voice-turns': ({ req, res, url }) => {
        if (!verifyVoiceTurnTelemetryRequest(req, url, config.hubTokenSecret, usedVoiceTurnProofNonces)) {
          return sendJson(res, 403, { error: 'forbidden' });
        }
        try {
          return recentVoiceTurns(parseVoiceTurnQuery(url.searchParams));
        } catch (error) {
          return sendJson(res, 400, { error: error.message });
        }
      },
      'GET /v1/admin/asr': ({ req, res, url }) => {
        if (!verifyVoiceTurnTelemetryRequest(req, url, config.hubTokenSecret, usedVoiceTurnProofNonces)) {
          return sendJson(res, 403, { error: 'forbidden' });
        }
        return asrStatus();
      },
    },
  });

  service.server.once('close', () => { robotActions.close(); deploymentActivity.stop(); setAsrRouter(null); });
  const admit = async (info, cb) => {
    const end = deploymentActivity.begin('voice');
    if (!end) return cb(false, 503, 'Server restarting; retry shortly', { 'Retry-After': '5' });
    const releaseVoice = robotActions.reserveVoice(info.req._auth, { verifiedIdentity: info.req._verifiedRobotIdentity });
    const release = () => { releaseVoice(); end(); };
    info.req._endDeploymentActivity = release;
    // Failed upgrades never get a transaction. Accepted connections release
    // their count when tx.done settles, including cancellation and failures.
    info.req.socket.once('close', () => { if (!info.req._deploymentConnected) release(); });
    // Ordinary voice has priority over a reverse announcement, but it must wait
    // for the native speech stop acknowledgement before starting its transaction.
    // Proactive work cannot interrupt an owner-requested announcement.
    const ready = await robotActions.prepareVoice(info.req._auth, {
      interrupt: LISTEN_PATHS.has(info.req.url), verifiedIdentity: info.req._verifiedRobotIdentity,
    });
    if (info.req.socket.destroyed) { release(); return; }
    if (!ready) {
      release();
      return cb(false, 503, 'Robot announcement stopping; retry shortly', { 'Retry-After': '5' });
    }
    cb(true, 200, '');
  };
  const wss = new WebSocketServer({
    noServer: true,
    verifyClient: (info, cb) => {
      // BaseService registers exact socket URLs. Query strings therefore remain
      // part of the lookup key and are rejected with the source 404 contract.
      const url = info.req.url || '';
      const pathOk = LISTEN_PATHS.has(url) || PROACTIVE_PATHS.has(url);
      if (config.disableAuth) {
        if (!pathOk) return cb(false, 404, `WebSocket url '${info.req.url}' has no handler`);
        info.req._auth = { ...ANONYMOUS_AUTH };
        return admit(info, cb);
      }
      const { error, auth } = checkAuthentication(info.req.headers, config.hubTokenSecret);
      if (error) { log.warn('ws auth failed', { error }); return cb(false, 401, error); }
      info.req._auth = auth;
      if (!pathOk) return cb(false, 404, `WebSocket url '${info.req.url}' has no handler`);
      if (!config.accountUrl) return admit(info, cb); // shared-secret-only mode
      // Per-robot account validation (async — ws supports a deferred cb).
      verifyAgainstAccount(auth, config.accountUrl, log, { timeoutMs: config.accountVerifyTimeoutMs,
        onVerified: (identity) => { info.req._verifiedRobotIdentity = identity; },
      }).then((r) => {
        if (r.error) { log.warn('ws account check failed', { error: r.error }); return cb(false, 401, r.error); }
        admit(info, cb);
      });
    },
  });

  // Keep the legacy authentication-before-path ordering in its own unchanged
  // verifier, while bounding frames on the new persistent control channel.
  service.server.on('upgrade', (req, socket, head) => {
    const server = req.url === ROBOT_ACTION_PATH ? robotActions.wss : wss;
    server.handleUpgrade(req, socket, head, (ws) => server.emit('connection', ws, req));
  });

  wss.on('connection', (ws, req) => {
    req._deploymentConnected = true;
    ws._auth = req._auth || (config.disableAuth ? { ...ANONYMOUS_AUTH } : null);
    // Separate from legacy claims: set only after signature + live Account
    // mapping equality. Native local routing cannot use context or headers
    // to manufacture this verified identity.
    ws._verifiedRobotIdentity = req._verifiedRobotIdentity || null;
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
      catch {
        // Preserve the original robot-visible protocol error, while giving the
        // server logger a safe summary. A malformed frame can itself contain a
        // transcript or token, so it must not be copied into observability.
        const error = new Error(`Invalid JSON arrived into socket: ${data}`);
        error.safeLogMessage = 'Invalid JSON arrived into socket';
        return tx.reject(error);
      }
      tx.handleMessage({ json });
    });
    // ListenHandler's SocketMessageReader resolves its read promise on close,
    // but the transaction itself remains pending until normal completion or
    // TransactionHandler's timeout. Resolving a listen transaction here makes
    // an early client disconnect look like a successful turn and can settle it
    // while a skill request is still in flight. ProactiveTransaction retains
    // Phoenix's existing close behavior until that separate lifecycle is
    // reviewed against the source proactive handler.
    //
    // A closed peer cannot receive anything, so the listen transaction's
    // in-flight ASR phase is abandoned instead (Phoenix fix): the robot closes
    // this socket on every hotword re-trigger and on cancel_local_turn, and
    // without this the phase kept streaming into a dead response and recognized
    // audio whose EOS + LISTEN frames were silently dropped.
    if (isProactive) ws.on('close', () => tx.abandon?.());
    else ws.on('close', () => tx.abandon?.());

    tx.done.catch((err) => {
      reqLog.error('transaction failed', { error: err.safeLogMessage || err.message, code: err.code });
      const wrote = response.write({ type: ResponseType.ERROR, msgID: newMsgId(), ts: now(), final: true, data: { code: err.code, message: err.message }, timings: { total: now() - tx.startTime } });
      if (wrote !== false) tx.markErrorResponse?.();
    });
    tx.done.then(req._endDeploymentActivity, req._endDeploymentActivity);
  });

  return { service, wss, components, robotActions };
}

export async function start(port = Number(process.env.PORT) || DefaultPort.gateway, config = loadConfig()) {
  const gw = await createGateway(config);
  await gw.service.listen(port);
  return gw;
}

// Executable boundary. The reference hub resolves its port from argv/ETCO_server_port
// and logs the setup config before constructing the service
// (packages/hub/src/cli/start.ts:17-43), with the hub-specific usage text that omits
// the `[options]` suffix other services print.
if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = parseServiceArgs();
  if (argv.h || argv.help) {
    console.log(serviceHelp(process.argv[1], { options: false }));
    process.exit(0);
  }
  const port = serviceCliPort({ fallback: DefaultPort.gateway });
  runService('Hub', async () => {
    const config = await loadConfig();
    logger('gateway').info('Starting hub with config: ', hubSetupConfig(config));
    return start(port, config);
  });
}
