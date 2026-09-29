import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { staticRoutes } from '../src/static.js';

test('the public repoint helper can fetch its SHA-pinned cloud config support file', () => {
  const route = staticRoutes()['GET /robot-client/repoint-cloud-config.cjs'];
  assert.equal(typeof route, 'function');
  let status;
  let body;
  route({ res: {
    writeHead(code) { status = code; },
    end(value) { body = value; },
  } });
  assert.equal(status, 200);
  const digest = createHash('sha256').update(body).digest('hex');
  const script = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../../scripts/robot-ota-repoint.sh'), 'utf8');
  assert.match(script, new RegExp(`CONFIG_PATCHER_SHA256="${digest}"`));
});
