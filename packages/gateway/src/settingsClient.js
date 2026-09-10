// Settings service client — port of hub/utils/SettingsClient.ts.
//
// The proactive engine asks the settings service for the preferences of every skill
// named by a proactive registration's settingsRules, in a single request. Identity rides
// `x-amz-credentials` (the account service's AWS-JSON Settings face trusts it, like every
// other LAN peer) and `x-amz-target` selects Settings_<version>.GetSettings. The response
// is an array of { skillId, data }; SettingsRulesChecker consumes it as a Map keyed by
// skillId.
//
// The pinned source sets exactly the two x-amz headers plus the body: the wire content
// type and the axios transport defaults come from the HTTP adapter, and no x-jibo-transid
// is forwarded here (captured reference request, docs/parity/evidence/2026-09-05/reference/
// transactions.json, "Original Settings client reaches legacy target").
//
// Pinned source: pegasus@5c0a7390539663ba749d360de348a428c088505c
//   packages/hub/src/utils/SettingsClient.ts:18-47 (getSettings, response map).

const SETTINGS_API_VERSION = '20160801';

export class SettingsClient {
  constructor(settingsURL) {
    this.base = (settingsURL || '').replace(/\/$/, '');
  }

  /**
   * Call Settings.GetSettings to get user settings.
   * @param {string} accountId speaker's account ID
   * @param {string} loopId speaker's loop ID
   * @param {string} transId transaction correlation ID (optional in the source)
   * @param {string[]} skills skills to return settings for
   * @returns {Promise<Map<string, object>>} skillId -> per-skill settings data
   */
  async getSettings(accountId, loopId, transId, skills, log) {
    if (!accountId || !loopId) {
      throw new Error(`Missing creds. Got accountID: ${!!accountId} | loopID: ${!!loopId}`);
    }
    if (!transId) log?.warn?.('Missing transId');
    if (!skills.length) {
      // short circuit if we don't actually need any settings
      return new Map();
    }

    const res = await fetch(this.base, {
      method: 'POST',
      headers: {
        'content-type': 'application/json;charset=utf-8',
        'x-amz-credentials': JSON.stringify({ id: accountId }),
        'x-amz-target': `Settings_${SETTINGS_API_VERSION}.GetSettings`,
      },
      // JSON.stringify drops an undefined transId, matching the source axios data object.
      body: JSON.stringify({ loopId, transId, skills, getView: false }),
    });
    if (!res.ok) throw new Error(`settings GetSettings ${res.status}`);

    // transform from array of {skill, data} to Map<skill, data>
    return new Map((await res.json()).map((obj) => [obj.skillId, obj.data]));
  }
}
