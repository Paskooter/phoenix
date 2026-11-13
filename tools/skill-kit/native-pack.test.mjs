import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
const canonical=v=>JSON.stringify(v,(_,x)=>x&&Object.getPrototypeOf(x)===Object.prototype?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
const hash=b=>createHash('sha256').update(b).digest('hex');
const appId='app-11111111-1111-4111-8111-111111111111';
function fixture(run){const root=mkdtempSync(join(tmpdir(),'native-pack-'));try{const artifact=Buffer.from('inert artifact; robot validates its tar separately'),manifest=[{path:'entry.js',length:1,sha256:'0'.repeat(64),mode:420}],descriptor={appId:'app-22222222-2222-4222-8222-222222222222',version:'1.0.2',minFirmware:'13.7.1',hostAbi:1,entry:'entry.js',permissions:['network'],optionalPermissions:[],launchNames:['agent-mode'],compressedBytes:artifact.length,sha256:hash(artifact),fileManifestSha256:hash(canonical(manifest)),unpackedBytes:1};writeFileSync(join(root,'artifact.tar.gz'),artifact);writeFileSync(join(root,'unsigned.json'),JSON.stringify({descriptor,fileManifest:manifest}));run({root,artifact,descriptor,manifest});}finally{rmSync(root,{recursive:true,force:true});}}
function pack(root,more=[]){return spawnSync(process.execPath,[new URL('./native-pack.mjs',import.meta.url).pathname,'--unsigned',join(root,'unsigned.json'),'--artifact',join(root,'artifact.tar.gz'),'--app-id',more.length?more[1]:appId,'--out',join(root,'test.phnative')],{encoding:'utf8'});}
test('wraps immutable unsigned artifact with the allocated local identity',()=>fixture(({root,artifact})=>{const r=pack(root);assert.equal(r.status,0,r.stderr);const bytes=readFileSync(join(root,'test.phnative'));assert.equal(bytes.subarray(0,8).toString(),'PHXNAT1\n');const n=bytes.readUInt32BE(8),meta=JSON.parse(bytes.subarray(12,12+n));assert.equal(meta.appId,appId);assert.equal(meta.version,'1.0.2');assert.equal(meta.minFirmware,'13.7.1');assert.deepEqual(bytes.subarray(12+n),artifact);assert.equal(bytes.subarray(12,12+n).toString(),canonical(meta));assert.equal(meta.signature,undefined);assert.equal(meta.reviewId,undefined);}));
test('refuses artifact hash mismatch',()=>fixture(({root})=>{writeFileSync(join(root,'artifact.tar.gz'),'changed');const r=pack(root);assert.notEqual(r.status,0);assert.match(r.stderr,/artifact_integrity/);}));
test('refuses manifest digest mismatch',()=>fixture(({root,descriptor,manifest})=>{manifest[0].length=2;writeFileSync(join(root,'unsigned.json'),JSON.stringify({descriptor,fileManifest:manifest}));const r=pack(root);assert.notEqual(r.status,0);assert.match(r.stderr,/manifest_integrity/);}));
test('refuses source Store identity instead of an allocated local identity',()=>fixture(({root,descriptor})=>{const r=pack(root,['--app-id',descriptor.appId]);assert.notEqual(r.status,0);assert.match(r.stderr,/identity_must_change/);}));
test('refuses replacing an existing output',()=>fixture(({root})=>{writeFileSync(join(root,'test.phnative'),'keep');assert.notEqual(pack(root).status,0);assert.equal(readFileSync(join(root,'test.phnative'),'utf8'),'keep');}));
