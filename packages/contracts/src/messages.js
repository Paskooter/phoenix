// JSON-Schema definitions for the messages that cross a process boundary.
//
// Field / enum / nullability / requiredness matrix built from the pinned Pegasus
// reference (packages/interfaces/src) AND its consumers (hub conv, skill-runtime,
// parser, hub-client), e.g.:
//   - ListenResult precedence (interfaces/src/hub/response.ts ListenResult.state)
//   - proactive requests/results (proactive/proactive.ts, hub/src/proactive/*)
//   - skill redirects and actions (skill/response.ts, skill/action.ts)
//   - JCP/display payloads (skill/action.ts + jibo-command-protocol v2 behaviors)
//   - manifests (skill/config.ts + hub/src/config/validation/SkillConfigValidator.ts)
//   - analytics (skill/analytics.ts, GraphSkill.track, optIn MIM SKILL_OFFER)
//
// Nullability rule: a field is `['x','null']` when the reference consumer actually
// emits or tolerates null (e.g. NLUResult.entities:null from the parser's EMPTY_NLU,
// ListenResponseData.asr/nlu on GARBAGE paths that pre-date emit sites, match:null).
// Requiredness rule: a field is `required` only when EVERY reference emitter always
// sets it AND at least one consumer depends on it. Everything else stays optional —
// a validator that rejects a valid optional field is a defect, not a feature.
// `additionalProperties` is left open everywhere except where the reference's own
// runtime validator is strict (manifests; see manifestSchema notes).

import {
  RequestType,
  ResponseType,
  SkillRequestType,
  ASRAnnotation,
  ListenMessageMode,
  ActionType,
} from './constants.js';

// --- shared building blocks -------------------------------------------------

/** Base envelope fields present on every message (service.ts:9-37). */
const envelopeProps = {
  type: { type: 'string' },
  msgID: { type: 'string' },
  ts: { type: 'number' },
};

/** final/timings that responses may carry (service.ts BaseResponse). */
const responseProps = {
  final: { type: 'boolean' },
  timings: { type: 'object' },
};

/**
 * GeneralData (jibo/data.ts:8-18). The hub's MessagePreProcessor injects defaults
 * for lang/release/remoteAddress, and MessageValidator only hard-requires
 * accountID/robotID (+release after defaulting), so lang/release are optional here
 * (missing values are legal input — the reference fills them in).
 */
export const generalDataSchema = {
  type: 'object',
  required: ['accountID', 'robotID'],
  properties: {
    accountID: { type: 'string' },
    robotID: { type: 'string' },
    lang: { type: 'string' },
    release: { type: 'string' },
    remoteAddress: { type: 'string' },
  },
};

/**
 * ASRConfig, or the literal string 'FAKE' (asr.ts:14-33; hub _performASR reads
 * `listenData.asr !== 'FAKE'`). All config fields optional per the interface.
 */
export const asrConfigSchema = {
  oneOfNote: "may also be the string 'FAKE'",
  type: ['object', 'string'],
  properties: {
    encoding: { type: 'string' },
    sampleRate: { type: 'number' },
    sosTimeout: { type: 'number' },
    maxSpeechTimeout: { type: 'number' },
    hints: { type: 'array', items: { type: 'string' } },
    earlyEOS: { type: 'array', items: { type: 'string' } },
  },
};

/**
 * ASR result (asr.ts:36-43). annotation only appears on timeouts/garbage paths.
 * confidence is always set by every emitter (Google, hub CLIENT_ASR path).
 */
export const asrResultSchema = {
  type: 'object',
  required: ['text', 'confidence'],
  properties: {
    text: { type: 'string' },
    confidence: { type: 'number' },
    annotation: {
      type: ['string', 'null'],
      enum: [null, ...Object.values(ASRAnnotation)],
    },
  },
};

/**
 * NLUResult (nlu.ts:66-82). The parser's EMPTY_NLU is `{intent:null, entities:null,
 * rules:[]}` (ParseRequestHandler.ts) — entities may be NULL, so both intent and
 * entities are nullable. `external` holds per-agent results (each with optional
 * `error`, per ExternalAgentResult).
 */
export const nluResultSchema = {
  type: 'object',
  required: ['rules', 'intent', 'entities'],
  properties: {
    rules: { type: 'array', items: { type: 'string' } },
    intent: { type: ['string', 'null'] },
    entities: { type: ['object', 'null'] },
    external: {
      type: 'object',
      additionalProperties: {
        type: 'object',
        required: ['rules', 'intent', 'entities'],
        properties: {
          rules: { type: 'array', items: { type: 'string' } },
          intent: { type: 'string' },
          entities: { type: 'object' },
          error: { type: 'string' },
        },
      },
    },
  },
};

/** GlobalMatchResponseData (common.ts:3-13). skillID is always set by every emitter. */
export const matchSchema = {
  type: ['object', 'null'],
  required: ['skillID'],
  properties: {
    skillID: { type: 'string' },
    onRobot: { type: 'boolean' },
    launch: { type: 'boolean' },
    isProactive: { type: 'boolean' },
    skipSurprises: { type: 'boolean' },
  },
};

/**
 * Skill session blob (jibo/data.ts SkillData.session). nodeID is the active graph
 * node; trace entries are {nodeID, transition}. id/nodeID are the fields every
 * writer sets; data/trace stay optional because a fresh session may carry `[]`.
 * transition is nullable because the reference GraphManager pushes
 * {nodeID, transition: null} on every enterNode and returns the action/redirect
 * before the transition is resolved (baseskill/src/graph/GraphManager.ts:84-91),
 * so a launch response legitimately carries trace [{nodeID, transition: null}].
 */
export const skillSessionSchema = {
  type: 'object',
  required: ['id', 'nodeID'],
  properties: {
    id: { type: 'string' },
    nodeID: { type: 'number' },
    data: { type: 'object' },
    trace: {
      type: 'array',
      items: {
        type: 'object',
        properties: { nodeID: { type: 'number' }, transition: { type: ['string', 'null'] } },
      },
    },
  },
};

// --- robot -> hub requests --------------------------------------------------

/** LISTEN (hub/request.ts:20-29). mode is an enforced enum (hub rejects others). */
export const listenRequestSchema = {
  type: 'object',
  required: ['type', 'data'],
  properties: {
    ...envelopeProps,
    type: { const: RequestType.LISTEN },
    data: {
      type: 'object',
      required: ['lang', 'rules'],
      properties: {
        lang: { type: 'string' },
        hotphrase: { type: 'boolean' },
        mode: { type: 'string', enum: Object.values(ListenMessageMode) },
        rules: { type: 'array', items: { type: 'string' } },
        asr: asrConfigSchema,
        agents: { type: 'object' },
      },
    },
  },
};

/** CLIENT_ASR (hub/request.ts:55-57). */
export const clientAsrRequestSchema = {
  type: 'object',
  required: ['type', 'data'],
  properties: {
    ...envelopeProps,
    type: { const: RequestType.CLIENT_ASR },
    data: {
      type: 'object',
      required: ['text'],
      properties: { text: { type: 'string' } },
    },
  },
};

/** CLIENT_NLU (hub/request.ts:58-59). data IS the NLUResult. */
export const clientNluRequestSchema = {
  type: 'object',
  required: ['type', 'data'],
  properties: {
    ...envelopeProps,
    type: { const: RequestType.CLIENT_NLU },
    data: nluResultSchema,
  },
};

/**
 * CONTEXT (hub/request.ts:30-33). The session carrier is data.skill; the hub's
 * MessageValidator only hard-requires general.accountID + general.robotID, and the
 * pre-processor injects lang/release defaults. runtime is the on-robot context.
 */
export const contextSchema = {
  type: 'object',
  required: ['type', 'data'],
  properties: {
    ...envelopeProps,
    type: { const: RequestType.CONTEXT },
    data: {
      type: 'object',
      required: ['general'],
      properties: {
        general: generalDataSchema,
        runtime: { type: 'object' },
        skill: {
          type: 'object',
          properties: {
            id: { type: ['string', 'null'] },
            session: skillSessionSchema,
          },
        },
      },
    },
  },
};

/**
 * Proactive TRIGGER (proactive/proactive.ts:29-36). triggerData is required at
 * runtime (reading triggerData.looperID without it rejects the transaction);
 * looperID itself is optional. triggerSource is NOT enum-checked by the reference
 * handler (only compared against SURPRISE), so it is typed `string` here — an
 * unknown source is accepted by the reference and must be accepted here too.
 */
export const triggerRequestSchema = {
  type: 'object',
  required: ['type', 'data'],
  properties: {
    ...envelopeProps,
    type: { const: RequestType.TRIGGER },
    data: {
      type: 'object',
      required: ['triggerSource', 'triggerData'],
      properties: {
        triggerSource: { type: 'string' },
        triggerData: {
          type: 'object',
          properties: { looperID: { type: 'string' } },
        },
      },
    },
  },
};

// --- hub <-> parser ---------------------------------------------------------

/** Hub -> parser NLU request (nlu.ts:42-53). loop carries trimmed LooperBasicInfo. */
export const nluRequestSchema = {
  type: 'object',
  required: ['type', 'data'],
  properties: {
    ...envelopeProps,
    type: { const: ResponseType.NLU },
    data: {
      type: 'object',
      required: ['text', 'rules'],
      properties: {
        text: { type: 'string' },
        rules: { type: 'array', items: { type: 'string' } },
        loop: {
          type: 'object',
          properties: {
            users: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  firstName: { type: 'string' },
                  lastName: { type: 'string' },
                },
              },
            },
          },
        },
        external: { type: 'object' },
      },
    },
  },
};

/** Parser -> hub NLU response (nlu.ts:86-87). data is the NLUResult. */
export const nluResponseSchema = {
  type: 'object',
  required: ['type', 'data'],
  properties: {
    ...envelopeProps,
    type: { const: ResponseType.NLU },
    data: nluResultSchema,
  },
};

// --- hub <-> skill ----------------------------------------------------------

/**
 * Hub -> skill request (skill/request.ts). Three flavors, discriminated by type:
 *   LISTEN_LAUNCH   data.result = { nlu, asr, memo? }
 *   LISTEN_UPDATE   data.result = { nlu, asr }   (skill.session REQUIRED, enforced by hub)
 *   PROACTIVE_LAUNCH data.result = { nlu?, memo? } (no asr)
 * The graph skills hard-require general.accountID/robotID and skill.id; everything
 * under result is optional because redirect launches may carry only a memo.
 */
export const skillRequestSchema = {
  type: 'object',
  required: ['type', 'data'],
  properties: {
    ...envelopeProps,
    type: { type: 'string', enum: Object.values(SkillRequestType) },
    data: {
      type: 'object',
      required: ['general', 'skill'],
      properties: {
        general: generalDataSchema,
        runtime: { type: 'object' },
        skill: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string' }, session: skillSessionSchema },
        },
        result: {
          type: 'object',
          properties: {
            nlu: { type: ['object', 'null'] },
            asr: { type: ['object', 'null'] },
            memo: {},
          },
        },
      },
    },
  },
};

/**
 * Skill -> hub response (skill/response.ts). Three shapes, all with a `skill`
 * context block:
 *   SKILL_ACTION  data = { skill, action: JCPAction|null, analytics?, final?, fireAndForget? }
 *   SKILL_REDIRECT data = { skillID, memo?, asr?, nlu?, skill }
 *   ERROR         data = { message, skill: { id } }   (code absent — BaseSkill sets none)
 * The hub only dispatches on `type` at runtime, and GraphSkill emits action:null on
 * terminal nodes, so nothing under data is required here (a stricter union would
 * reject valid terminal responses).
 */
export const skillResponseSchema = {
  type: 'object',
  required: ['type', 'data'],
  properties: {
    ...envelopeProps,
    type: { type: 'string', enum: ['SKILL_ACTION', 'SKILL_REDIRECT', 'ERROR'] },
    data: {
      type: 'object',
      properties: {
        skill: {
          type: 'object',
          properties: { id: { type: 'string' }, session: skillSessionSchema },
        },
        skillID: { type: 'string' },
        action: { type: ['object', 'null'], properties: { type: { type: 'string' } } },
        analytics: { $refNote: 'analyticsSchema (defined below)', type: 'object' },
        final: { type: 'boolean' },
        fireAndForget: { type: 'boolean' },
        message: { type: 'string' },
        code: { type: 'string' },
        memo: {},
        asr: asrResultSchema,
        nlu: nluResultSchema,
      },
    },
  },
};

// --- hub -> robot responses -------------------------------------------------

/**
 * LISTEN response (hub/response.ts ListenResponseData + ListenTransactionHandler
 * emitListenResult). asr/nlu/match keys are always present but may be null in
 * real flows (match:null on no-match; asr/nlu nulled on GARBAGE/client paths), so
 * they are nullable, not required. Interpretation precedence lives in
 * envelope.js listenResultState() — see ListenResultState.
 */
export const listenResponseSchema = {
  type: 'object',
  required: ['type', 'data'],
  properties: {
    ...envelopeProps,
    ...responseProps,
    type: { const: ResponseType.LISTEN },
    data: {
      type: 'object',
      properties: {
        asr: { type: ['object', 'null'] },
        nlu: { type: ['object', 'null'] },
        match: matchSchema,
      },
    },
  },
};

/**
 * SKILL_REDIRECT hub -> robot (TransactionHandler.emitSkillRedirectNotification).
 * The hub always wraps the redirect in match = { skillID, launch:true, onRobot };
 * memo/asr/nlu ride along when present.
 */
export const skillRedirectSchema = {
  type: 'object',
  required: ['type', 'data'],
  properties: {
    ...envelopeProps,
    ...responseProps,
    type: { const: ResponseType.SKILL_REDIRECT },
    data: {
      type: 'object',
      required: ['match'],
      properties: {
        match: matchSchema,
        memo: {},
        asr: asrResultSchema,
        nlu: nluResultSchema,
      },
    },
  },
};

/**
 * PROACTIVE response hub -> robot (proactive/ProactiveTransactionHandler).
 * Two legitimate shapes: data.match (a skill will launch) or data {} (no action —
 * emitNoActionResponse). A validator that requires match would reject valid input.
 */
export const proactiveResponseSchema = {
  type: 'object',
  required: ['type', 'data'],
  properties: {
    ...envelopeProps,
    ...responseProps,
    type: { const: ResponseType.PROACTIVE },
    data: {
      type: 'object',
      properties: { match: matchSchema },
    },
  },
};

/** ERROR response (HubErrorData; ListenHandler/emitSkillResult/BaseSkill). */
export const errorSchema = {
  type: 'object',
  required: ['type', 'data', 'final'],
  properties: {
    ...envelopeProps,
    ...responseProps,
    type: { const: ResponseType.ERROR },
    final: { const: true },
    data: {
      type: 'object',
      required: ['message'],
      properties: {
        message: { type: 'string' },
        code: { type: 'string' },
        skill: {
          type: 'object',
          properties: { id: { type: 'string' } },
        },
      },
    },
  },
};

/** SOS / EOS (data:null) (hop 5). */
export const eventResponseSchema = {
  type: 'object',
  required: ['type', 'data'],
  properties: {
    ...envelopeProps,
    ...responseProps,
    type: { type: 'string', enum: [ResponseType.SOS, ResponseType.EOS] },
    data: { type: 'null' },
  },
};

// --- JCP / display / analytics / manifests ----------------------------------

/**
 * JCP action (skill/action.ts:11-45). The only cloud skill action type. config
 * carries the protocol version and the behavior tree (jibo-command-protocol v2).
 * The behavior tree is intentionally an open object — its exact shape is the
 * robot-side requester's domain (SLIM/SEQUENCE/PARALLEL/DISPLAY/etc.), and skills
 * legitimately vary it (graph skills inject supplemental behaviors).
 */
export const jcpActionSchema = {
  type: 'object',
  required: ['type', 'config'],
  properties: {
    type: { const: ActionType.JCP },
    config: {
      type: 'object',
      required: ['version', 'jcp'],
      properties: {
        version: { type: 'string' },
        jcp: { type: 'object' },
      },
    },
  },
};

/**
 * Analytics payload (skill/analytics.ts AnalyticsData). Keyed by skill name to a
 * list of {event, properties} entries ('Skill Entry' from GraphSkill.track,
 * 'Skill Offer' from the opt-in MIM node).
 */
export const analyticsSchema = {
  type: 'object',
  additionalProperties: {
    type: 'array',
    items: {
      type: 'object',
      required: ['event'],
      properties: {
        event: { type: 'string' },
        properties: { type: 'object' },
      },
    },
  },
};

/** ContextRule (proactive/context.ts) — field/matchRule/value all required by the
 * hub's SkillConfigValidator at manifest load time. */
export const contextRuleSchema = {
  type: 'object',
  required: ['field', 'matchRule', 'value'],
  properties: {
    field: { type: 'string' },
    matchRule: {
      type: 'string',
      enum: ['EXACT', 'NOT', 'CONTAINS_ALL', 'CONTAINS_ANY', 'NOT_CONTAIN', 'GREATER_THAN', 'LESS_THAN', 'CONTAINED_IN'],
    },
    value: {},
  },
};

/** IHRule (proactive/history.ts:30-39). value is number|boolean|null|array only —
 * the hub validator rejects string values. */
export const ihRuleSchema = {
  type: 'object',
  required: ['query', 'matchRule', 'value'],
  properties: {
    query: { type: ['string', 'object'] },
    transform: { type: 'string', enum: ['TimeSince'] },
    checkProperty: { type: 'string' },
    matchRule: { type: 'string', enum: ['EXACT', 'NOT', 'GREATER_THAN', 'LESS_THAN'] },
    value: { type: ['number', 'boolean', 'null', 'array'] },
  },
};

/** SettingsRule (proactive/settings.ts). */
export const settingsRuleSchema = {
  type: 'object',
  required: ['skill', 'key', 'matchRule'],
  properties: {
    skill: { type: 'string' },
    key: { type: 'string' },
    matchRule: { type: 'string', enum: ['EXACT', 'NOT'] },
    value: {},
  },
};

/** IHQueryDefinition (proactive/history.ts:42-55). */
const ihQuerySchema = {
  type: 'object',
  required: ['type'],
  properties: {
    type: { type: 'string', enum: ['LastEvent', 'Count'] },
    personID: { type: 'string', enum: ['UNKNOWN', 'NONE', 'IDENTIFIED', 'FOCUSED_PERSON', 'ANY'] },
    queryRules: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          field: { type: 'string', enum: ['skillID', 'intent', 'personIDs', 'payload'] },
          key: { type: 'string' },
          match: { type: 'string', enum: ['EXACT', 'NOT', 'ONE_OF', 'CONTAINS', 'NOT_CONTAIN', 'CONTAINS_ANY', 'CONTAINS_ALL'] },
          value: {},
        },
      },
    },
    startTimeOffset: { type: ['array', 'string'] },
    endTimeOffset: { type: ['array', 'string'] },
  },
};

/** Manifest skill config (skill/config.ts ManifestSkillConfig). Real manifests also
 * carry extras (settings views add choices/links/oauth fields) so the view subtree
 * is open. Hub-side load validation additionally enforces strict no-unexpected-
 * property checks on ContextRule/IHRule/IHQuery/settingsRule — mirrored above via
 * required+enum, but NOT via additionalProperties:false (a manifest that loads in
 * the reference must validate here). */
export const manifestSchema = {
  type: 'object',
  required: ['id'],
  properties: {
    id: { type: 'string' },
    intents: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string' },
          memo: {},
          entities: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                value: { type: ['string', 'number', 'boolean'] },
                matchRule: { type: 'string', enum: ['EXACT', 'NOT'] },
              },
            },
          },
        },
      },
    },
    proactives: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          memo: {},
          topics: { type: 'array', items: { type: 'string' } },
          contextRules: { type: 'array', items: contextRuleSchema },
          IHRules: { type: 'array', items: ihRuleSchema },
          settingsRules: { type: 'array', items: settingsRuleSchema },
        },
      },
    },
    IHQueries: {
      type: 'object',
      additionalProperties: ihQuerySchema,
    },
    onRobot: { type: 'boolean' },
    basePath: { type: 'string' },
    settings: {
      type: 'object',
      properties: {
        view: {
          type: 'object',
          required: ['type', 'index'],
          properties: {
            type: { type: 'string' },
            index: { type: 'number' },
            title: { type: 'string' },
            subtitle: { type: 'string' },
            icon: { type: 'string' },
            valueDefinition: {
              type: 'object',
              properties: {
                target: { type: 'string', enum: ['loop', 'person', 'lasso'] },
                key: { type: 'string' },
                type: { type: 'string' },
                default: {},
              },
            },
            childViews: { $recursive: 'view' },
          },
        },
      },
    },
  },
};
// childViews is recursive — patch in a self reference after the object exists.
manifestSchema.properties.settings.properties.view.properties.childViews = {
  type: 'array',
  items: manifestSchema.properties.settings.properties.view,
};

/** Manifest conversion of the wire `schemas` registry below. */
// --- registry ---------------------------------------------------------------

/** Registry keyed by a stable name, handy for the harness and golden validation. */
export const schemas = {
  listenRequest: listenRequestSchema,
  clientAsrRequest: clientAsrRequestSchema,
  clientNluRequest: clientNluRequestSchema,
  context: contextSchema,
  trigger: triggerRequestSchema,
  nluRequest: nluRequestSchema,
  nluResponse: nluResponseSchema,
  skillRequest: skillRequestSchema,
  skillResponse: skillResponseSchema,
  listenResponse: listenResponseSchema,
  skillRedirect: skillRedirectSchema,
  proactive: proactiveResponseSchema,
  error: errorSchema,
  event: eventResponseSchema,
  match: matchSchema,
  nluResult: nluResultSchema,
  asrResult: asrResultSchema,
  jcpAction: jcpActionSchema,
  analytics: analyticsSchema,
  manifest: manifestSchema,
};