import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const TEST_DIR = fileURLToPath(new URL('.', import.meta.url));
const PORTAL_DIR = join(TEST_DIR, '../portal');
const read = (file) => readFileSync(join(PORTAL_DIR, file), 'utf8');

function runAnalytics({ href = 'https://jibo.io/app?code=single-use#/%2Floop', consent } = {}) {
  const listeners = new Map();
  const localStorage = new Map(consent ? [['phoenix.analyticsConsent', consent]] : []);
  const appended = [];
  const element = () => ({
    dataset: {},
    addEventListener() {},
    appendChild() {},
    focus() {},
    querySelector() { return element(); },
    remove() {},
    setAttribute() {},
  });
  const document = {
    body: { appendChild() {}, classList: { contains: (name) => name === 'console' } },
    cookie: '',
    createElement: () => element(),
    head: { appendChild: (node) => appended.push(node) },
    querySelector: () => null,
    querySelectorAll: () => [],
    referrer: 'https://mail.example/return?token=private',
  };
  const window = {
    location: new URL(href),
    localStorage: {
      getItem: (key) => localStorage.get(key) ?? null,
      setItem: (key, value) => localStorage.set(key, value),
    },
  };
  const context = vm.createContext({
    URL,
    Date,
    Set,
    String,
    document,
    encodeURIComponent,
    window,
    addEventListener: (name, listener) => listeners.set(name, listener),
  });
  vm.runInContext(read('analytics.js'), context, { filename: 'analytics.js' });
  return { appended, context, listeners, localStorage, window };
}

test('portal analytics is consent-gated, production-host restricted, and URL-safe', () => {
  const analytics = read('analytics.js');

  assert.match(analytics, /G-3CNE9E61X0j/);
  assert.match(analytics, /PUBLIC_HOSTS = new Set\(\['jibo\.io', 'www\.jibo\.io', 'portal\.jibo\.io'\]\)/);
  assert.match(analytics, /consent === 'granted'/);
  assert.match(analytics, /send_page_view: false/);
  assert.match(analytics, /window\.location\.origin\}\$\{window\.location\.pathname/);
  assert.match(analytics, /document\.referrer/);
  assert.match(analytics, /googletagmanager\.com/);

  for (const page of ['index.html', 'app.html', 'privacy.html', 'security.html', 'terms.html', '404.html']) {
    assert.match(read(page), /<script src="\/analytics\.js" defer><\/script>/, page);
  }

  assert.match(read('../src/static.js'), /'analytics\.js'/);
});

test('nginx policy allows only the Google hosts required by the opt-in tag', () => {
  const nginx = readFileSync(join(PORTAL_DIR, '../../../deploy/nginx/phoenix.conf'), 'utf8');
  assert.match(nginx, /https:\/\/www\.googletagmanager\.com/);
  assert.match(nginx, /https:\/\/www\.google-analytics\.com/);
  assert.match(nginx, /https:\/\/region1\.google-analytics\.com/);
  assert.match(nginx, /https:\/\/analytics\.google\.com/);
});

test('analytics cannot send a query-bearing URL and stops after revocation', () => {
  const run = runAnalytics({ consent: 'granted' });
  assert.equal(run.appended.length, 1, 'GA is loaded only after prior consent');

  const events = run.window.dataLayer.filter(([kind]) => kind === 'event');
  assert.equal(events.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(events[0][2])), {
    page_title: 'Console',
    page_location: 'https://jibo.io/app',
    page_path: '/app',
    page_referrer: 'https://mail.example/return',
  });

  run.localStorage.set('phoenix.analyticsConsent', 'denied');
  run.listeners.get('hashchange')();
  assert.equal(run.window.dataLayer.filter(([kind]) => kind === 'event').length, 1,
    'a loaded tag emits nothing after consent is withdrawn');
});

test('analytics is inert before consent and on non-public hosts', () => {
  assert.equal(runAnalytics().appended.length, 0, 'no tag before a choice');
  assert.equal(runAnalytics({ href: 'https://phoenix.example/app', consent: 'granted' }).appended.length, 0,
    'self-hosted portals never use the jibo.io property');
});
