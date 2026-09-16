// Portal REST: People / person catalog + voice training enrolment state (surface 7).
// Person_20160801 and VoiceTraining live in the Classic entrypoint; the portal calls them with
// the account's own signed identity (plus the forwarded x-amz-credentials the source gateway
// used, so person/voicetraining resolve the caller to this exact account).

import { sendJson } from '@phoenix/common';
import { classicCall, ClassicCallError } from './classicClient.js';
import { requireUser } from './session.js';

function idsEqual(a, b) {
  return a != null && b != null && String(a) === String(b);
}

export function portalPeopleRoutes(store, options = {}) {
  const classic = options.classicCall || classicCall;
  const base = options.classicBase;

  return {
    'GET /api/people': async ({ req, res, url }) => {
      const account = requireUser(store, req, res);
      if (!account) return;
      const loopId = url.searchParams.get('loopId');
      const loop = loopId ? store.loops.get(loopId) : null;
      if (!loop || loop.isDeleted === true) {
        return sendJson(res, 404, { error: 'Loop does not exist', code: 'LOOP_NOT_FOUND' });
      }
      const out = { loopId: loop._id, answers: [], accountProperties: {}, loopProperties: {}, holidays: [], voiceTraining: [] };
      const diagnostics = [];
      const forwarded = { id: account._id, email: account.email };

      const safe = async (fn) => {
        try { return await fn(); }
        catch (error) {
          if (error instanceof ClassicCallError) diagnostics.push({ code: error.code, message: error.message });
          else diagnostics.push({ message: String(error.message || error) });
          return undefined;
        }
      };

      const answers = await safe(() => classic({ base, account, credentials: forwarded, target: 'Person_20160801.List', body: { category: 'app' } }));
      if (answers) out.answers = answers.body;

      const properties = await safe(() => classic({ base, account, credentials: forwarded, target: 'Person_20160801.GetAccountProperties', body: {} }));
      if (properties && properties.body) out.accountProperties = properties.body;

      const loopProperties = await safe(() => classic({ base, account, credentials: forwarded, target: 'Person_20160801.GetLoopProperties', body: { loopId: loop._id } }));
      if (loopProperties && loopProperties.body) out.loopProperties = loopProperties.body;

      const birthdays = await safe(() => classic({ base, account, credentials: forwarded, target: 'Person_20160801.ListHolidays', body: { loopId: loop._id } }));
      if (birthdays) out.holidays = birthdays.body;

      const voice = await safe(() => classic({ base, account, credentials: forwarded, target: 'VoiceTraining_20151020.ListVoiceTrainings', body: {} }));
      if (voice && Array.isArray(voice.body)) out.voiceTraining = voice.body;

      // Voice training runs at loop scope in the source store (`/voiceTraining/<accountId>/<key>`),
      // so report enrolment from the store's own rows.
      if (Array.isArray(out.voiceTraining) && loop.robot) {
        const robotEnrolled = out.voiceTraining.some((record) => String(record.accountId || '') === String(loop.robot));
        out.enrolment = { robot: robotEnrolled };
      }
      if (diagnostics.length) out.diagnostics = diagnostics;
      return out;
    },
  };
}