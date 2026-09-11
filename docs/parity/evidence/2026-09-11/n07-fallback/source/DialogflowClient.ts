# jiboV2/pegasus:packages/parser/src/dialogflow/DialogflowClient.ts@5c0a7390539663ba749d360de348a428c088505c

import apiai = require('apiai');
import { google, nlu } from '@jibo/interfaces';
import { common } from '@jibo/utils';
import APIAIOutput = google.nlu.APIAIOutput;
import { NLUClient } from '../interfaces';
import { ClientState } from './states';
import { log as parentLog } from './log';

const logger = parentLog.createChild('Client');

export const DECOY_INTENT = 'decoyIntent';

export interface DialogflowClientConfig {
    accessToken: string;
}

interface ExternalAgentResults {
    [key: string]: nlu.ExternalAgentResult;
}

/**
 * Dialogflow client, handles NLU requests (default result + external agent results)
 */
export class DialogflowClient implements NLUClient<nlu.NLUResult> {

    public state: ClientState = ClientState.DISABLED;

    constructor(private config: DialogflowClientConfig) {}

    public init(): void {
        this.state = ClientState.READY;
    }

    /**
     * Handle NLU request (default result + external agent results)
     */
    public async handleNLU(request: nlu.NLURequestData): Promise<nlu.NLUResult> {
        if (this.state !== ClientState.READY) {
            return null;
        }
        const defaultResultPromise: Promise<nlu.AgentResult> = this.getAgentResult(request.text, 'default', {
            accessToken: this.config.accessToken,
            rules: request.rules
        });
        const otherResultsPromise: Promise<ExternalAgentResults> = this.getOtherResults(request);
        // Here we wait for all the agents
        return Promise.all([defaultResultPromise, otherResultsPromise])
            .then(([defaultResult, otherResults]) => {
                const result: nlu.NLUResult = defaultResult;
                if (request.external) {
                    result.external = otherResults;
                }
                return result;
            });
    }

    private async getOtherResults(input: nlu.NLURequestData): Promise<ExternalAgentResults> {
        if (!input.external) {
            return null;
        }
        const agentResults: ExternalAgentResults = {};
        const promises = Object.keys(input.external).map(name => {
            return this.getAgentResult(input.text, name, input.external[name])
                .then(result => {
                    agentResults[name] = result;
                }).catch(error => {
                    agentResults[name] = {
                        rules: input.external[name].rules,
                        intent: '',
                        entities: {},
                        error: error.message
                    };
                });
        });
        return Promise.all(promises).then(() => agentResults);
    }

    /**
     * Performs Dialogflow agent request for given agent parameters
     * @param text - The text to send to API.ai
     * @param agentName  - The name of the agent
     * @param agent Request params. See [[ExternalAgentRequest]]
     */
    private async getAgentResult(text: string, agentName: string, agent: nlu.ExternalAgentRequest): Promise<nlu.AgentResult> {
        return new Promise<nlu.AgentResult>((resolve, reject) => {
            const rules = agent.rules || [];
            const options = {
                resetContexts: true,
                sessionId: common.getUUID(),
                contexts: rules.map(ruleName => ({
                    name: ruleName,
                    parameters: {}
                })) as [any]
            };
            apiai(agent.accessToken).textRequest(text, options)
                .on('response', (response: APIAIOutput) => {
                    logger.debug('Dialogflow returned %j', response);
                    resolve({
                        rules: agent.rules,
                        intent: response.result.metadata.intentName,
                        entities: response.result.parameters
                    });
                })
                .on('error', error => {
                    reject(new Error(`Error accessing Dialogflow agent '${agentName}': ${error.message}`));
                })
                .end();
        });
    }
}
