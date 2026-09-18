// Admin configuration API.
//
//   GET    /api/admin/config            the catalogue, with each setting's live value and source
//   PUT    /api/admin/config            validate and persist changes to .env
//   POST   /api/admin/config/reveal     return one secret's value, for an administrator who asked
//   POST   /api/admin/config/generate   a strong random value for a secret field
//
// What this surface will and will not claim:
//
//   * It never says a change is in effect. Services read these at startup, so a
//     write to .env applies when the services that read it next restart. Every
//     response names those services, and the console repeats it.
//   * A value pinned by a real environment variable is reported locked, with the
//     reason. dotenv.js only fills keys the environment left unset, so editing
//     such a key would write a line that never takes effect — and silently doing
//     nothing is worse than refusing.
//   * Secrets are never included in the catalogue response. The console shows a
//     mask and asks for one explicitly.

import { randomBytes } from 'node:crypto';
import { dotEnvLoaded } from '@phoenix/common';

import { SETTINGS, GROUPS, SERVICES, BY_KEY, validate, servicesFor } from './configCatalog.js';
import { readEnvFile, writeEnvFile, envFilePath } from './envFile.js';

const MASK = '••••••••';

/**
 * Where a setting's live value comes from, and whether the console may edit it.
 *
 * `environment` means a real environment variable is set for this key, which
 * dotenv.js will never override — so the .env file cannot change it and we say
 * so rather than pretending.
 */
function resolveSource(key, fileValues) {
  const live = process.env[key];
  const fromDotEnv = Object.prototype.hasOwnProperty.call(dotEnvLoaded(), key);

  if (live !== undefined && live !== '' && !fromDotEnv) {
    return { source: 'environment', locked: true };
  }
  if (fromDotEnv || Object.prototype.hasOwnProperty.call(fileValues, key)) {
    return { source: 'file', locked: false };
  }
  return { source: 'default', locked: false };
}

export function adminConfigRoutes(store, { requireAdmin, sendJson }) {
  return {
    'GET /api/admin/config': ({ req, res }) => {
      if (!requireAdmin(store, req, res)) return;

      const file = readEnvFile();
      const settings = SETTINGS.map((spec) => {
        const { source, locked } = resolveSource(spec.key, file.values);
        const live = process.env[spec.key];
        const isSecret = spec.type === 'secret';
        const hasValue = live !== undefined && live !== '';

        return {
          key: spec.key,
          label: spec.label,
          group: spec.group,
          type: spec.type,
          help: spec.help,
          default: spec.default,
          options: spec.options,
          placeholder: spec.placeholder,
          min: spec.min,
          max: spec.max,
          danger: !!spec.danger,
          services: spec.services,
          source,
          locked,
          hasValue,
          // A secret's value never rides along with the catalogue; the console
          // asks for it by key when someone presses reveal.
          value: isSecret ? (hasValue ? MASK : '') : (hasValue ? String(live) : ''),
          // What the file says, so the console can show that an environment
          // variable is shadowing a different configured value.
          fileValue: isSecret ? undefined : (file.values[spec.key] ?? null),
          commentedValue: isSecret ? undefined : (file.commented[spec.key] ?? null),
        };
      });

      return {
        groups: GROUPS,
        services: SERVICES,
        settings,
        envFile: { path: file.path, exists: file.exists, writable: true },
      };
    },

    'PUT /api/admin/config': ({ req, res, body }) => {
      if (!requireAdmin(store, req, res)) return;

      const changes = body && typeof body.changes === 'object' ? body.changes : null;
      if (!changes) return sendJson(res, 400, { error: 'changes object required' });

      const keys = Object.keys(changes);
      if (!keys.length) return sendJson(res, 400, { error: 'no changes supplied' });

      const file = readEnvFile();
      const errors = {};
      const accepted = {};

      for (const key of keys) {
        const spec = BY_KEY.get(key);
        if (!spec) { errors[key] = 'not a known setting'; continue; }

        const { locked } = resolveSource(key, file.values);
        if (locked) {
          errors[key] = 'set in the process environment, which overrides .env — change it where the '
            + 'service is launched';
          continue;
        }

        const raw = changes[key];
        if (raw !== null && typeof raw !== 'string' && typeof raw !== 'number' && typeof raw !== 'boolean') {
          errors[key] = 'must be a string';
          continue;
        }
        const value = raw === null ? '' : String(raw);
        const problem = validate(key, value);
        if (problem) { errors[key] = problem; continue; }

        accepted[key] = value;
      }

      // All or nothing: a half-applied configuration change is worse than a
      // rejected one, because the operator cannot tell which half landed.
      if (Object.keys(errors).length) {
        return sendJson(res, 400, { error: 'some settings were rejected', errors });
      }

      let result;
      try {
        result = writeEnvFile(accepted);
      } catch (error) {
        return sendJson(res, 500, {
          error: `could not write ${envFilePath()}: ${error.message}`,
        });
      }

      const changed = [...result.applied, ...result.cleared];
      return {
        ok: true,
        path: result.path,
        applied: result.applied,
        cleared: result.cleared,
        added: result.added,
        backup: result.backup,
        // Said plainly, every time: this is not in effect yet.
        restartRequired: servicesFor(changed),
        note: changed.length
          ? 'Saved to the .env file. Services read these values when they start, so restart the '
            + 'services listed before the change takes effect.'
          : 'No change — the values were already what you asked for.',
      };
    },

    /**
     * Reveal one secret. Deliberately a POST of a single key rather than a flag
     * on the catalogue: revealing is an act, it happens one value at a time, and
     * it leaves a line in the log.
     */
    'POST /api/admin/config/reveal': ({ req, res, body }) => {
      if (!requireAdmin(store, req, res)) return;
      const key = body && typeof body.key === 'string' ? body.key : '';
      const spec = BY_KEY.get(key);
      if (!spec) return sendJson(res, 400, { error: 'not a known setting' });
      if (spec.type !== 'secret') return sendJson(res, 400, { error: 'not a secret' });

      const live = process.env[key];
      return { key, value: live === undefined ? '' : String(live) };
    },

    /** A strong value for a secret field, so nobody has to invent one. */
    'POST /api/admin/config/generate': ({ req, res }) => {
      if (!requireAdmin(store, req, res)) return;
      return { value: randomBytes(32).toString('base64url') };
    },
  };
}
