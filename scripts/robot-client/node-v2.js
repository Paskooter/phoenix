var Jibo = require('../core');
var fs = require('fs');
var Stream = Jibo.util.nodeRequire('stream').Stream;
var WritableStream = Jibo.util.nodeRequire('stream').Writable;
var ReadableStream = Jibo.util.nodeRequire('stream').Readable;
require('../http');

/**
 * @api private
 */
Jibo.NodeHttpClient = Jibo.util.inherit({
  handleRequest: function handleRequest(httpRequest, httpOptions, callback, errCallback) {
    var self = this;
    var cbAlreadyCalled = false;
    var endpoint = httpRequest.endpoint;
    var pathPrefix = '';
    if (!httpOptions) httpOptions = {};
    if (httpOptions.proxy) {
      pathPrefix = endpoint.protocol + '//' + endpoint.hostname;
      if (endpoint.port !== 80 && endpoint.port !== 443) {
        pathPrefix += ':' + endpoint.port;
      }
      endpoint = new Jibo.Endpoint(httpOptions.proxy);
    }

    var useSSL = endpoint.protocol === 'https:';
    var http = useSSL ? require('https') : require('http');
    var options = {
      host: endpoint.hostname,
      port: endpoint.port,
      method: httpRequest.method,
      headers: httpRequest.headers,
      path: pathPrefix + httpRequest.path
    };

    if (useSSL && !httpOptions.agent) {
      options.agent = this.sslAgent();
    }

    Jibo.util.update(options, httpOptions);
    delete options.proxy; // proxy isn't an HTTP option
    delete options.timeout; // timeout isn't an HTTP option

    var stream = http.request(options, function (httpResp) {
      if (cbAlreadyCalled) return; cbAlreadyCalled = true;

      callback(httpResp);
      httpResp.emit('headers', httpResp.statusCode, httpResp.headers);
    });
    httpRequest.stream = stream; // attach stream to httpRequest

    // timeout support
    stream.setTimeout(httpOptions.timeout || 0, function() {
      if (cbAlreadyCalled) return; cbAlreadyCalled = true;

      var msg = 'Connection timed out after ' + httpOptions.timeout + 'ms';
      errCallback(Jibo.util.error(new Error(msg), {code: 'TimeoutError'}));
      stream.abort();
    });

    stream.on('error', function() {
      if (cbAlreadyCalled) return; cbAlreadyCalled = true;
      errCallback.apply(this, arguments);
    });

    var expect = httpRequest.headers.Expect || httpRequest.headers.expect;
    if (expect === '100-continue') {
      stream.on('continue', function() {
        self.writeBody(stream, httpRequest);
      });
    } else {
      this.writeBody(stream, httpRequest);
    }

    return stream;
  },

  writeBody: function writeBody(stream, httpRequest) {
    var body = httpRequest.body;
    if (!(body instanceof Stream)) body = Jibo.util.buffer.toStream(body);
    if (body instanceof Stream) { // progress support
      var totalBytes = httpRequest.headers['Content-Length'];
      var numBytes = 0;
      body.on('data', function(chunk) {
        numBytes += chunk.length;
        stream.emit('sendProgress', {
          loaded: numBytes, total: totalBytes
        });
      });
      body.pipe(stream);
    } else if (body) {
      stream.end(body);
    } else {
      stream.end();
    }
  },

  sslAgent: function sslAgent() {
    var https = require('https');

    if (!Jibo.NodeHttpClient.sslAgent) {
      var agentOptions = {rejectUnauthorized: true};
      var caPath = process.env.JIBO_EXTRA_CA_CERTS || __dirname + '/phoenix-ca.pem';

      // An explicit path is authoritative: let readFileSync surface a
      // missing or unreadable deployment certificate instead of silently
      // falling back to Node's built-in roots.  The bundled path is
      // optional so installations without the Phoenix CA retain the
      // upstream agent behavior.
      if (process.env.JIBO_EXTRA_CA_CERTS || fs.existsSync(caPath)) {
        agentOptions.ca = fs.readFileSync(caPath);
      }

      Jibo.NodeHttpClient.sslAgent = new https.Agent(agentOptions);
      Jibo.NodeHttpClient.sslAgent.setMaxListeners(0);

      // delegate maxSockets to globalAgent
      Object.defineProperty(Jibo.NodeHttpClient.sslAgent, 'maxSockets', {
        enumerable: true,
        get: function() { return https.globalAgent.maxSockets; }
      });
    }
    return Jibo.NodeHttpClient.sslAgent;
  },

  progressStream: function progressStream(stream, httpRequest) {
    var numBytes = 0;
    var totalBytes = httpRequest.headers['Content-Length'];
    var writer = new WritableStream();
    writer._write = function(chunk, encoding, callback) {
      if (chunk) {
        numBytes += chunk.length;
        stream.emit('sendProgress', {
          loaded: numBytes, total: totalBytes
        });
      }
      stream.write(chunk, encoding, callback);
    };
    return writer;
  },

  emitter: null
});

/**
 * @!ignore
 */

/**
 * @api private
 */
Jibo.HttpClient.prototype = Jibo.NodeHttpClient.prototype;

/**
 * @api private
 */
Jibo.HttpClient.streamsApiVersion = ReadableStream ? 2 : 1;
