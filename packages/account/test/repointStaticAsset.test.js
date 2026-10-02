import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { staticRoutes } from '../src/static.js';

test('the public repoint helper can fetch its SHA-pinned cloud config support file', () => {
  const route = staticRoutes()['GET /robot-client/repoint-cloud-config.cjs'];
  assert.equal(typeof route, 'function');
  let status;
  let body;
  route({ res: {
    writeHead(code) { status = code; },
    end(value) { body = value; },
  } });
  assert.equal(status, 200);
  const digest = createHash('sha256').update(body).digest('hex');
  const script = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../../scripts/robot-ota-repoint.sh'), 'utf8');
  assert.match(script, new RegExp(`CONFIG_PATCHER_SHA256="${digest}"`));
});

test('every public repoint support asset matches its downloadable helper pin', () => {
  const assets = {
    'node.js': 'CLIENT_SOURCE', 'node-v2.js': 'CLIENT_V2_SOURCE',
    'isrg-root-x1.pem': 'ROOT_PEM_SOURCE', 'patch-system-backup-tls.cjs': 'BACKUP_TLS_PATCHER',
    'patch-ota-downloader-tls.cjs': 'OTA_TLS_PATCHER', 'patch-ssm-wifi-check.cjs': 'SSM_WIFI_PATCHER',
    'patch-oobe-setup-text.cjs': 'SETUP_TEXT_PATCHER', 'repoint-cloud-config.cjs': 'CONFIG_PATCHER',
    'trigger-ota.cjs': 'OTA_TRIGGER',
  };
  const routes = staticRoutes();
  const script = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../../scripts/robot-ota-repoint.sh'), 'utf8');
  for (const [asset, variable] of Object.entries(assets)) {
    let body; let status;
    assert.equal(typeof routes[`GET /robot-client/${asset}`], 'function', asset);
    routes[`GET /robot-client/${asset}`]({ res: {
      writeHead(code) { status = code; }, end(value) { body = value; },
    } });
    assert.equal(status, 200, asset);
    const hash = createHash('sha256').update(body).digest('hex');
    assert.match(script, new RegExp(`${variable}_SHA256="${hash}"`), asset);
  }
});
