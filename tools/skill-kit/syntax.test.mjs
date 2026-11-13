import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeFile} from './format.mjs';
import {run} from './cli.mjs';
test('exact syntax mode refuses a modern interpreter rather than claiming Node 6 compatibility',()=>{
 assert.throws(()=>nativeFile('entry.js',Buffer.from('throw Error("must not execute")'),process.execPath),/invalid_syntax_runtime/);
 assert.throws(()=>nativeFile('entry.js',Buffer.from('var x = 1;'),'node'),/invalid_syntax_runtime/);
});
test('host syntax check only compiles valid throwing code, never evaluates it',()=>{
 assert.doesNotThrow(()=>nativeFile('entry.js',Buffer.from('throw Error("must not execute")')));
 assert.throws(()=>nativeFile('entry.js',Buffer.from('var = broken')),/test_native_syntax_invalid/);
});
