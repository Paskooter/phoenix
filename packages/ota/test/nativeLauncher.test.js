// The native production launcher must give OTA the same resolved signing secret
// used when it creates and validates signed package URLs. Docker Compose already
// wires this explicitly; this small source guard prevents the native path from
// silently falling back to the development secret instead.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const launcher = new URL('../../../scripts/run-compose-stack.sh', import.meta.url);
const compose = new URL('../../../docker-compose.yml', import.meta.url);

test('native launcher passes a stable package bearer secret to OTA', async () => {
  const source = await readFile(launcher, 'utf8');
  assert.match(
    source,
    /ETCO_ota_packageBearerSecret="\$\{ETCO_ota_packageBearerSecret:-\$HUB_TOKEN_SECRET\}"/,
    'OTA must receive an explicit deployment signing secret, with the documented hub-secret fallback',
  );
});

test('native launcher routes report and hub settings to the local Account service', async () => {
  const source = await readFile(launcher, 'utf8');
  assert.match(source, /REPORT_SETTINGS="\$\{NET_settings:-\$\{NET_SETTINGS:-localhost:\$\(p 9011\)\}\}"/);
  assert.equal((source.match(/NET_settings="\$REPORT_SETTINGS"/g) || []).length, 2,
    'both report skill and gateway must use the local settings peer');
  assert.doesNotMatch(source, /REPORT_SETTINGS=.*settings\.jibo\.aws/);
});

test('Compose routes report and hub settings to the private Account service', async () => {
  const source = await readFile(compose, 'utf8');
  assert.match(source, /NET_settings=account:8080/);
  assert.match(source, /NET_settings=\$\{NET_settings:-\$\{NET_SETTINGS:-account:8080\}\}/);
});
