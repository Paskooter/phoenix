/*
 * Run the pinned @jibo/server validation path with the pinned Hapi 16 error
 * renderer. This is a review fixture only; it does not alter Phoenix or the
 * shared dependency cache. Set PHX_A02_HAPI_NODE_MODULES to the directory
 * containing hapi@16.6.3, joi@10.6.0, and boom@5.2.0.
 */

const fs = require('fs');
const http = require('http');
const path = require('path');

const NODE_MODULES = process.env.PHX_A02_HAPI_NODE_MODULES || '/tmp/a02-hapi/node_modules';
const Hapi = require(path.join(NODE_MODULES, 'hapi'));
const Joi = require(path.join(NODE_MODULES, 'joi'));
const Boom = require(path.join(NODE_MODULES, 'boom'));

const cases = [
  ['missing-body', undefined],
  ['top-null', null],
  ['top-number', 1],
  ['top-boolean', true],
  // Inject receives string payloads as raw entities; quote this one so it is
  // a valid top-level JSON string rather than malformed JSON text.
  ['top-string', '"source-string"'],
  ['payload-null', { payload: null }],
  ['payload-empty', { payload: '' }],
  ['payload-number', { payload: 4 }],
  ['payload-object', { payload: {} }],
  ['omitted-payload', {}],
  ['unknown-key', { payload: 'accepted', extra: true }],
  ['top-array', []],
];

function version(name) {
  return require(path.join(NODE_MODULES, name, 'package.json')).version;
}

function normalizedHeaders(headers) {
  const result = {};
  Object.keys(headers).sort().forEach((name) => {
    if (name === 'date') result[name] = '<runtime-date>';
    else result[name] = headers[name];
  });
  return result;
}

function validate(request, reply) {
  // This is the body of @jibo/server's validatePayload decorator: the source
  // passes the Joi object schema with allowUnknown=true, then wraps the Joi
  // error directly in Boom.badData(err).
  Joi.validate(request.payload, { payload: Joi.string() }, { allowUnknown: true }, (error, value) => {
    if (error) return reply(Boom.badData(error));
    return reply({ accepted: true, payload: value.payload === undefined ? null : value.payload });
  });
}

function networkProbe(server, rawBody) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1',
      port: server.info.port,
      path: '/',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(rawBody),
      },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        rawBody: Buffer.concat(chunks).toString('utf8'),
      }));
      response.on('error', reject);
    });
    request.on('error', reject);
    request.end(rawBody);
  });
}

async function main() {
  const server = new Hapi.Server();
  server.connection({ port: 0 });
  server.route({ method: 'POST', path: '/', handler: validate });
  await new Promise((resolve, reject) => server.start((error) => error ? reject(error) : resolve()));
  const results = [];
  for (const entry of cases) {
    const name = entry[0];
    const payload = entry[1];
    const request = { method: 'POST', url: '/' };
    if (payload !== undefined) request.payload = payload;
    const response = await new Promise((resolve) => server.inject(request, resolve));
    results.push({
      name,
      status: response.statusCode,
      headers: response.headers,
      normalizedHeaders: normalizedHeaders(response.headers),
      body: response.result,
      rawBody: response.payload,
    });
  }
  const output = {
    fixture: 'source-validatePayload-joi-boom-hapi',
    sourceBehavior: '@jibo/server validate.ts -> Joi.validate(..., {allowUnknown:true}) -> Boom.badData(error)',
    packages: { hapi: version('hapi'), joi: version('joi'), boom: version('boom') },
    networkProbe: await networkProbe(server, 'null'),
    cases: results,
  };
  const serialized = `${JSON.stringify(output, null, 2)}\n`;
  if (process.env.PHX_A02_HAPI_VALIDATION_OUT) fs.writeFileSync(process.env.PHX_A02_HAPI_VALIDATION_OUT, serialized);
  else process.stdout.write(serialized);
  await new Promise((resolve) => server.stop({ timeout: 0 }, resolve));
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
