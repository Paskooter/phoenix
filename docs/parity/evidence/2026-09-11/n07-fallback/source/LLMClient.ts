# jiboV2/pegasus:packages/parser/src/llm/LLMClient.ts

import * as http from 'http';
import * as urlModule from 'url';
import { nlu } from '@jibo/interfaces';
import { NLUClient } from '../interfaces';
import { ClientState } from './states';
import { log as logger } from './log';

export interface LLMClientConfig {
    enabled: boolean;
    url: string;             // e.g. http://192.168.1.252:1234/v1
    model: string;           // e.g. google/gemma-4-e4b
    timeoutMs?: number;      // default 8000
    temperature?: number;    // default 0
}

const DEFAULT_TIMEOUT_MS = 8000;

interface IntentTool {
    name: string;
    description: string;
    /** Map of entity name -> JSON Schema type */
    entities?: { [key: string]: string };
}

/**
 * Catalog of intents the LLM is allowed to emit. Each maps onto an intent
 * name the hub's IntentRouter already understands. The "unknown" tool is the
 * graceful exit when nothing fits.
 *
 * This list is intentionally small — the LLM is the *fallback*; well-known
 * phrases route through robust-parser FSTs first. Add more tools here as we
 * find the FST gaps.
 */
const INTENT_TOOLS: IntentTool[] = [
    { name: 'whatsUp', description: 'User greets Jibo or asks how Jibo is doing (e.g. "hey", "what\'s up", "how are you").' },
    { name: 'doYouLike', description: 'User asks whether Jibo likes a particular thing.', entities: { thing: 'string' } },
    { name: 'whoAmI', description: 'User asks Jibo to identify them or asks who Jibo is talking to.' },
    { name: 'tellMeAboutYourself', description: 'User asks Jibo to describe Jibo themselves.' },
    { name: 'tellAJoke', description: 'User asks Jibo to tell a joke or be funny.' },
    { name: 'tellMeATip', description: 'User asks Jibo for a tip, fact, or advice.' },
    { name: 'launchSkill', description: 'User asks Jibo to launch or open a specific skill or feature by name.', entities: { skillId: 'string' } },
    { name: 'whatTimeIsIt', description: 'User asks for the current time.' },
    { name: 'thanks', description: 'User thanks Jibo.' },
    { name: 'goodbye', description: 'User says goodbye, bye, or signals end of conversation.' },
    { name: 'cancel', description: 'User wants to stop, cancel, or never mind whatever is happening.' },
    { name: 'yes', description: 'User affirms (yes, yeah, sure, ok).' },
    { name: 'no', description: 'User declines (no, nope, not now).' },
    { name: 'chitchat', description: 'General small-talk that does not match any specific intent above. Catch-all for friendly conversation.' },
    { name: 'unknown', description: 'Could not confidently classify with any of the available intents.' },
];

export class LLMClient implements NLUClient<nlu.NLUResult> {
    private state: ClientState = ClientState.NOT_READY;

    constructor(public config: LLMClientConfig) {}

    init() {
        if (!this.config.enabled) {
            this.state = ClientState.DISABLED;
            logger.info('LLM client disabled by config.');
            return;
        }
        if (!this.config.url || !this.config.model) {
            logger.warn('LLM client missing url/model; staying NOT_READY.');
            this.state = ClientState.NOT_READY;
            return;
        }
        this.state = ClientState.READY;
        logger.info(`LLM client ready at ${this.config.url} (model=${this.config.model})`);
    }

    getState(): ClientState { return this.state; }

    public async handleNLU(request: nlu.NLURequestData): Promise<nlu.NLUResult> {
        if (this.state !== ClientState.READY) {
            return null;
        }

        const tools = INTENT_TOOLS.map(t => ({
            type: 'function',
            function: {
                name: t.name,
                description: t.description,
                parameters: {
                    type: 'object',
                    properties: t.entities
                        ? Object.keys(t.entities).reduce((acc, k) => {
                            acc[k] = { type: t.entities[k] };
                            return acc;
                        }, {} as { [k: string]: { type: string } })
                        : {},
                    required: t.entities ? Object.keys(t.entities) : []
                }
            }
        }));

        const systemPrompt = [
            'You are an NLU intent classifier for the Jibo social robot.',
            'You will be given a single user utterance.',
            'Pick the ONE tool whose description best matches the user\'s intent.',
            'If no tool fits well, call "unknown" with no arguments.',
            'Always call exactly one tool. Do not chain tools.',
            'Extract entity arguments verbatim from the utterance when present.'
        ].join(' ');
        const userPrompt = `Utterance: "${request.text}"`;

        try {
            const t0 = Date.now();
            const response = await this.postChatCompletion({
                model: this.config.model,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt }
                ],
                tools,
                tool_choice: 'auto',
                temperature: this.config.temperature != null ? this.config.temperature : 0
            });
            const ms = Date.now() - t0;
            logger.debug(`LLM round-trip ${ms}ms`);
            return this.parseToolCallResponse(response, request);
        } catch (err) {
            const e = err as Error;
            logger.warn(`LLM call failed: ${e.message}`);
            return null;
        }
    }

    private postChatCompletion(body: any): Promise<any> {
        return new Promise((resolve, reject) => {
            const target = urlModule.parse(this.config.url.replace(/\/$/, '') + '/chat/completions');
            const data = Buffer.from(JSON.stringify(body));
            const req = http.request({
                method: 'POST',
                host: target.hostname,
                port: target.port ? parseInt(target.port, 10) : 80,
                path: target.path,
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': data.length
                }
            }, (res) => {
                const bufs: Buffer[] = [];
                res.on('data', (c: Buffer) => bufs.push(c));
                res.on('end', () => {
                    const text = Buffer.concat(bufs).toString('utf8');
                    if (res.statusCode !== 200) {
                        return reject(new Error(`LLM ${res.statusCode}: ${text.substring(0, 300)}`));
                    }
                    try {
                        resolve(JSON.parse(text));
                    } catch (e) {
                        reject(new Error(`Could not parse LLM JSON: ${e}`));
                    }
                });
            });
            const timeoutMs = this.config.timeoutMs != null ? this.config.timeoutMs : DEFAULT_TIMEOUT_MS;
            req.setTimeout(timeoutMs, () => {
                req.abort();
                reject(new Error(`LLM request timed out after ${timeoutMs}ms`));
            });
            req.on('error', reject);
            req.write(data);
            req.end();
        });
    }

    private parseToolCallResponse(resp: any, request: nlu.NLURequestData): nlu.NLUResult {
        const choice = resp && resp.choices && resp.choices[0];
        const msg = choice && choice.message;
        const tc = msg && msg.tool_calls && msg.tool_calls[0];

        if (!tc || !tc.function || !tc.function.name) {
            logger.debug(`LLM did not call a tool. message.content=${msg && msg.content && msg.content.substring(0, 200)}`);
            return null;
        }

        const intent = tc.function.name;
        if (intent === 'unknown') {
            logger.debug('LLM picked "unknown"; returning empty NLU.');
            return null;
        }

        let entities: any = {};
        try {
            const args = tc.function.arguments;
            if (args) {
                entities = typeof args === 'string' ? JSON.parse(args) : args;
            }
        } catch (e) {
            logger.warn(`Could not parse tool arguments: ${tc.function.arguments}`);
        }

        const result: nlu.NLUResult = {
            intent,
            entities,
            rules: request.rules || []
        } as nlu.NLUResult;
        logger.info(`LLM matched intent="${intent}" entities=${JSON.stringify(entities)} for utterance="${request.text}"`);
        return result;
    }
}
