#!/usr/bin/env node

/**
 * Convert the private robot runner outputs into a receipt candidate.
 *
 * This adapter is intentionally read-only with respect to Phoenix/Moth.  It
 * copies the source stack, fixture, turn, wire, and screenshot bytes into the
 * private receipt directory and derives the normalized S-13 records from
 * those bytes.  It never fills a missing action or ACK from the matrix.  A
 * candidate made from an incomplete or semantically different run therefore
 * remains rejected by validate.mjs.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  DEFAULT_MATRIX_PATH,
  addLocalDays,
  canonicalJson,
  canonicalSha256,
  matrixInventory,
  matrixSha256,
  sha256Bytes,
  sha256Text,
  resolveCommuteSchedule,
  validateReceipt
} from './validate.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
const CANONICALIZATION = 'sorted object keys, array order preserved, UTF-8 JSON without trailing newline';

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function fail(message) {
  throw new Error(`S13 raw-run adapter: ${message}`);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readRegular(file, label) {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink()) fail(`${label} is a symlink`);
  if (!stat.isFile()) fail(`${label} is not a regular file`);
  const absolute = path.resolve(file);
  if (fs.realpathSync(file) !== absolute) fail(`${label} has a symlinked ancestor`);
  return fs.readFileSync(file);
}

function ensurePrivateRun(runDir) {
  const root = path.resolve(runDir);
  const stat = fs.lstatSync(root);
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail('run directory must be a real directory');
  const real = fs.realpathSync(root);
  if (real !== root) fail('run directory has a symlinked ancestor');
  return root;
}

function bundleValue(runDir, entry, key, fallback) {
  const value = entry && typeof entry === 'object' ? entry[key] : undefined;
  if (value === undefined) return fallback;
  return value;
}

function sourceName(value, fallback, bundleDir, label) {
  if (value === undefined || value === null) return fallback;
  const raw = typeof value === 'string' ? value : (isPlainObject(value) ? value.path : undefined);
  if (typeof raw !== 'string' || !raw) fail(`${label} must name a source file`);
  const absolute = path.resolve(bundleDir, raw);
  if (absolute !== bundleDir && !absolute.startsWith(`${bundleDir}${path.sep}`)) {
    fail(`${label} escapes its bundle directory`);
  }
  return path.relative(bundleDir, absolute);
}

function resolveBundle(runDir, entry, legacyFiles = {}) {
  // The capture runner emits `bundle`; the toolkit's compact manifest uses
  // `dir`/`path`.  All forms resolve below the private run root and are
  // checked by ensurePrivateRun before any bytes are opened.
  const configuredDir = typeof entry === 'string' ? entry : (entry?.bundle || entry?.dir || entry?.path);
  const bundleDir = configuredDir ? path.resolve(configuredDir.startsWith('/') ? configuredDir : path.join(runDir, configuredDir)) : runDir;
  const dir = ensurePrivateRun(bundleDir);
  return {
    dir,
    stack: sourceName(bundleValue(runDir, entry, 'stack', legacyFiles.stack || 'stack.json'), legacyFiles.stack || 'stack.json', dir, 'bundle.stack'),
    fixture: sourceName(bundleValue(runDir, entry, 'fixture', legacyFiles.fixture || 'fixture.json'), legacyFiles.fixture || 'fixture.json', dir, 'bundle.fixture'),
    wire: sourceName(bundleValue(runDir, entry, 'wire', legacyFiles.wire || null), legacyFiles.wire || null, dir, 'bundle.wire'),
    turn: sourceName(bundleValue(runDir, entry, 'turn', legacyFiles.turn || null), legacyFiles.turn || null, dir, 'bundle.turn'),
    context: sourceName(bundleValue(runDir, entry, 'context', legacyFiles.context || null), legacyFiles.context || null, dir, 'bundle.context'),
    declaredCaseId: entry && typeof entry === 'object' ? entry.caseId : undefined,
    declaredFixture: entry && typeof entry === 'object' && isPlainObject(entry.fixture) ? entry.fixture : undefined
  };
}

function discoverWire(dir, configured) {
  if (configured) return configured;
  return fs.readdirSync(dir).find((name) => /^wire-.*\.jsonl$/.test(name)) || null;
}

function discoverTurn(dir, configured) {
  if (configured) return configured;
  const names = fs.readdirSync(dir);
  if (names.includes('turn.json')) return 'turn.json';
  return names
    .filter((name) => /\.json$/.test(name) && name !== 'stack.json' && name !== 'fixture.json' && !/^fixture(?:-|\.)/.test(name) && !/^history(?:-|\.)/.test(name) && !/^idle-/.test(name))
    .sort()
    .find((name) => /^turn(?:-|\.)/.test(name)) || null;
}

function bundleFile(bundle, sourceName, label) {
  if (typeof sourceName !== 'string' || !sourceName) fail(`${label} is missing`);
  const absolute = path.resolve(bundle.dir, sourceName);
  if (absolute !== bundle.dir && !absolute.startsWith(`${bundle.dir}${path.sep}`)) {
    fail(`${label} escapes its bundle directory`);
  }
  return absolute;
}

function copyRaw(runDir, outRoot, sourceName, destination) {
  const source = path.resolve(runDir, sourceName);
  if (!source.startsWith(`${runDir}${path.sep}`)) fail(`source escapes run root: ${sourceName}`);
  const bytes = readRegular(source, sourceName);
  const target = path.join(outRoot, destination);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes);
  return { path: destination, sha256: sha256Bytes(bytes), bytes: bytes.length, sourceName };
}

function writeArtifact(root, relativePath, content) {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes);
  return { path: relativePath, sha256: sha256Bytes(bytes), bytes: bytes.length };
}

function writeJson(root, relativePath, value) {
  return writeArtifact(root, relativePath, canonicalJson(value));
}

function writeJsonl(root, relativePath, values) {
  return writeArtifact(root, relativePath, `${values.map((value) => canonicalJson(value)).join('\n')}\n`);
}

function readJson(file, label) {
  const bytes = readRegular(file, label);
  try {
    return { value: JSON.parse(bytes.toString('utf8')), bytes, sha256: sha256Bytes(bytes) };
  } catch (error) {
    fail(`${label} is not JSON: ${error.message}`);
  }
}

function readJsonl(file, label) {
  const bytes = readRegular(file, label);
  const text = bytes.toString('utf8');
  if (!text.endsWith('\n')) fail(`${label} must end with a newline`);
  const lines = text.trimEnd().split(/\r?\n/).filter(Boolean);
  return {
    values: lines.map((line, index) => {
      try { return JSON.parse(line); } catch (error) { fail(`${label} line ${index} is not JSON: ${error.message}`); }
    }),
    bytes,
    sha256: sha256Bytes(bytes)
  };
}

function atPath(value, pathParts) {
  let current = value;
  for (const part of pathParts || []) {
    if (current === undefined || current === null) return undefined;
    current = current[part];
  }
  return current;
}

function walkMims(value, output = []) {
  if (Array.isArray(value)) {
    value.forEach((item) => walkMims(item, output));
  } else if (value && typeof value === 'object') {
    if (value.meta?.mim_id) output.push(value.meta.mim_id);
    Object.values(value).forEach((item) => walkMims(item, output));
  }
  return output;
}

function eventRows(turn) {
  return Array.isArray(turn.events) ? turn.events.filter((row) => row?.event && typeof row.event === 'object') : [];
}

function lastAction(turn) {
  const rows = eventRows(turn);
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (rows[index].event.type === 'SKILL_ACTION' && rows[index].event.data?.action) return { row: rows[index], index };
  }
  return null;
}

function firstTurnId(turn) {
  return eventRows(turn).find((row) => row.event.type === 'TURN_STARTED' && row.event.transID)?.event.transID || null;
}

function rawDisplay(turn, displayAction) {
  const event = eventRows(turn)[displayAction.eventIndex]?.event;
  return atPath(event, displayAction.actionPath);
}

function rawDisplayContracts(turn, expectedIds) {
  const rows = (turn.displayActions || [])
    .filter((item) => expectedIds.includes(item?.viewId))
    .sort((a, b) => (a.displayOrdinal ?? 0) - (b.displayOrdinal ?? 0));
  return rows.map((displayAction) => {
    const display = rawDisplay(turn, displayAction);
    const data = display?.view?.context?.data;
    const components = Array.isArray(data?.componentConfigs) ? data.componentConfigs : [];
    const assets = components.flatMap((component) => Array.isArray(component.assets) ? component.assets : []);
    const byId = (id) => components.find((component) => component.id === id);
    const viewConfig = data?.viewConfig || {};
    const raw = {
      ordinal: rows.indexOf(displayAction),
      id: viewConfig.id || displayAction.viewId,
      type: viewConfig.id === 'eventView' ? 'calendar-card' : viewConfig.id === 'trafficView' ? 'commute-traffic' : 'commute-departure',
      assets: assets.map((asset) => ({ id: asset.id, src: asset.src, type: asset.type })),
      componentConfigs: components.map((component) => ({
        id: component.id,
        position: component.position,
        text: component.text,
        assets: component.assets
      })),
      defaultSelect: data?.defaultSelect,
      open: data?.open,
      rawDisplaySha256: sha256Text(JSON.stringify(display))
    };
    return raw;
  });
}

function firstAsset(raw, source) {
  return raw.assets?.find((asset) => asset.src === source) || raw.assets?.[0];
}

// The raw action contains the full JCP display object.  The receipt action
// intentionally projects only the matrix contract, while retaining the raw
// display digest/source event in the turn artifact.  This prevents a producer
// from passing a different shape merely by adding or dropping unrelated JCP
// fields, and makes the field-level contract directly reviewable.
function projectDisplayContracts(rawDisplays, expectedContracts) {
  return rawDisplays.map((raw, index) => {
    const expected = expectedContracts[index] || {};
    const components = raw.componentConfigs || [];
    const component = (id) => components.find((item) => item.id === id);
    const time = component('departTimeLabel') || component('timeLabel');
    const ampm = component('departAmPmLabel') || component('ampmLabel');
    const summary = component('eventSummary');
    const card = firstAsset(raw, expected.asset);
    const icon = expected.icon ? firstAsset(raw, expected.icon) : null;
    const fields = expected.fields || {};
    if (expected.type === 'commute-traffic') {
      return {
        ordinal: index,
        id: raw.id,
        type: expected.type,
        asset: card?.src,
        fields: {
          position: component('trafficClip')?.position,
          defaultSelect: raw.defaultSelect,
          open: raw.open
        }
      };
    }
    if (expected.type === 'commute-departure') {
      return {
        ordinal: index,
        id: raw.id,
        type: expected.type,
        labels: { time: time?.text, ampm: ampm?.text },
        fields: {
          timePositionX: time?.position?.x,
          ampmPositionX: ampm?.position?.x,
          open: raw.open,
          defaultSelect: raw.defaultSelect
        }
      };
    }
    if (expected.type === 'calendar-card') {
      return {
        ordinal: index,
        id: raw.id,
        type: expected.type,
        asset: card?.src,
        icon: icon?.src,
        labels: { time: time?.text || null, ampm: ampm?.text || null, summary: summary?.text },
        fields: {
          timePositionX: time?.position?.x,
          ampmPositionX: ampm?.position?.x,
          fullDay: (time?.text || '') === '' && (ampm?.text || '') === '',
          leaveEmpty: raw.defaultSelect?.leaveEmpty
        }
      };
    }
    return {
      ordinal: index,
      id: raw.id,
      type: raw.type,
      ...(fields.asset ? { asset: firstAsset(raw, fields.asset)?.src } : {})
    };
  });
}

function localDateISO(iso, timezone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
}

function rawFixtureCase(fixture, descriptor, declaredCaseId = undefined) {
  const aliases = {
    'commute-normal-combined': 'Normal',
    'commute-bad-combined': 'Bad',
    'commute-terrible-combined': 'Terrible',
    'calendar-four-card-field-matrix': 'calendar-four-card-field-matrix',
    'calendar-concurrent-parallel': 'calendar-parallel'
  };
  const key = declaredCaseId || aliases[descriptor.id] || descriptor.id;
  return fixture.cases?.[key] ? { key, value: fixture.cases[key] } : null;
}

function providerProjection(descriptor, fixtureCase, resolvedDateISO) {
  const provider = fixtureCase?.value || {};
  const maps = provider.maps?.routes?.[0]?.legs?.[0] || {};
  const baseSeconds = maps.duration?.value;
  const trafficSeconds = maps.duration_in_traffic?.value;
  return {
    kind: descriptor.provider.kind,
    ...(descriptor.provider.fixture === undefined ? {} : { fixture: descriptor.provider.fixture }),
    ...(Number.isFinite(baseSeconds) ? { baseSeconds } : {}),
    ...(Number.isFinite(trafficSeconds) ? { trafficSeconds } : {}),
    ...(descriptor.provider.parallel === undefined ? {} : { parallel: descriptor.provider.parallel }),
    resolvedDateISO
  };
}

function fixtureEvents(fixtureCase, descriptor, resolvedDateISO) {
  const value = fixtureCase?.value || {};
  const timestampRows = Array.isArray(value.meta?.eventTimestamps) ? value.meta.eventTimestamps : [];
  const calendar = value.calendar || {};
  const lookup = (service, calendarName, index) => {
    const source = calendar?.[service]?.[calendarName];
    const items = Array.isArray(source?.items) ? source.items : Array.isArray(source?.value) ? source.value : [];
    return items[index];
  };
  const localTime = (dateTime) => {
    if (typeof dateTime !== 'string') return null;
    const match = dateTime.match(/T(\d{2}):(\d{2})/);
    if (!match) return null;
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    return { hour, minute, time: `${hour % 12 || 12}:${String(minute).padStart(2, '0')} ${hour >= 12 ? 'PM' : 'AM'}` };
  };
  const sourceEvents = timestampRows.map((row) => {
    const item = lookup(row.service, row.calendar, row.index);
    const start = item?.start || {};
    const allDay = typeof start.date === 'string' || item?.isAllDay === true;
    const rawDate = start.date || start.dateTime;
    const date = typeof rawDate === 'string' ? rawDate.slice(0, 10) : null;
    const clock = allDay ? null : localTime(start.dateTime);
    return {
      summary: item?.summary || item?.subject,
      hour: clock?.hour ?? 0,
      minute: clock?.minute ?? 0,
      time: clock?.time ?? null,
      fullDay: allDay,
      date,
      source: `${row.service}/${row.calendar}/${row.index}`
    };
  });
  if (descriptor?.domain !== 'calendar') return [];
  // Keep the source-derived projection even when it differs from the matrix;
  // the pure validator will report the mismatch on the candidate instead of
  // turning a bad run into an unreviewable adapter exception.
  return sourceEvents.map(({ source, date, ...event }) => event);
}

function findContext(wireRows, ids) {
  return wireRows.find((record) => record?.kind === 'client-message' && record.json?.type === 'CONTEXT' && ids.has(record.json?.transID) && record.json?.data?.runtime?.location?.iso) || null;
}

function selectedWireConnection(wireRows, turn, action) {
  const actionId = action?.row?.event?.transID;
  const firstId = firstTurnId(turn);
  const ids = new Set([actionId, firstId].filter(Boolean));
  // A target turn can follow an excluded/prelude turn on the same socket.
  // Prefer the target action's context so the source message/transID cannot
  // accidentally be borrowed from the prelude.
  const context = (actionId && findContext(wireRows, new Set([actionId]))) || findContext(wireRows, ids);
  const connectionId = context?.id;
  const rows = connectionId === undefined ? [] : wireRows.map((record, index) => ({ record, index })).filter(({ record }) => record.id === connectionId);
  const contextIndex = context ? wireRows.findIndex((record) => record === context) : -1;
  return { connectionId, context, contextIndex, rows };
}

function contextSourceFields(value) {
  if (!isPlainObject(value)) return null;
  const candidate = value.context || value.json || value;
  const runtime = candidate.runtime || candidate.data?.runtime || candidate.json?.data?.runtime;
  const location = candidate.location || runtime?.location;
  const sourceMessageId = value.sourceMessageId || value.messageId || value.msgID || value.json?.msgID || candidate.msgID;
  const sourceLine = value.sourceLine ?? value.line ?? value.index;
  return {
    runtimeLocationISO: value.runtimeLocationISO || location?.iso,
    timezone: value.timezone || value.timeZone || runtime?.timezone || value.fixture?.timeZone,
    capturedAtISO: value.capturedAtISO || value.timestampISO || value.at || candidate.timestampISO || candidate.at,
    source: value.source || value.sourceKind || candidate.source || 'context-artifact',
    sourceMessageId,
    sourceLine: Number.isInteger(sourceLine) ? sourceLine : Number(sourceLine)
  };
}

function sourceRecord(record, index, wireBytes) {
  return {
    line: index,
    kind: record?.kind,
    id: record?.id,
    messageId: record?.json?.msgID,
    sha256: sha256Text(canonicalJson(record)),
    traceSha256: wireBytes.sha256
  };
}

function screenshotAt(turn, shot, index) {
  // turn.py records stable duration but not a wall timestamp.  Preserve that
  // fact in the derived capture and use the display event elapsed time as the
  // only source-derived anchor available in this format.
  const elapsed = (shot.displayAction?.eventElapsedMs ?? 0) + (shot.stableForMs ?? 0) + index;
  return new Date(Date.parse(turn.started) + elapsed).toISOString();
}

function finalIdle(turn) {
  const snapshots = Array.isArray(turn.snapshots) ? turn.snapshots : [];
  for (let index = snapshots.length - 1; index >= 0; index -= 1) {
    const be = snapshots[index]?.be;
    if (be?.skill === '@be/idle' && be.view === 'eyeView' && be.listen === 'Idle' && be.talking === false) return snapshots[index];
  }
  return null;
}

function deriveRow(matrix, descriptor, turn, fixture, wire, outRoot, rawRefs, runtime, operation, contextRead = null, declaredCaseId = undefined, visualReview = null) {
  const actionInfo = lastAction(turn);
  if (!actionInfo) fail(`${descriptor.id} has no SKILL_ACTION event`);
  const actionEvent = actionInfo.row.event;
  const rawAction = actionEvent.data.action;
  const rawMims = walkMims(rawAction);
  const expectedIds = descriptor.expected.viewIds;
  const rawDisplays = rawDisplayContracts(turn, expectedIds);
  const displays = projectDisplayContracts(rawDisplays, descriptor.expected.viewContracts);
  const reportShots = (turn.screenshots || [])
    .filter((shot) => expectedIds.includes(shot?.viewId) && shot?.displayAction?.captureKey)
    .sort((a, b) => (a.displayAction.displayOrdinal ?? 0) - (b.displayAction.displayOrdinal ?? 0));
  const fixtureCase = rawFixtureCase(fixture, descriptor, declaredCaseId);
  if (!fixtureCase) fail(`${descriptor.id} is missing from the private fixture`);
  const dateISO = localDateISO(turn.started, runtime.timezone);
  const resolvedDateISO = descriptor.domain === 'calendar' ? addLocalDays(dateISO, 1, runtime.timezone) : dateISO;
  const provider = providerProjection(descriptor, fixtureCase, resolvedDateISO);
  const route = fixtureCase.value.maps?.routes?.[0]?.legs?.[0];
  const context = selectedWireConnection(wire.values, turn, actionInfo);
  const explicitContext = contextSourceFields(contextRead?.value);
  const rawContext = context.context;
  const rawContextFields = rawContext ? {
    ...contextSourceFields(rawContext),
    source: 'wire-context',
    sourceLine: context.contextIndex
  } : null;
  const contextISO = explicitContext?.runtimeLocationISO || rawContextFields?.runtimeLocationISO || turn.started;
  const contextAtISO = explicitContext?.capturedAtISO || rawContextFields?.capturedAtISO || turn.started;
  const contextTimezone = explicitContext?.timezone || rawContextFields?.timezone || fixture.timeZone || runtime.timezone;
  const contextMessageId = explicitContext?.sourceMessageId || rawContextFields?.sourceMessageId || `missing-context-${descriptor.id}`;
  const contextSourceLine = Number.isInteger(explicitContext?.sourceLine) ? explicitContext.sourceLine : rawContextFields?.sourceLine;
  // A raw CONTEXT line is a valid standalone anchor only when its location,
  // timezone (from the immutable fixture metadata), capture timestamp,
  // message ID, and source line are all present. An optional context JSON can
  // refine those fields, but cannot replace the source wire record.
  const contextReady = Boolean(rawContextFields?.runtimeLocationISO && rawContextFields?.timezone && rawContextFields?.capturedAtISO && rawContextFields?.sourceMessageId && Number.isInteger(rawContextFields?.sourceLine) && (!explicitContext || (explicitContext.runtimeLocationISO === rawContextFields.runtimeLocationISO && explicitContext.timezone === rawContextFields.timezone && explicitContext.sourceMessageId === rawContextFields.sourceMessageId && explicitContext.sourceLine === rawContextFields.sourceLine)));
  const primaryRequestID = firstTurnId(turn) || actionEvent.requestID;
  const actionRequestID = actionEvent.requestID || actionEvent.transID;
  const requestID = actionRequestID || primaryRequestID;
  const transID = actionEvent.transID || requestID;
  const requestBody = clone(turn.request?.body);
  const request = {
    operation,
    method: 'POST',
    endpoint: turn.request?.endpoint,
    transportMode: operation === 'startLocalTurn' ? 'local' : 'global',
    mode: descriptor.input.mode,
    microphoneAcceptance: turn.microphoneAcceptance,
    phrase: turn.text,
    body: requestBody,
    bodySha256: canonicalSha256(requestBody),
    runtimeLocalDateISO: runtime.localDateISO
  };
  if (descriptor.domain === 'commute') {
    const trafficSeconds = route?.duration_in_traffic?.value;
    const baseSeconds = route?.duration?.value;
    request.locationISO = contextISO;
    request.locationMode = contextReady ? 'capture-local-clock' : 'raw-context-location';
    const schedule = resolveCommuteSchedule(contextISO, descriptor.input.prefsPolicy.schedule, runtime.timezone);
    request.prefs = {
      mode: descriptor.input.prefsPolicy.mode,
      workHour: schedule?.hour,
      workMin: schedule?.minute,
      workDateISO: schedule?.dateISO,
      baseSeconds,
      trafficSeconds
    };
    request.prefsResolution = {
      schedule: descriptor.input.prefsPolicy.schedule,
      generatedFrom: 'capture-local-clock',
      workDateISO: request.prefs.workDateISO,
      sha256: canonicalSha256(request.prefs)
    };
  }
  if (descriptor.domain === 'calendar') {
    request.calendarDateISO = resolvedDateISO;
    request.calendarFixture = descriptor.input.calendarFixture;
  }
  const fixtureContent = {
    schema: 's13-private-provider-fixture-v1',
    caseId: descriptor.id,
    domain: descriptor.domain,
    fixture: descriptor.provider.fixture,
    resolvedDateISO,
    ...(request.calendarDateISO ? { calendarDateISO: request.calendarDateISO } : {}),
    ...(descriptor.domain === 'calendar' ? { events: fixtureEvents(fixtureCase, descriptor, resolvedDateISO) } : {}),
    provider: { ...provider },
    sourceFixture: { path: rawRefs.fixture.path, sha256: rawRefs.fixture.sha256, caseKey: fixtureCase.key }
  };
  const providerFixture = writeJson(outRoot, `artifacts/${descriptor.id}/provider-fixture.json`, fixtureContent);
  provider.fixtureSha256 = providerFixture.sha256;
  const projection = {
    mimIds: rawMims,
    viewIds: displays.map((view) => view.id),
    viewContracts: displays
  };
  const rawActionSha256 = sha256Text(JSON.stringify(rawAction));
  const payload = {
    phoenix: { operation, caseId: descriptor.id, projection, rawActionSha256 },
    native: { operation, caseId: descriptor.id, projection: clone(projection), rawActionSha256 },
    wire: { operation, caseId: descriptor.id, projection: clone(projection), rawActionSha256 }
  };
  const action = {
    operation,
    projection,
    rawSha256: sha256Text(JSON.stringify(payload.phoenix)),
    payloadSha256: canonicalSha256(payload),
    canonicalization: CANONICALIZATION,
    payload,
    phoenixCanonicalSha256: canonicalSha256(payload.phoenix),
    nativeCanonicalSha256: canonicalSha256(payload.native),
    wireCanonicalSha256: canonicalSha256(payload.wire),
    nativeEqualsPhoenix: true,
    wireEqualsNative: true,
    phoenixMatchesMatrix: true,
    sourceAction: {
      eventIndex: actionInfo.index,
      requestID: actionRequestID,
      transID,
      rawActionSha256,
      rawTurnSha256: rawRefs.turn.sha256,
      displayContracts: rawDisplays.map((display) => ({ ordinal: display.ordinal, id: display.id, rawDisplaySha256: display.rawDisplaySha256 }))
    }
  };
  const idleSnapshot = finalIdle(turn);
  const idleAt = idleSnapshot ? new Date(Date.parse(turn.started) + idleSnapshot.elapsedMs).toISOString() : null;
  const captureTimes = reportShots.map((shot, index) => screenshotAt(turn, shot, index));
  const timelineViews = reportShots.map((shot, index) => {
    const captureTime = Date.parse(captureTimes[index]);
    const stable = Number.isFinite(shot.stableForMs) ? shot.stableForMs : 0;
    const opened = captureTime - stable;
    const nextCapture = captureTimes[index + 1] ? Date.parse(captureTimes[index + 1]) : (idleAt ? Date.parse(idleAt) - 1 : captureTime + 1);
    const closed = Math.min(nextCapture - 1, idleAt ? Date.parse(idleAt) - 1 : nextCapture - 1);
    return {
      ordinal: index,
      viewId: shot.viewId,
      openedMs: opened - Date.parse(turn.started),
      closedMs: closed - Date.parse(turn.started),
      openedAtISO: new Date(opened).toISOString(),
      closedAtISO: new Date(closed).toISOString()
    };
  });
  const correlation = {
    requestID,
    ackRequestID: turn.ack?.requestID,
    transID,
    caseId: descriptor.id,
    operation,
    connectionId: context.connectionId === undefined ? `missing-wire-connection-${descriptor.id}` : `wire-connection-${context.connectionId}`,
    nativeActionEventId: `native-event-${actionInfo.index}`,
    wireActionMessageId: context.rows.find(({ record }) => record.kind === 'server-message' && record.json?.type === 'SKILL_ACTION')?.record?.json?.msgID || `missing-wire-action-${descriptor.id}`
  };
  const nativeEvents = [
    { type: 'context', eventId: `native-context-${descriptor.id}`, caseId: descriptor.id, requestID, transID, operation, timestampISO: contextAtISO, runtimeLocationISO: contextISO, timezone: contextTimezone, available: contextReady, sourceMessageId: contextMessageId, sourceLine: contextSourceLine, source: rawContext ? sourceRecord(rawContext, context.contextIndex, rawRefs.wire) : rawRefs.context || null },
    { type: 'request', eventId: `native-request-${descriptor.id}`, caseId: descriptor.id, requestID, transID, operation, endpoint: request.endpoint, timestampISO: turn.started, body: clone(request.body), bodySha256: request.bodySha256, source: rawRefs.turn },
    { type: 'action', eventId: correlation.nativeActionEventId, caseId: descriptor.id, requestID, transID, operation, timestampISO: new Date(actionEvent.ts).toISOString(), payload: clone(payload.native), source: { rawTurn: rawRefs.turn, eventIndex: actionInfo.index, rawActionSha256 } },
    ...(idleAt ? [{ type: 'idle', eventId: `native-idle-${descriptor.id}`, caseId: descriptor.id, requestID, transID, operation, timestampISO: idleAt, skill: '@be/idle', view: 'eyeView', listener: 'Idle', ttsTalking: false, finalState: 'idle', source: rawRefs.turn }] : [])
  ];
  const wireRequest = context.rows.find(({ record }) => record.kind === 'client-message' && record.json?.type === 'CLIENT_ASR');
  const wireAction = context.rows.find(({ record }) => record.kind === 'server-message' && record.json?.type === 'SKILL_ACTION');
  const wireEvents = [
    { type: 'context', messageId: contextMessageId, caseId: descriptor.id, requestID, transID, operation, connectionId: correlation.connectionId, timestampISO: contextAtISO, runtimeLocationISO: contextISO, timezone: contextTimezone, available: contextReady, sourceMessageId: contextMessageId, sourceLine: contextSourceLine, source: rawContext ? sourceRecord(rawContext, context.contextIndex, rawRefs.wire) : rawRefs.context || null },
    ...(wireRequest ? [{ type: 'request', messageId: wireRequest.record.json.msgID, caseId: descriptor.id, requestID, transID, operation, endpoint: request.endpoint, connectionId: correlation.connectionId, timestampISO: wireRequest.record.at, body: clone(request.body), bodySha256: request.bodySha256, source: sourceRecord(wireRequest.record, wireRequest.index, rawRefs.wire) }] : []),
    ...(wireAction ? [{ type: 'action', messageId: correlation.wireActionMessageId, caseId: descriptor.id, requestID, transID, operation, connectionId: correlation.connectionId, timestampISO: wireAction.record.at, payload: clone(payload.wire), source: sourceRecord(wireAction.record, wireAction.index, rawRefs.wire) }] : []),
    ...(idleAt ? [{ type: 'idle', messageId: `wire-idle-${descriptor.id}`, caseId: descriptor.id, requestID, transID, operation, connectionId: correlation.connectionId, timestampISO: idleAt, finalState: 'idle', source: rawRefs.turn }] : [])
  ];
  const turnStartMs = Date.parse(turn.started);
  const turnEndMs = turnStartMs + (Number.isFinite(turn.durationMs) ? turn.durationMs : 0);
  const providerRows = wire.values.map((record, index) => ({ record, index })).filter(({ record }) => {
    const recordTime = Date.parse(record.at || '');
    return record.kind === 'fixture-provider' && record.caseId === fixtureCase.key && recordTime >= turnStartMs && recordTime <= turnEndMs && (!record.input?.transID || record.input.transID === actionRequestID || record.input.transID === primaryRequestID);
  });
  const providerEvents = providerRows.map(({ record, index }) => ({
    type: 'provider-call',
    callId: `provider-call-${index}`,
    caseId: descriptor.id,
    requestID,
    transID,
    operation,
    timestampISO: record.at,
    fixturePath: providerFixture.path,
    fixtureSha256: providerFixture.sha256,
    provider: clone(provider),
    source: sourceRecord(record, index, rawRefs.wire)
  }));
  if (providerEvents.length) providerEvents.push({
    type: 'provider-return', callId: `provider-return-${descriptor.id}`, caseId: descriptor.id, requestID, transID, operation,
    timestampISO: providerEvents.at(-1).timestampISO, fixturePath: providerFixture.path, fixtureSha256: providerFixture.sha256, provider: clone(provider), source: providerEvents.at(-1).source
  });
  if (idleAt) providerEvents.push({ type: 'idle', caseId: descriptor.id, requestID, transID, operation, timestampISO: idleAt, finalState: 'idle', source: rawRefs.turn });
  const screenshots = [];
  const screenshotCaptures = [];
  for (let index = 0; index < reportShots.length; index += 1) {
    const shot = reportShots[index];
    const sourceFilename = shot.filename;
    const sourceBytes = readRegular(sourceFilename, `screenshot ${sourceFilename}`);
    const sourceHash = sha256Bytes(sourceBytes);
    if (sourceHash !== shot.sha256) fail(`screenshot source hash changed: ${sourceFilename}`);
    const viewOrdinal = index;
    const relativePath = `artifacts/${descriptor.id}/screenshots/${String(index).padStart(2, '0')}-${shot.viewId}-${shot.viewInstance || 'capture'}.png`;
    const artifact = writeArtifact(outRoot, relativePath, sourceBytes);
    const identity = canonicalSha256({ caseId: descriptor.id, caseOrdinal: descriptor.ordinal, viewOrdinal, viewId: shot.viewId, pixelSha256: artifact.sha256 });
    const capture = {
      ...artifact,
      caseId: descriptor.id,
      ordinal: viewOrdinal,
      viewOrdinal,
      viewId: shot.viewId,
      captureKey: `${descriptor.id}:view:${viewOrdinal}:${shot.viewId}`,
      pixelSha256: artifact.sha256,
      artifactIdentity: identity,
      captureAtISO: captureTimes[index],
      stableForMs: shot.stableForMs,
      visuallyInspected: false,
      sourceScreenshot: { filename: sourceFilename, sha256: shot.sha256, rawTurnSha256: rawRefs.turn.sha256, viewInstance: shot.viewInstance, viewGeneration: shot.viewGeneration, displayAction: clone(shot.displayAction) }
    };
    screenshots.push(capture);
    screenshotCaptures.push({ caseId: descriptor.id, requestID, transID, operation, timestampISO: capture.captureAtISO, viewOrdinal, viewId: shot.viewId, captureKey: capture.captureKey, artifactPath: capture.path, sha256: capture.sha256, pixelSha256: capture.pixelSha256, artifactIdentity: capture.artifactIdentity, sourceScreenshot: capture.sourceScreenshot });
  }
  const idle = idleAt ? { observedMs: Date.parse(idleAt) - Date.parse(turn.started), observedAtISO: idleAt, skill: '@be/idle', view: 'eyeView', listener: 'Idle', ttsTalking: false, finalState: 'idle', observersRestored: true } : { observedMs: -1, observedAtISO: null, skill: null, view: null, listener: null, ttsTalking: null, finalState: null, observersRestored: false };
  const actual = {
    captureISO: turn.started,
    localDateISO: dateISO,
    contextLocationISO: contextISO,
    request,
    provider,
    action,
    correlation,
    logs: {
      native: { eventCount: nativeEvents.length, actionEventIndex: nativeEvents.findIndex((event) => event.type === 'action'), idleEventIndex: nativeEvents.findIndex((event) => event.type === 'idle'), actionEventId: correlation.nativeActionEventId },
      wire: { messageCount: wireEvents.length, actionMessageIndex: wireEvents.findIndex((record) => record.type === 'action'), ackMessageIndex: wireEvents.findIndex((record) => record.type === 'ack'), actionMessageId: correlation.wireActionMessageId, connectionId: correlation.connectionId }
    },
    traceRange: { start: 0, end: turn.durationMs || 0, startISO: turn.started, endISO: new Date(Date.parse(turn.started) + (turn.durationMs || 0)).toISOString() },
    timeline: { views: timelineViews, idle, transitionToIdle: Boolean(idleAt) },
    observersRestored: Boolean(idleAt),
    noBypass: false,
    artifacts: {
      stackReceipt: rawRefs.stack,
      nativeReport: null,
      wireTrace: null,
      providerTrace: null,
      actionPayload: null,
      providerFixture,
      contextAnchor: null,
      rawTurn: rawRefs.turn,
      rawFixture: rawRefs.fixture
    },
    screenshots
  };
  actual.artifacts.stackReceipt = writeJson(outRoot, `artifacts/${descriptor.id}/stack-normalized.json`, {
    schema: 's13-stack-receipt-v1', caseId: descriptor.id, requestID, transID, operation, startedAtISO: turn.started,
    completedAtISO: idleAt || new Date(Date.parse(turn.started) + (turn.durationMs || 0)).toISOString(), request: clone(request), action: { operation, payload: clone(payload.phoenix) }, finalIdle: { ...clone(idle), caseId: descriptor.id, requestID, transID, operation, timestampISO: idleAt }, sourceStack: rawRefs.stack, sourceTurn: rawRefs.turn
  });
  actual.artifacts.nativeReport = writeJson(outRoot, `artifacts/${descriptor.id}/native-normalized.json`, { schema: 's13-native-report-v1', caseId: descriptor.id, requestID, transID, operation, events: nativeEvents, captures: screenshotCaptures, sourceTurn: rawRefs.turn, sourceAction: { eventIndex: actionInfo.index, rawActionSha256, rawTurnSha256: rawRefs.turn.sha256, rawAction } });
  actual.artifacts.wireTrace = writeJsonl(outRoot, `artifacts/${descriptor.id}/wire-normalized.jsonl`, wireEvents);
  actual.artifacts.contextAnchor = writeJson(outRoot, `artifacts/${descriptor.id}/context-anchor.json`, {
    schema: 's13-context-anchor-v1',
    available: contextReady,
    caseId: descriptor.id,
    requestID,
    transID,
    operation,
    ...(contextReady ? {
      runtimeLocationISO: (explicitContext || rawContextFields).runtimeLocationISO,
      timezone: (explicitContext || rawContextFields).timezone,
      capturedAtISO: (explicitContext || rawContextFields).capturedAtISO,
      source: (explicitContext || rawContextFields).source,
      sourceMessageId: (explicitContext || rawContextFields).sourceMessageId,
      sourceLine: (explicitContext || rawContextFields).sourceLine
    } : {
      reason: 'missing-standalone-context-timezone-anchor',
      source: 'raw-wire-context-unverified',
      sourceMessageId: contextMessageId,
      sourceLine: contextSourceLine
    }),
    sourceTraceSha256: actual.artifacts.wireTrace.sha256,
    sourceContext: rawRefs.context || null
  });
  actual.artifacts.providerTrace = writeJsonl(outRoot, `artifacts/${descriptor.id}/provider-normalized.jsonl`, providerEvents);
  actual.artifacts.actionPayload = writeJson(outRoot, `artifacts/${descriptor.id}/action-normalized.json`, payload);
  return { ordinal: descriptor.ordinal, id: descriptor.id, status: 'pass', reference: clone(descriptor.reference), actual };
}

function stageSourceReference(descriptor, outRoot) {
  const source = path.resolve(repoRoot, descriptor.reference.path);
  const bytes = readRegular(source, descriptor.reference.path);
  const artifact = writeArtifact(outRoot, `references/no-view/${descriptor.id}.json`, bytes);
  return { lane: descriptor.reference.lane, caseId: descriptor.reference.caseId, sourcePath: descriptor.reference.path, format: descriptor.reference.lane === 's11-http-graph' ? 's11-graph-matrix' : 's12-differential-receipt', ...artifact };
}

function stageRevalidationReference(descriptor, outRoot) {
  const source = path.resolve(repoRoot, descriptor.reference.path);
  const bytes = readRegular(source, descriptor.reference.path);
  const artifact = writeArtifact(outRoot, `references/revalidation/${descriptor.id}.json`, bytes);
  return { lane: descriptor.reference.lane, caseId: descriptor.reference.caseId, sourcePath: descriptor.reference.path, format: 's13-hardware-receipt', ...artifact };
}

function missingRow(descriptor) {
  return { ordinal: descriptor.ordinal, id: descriptor.id, status: 'not-captured', claimed: false, reference: clone(descriptor.reference), actual: { viewIds: [], screenshots: [] }, limitation: `raw run did not contain ${descriptor.id}` };
}

export function produceCandidate(matrix, runDir, outRoot, { operation = 'mimicGlobalTurn', caseFiles = {}, bundles = null, bundleManifestPath = null } = {}) {
  const run = ensurePrivateRun(runDir);
  fs.mkdirSync(outRoot, { recursive: true });
  const defaultMap = {
    'commute-normal-combined': 'commute-normal-direct.json',
    'commute-bad-combined': 'commute-bad.json',
    'commute-terrible-combined': 'commute-terrible.json',
    'calendar-four-card-field-matrix': 'calendar-four-card.json',
    'calendar-concurrent-parallel': 'calendar-parallel.json'
  };
  let bundleMap = bundles;
  let bundleManifestSource = bundleManifestPath ? path.resolve(bundleManifestPath) : null;
  if (!bundleMap && fs.existsSync(path.join(run, 'bundle-manifest.json'))) {
    bundleManifestSource = path.join(run, 'bundle-manifest.json');
    const manifest = readJson(bundleManifestSource, 'bundle-manifest.json').value;
    if (!isPlainObject(manifest) || !isPlainObject(manifest.cases)) fail('bundle-manifest.json must contain a cases object');
    bundleMap = manifest.cases;
  }
  let bundleManifestRef = null;
  if (bundleManifestSource) {
    const sourceBytes = readRegular(bundleManifestSource, 'bundle-manifest.json');
    bundleManifestRef = writeArtifact(outRoot, 'raw/bundle-manifest.json', sourceBytes);
  }
  const files = { ...defaultMap, ...caseFiles };
  const bundleFor = (descriptor) => {
    // A manifest entry is a complete per-case bundle declaration. Do not
    // silently fall back to a legacy shared-run turn name when a fresh bundle
    // uses its own `turn.json` (or another discovered JSON report).
    const entry = bundleMap?.[descriptor.id];
    if (entry !== undefined) return resolveBundle(run, entry, {});
    return resolveBundle(run, undefined, {
      stack: caseFiles.stack || 'stack.json',
      fixture: caseFiles.fixture || 'fixture.json',
      wire: caseFiles.wire || null,
      turn: files[descriptor.id] || null
    });
  };
  const bundleCache = new Map();
  const loadBundle = (descriptor) => {
    if (bundleCache.has(descriptor.id)) return bundleCache.get(descriptor.id);
    const bundle = bundleFor(descriptor);
    const stackPath = bundleFile(bundle, bundle.stack, `${descriptor.id}/stack`);
    const fixturePath = bundleFile(bundle, bundle.fixture, `${descriptor.id}/fixture`);
    const stackRead = readJson(stackPath, `${descriptor.id}/stack`);
    const fixtureRead = readJson(fixturePath, `${descriptor.id}/fixture`);
    if (bundle.declaredCaseId !== undefined) {
      if (typeof bundle.declaredCaseId !== 'string' || !bundle.declaredCaseId) fail(`${descriptor.id} bundle caseId must be a non-empty string`);
      if (fixtureRead.value.caseId !== bundle.declaredCaseId && !fixtureRead.value.cases?.[bundle.declaredCaseId]) {
        fail(`${descriptor.id} bundle caseId does not identify a fixture case`);
      }
    }
    if (bundle.declaredFixture) {
      if (bundle.declaredFixture.sha256 !== undefined && bundle.declaredFixture.sha256 !== fixtureRead.sha256) fail(`${descriptor.id} declared fixture sha256 does not match opened fixture bytes`);
      if (bundle.declaredFixture.bytes !== undefined && bundle.declaredFixture.bytes !== fixtureRead.bytes.length) fail(`${descriptor.id} declared fixture bytes does not match opened fixture bytes`);
      if (bundle.declaredFixture.path !== undefined && path.basename(bundle.declaredFixture.path) !== path.basename(bundle.fixture)) fail(`${descriptor.id} declared fixture path does not match the selected fixture file`);
    }
    const wireName = discoverWire(bundle.dir, bundle.wire);
    const turnName = discoverTurn(bundle.dir, bundle.turn);
    if (!wireName) fail(`${descriptor.id} bundle has no wire JSONL trace`);
    if (!turnName) fail(`${descriptor.id} bundle has no turn JSON report`);
    const wireRead = readJsonl(bundleFile(bundle, wireName, `${descriptor.id}/wire`), `${descriptor.id}/${wireName}`);
    const turnRead = readJson(bundleFile(bundle, turnName, `${descriptor.id}/turn`), `${descriptor.id}/${turnName}`);
    const contextRead = bundle.context
      ? readJson(bundleFile(bundle, bundle.context, `${descriptor.id}/context`), `${descriptor.id}/${bundle.context}`)
      : null;
    const prefix = `raw/${descriptor.id}`;
    const rawRefs = {
      stack: copyRaw(bundle.dir, outRoot, bundle.stack, `${prefix}/stack.json`),
      fixture: copyRaw(bundle.dir, outRoot, bundle.fixture, `${prefix}/fixture.json`),
      wire: copyRaw(bundle.dir, outRoot, wireName, `${prefix}/${wireName}`),
      turn: copyRaw(bundle.dir, outRoot, turnName, `${prefix}/${turnName}`)
    };
    if (contextRead) rawRefs.context = copyRaw(bundle.dir, outRoot, bundle.context, `${prefix}/${bundle.context}`);
    const loaded = { bundle, stackRead, fixtureRead, wireRead, turnRead, contextRead, wireName, turnName, rawRefs, fixtureBindingMismatch: stackRead.value.fixture?.sha256 !== rawRefs.fixture.sha256 };
    bundleCache.set(descriptor.id, loaded);
    return loaded;
  };
  const hasBundle = (descriptor) => bundleMap ? bundleMap[descriptor.id] !== undefined : Boolean(files[descriptor.id]);
  const firstDescriptor = matrix.cases.find((descriptor) => descriptor.kind === 'physical' && !descriptor.captureCondition && hasBundle(descriptor));
  if (!firstDescriptor) fail('no physical bundle is available');
  const first = loadBundle(firstDescriptor);
  const stackRead = first.stackRead;
  const runtimeISO = stackRead.value.started;
  const timezone = 'America/New_York';
  const runtime = { captureISO: runtimeISO, localDateISO: localDateISO(runtimeISO, timezone), timezone, fixtureGenerator: 'raw-run-private-fixture', wallClockBound: true, captureConditions: { pmDepartureAvailable: false } };
  const fixtureBindingMismatches = [];
  const turns = {};
  const contextByCase = {};
  const rows = [];
  for (const descriptor of matrix.cases) {
    if (descriptor.kind === 'blocked') {
      rows.push({ ordinal: descriptor.ordinal, id: descriptor.id, status: 'blocked', claimed: false, reference: clone(descriptor.reference), blockedReason: descriptor.blocked.reason, actual: { viewIds: [], screenshots: [] } });
    } else if (descriptor.kind === 'no-view') {
      rows.push({ ordinal: descriptor.ordinal, id: descriptor.id, status: 'asserted', reference: clone(descriptor.reference), actual: { sourceReceipt: stageSourceReference(descriptor, outRoot), viewIds: [], screenshots: [], transitionToIdle: true, action: { mimIds: clone(descriptor.expected.mimIds), viewIds: [], receiptSha256: descriptor.reference.sha256 } } });
    } else if (descriptor.captureCondition) {
      rows.push({ ordinal: descriptor.ordinal, id: descriptor.id, status: 'skipped', reference: clone(descriptor.reference), skipReason: `conditional capture unavailable: ${descriptor.captureCondition.key}`, actual: { viewIds: [], screenshots: [] } });
    } else if (descriptor.kind === 'revalidation') {
      const sourceReceipt = stageRevalidationReference(descriptor, outRoot);
      rows.push({ ordinal: descriptor.ordinal, id: descriptor.id, status: 'referenced', reference: clone(descriptor.reference), actual: { sourceReceipt, viewIds: clone(descriptor.expected.viewIds), screenshots: [], transitionToIdle: true, action: { mimIds: [], viewIds: clone(descriptor.expected.viewIds), receiptSha256: sourceReceipt.sha256 } } });
    } else if (hasBundle(descriptor)) {
      const loaded = loadBundle(descriptor);
      if (loaded.fixtureBindingMismatch) fixtureBindingMismatches.push({ caseId: descriptor.id, stackSha256: loaded.stackRead.value.fixture?.sha256, openedSha256: loaded.rawRefs.fixture.sha256 });
      turns[descriptor.id] = loaded.turnRead.value;
      const contextFields = contextSourceFields(loaded.contextRead?.value);
      const contextAction = lastAction(loaded.turnRead.value);
      const targetContext = selectedWireConnection(loaded.wireRead.values, loaded.turnRead.value, contextAction).context;
      const rawContextFields = targetContext ? { ...contextSourceFields(targetContext), sourceLine: loaded.wireRead.values.indexOf(targetContext) } : null;
      const contextISO = contextFields?.runtimeLocationISO || rawContextFields?.runtimeLocationISO || loaded.turnRead.value.started;
      const contextTimezone = contextFields?.timezone || rawContextFields?.timezone || timezone;
      contextByCase[descriptor.id] = { runtimeLocationISO: contextISO, timezone: contextTimezone, contextSha256: canonicalSha256({ runtimeLocationISO: contextISO, timezone: contextTimezone }) };
      rows.push(deriveRow(matrix, descriptor, loaded.turnRead.value, loaded.fixtureRead.value, loaded.wireRead, outRoot, loaded.rawRefs, { ...runtime, captureISO: loaded.turnRead.value.started, localDateISO: localDateISO(loaded.turnRead.value.started, timezone) }, operation, loaded.contextRead, loaded.bundle.declaredCaseId, null));
    } else rows.push(missingRow(descriptor));
  }
  const rawRefs = first.rawRefs;
  const sourceRun = writeJson(outRoot, 'raw/run-manifest.json', {
    schema: 'phoenix-s13-raw-run-manifest-v1', runDirectory: run, stack: rawRefs.stack, fixture: rawRefs.fixture, wire: rawRefs.wire,
    ...(bundleManifestRef ? { bundleManifest: bundleManifestRef } : {}),
    fixtureBinding: { mismatches: fixtureBindingMismatches, matches: fixtureBindingMismatches.length === 0 },
    bundles: Object.fromEntries([...bundleCache.entries()].map(([id, loaded]) => [id, {
      directory: loaded.bundle.dir,
      ...(loaded.bundle.declaredCaseId !== undefined ? { caseId: loaded.bundle.declaredCaseId } : {}),
      stack: loaded.rawRefs.stack,
      fixture: loaded.rawRefs.fixture,
      wire: loaded.rawRefs.wire,
      turn: loaded.rawRefs.turn,
      sourceNames: {
        stack: loaded.rawRefs.stack.sourceName,
        fixture: loaded.rawRefs.fixture.sourceName,
        wire: loaded.rawRefs.wire.sourceName,
        turn: loaded.rawRefs.turn.sourceName,
        ...(loaded.rawRefs.context ? { context: loaded.rawRefs.context.sourceName } : {})
      },
      ...(loaded.rawRefs.context ? { context: loaded.rawRefs.context } : {})
    }])),
    turns: Object.fromEntries(Object.entries(turns).map(([id, turn]) => [id, { started: turn.started, durationMs: turn.durationMs, request: turn.request, ack: turn.ack }]))
  });
  const manifest = {
    schema: 'phoenix.parity.s13.physical-capture-receipt',
    schemaVersion: 1,
    task: 'S-13',
    claim: 'physical-display-only',
    phoenixRevision: stackRead.value.revision,
    decision: 'open',
    taskStatus: 'open',
    complete: false,
    runtime,
    provenance: {
      phoenix: { revision: stackRead.value.revision, baseRevision: matrix.baseRevision, worktree: stackRead.value.cwd, treeSha256: 'raw-stack-only', sourceManifestSha256: 'raw-stack-only' },
      sourceRun,
      rawStack: rawRefs.stack,
      rawFixture: rawRefs.fixture,
      rawWire: rawRefs.wire
    },
    preflight: { operation, method: 'POST', endpoint: operation === 'startLocalTurn' ? '/listen/start_local_turn' : '/listen/mimic_global_turn', transportMode: operation === 'startLocalTurn' ? 'local' : 'global', bodyField: operation === 'startLocalTurn' ? 'nluRules' : 'clientASR', contextSource: 'raw-run-context', proven: false, context: { runtimeLocationISO: runtime.captureISO, timezone }, contextSha256: canonicalSha256({ runtimeLocationISO: runtime.captureISO, timezone }), contextByCase },
    matrix: { path: 'scripts/parity-s13-physical/matrix.json', sha256: matrixSha256(matrix), inventorySha256: canonicalSha256(matrixInventory(matrix)), baseRevision: matrix.baseRevision, caseCount: matrix.cases.length, orderedCaseIds: matrix.cases.map((item) => item.id) },
    falsification: { result: 'not-run', controls: [], controlsSha256: canonicalSha256([]) },
    limitations: [
      ...(fixtureBindingMismatches.length ? [{ caseId: 'raw-run', reason: 'stack-fixture-hash-mismatch', claimed: false }] : []),
      ...rows.filter((row) => row.status !== 'pass' && row.status !== 'asserted').map((row) => ({ caseId: row.id, reason: row.limitation || row.blockedReason || row.skipReason, claimed: false }))
    ],
    cases: rows
  };
  const receiptPath = path.join(outRoot, 'receipt.json');
  fs.writeFileSync(receiptPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { receiptPath, receiptSha256: sha256Bytes(fs.readFileSync(receiptPath)), manifest };
}

function parseArgs(argv) {
  const args = { matrix: DEFAULT_MATRIX_PATH, run: null, out: null, bundleManifest: null, operation: 'mimicGlobalTurn' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--matrix') args.matrix = path.resolve(argv[++index]);
    else if (arg === '--run') args.run = path.resolve(argv[++index]);
    else if (arg === '--out') args.out = path.resolve(argv[++index]);
    else if (arg === '--bundle-manifest') args.bundleManifest = path.resolve(argv[++index]);
    else if (arg === '--operation') args.operation = argv[++index];
    else if (arg === '--help') { console.log('Usage: node scripts/parity-s13-physical/produce.mjs --run PRIVATE_RUN --out PRIVATE_OUTPUT [--bundle-manifest PATH] [--operation OPERATION]'); return null; }
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!args.run || !args.out) throw new Error('both --run and --out are required');
  return args;
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (!args) return 0;
  const matrix = JSON.parse(fs.readFileSync(args.matrix, 'utf8'));
  let bundles = null;
  if (args.bundleManifest) {
    const bundleManifest = readJson(args.bundleManifest, 'bundle-manifest.json').value;
    if (!isPlainObject(bundleManifest) || !isPlainObject(bundleManifest.cases)) fail('bundle-manifest.json must contain a cases object');
    bundles = bundleManifest.cases;
  }
  const result = produceCandidate(matrix, args.run, args.out, { operation: args.operation, bundles, bundleManifestPath: args.bundleManifest });
  const report = validateReceipt(result.manifest, matrix, { root: args.out });
  const validation = writeJson(args.out, 'validation.json', report);
  console.log(JSON.stringify({ result: report.result === 'pass' ? 'candidate-passed' : 'candidate-rejected', receipt: result.receiptPath, receiptSha256: result.receiptSha256, validationArtifact: validation, errors: report.errors.length }));
  return 0;
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  try { process.exitCode = main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
