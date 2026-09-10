import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SOURCE_DEFAULT_PORT,
  parseServiceArgs,
  parseServicePort,
  serviceCliPort,
  serviceHelp,
} from '../src/cli.js';

// The pinned source expression, on every service:
//   parseInt(argv['p'] || argv['port'] || process.env.ETCO_server_port || '8080')
// (packages/utils/common/run-service.js + packages/hub/src/cli/start.ts:17-19,
//  packages/parser/src/cli/start.ts:16-17, packages/history|report-skill|... scripts/run-service.js).
test('parseServicePort reproduces the source argv/ETCO_server_port precedence and parseInt', () => {
  assert.equal(SOURCE_DEFAULT_PORT, '8080');
  assert.equal(parseServicePort([], {}), 8080);
  assert.equal(parseServicePort([], { ETCO_server_port: '8123' }), 8123);
  assert.equal(parseServicePort(['-p', '1234'], { ETCO_server_port: '8123' }), 1234);
  assert.equal(parseServicePort(['--port', '2345'], { ETCO_server_port: '8123' }), 2345);
  assert.equal(parseServicePort(['--port=3456'], {}), 3456);
  assert.equal(parseServicePort(['--p', '3457'], {}), 3457);
  assert.equal(parseServicePort(['--p=3458'], {}), 3458);
  assert.equal(parseServicePort(['-p=4567'], {}), 4567);
  assert.equal(parseServicePort(['-p', '4567', '--port', '5678'], { ETCO_server_port: '6789' }), 4567);
  // minimist coerces numeric-looking argv, so an explicit 0 is falsy and falls through.
  assert.equal(parseServicePort(['--port', '0'], { ETCO_server_port: '7890' }), 7890);
  assert.equal(parseServicePort(['--port=0'], { ETCO_server_port: '7890' }), 7890);
  assert.equal(parseServicePort(['--port', '08tail'], {}), 8);
  assert.equal(parseServicePort(['--port', '0x10'], {}), 16);
  assert.ok(Number.isNaN(parseServicePort([], { ETCO_server_port: 'invalid' })));
});

test('generic argv parsing keeps the pinned minimist shape', () => {
  assert.deepEqual(parseServiceArgs(['--port', '8123', '--port', '9234']), { _: [], port: [8123, 9234] });
  assert.deepEqual(parseServiceArgs(['-xp8765']), { _: [], x: 'p8765' });
  assert.deepEqual(parseServiceArgs(['one', '2', '--', '3']), { _: ['one', 2, '3'] });
  assert.deepEqual(parseServiceArgs(['--help']), { _: [], help: true });
  // The historical dotted setter must not reintroduce prototype pollution.
  parseServiceArgs(['--__proto__.polluted=yes', '--constructor.prototype.polluted=yes']);
  assert.equal({}.polluted, undefined);
});

test('serviceCliPort keeps source inputs first and the Phoenix default last', () => {
  assert.equal(serviceCliPort({ args: [], env: {}, fallback: 7010 }), 7010);
  assert.equal(serviceCliPort({ args: [], env: { PORT: '9123' }, fallback: 7010 }), 9123);
  // ETCO_server_port is a source input; PORT is a Phoenix deployment alias, so the
  // source name wins when both are present.
  assert.equal(serviceCliPort({ args: [], env: { PORT: '9123', ETCO_server_port: '8123' }, fallback: 7010 }), 8123);
  assert.equal(serviceCliPort({ args: ['-p', '4321'], env: { PORT: '9123', ETCO_server_port: '8123' }, fallback: 7010 }), 4321);
  // PORT is still coerced the way programmatic start() did: 0 falls back.
  assert.equal(serviceCliPort({ args: [], env: { PORT: '0', ETCO_server_port: '' }, fallback: 7010 }), 7010);
});

test('serviceHelp renders the source usage; the hub variant omits [options]', () => {
  assert.equal(
    serviceHelp('/opt/report-skill/run-service.js'),
    'Usage: run-service.js [options]\n  Options:\n  --port, -p: [default: 8080] Port of service',
  );
  assert.equal(
    serviceHelp('/opt/hub/src/index.js', { options: false }),
    'Usage: index.js\n  Options:\n  --port, -p: [default: 8080] Port of service',
  );
});
