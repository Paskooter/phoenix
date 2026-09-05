// The PromptData location is a jibo-data-utils Location.  The runtime already
// supplies the resolved fields; this helper adds the source's region and
// string methods without performing a provider lookup.

function titleCase(value) {
  return String(value).replace(/\w\S*/g, word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase());
}
function sameString(a, b) {
  if (a && !b) return false;
  if (b && !a) return false;
  if (!a && !b) return true;
  return String(a).toLowerCase() === String(b).toLowerCase();
}

const JIBO_HOME = Object.freeze({
  city: 'boston',
  stateAbbr: 'ma',
  state: 'Massachusetts',
  country: 'usa',
  countryCode: 'US',
  lat: 42.313352,
  lng: -71.1273681,
});

export class PromptLocation {
  constructor(data = {}, timezone = null) {
    this.city = data.city;
    this.stateAbbr = data.stateAbbr;
    this.state = data.state;
    this.country = data.country;
    this.countryCode = data.countryCode;
    this.needsTimezone = false;
    this.timezone = timezone;
    this.lat = data.lat;
    this.lng = data.lng;
    this.latLongBounds = null;
    this.calculatedRegions = null;
  }

  calculateRegions() {
    const regions = [];
    if (this.countryCode) {
      regions.push(String(this.countryCode).toUpperCase());
      if (this.stateAbbr) regions.push(`${String(this.countryCode).toUpperCase()}-${String(this.stateAbbr).toUpperCase()}`);
    }
    return regions;
  }

  isInRegion(regions) {
    if (!this.calculatedRegions) this.calculatedRegions = this.calculateRegions();
    if (typeof regions === 'string') return this.calculatedRegions.indexOf(regions) > -1;
    if (!Array.isArray(regions)) return false;
    return regions.some(region => this.calculatedRegions.indexOf(region) > -1);
  }

  equals(other) {
    if (this === other) return true;
    if (!other) return false;
    return sameString(this.city, other.city) && sameString(this.stateAbbr, other.stateAbbr) && sameString(this.country, other.country);
  }

  get isLocal() {
    return this.equals(JIBO_HOME);
  }

  getStandardName() {
    if (this.equals(JIBO_HOME)) return '';
    let result = '';
    if (this.city) result += this.city;
    if (this.state && (!this.city || this.countryCode === JIBO_HOME.countryCode || this.countryCode === 'US')) result += `${result ? ' ' : ''}${this.state}`;
    if (this.country && this.countryCode !== JIBO_HOME.countryCode && this.countryCode !== 'US') result += `${result ? ' ' : ''}${this.country}`;
    return result;
  }

  prefixIn() {
    if (this.equals(JIBO_HOME)) return '';
    return `In ${this.getStandardName()}`;
  }

  toString() {
    let result = '';
    if (this.city) result += titleCase(this.city);
    if (this.state && (!this.city || this.countryCode === JIBO_HOME.countryCode)) {
      result += `${result ? ', ' : ''}${this.countryCode && String(this.countryCode).toUpperCase() === 'US' && this.stateAbbr ? String(this.stateAbbr).toUpperCase() : this.state}`;
    }
    if (this.country && this.countryCode !== JIBO_HOME.countryCode) {
      result += `${result ? ', ' : ''}${this.countryCode === 'US' ? 'USA' : titleCase(this.country)}`;
    }
    return result;
  }

  toLog() {
    return `[Location: ${this.toString()}]`;
  }

  toJSON() {
    return {
      __type: 'Location', city: this.city, state: this.state, stateAbbr: this.stateAbbr,
      country: this.country, countryCode: this.countryCode, lat: this.lat, lng: this.lng,
      timezone: this.timezone && typeof this.timezone.toJSON === 'function' ? this.timezone.toJSON() : this.timezone,
    };
  }
}
