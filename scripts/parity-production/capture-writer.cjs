'use strict';

const fs = require('fs');
const zlib = require('zlib');

// Keep every string handed to a stream bounded. The report's arrays are written
// one property/item at a time, so no report-wide JSON string or Buffer is made.
const STRING_CHUNK_SIZE = 16 * 1024;

function isUnsupported(value) {
  const type = typeof value;
  return value === undefined || type === 'function' || type === 'symbol';
}

function applyToJSON(value, key) {
  if (value !== null && (typeof value === 'object' || typeof value === 'function') && typeof value.toJSON === 'function') {
    return value.toJSON(key);
  }
  return value;
}

function isHighSurrogate(code) { return code >= 0xd800 && code <= 0xdbff; }
function isLowSurrogate(code) { return code >= 0xdc00 && code <= 0xdfff; }

function streamIsDestroyed(stream) {
  return !!(stream.destroyed || stream.closed || (stream._writableState && stream._writableState.destroyed));
}

function prematureCloseError() {
  const error = new Error('Premature close');
  error.code = 'ERR_STREAM_PREMATURE_CLOSE';
  return error;
}

function writeChunkedString(sink, value) {
  const text = String(value);
  const write = chunk => {
    const pending = sink.write(chunk);
    return pending ? pending : Promise.resolve();
  };
  let position = 0;
  const writePart = async () => {
    await write('"');
    while (position < text.length) {
      let end = Math.min(position + STRING_CHUNK_SIZE, text.length);
      // Do not split a valid UTF-16 surrogate pair. This keeps the bytes equal
      // to JSON.stringify for ordinary Unicode strings.
      if (end < text.length && end > position && isHighSurrogate(text.charCodeAt(end - 1)) && isLowSurrogate(text.charCodeAt(end))) end--;
      const encoded = JSON.stringify(text.slice(position, end));
      await write(encoded.slice(1, -1));
      position = end;
    }
    await write('"');
  };
  return writePart();
}

class StreamSink {
  constructor(target, streams) {
    this.target = target;
    this.streams = streams;
    this.error = null;
    this.ended = false;
    this.waiting = null;
    this.streamStates = [];
    this.done = Promise.all(streams.map(stream => this.waitForFinish(stream)));
    // Node 8 may destroy a generic Writable asynchronously without emitting
    // error or close. Keep checking lifecycle state while a capture is pending,
    // including when no more writes can run because the sink is backpressured.
    this.lifecycleTimer = setInterval(() => this.checkStreams(), 25);
    const stopWatching = () => clearInterval(this.lifecycleTimer);
    this.done.then(stopWatching, stopWatching);
    // A stream can fail while serialization is still running. The current
    // write receives that rejection; this handler prevents an unhandled
    // rejection before close() is reached.
    this.done.catch(() => {});
  }

  waitForFinish(stream) {
    const state = { check: null, abort: null };
    this.streamStates.push(state);
    return new Promise((resolve, reject) => {
      let settled = false;
      let finished = false;
      const cleanup = () => {
        stream.removeListener('finish', onFinish);
        stream.removeListener('error', onError);
        stream.removeListener('close', onClose);
      };
      const settle = (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) {
          this.fail(error);
          reject(error);
        } else {
          resolve();
        }
      };
      const onFinish = () => {
        finished = true;
        settle();
      };
      const onError = error => settle(error);
      const onClose = () => {
        if (!finished) settle(prematureCloseError());
      };
      state.check = () => {
        if (settled) return;
        if (streamIsDestroyed(stream)) onClose();
        else if (stream.writableFinished || (stream._writableState && stream._writableState.finished)) onFinish();
      };
      state.abort = error => settle(error);

      stream.once('finish', onFinish);
      stream.once('error', onError);
      stream.once('close', onClose);
      // A stream may have been destroyed, or may have emitted finish, before
      // this sink was constructed. The state check closes that event race.
      state.check();
    });
  }

  checkStreams() {
    this.streamStates.forEach(state => state.check());
  }

  fail(error) {
    if (!this.error) this.error = error;
    if (this.waiting) {
      const waiting = this.waiting;
      this.waiting = null;
      waiting.reject(this.error);
    }
    return this.error;
  }

  write(chunk) {
    if (this.error) return Promise.reject(this.error);
    if (streamIsDestroyed(this.target)) {
      const error = prematureCloseError();
      this.fail(error);
      return Promise.reject(error);
    }
    let accepted;
    try {
      accepted = this.target.write(chunk);
    } catch (error) {
      this.fail(error);
      return Promise.reject(error);
    }
    // Node 8 can mark a writable destroyed without emitting either `error` or
    // `close` (for example, _write() calling destroy()). Check immediately
    // after write so the backpressure wait cannot become unbounded.
    this.checkStreams();
    if (this.error) return Promise.reject(this.error);
    if (accepted) return null;
    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        this.target.removeListener('drain', onDrain);
        if (this.waiting && this.waiting.resolve === resolve) this.waiting = null;
      };
      const onDrain = () => {
        if (settled) return;
        settled = true;
        cleanup();
        if (this.error) reject(this.error); else resolve();
      };
      const fail = error => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      this.waiting = { resolve, reject: fail };
      this.target.once('drain', onDrain);
      if (this.error) fail(this.error);
    });
  }

  async close() {
    if (this.error) throw this.error;
    if (!this.ended) {
      this.ended = true;
      try { this.target.end(); } catch (error) { this.fail(error); throw error; }
    }
    this.checkStreams();
    if (this.error) throw this.error;
    await this.done;
    if (this.error) throw this.error;
  }

  abort(error) {
    this.fail(error);
    this.streams.forEach(stream => {
      if (!streamIsDestroyed(stream) && typeof stream.destroy === 'function') {
        // Do not pass the error here: Node 8 emits it on a later turn, after
        // the lifecycle listeners may have been cleaned up by this abort.
        try { stream.destroy(); } catch (_) {}
      }
    });
    this.streamStates.forEach(state => state.abort(error));
    return this.done.catch(() => {});
  }
}

function fileSink(out) {
  const file = fs.createWriteStream(out);
  if (!out.endsWith('.gz')) return new StreamSink(file, [file]);
  const gzip = zlib.createGzip();
  gzip.pipe(file);
  return new StreamSink(gzip, [gzip, file]);
}

class BufferedSink {
  constructor(inner) { this.inner = inner; this.chunks = []; this.bytes = 0; }
  write(chunk) {
    if (this.inner.error) return Promise.reject(this.inner.error);
    this.chunks.push(chunk);
    this.bytes += Buffer.byteLength(chunk);
    return this.bytes >= STRING_CHUNK_SIZE ? this.flush() : null;
  }
  flush() {
    if (!this.chunks.length) return null;
    const chunk = this.chunks.join('');
    this.chunks = []; this.bytes = 0;
    return this.inner.write(chunk);
  }
  async close() {
    const pending = this.flush();
    if (pending) await pending;
    await this.inner.close();
  }
  abort(error) {
    this.chunks = []; this.bytes = 0;
    return this.inner.abort(error);
  }
}

// Object traversal needs to decide omission before writing the key. Keep this
// as a separate function so the bounded serializer can preserve object
// omission semantics without building object-wide strings.
async function writeJSONObject(value, sink, stack) {
  let pending = sink.write('{');
  if (pending) await pending;
  let first = true;
  for (const property of Object.keys(value)) {
    const child = applyToJSON(value[property], property);
    if (isUnsupported(child)) continue;
    if (!first) { pending = sink.write(','); if (pending) await pending; }
    first = false;
    await writeChunkedString(sink, property);
    pending = sink.write(':');
    if (pending) await pending;
    await writeJSONValueBounded(child, sink, property, false, stack, true);
  }
  pending = sink.write('}');
  if (pending) await pending;
}

async function writeJSONValueBounded(value, sink, key, arrayItem, stack, prepared) {
  if (!prepared) value = applyToJSON(value, key);
  if (isUnsupported(value)) {
    if (arrayItem) { const pending = sink.write('null'); if (pending) await pending; return true; }
    return false;
  }
  if (value !== null && typeof value === 'object' && !(value instanceof Number || value instanceof String || value instanceof Boolean)) {
    if (stack.has(value)) throw new TypeError('Converting circular structure to JSON');
    stack.add(value);
    try {
      if (Array.isArray(value)) {
        let pending = sink.write('[');
        if (pending) await pending;
        for (let index = 0; index < value.length; index++) {
          if (index) { pending = sink.write(','); if (pending) await pending; }
          await writeJSONValueBounded(value[index], sink, String(index), true, stack);
        }
        pending = sink.write(']');
        if (pending) await pending;
      } else {
        await writeJSONObject(value, sink, stack);
      }
      return true;
    } finally { stack.delete(value); }
  }
  if (value instanceof Number || value instanceof String || value instanceof Boolean) value = value.valueOf();
  if (typeof value === 'string') { await writeChunkedString(sink, value); return true; }
  if (typeof value === 'number') {
    const pending = sink.write(Number.isFinite(value) ? JSON.stringify(value) : 'null');
    if (pending) await pending;
    return true;
  }
  if (typeof value === 'boolean') {
    const pending = sink.write(value ? 'true' : 'false');
    if (pending) await pending;
    return true;
  }
  if (typeof value === 'bigint') throw new TypeError('Do not know how to serialize a BigInt');
  if (value === null) {
    const pending = sink.write('null');
    if (pending) await pending;
    return true;
  }
  throw new TypeError('Unsupported JSON value');
}

async function writeJSONToSink(value, sink) {
  await writeJSONValueBounded(value, sink, '', false, new Set());
  const pending = sink.write('\n');
  if (pending) await pending;
  await sink.close();
}

async function writeJSONToStream(value, stream) {
  const sink = new BufferedSink(new StreamSink(stream, [stream]));
  try {
    await writeJSONToSink(value, sink);
  } catch (error) {
    await sink.abort(error);
    throw error;
  }
}

async function writeCapture(out, report) {
  let sink;
  try {
    sink = new BufferedSink(fileSink(out));
    await writeJSONToSink(report, sink);
  } catch (error) {
    if (sink) await sink.abort(error);
    throw error;
  }
}

module.exports = { writeCapture, writeJSONToStream, writeJSONToSink, StreamSink, STRING_CHUNK_SIZE };
