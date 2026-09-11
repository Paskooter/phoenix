# jiboV2/pegasus:packages/baseskill/src/graph/Utils.ts@5c0a7390539663ba749d360de348a428c088505c

import { skill } from '@jibo/interfaces';


export function makeUnique(list: string[]): string[] {
    const set = new Set<string>(list);
    const out = new Array(set.size);
    set.forEach(e => out.push(e));
    return out;
}

export function equal(setA: Set<string>, setB: Set<string>): boolean {
    if (setA.size !== setB.size) {
        return false;
    }

    return Array.from(setA).some(e => !setB.has(e));
}

export function generateTransitions<T>(transitionEnum: Object): T[] {
    return Object.keys(transitionEnum).map(key => transitionEnum[key]).filter(key => (typeof key === 'string'));
}

/**
 * Generate a JCP Action containing either a single SLIM behavior or a Sequence of behaviors.
 * @param behavior - JCP behavior to be wrapped as a JCP Action.
 * @returns [[JCPAction]]
 */
export function generateJCPAction(behavior: skill.behaviors.SupportedBehaviors): skill.action.JCPAction {
    return {
        type: skill.action.ActionType.JCP,
        config: {
            version: '2.0',
            jcp: behavior
        }
    };
}