import fs from 'node:fs';
import path from 'node:path';
import { addLocalDays, canonicalSha256, resolveCommuteSchedule, sha256Bytes, sha256Text } from './validate.mjs';

const CANONICALIZATION = 'sorted object keys, array order preserved, UTF-8 JSON without trailing newline';

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function dynamicDeparture(descriptor, provider, request) {
  const workHour = request.prefs.workHour;
  const workMin = request.prefs.workMin;
  const date = new Date(Date.UTC(2000, 0, 1, workHour, workMin, 0) - provider.trafficSeconds * 1000);
  const hours = date.getUTCHours();
  return { time: `${hours % 12 || 12}:${String(date.getUTCMinutes()).padStart(2, '0')}`, ampm: hours >= 12 ? 'PM' : 'AM' };
}

function resolvedContracts(descriptor, provider, request) {
  return (descriptor.expected.viewContracts || []).map((contract) => {
    if (!contract.labelsFrom) return clone(contract);
    const { labelsFrom: _discard, ...rest } = clone(contract);
    return { ...rest, labels: dynamicDeparture(descriptor, provider, request) };
  });
}

function writeArtifact(root, relativePath, content) {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  fs.writeFileSync(target, bytes);
  return { path: relativePath, sha256: sha256Bytes(bytes), bytes: bytes.length };
}

function artifactBody(caseId, kind) {
  return JSON.stringify({ schema: 's13-test-artifact', caseId, kind, nonce: `${caseId}:${kind}` });
}

function makePhysicalRow(descriptor, index, root, runtime, selectedOperation) {
  const resolvedDateISO = descriptor.domain === 'calendar' ? addLocalDays(runtime.localDateISO, 1) : runtime.localDateISO;
  const provider = {
    kind: descriptor.provider.kind,
    ...(descriptor.provider.fixture === undefined ? {} : { fixture: descriptor.provider.fixture }),
    ...(descriptor.provider.baseSeconds === undefined ? {} : { baseSeconds: descriptor.provider.baseSeconds }),
    ...(descriptor.provider.trafficSeconds === undefined ? {} : { trafficSeconds: descriptor.provider.trafficSeconds }),
    ...(descriptor.provider.parallel === undefined ? {} : { parallel: descriptor.provider.parallel }),
    resolvedDateISO,
    fixtureSha256: canonicalSha256({ id: descriptor.id, fixture: descriptor.provider.fixture || descriptor.provider.kind, date: resolvedDateISO })
  };
  const requestBody = { clientASR: descriptor.input.phrase };
  const request = {
    operation: selectedOperation, method: 'POST', endpoint: '/listen/mimic_global_turn', transportMode: 'global', mode: descriptor.input.mode,
    microphoneAcceptance: false, phrase: descriptor.input.phrase, body: requestBody, bodySha256: canonicalSha256(requestBody),
    runtimeLocalDateISO: runtime.localDateISO
  };
  if (descriptor.domain === 'commute') {
    request.locationISO = runtime.captureISO;
    request.locationMode = 'capture-local-clock';
    const schedule = resolveCommuteSchedule(runtime.captureISO, descriptor.input.prefsPolicy.schedule, runtime.timezone);
    request.prefs = {
      mode: descriptor.input.prefsPolicy.mode, workHour: schedule.hour, workMin: schedule.minute,
      workDateISO: schedule.dateISO, baseSeconds: descriptor.input.prefsPolicy.baseSeconds, trafficSeconds: descriptor.input.prefsPolicy.trafficSeconds
    };
    request.prefsResolution = {
      schedule: descriptor.input.prefsPolicy.schedule, generatedFrom: 'capture-local-clock', workDateISO: schedule.dateISO,
      sha256: canonicalSha256(request.prefs)
    };
  }
  if (descriptor.domain === 'calendar') {
    request.calendarDateISO = resolvedDateISO;
    request.calendarFixture = descriptor.input.calendarFixture;
  }
  if (descriptor.kind === 'revalidation') {
    request.revalidation = true;
    request.calendarDateISO = runtime.localDateISO;
  }
  const projection = {
    mimIds: descriptor.expected.mimIdsPolicy === 'capture-derived'
      ? (descriptor.domain === 'weather' ? ['WeatherIntro', 'WeatherTodayHighLow'] : ['NewsIntro', 'NewsHeadline', 'NewsHeadline', 'NewsHeadline', 'NewsOutro'])
      : clone(descriptor.expected.mimIds),
    viewIds: clone(descriptor.expected.viewIds),
    viewContracts: resolvedContracts(descriptor, provider, request)
  };
  const payload = {
    phoenix: { operation: selectedOperation, caseId: descriptor.id, projection },
    native: { operation: selectedOperation, caseId: descriptor.id, projection: clone(projection) },
    wire: { operation: selectedOperation, caseId: descriptor.id, projection: clone(projection) }
  };
  const correlation = {
    ackRequestID: `s13-${String(index).padStart(2, '0')}-trans`,
    transID: `s13-${String(index).padStart(2, '0')}-trans`,
    connectionId: `s13-connection-${index}`,
    nativeActionEventId: `native-action-${index}`,
    wireActionMessageId: `wire-action-${index}`
  };
  const action = {
    operation: selectedOperation, projection, rawSha256: sha256Text(JSON.stringify(payload.phoenix)), payloadSha256: canonicalSha256(payload),
    canonicalization: CANONICALIZATION, payload,
    phoenixCanonicalSha256: canonicalSha256(payload.phoenix), nativeCanonicalSha256: canonicalSha256(payload.native), wireCanonicalSha256: canonicalSha256(payload.wire),
    nativeEqualsPhoenix: true, wireEqualsNative: true, phoenixMatchesMatrix: true
  };
  const timelineViews = projection.viewContracts.map((view, ordinal) => ({
    ordinal, viewId: view.id, openedMs: 100 + ordinal * 100, closedMs: 200 + ordinal * 100
  }));
  const idleMs = 700;
  const actual = {
    request, provider, action, correlation,
    logs: {
      native: { eventCount: 3, actionEventIndex: 1, idleEventIndex: 2, actionEventId: correlation.nativeActionEventId },
      wire: { messageCount: 3, actionMessageIndex: 1, ackMessageIndex: 2, actionMessageId: correlation.wireActionMessageId, connectionId: correlation.connectionId }
    },
    traceRange: { start: 0, end: 2 },
    timeline: {
      views: timelineViews,
      idle: { observedMs: idleMs, skill: '@be/idle', view: 'eyeView', listener: 'Idle', ttsTalking: false, finalState: 'idle', observersRestored: true },
      transitionToIdle: true
    },
    observersRestored: true,
    noBypass: true,
    artifacts: {},
    screenshots: []
  };
  actual.artifacts.stackReceipt = writeArtifact(root, `artifacts/${descriptor.id}/stack.json`, artifactBody(descriptor.id, 'stack-receipt'));
  actual.artifacts.nativeReport = writeArtifact(root, `artifacts/${descriptor.id}/native.json`, artifactBody(descriptor.id, 'native-report'));
  actual.artifacts.wireTrace = writeArtifact(root, `artifacts/${descriptor.id}/wire.jsonl`, artifactBody(descriptor.id, 'wire-trace'));
  actual.artifacts.providerTrace = writeArtifact(root, `artifacts/${descriptor.id}/provider.jsonl`, artifactBody(descriptor.id, 'provider-trace'));
  actual.artifacts.actionPayload = writeArtifact(root, `artifacts/${descriptor.id}/action.json`, `${JSON.stringify(payload)}\n`);
  actual.screenshots = projection.viewContracts.map((view, ordinal) => {
    const relativePath = `artifacts/${descriptor.id}/screenshots/${String(ordinal).padStart(2, '0')}-${view.id}.png`;
    return { ...writeArtifact(root, relativePath, `S13 screenshot fixture ${descriptor.id} ${ordinal}\n`), ordinal, viewId: view.id, stableForMs: 1000, visuallyInspected: true };
  });
  return { ordinal: descriptor.ordinal, id: descriptor.id, status: 'pass', reference: clone(descriptor.reference), actual };
}

function makeNoViewRow(descriptor) {
  return {
    ordinal: descriptor.ordinal, id: descriptor.id, status: 'asserted', reference: clone(descriptor.reference),
    actual: {
      sourceReceipt: clone(descriptor.reference), viewIds: [], screenshots: [], transitionToIdle: true,
      action: { mimIds: clone(descriptor.expected.mimIds), viewIds: [], receiptSha256: descriptor.reference.sha256 }
    }
  };
}

function makeBlockedRow(descriptor) {
  return {
    ordinal: descriptor.ordinal, id: descriptor.id, status: 'blocked', reference: clone(descriptor.reference),
    blockedReason: descriptor.blocked.reason, claimed: false, actual: { viewIds: [], screenshots: [] }
  };
}

export function buildReceipt(matrix, root, { revision = matrix.baseRevision } = {}) {
  fs.mkdirSync(root, { recursive: true });
  const captureDate = new Date();
  const captureISO = captureDate.toISOString();
  const localDateISO = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(captureDate);
  const runtime = {
    captureISO, localDateISO, timezone: 'America/New_York', fixtureGenerator: 'relative-to-local-date', wallClockBound: true
  };
  const selectedOperation = 'mimicGlobalTurn';
  const preflightContext = { runtimeLocationISO: captureISO, timezone: runtime.timezone };
  const preflight = {
    operation: selectedOperation, method: 'POST', endpoint: '/listen/mimic_global_turn', transportMode: 'global', bodyField: 'clientASR',
    contextSource: 'fixture-scoped-runtime', proven: true, context: preflightContext, contextSha256: canonicalSha256(preflightContext)
  };
  const provenance = {
    phoenix: { revision, baseRevision: matrix.baseRevision, treeSha256: 'a'.repeat(64), sourceManifestSha256: 'b'.repeat(64), worktree: '/tmp/phoenix-s13-capture' },
    be: { packageName: '@be/be', version: '12.0.0', slot: 'phoenix-be-12-0-0-parity', packageSha256: 'c'.repeat(64), deploymentReceiptSha256: 'd'.repeat(64) },
    client: { packageName: '@jibo/jibo-server-client', version: '3.0.110', node: 'v22.14.0', packageJsonSha256: 'e'.repeat(64), entrySha256: 'f'.repeat(64), loadedPath: '/private/client/index.js' },
    nimbus: { packageName: '@be/nimbus', version: '3.0.4', root: '/private/nimbus', packageJsonSha256: '1'.repeat(64), indexSha256: '2'.repeat(64), assetManifestSha256: matrix.referenceContract.assetAudit.assetManifestSha256 },
    native: { firmware: 'fixture-firmware', ssmVersion: 'fixture-ssm-1', ssmSha256: '3'.repeat(64), jetstreamBinarySha256: '4'.repeat(64), jetstreamConfigSha256: '5'.repeat(64) }
  };
  const controls = matrix.falsificationControls.map((id) => ({ id, status: 'rejected', exitCode: 1, evidence: `isolated ${id} mutation rejected` }));
  const controlProjection = controls.map(({ id, status, exitCode, evidence }) => ({ id, status, exitCode, evidence }));
  const cases = matrix.cases.map((descriptor, index) => {
    if (descriptor.kind === 'blocked') return makeBlockedRow(descriptor);
    if (descriptor.kind === 'no-view') return makeNoViewRow(descriptor);
    return makePhysicalRow(descriptor, index + 1, root, runtime, selectedOperation);
  });
  return {
    schema: 'phoenix.parity.s13.physical-capture-receipt', schemaVersion: 1, task: 'S-13', claim: 'physical-display-only', phoenixRevision: revision,
    decision: 'blocked', taskStatus: 'open', complete: false, runtime, provenance, preflight,
    matrix: { path: 'scripts/parity-s13-physical/matrix.json', sha256: matrix.integrity.matrixSha256, inventorySha256: matrix.integrity.caseInventorySha256, baseRevision: matrix.baseRevision, caseCount: matrix.cases.length, orderedCaseIds: matrix.cases.map((item) => item.id) },
    falsification: { result: 'pass', controls, controlsSha256: canonicalSha256(controlProjection) }, cases
  };
}
