// Portal REST: robot detail + service status (surface 4). The pairing flow (POST
// /api/robots/setup, GET /api/robots/setup/status, the QR renderer) is untouched and lives in
// portalApi.js alongside the list view. This module adds the loop robot's record and the
// Robot_20160225 read (manufacturing/read-state from the Classic entrypoint, the same way the
// app reads it).

import { sendJson } from '@phoenix/common';
import { randomUUID } from 'node:crypto';
import { classicCall, ClassicCallError } from './classicClient.js';
import { requireUser } from './session.js';

function idsEqual(a, b) {
  return a != null && b != null && String(a) === String(b);
}

function isAcceptedMember(loop, accountId) {
  return (loop.members || []).some((member) => idsEqual(member.accountId, accountId)
    && String(member.status || '').toLowerCase() === 'accepted');
}

const AVATAR_COLORS = new Set(['blue', 'teal', 'violet', 'coral', 'gold', 'slate']);
const keyAttempts = new Map();

function validTimeZone(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 64) return false;
  try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; }
  catch { return false; }
}

function keyRateAllowed(accountId, loopId) {
  const key = `${accountId}:${loopId}`;
  const now = Date.now();
  const current = keyAttempts.get(key);
  if (!current || now - current.started > 15 * 60_000) {
    keyAttempts.set(key, { started: now, count: 1 });
    return true;
  }
  current.count += 1;
  return current.count <= 8;
}

function ownedRobot(store, account, loopId, res) {
  const loop = typeof loopId === 'string' ? store.loops.get(loopId) : null;
  if (!loop || loop.isDeleted === true || !idsEqual(loop.owner, account._id)) {
    sendJson(res, 404, { error: 'Owned robot not found' });
    return null;
  }
  const robot = loop.robot ? store.accounts.get(loop.robot) : null;
  if (!robot?.friendlyId) {
    sendJson(res, 404, { error: 'This loop has no robot' });
    return null;
  }
  return { loop, robot };
}

export function portalRobotRoutes(store, options = {}) {
  const classic = options.classicCall || classicCall;
  const base = options.classicBase;

  const readCustomHolidays = async (account, loopId) => {
    const result = await classic({ base, account, target: 'Person_20160801.GetLoopProperties',
      body: { loopId, keys: ['customHolidays'] } });
    const rows = result.body?.customHolidays?.holidays;
    return Array.isArray(rows) ? rows.filter((row) => row && typeof row === 'object').slice(0, 100) : [];
  };
  const saveCustomHolidays = (account, loopId, holidays) => classic({ base, account,
    target: 'Person_20160801.SetLoopProperty',
    body: { loopId, key: 'customHolidays', value: { holidays } } });

  const classicFailure = (res, error) => sendJson(res,
    error instanceof ClassicCallError && error.status >= 400 && error.status < 500 ? error.status : 502,
    { error: error instanceof ClassicCallError && error.status < 500 ? error.message : 'Robot settings service is unavailable' });

  return {
    // Loop robot detail: the robot Account record (from the account store) plus the Classic
    // Robot_20160225.GetRobot read projection for the friendly-id.
    'GET /api/robot': async ({ req, res, url }) => {
      const account = requireUser(store, req, res);
      if (!account) return;
      const loopId = url.searchParams.get('loopId');
      const loop = loopId ? store.loops.get(loopId) : null;
      // The native app presented a joined loop's Jibo details to accepted
      // members as well as its owner.  This portal projection never exposes
      // robot credentials, so use the same membership boundary instead of
      // showing a Details button which will always fail for a shared loop.
      if (!loop || loop.isDeleted === true
        || (!idsEqual(loop.owner, account._id) && !isAcceptedMember(loop, account._id))) {
        return sendJson(res, 404, { error: 'Loop does not exist', code: 'LOOP_NOT_FOUND' });
      }
      const robot = loop.robot ? store.accounts.get(loop.robot) : null;
      const out = {
        loop: {
          id: loop._id,
          name: loop.name,
          avatarColor: AVATAR_COLORS.has(loop.avatarColor) ? loop.avatarColor : 'blue',
          isSuspended: !!loop.isSuspended,
          members: (loop.members || []).length,
        },
        robot: robot ? {
          friendlyId: robot.friendlyId,
          isActive: !!robot.isActive,
          created: robot.created,
          lastSeen: robot.lastSeen || null,
        } : null,
      };
      if (!robot) return out;
      try {
        const classicResult = await classic({
          base,
          account,
          target: 'Robot_20160225.GetRobot',
          body: { id: robot.friendlyId },
        });
        out.getRobot = classicResult.body;
      } catch (error) {
        out.getRobot = null;
        out.diagnostics = { robotRecordError: error instanceof ClassicCallError ? {
          status: error.status, code: error.code, message: error.message,
        } : { message: String(error.message || error) } };
      }
      // Phoenix verifies loop membership before this route, then asks the
      // notification service with the robot's server-held credentials. The
      // source mobile client queried the robot account directly; doing it here
      // preserves the useful connection state without exposing a robot secret
      // or weakening the Classic caller boundary for arbitrary account ids.
      try {
        const connection = await classic({
          base,
          account: robot,
          target: 'Notification_20150505.GetStatus',
          body: { accountId: robot._id },
        });
        out.connection = connection.body;
      } catch (error) {
        out.diagnostics = {
          ...(out.diagnostics || {}),
          connectionError: error instanceof ClassicCallError ? {
            status: error.status, code: error.code, message: error.message,
          } : { message: String(error.message || error) },
        };
      }
      return out;
    },

    'PUT /api/robot/color': ({ req, res, body }) => {
      const account = requireUser(store, req, res);
      if (!account) return;
      const found = ownedRobot(store, account, body?.loopId, res);
      if (!found) return;
      if (!AVATAR_COLORS.has(body?.color)) return sendJson(res, 400, { error: 'Invalid robot color' });
      found.loop.avatarColor = body.color;
      found.loop.updated = Date.now();
      store.flush();
      return { color: body.color };
    },

    'PUT /api/robot/properties': async ({ req, res, body }) => {
      const account = requireUser(store, req, res);
      if (!account) return;
      const found = ownedRobot(store, account, body?.loopId, res);
      if (!found) return;
      const payload = {};
      if (Object.prototype.hasOwnProperty.call(body || {}, 'remoteEnabled')) {
        if (typeof body.remoteEnabled !== 'boolean') return sendJson(res, 400, { error: 'remoteEnabled must be a boolean' });
        payload.remoteEnabled = body.remoteEnabled;
      }
      if (Object.prototype.hasOwnProperty.call(body || {}, 'location')) {
        const place = body.location;
        if (!place || typeof place !== 'object' || Array.isArray(place)
          || typeof place.lat !== 'number' || !Number.isFinite(place.lat) || place.lat < -90 || place.lat > 90
          || typeof place.lng !== 'number' || !Number.isFinite(place.lng) || place.lng < -180 || place.lng > 180
          || !validTimeZone(place.timezone)) {
          return sendJson(res, 400, { error: 'Choose valid coordinates and a time zone' });
        }
        for (const field of ['city', 'state', 'zipcode', 'country', 'countryCode']) {
          if (place[field] !== undefined && (typeof place[field] !== 'string' || place[field].length > 120)) {
            return sendJson(res, 400, { error: `Invalid ${field}` });
          }
        }
        payload.locationOverride = {
          latitude: place.lat,
          longitude: place.lng,
          city: place.city || '',
          state: place.state || '',
          zipcode: place.zipcode || '',
          country: place.country || '',
          countryCode: place.countryCode || '',
          timezone: place.timezone,
        };
        payload.timezone = place.timezone;
      }
      if (Object.keys(payload).length !== 1 && !(payload.locationOverride && payload.timezone && Object.keys(payload).length === 2)) {
        return sendJson(res, 400, { error: 'Change one robot setting at a time' });
      }
      try {
        await classic({ base, account, target: 'Robot_20160225.UpdateRobot',
          body: { id: found.robot.friendlyId, payload } });
        return { ok: true };
      } catch (error) {
        const status = error instanceof ClassicCallError ? error.status : 502;
        return sendJson(res, status >= 400 && status < 500 ? status : 502,
          { error: status === 502 ? 'Robot settings service is unavailable' : error.message });
      }
    },

    'GET /api/robot/holidays': async ({ req, res, url }) => {
      const account = requireUser(store, req, res);
      if (!account) return;
      const found = ownedRobot(store, account, url.searchParams.get('loopId'), res);
      if (!found) return;
      try {
        const [standard, custom] = await Promise.all([
          classic({ base, account, target: 'Person_20160801.ListHolidays', body: { loopId: found.loop._id } }),
          readCustomHolidays(account, found.loop._id),
        ]);
        return { holidays: Array.isArray(standard.body) ? standard.body : [], custom };
      } catch (error) { return classicFailure(res, error); }
    },

    'PUT /api/robot/holiday': async ({ req, res, body }) => {
      const account = requireUser(store, req, res);
      if (!account) return;
      const found = ownedRobot(store, account, body?.loopId, res);
      if (!found) return;
      if (typeof body?.id !== 'string' || !/^[a-f0-9]{24}$/i.test(body.id) || typeof body.enabled !== 'boolean') {
        return sendJson(res, 400, { error: 'Choose a holiday and on/off state' });
      }
      try {
        const standard = await classic({ base, account, target: 'Person_20160801.ListHolidays',
          body: { loopId: found.loop._id } });
        if (!Array.isArray(standard.body) || !standard.body.some((holiday) => holiday.id === body.id)) {
          return sendJson(res, 404, { error: 'Holiday not found' });
        }
        await classic({ base, account,
          target: `Person_20160801.${body.enabled ? 'EnableHolidays' : 'DisableHolidays'}`,
          body: { loopId: found.loop._id, ids: [body.id] } });
        return { ok: true };
      } catch (error) { return classicFailure(res, error); }
    },

    'PUT /api/robot/holidays/custom': async ({ req, res, body }) => {
      const account = requireUser(store, req, res);
      if (!account) return;
      const found = ownedRobot(store, account, body?.loopId, res);
      if (!found) return;
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      const date = body?.date;
      const parsed = typeof date === 'string' ? new Date(`${date}T00:00:00Z`) : null;
      if (!name || name.length > 80 || !/^\d{4}-\d{2}-\d{2}$/.test(date || '')
        || !parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date
        || (body.id !== undefined && (typeof body.id !== 'string' || body.id.length > 100))
        || (body.enabled !== undefined && typeof body.enabled !== 'boolean')) {
        return sendJson(res, 400, { error: 'Choose a valid holiday name and date' });
      }
      try {
        const holidays = await readCustomHolidays(account, found.loop._id);
        const index = body.id ? holidays.findIndex((item) => item.id === body.id) : -1;
        if (body.id && index < 0) return sendJson(res, 404, { error: 'Custom holiday not found' });
        if (index < 0 && holidays.length >= 100) return sendJson(res, 400, { error: 'Too many custom holidays' });
        const holiday = index >= 0 ? { ...holidays[index] } : {
          id: randomUUID(), category: 'custom', subcategory: '', loopId: found.loop._id,
          memberId: account._id, created: String(Date.now()),
        };
        holiday.name = name;
        holiday.date = date;
        holiday.isEnabled = body.enabled ?? holiday.isEnabled ?? true;
        if (index >= 0) holidays[index] = holiday;
        else holidays.push(holiday);
        await saveCustomHolidays(account, found.loop._id, holidays);
        return { holiday };
      } catch (error) { return classicFailure(res, error); }
    },

    'DELETE /api/robot/holidays/custom': async ({ req, res, body }) => {
      const account = requireUser(store, req, res);
      if (!account) return;
      const found = ownedRobot(store, account, body?.loopId, res);
      if (!found) return;
      if (typeof body?.id !== 'string' || body.id.length > 100) return sendJson(res, 400, { error: 'Custom holiday ID required' });
      try {
        const holidays = await readCustomHolidays(account, found.loop._id);
        const next = holidays.filter((holiday) => holiday.id !== body.id);
        if (next.length === holidays.length) return sendJson(res, 404, { error: 'Custom holiday not found' });
        await saveCustomHolidays(account, found.loop._id, next);
        return { ok: true };
      } catch (error) { return classicFailure(res, error); }
    },

    'GET /api/robot/backup-key/status': async ({ req, res, url }) => {
      const account = requireUser(store, req, res);
      if (!account) return;
      const found = ownedRobot(store, account, url.searchParams.get('loopId'), res);
      if (!found) return;
      try {
        await classic({ base, account, target: 'Key_20160201.Restore', body: { loopId: found.loop._id } });
        return { backupExists: true };
      } catch (error) {
        if (error instanceof ClassicCallError && error.code === 'BACKUP_NOT_FOUND') return { backupExists: false };
        return classicFailure(res, error);
      }
    },

    'POST /api/robot/backup-key/current': async ({ req, res, body }) => {
      const account = requireUser(store, req, res);
      if (!account) return;
      const found = ownedRobot(store, account, body?.loopId, res);
      if (!found) return;
      if (!/^[a-f0-9]{40}$/i.test(body?.passwordHash || '')) return sendJson(res, 400, { error: 'Invalid passphrase proof' });
      if (!keyRateAllowed(account._id, found.loop._id)) return sendJson(res, 429, { error: 'Too many attempts. Try later.' });
      try {
        const result = await classic({ base, account, target: 'Key_20160201.Restore',
          body: { loopId: found.loop._id, passwordHash: body.passwordHash.toLowerCase() } });
        return { encryptedKey: result.body?.encryptedKey };
      } catch (error) {
        if (error instanceof ClassicCallError && error.code === 'BACKUP_PASSWORD_WRONG') {
          return sendJson(res, 403, { error: 'Current passphrase is incorrect' });
        }
        return classicFailure(res, error);
      }
    },

    'POST /api/robot/backup-key/change': async ({ req, res, body }) => {
      const account = requireUser(store, req, res);
      if (!account) return;
      const found = ownedRobot(store, account, body?.loopId, res);
      if (!found) return;
      if (!/^[a-f0-9]{40}$/i.test(body?.oldPasswordHash || '')
        || !/^[a-f0-9]{40}$/i.test(body?.newPasswordHash || '')
        || typeof body?.encryptedKey !== 'string' || body.encryptedKey.length > 512
        || !/^[A-Za-z0-9+/]+={0,2}$/.test(body.encryptedKey)) {
        return sendJson(res, 400, { error: 'Invalid encrypted backup' });
      }
      if (!keyRateAllowed(account._id, found.loop._id)) return sendJson(res, 429, { error: 'Too many attempts. Try later.' });
      try {
        await classic({ base, account, target: 'Key_20160201.Restore',
          body: { loopId: found.loop._id, passwordHash: body.oldPasswordHash.toLowerCase() } });
        await classic({ base, account, target: 'Key_20160201.Backup',
          body: { loopId: found.loop._id, encryptedKey: body.encryptedKey,
            passwordHash: body.newPasswordHash.toLowerCase() } });
        return { ok: true };
      } catch (error) {
        if (error instanceof ClassicCallError && error.code === 'BACKUP_PASSWORD_WRONG') {
          return sendJson(res, 403, { error: 'Current passphrase is incorrect' });
        }
        return classicFailure(res, error);
      }
    },
  };
}
