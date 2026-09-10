// A-16 runtime probe — start the classic entrypoint and hit ROM_20171011 over HTTP.
// Prints status, error envelope and (redacted) shapes for each operation.
import { createClassicEntrypoint } from '../../../../../packages/classic/src/index.js';

const OWNER = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const FRIENDLY_ID = 'Alex-Alex-Alex-Alex';
const IP = '192.168.1.100';

const redact = (v) => (typeof v === 'string' && v.length > 40 ? `<str len=${v.length}>` : v);
const shape = (body) => Object.fromEntries(Object.entries(body || {}).map(([k, v]) => [k, redact(v)]));

const rom = {
  accountClient: { async listLoops(ownerId) { return ownerId === OWNER ? [{ owner: OWNER, robotFriendlyId: FRIENDLY_ID }] : []; } },
  robotClient: { async getById() { return { id: FRIENDLY_ID, payload: { remoteEnabled: true } }; } },
};

const { listen } = createClassicEntrypoint({ rom });
const server = await listen(0);
const port = server.address().port;

async function call(target, body, credentials) {
  const headers = { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': target };
  if (credentials) headers['x-amz-credentials'] = JSON.stringify(credentials);
  const res = await fetch(`http://localhost:${port}/`, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await res.text();
  let parsed; try { parsed = JSON.parse(text); } catch { parsed = text; }
  console.log(`${target} -> HTTP ${res.status}  x-amzn-errortype=${res.headers.get('x-amzn-errortype') || '-'}`);
  console.log('   body:', JSON.stringify(parsed && parsed.__type ? parsed : shape(parsed)));
  return { status: res.status, body: parsed };
}

console.log('=== ROM_20171011 over the classic entrypoint (one host, one POST /) ===');
await call('ROM_20171011.Create', { friendlyId: FRIENDLY_ID, aco: {} }, { id: OWNER });
await call('ROM_20171011.SetupServer', { ipAddress: IP, ipAddresses: [{ address: IP, netmask: '255.255.252.0' }] }, { friendlyId: FRIENDLY_ID });
await call('ROM_20171011.SetupClient', { friendlyId: FRIENDLY_ID }, { id: OWNER });
console.log('--- failure / validation cases ---');
await call('ROM_20171011.SetupServer', { ipAddress: IP });                                     // no robot credentials
await call('ROM_20171011.SetupClient', { friendlyId: FRIENDLY_ID }, { id: 'not-the-owner' });   // ROBOT_NOT_OWNED
await call('ROM_20171011.Create', {});                                                          // missing friendlyId
await call('ROM_20171011.Create', { friendlyId: 'ghost' }, { id: OWNER });                      // ROBOT_NOT_OWNED
await call('ROM_20171011.Unknown', {}, { id: OWNER });                                          // unknown op

server.close();
