// `settings` service (Settings_20171219) — the report-skill's user-prefs source. Two faces:
//   - AWS-JSON (the report-skill's SettingsClient calls this at NET_settings): GetSettings /
//     UpdateSettings / DeleteSettings / GetDataForSettings, dispatched on POST / by op. The
//     caller identifies the account via `x-amz-credentials: {"id":<accountId>}` (we trust it —
//     LAN, like everything else; no SigV4 verification). GetSettings returns the array shape the
//     report-skill expects: [{ skillId:'report-skill', data:<PersonalReportSettingsData> }].
//   - Portal REST (GET/PUT /api/settings, session-cookie auth): the friendly editor, stored under
//     the logged-in owner's account._id.
//
// Wiring this up is what turns the report-skill's SettingsFailed degradation into a real,
// per-user personal report.

import { sendJson } from '@phoenix/common';
import { getSettingsData, setSettingsData, dataToFriendly, friendlyToData, defaultSettingsData } from './settingsData.js';
import { getSession } from './sessions.js';

const AMZ_JSON = 'application/x-amz-json-1.1';
const REPORT_SKILL = 'report-skill';

function amz(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': AMZ_JSON, 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function accountIdFromCreds(req) {
  const raw = req.headers && req.headers['x-amz-credentials'];
  if (!raw) return null;
  try { return JSON.parse(raw).id || null; } catch { return null; }
}

/**
 * AWS-JSON dispatch for the Settings_* prefix — called from robotFace's POST / router.
 * @returns true if it handled the op (so the caller stops), false to fall through.
 */
export function settingsAwsDispatch(store, { req, res, body, op, log }) {
  const accountId = accountIdFromCreds(req);
  switch (op.toLowerCase()) {
    case 'getsettings': {
      // The report-skill reads [{skillId, data}].find(s => s.skillId === 'report-skill').data
      const data = accountId ? getSettingsData(store, accountId) : defaultSettingsData();
      amz(res, 200, [{ skillId: REPORT_SKILL, data }]);
      return true;
    }
    case 'getdataforsettings': {
      const data = accountId ? getSettingsData(store, accountId) : defaultSettingsData();
      amz(res, 200, [{ skillId: REPORT_SKILL, data }]);
      return true;
    }
    case 'updatesettings': {
      if (!accountId) { amz(res, 401, { __type: 'CREDENTIALS_REQUIRED', message: 'x-amz-credentials required' }); return true; }
      // body.data may be the wire shape directly, or [{skillId,data}]. Accept both.
      const incoming = Array.isArray(body.data)
        ? (body.data.find((s) => s.skillId === REPORT_SKILL) || {}).data
        : body.data;
      const data = setSettingsData(store, accountId, incoming || getSettingsData(store, accountId));
      amz(res, 200, { data: [{ skillId: REPORT_SKILL, data }] });
      return true;
    }
    case 'deletesettings': {
      if (accountId) { store.settings.delete(accountId); store.flush(); }
      amz(res, 200, { data: [] });
      return true;
    }
    default:
      log?.warn?.('unknown Settings operation', { op });
      amz(res, 400, { __type: 'ValidationException', message: `unknown Settings operation: ${op}` });
      return true;
  }
}

/** Portal REST: the friendly settings editor (session-cookie auth, keyed by the owner's _id). */
export function settingsPortalRoutes(store) {
  const owner = (req) => {
    const s = getSession(store, req);
    return (s && s.kind === 'user') ? store.accounts.get(s.accountId) : null;
  };
  return {
    'GET /api/settings': ({ req, res }) => {
      const account = owner(req);
      if (!account) return sendJson(res, 401, { error: 'not logged in' });
      return { accountId: account._id, settings: dataToFriendly(getSettingsData(store, account._id)) };
    },
    'PUT /api/settings': ({ req, res, body }) => {
      const account = owner(req);
      if (!account) return sendJson(res, 401, { error: 'not logged in' });
      const data = friendlyToData(body || {}, getSettingsData(store, account._id));
      setSettingsData(store, account._id, data);
      return { accountId: account._id, settings: dataToFriendly(data) };
    },
  };
}
