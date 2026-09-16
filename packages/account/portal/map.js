// Location picker for the commute settings.
//
// The settings page used to ask for four numbers: home latitude, home longitude,
// work latitude, work longitude. Nobody knows their coordinates. This replaces
// that with a map you point at.
//
// Leaflet is vendored (portal/vendor/) rather than loaded from a CDN: the portal
// runs on a LAN next to the robot and should render without reaching an outside
// host. Map TILES and the address search do need the internet, so every failure
// path here falls back to the manual latitude/longitude fields rather than
// leaving the page broken — a household with no outbound route can still set a
// commute, just the tedious way.
//
// Markers are Leaflet `divIcon`s (styled in CSS), so no image assets are needed
// and the vendored directory stays two files.

const TILE_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
const TILE_ATTRIB = '© OpenStreetMap contributors';
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
// Nominatim asks every caller to identify itself. Being honest about who we are
// is the condition of using it.
const USER_AGENT_REFERRER = 'Phoenix Jibo portal';
const DEFAULT_VIEW = { lat: 42.3601, lng: -71.0589, zoom: 11 }; // Jibo was built in Boston.

let leafletPromise = null;

/** Load the vendored Leaflet once. Resolves null when it cannot be loaded. */
export function loadLeaflet() {
  if (leafletPromise) return leafletPromise;
  leafletPromise = new Promise((resolve) => {
    if (window.L) return resolve(window.L);
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = '/vendor/leaflet.css';
    document.head.appendChild(css);
    const script = document.createElement('script');
    script.src = '/vendor/leaflet.js';
    script.onload = () => resolve(window.L || null);
    script.onerror = () => resolve(null);
    document.head.appendChild(script);
  });
  return leafletPromise;
}

function round(value) {
  return value == null || Number.isNaN(Number(value)) ? null : Math.round(Number(value) * 1e6) / 1e6;
}

/** "42.360100, -71.058900" — fixed width so the readout does not jitter while dragging. */
function formatPoint(point) {
  if (!point || point.lat == null || point.lng == null) return 'not set';
  return `${Number(point.lat).toFixed(6)}, ${Number(point.lng).toFixed(6)}`;
}

async function geocode(query) {
  const url = `${NOMINATIM}?format=jsonv2&limit=5&q=${encodeURIComponent(query)}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' }, referrerPolicy: 'no-referrer-when-downgrade' });
  if (!res.ok) throw new Error(`search failed (${res.status})`);
  const rows = await res.json();
  return rows.map((row) => ({
    label: row.display_name,
    lat: Number(row.lat),
    lng: Number(row.lon),
  }));
}

/**
 * Build a two-pin location picker.
 *
 * @param {object} options
 * @param {Array<{key:string,label:string,point:{lat:?number,lng:?number}}>} options.places
 * @param {(key:string, point:{lat:number,lng:number}) => void} [options.onChange]
 * @returns {{element: HTMLElement, value: () => object, ready: Promise<boolean>}}
 */
export function createLocationPicker({ places, onChange }) {
  const state = new Map(places.map((p) => [p.key, { ...p.point }]));
  const markers = new Map();
  let active = places[0].key;
  let map = null;

  const el = document.createElement('div');
  el.className = 'map-picker';

  // --- place selector: which pin the next click moves ---------------------
  const tabs = document.createElement('div');
  tabs.className = 'map-tabs';
  const readouts = new Map();
  for (const place of places) {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'map-tab' + (place.key === active ? ' active' : '');
    tab.dataset.key = place.key;
    const dot = document.createElement('span');
    dot.className = `pin-dot pin-${place.key}`;
    const name = document.createElement('span');
    name.className = 'map-tab-name';
    name.textContent = place.label;
    const readout = document.createElement('span');
    readout.className = 'map-tab-coords';
    readout.textContent = formatPoint(place.point);
    readouts.set(place.key, readout);
    tab.append(dot, name, readout);
    tab.addEventListener('click', () => setActive(place.key));
    tabs.appendChild(tab);
  }

  // --- search + locate ----------------------------------------------------
  const tools = document.createElement('div');
  tools.className = 'map-tools';
  const search = document.createElement('input');
  search.type = 'search';
  search.className = 'map-search';
  search.placeholder = 'Search an address or place…';
  search.setAttribute('aria-label', 'Search for a place');
  const locate = document.createElement('button');
  locate.type = 'button';
  locate.className = 'ghost map-locate';
  locate.textContent = 'Use my location';
  tools.append(search, locate);

  const results = document.createElement('div');
  results.className = 'map-results';
  results.hidden = true;

  const canvas = document.createElement('div');
  canvas.className = 'map-canvas';

  const hint = document.createElement('p');
  hint.className = 'map-hint';

  // --- manual fallback, always available ----------------------------------
  const manual = document.createElement('details');
  manual.className = 'map-manual';
  const manualSummary = document.createElement('summary');
  manualSummary.textContent = 'Enter coordinates manually';
  manual.appendChild(manualSummary);
  const manualGrid = document.createElement('div');
  manualGrid.className = 'map-manual-grid';
  const manualInputs = new Map();
  for (const place of places) {
    for (const axis of ['lat', 'lng']) {
      const label = document.createElement('label');
      label.className = 'field';
      const span = document.createElement('span');
      span.className = 'field-label';
      span.textContent = `${place.label} ${axis === 'lat' ? 'latitude' : 'longitude'}`;
      const input = document.createElement('input');
      input.type = 'number';
      input.step = 'any';
      input.value = place.point?.[axis] ?? '';
      input.addEventListener('change', () => {
        const current = state.get(place.key) || {};
        current[axis] = input.value === '' ? null : Number(input.value);
        state.set(place.key, current);
        syncPlace(place.key, { fromManual: true });
      });
      manualInputs.set(`${place.key}_${axis}`, input);
      label.append(span, input);
      manualGrid.appendChild(label);
    }
  }
  manual.appendChild(manualGrid);

  el.append(tabs, tools, results, canvas, hint, manual);

  function setActive(key) {
    active = key;
    for (const tab of tabs.querySelectorAll('.map-tab')) {
      tab.classList.toggle('active', tab.dataset.key === key);
    }
    hint.textContent = map
      ? `Click the map, drag a pin, or search to set ${labelOf(key)}.`
      : hint.textContent;
  }

  const labelOf = (key) => (places.find((p) => p.key === key) || {}).label || key;

  function syncPlace(key, { fromManual = false, pan = false } = {}) {
    const point = state.get(key) || {};
    readouts.get(key).textContent = formatPoint(point);
    if (!fromManual) {
      const lat = manualInputs.get(`${key}_lat`);
      const lng = manualInputs.get(`${key}_lng`);
      if (lat) lat.value = point.lat ?? '';
      if (lng) lng.value = point.lng ?? '';
    }
    if (map && point.lat != null && point.lng != null) {
      const marker = markers.get(key);
      if (marker) marker.setLatLng([point.lat, point.lng]);
      if (pan) map.panTo([point.lat, point.lng]);
    }
    if (onChange) onChange(key, point);
  }

  function place(key, lat, lng, { pan = true } = {}) {
    state.set(key, { lat: round(lat), lng: round(lng) });
    syncPlace(key, { pan });
  }

  const ready = (async () => {
    const L = await loadLeaflet();
    if (!L) {
      canvas.classList.add('map-unavailable');
      canvas.textContent = 'The map could not be loaded. Use the coordinate fields below.';
      manual.open = true;
      hint.textContent = '';
      return false;
    }

    const first = places.map((p) => state.get(p.key)).find((p) => p && p.lat != null && p.lng != null);
    map = L.map(canvas, { zoomControl: true, attributionControl: true })
      .setView(first ? [first.lat, first.lng] : [DEFAULT_VIEW.lat, DEFAULT_VIEW.lng], first ? 13 : DEFAULT_VIEW.zoom);
    L.tileLayer(TILE_URL, { maxZoom: 19, attribution: TILE_ATTRIB }).addTo(map);

    for (const p of places) {
      const point = state.get(p.key) || {};
      const marker = L.marker(
        [point.lat ?? DEFAULT_VIEW.lat, point.lng ?? DEFAULT_VIEW.lng],
        {
          draggable: true,
          opacity: point.lat == null ? 0 : 1,
          icon: L.divIcon({
            className: `map-pin map-pin-${p.key}`,
            html: `<span class="map-pin-body">${p.label}</span>`,
            iconSize: null,
          }),
        },
      ).addTo(map);
      marker.on('dragend', () => {
        const { lat, lng } = marker.getLatLng();
        place(p.key, lat, lng, { pan: false });
      });
      marker.on('click', () => setActive(p.key));
      markers.set(p.key, marker);
      if (point.lat == null) marker.setOpacity(0);
    }

    map.on('click', (event) => {
      const marker = markers.get(active);
      if (marker) marker.setOpacity(1);
      place(active, event.latlng.lat, event.latlng.lng, { pan: false });
    });

    setActive(active);
    // Leaflet measures the container on creation; inside a freshly built card it
    // can still be zero-height at that moment, which leaves a grey box until the
    // next resize. Measure again once layout has settled.
    setTimeout(() => map.invalidateSize(), 60);
    return true;
  })();

  locate.addEventListener('click', () => {
    if (!navigator.geolocation) {
      hint.textContent = 'This browser will not share a location.';
      return;
    }
    locate.disabled = true;
    locate.textContent = 'Locating…';
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        locate.disabled = false;
        locate.textContent = 'Use my location';
        const marker = markers.get(active);
        if (marker) marker.setOpacity(1);
        place(active, pos.coords.latitude, pos.coords.longitude);
        if (map) map.setView([pos.coords.latitude, pos.coords.longitude], 15);
        hint.textContent = `${labelOf(active)} set from your device location.`;
      },
      (error) => {
        locate.disabled = false;
        locate.textContent = 'Use my location';
        // A denied permission is a choice, not a fault — say so plainly.
        hint.textContent = error.code === error.PERMISSION_DENIED
          ? 'Location permission was declined. Search or click the map instead.'
          : 'Could not get your location. Search or click the map instead.';
      },
      { enableHighAccuracy: true, timeout: 10000 },
    );
  });

  let searchTimer = null;
  search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    const query = search.value.trim();
    if (query.length < 3) { results.hidden = true; results.replaceChildren(); return; }
    // Nominatim's usage policy is at most one request a second; debounce well
    // clear of it rather than firing on every keystroke.
    searchTimer = setTimeout(async () => {
      try {
        const rows = await geocode(query);
        results.replaceChildren();
        if (!rows.length) {
          const empty = document.createElement('p');
          empty.className = 'map-result-empty';
          empty.textContent = 'Nothing found.';
          results.appendChild(empty);
        }
        for (const row of rows) {
          const option = document.createElement('button');
          option.type = 'button';
          option.className = 'map-result';
          option.textContent = row.label;
          option.addEventListener('click', () => {
            const marker = markers.get(active);
            if (marker) marker.setOpacity(1);
            place(active, row.lat, row.lng);
            if (map) map.setView([row.lat, row.lng], 15);
            results.hidden = true;
            search.value = '';
            hint.textContent = `${labelOf(active)} set to ${row.label.split(',')[0]}.`;
          });
          results.appendChild(option);
        }
        results.hidden = false;
      } catch {
        results.replaceChildren();
        const failed = document.createElement('p');
        failed.className = 'map-result-empty';
        failed.textContent = 'Address search is unavailable offline.';
        results.appendChild(failed);
        results.hidden = false;
      }
    }, 450);
  });

  return {
    element: el,
    ready,
    value() {
      const out = {};
      for (const [key, point] of state) out[key] = { lat: round(point.lat), lng: round(point.lng) };
      return out;
    },
  };
}
