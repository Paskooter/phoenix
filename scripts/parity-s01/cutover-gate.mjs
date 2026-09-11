#!/usr/bin/env node
// S-01 deployment half — cutover gate for the graph node-id allocation shape.
//
// WHY THIS EXISTS
// A cloud-skill session blob is opaque and carries only *numeric* node ids
// (`GraphManager.ts:55-60` builds `{id, nodeID, data, trace}`; `GraphManager.ts:73`
// and `:101` read `data.skill.session.nodeID`). The manager that resolves those ids
// is per host, and a graph host allocates ids sequentially from 0 in graph
// construction order (`GraphManager.ts:117-129`). Neither the skill
// (`GraphSkill.ts:81,84` just calls `GraphManager.instance.start/exitNode`) nor the
// hub (`SkillRequestHelper.ts:36-63` only checks that a session is present and that
// `context.skill.id === skillID`) ever validates the blob against the host shape.
//
// Consequence: within one deployment shape an in-flight session resumes at the same
// node; across a shape change (standalone `PHOENIX_SKILL_ID` process <-> combined
// cohosted host, or a re-ordered registry) the same blob is silently reinterpreted
// in the target node-id space and the cloud cannot detect it. Therefore the cutover
// must drop or re-launch in-flight sessions, and the *deployment* — not the skill —
// has to decide that. This tool is that deploy-time half: it fingerprints the live
// node-id allocation and prints whether a cutover may resume sessions or must
// drop/re-launch them.
//
// Pinned original: jiboV2/pegasus@5c0a7390539663ba749d360de348a428c088505c
//   packages/baseskill/src/graph/GraphManager.ts
//   packages/baseskill/src/GraphSkill.ts
//   packages/hub/src/skill/SkillRequestHelper.ts
//   packages/hub/src/listen/ListenTransactionHandler.ts
//
// USAGE (root, on deploy — run against the live stack BEFORE and AFTER a cutover)
//   node scripts/parity-s01/cutover-gate.mjs \
//     --url http://127.0.0.1:9003 --skills report-skill --state .parity/s01-shape.json
//   node scripts/parity-s01/cutover-gate.mjs \
//     --url http://127.0.0.1:9000 --skills chitchat-skill,report-skill --state .parity/s01-shape.json
// Exit 0 = resume-safe (same shape as --state), 2 = drop/re-launch required,
// 3 = shape changed and no operator decision recorded (first run writes state).
// `--accept` records the new shape after the operator has dropped/relaunched sessions.

import { readFileSync, writeFileSync } from 'node:fs';

/** Launch probes for the built-in graph skills (the ones that allocate node ids). */
export const DEFAULT_PROBES = {
  'chitchat-skill': (id) => ({
    type: 'LISTEN_LAUNCH', msgID: 's01-shape-probe', ts: 1,
    data: {
      general: { accountID: 's01-shape', robotID: 's01-shape', lang: 'en-US' },
      runtime: { dialog: {}, perception: {} },
      skill: { id },
      result: {
        nlu: { intent: 'RI_JBO_LikesIceCream', entities: {}, rules: [] },
        asr: { text: '' },
        memo: { mim: 'RI_JBO_LikesIceCream', type: 'ScriptedResponse' },
      },
    },
  }),
  'report-skill': (id) => ({
    type: 'LISTEN_LAUNCH', msgID: 's01-shape-probe', ts: 1,
    data: {
      general: { accountID: 's01-shape', robotID: 's01-shape', lang: 'en-US' },
      runtime: {
        loop: { loopId: 's01-shape', users: [{ id: 's01-shape', accountId: 's01-shape', birthdate: '1990-01-01' }] },
        location: { lat: 42.36, lng: -71.06, iso: '2018-05-30T12:00:00+00:00' },
        perception: { speaker: 's01-shape' },
        character: { emotion: { name: 'NEUTRAL', valence: 0, confidence: 0 } },
        dialog: {},
      },
      skill: { id },
      result: {
        nlu: { intent: 'launchPersonalReport', entities: {}, rules: ['launch'] },
        asr: { text: 'personal report', confidence: 1 },
        memo: 'Reactive',
      },
    },
  }),
};

/**
 * Read the initial node id each hosted graph skill allocates, over the real wire.
 * @param {string} baseUrl e.g. http://127.0.0.1:9003
 * @param {string[]} skills graph-skill ids hosted by this deployment shape
 * @returns {Promise<{skill:string, nodeID:number|null, error:string|null}[]>}
 */
export async function probeShape(baseUrl, skills, { fetchImpl = fetch, probes = DEFAULT_PROBES } = {}) {
  const entries = [];
  for (const skill of skills) {
    const build = probes[skill];
    if (!build) throw new Error(`No launch probe registered for '${skill}'`);
    const response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/v1/${skill}/main`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(build(skill)),
    });
    const body = await response.json();
    const session = body && body.data && body.data.skill && body.data.skill.session;
    entries.push({
      skill,
      nodeID: session && typeof session.nodeID === 'number' ? session.nodeID : null,
      error: session ? null : ((body && body.data && body.data.message) || `HTTP ${response.status}`),
    });
  }
  return entries;
}

/** Canonical, order-independent fingerprint of a probed deployment shape. */
export function shapeFingerprint(entries) {
  return JSON.stringify(
    [...entries].sort((a, b) => (a.skill < b.skill ? -1 : a.skill > b.skill ? 1 : 0)),
  );
}

/**
 * The cutover rule. A session minted under `prev` resumes only while the shape is
 * byte-identical; any change means ids shift and the blob would be reinterpreted.
 * @returns {{changed:boolean, decision:'resume'|'drop-or-relaunch'}}
 */
export function decideCutover(prevFingerprint, nextFingerprint) {
  if (prevFingerprint === null || prevFingerprint === undefined || prevFingerprint === '') {
    return { changed: true, decision: 'drop-or-relaunch' };
  }
  return prevFingerprint === nextFingerprint
    ? { changed: false, decision: 'resume' }
    : { changed: true, decision: 'drop-or-relaunch' };
}

function parseArgs(argv) {
  const args = { skills: [], state: '.parity/s01-shape.json', accept: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--url') args.url = argv[++i];
    else if (argv[i] === '--skills') args.skills = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (argv[i] === '--state') args.state = argv[++i];
    else if (argv[i] === '--accept') args.accept = true;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.url || !args.skills.length) {
    console.error('usage: cutover-gate.mjs --url <baseUrl> --skills a,b [--state file] [--accept]');
    process.exit(1);
  }
  const entries = await probeShape(args.url, args.skills);
  const failed = entries.filter((e) => e.nodeID === null);
  const fingerprint = shapeFingerprint(entries);

  let previous = '';
  try { previous = readFileSync(args.state, 'utf8').trim(); } catch { previous = ''; }

  const { changed, decision } = decideCutover(previous, fingerprint);
  const report = {
    url: args.url, skills: args.skills, entries, fingerprint,
    previousFingerprint: previous || null, changed, decision,
  };
  console.log(JSON.stringify(report, null, 2));

  if (failed.length) { console.error('FAIL: probe(s) returned no session:', failed.map((e) => e.skill).join(',')); process.exit(1); }

  if (changed) {
    console.error('CUTOVER: deployment shape changed — in-flight graph sessions MUST be dropped or re-launched.');
    if (args.accept) {
      writeFileSync(args.state, fingerprint);
      console.error(`recorded new shape in ${args.state}`);
      process.exit(0);
    }
    process.exit(2);
  }
  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
