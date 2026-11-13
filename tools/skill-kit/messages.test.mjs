import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,readFileSync,existsSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {scaffold} from './new.mjs';
const id='12345678-1234-4234-8234-123456789abc';
// Replace only the SSH child; execute the real CLI and its output handler offline.
function cliFixture(fn) {
 const base=mkdtempSync(join(tmpdir(),'skill-messages-'));
 try {
  const dir=scaffold('hello','hello',base).directory,log=join(base,'calls.jsonl'),preload=join(base,'ssh.cjs');
  writeFileSync(preload,`const cp=require('node:child_process'),{EventEmitter}=require('node:events'),{PassThrough}=require('node:stream'),fs=require('node:fs');
const f=JSON.parse(process.env.SKILL_MESSAGE_FIXTURE);
cp.spawn=(command,args)=>{
 if(command!=='ssh')throw Error('unexpected subprocess');
 const op=args.at(-1).match(/phoenix-test-cli\\.js' '([^']+)'/)[1];fs.appendFileSync(f.log,JSON.stringify(op)+'\\n');
 const c=new EventEmitter();c.stdin=new PassThrough();c.stdout=new PassThrough();c.stderr=new PassThrough();c.kill=()=>{};
 c.stdin.resume();c.stdin.on('finish',()=>{
 let result;
 if(op==='info')result={protocol:1,managerReady:true,beRoot:'/opt/jibo/Jibo/Skills/@be/be',runtimeNode:'/usr/bin/node',stateRoot:'/opt/home/jibo-skill/.local/share/phoenix/test-builds',localKinds:['native'],allowTestBuilds:f.allow!==false,...(f.schemas?{nativeContainerSchemas:f.schemas}:{}),limits:{maxArtifactBytes:33603596}};
 if(op==='create-project')result={projectId:'local-project-${id}',appId:'app-${id}',kind:'native'};
 if(op==='check')result={checked:true};
 if(op==='queue'||op==='remove')result={requestId:'${id}',kind:'native',...(f.initial||f.status)};
 if(op==='status')result={requestId:'${id}',kind:'native',...f.status};
 c.stdout.end(JSON.stringify({ok:true,result}));setImmediate(()=>c.emit('close',0));
 });return c;
};require('node:module').syncBuiltinESMExports();`);
  const invoke=(fixture={},args=['install',dir])=>{
   const r=spawnSync(process.execPath,['--require',preload,new URL('./cli.mjs',import.meta.url).pathname,...args,'--robot','robot.example','--timeout','1'],{encoding:'utf8',timeout:10000,env:{...process.env,SKILL_MESSAGE_FIXTURE:JSON.stringify({log,status:{state:'installed',runtimeState:'running'},...fixture})}});
   assert.ifError(r.error);return r;
  };
  const calls=()=>existsSync(log)?readFileSync(log,'utf8').trim().split('\n').map(JSON.parse):[];
  fn({dir,invoke,calls,base});
 }finally{rmSync(base,{recursive:true,force:true});}
}
for(const code of ['test_native_collision','test_identity_collision'])test(`failed ${code} names the installed app before code and request ID`,()=>cliFixture(({invoke})=>{
 const r=invoke({status:{state:'failed',blockedReason:code,collisionName:'Installed Store Sample',message:'UNTRUSTED ROBOT ERROR'}});
 assert.equal(r.status,1);assert.equal(r.stdout,'');
 assert.ok(r.stderr.includes(`Remove “Installed Store Sample” first, then try again.\nSkill request failed: ${code} (request ${id})\n`),r.stderr);
 assert.ok(!r.stderr.includes('UNTRUSTED ROBOT ERROR'));
}));
for(const name of [undefined,'','   ','bad\nname','bad\x1b[31m','bad\x7fname','bad\u202ename','x'.repeat(121),{name:'object'}])test(`collision refuses unsafe name ${JSON.stringify(name)}`,()=>cliFixture(({invoke})=>{
 const r=invoke({status:{state:'failed',blockedReason:'test_native_collision',collisionName:name,message:'UNTRUSTED ROBOT ERROR'}});
 assert.equal(r.status,1);assert.ok(!r.stderr.includes('Remove “'));assert.ok(!r.stderr.includes('UNTRUSTED ROBOT ERROR'));
}));
const allowInstruction='Allow test builds is off on Jibo; on Jibo open Settings > Developer testing, turn on Allow test builds and confirm with a tap, then run the command again.';
for(const existing of [false,true])test(`Allow off refuses install before allocation or upload (${existing?'saved project update':'new project'})`,()=>cliFixture(({dir,invoke,calls})=>{
 if(existing)assert.equal(invoke().status,0);
 const folder=join(dir,'.skill-kit'),before=existing?Object.fromEntries(readdirSync(folder).map(f=>[f,readFileSync(join(folder,f),'utf8')])):null,start=calls().length;
 const r=invoke({allow:false});
 assert.equal(r.status,1);assert.ok(r.stderr.includes(allowInstruction),r.stderr);
 assert.deepEqual(calls().slice(start),['info']);assert.ok(!r.stderr.includes('Tap Install'));
 if(existing)assert.deepEqual(Object.fromEntries(readdirSync(folder).map(f=>[f,readFileSync(join(folder,f),'utf8')])),before);
 else assert.equal(existsSync(folder),false);
}));
for(const later of [false,true])test(`Allow off queued request stops waiting with retention and cancellation guidance (${later?'status poll':'queue reply'})`,()=>cliFixture(({invoke})=>{
 const r=invoke({initial:later?{state:'pending_robot_approval'}:undefined,status:{state:'queued',blockedReason:'test_builds_disabled'}});
 assert.equal(r.status,1);assert.ok(r.stderr.includes(allowInstruction),r.stderr);
 assert.ok(!r.stderr.includes('approval_timeout'));assert.ok(r.stderr.includes('request stays on Jibo until Allow is on'));
 assert.ok(r.stderr.includes('cancelled if Jibo restarts'));
 assert.ok(r.stderr.includes(`node tools/skill-kit/ssh.mjs cancel --robot robot.example --request ${id}`),r.stderr);
 if(!later)assert.ok(!r.stderr.includes('Tap Install'));
}));
test('removal still works with Allow off',()=>cliFixture(({dir,invoke,calls})=>{
 assert.equal(invoke().status,0);const start=calls().length;
 const r=invoke({allow:false,status:{state:'removed'}},['remove',dir,'--keep-data']);
 assert.equal(r.status,0,r.stderr);assert.ok(calls().slice(start).includes('remove'));assert.ok(!r.stderr.includes(allowInstruction));
}));
for(const existing of [false,true])test(`declared icon older-firmware CLI refusal is useful and info-only (${existing?'saved':'new'} project)`,()=>cliFixture(({dir,invoke,calls})=>{
 if(existing)assert.equal(invoke().status,0);
 const app=JSON.parse(readFileSync(join(dir,'app.json'),'utf8'));Object.assign(app,{iconApi:1,icon:null,iconImage:null});writeFileSync(join(dir,'app.json'),JSON.stringify(app));
 const folder=join(dir,'.skill-kit'),before=existing?Object.fromEntries(readdirSync(folder).map(f=>[f,readFileSync(join(folder,f),'utf8')])):null,start=calls().length;
 const refused=invoke();assert.equal(refused.status,1);assert.equal(refused.stdout,'');assert.match(refused.stderr,/Update Jibo/);assert.match(refused.stderr,/nativeContainerSchemas/);assert.match(refused.stderr,/will not silently discard artwork/);assert.ok(refused.stderr.indexOf('Update Jibo')<refused.stderr.indexOf('Skill request failed: unsupported_native_icons'));assert.deepEqual(calls().slice(start),['info']);assert.ok(!refused.stderr.includes('Tap Install'));
 if(existing)assert.deepEqual(Object.fromEntries(readdirSync(folder).map(f=>[f,readFileSync(join(folder,f),'utf8')])),before);else assert.equal(existsSync(folder),false);
 assert.equal(invoke({schemas:[1,2]}).status,0);
}));
test('unrelated robot failure cannot supply an owner-facing collision message',()=>cliFixture(({invoke})=>{
 const r=invoke({status:{state:'failed',blockedReason:'test_other_failure',collisionName:'Installed Store Sample',message:'UNTRUSTED ROBOT ERROR'}});
 assert.equal(r.status,1);assert.ok(!r.stderr.includes('Remove “'));assert.ok(!r.stderr.includes('UNTRUSTED ROBOT ERROR'));
}));

for(const state of ['installed','resumed'])for(const runtimeState of ['disabled','paused'])test(`executable CLI ${state}/${runtimeState} exits nonzero with useful guidance and no success JSON`,()=>cliFixture(({invoke,calls})=>{
 const paused=runtimeState==='paused',code=paused?'test_builds_disabled':'test_native_collision';
 const r=invoke({status:{state,runtimeState,errorCode:code,collisionName:'Installed Store Sample',message:'UNTRUSTED ROBOT ERROR'}});
 assert.equal(r.status,1,r.stdout);assert.equal(r.stdout,'');
 assert.match(r.stderr,/not running/);assert.ok(!r.stderr.includes('Tap Install'));
 const guidance=paused?allowInstruction:'Remove “Installed Store Sample” first, then try again.';
 assert.ok(r.stderr.includes(guidance),r.stderr);
 assert.ok(r.stderr.indexOf(guidance)<r.stderr.indexOf('Skill request failed: '+code),r.stderr);
 assert.ok(r.stderr.includes(`Skill request failed: ${code} (request ${id})`));
 assert.ok(!r.stderr.includes('UNTRUSTED ROBOT ERROR'));
 assert.deepEqual(calls(),['info','info','create-project','info','check','info','queue']);
}));
