import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,readFileSync,symlinkSync,mkdirSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {scaffold} from './new.mjs';
import {checkProject,packProject,buildProject,tar} from './project.mjs';
import {canonical,inspectPack,hash} from './format.mjs';
import {run,argumentsFor} from './cli.mjs';
import {run as ssh,DEFAULTS,parseArgs} from './ssh.mjs';
const uuid='12345678-1234-4234-8234-123456789abc',projectId='local-project-'+uuid,appId='app-'+uuid;
function fixture(fn) { const base=mkdtempSync(join(tmpdir(),'skill-kit-')); return Promise.resolve().then(()=>fn(base)).finally(()=>rmSync(base,{recursive:true,force:true})); }
test('scaffold checks and packs deterministic bytes without executing it',()=>fixture(base=>{
  const dir=scaffold('hello-skill','hello',base).directory;
  const readme=readFileSync(join(dir,'README.md'),'utf8');
  assert.ok(!readme.includes('Approve tap'));
  assert.ok(readme.includes('Install full-access test'));
  assert.equal(checkProject(dir).kind,'native');
  const a=packProject(dir,join(base,'one')),b=packProject(dir,join(base,'two'));
  assert.equal(a.sha256,b.sha256);assert.equal(checkProject(a.file).appId,a.appId);
  assert.throws(()=>packProject(dir,join(base,'one')),e=>e.code==='EEXIST');
  assert.throws(()=>scaffold('hello-skill','hello',base),e=>e.code==='EEXIST');
}));
test('scaffold rejects paths and unknown templates before writing',()=>fixture(base=>{
  for(const name of ['../outside','with space','-bad','A'])assert.throws(()=>scaffold(name,'hello',base),/invalid_name/);
  for(const template of ['python','declarative','native','other'])assert.throws(()=>scaffold('test',template,base),/unknown_template/);
  assert.deepEqual(readdirSync(base),[]);
}));
test('native source links and path traversal are rejected',()=>fixture(base=>{
  const dir=scaffold('test','hello',base).directory;
  rmSync(join(dir,'hello.js'));symlinkSync('entry.js',join(dir,'hello.js'));
  assert.throws(()=>checkProject(dir),/invalid_source_path/);
  const c=JSON.parse(readFileSync(join(dir,'skill.json')));c.files.push('../outside');writeFileSync(join(dir,'skill.json'),JSON.stringify(c));
  assert.throws(()=>checkProject(dir));
}));
test('strict JSON rejects duplicate and prototype keys, malformed UTF-8',()=>fixture(base=>{
  const dir=scaffold('hello','hello',base).directory,file=join(dir,'app.json');
  for(const text of ['{"schema":1,"schema":1}','{"__proto__":{}}',Buffer.from([255])]){writeFileSync(file,text);assert.throws(()=>checkProject(dir),e=>/^theme_json_/.test(e.code));}
}));
test('only a native test container is accepted as a pack',()=>fixture(base=>{
  const file=join(base,'page.json');writeFileSync(file,'{"schema":1,"runtime":"phoenix-declarative-v1"}');
  assert.throws(()=>checkProject(file),/test_native_container_invalid/);
}));
test('native forbidden binaries, scripts, syntax and unlisted entry fail',()=>fixture(base=>{
  const dir=scaffold('hello','hello',base).directory,file=join(dir,'skill.json'),c=JSON.parse(readFileSync(file));
  writeFileSync(join(dir,'entry.js'),'this is not valid JavaScript !');assert.throws(()=>checkProject(dir),/test_native_syntax_invalid/);
  writeFileSync(join(dir,'entry.js'),'throw Error("must not run")');assert.doesNotThrow(()=>checkProject(dir));
  for(const [path,content,code] of [['bad.node','binary','test_native_binary_forbidden'],['package.json','{"scripts":{"install":"bad"}}','test_native_scripts_forbidden']]) {
    writeFileSync(join(dir,path),content);writeFileSync(file,JSON.stringify({...c,files:[...c.files,path]}));assert.throws(()=>checkProject(dir),e=>e.code===code);
  }
  writeFileSync(file,JSON.stringify({...c,files:c.files.filter(p=>p!=='entry.js')}));assert.throws(()=>checkProject(dir),/native_manifest_invalid/);
}));
test('native metadata and archive corruption are rejected',()=>fixture(base=>{
  const dir=scaffold('hello','hello',base).directory,good=buildProject(dir).bytes,n=good.readUInt32BE(8);
  const magic=Buffer.from(good);magic[0]=0;assert.throws(()=>inspectPack(magic,'native'),/test_native_container_invalid/);
  const length=Buffer.from(good);length.writeUInt32BE(999999,8);assert.throws(()=>inspectPack(length,'native'),/test_native_metadata_invalid/);
  const meta=JSON.parse(good.subarray(12,12+n));meta.hostAbi=2;const mb=Buffer.from(canonical(meta)),h=Buffer.from(good.subarray(0,12));h.writeUInt32BE(mb.length,8);
  assert.throws(()=>inspectPack(Buffer.concat([h,mb,good.subarray(12+n)]),'native'),/native_descriptor_invalid/);
  const corrupt=Buffer.from(good);corrupt[corrupt.length-5]^=255;assert.throws(()=>inspectPack(corrupt,'native'));
  assert.throws(()=>inspectPack(Buffer.concat([good,Buffer.from([0])]),'native'),/test_compressed_trailing/);
  assert.throws(()=>inspectPack(Buffer.concat([good,good.subarray(12+n)]),'native'),/test_compressed_trailing/);
}));
test('remote commands default fixed paths and refuse a mismatched info before project allocation',async()=>{
  assert.equal(parseArgs(['info','--robot','robot.example']).options.node,DEFAULTS.node);
  const calls=[];function spawn(command,args){calls.push(args);const c=new EventEmitter();c.stdin=new PassThrough();c.stdout=new PassThrough();c.stderr=new PassThrough();c.kill=()=>{};c.stdin.on('finish',()=>{c.stdout.end(JSON.stringify({ok:true,result:{protocol:1,managerReady:true,localKinds:['native'],beRoot:'/wrong',runtimeNode:DEFAULTS.node,stateRoot:DEFAULTS['state-root']}}));setImmediate(()=>c.emit('close',0));});return c;}
  await assert.rejects(ssh(['project','--robot','robot.example','--kind','native','--name','hello'],{spawn}),/robot_path_mismatch/);assert.equal(calls.length,1);
});
function fakeRemote(calls,terminal='installed') {return async args=>{
  calls.push(args);
  if(args[0]==='info')return {localKinds:['native']};
  if(args[0]==='project')return {projectId,appId,kind:args[args.indexOf('--kind')+1],name:'hello'};
  if(args[0]==='check')return {sha256:'checked'};
  if(args[0]==='queue'||args[0]==='remove')return {requestId:uuid,kind:'native',state:'pending_robot_approval'};
  if(args[0]==='status')return {requestId:uuid,kind:'native',state:terminal,...(terminal==='installed'?{runtimeState:'running'}:{})};
  throw Error('unexpected command');
};}
test('install allocates once, checks, packs with allocated identity, queues and reads terminal request',()=>fixture(async base=>{
  const dir=scaffold('hello','hello',base).directory,calls=[],lines=[];
  const deps={ssh:fakeRemote(calls),sleep:async()=>{},print:s=>lines.push(s)};
  const result=await run(['install',dir,'--robot','robot.example'],deps);assert.equal(result.state,'installed');
  assert.ok(lines.includes('Tap Install full-access test on Jibo'));assert.deepEqual(calls.map(c=>c[0]),['info','project','check','queue','status']);
  const firstId=calls.find(c=>c[0]==='queue').at(-1);calls.length=0;
  await run(['install',dir,'--robot','robot.example'],deps);assert.deepEqual(calls.map(c=>c[0]),['info','check','queue','status']);assert.equal(calls.find(c=>c[0]==='queue').at(-1),firstId);
  await run(['status',dir,'--robot','robot.example'],deps);
  calls.length=0;await run(['remove',dir,'--robot','robot.example','--keep-data'],{...deps,ssh:fakeRemote(calls,'removed')});
  assert.equal(calls[0][0],'remove');assert.ok(calls[0].includes('--keep-data'));assert.deepEqual(calls.map(c=>c[0]),['remove','status']);
  assert.ok(!calls.flat().includes('approve'));assert.ok(lines.includes('Tap Remove test build on Jibo'));
}));
test('install timeout includes the recoverable request ID and does not cancel or approve',()=>fixture(async base=>{
  const dir=scaffold('hello','hello',base).directory,calls=[];let time=0;
  await assert.rejects(run(['install',dir,'--robot','robot.example','--timeout','1'],{ssh:fakeRemote(calls,'pending_robot_approval'),now:()=>time,sleep:async ms=>{time+=ms;}}),e=>e.code==='approval_timeout'&&e.requestId===uuid);
  assert.ok(!calls.some(c=>['cancel','approve'].includes(c[0])));
}));
test('failed robot status is a failure, not transfer success',()=>fixture(async base=>{
  const dir=scaffold('hello','hello',base).directory;
  await assert.rejects(run(['install',dir,'--robot','robot.example'],{ssh:fakeRemote([],'failed'),sleep:async()=>{}}),/test_request_failed/);
}));
test('CLI rejects approval, duplicate flags, invalid identifiers and removal without an explicit data choice',()=>{
  for(const a of [['approve'],['install','hello','--robot','robot.example','--robot','another'],['remove','hello','--robot','robot.example'],['install','hello','--robot','-oops'],['install','hello','--robot','robot.example','--timeout','0']])assert.throws(()=>argumentsFor(a));
});
test('CLI help and invalid invocation execute offline',()=>{
  const cli=new URL('./cli.mjs',import.meta.url).pathname;
  const help=spawnSync(process.execPath,[cli,'--help'],{encoding:'utf8'});assert.equal(help.status,0);assert.match(help.stdout,/Confirm on Jibo/);
  const bad=spawnSync(process.execPath,[cli,'approve'],{encoding:'utf8'});assert.equal(bad.status,1);assert.match(bad.stderr,/unknown_command/);
});
