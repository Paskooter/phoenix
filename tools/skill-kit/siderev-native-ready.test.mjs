import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {scaffold} from './new.mjs';
import {run} from './cli.mjs';
const id='12345678-1234-4234-8234-123456789abc';
for(const outcome of ['running','failed'])test('SIDEREV native install waits past accepted/pending_restart for '+outcome,async()=>{
 const base=mkdtempSync(join(tmpdir(),'skill-native-ready-'));let polls=0,clock=0;
 try {
  const dir=scaffold('garden','hello',base).directory;
  const result=run(['install',dir,'--robot','robot.example'],{now:()=>clock,sleep:async ms=>{clock+=ms;},ssh:async args=>{
   if(args[0]==='info')return {localKinds:['native'],allowTestBuilds:true};
   if(args[0]==='project')return {projectId:'local-project-'+id,appId:'app-'+id,kind:'native'};
   if(args[0]==='check')return {kind:'native'};
   if(args[0]==='queue')return {requestId:id,kind:'native',state:'installed',runtimeState:'pending_restart'};
   if(args[0]==='status'){polls++;if(polls===1)throw Object.assign(Error('restarting'),{code:'test_manager_unavailable'});
    return {requestId:id,kind:'native',state:outcome==='failed'?'failed':'installed',runtimeState:outcome,errorCode:outcome==='failed'?'native_health_failed':null};}
   throw Error('unexpected '+args[0]);
  }});
  if(outcome==='failed')await assert.rejects(result,e=>e.code==='native_health_failed');
  else assert.equal((await result).runtimeState,'running','accepted bytes are not a healthy native installation');
  assert.equal(polls,2);
 }finally{rmSync(base,{recursive:true,force:true});}
});
