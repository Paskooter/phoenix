import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = join(dirname(fileURLToPath(import.meta.url)), 'robot-ota-repoint.sh');
const claimCode = 'A'.repeat(43);

function preview({ credentials, mode, claim = false, shape = 'ok', region = 'stg-entrypoint' }) {
  const dir = mkdtempSync(join(tmpdir(), 'phoenix-repoint-test-'));
  const ssh = join(dir, 'ssh');
  writeFileSync(ssh, `#!/usr/bin/env bash
cmd="\${*: -1}"
case "$cmd" in
  true) exit 0 ;;
  hostname*) echo Aero-Root-Okra-Knit ;;
  jibo-version*) echo 'Jibo Release Version: Release-13.0.0-20190225' ;;
  jibo-getmode*) echo "$PHOENIX_TEST_MODE" ;;
  'test -s /var/jibo/credentials.json') test "$PHOENIX_TEST_CREDS" = yes ;;
  *'grep -Eq'*accessKeyId*) test "$PHOENIX_TEST_CREDS_SHAPE" = ok ;;
  *'oobe-config/config.json'*) echo "$PHOENIX_TEST_REGION" ;;
  *'/var/jibo/credentials.json'*) echo "$PHOENIX_TEST_REGION" ;;
  *'test -f'*region_config.json*) [[ "$cmd" == *'/usr/lib/node_modules/@jibo/jibo-server-client/lib/region_config.json'* || "$cmd" == *'/opt/jibo/Jibo/Skills/@be/be/node_modules/@jibo/jibo-server-client/lib/region_config.json'* ]] ;;
  *'grep -c'*'jibo\\.com'*) echo 5 ;;
  *'grep -q'*'ca-certificates.crt'*) exit 0 ;;
  *'ls /usr/lib/node_modules/'*) exit 0 ;;
  *'df -k /opt'*) echo '4000000 3000000' ;;
  *'mount'*'/opt'*) echo '/dev/mmcblk0p5 ext4' ;;
  *'mount'*) echo '/dev/mmcblk0p2 on / type ext4 (ro,relatime)' ;;
  *) echo "unexpected SSH probe: $cmd" >&2; exit 75 ;;
esac
`);
  chmodSync(ssh, 0o755);
  try {
    return execFileSync('bash', [script, '--robot', 'root@192.0.2.15', '--auto',
      ...(claim ? ['--claim-code', claimCode] : []), '--dry-run'], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`,
        PHOENIX_TEST_CREDS: credentials ? 'yes' : 'no', PHOENIX_TEST_MODE: mode,
        PHOENIX_TEST_CREDS_SHAPE: shape, PHOENIX_TEST_REGION: region },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('OOBE screen with preserved credentials selects adoption and native OTA', () => {
  const out = preview({ credentials: true, mode: 'oobe', claim: true });
  assert.match(out, /credentials present; adopt\/claim and start native OTA/);
  assert.match(out, /prove possession with the robot's existing credentials/);
  assert.match(out, /ask the native system-manager to download and install/);
  assert.doesNotMatch(out, /QR setup will create and link it later/);
});

test('signed-out credentials path defers OTA and mode changes until account claim', () => {
  const out = preview({ credentials: true, mode: 'int-developer' });
  assert.match(out, /credentials present; register only, then sign in/);
  assert.match(out, /OTA and boot-mode changes are deferred/);
  assert.doesNotMatch(out, /ask the native system-manager to download and install/);
});

test('api-region plan names neo-hub and patches the active stock BE client', () => {
  const out = preview({ credentials: true, mode: 'int-developer', claim: true, region: 'api' });
  assert.match(out, /point the jetstream hub override at neo-hub\.jibo\.io:443/);
  assert.match(out, /present  \/opt\/jibo\/Jibo\/Skills\/@be\/be\/node_modules\/\@jibo\/jibo-server-client\/lib\/region_config\.json/);
});

test('missing credentials selects OOBE and never spends an account claim code', () => {
  const out = preview({ credentials: false, mode: 'int-developer', claim: true });
  assert.match(out, /credentials absent; repoint for QR setup and its automatic OTA/);
  assert.match(out, /claim code: not used on this path/);
  assert.match(out, /QR pairing creates credentials/);
  assert.doesNotMatch(out, /prove possession with the robot's existing credentials/);
});

test('a damaged credentials file stops before any change instead of failing at adoption', () => {
  assert.throws(() => preview({ credentials: true, mode: 'oobe', claim: true, shape: 'bad' }), (error) => {
    assert.match(String(error.stderr), /does not hold a complete robot identity; nothing was changed/);
    assert.doesNotMatch(String(error.stdout), /== Plan/);
    return true;
  });
});
