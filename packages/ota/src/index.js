// OTA update server entrypoint.
//
// Env:
//   PORT                 listen port (default 7015; compose maps host 9010 -> 8080)
//   ETCO_ota_manifest    manifest path (default packages/ota/manifest.json)
//   ETCO_ota_dataDir     built-package directory (default packages/ota/data)
//   ETCO_ota_publicUrl   override the base URL handed to robots for downloads (default: request Host)
//
// A robot reaches this when its Update-service endpoint (region -> https://<region>.jibo.com,
// a global endpoint shared by all server-client services) resolves here. See README "OTA".

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { logger } from '@phoenix/common';
import { Catalog } from './catalog.js';
import { createOtaService } from './service.js';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function start(opts = {}) {
  const log = logger('ota');
  const port = opts.port ?? (Number(process.env.PORT) || 7015);
  const manifestPath = opts.manifestPath ?? process.env.ETCO_ota_manifest ?? path.join(PKG_ROOT, 'manifest.json');
  const dataDir = opts.dataDir ?? process.env.ETCO_ota_dataDir ?? path.join(PKG_ROOT, 'data');
  const publicBaseUrl = opts.publicBaseUrl ?? process.env.ETCO_ota_publicUrl ?? null;

  // The executable OTA service is a public credential boundary. Keep the resolver injectable for
  // colocated launchers, but never let `node packages/ota/src/index.js` silently select the old
  // x-amz-credentials/LAN-trust mode. A read-only Account snapshot is the minimum standalone
  // deployment seam; reload it after the Account service atomically replaces the file so key
  // rotation and revocation take effect without an OTA restart.
  const resolveCredentials = opts.resolveCredentials || await productionCredentialResolver();
  if (opts.requireAuth === false) throw new Error('OTA production start cannot disable request authentication');

  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const catalog = await Catalog.load({ entries: manifest.updates || [], dataDir, log, serialOf: opts.serialOf ?? null });
  if (!catalog.entries.length) {
    log.warn('ota: no packages available yet — run scripts/build-ota-packages.sh to populate', { dataDir });
  }
  log.info('ota: catalog loaded', { available: catalog.entries.length, manifestPath, dataDir });

  const svc = createOtaService({
    catalog,
    publicBaseUrl,
    resolveCredentials,
    requireAuth: true,
    packageBearerSecret: opts.packageBearerSecret,
  });
  await svc.listen(port);
  return { svc, catalog };
}

async function productionCredentialResolver() {
  const file = process.env.ETCO_ota_accountDataFile
    || process.env.ETCO_account_dataFile;
  if (!file) throw new Error('ETCO_ota_accountDataFile or ETCO_account_dataFile is required for the public OTA service');
  const { Store } = await import('../../account/src/store.js');
  let store = new Store(file);
  let mtime = accountStoreMtime(file);
  return (accessKeyId) => {
    const current = accountStoreMtime(file);
    if (current !== mtime) {
      store = new Store(file);
      mtime = current;
    }
    return store.accountByAccessKeyId(accessKeyId);
  };
}

function accountStoreMtime(file) {
  try {
    const stat = statSync(file);
    return `${stat.mtimeNs ?? stat.mtimeMs}:${stat.size}:${stat.ino}`;
  } catch { return 'missing'; }
}

export { Catalog } from './catalog.js';
export { createOtaService } from './service.js';
export * as errors from './errors.js';

if (import.meta.url === `file://${process.argv[1]}`) {
  start().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
