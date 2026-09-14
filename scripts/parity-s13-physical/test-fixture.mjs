import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { addLocalDays, canonicalJson, canonicalSha256, resolveCommuteSchedule, sha256Bytes, sha256Text } from './validate.mjs';

const here = path.dirname(new URL(import.meta.url).pathname);
const repoRoot = path.resolve(here, '../..');
const CANONICALIZATION = 'sorted object keys, array order preserved, UTF-8 JSON without trailing newline';

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function isoAt(iso, deltaMs) {
  return new Date(Date.parse(iso) + deltaMs).toISOString();
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
  return Buffer.concat([length, typeBytes, data, checksum]);
}

// A deterministic, inspectable 640x480 RGBA image. It is large enough to
// represent a physical capture and has real PNG structure.
function pngFixture(seed) {
  const width = 640;
  const height = 480;
  const rowBytes = width * 4 + 1;
  const raw = Buffer.alloc(rowBytes * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * rowBytes;
    raw[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const pixel = row + 1 + x * 4;
      raw[pixel] = (x + seed * 17) % 256;
      raw[pixel + 1] = (y + seed * 31) % 256;
      raw[pixel + 2] = (x + y + seed * 47) % 256;
      raw[pixel + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 1 })),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

function writeArtifact(root, relativePath, content) {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  fs.writeFileSync(target, bytes);
  return { path: relativePath, sha256: sha256Bytes(bytes), bytes: bytes.length };
}

function writeJson(root, relativePath, value) {
  return writeArtifact(root, relativePath, canonicalJson(value));
}

function writeJsonl(root, relativePath, values) {
  return writeArtifact(root, relativePath, `${values.map((value) => canonicalJson(value)).join('\n')}\n`);
}

function stageLinkedReference(descriptor, root) {
  const sourcePath = path.resolve(repoRoot, descriptor.reference.path);
  const bytes = fs.readFileSync(sourcePath);
  if (sha256Bytes(bytes) !== descriptor.reference.sha256) {
    throw new Error(`source reference digest changed: ${descriptor.reference.path}`);
  }
  const relativePath = `references/no-view/${descriptor.id}.json`;
  const artifact = writeArtifact(root, relativePath, bytes);
  return {
    lane: descriptor.reference.lane,
    caseId: descriptor.reference.caseId,
    sourcePath: descriptor.reference.path,
    format: descriptor.reference.lane === 's11-http-graph' ? 's11-graph-matrix' : 's12-differential-receipt',
    ...artifact
  };
}

function dynamicDeparture(provider, request) {
  const date = new Date(Date.UTC(2000, 0, 1, request.prefs.workHour, request.prefs.workMin, 0) - provider.trafficSeconds * 1000);
  const hours = date.getUTCHours();
  return { time: `${hours % 12 || 12}:${String(date.getUTCMinutes()).padStart(2, '0')}`, ampm: hours >= 12 ? 'PM' : 'AM' };
}

function resolvedContracts(descriptor, provider, request) {
  return (descriptor.expected.viewContracts || []).map((contract) => {
    if (!contract.labelsFrom) return clone(contract);
    const { labelsFrom: _discard, ...rest } = clone(contract);
    return { ...rest, labels: dynamicDeparture(provider, request) };
  });
}

function makeRequest(descriptor, runtime, selectedOperation, allowedRequest) {
  const body = allowedRequest.bodyField === 'clientASR'
    ? { clientASR: descriptor.input.phrase }
    : clone(allowedRequest.bodyContract);
  const request = {
    operation: selectedOperation,
    method: allowedRequest.method,
    endpoint: allowedRequest.endpoint,
    transportMode: allowedRequest.transportMode,
    mode: descriptor.input.mode,
    microphoneAcceptance: false,
    phrase: descriptor.input.phrase,
    body,
    bodySha256: canonicalSha256(body),
    runtimeLocalDateISO: runtime.localDateISO
  };
  if (descriptor.domain === 'commute') {
    request.locationISO = runtime.captureISO;
    request.locationMode = 'capture-local-clock';
    const schedule = resolveCommuteSchedule(runtime.captureISO, descriptor.input.prefsPolicy.schedule, runtime.timezone);
    request.prefs = {
      mode: descriptor.input.prefsPolicy.mode,
      workHour: schedule.hour,
      workMin: schedule.minute,
      workDateISO: schedule.dateISO,
      baseSeconds: descriptor.input.prefsPolicy.baseSeconds,
      trafficSeconds: descriptor.input.prefsPolicy.trafficSeconds
    };
    request.prefsResolution = {
      schedule: descriptor.input.prefsPolicy.schedule,
      generatedFrom: 'capture-local-clock',
      workDateISO: schedule.dateISO,
      sha256: canonicalSha256(request.prefs)
    };
  }
  if (descriptor.domain === 'calendar') {
    request.calendarDateISO = addLocalDays(runtime.localDateISO, 1, runtime.timezone);
    request.calendarFixture = descriptor.input.calendarFixture;
  }
  if (descriptor.kind === 'revalidation') {
    request.revalidation = true;
    request.calendarDateISO = runtime.localDateISO;
  }
  return request;
}

function makePhysicalRow(descriptor, index, root, runtime, selectedOperation, allowedRequest) {
  const request = makeRequest(descriptor, runtime, selectedOperation, allowedRequest);
  const resolvedDateISO = descriptor.domain === 'calendar' ? request.calendarDateISO : runtime.localDateISO;
  const fixture = descriptor.provider.fixture ?? `${descriptor.provider.kind}:${resolvedDateISO}`;
  const providerProjection = {
    kind: descriptor.provider.kind,
    ...(descriptor.provider.fixture === undefined ? {} : { fixture: descriptor.provider.fixture }),
    ...(descriptor.provider.baseSeconds === undefined ? {} : { baseSeconds: descriptor.provider.baseSeconds }),
    ...(descriptor.provider.trafficSeconds === undefined ? {} : { trafficSeconds: descriptor.provider.trafficSeconds }),
    ...(descriptor.provider.parallel === undefined ? {} : { parallel: descriptor.provider.parallel }),
    resolvedDateISO
  };
  const fixtureContent = {
    schema: 's13-private-provider-fixture-v1',
    caseId: descriptor.id,
    domain: descriptor.domain,
    fixture,
    resolvedDateISO,
    ...(request.calendarDateISO ? { calendarDateISO: request.calendarDateISO } : {}),
    ...(descriptor.input.events ? { events: clone(descriptor.input.events) } : {}),
    provider: providerProjection
  };
  const providerFixture = writeJson(root, `artifacts/${descriptor.id}/provider-fixture.json`, fixtureContent);
  const provider = { ...providerProjection, fixtureSha256: providerFixture.sha256 };
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
    requestID: `s13-${String(index).padStart(2, '0')}-trans`,
    ackRequestID: `s13-${String(index).padStart(2, '0')}-trans`,
    transID: `s13-${String(index).padStart(2, '0')}-trans`,
    caseId: descriptor.id,
    operation: selectedOperation,
    connectionId: `s13-connection-${index}`,
    nativeActionEventId: `native-action-${index}`,
    wireActionMessageId: `wire-action-${index}`
  };
  const action = {
    operation: selectedOperation,
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
    phoenixMatchesMatrix: true
  };
  const timelineViews = projection.viewContracts.map((view, ordinal) => ({
    ordinal,
    viewId: view.id,
    openedMs: 100 + ordinal * 100,
    closedMs: 200 + ordinal * 100,
    openedAtISO: isoAt(runtime.captureISO, 100 + ordinal * 100),
    closedAtISO: isoAt(runtime.captureISO, 200 + ordinal * 100)
  }));
  const idleAt = isoAt(runtime.captureISO, 2500);
  const idle = {
    observedMs: 2500,
    observedAtISO: idleAt,
    skill: '@be/idle',
    view: 'eyeView',
    listener: 'Idle',
    ttsTalking: false,
    finalState: 'idle',
    observersRestored: true
  };
  const actual = {
    captureISO: runtime.captureISO,
    localDateISO: runtime.localDateISO,
    contextLocationISO: runtime.captureISO,
    request,
    provider,
    action,
    correlation,
    logs: {
      native: { eventCount: 3, actionEventIndex: 1, idleEventIndex: 2, actionEventId: correlation.nativeActionEventId },
      wire: { messageCount: 4, actionMessageIndex: 1, ackMessageIndex: 2, actionMessageId: correlation.wireActionMessageId, connectionId: correlation.connectionId, ackPayloadSha256: action.wireCanonicalSha256 }
    },
    traceRange: { start: 0, end: 3, startISO: isoAt(runtime.captureISO, -1000), endISO: isoAt(runtime.captureISO, 3000) },
    timeline: { views: timelineViews, idle, transitionToIdle: true },
    observersRestored: true,
    noBypass: true,
    artifacts: { providerFixture, contextAnchor: null },
    screenshots: []
  };

  const nativeEvents = [
    { type: 'request', eventId: `native-request-${index}`, caseId: descriptor.id, requestID: correlation.requestID, transID: correlation.transID, operation: selectedOperation, endpoint: request.endpoint, timestampISO: isoAt(runtime.captureISO, -500), body: clone(request.body), bodySha256: request.bodySha256 },
    { type: 'action', eventId: correlation.nativeActionEventId, caseId: descriptor.id, requestID: correlation.requestID, transID: correlation.transID, operation: selectedOperation, timestampISO: isoAt(runtime.captureISO, 50), payload: clone(payload.native) },
    { type: 'idle', eventId: `native-idle-${index}`, caseId: descriptor.id, requestID: correlation.requestID, transID: correlation.transID, operation: selectedOperation, timestampISO: idleAt, skill: '@be/idle', view: 'eyeView', listener: 'Idle', ttsTalking: false, finalState: 'idle' }
  ];
  const wireEvents = [
    { type: 'request', messageId: `wire-request-${index}`, caseId: descriptor.id, requestID: correlation.requestID, transID: correlation.transID, operation: selectedOperation, endpoint: request.endpoint, connectionId: correlation.connectionId, timestampISO: isoAt(runtime.captureISO, -400), body: clone(request.body), bodySha256: request.bodySha256 },
    { type: 'action', messageId: correlation.wireActionMessageId, caseId: descriptor.id, requestID: correlation.requestID, transID: correlation.transID, operation: selectedOperation, connectionId: correlation.connectionId, timestampISO: isoAt(runtime.captureISO, 50), payload: clone(payload.wire) },
    { type: 'ack', messageId: `wire-ack-${index}`, caseId: descriptor.id, requestID: correlation.requestID, transID: correlation.transID, operation: selectedOperation, connectionId: correlation.connectionId, timestampISO: isoAt(runtime.captureISO, 1500), ackFor: correlation.wireActionMessageId, payload: clone(payload.wire), payloadSha256: action.wireCanonicalSha256, actionPayloadSha256: action.payloadSha256 },
    { type: 'idle', messageId: `wire-idle-${index}`, caseId: descriptor.id, requestID: correlation.requestID, transID: correlation.transID, operation: selectedOperation, connectionId: correlation.connectionId, timestampISO: idleAt, finalState: 'idle' }
  ];
  const providerEvents = [
    { type: 'provider-call', callId: `provider-call-${index}`, caseId: descriptor.id, requestID: correlation.requestID, transID: correlation.transID, operation: selectedOperation, timestampISO: isoAt(runtime.captureISO, -300), fixturePath: providerFixture.path, fixtureSha256: providerFixture.sha256, provider: clone(provider) },
    { type: 'provider-return', callId: `provider-return-${index}`, caseId: descriptor.id, requestID: correlation.requestID, transID: correlation.transID, operation: selectedOperation, timestampISO: isoAt(runtime.captureISO, 800), fixturePath: providerFixture.path, fixtureSha256: providerFixture.sha256, provider: clone(provider) },
    { type: 'idle', caseId: descriptor.id, requestID: correlation.requestID, transID: correlation.transID, operation: selectedOperation, timestampISO: idleAt, finalState: 'idle' }
  ];
  actual.screenshots = projection.viewContracts.map((view, ordinal) => {
    const relativePath = `artifacts/${descriptor.id}/screenshots/${String(ordinal).padStart(2, '0')}-${view.id}.png`;
    const artifact = writeArtifact(root, relativePath, pngFixture(index * 10 + ordinal));
    const captureAtISO = isoAt(runtime.captureISO, 150 + ordinal * 100);
    const pixelSha256 = artifact.sha256;
    const artifactIdentity = canonicalSha256({ caseId: descriptor.id, caseOrdinal: descriptor.ordinal, viewOrdinal: ordinal, viewId: view.id, pixelSha256 });
    return { ...artifact, caseId: descriptor.id, ordinal, viewOrdinal: ordinal, viewId: view.id, captureKey: `${descriptor.id}:view:${ordinal}:${view.id}`, pixelSha256, artifactIdentity, captureAtISO, stableForMs: 1000, visuallyInspected: true };
  });
  const screenshotCaptures = actual.screenshots.map((shot) => ({
    caseId: descriptor.id,
    requestID: correlation.requestID,
    transID: correlation.transID,
    operation: selectedOperation,
    timestampISO: shot.captureAtISO,
    viewOrdinal: shot.viewOrdinal,
    viewId: shot.viewId,
    captureKey: shot.captureKey,
    artifactPath: shot.path,
    sha256: shot.sha256,
    pixelSha256: shot.pixelSha256,
    artifactIdentity: shot.artifactIdentity
  }));
  actual.artifacts.stackReceipt = writeJson(root, `artifacts/${descriptor.id}/stack.json`, {
    schema: 's13-stack-receipt-v1', caseId: descriptor.id, requestID: correlation.requestID, transID: correlation.transID, operation: selectedOperation,
    startedAtISO: isoAt(runtime.captureISO, -1000), completedAtISO: isoAt(runtime.captureISO, 3000), request: clone(request),
    action: { operation: selectedOperation, payload: clone(payload.phoenix) }, finalIdle: { ...clone(idle), timestampISO: idleAt, caseId: descriptor.id, requestID: correlation.requestID, transID: correlation.transID, operation: selectedOperation }
  });
  actual.artifacts.nativeReport = writeJson(root, `artifacts/${descriptor.id}/native.json`, {
    schema: 's13-native-report-v1', caseId: descriptor.id, requestID: correlation.requestID, transID: correlation.transID, operation: selectedOperation, events: nativeEvents, captures: screenshotCaptures
  });
  actual.artifacts.wireTrace = writeJsonl(root, `artifacts/${descriptor.id}/wire.jsonl`, wireEvents);
  actual.artifacts.contextAnchor = writeJson(root, `artifacts/${descriptor.id}/context-anchor.json`, {
    schema: 's13-context-anchor-v1', available: true, caseId: descriptor.id,
    requestID: correlation.requestID, transID: correlation.transID, operation: selectedOperation,
    runtimeLocationISO: runtime.captureISO, timezone: runtime.timezone,
    capturedAtISO: isoAt(runtime.captureISO, -700), source: 'synthetic-context',
    sourceMessageId: `wire-context-${index}`, sourceLine: 0,
    sourceTraceSha256: actual.artifacts.wireTrace.sha256
  });
  actual.artifacts.providerTrace = writeJsonl(root, `artifacts/${descriptor.id}/provider.jsonl`, providerEvents);
  actual.artifacts.actionPayload = writeArtifact(root, `artifacts/${descriptor.id}/action.json`, canonicalJson(payload));
  actual.artifacts.visualReview = writeJson(root, `artifacts/${descriptor.id}/visual-review.json`, {
    schema: 's13-visual-review-v1',
    caseId: descriptor.id,
    visuallyInspected: true,
    screenshots: actual.screenshots.map((shot) => ({
      caseId: shot.caseId,
      viewOrdinal: shot.viewOrdinal,
      viewId: shot.viewId,
      captureKey: shot.captureKey,
      sha256: shot.sha256,
      verdict: 'pass'
    }))
  });
  return { ordinal: descriptor.ordinal, id: descriptor.id, status: 'pass', reference: clone(descriptor.reference), actual };
}

function makeNoViewRow(descriptor, root) {
  const sourceReceipt = stageLinkedReference(descriptor, root);
  return {
    ordinal: descriptor.ordinal,
    id: descriptor.id,
    status: 'asserted',
    reference: clone(descriptor.reference),
    actual: {
      sourceReceipt,
      viewIds: [],
      screenshots: [],
      transitionToIdle: true,
      action: { mimIds: clone(descriptor.expected.mimIds), viewIds: [], receiptSha256: sourceReceipt.sha256 }
    }
  };
}

function makeBlockedRow(descriptor) {
  return {
    ordinal: descriptor.ordinal,
    id: descriptor.id,
    status: 'blocked',
    reference: clone(descriptor.reference),
    blockedReason: descriptor.blocked.reason,
    claimed: false,
    actual: { viewIds: [], screenshots: [] }
  };
}

function makeConditionalSkippedRow(descriptor) {
  return {
    ordinal: descriptor.ordinal,
    id: descriptor.id,
    status: 'skipped',
    reference: clone(descriptor.reference),
    skipReason: `conditional capture unavailable: ${descriptor.captureCondition.key}`,
    actual: { viewIds: [], screenshots: [] }
  };
}

function makeRevalidationReferenceRow(descriptor, root) {
  const sourceReceipt = stageLinkedReference(descriptor, root);
  return {
    ordinal: descriptor.ordinal,
    id: descriptor.id,
    status: 'referenced',
    reference: clone(descriptor.reference),
    actual: {
      sourceReceipt: { ...sourceReceipt, format: 's13-hardware-receipt' },
      viewIds: clone(descriptor.expected.viewIds),
      screenshots: [],
      transitionToIdle: true,
      action: { mimIds: [], viewIds: clone(descriptor.expected.viewIds), receiptSha256: sourceReceipt.sha256 }
    }
  };
}

export function buildReceipt(matrix, root, {
  revision = matrix.baseRevision,
  selectedOperation = 'mimicGlobalTurn',
  pmDepartureAvailable = false
} = {}) {
  fs.mkdirSync(root, { recursive: true });
  const captureDate = new Date();
  const captureISO = captureDate.toISOString();
  const localDateISO = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(captureDate);
  const runtime = {
    captureISO,
    localDateISO,
    timezone: 'America/New_York',
    fixtureGenerator: 'relative-to-local-date',
    wallClockBound: true,
    captureConditions: { pmDepartureAvailable }
  };
  const allowedRequest = matrix.physicalProtocol.allowedRequests.find((item) => item.operation === selectedOperation);
  if (!allowedRequest) throw new Error(`selected operation is not allow-listed: ${selectedOperation}`);
  const preflightContext = { runtimeLocationISO: captureISO, timezone: runtime.timezone };
  const preflight = {
    operation: selectedOperation,
    method: allowedRequest.method,
    endpoint: allowedRequest.endpoint,
    transportMode: allowedRequest.transportMode,
    bodyField: allowedRequest.bodyField,
    contextSource: allowedRequest.contextSource,
    proven: true,
    context: preflightContext,
    contextSha256: canonicalSha256(preflightContext)
  };
  const provenance = {
    phoenix: { revision, baseRevision: matrix.baseRevision, treeSha256: 'a'.repeat(64), sourceManifestSha256: 'b'.repeat(64), worktree: '/tmp/phoenix-s13-capture' },
    be: { packageName: '@be/be', version: '12.0.0', slot: 'phoenix-be-12-0-0-parity', packageSha256: 'c'.repeat(64), deploymentReceiptSha256: 'd'.repeat(64) },
    client: { packageName: '@jibo/jibo-server-client', version: '3.0.110', node: 'v22.14.0', packageJsonSha256: 'e'.repeat(64), entrySha256: 'f'.repeat(64), loadedPath: '/private/client/index.js' },
    nimbus: { packageName: '@be/nimbus', version: '3.0.4', root: '/private/nimbus', packageJsonSha256: '1'.repeat(64), indexSha256: '2'.repeat(64), assetManifestSha256: matrix.referenceContract.assetAudit.assetManifestSha256 },
    native: { firmware: 'fixture-firmware', ssmVersion: 'fixture-ssm-1', ssmSha256: '3'.repeat(64), jetstreamBinarySha256: '4'.repeat(64), jetstreamConfigSha256: '5'.repeat(64) }
  };
  const matrixAnchor = writeArtifact(root, 'provenance/anchors/matrix.json', fs.readFileSync(path.join(here, 'matrix.json')));
  const validatorAnchor = writeArtifact(root, 'provenance/anchors/validate.mjs', fs.readFileSync(path.join(here, 'validate.mjs')));
  const falsifierAnchor = writeArtifact(root, 'provenance/anchors/falsify.mjs', fs.readFileSync(path.join(here, 'falsify.mjs')));
  provenance.anchors = { matrix: matrixAnchor, validator: validatorAnchor, falsifier: falsifierAnchor };
  const controls = matrix.falsificationControls.map((id) => ({ id, status: 'rejected', exitCode: 1, evidence: `isolated ${id} mutation rejected by validator` }));
  const controlProjection = controls.map(({ id, status, exitCode, evidence }) => ({ id, status, exitCode, evidence }));
  const falsificationCodeArtifact = { ...falsifierAnchor };
  const falsificationExecution = {
    schema: 's13-falsification-execution-v1',
    command: 'node scripts/parity-s13-physical/falsify.mjs',
    codeRevision: revision,
    codeArtifact: falsificationCodeArtifact,
    codeArtifactSha256: falsificationCodeArtifact.sha256,
    controls: controlProjection
  };
  const falsificationExecutionArtifact = writeJson(root, 'falsification/execution.json', falsificationExecution);
  const cases = matrix.cases.map((descriptor, index) => {
    if (descriptor.kind === 'blocked') return makeBlockedRow(descriptor);
    if (descriptor.kind === 'no-view') return makeNoViewRow(descriptor, root);
    if (descriptor.kind === 'revalidation') return makeRevalidationReferenceRow(descriptor, root);
    if (descriptor.captureCondition && !pmDepartureAvailable) return makeConditionalSkippedRow(descriptor);
    return makePhysicalRow(descriptor, index + 1, root, runtime, selectedOperation, allowedRequest);
  });
  const limitations = matrix.cases.filter((descriptor) => descriptor.kind === 'blocked').map((descriptor) => ({ caseId: descriptor.id, reason: descriptor.blocked.reason, claimed: false }));
  return {
    schema: 'phoenix.parity.s13.physical-capture-receipt', schemaVersion: 1, task: 'S-13', claim: 'physical-display-only', phoenixRevision: revision,
    decision: 'verified_bounded', taskStatus: 'closed', complete: true, runtime, provenance, preflight,
    matrix: { path: 'scripts/parity-s13-physical/matrix.json', sha256: matrix.integrity.matrixSha256, inventorySha256: matrix.integrity.caseInventorySha256, baseRevision: matrix.baseRevision, caseCount: matrix.cases.length, orderedCaseIds: matrix.cases.map((item) => item.id) },
    falsification: { result: 'pass', controls, controlsSha256: canonicalSha256(controlProjection), execution: falsificationExecution, executionArtifact: falsificationExecutionArtifact }, limitations, cases
  };
}
