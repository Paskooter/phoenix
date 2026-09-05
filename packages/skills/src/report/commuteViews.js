// Commute GUI view construction from report-skill/subskills/commute/CommuteViews.ts.

import { getJSON } from './utils.js';

const NIMBUS_IMG_PATH = 'assets/personal-report-skill/commute';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/** Populate the traffic texture selected by the source extra-minute bands. */
export async function trafficView(extraMins) {
  const condition = extraMins >= 15 ? 'Terrible' : extraMins >= 5 ? 'Bad' : 'Normal';
  const view = clone(await getJSON('views/commuteTraffic'));
  view.componentConfigs[0].assets[0].src = `${NIMBUS_IMG_PATH}/traffic${condition}_v01.crn`;
  return view;
}

/** Populate the source departure time labels from the parsed DateTime. */
export async function departView(commuteData) {
  const view = clone(await getJSON('views/commuteDepart'));
  const [, departTime, departAmPm] = view.componentConfigs;
  const [time, ampm] = commuteData.departDT.toString({ timeOnly: true }).split(' ');
  departTime.text = time;
  departAmPm.text = ampm;
  return view;
}
