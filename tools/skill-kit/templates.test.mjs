import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {runInNewContext} from 'node:vm';
import {argumentsFor} from './cli.mjs';
const cli=new URL('./cli.mjs',import.meta.url).pathname;
const node6=process.env.SKILL_KIT_NODE_6_5;
for(const template of ['hello','touch-ui','voice','network-service']) {
  test(`CLI new --template ${template}, check and deterministic pack`,()=>{
    const base=mkdtempSync(join(tmpdir(),'skill-template-'));
    try {
      function run(args){const r=spawnSync(process.execPath,[cli,...args],{cwd:base,encoding:'utf8'});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout).result;}
      const made=run(['new','sample','--template',template]);
      assert.ok(existsSync(join(made.directory,'README.md')));
      const flags=node6?['--syntax-node',node6]:[];
      const checked=run(['check',made.directory,...flags]);
      assert.equal(checked.kind,'native');
      const a=run(['pack',made.directory,'--out',join(base,'a'),...flags]);
      const b=run(['pack',made.directory,'--out',join(base,'b'),...flags]);
      assert.equal(a.sha256,b.sha256);run(['check',a.file,...flags]);
      if(template==='voice') assert.deepEqual(JSON.parse(readFileSync(join(made.directory,'app.json'))).launchNames,['voice demo']);
    } finally {rmSync(base,{recursive:true,force:true});}
  });
}
test('template selector rejects unknown or ambiguous options',()=>{
  for(const args of [['new','sample','--template','missing'],['new','sample','--template','declarative'],['new','sample','--template','voice','--kind','native'],['new','sample','--kind','declarative'],['new','sample','--from','hello']])assert.throws(()=>argumentsFor(args));
});
function turn(){let resolve;const r={status:'ACTIVE',promise:new Promise(done=>{resolve=done;}),cancel(){this.status='CANCELED';resolve({status:'CANCELED'});return Promise.resolve(true);}};return {r,finish(value){r.status='FINISHED';resolve(value);}};}
const voiceModule={exports:{}};
runInNewContext(readFileSync(new URL('./templates/voice/voice-input.js',import.meta.url),'utf8'),{module:voiceModule,Promise});
const makeVoice=voiceModule.exports;
test('voice accepts only successful final text and retains one in-flight request',async()=>{
  for(const status of ['SUCCEEDED','TIMEOUT','CANCELED','FAILED']) {
    const t=turn(),heard=[];let calls=0;
    const input=makeVoice({startLocalTurn(options){calls++;assert.equal(options.rejectIfBusy,true);assert.equal(options.sosTimeout,6);return Promise.resolve(t.r);}});
    const a=input.listen(text=>heard.push(text)),b=input.listen(()=>assert.fail('second callback'));assert.equal(a,b);
    await new Promise(resolve=>setImmediate(resolve));t.finish({status,result:{asr:{text:'hello'}}});await a;
    assert.deepEqual(heard,status==='SUCCEEDED'?['hello']:[]);assert.equal(calls,1);await input.stop();
  }
});
test('voice stop cancels an active request and discards partial text',async()=>{
  const t=turn(),input=makeVoice({startLocalTurn:()=>Promise.resolve(t.r)});
  const work=input.listen(()=>assert.fail('canceled answer'));
  await new Promise(resolve=>setImmediate(resolve));await input.stop();await work;assert.equal(t.r.status,'CANCELED');
});
test('voice stop waits for a late request and cancels it before any reply',async()=>{
  let provide;const t=turn(),input=makeVoice({startLocalTurn:()=>new Promise(resolve=>{provide=resolve;})});
  const work=input.listen(()=>assert.fail('late answer'));await Promise.resolve();
  let stopped=false;const stop=input.stop().then(()=>{stopped=true;});await Promise.resolve();assert.equal(stopped,false);
  provide(t.r);await stop;await work;assert.equal(t.r.status,'CANCELED');
});
test('voice never claims cleanup when cancel is refused',async()=>{
  const t=turn();t.r.cancel=()=>Promise.resolve(false);
  const input=makeVoice({startLocalTurn:()=>Promise.resolve(t.r)}),work=input.listen(()=>{});
  await new Promise(resolve=>setImmediate(resolve));await assert.rejects(input.stop(),/voice_cancel_unconfirmed/);
  t.finish({status:'CANCELED'});await work;
});
test('voice rejects unconfirmed remote cancellation even after local forced completion',async()=>{
  const t=turn();t.r.cancel=()=>{t.finish({status:'CANCELED'});return Promise.resolve(false);};
  const input=makeVoice({startLocalTurn:()=>Promise.resolve(t.r)}),work=input.listen(()=>assert.fail('forced text'));
  await new Promise(resolve=>setImmediate(resolve));
  await assert.rejects(input.stop(),/voice_cancel_unconfirmed/);await work;
});
function networkFixture() {
  let interval=null,handler,requests=[],sockets=[],closed=0;
  const server=new EventEmitter();server.listening=false;
  server.listen=(port,host,done)=>{assert.equal(port,8897);assert.equal(host,'127.0.0.1');server.listening=true;done();};
  server.close=done=>{closed++;server.listening=false;done();};
  const module={exports:{}};
  runInNewContext(readFileSync(new URL('./templates/network-service/entry.js',import.meta.url),'utf8'),{module,exports:module.exports,Promise,Date,require(name){
    if(name==='./config')return {url:'https://example.com/',periodMs:60000,port:8897};
    if(name==='http')return {createServer(fn){handler=fn;return server;}};
    if(name==='https')return {get(url,callback){const req=new EventEmitter();req.setTimeout=(ms,fn)=>{assert.equal(ms,10000);req.timeout=fn;};req.abort=()=>{req.aborted=true;req.emit('abort');};requests.push({req,callback});return req;}};
    throw Error(name);
  }});
  const deadlines=new Set();
  const app=module.exports.create({timers:{setTimeout(fn){deadlines.add(fn);return fn;},clearTimeout(fn){deadlines.delete(fn);},setInterval(fn){interval=fn;return 1;},clearInterval(id){assert.equal(id,1);interval=null;}}});
  function reply(index=0,size=20){const response=new EventEmitter();response.statusCode=200;response.destroy=()=>{response.destroyed=true;response.emit('close');};requests[index].callback(response);response.emit('data',Buffer.alloc(size));response.emit('end');return response;}
  function status(){let code,body;handler({method:'GET',url:'/status'},{writeHead(c){code=c;},end(s){body=s;}});assert.equal(code,200);return JSON.parse(body);}
  return {app,server,requests,reply,status,poll:()=>interval(),hasTimer:()=>interval!==null||deadlines.size>0,expire:()=>[...deadlines].forEach(fn=>fn()),closed:()=>closed};
}
test('network service polls without overlap, serves bounded status, closes timer and listener',async()=>{
  const f=networkFixture();f.app.prepareBeforeInit();await f.app.startAfterInit();assert.equal(f.app.health().ok,true);
  f.poll();assert.equal(f.requests.length,1);f.reply();await Promise.resolve();f.poll();assert.equal(f.requests.length,2);
  assert.equal(f.status().bytes,20);assert.equal(f.status().httpStatus,200);
  const result=await f.app.stop();assert.equal(result.resourcesReleased,true);assert.equal(f.requests[1].req.aborted,true);assert.equal(f.hasTimer(),false);assert.equal(f.closed(),1);assert.equal(f.app.health().ok,false);
});
test('network timeout and oversize response abort only the owned request',async()=>{
  for(const oversized of [false,true]) {
    const f=networkFixture();f.app.prepareBeforeInit();await f.app.startAfterInit();
    if(oversized)f.reply(0,65537);else f.requests[0].req.timeout();
    await Promise.resolve();assert.equal(f.requests[0].req.aborted,true);assert.equal(f.status().error,oversized?'response_too_large':'request_timeout');await f.app.stop();
  }
});
test('network listener failure does not report healthy startup',async()=>{
  const f=networkFixture();f.server.listen=()=>f.server.emit('error',Object.assign(new Error('in use'),{code:'EADDRINUSE'}));
  await assert.rejects(f.app.startAfterInit(),/in use/);assert.equal(f.app.health().ok,false);assert.equal((await f.app.stop()).resourcesReleased,true);
});

test('network wall deadline bounds a slow response and clears all tracked timers',async()=>{
  const f=networkFixture();f.app.prepareBeforeInit();await f.app.startAfterInit();
  f.expire();await Promise.resolve();assert.equal(f.status().error,'request_timeout');
  assert.equal(f.requests[0].req.aborted,true);await f.app.stop();assert.equal(f.hasTimer(),false);
});
test('network stop waits for pending listener startup and never schedules work after stop',async()=>{
  const f=networkFixture();let listening,stopped=false;
  f.server.listen=(port,host,done)=>{listening=()=>{f.server.listening=true;done();};};
  f.app.prepareBeforeInit();const starting=f.app.startAfterInit();
  const stopping=f.app.stop().then(value=>{stopped=true;return value;});
  await Promise.resolve();await Promise.resolve();
  assert.equal(stopped,false,'pending listen is still an owned resource');
  listening();await starting;assert.equal((await stopping).resourcesReleased,true);
  assert.equal(f.hasTimer(),false);assert.equal(f.requests.length,0);assert.equal(f.server.listening,false);
});
test('network service executes with real loopback HTTP and confirms listener refusal after stop',()=>{
  const helper=new URL('./fixtures/network-loopback.cjs',import.meta.url).pathname;
  const entry=new URL('./templates/network-service/entry.js',import.meta.url).pathname;
  const result=spawnSync(node6||process.execPath,[helper,entry],{encoding:'utf8',timeout:6000});
  assert.equal(result.status,0,result.stderr);const value=JSON.parse(result.stdout);
  assert.equal(value.ok,true);assert.equal(value.listenerClosed,true);assert.equal(value.resourcesReleased,true);assert.equal(value.bytes,6);
  if(node6)assert.equal(value.node,'v6.5.0');
});
