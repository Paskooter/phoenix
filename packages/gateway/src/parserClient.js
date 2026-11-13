// Parser client — port of nlu/ParserClient.ts. POSTs an NLU request envelope to
// {parserURL}/v1/parse and unwraps the nested result at response.data.data (gotcha #8).

import { message, ResponseType } from '@phoenix/contracts';
import { createParserBoundary, PARSER_REQUEST_HEADER, writeTrace } from '@phoenix/common';
import { boundedSignal, DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS, signalFromOptions } from './requestSignal.js';

export class ParserClient {
  constructor(parserURL, options = {}) {
    this.parserURL = parserURL.replace(/\/$/, '');
    this.timeoutMs = typeof options === 'number'
      ? options
      : (options.timeoutMs ?? (DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS + 1000));
  }

  /**
   * @param {{text:string, rules:string[], loop?:object, external?:object}} data
   * @param {object} [trace]
   * @returns {Promise<{rules:string[], intent:(string|null), entities:object, external?:object}>}
   */
  async handleNLU(data, trace, options) {
    // The real Gateway wait owns this observer; direct callers get a fresh one.
    // Never derive a request ID from data, trace, or the caller's identity.
    const boundary = createParserBoundary('gateway', options?.parserBoundary);
    let status = 0;
    let outcome = 'error';
    let signal;
    let onAbort;
    try {
      const parent = signalFromOptions(options);
      signal = boundedSignal(this.timeoutMs, parent);
      onAbort = () => boundary.interrupt(parent?.aborted && signal.reason === parent.reason ? 'cancelled' : 'request_deadline');
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
      const body = message(ResponseType.NLU, data); // { type:'NLU', msgID, ts, data }
      const request = {
        method: 'POST',
        signal,
        headers: { 'content-type': 'application/json', ...writeTrace(trace), [PARSER_REQUEST_HEADER]: boundary.requestId },
        body: JSON.stringify(body),
      };
      outcome = 'transport_error';
      const res = await fetch(`${this.parserURL}/v1/parse`, request);
      status = res.status;
      if (!res.ok) {
        outcome = 'http_error';
        throw new Error(`parser ${res.status}`);
      }
      outcome = 'decode_error';
      const json = await res.json();
      const result = json.data; // NLUResult; unwrapping itself can still throw.
      boundary.complete('ok', status);
      return result;
    } catch (error) {
      // An observed abort does not erase a later HTTP/decode/transport failure.
      // Match only the actual rejection reason; never inspect raw error text.
      boundary.complete(signal?.aborted && error === signal.reason ? 'aborted' : outcome, status);
      throw error;
    } finally {
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    }
  }
}
