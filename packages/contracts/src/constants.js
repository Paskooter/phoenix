// Protocol constants. Sources cited as file:line into the Pegasus reference repo
// (jiboV2/pegasus@phoenix) via docs/atlas/message-protocol.md.

// Robot -> hub request discriminators (interfaces/src/hub/MessageType.ts:1-21).
export const RequestType = Object.freeze({
  LISTEN: 'LISTEN',
  CONTEXT: 'CONTEXT',
  TRIGGER: 'TRIGGER',
  CLIENT_ASR: 'CLIENT_ASR',
  CLIENT_NLU: 'CLIENT_NLU',
  // Declared in the reference but never handled on the listen path — kept for completeness.
  CMD_RESULT: 'CMD_RESULT',
});

// Hub -> robot response discriminators.
export const ResponseType = Object.freeze({
  SOS: 'SOS',
  EOS: 'EOS',
  LISTEN: 'LISTEN',
  NLU: 'NLU',
  SKILL_ACTION: 'SKILL_ACTION',
  SKILL_REDIRECT: 'SKILL_REDIRECT',
  PROACTIVE: 'PROACTIVE',
  ERROR: 'ERROR',
});

// Hub -> skill request discriminators (interfaces/src/skill/request.ts:7-38).
export const SkillRequestType = Object.freeze({
  LISTEN_LAUNCH: 'LISTEN_LAUNCH',
  LISTEN_UPDATE: 'LISTEN_UPDATE',
  PROACTIVE_LAUNCH: 'PROACTIVE_LAUNCH',
});

// Skill -> hub response discriminators (interfaces/src/skill/response.ts:9-51).
export const SkillResponseType = Object.freeze({
  SKILL_ACTION: 'SKILL_ACTION',
  SKILL_REDIRECT: 'SKILL_REDIRECT',
  ERROR: 'ERROR',
});

// Listen state-machine + transport timeouts in ms
// (ListenTransactionHandler.ts:37-43, BaseWebsocketHandler.ts:10-12).
export const Timeouts = Object.freeze({
  transaction: 60_000,
  asr: 40_000,
  context: 5_000,
  parser: 10_000,
  skill: 10_000,
  wsMax: 180_000,
  closeAfterFinal: 2_000,
});

// Error codes surfaced to the robot (interfaces/src/hub/HubErrorCode.ts).
export const HubErrorCode = Object.freeze({
  TIMEOUT_ASR: 'TIMEOUT_ASR',
  ASR: 'ASR',
  TIMEOUT_CONTEXT: 'TIMEOUT_CONTEXT',
  TIMEOUT_PARSER: 'TIMEOUT_PARSER',
  TIMEOUT_SKILL: 'TIMEOUT_SKILL',
  TOO_MANY_REDIRECTS: 'TOO_MANY_REDIRECTS',
  NOT_IMPLEMENTED: 'NOT_IMPLEMENTED',
  NOT_FOUND: 'NOT_FOUND',
  INTERNAL: 'INTERNAL',
  AUTH: 'AUTH',
});

// Default audio framing (interfaces/src/asr.ts:14-33).
export const AudioDefaults = Object.freeze({
  encoding: 'LINEAR16',
  sampleRate: 16_000,
  channels: 1,
});

// Cross-service trace headers (interfaces/src/service.ts:67-71). These MUST be
// propagated verbatim on every internal HTTP call (gotcha #12).
export const TraceHeaders = Object.freeze({
  transId: 'x-jibo-transid',
  robotId: 'x-jibo-robotid',
  loggingConfig: 'x-jibo-logging-config',
});

// Default listen ports per service. The reference ran every service on 8080 in-container
// with distinct host mappings; Phoenix gives each a distinct default for local side-by-side
// runs. Override with PORT or the service's ETCO_* var.
export const DefaultPort = Object.freeze({
  gateway: 7010,
  nlu: 7011,
  data: 7012,
  history: 7013,
  skills: 7014,
  ota: 7015,
  account: 7016,
  classic: 7017,
});
