// `log` service (Log_20150309) — robot log/telemetry upload. Faithful to srv-log-ws's role: it
// must accept the robot's events and never 500 (the robot fires these in the background; an error
// just spams its logs). We don't ship the events anywhere by default — optionally append a JSONL
// line per upload to ETCO_log_dir for inspection. Output shapes match the *.normal.json.
//
// Ops: PutEvents/PutEventsAsync (event arrays), PutAsrBinary/PutBinary* (S3-upload handshakes —
// we have no S3, so we return a local sink), NewKinesisCredentials (dead AWS Kinesis -> empty).

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { sendAmz, sendAmzError, ValidationException } from './awsJson.js';

function sink(op, body, log) {
  const dir = process.env.ETCO_log_dir;
  if (!dir) return;
  try {
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, 'robot-events.jsonl'), JSON.stringify({ ts: Date.now(), op, body }) + '\n');
  } catch (e) {
    log.warn('log sink write failed', { error: e.message });
  }
}

export function logHandler({ res, op, body, log }) {
  switch (op.toLowerCase()) {
    case 'putevents':
      sink(op, body, log);
      return void sendAmz(res, 200, {}); // Response shape has no members
    case 'puteventsasync':
      sink(op, body, log);
      // {contentEncoding, uploadUrl} — point the robot's async upload at this same sink op.
      return void sendAmz(res, 200, { contentEncoding: 'identity', uploadUrl: '' });
    case 'putbinary':
    case 'putbinaryasync':
    case 'putasrbinary': {
      // S3 handshake replacement: no bucket; return an empty target so the robot no-ops the PUT.
      sink(op, { meta: body && body.metadata }, log);
      return void sendAmz(res, 200, { bucketName: '', key: '', metadata: (body && body.metadata) || {}, uploadUrl: '' });
    }
    case 'newkinesiscredentials':
      // Kinesis is dead; hand back empty creds (robot degrades to no streaming telemetry).
      return void sendAmz(res, 200, { credentials: null, region: '', streamName: '' });
    default:
      return void sendAmzError(res, ValidationException, `unknown Log operation: ${op}`);
  }
}
