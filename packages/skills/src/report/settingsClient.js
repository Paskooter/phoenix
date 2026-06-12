// SettingsClient — port of report-skill/src/SettingsClient.ts. The AWS settings service is dead
// ([DEAD] in DIVERGENCES.md), so the live paths are: un-IDed/child speaker -> defaults;
// ETCO_report_prefsFromConfig=true -> resources/report-prefsConfig.json; otherwise the real
// GetSettings POST against NET_settings (throws when unreachable -> caller's SettingsFailed path,
// exactly like the reference behaves with the service down).

import { getJSON, getAccountFromLooper, speakerIsAdult } from './utils.js';

const SETTINGS_API_VERSION = '20160801';
const PREFS_CONFIG = 'report-prefsConfig';
const NO_AUTH = 'no-auth-provided';

const CommuteModeNames = ['driving', 'walking', 'bicycling', 'transit'];

export class SettingsClient {
  static async getUserPrefs(data, looperID) {
    const log = data.log;

    if (!looperID || looperID === 'notInLoop') {
      log?.info?.('Speaker not in loop');
      return SettingsClient.getDefaultPrefs(log);
    }
    if (!speakerIsAdult(data)) {
      log?.info?.('Speaker is a child, getting default prefs');
      return SettingsClient.getDefaultPrefs(log);
    }
    if (process.env.ETCO_report_prefsFromConfig === 'true') {
      return getJSON(PREFS_CONFIG);
    }

    const accountId = getAccountFromLooper(data.runtime.loop, looperID);
    const loopId = data.runtime.loop.loopId;
    const transId = data.trace && data.trace.transID;

    let settings;
    try {
      const res = await SettingsClient.getSettings(accountId, loopId, transId);
      const prSettings = res && res.find((skill) => skill.skillId === 'report-skill');
      settings = prSettings && prSettings.data;
    } catch (err) {
      err.message = `Error getting Settings data: ${err.code || ''}, ${err.message}`;
      throw err;
    }
    try {
      return SettingsClient.convertSettingsToPrefs(settings);
    } catch (err) {
      err.message = `Error converting settings data into prefs: ${err.message}`;
      throw err;
    }
  }

  static async getSettings(accountId, loopId, transId) {
    if (!accountId || accountId === NO_AUTH || !loopId) {
      throw new Error(`Missing creds for Settings request. Got accountID: ${!!accountId} | loopID: ${!!loopId}`);
    }
    const base = process.env.NET_settings;
    if (!base) throw new Error('NET_settings not configured (settings service unavailable)');
    const res = await fetch(`http://${base}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-amz-credentials': JSON.stringify({ id: accountId }),
        'x-amz-target': `Settings_${SETTINGS_API_VERSION}.GetSettings`,
      },
      body: JSON.stringify({ loopId, transId, getView: false, skills: 'report-skill' }),
    });
    if (!res.ok) throw new Error(`Settings service ${res.status}`);
    return res.json();
  }

  static convertSettingsToPrefs(settings) {
    if (!settings) throw new Error('No settings provided');
    const checkProp = (setting, prop) => settings[setting] && settings[setting][prop];

    const commutePrefs = {
      active: !!checkProp('commuteEnabled', 'value'),
      workTime: { hour: checkProp('commuteTime', 'hour'), min: checkProp('commuteTime', 'min') },
      origin: { lat: checkProp('homeLocation', 'lat'), lng: checkProp('homeLocation', 'lng') },
      destination: { lat: checkProp('workLocation', 'lat'), lng: checkProp('workLocation', 'lng') },
      mode: CommuteModeNames[checkProp('commuteType', 'value')],
      complete: false,
    };
    return {
      weather: {
        active: !!checkProp('weatherEnabled', 'value'),
        useCelsius: !!checkProp('weather', 'value'), // 0 = °F, 1 = °C
      },
      calendar: {
        active: !!checkProp('calendarEnabled', 'value'),
        googlePersonalCreds: !!checkProp('google:personalCalendar:readonly', 'credentialExists'),
        googleWorkCreds: !!checkProp('google:workCalendar:readonly', 'credentialExists'),
        outlookPersonalCreds: !!checkProp('outlook:personalCalendar:readonly', 'credentialExists'),
        outlookWorkCreds: !!checkProp('outlook:workCalendar:readonly', 'credentialExists'),
      },
      commute: Object.assign({}, commutePrefs, { complete: SettingsClient.commutePrefsComplete(commutePrefs) }),
      news: {
        active: !!checkProp('newsEnabled', 'value'),
        activeNewsCategories: {
          technology: !!checkProp('newsTechnology', 'value'),
          sports: !!checkProp('newsSports', 'value'),
          business: !!checkProp('newsBusiness', 'value'),
          science: !!checkProp('newsScience', 'value'),
          entertainment: !!checkProp('newsEntertainment', 'value'),
          strange: !!checkProp('newsStrange', 'value'),
          health: !!checkProp('newsHealth', 'value'),
          international: !!checkProp('newsInternational', 'value'),
          national: !!checkProp('newsNational', 'value'),
          politics: !!checkProp('newsPolitics', 'value'),
        },
      },
    };
  }

  /** Defaults: Weather + News on, Commute + Calendar off. */
  static getDefaultPrefs(log) {
    log?.info?.('Using default UserPrefs');
    return {
      weather: { active: true, useCelsius: false },
      calendar: { active: false, googlePersonalCreds: false, googleWorkCreds: false, outlookPersonalCreds: false, outlookWorkCreds: false },
      commute: {
        active: false,
        workTime: { hour: null, min: null },
        origin: { lat: null, lng: null },
        destination: { lat: null, lng: null },
        mode: null,
        complete: false,
      },
      news: {
        active: true,
        activeNewsCategories: {
          technology: true, sports: true, business: true, science: false, entertainment: false,
          strange: false, health: false, international: false, national: true, politics: false,
        },
      },
    };
  }

  static commutePrefsComplete(commutePrefs) {
    const allExist = (arr) => arr.every((item) => item !== null && item !== undefined);
    return allExist([
      commutePrefs, commutePrefs.mode, commutePrefs.origin, commutePrefs.workTime, commutePrefs.destination,
      commutePrefs.origin.lat, commutePrefs.origin.lng, commutePrefs.destination.lat, commutePrefs.destination.lng,
      commutePrefs.workTime.hour, commutePrefs.workTime.min,
    ]);
  }
}
