# jiboV2/pegasus:packages/parser/src/ParserService.ts

import * as utils from '@jibo/utils';
import { nlu } from '@jibo/interfaces';
import { ConfigUtils } from './utils/ConfigUtils';
import { ParseRequestHandler } from './handlers/ParseRequestHandler';
import { StateRequestHandler } from './handlers/StateRequestHandler';
import { RobustParserClient, RobustParserNLUResult, RobustParserProcess } from './robustparser';
import { DialogflowClient } from './dialogflow/DialogflowClient';
import { LLMClient } from './llm/LLMClient';
import { ParserServiceConfig, ServiceStateData } from './interfaces';
import { ServiceState } from './states';
import { log as parentLog } from './log';

const logger = parentLog.createChild('Service');


/**
 * ParserService
 * - starts RobustParserProcess on port 8787
 * - initializes Dialogflow and Robust Parser clients
 * - starts HTTP server on port 8080
 * - handles POST requests to /v1/parse endpoint
 * - shows its state if you go to /state endpoint
 */
export class ParserService extends utils.service.BaseService {

    private state: ServiceState = ServiceState.INITIAL;

    private robustParserProcess: RobustParserProcess;
    private robustParserClient: RobustParserClient;
    private dialogflowClient: DialogflowClient;
    private llmClient: LLMClient;

    /**
     * @param config [[ParserServiceConfig]] - parser confuguration to use
     * @TODO fix integration tests so that during integration tests Robust Parser could be running
     */
    constructor(private config: ParserServiceConfig) {
        super('Parser');

        // set configuration
        ConfigUtils.validateParserServiceConfig(this.config); // Validate in case provided externally

        if (!this.config.robustParser.enabled) {
            logger.warn('-----------------------------------------------');
            logger.warn('ParserService is starting with Dialogflow only ');
            logger.warn('-----------------------------------------------');
        }

        // create clients, they all have status DISABLED by default
        this.robustParserProcess = new RobustParserProcess();
        this.robustParserClient = new RobustParserClient(this.config.robustParser.config);
        this.dialogflowClient = new DialogflowClient(this.config.dialogflow.config);
        this.llmClient = new LLMClient((this.config.llm && this.config.llm.config) || { enabled: false, url: '', model: '' });

        // register HTTP request handlers
        this.addHttpHandler('/v1/parse', {
            handler: new ParseRequestHandler(this)
        });
        this.addHttpHandler('/state', {
            handler: new StateRequestHandler(this)
        });
    }

    /**
     * It overrides init() function from BaseService because before start of HTTP server
     * we should init all clients and start parser process
     */
    public async init(port = 8080): Promise<void> {
        this.state = ServiceState.STARTING;
        await this.initClients();
        await super.init(port);
        this.state = ServiceState.RUNNING;
        logger.info(`Service is started on port ${port}`);
        logger.info(`State: %j`, this.getServiceState());
    }

    /**
     * Stop HTTP server, robust parser client and robust parser process
     */
    public async close(): Promise<void> {
        if (this.robustParserClient) {
            this.robustParserClient.stop();
            this.robustParserClient = null;
        }
        if (this.robustParserProcess) {
            this.robustParserProcess.stop();
            this.robustParserProcess = null;
        }
        await super.close();
    }

    /**
     * It's used to display service state when you do GET request to /state endpoint.
     * Used for debugging and monitoring
     * @returns [[ServiceStateData]]
     */
    public getServiceState(): ServiceStateData {
        return {
            state: this.state,
            robustParserProcess: this.robustParserProcess.state,
            dialogflowClient: this.dialogflowClient.state,
            llmClient: this.llmClient.getState(),
            robustParserClient: this.robustParserClient.state
        };
    }

    /**
     * For not to make robustParserClient public,
     * it just exposes this function for ParseRequestHandler
     */
    public async getRobustParserNLUResult(request: nlu.NLURequestData): Promise<RobustParserNLUResult> {
        return this.robustParserClient.handleNLU(request);
    }

    /**
     * For not to make dialogflowClient public,
     * it just exposes this function for ParseRequestHandler
     */
    public async getDialogflowNLUResult(request: nlu.NLURequestData): Promise<nlu.NLUResult> {
        return this.dialogflowClient.handleNLU(request);
    }

    /**
     * For not to make llmClient public, exposes its handleNLU for ParseRequestHandler.
     */
    public async getLLMNLUResult(request: nlu.NLURequestData): Promise<nlu.NLUResult> {
        return this.llmClient.handleNLU(request);
    }

    /**
     * Start robust parser process and init two clients
     */
    private async initClients(): Promise<void> {
        if (this.config.robustParser.enabled && this.config.robustParser.startProcess) {
            await this.startRobustParserProcess();
        }
        if (this.config.robustParser.enabled) {
            logger.info(`Starting robust parser client`);
            await this.robustParserClient.init();
        }
        if (this.config.dialogflow.enabled) {
            logger.info(`Creating Dialogflow client`);
            this.dialogflowClient.init();
        }
        if (this.config.llm && this.config.llm.enabled) {
            logger.info(`Creating LLM client`);
            this.llmClient.init();
        }
    }

    /**
     * Start robust parser process and on successful start
     * subscribe on "closed" and "error" events of that process
     */
    private async startRobustParserProcess(): Promise<void> {
        logger.info(`Starting robust parser process`);
        await this.robustParserProcess.start();
        this.robustParserProcess.events.closed.on(() => {
            // TODO possibly implement some graceful restart logic
            logger.error(`Robust parser process closed, shutting down Parser service`);
            process.exit(1);
        });
        this.robustParserProcess.events.error.on((error: Error) => {
            // TODO possibly implement some graceful restart logic
            logger.error(`Error in robust parser process, shutting down Parser service`);
            process.exit(1);
        });
    }
}
