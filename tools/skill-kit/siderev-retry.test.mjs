import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {scaffold} from './new.mjs';
import {run} from './cli.mjs';
const id='12345678-1234-4234-8234-123456789abc';
test('SIDEREV explicit retry after refusal creates a new approval request for unchanged bytes',async()=>{
 const base=mkdtempSync(join(tmpdir(),'skill-retry-')),clients=[];let first=null;
 try {
  const dir=scaffold('garden','hello',base).directory;
  const deps={sleep:async()=>{},ssh:async args=>{
   if(args[0]==='info')return {localKinds:['native'],allowTestBuilds:true};
   if(args[0]==='project')return {projectId:'local-project-'+id,appId:'app-'+id,kind:'native'};
   if(args[0]==='check')return {kind:'native'};
   if(args[0]==='status')return {requestId:id,kind:'native',state:'failed',errorCode:'test_native_collision'};
   if(args[0]==='queue'){
    const client=args[args.indexOf('--client-request-id')+1];clients.push(client);if(!first)first=client;
    return client===first?{requestId:id,kind:'native',state:'failed',errorCode:'test_native_collision'}:{requestId:id,kind:'native',state:'installed',runtimeState:'running'};
   }
   throw Error('unexpected '+args[0]);
  }};
  await assert.rejects(run(['install',dir,'--robot','robot.example'],deps),e=>e.code==='test_native_collision');
  const next=await run(['install',dir,'--robot','robot.example'],deps);
  assert.equal(next.runtimeState,'running');assert.notEqual(clients[0],clients[1]);
 }finally{rmSync(base,{recursive:true,force:true});}
});
