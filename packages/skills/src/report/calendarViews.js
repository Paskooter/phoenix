// Calendar GUI view construction from report-skill/subskills/calendar/CalendarViews.ts.

import { getJSON, Names } from './utils.js';

const NIMBUS_IMG_PATH = 'assets/personal-report-skill/calendar';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/** Build source calendar event cards, preserving one view per parsed event. */
export async function calEventViews(events, data) {
  if (!events || !events.length) return [];
  const template = await getJSON('views/calendarEvent');
  const iconWords = await getJSON('views/calendarIconWords');
  return events.map((event, index, allEvents) => {
    if (!event || !event.dateTime) return null;
    const view = clone(template);
    const eventHour = event.dateTime.getLocalTime().hour;
    const timeOfDay = eventHour < 12 ? 'Morning' : eventHour < 19 ? 'Afternoon' : 'Night';
    const icon = getIconImgName(iconWords, event.summary);
    const [cardClip, iconClip, timeLabel, ampmLabel, eventSummary] = view.componentConfigs;

    cardClip.assets[0].src = `${NIMBUS_IMG_PATH}/cards/event${timeOfDay}_v01.crn`;
    iconClip.assets[0].src = `${NIMBUS_IMG_PATH}/icons/${icon}_v01.crn`;
    if (!event.fullDay) {
      const { time, ampm } = sanitizeTimeText(event.dateTime);
      timeLabel.text = time;
      ampmLabel.text = ampm;
    }
    const minutesVisibleOffset = timeLabel.text.includes(':') ? 125 : 0;
    timeLabel.position.x += minutesVisibleOffset;
    ampmLabel.position.x += minutesVisibleOffset;
    eventSummary.text = sanitizeSummaryText(event.summary);

    const reportData = data && data.skill && data.skill.session && data.skill.session.data
      ? data.skill.session.data._personalReport : undefined;
    if (reportData && reportData.singleSkill === Names.calendar) {
      view.defaultSelect.leaveEmpty = index === allEvents.length - 1 ? false : true;
    }
    return view;
  });
}

function getIconImgName(iconWords, summary) {
  if (iconWords) {
    for (const key of Object.keys(iconWords)) {
      if (new RegExp(iconWords[key], 'ig').test(summary)) return key;
    }
  }
  return 'calendar';
}

function sanitizeTimeText(dateTime) {
  const [fullTime, ampm] = dateTime.toString({ timeOnly: true }).split(' ');
  const time = dateTime.getLocalTime().minute ? fullTime : fullTime.split(':')[0];
  return { time, ampm };
}

function sanitizeSummaryText(summary) {
  return summary.length > 50 ? `${summary.slice(0, 47)}...` : summary;
}
