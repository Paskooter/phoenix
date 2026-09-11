// History service (Pegasus history equivalent). Milestone M3 + I-01 wire parity.
//
// Pegasus HistoryService mounts a SkillLaunchRequestsHandler at /v1/skill/launch and a
// SpeechHistoryRequestsHandler at /v1/speech, each an Express router with these sub-routes:
//   POST /v1/skill/launch            save a skill-launch record      -> full SkillLaunchRecord
//   PUT  /v1/skill/launch/payload    attach payload to a launch      -> updated record | null
//   GET+POST /v1/skill/launch/latest latest record matching an IHQuery -> record | null
//   GET+POST /v1/skill/launch/count  count of records matching an IHQuery -> { count }
//   POST /v1/speech                  write a speech record           -> { id }
//   PUT  /v1/speech/:id              partial (non-erasing) update    -> { id } | 500 on unknown id
//   GET  /healthcheck                base-service route (createService) -> 'ok'
//
// GET /latest and /count take the IHQuery from the Express query string (same Express/qs parsing
// as the reference — values inside array rules arrive as strings, identical to Pegasus). The bare
// (non-/v1) aliases are kept for older phoenix-internal callers (documented Phase A extension).

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createService, logger, parseServiceArgs, serviceCliPort, serviceHelp, runService } from '@phoenix/common';
import { DefaultPort } from '@phoenix/contracts';
import { HistoryStore } from './store.js';
import { validateEvent, validateQuery } from './validators.js';

// I-03: the running service is durable, exactly as the reference (rows live in Mongo, not process
// memory). `./data` sits inside the compose bind mount (`./packages:/phoenix/packages`), so the
// snapshot also survives a container recreate. A test constructing `new HistoryStore()` with no
// file stays process-local, so unit tests never share state.
const DEFAULT_DATA_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'store.json');

/** Durable snapshot path for the history service (`ETCO_history_dataFile` overrides the default). */
export function historyStoreFile(env = process.env) {
  return env.ETCO_history_dataFile || DEFAULT_DATA_FILE;
}

export function createHistoryService(store = new HistoryStore()) {
  // Validation lives in the handler layer exactly as the reference puts it in
  // SkillLaunchRequestsHandler (not in the collection):
  //   saveSkillLaunch/saveSkillPayload  -> data.timestamp = data.timestamp || Date.now();
  //                                        validators.event.validate(data); then the db call
  //   getLatestSkillLaunch/getEventsCount -> validators.query.validate(query); then the db call
  // So an invalid write is never persisted and an invalid query never reaches the store.
  const handlers = {
    'POST /skill/launch': ({ body }) => {
      body.timestamp = body.timestamp || Date.now();
      validateEvent(body);
      return store.addSkillLaunch(body);
    },
    'PUT /skill/launch/payload': ({ body }) => {
      body.timestamp = body.timestamp || Date.now();
      validateEvent(body);
      return store.saveSkillPayload(body); // record | null
    },
    'POST /skill/launch/latest': ({ body }) => {
      validateQuery(body);
      return store.getLatest(body);
    },
    'GET /skill/launch/latest': ({ req }) => {
      validateQuery(req.query);
      return store.getLatest(req.query);
    },
    'POST /skill/launch/count': ({ body }) => {
      validateQuery(body);
      return { count: store.getCount(body) };
    },
    'GET /skill/launch/count': ({ req }) => {
      validateQuery(req.query);
      return { count: store.getCount(req.query) };
    },
    'POST /speech': ({ body }) => ({ id: store.addSpeech(body) }),
    'PUT /speech/:id': ({ req, body }) => ({ id: store.updateSpeech(req.params.id, body) }),
  };
  // Mount each route at /v1/<path> (the reference wire shape) AND bare (legacy alias).
  const routes = {};
  for (const [key, fn] of Object.entries(handlers)) {
    const [method, path] = key.split(' ');
    routes[`${method} /v1${path}`] = fn;
    routes[key] = fn;
  }
  return createService({ name: 'history', routes });
}

export function start(port = Number(process.env.PORT) || DefaultPort.history) {
  return createHistoryService(new HistoryStore(historyStoreFile())).listen(port);
}

export { HistoryStore } from './store.js';
export { buildPredicate, resolveMatch, MatchMethod, RuleField } from './query.js';
export { validateEvent, validateQuery, validateRule, ValidationError } from './validators.js';

// Executable boundary: source History scripts/run-service.js resolves the port from
// argv/ETCO_server_port, logs its success line and closes the service on SIGINT/SIGTERM.
// Its help branch is a plain `return`, so the source reports "Service didn't return promise".
if (import.meta.url === `file://${process.argv[1]}`) {
  runService('History', () => {
    const argv = parseServiceArgs();
    if (argv.h || argv.help) {
      console.log(serviceHelp(process.argv[1]));
      return;
    }
    const port = serviceCliPort({ fallback: DefaultPort.history });
    return start(port).then((server) => {
      logger('history').info(`History service is successfully started on port ${port}`);
      process.on('SIGINT', () => server.close());
      process.on('SIGTERM', () => server.close());
    });
  });
}