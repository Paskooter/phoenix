#!/usr/bin/env python3
"""Probe a Jibo flash build's ext4 images for everything robot-ota-repoint.sh depends on.

usage: probe.py <images-dir> <label> <out-dir>
  writes <out-dir>/probe-<label>.json, and copies the version-sensitive stock
  files the helper patches into <out-dir>/files-<label>/ for offline patcher tests.
Reads the images with debugfs only; nothing is mounted. See
docs/ROBOT-FIRMWARE-COMPATIBILITY.md for what the fields mean.
"""
import hashlib, json, os, re, shutil, subprocess, sys, tempfile

IMG, LABEL, OUTDIR = sys.argv[1], sys.argv[2], sys.argv[3]
os.makedirs(OUTDIR, exist_ok=True)
OUT = os.path.join(OUTDIR, f'probe-{LABEL}.json')

PINS = {
    'ota_downloader_original': '33f6db1496baa3abd506a2ba9dad9b5cdf7567341e3e292e42cb3ed6f016003c',
    'backup_original': 'd17fbf4150dee58a988fe5ee72071d4515ef74f29876215bf66de2601e33e522',
    'restore_original': 'b5e7ec06c4ea72b641b8738b789a389575e250b152b3b6ecddd952d593e05ee6',
}
ROOT_MARKER = 'MIIFazCCA1OgAwIBAgIRAIIQz7DSQONZRGPgu2OCiwAwDQYJKoZIhvcNAQELBQAw'


def img(name):
    for cand in (f'{name}.ext4', f'{name}.img'):
        p = os.path.join(IMG, cand)
        if os.path.exists(p):
            return p
    return None


def dbg(image, cmd):
    if not image:
        return ''
    r = subprocess.run(['debugfs', '-R', cmd, image], capture_output=True, text=True, errors='replace')
    return r.stdout


def exists(image, path):
    out = subprocess.run(['debugfs', '-R', f'stat {path}', image], capture_output=True, text=True, errors='replace')
    return image is not None and 'Inode:' in out.stdout


def ftype(image, path):
    out = dbg(image, f'stat {path}')
    m = re.search(r'Type:\s+(\w+)\s+Mode:\s+(\d+)', out)
    return (m.group(1), m.group(2)) if m else (None, None)


def cat_bytes(image, path):
    r = subprocess.run(['debugfs', '-R', f'cat {path}', image], capture_output=True)
    return r.stdout


def readlink(image, path):
    out = dbg(image, f'stat {path}')
    m = re.search(r'Fast link dest: "([^"]*)"', out)
    return m.group(1) if m else None


def rdump(image, path, dest):
    os.makedirs(dest, exist_ok=True)
    subprocess.run(['debugfs', '-R', f'rdump {path} {dest}', image], capture_output=True)


def sha(b):
    return hashlib.sha256(b).hexdigest()


facts = {'label': LABEL}
R, S, K, V = img('rootfs'), img('services'), img('skills'), img('var')
facts['images'] = {n: bool(p) for n, p in (('rootfs', R), ('services', S), ('skills', K), ('var', V))}

# --- identity / version ------------------------------------------------------
jv = cat_bytes(R, '/usr/bin/jibo-version')
m = re.search(rb'Release-[0-9][0-9A-Za-z.\-]*', jv)
facts['jibo_version_binary'] = bool(jv)
facts['release_string'] = m.group(0).decode() if m else None
facts['fstab'] = [l for l in dbg(R, 'cat /etc/fstab').splitlines() if l.startswith('/dev/')]
node = cat_bytes(R, '/usr/bin/node')
mv = re.search(rb'node/v?([0-9]+\.[0-9]+\.[0-9]+)', node) or re.search(rb'\bv([0-9]+\.[0-9]+\.[0-9]+)\x00', node)
facts['node_version'] = mv.group(1).decode() if mv else None
facts['node_present'] = bool(node)

# --- tools the script shells out to on the robot ------------------------------
tools = {}
for t in ['jibo-getmode', 'jibo-setmode', 'jibo-version', 'jibo-mount', 'curl', 'sha256sum', 'mktemp',
          'openssl', 'blockdev', 'resize2fs', 'hostname', 'scp', 'find', 'xargs', 'timeout']:
    loc = None
    for d in ['/usr/bin', '/bin', '/usr/sbin', '/sbin']:
        if exists(R, f'{d}/{t}'):
            loc = f'{d}/{t}'
            break
    tools[t] = loc
facts['tools'] = tools
facts['sftp_server'] = next((p for p in ['/usr/libexec/sftp-server', '/usr/lib/openssh/sftp-server',
                                         '/usr/libexec/openssh/sftp-server'] if exists(R, p)), None)
facts['dropbear'] = exists(R, '/usr/sbin/dropbear')
facts['sshd'] = exists(R, '/usr/sbin/sshd')
facts['getmode_reads'] = re.findall(r'/var/jibo/[a-z_.]+', dbg(R, 'cat /usr/bin/jibo-getmode'))
setmode = dbg(R, 'cat /usr/bin/jibo-setmode')
facts['setmode_modes'] = sorted(set(re.findall(r'"(identified|oobe|int-developer|developer|certification|normal|service|[a-z-]+)"', setmode)) & {
    'identified', 'oobe', 'int-developer', 'developer', 'certification', 'normal', 'service'})


# --- SSH login surface --------------------------------------------------------
sshd = cat_bytes(R, '/usr/sbin/sshd')
mv = re.search(rb'OpenSSH_[0-9]+\.[0-9]+p?[0-9]*', sshd)
cfg = dbg(R, 'cat /etc/ssh/sshd_config')
facts['ssh'] = {
    'sshd_version': mv.group(0).decode() if mv else None,
    'dropbear': exists(R, '/usr/sbin/dropbear'),
    'config': [l.strip() for l in cfg.splitlines() if l.strip() and not l.strip().startswith('#')],
}
shadow = dbg(R, 'cat /etc/shadow')
root = next((l.split(':')[1] for l in shadow.splitlines() if l.startswith('root:')), None)
default_ok = None
if root and root.startswith('$1$'):
    salt = root.split('$')[2]
    calc = subprocess.run(['openssl', 'passwd', '-1', '-salt', salt, 'jibo'], capture_output=True, text=True).stdout.strip()
    default_ok = calc == root
elif root is not None:
    default_ok = 'empty' if root == '' else f'unhandled:{root[:3]}'
facts['ssh']['root_password_is_jibo'] = default_ok


fw = next((n for n in re.findall(r'S\d+firewall', dbg(R, 'ls /etc/init.d'))), None)
fwsrc = dbg(R, f'cat /etc/init.d/{fw}') if fw else ''
facts['firewall'] = {'script': fw, 'rejects_by_default': 'REJECT' in fwsrc,
                     'open_modes': [m for m in ('identified', 'int-developer', 'developer') if f'"{m}" ]' in fwsrc or f'"{m}"' in fwsrc]}

# --- trust store --------------------------------------------------------------
bundle = cat_bytes(R, '/etc/ssl/certs/ca-certificates.crt')
facts['ca_bundle'] = {'present': bool(bundle), 'bytes': len(bundle),
                      'certs': bundle.count(b'BEGIN CERTIFICATE'),
                      'isrg_x1': ROOT_MARKER.encode() in bundle}
facts['etc_ssl_cert_pem'] = {'exists': exists(R, '/etc/ssl/cert.pem'), 'link': readlink(R, '/etc/ssl/cert.pem')}

# --- node client copies (region_config.json) ----------------------------------
tmp = tempfile.mkdtemp(prefix='probe-')
try:
    configs = []
    def scan(image, part, base, mount):
        dest = os.path.join(tmp, part + base.replace('/', '_'))
        rdump(image, base, dest)
        for root, dirs, files in os.walk(dest):
            if 'region_config.json' in files and root.endswith('/lib'):
                p = os.path.join(root, 'region_config.json')
                rel = mount + base + root[len(dest) + len('/' + os.path.basename(base)):] + '/region_config.json'
                body = open(p, 'rb').read()
                pkg = os.path.join(os.path.dirname(root), 'package.json')
                ver = None
                if os.path.exists(pkg):
                    try: ver = json.load(open(pkg)).get('version')
                    except Exception: pass
                http_node = os.path.exists(os.path.join(root, 'http', 'node.js'))
                try:
                    parsed = json.loads(body)
                    keys = sorted(parsed.keys()) if isinstance(parsed, dict) else type(parsed).__name__
                except Exception:
                    parsed, keys = None, 'unparseable'
                configs.append({'path': rel, 'client_version': ver, 'jibo_com_hits': body.count(b'jibo.com'),
                                'top_keys': keys, 'has_lib_http_node_js': http_node,
                                'sample': body[:400].decode('utf8', 'replace')})
    scan(R, 'rootfs', '/usr/lib/node_modules', '')
    if exists(R, '/bin/jibo-ssm'):
        scan(R, 'rootfs', '/bin/jibo-ssm', '')
    if S:
        scan(S, 'services', '/bin', '/usr/local')
    if K and exists(K, '/jibo/Jibo/Skills'):
        scan(K, 'skills', '/jibo/Jibo/Skills', '/opt')
    facts['region_configs'] = configs


    # --- every other text config that still names the old cloud ----------------
    other = []
    def grep_tree(image, part, base, mount, exts=('.json', '.conf', '.cfg', '.yml', '.yaml', '.ini', '.xml', '.properties')):
        dest = os.path.join(tmp, 'g-' + part + base.replace('/', '_'))
        rdump(image, base, dest)
        for root, dirs, files in os.walk(dest):
            if 'node_modules' in root.split(os.sep):
                continue
            for f in files:
                if not f.endswith(exts):
                    continue
                fp = os.path.join(root, f)
                try:
                    b = open(fp, 'rb').read()
                except Exception:
                    continue
                if b'jibo.com' in b and not f == 'region_config.json':
                    rel = mount + base + fp[len(dest) + len('/' + os.path.basename(base)):]
                    hosts = sorted(set(m.decode() for m in re.findall(rb'[a-z0-9.-]*jibo\.com(?::[0-9]+)?', b)))[:8]
                    other.append({'path': rel, 'hosts': hosts})
    grep_tree(R, 'rootfs', '/etc', '')
    if S:
        grep_tree(S, 'services', '/etc', '/usr/local')
    facts['other_jibo_com_configs'] = other

    # --- OTA updater -----------------------------------------------------------
    upd = '/usr/lib/node_modules/@jibo/jibo-ota-updater'
    dl = cat_bytes(R, f'{upd}/src/download-update.js')
    facts['ota_updater'] = {
        'present': exists(R, upd),
        'version': (json.loads(cat_bytes(R, f'{upd}/package.json') or b'{}') or {}).get('version') if exists(R, f'{upd}/package.json') else None,
        'download_update_js_sha256': sha(dl) if dl else None,
        'matches_pinned_original': sha(dl) == PINS['ota_downloader_original'] if dl else False,
        'anchor_present': b'let req = http.get(argv.url, function(res) {' in dl,
        'jibo_download_update_link': readlink(R, '/usr/bin/jibo-download-update'),
        'src_files': sorted(re.findall(r'/([A-Za-z0-9_.-]+\.js)\n', '\n'.join('/' + l.split('/')[5] for l in dbg(R, f'ls -p {upd}/src').splitlines() if l.count('/') >= 6) + '\n')),
    }

    # --- services partition ----------------------------------------------------
    svc = {}
    if S:
        for name, key in (('jibo-system-backup', 'backup_original'), ('jibo-system-restore', 'restore_original')):
            b = cat_bytes(S, f'/bin/{name}')
            svc[name] = {'present': bool(b), 'sha256': sha(b) if b else None,
                         'matches_pinned_original': sha(b) == PINS[key] if b else False,
                         'has_request_line': b"var request = require('request');\n" in b,
                         'has_https_line': b"var https = require('https');\n" in b}
        js = cat_bytes(S, '/etc/jibo-jetstream-service.json')
        jet = {'present': bool(js)}
        if js:
            try:
                d = json.loads(js)
                hc = d.get('HubClient', {})
                jet.update({'has_HubClient': 'HubClient' in d, 'hub_keys': sorted(hc.keys()),
                            'regions': sorted((hc.get('region-settings') or {}).keys()),
                            'region_setting_example': next(iter((hc.get('region-settings') or {}).values()), None),
                            'override': hc.get('override')})
            except Exception as e:
                jet['parse_error'] = str(e)
        svc['jetstream'] = jet
        sm = cat_bytes(S, '/etc/jibo-system-manager.json')
        smj = {}
        try: smj = json.loads(sm)
        except Exception: pass
        svc['system_manager'] = {'config_present': bool(sm), 'serverPort': (smj.get('SystemManager') or {}).get('serverPort'),
                                 'backup_exec': ((smj.get('SystemManager') or {}).get('service') or {}).get('backup', {}).get('executable')}
        smb = cat_bytes(S, '/bin/jibo-system-manager')
        svc['system_manager']['binary_bytes'] = len(smb)
        lib = subprocess.run(['debugfs', '-R', 'cat /lib/libJiboSystemManager.so', S], capture_output=True).stdout
        svc['system_manager']['lib_bytes'] = len(lib)
        svc['system_manager']['lib_update_route'] = sorted(set(m.decode() for m in re.findall(rb'\^/update[^\x00]{0,40}', lib)))
        svc['system_manager']['lib_download_exec'] = sorted(set(m.decode() for m in re.findall(rb'/usr/bin/jibo-(?:download|apply)-update', lib)))
        svc['jibo_ssm'] = ftype(S, '/bin/jibo-ssm')[0]
    facts['services'] = svc

    # --- skills partition ------------------------------------------------------
    sk = {}
    if K:
        listing = dbg(K, 'ls -p /jibo/Jibo/Skills')
        sk['skills'] = [l.split('/')[5] for l in listing.splitlines() if l.count('/') >= 6 and l.split('/')[5] not in ('.', '..')]
        if exists(K, '/jibo/Jibo/Skills/@be'):
            sk['@be'] = [l.split('/')[5] for l in dbg(K, 'ls -p /jibo/Jibo/Skills/@be').splitlines() if l.count('/') >= 6 and l.split('/')[5] not in ('.', '..')]
        oc = cat_bytes(K, '/jibo/Jibo/Skills/oobe-config/config.json')
        m = re.search(rb'"serverRegion"\s*:\s*"([^"]*)"', oc)
        sk['oobe_config_json'] = bool(oc)
        sk['oobe_serverRegion'] = m.group(1).decode() if m else None
    facts['skills'] = sk
    facts['var_template'] = [l.split('/')[5] for l in dbg(V, 'ls -p /jibo').splitlines() if l.count('/') >= 6 and l.split('/')[5] not in ('.', '..')] if V else None
finally:
    shutil.rmtree(tmp, ignore_errors=True)


# --- keep the version-sensitive originals for offline patcher tests -----------
keep = os.path.join(os.path.dirname(OUT), f'files-{LABEL}')
os.makedirs(keep, exist_ok=True)
for image, path, name in ((R, '/usr/lib/node_modules/@jibo/jibo-ota-updater/src/download-update.js', 'download-update.js'),
                          (S, '/bin/jibo-system-backup', 'jibo-system-backup'),
                          (S, '/bin/jibo-system-restore', 'jibo-system-restore'),
                          (S, '/etc/jibo-server-service.json', 'jibo-server-service.json'),
                          (S, '/etc/jibo-jetstream-service.json', 'jibo-jetstream-service.json'),
                          (S, '/etc/jibo-asr-service.json', 'jibo-asr-service.json'),
                          (K, '/jibo/Jibo/Skills/oobe-config/config.json', 'oobe-config.json'),
                          (K, '/jibo/Jibo/Skills/oobe-config/package.json', 'oobe-package.json'),
                          (R, '/usr/bin/jibo-setmode', 'jibo-setmode'),
                          (R, '/usr/bin/jibo-mount', 'jibo-mount')):
    if image:
        b = cat_bytes(image, path)
        if b:
            open(os.path.join(keep, name), 'wb').write(b)

json.dump(facts, open(OUT, 'w'), indent=2)
print(OUT)
