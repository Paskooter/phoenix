// History service (Pegasus history equivalent). Milestone M3.
//
// Routes (history-client/src/skill-launch/SkillLaunchHistoryClient.ts, speech/SpeechHistoryClient.ts):
//   POST /skill/launch          write a skill-launch record           -> { id }
//   PUT  /skill/launch/payload  attach payload to a launch            -> { id }
//   POST /skill/launch/latest   latest record matching an IHQuery     -> SkillLaunchRecord | null
//   POST /skill/launch/count    count of records matching an IHQuery  -> { count }
//   POST /speech                write a speech record                 -> { id }
//   PUT  /speech/:id            partial (non-erasing) speech update   -> { id }
//   GET  /healthcheck

import { createService, sendJson } from '@phoenix/common';
import { DefaultPort } from '@phoenix/contracts';
import { HistoryStore } from './store.js';

export function createHistoryService(store = new HistoryStore()) {
  return createService({
    name: 'history',
    routes: {
      'POST /skill/launch': ({ body }) => ({ id: store.addSkillLaunch(body).id }),
      'PUT /skill/launch/payload': ({ body }) => {
        const rec = store.saveSkillPayload(body);
        return rec ? { id: rec.id } : { id: null };
      },
      'POST /skill/launch/latest': ({ body }) => store.getLatest(body), // record or null
      'POST /skill/launch/count': ({ body }) => ({ count: store.getCount(body) }),
      'POST /speech': ({ body }) => ({ id: store.addSpeech(body) }),
    },
  });
}

export function start(port = Number(process.env.PORT) || DefaultPort.history) {
  const store = new HistoryStore();
  const svc = createHistoryService(store);
  // PUT /speech/:id needs a path param; handle it via the raw server (createService routes are
  // exact-match). We add a thin upgrade-free request hook here.
  const httpServer = svc.server;
  const existing = httpServer.listeners('request')[0];
  httpServer.removeAllListeners('request');
  httpServer.on('request', async (req, res) => {
    const m = req.url.match(/^\/speech\/([^/?]+)$/);
    if (req.method === 'PUT' && m) {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        let patch = {};
        try { patch = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}; } catch { /* ignore */ }
        const id = store.updateSpeech(m[1], patch);
        sendJson(res, 200, { id });
      });
      return;
    }
    existing(req, res);
  });
  return svc.listen(port);
}

export { HistoryStore } from './store.js';
export { buildPredicate, MatchMethod, RuleField } from './query.js';

if (import.meta.url === `file://${process.argv[1]}`) {
  start().catch((e) => { console.error(e); process.exit(1); });
}
