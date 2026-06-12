// Calendar subskill — E.8b placeholder for report-skill/src/subskills/calendar/*. The graph
// shape and the ServiceDown degradation are faithful; CalendarParse/CalendarMimLogic's full
// event tables (EarlyEvent/EventCount/Parallel/SummaryAndTime/TomorrowOnly...) are the next
// port increment. With the settings service dead, calendar only activates via
// ETCO_report_prefsFromConfig, so the live paths today are MustBeLooper/MustBeAdult/
// SettingsFailed (handled before this graph) and ServiceDown (here).

import { Graph } from '../graph/graph.js';
import { DefaultNode, DefaultTransition } from '../graph/nodes.js';
import { Names, addMimPathsToLocalData } from './utils.js';
import { LassoClient } from './lassoClient.js';

export const MimPath = Object.freeze({ ServiceDown: 'ServiceDown', AppSetup: 'AppSetup' });

/** Fetch events from every credentialed calendar (CalendarData.getData). */
export async function getData(userPrefs, data) {
  const log = data.log;
  const prefs = userPrefs.calendar;
  const sources = [
    prefs.googlePersonalCreds && ['google', 'personalCalendar'],
    prefs.googleWorkCreds && ['google', 'workCalendar'],
    prefs.outlookPersonalCreds && ['outlook', 'personalCalendar'],
    prefs.outlookWorkCreds && ['outlook', 'workCalendar'],
  ].filter(Boolean);
  if (!sources.length) return [Names.calendar, null];

  const endDate = new Date(Date.now() + 48 * 3600 * 1000).toISOString();
  try {
    const responses = await Promise.all(sources.map(([service, cal]) =>
      LassoClient.fetchCalendarEvents(data, service, cal, endDate).catch((err) => {
        log?.error?.(`Calendar fetch failed (${service}/${cal}): ${err.message}`);
        return null;
      })));
    const events = responses.filter(Boolean).flatMap((r) => (r && r.events) || r || []);
    return [Names.calendar, events.length ? events : null];
  } catch (err) {
    log?.error?.(`Error getting calendar data: ${err.message}`);
    return [Names.calendar, null];
  }
}

/** E.8b: full CalendarParse port (event windows, all-day handling, parallel events). */
export function calendarParse(events) {
  return events && events.length ? { events } : undefined;
}

export class CalendarMimLogic extends DefaultNode {
  async exit(data) {
    // E.8b: full CalendarMimLogic condition tables. Until then: data -> nothing spoken
    // (avoids non-reference improvised dialog), no data -> faithful ServiceDown.
    if (!data.local.calendar) {
      data.local.mimPaths = addMimPathsToLocalData(Names.calendar, [MimPath.ServiceDown], data.local);
    }
    return { transition: DefaultTransition.Done };
  }
}

export const CalendarTransition = Object.freeze({ Done: 'Done' });

export class CalendarFactory {
  createGraph(gm) {
    const g = new Graph(gm, 'Calendar', Object.values(CalendarTransition));
    const logicNode = new CalendarMimLogic('Calendar Logic');
    const outroNode = new DefaultNode('Calendar Outro');
    g.addNode(logicNode, [[DefaultTransition.Done, outroNode]]);
    g.addNode(outroNode, [[DefaultTransition.Done, CalendarTransition.Done]]);
    g.finalize();
    return g;
  }
}
