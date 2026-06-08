// History service (Pegasus history equivalent). Milestone M3.
//
// Contract to fulfil (docs/atlas/packages/history.md):
//   Skill-launch history: write records; query with the IH rule language (compiled to a
//     predicate) for the gateway's proactive engine. 14-day retention. Match rules:
//     EXACT payload via stored key-count; latest tie-broken by insertion order; no-match -> null
//     (not 404); non-erasing partial speech updates.
//   Speech/ASR history: write-only.
//
// Black-box HTTP behavior is the spec; the reference's behavioral suites (e.g. ComplexQueries,
// 32 cases) port directly. First leaf service to build — depends only on the contracts + a store.

import { createService } from '@phoenix/common';
import { errorResponse, HubErrorCode, DefaultPort } from '@phoenix/contracts';

const notImpl = (what) => () =>
  errorResponse(`${what} not implemented (milestone M3)`, HubErrorCode.NOT_IMPLEMENTED);

const { listen } = createService({
  name: 'history',
  routes: {
    'POST /skilllaunch': notImpl('write skill-launch'),
    'POST /skilllaunch/latest': notImpl('query latest skill-launch'),
    'POST /skilllaunch/count': notImpl('count skill-launch'),
    'POST /speech': notImpl('write speech history'),
  },
});

listen(Number(process.env.PORT) || DefaultPort.history);
