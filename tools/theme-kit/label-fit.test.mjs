// SPDX-License-Identifier: BSD-3-Clause
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Stock ordinary-menu wording across release/sideload configurations, including
// the complete home menu, Developer testing and the two multiline Yoga labels.
// Dynamic installed-app names are not a fixed stock set.
// These are data-only observations, not bundled firmware, fonts or artwork.
export const stockMenus = {
  '@be/main-menu#main-menu': ['Introductions', 'Things to do', 'Fun stuff', 'Clock',
    'Personal Report', 'Music', 'Snapshot', 'Gallery', 'Photobooth', 'Yoga',
    'Bot basics', 'Settings', 'Agent mode'],
  '@be/main-menu#fun-stuff': ['Circuit Saver', 'Word of the Day', 'Tell a joke', 'Dance', 'Surprise'],
  '@be/main-menu#personal-report': ['Full Report', 'Weather', 'Calendar', 'Commute', 'News'],
  '@be/clock#clockMenu': ['Time', 'Date', 'Timer', 'Alarm'],
  '@be/create#createMenu': ['Take a Photo', 'Photobooth'],
  '@be/exercise#exercise-menu': ['Sun Salutation\nBeginner (15 Min.)', 'Basic Warrior\nBeginner (17 Min.)'],
  '@be/settings#settingsMenu': ['Volume', 'Wi-Fi', 'Battery', 'About', 'Updates', 'Themes', 'Developer testing', 'Firewall', 'Shut down', 'Wipe'],
};

// Deterministic offline-preview metrics (em advances), deliberately not a claim
// about installed Proxima fonts. Keep the kit dependency-free. The private real
// renderer probe uses the same measurement boundary; hardware still needs review.
function advance(text) {
  const narrow = new Set(['i', 'l', '.']);
  return [...text].reduce((sum, c) => sum + (c === ' ' ? 0.30 :
    c === 'M' || c === 'W' ? 0.85 : narrow.has(c) ? 0.28 : 0.60), 0);
}
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
function labelFit(theme, menuKey, text) {
  const override = theme.overrides.find(o => o.menuKey === menuKey);
  const layout = override?.menuLayout ?? theme.menuLayout;
  const fonts = override?.fonts ?? theme.fonts;
  if (layout) {
    // API4 labels are a single line. fonts.labelSize is NOT the visible size.
    const tile = clamp(720 * layout.buttonSize / 100, 64, 480);
    const size = clamp(tile * layout.labelSize / 100, 24, 56);
    return { textWidth: advance(text.replace(/[\r\n\t]/g, ' ')) * size,
      textHeight: size * 1.15, size,
      width: clamp(tile * layout.labelWidth / 100, Math.min(32, tile - 16), tile - 16),
      height: Math.min(tile - 16, size * 1.35 + 2) };
  }
  // API1–3 preview cards wrap, then uniformly fit the COMPLETE text into the
  // native sliding-label box. Unlike API4, they do not shorten it with ellipsis.
  const size = fonts.labelSize, lines = [];
  for (const line of text.split('\n')) {
    let current = '';
    for (const word of line.split(' ')) {
      const next = current ? current + ' ' + word : word;
      if (current && advance(next) * size > 216) { lines.push(current); current = word; }
      else current = next;
    }
    lines.push(current);
  }
  const width = Math.max(...lines.map(line => advance(line))) * size;
  const height = lines.length * size * 1.15;
  const scale = Math.min(1, 216 / width, 80 / height);
  return { textWidth: width * scale, textHeight: height * scale,
    size: size * scale, width: 216, height: 80 };
}

for (const name of ['ember', 'orbit', 'paper', 'signals', 'terrace', 'cut-paper']) {
  test(`${name}: every stock menu label fits without truncation at desktop and phone scales`, () => {
    const source = ['ember', 'orbit'].includes(name) ? '../../themes/' : './templates/';
    const { theme } = JSON.parse(readFileSync(new URL(source + name + '/theme.json', import.meta.url)));
    const failures = [];
    let checked = 0;
    for (const [menuKey, labels] of Object.entries(stockMenus)) for (const label of labels) {
      const fit = labelFit(theme, menuKey, label);
      // Scale the same 1280x720 scene, not its font or box independently.
      for (const viewportWidth of [1280, 390]) {
        const scale = viewportWidth / 1280;
        if (fit.textWidth * scale > fit.width * scale + 1e-9 ||
            fit.textHeight * scale > fit.height * scale + 1e-9) {
          failures.push({ menuKey, label, viewportWidth, ...fit });
        }
        checked++;
      }
    }
    assert.equal(checked, 82, 'complete 41-label, two-scale corpus');
    assert.deepEqual(failures, [], JSON.stringify(failures, null, 2));
  });
}
