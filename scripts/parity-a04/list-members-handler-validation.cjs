'use strict';

// Executes the actual pinned ListMembers decorators under Node 8.  The
// controller call is the only seam: it records the arguments and returns an
// empty result so Joi/parseCredentials behavior is observable without Mongo.
const Handler = require('/source/compiled/handlers/loop.handler.js').default;

function errorShape(error) {
  return error && {
    name: error.name,
    message: error.message,
    statusCode: error.output && error.output.statusCode || error.statusCode,
    payload: error.output && error.output.payload || null,
  };
}

async function runCase(handler, id, payload, credentials = { id: 'source-owner', friendlyId: null }) {
  const calls = [];
  handler.loopCtrl.listMembers = async (args) => {
    calls.push(args);
    return [];
  };
  let result;
  try {
    result = { status: 200, body: await handler.ListMembers({
      headers: { 'x-amz-credentials': JSON.stringify(credentials) },
      payload,
    }) };
  } catch (error) {
    result = { status: error.output && error.output.statusCode || error.statusCode || 500, error: errorShape(error) };
  }
  return { id, payload, calls, result };
}

async function main() {
  const handler = new Handler({
    config: { features: { coppa: 'off' }, server: {} },
    registry: { get() { return ''; } },
    eventSender: { send() { return Promise.resolve(); } },
  });
  const rows = [];
  rows.push(await runCase(handler, 'empty-object', {}));
  rows.push(await runCase(handler, 'empty-filters', { statusList: [], typeList: [] }));
  rows.push(await runCase(handler, 'status-accepted', { statusList: ['accepted'] }));
  rows.push(await runCase(handler, 'type-incoming', { typeList: ['incoming'] }));
  rows.push(await runCase(handler, 'both-filters', { statusList: ['accepted', 'declined'], typeList: ['outgoing'] }, { id: 'source-owner', friendlyId: 'source-robot' }));
  rows.push(await runCase(handler, 'status-invalid', { statusList: ['bogus'] }));
  rows.push(await runCase(handler, 'status-not-array', { statusList: 'accepted' }));
  rows.push(await runCase(handler, 'type-invalid', { typeList: ['bogus'] }));
  rows.push(await runCase(handler, 'type-not-array', { typeList: 'incoming' }));
  rows.push(await runCase(handler, 'top-null', null));
  rows.push(await runCase(handler, 'top-array', []));
  rows.push(await runCase(handler, 'top-number', 7));
  rows.push(await runCase(handler, 'top-string', 'raw'));
  rows.push(await runCase(handler, 'unknown-field', { ignored: true }));
  process.stdout.write(`${JSON.stringify({
    node: process.version,
    sourceRevision: '6cea43470825657d6a5722162f28c8f233153ee2',
    rows,
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
