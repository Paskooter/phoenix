import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { GoogleASRSession } from '../src/asr/googleSession.js';
function setup(t, overrides = {}) {
  const records = [];
  const log = Object.fromEntries(['info','warn','error','debug'].map(level => [level,(message,fields)=>records.push({level,message,fields})]));
  const stream = Object.assign(new EventEmitter(), {write() {},end() {},destroy() {}},overrides);
  const session = new GoogleASRSession(stream,{},log);
  t.after(()=>session.abort());
  return {session,stream,records};
}
for (const [method,operation,code] of [['end','stop','ECONNRESET'],['destroy','abort','EPIPE']]) {
  test(`legacy Google ${operation} failure has safe attribution without the transport message`,async t=>{
    const {session,records}=setup(t,{[method](){throw Object.assign(new Error('private-words token=private-value'),{code});}});
    const result=session.start();session[operation]();await result;
    const warning=records.find(r=>r.level==='warn');
    assert.equal(warning?.fields?.provider,'google');assert.equal(warning?.fields?.errorCode,code);
    assert.ok(!JSON.stringify(records).includes('private-words'));
  });
}
test('legacy Google error frame log contains a numeric upstream code but no frame text',async t=>{
  const {session,stream,records}=setup(t); const result=session.start().catch(e=>e);
  const error=Object.assign(new Error('private-words token=private-value'),{code:14});
  stream.emit('data',{error,results:[{alternatives:[{transcript:'private-words'}]}]});
  assert.equal(await result,error,'preserve the source rejection contract');
  const failure=records.find(r=>r.level==='error');
  assert.equal(failure?.fields?.provider,'google');assert.equal(failure?.fields?.grpcCode,14);
  assert.ok(!JSON.stringify(records).includes('private-words'));
});
test('legacy Google malformed event diagnostics never log arbitrary event names or frames',t=>{
  const {session,stream,records}=setup(t);session.start();
  stream.emit('data',{results:[{alternatives:[{transcript:'private-words'}]}]});
  stream.emit('data',{speechEventType:'private-words',transcript:'private-words'});
  const warnings=records.filter(r=>r.level==='warn');assert.equal(warnings.length,2);
  for(const warning of warnings){assert.equal(warning.fields?.provider,'google');assert.equal(warning.fields?.errorCode,'ERR_GOOGLE_RESPONSE_FORMAT');}
  assert.ok(!JSON.stringify(records).includes('private-words'));
});
test('legacy Google final timeout returns its interim unchanged but logs only safe diagnostics',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const {session,stream,records}=setup(t);const result=session.start();
  stream.emit('data',{speechEventType:'SPEECH_EVENT_UNSPECIFIED',results:[{isFinal:false,alternatives:[{transcript:'private-words',confidence:0.7}]}]});
  stream.emit('data',{speechEventType:'END_OF_SINGLE_UTTERANCE'});
  t.mock.timers.tick(3000);
  assert.equal((await result).text,'private-words');
  const warning=records.find(r=>r.fields?.errorCode==='GOOGLE_STT_TIMEOUT');assert.equal(warning?.fields?.provider,'google');
  assert.ok(!JSON.stringify(records).includes('private-words'));
});
