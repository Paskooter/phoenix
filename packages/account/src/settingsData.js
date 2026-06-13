// Report-skill settings: the PersonalReportSettingsData wire shape (a flat map of
// {key:{value}|{hour,min}|{lat,lng}|{credentialExists}}) the report-skill's SettingsClient reads
// via `convertSettingsToPrefs` — and a friendly {weather,news,commute,calendar} representation
// the portal editor uses. Defaults mirror SettingsClient.getDefaultPrefs (weather+news on).

const COMMUTE_MODES = ['driving', 'walking', 'bicycling', 'transit'];

const NEWS_CATS = ['technology', 'sports', 'business', 'science', 'entertainment', 'strange',
  'health', 'international', 'national', 'politics'];
const newsKey = (cat) => `news${cat[0].toUpperCase()}${cat.slice(1)}`; // technology -> newsTechnology

/** The wire-shape default (weather °F + news tech/sports/business/national on; commute+cal off). */
export function defaultSettingsData() {
  const data = {
    weatherEnabled: { value: 1 }, weather: { value: 0 },
    calendarEnabled: { value: 0 },
    'google:personalCalendar:readonly': { credentialExists: false },
    'google:workCalendar:readonly': { credentialExists: false },
    'outlook:personalCalendar:readonly': { credentialExists: false },
    'outlook:workCalendar:readonly': { credentialExists: false },
    commuteEnabled: { value: 0 }, commuteTime: { hour: 9, min: 0 },
    homeLocation: { lat: null, lng: null }, workLocation: { lat: null, lng: null },
    commuteType: { value: 0 },
    newsEnabled: { value: 1 },
  };
  const onByDefault = new Set(['technology', 'sports', 'business', 'national']);
  for (const cat of NEWS_CATS) data[newsKey(cat)] = { value: onByDefault.has(cat) ? 1 : 0 };
  return data;
}

const get = (d, k, p) => (d[k] && d[k][p]);

/** Wire data -> the friendly object the portal renders/edits. */
export function dataToFriendly(d) {
  return {
    weather: { active: !!get(d, 'weatherEnabled', 'value'), celsius: !!get(d, 'weather', 'value') },
    news: {
      active: !!get(d, 'newsEnabled', 'value'),
      categories: Object.fromEntries(NEWS_CATS.map((c) => [c, !!get(d, newsKey(c), 'value')])),
    },
    commute: {
      active: !!get(d, 'commuteEnabled', 'value'),
      home: { lat: get(d, 'homeLocation', 'lat'), lng: get(d, 'homeLocation', 'lng') },
      work: { lat: get(d, 'workLocation', 'lat'), lng: get(d, 'workLocation', 'lng') },
      time: { hour: get(d, 'commuteTime', 'hour'), min: get(d, 'commuteTime', 'min') },
      mode: COMMUTE_MODES[get(d, 'commuteType', 'value') || 0],
    },
    calendar: {
      active: !!get(d, 'calendarEnabled', 'value'),
      googlePersonal: !!get(d, 'google:personalCalendar:readonly', 'credentialExists'),
      googleWork: !!get(d, 'google:workCalendar:readonly', 'credentialExists'),
      outlookPersonal: !!get(d, 'outlook:personalCalendar:readonly', 'credentialExists'),
      outlookWork: !!get(d, 'outlook:workCalendar:readonly', 'credentialExists'),
    },
  };
}

/** Friendly object (partial OK) -> wire data, merged over the current data. */
export function friendlyToData(friendly, base = defaultSettingsData()) {
  const d = JSON.parse(JSON.stringify(base));
  const f = friendly || {};
  if (f.weather) {
    if ('active' in f.weather) d.weatherEnabled = { value: f.weather.active ? 1 : 0 };
    if ('celsius' in f.weather) d.weather = { value: f.weather.celsius ? 1 : 0 };
  }
  if (f.news) {
    if ('active' in f.news) d.newsEnabled = { value: f.news.active ? 1 : 0 };
    if (f.news.categories) for (const cat of NEWS_CATS) {
      if (cat in f.news.categories) d[newsKey(cat)] = { value: f.news.categories[cat] ? 1 : 0 };
    }
  }
  if (f.commute) {
    if ('active' in f.commute) d.commuteEnabled = { value: f.commute.active ? 1 : 0 };
    if (f.commute.home) d.homeLocation = { lat: f.commute.home.lat ?? null, lng: f.commute.home.lng ?? null };
    if (f.commute.work) d.workLocation = { lat: f.commute.work.lat ?? null, lng: f.commute.work.lng ?? null };
    if (f.commute.time) d.commuteTime = { hour: f.commute.time.hour ?? 9, min: f.commute.time.min ?? 0 };
    if (f.commute.mode) d.commuteType = { value: Math.max(0, COMMUTE_MODES.indexOf(f.commute.mode)) };
  }
  if (f.calendar) {
    if ('active' in f.calendar) d.calendarEnabled = { value: f.calendar.active ? 1 : 0 };
    if ('googlePersonal' in f.calendar) d['google:personalCalendar:readonly'] = { credentialExists: !!f.calendar.googlePersonal };
    if ('googleWork' in f.calendar) d['google:workCalendar:readonly'] = { credentialExists: !!f.calendar.googleWork };
    if ('outlookPersonal' in f.calendar) d['outlook:personalCalendar:readonly'] = { credentialExists: !!f.calendar.outlookPersonal };
    if ('outlookWork' in f.calendar) d['outlook:workCalendar:readonly'] = { credentialExists: !!f.calendar.outlookWork };
  }
  return d;
}

// -- store-backed accessors ---------------------------------------------------

export function getSettingsData(store, accountId) {
  const rec = store.settings.get(accountId);
  return (rec && rec.data) || defaultSettingsData();
}

export function setSettingsData(store, accountId, data) {
  store.settings.set(accountId, { _id: accountId, data, updated: Date.now() });
  store.flush();
  return data;
}
