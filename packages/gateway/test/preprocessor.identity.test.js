import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  preprocessContext,
  validateContextMessage,
} from '../src/preprocessor.js';

const AUTH = { id: 'acct-1', friendlyId: 'robot-1' };
const REMOTE = '192.0.2.10';

function context(data, auth) {
  if (arguments.length < 2) auth = AUTH;
  const message = { type: 'CONTEXT', data };
  preprocessContext(message, auth, REMOTE);
  return message;
}

function expectError(fn, message, name = 'Error') {
  assert.throws(fn, (error) => {
    assert.equal(error.name, name);
    assert.equal(error.message, message);
    return true;
  });
}

test('CONTEXT defaults come from authenticated identity and loop names are trimmed', () => {
  const message = context({
    runtime: {
      loop: {
        users: [
          { firstName: '  Ada ', lastName: ' Lovelace  ', phoneticName: ' A-da ' },
          { firstName: '', lastName: null, phoneticName: false },
        ],
      },
    },
    skill: null,
  });

  assert.deepEqual(message.data.general, {
    accountID: 'acct-1',
    robotID: 'robot-1',
    lang: 'en',
    release: '1.8.0',
    remoteAddress: REMOTE,
  });
  assert.deepEqual(message.data.runtime.loop.users, [
    { firstName: 'Ada', lastName: 'Lovelace', phoneticName: 'A-da' },
    { firstName: '', lastName: null, phoneticName: false },
  ]);
});

test('CONTEXT general overrides are preserved before identity validation', () => {
  const message = context({
    general: {
      accountID: AUTH.id,
      robotID: AUTH.friendlyId,
      lang: 'en-US',
      release: 'robot-release',
      remoteAddress: '198.51.100.5',
      extra: 'preserved',
    },
    runtime: { loop: {} },
  });
  assert.deepEqual(message.data.general, {
    accountID: 'acct-1',
    robotID: 'robot-1',
    lang: 'en-US',
    release: 'robot-release',
    remoteAddress: '198.51.100.5',
    extra: 'preserved',
  });
});

test('CONTEXT rejects conflicting and explicitly missing identity fields', () => {
  const cases = [
    [{ accountID: 'acct-other', robotID: AUTH.friendlyId }, 'data.general.accountID is not equal to socket accountID'],
    [{ accountID: AUTH.id, robotID: 'robot-other' }, 'data.general.robotID is not equal to socket robotID'],
    [{ accountID: '', robotID: AUTH.friendlyId }, 'accountID is missing in general data'],
    [{ accountID: AUTH.id, robotID: null }, 'robotID is missing in general data'],
    [{ accountID: AUTH.id, robotID: AUTH.friendlyId, release: '' }, 'release is missing in general data'],
  ];
  for (const [general, error] of cases) {
    expectError(() => context({ general, runtime: { loop: {} } }), error);
  }
});

test('malformed CONTEXTs preserve source property and iteration errors', () => {
  expectError(() => context({ general: {} }), "Cannot read property 'loop' of undefined", 'TypeError');
  expectError(() => context({ general: {}, runtime: null }), "Cannot read property 'loop' of null", 'TypeError');
  expectError(() => context({ general: {}, runtime: { loop: { users: {} } } }), 'loop.users.forEach is not a function', 'TypeError');
  expectError(() => context({ general: {}, runtime: { loop: { users: [null] } } }), "Cannot read property 'firstName' of null", 'TypeError');
  expectError(() => context({ general: {}, runtime: { loop: { users: [{ firstName: 7 }] } } }), 'user.firstName.trim is not a function', 'TypeError');
  expectError(() => context(undefined), "Cannot read property 'general' of undefined", 'TypeError');
  expectError(() => context(null), "Cannot read property 'general' of null", 'TypeError');
});

test('disabled-auth CONTEXT does not invent an anonymous identity', () => {
  expectError(() => context({ general: {}, runtime: { loop: {} } }, null), "Cannot read property 'id' of null", 'TypeError');
  expectError(() => context({ general: {}, runtime: { loop: {} } }, undefined), "Cannot read property 'id' of undefined", 'TypeError');
  expectError(() => context({ general: {}, runtime: { loop: {} } }, {}), 'accountID is missing in general data');
});

test('validateContextMessage keeps the source minimal checks', () => {
  const message = { type: 'CONTEXT', data: { general: { accountID: 'a', robotID: 'r' } } };
  assert.equal(validateContextMessage(message), message);
  const withoutType = { data: { general: { accountID: 'a', robotID: 'r' } } };
  assert.equal(validateContextMessage(withoutType), withoutType);
  expectError(() => validateContextMessage({ data: { general: {} } }), 'Invalid CONTEXT message: accountID is missing');
  expectError(() => validateContextMessage({ data: { general: { accountID: 'a' } } }), 'Invalid CONTEXT message: robotID is missing');
  expectError(() => validateContextMessage({ data: {} }), 'Invalid CONTEXT message: accountID is missing');
});
