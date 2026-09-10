import { writeFileSync } from 'node:fs';
import { createHistoryService } from '@phoenix/history/src/index.js';
import { HistoryStore } from '@phoenix/history/src/store.js';
const svc = createHistoryService(new HistoryStore());
await svc.listen(0);
const base = `http://127.0.0.1:${svc.server.address().port}`;
const out = [];
async function p(label, path, opts) {
  const res = await fetch(base + path, opts);
  const t = await res.text();
  let j; try { j = t === '' ? null : JSON.parse(t); } catch { j = t; }
  out.push({ label, status: res.status, ct: res.headers.get('content-type'), body: j });
}
await p('POST /v1/skill/launch malformed JSON', '/v1/skill/launch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"a":' });
await p('POST /v1/skill/launch urlencoded body', '/v1/skill/launch', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'robotID=R&sessionID=s&skillID=SK&timestamp=1' });
await p('POST /v1/skill/launch/ latest unknown rule field', '/v1/skill/launch/latest', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ robotID: 'R', rules: [{ field: 'bogus', value: 'x' }] }) });
await p('POST /v1/skill/launch/latest bad match method', '/v1/skill/launch/latest', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ robotID: 'R', rules: [{ field: 'intent', value: 'x', match: 'NOPE' }] }) });
await p('POST /v1/skill/launch/latest conflicting intent+rule', '/v1/skill/launch/latest', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ robotID: 'R', intent: 'a', rules: [{ field: 'intent', value: 'b' }] }) });
writeFileSync(process.argv[2] || 'extra-cases.json', JSON.stringify(out, null, 2));
svc.server.close();
