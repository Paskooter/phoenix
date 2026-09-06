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
import { answerSkill } from './answerSkill.js';
import { reportSkill } from './reportSkill.js';
import { chitchatSkill } from './chitchatSkill.js';
import { colorSkill } from './colorSkill.js';
import { exampleSkill } from './exampleSkill.js';
import { templateSkill } from './templateSkill.js';

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
export { reportSkill } from './reportSkill.js';
export { chitchatSkill } from './chitchatSkill.js';
export { colorSkill } from './colorSkill.js';
export { exampleSkill } from './exampleSkill.js';
export { templateSkill } from './templateSkill.js';

export const SKILLS = [
  { id: 'answer-skill', handler: answerSkill },
  { id: 'report-skill', handler: reportSkill },
  { id: 'chitchat-skill', handler: chitchatSkill },
  { id: 'color-skill', handler: colorSkill },
  { id: 'example-skill', handler: exampleSkill },
  { id: 'template-skill', handler: templateSkill },
];

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
    reportError(error);
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

export function start(port = defaultPort(), { skillId = process.env.PHOENIX_SKILL_ID } = {}) {
  if (skillId) {
    const selected = SKILLS.find((skill) => skill.id === skillId);
    if (!selected) throw new Error(`Unknown PHOENIX_SKILL_ID '${skillId}'`);
    return createSkillService({ name: selected.id, skillId: selected.id, handler: selected.handler }).listen(port);
  }
  return createSkillsService({ name: 'skills', skills: SKILLS, defaultId: 'answer-skill' }).listen(port);
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
