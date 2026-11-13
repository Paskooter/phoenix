// Independently implemented author checks for the public skill pack format.
// No submitted JavaScript is evaluated. The robot remains authoritative.
import {createHash} from 'node:crypto';
import {Script} from 'node:vm';
import {spawnSync} from 'node:child_process';
import {isAbsolute} from 'node:path';
import {gunzipSync,inflateRawSync} from 'node:zlib';
import strict from '../theme-kit/themeFormat.cjs';
import shared from '../theme-kit/format.cjs';
import {validateIcon,inspectIcon} from './native-icons.mjs';
export const canonical = shared.canonical;
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const APP = /^app-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
export function fail(code) { throw Object.assign(new Error(code), {code}); }
export function parse(bytes, members = 64) { return strict.parseStrict(bytes, {members}); }
function object(v) { return v && Object.getPrototypeOf(v) === Object.prototype; }
function keys(v, allowed, required = allowed, code = 'invalid_package') {
  if (!object(v) || Object.keys(v).some(k => !allowed.includes(k)) || required.some(k => !Object.hasOwn(v,k))) fail(code);
}
function version(v) { shared.compareVersion(v,v); }
export function validPath(p) { return typeof p === 'string' && Buffer.byteLength(p) <= 200 && /^[A-Za-z0-9_@.+-]+(?:\/[A-Za-z0-9_@.+-]+)*$/.test(p) && p.split('/').every(s => s !== '.' && s !== '..'); }
export function nativeMeta(m) {
  const code='test_native_metadata_invalid';
  keys(m,['schema','kind','appId','version','minFirmware','hostAbi','entry','permissions','optionalPermissions','launchNames','fileManifest',...(m.schema===2?['iconApi','icon','iconImage']:[])],undefined,code);
  if (![1,2].includes(m.schema) || m.kind !== 'native' || !APP.test(m.appId)) fail(code);
  if (m.hostAbi !== 1 || !validPath(m.entry) || !/\.js$/.test(m.entry)) fail('native_descriptor_invalid');
  try { version(m.version); version(m.minFirmware); } catch { fail('native_descriptor_invalid'); }
  function list(v,max,re) { return Array.isArray(v) && v.length <= max && v.every((x,i) => typeof x === 'string' && re.test(x) && v.indexOf(x) === i); }
  if (!list(m.permissions,32,/^[a-z][a-z0-9-]{0,63}$/) || !list(m.optionalPermissions,32,/^[a-z][a-z0-9-]{0,63}$/) || m.permissions.some(p => m.optionalPermissions.includes(p)) || !list(m.launchNames,16,/^[a-z0-9][a-z0-9 -]{0,63}$/)) fail('native_descriptor_invalid');
  if (!Array.isArray(m.fileManifest) || !m.fileManifest.length || m.fileManifest.length > 4096) fail('native_manifest_invalid');
  let previous='',total=0;
  for (const e of m.fileManifest) {
    keys(e,['path','length','sha256','mode'],undefined,'native_manifest_invalid');
    if (!validPath(e.path) || e.path <= previous || !Number.isSafeInteger(e.length) || e.length < 0 || e.length > 33554432 || !/^[a-f0-9]{64}$/.test(e.sha256) || ![420,493].includes(e.mode)) fail('native_manifest_invalid');
    previous=e.path; total+=e.length;
  }
  if (total > 134217728) fail('native_descriptor_invalid');
  if (!m.fileManifest.some(e => e.path === m.entry)) fail('native_manifest_invalid');
  if (m.schema===2) validateIcon(m,m.fileManifest);
  if (Buffer.byteLength(canonical(m)) > 49152) fail(code);
  return total;
}
export function nativeFile(p,b,syntaxNode) {
  if(p==='app.json')parse(b,4096);
  if (/\.(node|so)$/i.test(p)) fail('test_native_binary_forbidden');
  if (/(^|\/)package\.json$/.test(p)) { const pkg=parse(b,4096); if (pkg.scripts && Object.keys(pkg.scripts).length) fail('test_native_scripts_forbidden'); }
  if (/\.js$/.test(p)) {
    // The host parser catches syntax errors but is newer than the robot.
    // Install always performs the independent Node 6 parser check on Jibo.
    try { new Script(b.toString('utf8'),{filename:p}); } catch { fail('test_native_syntax_invalid'); }
    if(syntaxNode) {
      if(!isAbsolute(syntaxNode))fail('invalid_syntax_runtime');
      // This child compiles stdin with vm.Script. It never evaluates the skill.
      const code='if(process.version!=="v6.5.0")process.exit(42);process.stdout.write("node-6.5-parser\\n");new(require("vm").Script)(require("fs").readFileSync(0,"utf8"));';
      const result=spawnSync(syntaxNode,['--max-old-space-size=192','-e',code],{input:b,timeout:10000,maxBuffer:16384,encoding:'utf8',shell:false});
      if(result.error||result.status===42||result.stdout!=='node-6.5-parser\n')fail('invalid_syntax_runtime');
      if(result.status!==0)fail('test_native_syntax_invalid');
    }
  }
}
function field(h,start,len) {
  const b=h.subarray(start,start+len),zero=b.indexOf(0);
  if (zero >= 0 && b.subarray(zero).some(x => x !== 0)) fail('test_tar_invalid');
  return b.subarray(0,zero < 0 ? b.length : zero).toString('utf8');
}
function octal(h,start,len) { const s=h.subarray(start,start+len).toString('ascii').replace(/\0.*$/,'').trim(); if (!/^[0-7]+$/.test(s)) fail('test_tar_invalid'); return parseInt(s,8); }
function oneGzip(art) {
  if(art.length<18||art[0]!==31||art[1]!==139||art[2]!==8||(art[3]&0xe0))fail('test_decode_limit');
  let at=10;const flags=art[3];
  if(flags&4){if(at+2>art.length)fail('test_decode_limit');const n=art.readUInt16LE(at);at+=2+n;}
  for(const flag of [8,16])if(flags&flag){while(at<art.length&&art[at]!==0)at++;at++;}
  if(flags&2)at+=2;
  if(at>art.length-8)fail('test_decode_limit');
  const d=inflateRawSync(art.subarray(at),{maxOutputLength:142606336,info:true});
  if(at+d.engine.bytesWritten+8!==art.length)fail('test_compressed_trailing');
  // Validate the gzip trailer, header CRC and stream checksum too.
  return gunzipSync(art,{maxOutputLength:142606336});
}
// Every skill pack is a native test container; `kind` is kept for callers.
export function inspectPack(bytes,kind,syntaxNode) {
  if (bytes.length < 13 || bytes.length > 33603596 || bytes.toString('ascii',0,8) !== 'PHXNAT1\n') fail('test_native_container_invalid');
  const size=bytes.readUInt32BE(8);
  if (size < 1 || size > 49152 || size+12 >= bytes.length) fail('test_native_metadata_invalid');
  const mb=bytes.subarray(12,12+size),m=parse(mb,4096); nativeMeta(m);
  if (!Buffer.from(canonical(m)).equals(mb)) fail('test_native_metadata_invalid');
  const art=bytes.subarray(12+size); if (art.length > 33554432) fail('native_descriptor_invalid');
  let raw;
  try { raw=oneGzip(art); } catch(e) { if(e.code==='test_compressed_trailing') throw e; fail('test_decode_limit'); }
  const seen=new Set(),expected=new Map(m.fileManifest.map(e => [e.path,e])); let at=0,zeros=0;
  while (at+512 <= raw.length) {
    const h=raw.subarray(at,at+512); at+=512;
    if (h.every(x => !x)) { zeros++; continue; }
    if (zeros) fail('test_tar_trailing');
    let sum=0; for(let i=0;i<512;i++) sum+=i>=148&&i<156?32:h[i];
    if (sum !== octal(h,148,8) || h.toString('ascii',257,263) !== 'ustar\0' || ![0,48].includes(h[156])) fail('test_tar_invalid');
    const prefix=field(h,345,155),name=(prefix?prefix+'/':'')+field(h,0,100),len=octal(h,124,12),e=expected.get(name);
    if (!validPath(name) || seen.has(name) || !e || e.length !== len || e.mode !== octal(h,100,8) || at+len > raw.length) fail('test_tar_manifest_mismatch');
    if (field(h,157,100)) fail('test_tar_invalid');
    const b=raw.subarray(at,at+len); if (hash(b) !== e.sha256) fail('test_tar_digest_invalid'); nativeFile(name,b,syntaxNode);
    if(m.schema===2&&name==='app.json'){const app=parse(b,4096);if(b.toString()!==canonical(app)||canonical([app.iconApi,app.icon,app.iconImage])!==canonical([m.iconApi,m.icon,m.iconImage]))fail('native_icon_package_mismatch');}
    if(m.schema===2&&m.icon?.type==='image'&&name==='assets/app-icon.png')inspectIcon(b,m.iconImage);
    const next=at+Math.ceil(len/512)*512; if (raw.subarray(at+len,next).some(x => x !== 0)) fail('test_tar_invalid');
    at=next; seen.add(name);
  }
  if (at !== raw.length || zeros < 2 || seen.size !== m.fileManifest.length) fail('test_tar_invalid');
  return {kind:'native',appId:m.appId,version:m.version,nativeSchema:m.schema,sha256:hash(bytes),bytes:bytes.length};
}
