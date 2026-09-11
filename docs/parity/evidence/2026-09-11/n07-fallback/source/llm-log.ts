# jiboV2/pegasus:packages/parser/src/llm/log.ts

import { logging } from '@jibo/utils';
import Log = logging.Log;
import { log as parentLog } from '../log';
export const log: Log = parentLog.createChild('LLM');
