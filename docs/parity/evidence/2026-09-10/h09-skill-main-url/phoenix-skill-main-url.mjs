// H-09 Phoenix control: drives the real Phoenix per-skill host (the same
// createSkillService the executable entrypoint builds) and records the
// transport contract at the reference /v1/main URL, plus the intended-skill
// identity for every independently deployable skill process.
//
// Usage: node phoenix-skill-main-url.mjs <outPath>

import { writeFileSync } from 'node:fs';
import http from 'node:http';
import { createSkillService } from '../../../../../packages/skills/src/skillService.js';
import { start } from '../../../../../packages/skills/src/index.js';

const outPath = process.argv[2];

// Controlled handler that echoes the decorated request exactly like the source
// control's EchoSkill.
const echoHandler = (body, { req }) => {
  if (body && body.data && body.data.mode === 'throw') throw new Error('boom');
  return {
    type: 'SKILL_ACTION',
    msgID: 'echo',
    ts: 1,
    data: {
      skill: { id: 'report-skill' },
      requestType: body.type,
      transID: req.jibo.transID,
      robotID: req.jibo.robotID,
      loggingConfig: req.jibo.loggingConfig,
      echoed: body,
    },
  };
};

function request(port, method, urlPath, body, headers, contentType) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(body);
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: urlPath,
      method,
      headers: {
        ...(payload ? { 'content-length': payload.length } : {}),
        ...(contentType === null ? {} : { 'content-type': contentType || 'application/json' }),
        ...(headers || {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* non-JSON */ }
        resolve({ status: res.statusCode, raw: text, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const LAUNCH = JSON.stringify({
  type: 'LISTEN_LAUNCH',
  msgID: 'source-1',
  ts: 1,
  data: { general: { accountID: 'a', robotID: 'r' }, skill: { id: 'report-skill' } },
});

const out = { probes: {}, runtime: {} };

// ---- transport contract (controlled handler, same shape as the source control) ----
const service = createSkillService({ name: 'report-skill', skillId: 'report-skill', handler: echoHandler });
await service.listen(0);
const port = service.server.address().port;
out.probes.postMain = await request(port, 'POST', '/v1/main', LAUNCH, {
  'x-jibo-transid': 'tid:source', 'x-jibo-robotid': 'robot-1',
});
out.probes.postNamespacedAlias = await request(port, 'POST', '/v1/report-skill/main', LAUNCH, {});
out.probes.getMain = await request(port, 'GET', '/v1/main', undefined, {}, null);
out.probes.healthcheck = await request(port, 'GET', '/healthcheck', undefined, {}, null);
out.probes.postUnknown = await request(port, 'POST', '/v1/unknown', LAUNCH, {});
out.probes.postThrow = await request(port, 'POST', '/v1/main',
  JSON.stringify({ type: 'LISTEN_LAUNCH', data: { mode: 'throw' } }), {});
out.probes.postTextPlain = await request(port, 'POST', '/v1/main', LAUNCH, {}, 'text/plain');
out.probes.postMalformed = await request(port, 'POST', '/v1/main', '{not json', {});
await new Promise((resolve, reject) => service.server.close((e) => (e ? reject(e) : resolve())));

// ---- runtime identity per independently deployable skill process ----
const baseRuntime = {
  dialog: {}, perception: {}, loop: { users: [] },
  location: { lat: 42.36, lng: -71.06, iso: '2026-06-12T10:00:00-04:00' },
};
const SKILLS = {
  'answer-skill': {
    type: 'LISTEN_LAUNCH', msgID: 'answer', ts: 1,
    data: {
      general: { accountID: 'a', robotID: 'r', lang: 'en-US' }, runtime: { dialog: {} },
      skill: { id: 'answer-skill' },
      result: { asr: { text: 'who is ada lovelace' }, nlu: { intent: 'generalWhoQuestions', rules: ['launch'], entities: {} }, memo: { type: 'who' } },
    },
  },
  'report-skill': {
    type: 'LISTEN_LAUNCH', msgID: 'report', ts: 1,
    data: {
      general: { accountID: 'a', robotID: 'r', lang: 'en-US' }, runtime: baseRuntime,
      skill: { id: 'report-skill' },
      result: { nlu: { intent: 'launchPersonalReport', entities: {}, rules: [] }, asr: { text: '' }, memo: 'Reactive' },
    },
  },
  'chitchat-skill': {
    type: 'LISTEN_LAUNCH', msgID: 'chitchat', ts: 1,
    data: {
      general: { accountID: 'a', robotID: 'r', lang: 'en-US' },
      runtime: { ...baseRuntime, character: { emotion: { name: 'NEUTRAL', valence: 0, confidence: 0 } } },
      skill: { id: 'chitchat-skill' },
      result: { nlu: { intent: 'requestDance', entities: {}, rules: [] }, asr: { text: '' }, memo: { mim: 'RA_JBO_SpecificDance', type: 'ScriptedResponse' } },
    },
  },
  'example-skill': {
    type: 'LISTEN_LAUNCH', msgID: 'example', ts: 1,
    data: {
      general: { accountID: 'a', robotID: 'r', lang: 'en-US' }, runtime: baseRuntime,
      skill: { id: 'example-skill' },
      result: { nlu: { intent: 'doesJiboLikeThing', entities: {}, rules: [] }, asr: { text: '' }, memo: null },
    },
  },
  'template-skill': {
    type: 'LISTEN_LAUNCH', msgID: 'template', ts: 1,
    data: {
      general: { accountID: 'a', robotID: 'r', lang: 'en-US' }, runtime: baseRuntime,
      skill: { id: 'template-skill' },
      result: { nlu: { intent: 'x', entities: {}, rules: [] }, asr: { text: '' }, memo: { entry: 'SomeThing' } },
    },
  },
};

function mim(response) {
  const jcp = response.body?.data?.action?.config?.jcp;
  if (!jcp) return null;
  const slim = jcp.type === 'SLIM' ? jcp : jcp.children?.find((c) => c.type === 'SLIM');
  return slim?.config?.play?.meta?.mim_id ?? slim?.config?.play?.esml ?? null;
}

for (const skillId of Object.keys(SKILLS)) {
  const server = await start(0, { skillId });
  const p = server.address().port;
  const main = await request(p, 'POST', '/v1/main', JSON.stringify(SKILLS[skillId]), {});
  const alias = await request(p, 'POST', `/v1/${skillId}/main`, JSON.stringify(SKILLS[skillId]), {});
  out.runtime[skillId] = {
    main: { status: main.status, type: main.json?.type, skill: main.json?.data?.skill?.id, mim: mim(main) },
    alias: { status: alias.status, type: alias.json?.type, skill: alias.json?.data?.skill?.id, mim: mim(alias) },
  };
  await new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
}

writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log('phoenix-skill-main-url wrote', outPath);
