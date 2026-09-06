import assert from 'node:assert/strict';
import http from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = resolve(process.env.PHOENIX_ROOT || fileURLToPath(new URL('../../../../', import.meta.url)));
const { createSkillService, skillRoute } = await import(pathToFileURL(resolve(root, 'packages/skills/src/skillService.js')));

const REQUEST = {
  type: 'LISTEN_LAUNCH',
  msgID: 'fixture-request',
  ts: 0,
  data: { general: {}, skill: { id: 's01-fixture-skill' } },
};

const log = {
  warn() {},
  error() {},
};

const assignmentWitnesses = {
  inheritedSetterCalled: false,
  proxyAssigned: false,
  proxyInspectedBeforeAssignment: false,
};

function invoke(handler) {
  return skillRoute('s01-fixture-skill', handler)({ body: REQUEST, trace: {}, log });
}

function action(extra = {}) {
  return {
    type: 'SKILL_ACTION',
    msgID: 'fixture-response',
    ts: 0,
    data: { skill: { id: 's01-fixture-skill' } },
    ...extra,
  };
}

function normalizeWire(response) {
  const normalize = (value, key) => {
    if (key === 'msgID') return '<msgID>';
    if (key === 'ts') return '<ts>';
    if (key === 'total') return '<timing-number>';
    if (Array.isArray(value)) return value.map((item) => normalize(item));
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, normalize(item, name)]));
    }
    return value;
  };
  return { status: response.status, body: normalize(JSON.parse(response.body)) };
}

function matrixHandler(body) {
  const mode = body.data.mode;
  if (mode === 'throw-error') throw new Error('fixture failure');
  if (mode === 'throw-string') throw 'fixture string failure';
  if (mode === 'throw-object') throw { code: 'FIXTURE' };
  if (mode === 'throw-null') throw null;
  if (mode === 'throw-undefined') throw undefined;
  if (mode === 'return-undefined' || mode === 'callback') return undefined;
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
    // The source assignment invokes an inherited setter even when the target
    // itself is non-extensible. The setter writes only to the witness so the
    // returned response still serializes as an empty object.
    return Object.preventExtensions(Object.create(prototype));
  }
  if (mode === 'return-proxy') {
    const target = action();
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
  const result = action();
  if (mode === 'async') return new Promise((resolve) => setTimeout(() => resolve(result), 5));
  return result;
}

function request(port, mode) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ ...REQUEST, data: { ...REQUEST.data, mode } });
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
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(body);
  });
}


const {readFileSync,writeFileSync} = await import('node:fs');
const source=JSON.parse(readFileSync(new URL('./original.json', import.meta.url)));
const service=createSkillService({name:'s01-root-review',skillId:'s01-fixture-skill',handler:matrixHandler});
await service.listen(0);
try {
 const actual={};
 for(const mode of Object.keys(source.normalized)) {
  const response=await request(service.server.address().port,mode);
  const body=JSON.parse(response.body);
  if(body.timings) assert.equal(typeof body.timings.total,'number');
  actual[mode]=normalizeWire(response);
 }
 assert.deepEqual(actual,source.normalized);
 assert.deepEqual(assignmentWitnesses,source.assignmentWitnesses);
 if (process.env.S01_COMPARISON_OUT) writeFileSync(process.env.S01_COMPARISON_OUT,JSON.stringify({cases:Object.keys(actual).length,pass:true,normalization:['msgID','ts','measured numeric timings.total'],actual,assignmentWitnesses},null,2)+'\n');
 console.log(JSON.stringify({cases:Object.keys(actual).length,pass:true}));
}finally{await new Promise(resolve=>service.server.close(resolve));}
