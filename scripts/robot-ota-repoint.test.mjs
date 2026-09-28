import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = join(dirname(fileURLToPath(import.meta.url)), 'robot-ota-repoint.sh');
const claimCode = 'A'.repeat(43);

function preview({ credentials, mode, claim = false }) {
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
  *'oobe-config/config.json'*) echo stg-entrypoint ;;
  *'/var/jibo/credentials.json'*) echo stg-entrypoint ;;
  *'test -f'*region_config.json*) [[ "$cmd" == *'/usr/lib/node_modules/@jibo/jibo-server-client/lib/region_config.json'* ]] ;;
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
        PHOENIX_TEST_CREDS: credentials ? 'yes' : 'no', PHOENIX_TEST_MODE: mode },
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

test('missing credentials selects OOBE and never spends an account claim code', () => {
  const out = preview({ credentials: false, mode: 'int-developer', claim: true });
  assert.match(out, /credentials absent; repoint for QR setup and its automatic OTA/);
  assert.match(out, /claim code: not used on this path/);
  assert.match(out, /QR pairing creates credentials/);
  assert.doesNotMatch(out, /prove possession with the robot's existing credentials/);
});
