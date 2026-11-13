import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,existsSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {deflateSync,gzipSync} from 'node:zlib';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {scaffold} from './new.mjs';
import {buildProject,checkProject,tar} from './project.mjs';
import {inspectPack,canonical,hash} from './format.mjs';
import {pack} from './native-pack.mjs';
import {run} from './cli.mjs';
import {run as ssh,DEFAULTS} from './ssh.mjs';
const appId='app-12345678-1234-4234-8234-123456789abc',projectId='local-project-12345678-1234-4234-8234-123456789abc';
function crc(b){let n=0xffffffff;for(const x of b){n^=x;for(let j=0;j<8;j++)n=(n&1)?0xedb88320^(n>>>1):n>>>1;}return (n^0xffffffff)>>>0;}
function chunk(name,data){const b=Buffer.alloc(data.length+12);b.writeUInt32BE(data.length);b.write(name,4);data.copy(b,8);b.writeUInt32BE(crc(b.subarray(4,b.length-4)),b.length-4);return b;}
function png(filter=0){const h=Buffer.alloc(13);h.writeUInt32BE(32);h.writeUInt32BE(32,4);h[8]=8;h[9]=6;const pixels=Buffer.alloc(129*32,180);for(let y=0;y<32;y++)pixels[y*129]=filter;return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',h),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]);}
function fixture(fn){const base=mkdtempSync(join(tmpdir(),'native-icons-'));return Promise.resolve().then(()=>{const dir=scaffold('icon-test','hello',base).directory;mkdirSync(join(dir,'assets'));const b=png();writeFileSync(join(dir,'assets/app-icon.png'),b);const a=JSON.parse(readFileSync(join(dir,'app.json')));Object.assign(a,{iconApi:1,icon:{type:'image',asset:'app-icon'},iconImage:{mediaType:'image/png',width:32,height:32,bytes:b.length,sha256:hash(b)}});writeFileSync(join(dir,'app.json'),canonical(a));const c=JSON.parse(readFileSync(join(dir,'skill.json')));c.files.push('assets/app-icon.png');writeFileSync(join(dir,'skill.json'),canonical(c));return fn({base,dir,a,c});}).finally(()=>rmSync(base,{recursive:true,force:true}));}
function save(dir,a){writeFileSync(join(dir,'app.json'),canonical(a));}
test('declared image survives project pack and unsigned wrapper with arbitrary issued identity',()=>fixture(({base,dir,a})=>{
 const b=buildProject(dir,appId).bytes,checked=inspectPack(b,'native');assert.equal(checked.nativeSchema,2);assert.equal(checked.appId,appId);
 const n=b.readUInt32BE(8),m=JSON.parse(b.subarray(12,12+n)),artifact=b.subarray(12+n);assert.deepEqual(m.icon,a.icon);assert.deepEqual(m.iconImage,a.iconImage);
 const d={schema:3,runtime:'phoenix-native-v2',...m,appId:'app-22222222-2222-4222-8222-222222222222',compressedBytes:artifact.length,sha256:hash(artifact),fileManifestSha256:hash(canonical(m.fileManifest)),unpackedBytes:m.fileManifest.reduce((n,e)=>n+e.length,0)};d.schema=3;
 writeFileSync(join(base,'unsigned.json'),JSON.stringify({descriptor:d,fileManifest:m.fileManifest}));writeFileSync(join(base,'artifact'),artifact);
 const out=join(base,'wrapped.phnative');pack({unsigned:join(base,'unsigned.json'),artifact:join(base,'artifact'),'app-id':appId,out});const wrapped=readFileSync(out),len=wrapped.readUInt32BE(8);assert.deepEqual(wrapped.subarray(12+len),artifact);assert.equal(inspectPack(wrapped,'native').nativeSchema,2);
}));
for(const icon of [null,{type:'builtin',catalog:'jibo-menu-v1',name:'weather'}])test('explicit null or catalog icon is schema 2, not a silent legacy downgrade: '+JSON.stringify(icon),()=>fixture(({dir,a,c})=>{a.icon=icon;a.iconImage=null;save(dir,a);c.files=c.files.filter(p=>p!=='assets/app-icon.png');writeFileSync(join(dir,'skill.json'),canonical(c));assert.equal(checkProject(dir).nativeSchema,2);}));
for(const [label,change,code] of [
 ['partial fields',a=>delete a.iconImage,'app_icon_ref_invalid'],
 ['unknown API',a=>a.iconApi=2,'app_icon_api_invalid'],
 ['oversize dimensions',a=>a.iconImage.width=331,'app_icon_metadata_invalid'],
 ['oversize blob',a=>a.iconImage.bytes=262145,'app_icon_metadata_invalid'],
 ['hash binding',a=>a.iconImage.sha256='0'.repeat(64),'app_icon_manifest_invalid'],
 ['invalid ref',a=>a.icon.asset='../outside','app_icon_ref_invalid'],
 ['unknown builtin',a=>{a.icon={type:'builtin',catalog:'jibo-menu-v1',name:'unknown'};a.iconImage=null;},'app_icon_ref_invalid'],
 ['null reserved collision',a=>{a.icon=null;a.iconImage=null;},'app_icon_reserved_collision']
])test('rejects '+label,()=>fixture(({dir,a})=>{change(a);save(dir,a);assert.throws(()=>checkProject(dir),e=>e.code===code);}));
test('checks decoder filter as well as valid image digests',()=>fixture(({dir,a})=>{const b=png(5);writeFileSync(join(dir,'assets/app-icon.png'),b);Object.assign(a.iconImage,{bytes:b.length,sha256:hash(b)});save(dir,a);assert.throws(()=>checkProject(dir),/app_icon_filter_invalid/);}));
test('rejects invalid PNG CRC even when all manifest digests match',()=>fixture(({dir,a})=>{const b=png();b[29]^=1;writeFileSync(join(dir,'assets/app-icon.png'),b);a.iconImage.sha256=hash(b);save(dir,a);assert.throws(()=>checkProject(dir));}));
test('schema 2 binding must match canonical app.json, legacy schema remains accepted',()=>fixture(({dir})=>{const good=buildProject(dir).bytes,n=good.readUInt32BE(8),m=JSON.parse(good.subarray(12,12+n));const config=JSON.parse(readFileSync(join(dir,'skill.json')));const files=config.files.map(path=>({path,mode:420,bytes:readFileSync(join(dir,path))})).sort((a,b)=>a.path<b.path?-1:1);const appFile=files.find(f=>f.path==='app.json'),app=JSON.parse(appFile.bytes);app.iconApi=2;appFile.bytes=Buffer.from(canonical(app));m.fileManifest=files.map(f=>({path:f.path,length:f.bytes.length,mode:f.mode,sha256:hash(f.bytes)}));const mb=Buffer.from(canonical(m)),header=Buffer.from(good.subarray(0,12));header.writeUInt32BE(mb.length,8);assert.throws(()=>inspectPack(Buffer.concat([header,mb,gzipSync(tar(files))]),'native'),/native_icon_package_mismatch/);const legacy=scaffold('legacy','hello',join(dir,'..')).directory;assert.equal(checkProject(legacy).nativeSchema,1);}));
for(const cached of [false,true])test('older firmware refuses icons before '+(cached?'cached':'new')+' project state or upload',()=>fixture(async({dir,a})=>{
 const calls=[];const remote=async args=>{calls.push(args[0]);if(args[0]==='info')return {localKinds:['native'],allowTestBuilds:true};if(args[0]==='project')return {projectId,appId,kind:'native'};if(args[0]==='check')return {};if(args[0]==='queue')return {requestId:projectId.slice(14),kind:'native',state:'installed',runtimeState:'running'};throw Error('unexpected');};
 if(cached){delete a.iconApi;delete a.icon;delete a.iconImage;save(dir,a);await run(['install',dir,'--robot','offline-fixture'],{ssh:remote});Object.assign(a,{iconApi:1,icon:null,iconImage:null});const c=JSON.parse(readFileSync(join(dir,'skill.json')));c.files=c.files.filter(p=>p!=='assets/app-icon.png');writeFileSync(join(dir,'skill.json'),canonical(c));save(dir,a);calls.length=0;}
 const before=existsSync(join(dir,'.skill-kit'))?readdirSync(join(dir,'.skill-kit')).map(f=>[f,readFileSync(join(dir,'.skill-kit',f),'utf8')]):null;
 await assert.rejects(run(['install',dir,'--robot','offline-fixture'],{ssh:remote}),e=>e.code==='unsupported_native_icons'&&/Update Jibo/.test(e.ownerMessage));assert.deepEqual(calls,['info']);
 const after=existsSync(join(dir,'.skill-kit'))?readdirSync(join(dir,'.skill-kit')).map(f=>[f,readFileSync(join(dir,'.skill-kit',f),'utf8')]):null;assert.deepEqual(after,before);
}));
test('capable firmware installs schema 2 without changing approvals',()=>fixture(async({dir})=>{const calls=[];await run(['install',dir,'--robot','offline-fixture'],{ssh:async args=>{calls.push(args[0]);if(args[0]==='info')return {localKinds:['native'],nativeContainerSchemas:[1,2]};if(args[0]==='project')return {projectId,appId,kind:'native'};if(args[0]==='check')return {};if(args[0]==='queue')return {requestId:'12345678-1234-4234-8234-123456789abc',kind:'native',state:'installed',runtimeState:'running'};throw Error('unexpected');}});assert.deepEqual(calls,['info','project','check','queue']);}));
test('raw SSH helper refuses schema 2 after info only, before stdin upload',()=>fixture(async({base,dir})=>{const file=join(base,'pack');writeFileSync(file,buildProject(dir).bytes);const calls=[];function spawn(command,args){calls.push(args);const c=new EventEmitter();c.stdin=new PassThrough();c.stdout=new PassThrough();c.stderr=new PassThrough();c.kill=()=>{};c.stdin.on('finish',()=>{c.stdout.end(JSON.stringify({ok:true,result:{protocol:1,managerReady:true,localKinds:['native'],beRoot:DEFAULTS['be-root'],runtimeNode:DEFAULTS.node,stateRoot:DEFAULTS['state-root'],limits:{maxArtifactBytes:33603596}}}));setImmediate(()=>c.emit('close',0));});return c;}await assert.rejects(ssh(['check','--robot','offline-fixture','--project',projectId,'--file',file],{spawn}),/unsupported_native_icons/);assert.equal(calls.length,1);}));
