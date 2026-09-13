'use strict';

// Frozen Google Maps-shaped responses for the Report commute graph. The peer
// intentionally returns the legacy Lasso envelope so Pegasus and Phoenix use
// the same provider boundary without reaching a real Maps service.

function buildMapsResponse(item) {
  const prefs = item.prefs || {};
  const leg = {
    duration: { value: prefs.baseSeconds },
  };
  if (prefs.trafficSeconds !== undefined && prefs.trafficSeconds !== null) {
    leg.duration_in_traffic = { value: prefs.trafficSeconds };
  }
  return {
    status: 'OK',
    geocoded_waypoints: [],
    routes: [{ legs: [leg] }],
  };
}

function buildResponse(item) {
  switch (item.fixture) {
    case 'empty-envelope':
      return { lassoDataFromRedis: false };
    case 'null-envelope':
      return { relayData: null, lassoDataFromRedis: false };
    case 'empty-routes':
      return {
        relayData: { status: 'OK', geocoded_waypoints: [], routes: [] },
        lassoDataFromRedis: false,
      };
    case 'malformed-route':
      return {
        relayData: { status: 'OK', geocoded_waypoints: [], routes: [{ legs: [] }] },
        lassoDataFromRedis: false,
      };
    case 'normal':
    default:
      return { relayData: buildMapsResponse(item), lassoDataFromRedis: false };
  }
}

// The HTTP graph matrix keeps the non-commute services deliberately small. A
// calendar request is still a real provider hop (used by the commute/calendar
// dependency case), while the all-services-down case fails before parsing any
// successful payload. Keeping these envelopes here makes the peer useful for
// expanding the matrix without importing a live provider or network.
function buildCalendarResponse(item) {
  if (item.calendarFixture === 'malformed-envelope') return { lassoDataFromRedis: false };
  return {
    relayData: { events: [] },
    lassoDataFromRedis: false,
  };
}

function buildWeatherResponse(item, historical) {
  return {
    relayData: historical ? {
      daily: { data: [{ summary: 'Yesterday clear', icon: 'clear-day', temperatureHigh: 57.7, temperatureLow: 54.35 }] },
    } : {
      currently: { icon: 'cloudy', temperature: 65, summary: 'Cloudy now' },
      daily: { data: [
        { summary: 'Today rain', icon: 'rain', temperatureHigh: 50.3, temperatureLow: 45.83 },
        { summary: 'Tomorrow fog', icon: 'fog', temperatureHigh: 55.3, temperatureLow: 40.83 },
      ] },
    },
    lassoDataFromRedis: false,
  };
}

function buildNewsResponse() {
  // No success-path news case is in this commute lane. Return a valid relay
  // envelope anyway so adding one cannot silently reach an external service.
  return { relayData: '<rss><channel></channel></rss>', lassoDataFromRedis: false };
}

function buildProviderResponse(service, item, query) {
  if (service === 'maps') return buildResponse(item);
  if (service === 'calendar') return buildCalendarResponse(item);
  if (service === 'weather') return buildWeatherResponse(item, query && query.secondsSinceEpoch !== undefined);
  if (service === 'news') return buildNewsResponse(item);
  throw new Error(`unknown fixture provider: ${service}`);
}

module.exports = {
  buildMapsResponse,
  buildResponse,
  buildCalendarResponse,
  buildWeatherResponse,
  buildNewsResponse,
  buildProviderResponse,
};
