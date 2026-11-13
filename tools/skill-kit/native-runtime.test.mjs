import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {scaffold} from './new.mjs';
import {run} from './cli.mjs';

const id='12345678-1234-4234-8234-123456789abc';
const native=(state,runtimeState,extra={})=>({kind:'native',state,runtimeState,...extra});
// Only the transport and clock are synthetic: scaffold, validation, packing,
// durable request state and the install/remove CLI entry point are real.
function fixture(t,initial) {
  const base=mkdtempSync(join(tmpdir(),'skill-runtime-'));
  t.after(()=>rmSync(base,{recursive:true,force:true}));
  const dir=scaffold('sample','hello',base).directory;
  const f={dir,calls:[],lines:[],allow:true,initial,status:initial,clock:0};
  const deps={now:()=>f.clock,sleep:async ms=>{f.clock+=ms;},print:line=>f.lines.push(line),ssh:async args=>{
    f.calls.push(args);
    if(args[0]==='info')return {localKinds:['native'],allowTestBuilds:f.allow};
    if(args[0]==='project')return {projectId:'local-project-'+id,appId:'app-'+id,kind:'native'};
    if(args[0]==='check')return {kind:'native'};
    if(args[0]==='queue'||args[0]==='remove')return {requestId:id,...f.initial};
    if(args[0]==='status') {
      assert.equal(args.at(-1),id,'follow the original durable request');
      const result=typeof f.status==='function'?f.status():f.status;
      if(result instanceof Error)throw result;
      return {requestId:id,...result};
    }
    assert.fail('unexpected remote operation '+args[0]);
  }};
  f.invoke=(command='install',...flags)=>run([command,dir,'--robot','fixture.invalid','--timeout',String(f.timeout||1),...flags],deps);
  f.saved=()=>{
    const files=readdirSync(join(dir,'.skill-kit'));
    assert.equal(files.length,1,'temporary build directories must be removed even on failure');
    return JSON.parse(readFileSync(join(dir,'.skill-kit',files[0]),'utf8'));
  };
  f.clients=()=>f.calls.filter(args=>args[0]==='queue').map(args=>args.at(-1));
  return f;
}
function retained(f) {
  const saved=f.saved();
  assert.equal(saved.requestId,id);
  assert.ok(saved.install.clientRequestId,'a stopped runtime is not a refused approval request');
  assert.equal(f.calls.filter(args=>args[0]==='project').length,1);
  assert.ok(!f.calls.some(args=>['approve','enable','cancel'].includes(args[0])));
  return saved.install.clientRequestId;
}

for(const state of ['installed','resumed']) {
  for(const [runtimeState,code] of [['disabled','test_native_collision'],['paused','test_builds_disabled']]) {
    for(const later of [false,true])test(`native ${state}/${runtimeState} from ${later?'status':'queue'} is not install success and keeps request identity`,async t=>{
      const blocked=native(state,runtimeState,{errorCode:code,collisionName:'Installed Sample'});
      const f=fixture(t,later?native(state,'pending_restart'):blocked);
      f.status=blocked;
      await assert.rejects(f.invoke(),error=>{
        assert.equal(error.code,code);assert.equal(error.requestId,id);
        assert.equal(error.terminalState,undefined,'historical installed/resumed is not a terminal request refusal');
        assert.match(error.ownerMessage,/not running/);
        if(runtimeState==='disabled')assert.match(error.ownerMessage,/Remove “Installed Sample” first/);
        else assert.match(error.ownerMessage,/Allow test builds is off/);
        return true;
      });
      assert.equal(f.calls.filter(args=>args[0]==='status').length,later?1:0);
      const client=retained(f);
      assert.ok(!f.lines.some(line=>line.startsWith('Tap Install')),'do not ask for an approval already committed');
      // Re-running the command checks the same request, not a new allocation or approval.
      f.initial=native(state,'running');
      assert.equal((await f.invoke()).runtimeState,'running');
      assert.deepEqual(f.clients(),[client,client]);retained(f);
    });
  }
  for(const runtimeState of ['failed','revoked','recovery_required'])test(`native ${state}/${runtimeState} reports confirmed runtime failure without replacing the request`,async t=>{
    const f=fixture(t,native(state,runtimeState));
    await assert.rejects(f.invoke(),error=>error.code==='test_native_'+runtimeState&&error.requestId===id&&/not running/.test(error.ownerMessage));
    retained(f);
    assert.deepEqual(f.calls.map(args=>args[0]),['info','project','check','queue']);
  });
  test(`native ${state}/pending_restart follows reconnect and startup to running`,async t=>{
    const f=fixture(t,native(state,'pending_restart'));let polls=0;
    f.status=()=>++polls===1?Object.assign(Error('restart'),{code:'test_manager_unavailable'}):native(state,'running');
    f.timeout=10;
    const result=await f.invoke();
    assert.equal(result.runtimeState,'running');assert.equal(polls,2);
    assert.match(f.lines.join('\n'),/Waiting for Jibo to reconnect/);
    assert.equal(f.calls.filter(args=>args[0]==='queue').length,1);retained(f);
  });
  test(`native ${state}/running is confirmed install success without another approval`,async t=>{
    const f=fixture(t,native(state,'running'));
    assert.equal((await f.invoke()).runtimeState,'running');
    assert.deepEqual(f.calls.map(args=>args[0]),['info','project','check','queue']);retained(f);
    assert.ok(!f.lines.some(line=>line.startsWith('Tap Install')));
  });
}

for(const [label,summary] of [
  ['missing runtime',{kind:'native',state:'installed'}],
  ['unknown runtime',native('installed','future_startup_state')],
  ['missing kind',{state:'installed',runtimeState:'running'}],
  ['different kind',{kind:'theme',state:'installed',runtimeState:'running'}],
  ['removal result',native('removed','running')]
])test(`native install fails closed on ${label} and a retry keeps the same client request`,async t=>{
  const f=fixture(t,summary);
  await assert.rejects(f.invoke(),error=>error.code==='unknown_robot_state'&&error.requestId===id);
  const client=retained(f);
  f.initial=native('installed','running');await f.invoke();
  assert.deepEqual(f.clients(),[client,client]);retained(f);
});

for(const runtimeState of ['installed','pending_restart'])test(`native accepted/${runtimeState} timeout is not startup proof and preserves retry identity`,async t=>{
  const f=fixture(t,native('installed',runtimeState));
  f.status=()=>Object.assign(Error('reconnecting'),{code:'ssh_timeout'});
  await assert.rejects(f.invoke(),error=>error.code==='approval_timeout'&&error.requestId===id);
  const client=retained(f);
  assert.equal(f.calls.filter(args=>args[0]==='status').length,1);
  f.initial=native('installed','running');await f.invoke();
  assert.deepEqual(f.clients(),[client,client]);retained(f);
});

for(const state of ['failed','canceled','declined','expired'])test(`confirmed ${state} request fails even with running runtime and only explicit retry replaces approval identity`,async t=>{
  const f=fixture(t,native(state,'running'));
  await assert.rejects(f.invoke(),error=>error.code==='test_request_'+state&&error.terminalState===state&&error.requestId===id);
  assert.equal(f.saved().install,undefined);
  const first=f.clients()[0];
  f.initial=native('installed','running');await f.invoke();
  assert.notEqual(f.clients()[1],first);retained(f);
});

for(const [runtimeState,choice] of [['disabled','--keep-data'],['paused','--erase-data']])test(`Allow-off removal of ${runtimeState} native runtime still requires a tap and completes on removed ${choice}`,async t=>{
  const f=fixture(t,native('installed',runtimeState));
  await assert.rejects(f.invoke());retained(f);
  const start=f.calls.length;f.allow=false;
  f.initial=native('pending_robot_approval',runtimeState);
  f.status=native('removed',runtimeState);
  assert.equal((await f.invoke('remove',choice)).state,'removed');
  assert.deepEqual(f.calls.slice(start).map(args=>args[0]),['remove','status']);
  assert.ok(f.calls[start].includes(choice));
  assert.ok(f.lines.includes('Tap Remove test build on Jibo'));
  assert.equal(f.saved().remove.done,true);assert.equal(f.saved().install,undefined);
  assert.ok(!f.calls.some(args=>['approve','enable','cancel'].includes(args[0])));
});
