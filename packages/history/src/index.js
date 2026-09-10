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

import { createService } from '@phoenix/common';
import { DefaultPort } from '@phoenix/contracts';
import { HistoryStore } from './store.js';

export function createHistoryService(store = new HistoryStore()) {
  const handlers = {
    'POST /skill/launch': ({ body }) => store.addSkillLaunch(body),
    'PUT /skill/launch/payload': ({ body }) => store.saveSkillPayload(body), // record | null
    'POST /skill/launch/latest': ({ body }) => store.getLatest(body),
    'GET /skill/launch/latest': ({ req }) => store.getLatest(req.query),
    'POST /skill/launch/count': ({ body }) => ({ count: store.getCount(body) }),
    'GET /skill/launch/count': ({ req }) => ({ count: store.getCount(req.query) }),
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
  return createHistoryService(new HistoryStore()).listen(port);
}

export { HistoryStore } from './store.js';
export { buildPredicate, resolveMatch, MatchMethod, RuleField } from './query.js';

if (import.meta.url === `file://${process.argv[1]}`) {
  start().catch((e) => { console.error(e); process.exit(1); });
}