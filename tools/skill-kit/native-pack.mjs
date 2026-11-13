#!/usr/bin/env node
// Host-only unsigned test container. No network, signing, execution or consent.
import {openSync,closeSync,readFileSync,fstatSync,constants,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {iconFields} from './native-icons.mjs';
import {nativeMeta,inspectPack} from './format.mjs';
function fail(code){throw Object.assign(new Error(code),{code});}
function canonical(v){if(Array.isArray(v))return '['+v.map(canonical).join(',')+']';if(v&&Object.getPrototypeOf(v)===Object.prototype)return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';return JSON.stringify(v);}
const hash=b=>createHash('sha256').update(b).digest('hex');
function readRegular(file,max){const fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);try{const before=fstatSync(fd);if(!before.isFile()||before.nlink!==1||before.size<1||before.size>max)fail('invalid_input_file');const b=readFileSync(fd),after=fstatSync(fd);if(before.size!==b.length||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs)fail('input_changed');return b;}finally{closeSync(fd);}}
export function pack(options){
 const input=JSON.parse(readRegular(options.unsigned,262144)),d=input.descriptor,m=input.fileManifest;
 if(!d||!Array.isArray(m)||!m.length||m.length>4096)fail('invalid_unsigned');
 if(!/^app-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(options['app-id']))fail('invalid_local_identity');
 if(options['app-id']===d.appId)fail('identity_must_change');
 const artifact=readRegular(options.artifact,33554432);
 if(artifact.length!==d.compressedBytes||hash(artifact)!==d.sha256)fail('artifact_integrity');
 if(hash(canonical(m))!==d.fileManifestSha256||m.reduce((n,e)=>n+e.length,0)!==d.unpackedBytes)fail('manifest_integrity');
 const icons=iconFields(d);
 if((d.runtime==='phoenix-native-v2'||d.schema===3)&&!Object.keys(icons).length)fail('invalid_unsigned');
 if(Object.keys(icons).length&&(d.runtime!=='phoenix-native-v2'||d.schema!==3))fail('invalid_unsigned');
 const metadata={schema:Object.keys(icons).length?2:1,...icons,kind:'native',appId:options['app-id'],version:d.version,minFirmware:d.minFirmware,hostAbi:d.hostAbi,entry:d.entry,permissions:d.permissions,optionalPermissions:d.optionalPermissions,launchNames:d.launchNames,fileManifest:m};
 nativeMeta(metadata);
 const bytes=Buffer.from(canonical(metadata));if(bytes.length>49152)fail('metadata_limit');
 const header=Buffer.alloc(12);header.write('PHXNAT1\n');header.writeUInt32BE(bytes.length,8);
 const container=Buffer.concat([header,bytes,artifact]);if(metadata.schema===2)inspectPack(container,'native');writeFileSync(options.out,container,{flag:'wx',mode:0o600});
 return {file:options.out,appId:metadata.appId,version:metadata.version,bytes:container.length,sha256:hash(container),artifactSha256:hash(artifact),notice:'Packaging only. Robot validation and physical approval are still required; native global resources are not isolated.'};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){try{const options={};for(let i=2;i<process.argv.length;i+=2){const k=process.argv[i].replace(/^--/,'');if(!['unsigned','artifact','app-id','out'].includes(k)||Object.hasOwn(options,k)||!process.argv[i+1])fail('invalid_option');options[k]=process.argv[i+1];}if(Object.keys(options).length!==4)fail('missing_option');console.log(JSON.stringify(pack(options)));}catch(e){console.error('Native test packaging failed: '+(e.code||'invalid_input'));process.exitCode=1;}}
