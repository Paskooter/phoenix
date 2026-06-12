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

  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const catalog = await Catalog.load({ entries: manifest.updates || [], dataDir, log });
  if (!catalog.entries.length) {
    log.warn('ota: no packages available yet — run scripts/build-ota-packages.sh to populate', { dataDir });
  }
  log.info('ota: catalog loaded', { available: catalog.entries.length, manifestPath, dataDir });

  const svc = createOtaService({ catalog, publicBaseUrl });
  await svc.listen(port);
  return { svc, catalog };
}

export { Catalog } from './catalog.js';
export { createOtaService } from './service.js';

if (import.meta.url === `file://${process.argv[1]}`) {
  start().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
