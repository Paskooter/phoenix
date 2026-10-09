const COORDINATE = /^-?\d+\.?\d*$/;

function coordinateError(label, value) {
  return new TypeError(`Invalid ${label} coordinate: ${String(value)}`);
}

export function validateCoordinate(value, label) {
  if (typeof value === 'number') {
    if (Number.isFinite(value) && value >= (label === 'latitude' ? -90 : -180)
      && value <= (label === 'latitude' ? 90 : 180)) return value;
    throw coordinateError(label, value);
  }
  if (typeof value === 'string' && COORDINATE.test(value)) {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric >= (label === 'latitude' ? -90 : -180)
      && numeric <= (label === 'latitude' ? 90 : 180)) return value;
  }
  throw coordinateError(label, value);
}

export function validateCoordinateString(value, label) {
  if (typeof value !== 'string') {
    throw new TypeError('latitude and longitude must be strings when supplied');
  }
  return validateCoordinate(value, label);
}
