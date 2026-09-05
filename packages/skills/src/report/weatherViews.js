// Weather GUI view construction from report-skill/subskills/weather/WeatherViews.ts.
// The asset names intentionally retain the Nimbus-compatible report-skill path.

import { getJSON, tempThresholds } from './utils.js';

const NIMBUS_IMG_PATH = 'assets/personal-report-skill/weather';
const TEMP_VIEW = 'views/weatherHiLo';

const TEMP_BACKGROUND = Object.freeze({ HOT: 'Hot', COLD: 'Cold', NORMAL: 'Normal' });

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/** Build the source weather high/low view for the selected unit system. */
export async function hiLoTempView(weatherData, useCelsius) {
  const highTemp = weatherData.highTemp;
  const lowTemp = weatherData.lowTemp;
  const weatherView = clone(await getJSON(TEMP_VIEW));
  const [tempBG, tempIcon, hiNum, hiUnit, loNum, loUnit] = weatherView.componentConfigs;
  const { hotThreshold, coldThreshold } = tempThresholds(useCelsius);
  const unit = useCelsius ? 'C' : 'F';

  const tempBGName = highTemp > hotThreshold
    ? TEMP_BACKGROUND.HOT
    : highTemp < coldThreshold ? TEMP_BACKGROUND.COLD : TEMP_BACKGROUND.NORMAL;
  tempBG.assets[0].src = `${NIMBUS_IMG_PATH}/bg/temp${tempBGName}_v01.crn`;
  tempIcon.assets[0].src = `${NIMBUS_IMG_PATH}/icons/${weatherData.icon}_v01.crn`;

  hiNum.text = `${highTemp}°`;
  loNum.text = `${lowTemp}°`;
  hiUnit.text = unit;
  loUnit.text = unit;

  hiNum.position.x = xPositionWithOffset(hiNum, highTemp);
  hiUnit.position.x = xPositionWithOffset(hiUnit, highTemp);
  loNum.position.x = xPositionWithOffset(loNum, lowTemp);
  loUnit.position.x = xPositionWithOffset(loUnit, lowTemp);
  return weatherView;
}

function xPositionWithOffset(label, temperature) {
  const x = typeof label.position.x === 'string' ? Number.parseInt(label.position.x, 10) : label.position.x;
  if (temperature < -9 || temperature > 99) return x + 70;
  if (temperature < 10 && temperature >= 0) return x - 70;
  return x;
}
