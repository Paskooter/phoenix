import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createSkillService, skillRoute } from '../src/skillService.js';

const REQUEST = {
  type: 'LISTEN_LAUNCH',
  msgID: 'fixture-request',
  ts: 0,
  data: { general: {}, skill: { id: 'fixture-skill' } },
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
  return skillRoute('fixture-skill', handler)({ body: REQUEST, trace: {}, log });
}

function action(extra = {}) {
  return {
    type: 'SKILL_ACTION',
    msgID: 'fixture-response',
    ts: 0,
    data: { skill: { id: 'fixture-skill' } },
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

test('skillRoute measures awaited handler time and overwrites handler timings', async () => {
  const result = await invoke(async () => {
    await new Promise((resolve) => setTimeout(resolve, 8));
    return action({ timings: { total: 999 } });
  });

  assert.equal(Number.isInteger(result.timings.total), true);
  assert.ok(result.timings.total >= 5, `expected elapsed timing, got ${result.timings.total}`);
});

test('skillRoute preserves source error envelope without success timings', async () => {
  const result = await invoke(async () => { throw new Error('fixture failure'); });

  assert.equal(result.type, 'ERROR');
  assert.deepEqual(result.data, {
    message: 'fixture failure',
    skill: { id: 'fixture-skill' },
  });
  assert.equal(result.timings, undefined);
});

test('skillRoute uses source error message conversion for strings and objects', async () => {
  const stringError = await invoke(async () => { throw 'fixture string failure'; });
  const objectError = await invoke(async () => { throw { code: 'FIXTURE' }; });

  assert.equal(stringError.data.message, 'fixture string failure');
  assert.equal(objectError.data.message, 'Error: {"code":"FIXTURE"}');
});

test('result assignment uses the frozen Node 8 wrapper error wording', async () => {
  const cases = [
    [undefined, "Cannot set property 'timings' of undefined"],
    [null, "Cannot set property 'timings' of null"],
    [7, "Cannot create property 'timings' on number '7'"],
    [false, "Cannot create property 'timings' on boolean 'false'"],
    ['fixture', "Cannot create property 'timings' on string 'fixture'"],
    [Object.freeze({}), 'Cannot add property timings, object is not extensible'],
  ];

  for (const [value, message] of cases) {
    const result = await invoke(async () => value);
    assert.equal(result.type, 'ERROR');
    assert.equal(result.data.message, message);
    assert.deepEqual(result.data.skill, { id: 'fixture-skill' });
    assert.equal(result.timings, undefined);
  }
});

test('createSkillService matches the normalized source status/body matrix', async () => {
  const service = createSkillService({
    name: 'skill-response-test',
    skillId: 'fixture-skill',
    handler: matrixHandler,
  });
  await service.listen(0);
  const port = service.server.address().port;

  try {
    const modes = [
      'success', 'async', 'throw-error', 'throw-string', 'throw-object',
      'throw-null', 'throw-undefined', 'return-undefined', 'callback',
      'return-null', 'return-number', 'return-boolean', 'return-string',
      'return-frozen', 'return-readonly', 'return-getter', 'return-setter-error',
      'return-inherited-setter', 'return-proxy',
    ];
    const actual = {};
    for (const mode of modes) actual[mode] = normalizeWire(await request(port, mode));

    const skillError = (message) => ({
      status: 200,
      body: {
        type: 'ERROR', msgID: '<msgID>', ts: '<ts>',
        data: { message, skill: { id: 'fixture-skill' } },
      },
    });
    const serviceError = (message) => ({
      status: 500,
      body: {
        type: 'ERROR', msgID: '<msgID>', ts: '<ts>', final: true,
        data: { message },
      },
    });
    const expectedAction = {
      status: 200,
      body: {
        type: 'SKILL_ACTION', msgID: '<msgID>', ts: '<ts>',
        data: { skill: { id: 'fixture-skill' } }, timings: { total: '<timing-number>' },
      },
    };
    assert.deepEqual(actual, {
      success: expectedAction,
      async: expectedAction,
      'throw-error': skillError('fixture failure'),
      'throw-string': skillError('fixture string failure'),
      'throw-object': skillError('Error: {"code":"FIXTURE"}'),
      'throw-null': serviceError("Cannot read property 'message' of null"),
      'throw-undefined': serviceError("Cannot read property 'message' of undefined"),
      'return-undefined': skillError("Cannot set property 'timings' of undefined"),
      callback: skillError("Cannot set property 'timings' of undefined"),
      'return-null': skillError("Cannot set property 'timings' of null"),
      'return-number': skillError("Cannot create property 'timings' on number '7'"),
      'return-boolean': skillError("Cannot create property 'timings' on boolean 'false'"),
      'return-string': skillError("Cannot create property 'timings' on string 'fixture'"),
      'return-frozen': skillError('Cannot add property timings, object is not extensible'),
      'return-readonly': skillError("Cannot assign to read only property 'timings' of object '#<Object>'"),
      'return-getter': skillError('Cannot set property timings of #<Object> which has only a getter'),
      'return-setter-error': skillError('custom setter failure'),
      'return-inherited-setter': { status: 200, body: {} },
      'return-proxy': expectedAction,
    });
    assert.equal(assignmentWitnesses.inheritedSetterCalled, true);
    assert.equal(assignmentWitnesses.proxyAssigned, true);
    assert.equal(assignmentWitnesses.proxyInspectedBeforeAssignment, false);
  } finally {
    await new Promise((resolve, reject) => service.server.close((error) => error ? reject(error) : resolve()));
  }
});
