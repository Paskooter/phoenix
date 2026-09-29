import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = join(dirname(fileURLToPath(import.meta.url)), 'robot-ota-repoint.sh');
const claimCode = 'A'.repeat(43);

// Firmware profiles from the archived flash images (see docs/ROBOT-FIRMWARE-COMPATIBILITY.md).
const STOCK_V3 = 'c3511dbc55c8a9ec3ac74a675a1245306b55c67fab65a3ecfe896ed01689997a';
const STOCK_V2 = '81533de391dfba88fc40bedfc63ea30a77f8d032f9a8c23196db4cb3a44fa89b';
const FIRMWARE = {
  '13': { release: 'Jibo Release Version: Release-13.0.0-20190225', node: 'v6.9.2', backup: 'yes', jetstream: 'yes', ssm: 'google', handler: STOCK_V3,
    found: ['/usr/lib/node_modules/@jibo/jibo-server-client/lib/region_config.json',
      '/opt/jibo/Jibo/Skills/@be/be/node_modules/@jibo/jibo-server-client/lib/region_config.json'] },
  // RTM3: the factory image a new-in-box robot runs (Node 4, 2.x clients, no backup helpers).
  rtm3: { release: 'Jibo Release Version: Release-3.3.4-20170623', node: 'v4.1.2', backup: 'no', jetstream: 'no', ssm: 'jibo.com', handler: STOCK_V2,
    found: ['/usr/lib/node_modules/@jibo/jibo-server-client/lib/region_config.json',
      '/usr/local/bin/jibo-ssm/node_modules/@jibo/jibo-server-client/lib/region_config.json',
      '/opt/jibo/Jibo/Skills/oobe-config/node_modules/@jibo/jibo-server-client/lib/region_config.json'] },
};

function preview({ credentials, mode, claim = false, shape = 'ok', region = 'stg-entrypoint', auth = 'key', robot = 'root@192.0.2.15',
  firmware = '13', handler, preflight = 'ok', hostKey = 'known', auto = true, extra = [] }) {
  const fw = FIRMWARE[firmware];
  const dir = mkdtempSync(join(tmpdir(), 'phoenix-repoint-test-'));
  const ssh = join(dir, 'ssh');
  writeFileSync(ssh, `#!/usr/bin/env bash
# A stand-in for OpenSSH: a master connection is created only for the login
# method this test allows, and every other call must reuse that master.
control=""; master=0; batch=0
for a in "$@"; do
  case "$a" in
    ControlPath=*) control="\${a#ControlPath=}" ;;
    ControlMaster=yes) master=1 ;;
    BatchMode=yes) batch=1 ;;
  esac
done
if [[ " $* " == *" -O exit "* ]]; then rm -f "$control"; exit 0; fi
if [ "$1" = -G ]; then printf 'hostname %s\\nport 22\\n' "\${2#*@}"; exit 0; fi
if [ "$master" = 1 ]; then
  echo "\${*: -1}" >> "$PHOENIX_TEST_LOG"
  if [ -e "$PHOENIX_TEST_STALE_KEY" ]; then
    printf '%s\\n' '@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @' \\
      'SHA256:/FAfL6lYTXGslXazJhiJPgKnxtKoBkPynUDPGSvO0pM.' 'Host key verification failed.' >&2
    exit 255
  fi
  if [ "$batch" = 1 ]; then
    [ "$PHOENIX_TEST_AUTH" = key ] || { echo 'Permission denied (publickey,password).' >&2; exit 255; }
    echo key >> "$PHOENIX_TEST_LOG"
  elif [ -n "\${SSH_ASKPASS:-}" ]; then
    [ "$PHOENIX_TEST_AUTH" = factory ] && [ "$("$SSH_ASKPASS")" = jibo ] || { echo 'Permission denied' >&2; exit 255; }
    echo factory >> "$PHOENIX_TEST_LOG"
  else
    echo 'Permission denied' >&2; exit 255
  fi
  python3 -c 'import socket,sys; socket.socket(socket.AF_UNIX).bind(sys.argv[1])' "$control"
  exit 0
fi
[ -S "$control" ] || { echo "command without an authenticated master: \${*: -1}" >&2; exit 255; }
cmd="\${*: -1}"
case "$cmd" in
  true) exit 0 ;;
  hostname*) echo Aero-Root-Okra-Knit ;;
  jibo-version*) echo "$PHOENIX_TEST_RELEASE" ;;
  'node -v 2>/dev/null') echo "$PHOENIX_TEST_NODE" ;;
  *'test -f /usr/local/bin/jibo-system-backup'*) test "$PHOENIX_TEST_BACKUP" = yes ;;
  'test -f /usr/local/etc/jibo-jetstream-service.json') test "$PHOENIX_TEST_JETSTREAM" = yes ;;
  *'find "$d" -name region_config.json'*) printf '%s\\n' $PHOENIX_TEST_FOUND ;;
  *"sha256sum '"*'/http/node.js'*) [ -z "$PHOENIX_TEST_HANDLER" ] || echo "$PHOENIX_TEST_HANDLER  node.js" ;;
  'mktemp /tmp/phoenix-preflight.XXXXXX') echo /tmp/phoenix-preflight.abc123 ;;
  "cat > '/tmp/phoenix-preflight.abc123'") cat > /dev/null ;;
  "node '/tmp/phoenix-preflight.abc123' --dry-run --suffix"*)
    if [ "$PHOENIX_TEST_SSM" = google ]; then echo 'not-needed (checks google.com)'; else echo patched; fi ;;
  "node '/tmp/phoenix-preflight.abc123' --dry-run"*)
    if [ "$PHOENIX_TEST_PREFLIGHT" = ok ]; then echo patched
    else echo 'patch-ota-downloader-tls: OTA downloader has an unsupported source hash: 0123' >&2; exit 2; fi ;;
  jibo-getmode*) echo "$PHOENIX_TEST_MODE" ;;
  'test -s /var/jibo/credentials.json') test "$PHOENIX_TEST_CREDS" = yes ;;
  *'grep -Eq'*accessKeyId*) test "$PHOENIX_TEST_CREDS_SHAPE" = ok ;;
  *'oobe-config/config.json'*) echo "$PHOENIX_TEST_REGION" ;;
  *'/var/jibo/credentials.json'*) echo "$PHOENIX_TEST_REGION" ;;
  *'test -f'*region_config.json*) f="$(printf '%s' "$cmd" | sed -e 's/^test -f .//' -e 's/.$//')"; [[ " $PHOENIX_TEST_FOUND " == *" $f "* ]] ;;
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
  const keygen = join(dir, 'ssh-keygen');
  writeFileSync(keygen, `#!/usr/bin/env bash
echo "ssh-keygen $*" >> "$PHOENIX_TEST_LOG"; rm -f "$PHOENIX_TEST_STALE_KEY"
`);
  chmodSync(keygen, 0o755);
  const staleKey = join(dir, 'stale-key');
  if (hostKey === 'changed') writeFileSync(staleKey, '');
  try {
    return execFileSync('setsid', ['-w', 'bash', script, ...(robot ? ['--robot', robot] : []), ...(auto ? ['--auto'] : []),
      ...(claim ? ['--claim-code', claimCode] : []), ...extra, '--dry-run'], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`,
        PHOENIX_TEST_CREDS: credentials ? 'yes' : 'no', PHOENIX_TEST_MODE: mode,
        PHOENIX_TEST_CREDS_SHAPE: shape, PHOENIX_TEST_REGION: region,
        PHOENIX_TEST_AUTH: auth, PHOENIX_TEST_LOG: join(dir, 'ssh.log'),
        PHOENIX_TEST_RELEASE: fw.release, PHOENIX_TEST_NODE: fw.node, PHOENIX_TEST_BACKUP: fw.backup, PHOENIX_TEST_JETSTREAM: fw.jetstream, PHOENIX_TEST_SSM: fw.ssm,
        PHOENIX_TEST_HANDLER: handler ?? fw.handler, PHOENIX_TEST_FOUND: fw.found.join(' '),
        PHOENIX_TEST_PREFLIGHT: preflight, PHOENIX_TEST_STALE_KEY: staleKey },
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
  assert.match(out, /credentials present; verify\/register without changing account ownership/);
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

test('a key login is used without trying any password', () => {
  const out = preview({ credentials: true, mode: 'normal', claim: true });
  assert.match(out, /Wi-Fi server check: not-needed \(checks google\.com\)/);
  assert.match(out, /login {5}: root via key/);
  assert.doesNotMatch(out, /factory root password/);
});

test('with no key installed, the factory root:jibo login is tried automatically', () => {
  const out = preview({ credentials: true, mode: 'normal', claim: true, auth: 'factory' });
  assert.match(out, /login {5}: root via factory password/);
  assert.match(out, /still accepts the factory root password/);
});

test('a bare robot address logs in as root', () => {
  const out = preview({ credentials: true, mode: 'normal', claim: true, auth: 'factory', robot: '192.0.2.15' });
  assert.match(out, /login {5}: root via factory password/);
});

test('a changed root password without a terminal stops with a clear message', () => {
  assert.throws(() => preview({ credentials: true, mode: 'normal', claim: true, auth: 'custom' }), (error) => {
    assert.match(String(error.stderr), /refused key and factory-password login, and there is no terminal/);
    return true;
  });
});

test("the console's command (a claim code alone) takes the credential-detecting path", () => {
  const out = preview({ credentials: true, mode: 'oobe', claim: true, auto: false });
  assert.match(out, /credentials present; adopt\/claim and start native OTA/);
});

test('a new or reset robot is restarted into setup at the end; a set-up one is left to its OTA', () => {
  const fresh = preview({ credentials: false, mode: 'int-developer', claim: true });
  assert.match(fresh, /10\. reboot the robot into its setup screen once everything above has succeeded/);
  const optedOut = preview({ credentials: false, mode: 'int-developer', claim: true, extra: ['--no-reboot'] });
  assert.doesNotMatch(optedOut, /reboot the robot into its setup screen/);
  const paired = preview({ credentials: true, mode: 'normal', claim: true });
  assert.doesNotMatch(paired, /reboot the robot into its setup screen/);
  assert.match(paired, /10\. ask the native system-manager to download and install the published OTA set \(reboots\)/);
});

test('no robot address and no terminal to ask for one stops with the usage hint', () => {
  assert.throws(() => preview({ credentials: true, mode: 'normal', claim: true, auto: false, robot: '' }), (error) => {
    assert.match(String(error.stderr), /--robot root@<ip> is required/);
    return true;
  });
});

test('a changed host key without a terminal stops before any password and names the fix', () => {
  assert.throws(() => preview({ credentials: true, mode: 'normal', claim: true, auth: 'factory', hostKey: 'changed' }), (error) => {
    assert.match(String(error.stderr), /host key changed \(normal after a reflash\)\. If this is your Jibo, run: ssh-keygen -R 192\.0\.2\.15; then run this again/);
    assert.doesNotMatch(String(error.stdout), /Enter the root password/);
    return true;
  });
});

test('a new-in-box RTM3 robot gets the 2.x client build, a default region, and no backup patch', () => {
  const out = preview({ credentials: false, mode: 'int-developer', firmware: 'rtm3', region: '' });
  assert.match(out, /credentials absent; repoint for QR setup/);
  assert.match(out, /region {4}: api \(default: this firmware's setup skill names no region\)/);
  assert.match(out, /node {6}: v4\.1\.2/);
  assert.match(out, /oobe-config\/node_modules\/@jibo\/jibo-server-client\/lib\/region_config\.json {2}\(jibo\.com lines: 5; 2\.x client\)/);
  assert.match(out, /no system backup\/restore helpers on this firmware/);
  assert.match(out, /OTA downloader: reviewed stock version; ready to patch/);
  assert.match(out, /no jetstream hub config on this firmware/);
  // The factory Wi-Fi check still names the old cloud and is patched (see patch-ssm-wifi-check.cjs).
  assert.match(out, /Wi-Fi server check: reviewed stock version; ready to patch/);
  assert.doesNotMatch(out, /backup\/restore helpers: /);
});

test('an unrecognized HTTP client stops before any change', () => {
  assert.throws(() => preview({ credentials: false, mode: 'int-developer', firmware: 'rtm3', region: '', handler: 'f'.repeat(64) }), (error) => {
    assert.match(String(error.stderr), /unrecognized HTTP client at .*nothing was changed/);
    assert.doesNotMatch(String(error.stdout), /== Plan/);
    return true;
  });
});

test('an unreviewed OTA downloader stops at the compatibility check, before any change', () => {
  assert.throws(() => preview({ credentials: true, mode: 'normal', claim: true, preflight: 'unreviewed' }), (error) => {
    assert.match(String(error.stderr), /OTA downloader is not a reviewed version, so nothing was changed/);
    assert.doesNotMatch(String(error.stdout), /dry run — nothing was changed/);
    return true;
  });
});
