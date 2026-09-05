'use strict';

const fs = require('fs');
const { writeCapture } = require('./capture-writer.cjs');

async function main() {
  const out = process.argv[2];
  if (!out) throw new Error('Usage: capture-writer-large.cjs OUTPUT');
  const megabyte = 'x'.repeat(1024 * 1024);
  const report = { schemaVersion: 2, cases: [] };
  for (let index = 0; index < 270; index++) report.cases.push({ id: index, payload: megabyte });
  await writeCapture(out, report);
  const bytes = fs.statSync(out).size;
  if (bytes <= 256 * 1024 * 1024) throw new Error('Expected output larger than 256 MiB, got ' + bytes);
  const fd = fs.openSync(out, 'r');
  const first = Buffer.alloc(1), last = Buffer.alloc(1);
  fs.readSync(fd, first, 0, 1, 0);
  fs.readSync(fd, last, 0, 1, bytes - 1);
  fs.closeSync(fd);
  if (first.toString() !== '{' || last.toString() !== '\n') throw new Error('Output boundary is not JSON plus newline');
  console.log(JSON.stringify({ bytes, greaterThan256MiB: true, runtime: process.version }));
  if (!process.env.KEEP_CAPTURE_OUTPUT) fs.unlinkSync(out);
}

main().catch(error => { console.error(error.stack); process.exitCode = 1; });
