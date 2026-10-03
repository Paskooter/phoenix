// Cross-repository test backend. Requires an explicit disposable directory.
// Every identity is synthetic; never point this at a production store.
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import https from 'node:https';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { Store } from '../../packages/account/src/store.js';
import { createAccountService } from '../../packages/account/src/index.js';
import { createSession } from '../../packages/account/src/sessions.js';
import { createGateway } from '../../packages/gateway/src/index.js';
import { loadConfig } from '../../packages/gateway/src/config.js';
import { createService, jwt } from '@phoenix/common';
import { parseRequest } from '../../packages/nlu/src/requestParser.js';

if (!process.env.PHOENIX_HA_TEST_ROOT) throw new Error('Set PHOENIX_HA_TEST_ROOT to disposable test storage');
const root = mkdtempSync(join(process.env.PHOENIX_HA_TEST_ROOT, 'phoenix-ha-'));
process.env.ETCO_account_internalPeerToken = 'synthetic-ha-peer';
const store = new Store(join(root, 'account.json'));
const owner = { _id: 'synthetic-ha-owner', isActive: true, email: 'fixture@example.invalid' };
const robot = { _id: 'synthetic-ha-robot', friendlyId: 'synthetic-jibo', isActive: true, accessKeyId: 'synthetic-robot-key' };
store.accounts.set(owner._id, owner); store.accounts.set(robot._id, robot);
store.loops.set('synthetic-ha-loop', { _id: 'synthetic-ha-loop', name: 'Test Loop', owner: owner._id, robot: robot._id, members: [] });
const session = createSession(store, { kind: 'user', accountId: owner._id });
const account = createAccountService({ store }); await account.listen(0, '127.0.0.1');
const accountUrl = `http://127.0.0.1:${account.server.address().port}`;
const parser = createService({ name: 'ha-test-parser', routes: { 'POST /v1/parse': ({ body }) => ({ data: parseRequest(body.data || body) }) } });
await parser.listen(0, '127.0.0.1');
const config = await loadConfig({ ETCO_hub_accountUrl: accountUrl, ETCO_account_internalPeerToken: 'synthetic-ha-peer',
  ETCO_server_hubTokenSecret: 'synthetic-ha-hub', NET_skills: '127.0.0.1:1',
  NET_parser: `127.0.0.1:${parser.server.address().port}`, ETCO_hub_recordLaunchHistory: 'false' });
const gateway = await createGateway(config); await gateway.service.listen(0, '127.0.0.1');
const certificate = join(root, 'tls.pem'); const key = join(root, 'tls.key');
const generated = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
  '-keyout', key, '-out', certificate, '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost'], { stdio: 'ignore' });
if (generated.status !== 0) throw new Error('Test certificate generation failed');
const edge = https.createServer({ key: readFileSync(key), cert: readFileSync(certificate) }, (req, res) => {
  if (req.url === '/test/disconnect') { for (const socket of account.homeAssistant.wss.clients) socket.terminate(); res.end('{}'); return; }
  if (req.url === '/test/revoke') { for (const row of store.homeAssistantInstallations.values()) account.homeAssistant.revoke(row); res.end('{}'); return; }
  const upstream = http.request(accountUrl + req.url, { method: req.method, headers: req.headers }, (response) => {
    res.writeHead(response.statusCode, response.headers); response.pipe(res);
  });
  upstream.on('error', () => { res.writeHead(502); res.end(); }); req.pipe(upstream);
});
edge.on('upgrade', (...args) => account.homeAssistant.upgrade(...args));
await new Promise((resolve) => edge.listen(0, '127.0.0.1', resolve));
const code = account.homeAssistant.issueCode(owner, [robot.friendlyId]).code;
console.log(JSON.stringify({ url: `https://127.0.0.1:${edge.address().port}`, certificate, code,
  owner_cookie: `phx_session=${session._id}`, gateway_url: `http://127.0.0.1:${gateway.service.server.address().port}`,
  robot_token: jwt.sign({ id: robot._id, accessKeyId: robot.accessKeyId, friendlyId: robot.friendlyId }, config.hubTokenSecret) }));
process.on('SIGTERM', () => {
  account.homeAssistant.close(); for (const socket of gateway.wss.clients) socket.terminate();
  edge.close(); parser.server.close(); account.server.close(); gateway.service.server.close();
  setTimeout(() => process.exit(0), 100).unref();
});
