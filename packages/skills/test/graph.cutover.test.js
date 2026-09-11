// S-01 acceptance 3 — the deployment half of the in-flight-session cutover clause.
//
// The skill side is already covered in graph.lifecycle.test.js: a session blob
// carries numeric node ids only, so the cloud cannot tell which deployment shape
// minted it. This file exercises the *deployment* half at runtime: it boots the two
// real deployment shapes the compose/native launchers use, probes their live node-id
// allocation over real HTTP, and asserts the cutover gate (scripts/parity-s01/
// cutover-gate.mjs) decides resume vs drop-or-relaunch correctly.
//
// Source citations are file:line against
// 5c0a7390539663ba749d360de348a428c088505c:
//   baseskill/src/graph/GraphManager.ts:55-60,73,101,117-129  (id space + session reads)
//   baseskill/src/GraphSkill.ts:81,84                          (no shape validation)
//   hub/src/skill/SkillRequestHelper.ts:36-63                  (hub only checks presence/id)
//   hub/src/listen/ListenTransactionHandler.ts:432-435         (context, with the session,
//                                                               arrives from the robot)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { start } from '../src/index.js';
import { probeShape, shapeFingerprint, decideCutover } from '../../../scripts/parity-s01/cutover-gate.mjs';

const close = (server) => new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
const baseUrl = (server) => `http://127.0.0.1:${server.address().port}`;

async function withServers(builds, fn) {
  const oldPrefs = process.env.ETCO_report_prefsFromConfig;
  process.env.ETCO_report_prefsFromConfig = 'true';
  const servers = [];
  try {
    for (const build of builds) servers.push(await build());
    return await fn(servers);
  } finally {
    if (oldPrefs === undefined) delete process.env.ETCO_report_prefsFromConfig;
    else process.env.ETCO_report_prefsFromConfig = oldPrefs;
    for (const server of servers) await close(server);
  }
}

// Shape A: the standalone per-skill process the compose/native launchers use
// (PHOENIX_SKILL_ID selects one skill at /v1/main; index.js:235-249).
const standaloneReport = () => start(0, { skillId: 'report-skill' });
// Shape B: the combined cohosted host (no PHOENIX_SKILL_ID) that builds every
// builtin graph in registry order against one manager (index.js:254-261).
const combinedHost = () => start(0, { skillId: null });

test('S-01 deployment shape fixes a skill initial node id and is deterministic across boots', async () => {
  await withServers([standaloneReport, combinedHost, combinedHost], async ([standalone, combinedOne, combinedTwo]) => {
    const alone = await probeShape(baseUrl(standalone), ['report-skill']);
    assert.equal(alone[0].nodeID, 31, 'a standalone report process allocates the report graph from 0');
    assert.equal(alone[0].error, null);

    const combined = await probeShape(baseUrl(combinedOne), ['chitchat-skill', 'report-skill']);
    const byId = Object.fromEntries(combined.map((e) => [e.skill, e.nodeID]));
    assert.equal(byId['chitchat-skill'], 0, 'chitchat is built first in the cohosted registry');
    assert.equal(byId['report-skill'], 35, 'cohosting shifts the report graph to a different node id');
    for (const entry of combined) assert.equal(entry.error, null, `${entry.skill} launch probe answered`);

    // Same shape booted twice ⇒ byte-identical allocation ⇒ a session from one
    // process resumes on the other. This is the "identical-shape restart" half.
    const combinedAgain = await probeShape(baseUrl(combinedTwo), ['chitchat-skill', 'report-skill']);
    assert.equal(
      shapeFingerprint(combined),
      shapeFingerprint(combinedAgain),
      'graph construction order is deterministic, so same-shape boots allocate identically',
    );
  });
});

test('S-01 the cutover gate resumes only an unchanged shape and drops on a shape change', async () => {
  await withServers([standaloneReport, combinedHost], async ([standalone, combined]) => {
    const standaloneFp = shapeFingerprint(await probeShape(baseUrl(standalone), ['report-skill']));
    const combinedFp = shapeFingerprint(await probeShape(baseUrl(combined), ['chitchat-skill', 'report-skill']));

    assert.notEqual(standaloneFp, combinedFp, 'the two deployment shapes fingerprint differently');

    // The deployment procedure root runs on release: compare the fingerprint the
    // running shape reports against the one persisted at the last cutover.
    assert.deepEqual(
      decideCutover(combinedFp, combinedFp),
      { changed: false, decision: 'resume' },
      'an unchanged shape may resume in-flight sessions',
    );
    assert.deepEqual(
      decideCutover(standaloneFp, combinedFp),
      { changed: true, decision: 'drop-or-relaunch' },
      'a shape change must drop or re-launch in-flight sessions',
    );
    assert.deepEqual(
      decideCutover('', combinedFp),
      { changed: true, decision: 'drop-or-relaunch' },
      'with no persisted shape (first deploy after this gate lands) nothing may resume',
    );
  });
});

test('S-01 the cloud does not enforce the cutover, so the deployment gate is required', async () => {
  await withServers([standaloneReport, combinedHost], async ([standalone, combined]) => {
    // Mint an in-flight session under the standalone shape, then offer it to the
    // combined host as if the cutover had carried it across. The pinned original
    // never validates the blob against the host (GraphSkill.ts:81,84): the only
    // check is that the id resolves inside the *current* manager, so the run is
    // silently reinterpreted in the combined node-id space instead of refused.
    const launchBody = {
      type: 'LISTEN_LAUNCH', msgID: 's01-cutover-1', ts: 1,
      data: {
        general: { accountID: 's01-shape', robotID: 's01-shape', lang: 'en-US' },
        runtime: {
          loop: { loopId: 's01-shape', users: [{ id: 's01-shape', accountId: 's01-shape', birthdate: '1990-01-01' }] },
          location: { lat: 42.36, lng: -71.06, iso: '2018-05-30T12:00:00+00:00' },
          perception: { speaker: 's01-shape' },
          character: { emotion: { name: 'NEUTRAL', valence: 0, confidence: 0 } },
          dialog: {},
        },
        skill: { id: 'report-skill' },
        result: {
          nlu: { intent: 'launchPersonalReport', entities: {}, rules: ['launch'] },
          asr: { text: 'personal report', confidence: 1 }, memo: 'Reactive',
        },
      },
    };
    const launched = await (await fetch(`${baseUrl(standalone)}/v1/report-skill/main`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(launchBody),
    })).json();
    const session = launched.data.skill.session;
    assert.equal(session.nodeID, 31);

    const updateBody = {
      type: 'LISTEN_UPDATE', msgID: 's01-cutover-2', ts: 2,
      data: {
        general: launchBody.data.general, runtime: launchBody.data.runtime,
        skill: { id: 'report-skill', session },
        result: { asr: { text: 'yes' }, nlu: { intent: 'yes', rules: [], entities: {} } },
      },
    };
    const crossed = await (await fetch(`${baseUrl(combined)}/v1/report-skill/main`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(updateBody),
    })).json();
    assert.notEqual(crossed.type, 'ERROR', 'the combined host accepts a foreign-shape session instead of refusing it');
    assert.equal(crossed.data.skill.session.nodeID, 35, 'the blob is reinterpreted at the combined node id');
  });
});
