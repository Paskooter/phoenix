# jiboV2/pegasus:packages/baseskill/src/GraphSkill.ts@5c0a7390539663ba749d360de348a428c088505c

import { v2 as requester } from 'jibo-command-requester';
import { skill } from '@jibo/interfaces';
import * as utils from '@jibo/utils';
import { BaseSkill } from './BaseSkill';
import { Graph, GraphFactory, GraphManager } from './graph';
import { Data, EnterResponse, NodeResponse, SkillDataSupplement } from './graph/nodes/Node';

const log = new utils.logging.Log();

/**
 * Type-guard check if a given action is a JCP Action.
 * @returns `true` if the action is a JCP Action
 */
export function isJCP(action: skill.action.Action): action is skill.action.JCPAction {
    return (action.type === skill.action.ActionType.JCP);
}

export abstract class GraphSkill<ExitTransition extends string = string> extends BaseSkill implements GraphFactory<ExitTransition> {

    private graph: Graph;

    constructor(name: string) {
        super(name);
        log.debug("GraphSkill constructor running");
        this.graph = this.createGraph();
    }

    protected async handle(req: utils.service.PegasusRequest<skill.request.SkillRequest>): Promise<skill.response.SkillResponse> {
        const body = req.body;
        req.log.debug("GraphSkill handling request: ", body);

        if (!body.data.general || !body.data.general.accountID) {
            throw new Error('Skill request without general.accountID arrived');
        }
        if (!body.data.general.robotID) {
            throw new Error('Skill request without general.robotID arrived');
        }
        if (!body.data.skill) {
            body.data.skill = {
                id: this.name
            };
        }
        if (!body.data.skill.id) {
            body.data.skill.id = this.name;
        }
        if (body.data.skill.id !== this.name) {
            throw new Error(`Incoming skill name doesn't match. This: '${this.name}', incoming: '${body.data.skill.id}'`);
        }

        if (!body.data.result) {
            req.log.warn('Didn\'t have action results when we expected them');
        }

        const data: Data = Object.assign<{}, typeof body.data, SkillDataSupplement>(
            {},
            body.data,
            {
                req,
                log: req.log,
                local: {},
                analytics: {},
                behaviors: {
                    parallel: [],
                    sequence: []
                }
            });

        let nodeResponse: NodeResponse;

        if (body.type === skill.request.MessageType.LISTEN_LAUNCH ||
            body.type === skill.request.MessageType.PROACTIVE_LAUNCH) {
            // If this is a skill launch
            const properties: skill.analytics.SkillEntryAnalyticsData = {
                initial_intent: 'n/a',
                domain: '',
                was_hey_jibo_launch: (body.type === skill.request.MessageType.LISTEN_LAUNCH),
                user_initiated: (body.type === skill.request.MessageType.LISTEN_LAUNCH),
                last_skill: 'n/a',
            };
            this.track(data, skill.analytics.EVENTS.SKILL_ENTRY, properties);
            nodeResponse = await GraphManager.instance.start(this.graph, data);
        } else if (body.type === skill.request.MessageType.LISTEN_UPDATE) {
            // If this is an action result
            nodeResponse = await GraphManager.instance.exitNode(data);
        } else {
            throw new Error(`Unknown request type '${(body as {type: string}).type}'`);
        }

        if (nodeResponse && nodeResponse.redirect) {
            req.log.debug("GraphSkill redirect response");
            return {
                type: skill.response.ResponseType.SKILL_REDIRECT,
                data: Object.assign({}, nodeResponse.redirect, {
                    skill: body.data.skill
                }),
                ts: Date.now(),
                msgID: utils.common.getUUID(),
            };
        }
        else if (nodeResponse && (nodeResponse as EnterResponse).action) {
            req.log.debug("GraphSkill general response");
            const resp = nodeResponse as EnterResponse;
            return {
                type: skill.response.ResponseType.SKILL_ACTION,
                data: {
                    skill: body.data.skill,
                    action: isJCP(resp.action) ? this.injectSupplementalBehaviors(data, resp.action) : resp.action,
                    analytics: data.analytics, // Copy analytics into response from skill data
                    final: resp.final || false,
                    fireAndForget: false,
                },
                ts: Date.now(),
                msgID: utils.common.getUUID(),
            };
        }
        else {
            req.log.debug("GraphSkill final response");
            /**
             * When node returns no action and no redirect,
             * it means that it was the last node and skill transaction is finished
             */
            return {
                type: skill.response.ResponseType.SKILL_ACTION,
                data: {
                    skill: body.data.skill,
                    action: null,
                    analytics: data.analytics, // Copy analytics into response from skill data
                    final: true,
                    fireAndForget: true
                },
                ts: Date.now(),
                msgID: utils.common.getUUID(),
            };
        }
    }

    /**
     * A convenience method to track skill analytics events
     * @param data The on-going session skill data.
     * @param event The name of the event.
     * @param properties An object containing any relevant event properties.
     */
    public track(data: Data, event: string, properties: any={}): void {
        if (!data.analytics) {
            data.analytics = {};
        }
        if (!data.analytics[this.name]) {
            data.analytics[this.name] = [];
        }
        data.analytics[this.name].push({
            event,
            properties
        });
    }

    /**
     * A convenience method to override the current speaker.
     * @param data The on-going session skill data.
     * @param id The ID of the identified Looper to override with.
     */
    public overrideSpeaker(data: Data, id: string): void {
        if (data.runtime && data.runtime.perception) {
            if (!id) {
                log.warn('Intended speaker override ID missing');
            } else {
                log.debug('Speaker override with ID:', id);
            }
            data.runtime.perception.speaker = id;
        } else {
            log.warn('Runtime Perception Context missing or incomplete, unable to update speaker.');
        }
    }

    /**
     * A convenience method to add behaviors to be sent in parallel with main Skill behavior
     * @param data The on-going session skill data.
     * @param behavior The behaviors to be added in parallel.
     */
    public addParallelBehavior(data: Data, behavior: skill.behaviors.SupportedBehaviors): void {
        this._addBehavior(data, behavior, skill.behaviors.SupplementalBehaviorType.Parallel);
    }

    /**
     * A convenience method to add behaviors to be sent in sequence with main Skill behavior
     * @param data The on-going session skill data.
     * @param behavior The behaviors to be added in sequence.
     */
    public addSequenceBehavior(data: Data, behavior: skill.behaviors.SupportedBehaviors): void {
        this._addBehavior(data, behavior, skill.behaviors.SupplementalBehaviorType.Sequence);
    }

    private _addBehavior(data: Data, behavior: skill.behaviors.SupportedBehaviors, type: skill.behaviors.SupplementalBehaviorType): void {
        if (!data.behaviors) {
            data.behaviors = {
                parallel: [],
                sequence: []
            };
        } else {
            if (!data.behaviors.parallel) {
                data.behaviors.parallel = [];
            }
            if (!data.behaviors.sequence) {
                data.behaviors.sequence = [];
            }
        }
        switch (type) {
            case skill.behaviors.SupplementalBehaviorType.Parallel:
                data.behaviors.parallel.push(behavior);
                break;
            case skill.behaviors.SupplementalBehaviorType.Sequence:
                data.behaviors.sequence.push(behavior);
                break;
        }
    }

    /**
     * Provided a Skill Action, inject any supplemental behaviors that have been added by the skill
     * along the way.
     *
     * Behaviors are injected in the following way:
     *   1. If there are supplemental sequence behaviors, create a new sequence behavior starting
     *      with the supplemental sequence behaviors and ending with main skill behavior.
     *   2. If there are supplemental parallel behaviors, create a new parallel behavior starting
     *      with the supplemental parallel behaviors and ending with either the main skill behavior
     *      or the the just-created sequence (which itself contains the main skill behavior).
     */
    private injectSupplementalBehaviors(data: Data, action: skill.action.JCPAction): skill.action.JCPAction {
        let behavior: skill.behaviors.SupportedBehaviors = action.config.jcp;
        if (data.behaviors.sequence.length) {
            const behaviors = [...data.behaviors.sequence, behavior];
            behavior = requester.structural.Sequence.generateProtocol(behaviors);
        }
        if (data.behaviors.parallel.length) {
            const behaviors = [...data.behaviors.parallel, behavior];
            behavior = requester.structural.Parallel.generateProtocol(behaviors);
        }
        action.config.jcp = behavior;
        return action;
    }

    /**
     * Builds a new instance of a graph with all new instances of nodes
     */
    abstract createGraph(): Graph<ExitTransition>;
}
