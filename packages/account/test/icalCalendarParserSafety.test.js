import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchIcalText, validateIcalUrl } from '../src/icalSubscriptions.js';

test('iCal URL policy allows LAN http(s)/webcal and rejects other schemes', () => {
  assert.equal(validateIcalUrl('http://127.0.0.1:8080/calendar.ics').protocol, 'http:');
  assert.equal(validateIcalUrl('webcal://calendar.lan/feed').protocol, 'webcal:');
  assert.throws(() => validateIcalUrl('ftp://calendar.test/feed'), /scheme|protocol/i);
  assert.throws(() => validateIcalUrl('javascript:alert(1)'), /scheme|protocol/i);
});

test('iCal fetching aborts a body that stalls after headers', async () => {
  let receivedSignal;
  const response = {
    status: 200,
    ok: true,
    headers: { get: () => null },
    body: {
      getReader: () => ({
        read: () => new Promise(() => {}),
        cancel: async () => {},
        releaseLock: () => {},
      }),
    },
  };
  await assert.rejects(
    fetchIcalText('http://calendar.lan/stalled.ics', {
      timeoutMs: 20,
      fetchImpl: async (_url, options) => { receivedSignal = options.signal; return response; },
    }),
    /timed out/,
  );
  assert.equal(receivedSignal.aborted, true);
});

test('iCal fetching does not follow an unsafe redirect scheme', async () => {
  let calls = 0;
  await assert.rejects(
    fetchIcalText('https://calendar.test/feed.ics', {
      fetchImpl: async () => {
        calls += 1;
        return {
          status: 302,
          ok: false,
          headers: { get: (name) => name === 'location' ? 'file:///etc/passwd' : null },
        };
      },
    }),
    /scheme|protocol/i,
  );
  assert.equal(calls, 1);
});
