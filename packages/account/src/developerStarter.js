// Deterministic ZIPs of fixed public sources, never user-supplied paths.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// The already-published hello-jibo.zip starter: its URL and bytes stay as they are.
export const STARTER_DIR = 'docs/developers/examples/hello-jibo';
export const STARTER_FILES = Object.freeze(['skill.json', 'index.js', 'test.mjs', 'package.json', 'README.md']);
// The skill kit download: its runnable authoring tools, starters and the two
// shared theme-kit format modules they import, with the project license. Tests,
// fixtures and the repository's other sources are deliberately not included.
const SKILL_TEMPLATES = Object.freeze({
  hello: ['README.md', 'app.json', 'entry.js', 'hello.js', 'skill.json'],
  'network-service': ['README.md', 'app.json', 'config.js', 'entry.js', 'skill.json'],
  'touch-ui': ['README.md', 'app.json', 'entry.js', 'hello.js', 'skill.json'],
  voice: ['README.md', 'app.json', 'entry.js', 'hello.js', 'skill.json', 'voice-input.js'],
});
export const SKILL_KIT_FILES = Object.freeze([
  'LICENSE',
  ...['README.md', 'cli.mjs', 'format.mjs', 'native-icons.mjs', 'native-pack.mjs', 'new.mjs', 'project.mjs', 'ssh.mjs'].map(f => 'tools/skill-kit/' + f),
  ...Object.entries(SKILL_TEMPLATES).flatMap(([name, files]) => files.map(f => `tools/skill-kit/templates/${name}/${f}`)),
  'tools/theme-kit/format.cjs',
  'tools/theme-kit/themeFormat.cjs',
]);
export const SKILL_KIT_FOLDER = 'jibo-skill-kit';
const crc = bytes => {
  let value = 0xffffffff;
  for (const byte of bytes) { value ^= byte; for (let i = 0; i < 8; i++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1; }
  return (value ^ 0xffffffff) >>> 0;
};
export function starterFiles(projectDir) {
  return STARTER_FILES.map(path => ({ path, bytes: readFileSync(join(projectDir, STARTER_DIR, path)) }));
}
export function skillKitFiles(projectDir) {
  return SKILL_KIT_FILES.map(path => ({ path, bytes: readFileSync(join(projectDir, path)) }));
}
// Stored entries with a fixed 1980-01-01 timestamp, so equal sources give equal bytes.
function zip(folder, files) {
  const local = [], central = []; let offset = 0;
  for (const file of files) {
    const name = Buffer.from(folder + '/' + file.path), body = file.bytes, sum = crc(body);
    const head = Buffer.alloc(30); head.writeUInt32LE(0x04034b50); head.writeUInt16LE(20, 4);
    head.writeUInt16LE(33, 12); head.writeUInt32LE(sum, 14); head.writeUInt32LE(body.length, 18); head.writeUInt32LE(body.length, 22); head.writeUInt16LE(name.length, 26);
    const record = Buffer.alloc(46); record.writeUInt32LE(0x02014b50); record.writeUInt16LE(20, 4); record.writeUInt16LE(20, 6);
    record.writeUInt16LE(33, 14); record.writeUInt32LE(sum, 16); record.writeUInt32LE(body.length, 20); record.writeUInt32LE(body.length, 24); record.writeUInt16LE(name.length, 28); record.writeUInt32LE(offset, 42);
    local.push(head, name, body); central.push(record, name); offset += head.length + name.length + body.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
export function starterZip(projectDir) {
  return zip('hello-jibo', starterFiles(projectDir));
}
export function skillKitZip(projectDir) {
  return zip(SKILL_KIT_FOLDER, skillKitFiles(projectDir));
}
