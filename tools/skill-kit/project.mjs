import {lstatSync,readFileSync,readdirSync,openSync,closeSync,readSync,fstatSync,constants,writeFileSync,mkdirSync,realpathSync} from 'node:fs';
import {join,resolve,relative,sep} from 'node:path';
import {gzipSync} from 'node:zlib';
import {canonical,parse,hash,fail,validPath,nativeMeta,nativeFile,inspectPack} from './format.mjs';
import {iconFields} from './native-icons.mjs';
export function readRegular(file,max=33554432) {
  const before=lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > max) fail('invalid_input_file');
  const fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try {
    const st=fstatSync(fd); if(st.ino!==before.ino||st.dev!==before.dev) fail('input_changed');
    const bytes=Buffer.alloc(st.size); let at=0;
    while(at<bytes.length) { const n=readSync(fd,bytes,at,bytes.length-at,at); if(!n) fail('input_changed'); at+=n; }
    const after=fstatSync(fd),end=lstatSync(file);
    if ([after,end].some(s=>s.ino!==st.ino||s.dev!==st.dev||s.size!==st.size||s.mtimeMs!==st.mtimeMs||s.ctimeMs!==st.ctimeMs)) fail('input_changed');
    return bytes;
  } finally {closeSync(fd);}
}
export function loadProject(dir) {
  dir=resolve(dir); if(realpathSync(dir)!==dir||!lstatSync(dir).isDirectory()) fail('invalid_project_path');
  const config=parse(readRegular(join(dir,'skill.json'),65536));
  if (!config || Object.keys(config).some(k=>!['schema','kind','name','files'].includes(k)) || config.schema!==1 || config.kind!=='native' || typeof config.name!=='string' || !config.name.trim() || config.name.length>60 || /[\x00-\x1f<>]/.test(config.name)) fail('invalid_project');
  return {dir,config};
}
export function tar(files) {
  const blocks=[];
  function octal(h,at,len,n){h.write(n.toString(8).padStart(len-1,'0')+'\0',at,len,'ascii');}
  for (const f of files) {
    const h=Buffer.alloc(512); let name=f.path,prefix='';
    if(Buffer.byteLength(name)>100) { let at=name.lastIndexOf('/'); while(at>0 && (Buffer.byteLength(name.slice(at+1))>100||Buffer.byteLength(name.slice(0,at))>155)) at=name.lastIndexOf('/',at-1); if(at<1) fail('ustar_path_limit'); prefix=name.slice(0,at); name=name.slice(at+1); }
    h.write(name,0,100);octal(h,100,8,f.mode);octal(h,108,8,0);octal(h,116,8,0);octal(h,124,12,f.bytes.length);octal(h,136,12,0);h.fill(32,148,156);h[156]=48;h.write('ustar\0',257);h.write('00',263);h.write(prefix,345,155);
    let sum=0;for(const n of h)sum+=n;h.write(sum.toString(8).padStart(6,'0')+'\0 ',148,8);
    blocks.push(h,f.bytes,Buffer.alloc((512-f.bytes.length%512)%512));
  }
  blocks.push(Buffer.alloc(1024)); return Buffer.concat(blocks);
}
export function buildProject(dir,appId,syntaxNode) {
  const {dir:base,config}=loadProject(dir);
  if(!Array.isArray(config.files)||!config.files.includes('app.json')||config.files.length<2||config.files.length>4096||new Set(config.files).size!==config.files.length) fail('invalid_file_list');
  const app=parse(readRegular(join(base,'app.json'),65536),4096);
  const allowed=['appId','name','version','minFirmware','hostAbi','entry','permissions','optionalPermissions','launchNames','incomingPorts','skills','plugins','menuEntries','iconApi','icon','iconImage'];
  if(Object.keys(app).some(k=>!allowed.includes(k))) fail('invalid_app_manifest');
  if(typeof app.name!=='string'||!/^@[a-z0-9-]+\/[a-z0-9-]+$/.test(app.name)) fail('invalid_app_manifest');
  for(const key of ['skills','plugins','menuEntries','incomingPorts'])if(app[key]!==undefined&&!Array.isArray(app[key]))fail('invalid_app_manifest');
  for(const key of ['skills','plugins','menuEntries'])if(app[key]?.some(v=>typeof v!=='string'&&(!v||typeof v.name!=='string')))fail('invalid_app_manifest');
  if(appId)app.appId=appId;
  const files=config.files.map(p=>{
    if(!validPath(p))fail('invalid_source_path'); const full=join(base,p);
    // Reject symlinks in every component, including otherwise regular leaves.
    let current=base;for(const part of p.split('/')){current=join(current,part);if(lstatSync(current).isSymbolicLink())fail('invalid_source_path');}
    if(!relative(base,full)||relative(base,full).startsWith('..'+sep))fail('invalid_source_path');
    const bytes=p==='app.json'?Buffer.from(canonical(app)):readRegular(full);
    nativeFile(p,bytes,syntaxNode);return {path:p,mode:(lstatSync(full).mode&0o111)?493:420,bytes};
  }).sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
  const icons=iconFields(app);
  const m={schema:Object.keys(icons).length?2:1,...icons,kind:'native',appId:app.appId,version:app.version,minFirmware:app.minFirmware,hostAbi:app.hostAbi,entry:app.entry,permissions:app.permissions,optionalPermissions:app.optionalPermissions,launchNames:app.launchNames,fileManifest:files.map(f=>({path:f.path,length:f.bytes.length,mode:f.mode,sha256:hash(f.bytes)}))};
  nativeMeta(m);const metadata=Buffer.from(canonical(m)),artifact=gzipSync(tar(files),{level:9});
  const h=Buffer.alloc(12);h.write('PHXNAT1\n');h.writeUInt32BE(metadata.length,8);
  const bytes=Buffer.concat([h,metadata,artifact]);inspectPack(bytes,'native');
  return {bytes,kind:'native',version:m.version,appId:m.appId,name:config.name};
}
export function checkProject(target,syntaxNode) {
  if(lstatSync(target).isFile()) return inspectPack(readRegular(target,33603596),'native',syntaxNode);
  const build=buildProject(target,undefined,syntaxNode);return inspectPack(build.bytes,build.kind);
}
export function packProject(dir,out,appId,syntaxNode) {
  const b=buildProject(dir,appId,syntaxNode);out=resolve(out);
  // Build before creating output, never recursively include it in an artifact.
  mkdirSync(out,{recursive:true});const file=join(out,`${b.name}-${b.version}.phnative`);
  if(!/^[a-z][a-z0-9-]{0,39}$/.test(b.name)) fail('invalid_output_name');
  writeFileSync(file,b.bytes,{flag:'wx',mode:0o600});return {...inspectPack(b.bytes,b.kind),file};
}
