#!/usr/bin/env node
// A-10 envelope measurement: run the PINNED validator (@jibo/server declares joi
// ^10.5.2; the original monorepo install under .parity/reviews/a06-original-runtime
// resolves 10.5.2) over the exact payloads the notification route can receive, so the
// expected `err.message` is MEASURED rather than transcribed from the handler source.
//
// The @jibo/server validatePayload decorator calls
//   Joi.validate(request.payload, validationObj, { allowUnknown: true }, cb)
// and rejects with Boom.badData(err) (HTTP 422, payload {statusCode, error, message}).
//
// Run: node docs/parity/evidence/2026-09-10/a10-notification-lifecycle/joi-matrix.cjs
const PINNED_JOI_DIR = process.env.PHOENIX_PINNED_JOI
  || '/home/shell/work/phoenix/.parity/reviews/a06-original-runtime/node_modules/joi';
const Joi = require(PINNED_JOI_DIR);
const fs = require('fs');
const path = require('path');

const NEW_ROBOT_TOKEN = { deviceId: Joi.string() };                       // handler.ts:24-26
const GET_STATUS = { accountId: Joi.string().required() };                // handler.ts:38-40

const CASES = [
  ['NewRobotToken deviceId={}', { deviceId: {} }, NEW_ROBOT_TOKEN],
  ['NewRobotToken deviceId=[]', { deviceId: [] }, NEW_ROBOT_TOKEN],
  ['NewRobotToken deviceId=true', { deviceId: true }, NEW_ROBOT_TOKEN],
  ['NewRobotToken deviceId=null', { deviceId: null }, NEW_ROBOT_TOKEN],
  ['NewRobotToken deviceId=""', { deviceId: '' }, NEW_ROBOT_TOKEN],
  ['NewRobotToken payload=""', '', NEW_ROBOT_TOKEN],
  ['NewRobotToken payload=null', null, NEW_ROBOT_TOKEN],
  ['NewRobotToken payload=[]', [], NEW_ROBOT_TOKEN],
  ['NewRobotToken payload=false', false, NEW_ROBOT_TOKEN],
  ['NewRobotToken payload=0', 0, NEW_ROBOT_TOKEN],
  ['NewRobotToken payload="scalar"', 'scalar', NEW_ROBOT_TOKEN],
  ['NewRobotToken payload={}', {}, NEW_ROBOT_TOKEN],
  ['NewRobotToken payload={deviceId:"x",unknown:1}', { deviceId: 'x', unknown: 1 }, NEW_ROBOT_TOKEN],
  ['GetStatus payload={}', {}, GET_STATUS],
  ['GetStatus accountId=null', { accountId: null }, GET_STATUS],
  ['GetStatus accountId=7', { accountId: 7 }, GET_STATUS],
  ['GetStatus accountId=""', { accountId: '' }, GET_STATUS],
  ['GetStatus payload=null', null, GET_STATUS],
  ['GetStatus payload={accountId:"a",extra:1}', { accountId: 'a', extra: 1 }, GET_STATUS],
];

const results = CASES.map(([name, payload, schema]) => {
  const { error } = Joi.validate(payload, schema, { allowUnknown: true });
  return { case: name, expected422Message: error ? error.message : null };
});
const out = {
  joiVersion: JSON.parse(fs.readFileSync(path.join(PINNED_JOI_DIR, 'package.json'), 'utf8')).version,
  allowUnknown: true,
  results,
};
fs.writeFileSync(path.join(__dirname, 'joi-matrix.json'), `${JSON.stringify(out, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(out, null, 1)}\n`);
