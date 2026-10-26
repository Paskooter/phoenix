// Shared by the console and Account: validate literal values, never rewrite them.
const hasLoneSurrogate = (value) => [...value].some((character) => {
  const unit = character.charCodeAt(0);
  return character.length === 1 && unit >= 0xd800 && unit <= 0xdfff;
});
const isIPv4 = (value) => typeof value === 'string'
  && /^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(value)
  && value.split('.').every((part) => Number(part) <= 255);

/** Return the first actionable error, or null. Lengths match Jibo's Wi-Fi API. */
export function wifiDetailsError({ ssid, password = '', staticConfig = null }) {
  if (typeof ssid !== 'string' || ssid.length === 0) return 'Enter your Wi-Fi network name.';
  if (new TextEncoder().encode(ssid).length > 32) {
    return 'That Wi-Fi name is too long for Jibo. Wi-Fi names are at most 32 characters, fewer with accents or emoji.';
  }
  if (typeof password !== 'string' || (password.length !== 0 && (password.length < 8 || password.length > 63))) {
    return 'Wi-Fi passwords are 8 to 63 characters. Leave it blank only for an open network.';
  }
  if (ssid.includes('\n') || password.includes('\n')) return "Wi-Fi names and passwords can't contain line breaks.";
  if (hasLoneSurrogate(ssid) || hasLoneSurrogate(password)) {
    return "That Wi-Fi name or password has a character Jibo can't use. Retype it and try again.";
  }
  if (staticConfig !== null && (typeof staticConfig !== 'object' || Array.isArray(staticConfig)
    || !['ip', 'netmask', 'gateway'].every((key) => isIPv4(staticConfig[key]))
    || !['dns1', 'dns2'].every((key) => staticConfig[key] === undefined || staticConfig[key] === '' || isIPv4(staticConfig[key])))) {
    return 'Check the static network settings: IP address, subnet mask and gateway must be valid addresses.';
  }
  return null;
}
