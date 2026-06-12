// Calendar subskill — full port of report-skill/src/subskills/calendar/{CalendarFactory,
// CalendarData,CalendarParse,CalendarMimLogic}.ts. Events from every credentialed calendar are
// merged + sorted; parse classifies today/tomorrow, all-day and early-vs-work-time; MimLogic
// picks the summary MIM (EventToday[FullDay]/NothingToday/EventTomorrow[FullDay]/Nothing +
// EarlyEvent) for the full report, or the count + per-event SummaryAndTime/ParallelEvent walk
// (+ TomorrowOnly/Outro) for a single-skill launch.

import { Graph } from '../graph/graph.js';
import { DefaultNode, DefaultTransition } from '../graph/nodes.js';
import { Names, addMimPathsToLocalData, askedForTomorrow, getJSON } from './utils.js';
import { LassoClient } from './lassoClient.js';
import { DateTime } from './dateTime.js';

export const MimPath = Object.freeze({
  ServiceDown: 'ServiceDown', Nothing: 'Nothing', NothingToday: 'NothingToday',
  EventToday: 'EventToday', EventTomorrow: 'EventTomorrow',
  EventTodayFullDay: 'EventTodayFullDay', EventTomorrowFullDay: 'EventTomorrowFullDay',
  EarlyEvent: 'EarlyEvent', AppSetup: 'AppSetup',
  EventCountToday: 'EventCountToday', EventCountTomorrow: 'EventCountTomorrow',
  SummaryAndTime: 'SummaryAndTime', ParallelEvent: 'ParallelEvent',
  TomorrowOnly: 'TomorrowOnly', Outro: 'Outro',
});

// --- CalendarData ---------------------------------------------------------------

/** End of tomorrow in the location's timezone, ISO. */
function endOfTomorrowISO(iso) {
  const dt = new DateTime(iso);
  dt.utc += 24 * 3600 * 1000;
  dt.setTime(23, 59, 59, 999);
  return new Date(dt.utc).toISOString();
}

export async function getData(userPrefs, data) {
  const log = data.log;
  const prefs = userPrefs.calendar;
  const iso = data.runtime.location.iso;
  const endDate = endOfTomorrowISO(iso);

  try {
    const personalEventsPromise = prefs.googlePersonalCreds ? LassoClient.fetchCalendarEvents(data, 'google', 'personalCalendar', endDate)
      : prefs.outlookPersonalCreds ? LassoClient.fetchCalendarEvents(data, 'outlook', 'personalCalendar', endDate)
        : null;
    const workEventsPromise = prefs.googleWorkCreds ? LassoClient.fetchCalendarEvents(data, 'google', 'workCalendar', endDate)
      : prefs.outlookWorkCreds ? LassoClient.fetchCalendarEvents(data, 'outlook', 'workCalendar', endDate)
        : null;

    if (personalEventsPromise === null && workEventsPromise === null) return [Names.calendar, []];

    const [personalCal, workCal] = await Promise.all([personalEventsPromise, workEventsPromise]);
    const personalEvents = personalCal ? personalCal.events : [];
    const workEvents = workCal ? workCal.events : [];
    const mergedEvents = [...personalEvents, ...workEvents]
      .sort((a, b) => a.start.timestamp - b.start.timestamp);
    return [Names.calendar, mergedEvents];
  } catch (err) {
    log?.error?.(`Failed to get calendar events from Lasso: ${err.message}`);
    return [Names.calendar, null];
  }
}

// --- CalendarParse ------------------------------------------------------------------

function isEventNDaysFromNow(event, offsetDays) {
  if (!event.start || !event.start.dateTime) return null;
  const dt = new DateTime(event.start.dateTime);
  // fullDay events start at 00:00, so include them even if the start is past.
  return (dt.isFuture() || event.fullDay) && (dt.getRelativeDays() === offsetDays);
}

/** Normal work-arrival DateTime on the day (today/tomorrow) of the next event. */
export function getWorkArrivalDT(nextEvent, localISO, workTime = { hour: 9, min: 0 }) {
  const dt = new DateTime(localISO);
  dt.setTime(workTime.hour, workTime.min);
  if (nextEvent && isEventNDaysFromNow(nextEvent, 1)) dt.utc += 24 * 3600 * 1000;
  return dt;
}

export function calendarParse(rawEvents, data) {
  if (!rawEvents || !Array.isArray(rawEvents)) return undefined;
  const eventsToday = rawEvents.filter((e) => isEventNDaysFromNow(e, 0));
  const eventsTomorrow = rawEvents.filter((e) => isEventNDaysFromNow(e, 1));
  const numEventsToday = eventsToday.length;
  const numEventsTomorrow = eventsTomorrow.length;

  const upcomingEvents = (!!numEventsToday && !askedForTomorrow(data)) ? eventsToday : eventsTomorrow;

  const workTime = data.local.userPrefs && data.local.userPrefs.commute && data.local.userPrefs.commute.workTime;
  const firstNonAllDayEvent = upcomingEvents.find((event) => !event.fullDay);
  const workArrivalDT = getWorkArrivalDT(firstNonAllDayEvent, data.runtime.location.iso, workTime || undefined);

  const events = upcomingEvents.map((event) => {
    const fullDay = event.fullDay;
    const summary = event.summary || 'No event description';
    const dateTime = new DateTime(event.start.dateTime); // validated by isEventNDaysFromNow
    const isEarly = (!fullDay && workArrivalDT) ? (dateTime.utc < workArrivalDT.utc) : false;
    return { isEarly, summary, dateTime, fullDay };
  });

  return { events, workArrivalDT, numEventsToday, numEventsTomorrow };
}

// --- CalendarMimLogic -------------------------------------------------------------------

export class CalendarMimLogic extends DefaultNode {
  async exit(data) {
    const log = data.log;
    let mimPaths;
    try {
      mimPaths = await this.getMimPaths(data, log);
    } catch (err) {
      log?.error?.('Error getting MIM path:', { error: err.message });
      mimPaths = [MimPath.ServiceDown];
    }

    data.local.mimPaths = addMimPathsToLocalData(Names.calendar, mimPaths, data.local);
    data.local.views.calendarEvents = {}; // GUI views not rendered in Phoenix sim

    return { transition: DefaultTransition.Done };
  }

  async getMimPaths(data, log) {
    if (!this.anyCalendarsConnected(data)) return [MimPath.AppSetup];
    if (!data.local.calendar || !data.local.calendar.events) return [MimPath.ServiceDown];

    if (data.skill.session.data._personalReport.singleSkill === Names.calendar) {
      return this.getSingleSkillMims(data, log);
    }
    return this.getFullReportMims(data);
  }

  anyCalendarsConnected(data) {
    const calPrefs = data.local.userPrefs && data.local.userPrefs.calendar;
    return !!calPrefs && (
      calPrefs.googlePersonalCreds || calPrefs.googleWorkCreds
      || calPrefs.outlookPersonalCreds || calPrefs.outlookWorkCreds
    );
  }

  getSingleSkillMims(data, log) {
    const calData = data.local.calendar;

    let countMimPaths;
    if (askedForTomorrow(data)) {
      if (!calData.numEventsTomorrow) return [MimPath.Nothing];
      countMimPaths = [MimPath.EventCountTomorrow]; // explicit "tomorrow" ask: no TomorrowOnly
    } else if (calData.numEventsToday) {
      countMimPaths = [MimPath.EventCountToday];
    } else if (calData.numEventsTomorrow) {
      countMimPaths = [MimPath.TomorrowOnly, MimPath.EventCountTomorrow];
    } else {
      return [MimPath.Nothing];
    }

    const MAX_DAILY_EVENTS = 5;
    const calEvents = calData.events.slice(0, MAX_DAILY_EVENTS);
    const promptText = getJSON('report-mimPromptText');

    const eventMimPaths = [];
    calData.eventSummaries = [];
    calData.eventTimesOnAt = [];

    calEvents.forEach((event, i, arr) => {
      const prev = arr[i - 1];
      // Concurrent events (after the first) get the ParallelEvent phrasing.
      eventMimPaths.push((prev && prev.dateTime.utc === event.dateTime.utc) ? MimPath.ParallelEvent : MimPath.SummaryAndTime);

      const eventTimeOnAt = event.fullDay ? promptText.calendar.fullDay[0]
        : event.dateTime.toString({ prefixOnAt: true });
      calData.eventTimesOnAt.push(eventTimeOnAt);
      calData.eventSummaries.push(event.summary);
    });

    if (calData.eventSummaries.length !== calData.eventTimesOnAt.length) {
      log?.warn?.('Summaries and Times array lengths are not equal');
      return [MimPath.ServiceDown];
    }

    return [...countMimPaths, ...eventMimPaths, MimPath.Outro];
  }

  getFullReportMims(data) {
    const localISO = data.runtime.location.iso;
    const calData = data.local.calendar;

    const isAfterNoon = new DateTime(localISO).getLocalTime().hour >= 12;
    const earlyEventExists = calData.events.some((event) => event.isEarly);
    const fullDayEventExists = calData.events.some((event) => event.fullDay);
    const mentionFullDay = !earlyEventExists && fullDayEventExists;

    const mimPaths = [this.getSummaryMim(calData, isAfterNoon, mentionFullDay)];
    if (earlyEventExists && !mimPaths[0].includes('Nothing')) mimPaths.push(MimPath.EarlyEvent);
    return mimPaths;
  }

  getSummaryMim(calData, isAfterNoon, mentionFullDay) {
    if (calData.numEventsToday) return mentionFullDay ? MimPath.EventTodayFullDay : MimPath.EventToday;
    if (!isAfterNoon) return MimPath.NothingToday;
    if (calData.numEventsTomorrow) return mentionFullDay ? MimPath.EventTomorrowFullDay : MimPath.EventTomorrow;
    return MimPath.Nothing;
  }
}

// --- CalendarFactory -------------------------------------------------------------------

export const CalendarTransition = Object.freeze({ Done: 'Done' });

export class CalendarFactory {
  createGraph(gm) {
    const g = new Graph(gm, 'Calendar', Object.values(CalendarTransition));
    const logicNode = new CalendarMimLogic('Calendar Mim Logic');
    const outroNode = new DefaultNode('Calendar Outro');
    g.addNode(logicNode, [[DefaultTransition.Done, outroNode]]);
    g.addNode(outroNode, [[DefaultTransition.Done, CalendarTransition.Done]]);
    g.finalize();
    return g;
  }
}
