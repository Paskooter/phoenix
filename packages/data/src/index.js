// Data-relay service (Pegasus lasso equivalent). Milestone M4.
//
// Contract to fulfil (docs/atlas/packages/lasso.md, message-protocol.md §9):
//   GET/HEAD /v1/dark_sky | /v1/google_maps | /v1/ap_news      relay+cache (HEAD = prefetch)
//   GET/POST/DELETE /v1/google_calendar | /v1/outlook_calendar OAuth-backed calendar
//   POST/GET/DELETE /v1/credential                             OAuth credential CRUD
//   Every relay responds { relayData, lassoDataFromRedis, lassoInsertedIntoRedisAt? }.
//   Cache TTLs: weather 15m, maps 15m, news 65m, calendar 60s.
//
// Phoenix substitutions (keep the response wrapper + downstream schema identical):
//   DarkSky -> Open-Meteo, AP News -> RSS (re-emitted as AP XML), Google Maps -> OpenRouteService.
// Preserve the weather day-index semantics (atlas risk R3) — decide before implementing.

import { createService } from '@phoenix/common';
import { errorResponse, HubErrorCode, DefaultPort } from '@phoenix/contracts';

const notImpl = (what) => () =>
  errorResponse(`${what} not implemented (milestone M4)`, HubErrorCode.NOT_IMPLEMENTED);

const { listen } = createService({
  name: 'data',
  routes: {
    'GET /v1/dark_sky': notImpl('weather relay'),
    'GET /v1/google_maps': notImpl('commute relay'),
    'GET /v1/ap_news': notImpl('news relay'),
    'GET /v1/google_calendar': notImpl('google calendar'),
    'GET /v1/outlook_calendar': notImpl('outlook calendar'),
    'POST /v1/credential': notImpl('credential store'),
  },
});

listen(Number(process.env.PORT) || DefaultPort.data);
