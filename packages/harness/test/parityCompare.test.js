import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { compareTraces, validateTrace } from '../src/parityCompare.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const fixturePath = resolve(root, 'packages/harness/test/fixtures/foundation-reference.json');
const reference = JSON.parse(readFileSync(fixturePath, 'utf8'));
const provenance = JSON.parse(readFileSync(fixturePath.replace('.json', '.source.json'), 'utf8'));
const suite = JSON.parse(readFileSync(resolve(root, 'scripts/parity-compare/suite.json'), 'utf8'));
const clone = () => structuredClone(reference);
const get = (trace, id = 'listen-launch') => trace.cases.find(c => c.id === id);
const action = trace => get(trace).frames.find(f => f.message.type === 'SKILL_ACTION').message;
const hash = raw => createHash('sha256').update(raw).digest('hex');
const tag = raw => `W/"${Buffer.byteLength(raw).toString(16)}-${createHash('sha1').update(raw).digest('base64').slice(0, 27)}"`;
// Model a real corrupted response: update its raw bytes and derived headers too,
// so rejection proves semantic comparison rather than only decoder consistency.
function syncRaw(trace) {
  for (const c of trace.cases) {
    for (const r of [c.response, c.upgrade].filter(Boolean)) {
      r.rawBody = r.body.kind === 'json' ? JSON.stringify(r.body.value) : r.body.value;
      if (c.input.method !== 'HEAD') {
        if ('content-length' in r.headers) r.headers['content-length'] = String(Buffer.byteLength(r.rawBody));
        if ('etag' in r.headers) r.headers.etag = tag(r.rawBody);
      }
    }
    for (const f of c.frames || []) f.raw = JSON.stringify(f.message);
    for (const e of c.effects || []) {
      e.rawBody = e.body.kind === 'json' ? JSON.stringify(e.body.value) : e.body.value;
      if ('content-length' in e.headers) e.headers['content-length'] = String(Buffer.byteLength(e.rawBody));
    }
  }
}

test('original execution fixture is intact and satisfies independent invariants', () => {
  assert.equal(hash(readFileSync(fixturePath)), provenance.sha256);
  assert.deepEqual(validateTrace(reference, suite), []);
  assert.equal(compareTraces(reference, clone(), suite).pass, true);
});

const corruptions = [
  ['HTTP status', t => { get(t, 'http-null').response.status = 201; }],
  ['content type', t => { get(t, 'http-null').response.headers['content-type'] = 'text/plain'; }],
  ['HTTP clock', t => { get(t, 'http-null').response.headers.date = 'Wed, 30 May 2018 12:00:01 GMT'; }],
  ['null versus empty object', t => { get(t, 'http-null').response.body.value = {}; }],
  ['field absence', t => { delete action(t).data.analytics; }],
  ['intent', t => { get(t).frames[2].message.data.nlu.intent = 'wrong'; }],
  ['entities', t => { get(t).frames[2].message.data.nlu.entities.fixtureEntity = 'wrong'; }],
  ['winning rules', t => { get(t).frames[2].message.data.nlu.rules = []; }],
  ['memo', t => { get(t).effects.find(e => e.path === '/skill').body.value.data.result.memo.enabled = true; }],
  ['ESML', t => { action(t).data.action.config.jcp.config.play.esml = '<speak>Wrong answer.</speak>'; }],
  ['JCP', t => { action(t).data.action.config.jcp.type = 'Parallel'; }],
  ['analytics', t => { action(t).data.analytics.skill1[0].properties.enabled = true; }],
  ['opaque session contents', t => { action(t).data.skill.session.nodeID = 99; }],
  ['continuation forwarding', t => { get(t, 'listen-update').effects.find(e => e.path === '/skill').body.value.data.skill.session.data.answer = 'lost'; }],
  ['timing sentinel', t => { get(t).frames[0].message.timings.total = 0; }],
  ['missing timing', t => { delete get(t).frames[2].message.timings.asr; }],
  ['frame order', t => { get(t).frames.reverse(); }],
  ['duplicate terminal', t => { const c = get(t); c.frames.push(structuredClone(c.frames.at(-1))); c.terminalCount++; }],
  ['wall-time bound', t => { get(t).durationMs = 6000; }],
  ['close behavior', t => { get(t, 'listen-final-lifetime').openAfterFinal = false; }],
  ['dropped side effect', t => { get(t).effects.pop(); }],
  ['fixture substitution', t => { t.suiteSha256 = 'wrong'; }],
  ['case omission', t => { t.cases.pop(); }],
];
for (const [name, mutate] of corruptions) test(`gate rejects ${name}`, () => {
  const candidate = clone(); mutate(candidate); syncRaw(candidate);
  const result = compareTraces(reference, candidate, suite);
  assert.equal(result.pass, false);
  assert.ok(result.differences.length || result.invariants.length);
});

test('generated identifier bindings are bijective even if a reused ID equals the reference literal', () => {
  const candidate = clone(), c = get(candidate);
  c.frames[0].message.msgID = c.frames[1].message.msgID;
  syncRaw(candidate);
  const result = compareTraces(reference, candidate, suite);
  assert.equal(result.pass, false);
  assert.ok(result.differences.some(d => d.path.endsWith('/frames/1/message/msgID')));
});

test('fresh generated identifiers may differ while relationships remain intact', () => {
  const candidate = clone(), ids = new Map(); let n = 0;
  const rename = message => {
    if (!message?.msgID || !/^[0-9a-f-]{36}$/.test(message.msgID)) return;
    if (!ids.has(message.msgID)) ids.set(message.msgID, `11111111-1111-4111-8111-${(++n).toString(16).padStart(12, '0')}`);
    message.msgID = ids.get(message.msgID);
  };
  for (const c of candidate.cases) {
    rename(c.response?.body?.value);
    for (const f of c.frames || []) rename(f.message);
    for (const e of c.effects || []) rename(e.body.value);
  }
  syncRaw(candidate);
  assert.equal(compareTraces(reference, candidate, suite).pass, true);
});

test('only declared fixture endpoint paths may change ports', () => {
  const expected = clone(), candidate = clone();
  get(expected).frames[2].message.data.nlu.entities.link = 'http://example.test:8080/item';
  get(candidate).frames[2].message.data.nlu.entities.link = 'http://example.test:9090/item';
  syncRaw(expected); syncRaw(candidate);
  assert.equal(compareTraces(expected, candidate, suite).pass, false);
});

test('raw bytes and derived ETags are independently checked', () => {
  const candidate = clone();
  get(candidate, 'http-null').response.headers.etag = 'W/"4-invalid"';
  const result = compareTraces(reference, candidate, suite);
  assert.equal(result.pass, false);
  assert.ok(result.invariants.some(f => f.path.endsWith('/headers/etag')));
});

test('CLI exits nonzero for a corrupted session and retains a diff report', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'phoenix-parity-cli-'));
  try {
    const candidate = clone(); action(candidate).data.skill.session.data.answer = 'corrupted'; syncRaw(candidate);
    const file = resolve(dir, 'candidate.json'), output = resolve(dir, 'comparison.json');
    writeFileSync(file, JSON.stringify(candidate));
    const result = spawnSync(process.execPath, [resolve(root, 'packages/harness/src/index.js'), 'compare', '--reference', fixturePath, '--candidate', file, '--out', output], { encoding: 'utf8' });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(JSON.parse(readFileSync(output)).pass, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('clock fixture freezes automatic HTTP dates while preserving explicit headers and suppression', () => {
  const driver = resolve(root, 'scripts/parity-compare/driver.cjs');
  const script = `
    import http from 'node:http';
    import assert from 'node:assert/strict';
    import driver from ${JSON.stringify(driver)};
    driver.installClock();
    const explicit = 'Tue, 01 Jan 2019 00:00:00 GMT';
    const server = http.createServer((req, res) => {
      if (req.url === '/set') res.setHeader('Date', explicit);
      if (req.url === '/object') res.writeHead(200, { Date: explicit });
      if (req.url === '/array') res.writeHead(200, ['Date', explicit]);
      if (req.url === '/none') res.sendDate = false;
      res.end('fixture');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      for (const path of ['/', '/set', '/object', '/array', '/none']) {
        const headers = await new Promise((resolve, reject) => {
          http.get({ host: '127.0.0.1', port: server.address().port, path, agent: false }, res => {
            res.resume(); res.on('end', () => resolve(res.headers));
          }).on('error', reject);
        });
        assert.equal(headers.date, path === '/' ? 'Wed, 30 May 2018 12:00:00 GMT' : path === '/none' ? undefined : explicit);
      }
    } finally { await new Promise(resolve => server.close(resolve)); }
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
});
