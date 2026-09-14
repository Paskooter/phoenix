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

function isWithin(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function confinedPath(root, candidate, label) {
  const absolute = path.resolve(candidate);
  if (!isWithin(root, absolute)) fail(`${label} escapes run root`);
  return absolute;
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
  const bundleDir = configuredDir ? confinedPath(runDir, configuredDir.startsWith('/') ? configuredDir : path.join(runDir, configuredDir), 'bundle directory') : runDir;
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
  const candidates = fs.readdirSync(dir).filter((name) => /^wire-.*\.jsonl$/.test(name)).sort();
  if (candidates.length > 1) fail(`bundle has multiple wire JSONL traces; explicit wire selection is required (${candidates.join(', ')})`);
  return candidates[0] || null;
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
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  if (lines.some((line) => line.length === 0)) fail(`${label} contains an empty JSONL line`);
  return {
    values: lines.map((line, index) => {
      try { return JSON.parse(line); } catch (error) { fail(`${label} line ${index} is not JSON: ${error.message}`); }
    }),
    lineSha256: lines.map((line) => sha256Text(line)),
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

function rawDisplayContract(display, displayAction, ordinal) {
  const data = display?.view?.context?.data;
  const components = Array.isArray(data?.componentConfigs) ? data.componentConfigs : [];
  const assets = components.flatMap((component) => Array.isArray(component.assets) ? component.assets : []);
  const viewConfig = data?.viewConfig || {};
  return {
    ordinal,
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
}

function rawDisplayContracts(turn, expectedIds, targetTransID = null, targetEventIndex = null) {
  const rows = (turn.displayActions || [])
    .filter((item) => expectedIds.includes(item?.viewId)
      && (!targetTransID || item?.transID === targetTransID)
      && (targetEventIndex === null || item?.eventIndex === targetEventIndex))
    .sort((a, b) => (a.displayOrdinal ?? 0) - (b.displayOrdinal ?? 0));
  return rows.map((displayAction, index) => rawDisplayContract(rawDisplay(turn, displayAction), displayAction, index));
}

function wireDisplayContracts(rawAction, expectedIds) {
  const found = [];
  const walk = (value) => {
    if (Array.isArray(value)) {
      value.forEach(walk);
    } else if (value && typeof value === 'object') {
      const display = value.config?.display;
      const viewId = display?.view?.context?.data?.viewConfig?.id;
      if (display && expectedIds.includes(viewId)) found.push({ display, viewId });
      Object.values(value).forEach(walk);
    }
  };
  walk(rawAction);
  return found.map(({ display, viewId }, index) => rawDisplayContract(display, { viewId }, index));
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
    ...(descriptor.domain === 'commute' && Number.isFinite(baseSeconds) ? { baseSeconds } : {}),
    ...(descriptor.domain === 'commute' && Number.isFinite(trafficSeconds) ? { trafficSeconds } : {}),
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

function sourceRecord(record, index, wireRead) {
  return {
    line: index,
    kind: record?.kind,
    id: record?.id,
    messageId: record?.json?.msgID,
    messageType: record?.json?.type || record?.type,
    sha256: wireRead?.lineSha256?.[index] || sha256Text(canonicalJson(record)),
    canonicalSha256: sha256Text(canonicalJson(record)),
    traceSha256: wireRead.sha256
  };
}

function wireActionRecords(rows, connectionId) {
  return rows
    .filter(({ record }) => record?.kind === 'server-message' && record?.id === connectionId && record?.json?.type === 'SKILL_ACTION');
}

function wireActionRecord(rows, connectionId) {
  return wireActionRecords(rows, connectionId).at(-1) || null;
}

function twoStageIdentity(turn, wireRows) {
  const rows = eventRows(turn);
  const starts = rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => row.event.type === 'TURN_STARTED' && (row.event.transID || row.event.requestID));
  if (starts.length < 2) {
    const start = starts[0];
    const action = rows.map((row, index) => ({ row, index })).find(({ row }) => row.event.type === 'SKILL_ACTION' && row.event.data?.action);
    const transactionID = start?.row.event.transID || start?.row.event.requestID || action?.row.event.transID || action?.row.event.requestID;
    const connectionID = wireRows.find((record) => record?.kind === 'client-message' && record?.json?.transID === transactionID)?.id;
    const stageRows = wireRows.map((record, index) => ({ record, index })).filter(({ record }) => record.id === connectionID);
    const context = stageRows.find(({ record }) => record.kind === 'client-message' && record.json?.type === 'CONTEXT' && record.json?.transID === transactionID);
    const wireAction = wireActionRecord(stageRows, connectionID);
    if (!start || !action || !transactionID || connectionID === undefined || !context || !wireAction) fail('turn does not contain the initial and followup TURN_STARTED records');
    const sessionId = action.row.event.data?.skill?.session?.id || null;
    return {
      legacy: true,
      initial: { requestID: transactionID, transID: transactionID, turnStartedEventIndex: start.index, actionEventIndex: action.index, connectionId: connectionID, contextLine: context.index, contextMessageId: context.record.json?.msgID, wireActionLine: wireAction.index, wireActionMessageId: wireAction.record.json?.msgID, sdkAckRequestID: turn.ack?.requestID || null, sdkAckSource: 'turn.json.ack.requestID', prelude: { kind: 'SKILL_ACTION', idsInRawWire: false, line: wireAction.index, messageId: wireAction.record.json?.msgID } },
      followup: { requestID: transactionID, transID: transactionID, turnStartedEventIndex: start.index, actionEventIndex: action.index, connectionId: connectionID, contextLine: context.index, contextMessageId: context.record.json?.msgID, wireActionLine: wireAction.index, wireActionMessageId: wireAction.record.json?.msgID, handle: null, handleSource: null },
      sharedSkillSessionId: sessionId,
      wireAckCount: 0,
      postTurnConnections: []
    };
  }
  if (starts.length !== 2) fail(`turn contains ${starts.length} candidate TURN_STARTED records; exactly the initial and followup records are required`);
  const initialStart = starts[0];
  const followupStart = starts[1];
  const initialID = initialStart.row.event.transID || initialStart.row.event.requestID;
  const followupID = followupStart.row.event.transID || followupStart.row.event.requestID;
  if (!initialID || !followupID || initialID === followupID) fail('initial and followup transaction IDs are not distinct');
  const followupCalls = Array.isArray(turn.followup?.calls) ? turn.followup.calls : [];
  const followupCall = followupCalls.length === 1 ? followupCalls[0] : null;
  if (!followupCall || followupCall.requestID !== followupID || followupCall.text !== 'George' || followupCall.updateCompleted !== true) {
    fail('followup handle is not an exact George SDK update record');
  }
  const actions = rows
    .map((row, index) => ({ row, index, event: row.event }))
    .filter(({ event }) => event.type === 'SKILL_ACTION');
  if (actions.length !== 2 || actions.some(({ event }) => !event.data?.action)) fail('turn does not contain exactly the initial and followup SKILL_ACTION records');
  const initialActions = actions.filter(({ event }) => (event.transID || event.requestID) === initialID);
  const targetActions = actions.filter(({ event }) => (event.transID || event.requestID) === followupID);
  if (initialActions.length !== 1 || targetActions.length !== 1) fail('turn SKILL_ACTION records do not uniquely bind initial and followup transactions');
  const initialAction = initialActions[0];
  const targetAction = targetActions[0];
  const initialSessionId = initialAction.event.data?.skill?.session?.id;
  const targetSessionId = targetAction.event.data?.skill?.session?.id;
  if (!initialSessionId || initialSessionId !== targetSessionId) fail('initial and followup actions do not share one skill session');

  const excludedPrelude = (turn.excludedDisplayActions || [])
    .filter((item) => item?.eventIndex === initialAction.index && item?.viewId === 'whoIsThisMenu' && item?.captureStatus === 'excluded-prelude');

  const connectionIds = [...new Set(wireRows.filter((record) => record?.kind === 'connection').map((record) => record.id))];
  const connectionFor = (transactionID) => {
    const record = wireRows.find((candidate) => candidate?.kind === 'client-message' && candidate?.json?.transID === transactionID);
    return record?.id;
  };
  const initialConnectionId = connectionFor(initialID);
  const targetConnectionId = connectionFor(followupID);
  if (initialConnectionId === undefined || targetConnectionId === undefined || initialConnectionId === targetConnectionId) {
    fail('wire does not bind distinct initial and followup connections');
  }
  const candidateConnectionIds = connectionIds.filter((id) => wireRows.some((record) => record?.id === id && record?.kind === 'client-message' && [initialID, followupID].includes(record.json?.transID)));
  const initialConnectionOrdinal = candidateConnectionIds.indexOf(initialConnectionId);
  const targetConnectionOrdinal = candidateConnectionIds.indexOf(targetConnectionId);
  if (candidateConnectionIds.length !== 2 || initialConnectionOrdinal !== 0 || targetConnectionOrdinal !== 1) {
    fail(`wire connection order does not bind two-stage identity (initial=${initialConnectionId}, followup=${targetConnectionId})`);
  }
  const initialRows = wireRows.map((record, index) => ({ record, index })).filter(({ record }) => record.id === initialConnectionId);
  const targetRows = wireRows.map((record, index) => ({ record, index })).filter(({ record }) => record.id === targetConnectionId);
  const initialContexts = initialRows.filter(({ record }) => record.kind === 'client-message' && record.json?.type === 'CONTEXT' && record.json?.transID === initialID);
  const targetContexts = targetRows.filter(({ record }) => record.kind === 'client-message' && record.json?.type === 'CONTEXT' && record.json?.transID === followupID);
  if (initialContexts.length !== 1 || targetContexts.length !== 1) fail('wire does not contain exactly one initial and followup CONTEXT record');
  const initialContext = initialContexts[0];
  const targetContext = targetContexts[0];
  const initialWireActions = wireActionRecords(initialRows, initialConnectionId);
  const targetWireActions = wireActionRecords(targetRows, targetConnectionId);
  if (initialWireActions.length !== 1 || targetWireActions.length !== 1
    || initialWireActions.some(({ record }) => !record.json?.data?.action)
    || targetWireActions.some(({ record }) => !record.json?.data?.action)) {
    fail('wire does not contain exactly one initial and followup SKILL_ACTION record with action payloads');
  }
  const initialWireAction = initialWireActions[0];
  const targetWireAction = targetWireActions[0];
  if ([initialWireAction, targetWireAction].some(({ record }) => record.json?.requestID != null || record.json?.transID != null)) {
    fail('raw wire SKILL_ACTION records unexpectedly carry transaction/request IDs');
  }
  const initialCloseIndex = initialRows.filter(({ record }) => record.kind === 'close').at(-1)?.index;
  const targetCloseIndex = targetRows.filter(({ record }) => record.kind === 'close').at(-1)?.index;
  if (!Number.isInteger(initialCloseIndex) || !Number.isInteger(targetCloseIndex)) fail('wire does not contain close records for both identity stages');
  if (!(initialContext.index < initialWireAction.index && initialWireAction.index < initialCloseIndex && targetContext.index < targetWireAction.index && targetWireAction.index < targetCloseIndex && initialCloseIndex < targetContext.index)) {
    fail('wire stage records are not ordered as initial context/action/close followed by followup context/action/close');
  }
  const candidateStartIndex = Math.min(...initialRows.map(({ index }) => index));
  const postTurnConnections = connectionIds
    .filter((id) => id !== initialConnectionId && id !== targetConnectionId)
    .map((id) => ({ id, rows: wireRows.map((record, index) => ({ record, index })).filter(({ record }) => record.id === id) }))
    .map(({ id, rows: connectionRows }) => {
      const beforeTargetClose = connectionRows.filter(({ index }) => index >= candidateStartIndex && index <= targetCloseIndex);
      if (beforeTargetClose.length) fail(`wire contains shadow connection ${id} before followup close`);
      return {
        id,
        rows: connectionRows.map(({ record, index }) => ({ index, kind: record.kind, type: record.json?.type, messageId: record.json?.msgID }))
      };
    });
  const initialAckRequestID = turn.ack?.requestID;
  if (initialAckRequestID !== initialID) fail('SDK ACK does not bind the initial transaction');
  const wireAckRecords = wireRows.filter((record) => ['ack', 'ACK', 'TURN_ACK'].includes(record?.kind) || ['ack', 'ACK', 'TURN_ACK'].includes(record?.type) || ['ACK', 'TURN_ACK'].includes(record?.json?.type));
  if (wireAckRecords.length) fail('wire contains an ACK record; raw S13 wire must have no independent followup ACK');
  return {
    initial: {
      requestID: initialID,
      transID: initialID,
      turnStartedEventIndex: initialStart.index,
      actionEventIndex: initialAction.index,
      connectionId: initialConnectionId,
      contextLine: initialContext.index,
      contextMessageId: initialContext.record.json?.msgID,
      wireActionLine: initialWireAction.index,
      wireActionMessageId: initialWireAction.record.json?.msgID,
      sdkAckRequestID: initialAckRequestID,
      sdkAckSource: 'turn.json.ack.requestID',
      prelude: {
        kind: 'SKILL_ACTION',
        idsInRawWire: false,
        line: initialWireAction.index,
        messageId: initialWireAction.record.json?.msgID,
        rawActionSha256: sha256Text(JSON.stringify(initialAction.event.data.action)),
        turnActionEventIndex: initialAction.index,
        excludedDisplayActions: clone(excludedPrelude)
      }
    },
    followup: {
      requestID: followupID,
      transID: followupID,
      turnStartedEventIndex: followupStart.index,
      actionEventIndex: targetAction.index,
      connectionId: targetConnectionId,
      contextLine: targetContext.index,
      contextMessageId: targetContext.record.json?.msgID,
      wireActionLine: targetWireAction.index,
      wireActionMessageId: targetWireAction.record.json?.msgID,
      rawActionSha256: sha256Text(JSON.stringify(targetAction.event.data.action)),
      handle: clone(followupCall),
      handleSource: 'turn.json.followup.calls[0]'
    },
    sharedSkillSessionId: initialSessionId,
    wireAckCount: 0,
    postTurnConnections
  };
}

function visualReviewFromRun(runRoot, visualReviewPath = null) {
  const candidate = visualReviewPath || path.join(runRoot, 'visual-review-v2.json');
  if (!fs.existsSync(candidate)) return null;
  const source = confinedPath(runRoot, candidate, 'visual review');
  const read = readJson(source, 'visual-review-v2.json');
  const review = read.value;
  if (!isPlainObject(review) || review.schema !== 'phoenix-s13-visual-review-v2') fail('visual review must use phoenix-s13-visual-review-v2');
  if (typeof review.reviewer !== 'string' || !review.reviewer || typeof review.reviewedAt !== 'string' || Number.isNaN(Date.parse(review.reviewedAt)) || review.allPassed !== true) fail('visual review does not contain a completed all-passed external review');
  if (path.resolve(review.captureRoot || '') !== runRoot) fail('visual review captureRoot does not bind the private run root');
  if (!Array.isArray(review.reviews) || !Number.isInteger(review.targetCount) || review.targetCount !== review.reviews.length) fail('visual review targetCount does not bind review records');
  const records = [];
  const seen = new Set();
  review.reviews.forEach((record, index) => {
    if (!isPlainObject(record)) fail(`visual review record ${index} is not an object`);
    if (typeof record.case !== 'string' || !Number.isInteger(record.captureOrdinal) || typeof record.viewId !== 'string' || typeof record.path !== 'string') fail(`visual review record ${index} has incomplete identity`);
    if (!record.path || path.isAbsolute(record.path) || record.path.split('/').includes('..')) fail(`visual review record ${index} path must be run-relative`);
    const absolute = confinedPath(runRoot, path.join(runRoot, record.path), `visual review record ${index}`);
    const bytes = readRegular(absolute, `visual review screenshot ${record.path}`);
    const key = `${record.case}:${record.captureOrdinal}:${record.viewId}`;
    if (seen.has(key)) fail(`visual review repeats ${key}`);
    seen.add(key);
    if (sha256Bytes(bytes) !== record.sha256 || bytes.length !== record.bytes) fail(`visual review screenshot bytes do not match ${record.path}`);
    if (record.verdict !== 'pass') fail(`visual review record ${key} is not a pass`);
    records.push({ ...clone(record), sourcePath: record.path, sourceSha256: record.sha256, sourceBytes: record.bytes });
  });
  return { value: review, refSource: source, refRead: read, records, byKey: new Map(records.map((record) => [`${record.case}:${record.captureOrdinal}:${record.viewId}`, record])) };
}

function captureSnapshot(turn, shot) {
  const metadata = shot?.displayAction?.captureKey;
  const ordinal = shot?.displayAction?.captureOrdinal;
  const filename = shot?.filename;
  const snapshots = Array.isArray(turn.snapshots) ? turn.snapshots : [];
  const matches = snapshots.filter((snapshot) => {
    const capture = snapshot?.captureMetadata;
    if (!capture) return false;
    return (metadata && capture.captureKey === metadata)
      || (filename && capture.filename === filename)
      || (Number.isInteger(ordinal) && capture.ordinal === ordinal);
  });
  if (matches.length !== 1) fail(`screenshot ${filename || shot?.viewId} does not bind exactly one captureMetadata snapshot`);
  const snapshot = matches[0];
  const capture = snapshot.captureMetadata;
  if (!Number.isFinite(snapshot.elapsedMs) || capture.filename !== filename || capture.viewId !== shot.viewId || capture.sha256 !== shot.sha256) {
    fail(`screenshot ${filename || shot?.viewId} captureMetadata does not bind turn screenshot`);
  }
  return { snapshot, capture };
}

function screenshotAt(turn, shot, index) {
  const { snapshot, capture } = captureSnapshot(turn, shot);
  return {
    elapsedMs: snapshot.elapsedMs,
    stableForMs: capture.stableForMs ?? shot.stableForMs,
    ordinal: capture.ordinal,
    captureKey: capture.captureKey,
    viewInstance: capture.viewInstance,
    viewGeneration: capture.viewGeneration,
    captureAtISO: new Date(Date.parse(turn.started) + snapshot.elapsedMs).toISOString(),
    snapshotIndex: turn.snapshots.indexOf(snapshot)
  };
}

function finalIdle(turn) {
  const snapshots = Array.isArray(turn.snapshots) ? turn.snapshots : [];
  for (let index = snapshots.length - 1; index >= 0; index -= 1) {
    const be = snapshots[index]?.be;
    if (be?.skill === '@be/idle' && be.view === 'eyeView' && be.listen === 'Idle' && be.talking === false) return snapshots[index];
  }
  return null;
}

function privateFixtureWorkTime(descriptor, fixtureCase, fixtureSha256) {
  const value = fixtureCase?.value || {};
  const workTime = value.userPrefs?.commute?.workTime || value.meta?.workTime;
  const dateISO = value.meta?.date;
  if (descriptor.domain !== 'commute') return null;
  if (!Number.isInteger(workTime?.hour) || !Number.isInteger(workTime?.min) || typeof dateISO !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateISO)) {
    fail(`${descriptor.id} has no complete private fixture work-time/date fields`);
  }
  return {
    hour: workTime.hour,
    min: workTime.min,
    dateISO,
    source: 'fixture.userPrefs.commute.workTime',
    fixtureCase: fixtureCase.key,
    fixtureSha256
  };
}

function resolvedProjection(descriptor, request, provider) {
  const viewContracts = clone(descriptor.expected.viewContracts || []).map((contract) => {
    if (contract.type !== 'commute-departure' || !contract.labelsFrom) return contract;
    const date = new Date(Date.UTC(2000, 0, 1, request.prefs.workHour, request.prefs.workMin, 0) - provider.trafficSeconds * 1000);
    const hour = date.getUTCHours();
    const minute = date.getUTCMinutes();
    return {
      ...contract,
      labels: { time: `${hour % 12 || 12}:${String(minute).padStart(2, '0')}`, ampm: hour >= 12 ? 'PM' : 'AM' }
    };
  }).map((contract) => {
    const { labelsFrom: _labelsFrom, ...rest } = contract;
    return rest;
  });
  return {
    mimIds: clone(descriptor.expected.mimIds || []),
    viewIds: clone(descriptor.expected.viewIds || []),
    viewContracts
  };
}

function sameValue(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function deriveRow(matrix, descriptor, turn, fixture, wire, outRoot, rawRefs, runtime, operation, contextRead = null, declaredCaseId = undefined, visualReview = null, runRoot = runtime.runRoot) {
  const identity = twoStageIdentity(turn, wire.values);
  const actionInfo = { row: eventRows(turn)[identity.followup.actionEventIndex], index: identity.followup.actionEventIndex };
  const actionEvent = actionInfo.row.event;
  const rawAction = actionEvent.data.action;
  const rawMims = walkMims(rawAction);
  const expectedIds = descriptor.expected.viewIds;
  const rawDisplays = rawDisplayContracts(turn, expectedIds, identity.followup.transID, identity.followup.actionEventIndex);
  const displays = projectDisplayContracts(rawDisplays, descriptor.expected.viewContracts);
  const reportShots = (turn.screenshots || [])
    .filter((shot) => expectedIds.includes(shot?.viewId)
      && shot?.displayAction?.captureKey
      && shot.displayAction.captureStatus === 'captured'
      && shot.displayAction.transID === identity.followup.transID
      && shot.displayAction.requestID === identity.followup.requestID
      && shot.displayAction.eventIndex === identity.followup.actionEventIndex)
    .sort((a, b) => (a.displayAction.displayOrdinal ?? 0) - (b.displayAction.displayOrdinal ?? 0));
  const fixtureCase = rawFixtureCase(fixture, descriptor, declaredCaseId);
  if (!fixtureCase) fail(`${descriptor.id} is missing from the private fixture`);
  const dateISO = localDateISO(turn.started, runtime.timezone);
  const resolvedDateISO = descriptor.domain === 'calendar' ? addLocalDays(dateISO, 1, runtime.timezone) : dateISO;
  const provider = providerProjection(descriptor, fixtureCase, resolvedDateISO);
  const route = fixtureCase.value.maps?.routes?.[0]?.legs?.[0];
  const context = selectedWireConnection(wire.values, turn, actionInfo);
  if (context.connectionId !== identity.followup.connectionId) fail(`${descriptor.id} target context is not on the followup connection`);
  const targetWireAction = wireActionRecord(context.rows, identity.followup.connectionId);
  const rawWireAction = targetWireAction?.record?.json?.data?.action;
  const targetWireRequest = context.rows.find(({ record }) => record.kind === 'client-message' && record.json?.type === 'CLIENT_ASR');
  const followupBody = targetWireRequest?.record?.json?.data?.text
    ? { clientASR: targetWireRequest.record.json.data.text }
    : clone(turn.request?.body);
  const followupBodySha256 = canonicalSha256(followupBody);
  const wireDisplays = rawWireAction ? projectDisplayContracts(wireDisplayContracts(rawWireAction, expectedIds), descriptor.expected.viewContracts) : [];
  const explicitContext = contextSourceFields(contextRead?.value);
  const rawContext = context.context;
  const rawContextFields = rawContext ? {
    ...contextSourceFields(rawContext),
    source: 'wire-context',
    sourceLine: context.contextIndex
  } : null;
  const contextISO = rawContextFields?.runtimeLocationISO || explicitContext?.runtimeLocationISO || turn.started;
  const contextAtISO = rawContextFields?.capturedAtISO || explicitContext?.capturedAtISO || turn.started;
  const contextTimezone = rawContextFields?.timezone || explicitContext?.timezone || fixture.timeZone || runtime.timezone;
  const contextMessageId = rawContextFields?.sourceMessageId || explicitContext?.sourceMessageId || `missing-context-${descriptor.id}`;
  const contextSourceLine = Number.isInteger(rawContextFields?.sourceLine) ? rawContextFields.sourceLine : explicitContext?.sourceLine;
  // A raw CONTEXT line is a valid standalone anchor only when its location,
  // timezone (from the immutable fixture metadata), capture timestamp,
  // message ID, and source line are all present. An optional context JSON can
  // refine those fields, but cannot replace the source wire record.
  const contextReady = Boolean(rawContextFields?.runtimeLocationISO && rawContextFields?.timezone && rawContextFields?.capturedAtISO && rawContextFields?.sourceMessageId && Number.isInteger(rawContextFields?.sourceLine) && (!explicitContext || (explicitContext.runtimeLocationISO === rawContextFields.runtimeLocationISO && explicitContext.timezone === rawContextFields.timezone && explicitContext.capturedAtISO === rawContextFields.capturedAtISO && explicitContext.sourceMessageId === rawContextFields.sourceMessageId && explicitContext.sourceLine === rawContextFields.sourceLine)));
  const primaryRequestID = identity.initial.requestID;
  const actionRequestID = identity.followup.requestID;
  const requestID = actionRequestID;
  const transID = identity.followup.transID;
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
    runtimeLocalDateISO: runtime.localDateISO,
    identity: {
      stage: 'initial-global',
      requestID: identity.initial.requestID,
      transID: identity.initial.transID,
      connectionId: `wire-connection-${identity.initial.connectionId}`,
      source: rawRefs.turn,
      sdkAck: { requestID: identity.initial.sdkAckRequestID, source: identity.initial.sdkAckSource }
    },
    followup: {
      stage: 'followup-local',
      requestID: identity.followup.requestID,
      transID: identity.followup.transID,
      connectionId: `wire-connection-${identity.followup.connectionId}`,
      handle: clone(identity.followup.handle),
      body: clone(followupBody),
      bodySha256: followupBodySha256,
      source: rawRefs.turn
    }
  };
  if (descriptor.domain === 'commute') {
    const trafficSeconds = route?.duration_in_traffic?.value;
    const baseSeconds = route?.duration?.value;
    request.locationISO = contextISO;
    const workTime = privateFixtureWorkTime(descriptor, fixtureCase, rawRefs.fixture.sha256);
    request.locationMode = contextReady ? 'private-fixture-work-time' : 'private-fixture-work-time-unanchored-context';
    request.prefs = {
      mode: descriptor.input.prefsPolicy.mode,
      workHour: workTime.hour,
      workMin: workTime.min,
      workDateISO: workTime.dateISO,
      baseSeconds,
      trafficSeconds
    };
    request.prefsResolution = {
      schedule: 'private-fixture-work-time',
      generatedFrom: 'private-fixture-work-time',
      source: workTime.source,
      fixtureCase: workTime.fixtureCase,
      fixtureSha256: workTime.fixtureSha256,
      matrixPolicy: descriptor.input.prefsPolicy.schedule,
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
  if (!wireDisplays.length || wireDisplays.length !== displays.length) fail(`${descriptor.id} target wire SKILL_ACTION does not bind every display action`);
  const wireProjection = {
    mimIds: walkMims(rawWireAction),
    viewIds: wireDisplays.map((view) => view.id),
    viewContracts: wireDisplays
  };
  const rawActionSha256 = sha256Text(JSON.stringify(rawAction));
  const rawWireActionSha256 = sha256Text(JSON.stringify(rawWireAction));
  const initialActionEvent = eventRows(turn)[identity.initial.actionEventIndex].event;
  const initialRawAction = initialActionEvent.data.action;
  const initialWireRows = wire.values.map((record, index) => ({ record, index })).filter(({ record }) => record.id === identity.initial.connectionId);
  const initialWireRequest = initialWireRows.find(({ record }) => record.kind === 'client-message' && record.json?.type === 'LISTEN');
  const initialContext = initialWireRows.find(({ record }) => record.kind === 'client-message' && record.json?.type === 'CONTEXT' && record.json?.transID === identity.initial.transID);
  const initialWireAction = wireActionRecord(initialWireRows, identity.initial.connectionId);
  const wireFlow = {
    schema: 'phoenix.s13.two-stage-wire-flow.v1',
    sessionId: identity.sharedSkillSessionId,
    excludedPrelude: {
      count: identity.initial.prelude?.excludedDisplayActions?.length || 0,
      eventIndex: identity.initial.prelude?.excludedDisplayActions?.[0]?.eventIndex,
      viewId: identity.initial.prelude?.excludedDisplayActions?.[0]?.viewId,
      captureStatus: identity.initial.prelude?.excludedDisplayActions?.[0]?.captureStatus,
      exclusionReason: identity.initial.prelude?.excludedDisplayActions?.[0]?.exclusionReason
    },
    stages: [
      {
        stage: 'Tg',
        kind: 'global-prelude',
        requestID: identity.initial.requestID,
        transID: identity.initial.transID,
        connectionId: `wire-connection-${identity.initial.connectionId}`,
        operation,
        requestType: 'LISTEN',
        endpoint: request.endpoint,
        body: clone(request.body),
        bodySha256: canonicalSha256(request.body),
        contextMessageId: identity.initial.contextMessageId,
        actionMessageId: identity.initial.wireActionMessageId,
        actionPayloadSha256: sha256Text(JSON.stringify(initialRawAction)),
        rawWireActionSha256: sha256Text(JSON.stringify(initialWireAction?.record?.json?.data?.action)),
        ackRequestID: identity.initial.sdkAckRequestID
      },
      {
        stage: 'Tl',
        kind: 'local-followup',
        requestID: identity.followup.requestID,
        transID: identity.followup.transID,
        connectionId: `wire-connection-${identity.followup.connectionId}`,
        operation,
        requestType: 'CLIENT_ASR',
        endpoint: request.endpoint,
        body: clone(followupBody),
        bodySha256: followupBodySha256,
        contextMessageId: identity.followup.contextMessageId,
        actionMessageId: identity.followup.wireActionMessageId,
        actionPayloadSha256: rawWireActionSha256,
        rawWireActionSha256,
        handle: clone(identity.followup.handle)
      }
    ]
  };
  const payload = {
    phoenix: { operation, caseId: descriptor.id, projection, rawActionSha256 },
    native: { operation, caseId: descriptor.id, projection: clone(projection), rawActionSha256 },
    wire: { operation, caseId: descriptor.id, projection: wireProjection, rawActionSha256: rawWireActionSha256 }
  };
  const expectedProjection = resolvedProjection(descriptor, request, provider);
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
    nativeEqualsPhoenix: sameValue(payload.native, payload.phoenix),
    wireEqualsNative: sameValue(payload.wire, payload.native),
    phoenixMatchesMatrix: sameValue(projection, expectedProjection),
    sourceAction: {
      eventIndex: actionInfo.index,
      requestID: actionRequestID,
      transID,
      rawActionSha256,
      rawTurnSha256: rawRefs.turn.sha256,
      displayContracts: rawDisplays.map((display) => ({ ordinal: display.ordinal, id: display.id, rawDisplaySha256: display.rawDisplaySha256 })),
      targetDisplayActions: reportShots.map((shot) => clone(shot.displayAction)),
      initial: {
        actionEventIndex: identity.initial.actionEventIndex,
        requestID: identity.initial.requestID,
        transID: identity.initial.transID,
        rawActionSha256: sha256Text(JSON.stringify(eventRows(turn)[identity.initial.actionEventIndex].event.data.action)),
        rawWireActionMessageId: identity.initial.wireActionMessageId,
        rawWireActionLine: identity.initial.wireActionLine,
        excludedDisplayActions: clone(identity.initial.prelude?.excludedDisplayActions || [])
      },
      followup: {
        actionEventIndex: identity.followup.actionEventIndex,
        requestID: identity.followup.requestID,
        transID: identity.followup.transID,
        rawWireActionSha256,
        rawWireActionMessageId: identity.followup.wireActionMessageId,
        rawWireActionLine: identity.followup.wireActionLine
      },
      rawWireActionSha256,
      rawWireTraceSha256: rawRefs.wire.sha256,
      rawWireActionMessageId: identity.followup.wireActionMessageId,
      rawWireActionLine: identity.followup.wireActionLine,
      sharedSkillSessionId: identity.sharedSkillSessionId
    }
  };
  const idleSnapshot = finalIdle(turn);
  const idleAt = idleSnapshot ? new Date(Date.parse(turn.started) + idleSnapshot.elapsedMs).toISOString() : null;
  const captureInfos = reportShots.map((shot, index) => screenshotAt(turn, shot, index));
  const captureTimes = captureInfos.map((capture) => capture.captureAtISO);
  const snapshots = Array.isArray(turn.snapshots) ? turn.snapshots : [];
  const actionElapsedMs = Math.max(0, Number(actionInfo.row.event.ts) - Date.parse(turn.started));
  const timelineViews = reportShots.map((shot, index) => {
    const captureInfo = captureInfos[index];
    const captureTime = Date.parse(captureInfo.captureAtISO);
    const instance = captureInfo.viewInstance || shot.viewInstance;
    const opening = snapshots.find((snapshot) => Number.isFinite(snapshot.elapsedMs)
      && snapshot.elapsedMs >= actionElapsedMs
      && snapshot.elapsedMs <= captureInfo.elapsedMs
      && snapshot.be?.view === shot.viewId
      && (!instance || snapshot.be?.viewInstance === instance));
    const openedMs = opening?.elapsedMs ?? Math.max(actionElapsedMs, captureInfo.elapsedMs - (captureInfo.stableForMs || 0));
    const transition = snapshots.find((snapshot) => Number.isFinite(snapshot.elapsedMs)
      && snapshot.elapsedMs > captureInfo.elapsedMs
      && (snapshot.be?.view !== shot.viewId || (instance && snapshot.be?.viewInstance !== instance)));
    const idleMs = idleSnapshot?.elapsedMs;
    const closedMs = Math.min(
      transition?.elapsedMs !== undefined ? transition.elapsedMs - 1 : Number.POSITIVE_INFINITY,
      idleMs !== undefined ? idleMs - 1 : captureInfo.elapsedMs
    );
    const closed = Date.parse(turn.started) + closedMs;
    return {
      ordinal: index,
      viewId: shot.viewId,
      openedMs,
      closedMs,
      openedAtISO: new Date(Date.parse(turn.started) + openedMs).toISOString(),
      closedAtISO: new Date(closed).toISOString()
    };
  });
  const timelineBound = Boolean(idleAt)
    && timelineViews.length === reportShots.length
    && timelineViews.every((view, index) => {
      const captureAt = Date.parse(captureInfos[index].captureAtISO);
      const openedAt = Date.parse(view.openedAtISO);
      const closedAt = Date.parse(view.closedAtISO);
      return Number.isFinite(view.openedMs)
        && Number.isFinite(view.closedMs)
        && view.openedMs < view.closedMs
        && Number.isFinite(captureAt)
        && Number.isFinite(openedAt)
        && Number.isFinite(closedAt)
        && openedAt <= captureAt
        && captureAt <= closedAt;
    });
  const correlation = {
    requestID,
    ackRequestID: identity.initial.sdkAckRequestID,
    transID,
    caseId: descriptor.id,
    operation,
    connectionId: context.connectionId === undefined ? `missing-wire-connection-${descriptor.id}` : `wire-connection-${context.connectionId}`,
    nativeActionEventId: `native-event-${actionInfo.index}`,
    wireActionMessageId: targetWireAction?.record?.json?.msgID || `missing-wire-action-${descriptor.id}`,
    stages: {
      initial: {
        requestID: identity.initial.requestID,
        transID: identity.initial.transID,
        connectionId: `wire-connection-${identity.initial.connectionId}`,
        sdkAck: { requestID: identity.initial.sdkAckRequestID, source: identity.initial.sdkAckSource },
        prelude: {
          type: 'SKILL_ACTION',
          sourceLine: identity.initial.wireActionLine,
          sourceMessageId: identity.initial.wireActionMessageId,
          rawWireHasRequestID: false,
          rawWireHasTransID: false,
          excludedDisplayActions: clone(identity.initial.prelude?.excludedDisplayActions || [])
        }
      },
      followup: {
        requestID: identity.followup.requestID,
        transID: identity.followup.transID,
        connectionId: `wire-connection-${identity.followup.connectionId}`,
        handle: clone(identity.followup.handle),
        context: { sourceLine: identity.followup.contextLine, sourceMessageId: identity.followup.contextMessageId },
        action: { sourceLine: identity.followup.wireActionLine, sourceMessageId: identity.followup.wireActionMessageId, rawWireHasRequestID: false, rawWireHasTransID: false },
        targetDisplayActions: reportShots.map((shot) => clone(shot.displayAction)),
        providerConnectionBound: true
      }
    },
    sharedSkillSessionId: identity.sharedSkillSessionId,
    wireAck: { present: false, independent: false, source: 'raw-wire-jsonl-has-no-ACK-record' },
    postTurnConnections: clone(identity.postTurnConnections)
  };
  const followupStartedAtISO = new Date(eventRows(turn)[identity.followup.turnStartedEventIndex].event.ts).toISOString();
  const wireRequest = targetWireRequest;
  const wireAction = targetWireAction;
  const nativeEvents = [
    { type: 'request', stage: 'Tg', sessionId: identity.sharedSkillSessionId, eventId: `native-global-request-${descriptor.id}`, caseId: descriptor.id, requestID: identity.initial.requestID, transID: identity.initial.transID, operation, endpoint: request.endpoint, timestampISO: turn.started, body: clone(request.body), bodySha256: request.bodySha256, source: rawRefs.turn },
    { type: 'action', stage: 'Tg', sessionId: identity.sharedSkillSessionId, eventId: `native-prelude-${descriptor.id}`, caseId: descriptor.id, requestID: identity.initial.requestID, transID: identity.initial.transID, operation, timestampISO: new Date(initialActionEvent.ts).toISOString(), payload: { operation, caseId: descriptor.id, stage: 'Tg', rawActionSha256: sha256Text(JSON.stringify(initialRawAction)) }, source: { rawTurn: rawRefs.turn, eventIndex: identity.initial.actionEventIndex, rawActionSha256: sha256Text(JSON.stringify(initialRawAction)), rawRequestID: initialActionEvent.requestID ?? null, rawTransID: initialActionEvent.transID ?? null } },
    { type: 'context', stage: 'Tl', sessionId: identity.sharedSkillSessionId, eventId: `native-context-${descriptor.id}`, caseId: descriptor.id, requestID, transID, operation, timestampISO: contextAtISO, runtimeLocationISO: contextISO, timezone: contextTimezone, available: contextReady, sourceMessageId: contextMessageId, sourceLine: contextSourceLine, source: rawContext ? sourceRecord(rawContext, context.contextIndex, wire) : rawRefs.context || null },
    { type: 'request', stage: 'Tl', sessionId: identity.sharedSkillSessionId, eventId: `native-request-${descriptor.id}`, caseId: descriptor.id, requestID, transID, operation, endpoint: request.endpoint, timestampISO: wireRequest?.record?.at || followupStartedAtISO, body: clone(followupBody), bodySha256: followupBodySha256, source: wireRequest ? sourceRecord(wireRequest.record, wireRequest.index, wire) : rawRefs.turn, handle: clone(identity.followup.handle) },
    { type: 'action', stage: 'Tl', sessionId: identity.sharedSkillSessionId, eventId: correlation.nativeActionEventId, caseId: descriptor.id, requestID, transID, operation, timestampISO: new Date(actionEvent.ts).toISOString(), payload: clone(payload.native), sharedSkillSessionId: identity.sharedSkillSessionId, source: { rawTurn: rawRefs.turn, eventIndex: actionInfo.index, rawActionSha256, rawRequestID: actionEvent.requestID ?? null, rawTransID: actionEvent.transID ?? null } },
    ...(idleAt ? [{ type: 'idle', stage: 'Tl', sessionId: identity.sharedSkillSessionId, eventId: `native-idle-${descriptor.id}`, caseId: descriptor.id, requestID, transID, operation, timestampISO: idleAt, skill: '@be/idle', view: 'eyeView', listener: 'Idle', ttsTalking: false, finalState: 'idle', source: rawRefs.turn }] : [])
  ];
  const wireEvents = [
    ...(initialWireRequest ? [{ type: 'request', stage: 'Tg', sessionId: identity.sharedSkillSessionId, messageId: initialWireRequest.record.json.msgID, caseId: descriptor.id, requestID: identity.initial.requestID, transID: identity.initial.transID, operation, connectionId: wireFlow.stages[0].connectionId, timestampISO: initialWireRequest.record.at, endpoint: request.endpoint, body: clone(request.body), bodySha256: request.bodySha256, source: sourceRecord(initialWireRequest.record, initialWireRequest.index, wire) }] : []),
    ...(initialContext ? [{ type: 'context', stage: 'Tg', sessionId: identity.sharedSkillSessionId, messageId: initialContext.record.json.msgID, caseId: descriptor.id, requestID: identity.initial.requestID, transID: identity.initial.transID, operation, connectionId: wireFlow.stages[0].connectionId, timestampISO: initialContext.record.at, runtimeLocationISO: initialContext.record.json?.data?.runtime?.location?.iso, timezone: initialContext.record.json?.data?.runtime?.timezone || contextTimezone, source: sourceRecord(initialContext.record, initialContext.index, wire) }] : []),
    ...(initialWireAction ? [{ type: 'action', stage: 'Tg', sessionId: identity.sharedSkillSessionId, messageId: initialWireAction.record.json.msgID, caseId: descriptor.id, requestID: identity.initial.requestID, transID: identity.initial.transID, operation, connectionId: wireFlow.stages[0].connectionId, timestampISO: initialWireAction.record.at, payload: { operation, caseId: descriptor.id, stage: 'Tg', rawActionSha256: sha256Text(JSON.stringify(initialRawAction)) }, source: { ...sourceRecord(initialWireAction.record, initialWireAction.index, wire), rawRequestID: initialWireAction.record.json?.requestID ?? null, rawTransID: initialWireAction.record.json?.transID ?? null, rawActionSha256: sha256Text(JSON.stringify(initialRawAction)) } }] : []),
    { type: 'context', stage: 'Tl', sessionId: identity.sharedSkillSessionId, messageId: contextMessageId, caseId: descriptor.id, requestID, transID, operation, connectionId: correlation.connectionId, timestampISO: contextAtISO, runtimeLocationISO: contextISO, timezone: contextTimezone, available: contextReady, sourceMessageId: contextMessageId, sourceLine: contextSourceLine, source: rawContext ? sourceRecord(rawContext, context.contextIndex, wire) : rawRefs.context || null },
    ...(wireRequest ? [{ type: 'request', stage: 'Tl', sessionId: identity.sharedSkillSessionId, messageId: wireRequest.record.json.msgID, caseId: descriptor.id, requestID, transID, operation, endpoint: request.endpoint, connectionId: correlation.connectionId, timestampISO: wireRequest.record.at, body: clone(followupBody), bodySha256: followupBodySha256, source: sourceRecord(wireRequest.record, wireRequest.index, wire), handle: clone(identity.followup.handle) }] : []),
    ...(wireAction ? [{ type: 'action', stage: 'Tl', sessionId: identity.sharedSkillSessionId, messageId: correlation.wireActionMessageId, caseId: descriptor.id, requestID, transID, operation, connectionId: correlation.connectionId, timestampISO: wireAction.record.at, payload: clone(payload.wire), source: { ...sourceRecord(wireAction.record, wireAction.index, wire), rawRequestID: wireAction.record.json?.requestID ?? null, rawTransID: wireAction.record.json?.transID ?? null, rawActionSha256: rawWireActionSha256 } }] : [])
  ];
  const targetStartMs = Math.min(...context.rows.map(({ record }) => Date.parse(record.at || '')).filter(Number.isFinite));
  const targetCloseMs = Math.max(...context.rows.filter(({ record }) => record.kind === 'close').map(({ record }) => Date.parse(record.at || '')).filter(Number.isFinite));
  const providerRows = wire.values.map((record, index) => ({ record, index })).filter(({ record }) => {
    const recordTime = Date.parse(record.at || '');
    return record.kind === 'fixture-provider' && record.caseId === fixtureCase.key && recordTime >= targetStartMs && recordTime <= targetCloseMs && (!record.input?.transID || record.input.transID === actionRequestID);
  });
  const providerEvents = providerRows.map(({ record, index }) => ({
    type: 'provider-call',
    callId: `provider-call-${index}`,
    caseId: descriptor.id,
    service: record.service,
    rawCaseId: record.caseId,
    requestID,
    transID,
    operation,
    connectionId: correlation.connectionId,
    stage: 'Tl',
    timestampISO: record.at,
    fixturePath: providerFixture.path,
    fixtureSha256: providerFixture.sha256,
    provider: clone(provider),
    source: sourceRecord(record, index, wire),
    sourceInput: { input: clone(record.input || {}), rawTransID: record.input?.transID ?? null, association: 'followup-connection-and-target-window' }
  }));
  const expectedProviderServices = descriptor.domain === 'commute'
    ? ['settings', 'maps']
    : descriptor.provider.parallel ? ['settings', 'google-calendar', 'outlook-calendar'] : ['settings', 'google-calendar'];
  const providerTraceBound = providerEvents.length === expectedProviderServices.length
    && providerEvents.every((event, index) => event.service === expectedProviderServices[index]);
  const screenshots = [];
  const screenshotCaptures = [];
  for (let index = 0; index < reportShots.length; index += 1) {
    const shot = reportShots[index];
    const sourceFilename = confinedPath(runRoot, shot.filename, `screenshot ${shot.filename}`);
    const sourceBytes = readRegular(sourceFilename, `screenshot ${sourceFilename}`);
    const sourceHash = sha256Bytes(sourceBytes);
    if (sourceHash !== shot.sha256) fail(`screenshot source hash changed: ${sourceFilename}`);
    const captureInfo = captureInfos[index];
    const reviewRecord = visualReview?.byKey.get(`${descriptor.id}:${shot.displayAction.captureOrdinal}:${shot.viewId}`) || null;
    const sourceRelativePath = path.relative(runRoot, sourceFilename);
    if (reviewRecord && (reviewRecord.sourcePath !== sourceRelativePath || reviewRecord.sha256 !== sourceHash || reviewRecord.bytes !== sourceBytes.length)) {
      fail(`visual review record does not bind screenshot ${sourceRelativePath}`);
    }
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
      captureKey: captureInfo.captureKey,
      pixelSha256: artifact.sha256,
      artifactIdentity: identity,
      captureAtISO: captureInfo.captureAtISO,
      elapsedMs: captureInfo.elapsedMs,
      stableForMs: captureInfo.stableForMs,
      captureOrdinal: shot.displayAction.captureOrdinal,
      visuallyInspected: Boolean(reviewRecord),
      ...(reviewRecord ? { visualReview: { schema: visualReview.value.schema, case: reviewRecord.case, captureOrdinal: reviewRecord.captureOrdinal, viewId: reviewRecord.viewId, path: reviewRecord.path, sha256: reviewRecord.sha256, bytes: reviewRecord.bytes, verdict: reviewRecord.verdict, reviewer: visualReview.value.reviewer, reviewedAt: visualReview.value.reviewedAt } } : {}),
      sourceScreenshot: { filename: sourceFilename, relativePath: sourceRelativePath, sha256: shot.sha256, rawTurnSha256: rawRefs.turn.sha256, viewInstance: shot.viewInstance, viewGeneration: shot.viewGeneration, displayAction: clone(shot.displayAction), captureMetadata: { snapshotIndex: captureInfo.snapshotIndex, elapsedMs: captureInfo.elapsedMs, ordinal: captureInfo.ordinal, captureKey: captureInfo.captureKey } }
    };
    screenshots.push(capture);
    screenshotCaptures.push({ caseId: descriptor.id, requestID, transID, operation, timestampISO: capture.captureAtISO, viewOrdinal, viewId: shot.viewId, captureKey: capture.captureKey, artifactPath: capture.path, sha256: capture.sha256, pixelSha256: capture.pixelSha256, artifactIdentity: capture.artifactIdentity, sourceScreenshot: capture.sourceScreenshot, visuallyInspected: capture.visuallyInspected, ...(capture.visualReview ? { visualReview: capture.visualReview } : {}) });
  }
  const idle = idleAt ? { observedMs: Date.parse(idleAt) - Date.parse(turn.started), observedAtISO: idleAt, skill: '@be/idle', view: 'eyeView', listener: 'Idle', ttsTalking: false, finalState: 'idle', observersRestored: true } : { observedMs: -1, observedAtISO: null, skill: null, view: null, listener: null, ttsTalking: null, finalState: null, observersRestored: false };
  const noBypassEvidence = {
    requestVia: turn.request?.via,
    endpoint: turn.request?.endpoint,
    bodySource: rawRefs.turn,
    initialSDKAck: { requestID: identity.initial.sdkAckRequestID, source: identity.initial.sdkAckSource },
    targetWireAction: { line: identity.followup.wireActionLine, messageId: identity.followup.wireActionMessageId, trace: rawRefs.wire },
      targetScreenshots: screenshots.length,
      timelineBound,
    visualReview: visualReview ? {
      path: visualReview.ref?.path,
      sha256: visualReview.ref?.sha256,
      targetCount: visualReview.value.targetCount,
      boundScreenshots: screenshots.filter((shot) => shot.visuallyInspected === true).length
    } : null,
    providerTrace: { services: providerEvents.map((event) => event.service), expected: expectedProviderServices, source: rawRefs.wire }
  };
  const visualReviewBound = Boolean(visualReview)
    && screenshots.length === reportShots.length
    && screenshots.every((shot) => shot.visuallyInspected === true);
  const noBypass = turn.request?.via === 'original BE Jetstream SDK'
    && turn.request?.endpoint === '/listen/mimic_global_turn'
    && contextReady
    && reportShots.length === expectedIds.length
    && screenshots.length === reportShots.length
    && timelineBound
    && providerTraceBound
    && visualReviewBound
    && identity.initial.prelude?.excludedDisplayActions?.length === 1
    && Boolean(targetWireAction);
  const actual = {
    captureISO: turn.started,
    localDateISO: dateISO,
    contextLocationISO: contextISO,
    request,
    provider,
    action,
    correlation,
    wireFlow,
    identity: clone(correlation.stages),
    logs: {
      native: { eventCount: nativeEvents.length, actionEventIndex: nativeEvents.findIndex((event) => event.type === 'action' && event.stage === 'Tl'), idleEventIndex: nativeEvents.findIndex((event) => event.type === 'idle'), actionEventId: correlation.nativeActionEventId },
      wire: { messageCount: wireEvents.length, actionMessageIndex: wireEvents.findIndex((record) => record.type === 'action' && record.stage === 'Tl'), ackMessageIndex: -1, ackPresent: false, actionMessageId: correlation.wireActionMessageId, connectionId: correlation.connectionId }
    },
    traceRange: { start: 0, end: 0, startISO: turn.started, endISO: turn.started },
    timeline: { views: timelineViews, idle, transitionToIdle: Boolean(idleAt) },
    observersRestored: Boolean(idleAt),
    noBypass,
    noBypassEvidence,
    artifacts: {
      stackReceipt: rawRefs.stack,
      nativeReport: null,
      wireTrace: null,
      providerTrace: null,
      actionPayload: null,
      providerFixture,
      contextAnchor: null,
      ...(visualReview?.ref ? { visualReview: visualReview.ref } : { visualReview: null }),
      rawTurn: rawRefs.turn,
      rawFixture: rawRefs.fixture,
      rawWire: rawRefs.wire
    },
    screenshots
  };
  actual.artifacts.stackReceipt = writeJson(outRoot, `artifacts/${descriptor.id}/stack-normalized.json`, {
    schema: 's13-stack-receipt-v1', caseId: descriptor.id, requestID, transID, operation, startedAtISO: turn.started,
    completedAtISO: idleAt, request: clone(request), action: { operation, payload: clone(payload.phoenix) }, finalIdle: { ...clone(idle), caseId: descriptor.id, requestID, transID, operation, timestampISO: idleAt }, identity: clone(correlation.stages), sourceStack: rawRefs.stack, sourceTurn: rawRefs.turn
  });
  actual.artifacts.nativeReport = writeJson(outRoot, `artifacts/${descriptor.id}/native-normalized.json`, { schema: 's13-native-report-v1', caseId: descriptor.id, requestID, transID, operation, identity: clone(correlation.stages), events: nativeEvents, captures: screenshotCaptures, sourceTurn: rawRefs.turn, sourceAction: { ...clone(action.sourceAction), rawAction } });
  actual.artifacts.wireTrace = writeJsonl(outRoot, `artifacts/${descriptor.id}/wire-normalized.jsonl`, wireEvents);
  actual.artifacts.contextAnchor = writeJson(outRoot, `artifacts/${descriptor.id}/context-anchor.json`, {
    schema: 's13-context-anchor-v1',
    available: contextReady,
    caseId: descriptor.id,
    requestID,
    transID,
    operation,
    ...(contextReady ? {
      runtimeLocationISO: rawContextFields.runtimeLocationISO,
      timezone: rawContextFields.timezone,
      capturedAtISO: rawContextFields.capturedAtISO,
      source: rawContextFields.source,
      sourceMessageId: rawContextFields.sourceMessageId,
      sourceLine: rawContextFields.sourceLine,
      initialContextLine: identity.initial.contextLine,
      followupContextLine: identity.followup.contextLine
    } : {
      reason: 'missing-standalone-context-timezone-anchor',
      source: 'raw-wire-context-unverified',
      sourceMessageId: contextMessageId,
      sourceLine: contextSourceLine
    }),
    sourceTraceSha256: rawRefs.wire.sha256,
    ...(contextReady && rawContext ? { sourceLineSha256: sourceRecord(rawContext, context.contextIndex, wire).sha256 } : {}),
    normalizedTraceSha256: actual.artifacts.wireTrace.sha256,
    sourceContext: rawRefs.context || null
  });
  actual.artifacts.providerTrace = writeJsonl(outRoot, `artifacts/${descriptor.id}/provider-normalized.jsonl`, providerEvents);
  actual.artifacts.actionPayload = writeJson(outRoot, `artifacts/${descriptor.id}/action-normalized.json`, payload);
  const traceTimes = [
    turn.started,
    followupStartedAtISO,
    ...nativeEvents.map((event) => event.timestampISO),
    ...wireEvents.map((event) => event.timestampISO),
    ...providerEvents.map((event) => event.timestampISO),
    ...screenshots.map((shot) => shot.captureAtISO),
    ...timelineViews.flatMap((view) => [view.openedAtISO, view.closedAtISO])
  ].map((value) => Date.parse(value)).filter(Number.isFinite);
  const traceStart = Math.min(...traceTimes);
  const traceEnd = Math.max(...traceTimes);
  actual.traceRange = {
    start: traceStart - Date.parse(turn.started),
    end: traceEnd - Date.parse(turn.started),
    startISO: new Date(traceStart).toISOString(),
    endISO: new Date(traceEnd).toISOString()
  };
  const claimed = action.phoenixMatchesMatrix === true && noBypass === true && contextReady === true;
  return {
    ordinal: descriptor.ordinal,
    id: descriptor.id,
    status: claimed ? 'pass' : 'observed',
    claimed,
    reference: clone(descriptor.reference),
    actual,
    ...(claimed ? {} : { limitation: action.phoenixMatchesMatrix !== true ? 'captured action projection differs from the matrix contract' : 'capture lacks complete source evidence for a bounded claim' })
  };
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

function missingRow(descriptor, limitation = `raw run did not contain ${descriptor.id}`) {
  return { ordinal: descriptor.ordinal, id: descriptor.id, status: 'not-captured', claimed: false, reference: clone(descriptor.reference), actual: { viewIds: [], screenshots: [] }, limitation };
}

export function produceCandidate(matrix, runDir, outRoot, { operation = 'mimicGlobalTurn', caseFiles = {}, bundles = null, bundleManifestPath = null, visualReviewPath = null } = {}) {
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
  if (!bundleMap) {
    const preferredManifest = fs.existsSync(path.join(run, 'bundle-manifest-toolkit-v2.json'))
      ? path.join(run, 'bundle-manifest-toolkit-v2.json')
      : fs.existsSync(path.join(run, 'bundle-manifest.json')) ? path.join(run, 'bundle-manifest.json') : null;
    if (preferredManifest) {
      bundleManifestSource = preferredManifest;
    }
  }
  if (!bundleMap && bundleManifestSource) {
    const manifest = readJson(bundleManifestSource, 'bundle-manifest.json').value;
    if (!isPlainObject(manifest) || !isPlainObject(manifest.cases)) fail('bundle-manifest.json must contain a cases object');
    bundleMap = manifest.cases;
  }
  let bundleManifestRef = null;
  if (bundleManifestSource) {
    const sourceBytes = readRegular(bundleManifestSource, 'bundle-manifest.json');
    bundleManifestRef = writeArtifact(outRoot, `raw/${path.basename(bundleManifestSource)}`, sourceBytes);
  }
  const visualReview = visualReviewFromRun(run, visualReviewPath);
  const visualReviewRef = visualReview ? writeArtifact(outRoot, 'raw/visual-review-v2.json', visualReview.refRead.bytes) : null;
  if (visualReview) visualReview.ref = visualReviewRef;
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
  const runtime = { captureISO: runtimeISO, localDateISO: localDateISO(runtimeISO, timezone), timezone, runRoot: run, fixtureGenerator: 'private-fixture-work-time', wallClockBound: false, captureConditions: { pmDepartureAvailable: false } };
  const fixtureBindingMismatches = [];
  const rejectedBundles = [];
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
      const contextAction = { row: eventRows(loaded.turnRead.value)[twoStageIdentity(loaded.turnRead.value, loaded.wireRead.values).followup.actionEventIndex] };
      const targetContext = selectedWireConnection(loaded.wireRead.values, loaded.turnRead.value, contextAction).context;
      const rawContextFields = targetContext ? { ...contextSourceFields(targetContext), sourceLine: loaded.wireRead.values.indexOf(targetContext) } : null;
      const contextISO = rawContextFields?.runtimeLocationISO || contextFields?.runtimeLocationISO || loaded.turnRead.value.started;
      const contextTimezone = rawContextFields?.timezone || contextFields?.timezone || timezone;
      contextByCase[descriptor.id] = {
        runtimeLocationISO: contextISO,
        timezone: contextTimezone,
        capturedAtISO: rawContextFields?.capturedAtISO,
        sourceMessageId: rawContextFields?.sourceMessageId,
        sourceLine: rawContextFields?.sourceLine,
        sourceTraceSha256: loaded.rawRefs.wire.sha256,
        connectionId: `wire-connection-${selectedWireConnection(loaded.wireRead.values, loaded.turnRead.value, contextAction).connectionId}`,
        transactionID: contextAction.row?.event?.transID,
        contextSha256: canonicalSha256({ runtimeLocationISO: contextISO, timezone: contextTimezone })
      };
      try {
        const row = deriveRow(matrix, descriptor, loaded.turnRead.value, loaded.fixtureRead.value, loaded.wireRead, outRoot, loaded.rawRefs, { ...runtime, runRoot: run, captureISO: loaded.turnRead.value.started, localDateISO: localDateISO(loaded.turnRead.value.started, timezone) }, operation, loaded.contextRead, loaded.bundle.declaredCaseId, visualReview, run);
        if (loaded.fixtureBindingMismatch) {
          row.status = 'observed';
          row.claimed = false;
          row.actual.noBypass = false;
          row.actual.noBypassEvidence.fixtureBinding = { stackFixtureSha256: loaded.stackRead.value.fixture?.sha256, rawFixtureSha256: loaded.rawRefs.fixture.sha256, source: loaded.rawRefs.stack };
          row.limitation = 'stack fixture hash does not bind opened private fixture bytes';
        }
        rows.push(row);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        if (!/shadow connection|two-stage identity|initial and followup|candidate TURN_STARTED|raw wire SKILL_ACTION|SDK ACK/i.test(reason)) throw error;
        rejectedBundles.push({ caseId: descriptor.id, reason, claimed: false });
        rows.push(missingRow(descriptor, `raw run rejected: ${reason}`));
      }
    } else rows.push(missingRow(descriptor));
  }
  const rawRefs = first.rawRefs;
  const capturedPhysicalRows = rows.filter((row) => row?.actual?.request?.operation);
  const preflightContext = capturedPhysicalRows[0]?.actual?.request?.locationISO || runtime.captureISO;
  const preflightTimezone = capturedPhysicalRows[0]?.actual?.timeline?.idle ? timezone : runtime.timezone;
  const preflightProven = capturedPhysicalRows.length > 0
    && fixtureBindingMismatches.length === 0
    && capturedPhysicalRows.every((row) => row.actual?.request?.endpoint === '/listen/mimic_global_turn'
      && row.actual?.request?.body?.clientASR === row.actual?.request?.phrase
      && row.actual?.contextLocationISO === (row.actual?.request?.locationISO || row.actual?.contextLocationISO)
      && row.actual?.artifacts?.contextAnchor
      && row.actual?.correlation?.stages?.initial?.sdkAck?.requestID
      && row.actual?.correlation?.stages?.followup?.handle?.requestID === row.actual?.correlation?.transID);
  const sourceRun = writeJson(outRoot, 'raw/run-manifest.json', {
    schema: 'phoenix-s13-raw-run-manifest-v1', runDirectory: run, stack: rawRefs.stack, fixture: rawRefs.fixture, wire: rawRefs.wire,
    ...(bundleManifestRef ? { bundleManifest: bundleManifestRef } : {}),
    ...(visualReviewRef ? { visualReview: visualReviewRef } : {}),
    ...(rejectedBundles.length ? { rejectedBundles } : {}),
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
    turns: Object.fromEntries(Object.entries(turns).map(([id, turn]) => [id, { started: turn.started, durationMs: turn.durationMs, request: turn.request, ack: turn.ack, followup: turn.followup }]))
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
      phoenix: { revision: stackRead.value.revision, baseRevision: matrix.baseRevision, worktree: stackRead.value.cwd, source: rawRefs.stack },
      sourceRun,
      rawStack: rawRefs.stack,
      rawFixture: rawRefs.fixture,
      rawWire: rawRefs.wire,
      ...(visualReviewRef ? { visualReview: visualReviewRef } : {})
    },
    preflight: { operation, method: 'POST', endpoint: operation === 'startLocalTurn' ? '/listen/start_local_turn' : '/listen/mimic_global_turn', transportMode: operation === 'startLocalTurn' ? 'local' : 'global', bodyField: operation === 'startLocalTurn' ? 'nluRules' : 'clientASR', contextSource: preflightProven ? 'fixture-scoped-runtime' : 'raw-run-context-unverified', proven: preflightProven, context: { runtimeLocationISO: preflightContext, timezone: preflightTimezone }, contextSha256: canonicalSha256({ runtimeLocationISO: preflightContext, timezone: preflightTimezone }), contextByCase },
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
