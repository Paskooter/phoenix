// A-08 runtime probe — start the OTA service on a real port and drive every one of the eight
// Update operations over the wire, recording the exact status + envelope each returns.
//
//   node docs/parity/evidence/2026-09-10/a08-update-delivery/probe.mjs [--json out.json]
//
// It NEVER contacts a robot: it only starts this process's own HTTP listener on 127.0.0.1 and
// serves fixture packages from a temp dir. No OTA installation is triggered anywhere.

import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Catalog } from '../../../../../packages/ota/src/catalog.js';
import { createOtaService } from '../../../../../packages/ota/src/service.js';

const sha1 = (b) => createHash('sha1').update(b).digest('hex');
const PKG = Buffer.from('OS-13.0.0-PROBE-'.repeat(64));
const FILES = {
  'os-12.10.0.tar': Buffer.from('OS-12.10.0-PROBE-'.repeat(48)),
  'be-green.tar': Buffer.from('BE-GREEN-PROBE-'.repeat(32)),
};
const ENTRIES = [
  { id: 'os-12.10.0', subsystem: 'os', fromVersion: '*', toVersion: '12.10.0', changes: 'os', filter: '', dependencies: {}, file: 'os-12.10.0.tar' },
  { id: 'be-green', subsystem: 'be', fromVersion: '*', toVersion: '10.0.16', changes: 'be', filter: 'green', dependencies: {}, file: 'be-green.tar' },
];
const ADMIN = { 'x-amz-credentials': JSON.stringify({ id: 'probe-admin', isAdmin: true }) };
const CREATOR = { 'x-amz-credentials': JSON.stringify({ id: 'probe-admin', isAdmin: true }) };

const dataDir = await mkdtemp(path.join(os.tmpdir(), 'a08-probe-'));
for (const [name, buf] of Object.entries(FILES)) await writeFile(path.join(dataDir, name), buf);
const catalog = await Catalog.load({ entries: ENTRIES, dataDir, log: {} });
const svc = await createOtaService({ catalog }).listen(0);
const port = svc.address().port;
const base = `http://127.0.0.1:${port}`;

const post = (op, body, headers = {}, raw = null) => fetch(`${base}/`, {
  method: 'POST',
  headers: {
    'content-type': raw ? 'application/octet-stream' : 'application/x-amz-json-1.1',
    'x-amz-target': `Update_20160301.${op}`,
    ...headers,
  },
  body: raw ?? JSON.stringify(body),
});

const results = [];
async function probe(op, label, make) {
  const r = await make();
  let body = null;
  try { body = await r.json(); } catch { body = null; }
  results.push({ op, label, status: r.status, errortype: r.headers.get('x-amzn-errortype'), body });
  return { r, body };
}

await probe('ListUpdates', 'subsystem=os (served)', () => post('ListUpdates', { subsystem: 'os' }));
await probe('ListUpdatesFrom', 'fromVersion 3.3.4 subsystem=os (served)', () => post('ListUpdatesFrom', { fromVersion: '3.3.4', subsystem: 'os' }));
await probe('GetUpdateFrom', 'optimal for os (served)', () => post('GetUpdateFrom', { fromVersion: '3.3.4', subsystem: 'os' }));
await probe('GetUpdateFrom', 'no applicable update -> 404', () => post('GetUpdateFrom', { fromVersion: '12.10.0', subsystem: 'os' }));
const created = await probe('CreateUpdate', 'admin upload (served)', () => post('CreateUpdate', null, {
  ...ADMIN, 'x-update-from-version': '12.10.0', 'x-update-to-version': '13.0.0', 'x-update-changes': 'probe',
}, PKG));
await probe('CreateUpdate', 'non-admin -> 403', () => post('CreateUpdate', null, {
  'x-amz-credentials': JSON.stringify({ id: 'nobody' }),
  'x-update-from-version': '50.0.0', 'x-update-to-version': '51.0.0', 'x-update-changes': 'x',
}, PKG));
await probe('ListUniqueFilters', 'admin (served)', () => post('ListUniqueFilters', {}, ADMIN));
await probe('SetTarget', 'admin (served)', () => post('SetTarget', { serial: 'PROBE-1', target: 'green' }, ADMIN));
await probe('ListTargets', 'admin (served)', () => post('ListTargets', {}, ADMIN));
await probe('RemoveUpdate', 'creator (served)', () => post('RemoveUpdate', { id: created.body._id }, CREATOR));
await probe('RemoveUpdate', 'unknown id -> 404', () => post('RemoveUpdate', { id: 'ffffffffffffffffffffffff' }, CREATOR));

// package delivery
const dl = await fetch(`${base}/ota/package?id=os-12.10.0`);
const bytes = Buffer.from(await dl.arrayBuffer());
const delivery = {
  status: dl.status,
  contentLength: Number(dl.headers.get('content-length')),
  contentType: dl.headers.get('content-type'),
  bytes: bytes.length,
  sha1Matches: sha1(bytes) === sha1(FILES['os-12.10.0.tar']),
  createdPackageSha: created.body?.shaHash === sha1(PKG),
  createdPackageLength: created.body?.length === PKG.length,
};
const health = await fetch(`${base}/healthcheck`);

const out = {
  date: new Date().toISOString(),
  base,
  catalogEntries: catalog.entries.length,
  healthcheck: { status: health.status, body: await health.text() },
  operations: results,
  delivery,
  served: [...new Set(results.map((r) => r.op))].sort(),
};
// The service logger and this probe share stdout, so the machine-readable artifact is written
// to a file (default: alongside this script) and only a summary goes to the console.
const outPath = process.argv[2] || fileURLToPath(new URL('./probe.json', import.meta.url));
await writeFile(outPath, `${JSON.stringify(out, null, 2)}\n`);
console.log(`probe: ${out.served.length} operations served, ${results.length} requests, delivery sha1 ok=${delivery.sha1Matches} -> ${outPath}`);
await new Promise((r) => svc.close(r));
await rm(dataDir, { recursive: true, force: true });
