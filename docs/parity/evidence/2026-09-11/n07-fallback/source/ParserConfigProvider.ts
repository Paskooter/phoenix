# jiboV2/pegasus:packages/parser/src/ParserConfigProvider.ts@5c0a7390539663ba749d360de348a428c088505c

import { ParserServiceConfig } from './interfaces';
import { ConfigUtils } from './utils/ConfigUtils';


/**
 * Its responsibility is to read environment variables
 * and to return ParserServiceConfig
 */
export class ParserConfigProvider {

    /**
     * Config used in scripts/start.js
     */
    static getConfig(useAccessTokenFromEnv?: boolean): ParserServiceConfig {
        const config = ConfigUtils.readConfigSync('default');
        if (useAccessTokenFromEnv) {
            const clientID = process.env.ETCO_parser_dialogflow_key;
            if (!clientID) {
                throw new Error(`Did not find required env variable 'ETCO_parser_dialogflow_key'`);
            }
            config.dialogflow.config.accessToken = clientID;
        }
        return config;
    }

    /**
     * Config used in unit tests
     */
    static getTestConfig(): ParserServiceConfig {
        return ConfigUtils.readConfigSync('tests');
    }
}