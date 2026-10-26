import { test } from 'node:test';
import assert from 'node:assert/strict';
import { portalRoutes } from '../src/portalApi.js';
import { buildQrCodes } from '../src/qrPayload.js';
import { qrMatrix } from '../portal/qr.js';
import { createHash } from 'node:crypto';

const messages = {
  name: 'Enter your Wi-Fi network name.',
  long: 'That Wi-Fi name is too long for Jibo. Wi-Fi names are at most 32 characters, fewer with accents or emoji.',
  password: 'Wi-Fi passwords are 8 to 63 characters. Leave it blank only for an open network.',
  lf: "Wi-Fi names and passwords can't contain line breaks.",
  unicode: "That Wi-Fi name or password has a character Jibo can't use. Retype it and try again.",
  static: 'Check the static network settings: IP address, subnet mask and gateway must be valid addresses.',
};
const network = { ssid: 'Example-Net', password: 'example-password' };
const staticConfig = { ip: '192.0.2.2', netmask: '255.255.255.0', gateway: '192.0.2.1', dns1: '', dns2: '' };
function fixture(path, existing) {
  let flushes = 0;
  const store = { flush() { flushes++; } };
  for (const key of ['accounts', 'sessions', 'tokens', 'loops', 'members', 'codes', 'invitations', 'deletedAccounts', 'outbox', 'settings', 'settingsDefinitions', 'robotAccounts', 'emailVerifications', 'passwordResets']) store[key] = new Map();
  store.accounts.set('fixture-owner', { _id: 'fixture-owner', isActive: true });
  store.sessions.set('fixture-session', { _id: 'fixture-session', kind: 'user', accountId: 'fixture-owner', created: Date.now() });
  store.loops.set('fixture-loop', { _id: 'fixture-loop', owner: 'fixture-owner', robot: 'fixture-robot' });
  if (existing) store.tokens.set('Fixture', { _id: 'Fixture', accountId: 'fixture-owner', loopId: path.endsWith('wifi') ? 'fixture-loop' : null, created: existing === 'expired' ? 1 : Date.now() });
  const forbid = () => { throw new Error('Unexpected peer request'); };
  const routes = portalRoutes(store, { classicCall: forbid, mailProviders: {}, identityProviders: {}, requireEmailVerification: false });
  return { store, flushes: () => flushes, call(body) {
    let status = 200, data;
    const res = { setHeader() {}, writeHead(code) { status = code; }, end(text) { data = JSON.parse(text); } };
    const value = routes[`POST ${path}`]({ req: { headers: { cookie: 'phx_session=fixture-session' } }, res, body: { loopId: 'fixture-loop', ...body } });
    return { status, data: data ?? value };
  } };
}
const invalid = [
  ['missing name', { ssid: undefined }, 'name'], ['empty name', { ssid: '' }, 'name'],
  ['nonstring name', { ssid: 7 }, 'name'], ['33 ASCII bytes', { ssid: 's'.repeat(33) }, 'long'],
  ['33 accented UTF-8 bytes', { ssid: 'é'.repeat(16) + 'a' }, 'long'],
  ['seven password units', { password: 'p'.repeat(7) }, 'password'],
  ['64 password units', { password: 'p'.repeat(64) }, 'password'],
  ['nonstring password', { password: 42 }, 'password'],
  ['LF name', { ssid: 'Example\nNet' }, 'lf'], ['LF password', { password: 'example\npass' }, 'lf'],
  ['high surrogate name', { ssid: 'Example\ud800' }, 'unicode'], ['low surrogate name', { ssid: 'Example\udc00' }, 'unicode'],
  ['high surrogate password', { password: 'example\ud800' }, 'unicode'], ['low surrogate password', { password: 'example\udc00' }, 'unicode'],
  ['empty static object', { static: {} }, 'static'],
  ['missing static IP', { static: { ...staticConfig, ip: '' } }, 'static'],
  ...['ip', 'netmask', 'gateway', 'dns1', 'dns2'].map((key) => [`invalid static ${key}`, { static: { ...staticConfig, [key]: '256.0.0.1' } }, 'static']),
  ['nonobject static', { static: '192.0.2.2' }, 'static'],
  ['abbreviated IPv4', { static: { ...staticConfig, gateway: '127.1' } }, 'static'],
  ['static LF', { static: { ...staticConfig, dns1: '192.0.2.1\n' } }, 'static'],
  ['error precedence', { ssid: '', password: 'x', static: {} }, 'name'],
];
for (const path of ['/api/robots/setup', '/api/robots/wifi']) {
  for (const [label, changed, message] of invalid) test(`${path}: refuses ${label} before token mutation`, () => {
    for (const existing of [false, 'expired', 'valid']) {
      const f = fixture(path, existing);
      const before = structuredClone([...f.store.tokens]);
      const result = f.call({ ...network, ...changed });
      assert.equal(result.status, 400);
      assert.deepEqual(result.data, { error: messages[message] });
      assert.deepEqual([...f.store.tokens], before, 'no token created, refreshed or removed');
      assert.equal(f.flushes(), 0, 'no persistent mutation');
    }
  });
  for (const [label, body] of [
    ['32 ASCII bytes', { ...network, ssid: 's'.repeat(32) }],
    ['32 accented UTF-8 bytes', { ...network, ssid: 'é'.repeat(16) }],
    ['eight password units', { ...network, password: 'p'.repeat(8) }],
    ['63 password units', { ...network, password: 'p'.repeat(63) }],
    ['UTF-16 password units', { ...network, password: '😀'.repeat(31) + 'p' }],
    ['open network', { ...network, password: '' }],
    ['literal whitespace and Unicode', { ssid: ' Café😀 ', password: ' café😀pw ' }],
    ['static defaults', { ...network, static: staticConfig }],
    ['static DNS', { ...network, static: { ...staticConfig, dns1: '192.0.2.53', dns2: '198.51.100.53' } }],
  ]) test(`${path}: accepts ${label} without changing QR payload bytes`, () => {
    const f = fixture(path, 'valid');
    const result = f.call(body);
    assert.equal(result.status, 200);
    assert.equal(result.data.token, 'Fixture');
    assert.deepEqual(result.data.qr.codes, buildQrCodes({ ssid: body.ssid, password: body.password, staticConfig: body.static, token: 'Fixture' }).codes);
  });
}

// Frozen payload and matrix digests from the preceding encoder revision.
const golden = [
  {
    "input": {
      "ssid": "Example-Net",
      "password": "example-password"
    },
    "sha256": "219ffd000ccea33e34450c81ed73b116414fdff7ffc444785836c05b04a3378c"
  },
  {
    "input": {
      "ssid": "\u00e9\u00e9\u00e9\u00e9\u00e9\u00e9\u00e9\u00e9\u00e9\u00e9\u00e9\u00e9\u00e9\u00e9\u00e9\u00e9",
      "password": "ppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppp"
    },
    "sha256": "8a59734dad5ea01eb2c214e9d0002dc4887f697bb2fdedff6b05a7c27e899c6f"
  },
  {
    "input": {
      "ssid": "ssssssssssssssssssssssssssssssss",
      "password": ""
    },
    "sha256": "663428e3efdf47441f5a41c185ee57abc6257d3e01fa2e0caa6288648b01463b"
  },
  {
    "input": {
      "ssid": " Caf\u00e9\ud83d\ude00 ",
      "password": " caf\u00e9\ud83d\ude00pw "
    },
    "sha256": "34194d936b4ea0c37b4785d5abd304eb1568c968466c2bc331f086c917fc68cd"
  },
  {
    "input": {
      "ssid": "Example-Net",
      "password": "example-password",
      "staticConfig": {
        "ip": "192.0.2.2",
        "netmask": "255.255.255.0",
        "gateway": "192.0.2.1",
        "dns1": "",
        "dns2": ""
      }
    },
    "sha256": "43147cc3116764638f1cf6507f67f29b397703aea1ec4f3d7679059c0d567337"
  }
];
for (const [index, { input, sha256 }] of golden.entries()) test(`QR fixture ${index + 1} retains payload and matrix bytes`, () => {
  const output = buildQrCodes({ ...input, token: 'Fixture' });
  const actual = createHash('sha256').update(JSON.stringify({ output, matrices: output.codes.map(qrMatrix) })).digest('hex');
  assert.equal(actual, sha256);
});
