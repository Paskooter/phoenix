// Focused probe: Phoenix's 422 messages for empty-string fields on OauthClients
// Create/Update, to compare against the pinned Joi 10.5.2 replay (joi-replay.json).
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');
const { signSigV4 } = await import(join(ROOT, 'packages/common/src/index.js'));
const { createAccountService } = await import(join(ROOT, 'packages/account/src/index.js'));
const { Store } = await import(join(ROOT, 'packages/account/src/store.js'));
const { createOwnerAccount } = await import(join(ROOT, 'packages/account/src/model.js'));

const dir = mkdtempSync(join(tmpdir(), 'phx-a18-joi-'));
const store = new Store(join(dir, 'store.json'));
const admin = createOwnerAccount(store, { email: 'j@x.test', password: 'x' }); admin.isAdmin = true; store.flush();
const account = await createAccountService({ store }).listen(0);
const base = `http://127.0.0.1:${account.address().port}`;
async function post(target, body) {
  const headers = { host: new URL(base).host, 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': target };
  const signed = signSigV4({ method: 'POST', path: '/', body: JSON.stringify(body), headers, accessKeyId: admin.accessKeyId, secretAccessKey: admin.secretAccessKey, region: 'global', service: 'jibo' }).headers;
  const r = await fetch(`${base}/`, { method: 'POST', headers: { ...signed, connection: 'close' }, body: JSON.stringify(body) });
  const text = await r.text(); let parsed = null; try { parsed = JSON.parse(text); } catch {}
  return { status: r.status, message: parsed && parsed.message };
}
const out = [];
out.push({ case: 'CREATE empty clientId', ...(await post('OauthClients_20171108.Create', { clientId: '', redirectUri: 'b', updatedBy: 'u' })) });
out.push({ case: 'CREATE empty optional secret', ...(await post('OauthClients_20171108.Create', { clientId: 'a', redirectUri: 'b', updatedBy: 'u', secret: '' })) });
out.push({ case: 'UPDATE empty optional redirectUri', ...(await post('OauthClients_20171108.Update', { id: 'ffffffffffffffffffffffff', updatedBy: 'u', redirectUri: '' })) });
out.push({ case: 'CREATE pkce non-bool', ...(await post('OauthClients_20171108.Create', { clientId: 'a', redirectUri: 'b', updatedBy: 'u', pkce: 'yes' })) });
console.log(JSON.stringify(out, null, 1));
account.close(); rmSync(dir, { recursive: true, force: true });
process.exit(0);
