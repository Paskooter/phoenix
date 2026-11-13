import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,existsSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {scaffold} from './new.mjs';
import {run} from './cli.mjs';
import {DEFAULTS} from './ssh.mjs';
import {inspectPack,hash} from './format.mjs';
const id='12345678-1234-4234-8234-123456789abc',appId='app-'+id;
for(const existing of [false,true])test(`install refuses a Jibo that does not advertise native test builds before allocation or queueing (${existing?'saved project':'new project'})`,async()=>{
 const base=mkdtempSync(join(tmpdir(),'skill-kind-')),calls=[];
 try {
  const dir=scaffold('pages','hello',base).directory;
  if(existing){
   mkdirSync(join(dir,'.skill-kit'));
   const key=hash(JSON.stringify(['robot.example',DEFAULTS['be-root'],DEFAULTS.node,DEFAULTS['state-root']]));
   writeFileSync(join(dir,'.skill-kit',key+'.json'),JSON.stringify({project:{projectId:'local-project-'+id,appId,kind:'native'}}));
  }
  function spawn(command,args,options){
   assert.equal(command,'ssh');assert.equal(options.shell,false);
   const operation=args.at(-1).match(/phoenix-test-cli\.js' '([^']+)'/)[1];calls.push(operation);
   const c=new EventEmitter();c.stdin=new PassThrough();c.stdout=new PassThrough();c.stderr=new PassThrough();c.kill=()=>{};
   c.stdin.on('finish',()=>{
    const result=operation==='info'?{protocol:1,managerReady:true,beRoot:DEFAULTS['be-root'],runtimeNode:DEFAULTS.node,stateRoot:DEFAULTS['state-root'],localKinds:['theme']}:{requestId:id,kind:'native',state:'installed',runtimeState:'running'};
    c.stdout.end(JSON.stringify({ok:true,result}));setImmediate(()=>c.emit('close',0));
   });return c;
  }
  await assert.rejects(run(['install',dir,'--robot','robot.example'],{spawn}),e=>e.code==='unsupported_kind'&&e.message==="This Jibo can't install skill test builds: its info has no native in localKinds. Check that Jibo runs its current software.");
  assert.deepEqual(calls,['info']);
  if(!existing)assert.equal(existsSync(join(dir,'.skill-kit')),false);
 }finally{rmSync(base,{recursive:true,force:true});}
});
test('complete install uses the real SSH wrapper with a fake child, streams allocated identity, and polls after restart',async()=>{
 const base=mkdtempSync(join(tmpdir(),'skill-wire-'));const calls=[];let interrupted=false;
 try {
  const dir=scaffold('hello','hello',base).directory;
  function spawn(command,args,options) {
   assert.equal(command,'ssh');assert.equal(options.shell,false);assert.ok(!args.join(' ').includes('StrictHostKeyChecking=no'));
   const remote=args.at(-1),operation=remote.match(/phoenix-test-cli\.js' '([^']+)'/)[1];calls.push(operation);
   const c=new EventEmitter();c.stdin=new PassThrough();c.stdout=new PassThrough();c.stderr=new PassThrough();c.kill=()=>{};
   const chunks=[];c.stdin.on('data',b=>chunks.push(b));
   c.stdin.on('finish',()=>{
    let result;
    if(operation==='info')result={protocol:1,managerReady:true,beRoot:DEFAULTS['be-root'],runtimeNode:DEFAULTS.node,stateRoot:DEFAULTS['state-root'],localKinds:['native'],limits:{maxArtifactBytes:33603596}};
    if(operation==='create-project')result={projectId:'local-project-'+id,appId,kind:'native',name:'hello'};
    if(operation==='check'||operation==='queue'){const bytes=Buffer.concat(chunks);assert.equal(inspectPack(bytes,'native').appId,appId);assert.ok(remote.includes("'--sha256'"));result=operation==='check'?{checked:true}:{requestId:id,kind:'native',state:'installed',runtimeState:'pending_restart'};}
    if(operation==='status') {
     if(!interrupted){interrupted=true;c.stderr.end('connection closed during restart');setImmediate(()=>c.emit('close',255));return;}
     result={requestId:id,kind:'native',state:'installed',runtimeState:'running'};
    }
    c.stdout.end(JSON.stringify({ok:true,result}));setImmediate(()=>c.emit('close',0));
   });return c;
  }
  const result=await run(['install',dir,'--robot','robot.example'],{spawn,sleep:async()=>{}});
  assert.equal(result.state,'installed');assert.equal(result.runtimeState,'running');assert.deepEqual(calls,['info','info','create-project','info','check','info','queue','info','status','info','status']);
 }finally{rmSync(base,{recursive:true,force:true});}
});
