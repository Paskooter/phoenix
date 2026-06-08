// report-skill — daily personal briefing. Phoenix port of packages/report-skill (lean).
// Speaks weather + a news headline, fetched from the data service (lasso) via NET_data when
// available; falls back gracefully when it isn't. Returns a wire-faithful SKILL_ACTION.

import { newMsgId } from '@phoenix/contracts';
import { buildSkillAction } from './jcp.js';

const DATA_URL = process.env.NET_data ? (/^https?:\/\//.test(process.env.NET_data) ? process.env.NET_data : `http://${process.env.NET_data}`) : '';

export async function reportSkill(request) {
  const data = request.data || {};
  const loc = (data.runtime && data.runtime.location) || {};
  const sessionId = (data.skill && data.skill.session && data.skill.session.id) || newMsgId();

  const parts = ['Here is your personal report.'];
  const weather = await getWeather(loc);
  if (weather) parts.push(weather);
  const news = await getNews();
  if (news) parts.push(news);
  if (parts.length === 1) parts.push("I don't have your weather or news connected right now.");

  return buildSkillAction({
    skillId: 'report-skill',
    esmlText: parts.join(' '),
    sessionId,
    sessionData: { _report: { at: Date.now() } },
    mimId: 'PersonalReport',
    analytics: { 'report-skill': [{ event: 'Skill Entry', properties: { initial_intent: 'launchPersonalReport' } }] },
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
    return m ? `In the news: ${m[1]}.` : null;
  } catch { return null; }
}
