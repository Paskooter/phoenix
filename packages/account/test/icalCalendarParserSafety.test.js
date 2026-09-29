import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { fetchIcalText, validateIcalUrl } from '../src/icalSubscriptions.js';

test('iCal URL policy allows LAN http(s)/webcal and rejects other schemes', () => {
  assert.equal(validateIcalUrl('http://127.0.0.1:8080/calendar.ics', { allowPrivateHosts: true }).protocol, 'http:');
  assert.equal(validateIcalUrl('webcal://calendar.lan/feed', { allowPrivateHosts: true }).protocol, 'webcal:');
  assert.throws(() => validateIcalUrl('http://127.0.0.1:8080/calendar.ics'), /host is not allowed/);
  assert.throws(() => validateIcalUrl('http://[::ffff:7f00:1]/feed.ics'), /host is not allowed/);
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

test('iCal production fetch connects to the checked DNS address and rejects a mixed public/private answer', async () => {
  let requests = 0;
  const source = http.createServer((_req, res) => {
    requests += 1;
    res.writeHead(200, { 'content-type': 'text/calendar' });
    res.end('BEGIN:VCALENDAR\nEND:VCALENDAR\n');
  });
  await new Promise((resolve) => source.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://calendar.example.test:${source.address().port}/feed.ics`;
    const body = await fetchIcalText(url, {
      allowPrivateHosts: true,
      dnsLookup: async () => [{ address: '127.0.0.1', family: 4 }],
    });
    assert.match(body, /BEGIN:VCALENDAR/);
    assert.equal(requests, 1, 'the validated address was used even though the hostname has no public DNS');
    await assert.rejects(fetchIcalText(url, {
      dnsLookup: async () => [
        { address: '8.8.8.8', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ],
    }), /host is not allowed/);
    assert.equal(requests, 1, 'an unsafe DNS answer was rejected before connecting');
  } finally {
    await new Promise((resolve) => source.close(resolve));
  }
});
