// Gateway service (Pegasus hub equivalent). Milestone M6.
//
// Contract to fulfil (docs/atlas/packages/hub.md, docs/atlas/message-protocol.md):
//   WS   /v1/listen     one socket == one transaction; text=JSON BaseMessage, binary=PCM.
//                       State machine WAIT_LISTEN -> (ASR|WAIT_CLIENT_*) -> NLU -> ROUTE -> DONE.
//                       Emits SOS/EOS, a (non-final for cloud-skill) LISTEN, then the skill's
//                       SKILL_ACTION verbatim (overwriting only `final`/`timings`).
//   WS   /v1/proactive  TRIGGER + CONTEXT -> PROACTIVE or PROACTIVE_LAUNCH to a skill.
//   GET  /v1/skills/:robotId[/settings]   skill list for a robot.
//   GET  /healthcheck   (free, provided by the runner)
//
// Auth rides the WS upgrade (JWT vs ETCO_server_hubTokenSecret); ETCO_hub_disableAuth=true
// skips it and defaults identity to anonymous-account/anonymous-robot.
//
// WS handling will be wired through createService({ onUpgrade }) in M6 (needs the `ws`
// dependency). Until then only /healthcheck answers.

import { createService } from '@phoenix/common';
import { errorResponse, HubErrorCode, DefaultPort } from '@phoenix/contracts';

const { listen } = createService({
  name: 'gateway',
  routes: {
    'GET /v1/skills': () =>
      errorResponse('skill listing not implemented (milestone M6)', HubErrorCode.NOT_IMPLEMENTED),
  },
});

listen(Number(process.env.PORT) || DefaultPort.gateway);
