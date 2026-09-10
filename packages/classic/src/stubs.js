// Build-to-spec classic-service stubs (CLASSIC-SERVICES.md tier 3). These need the dead mobile
// app and/or robot hardware to actually exercise, so they are implemented to the wire contract
// (apis/<name>.normal.json output shapes) and wire-tested for dispatch + shape — but UNVERIFIED
// end-to-end without the app (recorded in DIVERGENCES.md). Each returns an empty/sane-default
// shape so a robot or app calling it gets a valid answer instead of hanging.
//
//   media      (Media_20160725)  cloud photo/recording store — now REAL (A-Gallery)
//   rom        (ROM_20171011)    cert exchange — now REAL (A-16)
//   person     (Person_20160801) per-loop/per-account properties + holidays (real in-memory props)
//   ifttt      (IFTTT_20170207)  IFTTT integration
//   nlp        (NLP_20161031)    cloud NLP (Phoenix has its own parser)
//   collision  (Collision_20161126) username-collision check
//
// rom (ROM_20171011) is no longer a stub — it is implemented in rom.js (A-16).
// NOT built (no client API contract exists in the archive): voicetraining, jot.
//
// media (Media_20160725) graduated out of this file — the app's Gallery tab reads it, so it now
// has a real store: see ./media.js.

import { sendAmz, sendAmzError, accessKeyIdFromAuth, ValidationException } from './awsJson.js';

const COMMAND_OK = { result: 'Command accepted' };

// Per-service op -> output. A function receives (body, ctx) for dynamic shapes; a plain value is
// returned as-is. Op keys are matched case-insensitively.
function defineStubs() {
  // person keeps a tiny in-memory property store so Set/Get round-trips meaningfully.
  const loopProps = new Map();    // loopId -> { key: value }
  const accountProps = new Map(); // accountId -> { key: value }
  const propBag = (m, id) => { let b = m.get(id); if (!b) { b = {}; m.set(id, b); } return b; };

  return {
    person: {
      prefix: /^person/i,
      ops: {
        list: () => [],
        answer: (b) => ({ key: (b && b.key) || '', answer: null }),
        enableholidays: () => COMMAND_OK,
        disableholidays: () => COMMAND_OK,
        listholidays: () => [],
        setloopproperty: (b) => { if (b && b.loopId && b.key !== undefined) propBag(loopProps, b.loopId)[b.key] = b.value; return {}; },
        getloopproperties: (b) => (b && loopProps.get(b.loopId)) || {},
        setaccountproperty: (b, { accountId }) => { if (b && b.key !== undefined) propBag(accountProps, accountId)[b.key] = b.value; return {}; },
        getaccountproperties: (b, { accountId }) => accountProps.get(accountId) || {},
        listaccountpropertykeys: (b, { accountId }) => ({ keys: Object.keys(accountProps.get(accountId) || {}) }),
      },
    },
    ifttt: {
      prefix: /^ifttt/i,
      ops: {
        trigger: () => COMMAND_OK,
        listtriggers: () => [],
        listmedia: () => [],
        deleteidentity: () => COMMAND_OK,
        action: () => ({}),
        listactions: () => [],
        userinfo: (b, { accountId }) => ({ id: accountId, name: '' }),
      },
    },
    nlp: {
      prefix: /^nlp/i,
      ops: { partofspeech: () => ({ partsOfSpeech: [] }), namedentityrecognition: () => ({ namedEntities: [] }) },
    },
    collision: {
      prefix: /^collision/i,
      // "no collision" — the username is free.
      ops: { match: () => ({ success: true, collision: false, closest_pair: null, distance: null }) },
    },
  };
}

function makeStubHandler(name, ops) {
  return function stubHandler({ req, res, body, op }) {
    const fn = ops[op.toLowerCase()];
    if (fn === undefined) return void sendAmzError(res, ValidationException, `unknown ${name} operation: ${op}`);
    const accountId = accessKeyIdFromAuth(req) || 'anon';
    const out = typeof fn === 'function' ? fn(body || {}, { accountId }) : fn;
    return void sendAmz(res, 200, out);
  };
}

/** Router registrations for every stubbed classic service. */
export function stubRegistrations() {
  const defs = defineStubs();
  return Object.entries(defs).map(([name, { prefix, ops }]) => ({ match: prefix, handler: makeStubHandler(name, ops) }));
}
