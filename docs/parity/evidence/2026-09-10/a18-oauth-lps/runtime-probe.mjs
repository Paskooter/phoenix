// A-18 independent runtime probe (verification artifact, not implementation).
//
// Boots a REAL account service and a REAL classic entrypoint, then drives the five
// A-18 targets through the classic front door (signature -> proxy -> dispatch), plus
// the negative auth boundaries. Run from anywhere inside the repo:
//
//     node docs/parity/evidence/2026-09-10/a18-oauth-lps/runtime-probe.mjs
//
// Writes results to $A18_PROBE_OUT (default /tmp/a18src/runtime-probe.json) and leaves
// server logs on stdout. The captured run is runtime-probe.json next to this file.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');
const { signSigV4 } = await import(join(ROOT, 'packages/common/src/index.js'));
const { createAccountService } = await import(join(ROOT, 'packages/account/src/index.js'));
const { Store } = await import(join(ROOT, 'packages/account/src/store.js'));
const { createOwnerAccount, findOrCreateRobotAccount } = await import(join(ROOT, 'packages/account/src/model.js'));
const { createClassicEntrypoint } = await import(join(ROOT, 'packages/classic/src/index.js'));

const dir = mkdtempSync(join(tmpdir(), 'phx-a18-probe-'));
const store = new Store(join(dir, 'store.json'));

const fakeSts = {
  async newCredentials(accountId, friendlyId) {
    return {
      bucketName: 'jibo-lps-probe',
      bucketPath: `lps/robot=${friendlyId}/account=${accountId}/year=2026/month=8/day=10/session=1/`,
      credentials: {
        AccessKeyId: 'AKIAPROBE', Expiration: '2026-11-10T00:00:00.000Z',
        SecretAccessKey: 'probe-secret', SessionToken: 'probe-token',
      },
      region: 'us-east-1',
    };
  },
};

function signed(accessKeyId, target, body, host) {
  const headers = { host, 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': target };
  const account = store.accountByAccessKeyId(accessKeyId);
  return signSigV4({
    method: 'POST', path: '/', body: body === undefined ? '' : JSON.stringify(body),
    headers, accessKeyId, secretAccessKey: account?.secretAccessKey || 'unknown', region: 'global', service: 'jibo',
  }).headers;
}

async function post(base, target, body, accessKeyId) {
  const headers = accessKeyId
    ? signed(accessKeyId, target, body, new URL(base).host)
    : { host: new URL(base).host, 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': target };
  const response = await fetch(`${base}/`, {
    method: 'POST', headers: { ...headers, connection: 'close' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await response.text();
  let parsed = null; try { parsed = raw ? JSON.parse(raw) : null; } catch (_) {}
  return { status: response.status, errortype: response.headers.get('x-amzn-errortype'), body: parsed, raw };
}

const results = {};
const record = (name, r) => { results[name] = r; };

async function main() {
  const admin = createOwnerAccount(store, { email: 'probe-admin@example.test', password: 'x', firstName: 'A' });
  admin.isAdmin = true;
  const human = createOwnerAccount(store, { email: 'probe-human@example.test', password: 'x', firstName: 'H' });
  const robot = findOrCreateRobotAccount(store, 'probe-robot-friendly');
  store.flush();

  const account = await createAccountService({ store, lpsStsProvider: fakeSts }).listen(0);
  const accountBase = `http://127.0.0.1:${account.address().port}`;
  const previous = process.env.NET_account;
  process.env.NET_account = accountBase.replace('http://', '');
  const classic = await createClassicEntrypoint().listen(0);
  const base = `http://127.0.0.1:${classic.address().port}`;

  try {
    const created = await post(base, 'OauthClients_20171108.Create', {
      clientId: 'probe.app', redirectUri: 'https://x.invalid/cb', updatedBy: admin._id,
    }, admin.accessKeyId);
    record('Create.admin', created);
    record('Create.duplicate', await post(base, 'OauthClients_20171108.Create', {
      clientId: 'probe.app', redirectUri: 'https://x.invalid/cb2', updatedBy: admin._id,
    }, admin.accessKeyId));
    record('Create.acoFallback', await post(base, 'OauthClients_20171108.Create', {
      clientId: 'probe.aco', redirectUri: 'https://x.invalid/cb3', updatedBy: admin._id, aco: { commandSet: ['c'] },
    }, admin.accessKeyId));
    record('ListClients.admin', await post(base, 'OauthClients_20171108.ListClients', {}, admin.accessKeyId));
    record('Update.admin', await post(base, 'OauthClients_20171108.Update', {
      id: created.body.id, updatedBy: admin._id, redirectUri: 'https://x.invalid/upd', pkce: true,
    }, admin.accessKeyId));
    record('Update.missing', await post(base, 'OauthClients_20171108.Update', {
      id: 'ffffffffffffffffffffffff', updatedBy: admin._id, redirectUri: 'https://x.invalid/z',
    }, admin.accessKeyId));
    record('Remove.admin', await post(base, 'OauthClients_20171108.Remove', { id: created.body.id }, admin.accessKeyId));
    record('Remove.missing', await post(base, 'OauthClients_20171108.Remove', { id: 'ffffffffffffffffffffffff' }, admin.accessKeyId));
    record('Lps.robot', await post(base, 'Lps_20171201.NewCredentials', {}, robot.accessKeyId));

    record('Create.unsigned', await post(base, 'OauthClients_20171108.Create', { clientId: 'x', redirectUri: 'x', updatedBy: admin._id }));
    record('ListClients.unsigned', await post(base, 'OauthClients_20171108.ListClients', {}));
    record('Update.unsigned', await post(base, 'OauthClients_20171108.Update', { id: 'x', updatedBy: 'x' }));
    record('Remove.unsigned', await post(base, 'OauthClients_20171108.Remove', { id: 'x' }));
    record('Lps.unsigned', await post(base, 'Lps_20171201.NewCredentials', {}));

    record('Create.nonAdmin', await post(base, 'OauthClients_20171108.Create', {
      clientId: 'probe.nonadmin', redirectUri: 'x', updatedBy: human._id,
    }, human.accessKeyId));
    record('ListClients.nonAdmin', await post(base, 'OauthClients_20171108.ListClients', {}, human.accessKeyId));
    record('Update.nonAdmin', await post(base, 'OauthClients_20171108.Update', { id: 'ffffffffffffffffffffffff', updatedBy: human._id }, human.accessKeyId));
    record('Remove.nonAdmin', await post(base, 'OauthClients_20171108.Remove', { id: 'ffffffffffffffffffffffff' }, human.accessKeyId));
    record('Lps.human', await post(base, 'Lps_20171201.NewCredentials', {}, human.accessKeyId));
    record('humanCreatedAny', [...store.oauthClients.values()].some((c) => c.clientId === 'probe.nonadmin'));

    record('Create.missingUpdatedBy', await post(base, 'OauthClients_20171108.Create', {
      clientId: 'probe.v', redirectUri: 'x',
    }, admin.accessKeyId));
    record('Create.emptyClientId', await post(base, 'OauthClients_20171108.Create', {
      clientId: '', redirectUri: 'x', updatedBy: admin._id,
    }, admin.accessKeyId));

    results['_storeRows'] = [...store.oauthClients.values()].map((c) => ({
      clientId: c.clientId, aco: c.aco, refresh: c.refresh,
    }));
  } finally {
    classic.close(); account.close();
    if (previous === undefined) delete process.env.NET_account; else process.env.NET_account = previous;
    writeFileSync(process.env.A18_PROBE_OUT || '/tmp/a18src/runtime-probe.json', JSON.stringify(results, null, 2));
    rmSync(dir, { recursive: true, force: true });
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error('PROBE ERROR', e); process.exit(1); });
