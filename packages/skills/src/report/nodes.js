// PersonalReport core nodes — ports of report-skill/src/nodes/{IntentSplitNode,ToggleNode,
// GetUserPrefsNode,GetDataNode,ParseDataNode}.ts.

import { NoOpNode, DefaultNode, DefaultTransition } from '../graph/nodes.js';
import { Names, addMimPathsToLocalData, speakerIsAdult } from './utils.js';
import { SettingsClient } from './settingsClient.js';
import * as weather from './weather.js';
import * as news from './news.js';
import * as calendar from './calendar.js';
import * as commute from './commute.js';

// --- IntentSplitNode -----------------------------------------------------------

export const IntentSplitTransition = Object.freeze({ Reactive: 'Reactive', Proactive: 'Proactive' });

export const Intent = Object.freeze({
  launchPersonalReport: 'launchPersonalReport',
  requestWeatherPR: 'requestWeatherPR',
  requestNews: 'requestNews',
  requestCalendar: 'requestCalendar',
  requestCommute: 'requestCommute',
});

export class IntentSplitNode extends NoOpNode {
  constructor(name) { super(name, Object.values(IntentSplitTransition)); }

  async exit(data) {
    const nlu = data.result && data.result.nlu; // could be null
    let singleSkill = null;
    let transition = null;
    data.result = data.result || {};
    data.result.proactive = true;
    if (nlu && nlu.intent) {
      switch (nlu.intent) {
        case Intent.launchPersonalReport: break;
        case Intent.requestWeatherPR: singleSkill = Names.weather; break;
        case Intent.requestNews: singleSkill = Names.news; break;
        case Intent.requestCalendar: singleSkill = Names.calendar; break;
        case Intent.requestCommute: singleSkill = Names.commute; break;
        default: throw new Error(`Unknown intent: '${nlu.intent}'`);
      }
      transition = IntentSplitTransition.Reactive;
      data.result.proactive = false;
    } else if (data.result && data.result.memo === IntentSplitTransition.Proactive) {
      transition = data.result.memo;
    } else {
      throw new Error(`Unknown memo: '${data.result && data.result.memo}'`);
    }

    data.skill.session.data._personalReport = { singleSkill, nlu };
    return { transition, result: data.result };
  }
}

// --- ToggleNode ------------------------------------------------------------------

export const ToggleTransition = Object.freeze({ Off: 'Off', On: 'On' });

export class ToggleNode extends NoOpNode {
  constructor(name, category) {
    super(name, Object.values(ToggleTransition));
    this.category = category;
  }

  async exit(data) {
    const userPrefs = data.local.userPrefs;
    return { transition: userPrefs[this.category].active ? ToggleTransition.On : ToggleTransition.Off };
  }
}

// --- GetUserPrefsNode ---------------------------------------------------------------

export const GetUserPrefsTransition = Object.freeze({ OptIn: 'OptIn', Finish: 'Finish', GetData: 'GetData' });

const PrefsMimName = Object.freeze({
  KickOff: 'KickOff', NoneActive: 'NoneActive', MustBeAdult: 'MustBeAdult', MustBeLooper: 'MustBeLooper',
  SettingsFailed: 'SettingsFailed', KickOffNonPersonal: 'KickOffNonPersonal',
});

export class GetUserPrefsNode extends NoOpNode {
  constructor(name) { super(name, Object.values(GetUserPrefsTransition)); }

  async exit(data) {
    const log = data.log;
    const looperID = data.runtime.perception && data.runtime.perception.speaker;
    const personalReportData = data.skill.session.data._personalReport;
    const singleSkill = personalReportData.singleSkill;
    const calOrCommute = (singleSkill === Names.calendar) || (singleSkill === Names.commute);

    let mimName;
    try {
      data.local.userPrefs = await SettingsClient.getUserPrefs(data, looperID);

      // Single skill: configured doesn't matter and there's no intro MIM.
      if (singleSkill) {
        if (calOrCommute) {
          if (!looperID) {
            data.local.mimPaths = addMimPathsToLocalData(Names.personalReport, [PrefsMimName.MustBeLooper], data.local);
            return { transition: GetUserPrefsTransition.Finish };
          }
          if (!speakerIsAdult(data)) {
            data.local.mimPaths = addMimPathsToLocalData(Names.personalReport, [PrefsMimName.MustBeAdult], data.local);
            return { transition: GetUserPrefsTransition.Finish };
          }
        }
        return { transition: GetUserPrefsTransition.GetData };
      }

      data.local.configured = Object.keys(data.local.userPrefs)
        .some((cat) => data.local.userPrefs[cat].active);

      if (data.result && data.result.proactive) {
        personalReportData.userPrefsConfigured = data.local.configured;
        return { transition: GetUserPrefsTransition.OptIn };
      }
      personalReportData.userPrefsConfigured = null;
      if (data.local.configured) {
        mimName = PrefsMimName.KickOff;
      } else {
        mimName = PrefsMimName.KickOffNonPersonal;
        data.local.userPrefs = SettingsClient.getDefaultPrefs(log);
      }
    } catch (err) {
      log?.error?.(`Error getting user prefs: ${err.message}`);
      data.local.settingsError = true; // suppresses OutroNotConfigured
      data.local.userPrefs = SettingsClient.getDefaultPrefs(log);
      mimName = PrefsMimName.SettingsFailed;
      if (calOrCommute) {
        data.local.mimPaths = addMimPathsToLocalData(Names.personalReport, [mimName], data.local);
        return { transition: GetUserPrefsTransition.Finish };
      }
    }

    data.local.mimPaths = addMimPathsToLocalData(Names.personalReport, [mimName], data.local);
    return { transition: GetUserPrefsTransition.GetData };
  }
}

// --- GetDataNode -----------------------------------------------------------------------

export const GetDataTransition = Object.freeze({ GotData: 'GotData', AllServicesDown: 'AllServicesDown' });

export class GetDataNode extends NoOpNode {
  constructor(name, personalReport) {
    super(name, Object.values(GetDataTransition));
    this.personalReport = personalReport;
  }

  async exit(data) {
    const log = data.log;
    data.result = data.result || {};
    const activeCategories = [];
    const userPrefs = data.local.userPrefs;
    const { weather: weatherPrefs, calendar: calendarPrefs, commute: commutePrefs, news: newsPrefs } = userPrefs;
    const personalReport = data.skill.session.data._personalReport;
    const singleSkill = personalReport && personalReport.singleSkill;

    if (singleSkill) {
      for (const category in userPrefs) {
        if (category in Names) userPrefs[category].active = (singleSkill === category);
      }
    }

    // News enabled with zero active categories falls back to the defaults.
    const activeNewsCats = newsPrefs.activeNewsCategories || {};
    const anyActiveNewsCat = Object.keys(activeNewsCats).some((key) => !!activeNewsCats[key]);
    if (newsPrefs.active && !anyActiveNewsCat) {
      newsPrefs.activeNewsCategories = SettingsClient.getDefaultPrefs(log).news.activeNewsCategories;
    }

    try {
      // Commute can depend on calendar data even when calendar itself is off (early event).
      const calOrCommuteActive = calendarPrefs.active || commutePrefs.active;
      activeCategories.push(calOrCommuteActive && calendar.getData(userPrefs, data));
      activeCategories.push(weatherPrefs.active && weather.getData(userPrefs, data));
      activeCategories.push(commutePrefs.active && commute.getData(userPrefs, data));
      activeCategories.push(newsPrefs.active && news.getData(userPrefs, data));

      const unfilteredData = await Promise.all(activeCategories);
      const dataResults = unfilteredData.filter((d) => !!d);

      if (!singleSkill && dataResults.every(([, d]) => !d)) {
        data.local.allServicesDown = true;
        return { transition: GetDataTransition.AllServicesDown };
      }

      dataResults.forEach(([name, categoryData]) => { data.result[name] = categoryData; });
    } catch (err) {
      log?.error?.(`Error from getData: ${err.message}`);
    }

    // Personal Report results analytics.
    try {
      this.personalReport.track(data, 'Personal Report Results', {
        weather: !!data.result[Names.weather], calendar: !!data.result[Names.calendar],
        commute: !!data.result[Names.commute], news: !!data.result[Names.news],
      });
    } catch (err) {
      log?.error?.('Unable to track Results analytics:', { error: err.message });
    }

    return { transition: GetDataTransition.GotData, result: data.result };
  }
}

// --- ParseDataNode -----------------------------------------------------------------------

export class ParseDataNode extends DefaultNode {
  async exit(data) {
    const log = data.log;
    const localISO = data.runtime.location && data.runtime.location.iso;
    const result = data.result;

    data.local = Object.assign(data.local, { views: {} });
    if (!result) return { transition: DefaultTransition.Done };

    if (result.weather) {
      try { data.local.weather = weather.weatherParse(result.weather, data.local.userPrefs); }
      catch (err) { log?.error?.('Error parsing weather:', { error: err.message }); }
    }
    if (result.calendar) {
      try { data.local.calendar = calendar.calendarParse(result.calendar, data); }
      catch (err) { log?.error?.('Error parsing calendar:', { error: err.message }); }
    }
    if (result.commute) {
      try { data.local.commute = await commute.commuteParse(result.commute, localISO, data.local); }
      catch (err) { log?.error?.('Error parsing commute:', { error: err.message }); }
    }
    if (result.news) {
      try { data.local.news = news.newsParse(result.news); }
      catch (err) { log?.error?.('Error parsing news:', { error: err.message }); }
    }
    return { transition: DefaultTransition.Done };
  }
}
