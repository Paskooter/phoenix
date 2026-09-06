'use strict';

// Expanded source-only boundary probe. Run with the frozen Pegasus tree at
// /ref under the pinned Node 8 image. The older
// s01-base-skill-source-probe.cjs remains unchanged as the initial evidence.
const http = require('http');
const path = require('path');

const sourceRoot = process.env.S01_SOURCE_ROOT || process.argv[2] || '/ref';
const { BaseSkill } = require(path.join(sourceRoot, 'packages/baseskill/lib/BaseSkill'));
const { SkillService } = require(path.join(sourceRoot, 'packages/baseskill/lib/SkillService'));

const assignmentWitnesses = {
  inheritedSetterCalled: false,
  proxyAssigned: false,
  proxyInspectedBeforeAssignment: false,
};

class FixtureSkill extends BaseSkill {
  constructor() {
    super('s01-fixture-skill');
  }

  handle(request, callback) {
    const mode = request.body && request.body.data && request.body.data.mode;
    if (mode === 'throw-error') throw new Error('fixture failure');
    if (mode === 'throw-string') throw 'fixture string failure';
    if (mode === 'throw-object') throw { code: 'FIXTURE' };
    if (mode === 'throw-null') throw null;
    if (mode === 'throw-undefined') throw undefined;
    if (mode === 'return-undefined' || mode === 'callback') {
      if (typeof callback === 'function') callback();
      return undefined;
    }
    if (mode === 'return-null') return null;
    if (mode === 'return-number') return 7;
    if (mode === 'return-boolean') return false;
    if (mode === 'return-string') return 'fixture';
    if (mode === 'return-frozen') return Object.freeze({});
    if (mode === 'return-readonly') {
      const result = {};
      Object.defineProperty(result, 'timings', { value: 1, writable: false });
      return result;
    }
    if (mode === 'return-getter') {
      const result = {};
      Object.defineProperty(result, 'timings', { get() { return 1; } });
      return result;
    }
    if (mode === 'return-setter-error') {
      const result = {};
      Object.defineProperty(result, 'timings', {
        set() { throw new TypeError('custom setter failure'); },
      });
      return result;
    }
    if (mode === 'return-inherited-setter') {
      const prototype = {
        set timings(value) {
          assignmentWitnesses.inheritedSetterCalled = value && Number.isInteger(value.total);
        },
      };
      return Object.preventExtensions(Object.create(prototype));
    }
    if (mode === 'return-proxy') {
      const target = {
        type: 'SKILL_ACTION',
        msgID: 'fixture-response',
        ts: Date.now(),
        data: { skill: { id: 's01-fixture-skill' } },
      };
      return new Proxy(target, {
        getOwnPropertyDescriptor(object, key) {
          if (!assignmentWitnesses.proxyAssigned) assignmentWitnesses.proxyInspectedBeforeAssignment = true;
          return Reflect.getOwnPropertyDescriptor(object, key);
        },
        isExtensible(object) {
          if (!assignmentWitnesses.proxyAssigned) assignmentWitnesses.proxyInspectedBeforeAssignment = true;
          return Reflect.isExtensible(object);
        },
        set(object, key, value) {
          if (key === 'timings') {
            assignmentWitnesses.proxyAssigned = true;
            object.timings = value;
          }
          else object[key] = value;
          return true;
        },
      });
    }

    const result = {
      type: 'SKILL_ACTION',
      msgID: 'fixture-response',
      ts: Date.now(),
      data: { skill: { id: 's01-fixture-skill' } },
    };
    if (mode === 'async') return new Promise(resolve => setTimeout(() => resolve(result), 5));
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
      res.on('end', () => resolve({
        status: res.statusCode,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

function normalize(value, key) {
  if (key === 'msgID') return '<msgID>';
  if (key === 'ts') return '<ts>';
  if (key === 'total') return '<timing-number>';
  if (Array.isArray(value)) return value.map(item => normalize(item));
  if (value && typeof value === 'object') {
    return Object.keys(value).reduce((output, name) => {
      output[name] = normalize(value[name], name);
      return output;
    }, {});
  }
  return value;
}

(async () => {
  const modes = [
    'success', 'async', 'throw-error', 'throw-string', 'throw-object',
    'throw-null', 'throw-undefined', 'return-undefined', 'callback',
    'return-null', 'return-number', 'return-boolean', 'return-string',
    'return-frozen', 'return-readonly', 'return-getter', 'return-setter-error',
    'return-inherited-setter', 'return-proxy',
  ];
  const service = new SkillService(new FixtureSkill());
  await service.init(0);
  const port = service.server.address().port;
  try {
    const normalized = {};
    for (const mode of modes) {
      const result = await request(port, mode);
      normalized[mode] = { status: result.status, body: normalize(result.body) };
    }
    console.log(JSON.stringify({ runtime: process.version, normalized, assignmentWitnesses }, null, 2));
  } finally {
    await service.close();
  }
})().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
