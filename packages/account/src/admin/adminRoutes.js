// Admin operations API.
//
//   GET  /api/admin/overview   the server at a glance: its services, people and robots, recent
//                              voice activity, disk space, and what needs attention
//   GET  /api/admin/fleet      every robot (with its loop, owner and whether it is online) and loop
//   GET  /api/admin/admins     everyone who can sign in, with their administrator flag
//   POST /api/admin/admins     grant or revoke administrator access
//
// Granting is the same operation scripts/portal-grant-admin.mjs performs — the
// `isAdmin` flag on the account, flushed to the store — so the two agree and
// neither is a second path with its own rules.
//
// Everything reported is observed, not inferred: services are health-checked when
// asked, robots are asked whether they are connected, and anything that could not
// be checked is reported as unknown rather than guessed.

import { execFile } from 'node:child_process';
import { statfs, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { BY_KEY, SERVICES } from './configCatalog.js';
import { consoleSettingsFile, readConsoleSettings } from './consoleSettings.js';
import { launcherControl, readLauncherState, servicesStatus } from './launcherControl.js';
import { effectiveValues, readServerValues } from './settingsRoutes.js';
import { fetchVoiceTurnPage } from './voiceTurnRoutes.js';

const sameId = (a, b) => a != null && b != null && String(a) === String(b);
const accepted = (member) => String(member?.status || '').toLowerCase() === 'accepted';
const displayName = (account) => [account?.firstName, account?.lastName].filter(Boolean).join(' ').trim();

/** People who can sign in: not robots, not deleted, with an email address. */
function people(store) {
  return [...store.accounts.values()].filter((a) => !a.isDeleted && !a.friendlyId && a.email);
}

function activeLoops(store) {
  return [...store.loops.values()].filter((loop) => loop.isDeleted !== true);
}

/** Identity only. Never password material, access keys or secrets. */
function adminView(store, account) {
  const loops = activeLoops(store).filter((loop) => sameId(loop.owner, account._id)
    || (loop.members || []).some((member) => sameId(member.accountId, account._id) && accepted(member)));
  return {
    id: String(account._id),
    email: account.email || null,
    firstName: account.firstName || '',
    lastName: account.lastName || '',
    isAdmin: !!account.isAdmin,
    isActive: account.isActive !== false,
    created: account.created || null,
    loops: loops.length,
  };
}

/** The release running here, read once: the commit and its date, when this is a git checkout. */
let releasePromise = null;
function releaseInfo() {
  releasePromise ||= new Promise((resolve) => {
    execFile('git', ['log', '-1', '--format=%h%x09%cI'], { cwd: process.cwd(), timeout: 3000 }, (error, stdout) => {
      if (error) return resolve(null);
      const [commit, date] = String(stdout).trim().split('\t');
      resolve(/^[0-9a-f]{7,40}$/.test(commit || '') ? { commit, date: date || null } : null);
    });
  });
  return releasePromise;
}

async function diskUsage(path) {
  try {
    const fs = await statfs(path);
    return { free: fs.bavail * fs.bsize, total: fs.blocks * fs.bsize };
  } catch {
    return null;
  }
}

const percentile = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : null);

/** The last hour of voice turns, summarized. Never what was said, nor by whom. */
async function voiceSummary(env, fetchImpl) {
  const windowMs = 60 * 60 * 1000;
  const result = await fetchVoiceTurnPage({
    env, fetchImpl, query: new URLSearchParams({ limit: '100', from: String(Date.now() - windowMs) }),
  });
  if (!result.ok) return null;
  const turns = result.page.turns;
  const failed = new Set(['error', 'timeout', 'remote_error', 'abandoned', 'cancelled']);
  let understood = 0;
  let missed = 0;
  let failures = 0;
  for (const turn of turns) {
    if (failed.has(turn.outcome)) { failures += 1; continue; }
    const route = turn.stages.find((stage) => stage.stage === 'route');
    if (route?.outcome === 'matched') understood += 1;
    else if (route?.outcome === 'unmatched') missed += 1;
  }
  const times = turns.filter((turn) => !failed.has(turn.outcome) && Number.isFinite(turn.totalMs))
    .map((turn) => turn.totalMs).sort((a, b) => a - b);
  return {
    windowMs,
    turns: turns.length,
    understood,
    missed,
    failed: failures,
    medianMs: percentile(times, 0.5),
    p90Ms: percentile(times, 0.9),
  };
}

/** Things an administrator should know about, most serious first. */
function attentionItems({ status, control, settingsError, pendingByService, effective, adminCount, disk, serverFile, launcherStartedAt }) {
  const items = [];
  const label = (id) => SERVICES[id]?.label || id;

  for (const service of status.services) {
    if (service.minor) continue;
    if (service.state === 'stopped') {
      items.push({
        level: 'error',
        title: `${service.label} isn’t running`,
        body: service.safeMode
          ? 'It stopped right after starting, even without the settings saved here. Its log says why.'
          : `It stopped${service.exitCode !== null ? ` (exit code ${service.exitCode})` : ''}. Its log says why.`,
        action: { label: 'Start it', restart: [service.id] },
        service: service.id,
      });
    } else if (service.state === 'running' && service.healthy === false) {
      items.push({
        level: 'error',
        title: `${service.label} isn’t answering`,
        body: 'It is running but didn’t respond to a health check just now.',
        action: { label: 'Restart it', restart: [service.id] },
        service: service.id,
      });
    }
    if (service.state === 'running' && service.safeMode) {
      items.push({
        level: 'warn',
        title: `${service.label} is running without your saved settings`,
        body: 'It stopped right after starting with them, so it was started without them. Check the settings it '
          + 'uses, then restart it.',
        action: { label: 'Review settings', href: '#/admin/settings' },
        service: service.id,
      });
    }
  }
  if (settingsError) {
    items.push({ level: 'error', title: 'Saved settings can’t be read', body: settingsError,
      action: { label: 'Open settings', href: '#/admin/settings' } });
  }

  const pending = Object.keys(pendingByService);
  if (pending.length) {
    const count = Object.values(pendingByService).reduce((max, n) => Math.max(max, n), 0);
    items.push({
      level: 'info',
      title: count === 1 ? 'A saved change is waiting for a restart' : 'Saved changes are waiting for a restart',
      body: `${pending.map(label).join(', ')} ${pending.length === 1 ? 'is' : 'are'} still running without `
        + `${count === 1 ? 'it' : 'them'}.`,
      action: { label: 'Restart now', restart: pending },
    });
  }

  if (adminCount === 1) {
    items.push({
      level: 'warn',
      title: 'You’re the only administrator',
      body: 'If you lose access to your account, nobody can manage this server from here.',
      action: { label: 'Add another', href: '#/admin/people' },
    });
  }

  if (!effective.PARAKEET_URL) {
    items.push({ level: 'warn', title: 'Speech recognition isn’t set up',
      body: 'Without a recognition server, Jibo hears “Hey Jibo” but not the question.',
      action: { label: 'Set it up', href: '#/admin/settings?group=speech' } });
  }
  if (!effective.ETCO_account_mailSmtpHost) {
    items.push({ level: 'warn', title: 'Email isn’t set up',
      body: 'Nobody can confirm a new account or reset a password by email.',
      action: { label: 'Set it up', href: '#/admin/settings?group=mail' } });
  }
  if (!effective.TOMTOM_API_KEY) {
    items.push({ level: 'info', title: 'Commute times are off',
      body: 'Jibo can’t tell anyone how long their commute will take without a TomTom key.',
      action: { label: 'Add a key', href: '#/admin/settings?group=report' } });
  }
  if (!effective.ETCO_gqa_wolframKey && (effective.PHOENIX_GQA_DEFAULT_PROFILE || '') === '') {
    items.push({ level: 'info', title: 'Answers can’t work things out',
      body: 'Without Wolfram|Alpha, Jibo can’t answer measurements, distances or arithmetic.',
      action: { label: 'Add an app ID', href: '#/admin/settings?group=answers' } });
  }

  if (disk && disk.total > 0 && disk.free / disk.total < 0.1) {
    const gb = (bytes) => `${(bytes / 1e9).toFixed(1)} GB`;
    items.push({ level: 'warn', title: 'The disk is nearly full',
      body: `${gb(disk.free)} free of ${gb(disk.total)}. Photos, backups and updates need room.` });
  }

  if (serverFile.changedAt && launcherStartedAt && serverFile.changedAt > launcherStartedAt + 5000) {
    items.push({
      level: 'info',
      title: 'The server’s settings file changed after Phoenix started',
      body: 'Services keep the values they started with until they restart.',
      action: control.available ? { label: 'Restart everything', restart: 'all' } : undefined,
    });
  }

  const rank = { error: 0, warn: 1, info: 2 };
  return items.sort((a, b) => rank[a.level] - rank[b.level]);
}

export function adminOpsRoutes(store, {
  requireAdmin, sendJson, currentAccount, env = process.env, fetchImpl = fetch,
  presence = null,
  control: controlFor = () => launcherControl(env),
}) {
  /** Ask each robot whether it is connected; null where that could not be found out. */
  const robotsOnline = async (robots) => {
    if (typeof presence !== 'function') return robots.map(() => null);
    return Promise.all(robots.map(async (robot) => {
      try {
        const online = await presence(robot);
        return typeof online === 'boolean' ? online : null;
      } catch {
        return null;
      }
    }));
  };

  return {
    'GET /api/admin/overview': async ({ req, res }) => {
      if (!requireAdmin(store, req, res)) return undefined;
      const control = controlFor();
      const settingsFile = consoleSettingsFile({ env, storeFile: store.file });
      const { state, error: settingsError } = readConsoleSettings(settingsFile);
      const server = readServerValues(env);
      const robots = store.allRobots().map((r) => r.robot);
      const dataDir = env.PHOENIX_DATA_DIR || dirname(store.file);

      const [status, online, voice, disk, release, serverStat] = await Promise.all([
        servicesStatus(control, { fetchImpl }),
        robotsOnline(robots),
        voiceSummary(env, fetchImpl),
        diskUsage(dataDir),
        releaseInfo(),
        server.exists ? stat(server.path).catch(() => null) : Promise.resolve(null),
      ]);

      // Saved changes each running service has not picked up yet.
      const launcher = readLauncherState(control);
      const pendingByService = {};
      if (launcher) {
        for (const [key, entry] of Object.entries(state.settings)) {
          const spec = BY_KEY.get(key);
          for (const id of spec?.restart || []) {
            const s = launcher.services[id];
            if (s && !(Number(s.revision) >= entry.revision)) pendingByService[id] = (pendingByService[id] || 0) + 1;
          }
        }
      }

      const everyone = people(store);
      const adminCount = everyone.filter((a) => a.isAdmin).length;
      const loops = activeLoops(store);
      const known = online.filter((value) => value !== null);

      return {
        phoenix: {
          release,
          node: process.version,
          platform: `${process.platform} ${process.arch}`,
          startedAt: status.launcher?.startedAt ?? Date.now() - Math.round(process.uptime() * 1000),
        },
        control: { available: !!control.available },
        services: status.services.map((service) => ({ ...service, pendingSettings: pendingByService[service.id] || 0 })),
        counts: {
          people: everyone.length,
          admins: adminCount,
          loops: loops.length,
          robots: robots.length,
          online: known.length ? known.filter(Boolean).length : null,
        },
        voice,
        disk: disk ? { ...disk, path: dataDir } : null,
        attention: attentionItems({
          status, control, settingsError, pendingByService,
          effective: effectiveValues(state, server), adminCount, disk,
          serverFile: { changedAt: serverStat?.mtimeMs ?? null },
          launcherStartedAt: status.launcher?.startedAt ?? null,
        }),
      };
    },

    'GET /api/admin/fleet': async ({ req, res }) => {
      if (!requireAdmin(store, req, res)) return undefined;
      const loops = activeLoops(store);
      const robotAccounts = [...store.accounts.values()].filter((a) => a.friendlyId && !a.isDeleted);
      const online = await robotsOnline(robotAccounts);
      const ownerView = (id) => {
        const owner = id ? store.accounts.get(String(id)) : null;
        return owner ? { name: displayName(owner) || null, email: owner.email || null } : null;
      };
      const peopleIn = (loop) => (loop.members || [])
        .filter((member) => accepted(member) && !sameId(member.accountId, loop.robot)).length;

      return {
        robots: robotAccounts.map((robot, index) => {
          const loop = loops.find((l) => sameId(l.robot, robot._id)) || null;
          return {
            friendlyId: robot.friendlyId,
            name: loop?.name || null,
            color: loop?.avatarColor || 'blue',
            loopId: loop ? String(loop._id) : null,
            owner: loop ? ownerView(loop.owner) : null,
            people: loop ? peopleIn(loop) : 0,
            created: robot.created || null,
            lastSeen: robot.lastSeen || null,
            online: online[index],
          };
        }),
        loops: loops.map((loop) => {
          const robot = loop.robot ? store.accounts.get(String(loop.robot)) : null;
          return {
            id: String(loop._id),
            name: loop.name || null,
            color: loop.avatarColor || 'blue',
            robot: robot?.friendlyId || null,
            owner: ownerView(loop.owner),
            people: peopleIn(loop),
            invited: (loop.members || []).filter((m) => String(m.status || '').toLowerCase() === 'invited').length,
            suspended: loop.isSuspended === true,
            created: loop.created || null,
          };
        }),
      };
    },

    'GET /api/admin/admins': ({ req, res }) => {
      if (!requireAdmin(store, req, res)) return undefined;
      const accounts = people(store)
        .map((account) => adminView(store, account))
        // Administrators first, then by name or email, so the short list is at the top.
        .sort((a, b) => Number(b.isAdmin) - Number(a.isAdmin)
          || (displayName(a) || a.email || '').localeCompare(displayName(b) || b.email || ''));
      return { accounts, adminCount: accounts.filter((a) => a.isAdmin).length };
    },

    'POST /api/admin/admins': ({ req, res, body }) => {
      if (!requireAdmin(store, req, res)) return undefined;

      const email = body && typeof body.email === 'string' ? body.email.trim() : '';
      const grant = !!(body && body.grant);
      if (!email) return sendJson(res, 400, { error: 'email required' });

      const target = store.accountByEmail(email);
      if (!target) return sendJson(res, 404, { error: `no account with email ${email}` });

      const actor = currentAccount(store, req);

      // Removing your own access is a decision, not a slip, and a console that
      // lets you do it by accident is a console that locks you out of itself.
      if (!grant && actor && String(actor._id) === String(target._id)) {
        return sendJson(res, 400, {
          error: 'you cannot revoke your own administrator access from here — ask another '
            + 'administrator, or use scripts/portal-grant-admin.mjs',
        });
      }

      // The same guard one level up: never leave the instance with no way back in.
      if (!grant) {
        const remaining = [...store.accounts.values()]
          .filter((a) => !a.isDeleted && a.isAdmin && String(a._id) !== String(target._id));
        if (!remaining.length) {
          return sendJson(res, 400, {
            error: 'this is the only administrator — granting someone else access first keeps you '
              + 'from being locked out',
          });
        }
      }

      if (!!target.isAdmin === grant) {
        return { ok: true, changed: false, account: adminView(store, target) };
      }

      target.isAdmin = grant;
      store.flush();
      return { ok: true, changed: true, account: adminView(store, target) };
    },
  };
}
