#!/usr/bin/env python3
"""Install a hash-pinned BE release in a new, separate Moth validation slot.

Does not stop/start skills or change native configuration. Verifies all release
file bytes after extraction; only the root package name is changed for SSM's
required @be/ namespace. Retains a receipt and rollback package on the robot.
"""
import argparse
import hashlib
import json
from pathlib import Path
import posixpath
import re
import shlex
import subprocess
import tarfile


HOST = 'root@moth-radius-breazeal-felt.jibo'


def ssh(command, **kwargs):
    return subprocess.run(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', HOST, command],
                          check=True, **kwargs)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--archive', type=Path, required=True)
    parser.add_argument('--sha256', required=True)
    parser.add_argument('--version', required=True)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    if not re.fullmatch(r'\d+\.\d+\.\d+', args.version):
        parser.error('Use an explicit numeric release version')
    h = hashlib.sha256()
    with args.archive.open('rb') as f:
        for b in iter(lambda: f.read(1048576), b''):
            h.update(b)
    if h.hexdigest() != args.sha256:
        raise RuntimeError('Archive checksum mismatch')
    files = []
    with tarfile.open(args.archive) as archive:
        for member in archive:
            rel = posixpath.normpath(member.name)
            if rel.startswith('/') or rel == '..' or rel.startswith('../'):
                raise RuntimeError('Unsafe archive path: ' + member.name)
            if member.issym() or member.islnk():
                target = posixpath.normpath(posixpath.join(posixpath.dirname(rel) if member.issym() else '', member.linkname))
                if target.startswith('/') or target == '..' or target.startswith('../'):
                    raise RuntimeError('Unsafe archive link: ' + member.name)
            if member.isfile():
                content = archive.extractfile(member)
                digest = hashlib.sha256()
                for b in iter(lambda: content.read(1048576), b''):
                    digest.update(b)
                files.append({'path': rel, 'sha256': digest.hexdigest()})
    if len({f['path'] for f in files}) != len(files):
        raise RuntimeError('Duplicate archive file paths require review')
    slot = 'phoenix-be-' + args.version.replace('.', '-') + '-parity'
    remote = '/opt/jibo/Jibo/Skills/' + slot
    print('Extracting verified release %s to %s' % (args.version, remote), flush=True)
    with args.archive.open('rb') as f:
        ssh('set -e; test ! -e ' + shlex.quote(remote) + '; mkdir -m 755 ' + shlex.quote(remote) +
            '; tar xzf - -C ' + shlex.quote(remote), stdin=f, timeout=180)
    # The source is fixed text; values travel as JSON through stdin, not shell interpolation.
    script = r'''var fs=require('fs'),crypto=require('crypto'),input=JSON.parse(fs.readFileSync(0,'utf8'));
var root=input.root,changed=[];input.files.forEach(function(x){var actual=crypto.createHash('sha256').update(fs.readFileSync(root+'/'+x.path)).digest('hex');if(actual!==x.sha256)changed.push({path:x.path,actual:actual,expected:x.sha256});});
if(changed.length)throw Error('Release byte mismatch: '+JSON.stringify(changed));
var p=root+'/package.json',j=JSON.parse(fs.readFileSync(p));if(j.name!=='@be/be'||j.version!==input.version)throw Error('Unexpected release identity');
var backup='/opt/phoenix-parity/20260905-moth/be-'+input.version+'.package.before.json';fs.writeFileSync(backup,fs.readFileSync(p),{mode:384,flag:'wx'});
j.name='@be/phoenix-parity-'+input.version.replace(/\./g,'-');fs.writeFileSync(p,JSON.stringify(j,null,2)+'\n');fs.chmodSync(root+'/index.js',436);
console.log(JSON.stringify({version:j.version,name:j.name,slot:root,verifiedFiles:input.files.length,changes:[{path:'package.json',sha256:crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'),reason:'Unique validation package in SSM-required @be namespace'}],packageBackup:backup}));'''
    result = ssh('node -e ' + shlex.quote(script), input=json.dumps({'root': remote, 'version': args.version, 'files': files}),
                 capture_output=True, text=True, timeout=120)
    receipt = json.loads(result.stdout)
    receipt.update({'archive': str(args.archive), 'archiveSha256': args.sha256,
                    'archiveBytes': args.archive.stat().st_size, 'host': HOST})
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(receipt, indent=2)+'\n')
    print(json.dumps(receipt, indent=2))


if __name__ == '__main__':
    main()
