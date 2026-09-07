// Skills service host (Pegasus baseskill + skills equivalent). Milestone M7.
//
// Hosts the cloud skills, each at POST /v1/<id>/main (the gateway registry points each cloud
// skill's URL there). A PHOENIX_SKILL_ID process may expose one selected skill at /v1/main,
// which is the deployment shape used by the per-skill compose/native launchers. With no
// selection, the shared host keeps the combined multi-skill service and answer-skill default.

import { DefaultPort } from '@phoenix/contracts';
import { basename } from 'node:path';
import { createSkillsService, createSkillService } from './skillService.js';
import minimist from './vendor/minimist.cjs';
import { GraphManager } from './graph/graphManager.js';
import { answerSkill } from './answerSkill.js';
import { getChitchatSkill } from './chitchatSkill.js';
import { getReportSkill } from './reportSkill.js';
import { colorSkill } from './colorSkill.js';
import { exampleSkill } from './exampleSkill.js';
import { templateSkill } from './templateSkill.js';
import {
  GQA_WIKIPEDIA_PROFILE,
  startGqaWikipediaService,
} from './gqaWikipediaService.js';
import {
  GQA_MULTI_PROVIDER_PROFILE,
  startGqaMultiProviderService,
} from './gqaMultiProviderService.js';
import {
  createGqaDefaultSkill,
  validateGqaDefaultProfile,
} from './gqaDefaultService.js';

export { createSkillsService, createSkillService } from './skillService.js';
export { buildSkillAction, buildJcpAction, buildJcpFromSlim, escapeForEsml } from './jcp.js';
export { createGraphSkill, SkillFacade } from './graph/graphSkill.js';
export { Node, FnNode } from './graph/node.js';
export { Graph, TransitionContainer } from './graph/graph.js';
export * as nodes from './graph/nodes.js';
export * as mimFactories from './graph/mims/factories.js';
export { OptInFactory, OptInType, OptInTransition, RouteNode, YesNoWrongIDNode } from './graph/mims/optIn.js';
export { unifyMims } from './graph/mims/unify.js';
export { loadMims, prepareMim } from './graph/mims/utils.js';
export { GraphManager } from './graph/graphManager.js';
export { generateSlim, generateSlimSequence, generateSlimFromMim, generateDisplay, weightedSample, newMimState, MimTypes, PromptCategory, PromptSubCategory } from './graph/mims/slimmer.js';
export { buildPromptData, loadMimFile } from './graph/mims/promptData.js';
export { answerSkill } from './answerSkill.js';
export {
  createGqaAnswerSkill,
  createGqaProviderPipeline,
  createGqaHttpRoute,
  gqaAnswerSkill,
  GQA_MISSING_TRANSID_HTML,
  GQA_BAD_REQUEST_HTML,
  validateGqaRequestEnvelope,
  validateGqaRequestBody,
  buildGqaResponse,
  buildGqaSlimFromMim,
  buildGqaSlimFromText,
  createGqaTextDisplay,
  getGqaQuestionType,
  cleanGqaInput,
  gqaMimPromptIds,
  GQA_SOURCE_REVISION,
  GQA_VERSION,
} from './gqaAnswerSkill.js';
export {
  createWikipediaProvider,
  wikipediaProviderContract,
  WIKIPEDIA_SOURCE_API,
  WIKIPEDIA_SOURCE_REVISION,
  WIKIPEDIA_SOURCE_USER_AGENT,
} from './gqaWikipediaProvider.js';
export {
  createBingProvider,
  extractBingSpokenAnswer,
  bingProviderContract,
  BING_SOURCE_CONFIG_KEY,
  BING_SOURCE_MODULE,
  BING_SOURCE_REVISION,
  BING_UNHELPFUL_SPOKEN_TEXT,
  BING_SUPPRESS_IN_SPOKEN_TEXT,
} from './gqaBingProvider.js';
export {
  createWolframProvider,
  extractWolframPodAnswer,
  extractWolframSpokenAnswer,
  cleanWolframAnswer,
  wolframProviderContract,
  WOLFRAM_SOURCE_CONFIG_KEY,
  WOLFRAM_SOURCE_MODULE,
  WOLFRAM_SOURCE_REVISION,
  WOLFRAM_SOURCE_TOTAL_TIMEOUT,
  WOLFRAM_SOURCE_SCAN_TIMEOUT,
  WOLFRAM_SOURCE_ANSWER_POD_INDEX,
} from './gqaWolframProvider.js';
export { createReportSkill, getReportSkill, reportSkill } from './reportSkill.js';
export { createChitchatSkill, getChitchatSkill, chitchatSkill } from './chitchatSkill.js';
export { colorSkill } from './colorSkill.js';
export { exampleSkill } from './exampleSkill.js';
export { templateSkill } from './templateSkill.js';
export {
  createGqaWikipediaService,
  readGqaWikipediaProfileConfig,
  startGqaWikipediaService,
  GQA_WIKIPEDIA_BASE_PATH,
  GQA_WIKIPEDIA_PROFILE,
  GQA_WIKIPEDIA_SKILL_ID,
} from './gqaWikipediaService.js';
export {
  createGqaMultiProviderProfile,
  createGqaMultiProviderService,
  readGqaMultiProviderProfileConfig,
  startGqaMultiProviderService,
  GQA_MULTI_PROVIDER_BASE_PATH,
  GQA_MULTI_PROVIDER_PROFILE,
  GQA_MULTI_PROVIDER_SKILL_ID,
  GQA_MULTI_PROVIDER_TIMEOUTS,
} from './gqaMultiProviderService.js';
export {
  createGqaDefaultSkill,
  validateGqaDefaultProfile,
  GQA_DEFAULT_PROFILE,
  GQA_DEFAULT_PROFILE_ENV,
} from './gqaDefaultService.js';
export {
  createGqaAccountLookup,
  createGqaAttributionStore,
  createGqaMemoryAttributionStore,
  createGqaRetrieveAttributionRoute,
  createGqaWipeAttributionRoute,
  sourceJsonDumps,
  sourceTruthy,
  GQA_ACCOUNT_SOURCE_REVISION,
  GQA_ACCOUNT_SOURCE_MODULE,
  GQA_ATTRIBUTE_SOURCE_REVISION,
  GQA_ATTRIBUTE_SOURCE_MODULE,
  GQA_ACCOUNT_SERVICE_ENV,
  GQA_ATTRIBUTE_INDEX,
} from './gqaAccountAttribution.js';

// Compatibility descriptors retain the historical named handlers. A caller
// that passes SKILLS directly to createSkillsService still represents one
// co-hosted host, so its first request must not decide graph-ID allocation.
// Build that registry lazily, in the source order, while keeping selected
// start() hosts on their own managers below.
let publicBuiltinSkills;

function publicSkillHandler(skillId) {
  return (...args) => {
    if (!publicBuiltinSkills) publicBuiltinSkills = createBuiltinSkills({ graphManager: new GraphManager() });
    return publicBuiltinSkills.find((skill) => skill.id === skillId).handler(...args);
  };
}

export const SKILLS = [
  { id: 'answer-skill', handler: answerSkill },
  { id: 'chitchat-skill', handler: publicSkillHandler('chitchat-skill') },
  { id: 'report-skill', handler: publicSkillHandler('report-skill') },
  { id: 'color-skill', handler: colorSkill },
  { id: 'example-skill', handler: exampleSkill },
  { id: 'template-skill', handler: templateSkill },
];

const SKILL_IDS = new Set(SKILLS.map((skill) => skill.id));

function answerSkillEntry(handler = answerSkill, route) {
  const entry = { id: 'answer-skill', handler };
  if (typeof route === 'function') entry.route = route;
  return entry;
}

/** Construct only the handlers hosted by this process, in source order. */
export function createBuiltinSkills({
  graphManager = new GraphManager(),
  answerHandler = answerSkill,
  answerRoute,
} = {}) {
  return [
    answerSkillEntry(answerHandler, answerRoute),
    { id: 'chitchat-skill', handler: getChitchatSkill({ graphManager }) },
    { id: 'report-skill', handler: getReportSkill({ graphManager }) },
    { id: 'color-skill', handler: colorSkill },
    { id: 'example-skill', handler: exampleSkill },
    { id: 'template-skill', handler: templateSkill },
  ];
}

function createSelectedSkill(skillId, { answerHandler = answerSkill, answerRoute } = {}) {
  if (skillId === 'chitchat-skill') return { id: skillId, handler: getChitchatSkill({ graphManager: new GraphManager() }) };
  if (skillId === 'report-skill') return { id: skillId, handler: getReportSkill({ graphManager: new GraphManager() }) };
  if (skillId === 'answer-skill') return answerSkillEntry(answerHandler, answerRoute);
  return SKILLS.find((skill) => skill.id === skillId);
}

function defaultPort() {
  const configured = process.env.PORT || process.env.ETCO_server_port;
  if (configured === undefined || configured === '') return DefaultPort.skills;
  const parsed = Number(configured);
  return Number.isFinite(parsed) ? parsed : DefaultPort.skills;
}

// The Pegasus run-service entrypoint uses minimist and then evaluates
// parseInt(argv.p || argv.port || ETCO_server_port || '8080'). Keep the
// programmatic start() default above as an explicit Phoenix deployment
// adapter (PORT/shared-host), while making the executable path source-shaped.
export function parseServiceArgs(args = process.argv.slice(2)) {
  return minimist(Array.isArray(args) ? args : []);
}

/** Resolve the source run-service port from generic minimist argv and ETCO_server_port. */
export function parseServicePort(args = process.argv.slice(2), env = process.env) {
  const argv = parseServiceArgs(args);
  const raw = argv.p || argv.port || env.ETCO_server_port || '8080';
  return parseInt(raw);
}

export function serviceHelp(program = 'run-service.js') {
  return `Usage: ${basename(program)} [options]\n  Options:\n  --port, -p: [default: 8080] Port of service`;
}

export const RUN_SERVICE_SHUTDOWN_MS = 5000;

function serviceErrorMessage(error) {
  if (typeof error === 'string') return error;
  if (error && typeof error.message === 'string') return error.message;
  return String(error);
}

/**
 * Run the executable service through the source common-runner contract.
 * Programmatic callers use start() directly; this wrapper is only for the
 * process entrypoint, where a missing/rejected service promise must be logged
 * and allowed to flush for the source five-second shutdown interval.
 *
 * Hooks keep the synchronous contract testable without sleeping or exiting the
 * test process. They are not used by the executable path.
 */
export function runService(serviceName, serviceStarter, {
  shutdownMs = RUN_SERVICE_SHUTDOWN_MS,
  reportError = (error) => console.error(`[error] H.${serviceName}.RunService ${serviceErrorMessage(error)}`),
  scheduleExit = (callback, delay) => setTimeout(callback, delay),
  exit = (status) => process.exit(status),
} = {}) {
  const handleError = (error) => {
    try {
      reportError(error);
    } catch (loggerError) {
      console.error('Error creating error logger', loggerError);
      console.error(error);
    }
    scheduleExit(() => exit(1), shutdownMs);
  };

  try {
    const promise = serviceStarter();
    if (promise && typeof promise.catch === 'function') promise.catch(handleError);
    else handleError("Service didn't return promise");
  } catch (error) {
    handleError(error);
  }
}

export function start(port = defaultPort(), {
  skillId = process.env.PHOENIX_SKILL_ID,
  gqaProfile = process.env.PHOENIX_GQA_PROFILE,
  gqaDefaultProfile = process.env.PHOENIX_GQA_DEFAULT_PROFILE,
  gqaEnvironment = process.env,
  gqaConfig = {},
  gqaEndpoint = process.env.ETCO_gqa_wikiApi,
  gqaTimeoutMs = process.env.ETCO_gqa_wikiTimeoutMs,
} = {}) {
  const selectedDefaultProfile = validateGqaDefaultProfile(gqaDefaultProfile);
  if (gqaProfile === GQA_WIKIPEDIA_PROFILE) {
    if (skillId && skillId !== 'answer' && skillId !== 'answer-skill') {
      throw new Error(`GQA Wikipedia profile cannot serve PHOENIX_SKILL_ID '${skillId}'`);
    }
    return startGqaWikipediaService(port, {
      endpoint: gqaEndpoint,
      timeoutMs: gqaTimeoutMs,
    });
  }
  if (gqaProfile === GQA_MULTI_PROVIDER_PROFILE) {
    if (skillId && skillId !== 'answer' && skillId !== 'answer-skill') {
      throw new Error(`GQA multi-provider profile cannot serve PHOENIX_SKILL_ID '${skillId}'`);
    }
    return startGqaMultiProviderService(port, {
      env: gqaEnvironment,
      ...gqaConfig,
    });
  }
  if (skillId) {
    if (!SKILL_IDS.has(skillId)) throw new Error(`Unknown PHOENIX_SKILL_ID '${skillId}'`);
    const defaultGqa = selectedDefaultProfile && skillId === 'answer-skill'
      ? createGqaDefaultSkill({ env: gqaEnvironment, ...gqaConfig })
      : undefined;
    const selected = createSelectedSkill(skillId, {
      answerHandler: defaultGqa?.handler,
      answerRoute: defaultGqa?.route,
    });
    return createSkillService({
      name: selected.id,
      skillId: selected.id,
      handler: selected.handler,
      route: selected.route,
    }).listen(port);
  }
  const defaultGqa = selectedDefaultProfile
    ? createGqaDefaultSkill({ env: gqaEnvironment, ...gqaConfig })
    : undefined;
  return createSkillsService({
    name: 'skills',
    skills: createBuiltinSkills({
      answerHandler: defaultGqa?.handler,
      answerRoute: defaultGqa?.route,
    }),
    defaultId: 'answer-skill',
  }).listen(port);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = parseServiceArgs();
  const executableServiceName = process.env.PHOENIX_SKILL_ID === 'report-skill'
    ? 'PersonalReportSkill'
    : 'Skills';
  if (argv.h || argv.help) {
    console.log(serviceHelp(process.argv[1]));
    runService(executableServiceName, () => undefined);
  } else {
    runService(executableServiceName, () => start(parseServicePort()));
  }
}
