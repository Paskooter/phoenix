// I-01 runtime route probe. Starts the REAL history service on an ephemeral port and
// sends every route with the shapes the pinned `@jibo/history-client` produces, recording
// status + headers + body. Prints one JSON object; nothing is inferred from source here.
import { writeFileSync } from 'node:fs';
import { createHistoryService } from '@phoenix/history/src/index.js';
import { HistoryStore } from '@phoenix/history/src/store.js';

const TS = Date.now();

async function probe(svc, method, path, { body, query, raw, headers } = {}) {
  const base = `http://127.0.0.1:${svc.server.address().port}`;
  const url = query ? `${base}${path}?${query}` : `${base}${path}`;
  const h = { ...(headers || {}) };
  let payload;
  if (raw !== undefined) { payload = raw; h['content-type'] = h['content-type'] || 'application/json'; }
  else if (body !== undefined) { payload = JSON.stringify(body); h['content-type'] = 'application/json'; }
  const res = await fetch(url, { method, headers: h, body: payload });
  const text = await res.text();
  let json = null, parseErr = null;
  try { json = text === '' ? null : JSON.parse(text); } catch (e) { parseErr = e.message; json = text; }
  return {
    method, path: path + (query ? `?${query}` : ''),
    status: res.status,
    contentType: res.headers.get('content-type'),
    body: json,
    ...(parseErr ? { nonJsonBody: text } : {}),
  };
}

const store = new HistoryStore();
const svc = createHistoryService(store);
await svc.listen(0);
const out = [];
const record = async (label, ...args) => out.push({ label, ...(await probe(svc, ...args)) });

try {
  // 0. healthcheck (base-service route)
  await record('GET /healthcheck', 'GET', '/healthcheck');

  // 1. skill launch write
  await record('POST /v1/skill/launch full', 'POST', '/v1/skill/launch', {
    body: { timestamp: TS, sessionID: 'sess-1', robotID: 'Robot-Jibo-Number-One', skillID: 'SKILL-1', intent: 'intent-1', personIDs: ['person-2', 'person-1'] },
  });
  await record('POST /v1/skill/launch extra unknown field', 'POST', '/v1/skill/launch', {
    body: { timestamp: TS, sessionID: 'sess-x', robotID: 'R-extra', skillID: 'SK-1', bogus: 'drop-me', type: 'HACK' },
  });
  await record('POST /v1/skill/launch payload only', 'POST', '/v1/skill/launch', {
    body: { timestamp: TS, sessionID: 'sess-p', robotID: 'R-p', skillID: 'SK-p', payload: { a: 1 } },
  });

  // 2. payload update
  await record('PUT /v1/skill/launch/payload match', 'PUT', '/v1/skill/launch/payload', {
    body: { robotID: 'R-p', sessionID: 'sess-p', skillID: 'SK-p', payload: { key1: 'value1', key2: 'value2' } },
  });
  await record('PUT /v1/skill/launch/payload no match', 'PUT', '/v1/skill/launch/payload', {
    body: { robotID: 'nobody', sessionID: 'nope', skillID: 'SK-1', payload: { a: 1 } },
  });

  // 3. latest POST/GET
  await record('POST /v1/skill/launch/latest hit', 'POST', '/v1/skill/launch/latest', {
    body: { robotID: 'Robot-Jibo-Number-One', rules: [{ field: 'intent', value: 'intent-1' }] },
  });
  await record('POST /v1/skill/launch/latest miss', 'POST', '/v1/skill/launch/latest', {
    body: { robotID: 'Robot-Jibo-Number-One', rules: [{ field: 'intent', value: 'nope' }] },
  });
  await record('POST /v1/skill/launch/latest no robotID', 'POST', '/v1/skill/launch/latest', { body: { rules: [] } });
  await record('GET /v1/skill/launch/latest hit', 'GET', '/v1/skill/launch/latest',
    { query: 'robotID=Robot-Jibo-Number-One&rules[0][field]=intent&rules[0][value]=intent-1' });
  await record('GET /v1/skill/launch/latest miss', 'GET', '/v1/skill/launch/latest',
    { query: 'robotID=Robot-Jibo-Number-One&rules[0][field]=intent&rules[0][value]=nope' });
  await record('GET /v1/skill/launch/latest no robotID', 'GET', '/v1/skill/launch/latest');

  // 4. count POST/GET
  await record('POST /v1/skill/launch/count', 'POST', '/v1/skill/launch/count', { body: { robotID: 'Robot-Jibo-Number-One' } });
  await record('GET /v1/skill/launch/count', 'GET', '/v1/skill/launch/count',
    { query: 'robotID=Robot-Jibo-Number-One&rules[0][field]=skillID&rules[0][value]=SKILL-1' });
  await record('POST /v1/skill/launch/count unknown robot', 'POST', '/v1/skill/launch/count', { body: { robotID: 'never' } });

  // 5. speech
  const speech = await probe(svc, 'POST', '/v1/speech', {
    body: { robotID: 'r', accountID: 'a', transID: 't', timestamp: TS, audioFileURL: 'http://a' },
  });
  out.push({ label: 'POST /v1/speech', ...speech });
  const speechId = speech.body && speech.body.id;
  await record('PUT /v1/speech/:id ok', 'PUT', `/v1/speech/${speechId}`, {
    body: { asr: { text: 'x' }, nlu: { intent: 'greet' }, personIDs: ['p1'], robotID: 'HACKED' },
  });
  await record('PUT /v1/speech/:id unknown', 'PUT', '/v1/speech/does-not-exist', { body: { audioFileURL: 'x' } });
  await record('PUT /v1/speech/:id empty body (text/plain)', 'PUT', `/v1/speech/${speechId}`, { raw: '', headers: { 'content-type': 'text/plain' } });

  // 6. unknown route + method + trailing slash + case + HEAD + bare alias
  await record('GET unknown route', 'GET', '/v1/skill/launch/does-not-exist');
  await record('DELETE on known path', 'DELETE', '/v1/skill/launch/latest');
  await record('PATCH on known path', 'PATCH', '/v1/skill/launch/count');
  await record('POST trailing slash /v1/skill/launch/', 'POST', '/v1/skill/launch/', {
    body: { timestamp: TS, sessionID: 'slash', robotID: 'R-slash', skillID: 'SK-slash' },
  });
  await record('GET case-insensitive /V1/SKILL/LAUNCH/count', 'GET', '/V1/SKILL/LAUNCH/count', { query: 'robotID=R-slash' });
  await record('HEAD /v1/skill/launch/count', 'HEAD', '/v1/skill/launch/count', { query: 'robotID=R-slash' });
  await record('bare alias GET /skill/launch/count', 'GET', '/skill/launch/count', { query: 'robotID=R-slash' });
  await record('bare alias POST /speech', 'POST', '/speech', { body: { robotID: 'r', accountID: 'a', transID: 't', timestamp: TS } });
  await record('bare alias PUT /speech/:id unknown', 'PUT', '/speech/nope', { body: { audioFileURL: 'x' } });
} finally {
  svc.server.close();
}

console.log(JSON.stringify(out, null, 2));
writeFileSync(process.argv[2] || 'runtime-probe.json', JSON.stringify(out, null, 2));
