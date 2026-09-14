#!/usr/bin/env node

/* Focused adversarial checks for the raw-evidence v2 lane.  The legacy
 * fixture remains useful for the broad receipt tests in test.mjs; these tests
 * deliberately introduce just enough v2 metadata to enter the strict lane,
 * then verify that the old synthetic transport shortcuts are rejected. */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReceipt } from './test-fixture.mjs';
import {
  addLocalDays,
  canonicalSha256,
  falsificationAnchorSha256,
  provenanceAnchorSha256,
  sha256Bytes,
  validatePngBytes,
  validateReceipt
} from './validate.mjs';

const matrix = JSON.parse(fs.readFileSync(new URL('./matrix.json', import.meta.url), 'utf8'));

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
  return Buffer.concat([length, typeBytes, data, checksum]);
}

function pngFixture() {
  const width = 320;
  const height = 200;
  const rowBytes = width * 4 + 1;
  const scanlines = Buffer.alloc(rowBytes * height);
  for (let row = 0; row < height; row += 1) {
    scanlines[row * rowBytes] = 0;
    for (let column = 0; column < width; column += 1) {
      const pixel = row * rowBytes + 1 + column * 4;
      scanlines[pixel] = column % 251;
      scanlines[pixel + 1] = row % 251;
      scanlines[pixel + 2] = (row + column) % 251;
      scanlines[pixel + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(scanlines)),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

function rewriteRawRefs(root, row, files) {
  const refNames = { 'turn.json': 'rawTurn', 'fixture.json': 'rawFixture', 'wire.jsonl': 'rawWire' };
  for (const [name, content] of Object.entries(files)) {
    const relative = `raw/${row.id}/${name}`;
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const bytes = Buffer.from(content, 'utf8');
    fs.writeFileSync(target, bytes);
    row.actual.artifacts[refNames[name] || name.replace(/\.jsonl?$/, '')] = {
      path: relative,
      sha256: sha256Bytes(bytes),
      bytes: bytes.length
    };
  }
}

function rewriteJsonRef(root, ref, value) {
  const bytes = Buffer.from(JSON.stringify(value), 'utf8');
  fs.writeFileSync(path.join(root, ref.path), bytes);
  ref.sha256 = sha256Bytes(bytes);
  ref.bytes = bytes.length;
}

function truthfulAnchors(receipt) {
  const visualReviewSha256 = {};
  for (const row of receipt.cases) {
    if (row.actual?.artifacts?.visualReview) visualReviewSha256[row.id] = row.actual.artifacts.visualReview.sha256;
  }
  return {
    visualReviewSha256,
    provenanceSha256: provenanceAnchorSha256(receipt),
    captureWindow: { startISO: '2020-01-01T00:00:00.000Z', endISO: '2090-01-01T00:00:00.000Z' },
    falsifierReceiptSha256: falsificationAnchorSha256(receipt.falsification)
  };
}

test('PNG validation inflates every IDAT stream and rejects zlib corruption with a repaired CRC', () => {
  const valid = pngFixture();
  assert.equal(validatePngBytes(valid).result, 'pass');

  const corrupt = Buffer.from(valid);
  let cursor = 8;
  while (cursor < corrupt.length) {
    const length = corrupt.readUInt32BE(cursor);
    const type = corrupt.subarray(cursor + 4, cursor + 8).toString('ascii');
    if (type === 'IDAT') {
      const dataStart = cursor + 8;
      corrupt[dataStart] ^= 0xff;
      const crcStart = dataStart + length;
      corrupt.writeUInt32BE(crc32(corrupt.subarray(cursor + 4, crcStart)), crcStart);
      break;
    }
    cursor += 12 + length;
  }
  const report = validatePngBytes(corrupt);
  assert.equal(report.result, 'fail');
  assert.ok(report.errors.some((error) => /IDAT zlib stream is invalid/.test(error)), report.errors.join('; '));
});

test('v2 raw wire rejects ACK/idle rows and requires the missing physical refs', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phoenix-s13-v2-'));
  try {
    const receipt = buildReceipt(matrix, root);
    const row = receipt.cases.find((item) => item.id === 'commute-normal-combined');
    rewriteRawRefs(root, row, {
      'turn.json': '{}',
      'fixture.json': '{}',
      'wire.jsonl': [
        JSON.stringify({ kind: 'server-message', at: '2026-09-14T00:00:00.000Z', json: { type: 'ACK' } }),
        JSON.stringify({ kind: 'server-message', at: '2026-09-14T00:00:01.000Z', json: { type: 'IDLE' } })
      ].join('\n') + '\n'
    });
    receipt.falsification.receiptSha256 = falsificationAnchorSha256(receipt.falsification);
    const report = validateReceipt(receipt, matrix, { root, externalAnchors: truthfulAnchors(receipt) });
    assert.equal(report.result, 'fail');
    assert.ok(report.errors.some((error) => /rawWire\[0\].*forbidden synthetic ack/i.test(error)), report.errors.join('; '));
    assert.ok(report.errors.some((error) => /rawWire\[1\].*forbidden synthetic idle/i.test(error)), report.errors.join('; '));
    assert.ok(!report.errors.some((error) => /nativeReport contains forbidden ACK\/idle\/provider-return type/.test(error)), report.errors.join('; '));
    assert.ok(report.errors.some((error) => /wireFlow\.schema/.test(error)), report.errors.join('; '));
    assert.ok(report.errors.some((error) => /artifacts\.rawWire must be an object/.test(error)), report.errors.join('; '));
    assert.ok(report.errors.some((error) => /sourceSnapshot\.snapshotIndex/.test(error)), report.errors.join('; '));
    assert.ok(report.errors.some((error) => /sourceScreenshot must be an object/.test(error)), report.errors.join('; '));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('strict anchor projection changes cannot be rehashed inside the receipt', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phoenix-s13-anchor-'));
  try {
    const receipt = buildReceipt(matrix, root);
    const row = receipt.cases.find((item) => item.id === 'commute-normal-combined');
    rewriteRawRefs(root, row, { 'turn.json': '{}', 'fixture.json': '{}', 'wire.jsonl': '{}\n' });
    receipt.falsification.receiptSha256 = falsificationAnchorSha256(receipt.falsification);
    const anchors = truthfulAnchors(receipt);
    receipt.provenance.phoenix.worktree = '/forged';
    const report = validateReceipt(receipt, matrix, { root, externalAnchors: anchors });
    assert.equal(report.result, 'fail');
    assert.ok(report.errors.some((error) => /provenance does not match the external provenance anchor/.test(error)), report.errors.join('; '));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('provider rows bind exact service/input cardinality and cannot invent a transID', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phoenix-s13-provider-'));
  try {
    const receipt = buildReceipt(matrix, root);
    const row = receipt.cases.find((item) => item.id === 'commute-normal-combined');
    const rawProvider = { kind: 'fixture-provider', at: '2026-09-14T00:00:00.000Z', service: 'settings', caseId: 'Normal', input: { transID: 'raw-tl' } };
    const rawFixture = {
      schema: 'phoenix-s13-robot-fixture-v1',
      caseId: 'Normal',
      cases: { Normal: { maps: { routes: [{ legs: [{ duration: { value: 600 }, duration_in_traffic: { value: 600 } }] }] } } }
    };
    rawFixture.integrity = { casesSha256: canonicalSha256(rawFixture.cases) };
    const forgedProvider = { ...rawProvider, caseId: 'forged-case' };
    rewriteRawRefs(root, row, {
      'turn.json': '{}',
      'fixture.json': JSON.stringify(rawFixture),
      // The forged case ID is rehashed into the raw-wire reference below;
      // the provider fixture still selects the exact Normal source case.
      'wire.jsonl': `${JSON.stringify(forgedProvider)}\n`
    });
    const fixture = JSON.parse(fs.readFileSync(path.join(root, row.actual.artifacts.providerFixture.path), 'utf8'));
    fixture.sourceFixture = { path: row.actual.artifacts.rawFixture.path, sha256: row.actual.artifacts.rawFixture.sha256, caseKey: 'Normal' };
    rewriteJsonRef(root, row.actual.artifacts.providerFixture, fixture);
    row.actual.provider.fixtureSha256 = row.actual.artifacts.providerFixture.sha256;
    const providerCall = {
      type: 'provider-call',
      service: 'settings',
      input: { transID: 'raw-tl' },
      transID: 'forged-tl',
      timestampISO: '2026-09-14T00:00:00.000Z',
      fixturePath: row.actual.artifacts.providerFixture.path,
      fixtureSha256: row.actual.provider.fixtureSha256,
      provider: row.actual.provider,
      source: {
        line: 0,
        kind: 'fixture-provider',
        sha256: sha256Bytes(Buffer.from(JSON.stringify(forgedProvider), 'utf8')),
        traceSha256: row.actual.artifacts.rawWire.sha256
      }
    };
    const providerTrace = row.actual.artifacts.providerTrace;
    rewriteJsonRef(root, providerTrace, providerCall);
    fs.writeFileSync(path.join(root, providerTrace.path), Buffer.from(JSON.stringify(providerCall) + '\n'));
    providerTrace.sha256 = sha256Bytes(fs.readFileSync(path.join(root, providerTrace.path)));
    providerTrace.bytes = fs.statSync(path.join(root, providerTrace.path)).size;
    receipt.falsification.receiptSha256 = falsificationAnchorSha256(receipt.falsification);
    const report = validateReceipt(receipt, matrix, { root, externalAnchors: truthfulAnchors(receipt) });
    assert.equal(report.result, 'fail');
    assert.ok(report.errors.some((error) => /providerTrace\[0\]\.source case ID does not bind the selected fixture case/.test(error)), report.errors.join('; '));
    assert.ok(report.errors.some((error) => /providerTrace\[0\].*transID.*raw input transID/.test(error)), report.errors.join('; '));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('raw fixture event mutations fail after rehashing the raw artifact', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phoenix-s13-fixture-falsifier-'));
  try {
    const receipt = buildReceipt(matrix, root);
    const row = receipt.cases.find((item) => item.id === 'calendar-concurrent-parallel');
    const calendarDate = row.actual.request.calendarDateISO;
    const rawCase = {
      maps: { routes: [{ legs: [{ duration: { value: 600 }, duration_in_traffic: { value: 600 } }] }] },
      calendar: {
        google: { personalCalendar: { items: [{ summary: 'Personal standup', start: { dateTime: `${calendarDate}T11:00:00-04:00` }, end: { dateTime: `${calendarDate}T11:30:00-04:00` } }] }, workCalendar: { items: [] } },
        outlook: { personalCalendar: { value: [] }, workCalendar: { value: [{ subject: 'Work review', isAllDay: false, start: { dateTime: `${calendarDate}T11:00:00` }, end: { dateTime: `${calendarDate}T11:30:00` } }] } }
      },
      meta: {
        date: row.actual.localDateISO,
        timeZone: 'America/New_York',
        eventTimestamps: [
          { service: 'google', calendar: 'personalCalendar', index: 0, start: `${calendarDate}T11:00:00-04:00`, end: `${calendarDate}T11:30:00-04:00` },
          { service: 'outlook', calendar: 'workCalendar', index: 0, start: `${calendarDate}T11:00:00`, end: `${calendarDate}T11:30:00` }
        ]
      }
    };
    const rawFixture = {
      schema: 'phoenix-s13-robot-fixture-v1',
      caseId: 'calendar-parallel',
      integrity: { casesSha256: canonicalSha256({ 'calendar-parallel': rawCase }) },
      cases: { 'calendar-parallel': rawCase }
    };
    rewriteRawRefs(root, row, {
      'turn.json': '{}',
      'fixture.json': `${JSON.stringify(rawFixture)}\n`,
      'wire.jsonl': '{}\n'
    });
    const providerPath = path.join(root, row.actual.artifacts.providerFixture.path);
    const provider = JSON.parse(fs.readFileSync(providerPath, 'utf8'));
    provider.sourceFixture = {
      path: row.actual.artifacts.rawFixture.path,
      sha256: row.actual.artifacts.rawFixture.sha256,
      caseKey: 'calendar-parallel'
    };
    rewriteJsonRef(root, row.actual.artifacts.providerFixture, provider);
    row.actual.provider.fixtureSha256 = row.actual.artifacts.providerFixture.sha256;
    // The attacker rehashes the raw fixture and its receipt references, but
    // cannot make the private provider projection agree with the changed
    // source event without also changing the independently reviewed fixture.
    receipt.falsification.receiptSha256 = falsificationAnchorSha256(receipt.falsification);
    const report = validateReceipt(receipt, matrix, { root, externalAnchors: truthfulAnchors(receipt) });
    assert.equal(report.result, 'fail');
    assert.ok(report.errors.some((error) => /providerFixture\.events do not bind raw fixture event bytes/.test(error)), report.errors.join('; '));
    assert.ok(addLocalDays(row.actual.localDateISO, 1, 'America/New_York') === calendarDate);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
