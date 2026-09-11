// The PromptData location is a jibo-data-utils Location.  The runtime already
// supplies the resolved fields; this helper adds the source's region and
// string methods without performing a provider lookup.

// The pinned jibo-data-utils `toTitleCase`/`areStringsEqual` helpers call
// String prototype methods directly; they never coerce.  A non-string runtime
// location field therefore throws out of `toString`, `equals`, `isLocal`,
// `getStandardName` and `prefixIn` instead of being stringified.  The parameter
// names are kept as the source has them so the thrown TypeError messages stay
// byte-identical ("str.replace is not a function",
// "strA.toLowerCase is not a function").
function titleCase(str) {
  return str.replace(/\w\S*/g, word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase());
}
function sameString(strA, strB) {
  if (strA && !strB) return false;
  if (strB && !strA) return false;
  if (!strA && !strB) return true;
  return strA.toLowerCase() === strB.toLowerCase();
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
    // Source behaviour: a string is matched whole, anything else is walked by
    // `length`.  A non-array without `length` (or null) therefore either misses
    // or throws exactly as the original does; do not invent an array guard.
    for (let i = 0, length = regions.length; i < length; ++i) {
      if (this.calculatedRegions.indexOf(regions[i]) > -1) return true;
    }
    return false;
  }

  equals(loc) {
    if (this === loc) return true;
    return sameString(this.city, loc.city) && sameString(this.stateAbbr, loc.stateAbbr) && sameString(this.country, loc.country);
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
