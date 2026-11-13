#!/usr/bin/env node
// Public host-only helper. No cloud API, credentials, installer, or approval endpoint.
import { spawn as spawnProcess } from 'node:child_process';
import { openSync, closeSync, readSync, lstatSync, fstatSync, constants, createReadStream } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, posix, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {parse} from './format.mjs';
import {requireNativeSchema} from './native-icons.mjs';
const COMMANDS = {
  info: [], project: ['kind', 'name', 'client-request-id'],
  check: ['project', 'file'], queue: ['project', 'file', 'client-request-id'],
  status: ['request', 'list'], cancel: ['request', 'client-request-id'],
  resume: ['project', 'client-request-id'], remove: ['project', 'keep-data', 'erase-data', 'client-request-id']
};
export const DEFAULTS = Object.freeze({
  'be-root':'/opt/jibo/Jibo/Skills/@be/be',
  node:'/usr/bin/node',
  'state-root':'/opt/home/jibo-skill/.local/share/phoenix/test-builds'
});
const COMMON = ['robot', 'be-root', 'node', 'state-root'];
const FLAGS = ['list', 'keep-data', 'erase-data'];
const UUID = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
function fail(code) { throw Object.assign(new Error(code), {code}); }
export function quote(value) { return "'" + value.replace(/'/g, "'\\''") + "'"; }
export function parseArgs(argv) {
  const command = argv[0], options = Object.create(null);
  if (!Object.hasOwn(COMMANDS, command)) fail('unknown_command');
  for (let i = 1; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, '');
    if (argv[i] !== '--' + key || !COMMON.concat(COMMANDS[command]).includes(key) || Object.hasOwn(options, key)) fail('invalid_option');
    if (FLAGS.includes(key)) options[key] = true;
    else {
      const value = argv[++i];
      if (typeof value !== 'string' || !value.length || value.startsWith('--') || /[\x00-\x1f\x7f]/.test(value)) fail('invalid_option_value');
      options[key] = value;
    }
  }
  for (const [key,value] of Object.entries(DEFAULTS)) options[key] ??= value;
  for (const key of COMMON) if (!options[key]) fail('missing_' + key.replaceAll('-', '_'));
  if (!/^(?:root@)?[A-Za-z0-9][A-Za-z0-9_.:-]{0,252}$/.test(options.robot)) fail('invalid_robot');
  for (const key of ['be-root', 'node', 'state-root']) {
    const value = options[key];
    if (!posix.isAbsolute(value) || value === '/' || posix.normalize(value) !== value || value.split('/').some(p => p === '..' || p === '.')) fail('invalid_remote_path');
  }
  if (['check', 'queue', 'resume', 'remove'].includes(command) && !new RegExp('^local-project-' + UUID + '$').test(options.project || '')) fail('invalid_project_id');
  if (['check', 'queue'].includes(command) && !options.file) fail('missing_file');
  if (command === 'status' && Boolean(options.request) === Boolean(options.list)) fail('choose_request_or_list');
  if ((command === 'status' && options.request || command === 'cancel') && !new RegExp('^' + UUID + '$').test(options.request || '')) fail('invalid_request_id');
  if (command === 'project' && (!['declarative', 'theme', 'native'].includes(options.kind) || !options.name || options.name.length > 60)) fail('invalid_project');
  if (command === 'remove' && Boolean(options['keep-data']) === Boolean(options['erase-data'])) fail('choose_keep_or_erase_data');
  if (COMMANDS[command].includes('client-request-id')) {
    options['client-request-id'] ||= randomUUID();
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(options['client-request-id'])) fail('invalid_client_request_id');
  }
  return {command, options};
}
function sameFile(a, b) { return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && b.nlink === 1 && b.isFile(); }
function openPack(file, limit) {
  const name = resolve(file), initial = lstatSync(name);
  if (!initial.isFile() || initial.isSymbolicLink() || initial.nlink !== 1 || initial.size < 1 || initial.size > limit) fail('invalid_pack_file');
  const fd = openSync(name, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
  try {
    if (!sameFile(initial, fstatSync(fd))) fail('pack_changed');
    const hash = createHash('sha256'), buffer = Buffer.alloc(65536); let position = 0, size;
    while ((size = readSync(fd, buffer, 0, buffer.length, position)) > 0) { hash.update(buffer.subarray(0, size)); position += size; if (position > limit) fail('pack_too_large'); }
    if (position !== initial.size || !sameFile(initial, fstatSync(fd)) || !sameFile(initial, lstatSync(name))) fail('pack_changed');
    return {fd, name, initial, bytes:position, sha256:hash.digest('hex')};
  } catch (error) { closeSync(fd); throw error; }
}
function remote(options, args, pack, dependencies) {
  return new Promise((resolveResult, reject) => {
    const command = [options.node, posix.join(options['be-root'], 'phoenix-test-cli.js'), ...args, '--state-root', options['state-root'], '--json'].map(quote).join(' ');
    const child = (dependencies.spawn || spawnProcess)('ssh', ['-T', '-l', 'root', '--', options.robot, command], {stdio:['pipe', 'pipe', 'pipe'], shell:false});
    let output = '', errorText = '', done = false, stream, transferError;
    const timeout = setTimeout(() => finish(Object.assign(new Error('ssh_timeout'), {code:'ssh_timeout'})), 95000);
    function finish(error, result) {
      if (done) return; done = true; clearTimeout(timeout);
      if (error) { if (stream) stream.destroy(); child.kill(); reject(error); } else resolveResult(result);
    }
    child.on('error', error => finish(Object.assign(new Error('ssh_unavailable'), {code:'ssh_unavailable', cause:error})));
    child.stdout.on('data', data => { output += data.toString('utf8'); if (Buffer.byteLength(output) > 16384) finish(Object.assign(new Error('robot_response_too_large'), {code:'robot_response_too_large'})); });
    child.stderr.on('data', data => { if (errorText.length < 4096) errorText += data.toString('utf8'); if (dependencies.stderr) dependencies.stderr.write(data); });
    child.stdin.on('error', error => finish(Object.assign(new Error('ssh_stream_failed'), {code:'ssh_stream_failed', cause:error})));
    child.on('close', code => {
      if (done) return;
      try {
        if (transferError) throw transferError;
        let response;
        try { response = JSON.parse(output); } catch (_) { fail(code === 127 || /No such file|not found/.test(errorText) ? 'unsupported_firmware' : 'ssh_or_robot_failed'); }
        if (!response || typeof response.ok !== 'boolean') fail('invalid_robot_response');
        if (!response.ok) fail(typeof response.error === 'string' && /^[a-z0-9_]{1,100}$/.test(response.error) ? response.error : 'robot_request_failed');
        if (code !== 0) fail('ssh_or_robot_failed');
        if (pack && (!sameFile(pack.initial, fstatSync(pack.fd)) || !sameFile(pack.initial, lstatSync(pack.name)))) fail('pack_changed');
        finish(null, response.result);
      } catch (error) { finish(error); }
    });
    if (pack) {
      stream = createReadStream(pack.name, {fd:pack.fd, start:0, autoClose:false});
      stream.on('error', error => finish(error));
      stream.on('end', () => {
        try {
          if (!sameFile(pack.initial, fstatSync(pack.fd)) || !sameFile(pack.initial, lstatSync(pack.name))) fail('pack_changed');
          child.stdin.end();
        } catch (_) {
          transferError = Object.assign(new Error('pack_changed'), {code:'pack_changed'});
          // Do not kill SSH on a complete prefix: EOF would commit the frame.
          // Let the remote CLI observe an extra byte and reject the transport.
          child.stdin.end(Buffer.from([0]));
        }
      });
      stream.pipe(child.stdin, {end:false});
    } else child.stdin.end();
  });
}
export async function run(argv, dependencies = {}) {
  const {command, options} = parseArgs(argv);
  const info = await remote(options, ['info'], null, dependencies);
  if (!info || info.protocol !== 1 || !Array.isArray(info.localKinds)) fail('unsupported_firmware');
  if (info.managerReady !== true) fail(typeof info.unavailableReason === 'string' && /^[a-z0-9_]{1,100}$/.test(info.unavailableReason) ? info.unavailableReason : 'test_manager_unavailable');
  if (info.beRoot !== options['be-root'] || info.stateRoot !== options['state-root'] || info.runtimeNode !== options.node) fail('robot_path_mismatch');
  if (command === 'info') return info;
  if (command === 'project' && !info.localKinds.includes(options.kind)) fail('unsupported_kind');
  let pack;
  try {
    const args = [command === 'project' ? 'create-project' : command];
    for (const key of COMMANDS[command]) {
      if (key === 'file' || !Object.hasOwn(options, key)) continue;
      args.push('--' + key); if (!FLAGS.includes(key)) args.push(options[key]);
    }
    if (options.file) {
      const max = info.limits && info.limits.maxArtifactBytes;
      if (!Number.isSafeInteger(max) || max < 1 || max > 67108864) fail('invalid_robot_limits');
      pack = openPack(options.file, max);
      const header=Buffer.alloc(12);readSync(pack.fd,header,0,12,0);
      if(header.toString('ascii',0,8)==='PHXNAT1\n'){
        const size=header.readUInt32BE(8);if(size<1||size>49152||12+size>=pack.bytes)fail('test_native_metadata_invalid');
        const metadata=Buffer.alloc(size);if(readSync(pack.fd,metadata,0,size,12)!==size)fail('pack_changed');
        requireNativeSchema(info,parse(metadata,4096).schema);
      }
      args.push('--stdin', '--bytes', String(pack.bytes), '--sha256', pack.sha256);
    }
    return await remote(options, args, pack, dependencies);
  } finally { if (pack) { try { closeSync(pack.fd); } catch (error) { if (error.code !== 'EBADF') throw error; } } }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  run(process.argv.slice(2), {stderr:process.stderr}).then(result => {
    process.stdout.write(JSON.stringify({ok:true, result}) + '\n');
  }, error => {
    if(error.ownerMessage)process.stderr.write(error.ownerMessage+'\n');
    process.stderr.write('Local test request failed: ' + (error.code || 'host_io_error') + '\n');
    process.stdout.write(JSON.stringify({ok:false, error:error.code || 'host_io_error'}) + '\n'); process.exitCode = 1;
  });
}
