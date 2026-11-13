// Install admission on Node 6.9.2. All packages, keys and versions here are synthetic.
// Optional private stock inputs exercise the SAME tests through the hash-pinned Jibo
// apply-update.js and its real WorkState; never copy those files into this repository.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, createSign } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { signRow } from '../../packages/ota/src/releaseSignature.js';

const BAKER = new URL('./bake_jibo_io_native_image.py', import.meta.url).pathname;
const NODE = process.env.PHOENIX_TEST_NODE6 || process.execPath;
const STOCK = process.env.PHOENIX_TEST_STOCK_OTA_APPLIER;
const WORK_STATE = process.env.PHOENIX_TEST_STOCK_OTA_WORK_STATE;
const KEY_ID = 'phoenix-ota-dependency-test';
const SUFFIX = '.phoenix-signature.json';
let root, privateKey, publicKey, serial = 0;
const variants = ['fixture', ...(STOCK ? ['stock'] : [])];
const digest = (alg, b) => createHash(alg).update(b).digest('hex');
function write(file, data, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data, mode ? { mode } : undefined);
}
function python(code, input) {
  const r = spawnSync('python3', ['-c', code, BAKER], { input: JSON.stringify(input), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}
const MINIMIST = `module.exports = function(args) {
  var o = {}; for (var i=0; i<args.length; ++i) {
    var k=args[i].slice(2), v=args[i+1];
    if (v === undefined || v.indexOf('--') === 0) v=true; else ++i;
    if (o[k] === undefined) o[k]=v; else if (Array.isArray(o[k])) o[k].push(v); else o[k]=[o[k],v];
  } return o;
};`;
// A Phoenix-authored orchestration fixture, not vendor source. Its anchors and
// WorkState calls mirror the real entry point; the optional stock variant pins them.
const APPLIER = `#!/usr/bin/env node
'use strict';
const fs = require('fs');
const parseArgs = require('minimist');
const common = require('./apply_common');
const syslog = common.syslog();
const work_state = common.work_state();
let args=process.argv.slice(2), argopts={};
let argv = parseArgs(args, argopts);
if (!argv.continue) {
    const fields=['source','subsystem','from','to','destination','filter'];
    const list=Array.isArray(argv.source)?argv.source:[argv.source];
    list.forEach(function(_, i) { const ws={step:null}; fields.forEach(function(k) {
      ws[k]=Array.isArray(argv[k])?argv[k][i]:argv[k];
    }); work_state.addItem(ws); });
    // save and reboot to actually start
    work_state.saveSync(common.work_state_file);
    common.reboot(function() {});
} else {
    work_state.loadSync(common.work_state_file);
    function do_work() {
        const ws=work_state.current();
        if (ws === null) return;
        syslog.info("Continue: source=%s, subsystem=%s, step=%s",
                ws.source, ws.subsystem, ws.step);
        require('./apply_skill').execute(ws.step, work_state, {});
    }
    common.setNextFunction(do_work);
    do_work();
}
`;
const STATE = `const fs=require('fs'); function WorkState() { this.idx=null; this.items=[]; }
WorkState.prototype.addItem=function(ws) { this.items.push(ws); if(this.idx===null) this.idx=0; };
WorkState.prototype.current=function() { return this.idx===null?null:this.items[this.idx]; };
WorkState.prototype.finishCurrent=function() { ++this.idx; if(this.idx>=this.items.length) this.idx=null; };
WorkState.prototype.loadSync=function(f) { var s=JSON.parse(fs.readFileSync(f)); this.idx=s.idx; this.items=s.items; };
WorkState.prototype.saveSync=function(f) { fs.writeFileSync(f,JSON.stringify(this)); };
WorkState.prototype.save=function(f,cb) { this.saveSync(f); cb(null); };
module.exports.WorkState=WorkState;`;
// Only device/UI/reboot/subsystem boundaries are replaced. The guard, real signed
// envelopes, byte hashes, version commands, JSON files, work state and tar are real.
const COMMON = `const fs=require('fs'), cp=require('child_process'), path=require('path');
const root=path.dirname(__dirname), state=new (require('./work_state').WorkState)();
var next=function(){};
var logger={}; ['error','info','debug'].forEach(function(level) { logger[level]=function() {
 fs.appendFileSync(root+'/syslog', level+' '+require('util').format.apply(null,arguments)+'\\n'); }; });
module.exports={ work_state:function(){return state;}, syslog:function(){return logger;},
 work_state_file:root+'/ota.json', fileSize:function(f){return fs.statSync(f).size;},
 reboot:function(cb){fs.appendFileSync(root+'/reboot','reboot\\n');cb();},
 setNextFunction:function(f){next=f;},
 getAvailableUpdate:function(subsystem,from,filter,cb){cb({},process.env.PHOENIX_TEST_RETRY_SOURCE);},
 unpackUpdate:function(dir,tar,cb) { fs.appendFileSync(root+'/unpack','unpack\\n');
  fs.mkdirSync(dir); cp.execFileSync('tar',['-xf',tar,'-C',dir]); cb(dir); },
 next:function(){state.finishCurrent();state.saveSync(root+'/ota.json');if(state.current()!==null)next();}
};`;
const SUBSYSTEM = `const fs=require('fs'), path=require('path'), cp=require('child_process');
const common=require('./apply_common'), root=path.dirname(__dirname);
module.exports={handlesSubsystem:function(){return true;}, execute:function(step,state,gui) {
 const ws=state.current(); fs.appendFileSync(root+'/execute',ws.subsystem+'\\n');
 if(step==='verify') { common.next(); return; }
 function install(src) {
 ws.step='init'; state.saveSync(root+'/ota.json');
 common.unpackUpdate(root+'/extract-'+state.idx,src,function(dir) {
   cp.execFileSync('sh',[dir+'/preinstall',root+'/hook']);
   if(ws.subsystem==='os'||ws.subsystem==='services') fs.writeFileSync(root+'/'+ws.subsystem+'.version',ws.to);
   else { var p=root+'/skills/'+ws.subsystem; cp.execFileSync('mkdir',['-p',p]);
     fs.writeFileSync(p+'/package.json',JSON.stringify({version:ws.to})); }
   fs.appendFileSync(root+'/installed',ws.subsystem+' '+ws.to+'\\n'); common.next();
 }); }
 if(step==='retry') common.getAvailableUpdate(ws.subsystem,ws.from,ws.filter,function(update,tar){install(tar);});
 else install(ws.source);
}};`;

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'phoenix-ota-dependencies-'));
  ({ privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 3072 }));
  write(path.join(root, 'key.pub.pem'), publicKey.export({ type: 'spki', format: 'pem' }));
});
after(() => fs.rmSync(root, { recursive: true, force: true }));

function fixture(variant) {
  const dir = path.join(root, String(++serial));
  fs.mkdirSync(dir);
  for (const [name, version] of [['os', '13.0.8'], ['services', '13.0.8']]) {
    write(path.join(dir, name + '.version'), version);
    write(path.join(dir, name + '-version'), `#!/bin/sh\nprintf 'Version: '; cat '${dir}/${name}.version'\n`, 0o755);
  }
  write(path.join(dir, 'skills/@be/be/package.json'), JSON.stringify({ version: '13.9.0-dev.3' }));
  const sources = { versionCommands: Object.fromEntries(['os', 'services'].map(name => [name, {
    command: path.join(dir, name + '-version'), pattern: '^Version: ([^\\s]+)',
  }])), skillsRoot: path.join(dir, 'skills') };
  const original = variant === 'stock' ? fs.readFileSync(STOCK, 'utf8') : APPLIER;
  // Baseline has no applier transform: run its unchanged entry point so RED is
  // the missing dependency refusal, not a missing Python symbol/import error.
  const rendered = python(`import importlib.util,json,sys
s=importlib.util.spec_from_file_location('b',sys.argv[1]);b=importlib.util.module_from_spec(s);s.loader.exec_module(b)
r=json.load(sys.stdin); source=r['source']
if hasattr(b,'render_ota_applier'):
 if r['pinned']: source=b.stock_ota_applier(source)
 source=b.render_ota_applier(source,b.ota_gate_config(b.load_ota_release_pubkeys(r['keys']),r['sources']))
sys.stdout.write(source)
`, { source: original, pinned: variant === 'stock', sources, keys: [`${KEY_ID}=${path.join(root, 'key.pub.pem')}`] });
  write(path.join(dir, 'src/apply-update.js'), rendered);
  write(path.join(dir, 'src/work_state.js'), variant === 'stock' && WORK_STATE ? fs.readFileSync(WORK_STATE) : STATE);
  write(path.join(dir, 'src/apply_common.js'), COMMON);
  write(path.join(dir, 'src/node_modules/minimist/index.js'), MINIMIST);
  write(path.join(dir, 'src/node_modules/daemon/index.js'), 'module.exports=function(){};');
  write(path.join(dir, 'src/gui.js'), 'module.exports=function(){};');
  for (const name of ['skill', 'os', 'services', 'bootloader']) write(path.join(dir, 'src/apply_' + name + '.js'), SUBSYSTEM);
  return { dir, script: path.join(dir, 'src/apply-update.js'), sources, original };
}
function release(f, { subsystem = '@be/be', to = '13.9.0', dependencies = { os: '13.0.9' }, from = '*', filter = 'fcs' } = {}) {
  const source = path.join(f.dir, 'cache', `${to}-${subsystem}.tar`);
  const input = path.join(f.dir, 'input-' + ++serial);
  write(path.join(input, 'preinstall'), '#!/bin/sh\nprintf hook >> "$1"\n', 0o755);
  fs.mkdirSync(path.dirname(source), { recursive: true });
  const tar = spawnSync('tar', ['-cf', source, '-C', input, '.']);
  assert.equal(tar.status, 0);
  const body = fs.readFileSync(source);
  const row = { id: 'test-' + serial, subsystem, fromVersion: from, toVersion: to, filter, dependencies };
  const sig = signRow(row, { length: body.length, sha256: digest('sha256', body), sha1: digest('sha1', body) }, { keyId: KEY_ID, privateKey });
  write(source + SUFFIX, JSON.stringify(sig), 0o600);
  return { source, subsystem, from: subsystem === '@be/be' ? '13.9.0-dev.3' : '13.0.8', to,
    destination: path.join(f.dir, 'skills', subsystem), filter: 'fcs', step: null, sig };
}
function run(f, items, { continuation = false, idx = 0, env = {} } = {}) {
  let args;
  if (continuation) {
    write(path.join(f.dir, 'ota.json'), JSON.stringify({ idx, items }));
    args = ['--continue'];
  } else args = items.flatMap(ws => ['source', 'subsystem', 'from', 'to', 'destination', 'filter'].flatMap(k => ['--' + k, ws[k]]));
  const r = spawnSync(NODE, [f.script, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
  return { ...r, log: fs.existsSync(path.join(f.dir, 'syslog')) ? fs.readFileSync(path.join(f.dir, 'syslog'), 'utf8') : '' };
}
function snapshot(f) {
  const out = {};
  function walk(dir) { for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p=path.join(dir,e.name); if(e.isDirectory()) walk(p);
    else if(e.name!=='syslog') {
      const s=fs.lstatSync(p);
      out[path.relative(f.dir,p)]={mode:s.mode,nlink:s.nlink,
        content:e.isSymbolicLink()?fs.readlinkSync(p):digest('sha256',fs.readFileSync(p))};
    }
  } } walk(f.dir); return out;
}
function refused(f, r, reason, before) {
  assert.notEqual(r.status, 0, `expected dependency refusal, got success: ${r.stdout} ${r.stderr}`);
  assert.match(r.log, /Phoenix OTA apply gate refused /);
  assert.match(r.log, reason);
  if (before) assert.deepEqual(snapshot(f), before, 'no package, installed file, work state, reboot, hook or subsystem write');
  for (const name of ['reboot', 'execute', 'unpack', 'hook', 'installed']) assert.equal(fs.existsSync(path.join(f.dir,name)),false,name+' untouched');
}
const each = (name, fn) => test(name, async t => {
  for (const v of variants) await t.test(v, () => fn(fixture(v)));
});

test('dependency tests use the requested robot runtime', () => {
  if (process.env.PHOENIX_TEST_NODE6) assert.equal(spawnSync(NODE, ['-v'], { encoding: 'utf8' }).stdout.trim(), 'v6.9.2');
});
each('missing signed dependency is refused before work state or reboot', f => {
  const ws = release(f); const before=snapshot(f);
  refused(f,run(f,[ws]),/dependency os requires 13\.0\.9.*13\.0\.8/,before);
});
each('an installed exact dependency permits the package to apply', f => {
  const ws=release(f,{dependencies:{os:'13.0.8'}});
  const r=run(f,[ws],{continuation:true});
  assert.equal(r.status,0,r.stderr+' '+r.log);
  assert.equal(fs.readFileSync(path.join(f.dir,'hook'),'utf8'),'hook');
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir,'skills/@be/be/package.json'))).version,'13.9.0');
});

each('an earlier signed package satisfies the next dependency in the same ordered update', f => {
  const os=release(f,{subsystem:'os',to:'13.0.9',dependencies:{}}), be=release(f);
  const r=run(f,[os,be]);
  assert.equal(r.status,0,r.stderr+' '+r.log);
  assert.equal(fs.readFileSync(path.join(f.dir,'reboot'),'utf8'),'reboot\n');
  const saved=JSON.parse(fs.readFileSync(path.join(f.dir,'ota.json')));
  const applied=run(f,saved.items,{continuation:true});
  assert.equal(applied.status,0,applied.stderr+' '+applied.log);
  assert.equal(fs.readFileSync(path.join(f.dir,'installed'),'utf8'),'os 13.0.9\n@be/be 13.9.0\n');
});
each('a later package is not credited as an installed dependency', f => {
  const os=release(f,{subsystem:'os',to:'13.0.9',dependencies:{}}), be=release(f), before=snapshot(f);
  refused(f,run(f,[be,os]),/dependency os requires/,before);
});
each('a package cannot satisfy its own dependency with its incoming version', f => {
  const ws=release(f,{dependencies:{'@be/be':'13.9.0'}}), before=snapshot(f);
  refused(f,run(f,[ws]),/dependency @be\/be requires/,before);
});
each('an earlier replacement takes precedence over the previously installed version', f => {
  const os=release(f,{subsystem:'os',to:'13.0.9',dependencies:{}});
  const be=release(f,{dependencies:{os:'13.0.8'}}), before=snapshot(f);
  refused(f,run(f,[os,be]),/dependency os requires 13\.0\.8.*13\.0\.9/,before);
});
each('dependencies are exact versions, not minimum versions', f => {
  const ws=release(f,{dependencies:{os:'13.0.7'}}), before=snapshot(f);
  refused(f,run(f,[ws]),/dependency os requires 13\.0\.7.*13\.0\.8/,before);
});
each('a genuinely absent skill dependency is refused even if it names version zero', f => {
  const ws=release(f,{dependencies:{'support-skill':'0.0.0'}}), before=snapshot(f);
  refused(f,run(f,[ws]),/dependency support-skill is not installed/,before);
});
each('an earlier new skill can satisfy a signed skill dependency', f => {
  const support=release(f,{subsystem:'support-skill',to:'1.0.0',dependencies:{}});
  const ws=release(f,{dependencies:{'support-skill':'1.0.0'}});
  const r=run(f,[support,ws]);
  assert.equal(r.status,0,r.stderr+' '+r.log);
});
each('resume refuses an unmet dependency without trusting earlier unsigned work-state versions', f => {
  const os=release(f,{subsystem:'os',to:'13.0.9',dependencies:{}}), be=release(f);
  // The journal says item zero finished, but its installed version did not change.
  write(path.join(f.dir,'ota.json'),JSON.stringify({idx:1,items:[os,be]}));
  const before=snapshot(f);
  refused(f,run(f,[os,be],{continuation:true,idx:1}),/dependency os requires/,before);
});
each('changing an installed dependency after preflight is caught before apply', f => {
  const ws=release(f,{dependencies:{os:'13.0.8'}});
  assert.equal(run(f,[ws]).status,0);
  const saved=JSON.parse(fs.readFileSync(path.join(f.dir,'ota.json'))).items;
  fs.rmSync(path.join(f.dir,'reboot'));
  write(path.join(f.dir,'os.version'),'13.0.7'); const before=snapshot(f);
  refused(f,run(f,saved,{continuation:true}),/dependency os requires/,before);
});
each('a missing signed receipt refuses an otherwise valid cached package', f => {
  const ws=release(f,{dependencies:{}}); fs.rmSync(ws.source+SUFFIX); const before=snapshot(f);
  refused(f,run(f,[ws]),/ENOENT/,before);
});
each('stripping dependencies from the cached signed payload cannot bypass admission', f => {
  const ws=release(f), sig={...ws.sig,payload:ws.sig.payload.replace('"os":"13.0.9"','"os":"13.0.8"')};
  write(ws.source+SUFFIX,JSON.stringify(sig)); const before=snapshot(f);
  refused(f,run(f,[ws]),/bad signature receipt/,before);
});
each('cached bytes are rechecked before install even with an authentic receipt', f => {
  const ws=release(f,{dependencies:{os:'13.0.8'}}), bytes=fs.readFileSync(ws.source); bytes[777]^=1;
  write(ws.source,bytes); const before=snapshot(f);
  refused(f,run(f,[ws]),/cached package bytes differ/,before);
});
each('a signature for another work-item target is refused', f => {
  const ws=release(f,{dependencies:{}}); ws.to='13.10.0'; const before=snapshot(f);
  refused(f,run(f,[ws]),/signed item identity differs/,before);
});
each('the signed filter uses the same prefix matching as the catalog', f => {
  const ws=release(f,{dependencies:{},filter:'fcs/ring'});
  const r=run(f,[ws]); assert.equal(r.status,0,r.stderr+' '+r.log);
});
each('a filterless request is not a wildcard for a signed filtered package', f => {
  const ws=release(f,{dependencies:{}}); ws.filter=''; const before=snapshot(f);
  refused(f,run(f,[ws]),/signed filter differs/,before);
});
function resign(ws, change) {
  const st=JSON.parse(ws.sig.payload); change(st);
  const payload=JSON.stringify(st), signature=createSign('RSA-SHA256').update(payload).sign(privateKey,'base64');
  write(ws.source+SUFFIX,JSON.stringify({...ws.sig,payload,signature}));
}
for (const [name,dependencies] of [['missing',undefined],['null',null],['array',[]],['non-string',{os:13}],
  ['wildcard',{os:'*'}],['unsafe path',{'../os':'13.0.8'}]]) {
  each(`malformed signed dependencies fail closed: ${name}`, f => {
    const ws=release(f,{dependencies:{}}); resign(ws,st=>{st.dependencies=dependencies;}); const before=snapshot(f);
    refused(f,run(f,[ws]),/malformed signed dependenc/,before);
  });
}
each('a symlinked signature receipt is refused untouched', f => {
  const ws=release(f,{dependencies:{}}), receipt=ws.source+SUFFIX;
  fs.renameSync(receipt,receipt+'.original'); fs.symlinkSync(receipt+'.original',receipt); const before=snapshot(f);
  refused(f,run(f,[ws]),/not a single-link regular file/,before);
});
each('an OS verify step resumes after the cache tar is consumed', f => {
  const ws=release(f,{subsystem:'os',to:'13.0.9',dependencies:{}}); ws.step='verify';
  fs.rmSync(ws.source); write(path.join(f.dir,'os.version'),'13.0.9');
  const r=run(f,[ws],{continuation:true}); assert.equal(r.status,0,r.stderr+' '+r.log);
  assert.equal(fs.readFileSync(path.join(f.dir,'execute'),'utf8'),'os\n');
  assert.equal(fs.existsSync(path.join(f.dir,'unpack')),false);
});
each('OS verification preserves a dependency on its own starting version', f => {
  const ws=release(f,{subsystem:'os',to:'13.0.9',dependencies:{os:'13.0.8'}});
  const plan=run(f,[ws]); assert.equal(plan.status,0,plan.stderr+' '+plan.log);
  const items=JSON.parse(fs.readFileSync(path.join(f.dir,'ota.json'))).items;
  // The package changed its own version; its required starting version was present
  // when admitted. Verification must not demand undoing that successful update.
  items[0].step='verify'; write(path.join(f.dir,'os.version'),'13.0.9'); fs.rmSync(ws.source);
  const r=run(f,items,{continuation:true}); assert.equal(r.status,0,r.stderr+' '+r.log);
});

each('a fake verify step is refused if the signed target is not installed', f => {
  const ws=release(f,{subsystem:'os',to:'13.0.9',dependencies:{}}); ws.step='verify';
  write(path.join(f.dir,'ota.json'),JSON.stringify({idx:0,items:[ws]})); const before=snapshot(f);
  refused(f,run(f,[ws],{continuation:true}),/verify step does not match installed/,before);
});
each('OS verification still checks dependencies on other subsystems', f => {
  const ws=release(f,{subsystem:'os',to:'13.0.9',dependencies:{services:'13.0.9'}}); ws.step='verify';
  write(path.join(f.dir,'os.version'),'13.0.9');
  write(path.join(f.dir,'ota.json'),JSON.stringify({idx:0,items:[ws]})); const before=snapshot(f);
  refused(f,run(f,[ws],{continuation:true}),/dependency services requires/,before);
});
each('retry rechecks the actual downloaded package before unpack or hooks', f => {
  const ws=release(f,{dependencies:{os:'13.0.8'}}); ws.step='retry';
  const other=release({...f,dir:path.join(f.dir,'retry-cache')},{dependencies:{os:'13.0.9'}});
  fs.rmSync(ws.source); // stock retry legitimately no longer has its original tar
  const r=run(f,[ws],{continuation:true,env:{PHOENIX_TEST_RETRY_SOURCE:other.source}});
  assert.notEqual(r.status,0); assert.match(r.log,/dependency os requires/);
  assert.equal(fs.readFileSync(path.join(f.dir,'execute'),'utf8'),'@be/be\n','retry callback was reached');
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir,'ota.json'))).items[0].step,'retry',
    'retry must not rewrite the journal before rejecting new signed dependencies');
  for(const name of ['unpack','hook','installed','reboot']) assert.equal(fs.existsSync(path.join(f.dir,name)),false,name);
});
each('a retry with satisfied signed dependencies can unpack and install', f => {
  const ws=release(f,{dependencies:{os:'13.0.8'}}); ws.step='retry'; fs.rmSync(ws.source);
  const other=release({...f,dir:path.join(f.dir,'retry-cache')},{dependencies:{os:'13.0.8'}});
  const r=run(f,[ws],{continuation:true,env:{PHOENIX_TEST_RETRY_SOURCE:other.source}});
  assert.equal(r.status,0,r.stderr+' '+r.log);
  assert.equal(fs.readFileSync(path.join(f.dir,'hook'),'utf8'),'hook');
});
each('retry cannot silently substitute another signed target version', f => {
  const ws=release(f,{dependencies:{}}); ws.step='retry';
  const other=release({...f,dir:path.join(f.dir,'retry-cache')},{to:'13.10.0',dependencies:{}});
  const r=run(f,[ws],{continuation:true,env:{PHOENIX_TEST_RETRY_SOURCE:other.source}});
  assert.notEqual(r.status,0); assert.match(r.log,/signed item identity differs/);
  assert.equal(fs.existsSync(path.join(f.dir,'unpack')),false);
});
each('a receipt from an untrusted key is not accepted at apply time', f => {
  const ws=release(f,{dependencies:{}});
  write(ws.source+SUFFIX,JSON.stringify({...ws.sig,keyId:'unknown-key'})); const before=snapshot(f);
  refused(f,run(f,[ws]),/untrusted signature receipt/,before);
});
each('apply-time version and fromVersion checks cannot be skipped by a forged work item', f => {
  const ws=release(f,{dependencies:{},from:'13.8.0'}), before=snapshot(f);
  refused(f,run(f,[ws]),/signed starting version differs/,before);
});
each('a malformed installed dependency version is not accepted', f => {
  const ws=release(f,{dependencies:{os:'13.0.8'}});
  write(path.join(f.dir,'os.version'),'not-a-version'); const before=snapshot(f);
  refused(f,run(f,[ws]),/invalid installed version for os/,before);
});

test('the applier transform requires exact anchors and refuses already-patched source', () => {
  const result=JSON.parse(python(`import importlib.util,json,sys
s=importlib.util.spec_from_file_location('b',sys.argv[1]);b=importlib.util.module_from_spec(s);s.loader.exec_module(b)
r=json.load(sys.stdin);gate=b.ota_gate_config(b.load_ota_release_pubkeys(r['keys']))
out=[]
for source in (r['source'].replace('let argv = parseArgs(args, argopts);',''),
               r['source'].replace('    // save and reboot to actually start','    // changed'),
               r['source']+'\\n// phoenix-ota-apply-gate'):
 try: b.render_ota_applier(source,gate);out.append('UNSAFE ACCEPT')
 except (SystemExit,RuntimeError) as e: out.append(str(e))
out.append(b.render_ota_applier(r['source'],None)==r['source'])
json.dump(out,sys.stdout)
`,{source:APPLIER,keys:[`${KEY_ID}=${path.join(root,'key.pub.pem')}`]}));
  assert.equal(result.length,4); assert.ok(result.slice(0,3).every(v=>v!=='UNSAFE ACCEPT')); assert.equal(result[3],true);
});

const haveE2fs=['mke2fs','debugfs','e2fsck'].every(tool=>spawnSync('sh',['-c',`command -v ${tool}`]).status===0);
test('builder patches the real pinned installer inside ext4, keeps it executable and refuses an unknown source',
  {skip:!STOCK?'set PHOENIX_TEST_STOCK_OTA_APPLIER':!haveE2fs?'e2fsprogs missing':false},()=>{
    for(const changed of [false,true]) {
      const f=fixture('fixture'), tree=path.join(f.dir,'tree');
      const remote='/usr/lib/node_modules/@jibo/jibo-ota-updater/src/apply-update.js';
      const original=fs.readFileSync(STOCK,'utf8')+(changed?'\n// unreviewed change\n':'');
      write(path.join(tree,remote),original,0o755);
      const image=path.join(f.dir,'root.ext4');
      assert.equal(spawnSync('mke2fs',['-q','-t','ext4','-d',tree,image,'8M']).status,0);
      const result=JSON.parse(python(`import importlib.util,json,sys
from pathlib import Path
s=importlib.util.spec_from_file_location('b',sys.argv[1]);b=importlib.util.module_from_spec(s);s.loader.exec_module(b)
r=json.load(sys.stdin)
try: out=b.patch_ota_applier(Path(r['image']),b.load_ota_release_pubkeys(r['keys']))
except (RuntimeError,SystemExit) as e: out={'refused':str(e)}
json.dump(out,sys.stdout)
`,{image,keys:[`${KEY_ID}=${path.join(root,'key.pub.pem')}`]}));
      const dumped=path.join(f.dir,'dumped.js');
      assert.equal(spawnSync('debugfs',['-R',`dump ${remote} ${dumped}`,image]).status,0);
      if(changed) { assert.match(result.refused,/unexpected OTA applier source hash/); assert.equal(fs.readFileSync(dumped,'utf8'),original); }
      else {
        assert.equal(result.enabled,true); assert.equal(digest('sha256',fs.readFileSync(dumped)),result.patched_sha256);
        assert.equal(spawnSync(NODE,['--check',dumped]).status,0);
        const stat=spawnSync('debugfs',['-R',`stat ${remote}`,image],{encoding:'utf8'}).stdout;
        assert.match(stat,/Mode: +0755/);
      }
      assert.equal(spawnSync('e2fsck',['-fn',image]).status,0);
    }
  });

test('a stock download receipt drives actual apply admission, not unsigned catalog dependencies',
  {skip:process.env.PHOENIX_TEST_STOCK_OTA_DOWNLOADER?false:'set PHOENIX_TEST_STOCK_OTA_DOWNLOADER'},async t=>{
    for(const satisfied of [false,true]) await t.test(satisfied?'satisfied dependency applies':'stripped missing dependency refuses untouched',async()=>{
      const f=fixture(STOCK?'stock':'fixture');
      const ws=release(f,{dependencies:{os:satisfied?'13.0.8':'13.0.9'}});
      const body=fs.readFileSync(ws.source); fs.rmSync(ws.source); fs.rmSync(ws.source+SUFFIX);
      const rendered=python(`import importlib.util,json,sys
s=importlib.util.spec_from_file_location('b',sys.argv[1]);b=importlib.util.module_from_spec(s);s.loader.exec_module(b)
r=json.load(sys.stdin);source=b.stock_ota_downloader(open(r['source']).read())
sys.stdout.write(b.render_ota_downloader(source,b.ota_gate_config(b.load_ota_release_pubkeys(r['keys']),r['sources'])))
`,{source:process.env.PHOENIX_TEST_STOCK_OTA_DOWNLOADER,sources:f.sources,keys:[`${KEY_ID}=${path.join(root,'key.pub.pem')}`]});
      const downloader=path.join(f.dir,'src/download-update.js'); write(downloader,rendered);
      write(path.join(f.dir,'src/node_modules/modern-syslog/index.js'),
        'var l=require("../../apply_common").syslog();l.init=function(){};module.exports=l;');
      const server=http.createServer((req,res)=>{
        res.writeHead(200,{'content-length':body.length,'x-phoenix-ota-signature':Buffer.from(JSON.stringify(ws.sig)).toString('base64')});res.end(body);
      });
      await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
      try {
        const result=await new Promise((resolve,reject)=>{
          const child=spawn(NODE,[downloader,'--id',JSON.parse(ws.sig.payload).id,'--url',`http://127.0.0.1:${server.address().port}/package`,
            '--destination',ws.source,'--shasum',digest('sha1',body)]);
          let stdout='',stderr='';child.stdout.on('data',c=>stdout+=c);child.stderr.on('data',c=>stderr+=c);
          child.on('error',reject);child.on('close',status=>resolve({status,stdout,stderr}));
        });
        assert.equal(result.status,0,result.stderr+' '+result.stdout);
        assert.deepEqual(JSON.parse(fs.readFileSync(ws.source+SUFFIX)),ws.sig);
        // The compiled caller passes no dependency map: signed receipt is the authority.
        delete ws.dependencies;
        if(satisfied) {
          const r=run(f,[ws],{continuation:true});assert.equal(r.status,0,r.stderr+' '+r.log);
          assert.equal(fs.readFileSync(path.join(f.dir,'hook'),'utf8'),'hook');
        } else {
          const before=snapshot(f);refused(f,run(f,[ws]),/dependency os requires/,before);
        }
      } finally { await new Promise(resolve=>server.close(resolve)); }
    });
  });
