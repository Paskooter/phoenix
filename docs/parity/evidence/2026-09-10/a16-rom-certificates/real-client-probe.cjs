// A-16 real-client leg — drive Phoenix's ROM_20171011 with the ORIGINAL generated client
// (the pinned @jibo/jibo-server-client v3.0.117 aws-sdk fork: clients/rom.js,
// apis/rom-2017-10-11.min.json). Proves the wire shapes parse through the real model.
const path = '/tmp/jibo-guide-audit.b8lAFO/BEam/@be/be/node_modules/@jibo/jibo-server-client';

const OWNER = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const FRIENDLY_ID = 'Alex-Alex-Alex-Alex';
const IP = '192.168.1.100';
const NETMASK = '255.255.252.0';

const redact = (v) => (typeof v === 'string' && v.length > 40 ? `<str len=${v.length}>` : v);
const shape = (o) => Object.fromEntries(Object.entries(o || {}).map(([k, v]) => [k, redact(v)]));

(async () => {
  const { createClassicEntrypoint } = await import('../../../../../packages/classic/src/index.js');
  const Jibo = require(`${path}/lib/aws.js`);

  const romDoubles = {
    accountClient: { async listLoops(ownerId) { return ownerId === OWNER ? [{ owner: OWNER, robotFriendlyId: FRIENDLY_ID }] : []; } },
    robotClient: { async getById() { return { id: FRIENDLY_ID, payload: { remoteEnabled: true } }; } },
  };
  const server = await createClassicEntrypoint({ rom: romDoubles }).listen(0);
  const port = server.address().port;

  const client = new Jibo.ROM({
    endpoint: `http://localhost:${port}`,
    region: 'us-east-1',
    credentials: { accessKeyId: OWNER, secretAccessKey: 'x'.repeat(40) },
    sslEnabled: false,
    maxRetries: 0,
    httpOptions: { connectTimeout: 5000, timeout: 10000 },
  });

  const withRobotCredentials = (req) => req.on('build', () => {
    req.httpRequest.headers['x-amz-credentials'] = JSON.stringify({ friendlyId: FRIENDLY_ID });
  });

  const run = async (label, fn) => {
    try {
      const data = await fn().promise();
      console.log(`${label} -> OK  ${JSON.stringify(data && typeof data === 'object' ? shape(data) : data)}`);
      return { ok: true, data };
    } catch (err) {
      console.log(`${label} -> ERR ${err.code || err.name} status=${err.statusCode || '-'} ${err.message}`);
      return { ok: false, code: err.code, status: err.statusCode };
    }
  };

  console.log('=== original @jibo/jibo-server-client ROM client against Phoenix classic ===');
  await run('ROM.create', () => client.create({ friendlyId: FRIENDLY_ID, aco: {} }));
  await run('ROM.setupServer', () => withRobotCredentials(client.setupServer({ ipAddress: IP, ipAddresses: [{ address: IP, netmask: NETMASK }] })));
  const sc = await run('ROM.setupClient', () => client.setupClient({ friendlyId: FRIENDLY_ID }));
  if (sc.ok) {
    console.log('   payload:', JSON.stringify(sc.data.payload));
    console.log('   p12 present:', typeof sc.data.p12 === 'string' && sc.data.p12.length > 100,
      '| cert PEM:', /^-----BEGIN CERTIFICATE-----/.test(sc.data.cert),
      '| fingerprint len:', sc.data.fingerprint.length);
  }

  console.log('--- typed error envelope through the generated model ---');
  await run('ROM.setupServer (no robot credentials)', () => client.setupServer({ ipAddress: IP }));
  await run('ROM.create (unknown robot)', () => client.create({ friendlyId: 'not-mine' }));
  await run('ROM.setupClient (missing friendlyId)', () => client.setupClient({}));

  server.close();
})().catch((e) => { console.error('PROBE FAILED:', e); process.exit(1); });
