import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { gzipSync } from 'node:zlib';
import { createService } from '../src/service.js';

function request(port, { method = 'GET', path, body, contentType, headers: extraHeaders = {} } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { ...extraHeaders };
    if (body !== undefined) {
      headers['content-length'] = Buffer.byteLength(body);
      if (contentType) headers['content-type'] = contentType;
    }
    const req = http.request({ hostname: '127.0.0.1', port, method, path, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        rawBody: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

test('common HTTP service preserves the reference JSON and error boundary contract', async () => {
  const service = createService({
    name: 'common-contract-test',
    routes: {
      'GET /null': async () => null,
      'GET /undefined': async () => undefined,
      'GET /array': async () => [null, false, 0, ''],
      'POST /echo': async ({ body }) => body,
      'PUT /raw': Object.assign(async ({ req, body, res }) => {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        res.status(200).json({ body, raw: Buffer.concat(chunks).toString('utf8') });
      }, { rawBody: true }),
      'GET /typed-error': async () => {
        const error = new Error('fixture teapot');
        error.statusCode = 418;
        throw error;
      },
    },
  });

  await service.listen(0);
  const port = service.server.address().port;
  try {
    const jsonHeaders = (response) => {
      assert.equal(response.headers['x-powered-by'], 'Express');
      assert.equal(response.headers['content-type'], 'application/json; charset=utf-8');
      assert.equal(response.headers['content-length'], String(Buffer.byteLength(response.rawBody)));
    };

    const nullResponse = await request(port, { path: '/null' });
    assert.equal(nullResponse.status, 200);
    assert.equal(nullResponse.rawBody, 'null');
    jsonHeaders(nullResponse);
    assert.equal(nullResponse.headers.etag, 'W/"4-K+iMpCQsduglOsYkdIUQZQMtaDM"');

    const undefinedResponse = await request(port, { path: '/undefined' });
    assert.equal(undefinedResponse.status, 200);
    assert.equal(undefinedResponse.rawBody, '');
    jsonHeaders(undefinedResponse);
    assert.equal(undefinedResponse.headers.etag, undefined);

    const arrayResponse = await request(port, { path: '/array' });
    assert.equal(arrayResponse.status, 200);
    assert.equal(arrayResponse.rawBody, '[null,false,0,""]');
    jsonHeaders(arrayResponse);
    assert.equal(arrayResponse.headers.etag, 'W/"11-BvaXtMXhNd6cFzrt+bAbKxFW91w"');

    const emptyBody = await request(port, {
      method: 'POST', path: '/echo', body: '', contentType: 'application/json',
    });
    assert.equal(emptyBody.status, 200);
    assert.equal(emptyBody.rawBody, '{}');
    jsonHeaders(emptyBody);

    const formBody = await request(port, {
      method: 'POST', path: '/echo', body: 'a=one&a=two',
      contentType: 'application/x-www-form-urlencoded',
    });
    assert.equal(formBody.status, 200);
    assert.deepEqual(JSON.parse(formBody.rawBody), { a: ['one', 'two'] });
    jsonHeaders(formBody);

    const extendedFormBody = await request(port, {
      method: 'POST', path: '/echo',
      body: 'person[name]=Jibo&person[roles][]=robot&person[roles][]=friend',
      contentType: 'application/x-www-form-urlencoded',
    });
    assert.equal(extendedFormBody.status, 200);
    assert.deepEqual(JSON.parse(extendedFormBody.rawBody), {
      person: { name: 'Jibo', roles: ['robot', 'friend'] },
    });
    jsonHeaders(extendedFormBody);
    assert.equal(extendedFormBody.headers.etag, 'W/"35-dt79+l6u328wWA/VVJZsWZRfnrU"');

    const prototypePollution = await request(port, {
      method: 'POST', path: '/echo', body: '__proto__[phxC01Review]=polluted',
      contentType: 'application/x-www-form-urlencoded',
    });
    assert.equal(prototypePollution.status, 200);
    assert.equal(prototypePollution.rawBody, '{}');
    assert.equal(Object.prototype.phxC01Review, undefined);

    const caseInsensitive = await request(port, { path: '/NULL/' });
    assert.equal(caseInsensitive.status, 200);
    assert.equal(caseInsensitive.rawBody, 'null');

    const gzipJson = await request(port, {
      method: 'POST', path: '/echo', body: gzipSync(Buffer.from('{"compressed":true}')),
      contentType: 'application/json', headers: { 'content-encoding': 'gzip' },
    });
    assert.equal(gzipJson.status, 200);
    assert.deepEqual(JSON.parse(gzipJson.rawBody), { compressed: true });

    const unsupportedEncoding = await request(port, {
      method: 'POST', path: '/echo', body: '{"compressed":true}',
      contentType: 'application/json', headers: { 'content-encoding': 'br' },
    });
    assert.equal(unsupportedEncoding.status, 415);
    assert.deepEqual(JSON.parse(unsupportedEncoding.rawBody).data, {
      message: 'unsupported content encoding "br"',
    });

    const formCharset = await request(port, {
      method: 'POST', path: '/echo', body: 'a=one',
      contentType: 'application/x-www-form-urlencoded; charset=latin1',
    });
    assert.equal(formCharset.status, 415);
    assert.deepEqual(JSON.parse(formCharset.rawBody).data, {
      message: 'unsupported charset "LATIN1"',
    });

    const tooManyParameters = await request(port, {
      method: 'POST', path: '/echo',
      body: Array.from({ length: 1001 }, (_, index) => `key${index}=value`).join('&'),
      contentType: 'application/x-www-form-urlencoded',
    });
    assert.equal(tooManyParameters.status, 413);
    assert.deepEqual(JSON.parse(tooManyParameters.rawBody).data, { message: 'too many parameters' });

    const tooLargeJson = await request(port, {
      method: 'POST', path: '/echo',
      body: JSON.stringify({ value: 'x'.repeat(100 * 1024) }), contentType: 'application/json',
    });
    assert.equal(tooLargeJson.status, 413);
    assert.deepEqual(JSON.parse(tooLargeJson.rawBody).data, { message: 'request entity too large' });

    for (const [body, message] of [
      ['1', 'Unexpected token 1 in JSON at position 0'],
      [' \n1', 'Unexpected token 1 in JSON at position 2'],
    ]) {
      const primitive = await request(port, {
        method: 'POST', path: '/echo', body, contentType: 'application/json',
      });
      assert.equal(primitive.status, 400);
      assert.deepEqual(JSON.parse(primitive.rawBody).data, { message });
    }

    for (const [body, message] of [
      ['{"a":}', 'Unexpected token } in JSON at position 5'],
      ['{}x', 'Unexpected token x in JSON at position 2'],
      ['x{', 'Unexpected token x in JSON at position 0'],
      ['{"x" 1}', 'Unexpected number in JSON at position 5'],
      ['{"x":1 "y":2}', 'Unexpected string in JSON at position 7'],
      ['[1 2]', 'Unexpected number in JSON at position 3'],
      ['{"x":tru}', 'Unexpected token } in JSON at position 8'],
      ['{"x":"}","y":tru}', 'Unexpected token } in JSON at position 16'],
      ['{"a":1,}', 'Unexpected token } in JSON at position 7'],
      ['{"a":true,"b":ttrue}', 'Unexpected token t in JSON at position 15'],
      ['{"a":"\\uZZZZ"}', 'Unexpected token Z in JSON at position 8'],
      ['{"a":1e+}', 'Unexpected token } in JSON at position 8'],
      ['{"a":"line\nfeed"}', 'Unexpected token \n in JSON at position 10'],
      ['{"a":"tab\tvalue"}', 'Unexpected token \t in JSON at position 9'],
      [' \n{bad}', 'Unexpected token b in JSON at position 3'],
      ['{"x":"unterminated}', 'Unexpected end of JSON input'],
      ['{"x":"unterminated\\', 'Unexpected end of JSON input'],
      ['{"x":"bad\\q"}', 'Unexpected token q in JSON at position 10'],
      ['{"x":01}', 'Unexpected number in JSON at position 6'],
      ['{"x":1.}', 'Unexpected token } in JSON at position 7'],
      ['{} \n x', 'Unexpected token x in JSON at position 5'],
      ['{} {}', 'Unexpected token { in JSON at position 3'],
      ['["a",1,2.5-3e2,{"b":true}]', 'Unexpected number in JSON at position 10'],
      ['["a",1,2.5,-xe2,{"b":true}]', 'Unexpected token x in JSON at position 12'],
      ['["a",1,2.5,-e2,{"b":true}]', 'Unexpected token e in JSON at position 12'],
      ['["a",1,2.5,-,e2,{"b":true}]', 'Unexpected token , in JSON at position 12'],
      ['{"a":-}', 'Unexpected token } in JSON at position 6'],
      ['['.repeat(700) + 'x' + ']'.repeat(700), 'Unexpected token x in JSON at position 700'],
    ]) {
      const malformedVariant = await request(port, {
        method: 'POST', path: '/echo', body, contentType: 'application/json',
      });
      assert.equal(malformedVariant.status, 400);
      assert.deepEqual(JSON.parse(malformedVariant.rawBody).data, { message });
    }

    const unsupportedCharset = await request(port, {
      method: 'POST', path: '/echo', body: '{}', contentType: 'application/json; charset=latin1',
    });
    assert.equal(unsupportedCharset.status, 415);
    assert.deepEqual(JSON.parse(unsupportedCharset.rawBody).data, {
      message: 'unsupported charset "LATIN1"',
    });

    for (const contentType of [undefined, 'text/plain']) {
      const ignored = await request(port, {
        method: 'POST', path: '/echo', body: '{"value":1}', contentType,
      });
      assert.equal(ignored.status, 200);
      assert.equal(ignored.rawBody, '{}');
      jsonHeaders(ignored);
    }

    const awsJson = await request(port, {
      method: 'POST', path: '/echo', body: '{"value":1}', contentType: 'application/x-amz-json-1.1',
    });
    assert.equal(awsJson.status, 200);
    assert.deepEqual(JSON.parse(awsJson.rawBody), { value: 1 });
    jsonHeaders(awsJson);

    const malformed = await request(port, {
      method: 'POST', path: '/echo', body: '{', contentType: 'application/json',
    });
    assert.equal(malformed.status, 400);
    jsonHeaders(malformed);
    const malformedMessage = JSON.parse(malformed.rawBody);
    assert.equal(malformedMessage.type, 'ERROR');
    assert.equal(malformedMessage.final, true);
    assert.deepEqual(malformedMessage.data, { message: 'Unexpected end of JSON input' });

    const typedError = await request(port, { path: '/typed-error' });
    assert.equal(typedError.status, 418);
    jsonHeaders(typedError);
    const typedMessage = JSON.parse(typedError.rawBody);
    assert.equal(typedMessage.type, 'ERROR');
    assert.equal(typedMessage.final, true);
    assert.deepEqual(typedMessage.data, { message: 'fixture teapot' });

    const missing = await request(port, { path: '/missing' });
    assert.equal(missing.status, 404);
    jsonHeaders(missing);
    const missingMessage = JSON.parse(missing.rawBody);
    assert.equal(missingMessage.type, 'ERROR');
    assert.equal(missingMessage.final, true);
    assert.deepEqual(missingMessage.data, { message: 'URL not found: /missing' });

    const parserBeforeNotFound = await request(port, {
      method: 'POST', path: '/missing', body: '{', contentType: 'application/json',
    });
    assert.equal(parserBeforeNotFound.status, 400);
    assert.deepEqual(JSON.parse(parserBeforeNotFound.rawBody).data, {
      message: 'Unexpected end of JSON input',
    });

    const rawUpload = await request(port, {
      method: 'PUT', path: '/raw', body: 'binary\u0000payload', contentType: 'application/octet-stream',
    });
    assert.equal(rawUpload.status, 200);
    assert.deepEqual(JSON.parse(rawUpload.rawBody), { body: null, raw: 'binary\u0000payload' });

    const conditional = await request(port, {
      path: '/null', headers: { 'if-none-match': 'W/"4-K+iMpCQsduglOsYkdIUQZQMtaDM"' },
    });
    assert.equal(conditional.status, 304);
    assert.equal(conditional.rawBody, '');
    assert.equal(conditional.headers['content-length'], undefined);
    assert.equal(conditional.headers.etag, 'W/"4-K+iMpCQsduglOsYkdIUQZQMtaDM"');

    const trailingSlash = await request(port, { path: '/null/' });
    assert.equal(trailingSlash.status, 200);
    assert.equal(trailingSlash.rawBody, 'null');
    jsonHeaders(trailingSlash);

    const head = await request(port, { method: 'HEAD', path: '/null' });
    assert.equal(head.status, 200);
    assert.equal(head.rawBody, '');
    assert.equal(head.headers['content-length'], '4');
    assert.equal(head.headers.etag, 'W/"4-K+iMpCQsduglOsYkdIUQZQMtaDM"');

    const options = await request(port, { method: 'OPTIONS', path: '/echo' });
    assert.equal(options.status, 200);
    assert.equal(options.rawBody, 'POST');
    assert.equal(options.headers.allow, 'POST');
    assert.equal(options.headers['content-type'], 'text/html; charset=utf-8');

    const unsupportedMethod = await request(port, { method: 'PUT', path: '/null' });
    assert.equal(unsupportedMethod.status, 404);
    assert.deepEqual(JSON.parse(unsupportedMethod.rawBody).data, {
      message: 'URL not found: /null',
    });

    const health = await request(port, { path: '/healthcheck' });
    assert.equal(health.status, 200);
    assert.equal(health.rawBody, 'ok');
    assert.equal(health.headers['x-powered-by'], 'Express');
    assert.equal(health.headers['content-type'], 'text/html; charset=utf-8');
    assert.equal(health.headers['content-length'], '2');
    assert.equal(health.headers.etag, 'W/"2-eoX0dku9ba8cNUXvu/DyeabcC+s"');

    const healthTrailingSlash = await request(port, { path: '/healthcheck/' });
    assert.equal(healthTrailingSlash.status, 200);
    assert.equal(healthTrailingSlash.rawBody, 'ok');

    const healthHead = await request(port, { method: 'HEAD', path: '/healthcheck' });
    assert.equal(healthHead.status, 200);
    assert.equal(healthHead.rawBody, '');
    assert.equal(healthHead.headers['content-length'], '2');

    const healthOptions = await request(port, { method: 'OPTIONS', path: '/healthcheck' });
    assert.equal(healthOptions.status, 404);
    assert.deepEqual(JSON.parse(healthOptions.rawBody).data, {
      message: 'URL not found: /healthcheck',
    });

    const healthUnsupportedMethod = await request(port, { method: 'POST', path: '/healthcheck' });
    assert.equal(healthUnsupportedMethod.status, 404);
    assert.deepEqual(JSON.parse(healthUnsupportedMethod.rawBody).data, {
      message: 'URL not found: /healthcheck',
    });
  } finally {
    await new Promise((resolve, reject) => service.server.close((error) => error ? reject(error) : resolve()));
  }
});
