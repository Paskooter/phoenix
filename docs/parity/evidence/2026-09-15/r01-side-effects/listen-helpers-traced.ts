import { hub, nlu, service, skill } from '@jibo/interfaces';
import { expect } from 'chai';
import { Client, CloudRequestOptions } from '@jibo/hub-client';
import { createContextData } from '@jibo/test-utils';
import { test } from '@jibo/utils';
import * as integration from './integration';


export interface TestOptions {
    port: number;
    auth?: service.IAuthDetails;
    context?: service.BaseData;
    rules?: string[];
    asr?: {
        hints?: string[],
        earlyEOS?: string[]
    };
    agents?: {
        [name: string]: nlu.ExternalAgentRequest
    };
}

export interface SimulatedASRTestOptions extends TestOptions{
    fakeASRText: string;
}

export interface SimulatedNLUTestOptions extends TestOptions {
    fakeNLU: nlu.NLUResult;
}

export interface TestExpectations {
    text?: string[];
    textInclude?: string;
    intent: string;
    skillID?: string;
    skillPrompt?: string;
    agentResponses?: { [name: string]: {
        intent: string;
        error?: string;
    }};
}

const DEFAULT_CREDENTIALS = {
    id: 'accountId',
    accessKeyId: 'accessKeyId',
    secretAccessKey: 'secretAccessKey',
    friendlyId: 'friendlyId'
};


// R-01 side-effect capture seam. With R01_TRACE_DIR set, every message the
// client receives is written out, so a control run and a substituted run can be
// diffed message-for-message rather than only through the suite's assertions.
//
// Captured in the drivers rather than in checkExpectations: a driver always
// returns, while checkExpectations is skipped once an earlier assertion throws,
// which would silently shift the index and align two different transactions.
const __r01Seen: { [key: string]: number } = {};

function __r01Key(kind: string, options: any): string {
    // Key on what the transaction WAS, never on call order. A driver can throw
    // before it returns (an errored transaction rejects first), so one run may
    // write fewer traces than the other -- the control writes 6 and the
    // substituted run 8, because the control's external-agent cases fail with a
    // 500 before the driver returns. Sequence numbers would then align two
    // different transactions and silently compare unrelated streams.
    const parts = [kind];
    if (options && options.fakeASRText) { parts.push(String(options.fakeASRText)); }
    if (options && options.fakeNLU && options.fakeNLU.intent) { parts.push(String(options.fakeNLU.intent)); }
    if (options && options.audioPath) { parts.push(String(options.audioPath)); }
    if (options && options.asr && options.asr.earlyEOS) { parts.push('earlyEOS:' + String(options.asr.earlyEOS)); }
    // Two different tests drive the same utterance -- 'do you like being Jibo'
    // is used both with and without external agents -- so the utterance alone
    // is not a key. Without this the second transaction silently overwrites the
    // first and one of them is never compared at all.
    if (options && options.agents) { parts.push('agents:' + Object.keys(options.agents).sort().join('+')); }
    return parts.join('-').replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 120);
}

function __r01Trace(kind: string, options: any, messages: any[]): void {
    const dir = process.env.R01_TRACE_DIR;
    if (!dir) { return; }
    const fs = require('fs');
    const path = require('path');
    // The suite runs on Node 8.9.4, where mkdirSync has no `recursive` option
    // (Node 10.12+). Passing it silently creates nothing and then throws ENOENT
    // from inside the driver, which fails the test and looks like a finding.
    const parts = dir.split(path.sep).filter(Boolean);
    let built = dir.charAt(0) === path.sep ? path.sep : '';
    for (const part of parts) {
        built = path.join(built, part);
        if (!fs.existsSync(built)) { fs.mkdirSync(built); }
    }
    // Two transactions can be genuinely indistinguishable from inside the
    // driver: the "second Dialogflow agent" and "bad second Dialogflow agent"
    // tests send identical input and differ only in the nock status the driver
    // never sees. Disambiguate by occurrence order, which is stable because
    // both runs execute the same files in the same order -- without it the
    // second silently overwrites the first.
    const key = __r01Key(kind, options);
    __r01Seen[key] = (__r01Seen[key] || 0) + 1;
    const suffix = __r01Seen[key] > 1 ? ('-' + __r01Seen[key]) : '';
    fs.writeFileSync(path.join(dir, key + suffix + '.json'), JSON.stringify(messages, null, 2));
}

export async function simulatedASRTest(options: SimulatedASRTestOptions): Promise<hub.response.Response<any, any>[]> {
    const credentials = options.auth || DEFAULT_CREDENTIALS;
    const cloudOptions: CloudRequestOptions = {
        hostname: 'localhost',
        port: options.port,
        path: '/v1/listen',
        auth: {
            secret: integration.WEB_TOKEN_SECRET,
            credentials: credentials
        }
    };

    const mode: hub.request.ListenMessageMode = options.fakeASRText ?
        hub.request.ListenMessageMode.CLIENT_ASR : undefined;

    const session = await Client.startListenSession(cloudOptions, Object.assign({}, options, {
        mode,
        hotphrase: false,
        rules: options.rules || ['launch'],
        lang: 'en-US' as 'en-US'
    }));

    const errorPromise = new Promise((_, reject) => {
        session.events.on('ERROR', reject);
    });

    if (options && options.context) {
        session.writeContext(options.context);
    } else {
        session.writeContext(createContextData({ credentials }));
    }

    if (options.fakeASRText) {
        session.writeClientASR(options.fakeASRText);
    }

    const messages: hub.response.Response<any, any>[] = [];
    session.events.on('ALL', message => messages.push(message));

    await Promise.race([errorPromise, session.transactionDone]);
    __r01Trace('simulatedASRTest', options, messages);
    return messages;
}

export async function simulatedNLUTest(options: SimulatedNLUTestOptions): Promise<hub.response.Response<any, any>[]> {
    const credentials = options.auth || DEFAULT_CREDENTIALS;
    const cloudOptions: CloudRequestOptions = {
        hostname: 'localhost',
        port: options.port,
        path: '/v1/listen',
        auth: {
            secret: integration.WEB_TOKEN_SECRET,
            credentials: credentials
        }
    };

    const mode: hub.request.ListenMessageMode = options.fakeNLU ?
        hub.request.ListenMessageMode.CLIENT_NLU : undefined;
    const session = await Client.startListenSession(cloudOptions, Object.assign({}, options, {
        mode,
        hotphrase: false,
        rules: options.rules || ['launch'],
        lang: 'en-US' as 'en-US'
    }));

    const errorPromise = new Promise((_, reject) => {
        session.events.on('ERROR', reject);
    });

    if (options && options.context) {
        session.writeContext(options.context);
    } else {
        session.writeContext(createContextData({ credentials }));
    }

    if (options.fakeNLU) {
        session.writeClientNLU(options.fakeNLU);
    }

    const messages: hub.response.Response<any, any>[] = [];
    session.events.on('ALL', message => messages.push(message));

    await Promise.race([errorPromise, session.transactionDone]);
    __r01Trace('simulatedNLUTest', options, messages);
    return messages;
}

export async function audioTest(options: TestOptions, audioPath: string): Promise<hub.response.Response<any, any>[]> {
    const credentials = options.auth || DEFAULT_CREDENTIALS;
    const cloudOptions: CloudRequestOptions = {
        hostname: 'localhost',
        port: options.port,
        path: '/v1/listen',
        auth: {
            secret: integration.WEB_TOKEN_SECRET,
            credentials: credentials
        }
    };

    const session = await Client.startListenSession(cloudOptions, Object.assign({}, options, {
        hotphrase: false,
        rules: ['launch'],
        lang: 'en-US' as 'en-US',
        asr: {
            hints: options.asr && options.asr.hints,
            earlyEOS: options.asr && options.asr.earlyEOS
        }
    }), {
        path: audioPath
    });

    const errorPromise = new Promise((_, reject) => {
        session.events.on('ERROR', reject);
    });

    session.writeContext(createContextData({ credentials }));
    const messages: hub.response.Response<any, any>[] = [];
    session.events.on('ALL', message => messages.push(message));

    await Promise.race([errorPromise, session.transactionDone]);
    __r01Trace('audioTest', Object.assign({ audioPath }, options), messages);
    return messages;
}

export function checkExpectations(messages, expectations: TestExpectations) {
    // console.log(JSON.stringify(messages,null,4));
    let cnt = -1;
    if (expectations.skillPrompt) {
        expect(messages.length).to.equal(4);
    } else {
        expect(messages.length).to.equal(3);
    }

    expect(messages[++cnt].type).to.equal(hub.response.MessageType.SOS);
    expect(messages[++cnt].type).to.equal(hub.response.MessageType.EOS);

    // Listen
    const listenMsg = messages[++cnt];
    expect(listenMsg.type).to.equal(hub.response.MessageType.LISTEN);
    expect(listenMsg.data.nlu.intent).to.equal(expectations.intent);
    expect(typeof listenMsg.timings.total).to.equal('number');
    expect(typeof listenMsg.timings.nlu).to.equal('number');
    expect(typeof listenMsg.timings.asr).to.equal('number');
    if (expectations.text) {
        expect(listenMsg.data.asr.text).to.be.oneOf(expectations.text);
    }
    if (expectations.textInclude) {
        expect(listenMsg.data.asr.text).to.contain(expectations.textInclude);
    }
    if (expectations.skillID) {
        expect(listenMsg.data.match.skillID).to.equal(expectations.skillID);
    }

    if (expectations.agentResponses) {
        Object.keys(expectations.agentResponses).forEach(name => {
            const agent = expectations.agentResponses[name];
            expect(listenMsg.data.nlu.external[name].intent).to.equal(agent.intent);
        });
    }

    if (expectations.skillPrompt) {
        const skillMsg = messages[++cnt];
        expect(skillMsg.type).to.equal(skill.response.ResponseType.SKILL_ACTION);
        expect(skillMsg.data.action.type).to.equal('JCP');
        expect(skillMsg.data.action.config.jcp.config.play.esml).to.equal(expectations.skillPrompt);
        expect(typeof skillMsg.timings.total).to.equal('number');
        expect(typeof skillMsg.timings.skill).to.equal('number');
    }
}

export const TEST_SKILL_CONFIG: skill.config.SkillConfig[] = [{
    id: "example",
    URL: "http://127.0.0.1:8080/v1/main",
    intents: [
        {
            name: test.TestIntents.DOES_LIKE,
            // name: test.TestIntents.DOES_LIKE,
            entities: [
                {
                    name: "Experience",
                    value: "BeingJibo",
                    matchRule: "EXACT"
                }
            ],
            memo: test.TestIntents.DOES_LIKE
        },
        { "name": test.TestIntents.DISLIKES, "memo": "MEMO1" },
        {
            // name: test.TestIntents.LIVE_AND_PROSPER,
            name: test.TestIntents.LIVE_AND_PROSPER,
            entities: [],
            memo: test.TestIntents.LIVE_AND_PROSPER
        }
    ],
    proactives: [
        {
            "memo": "Proactive entry 1",
            "topics": ["fake topic 1"],
            "contextRules": []
        }
    ]
}];