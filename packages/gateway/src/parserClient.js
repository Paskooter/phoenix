// Parser client — port of nlu/ParserClient.ts. POSTs an NLU request envelope to
// {parserURL}/v1/parse and unwraps the nested result at response.data.data (gotcha #8).

import { message, ResponseType } from '@phoenix/contracts';
import { writeTrace } from '@phoenix/common';
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
    const body = message(ResponseType.NLU, data); // { type:'NLU', msgID, ts, data }
    const res = await fetch(`${this.parserURL}/v1/parse`, {
      method: 'POST',
      signal: boundedSignal(this.timeoutMs, signalFromOptions(options)),
      headers: { 'content-type': 'application/json', ...writeTrace(trace) },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`parser ${res.status}`);
    const json = await res.json();
    return json.data; // NLUResult
  }
}
