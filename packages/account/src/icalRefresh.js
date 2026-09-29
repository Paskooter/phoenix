// Refresh subscribed iCal feeds in the Account process, not in a browser tab or
// robot turn. The cache and last-check time live in the account store, so a
// restart resumes the daily schedule without fetching every calendar again.

import { logger } from '@phoenix/common';
import {
  accountTimeZone,
  fetchAndParseIcal,
  listSubscriptions,
  saveSubscriptions,
  verifySubscription,
} from './icalSubscriptions.js';
import { getSettingsData } from './settingsData.js';

export const ICAL_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const ICAL_SCAN_INTERVAL_MS = 60 * 60 * 1000;

const log = logger('account.calendar');

export class IcalRefreshService {
  constructor(store, {
    fetcher = fetchAndParseIcal,
    fetchOptions = {},
    refreshIntervalMs = ICAL_REFRESH_INTERVAL_MS,
    scanIntervalMs = ICAL_SCAN_INTERVAL_MS,
    now = Date.now,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
  } = {}) {
    this.store = store;
    this.fetcher = fetcher;
    this.fetchOptions = fetchOptions;
    this.refreshIntervalMs = refreshIntervalMs;
    this.scanIntervalMs = scanIntervalMs;
    this.now = now;
    this.setIntervalFn = setIntervalFn;
    this.clearIntervalFn = clearIntervalFn;
    this.started = false;
    this.timer = null;
    this.running = null;
    this.rerunRequested = false;
    this.generation = 0;
  }

  _accountsWithSubscriptions() {
    const accounts = [];
    for (const [accountId] of this.store.settings) {
      const account = this.store.accounts.get(accountId);
      if (!account || account.isDeleted === true) continue;
      const subscriptions = listSubscriptions(this.store, accountId);
      if (subscriptions.some((item) => item.enabled && item.url)) accounts.push(accountId);
    }
    return accounts;
  }

  _isDue(subscription, timeZone, now) {
    if (!subscription?.enabled || !subscription.url) return false;
    // Old saved subscriptions have no zone checkpoint, so a deployment checks
    // them once. A failed attempt still records the checked zone and retries
    // on the daily interval rather than every hourly scan.
    if (subscription.checkedTimeZone !== timeZone) return true;
    const checked = subscription.verification?.lastChecked;
    return !Number.isFinite(checked) || checked + this.refreshIntervalMs <= now;
  }

  _syncTimer() {
    const needed = this.started && this._accountsWithSubscriptions().length > 0;
    if (needed && !this.timer) {
      this.timer = this.setIntervalFn(() => {
        void this.refreshDue().catch(() => log.error('iCal refresh sweep failed'));
      }, this.scanIntervalMs);
      this.timer?.unref?.();
    } else if (!needed && this.timer) {
      this.clearIntervalFn(this.timer);
      this.timer = null;
    }
  }

  start() {
    if (this.started) return this.running || Promise.resolve();
    this.started = true;
    this._syncTimer();
    if (this.running) {
      this.rerunRequested = true;
      return this.running;
    }
    return this.refreshDue();
  }

  stop() {
    this.started = false;
    this.generation += 1;
    this.rerunRequested = false;
    this._syncTimer();
  }

  // Called after adding, editing, enabling, or removing a subscription (and
  // after changing the account timezone). An in-flight result re-reads the
  // current record before saving, so a removed URL cannot be resurrected.
  changed() {
    this._syncTimer();
    if (!this.started || !this.timer) return;
    if (this.running) {
      this.rerunRequested = true;
      return;
    }
    void this.refreshDue().catch(() => log.error('iCal refresh sweep failed'));
  }

  refreshDue() {
    if (this.running) return this.running;
    const generation = this.generation;
    this.running = this._refreshDue(generation).finally(() => {
      this.running = null;
      this._syncTimer();
      if (this.started && this.rerunRequested) {
        this.rerunRequested = false;
        void this.refreshDue().catch(() => log.error('iCal refresh sweep failed'));
      }
    });
    return this.running;
  }

  async _refreshDue(generation) {
    const due = [];
    const now = this.now();
    for (const accountId of this._accountsWithSubscriptions()) {
      const timeZone = accountTimeZone(getSettingsData(this.store, accountId));
      for (const item of listSubscriptions(this.store, accountId)) {
        if (this._isDue(item, timeZone, now)) due.push({ accountId, id: item.id });
      }
    }

    let refreshed = 0;
    let failed = 0;
    for (const { accountId, id } of due) {
      if (generation !== this.generation) break;
      const account = this.store.accounts.get(accountId);
      if (!account || account.isDeleted === true) continue;
      const before = listSubscriptions(this.store, accountId).find((item) => item.id === id);
      const timeZone = accountTimeZone(getSettingsData(this.store, accountId));
      if (!this._isDue(before, timeZone, this.now())) continue;
      const beforeVerification = JSON.stringify(before.verification);
      const checked = await verifySubscription(before, {
        timeZone,
        fetcher: this.fetcher,
        fetchOptions: this.fetchOptions,
        now: this.now(),
        preserveOnError: true,
      });
      if (generation !== this.generation) break;
      const current = listSubscriptions(this.store, accountId);
      const latest = current.find((item) => item.id === id);
      const latestAccount = this.store.accounts.get(accountId);
      if (!latest || !latest.enabled || latest.url !== before.url
        || JSON.stringify(latest.verification) !== beforeVerification
        || accountTimeZone(getSettingsData(this.store, accountId)) !== timeZone
        || !latestAccount || latestAccount.isDeleted === true) continue;
      saveSubscriptions(this.store, accountId, current.map((item) => item.id === id
        ? { ...checked, label: item.label } : item));
      refreshed += 1;
      if (checked.verification.lastError) failed += 1;
    }
    if (refreshed) log.info('iCal subscriptions refreshed', { refreshed, failed });
    return { refreshed, failed };
  }
}
