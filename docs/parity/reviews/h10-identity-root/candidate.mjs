import fs from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
const { preprocessContext } = await import(pathToFileURL(`${process.env.PHOENIX_ROOT || fileURLToPath(new URL('../../../../', import.meta.url))}/packages/gateway/src/preprocessor.js`));
const fixture = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const clone = value => JSON.parse(JSON.stringify(value));
const cases = {};
for (const spec of fixture.cases) {
  const message = clone(spec.message);
  const auth = Object.hasOwn(spec, 'auth') ? (spec.auth === 'undefined' ? undefined : clone(spec.auth)) : clone(fixture.auth);
  try {
    if (message && message.type === 'CONTEXT') preprocessContext(message, auth, fixture.remoteAddress);
    cases[spec.id] = { ok: true, message };
  } catch (error) {
    cases[spec.id] = { ok: false, error: {name: error.name, message: error.message, constructor: error.constructor.name}, message };
  }
}
fs.writeFileSync(process.argv[3], JSON.stringify({runtime: process.version, cases}, null, 2) + '\n');
