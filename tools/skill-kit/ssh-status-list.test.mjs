import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {run as runSsh} from './ssh.mjs';
import {scaffold} from './new.mjs';

const helper = fileURLToPath(new URL('./ssh.mjs', import.meta.url));
const cli = fileURLToPath(new URL('./cli.mjs', import.meta.url));
const common = ['--robot', 'fixture.invalid', '--be-root', '/opt/be', '--node', '/opt/node', '--state-root', '/var/lib/test-builds'];
const requestId = '12345678-1234-4234-8234-123456789abc';
const projectId = 'local-project-' + requestId;
const encode = result => JSON.stringify({ok: true, result}) + '\n';
const quoted = args => args.map(value => "'" + value.replaceAll("'", "'\\''") + "'").join(' ');
const remoteCommand = args => quoted(['/opt/node', '/opt/be/phoenix-test-cli.js', ...args, '--state-root', '/var/lib/test-builds', '--json']);
function info() {
  return {protocol: 1, managerReady: true, localKinds: ['native'], allowTestBuilds: false,
    beRoot: '/opt/be', runtimeNode: '/opt/node', stateRoot: '/var/lib/test-builds',
    limits: {localListResponseBytes: 1048576, maxArtifactBytes: 33603596}};
}
function row(index) {
  const id = index.toString(16).padStart(8, '0') + '-1234-4234-8234-123456789abc';
  return {requestId: id, projectId, buildId: 'local-build-' + id, appId: 'app-' + requestId,
    origin: 'ssh-local', state: 'canceled', status: 'canceled', action: 'install', kind: 'native',
    name: 'Synthetic history ' + index + ' '.repeat(50), version: '1.0.0', collisionName: null,
    runtimeState: 'pending', errorCode: null, blockedReason: null, approvalRemainingMs: 0, badge: 'LOCAL / Test'};
}
function fixture(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'kit-status-')), bin = join(root, 'bin');
  mkdirSync(bin);
  t.after(() => rmSync(root, {recursive: true, force: true}));
  writeFileSync(join(bin, 'ssh'), '#!' + process.execPath + '\n' + readFileSync(new URL('./fixtures/status-ssh.cjs', import.meta.url), 'utf8'), {mode: 0o700});
  const trace = join(root, 'trace.jsonl'), specFile = join(root, 'replies.json');
  const env = {...process.env, PATH: bin, SKILL_KIT_SSH_FIXTURE: specFile};
  delete env.NODE_OPTIONS;
  delete env.NODE_PATH;
  function set({preflight = info(), preflightRaw, preflightExit = 0, operation = ['status', '--list'], stdout = encode([]), ...reply} = {}) {
    writeFileSync(specFile, JSON.stringify({trace, replies: [
      {command: remoteCommand(['info']), stdout: preflightRaw ?? encode(preflight), exit: preflightExit},
      {command: remoteCommand(operation), stdout, ...reply}
    ]}));
  }
  set(options);
  function invoke(args = ['status', '--list'], {entry = helper, slow = false} = {}) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [entry, args[0], ...common, ...args.slice(1)], {cwd: root, env, stdio: ['pipe', 'pipe', 'pipe']});
      const out = [], err = [];
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('fixture_deadline')); }, 20000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.stdin.on('error', () => {}); child.stdin.end();
      child.stdout.on('data', data => out.push(data)); child.stderr.on('data', data => err.push(data));
      if (slow) { child.stdout.pause(); setTimeout(() => child.stdout.resume(), 150); }
      child.once('close', (exit, signal) => {
        clearTimeout(timer);
        resolve({exit, signal, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString('utf8')});
      });
    });
  }
  return {root, set, invoke, trace: () => existsSync(trace) ? readFileSync(trace, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : []};
}
function successful(reply, expected) {
  assert.equal(reply.signal, null);
  assert.equal(reply.exit, 0, reply.stdout.toString() + reply.stderr);
  assert.equal(reply.stderr, '');
  assert.deepEqual(JSON.parse(reply.stdout), {ok: true, result: expected});
}
function refused(reply, error) {
  assert.equal(reply.signal, null); assert.equal(reply.exit, 1);
  assert.deepEqual(JSON.parse(reply.stdout), {ok: false, error});
  assert.equal(reply.stderr, 'Local test request failed: ' + error + '\n');
}

test('negotiated status list preserves all 129 rows through delayed executable stdout above 64 KiB', async t => {
  const rows = Array.from({length: 129}, (_, i) => row(i)), stdout = encode(rows);
  assert.ok(Buffer.byteLength(stdout) > 65536);
  const f = fixture(t, {stdout});
  const reply = await f.invoke(undefined, {slow: true});
  successful(reply, rows);
  assert.equal(reply.stdout.length, Buffer.byteLength(stdout));
  assert.deepEqual(f.trace().filter(item => item.event === 'command').map(item => item.argv[5]), [remoteCommand(['info']), remoteCommand(['status', '--list'])]);
  assert.equal(f.trace().filter(item => item.event === 'flushed').at(-1).bytes, Buffer.byteLength(stdout));
});

test('status list preserves a UTF-8 scalar split across actual child pipe writes', async t => {
  const rows = [{name: 'Synthetic 🌱 history'}], stdout = encode(rows);
  const split = Buffer.from(stdout).indexOf(Buffer.from('🌱')) + 1;
  const f = fixture(t, {stdout, cuts: [split], delayMs: 35});
  successful(await f.invoke(), rows);
});

function paddedList(bytes) {
  const rows = [{name: ''}];
  rows[0].name = 'x'.repeat(bytes - Buffer.byteLength(encode(rows)));
  const stdout = encode(rows);
  assert.equal(Buffer.byteLength(stdout), bytes);
  return {rows, stdout};
}
const commands = f => f.trace().filter(item => item.event === 'command');

for (const limits of [undefined, null, {}, {robotResponseBytes: 65536}, JSON.parse('{"__proto__":{"localListResponseBytes":1048576}}')]) {
  test(`absent list capability keeps exactly the legacy 16384-byte budget (${JSON.stringify(limits)})`, async t => {
    const preflight = info();
    if (limits === undefined) delete preflight.limits; else preflight.limits = limits;
    const exact = paddedList(16384), f = fixture(t, {preflight, stdout: exact.stdout});
    successful(await f.invoke(), exact.rows);
    f.set({preflight, stdout: paddedList(16385).stdout});
    refused(await f.invoke(), 'robot_response_too_large');
  });
}

for (const cap of [16384, 32768, 1048576]) {
  test(`negotiated list budget accepts exactly ${cap} wire bytes and refuses the next byte`, async t => {
    const preflight = info(); preflight.limits.localListResponseBytes = cap;
    const exact = paddedList(cap), f = fixture(t, {preflight, stdout: exact.stdout});
    successful(await f.invoke(undefined, {slow: true}), exact.rows);
    f.set({preflight, stdout: paddedList(cap + 1).stdout});
    refused(await f.invoke(undefined, {slow: true}), 'robot_response_too_large');
  });
}

test('multibyte wire-byte accounting is independent of character count and split boundaries', async t => {
  const preflight = info(); preflight.limits.localListResponseBytes = 16384;
  const rows = [{name: '🌱'.repeat(4000)}];
  rows[0].name += 'x'.repeat(16384 - Buffer.byteLength(encode(rows)));
  const stdout = encode(rows), first = Buffer.from(stdout).indexOf(Buffer.from('🌱')) + 1;
  const f = fixture(t, {preflight, stdout, cuts: [first, 10000], delayMs: 15});
  assert.equal(Buffer.byteLength(stdout), 16384); assert.ok(stdout.length < 16384);
  successful(await f.invoke(), rows);
  rows[0].name += 'x'; f.set({preflight, stdout: encode(rows), cuts: [first], delayMs: 15});
  refused(await f.invoke(), 'robot_response_too_large');
});

for (const cap of [null, false, true, '1048576', '16384; invalid', 0, -1, 16383, 1048577, 16384.5, Number.MAX_SAFE_INTEGER, {}, [], {valueOf: 1048576}]) {
  test(`present invalid list capability fails before status (${JSON.stringify(cap)})`, async t => {
    const preflight = info(); preflight.limits.localListResponseBytes = cap;
    const f = fixture(t, {preflight, stdout: encode([row(1)])});
    refused(await f.invoke(), 'invalid_robot_limits');
    assert.deepEqual(commands(f).map(item => item.argv[5]), [remoteCommand(['info'])]);
  });
}

test('a hostile JSON number overflowing to Infinity cannot become a list budget', async t => {
  const preflightRaw = encode(info()).replace('"localListResponseBytes":1048576', '"localListResponseBytes":1e400');
  const f = fixture(t, {preflightRaw});
  refused(await f.invoke(), 'invalid_robot_limits'); assert.equal(commands(f).length, 1);
});

for (const [name, mutate, error] of [
  ['protocol', value => { value.protocol = 2; }, 'unsupported_firmware'],
  ['local kinds', value => { value.localKinds = null; }, 'unsupported_firmware'],
  ['readiness', value => { value.managerReady = false; value.unavailableReason = 'test_owner_unknown'; }, 'test_owner_unknown'],
  ['missing readiness', value => { delete value.managerReady; }, 'test_manager_unavailable'],
  ['BE root', value => { value.beRoot = '/other'; }, 'robot_path_mismatch'],
  ['state root', value => { value.stateRoot = '/other'; }, 'robot_path_mismatch'],
  ['runtime identity', value => { value.runtimeNode = '/other'; }, 'robot_path_mismatch']
]) {
  test(`list negotiation cannot bypass preflight ${name}`, async t => {
    const preflight = info(); mutate(preflight);
    const f = fixture(t, {preflight, stdout: paddedList(70000).stdout});
    refused(await f.invoke(), error); assert.equal(commands(f).length, 1);
  });
}

test('info itself remains limited to 16384 bytes even while advertising a larger list cap', async t => {
  const preflight = info(); preflight.padding = '';
  preflight.padding = 'x'.repeat(16384 - Buffer.byteLength(encode(preflight)));
  const f = fixture(t, {preflight});
  successful(await f.invoke(['info']), preflight);
  preflight.padding += 'x'; f.set({preflight});
  refused(await f.invoke(['info']), 'robot_response_too_large');
});

for (const command of ['status', 'project', 'check', 'queue', 'cancel', 'resume', 'remove']) {
  test(`${command} without list never inherits the aggregate budget`, async t => {
    const f = fixture(t), preflight = info(), client = 'synthetic-' + command;
    let args, operation, inputBytes = 0;
    if (command === 'status') args = operation = ['status', '--request', requestId];
    if (command === 'project') {
      args = ['project', '--kind', 'native', '--name', 'Synthetic', '--client-request-id', client];
      operation = ['create-project', ...args.slice(1)];
    }
    if (command === 'check' || command === 'queue') {
      const file = join(f.root, 'invented-pack'), pack = Buffer.from('Synthetic pack transport'); writeFileSync(file, pack);
      inputBytes = pack.length;
      args = [command, '--project', projectId, '--file', file, ...(command === 'queue' ? ['--client-request-id', client] : [])];
      operation = [command, '--project', projectId, ...(command === 'queue' ? ['--client-request-id', client] : []), '--stdin', '--bytes', String(pack.length), '--sha256', createHash('sha256').update(pack).digest('hex')];
    }
    if (command === 'cancel') args = operation = [command, '--request', requestId, '--client-request-id', client];
    if (command === 'resume') args = operation = [command, '--project', projectId, '--client-request-id', client];
    if (command === 'remove') args = operation = [command, '--project', projectId, '--keep-data', '--client-request-id', client];
    const exact = paddedList(16384);
    f.set({preflight, operation, inputBytes, stdout: exact.stdout});
    successful(await f.invoke(args), exact.rows);
    f.set({preflight, operation, inputBytes, stdout: paddedList(16385).stdout});
    refused(await f.invoke(args), 'robot_response_too_large');
  });
}

for (const [name, stdout, error] of [
  ['incomplete JSON', '{"ok":true,"result":', 'ssh_or_robot_failed'],
  ['null envelope', 'null', 'invalid_robot_response'],
  ['non-boolean ok', '{"ok":"true","result":[]}', 'invalid_robot_response'],
  ['missing ok', '{"result":[]}', 'invalid_robot_response'],
  ['remote owner refusal', '{"ok":false,"error":"test_owner_unknown"}', 'test_owner_unknown'],
  ['raw remote error', '{"ok":false,"error":"SYNTHETIC PRIVATE EXCEPTION"}', 'robot_request_failed'],
  ['object remote error', '{"ok":false,"error":{"code":"test_owner_unknown"}}', 'robot_request_failed']
]) {
  test(`negotiated list preserves fail-closed parsing: ${name}`, async t => {
    const f = fixture(t, {stdout, exit: 1}); refused(await f.invoke(), error);
  });
}

for (const exit of [7, 255]) test(`successful JSON from a failing SSH child is still refused (exit ${exit})`, async t => {
  const f = fixture(t, {stdout: encode([row(1)]), exit}); refused(await f.invoke(), 'ssh_or_robot_failed');
});

test('a signalled SSH child is not mistaken for a successful list', async t => {
  const f = fixture(t, {stdout: encode([]), signal: 'SIGTERM'}); refused(await f.invoke(), 'ssh_or_robot_failed');
});

test('missing firmware keeps the original unsupported-firmware refusal', async t => {
  const f = fixture(t, {stdout: '', exit: 127}); refused(await f.invoke(), 'unsupported_firmware');
});

test('missing SSH executable cannot fall back to the real network', async t => {
  const f = fixture(t); rmSync(join(f.root, 'bin', 'ssh'));
  refused(await f.invoke(), 'ssh_unavailable'); assert.equal(commands(f).length, 0);
});

test('connection and request parser refusals happen before any executable SSH', async t => {
  const f = fixture(t);
  for (const [args, error] of [
    [['status', '--list', '--request', requestId], 'choose_request_or_list'],
    [['status', '--list', '--list'], 'invalid_option'],
    [['status', '--list', '--approve'], 'invalid_option'],
    [['status', '--list', '--node', '/again'], 'invalid_option'],
    [['status', '--request', '../not-an-id'], 'invalid_request_id']
  ]) refused(await f.invoke(args), error);
  assert.equal(commands(f).length, 0);
});

test('saved-project CLI status stays per-request and retains the legacy bound', async t => {
  const f = fixture(t), directory = scaffold('sample', 'hello', f.root).directory;
  const folder = join(directory, '.skill-kit'); mkdirSync(folder);
  const key = createHash('sha256').update(JSON.stringify(['fixture.invalid', '/opt/be', '/opt/node', '/var/lib/test-builds'])).digest('hex');
  writeFileSync(join(folder, key + '.json'), JSON.stringify({requestId}));
  const expected = row(1), operation = ['status', '--request', requestId];
  f.set({operation, stdout: encode(expected)});
  successful(await f.invoke(['status', directory], {entry: cli}), expected);
  assert.equal(commands(f).at(-1).argv[5], remoteCommand(operation));
  f.set({operation, stdout: paddedList(16385).stdout});
  const rejected = await f.invoke(['status', directory], {entry: cli});
  assert.equal(rejected.exit, 1); assert.equal(rejected.stdout.length, 0);
  assert.equal(rejected.stderr, 'Skill request failed: robot_response_too_large\n');
  assert.deepEqual(JSON.parse(readFileSync(join(folder, key + '.json'))), {requestId});
});

test('negotiated list does not change the 95000ms SSH deadline or child termination', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  let beginStatus, killed = false, count = 0;
  const started = new Promise(resolve => { beginStatus = resolve; });
  function spawnDouble() {
    const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => { killed = true; };
    if (++count === 1) child.stdin.on('finish', () => { child.stdout.end(encode(info())); setImmediate(() => child.emit('close', 0)); });
    else beginStatus();
    return child;
  }
  const pending = assert.rejects(runSsh(['status', ...common, '--list'], {spawn: spawnDouble}), error => error.code === 'ssh_timeout');
  await started;
  t.mock.timers.tick(94999); assert.equal(killed, false);
  t.mock.timers.tick(1); await pending; assert.equal(killed, true); assert.equal(count, 2);
});
