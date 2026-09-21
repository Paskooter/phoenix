// Optional, consent-gated GA4 for the public jibo.io deployment.
//
// Phoenix is self-hosted software. Never send a self-hosted operator's portal
// traffic to the project's property, so the integration is deliberately
// restricted to the canonical public hosts below. The tag is also not loaded
// until the visitor opts in. This keeps the default/local experience free of
// third-party tracking and lets a visitor decline without a network request to
// Google.

const MEASUREMENT_ID = 'G-3CNE9E61X0j';
const CONSENT_KEY = 'phoenix.analyticsConsent';
const PUBLIC_HOSTS = new Set(['jibo.io', 'www.jibo.io', 'portal.jibo.io']);

function isPublicDeployment() {
  return PUBLIC_HOSTS.has(String(window.location.hostname || '').toLowerCase().replace(/\.$/, ''));
}

function readConsent() {
  try { return window.localStorage.getItem(CONSENT_KEY); } catch { return null; }
}

function writeConsent(value) {
  try { window.localStorage.setItem(CONSENT_KEY, value); } catch { /* session-only choice */ }
}

function clearAnalyticsCookies() {
  // GA4's first-party cookies are named _ga and _ga_<measurement-id>. They
  // are host-only here; expiry is best effort when a browser has retained a
  // cookie under a different historical path/domain.
  for (const part of document.cookie.split(';')) {
    const name = part.trim().split('=')[0];
    if (!/^_ga(?:_|$)/.test(name)) continue;
    document.cookie = `${name}=; Max-Age=0; Path=/; SameSite=Lax`;
  }
}

function sanitizedPageLocation() {
  // Never send activation, reset, confirmation or other query-string values
  // to an analytics provider. The portal's SPA state is in the hash and is
  // intentionally omitted as well; route names can contain user-controlled
  // labels in future versions.
  return `${window.location.origin}${window.location.pathname || '/'}`;
}

function sanitizedReferrer() {
  if (!document.referrer) return '';
  try {
    const referrer = new URL(document.referrer);
    return `${referrer.origin}${referrer.pathname || '/'}`;
  } catch {
    return '';
  }
}

function safePageTitle() {
  // Do not forward a console title that may eventually include a household,
  // robot or member name. These stable labels are enough for aggregate views.
  return document.body?.classList.contains('console') ? 'Console' : 'Public site';
}

function sendPageView() {
  // A previously opted-in visitor can revoke consent without reloading.  The
  // already-loaded Google library remains in memory, so do not enqueue an
  // event (including a cookieless consent-mode ping) after that choice.
  if (readConsent() !== 'granted' || typeof window.gtag !== 'function') return;
  const referrer = sanitizedReferrer();
  window.gtag('event', 'page_view', {
    page_title: safePageTitle(),
    page_location: sanitizedPageLocation(),
    page_path: window.location.pathname || '/',
    ...(referrer ? { page_referrer: referrer } : {}),
  });
}

function installRouteTracking() {
  if (window.__phoenixAnalyticsRouteTracking) return;
  window.__phoenixAnalyticsRouteTracking = true;
  addEventListener('hashchange', sendPageView, { passive: true });
  addEventListener('popstate', sendPageView, { passive: true });
}

function loadGoogleAnalytics() {
  // Re-granting after a prior revocation uses the library already in memory.
  // Explicitly undo the earlier Consent Mode denial before sending the fresh,
  // sanitized page view.
  if (window.__phoenixAnalyticsLoaded) {
    if (typeof window.gtag === 'function') {
      window.gtag('consent', 'update', {
        analytics_storage: 'granted',
        ad_storage: 'denied',
        ad_user_data: 'denied',
        ad_personalization: 'denied',
      });
    }
    installRouteTracking();
    sendPageView();
    return;
  }
  window.__phoenixAnalyticsLoaded = true;

  window.dataLayer = window.dataLayer || [];
  window.gtag = window.gtag || function gtag() { window.dataLayer.push(arguments); };
  window.gtag('js', new Date());
  // Set the safe URL globally as well as on our explicit page_view. If an
  // administrator enables an automatic GA4 event in the property later, it
  // still cannot pick up an activation/reset query string from the browser.
  const referrer = sanitizedReferrer();
  window.gtag('set', {
    page_title: safePageTitle(),
    page_location: sanitizedPageLocation(),
    page_path: window.location.pathname || '/',
    ...(referrer ? { page_referrer: referrer } : {}),
  });
  // Automatic page_view is disabled so query strings can never be captured by
  // the library before our sanitized event is queued.
  window.gtag('config', MEASUREMENT_ID, {
    send_page_view: false,
    anonymize_ip: true,
    allow_google_signals: false,
    allow_ad_personalization_signals: false,
  });

  const script = document.createElement('script');
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(MEASUREMENT_ID)}`;
  script.dataset.phoenixAnalytics = 'ga4';
  document.head.appendChild(script);
  installRouteTracking();
  sendPageView();
}

function revokeAnalytics() {
  writeConsent('denied');
  if (typeof window.gtag === 'function') {
    window.gtag('consent', 'update', {
      analytics_storage: 'denied',
      ad_storage: 'denied',
      ad_user_data: 'denied',
      ad_personalization: 'denied',
    });
  }
  clearAnalyticsCookies();
}

function removePrompt(prompt) {
  prompt?.remove();
}

function showConsentPrompt() {
  if (document.querySelector('[data-analytics-consent]')) return;

  const prompt = document.createElement('section');
  prompt.className = 'analytics-consent';
  prompt.dataset.analyticsConsent = '';
  prompt.setAttribute('role', 'dialog');
  prompt.setAttribute('aria-labelledby', 'analytics-consent-title');
  prompt.setAttribute('aria-describedby', 'analytics-consent-copy');
  prompt.innerHTML = `
    <div class="analytics-consent-copy">
      <h2 id="analytics-consent-title">Help improve jibo.io</h2>
      <p id="analytics-consent-copy">Allow aggregate usage statistics for the public site and console? Robot data and account contents are never sent to Google.</p>
    </div>
    <div class="analytics-consent-actions">
      <button type="button" class="btn btn-primary btn-sm" data-analytics-accept>Allow analytics</button>
      <button type="button" class="btn btn-quiet btn-sm" data-analytics-decline>Decline</button>
    </div>`;

  prompt.querySelector('[data-analytics-accept]')?.addEventListener('click', () => {
    writeConsent('granted');
    removePrompt(prompt);
    loadGoogleAnalytics();
  });
  prompt.querySelector('[data-analytics-decline]')?.addEventListener('click', () => {
    revokeAnalytics();
    removePrompt(prompt);
  });
  document.body.appendChild(prompt);
}

function showPreferences() {
  if (!isPublicDeployment()) return;
  revokeAnalytics();
  writeConsent('pending');
  document.querySelector('[data-analytics-consent]')?.remove();
  showConsentPrompt();
  document.querySelector('[data-analytics-accept]')?.focus();
}

function init() {
  if (!isPublicDeployment()) return;

  for (const control of document.querySelectorAll('[data-analytics-preferences]')) {
    control.hidden = false;
    control.addEventListener('click', showPreferences);
  }

  const consent = readConsent();
  if (consent === 'granted') loadGoogleAnalytics();
  else if (consent !== 'denied') showConsentPrompt();
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') init();
