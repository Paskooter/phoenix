// Phoenix console service worker. It caches only the static console shell; API
// data, sessions, branding, and all account content stay network-only.

const CACHE_NAME = 'phoenix-console-shell-v2';
const APP_SHELL = [
  '/app', '/app.html', '/theme.css', '/console.css', '/app.js', '/pwa.js',
  '/brand.js', '/qr.js', '/map.js', '/manifest.webmanifest', '/assets/favicon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys
    .filter((key) => key.startsWith('phoenix-console-shell-') && key !== CACHE_NAME)
    .map((key) => caches.delete(key)))));
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  const isConsoleNavigation = event.request.mode === 'navigate'
    && (url.pathname === '/app' || url.pathname === '/app.html');
  if (isConsoleNavigation) {
    event.respondWith(fetch(event.request).catch(() => caches.match('/app')));
    return;
  }
  if (!APP_SHELL.includes(url.pathname)) return;
  event.respondWith(fetch(event.request).then((response) => {
    if (response.ok) {
      const copy = response.clone();
      void caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
    }
    return response;
  }).catch(() => caches.match(event.request)));
});

function safeConsoleUrl(value) {
  try {
    const url = new URL(value || '/app', self.location.origin);
    return url.origin === self.location.origin && url.pathname.startsWith('/app') ? url.href : '/app';
  } catch {
    return '/app';
  }
}

self.addEventListener('push', (event) => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; }
  catch { payload = {}; }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) payload = {};
  const title = typeof payload.title === 'string' && payload.title ? payload.title : 'Jibo';
  const options = {
    body: typeof payload.body === 'string' ? payload.body : '',
    icon: '/assets/favicon.svg',
    badge: '/assets/favicon.svg',
    tag: typeof payload.tag === 'string' ? payload.tag : undefined,
    data: { url: safeConsoleUrl(payload.url) },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const destination = safeConsoleUrl(event.notification.data?.url);
  event.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (windows) => {
    const current = windows.find((client) => new URL(client.url).origin === self.location.origin);
    if (current) {
      await current.navigate(destination).catch(() => {});
      return current.focus();
    }
    return clients.openWindow(destination);
  }));
});

self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true })
    .then((windows) => windows.forEach((client) => client.postMessage({ type: 'phoenix-push-subscription-changed' }))));
});
