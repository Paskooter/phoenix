// OTA HTTP service. Two surfaces:
//
//   POST /                       the AWS-JSON Update API the robot's jibo-server-client calls.
//                                Dispatched by the X-Amz-Target operation name:
//                                  Update_20160301.ListUpdates       -> [Update,…]
//                                  Update_20160301.ListUpdatesFrom    -> [Update,…]
//                                  Update_20160301.GetUpdateFrom      -> Update | 404 NoUpdateAvailable
//   GET  /ota/package?id=<id>    the binary package, streamed with Content-Length so
//                                jibo-download-update can show progress + verify the SHA-1.
//   GET  /healthcheck            (free, from @phoenix/common createService)
//
// SigV4 on the inbound request is ignored — we trust the LAN like the hub's DISABLE_AUTH. The
// `url` we hand back points at THIS server (derived from the request Host, or ETCO_ota_publicUrl)
// so the robot downloads from wherever it reached us.

import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { createService } from '@phoenix/common';
import { parseTarget, sendAmz, sendAmzError } from './awsJson.js';

export function createOtaService({ catalog, publicBaseUrl = null } = {}) {
  const baseFor = (req) => publicBaseUrl || `http://${(req.headers && req.headers.host) || 'localhost'}`;

  const routes = {
    'POST /': async ({ req, res, body, log }) => {
      const op = parseTarget(req);
      const { fromVersion, subsystem, filter } = body || {};
      const baseUrl = baseFor(req);
      // Every robot update-check is logged with what it asked + how many we returned — so a
      // "no updates" on the robot is diagnosable from this server's log alone.
      try {
        if (op === 'ListUpdates' || op === 'ListUpdatesFrom') {
          const matches =
            op === 'ListUpdates' ? catalog.listUpdates({ subsystem, filter }) : catalog.listUpdatesFrom({ fromVersion, subsystem, filter });
          log.info?.('update query', { op, subsystem, fromVersion, filter, returned: matches.length, available: catalog.entries.length });
          return void sendAmz(res, 200, matches.map((e) => catalog.toUpdate(e, { baseUrl, fromVersion, filter })));
        }
        if (op === 'GetUpdateFrom') {
          const best = catalog.getUpdateFrom({ fromVersion, subsystem, filter });
          log.info?.('update query', { op, subsystem, fromVersion, filter, returned: best ? 1 : 0, available: catalog.entries.length });
          // The robot's system-manager (UpdateManager::checkForUpdates) treats ANY error code
          // other than exactly "UPDATE_NOT_FOUND" as fatal and aborts the whole multi-subsystem
          // check — so a subsystem we don't stock (e.g. @be/be, which sorts first) must return
          // precisely this code or os/services never get checked.
          if (!best) return void sendAmzError(res, 404, 'UPDATE_NOT_FOUND', `no ${subsystem || 'main'} update from ${fromVersion}`);
          return void sendAmz(res, 200, catalog.toUpdate(best, { baseUrl, fromVersion, filter }));
        }
        log.warn?.('unknown update target', { target: (req.headers && req.headers['x-amz-target']) || '(none)' });
        return void sendAmzError(res, 400, 'UnknownOperationException', `unknown target ${(req.headers && req.headers['x-amz-target']) || '(none)'}`);
      } catch (err) {
        log.error?.('ota operation failed', { op, error: err.message });
        return void sendAmzError(res, 500, 'InternalFailure', err.message);
      }
    },

    'GET /ota/package': async ({ res, url, log }) => {
      const id = url.searchParams.get('id');
      const entry = id && catalog.findById(id);
      if (!entry) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        return void res.end('no such package');
      }
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': entry.length });
      try {
        await pipeline(createReadStream(entry._file), res);
      } catch (err) {
        // Client hung up mid-download, or read error after headers were sent — nothing to do but log.
        log.warn?.('ota package stream interrupted', { id, error: err.message });
      }
    },
  };

  return createService({ name: 'ota', routes });
}
