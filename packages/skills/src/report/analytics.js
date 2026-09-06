// Personal Report results analytics — port of report-skill/src/Analytics.ts.
//
// The results event describes the categories selected by user preferences and
// whether each selected provider returned a value. It is deliberately separate
// from the framework Skill Entry event and from the raw result object.

import { Names } from './utils.js';

export const RESULTS_EVENT = 'Personal Report Results';

/**
 * Build the source-shaped properties for the Personal Report Results event.
 *
 * Source order is observable in the serialized analytics object, so retain
 * the source category order: weather, calendar, commute, news.
 */
export function buildResultsAnalytics(data) {
  const configured = data.skill.session.data._personalReport.userPrefsConfigured;
  const categories = [Names.weather, Names.calendar, Names.commute, Names.news];
  const categoryData = [];
  const serviceData = [];

  categories.forEach((category) => {
    if (data.local.userPrefs[category].active) {
      categoryData.push(category);
      serviceData.push(`${category}=${data.result[category] ? 'up' : 'down'}`);
    }
  });

  return {
    details: categoryData.join(','),
    service_details: serviceData.join(','),
    config_state: configured ? 'configured' : 'not configured',
  };
}
