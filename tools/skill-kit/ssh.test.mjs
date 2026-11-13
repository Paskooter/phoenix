import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, renameSync, openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { pathToFileURL } from 'node:url';
import {scaffold} from './new.mjs';
import {buildProject} from './project.mjs';
const source = new URL('./ssh.mjs', import.meta.url).pathname;
const common = ['--robot', 'robot.example', '--be-root', '/opt/be', '--node', '/opt/node', '--state-root', '/var/lib/test-builds'];
function fakeSsh(infoOverride, onChunk) {
  const calls = [];
  function spawn(command, args, options) {
    const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
    const chunks = []; child.stdin.on('data', data => { chunks.push(data); if(onChunk) onChunk(data, args); });
    calls.push({command, args, options, chunks});
    child.stdin.on('finish', () => {
      const info = infoOverride || {protocol: 1, managerReady: true, beRoot:'/opt/be', runtimeNode:'/opt/node', stateRoot:'/var/lib/test-builds', localKinds: ['declarative', 'theme', 'native'], limits: {maxArtifactBytes: 33603596}};
      child.stdout.end(JSON.stringify({ok:true, result: args.at(-1).includes("'info'") ? info : {requestId: '12345678-1234-1234-1234-123456789abc', state:'pending_robot_approval', badge:'LOCAL / Test'}}));
      setImmediate(() => child.emit('close', 0));
    });
    return child;
  }
  return {spawn, calls};
}
test('host streams an unsigned native pack via SSH only after firmware preflight', async () => {
  const { run } = await import(pathToFileURL(source));
  const dir = mkdtempSync(join(tmpdir(), 'sideload-host-'));
  try {
    const bytes=buildProject(scaffold('transport','hello',dir).directory).bytes;
    const file = join(dir, "native pack '; touch NEVER.phnative"); writeFileSync(file, bytes);
    const fake = fakeSsh();
    const result = await run(['queue', ...common, '--project', 'local-project-12345678-1234-1234-1234-123456789abc', '--file', file, '--client-request-id', 'retry-1'], {spawn:fake.spawn});
    assert.equal(result.state, 'pending_robot_approval'); assert.equal(result.badge, 'LOCAL / Test');
    assert.equal(fake.calls.length, 2);
    assert.ok(fake.calls.every(c => c.command === 'ssh' && c.options.shell !== true));
    const call = fake.calls[1]; assert.deepEqual(call.args.slice(0, 4), ['-T', '-l', 'root', '--']);
    assert.ok(call.args.at(-1).includes("'--stdin'")); assert.ok(!call.args.at(-1).includes(file));
    assert.deepEqual(Buffer.concat(call.chunks), bytes);
    assert.ok(fake.calls.every(c => !c.args.join(' ').includes('StrictHostKeyChecking=no')));
  } finally { rmSync(dir, {recursive:true, force:true}); }
});
test('host invalidates a complete frame if its source is renamed before EOF', async () => {
  const {run} = await import(pathToFileURL(source));const dir=mkdtempSync(join(tmpdir(),'host-move-'));const file=join(dir,'source');const bytes=Buffer.from('original');writeFileSync(file,bytes);let moved=false;
  try {
    const fake=fakeSsh(null,()=>{if(!moved){moved=true;renameSync(file,file+'.old');writeFileSync(file,bytes);}});
    await assert.rejects(run(['queue',...common,'--project','local-project-12345678-1234-1234-1234-123456789abc','--file',file],{spawn:fake.spawn}),/pack_changed/);
    assert.ok(Buffer.concat(fake.calls[1].chunks).length>bytes.length,'failed snapshot must poison, not half-close, the valid prefix');
  } finally {rmSync(dir,{recursive:true,force:true});}
});
test('old firmware refusal never copies a CLI or attempts fallback installation', async () => {
  const {run} = await import(pathToFileURL(source)); const fake = fakeSsh({protocol:0, managerReady:false});
  await assert.rejects(run(['project', ...common, '--kind','native','--name','test'], {spawn:fake.spawn}), /unsupported_firmware/);
  assert.equal(fake.calls.length, 1); assert.equal(fake.calls[0].command, 'ssh');
});
test('host rejects approval unknown options and injection before spawning SSH', async () => {
  const {run, parseArgs, quote} = await import(pathToFileURL(source));
  const fake = fakeSsh();
  for (const args of [['approve'], ['info', ...common, '--allow'], ['remove', ...common, '--project','local-project-12345678-1234-1234-1234-123456789abc'], ['info',...common.slice(0,1), '-oProxyCommand=oops', ...common.slice(2)]]) {
    await assert.rejects(run(args, {spawn:fake.spawn}));
  }
  assert.equal(fake.calls.length,0); assert.equal(quote("a'b"), "'a'\\''b'");
  assert.throws(() => parseArgs(['info',...common,'--node','/again']), /invalid_option/);
});
test('host removal explicitly forwards keep or erase and leaves approval physical', async () => {
  const {run} = await import(pathToFileURL(source));
  for (const choice of ['--keep-data', '--erase-data']) {
    const fake=fakeSsh(); const result=await run(['remove',...common,'--project','local-project-12345678-1234-1234-1234-123456789abc',choice,'--client-request-id','remove-1'],{spawn:fake.spawn});
    assert.equal(result.state,'pending_robot_approval'); assert.ok(fake.calls[1].args.at(-1).includes("'"+choice+"'"));
    assert.ok(!fake.calls[1].args.at(-1).includes('approve'));
  }
});
