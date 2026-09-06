'use strict';

// Run this fixture with the frozen Pegasus tree mounted at /ref and the pinned
// Node 8 image. It intentionally loads only the original compiled BaseSkill /
// SkillService modules; no Phoenix implementation is imported.
const assert = require('assert');
const http = require('http');
const path = require('path');

const sourceRoot = process.env.S01_SOURCE_ROOT || process.argv[2] || '/ref';
const { BaseSkill } = require(path.join(sourceRoot, 'packages/baseskill/lib/BaseSkill'));
const { SkillService } = require(path.join(sourceRoot, 'packages/baseskill/lib/SkillService'));

class FixtureSkill extends BaseSkill {
  constructor() {
    super('s01-fixture-skill');
  }

  handle(request, callback) {
    const mode = request.body && request.body.data && request.body.data.mode;
    if (mode === 'error') throw new Error('fixture failure');
    if (mode === 'string-error') throw 'fixture string failure';
    if (mode === 'undefined') return undefined;
    if (mode === 'callback') {
      // BaseSkill calls handle with one request argument, so a callback-style
      // implementation has no callback and resolves as undefined.
      if (typeof callback === 'function') callback();
      return undefined;
    }
    const result = {
      type: 'SKILL_ACTION',
      msgID: 'fixture-response',
      ts: Date.now(),
      data: { skill: { id: 's01-fixture-skill' } },
    };
    if (mode === 'async') {
      return new Promise(resolve => setTimeout(() => resolve(result), 5));
    }
    return result;
  }
}

function request(port, mode) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ type: 'FIXTURE', data: { mode } });
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/v1/main',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

(async () => {
  const service = new SkillService(new FixtureSkill());
  await service.init(0);
  const port = service.server.address().port;
  try {
    const results = {};
    for (const mode of ['success', 'async', 'error', 'string-error', 'undefined', 'callback']) {
      results[mode] = await request(port, mode);
    }

    assert.equal(results.success.status, 200);
    assert.equal(typeof results.success.body.timings.total, 'number');
    assert.equal(results.async.status, 200);
    assert.equal(typeof results.async.body.timings.total, 'number');
    assert.equal(results.error.body.data.message, 'fixture failure');
    assert.equal(results['string-error'].body.data.message, 'fixture string failure');
    assert.equal(results.undefined.body.data.message, "Cannot set property 'timings' of undefined");
    assert.equal(results.callback.body.data.message, "Cannot set property 'timings' of undefined");
    for (const mode of ['error', 'string-error', 'undefined', 'callback']) {
      assert.equal(results[mode].body.type, 'ERROR');
      assert.equal(results[mode].body.timings, undefined);
    }

    console.log(JSON.stringify({
      runtime: process.version,
      successTotal: results.success.body.timings.total,
      asyncTotal: results.async.body.timings.total,
      errors: {
        error: results.error.body.data.message,
        stringError: results['string-error'].body.data.message,
        undefined: results.undefined.body.data.message,
        callback: results.callback.body.data.message,
      },
    }));
  } finally {
    await service.close();
  }
})().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
