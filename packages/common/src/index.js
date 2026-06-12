// @phoenix/common — shared service scaffolding.
// Side-effect: fill process.env from the repo-root .env (real env always wins; see dotenv.js).
import { loadDotEnv } from './dotenv.js';
loadDotEnv();
export { loadDotEnv } from './dotenv.js';
export { net, etco, boolEnv } from './env.js';
export { readTrace, writeTrace } from './headers.js';
export { logger } from './log.js';
export { createService, sendText, sendJson, readJson } from './service.js';
export * as jwt from './jwt.js';
