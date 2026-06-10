// report-skill — personal briefing. Phoenix port of packages/report-skill (lean).
//
// Mirrors the reference IntentSplitNode (report-skill/src/nodes/IntentSplitNode.ts):
// the launch intent selects a SINGLE subskill, and only launchPersonalReport (or a
// proactive launch with no intent) runs the full report:
//   launchPersonalReport -> full report (weather + news)
//   requestWeatherPR     -> weather only
//   requestNews          -> news only
//   requestCommute       -> commute only
//   requestCalendar      -> calendar only
// Data comes from the data service (lasso) via NET_data; each subskill degrades
// gracefully when its source isn't reachable. Returns a wire-faithful SKILL_ACTION.

import { newMsgId } from '@phoenix/contracts';
import { buildSkillAction } from './jcp.js';

const DATA_URL = process.env.NET_data ? (/^https?:\/\//.test(process.env.NET_data) ? process.env.NET_data : `http://${process.env.NET_data}`) : '';

// Reference Names enum: which single subskill an intent selects (null = full report).
const INTENT_TO_SUBSKILL = {
  launchPersonalReport: null,
  requestWeatherPR: 'weather',
  requestNews: 'news',
  requestCommute: 'commute',
  requestCalendar: 'calendar',
};

export async function reportSkill(request) {
  const data = request.data || {};
  const result = data.result || {};
  const intent = (result.nlu && result.nlu.intent) || '';
  const loc = (data.runtime && data.runtime.location) || {};
  const sessionId = (data.skill && data.skill.session && data.skill.session.id) || newMsgId();

  const singleSkill = INTENT_TO_SUBSKILL[intent] !== undefined ? INTENT_TO_SUBSKILL[intent] : null;

  let text; let mimId;
  if (singleSkill === 'weather') {
    text = (await getWeather(loc)) || "I can't reach your weather right now.";
    mimId = 'WeatherReport';
  } else if (singleSkill === 'news') {
    const news = await getNews();
    text = news ? `Here's the latest news. ${news}` : "I can't reach your news right now.";
    mimId = 'NewsReport';
  } else if (singleSkill === 'commute') {
    text = "I don't have your commute set up yet. You can add your home and work locations in the Jibo app.";
    mimId = 'CommuteReport';
  } else if (singleSkill === 'calendar') {
    text = "I don't have your calendar connected yet. You can link an account in the Jibo app.";
    mimId = 'CalendarReport';
  } else {
    // Full report (launchPersonalReport, or proactive launch with no intent).
    const parts = ['Here is your personal report.'];
    const weather = await getWeather(loc);
    if (weather) parts.push(weather);
    const news = await getNews();
    if (news) parts.push(`In the news: ${news}`);
    if (parts.length === 1) parts.push("I don't have your weather or news connected right now.");
    text = parts.join(' ');
    mimId = 'PersonalReport';
  }

  return buildSkillAction({
    skillId: 'report-skill',
    esmlText: text,
    sessionId,
    sessionData: { _report: { at: Date.now(), singleSkill } },
    mimId,
    analytics: { 'report-skill': [{ event: 'Skill Entry', properties: { initial_intent: intent || 'launchPersonalReport' } }] },
  });
}

async function getWeather(loc) {
  if (!DATA_URL || loc.lat == null || loc.lng == null) return null;
  try {
    const r = await fetch(`${DATA_URL}/v1/dark_sky?lat=${loc.lat}&lon=${loc.lng}`);
    if (!r.ok) return null;
    const today = (await r.json())?.relayData?.daily?.data?.[1];
    if (!today) return null;
    return `Today's weather is ${today.summary}, with a high of ${Math.round(today.temperatureHigh)} degrees.`;
  } catch { return null; }
}

async function getNews() {
  if (!DATA_URL) return null;
  try {
    const r = await fetch(`${DATA_URL}/v1/ap_news?sourceID=42209`);
    if (!r.ok) return null;
    const xml = (await r.json())?.relayData || '';
    const m = /<apcm:ExtendedHeadLine>([^<]+)<\/apcm:ExtendedHeadLine>/.exec(xml);
    return m ? `${m[1]}.` : null;
  } catch { return null; }
}
