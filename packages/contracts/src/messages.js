// JSON-Schema definitions for the messages that cross a process boundary.
//
// Faithful to docs/atlas/message-protocol.md but deliberately permissive: `additionalProperties`
// is left open (the protocol carries optional/forward-compatible fields) and only fields the
// receiver actually depends on are `required`. Tighten as the rebuild milestones harden each hop.
//
// Schema authoring conventions:
//   - nullability is expressed by a type union, e.g. type: ['string', 'null']
//   - shared sub-schemas are defined once and referenced by spreading into `properties`.

import { RequestType, ResponseType, SkillRequestType } from './constants.js';

// --- shared building blocks -------------------------------------------------

/** Base envelope fields present on every message (service.ts:9-27). */
const envelopeProps = {
  type: { type: 'string' },
  msgID: { type: 'string' },
  ts: { type: 'number' },
};

/** ASRConfig, or the literal string 'FAKE' (asr.ts:14-33; gotcha #5). */
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

/** ASR result (asr.ts:36-43). */
export const asrResultSchema = {
  type: 'object',
  required: ['text'],
  properties: {
    text: { type: 'string' },
    confidence: { type: 'number' },
    annotation: { type: ['string', 'null'], enum: [null, 'GARBAGE', 'FAST_EOS', 'SOS_TIMEOUT', 'MAX_SPEECH_TIMEOUT'] },
  },
};

/** NLUResult (nlu.ts:47-66). Empty/garbage ASR yields intent:null, rules:[], entities:{} (gotcha #7). */
export const nluResultSchema = {
  type: 'object',
  required: ['rules', 'intent', 'entities'],
  properties: {
    rules: { type: 'array', items: { type: 'string' } },
    intent: { type: ['string', 'null'] },
    entities: { type: 'object' },
    external: { type: 'object' },
  },
};

/** GlobalMatchResponseData.match (common.ts:4-15). */
export const matchSchema = {
  type: ['object', 'null'],
  properties: {
    skillID: { type: 'string' },
    launch: { type: 'boolean' },
    onRobot: { type: 'boolean' },
  },
};

// --- robot -> hub requests --------------------------------------------------

/** LISTEN (hub/request.ts:15-26). */
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
        mode: { type: 'string', enum: ['CLIENT_ASR', 'CLIENT_NLU'] },
        rules: { type: 'array', items: { type: 'string' } },
        asr: asrConfigSchema,
        agents: { type: 'object' },
      },
    },
  },
};

/** CONTEXT (service.ts:39-46; runtime.ts:144-155). The session carrier is data.skill. */
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
        general: {
          type: 'object',
          required: ['accountID', 'robotID', 'lang'],
          properties: {
            accountID: { type: 'string' },
            robotID: { type: 'string' },
            lang: { type: 'string' },
            release: { type: 'string' },
          },
        },
        runtime: { type: 'object' },
        skill: {
          type: 'object',
          properties: {
            id: { type: ['string', 'null'] },
            session: { type: 'object' },
          },
        },
      },
    },
  },
};

// --- hub <-> parser ---------------------------------------------------------

/** NLU request body to the parser (nlu.ts:32-44). */
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
        loop: { type: 'object' },
        external: { type: 'object' },
      },
    },
  },
};

/** NLU response from the parser (nlu.ts:47-66). Hub reads response.data.data (gotcha #8). */
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

/** Skill session blob — opaque to everyone but the owning skill (response.ts:9-51). */
export const skillSessionSchema = {
  type: 'object',
  required: ['id', 'nodeID'],
  properties: {
    id: { type: 'string' },
    nodeID: { type: 'integer' },
    data: { type: 'object' },
    trace: { type: 'array' },
  },
};

/** SkillRequest (request.ts:7-38). */
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
        general: { type: 'object' },
        runtime: { type: 'object' },
        skill: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string' }, session: skillSessionSchema },
        },
        result: { type: 'object' },
      },
    },
  },
};

/** SkillResponse (response.ts:9-51). */
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
        action: { type: ['object', 'null'] },
        analytics: { type: 'object' },
        final: { type: 'boolean' },
        fireAndForget: { type: 'boolean' },
      },
    },
  },
};

// --- hub -> robot responses -------------------------------------------------

/** LISTEN response (hub/response.ts:25-29). Non-final for a cloud-skill match (hop 8). */
export const listenResponseSchema = {
  type: 'object',
  required: ['type', 'data'],
  properties: {
    ...envelopeProps,
    type: { const: ResponseType.LISTEN },
    final: { type: 'boolean' },
    timings: { type: 'object' },
    data: {
      type: 'object',
      properties: {
        asr: asrResultSchema,
        nlu: nluResultSchema,
        match: matchSchema,
      },
    },
  },
};

/** ERROR response (message-protocol.md §4 error). */
export const errorSchema = {
  type: 'object',
  required: ['type', 'data', 'final'],
  properties: {
    ...envelopeProps,
    type: { const: ResponseType.ERROR },
    final: { const: true },
    timings: { type: 'object' },
    data: {
      type: 'object',
      required: ['message'],
      properties: {
        message: { type: 'string' },
        code: { type: 'string' },
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
    type: { type: 'string', enum: [ResponseType.SOS, ResponseType.EOS] },
    data: { type: 'null' },
    timings: { type: 'object' },
  },
};

/** Registry keyed by a stable name, handy for the harness and golden validation. */
export const schemas = {
  listenRequest: listenRequestSchema,
  context: contextSchema,
  nluRequest: nluRequestSchema,
  nluResponse: nluResponseSchema,
  skillRequest: skillRequestSchema,
  skillResponse: skillResponseSchema,
  listenResponse: listenResponseSchema,
  error: errorSchema,
  event: eventResponseSchema,
};
