# jiboV2/pegasus:packages/baseskill/src/graph/mims/utils/unify/Unify.ts@5c0a7390539663ba749d360de348a428c088505c

import { logging } from '@jibo/utils';
import { Data } from '../../../nodes/Node';
import { loadMims } from '../Utils';
import {
    MimConfig,
    UnifyDataOptions
} from '../../common/Types';


/**
 * Resultant data from loading the skill and base MIMs for unification
 * @hidden
 */
interface ResolvedUnifyData {
    /** Resovled and loaded skill provided MIM */
    skillMim: MimConfig;
    /** Resovled and loaded base MIM */
    baseMim: MimConfig;
}

/**
 * Unifies a skill provided MIM with a base MIM into one
 * @param options Options around how the MIMs are to be unified.
 * @param data Current skill data
 * @returns Unified MIM
 */
export async function unifyMims(options: UnifyDataOptions, data: Data): Promise<MimConfig> {
    const log = data.log.createChild('Unifier');
    if (!options.baseProvider) {
        throw new Error('Missing base MIM for unification.');
    }
    const mims = await loadAndPrep(options, data, log);

    let unifiedMim: MimConfig;
    if (options.transform && mims.skillMim) {
        try {
            unifiedMim = options.transform(data, mims.skillMim, mims.baseMim);
        } catch (error) {
            log.warn('Provided MIM unification transform function threw an error; switching to default merge strategy.', error);
        }
    }
    return unifiedMim ? unifiedMim : injectPromptsIntoBase(mims.skillMim, mims.baseMim, log);
}

/**
 * Applies the default unification strategy -- skill MIM prompts overriding the base MIM prompts
 * @param skillMim Skill provided MIM to be unified
 * @param baseMim Base MIM the Skill provided MIM is unified with
 * @param log Curent log instance
 */
function injectPromptsIntoBase(skillMim: MimConfig, baseMim: MimConfig, log: logging.Log): MimConfig {
    if (!skillMim) {
        log.warn(`No MIM was provided by the skill, this isn't recommended; defaulting to base MIM defaults.`);
    } else if (skillMim && !skillMim.prompts) {
        log.warn(`Skill provided MIM contains no prompts; defaulting to base MIM defaults.`);
    } else {
        // Inject skill provided prompts into the base MIM
        baseMim.prompts = skillMim.prompts;
    }
    return baseMim;
}

/**
 * Resolve and load MIMs to be unified
 * @param options Options around how the MIMs are to be unified.
 * @param data Current skill data
 * @param log Current log instance
 */
async function loadAndPrep(options: UnifyDataOptions, data: Data, log: logging.Log): Promise<ResolvedUnifyData> {
    // Load skill's provided MIM for unification from disk
    const skillMims = await loadMims(options.mimProvider, data);

    // Load base MIM for unification from disk
    const baseMims = await loadMims(options.baseProvider, data);

    if (skillMims.length > 1) {
        log.warn(`More than 1 MIM was provided by the skill; defaulting to the 1st.`);
    }
    if (!baseMims.length) {
        throw new Error('Missing base MIM provided.');
    }

    return {
        skillMim: skillMims.length ? skillMims[0] : null,
        baseMim: baseMims[0],
    };
}