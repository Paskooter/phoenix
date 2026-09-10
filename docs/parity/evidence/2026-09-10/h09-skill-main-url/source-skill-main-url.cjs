'use strict';

// H-09 source control: runs the PINNED original Pegasus SkillService / BaseSkill
// (5c0a7390539663ba749d360de348a428c088505c) under the archived Node 8.9.4
// runtime and records the exact /v1/main wire contract of an *independently
// deployed skill process*.
//
// The controlled skill echoes the request decoration (jibo headers, parsed body)
// so the transport contract is observable rather than the skill's own content.
//
// Usage: node source-skill-main-url.cjs <referenceRoot> <outPath>

const fs = require('fs');
const http = require('http');
const path = require('path');

const ref = process.argv[2];
const outPath = process.argv[3];

const baseskill = require(path.join(ref, 'packages/baseskill/lib/index'));

// One independently deployed skill process: SkillService hosts exactly one
// BaseSkill at POST /v1/main (SkillService.ts:12-18).
class EchoSkill extends baseskill.BaseSkill {
  handle(request) {
    const body = (request && request.body) || {};
    if (body.data && body.data.mode === 'throw') throw new Error('boom');
    return Promise.resolve({
      type: 'SKILL_ACTION',
      msgID: 'echo',
      ts: 1,
      data: {
        skill: { id: this.name },
        requestType: body.type,
        transID: request.jibo && request.jibo.transID,
        robotID: request.jibo && request.jibo.robotID,
        loggingConfig: request.jibo && request.jibo.loggingConfig,
        echoed: body,
      },
    });
  }
}

const skill = new EchoSkill('report-skill');
const service = new baseskill.SkillService(skill);

function request(method, urlPath, body, headers, contentType) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(body);
    const req = http.request({
      hostname: '127.0.0.1',
      port: service.server.address().port,
      path: urlPath,
      method,
      headers: Object.assign(
        payload ? { 'content-length': payload.length } : {},
        contentType === null ? {} : { 'content-type': contentType || 'application/json' },
        headers || {}
      ),
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (e) { /* non-JSON */ }
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

async function main() {
  await service.init(0);
  const out = { port: service.server.address().port, probes: {} };

  out.probes.postMain = await request('POST', '/v1/main', LAUNCH, {
    'x-jibo-transid': 'tid:source', 'x-jibo-robotid': 'robot-1',
  });
  out.probes.postNamespacedAlias = await request('POST', '/v1/report-skill/main', LAUNCH, {});
  out.probes.getMain = await request('GET', '/v1/main', undefined, {}, null);
  out.probes.healthcheck = await request('GET', '/healthcheck', undefined, {}, null);
  out.probes.postUnknown = await request('POST', '/v1/unknown', LAUNCH, {});
  out.probes.postThrow = await request('POST', '/v1/main',
    JSON.stringify({ type: 'LISTEN_LAUNCH', data: { mode: 'throw' } }), {});
  out.probes.postTextPlain = await request('POST', '/v1/main', LAUNCH, {}, 'text/plain');
  out.probes.postMalformed = await request('POST', '/v1/main', '{not json', {});

  await service.close();
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log('source-skill-main-url wrote', outPath);
}

main().catch((error) => { console.error(error); process.exit(1); });
