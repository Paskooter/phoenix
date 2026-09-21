// Progressive-web-app and browser-push client for the account console.
//
// This module deliberately has no framework state. The console remains a
// normal mobile web page when a browser does not support installation or Web
// Push; these helpers only enhance the signed-in experience.

const SERVICE_WORKER_URL = '/sw.js';
let registrationPromise = null;
let deferredInstallPrompt = null;
let syncedAccountId = '';

addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
});

addEventListener('appinstalled', () => { deferredInstallPrompt = null; });

function isIos() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function installed() {
  return matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}

function base64urlBytes(value) {
  const padded = String(value).replace(/-/g, '+').replace(/_/g, '/')
    + '='.repeat((4 - (String(value).length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function pwaCapabilities() {
  const secure = window.isSecureContext === true;
  return {
    secure,
    serviceWorker: secure && 'serviceWorker' in navigator,
    push: secure && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window,
    installed: installed(),
    ios: isIos(),
    canPromptInstall: !!deferredInstallPrompt,
  };
}

/** Register the app shell; errors leave the normal browser console untouched. */
export async function registerPortalServiceWorker() {
  if (!pwaCapabilities().serviceWorker) return null;
  if (!registrationPromise) {
    registrationPromise = navigator.serviceWorker.register(SERVICE_WORKER_URL, { scope: '/' })
      .then(() => navigator.serviceWorker.ready)
      .catch(() => null);
  }
  return registrationPromise;
}

export async function promptInstall() {
  const prompt = deferredInstallPrompt;
  if (!prompt) return { prompted: false };
  deferredInstallPrompt = null;
  await prompt.prompt();
  const choice = await prompt.userChoice;
  return { prompted: true, accepted: choice.outcome === 'accepted' };
}

function browserLabel() {
  const platform = navigator.userAgentData?.platform || navigator.platform || '';
  return platform ? `${platform} browser` : 'This browser';
}

async function currentSubscription() {
  const registration = await registerPortalServiceWorker();
  return registration ? registration.pushManager.getSubscription() : null;
}

/** Read both the server configuration and this browser's subscription state. */
export async function browserPushState(api) {
  const capabilities = pwaCapabilities();
  const server = await api('GET', '/api/web-push');
  if (!capabilities.push) return { capabilities, server, subscription: null, permission: 'unsupported' };
  const subscription = await currentSubscription().catch(() => null);
  return { capabilities, server, subscription, permission: Notification.permission };
}

/**
 * Ask for notification permission only in response to an explicit click, then
 * attach the browser's subscription to the signed-in Account user.
 */
export async function enableBrowserPush(api) {
  const capabilities = pwaCapabilities();
  if (!capabilities.push) throw new Error('This browser does not support push notifications here.');
  const status = await api('GET', '/api/web-push');
  if (!status.ok || !status.data.available || !status.data.publicKey) {
    throw new Error(status.data?.error || status.data?.reason || 'Browser notifications are not configured on this server.');
  }
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Notification permission was not granted.');
  const registration = await registerPortalServiceWorker();
  if (!registration) throw new Error('The app service worker could not be installed.');
  let subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: base64urlBytes(status.data.publicKey),
    });
  }
  const saved = await api('POST', '/api/web-push/subscribe', {
    subscription: subscription.toJSON(),
    label: browserLabel(),
  });
  if (!saved.ok) throw new Error(saved.data?.error || 'Could not save this notification device.');
  return saved.data;
}

/** Refresh a previously-granted subscription when the account changes or opens. */
export async function syncBrowserPush(api, accountId) {
  if (!accountId || syncedAccountId === String(accountId)) return;
  syncedAccountId = String(accountId);
  const capabilities = pwaCapabilities();
  if (!capabilities.push || Notification.permission !== 'granted') return;
  try {
    const status = await api('GET', '/api/web-push');
    if (!status.ok || !status.data.available) return;
    const subscription = await currentSubscription();
    if (!subscription) return;
    const saved = await api('POST', '/api/web-push/subscribe', {
      subscription: subscription.toJSON(),
      label: browserLabel(),
    });
    if (!saved.ok) syncedAccountId = '';
  } catch {
    // Offline app startup and a temporarily unavailable account service should
    // not turn a normal console visit into an error screen.
    syncedAccountId = '';
  }
}

/** Remove this browser from Account before removing the browser subscription. */
export async function disableBrowserPush(api) {
  const subscription = await currentSubscription();
  if (!subscription) return { removed: false };
  const stored = await api('POST', '/api/web-push/unsubscribe', { subscription: subscription.toJSON() });
  if (!stored.ok) throw new Error(stored.data?.error || 'Could not remove this notification device.');
  await subscription.unsubscribe().catch(() => false);
  return stored.data;
}

// A browser can rotate a subscription after its endpoint expires. The service
// worker tells an open console; the next account refresh attaches the new one.
navigator.serviceWorker?.addEventListener('message', (event) => {
  if (event.data?.type === 'phoenix-push-subscription-changed') syncedAccountId = '';
});
