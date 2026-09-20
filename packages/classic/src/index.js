// @phoenix/classic — the classic-service entrypoint: the robot's single front door. One AWS-JSON
// endpoint (POST /) that the robot's region (https://<region>.jibo.com) resolves to, dispatching
// by X-Amz-Target prefix to the right service. Lightweight stateless services (log, robot) run
// in-process here; stateful services that own a store proxy to their dedicated process:
//   OOBE_*   -> account service (NET_account, default localhost:7016)
//   Update_* -> ota service     (NET_ota,     default localhost:7015)
// New services (settings, notification, key, …) register here as they land in later iterations.

import { createService, sendJson, logger } from '@phoenix/common';
import { statSync } from 'node:fs';
import { DefaultPort } from '@phoenix/contracts';
import {
  createGqaFileAttributionStore,
  createPhoenixGqaAccountLookup,
  createStructQaHandler,
  GQA_ATTRIBUTE_DEFAULT_FILE,
} from '@phoenix/skills';
import { createClassicRouter } from './router.js';
import { LogStore, makeLogHandler, logHttpRoutes } from './log.js';
import { makeRobotHandler, RobotStore } from './robot.js';
import { NotificationHub, makeNotificationHandler, attachNotificationSocket } from './notification.js';
import { KeyStore, makeKeyHandler, keyRoutes, accountMembership } from './key.js';
import { DeviceRegistry, makePushHandler, pushRoutes } from './push.js';
import { createJotMessageCreatedConsumer } from './jotPushConsumer.js';
import { BackupStore, makeBackupHandler, backupBlobRoutes } from './backup.js';
import { MediaStore, makeMediaHandler, mediaBlobRoutes, isMediaUpload } from './media.js';
import { makeRomHandler } from './rom.js';
import { IftttStore, makeIftttHandler } from './ifttt.js';
import { makeNlpHandler, nlpProviderFromEnv } from './nlp.js';
import { PersonStore, PersonController, PropertyController, makePersonHandler, PERSON_ERRORS } from './person.js';
import { makeCollisionHandler, detectCollision, graphemePhonemize, levenshteinDistance, COLLISION_ERRORS, COLLISION_DEFAULTS } from './collision.js';
import { GQA_ROUTE_OPTIONS, makeGqaHandler } from './gqa.js';
import { JotStore, makeJotHandler, mediaStoreClient, jotHttpRoutes, unavailableMedia, JOT_ERRORS, JOT_OPERATIONS } from './jot.js';
import {
  VoiceTrainingStore, makeVoiceTrainingHandler, voiceTrainingBackup, voiceTrainingBlobRoutes,
  VOICE_TRAINING_OPERATIONS, VOICE_TRAINING_UNSUPPORTED_OPERATIONS, VOICE_TRAINING_TARGET_PREFIXES,
  VOICE_TRAINING_PATH_ROOT, VOICE_TRAINING_MAX_BYTES, VOICE_TRAINING_BLOB_ROUTE,
} from './voiceTraining.js';
import { stubRegistrations } from './stubs.js';
import { proxyMemberPhoto } from './photoProxy.js';
import { PublicOriginError, configuredPublicOrigin } from './publicOrigin.js';
import {
  cleanupVerifiedClassicRequest,
  createVerifiedClassicCaller,
  sendVerifiedCallerError,
} from './caller.js';

export { createClassicRouter } from './router.js';
export * as awsJson from './awsJson.js';
export { LogStore, makeLogHandler, logHttpRoutes } from './log.js';
export { makeRobotHandler, RobotStore } from './robot.js';
export { NotificationHub, createVerifiedNotificationAccountResolver } from './notification.js';
export { NotificationStore } from './notification.js';
export { KeyStore, keyRoutes, KEY_ERRORS, KEY_BINARY_MAX_BYTES } from './key.js';
export { DeviceRegistry, makePushHandler, pushRoutes } from './push.js';
export { BackupStore, credentialsAccountId, accountLoopRobot, BACKUP_MAX_BYTES, BACKUP_URL_EXPIRATION_MS } from './backup.js';
export { MediaStore, makeMediaHandler, mediaBlobRoutes, expandMedia, accessKeyAccountResolver, MEDIA_ERRORS, MEDIA_TYPES, MEDIA_MAX_BYTES, AUTHORIZED_UNDER_ADMIN } from './media.js';
export {
  VERIFIED_CALLER,
  createVerifiedClassicCaller,
  verifiedCallerFromRequest,
  cleanupVerifiedClassicRequest,
  sendVerifiedCallerError,
  DEFAULT_AUTH_BODY_MAX_BYTES,
} from './caller.js';
export { PublicOriginError, configuredPublicOrigin, canonicalPublicOrigin, requirePublicOrigin } from './publicOrigin.js';
export {
  RomController, RomError, CertificateStore, ROM_ERRORS,
  makeRomHandler, makeAccountClient, makeRobotClient, generateCertificatePair,
  accountBaseUrl, robotBaseUrl, CERTIFICATE_LIFETIME_DAYS,
} from './rom.js';
export { IftttStore, makeIftttHandler, IFTTT_ERRORS, localPhoneticKey, singleHouseholdLoops, unavailableIftttNotify, unavailableKeyClient } from './ifttt.js';
export { makeNlpHandler, cleanInput, unavailableNlpProvider, createHttpNlpProvider, nlpProviderFromEnv, WH_WORDS } from './nlp.js';
export { PersonStore, PersonController, PropertyController, makePersonHandler, accountIdFromRequest, PERSON_ERRORS, PERSON_OPERATIONS, MISSING_AUTH_HEADER } from './person.js';
export { makeCollisionHandler, detectCollision, graphemePhonemize, levenshteinDistance, COLLISION_ERRORS, COLLISION_DEFAULTS, COLLISION_OPERATIONS } from './collision.js';
export {
  GQA_SOURCE_REVISION, GQA_API_REVISION, GQA_GATEWAY_REVISION, GQA_TARGET_PREFIX, GQA_OPERATIONS,
  GQA_VERSION, GQA_BAD_REQUEST_HTML, GQA_NOT_FOUND_HTML, GQA_ROUTE_OPTIONS,
  gqaCredentials, gqaEmptyJsonEntity, sendGqaJson, sendGqaHtml, sourceTruthy, makeGqaHandler,
} from './gqa.js';
export {
  JotStore, JotMessageController, JotMessageCreated, makeJotHandler, jotHttpRoutes,
  mediaStoreClient, unavailableMedia, JOT_ERRORS, JOT_OPERATIONS, JOT_TARGET_PREFIXES,
  JOT_MESSAGES_LIMIT, JOT_BULK_ROUTE, JOT_EVENTS, JOT_VALIDATORS, JOT_MESSAGE_CREATED_SCHEMA,
  JOT_DISPATCH_RULE, jotMethodNotFound, lowerFirstOp,
} from './jot.js';
export { PERSON_QUESTIONS, HOLIDAYS } from './personCatalog.js';
export {
  VoiceTrainingStore, voiceTrainingBackup, makeVoiceTrainingHandler, voiceTrainingBlobRoutes,
  parseCredentials as voiceTrainingParseCredentials, backupCredentials, voiceTrainingAccountId,
  VOICE_TRAINING_OPERATIONS, VOICE_TRAINING_UNSUPPORTED_OPERATIONS, VOICE_TRAINING_TARGET_PREFIXES,
  VOICE_TRAINING_PATH_ROOT, VOICE_TRAINING_MAX_BYTES, VOICE_TRAINING_RECORD_FIELDS,
  VOICE_TRAINING_ACCOUNT_REQUIRED, VOICE_TRAINING_BLOB_ROUTE, VOICE_TRAINING_VALIDATORS,
} from './voiceTraining.js';

const netUrl = (name, defPort) => {
  const v = process.env[`NET_${name}`];
  if (!v) return `http://localhost:${defPort}`;
  return /^https?:\/\//.test(v) ? v : `http://${v}`;
};

const GQA_ACCOUNT_SERVICE_ENV = 'ETCO_server_accountService';
const GQA_ATTRIBUTION_FILE_ENV = 'ETCO_gqa_attributionFile';

const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

/** Apply the SigV4 caller boundary to a non-X-Amz-Target route. */
function verifiedDirectRoute(handler, callerBoundary) {
  const guarded = async (context) => {
    if (!callerBoundary) return handler(context);
    const { req, res, body, target, op, log } = context;
    try {
      // Express initializes an absent request body to `{}`.  For an entityless
      // GET/HEAD that is not the wire representation (and would make a valid
      // SigV4 empty-payload signature fail), so authenticate the actual empty
      // entity instead.
      const wireBody = req.rawBody !== undefined
        ? req.rawBody
        : ['GET', 'HEAD'].includes(String(req.method || '').toUpperCase())
          ? ''
          : body === undefined || body === null ? '' : body;
      const caller = await callerBoundary({ req, res, body: wireBody, target, op, log });
      if (!caller) throw new Error('verified caller boundary returned no identity');
      return await handler({ ...context, caller });
    } catch (error) {
      if (!res.writableEnded) sendVerifiedCallerError(res, error);
      return undefined;
    } finally {
      await cleanupVerifiedClassicRequest(req);
    }
  };
  // createService inspects these handler properties before invoking the route. Preserve the
  // raw-body/parser metadata across the auth wrapper so streamed uploads are never JSON parsed.
  for (const property of ['rawBody', 'bodyLimit', 'parserError', 'jsonStrict', 'jsonTypes']) {
    if (Object.prototype.hasOwnProperty.call(handler, property)) guarded[property] = handler[property];
  }
  return guarded;
}

function verifiedDirectRoutes(routes, callerBoundary) {
  if (!callerBoundary) return routes;
  return Object.fromEntries(Object.entries(routes).map(([route, handler]) => [
    route,
    verifiedDirectRoute(handler, callerBoundary),
  ]));
}

function httpPeerUrl(value) {
  if (typeof value !== 'string' || value.length === 0) return value;
  return /^https?:\/\//i.test(value) ? value : `http://${value}`;
}

function accountLookupFromObject(value) {
  if (typeof value === 'function') return value;
  if (value && typeof value.getLoopId === 'function') return value.getLoopId.bind(value);
  if (value && typeof value.get_loop_id === 'function') return value.get_loop_id.bind(value);
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const config = { ...value };
    if (config.endpoint !== undefined) config.endpoint = httpPeerUrl(config.endpoint);
    if (config.baseUrl !== undefined) config.baseUrl = httpPeerUrl(config.baseUrl);
    return createPhoenixGqaAccountLookup(config);
  }
  throw new TypeError('Classic GQA account configuration must be a function or mapping');
}

function defaultGqaAccountLookup(options) {
  if (own(options, 'accountLookup') && options.accountLookup !== undefined) return options.accountLookup;
  if (own(options, 'account') && options.account !== undefined && options.account !== null) {
    return accountLookupFromObject(options.account);
  }

  const configuredEndpoint = options.accountEndpoint
    || options.accountServiceEndpoint
    || process.env[GQA_ACCOUNT_SERVICE_ENV];
  if (configuredEndpoint) {
    // The source ETCO_server_accountService setting is the complete endpoint
    // consumed by gqa/account.py. Keep that meaning for explicit Classic
    // configuration; `account: { baseUrl }` is the unambiguous Phoenix form.
    return createPhoenixGqaAccountLookup({ endpoint: httpPeerUrl(configuredEndpoint) });
  }

  // NET_account is the same private peer used by Classic's OOBE/Account/Loop
  // proxies. Keep GQA on that boundary and derive the source internal route;
  // no public account URL or provider endpoint is selected implicitly.
  return createPhoenixGqaAccountLookup({ baseUrl: netUrl('account', DefaultPort.account) });
}

function attributionStoreFromValue(value, clock) {
  // A custom Classic attribution handler may only need the source search face;
  // retain that explicit seam when Question itself is also injected.
  if (typeof value === 'function') return value;
  if (value && typeof value.search === 'function') return value;
  if (value && typeof value === 'object' && !Array.isArray(value) && value.file) {
    return createGqaFileAttributionStore({ ...value, clock });
  }
  if (value === undefined || value === null) return undefined;
  throw new TypeError('Classic GQA attribution must be a store or file mapping');
}

/**
 * Compose Classic's production GQA route from the source-shaped handler and
 * the private Phoenix Account/durable attribution seams. Provider clients are
 * deliberately absent unless a caller supplies `gqaProvider` or `providers`.
 * Explicit handler/store/account options remain replaceable for focused
 * tests and deployments.
 */
export function createClassicGqa(gqa = {}) {
  if (gqa !== undefined && gqa !== null
    && (typeof gqa !== 'object' || Array.isArray(gqa))) {
    throw new TypeError('Classic GQA configuration must be a mapping');
  }
  const options = gqa || {};
  const clock = typeof options.clock === 'function' ? options.clock : Date.now;
  const accountLookup = defaultGqaAccountLookup(options);
  const configuredAttribution = own(options, 'attribution')
    ? options.attribution
    : own(options, 'store') ? options.store : undefined;
  const attribution = attributionStoreFromValue(configuredAttribution, clock)
    || createGqaFileAttributionStore({
      file: options.attributionFile
        || process.env[GQA_ATTRIBUTION_FILE_ENV]
        || GQA_ATTRIBUTE_DEFAULT_FILE,
      clock: typeof options.attributionClock === 'function' ? options.attributionClock : clock,
    });
  const question = options.structQaHandler
    || options.question
    || options.questionHandler
    || options.structQA;
  const questionAttribution = attribution && typeof attribution.insert === 'function'
    ? attribution : undefined;
  const structQaHandler = question || createStructQaHandler({
    ...options,
    accountLookup,
    attribution: questionAttribution,
    clock,
  });

  return {
    ...options,
    accountLookup,
    attribution,
    structQaHandler,
  };
}

function isNotificationTarget(req) {
  return /^notification[^.]*\./i.test(String(req?.headers?.['x-amz-target'] || ''));
}

function isCreateHubTokenTarget(req) {
  return /\.createhubtoken$/i.test(String(req?.headers?.['x-amz-target'] || ''));
}

function isLoopTarget(req) {
  return /^loop[^.]*\./i.test(String(req?.headers?.['x-amz-target'] || ''));
}

function isAccountTarget(req) {
  return /^account/i.test(String(req?.headers?.['x-amz-target'] || ''));
}

/** Build the entrypoint's route table. `extra` registrations are prepended (later iterations). */
export function classicRoutes(hub, extra = [], { notificationAccountResolver, logStore, baseFor, callerBoundary, media, keyStore, keyMembership, keyBinaryDir, rom, robotStore, key, ifttt, nlp, person, collision, gqa, jot, voiceTraining } = {}) {
  const mediaStore = media?.store || new MediaStore();
  const personStore = person?.store || new PersonStore();
  const jotStore = jot?.store || new JotStore();
  // One registry backs both the push face and the Jot fan-out, so a device
  // registered through Push_20160729 actually receives Jot notifications.
  const pushRegistry = jot?.pushRegistry || new DeviceRegistry();
  // server/push-ws consumed JotMessageCreated off Kafka and pushed toeach member's
  // devices. The bus is gone; the consumer is reproduced and wired directly to
  // the producer's onEvent sink. An explicit jot.onEvent still wins.
  const jotFanOut = jot?.onEvent || createJotMessageCreatedConsumer({
    account: jot?.account,
    registry: pushRegistry,
    store: jotStore,
    push: jot?.push,
    jotSettings: jot?.jotSettings,
  });
  const voiceTrainingStore = voiceTraining?.store || new VoiceTrainingStore();
  const keys = keyStore || new KeyStore();
  const robots = robotStore || new RobotStore();
  // The membership seam the key handler resolves to. An absent `keyMembership` means the default
  // Account peer routes, and the wake-up must resolve the loop the SAME way the membership check
  // just did — building it from the raw option instead left the notifier with no `loop()` and
  // silently fanned every KeyNeeded out to all siblings (observed on Moth 2026-09-10).
  const keyMembershipSeam = keyMembership || accountMembership();
  const router = createClassicRouter([
    ...extra,
    { match: /^log/i, handler: makeLogHandler(logStore || new LogStore(), baseFor, { callerBoundary }) },
    { match: /^robot/i, handler: makeRobotHandler({ store: robotStore || new RobotStore(), callerBoundary }) },
    { match: /^notification/i, handler: makeNotificationHandler(hub, { accountResolver: notificationAccountResolver, callerBoundary }), preserveBody: true, bodyDefault: null },
    { match: /^key/i, handler: makeKeyHandler(keys, {
      membership: keyMembershipSeam, baseFor, binaryDir: keyBinaryDir,
      accountResolver: key?.accountResolver,
      callerBoundary,
      // The robot's immediate wake-up on CreateRequest (source: SNS KeyNeeded to the siblings).
      notifyKeyNeeded: makeKeyNeededNotifier(hub, keyMembershipSeam),
    }) },
    { match: /^push/i, handler: makePushHandler(pushRegistry, { callerBoundary }) },
    // Media_20160725 owns a real store: the app's Gallery reads it and the robot writes photos to
    // it. Registered before the tier-3 stubs so the media stub never answers for it.
    { match: /^media/i, handler: makeMediaHandler({
      store: mediaStore,
      baseFor,
      accountResolver: media?.accountResolver,
      loops: media?.loops,
      credentials: media?.credentials,
      callerBoundary,
    }) },
    { match: /^rom/i, handler: makeRomHandler({ ...(rom || {}), callerBoundary }) }, // ROM_20171011 cert exchange (A-16)
    // IFTTT_20170207 and NLP_20161031 are real handlers now (source-faithful contracts with
    // explicit dead-provider seams), registered before the tier-3 stubs so they win.
    { match: /^ifttt/i, handler: makeIftttHandler(ifttt || {}) },
    { match: /^nlp/i, handler: makeNlpHandler(nlp || {}) },
    // Person_20160801 (questions/answers, properties, holidays) and Collision_20161126 (phonetic
    // username collision) own real handlers now (A-15), registered ahead of the tier-3 stubs.
    { match: /^person/i, handler: makePersonHandler({
      store: personStore, account: person?.account, questions: person?.questions,
      holidays: person?.holidays, now: person?.now, callerBoundary,
    }) },
    { match: /^collision/i, handler: makeCollisionHandler(collision || {}) },
    // The source GQA API is a Classic AWS target whose security-gateway hop routes Question to
    // Flask /structQA and ListAttribution to /retrieveAtt. Question is injected so this wire
    // adapter does not duplicate the parallel Q-01 provider/orchestration implementation.
    // Unanchored, like every other prefix here. The pinned client's targetPrefix is
    // `GQA_20160930`, but the shipping phone app sends `GQA_20160930s.ListAttribution`
    // — observed live on 2026-09-17, and answered `no service for target` because the
    // `$` anchor rejected the trailing character. GQA was the only anchored entry in
    // this table, so it was the only one that could miss a version suffix, and the
    // effect was that answer history never loaded in the app.
    { match: /^gqa_20160930/i, handler: makeGqaHandler(gqa || {}), ...GQA_ROUTE_OPTIONS },
    // Jot (the loop-scoped family messaging surface) owns a real handler now — the five loop-era
    // operations of server/jot-ws@9a725d3, dispatched by operation name under any Jot* prefix. The
    // media seam defaults to the in-process Media store so a message's parts carry real urls.
    { match: /^jot/i, handler: makeJotHandler({
      store: jotStore,
      account: jot?.account,
      media: jot?.media || mediaStoreClient(mediaStore, { accountLoops: jot?.accountLoops }),
      onEvent: jotFanOut,
    }) },
    // VoiceTraining (the robot's voice-sample enrollment store) owns a real handler now — the two
    // operations of server/voice-ws@a0ec047a, dispatched by operation NAME under any
    // VoiceTraining* prefix (the source splits the target on the dot). The file operations of the
    // later SDK models have no recovered handler and answer the source's own 404. The Backup hop is
    // the injected seam; its default is an in-process read/write of the same durable store.
    { match: /^voicetraining/i, handler: makeVoiceTrainingHandler({
      store: voiceTrainingStore,
      backup: voiceTraining?.backup,
      baseFor,
      callerBoundary,
      maxBytes: voiceTraining?.maxBytes,
    }) },
    ...stubRegistrations(), // build-to-spec tier-3 stubs (none remain: person/collision/jot/voiceTraining graduated)
    { match: /^oobe/i, proxyTo: () => netUrl('account', DefaultPort.account) },
    { match: /^account/i, proxyTo: () => netUrl('account', DefaultPort.account) },
    { match: /^loop/i, proxyTo: () => netUrl('account', DefaultPort.account) },
    { match: /^settings/i, proxyTo: () => netUrl('account', DefaultPort.account) },
    { match: /^update/i, proxyTo: () => netUrl('ota', DefaultPort.ota) },
  ], { callerBoundary });
  return router;
}

/**
 * The Original Cloud woke the robot with an SNS `KeyNeeded` publish to the loop's sibling
 * machines (srv-key-ws shares KeyNeeded with getSiblingIds; the robot's NotificationSubsystem
 * consumed it). Phoenix has no SNS, but the robot already holds the equivalent channel open —
 * `Notification_20150505.NewRobotToken` then a websocket to `{region}-socket.jibo.com/{token}` —
 * and jibo-server-service relays every frame it receives to jibo-sts's local
 * `ws://127.0.0.1:8888/server/notifications`. jibo-sts emits `KeyNeeded` and answers the request
 * at once, instead of waiting out its 30-minute incoming-request poll.
 *
 * Target: the loop's robot account (the member that originates and holds the UGC key). When the
 * loop document cannot be resolved the fan-out falls back to every sibling account, which is the
 * source's own sibling semantics. The notification carries no key material — only the loopId.
 */
export function makeKeyNeededNotifier(hub, membership) {
  const log = logger('classic.key');
  return async function notifyKeyNeeded({ loopId, siblingAccountIds }) {
    const siblings = Array.isArray(siblingAccountIds) ? siblingAccountIds.map(String) : [];
    let loop;
    try {
      loop = typeof membership?.loop === 'function' ? await membership.loop(loopId) : undefined;
    } catch { loop = undefined; }
    const robot = loop && loop.robot != null ? String(loop.robot) : null;
    const targets = robot ? [robot] : siblings;
    if (!robot) {
      // Verifying a loop is one Account peer call; when it cannot be read the request still
      // must not go unanswered, so fall back to the source's sibling fan-out and say so.
      log.warn('key needed wake-up: loop unresolved, notifying every sibling', {
        loopId: String(loopId), accountIds: targets,
      });
    } else {
      log.info('key needed wake-up', { loopId: String(loopId), accountIds: targets });
    }
    for (const accountId of targets) {
      if (accountId === undefined || accountId === null || accountId === '') continue;
      hub.enqueueNotification({
        accountId,
        skillId: '-1',
        notification: { name: 'KeyNeeded', payload: { loopId: String(loopId) } },
      });
    }
  };
}

/**
 * The classic-service entrypoint. Returns { service, listen, hub, wss }. The notification
 * socket (the wss push door) is attached to the same HTTP server — the robot reaches the REST
 * face and the socket on one host (path /socket/<token>).
 */
export function createClassicEntrypoint({ extra = [], tls, publicUrl, publicOrigin, requirePublicUrl, callerBoundary, notificationFile, notificationStore, notificationClock, notificationTtlMs, notificationPollIntervalMs, notificationAccountResolver, backupOwnership, backup, log, media, key, keyStore, keyMembership, keyBinaryDir, rom, robotStore, ifttt, nlp, person, collision, gqa, jot, voiceTraining } = {}) {
  const configuredOrigin = configuredPublicOrigin({ publicUrl, publicOrigin });
  if ((requirePublicUrl === true || (requirePublicUrl === undefined && !!callerBoundary)) && !configuredOrigin) {
    throw new PublicOriginError('publicUrl is required for an authenticated Classic entrypoint');
  }
  const classicGqa = createClassicGqa(gqa);
  const hub = new NotificationHub({
    file: notificationFile,
    store: notificationStore,
    clock: notificationClock,
    notificationTtlMs,
    pollIntervalMs: notificationPollIntervalMs,
  });
  const backups = backup?.store || new BackupStore(backup?.dir, {
    maxBytes: backup?.maxBytes,
    bearerSecret: backup?.bearerSecret,
    clock: backup?.clock,
    urlExpirationMs: backup?.urlExpirationMs,
  });
  const loopbackBackupOptIn = backup?.allowLoopbackWithoutIdentity === true
    || process.env.ETCO_classic_backupTrustedLoopback === 'true';
  const effectiveBackupOwnership = (backupOwnership || loopbackBackupOptIn)
    ? { ...(backupOwnership || {}), ...(loopbackBackupOptIn ? { allowLoopbackWithoutIdentity: true } : {}) }
    : undefined;
  const keys = keyStore || new KeyStore();
  const robots = robotStore || new RobotStore();
  // Never consult request Host for a bearer destination. Keep the legacy Host fallback only for
  // unauthenticated standalone tests; an authenticated deployment must configure its origin.
  const baseFor = (req) => {
    if (configuredOrigin) return configuredOrigin;
    if (callerBoundary) throw new PublicOriginError('publicUrl is required to emit an object URL');
    return process.env.ETCO_classic_publicUrl
      || `${req?.socket?.encrypted ? 'https' : 'http'}://${(req?.headers && req.headers.host) || 'localhost'}`;
  };
  const logStore = log?.store || new LogStore(log?.dir, { maxBytes: log?.maxBytes });
  const mediaStore = media?.store || new MediaStore(media || {});
  const iftttStore = ifttt?.store || new IftttStore({
    // The original stored Identity/Trigger/Action/TriggerMedia in Mongo; the durable file keeps
    // that state across a restart (ETCO_classic_iftttFile, default $TMPDIR/phoenix-ifttt.json).
    file: ifttt?.file,
    clock: ifttt?.clock,
    newId: ifttt?.newId,
    phonetic: ifttt?.phonetic,
  });
  const personStore = person?.store || new PersonStore();
  const jotStore = jot?.store || new JotStore();
  const jotMedia = jot?.media || mediaStoreClient(mediaStore, { accountLoops: jot?.accountLoops });
  const voiceTrainingStore = voiceTraining?.store || new VoiceTrainingStore();
  const pushRegistry = jot?.pushRegistry || new DeviceRegistry();
  const service = createService({
    name: 'classic',
    tls,
    // The Hapi-backed Account boundary validates primitive JSON values after
    // parsing. Notification's Hapi validator also needs null/scalar payloads
    // intact to reject them before token mutation. Other routes stay strict.
    jsonStrict: (req) => !isCreateHubTokenTarget(req) && !isNotificationTarget(req) && !isLoopTarget(req) && !isAccountTarget(req),
    routes: {
      ...classicRoutes(hub, [...extra, { match: /^backup/i, handler: makeBackupHandler(backups, baseFor, { ownership: effectiveBackupOwnership, callerBoundary }) }], {
        notificationAccountResolver,
        callerBoundary,
        logStore,
        baseFor,
        media: { ...media, store: mediaStore },
        key,
        keyStore: keys,
        keyMembership,
        keyBinaryDir,
        rom,
        robotStore: robots,
        ifttt: { ...ifttt, store: iftttStore },
        nlp: nlp || { provider: nlpProviderFromEnv() },
        person: { store: personStore, account: person?.account, questions: person?.questions, holidays: person?.holidays, now: person?.now },
        collision: collision || {},
        gqa: classicGqa,
        jot: { ...jot, store: jotStore, media: jotMedia, pushRegistry },
        voiceTraining: { ...voiceTraining, store: voiceTrainingStore },
      }),
      // Jot's direct, non-X-Amz-Target bulk unread-count route (srv-jot-ws-archived src/routes/route.js).
      ...verifiedDirectRoutes(jotHttpRoutes({ store: jotStore, account: jot?.account, media: jotMedia, onEvent: jot?.onEvent }), callerBoundary),
      // Push's web-portal read sidecar (the AWS surface has no list op).
      ...verifiedDirectRoutes(pushRoutes(pushRegistry, { callerBoundary }), callerBoundary),
      // VoiceTraining's self-hosted blob route: the `url` virtual of the legacy Backup record
      // (schemes/backup.js) pointed at an S3 presigned GET; Phoenix serves the bytes itself.
      ...verifiedDirectRoutes(voiceTrainingBlobRoutes(voiceTrainingStore, { callerBoundary }), callerBoundary),
      // Account owns the photo objects. Keep the URL on the same public
      // Classic/TLS origin that the robot already reaches.
      'GET /member-photos/:key': verifiedDirectRoute(({ req, res, log, caller }) => proxyMemberPhoto({
        baseUrl: netUrl('account', DefaultPort.account),
        key: req.params.key,
        req,
        res,
        log,
        caller,
      }), callerBoundary),
      ...backupBlobRoutes(backups), // PUT/GET /backup/blob — the self-hosted store the URLs point at
      ...keyRoutes(keys, { membership: keyMembership, baseFor, binaryDir: keyBinaryDir, callerBoundary }), // POST /binaryRequest, /deleteBinaries, GET /key/binary
      ...verifiedDirectRoutes(logHttpRoutes(logStore, { callerBoundary }), callerBoundary),  // PUT/GET /log/upload|blob — the log/ASR/binary sink the URLs point at
      ...verifiedDirectRoutes(mediaBlobRoutes(mediaStore, { callerBoundary }), callerBoundary), // GET /media/blob/:path — the object bytes behind a Media url
      // Internal enqueue: push a notification to a robot's account (portal/system/tests use this).
      'POST /notify': verifiedDirectRoute(({ res, body, caller }) => {
        const accountId = caller?.accountId || body?.accountId;
        if (!accountId) return sendJson(res, 400, { error: 'accountId required' });
        const notification = Object.prototype.hasOwnProperty.call(body || {}, 'notification')
          ? body.notification
          : Object.prototype.hasOwnProperty.call(body || {}, 'payload') ? body.payload : {};
        const n = hub.enqueueNotification({
          accountId,
          skillId: body.skillId === undefined ? '-1' : body.skillId,
          notification,
        });
        return { queued: n._id };
      }, callerBoundary),
    },
  });
  const wss = attachNotificationSocket(service.server, hub);
  hub.startDelivery();
  service.server.on('close', () => hub.stopDelivery());
  return {
    ...service,
    hub,
    wss,
    backups,
    logStore,
    mediaStore,
    keys,
    iftttStore,
    personStore,
    jotStore,
    voiceTrainingStore,
    gqa: classicGqa,
  };
}

/**
 * The executable Classic service must never fall back to the historical LAN-trust entrypoint.
 * A standalone process gets the Account snapshot through an explicit read-only path (the
 * colocated parity launcher sets ETCO_account_dataFile); deployments that construct the
 * entrypoint directly may inject createVerifiedClassicCaller themselves. Reload on atomic-file
 * replacement so access-key rotation/revocation is visible without restarting Classic.
 */
async function productionCredentialResolver() {
  const file = process.env.ETCO_classic_accountDataFile || process.env.ETCO_account_dataFile;
  if (!file) throw new Error('ETCO_classic_accountDataFile or ETCO_account_dataFile is required for the public Classic service');
  const { Store } = await import('../../account/src/store.js');
  let store = new Store(file);
  let mtime = accountStoreMtime(file);
  return (accessKeyId) => {
    const current = accountStoreMtime(file);
    if (current !== mtime) {
      store = new Store(file);
      mtime = current;
    }
    return store.accountByAccessKeyId(accessKeyId);
  };
}

function accountStoreMtime(file) {
  try {
    const stat = statSync(file);
    return `${stat.mtimeNs ?? stat.mtimeMs}:${stat.size}:${stat.ino}`;
  } catch { return 'missing'; }
}

export async function start(port = Number(process.env.PORT) || DefaultPort.classic) {
  const resolveCredentials = await productionCredentialResolver();
  const callerBoundary = createVerifiedClassicCaller({
    resolveCredentials,
    allowNativeClientPayloadHash: true,
  });
  return createClassicEntrypoint({
    publicUrl: process.env.ETCO_classic_publicUrl || process.env.CLASSIC_PUBLIC_URL,
    requirePublicUrl: true,
    callerBoundary,
  }).listen(port);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  start().catch((e) => { console.error(e); process.exit(1); });
}
