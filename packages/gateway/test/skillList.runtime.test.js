// H-01 runtime: the robot-specific skill-list endpoints, observed over a real TCP
// socket against the gateway the process actually serves.
//
// Pinned source (pegasus@5c0a7390539663ba749d360de348a428c088505c):
//   packages/hub/src/HubService.ts:75-80
//     The one SkillListGetHttpRequestsHandler is mounted at BOTH '/skills' and
//     '/v1/skills', so the robot-specific URLs are:
//       GET /skills/:robotId            GET /v1/skills/:robotId
//       GET /skills/settings/:robotId   GET /v1/skills/settings/:robotId
//   packages/hub/src/skill-list/SkillListGetHttpRequestsHandler.ts:13-44
//     addGetHandler('/:robotId',  ... false) -> { skills: skillConfigs }
//     addGetHandler('/settings/:robotId', ... true) -> { skills: skillConfigsWithSettings }
//     skillConfigsWithSettings = skillConfigs.filter(it => !!it.settings)
//     :robotId is read for logging only and never filters the response.
//   `SkillConfig` (packages/interfaces/src/skill/config.ts) = the full manifest
//   shape plus the derived `URL`, so the unfiltered response is the complete
//   configuration, not a reduced { id, intents } projection.
// Documented at
//   https://pvindex.org/gitea/jiboV2/pegasus/src/commit/d682547a31511cd164db0913b6104eb1786455a2/docs/atlas/packages/hub.md
//   §3 Public interface: "HTTP GET /skills/:robotId, /v1/skills/:robotId ->
//   { skills: SkillConfig[] }; GET /skills/settings/:robotId -> only configs that
//   have settings. No auth middleware is registered for these."

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { createGateway } = await import('@phoenix/gateway');

const PLAIN = { id: 'plain-skill', URL: 'http://127.0.0.1:9/plain/v1/main', intents: [{ name: 'plainIntent' }] };
const WITH_SETTINGS = {
  id: 'settings-skill',
  URL: 'http://127.0.0.1:9/settings/v1/main',
  intents: [],
  settings: { view: { type: 'main', index: 0, title: 'Settings' } },
};
const FULL = [PLAIN, WITH_SETTINGS];

const ROBOT_URLS = ['/skills/robot-A', '/v1/skills/robot-A'];
const SETTINGS_URLS = ['/skills/settings/robot-A', '/v1/skills/settings/robot-A'];

async function withGateway(skills, run) {
  const gateway = await createGateway({
    hubTokenSecret: '',
    disableAuth: true,
    accountUrl: '',
    parserURL: 'http://127.0.0.1:9',
    historyURL: 'http://127.0.0.1:9',
    settingsURL: 'http://127.0.0.1:9',
    skills,
  });
  await gateway.service.listen(0);
  const port = gateway.service.server.address().port;
  try {
    return await run(port);
  } finally {
    await new Promise((resolve) => gateway.wss.close(() => resolve()));
    await new Promise((resolve, reject) => gateway.service.server.close((error) => (error ? reject(error) : resolve())));
  }
}

const fetchJson = async (port, path) => {
  const response = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: response.status, contentType: response.headers.get('content-type'), body: await response.text() };
};

test('H-01: /skills/:robotId and /v1/skills/:robotId serve the full reference-shaped configurations', async () => {
  await withGateway(FULL, async (port) => {
    for (const path of ROBOT_URLS) {
      const { status, contentType, body } = await fetchJson(port, path);
      assert.equal(status, 200, path);
      assert.match(contentType, /^application\/json/, path);
      const parsed = JSON.parse(body);
      assert.deepEqual(parsed, { skills: [PLAIN, WITH_SETTINGS] }, path);
      // Full SkillConfig: the derived URL and the manifest fields survive, so this
      // is not the generic { id, intents } projection (HubService.ts:75-80).
      assert.equal(parsed.skills[0].URL, PLAIN.URL, path);
      assert.deepEqual(parsed.skills[1].settings, WITH_SETTINGS.settings, path);
    }
  });
});

test('H-01: the settings-filtered URLs return exactly the configurations that carry settings', async () => {
  await withGateway(FULL, async (port) => {
    for (const path of SETTINGS_URLS) {
      const { status, body } = await fetchJson(port, path);
      assert.equal(status, 200, path);
      assert.deepEqual(JSON.parse(body), { skills: [WITH_SETTINGS] }, path);
    }
  });
});

test('H-01: an unknown robot ID returns the same configurations as a known one (the id is not a filter)', async () => {
  await withGateway(FULL, async (port) => {
    for (const [known, unknown] of [['/skills/robot-A', '/skills/no-such-robot'], ['/v1/skills/settings/robot-A', '/v1/skills/settings/no-such-robot']]) {
      const a = await fetchJson(port, known);
      const b = await fetchJson(port, unknown);
      assert.equal(b.status, 200, unknown);
      assert.equal(b.body, a.body, unknown);
    }
  });
});

test('H-01: an empty registry returns {"skills":[]} on all four URLs, settings variants included', async () => {
  await withGateway([], async (port) => {
    for (const path of [...ROBOT_URLS, ...SETTINGS_URLS]) {
      const { status, body } = await fetchJson(port, path);
      assert.equal(status, 200, path);
      assert.deepEqual(JSON.parse(body), { skills: [] }, path);
    }
  });
});

test('H-01: a registry with no settings-bearing skill yields {"skills":[]} from the settings variants only', async () => {
  await withGateway([PLAIN], async (port) => {
    for (const path of SETTINGS_URLS) {
      const { status, body } = await fetchJson(port, path);
      assert.equal(status, 200, path);
      assert.deepEqual(JSON.parse(body), { skills: [] }, path);
    }
    for (const path of ROBOT_URLS) {
      const { body } = await fetchJson(port, path);
      assert.deepEqual(JSON.parse(body), { skills: [PLAIN] }, path);
    }
  });
});

test('H-01: the generic no-ID alias is the reduced id+intents projection, unlike the robot-specific list', async () => {
  await withGateway(FULL, async (port) => {
    for (const path of ['/skills', '/v1/skills']) {
      const { status, body } = await fetchJson(port, path);
      assert.equal(status, 200, path);
      assert.deepEqual(JSON.parse(body), { skills: [{ id: PLAIN.id, intents: PLAIN.intents }, { id: WITH_SETTINGS.id, intents: WITH_SETTINGS.intents }] }, path);
    }
  });
});
