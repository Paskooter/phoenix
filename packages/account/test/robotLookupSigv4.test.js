// Invented accounts and secrets only. Exercise the actual public proxy and
// Account boundary before any robot credential can leave GetRobot.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAccountService, Store } from '../src/index.js';
import { createOwnerAccount, createLoop } from '../src/model.js';
import { createClassicEntrypoint } from '../../classic/src/index.js';
import { signSigV4 } from '@phoenix/common';

const dir=mkdtempSync(join(tmpdir(),'phoenix-getrobot-auth-'));
const store=new Store(join(dir,'store.json'));
let owner, outsider, robot, loop, accountServer, classicServer, endpoints;
const target='Loop_20160324.GetRobot';
function signed(base, body, credential=owner, overrides={}) {
  return {body,headers:signSigV4({method:'POST',path:'/',body,
    headers:{host:new URL(base).host,'content-type':'application/x-amz-json-1.1','x-amz-target':target,...overrides.headers},
    accessKeyId:credential.accessKeyId,secretAccessKey:overrides.secret || credential.secretAccessKey,
    region:'global',service:'jibo',date:overrides.date || new Date()}).headers};
}
async function post(base, request) {
  const response=await fetch(base+'/',{method:'POST',...request});
  return {status:response.status,body:await response.json()};
}
function error(response,status,code) {
  assert.equal(response.status,status);assert.equal(response.body.__type,code);
  assert.equal(JSON.stringify(response.body).includes(robot.secretAccessKey),false);
}
before(async()=>{
  owner=createOwnerAccount(store,{email:'owner@auth-fixture.test',password:'fixture-owner-password'});
  outsider=createOwnerAccount(store,{email:'outsider@auth-fixture.test',password:'fixture-outsider-password'});
  ({robot,loop}=createLoop(store,{owner,robotId:'credential-fixture-robot'}));
  accountServer=await createAccountService({store}).listen(0);
  process.env.NET_account=`localhost:${accountServer.address().port}`;
  classicServer=await createClassicEntrypoint().listen(0);
  endpoints=[`http://localhost:${accountServer.address().port}`,`http://localhost:${classicServer.address().port}`];
});
after(async()=>{
  await Promise.all([accountServer,classicServer].map(s=>new Promise(r=>s.close(r))));
  delete process.env.NET_account;rmSync(dir,{recursive:true,force:true});
});

test('only a signed active owner can obtain robot credentials through either boundary',async()=>{
  for(const base of endpoints) {
    const body='{\n  "loopId": '+JSON.stringify(loop._id)+'\n}';
    const accepted=await post(base,signed(base,body));
    assert.equal(accepted.status,200);
    assert.equal(accepted.body.secretAccessKey,robot.secretAccessKey);
    assert.equal(accepted.body.accessKeyId,robot.accessKeyId);
    error(await post(base,signed(base,body,outsider,{headers:{'x-amz-credentials':JSON.stringify({id:owner._id,isAdmin:true})}})),403,'CAN_BE_ACCESSED_BY_OWNER');
    error(await post(base,signed(base,body,owner,{secret:outsider.secretAccessKey})),401,'SIGNATURE_MISMATCH');
    error(await post(base,{body,headers:{'content-type':'application/x-amz-json-1.1','x-amz-target':target,authorization:`AWS4-HMAC-SHA256 Credential=${owner.accessKeyId}/20260908/global/jibo/aws4_request, SignedHeaders=host, Signature=fixture`}}),401,'MISSING_DATE_HEADER');
    error(await post(base,{body,headers:{'content-type':'application/x-amz-json-1.1','x-amz-target':target,'x-amz-credentials':JSON.stringify({id:owner._id})}}),401,'MISSING_AUTH_HEADER');
    error(await post(base,signed(base,body,owner,{date:new Date(Date.now()-3600000)})),401,'CLOCK_SKEW_TOO_LONG');
    owner.isActive=false;
    try {error(await post(base,signed(base,body)),403,'ACCOUNT_NOT_ACTIVE');}
    finally {owner.isActive=true;}
  }
});

test('GetRobot checks exact signed bytes and target before source handler validation',async()=>{
  for(const base of endpoints) {
    const body=JSON.stringify({loopId:loop._id});
    const original=signed(base,body);
    error(await post(base,{...original,body:JSON.stringify({loopId:'different-fixture-loop'})}),401,'SIGNATURE_MISMATCH');
    error(await post(base,{...original,headers:{...original.headers,'x-amz-target':'Loop_20160324.getrobot'}}),401,'SIGNATURE_MISMATCH');
    for(const body of ['null','false','7','"text"','[]','{}']) {
      const validated=await post(base,signed(base,body));
      assert.equal(validated.status,422);
      error(await post(base,{body,headers:{'content-type':'application/x-amz-json-1.1','x-amz-target':target}}),401,'MISSING_AUTH_HEADER');
    }
  }
});

test('Classic forwards profile JSON primitives to the same 422 validation boundary',async()=>{
  const base=endpoints[1];
  for(const operation of ['SetEnrollment','UpdateNickname','UpdatePhoneticName']) {
    for(const body of ['null','false','7','"text"','[]']) {
      const result=await post(base,{body,headers:{'content-type':'application/x-amz-json-1.1','x-amz-target':'Loop_20160324.'+operation}});
      assert.equal(result.status,422);
    }
  }
});

// The original decorated handlers reject parsed JSON scalars with 422.
test('lookup JSON primitives reach handler validation on Account and Classic', async () => {
  for (const base of endpoints) {
    for (const operation of ['FindOwner', 'ListOwnerRobots']) {
      for (const body of ['null', 'false', '7', '"text"', '[]']) {
        const request = signed(base, body, owner, { headers: { 'x-amz-target': 'Loop_20160324.' + operation } });
        assert.equal((await post(base, request)).status, 422);
      }
    }
  }
});

test('FindOwner and ListOwnerRobots enforce the source public gateway authentication', async () => {
  for (const base of endpoints) {
    for (const operation of ['FindOwner', 'ListOwnerRobots']) {
      const headers = { 'x-amz-target': 'Loop_20160324.' + operation };
      const body = JSON.stringify({ accountId: owner._id });
      assert.equal((await post(base, signed(base, body, owner, { headers }))).status, 200);
      error(await post(base, signed(base, body, owner, { headers, secret: outsider.secretAccessKey })), 401, 'SIGNATURE_MISMATCH');
      error(await post(base, { body: 'null', headers: { ...headers, 'content-type': 'application/x-amz-json-1.1', 'x-amz-credentials': JSON.stringify({ id: owner._id }) } }), 401, 'MISSING_AUTH_HEADER');
      const request = signed(base, body, owner, { headers });
      error(await post(base, { ...request, body: '{}' }), 401, 'SIGNATURE_MISMATCH');
      owner.isActive = false;
      try { error(await post(base, signed(base, body, owner, { headers })), 403, 'ACCOUNT_NOT_ACTIVE'); }
      finally { owner.isActive = true; }
    }
  }
});
