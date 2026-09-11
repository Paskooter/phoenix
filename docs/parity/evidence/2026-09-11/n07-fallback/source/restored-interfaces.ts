# jiboV2/pegasus:packages/parser/src/interfaces.ts

import { nlu } from '@jibo/interfaces';
import { RobustParserClientConfig } from './robustparser/interfaces';
import { DialogflowClientConfig } from './dialogflow/DialogflowClient';
import { LLMClientConfig } from './llm/LLMClient';
import { ServiceState } from './states';
import { ClientState as DialogflowClientState } from './dialogflow/states';
import { ClientState as LLMClientState } from './llm/states';
import { ClientState as RobustParserClientState, ProcessState as RobustParserProcessState } from './robustparser/states';


export interface ParserServiceConfig {
    robustParser: {
        enabled: boolean;
        startProcess: boolean;
        config: RobustParserClientConfig;
    };
    dialogflow: {
        enabled: boolean;
        config: DialogflowClientConfig;
    };
    llm?: {
        enabled: boolean;
        config: LLMClientConfig;
    };
}

export interface NLUClient<T> {
    handleNLU(request: nlu.NLURequestData): Promise<T>;
}

export interface ServiceStateData {
    state: ServiceState;
    robustParserProcess: RobustParserProcessState;
    robustParserClient: RobustParserClientState;
    dialogflowClient: DialogflowClientState;
    llmClient?: LLMClientState;
}

