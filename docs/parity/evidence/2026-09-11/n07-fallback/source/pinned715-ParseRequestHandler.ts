# jiboV2/pegasus:packages/parser/src/handlers/ParseRequestHandler.ts@715e0dd0719ecca5164959d713862a1402430623

import * as utils from '@jibo/utils';
import logging = utils.logging;
import HttpError = utils.http.HttpError;
import { nlu } from '@jibo/interfaces';
import { ParserService } from '../ParserService';
import { RobustParserNLUResult } from '../robustparser/interfaces';
import { DECOY_INTENT } from '../dialogflow/DialogflowClient';
import { LoopMemberDetector } from '../utils/LoopMemberDetector';


const EMPTY_NLU: nlu.NLUResult = {
    intent: null,
    entities: null,
    rules: []
};


export class ParseRequestHandler extends utils.service.BaseHttpHandler {

    constructor(private service: ParserService){
        super();
        this.addPostHandler('/', (data: nlu.NLURequest, req: utils.service.PegasusRequest) => this.handleParseRequest(req));
    }

    private async handleParseRequest(req: utils.service.PegasusRequest<nlu.NLURequest>): Promise<nlu.NLUResponse> {
        req.log = req.log.createChild('parse');
        req.log.debug(`Parse request arrived: %j`, req.body);
        if (!req.body || !req.body.data || (typeof req.body.data.text !== 'string')) {
            throw new HttpError('Bad request: ' + JSON.stringify(req.body), 400);
        }
        const result: nlu.NLUResult = await this.getNLUResult(req.body.data, req.log);
        LoopMemberDetector.detectLoopMembers(req.body.data, result);
        return {
            type: 'NLU',
            msgID: utils.common.getUUID(),
            ts: Date.now(),
            data: result
        };
    }

    /**
     * 2026 restoration: hybrid NLU pipeline.
     *  - Stage 1: robust-parser FSTs (sub-ms, deterministic). If a HIGH-priority
     *    match comes back, return immediately and skip the LLM round-trip.
     *  - Stage 2: LLM fallback (LM Studio / Gemma) only when stage 1 missed or
     *    came back LOW-priority. Replaces the dead Dialogflow slot.
     */
    private async getNLUResult(data: nlu.NLURequestData, log: logging.Log): Promise<nlu.NLUResult> {
        data.text = data.text.trim();
        if (!data.text.length) {
            log.info('Received empty text, returning empty NLU results');
            return EMPTY_NLU;
        }

        // Stage 1: robust-parser FSTs.
        let parserResult: RobustParserNLUResult = null;
        try {
            const t0 = Date.now();
            parserResult = await this.service.getRobustParserNLUResult(data);
            log.info(`Robust parser result (${Date.now() - t0}ms): %j`, parserResult ? parserResult.nlu : 'NONE');
        } catch (err) {
            log.debug('Robust parser error: %s', (err as Error).message);
        }

        if (this.isParserResultValid(parserResult, log) && parserResult.priority === 'HIGH') {
            log.debug('Robust parser priority HIGH; skipping LLM call.');
            return parserResult.nlu;
        }

        // Stage 2: LLM fallback (only on miss/low).
        let llmResult: nlu.NLUResult = null;
        try {
            const t0 = Date.now();
            llmResult = await this.service.getLLMNLUResult(data);
            log.info(`LLM result (${Date.now() - t0}ms): %j`, llmResult);
        } catch (err) {
            log.debug('LLM error: %s', (err as Error).message);
        }

        return this.selectValidResult(parserResult, llmResult, log);
    }

    private selectValidResult(parserResult: RobustParserNLUResult, fallbackResult: nlu.NLUResult, log: logging.Log): nlu.NLUResult {
        if (!this.isParserResultValid(parserResult, log)) {
            parserResult = null;
        }
        if (!this.isFallbackResultValid(fallbackResult, log)) {
            fallbackResult = null;
        }

        if (parserResult && fallbackResult) {
            log.debug(`Robust parser priority was LOW, returning LLM fallback response: %j`, fallbackResult);
            return fallbackResult;
        }
        if (parserResult) {
            log.debug(`No LLM fallback result, returning robust parser response %j`, parserResult);
            return parserResult.nlu;
        }
        if (fallbackResult) {
            log.debug(`No robust parser result, returning LLM fallback response %j`, fallbackResult);
            return fallbackResult;
        }
        return EMPTY_NLU;
    }

    private isParserResultValid(parserResult: RobustParserNLUResult, log: logging.Log): boolean {
        if (!parserResult) return false;
        if (!parserResult.nlu || !parserResult.nlu.intent) {
            log.debug(`Robust parser intent missing, ignored`);
            return false;
        }
        if (parserResult.priority === 'SKIP') {
            log.debug(`Robust parser priority was SKIP, ignored`);
            return false;
        }
        return true;
    }

    private isFallbackResultValid(fallbackResult: nlu.NLUResult, log: logging.Log): boolean {
        if (!fallbackResult) return false;
        if (!fallbackResult.intent) {
            log.debug(`Fallback intent missing, ignored`);
            return false;
        }
        if (fallbackResult.intent === DECOY_INTENT) {
            log.debug(`Fallback result was ${DECOY_INTENT}, ignored`);
            return false;
        }
        return true;
    }
}
