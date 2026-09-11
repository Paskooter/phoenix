// A-05 runtime demonstration: drive every normal/admin OOBE target over real HTTP, then prove
// credential preservation across a SIGKILL restart. Prints a JSON report on stdout.
//
//   node docs/parity/evidence/2026-09-10/a05-oobe-reconnect/runtime-probe.mjs
//
// Relative imports only: node_modules/@phoenix/* in a worktree symlinks to the MAIN checkout.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..', '..', '..');
const account = (p) => join(root, 'packages', 'account', p);
const dir = mkdtempSync(join(tmpdir(), 'a05-probe-'));
process.env.ETCO_account_dataFile = join(dir, 'store.json');
delete process.env.NET_robotread;

const { createAccountService, getStore } = await import(account('src/index.js'));
const { createOwnerAccount, createLoop, mintSetupToken } = await import(account('src/model.js'));

const svc = await createAccountService({ log: { info() {}, warn() {}, error() {} } });
const server = svc.server ?? svc;
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;

const sig = (k) => `AWS4-HMAC-SHA256 Credential=${k}/20260612/us-east-1/account/aws4_request, SignedHeaders=host, Signature=feedface`;

async function amz(target, body, headers = {}) {
  const res = await fetch(`${base}/`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': target, ...headers, connection: 'close' },
    body: JSON.stringify(body),
  });
  return { status: res.status, contentType: res.headers.get('content-type'), errType: res.headers.get('x-amzn-errortype'), body: await res.json().catch(() => null) };
}

const report = { kind: 'a05-oobe-reconnect-runtime-probe', targets: {}, persistence: {} };

const store = getStore();
const owner = createOwnerAccount(store, { email: 'probe-owner@probe.invalid', password: 'pw', firstName: 'Probe' });
const created = createLoop(store, { owner, robotId: 'probe-robot-a' });

const prep = await amz('OOBE_20161026.PrepareRobot', {}, { authorization: sig(owner.accessKeyId) });
report.targets['OOBE_20161026.PrepareRobot'] = prep;
report.targets['OOBE_20161026.GetStatus(pending)'] = await amz('OOBE_20161026.GetStatus', { token: prep.body.token });
report.targets['OOBE_20161026.SetupRobot'] = await amz('OOBE_20161026.SetupRobot', { token: prep.body.token, id: 'probe-robot-new' });
report.targets['OOBE_20161026.GetStatus(done)'] = await amz('OOBE_20161026.GetStatus', { token: prep.body.token });

const robot = store.accountByFriendlyId('probe-robot-new');
const rtok = mintSetupToken(store, owner._id, created.loop._id);
report.targets['OOBE_20161026.ReconnectRobot'] = await amz('OOBE_20161026.ReconnectRobot', { token: rtok._id }, { authorization: sig(robot.accessKeyId) });
report.targets['OOBE_20161026.ReconnectRobot(unknown-token)'] = await amz('OOBE_20161026.ReconnectRobot', { token: 'nope' }, { authorization: sig(robot.accessKeyId) });

report.targets['OOBE_20161026.GetServiceToken(non-admin)'] = await amz('OOBE_20161026.GetServiceToken', {}, { authorization: sig(owner.accessKeyId) });
owner.isAdmin = true; store.flush();
report.targets['OOBE_20161026.GetServiceToken(admin)'] = await amz('OOBE_20161026.GetServiceToken', {}, { authorization: sig(owner.accessKeyId) });
report.targets['OOBE_20161026.UnknownOp'] = await amz('OOBE_20161026.Frobnicate', {});
report.targets['OOBE.PrepareRobot(bare-prefix)'] = await amz('OOBE.PrepareRobot', {}, { authorization: sig(owner.accessKeyId) });
report.targets['OOBE_20161026.SetupRobot(used-token-replay)'] = await amz('OOBE_20161026.SetupRobot', { token: prep.body.token, id: 'probe-robot-new' });

server.close();

// -- SIGKILL credential preservation -----------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sdir = mkdtempSync(join(tmpdir(), 'a05-sigkill-'));
const file = join(sdir, 'account.json');
const marker = join(sdir, 'marker.json');
const child = spawn(process.execPath, [join(root, 'scripts', 'parity-a05', 'oobeStoreChild.mjs'), file, marker], { stdio: 'ignore' });
for (let i = 0; i < 1000 && !existsSync(marker); i += 1) await sleep(10);
const issued = JSON.parse(readFileSync(marker, 'utf8'));
await sleep(25);
child.kill('SIGKILL');
const exited = await new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
const { Store } = await import(account('src/store.js'));
const reopened = new Store(file);
report.persistence = {
  method: 'spawn a real node process, wait for its first atomic snapshot, SIGKILL mid-write, reopen the file',
  childExit: exited,
  issued,
  preserved: {
    accessKeyId: reopened.accounts.get(issued.robotId)?.accessKeyId === issued.accessKeyId,
    secretAccessKey: reopened.accounts.get(issued.robotId)?.secretAccessKey === issued.secretAccessKey,
    loopRobot: reopened.loops.get(issued.loopId)?.robot === issued.robotId,
    accessKeyResolves: reopened.accountByAccessKeyId(issued.accessKeyId)?._id === issued.robotId,
  },
};

console.log(JSON.stringify(report, null, 2));
