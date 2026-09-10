// Service CLI contract, Pegasus 5c0a739.
//
// Reference: packages/utils/common/run-service.js and each service's
// scripts/run-service.js or src/cli/start.ts. Every service resolves its listen
// port with the same expression:
//
//   parseInt(argv['p'] || argv['port'] || process.env.ETCO_server_port || '8080')
//
// minimist does the argv coercion ("1234" becomes a number, so `--port 0` is
// falsy and falls through to the next input). DEFAULT_PORT is '8080' for every
// reference service.
//
// Phoenix runs several services side by side on one host, so each service keeps
// its own local default (packages/contracts DefaultPort) and accepts PORT as a
// deployment alias. `serviceCliPort` keeps the source inputs first - argv, then
// ETCO_server_port - and falls back to PORT/DefaultPort last, so an unmodified
// reference environment (ETCO_server_port=8080) gets source behaviour while a
// bare local run keeps Phoenix's distinct default.

import { basename } from 'node:path';
import minimist from './vendor/minimist.cjs';

export const SOURCE_DEFAULT_PORT = '8080';

/** Generic source minimist parse of the process argv (or a supplied argv array). */
export function parseServiceArgs(args = process.argv.slice(2)) {
  return minimist(Array.isArray(args) ? args : []);
}

/**
 * Resolve the source run-service port.
 * @param {string[]} [args] argv after the script name
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [fallback] the source literal default, overridable for deployment
 */
export function parseServicePort(args = process.argv.slice(2), env = process.env, fallback = SOURCE_DEFAULT_PORT) {
  const argv = parseServiceArgs(args);
  const raw = argv.p || argv.port || env.ETCO_server_port || fallback;
  return parseInt(raw);
}

/**
 * Port for a service executable: source inputs first (argv, ETCO_server_port),
 * then the Phoenix deployment default (`PORT` or the caller's per-service
 * DefaultPort). Keeps the source contract without changing a bare local run.
 */
export function serviceCliPort({ args = process.argv.slice(2), env = process.env, fallback } = {}) {
  return parseServicePort(args, env, String(Number(env.PORT) || fallback));
}

/**
 * Source help text. Hub's src/cli/start.ts omits the `[options]` suffix that the
 * other services print; pass `options: false` for that variant.
 */
export function serviceHelp(program = 'run-service.js', { options = true } = {}) {
  const usage = options ? `Usage: ${basename(program)} [options]` : `Usage: ${basename(program)}`;
  return `${usage}\n  Options:\n  --port, -p: [default: ${SOURCE_DEFAULT_PORT}] Port of service`;
}

/** Source packages/utils/common/run-service.js shutdown delay. */
export const RUN_SERVICE_SHUTDOWN_MS = 5000;

function serviceErrorMessage(error) {
  if (typeof error === 'string') return error;
  if (error && typeof error.message === 'string') return error.message;
  return String(error);
}

/**
 * The source common service runner (packages/utils/common/run-service.js:8-38).
 *
 * A starter that does not return a thenable (including one that returns
 * `undefined`, e.g. a `--help` branch that only `return`s) is reported as
 * "Service didn't return promise". Either way the process stays alive for the
 * source five-second log-upload window before exiting 1.
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
